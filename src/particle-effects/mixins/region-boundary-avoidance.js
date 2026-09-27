import { regionContainsPoint, regionMaskGeometrySignature } from "../../utils/geometry.js";
import {
  fxmDeltaSeconds,
  fxmForEachEmitterParticle,
  fxmGetParticleAge,
  fxmParticleVelocityVector,
  fxmRetargetMovePathParticle,
  fxmSteerParticleVelocity,
} from "../effect.js";

/** Compiled world-space boundaries shared by all animal emitters in a Region. */
const boundaryCache = new WeakMap();

/**
 * Compile the effective Region polygons, including holes and disconnected areas.
 * @param {object} region
 * @returns {object}
 */
function getBoundary(region) {
  const document = region.document ?? region;
  const polygons = region.animationState?.polygons ?? document.polygons;
  const animationKey = region.isAnimating ? regionMaskGeometrySignature(region) : "";
  const cached = boundaryCache.get(region);
  if (cached && cached.polygons === polygons && cached.animationKey === animationKey) return cached;

  const contains = (x, y) => regionContainsPoint(region, { x, y });
  const edges = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const polygon of polygons ?? []) {
    const points = polygon.points ?? polygon;
    if (!points?.length) continue;
    for (let i = 0, j = points.length - 2; i < points.length; j = i, i += 2) {
      const ax = Number(points[j]);
      const ay = Number(points[j + 1]);
      const bx = Number(points[i]);
      const by = Number(points[i + 1]);
      const dx = bx - ax;
      const dy = by - ay;
      const length = Math.hypot(dx, dy);
      if (!Number.isFinite(length) || length < 1e-6) continue;
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      let nx = -dy / length;
      let ny = dx / length;
      const probe = Math.min(0.01, length * 0.001);
      const left = contains(mx + nx * probe, my + ny * probe);
      const right = contains(mx - nx * probe, my - ny * probe);
      if (left === right) continue;
      if (!left) {
        nx = -nx;
        ny = -ny;
      }
      edges.push({ ax, ay, bx, by, dx, dy, nx, ny, length2: length * length });
      minX = Math.min(minX, ax, bx);
      minY = Math.min(minY, ay, by);
      maxX = Math.max(maxX, ax, bx);
      maxY = Math.max(maxY, ay, by);
    }
  }
  const boundary = { polygons, animationKey, contains, edges, minX, minY, maxX, maxY };
  boundaryCache.set(region, boundary);
  return boundary;
}

/**
 * Find the nearest boundary within a world-space search distance.
 * @param {object} boundary
 * @param {number} x
 * @param {number} y
 * @param {number} [limit=Infinity]
 * @returns {object|null}
 */
function nearestBoundary(boundary, x, y, limit = Infinity) {
  let best = null;
  let distance2 = limit * limit;
  for (const edge of boundary.edges) {
    if (x < Math.min(edge.ax, edge.bx) - limit || x > Math.max(edge.ax, edge.bx) + limit) continue;
    if (y < Math.min(edge.ay, edge.by) - limit || y > Math.max(edge.ay, edge.by) + limit) continue;
    const t = Math.max(0, Math.min(1, ((x - edge.ax) * edge.dx + (y - edge.ay) * edge.dy) / edge.length2));
    const px = edge.ax + edge.dx * t;
    const py = edge.ay + edge.dy * t;
    const d2 = (x - px) ** 2 + (y - py) ** 2;
    if (d2 >= distance2) continue;
    distance2 = d2;
    best = { x: px, y: py, nx: edge.nx, ny: edge.ny, distance: Math.sqrt(d2) };
  }
  return best;
}

/**
 * Find the first outward crossing, including thin holes skipped within one frame.
 * @param {object} boundary
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @returns {object|null}
 */
function firstExit(boundary, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  let best = null;
  let earliest = Infinity;
  for (const edge of boundary.edges) {
    if (dx * edge.nx + dy * edge.ny >= -1e-8) continue;
    const denominator = dx * edge.dy - dy * edge.dx;
    if (Math.abs(denominator) < 1e-10) continue;
    const qx = edge.ax - ax;
    const qy = edge.ay - ay;
    const t = (qx * edge.dy - qy * edge.dx) / denominator;
    const u = (qx * dy - qy * dx) / denominator;
    if (t < -1e-8 || t > 1 || u < -1e-8 || u > 1 + 1e-8 || t >= earliest) continue;
    earliest = t;
    best = { x: ax + dx * t, y: ay + dy * t, nx: edge.nx, ny: edge.ny, distance: 0 };
  }
  return best;
}

/**
 * Move a particle while preserving path origins and lateral movement state.
 * @param {object} particle
 * @param {number} x
 * @param {number} y
 */
function moveParticle(particle, x, y) {
  const dx = x - particle.x;
  const dy = y - particle.y;
  particle.x = x;
  particle.y = y;
  if (particle.config?.initPosition) {
    particle.config.initPosition.x += dx;
    particle.config.initPosition.y += dy;
  }
  particle._fxmLM_ox = 0;
  particle._fxmLM_oy = 0;
  particle._fxmLM_prevBaseX = x;
  particle._fxmLM_prevBaseY = y;
}

/**
 * Redirect movement and sprite orientation without restoring an outward token-avoidance heading.
 * @param {object} particle
 * @param {object|null} path
 * @param {number} angle
 */
function setHeading(particle, path, angle) {
  const nx = Math.cos(angle);
  const ny = Math.sin(angle);
  fxmSteerParticleVelocity(particle, nx, ny, 1);
  fxmRetargetMovePathParticle(particle, path, angle, 1);
  particle.rotation = angle;
  particle._fxmLM_baseRot = angle;
  particle._fxmLM_visRot = angle;
  particle._fxmTA_forwardX = nx;
  particle._fxmTA_forwardY = ny;
}

/**
 * Choose a stable turn style for one boundary encounter.
 * @param {object} edge
 * @param {number} heading
 * @param {boolean} [allowFollowing=true]
 * @returns {object}
 */
function createBoundaryResponse(edge, heading, allowFollowing = true) {
  const normal = Math.atan2(edge.ny, edge.nx);
  const offset = (Math.random() - 0.5) * 2;
  const alongEdge = Math.sin(heading - normal);
  const side = Math.abs(alongEdge) > 0.2 ? Math.sign(alongEdge) : Math.random() < 0.5 ? -1 : 1;
  return {
    edge,
    offset,
    target: normal + offset,
    turnRate: 0.75 + Math.random() * 0.8,
    followRemaining: allowFollowing && Math.random() < 0.3 ? 0.7 + Math.random() * 2.1 : 0,
    followOffset: side * (1.43 + Math.random() * 0.12),
  };
}

/**
 * End brief edge following with an inward turn, adapting to corners as needed.
 * @param {object} response
 * @param {object} edge
 * @param {number} dt
 * @returns {number}
 */
function boundaryResponseTarget(response, edge, dt) {
  const normal = Math.atan2(edge.ny, edge.nx);
  if (response.followRemaining > 0) {
    response.followRemaining = Math.max(0, response.followRemaining - dt);
    if (response.followRemaining > 0) return normal + response.followOffset;
    response.target = normal + response.offset;
  }
  if (Math.cos(response.target) * edge.nx + Math.sin(response.target) * edge.ny < 0.25) {
    response.target = normal + response.offset;
  }
  return response.target;
}

/**
 * Select an interior position for a newly spawned particle or an edited Region.
 * @param {object} boundary
 * @param {object} particle
 * @param {number} margin
 * @param {object|null} [edge=null]
 * @returns {boolean}
 */
function placeInside(boundary, particle, margin, edge = null) {
  if (edge) {
    for (const distance of [margin, 1, 0.01]) {
      const x = edge.x + edge.nx * distance;
      const y = edge.y + edge.ny * distance;
      if (!boundary.contains(x, y)) continue;
      if (firstExit(boundary, edge.x + edge.nx * 0.001, edge.y + edge.ny * 0.001, x, y)) continue;
      moveParticle(particle, x, y);
      return true;
    }
  }
  for (let i = 0; i < 32; i++) {
    const x = boundary.minX + Math.random() * (boundary.maxX - boundary.minX);
    const y = boundary.minY + Math.random() * (boundary.maxY - boundary.minY);
    if (!boundary.contains(x, y)) continue;
    moveParticle(particle, x, y);
    return true;
  }
  for (const candidate of boundary.edges) {
    const x = (candidate.ax + candidate.bx) / 2 + candidate.nx * 0.01;
    const y = (candidate.ay + candidate.by) / 2 + candidate.ny * 0.01;
    if (!boundary.contains(x, y)) continue;
    moveParticle(particle, x, y);
    return true;
  }
  return false;
}

/**
 * Install optional Region containment after custom animal emitters have been constructed.
 * @param {object} effect
 * @param {object} region
 * @param {object} options
 */
export function installRegionBoundaryAvoidance(effect, region, options = {}) {
  const enabled = options.regionBoundaryAvoidance?.value ?? options.regionBoundaryAvoidance ?? false;
  const orbit = options.orbit?.value ?? options.orbit ?? false;
  if (!enabled || orbit || !region || effect?.constructor?.group !== "animals") return;

  const grid = Math.max(1, Number(globalThis.canvas?.dimensions?.size) || 100);
  for (const emitter of effect.emitters ?? []) {
    if (!emitter || emitter._fxmRegionBoundaryAvoidanceWrapped) continue;
    const states = new WeakMap();
    const path = emitter.getBehavior?.("movePath") ?? null;
    const originalUpdate = emitter.update.bind(emitter);
    const wasAuto = !!emitter.autoUpdate;
    if (wasAuto) emitter.autoUpdate = false;

    emitter.update = (delta) => {
      const boundary = getBoundary(region);
      if (!boundary.edges.length) return originalUpdate(delta);
      const dt = Math.min(0.05, Math.max(0.001, fxmDeltaSeconds(delta)));
      const marginFor = (particle) => Math.max(2, Math.hypot(particle.width || 0, particle.height || 0) * 0.35);
      fxmForEachEmitterParticle(emitter, (particle) => {
        const age = fxmGetParticleAge(particle);
        let state = states.get(particle);
        if (!state || (age !== undefined && age < state.age)) state = { speed: grid * 2 };
        const margin = marginFor(particle);
        if (!boundary.contains(particle.x, particle.y)) {
          placeInside(boundary, particle, margin);
          state.response = null;
        }
        const velocity = fxmParticleVelocityVector(particle);
        const heading = velocity
          ? Math.atan2(velocity.y, velocity.x)
          : Number(particle.config?.initRotation ?? particle.rotation) || 0;
        const lookAhead = margin + Math.max(grid * 0.25, state.speed * 0.6);
        const edge = nearestBoundary(boundary, particle.x, particle.y, lookAhead);
        if (edge) {
          const dot = Math.cos(heading) * edge.nx + Math.sin(heading) * edge.ny;
          if (!state.response && dot < -0.001) state.response = createBoundaryResponse(edge, heading);
        }
        if (state.response) {
          const response = state.response;
          if (edge) response.edge = edge;
          else if (response.followRemaining > 0) {
            response.followRemaining = 0;
            response.target = Math.atan2(response.edge.ny, response.edge.nx) + response.offset;
          }
          const target = boundaryResponseTarget(response, response.edge, dt);
          const difference = Math.atan2(Math.sin(target - heading), Math.cos(target - heading));
          const urgency = edge
            ? 1 - Math.min(1, Math.max(0, edge.distance - margin) / Math.max(1, lookAhead - margin))
            : 0;
          const turn = (2 + 8 * urgency) * response.turnRate * dt;
          setHeading(particle, path, heading + Math.max(-turn, Math.min(turn, difference)));
          if (response.followRemaining <= 0 && Math.abs(difference) <= turn) state.response = null;
        }
        state.x = particle.x;
        state.y = particle.y;
        state.age = age;
        states.set(particle, state);
      });

      const result = originalUpdate(delta);
      fxmForEachEmitterParticle(emitter, (particle) => {
        const age = fxmGetParticleAge(particle);
        const previous = states.get(particle);
        const sameLife = previous && !(age !== undefined && age < previous.age);
        const state = sameLife ? previous : { speed: grid * 2 };
        const margin = marginFor(particle);
        let edge = sameLife ? firstExit(boundary, previous.x, previous.y, particle.x, particle.y) : null;
        if (!boundary.contains(particle.x, particle.y) && !edge) {
          edge = sameLife ? nearestBoundary(boundary, particle.x, particle.y) : null;
          placeInside(boundary, particle, margin, edge);
          edge ??= nearestBoundary(boundary, particle.x, particle.y);
        } else if (edge) {
          if (!placeInside(boundary, particle, margin, edge)) moveParticle(particle, previous.x, previous.y);
        }
        if (edge) {
          state.response ??= createBoundaryResponse(edge, Number(particle.rotation) || 0, false);
          state.response.edge = edge;
          setHeading(particle, path, boundaryResponseTarget(state.response, edge, 0));
        }
        const measured = sameLife && !edge ? Math.hypot(particle.x - previous.x, particle.y - previous.y) / dt : 0;
        state.x = particle.x;
        state.y = particle.y;
        state.age = age;
        if (measured > 0.001) state.speed = measured;
        states.set(particle, state);
      });
      return result;
    };
    emitter._fxmRegionBoundaryAvoidanceWrapped = true;
    if (wasAuto) emitter.autoUpdate = true;
  }
}
