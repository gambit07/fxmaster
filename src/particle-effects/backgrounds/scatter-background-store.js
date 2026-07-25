/**
 * Session-persistent state for sprite-based particle backgrounds such as
 * accumulated autumn leaves. The store deliberately owns only lightweight
 * data; each active renderer mirrors that data into its own PIXI sprites.
 */

const MAX_SCATTER_PARTICLES = 2600;
const MIN_SCATTER_PARTICLES = 8;
const MAX_PHYSICS_STEP_SECONDS = 0.025;

function finiteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, min, max, fallback = min) {
  return Math.max(min, Math.min(max, finiteNumber(value, fallback)));
}

function smoothstep01(value) {
  const t = clamp(value, 0, 1, 0);
  return t * t * (3 - 2 * t);
}

function normalizeTick(tick) {
  const supplied = Number(tick);
  if (Number.isFinite(supplied) && supplied >= 0) return supplied;

  try {
    const monotonic = Number(globalThis.performance?.now?.());
    if (Number.isFinite(monotonic) && monotonic >= 0) return monotonic;
  } catch (_err) {}

  return Date.now();
}

function normalizeBounds(bounds) {
  if (!bounds) return null;
  return {
    x: finiteNumber(bounds.x, 0),
    y: finiteNumber(bounds.y, 0),
    width: Math.max(1, finiteNumber(bounds.width, 1)),
    height: Math.max(1, finiteNumber(bounds.height, 1)),
    gridSize: Math.max(1, finiteNumber(bounds.gridSize, 100)),
  };
}

function boundsSignature(bounds) {
  if (!bounds) return "";
  return [bounds.x, bounds.y, bounds.width, bounds.height, bounds.gridSize]
    .map((value) => finiteNumber(value, 0).toFixed(3))
    .join(":");
}

function hashString32(value) {
  const text = String(value ?? "scatter-background");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mix32(value) {
  let x = Number(value) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

function random01(seed) {
  return mix32(seed) / 4294967296;
}

function createRandom(seed) {
  let state = mix32(seed || 0x9e3779b9);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussianPair(random) {
  const u1 = Math.max(1e-7, random());
  const u2 = random();
  const magnitude = Math.sqrt(-2 * Math.log(u1));
  const angle = Math.PI * 2 * u2;
  return [magnitude * Math.cos(angle), magnitude * Math.sin(angle)];
}

function normalizeVector(x, y, fallbackX = 1, fallbackY = 0) {
  const length = Math.hypot(x, y);
  if (!(length > 1e-6)) return { x: fallbackX, y: fallbackY, length: 0 };
  return { x: x / length, y: y / length, length };
}

function reflectIntoRange(value, min, max) {
  const span = max - min;
  if (!(span > 1e-6)) return (min + max) / 2;
  let offset = (value - min) % (span * 2);
  if (offset < 0) offset += span * 2;
  if (offset > span) offset = span * 2 - offset;
  return min + offset;
}

function closestPointOnSegment(point, from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!(lengthSquared > 1e-8)) return { x: from.x, y: from.y, t: 0 };
  const t = clamp(((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared, 0, 1, 0);
  return { x: from.x + dx * t, y: from.y + dy * t, t };
}

function resolvePatternSeed(uid, state) {
  const background = state?.background ?? {};
  const stored = Number(background.patternSeed);
  const material =
    Number.isFinite(stored) && stored >= 0
      ? `${uid}:seed:${Math.trunc(stored)}`
      : `${uid}:legacy:${background.startedAt ?? "none"}:${background.revision ?? 0}`;
  return hashString32(material);
}

function resolveWind(directionDegrees) {
  const degrees = finiteNumber(directionDegrees, 270);
  const radians = (degrees * Math.PI) / 180;
  return { x: Math.cos(radians), y: -Math.sin(radians) };
}

function normalizeOptionalDirection(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Shared state for an interactive scatter field.
 */
export class ScatterBackgroundStore {
  constructor({ uid = "scatter-background", descriptor = null } = {}) {
    this.type = "scatter";
    this.uid = String(uid ?? "scatter-background");
    this.descriptor = descriptor ?? null;
    this.enabled = false;
    this.bounds = null;
    this.leaves = [];
    this.generation = 0;
    this.motionRevision = 0;
    this._boundsSignature = "";
    this._resetSignature = null;
    this._layoutSignature = null;
    this._lastTick = null;
    this._lastProgress = 1;
    this._awakeLeaves = new Set();
    this._spatialCells = new Map();
    this._spatialCellSize = 100;
    this._maxLeafSize = 0;
    this._destroyed = false;
    this.settings = {};
  }

  setEnabled(enabled) {
    if (this._destroyed) return;
    const next = !!enabled;
    if (this.enabled === next) return;
    this.enabled = next;

    if (!next) {
      this.leaves = [];
      this.generation += 1;
      this.motionRevision += 1;
      this._layoutSignature = null;
      this._lastTick = null;
      this._awakeLeaves.clear();
      this._spatialCells.clear();
      this._maxLeafSize = 0;
    }
  }

  setBounds(bounds) {
    if (this._destroyed) return;
    const normalized = normalizeBounds(bounds);
    const signature = boundsSignature(normalized);
    if (signature === this._boundsSignature) return;
    this.bounds = normalized;
    this._boundsSignature = signature;
    this._layoutSignature = null;
  }

  resetForSignature(signature) {
    if (this._destroyed) return;
    const normalized = String(signature ?? "");
    if (normalized === this._resetSignature) return;
    this._resetSignature = normalized;
    this._layoutSignature = null;
    this._lastTick = null;
  }

  /**
   * Configure and, when necessary, regenerate the deterministic field.
   *
   * @param {{descriptor?:object|null,state?:object|null,bounds?:object|null,coverage?:number,fillVariation?:number,pileStrength?:number,pileScale?:number,leafScale?:number,direction?:number|null}} config
   */
  configure({
    descriptor = this.descriptor,
    state = {},
    bounds = this.bounds,
    coverage = 0.65,
    fillVariation = 0.7,
    pileStrength = 0.6,
    pileScale = 3.5,
    leafScale = 1,
    direction = 270,
  } = {}) {
    if (this._destroyed) return;
    this.descriptor = descriptor ?? this.descriptor ?? null;
    this.setBounds(bounds);

    const textures = Array.isArray(this.descriptor?.textures) ? this.descriptor.textures : [];
    const textureScaleByPath = this.descriptor?.textureScaleByPath ?? {};
    const textureScales = textures.map((texture) => clamp(textureScaleByPath?.[texture], 0.1, 3, 1));

    this.settings = {
      coverage: clamp(coverage, 0.05, 1, 0.65),
      fillVariation: clamp(fillVariation, 0, 1, 0.7),
      pileStrength: clamp(pileStrength, 0, 1, 0.6),
      pileScale: clamp(pileScale, 0.5, 12, 3.5),
      leafScale: clamp(leafScale, 0.05, 2.5, 1),
      direction: normalizeOptionalDirection(direction),
      textureScales,
    };

    if (!this.enabled || !this.bounds) return;

    const seed = resolvePatternSeed(this.uid, state);
    const signature = [
      this._resetSignature ?? "",
      this._boundsSignature,
      seed,
      textures.join("|"),
      textureScales.map((value) => value.toFixed(4)).join("|"),
      this.settings.coverage.toFixed(4),
      this.settings.fillVariation.toFixed(4),
      this.settings.pileStrength.toFixed(4),
      this.settings.pileScale.toFixed(4),
      this.settings.leafScale.toFixed(4),
      this.settings.direction === null ? "seeded-direction" : this.settings.direction.toFixed(3),
    ].join(":");

    if (signature !== this._layoutSignature) {
      this._layoutSignature = signature;
      this._buildLayout(seed, textures.length);
    }
  }

  _buildLayout(seed, textureCount) {
    const bounds = this.bounds;
    if (!this.enabled || !bounds) return;

    const random = createRandom(seed);
    const grid = bounds.gridSize;
    const areaInGridSpaces = Math.max(0.1, (bounds.width * bounds.height) / (grid * grid));
    const particlesPerGrid = 0.4 + this.settings.coverage * 4.0;
    const count = Math.max(
      MIN_SCATTER_PARTICLES,
      Math.min(MAX_SCATTER_PARTICLES, Math.round(areaInGridSpaces * particlesPerGrid)),
    );

    const effectiveDirection =
      this.settings.direction === null ? random01(seed ^ 0x4f1bbcdc) * 360 : this.settings.direction;
    const wind = resolveWind(effectiveDirection);
    const cross = { x: -wind.y, y: wind.x };
    const clusterCount = Math.max(3, Math.min(72, Math.round(Math.sqrt(count) * 0.55)));
    const clusters = [];

    for (let index = 0; index < clusterCount; index++) {
      const margin = Math.min(grid * 0.5, Math.min(bounds.width, bounds.height) * 0.08);
      clusters.push({
        x: bounds.x + margin + random() * Math.max(1, bounds.width - margin * 2),
        y: bounds.y + margin + random() * Math.max(1, bounds.height - margin * 2),
        arrival: random(),
        density: 0.55 + random() * 0.75,
        rotation: (random() - 0.5) * 0.5,
      });
    }

    const leaves = [];
    for (let index = 0; index < count; index++) {
      const leafSeed = mix32(seed ^ Math.imul(index + 1, 0x9e3779b1));
      const cluster = clusters[Math.floor(random() * clusters.length)] ?? clusters[0];
      const clustered = random() < 0.24 + this.settings.pileStrength * 0.72;
      let x;
      let y;
      let pileDepth;
      let spatialArrival;

      if (clustered && cluster) {
        const [gaussianAlong, gaussianAcross] = gaussianPair(random);
        const pileWorld = this.settings.pileScale * grid;
        const alongSpread = pileWorld * (0.34 + cluster.density * 0.26);
        const acrossSpread = pileWorld * (0.16 + cluster.density * 0.13);
        const localAngle = cluster.rotation;
        const localCos = Math.cos(localAngle);
        const localSin = Math.sin(localAngle);
        const along = {
          x: wind.x * localCos + cross.x * localSin,
          y: wind.y * localCos + cross.y * localSin,
        };
        const across = { x: -along.y, y: along.x };
        const alongOffset = gaussianAlong * alongSpread;
        const acrossOffset = gaussianAcross * acrossSpread;
        x = cluster.x + along.x * alongOffset + across.x * acrossOffset;
        y = cluster.y + along.y * alongOffset + across.y * acrossOffset;

        const normalizedDistance = Math.sqrt(
          (alongOffset * alongOffset) / Math.max(1, alongSpread * alongSpread) +
            (acrossOffset * acrossOffset) / Math.max(1, acrossSpread * acrossSpread),
        );
        pileDepth = clamp(
          Math.exp(-0.72 * normalizedDistance * normalizedDistance) * (0.55 + random() * 0.45),
          0,
          1,
          0,
        );
        spatialArrival = clamp(cluster.arrival * 0.78 + normalizedDistance * 0.12 + random() * 0.1, 0, 1, 0);
      } else {
        x = bounds.x + random() * bounds.width;
        y = bounds.y + random() * bounds.height;
        pileDepth = random() * 0.24;
        spatialArrival = random();
      }

      const edgePadding = Math.min(grid * 0.08, Math.min(bounds.width, bounds.height) * 0.02);
      x = reflectIntoRange(x, bounds.x + edgePadding, bounds.x + bounds.width - edgePadding);
      y = reflectIntoRange(y, bounds.y + edgePadding, bounds.y + bounds.height - edgePadding);

      const randomArrival = random();
      const arrivalRank = clamp(
        randomArrival * (1 - this.settings.fillVariation) + spatialArrival * this.settings.fillVariation,
        0,
        1,
        randomArrival,
      );
      const textureIndex = textureCount > 0 ? Math.floor(random() * textureCount) % textureCount : 0;
      const textureScale = this.settings.textureScales?.[textureIndex] ?? 1;
      const size =
        grid *
        0.19 *
        this.settings.leafScale *
        textureScale *
        (0.72 + random() * 0.58) *
        (1 + pileDepth * this.settings.pileStrength * 0.16);

      const rotation = random() * Math.PI * 2;

      leaves.push({
        id: index,
        seed: leafSeed,
        textureIndex,
        baseX: x,
        baseY: y,
        baseRotation: rotation,
        homeX: x,
        homeY: y,
        x,
        y,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        rotation,
        angularVelocity: 0,
        size,
        baseAlpha: 0.76 + random() * 0.22,
        brightness: clamp(0.83 + random() * 0.13 + pileDepth * 0.04, 0.72, 1.02, 0.9),
        pileDepth,
        arrivalRank,
        flutterPhase: random() * Math.PI * 2,
        awake: false,
        awakeUntil: 0,
        forceSleepAt: 0,
        lastDisturbedAt: -Infinity,
        motionTimeMs: 0,
        airborneStartedAt: 0,
        airborneUntil: 0,
        airborneHeight: 0,
        settleDurationScale: 1,
        settleImpact: 1,
      });
    }

    leaves.sort((a, b) => a.y - b.y || a.textureIndex - b.textureIndex || a.id - b.id);
    for (let index = 0; index < leaves.length; index++) leaves[index].renderIndex = index;

    this.leaves = leaves;
    this.generation += 1;
    this.motionRevision += 1;
    this._lastTick = null;
    this._awakeLeaves.clear();
    this._rebuildSpatialIndex();
  }

  _spatialKey(x, y) {
    const bounds = this.bounds;
    const cellSize = Math.max(1, this._spatialCellSize || bounds?.gridSize || 100);
    const cellX = Math.floor((finiteNumber(x, 0) - finiteNumber(bounds?.x, 0)) / cellSize);
    const cellY = Math.floor((finiteNumber(y, 0) - finiteNumber(bounds?.y, 0)) / cellSize);
    return `${cellX}:${cellY}`;
  }

  _removeLeafFromSpatialIndex(leaf) {
    const key = leaf?._spatialKey ?? null;
    if (key === null) return;
    const cell = this._spatialCells.get(key) ?? null;
    cell?.delete?.(leaf);
    if (cell?.size === 0) this._spatialCells.delete(key);
    leaf._spatialKey = null;
  }

  _updateLeafSpatialIndex(leaf) {
    if (!leaf || !this.bounds) return;
    const key = this._spatialKey(leaf.x, leaf.y);
    if (leaf._spatialKey === key) return;
    this._removeLeafFromSpatialIndex(leaf);
    let cell = this._spatialCells.get(key) ?? null;
    if (!cell) {
      cell = new Set();
      this._spatialCells.set(key, cell);
    }
    cell.add(leaf);
    leaf._spatialKey = key;
  }

  _rebuildSpatialIndex() {
    this._spatialCells.clear();
    this._spatialCellSize = Math.max(1, finiteNumber(this.bounds?.gridSize, 100));
    this._maxLeafSize = 0;
    for (const leaf of this.leaves) {
      leaf._spatialKey = null;
      this._maxLeafSize = Math.max(this._maxLeafSize, finiteNumber(leaf?.size, 0));
      this._updateLeafSpatialIndex(leaf);
    }
  }

  _queryLeavesForSegment(from, to, radius) {
    if (!this.bounds || !this._spatialCells.size) return this.leaves;
    const padding = Math.max(0, finiteNumber(radius, 0)) + this._maxLeafSize * 0.45;
    const cellSize = Math.max(1, this._spatialCellSize);
    const originX = finiteNumber(this.bounds.x, 0);
    const originY = finiteNumber(this.bounds.y, 0);
    const minCellX = Math.floor((Math.min(from.x, to.x) - padding - originX) / cellSize);
    const maxCellX = Math.floor((Math.max(from.x, to.x) + padding - originX) / cellSize);
    const minCellY = Math.floor((Math.min(from.y, to.y) - padding - originY) / cellSize);
    const maxCellY = Math.floor((Math.max(from.y, to.y) + padding - originY) / cellSize);
    const leaves = [];
    for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
        const cell = this._spatialCells.get(`${cellX}:${cellY}`);
        if (cell?.size) leaves.push(...cell);
      }
    }
    return leaves;
  }

  /**
   * Advance active leaves once per ticker timestamp. Multiple surfaces can
   * share this store during a crossfade; the timestamp guard prevents physics
   * from running twice.
   */
  advance(tick, { progress = this._lastProgress } = {}) {
    if (!this.enabled || this._destroyed || !this.bounds) return;
    const now = normalizeTick(tick);
    this._lastProgress = clamp(progress, 0, 1, 1);

    if (this._lastTick === null) {
      this._lastTick = now;
      return;
    }
    if (now <= this._lastTick) return;

    const elapsedSeconds = Math.max(0, (now - this._lastTick) / 1000);
    this._lastTick = now;
    if (!(elapsedSeconds > 0)) return;

    const simulationSeconds = Math.min(0.3, elapsedSeconds);
    const moved = this._advanceAwakeRange(now - simulationSeconds * 1000, now);

    if (moved) this.motionRevision += 1;
  }

  /**
   * Advance only currently active leaves over a bounded time range.
   *
   * @param {number} fromTick
   * @param {number} toTick
   * @param {{maxSeconds?:number}} [options]
   * @returns {boolean}
   * @private
   */
  _advanceAwakeRange(fromTick, toTick, { maxSeconds = 20 } = {}) {
    if (!this._awakeLeaves.size) return false;
    const start = finiteNumber(fromTick, 0);
    const end = Math.max(start, finiteNumber(toTick, start));
    const spanSeconds = Math.min(Math.max(0, end - start) / 1000, Math.max(0, finiteNumber(maxSeconds, 20)));
    if (!(spanSeconds > 0)) return false;

    const simulationEnd = start + spanSeconds * 1000;
    let cursor = start;
    let moved = false;
    while (cursor < simulationEnd - 0.001 && this._awakeLeaves.size) {
      const dt = Math.min(MAX_PHYSICS_STEP_SECONDS, (simulationEnd - cursor) / 1000);
      cursor += dt * 1000;
      for (const leaf of Array.from(this._awakeLeaves)) {
        if (!leaf?.awake) {
          this._awakeLeaves.delete(leaf);
          continue;
        }
        moved = true;
        if (!this._advanceLeaf(leaf, cursor, dt)) this._awakeLeaves.delete(leaf);
      }
    }
    return moved;
  }

  _advanceLeaf(leaf, now, dt) {
    const bounds = this.bounds;
    const grid = bounds.gridSize;
    const perpendicular = normalizeVector(-leaf.vy, leaf.vx, 0, 1);
    const flutterStrength = grid * (leaf.z > 0 ? 0.65 : 0.16);
    leaf.motionTimeMs = Math.max(0, finiteNumber(leaf.motionTimeMs, 0) + dt * 1000);
    const flutter = Math.sin(leaf.motionTimeMs * 0.008 + leaf.flutterPhase) * flutterStrength;

    leaf.vx += perpendicular.x * flutter * dt;
    leaf.vy += perpendicular.y * flutter * dt;
    leaf.x += leaf.vx * dt;
    leaf.y += leaf.vy * dt;
    leaf.z += leaf.vz * dt;
    leaf.rotation += leaf.angularVelocity * dt;

    const settleScale = clamp(leaf.settleDurationScale, 0.35, 4, 1);
    leaf.vz -= ((grid * 3.2) / settleScale) * dt;

    const airborneUntil = finiteNumber(leaf.airborneUntil, 0);
    if (now < airborneUntil) {
      const airborneStartedAt = finiteNumber(leaf.airborneStartedAt, now);
      const airborneDuration = Math.max(1, airborneUntil - airborneStartedAt);
      const airborneProgress = clamp((now - airborneStartedAt) / airborneDuration, 0, 1, 0);
      const arcHeight = Math.max(0, finiteNumber(leaf.airborneHeight, 0) * Math.sin(Math.PI * airborneProgress));
      if (arcHeight > leaf.z) {
        leaf.z = arcHeight;
        leaf.vz = Math.max(leaf.vz, 0);
      }
    } else if (leaf.z <= 0) {
      leaf.z = 0;
      leaf.vz = 0;
    }

    const airborne = leaf.z > 0.5 || Math.abs(leaf.vz) > grid * 0.05;
    const linearDrag = Math.exp(-(airborne ? 1.55 : 3.25) * dt);
    const angularDrag = Math.exp(-(airborne ? 1.15 : 2.55) * dt);
    leaf.vx *= linearDrag;
    leaf.vy *= linearDrag;
    leaf.angularVelocity *= angularDrag;

    const padding = leaf.size * 0.35;
    const minX = bounds.x - padding;
    const maxX = bounds.x + bounds.width + padding;
    const minY = bounds.y - padding;
    const maxY = bounds.y + bounds.height + padding;
    if (leaf.x < minX) {
      leaf.x = minX;
      leaf.vx = Math.abs(leaf.vx) * 0.22;
    } else if (leaf.x > maxX) {
      leaf.x = maxX;
      leaf.vx = -Math.abs(leaf.vx) * 0.22;
    }
    if (leaf.y < minY) {
      leaf.y = minY;
      leaf.vy = Math.abs(leaf.vy) * 0.22;
    } else if (leaf.y > maxY) {
      leaf.y = maxY;
      leaf.vy = -Math.abs(leaf.vy) * 0.22;
    }
    this._updateLeafSpatialIndex(leaf);

    const remainingSpeed = Math.hypot(leaf.vx, leaf.vy);
    const canSleep = now >= leaf.awakeUntil && leaf.z <= 0.01 && Math.abs(leaf.vz) < grid * 0.04;
    const mustSleep = now >= leaf.forceSleepAt && leaf.z <= 0.01;
    if ((canSleep && remainingSpeed < grid * 0.16 && Math.abs(leaf.angularVelocity) < 0.45) || mustSleep) {
      leaf.awake = false;
      leaf.vx = 0;
      leaf.vy = 0;
      leaf.vz = 0;
      leaf.angularVelocity = 0;
      leaf.z = 0;
      leaf.airborneStartedAt = 0;
      leaf.airborneUntil = 0;
      leaf.airborneHeight = 0;
      leaf.homeX = leaf.x;
      leaf.homeY = leaf.y;
      return false;
    }
    return true;
  }

  /**
   * Restore the deterministic seeded field before replaying persisted movement.
   *
   * @param {{bumpRevision?:boolean}} [options]
   */
  resetMotion({ bumpRevision = true } = {}) {
    this._awakeLeaves.clear();
    for (const leaf of this.leaves) {
      leaf.homeX = finiteNumber(leaf.baseX, leaf.homeX);
      leaf.homeY = finiteNumber(leaf.baseY, leaf.homeY);
      leaf.x = leaf.homeX;
      leaf.y = leaf.homeY;
      leaf.z = 0;
      leaf.vx = 0;
      leaf.vy = 0;
      leaf.vz = 0;
      leaf.rotation = finiteNumber(leaf.baseRotation, leaf.rotation);
      leaf.angularVelocity = 0;
      leaf.awake = false;
      leaf.awakeUntil = 0;
      leaf.forceSleepAt = 0;
      leaf.lastDisturbedAt = -Infinity;
      leaf.motionTimeMs = 0;
      leaf.airborneStartedAt = 0;
      leaf.airborneUntil = 0;
      leaf.airborneHeight = 0;
      leaf.settleDurationScale = 1;
      leaf.settleImpact = 1;
    }
    this._lastTick = null;
    this._rebuildSpatialIndex();
    if (bumpRevision) this.motionRevision += 1;
  }

  /**
   * Deterministically rebuild the displaced field from persisted movement
   * events. Events are projected onto a virtual monotonic timeline, simulated
   * in order, and then shifted back to the current runtime clock.
   *
   * @param {Array<object>} events
   * @param {{currentTick?:number,currentTime?:number}} [options]
   * @returns {number}
   */
  replayDisturbanceHistory(events, { currentTick = normalizeTick(), currentTime = Date.now() } = {}) {
    if (!this.enabled || this._destroyed || !this.bounds) return 0;
    const ordered = (Array.isArray(events) ? events : [])
      .filter((event) => Number.isFinite(Number(event?.occurredAt)))
      .slice()
      .sort(
        (a, b) =>
          Number(a.occurredAt) - Number(b.occurredAt) || String(a.eventId ?? "").localeCompare(String(b.eventId ?? "")),
      );

    this.resetMotion({ bumpRevision: false });
    const nowTick = normalizeTick(currentTick);
    const wallNow = finiteNumber(currentTime, Date.now());
    if (!ordered.length) {
      this._lastTick = nowTick;
      this.motionRevision += 1;
      return 0;
    }

    const oldestAge = Math.max(0, wallNow - Number(ordered[0].occurredAt));
    const timelineOffset = Math.max(1000, oldestAge - nowTick + 1000);
    const virtualNow = nowTick + timelineOffset;
    let cursor = Math.max(0, virtualNow - oldestAge);
    let disturbed = 0;

    for (const event of ordered) {
      const ageMs = Math.max(0, wallNow - Number(event.occurredAt));
      const eventTick = Math.max(cursor, virtualNow - ageMs);
      this._advanceAwakeRange(cursor, eventTick, { maxSeconds: 20 });
      disturbed +=
        Number(
          this.disturbSegment({
            from: event.from,
            to: event.to,
            tokenWidth: event.tokenWidth,
            tokenHeight: event.tokenHeight,
            tick: eventTick,
            progress: event.progress,
            radiusMultiplier: event.radiusMultiplier,
            strength: event.strength,
            swirl: event.swirl,
            liftChance: event.liftChance,
            settleSeconds: event.settleSeconds,
            settleImpact: event.settleImpact,
            disturbanceSeed: event.seed ?? event.disturbanceSeed,
          }),
        ) || 0;
      cursor = eventTick;
    }
    this._advanceAwakeRange(cursor, virtualNow, { maxSeconds: 20 });

    for (const leaf of this.leaves) {
      if (Number.isFinite(leaf.lastDisturbedAt)) leaf.lastDisturbedAt -= timelineOffset;
      if (Number.isFinite(leaf.awakeUntil)) leaf.awakeUntil -= timelineOffset;
      if (Number.isFinite(leaf.forceSleepAt)) leaf.forceSleepAt -= timelineOffset;
    }
    this._lastTick = nowTick;
    this.motionRevision += 1;
    return disturbed;
  }

  /**
   * Disturb leaves intersecting a swept token capsule.
   *
   * @returns {number} Number of leaves affected.
   */
  disturbSegment({
    from,
    to,
    tokenWidth = 0,
    tokenHeight = 0,
    tick,
    progress = this._lastProgress,
    radiusMultiplier = 0.9,
    strength = 0.7,
    swirl = 0.55,
    liftChance = 0.25,
    settleSeconds = 3,
    settleImpact = 1,
    disturbanceSeed = null,
  } = {}) {
    if (!this.enabled || this._destroyed || !this.bounds || !from || !to) return 0;

    const a = { x: finiteNumber(from.x, Number.NaN), y: finiteNumber(from.y, Number.NaN) };
    const b = { x: finiteNumber(to.x, Number.NaN), y: finiteNumber(to.y, Number.NaN) };
    if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return 0;

    const movement = normalizeVector(b.x - a.x, b.y - a.y, 1, 0);
    if (!(movement.length > 0.01)) return 0;

    const now = normalizeTick(tick);
    const grid = this.bounds.gridSize;
    const tokenMinor = Math.max(grid * 0.25, Math.min(finiteNumber(tokenWidth, grid), finiteNumber(tokenHeight, grid)));
    const radius = clamp(tokenMinor * 0.5 * clamp(radiusMultiplier, 0, 2, 0.9), grid * 0.15, grid * 2, grid * 0.55);
    const pushStrength = clamp(strength, 0, 1, 0.7);
    const swirlStrength = clamp(swirl, 0, 1, 0.55);
    const liftProbability = clamp(liftChance, 0, 1, 0.25);
    const settle = clamp(settleSeconds, 0.1, 12, 3);
    const settleScale = clamp(settle / 3, 0.35, 4, 1);
    const impact = clamp(settleImpact, 0, 1, 1);
    const visibleProgress = clamp(progress, 0, 1, 1);
    const movementSpeedHint = Math.min(grid * 8, movement.length / 0.05);
    let disturbed = 0;

    const suppliedSeed = Number(disturbanceSeed);
    const quantized = Number.isFinite(suppliedSeed)
      ? Math.trunc(suppliedSeed) >>> 0
      : (Math.round(a.x / Math.max(1, grid * 0.05)) * 73856093) ^
        (Math.round(a.y / Math.max(1, grid * 0.05)) * 19349663) ^
        (Math.round(b.x / Math.max(1, grid * 0.05)) * 83492791);

    for (const leaf of this._queryLeavesForSegment(a, b, radius)) {
      if (leaf.arrivalRank > visibleProgress + 0.025) continue;

      const closest = closestPointOnSegment(leaf, a, b);
      const offsetX = leaf.x - closest.x;
      const offsetY = leaf.y - closest.y;
      const distance = Math.hypot(offsetX, offsetY);
      const effectiveRadius = radius + leaf.size * 0.42;
      if (distance > effectiveRadius) continue;

      const influence = smoothstep01(1 - distance / Math.max(1, effectiveRadius));
      if (!(influence > 0.001)) continue;

      const randomA = random01(leaf.seed ^ quantized ^ 0xa511e9b3);
      const randomB = random01(leaf.seed ^ quantized ^ 0x63d83595);
      const randomC = random01(leaf.seed ^ quantized ^ 0x9e3779b9);
      const outward = normalizeVector(offsetX, offsetY, -movement.y, movement.x);
      const perpendicular = { x: -movement.y, y: movement.x };
      const sideSign = randomA < 0.5 ? -1 : 1;
      const repeatedScale = now - leaf.lastDisturbedAt < 90 ? 0.38 : 1;
      const baseImpulse = (grid * (0.75 + pushStrength * 3.15) + movementSpeedHint * 0.16) * influence * repeatedScale;
      const forwardImpulse = baseImpulse * (0.46 + randomB * 0.18);
      const outwardImpulse = baseImpulse * (0.5 + randomC * 0.3);
      const swirlImpulse = baseImpulse * swirlStrength * (0.22 + randomA * 0.5) * sideSign;

      leaf.vx =
        leaf.vx * 0.38 + movement.x * forwardImpulse + outward.x * outwardImpulse + perpendicular.x * swirlImpulse;
      leaf.vy =
        leaf.vy * 0.38 + movement.y * forwardImpulse + outward.y * outwardImpulse + perpendicular.y * swirlImpulse;
      leaf.angularVelocity += (randomB - 0.5) * (5 + pushStrength * 9) * influence;

      leaf.settleDurationScale = Math.max(clamp(leaf.settleDurationScale, 0.35, 4, 1), settleScale);
      leaf.settleImpact = impact;

      if (randomC < liftProbability * influence) {
        const settleMs = settle * 1000 * (0.72 + randomB * 0.56);
        const airborneMs = settleMs * (0.58 + randomA * 0.28);
        leaf.vz = Math.max(
          leaf.vz,
          grid * (0.7 + pushStrength * 1.45) * (0.7 + randomA * 0.65) * Math.sqrt(settleScale),
        );
        leaf.z = Math.max(leaf.z, leaf.size * 0.08);
        leaf.airborneStartedAt = now;
        leaf.airborneUntil = Math.max(leaf.airborneUntil, now + airborneMs);
        leaf.airborneHeight = Math.max(
          leaf.airborneHeight,
          grid * (0.16 + pushStrength * 0.24) * (0.85 + randomB * 0.4) * (0.55 + settleScale * 0.45),
        );
      }

      leaf.awake = true;
      this._awakeLeaves.add(leaf);
      leaf.lastDisturbedAt = now;
      const settleMs = settle * 1000 * (0.72 + randomB * 0.56);
      leaf.awakeUntil = Math.max(leaf.awakeUntil, now + settleMs);
      leaf.forceSleepAt = Math.max(leaf.forceSleepAt, now + settleMs + 2500);
      disturbed += 1;
    }

    if (disturbed) this.motionRevision += 1;
    return disturbed;
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.enabled = false;
    this.leaves = [];
    this._awakeLeaves.clear();
    this._spatialCells.clear();
    this._maxLeafSize = 0;
    this.bounds = null;
    this.generation += 1;
    this.motionRevision += 1;
  }
}

/**
 * Exported for focused tests and future scatter profiles.
 */
export const scatterBackgroundInternals = Object.freeze({
  resolvePatternSeed,
  hashString32,
  mix32,
  smoothstep01,
});
