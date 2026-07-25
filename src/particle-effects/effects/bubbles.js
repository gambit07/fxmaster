import { FXMasterParticleEffect, fxmDeltaSeconds, fxmForEachEmitterParticle, fxmGetParticleAge } from "./effect.js";
import { DefaultRectangleSpawnMixin } from "./mixins/default-rectangle-spawn.js";
import { logger } from "../../logger.js";

const BUBBLE_TRAIL_SAMPLE_INTERVAL_MS = 33;
const BUBBLE_TRAIL_MAX_SEGMENTS = 96;
const BUBBLE_TRAIL_TELEPORT_GRID_SPACES = 8;

function bubbleOptionValue(value, fallback = undefined) {
  if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "value")) return value.value;
  return value === undefined ? fallback : value;
}

function bubbleOptionEnabled(value) {
  const raw = bubbleOptionValue(value, false);
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (!normalized || ["false", "0", "off", "no"].includes(normalized)) return false;
    if (["true", "1", "on", "yes"].includes(normalized)) return true;
  }
  if (typeof raw === "number") return raw > 0;
  return raw === true;
}

function bubbleClamp(value, min, max, fallback = min) {
  const number = Number(value);
  const safe = Number.isFinite(number) ? number : fallback;
  return Math.max(min, Math.min(max, safe));
}

function bubbleNowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function bubbleTokenId(token) {
  return String(token?.document?.uuid ?? token?.document?.id ?? token?.id ?? token?.objectId ?? "");
}

function bubbleTokenVisible(token) {
  if (!token || token.destroyed) return false;
  if (token.document?.hidden) return false;
  if (token.visible === false) return false;
  if (token.alpha === 0) return false;
  return true;
}

function bubbleTokenCenter(token) {
  const center = token?.center;
  const cx = Number(center?.x);
  const cy = Number(center?.y);
  if (Number.isFinite(cx) && Number.isFinite(cy)) return { x: cx, y: cy };
  const grid = Number(globalThis.canvas?.dimensions?.size) || 100;
  const x = Number(token?.document?.x ?? token?.x);
  const y = Number(token?.document?.y ?? token?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const docWidth = Number(token?.document?.width);
  const docHeight = Number(token?.document?.height);
  const w = Number(token?.w ?? token?.width ?? (Number.isFinite(docWidth) && docWidth > 0 ? docWidth * grid : grid));
  const h = Number(
    token?.h ?? token?.height ?? (Number.isFinite(docHeight) && docHeight > 0 ? docHeight * grid : grid),
  );
  return {
    x: x + (Number.isFinite(w) && w > 0 ? w : grid) * 0.5,
    y: y + (Number.isFinite(h) && h > 0 ? h : grid) * 0.5,
  };
}

function bubbleTokenFootprint(token) {
  const grid = Number(globalThis.canvas?.dimensions?.size) || 100;
  const docWidth = Number(token?.document?.width);
  const docHeight = Number(token?.document?.height);
  const w = Number(token?.w ?? token?.width ?? (Number.isFinite(docWidth) && docWidth > 0 ? docWidth * grid : grid));
  const h = Number(
    token?.h ?? token?.height ?? (Number.isFinite(docHeight) && docHeight > 0 ? docHeight * grid : grid),
  );
  return Math.max(grid * 0.35, Number.isFinite(w) && w > 0 ? w : grid, Number.isFinite(h) && h > 0 ? h : grid);
}

function bubbleDistanceToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const denom = abx * abx + aby * aby;
  const t = denom > 1e-6 ? Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / denom)) : 0;
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  return Math.hypot(px - cx, py - cy);
}

function bubbleParticleVisualRadius(particle) {
  const width = Math.abs(Number(particle?.width));
  const height = Math.abs(Number(particle?.height));
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)
    return Math.max(width, height) * 0.5;

  const texture = particle?.texture ?? particle?._texture;
  const texWidth = Number(texture?.orig?.width ?? texture?.frame?.width ?? texture?.width);
  const texHeight = Number(texture?.orig?.height ?? texture?.frame?.height ?? texture?.height);
  const scaleX = Math.abs(Number(particle?.scale?.x ?? particle?.scaleX ?? 1)) || 1;
  const scaleY = Math.abs(Number(particle?.scale?.y ?? particle?.scaleY ?? scaleX)) || scaleX;
  if (Number.isFinite(texWidth) && Number.isFinite(texHeight) && texWidth > 0 && texHeight > 0) {
    return Math.max(texWidth * scaleX, texHeight * scaleY) * 0.5;
  }

  return Math.max(4, 18 * Math.max(scaleX, scaleY));
}

function bubbleNormalizeColor(value, fallback = 0xffffff) {
  if (typeof value === "number" && Number.isFinite(value)) return value & 0xffffff;
  if (typeof value === "string") {
    const cleaned = value.trim().replace(/^#/, "");
    const parsed = Number.parseInt(cleaned, 16);
    if (Number.isFinite(parsed)) return parsed & 0xffffff;
  }
  if (value && typeof value === "object") {
    if (typeof value.toNumber === "function") return bubbleNormalizeColor(value.toNumber(), fallback);
    if (typeof value.value === "number" || typeof value.value === "string")
      return bubbleNormalizeColor(value.value, fallback);
    const r = Number(value.r ?? value.red);
    const g = Number(value.g ?? value.green);
    const b = Number(value.b ?? value.blue);
    if ([r, g, b].every((n) => Number.isFinite(n))) {
      const scale = Math.max(r, g, b) <= 1 ? 255 : 1;
      return (
        ((Math.round(r * scale) & 0xff) << 16) | ((Math.round(g * scale) & 0xff) << 8) | (Math.round(b * scale) & 0xff)
      );
    }
  }
  return fallback & 0xffffff;
}

function bubbleParticleTintColor(particle) {
  return bubbleNormalizeColor(
    particle?.tint ?? particle?.tintValue ?? particle?._tintRGB ?? particle?._tintColor ?? particle?._tint,
    0xffffff,
  );
}

function bubbleMixColor(color, target, amount) {
  const t = bubbleClamp(amount, 0, 1, 0);
  const ar = (color >> 16) & 0xff;
  const ag = (color >> 8) & 0xff;
  const ab = color & 0xff;
  const br = (target >> 16) & 0xff;
  const bg = (target >> 8) & 0xff;
  const bb = target & 0xff;
  return (
    ((Math.round(ar + (br - ar) * t) & 0xff) << 16) |
    ((Math.round(ag + (bg - ag) * t) & 0xff) << 8) |
    (Math.round(ab + (bb - ab) * t) & 0xff)
  );
}

/**
 * A full-screen particle effect which renders floating bubbles.
 */
export class BubblesParticleEffect extends DefaultRectangleSpawnMixin(FXMasterParticleEffect) {
  /** @override */
  static label = "FXMASTER.Particles.Effects.Bubbles";

  /** @override */
  static get icon() {
    return "modules/fxmaster/assets/particle-effects/icons/bubbles.webp";
  }

  /** @override */
  static get group() {
    return "ambient";
  }

  static get orbitFacesTangent() {
    return false;
  }

  /** @override */
  static get parameters() {
    const p = super.parameters;
    return {
      belowTokens: p.belowTokens,
      belowTiles: p.belowTiles,
      soundFxEnabled: p.soundFxEnabled,
      tint: p.tint,
      topDown: { label: "FXMASTER.Params.TopDown", type: "checkbox", value: false, hideWhen: { orbit: true } },
      orbit: { label: "FXMASTER.Params.Orbit", type: "checkbox", value: false, hideWhen: { topDown: true } },
      orbitDistance: {
        label: "FXMASTER.Params.OrbitDistance",
        type: "range",
        min: 0,
        value: 0.5,
        max: 1,
        step: 0.01,
        decimals: 2,
        showWhen: { orbit: true },
      },
      directionalMovement: {
        label: "FXMASTER.Params.DirectionalMovement",
        type: "checkbox",
        value: false,
        hideWhen: [{ orbit: true }, { topDown: true }],
      },
      direction: {
        ...p.direction,
        showWhen: { directionalMovement: true },
        hideWhen: [{ orbit: true }, { topDown: true }],
      },
      synchronizedDirection: {
        ...this.synchronizedDirectionParameter,
        showWhen: { directionalMovement: true },
        hideWhen: [{ orbit: true }, { topDown: true }],
      },
      spread: {
        label: "FXMASTER.Params.Spread",
        type: "range",
        min: 0,
        value: 0,
        max: 20,
        step: 1,
        decimals: 0,
        showWhen: { directionalMovement: true },
        hideWhen: [{ orbit: true }, { topDown: true }],
      },
      scale: p.scale,
      speed: p.speed,
      lifetime: p.lifetime,
      density: { ...p.density, min: 0.01, value: 0.15, max: 0.5, step: 0.01, decimals: 2 },
      alpha: p.alpha,
      tokenTrailsEnabled: {
        label: "FXMASTER.Params.TokenTrails",
        type: "checkbox",
        value: true,
        tooltip: "FXMASTER.ParamTooltips.BubbleTokenTrails",
      },
      tokenTrailWidth: {
        label: "FXMASTER.Params.TokenTrailWidth",
        type: "range",
        min: 0,
        value: 1,
        max: 2,
        step: 0.05,
        decimals: 2,
        showWhen: { tokenTrailsEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.BubbleTokenTrailWidth",
      },
      tokenTrailStrength: {
        label: "FXMASTER.Params.TokenTrailStrength",
        type: "range",
        min: 0,
        value: 0.85,
        max: 1,
        step: 0.01,
        decimals: 2,
        showWhen: { tokenTrailsEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.BubbleTokenTrailStrength",
      },
    };
  }

  /**
   * Configuration for the particle emitter for floating bubbles
   * @type {PIXI.particles.EmitterConfigV3}
   */
  static BUBBLES_CONFIG = {
    lifetime: { min: 8, max: 10 },
    behaviors: [
      {
        type: "alpha",
        config: {
          alpha: {
            list: [
              { value: 0, time: 0 },
              { value: 0.85, time: 0.05 },
              { value: 0.85, time: 0.85 },
              { value: 0, time: 1 },
            ],
          },
        },
      },
      {
        type: "moveSpeed",
        config: {
          speed: {
            list: [
              { time: 0, value: 20 },
              { time: 1, value: 60 },
            ],
          },
          minMult: 0.6,
        },
      },
      {
        type: "scale",
        config: {
          scale: {
            list: [
              { value: 0.25, time: 0 },
              { value: 0.5, time: 1 },
            ],
          },
          minMult: 0.5,
        },
      },
      {
        type: "rotation",
        config: { accel: 0, minSpeed: 100, maxSpeed: 200, minStart: 0, maxStart: 365 },
      },
      {
        type: "textureSingle",
        config: { texture: "modules/fxmaster/assets/particle-effects/effects/bubbles/bubble.webp" },
      },
    ],
  };

  /** @override */
  static get defaultConfig() {
    return this.BUBBLES_CONFIG;
  }

  createEmitter(config) {
    const emitter = super.createEmitter(config);
    this._installBubbleTokenTrails(emitter, this._fxmLastOptions ?? this.options ?? {});
    return emitter;
  }

  _installBubbleTokenTrails(emitter, options = {}) {
    if (!emitter) return;

    const enabled = bubbleOptionEnabled(options?.tokenTrailsEnabled);
    const widthScale = bubbleClamp(bubbleOptionValue(options?.tokenTrailWidth, 1), 0, 2, 1);
    const strength = bubbleClamp(bubbleOptionValue(options?.tokenTrailStrength, 0.85), 0, 1, 0.85);
    if (!enabled || widthScale <= 0.001 || strength <= 0.001) {
      emitter._fxmBubbleTrailUpdate = null;
      return;
    }

    emitter._fxmBubbleTrailState ??= { positions: new Map(), segments: [], lastSampleMs: 0 };
    emitter._fxmBubbleTrailUpdate = (delta) => {
      const state = emitter._fxmBubbleTrailState;
      if (!state) return;

      const now = bubbleNowMs();
      state.segments = [];
      if (now - state.lastSampleMs >= BUBBLE_TRAIL_SAMPLE_INTERVAL_MS) {
        this._sampleBubbleTrailTokens(state, now, widthScale);
        state.lastSampleMs = now;
      }

      this._updateBubblePops(fxmDeltaSeconds(delta));

      const activeSegments = state.segments;
      fxmForEachEmitterParticle(emitter, (particle) => {
        this._resetBubbleParticleIfRespawned(particle);
        if (activeSegments.length) this._maybePopBubbleParticle(particle, activeSegments, strength);
      });
      state.segments = [];
    };

    if (emitter._fxmBubbleTrailWrapped) return;

    const wasAuto = !!emitter.autoUpdate;
    if (wasAuto) emitter.autoUpdate = false;

    const origUpdate = emitter.update.bind(emitter);
    emitter._fxmBubbleTrailOrigUpdate = origUpdate;
    emitter.update = (delta) => {
      origUpdate(delta);
      try {
        emitter._fxmBubbleTrailUpdate?.(delta);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    };

    emitter._fxmBubbleTrailWrapped = true;
    if (wasAuto) emitter.autoUpdate = true;
  }

  _sampleBubbleTrailTokens(state, now, widthScale) {
    const tokens = globalThis.canvas?.tokens?.placeables ?? [];
    const grid = Math.max(1, Number(globalThis.canvas?.dimensions?.size) || 100);
    const minDistance = Math.max(1.5, grid * 0.018);
    const teleportDistance = Math.max(grid, grid * BUBBLE_TRAIL_TELEPORT_GRID_SPACES);
    const seen = new Set();

    for (const token of tokens) {
      if (!bubbleTokenVisible(token)) continue;
      const id = bubbleTokenId(token);
      if (!id) continue;
      const center = bubbleTokenCenter(token);
      if (!center) continue;
      seen.add(id);

      const footprint = bubbleTokenFootprint(token);
      const previous = state.positions.get(id);
      if (!previous) {
        state.positions.set(id, { x: center.x, y: center.y, footprint, seenAt: now });
        continue;
      }

      const distance = Math.hypot(center.x - previous.x, center.y - previous.y);
      if (distance > teleportDistance) {
        state.positions.set(id, { x: center.x, y: center.y, footprint, seenAt: now });
        continue;
      }

      if (distance >= minDistance) {
        state.segments.push({
          ax: previous.x,
          ay: previous.y,
          bx: center.x,
          by: center.y,
          radius: Math.max(grid * 0.2, Math.max(previous.footprint ?? footprint, footprint) * widthScale * 0.52),
        });
        if (state.segments.length > BUBBLE_TRAIL_MAX_SEGMENTS)
          state.segments.splice(0, state.segments.length - BUBBLE_TRAIL_MAX_SEGMENTS);
        state.positions.set(id, { x: center.x, y: center.y, footprint, seenAt: now });
      } else {
        previous.footprint = footprint;
        previous.seenAt = now;
      }
    }

    for (const [id, entry] of state.positions.entries()) {
      if (seen.has(id)) continue;
      if (now - (entry?.seenAt ?? now) > 1200) state.positions.delete(id);
    }
  }

  _maybePopBubbleParticle(particle, segments, strength) {
    if (!particle || particle._fxmBubblePopped) {
      this._resetBubbleParticleIfRespawned(particle);
      return;
    }

    const px = Number(particle.x ?? particle.position?.x);
    const py = Number(particle.y ?? particle.position?.y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return;

    for (const segment of segments) {
      const radius = Math.max(1, Number(segment?.radius) || 0);
      const distance = bubbleDistanceToSegment(px, py, segment.ax, segment.ay, segment.bx, segment.by);
      if (distance > radius * (0.72 + 0.36 * strength)) continue;
      this._popBubbleParticle(particle, px, py, radius, strength);
      return;
    }
  }

  _resetBubbleParticleIfRespawned(particle) {
    if (!particle || !particle._fxmBubblePopped) return;
    const age = fxmGetParticleAge(particle);
    if (age !== undefined && typeof particle._fxmBubblePoppedAge === "number" && age < particle._fxmBubblePoppedAge) {
      particle._fxmBubblePopped = false;
      if (particle.visible === false) particle.visible = true;
    }
  }

  _popBubbleParticle(particle, x, y, _trailRadius, strength) {
    const age = fxmGetParticleAge(particle);
    particle._fxmBubblePoppedAge = typeof age === "number" ? age : 0;
    particle._fxmBubblePopped = true;

    const visualRadius = Math.max(3.5, bubbleParticleVisualRadius(particle));
    this._spawnBubblePop(x, y, visualRadius, strength, bubbleParticleTintColor(particle));

    particle.alpha = 0;
    particle.visible = false;
    const maxLife = Number(particle.maxLife ?? particle._maxLife ?? particle.lifeTime ?? particle._lifeTime);
    const endLife = Number.isFinite(maxLife) && maxLife > 0 ? maxLife : 1;
    if (typeof particle.age === "number") particle.age = endLife;
    if (typeof particle._age === "number") particle._age = endLife;
    if (typeof particle.life === "number") particle.life = endLife;
    if (typeof particle._life === "number") particle._life = endLife;
    if (typeof particle.currentLife === "number") particle.currentLife = endLife;
    if (typeof particle._currentLife === "number") particle._currentLife = endLife;
  }

  _spawnBubblePop(x, y, radius, strength, color = 0xffffff) {
    if (!globalThis.PIXI?.Graphics) return;
    const graphic = new PIXI.Graphics();
    graphic.x = x;
    graphic.y = y;
    graphic.eventMode = "none";
    graphic._fxmBubblePopAge = 0;
    graphic._fxmBubblePopLife = 0.34 + 0.18 * strength;
    graphic._fxmBubblePopRadius = radius;
    graphic._fxmBubblePopStrength = strength;
    graphic._fxmBubblePopColor = bubbleNormalizeColor(color, 0xffffff);
    if (globalThis.PIXI?.BLEND_MODES?.ADD !== undefined) graphic.blendMode = PIXI.BLEND_MODES.ADD;
    graphic._fxmBubblePopAngle = (((x * 0.017 + y * 0.031) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    this._fxmBubblePopGraphics ??= [];
    this._fxmBubblePopGraphics.push(graphic);
    this.addChild?.(graphic);
    this._drawBubblePopGraphic(graphic, 0);
  }

  _drawBubblePopArc(graphic, radius, start, end) {
    if (typeof graphic.arc === "function") {
      graphic.arc(0, 0, radius, start, end);
      return;
    }
    graphic.drawCircle(0, 0, radius);
  }

  _drawBubblePopGraphic(graphic, t) {
    const radius = Number(graphic?._fxmBubblePopRadius) || 10;
    const strength = Number(graphic?._fxmBubblePopStrength) || 0.85;
    const color = bubbleNormalizeColor(graphic?._fxmBubblePopColor, 0xffffff);
    const edgeColor = bubbleMixColor(color, 0xffffff, 0.82);
    const sprayColor = bubbleMixColor(color, 0xffffff, 0.72);
    const glintColor = bubbleMixColor(color, 0xffffff, 0.94);
    const angle = Number(graphic?._fxmBubblePopAngle) || 0;
    const clampedT = Math.min(1, Math.max(0, t));
    const ease = 1 - Math.pow(1 - clampedT, 2.4);
    const sprayFade = Math.pow(Math.max(0, 1 - clampedT), 0.82);
    const dotFade = Math.pow(Math.max(0, 1 - clampedT), 0.64);
    const arcFade = Math.pow(Math.max(0, 1 - clampedT / 0.3), 2.15);
    const sprayBase = radius * (0.84 + 0.1 * ease);
    const sprayReach = radius * (0.18 + 0.7 * ease) * (0.86 + 0.3 * strength);
    graphic.clear();

    graphic.lineStyle(Math.max(0.3, radius * 0.012), edgeColor, arcFade * (0.16 + 0.13 * strength));
    for (let i = 0; i < 4; i++) {
      const seed = i + 1;
      const a = angle + seed * 1.61 + Math.sin(seed * 19.31 + radius * 0.19) * 0.3;
      const arcRadius = radius * (0.78 + 0.18 * ease + 0.018 * i);
      const span = 0.18 + 0.08 * ((seed * 7) % 3);
      graphic.moveTo(Math.cos(a - span) * arcRadius, Math.sin(a - span) * arcRadius);
      this._drawBubblePopArc(graphic, arcRadius, a - span, a + span * 0.72);
    }

    for (let i = 0; i < 30; i++) {
      const seed = i + 1;
      const jitter = Math.sin(seed * 12.9898 + radius * 0.371) * 0.32 + Math.sin(seed * 78.233 + radius * 0.113) * 0.14;
      const a = angle + seed * 2.399963 + jitter;
      const randomA = 0.58 + 0.42 * (0.5 + 0.5 * Math.sin(seed * 5.371 + radius * 0.41));
      const randomB = 0.64 + 0.36 * (0.5 + 0.5 * Math.sin(seed * 9.173 + radius * 0.23));
      const start = sprayBase * (0.95 + 0.09 * randomA);
      const travel = sprayReach * (0.36 + 0.76 * randomA);
      const dropletR = start + travel;
      const streakLength = Math.min(
        radius * 0.24,
        Math.max(1.25, radius * (0.07 + 0.03 * randomB) * (1 - clampedT * 0.58)),
      );
      const side = radius * 0.075 * Math.sin(seed * 3.17 + clampedT * 2.1);
      const sx = Math.cos(a) * Math.max(start, dropletR - streakLength) - Math.sin(a) * side;
      const sy = Math.sin(a) * Math.max(start, dropletR - streakLength) + Math.cos(a) * side;
      const ex = Math.cos(a) * dropletR - Math.sin(a) * side * 0.38;
      const ey = Math.sin(a) * dropletR + Math.cos(a) * side * 0.38;
      const lineWidth = Math.max(0.45, Math.min(1.45, radius * (0.016 + 0.006 * (i % 3))));
      const lineAlpha = sprayFade * (0.24 + 0.28 * randomB) * (0.82 + 0.18 * strength);
      graphic.lineStyle(lineWidth, sprayColor, lineAlpha);
      graphic.moveTo(sx, sy);
      graphic.lineTo(ex, ey);
    }

    graphic.lineStyle(0, sprayColor, 0);
    for (let i = 0; i < 26; i++) {
      const seed = i + 1;
      const a = angle + seed * 2.114 + Math.sin(seed * 8.49 + radius * 0.27) * 0.46;
      const randomA = 0.56 + 0.44 * (0.5 + 0.5 * Math.sin(seed * 6.71 + radius * 0.53));
      const randomB = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(seed * 13.17 + radius * 0.29));
      const dotR = sprayBase + sprayReach * (0.34 + 0.82 * randomA);
      const dotSize = Math.max(0.9, Math.min(2.4, radius * (0.026 + 0.016 * randomB) * (1.0 - clampedT * 0.36)));
      const dotAlpha = dotFade * (0.42 + 0.3 * randomA) * (0.82 + 0.18 * strength);
      const dotColor = i % 4 === 0 ? glintColor : sprayColor;
      graphic.beginFill(dotColor, dotAlpha);
      graphic.drawCircle(Math.cos(a) * dotR, Math.sin(a) * dotR, dotSize);
      graphic.endFill();
    }
  }

  _updateBubblePops(dt) {
    const pops = this._fxmBubblePopGraphics;
    if (!Array.isArray(pops) || !pops.length) return;
    const step = Math.max(0, Number(dt) || 0);
    for (let i = pops.length - 1; i >= 0; i--) {
      const graphic = pops[i];
      if (!graphic || graphic.destroyed) {
        pops.splice(i, 1);
        continue;
      }
      graphic._fxmBubblePopAge = (Number(graphic._fxmBubblePopAge) || 0) + step;
      const life = Math.max(0.05, Number(graphic._fxmBubblePopLife) || 0.4);
      const t = Math.min(1, graphic._fxmBubblePopAge / life);
      if (t >= 1) {
        graphic.parent?.removeChild?.(graphic);
        graphic.destroy?.();
        pops.splice(i, 1);
        continue;
      }
      this._drawBubblePopGraphic(graphic, t);
    }
  }

  _clearBubblePops() {
    const pops = this._fxmBubblePopGraphics;
    if (!Array.isArray(pops)) return;
    for (const graphic of pops.splice(0)) {
      graphic?.parent?.removeChild?.(graphic);
      graphic?.destroy?.();
    }
  }

  destroy(options) {
    this._clearBubblePops();
    super.destroy?.(options);
  }

  /** @override */
  getParticleEmitters(options = {}) {
    options = this.constructor.mergeWithDefaults(options);
    const orbit = !!options?.orbit?.value;
    const topDown = !!options?.topDown?.value && !orbit;
    const movementOptions =
      orbit || topDown
        ? {
            ...options,
            directionalMovement: { ...(options?.directionalMovement ?? {}), value: false },
            synchronizedDirection: { ...(options?.synchronizedDirection ?? {}), value: false },
          }
        : options;

    if (!topDown) {
      this._fxmCanvasPanOwnerPosEnabled = false;
      return super.getParticleEmitters(movementOptions);
    }

    this._fxmCanvasPanOwnerPosEnabled = true;

    const d = CONFIG.fxmaster.getParticleDimensions(options);

    const { maxParticles } = this.constructor.computeMaxParticlesFromView(options, {
      minViewCells: this.constructor.MIN_VIEW_CELLS ?? 3000,
    });

    const sceneRadius = Math.sqrt(d.sceneWidth * d.sceneWidth + d.sceneHeight * d.sceneHeight) / 2;

    const config = foundry.utils.deepClone(this.constructor.BUBBLES_CONFIG);
    config.maxParticles = maxParticles;

    const lifetime = config.lifetime ?? 1;
    const lifetimeMin = typeof lifetime === "number" ? lifetime : lifetime.min ?? 1;
    config.frequency = lifetimeMin / maxParticles;

    config.behaviors = (config.behaviors ?? []).filter((b) => b.type !== "rotation" && b.type !== "rotationStatic");
    config.behaviors.push({ type: "rotationStatic", config: { min: 180, max: 180 } });

    this.applyOptionsToConfig(movementOptions, config);

    const moveSpeedBehavior = config.behaviors.find(({ type }) => type === "moveSpeed");
    const moveSpeedList = moveSpeedBehavior?.config?.speed?.list ?? [{ value: 20 }, { value: 60 }];
    const averageSpeed =
      moveSpeedList.reduce((acc, cur) => acc + (cur.value ?? 0), 0) / Math.max(1, moveSpeedList.length);

    const lifetimeMax = typeof config.lifetime === "number" ? config.lifetime : config.lifetime?.max ?? lifetimeMin;

    const holeRadius = this.getTopDownDeadzoneRadius(d);

    const travel = averageSpeed * lifetimeMax;
    const innerRadius = travel + holeRadius;
    const outerRadius = innerRadius + sceneRadius * 2;

    config.behaviors.push({
      type: "spawnShape",
      config: {
        type: "torus",
        data: {
          x: d.sceneRect.x + d.sceneWidth / 2,
          y: d.sceneRect.y + d.sceneHeight / 2,
          radius: outerRadius,
          innerRadius,
          affectRotation: true,
        },
      },
    });

    const emitter = this.createEmitter(config);

    const ctx = options?.__fxmParticleContext ?? this.__fxmParticleContext;
    const scopedContext = CONFIG.fxmaster?.isScopedParticleContext?.(ctx) ?? !!ctx?.dimensions;
    const ownerX = scopedContext ? 0 : canvas.stage.pivot.x - d.sceneX - d.sceneWidth / 2;
    const ownerY = scopedContext ? 0 : canvas.stage.pivot.y - d.sceneY - d.sceneHeight / 2;
    emitter.updateOwnerPos(ownerX, ownerY);

    return [emitter];
  }
}
