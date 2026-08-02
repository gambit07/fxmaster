/**
 * FXMasterParticleEffect (abstract)
 * ---------------------------------
 * Base class for particle effects in FXMaster.
 * - Defines common UI parameters and sensible defaults.
 * - Maps user options (scale, speed, direction, lifetime, tint, alpha) onto
 * PIXI emitter configs.
 * - Provides helpers for pre-warming (play) and graceful teardown (fadeOut).
 * - Includes V1-V2 option converters for scene-dimension-aware values.
 */

import {
  geometricDirectionToScreenDegrees,
  legacyClockwiseDirectionToGeometric,
  roundToDecimals,
} from "../../utils.js";
import { logger } from "../../logger.js";

/** ------------------------------------------------------------------------- */
/** Lateral Movement Helpers                                                  */
/** ------------------------------------------------------------------------- */

/**
 * Convert a PIXI.Ticker delta to seconds using `PIXI.Ticker.shared.deltaMS` for reliable detection.
 *
 * PIXI-particles expects seconds. Foundry and PIXI commonly provide `deltaTime` where `1.0` approximates one 60 fps frame regardless of the actual refresh rate, but some callers may pass raw seconds. The ticker millisecond timestamp is treated as authoritative when available, with heuristic fallback only when the ticker cannot be reached.
 *
 * @param {number} delta - Raw ticker delta value.
 * @returns {number} Elapsed time in seconds, falling back to `1 / 60` for invalid or non-positive inputs.
 */
export function fxmDeltaSeconds(delta) {
  if (typeof delta !== "number" || !Number.isFinite(delta) || delta <= 0) return 1 / 60;

  const ms = PIXI?.Ticker?.shared?.deltaMS;
  if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) {
    return ms / 1000;
  }

  if (delta < 0.034) return delta;
  if (delta < 5) return delta / 60;
  return delta;
}

/**
 * Best-effort particle age access for respawn detection across PIXI-particles versions.
 * @param {any} p
 * @returns {number|undefined}
 */
export function fxmGetParticleAge(p) {
  return typeof p?.age === "number"
    ? p.age
    : typeof p?._age === "number"
    ? p._age
    : typeof p?.life === "number"
    ? p.life
    : typeof p?._life === "number"
    ? p._life
    : typeof p?.currentLife === "number"
    ? p.currentLife
    : typeof p?._currentLife === "number"
    ? p._currentLife
    : typeof p?.agePercent === "number"
    ? p.agePercent
    : undefined;
}

/**
 * Follow the linked-list `next` pointer across PIXI-particles versions.
 * @param {any} p
 * @returns {any|null}
 */
export function fxmNextParticle(p) {
  return p?.next ?? p?._next ?? p?.nextParticle ?? p?._nextParticle ?? p?.__next ?? null;
}

/**
 * Iterate active particles for an emitter with minimal allocations.
 * @param {PIXI.particles.Emitter} emitter
 * @param {(p:any)=>void} fn
 */
export function fxmForEachEmitterParticle(emitter, fn) {
  let p = emitter?._activeParticlesFirst;
  if (p) {
    const max = Math.min(emitter?.particleCount ?? emitter?.maxParticles ?? 10000, 20000);
    for (let i = 0; p && i < max; i++) {
      fn(p);
      p = fxmNextParticle(p);
    }
    return;
  }
}

/**
 * Lerp between angles in radians, taking the shortest wrap-around path.
 * @param {number} a
 * @param {number} b
 * @param {number} t
 * @returns {number}
 */
function fxmAngleLerp(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/**
 * Clamp a number to a finite inclusive range.
 *
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function fxmClampNumber(value, min, max, fallback = min) {
  const n = Number(value);
  const safe = Number.isFinite(n) ? n : fallback;
  return Math.max(min, Math.min(max, safe));
}

/**
 * Read either a raw option or a normalized parameter option.
 *
 * @param {any} value
 * @param {any} fallback
 * @returns {any}
 */
function fxmOptionValue(value, fallback = undefined) {
  if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "value")) return value.value;
  return value === undefined ? fallback : value;
}

const FXM_TOKEN_AVOIDANCE_DISPOSITIONS = Object.freeze(["friendly", "neutral", "hostile", "secret"]);

/**
 * Normalize a Token disposition selection used by particle avoidance.
 * @param {any} value
 * @returns {Set<string>}
 */
function fxmTokenAvoidanceDispositionSelection(value) {
  const raw = fxmOptionValue(value, FXM_TOKEN_AVOIDANCE_DISPOSITIONS);
  const values = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const aliases = new Map([
    ["1", "friendly"],
    ["0", "neutral"],
    ["-1", "hostile"],
    ["-2", "secret"],
  ]);
  const valid = new Set(FXM_TOKEN_AVOIDANCE_DISPOSITIONS);
  const selected = new Set();

  for (const value of values) {
    const normalized = String(value ?? "")
      .trim()
      .toLowerCase();
    const key = aliases.get(normalized) ?? normalized;
    if (valid.has(key)) selected.add(key);
  }

  return selected.size ? selected : new Set(FXM_TOKEN_AVOIDANCE_DISPOSITIONS);
}

/**
 * Resolve the stable disposition key for a Token.
 * @param {Token|object} token
 * @returns {string|null}
 */
function fxmTokenAvoidanceDisposition(token) {
  const value = Number(token?.document?.disposition ?? token?.disposition);
  if (!Number.isFinite(value)) return null;

  const dispositions = globalThis.CONST?.TOKEN_DISPOSITIONS ?? {};
  if (value === Number(dispositions.FRIENDLY ?? 1)) return "friendly";
  if (value === Number(dispositions.NEUTRAL ?? 0)) return "neutral";
  if (value === Number(dispositions.HOSTILE ?? -1)) return "hostile";
  if (value === Number(dispositions.SECRET ?? -2)) return "secret";
  return null;
}

/**
 * Stable token identifier used by particle token avoidance.
 * @param {Token|object} token
 * @returns {string}
 */
function fxmTokenAvoidanceId(token) {
  return String(token?.document?.uuid ?? token?.document?.id ?? token?.id ?? token?.objectId ?? "");
}

/**
 * Return whether a Token is a visible avoidance source.
 * @param {Token|object} token
 * @returns {boolean}
 */
function fxmTokenAvoidanceVisible(token) {
  if (!token || token.destroyed) return false;
  if (token.document?.hidden) return false;
  if (token.visible === false) return false;
  if (token.alpha === 0) return false;
  return true;
}

/**
 * Resolve token center in world/canvas coordinates.
 * @param {Token|object} token
 * @returns {{x:number,y:number}|null}
 */
function fxmTokenAvoidanceCenter(token) {
  const c = token?.center;
  const cx = Number(c?.x);
  const cy = Number(c?.y);
  if (Number.isFinite(cx) && Number.isFinite(cy)) return { x: cx, y: cy };

  const grid = Number(canvas?.dimensions?.size) || 100;
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

/**
 * Resolve a token footprint size in world/canvas pixels.
 * @param {Token|object} token
 * @returns {number}
 */
function fxmTokenAvoidanceFootprint(token) {
  const grid = Number(canvas?.dimensions?.size) || 100;
  const docWidth = Number(token?.document?.width);
  const docHeight = Number(token?.document?.height);
  const w = Number(token?.w ?? token?.width ?? (Number.isFinite(docWidth) && docWidth > 0 ? docWidth * grid : grid));
  const h = Number(
    token?.h ?? token?.height ?? (Number.isFinite(docHeight) && docHeight > 0 ? docHeight * grid : grid),
  );
  return Math.max(grid * 0.35, Number.isFinite(w) && w > 0 ? w : grid, Number.isFinite(h) && h > 0 ? h : grid);
}

/**
 * Steer the actual PIXI-particles movement velocity toward a target direction.
 *
 * The movement behaviors rotate and then keep a velocity vector on particle.config.velocity. Visual rotation alone does not redirect native particle travel, so creature avoidance must turn that vector as well as the sprite.
 *
 * @param {any} particle
 * @param {number} nx
 * @param {number} ny
 * @param {number} t
 * @param {number} fallbackSpeed
 * @returns {boolean}
 */
function fxmSteerParticleVelocity(particle, nx, ny, t, fallbackSpeed = 0) {
  const velocity = particle?.config?.velocity ?? particle?.velocity ?? particle?._velocity;
  if (!velocity || typeof velocity !== "object") return false;

  const vx = Number(velocity.x);
  const vy = Number(velocity.y);
  let speed = Math.hypot(Number.isFinite(vx) ? vx : 0, Number.isFinite(vy) ? vy : 0);
  if (!(speed > 0.001)) speed = Math.max(0, Number(fallbackSpeed) || 0);
  if (!(speed > 0.001)) return false;

  const curX = Number.isFinite(vx) && Number.isFinite(vy) && Math.hypot(vx, vy) > 0.001 ? vx / Math.hypot(vx, vy) : nx;
  const curY = Number.isFinite(vx) && Number.isFinite(vy) && Math.hypot(vx, vy) > 0.001 ? vy / Math.hypot(vx, vy) : ny;
  const blendX = curX * (1 - t) + nx * t;
  const blendY = curY * (1 - t) + ny * t;
  const blendLen = Math.hypot(blendX, blendY) || 1;
  const outX = (blendX / blendLen) * speed;
  const outY = (blendY / blendLen) * speed;

  if (typeof velocity.set === "function") velocity.set(outX, outY);
  else {
    velocity.x = outX;
    velocity.y = outY;
  }
  return true;
}

/**
 * Read the current PIXI-particles velocity vector, if one exists.
 * @param {any} particle
 * @returns {{x:number,y:number,speed:number}|null}
 */
function fxmParticleVelocityVector(particle) {
  const velocity = particle?.config?.velocity ?? particle?.velocity ?? particle?._velocity;
  if (!velocity || typeof velocity !== "object") return null;
  const vx = Number(velocity.x);
  const vy = Number(velocity.y);
  if (!Number.isFinite(vx) || !Number.isFinite(vy)) return null;
  const speed = Math.hypot(vx, vy);
  if (!(speed > 0.001)) return null;
  return { x: vx / speed, y: vy / speed, speed };
}

/**
 * Resolve a particle's canvas-space position.
 * @param {any} particle
 * @returns {{x:number,y:number}|null}
 */
function fxmParticlePosition(particle) {
  const x = Number(particle?.x ?? particle?.position?.x);
  const y = Number(particle?.y ?? particle?.position?.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/**
 * Write a particle's canvas-space position.
 * @param {any} particle
 * @param {number} x
 * @param {number} y
 * @returns {void}
 */
function fxmSetParticlePosition(particle, x, y) {
  if (!particle || !Number.isFinite(x) || !Number.isFinite(y)) return;
  if (particle.position) {
    particle.position.x = x;
    particle.position.y = y;
    return;
  }
  particle.x = x;
  particle.y = y;
}

/**
 * Steer a particle's observed displacement toward a target direction.
 * @param {any} particle
 * @param {number} nx
 * @param {number} ny
 * @param {number} t
 * @returns {boolean}
 */
function fxmSteerParticleDisplacement(particle, nx, ny, t) {
  const pos = fxmParticlePosition(particle);
  if (!pos) return false;

  const last = particle._fxmSyncLastPosition;
  particle._fxmSyncLastPosition = { x: pos.x, y: pos.y };
  if (!last || !Number.isFinite(last.x) || !Number.isFinite(last.y)) return false;

  const dx = pos.x - last.x;
  const dy = pos.y - last.y;
  const distance = Math.hypot(dx, dy);
  if (!(distance > 0.001)) return false;

  const curX = dx / distance;
  const curY = dy / distance;
  const blendX = curX * (1 - t) + nx * t;
  const blendY = curY * (1 - t) + ny * t;
  const blendLen = Math.hypot(blendX, blendY) || 1;
  const outX = last.x + (blendX / blendLen) * distance;
  const outY = last.y + (blendY / blendLen) * distance;
  fxmSetParticlePosition(particle, outX, outY);
  particle._fxmSyncLastPosition = { x: outX, y: outY };
  return true;
}

function fxmEmitterConfig(emitter) {
  return emitter?._fxmOrbitConfig ?? emitter?._fxmSynchronizedDirectionConfig ?? null;
}

function fxmEmitterHasMovePath(config) {
  return Array.isArray(config?.behaviors) && config.behaviors.some((b) => b?.type === "movePath");
}

function fxmRotatePointRadians(angle, x, y) {
  const s = Math.sin(angle);
  const c = Math.cos(angle);
  return { x: x * c - y * s, y: x * s + y * c };
}

function fxmRetargetMovePathParticle(particle, pathBehavior, targetRadians, t) {
  const cfg = particle?.config;
  if (!cfg || !pathBehavior || typeof pathBehavior.path !== "function") return false;

  const movement = Number(cfg.movement);
  if (!Number.isFinite(movement)) return false;

  const position = particle.position ?? particle;
  const px = Number(position?.x);
  const py = Number(position?.y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) return false;

  const current = Number.isFinite(Number(cfg.initRotation))
    ? Number(cfg.initRotation)
    : Number(particle.rotation) || targetRadians;
  const next = fxmAngleLerp(current, targetRadians, t);
  if (Math.abs(next - current) < 1e-5) return true;

  const pathY = Number(pathBehavior.path(movement));
  if (!Number.isFinite(pathY)) return false;

  const offset = fxmRotatePointRadians(next, movement, pathY);
  cfg.initRotation = next;
  if (!cfg.initPosition) cfg.initPosition = { x: px - offset.x, y: py - offset.y };
  else if (typeof cfg.initPosition.set === "function") cfg.initPosition.set(px - offset.x, py - offset.y);
  else {
    cfg.initPosition.x = px - offset.x;
    cfg.initPosition.y = py - offset.y;
  }

  return true;
}

function fxmRetargetEmitterRotationBehaviors(emitter, targetRadians) {
  const rotation = typeof emitter?.getBehavior === "function" ? emitter.getBehavior("rotation") : null;
  if (rotation && Number.isFinite(rotation.minStart) && Number.isFinite(rotation.maxStart)) {
    rotation._fxmSynchronizedDirectionRange ??= rotation.maxStart - rotation.minStart;
    const range = Number.isFinite(rotation._fxmSynchronizedDirectionRange)
      ? rotation._fxmSynchronizedDirectionRange
      : 0;
    rotation.minStart = targetRadians - range * 0.5;
    rotation.maxStart = targetRadians + range * 0.5;
  }

  const rotationStatic = typeof emitter?.getBehavior === "function" ? emitter.getBehavior("rotationStatic") : null;
  if (rotationStatic && Number.isFinite(rotationStatic.min) && Number.isFinite(rotationStatic.max)) {
    rotationStatic._fxmSynchronizedDirectionRange ??= rotationStatic.max - rotationStatic.min;
    const range = Number.isFinite(rotationStatic._fxmSynchronizedDirectionRange)
      ? rotationStatic._fxmSynchronizedDirectionRange
      : 0;
    rotationStatic.min = targetRadians - range * 0.5;
    rotationStatic.max = targetRadians + range * 0.5;
  }
}

/**
 * Locate the rectangle used for orbit geometry.
 *
 * @param {PIXI.particles.EmitterConfigV3|object} config
 * @returns {{x:number,y:number,w:number,h:number}}
 */
function fxmOrbitRectFromConfig(config) {
  const spawn = (config?.behaviors ?? []).find(
    (behavior) => behavior?.type === "spawnShape" && behavior?.config?.type === "rect" && behavior?.config?.data,
  );
  const rect = config?._activeRect ?? spawn?.config?.data ?? canvas?.dimensions?.sceneRect ?? canvas?.dimensions ?? {};
  const x = Number(rect.x ?? rect.sceneX ?? 0) || 0;
  const y = Number(rect.y ?? rect.sceneY ?? 0) || 0;
  const w = Math.max(1, Number(rect.w ?? rect.width ?? rect.sceneWidth ?? 1) || 1);
  const h = Math.max(1, Number(rect.h ?? rect.height ?? rect.sceneHeight ?? 1) || 1);
  return { x, y, w, h };
}

/**
 * Compute a ring inside a rectangle for orbit movement.
 *
 * @param {number} minDimension
 * @param {number} distance
 * @returns {{min:number,max:number}}
 */
function fxmOrbitRadii(minDimension, distance) {
  const base = Math.max(1, minDimension) * 0.48;
  const outer = base * (0.3 + 0.7 * fxmClampNumber(distance, 0, 1, 0.5));
  return { min: Math.max(1, outer * 0.65), max: Math.max(1, outer) };
}

/**
 * Abstract particle effect with parameter plumbing and utilities. Subclasses must provide a PIXI EmitterConfig via `defaultConfig`.
 */
export class FXMasterParticleEffect extends CONFIG.fxmaster.ParticleEffectNS {
  /** Human-readable label, typically a localization key. */
  static label = "FXMASTER.Common.ParticleEffect";

  /**
   * Hide this effect from the management UI. Useful for backwards-compatibility aliases that should still load from scene flags.
   */
  static hidden = false;

  /**
   * Whether this effect should keep its emitters' ownerPos synced to the current canvas pan.
   *
   * Do not define this as a class field. The FXMaster particle emitter container builds emitters during its constructor, and many FXMaster effects toggle this flag inside getParticleEmitters(). Class fields are initialized after super(), which would overwrite whatever getParticleEmitters() set and break pan re-centering.
   *
   * Subclasses should set `this._fxmCanvasPanOwnerPosEnabled = true/false` while building emitters.
   *
   * @type {boolean|undefined}
   * @protected
   */

  /**
   * The id of the canvasPan hook registered by this effect.
   * @type {number|Function|undefined}
   * @private
   */

  /** Effect group used by the weather UI. */
  static get group() {
    return "other";
  }

  /** Icon path shown in the UI. */
  static get icon() {
    return "modules/fxmaster/assets/particle-effects/icons/snow.webp";
  }

  /**
   * Lateral Movement period range (seconds) used for per-particle sine drift.
   *
   * Subclasses can override these getters to tune how long each side-to-side glide takes.
   */
  static get lateralMovementPeriodMin() {
    return 10;
  }

  static get lateralMovementPeriodMax() {
    return 20;
  }

  /**
   * Lateral Movement amplitude multiplier.
   *
   * Small sprite-based effects (rats/spiders) can override this to make the lateral drift more noticeable without needing extreme strength values.
   */
  static get lateralMovementAmplitudeFactor() {
    return 1;
  }

  /**
   * Minimum lateral movement amplitude in pixels (at strength=1).
   *
   * This prevents sub-pixel drift for very small sprites where size-based scaling would otherwise be imperceptible.
   */
  static get lateralMovementAmplitudeMinPx() {
    return 0;
  }

  /** Whether orbit movement rotates particles toward their path tangent. */
  static get orbitFacesTangent() {
    return true;
  }

  /** Parameter schema used to render controls and hold defaults. */
  static get parameters() {
    return {
      belowTokens: { label: "FXMASTER.Params.BelowTokens", type: "checkbox", value: false },
      belowTiles: { label: "FXMASTER.Params.BelowTiles", type: "checkbox", value: false },
      soundFxEnabled: { label: "FXMASTER.Params.SoundFxEnabled", type: "checkbox", value: false },
      tint: { label: "FXMASTER.Params.Tint", type: "color", value: { value: "#FFFFFF", apply: false } },
      scale: { label: "FXMASTER.Params.Scale", type: "range", min: 0.1, value: 1, max: 5, step: 0.1, decimals: 1 },
      direction: {
        label: "FXMASTER.Params.Direction",
        type: "range",
        min: 0,
        value: this.defaultDirection,
        max: 360,
        step: 5,
        decimals: 0,
        compassDirection: true,
      },
      speed: { label: "FXMASTER.Params.Speed", type: "range", min: 0.1, value: 1, max: 5, step: 0.1, decimals: 1 },
      lifetime: {
        label: "FXMASTER.Params.Lifetime",
        type: "range",
        min: 0.1,
        value: 1,
        max: 5,
        step: 0.1,
        decimals: 1,
      },
      density: {
        label: "FXMASTER.Params.Density",
        type: "range",
        min: 0.1,
        value: 0.5,
        max: 5,
        step: 0.1,
        decimals: 1,
      },
      alpha: { label: "FXMASTER.Params.Opacity", type: "range", min: 0, value: 1, max: 1, step: 0.1, decimals: 1 },
    };
  }

  /** Shared direction synchronization control used by wind-driven effects. */
  static get synchronizedDirectionParameter() {
    return {
      label: "FXMASTER.Params.SynchronizedDirection",
      type: "checkbox",
      value: false,
      tooltip: "FXMASTER.ParamTooltips.SynchronizedDirection",
    };
  }

  /** Shared optional DropShadowFilter controls used by particles that support wrapper-level shadows. */
  static get shadowParameters() {
    return {
      dropShadow: { label: "FXMASTER.Params.Shadow", type: "checkbox", value: false },
      shadowOnly: {
        label: "FXMASTER.Params.ShadowOnly",
        type: "checkbox",
        value: false,
        showWhen: { dropShadow: true },
      },
      shadowRotation: {
        label: "FXMASTER.Params.ShadowRotation",
        type: "range",
        min: 0,
        value: 315,
        max: 360,
        step: 1,
        decimals: 0,
        showWhen: { dropShadow: true },
      },
      shadowDistance: {
        label: "FXMASTER.Params.ShadowDistance",
        type: "range",
        min: 0,
        value: 70,
        max: 300,
        step: 1,
        decimals: 0,
        showWhen: { dropShadow: true },
      },
      shadowBlur: {
        label: "FXMASTER.Params.ShadowBlur",
        type: "range",
        min: 0,
        value: 2,
        max: 20,
        step: 0.5,
        decimals: 1,
        showWhen: { dropShadow: true },
      },
      shadowOpacity: {
        label: "FXMASTER.Params.ShadowOpacity",
        type: "range",
        min: 0,
        value: 1,
        max: 1,
        step: 0.05,
        decimals: 2,
        showWhen: { dropShadow: true },
      },
    };
  }

  /** Merge provided options into the parameter schema without inserting new keys. */
  static mergeWithDefaults(options) {
    const merged = foundry.utils.mergeObject(this.parameters, options, { insertKeys: false, inplace: false });

    if (options && typeof options === "object") {
      for (const [k, v] of Object.entries(options)) {
        if (k in merged) continue;
        if (k.startsWith("__") || k.startsWith("_")) merged[k] = v;
      }
    }

    return CONFIG.fxmaster?.normalizeEffectOptionsForRuntime?.(this, merged) ?? merged;
  }

  /**
   * Default PIXI emitter configuration for the effect. Subclasses must override.
   * @returns {PIXI.particles.EmitterConfigV3}
   */
  static get defaultConfig() {
    throw new Error("Subclasses of FXMasterParticleEffect must implement defaultConfig");
  }

  /** Rounded default direction derived from the default config, if any. */
  static get defaultDirection() {
    const step = 5;

    const rotationBehavior = this.defaultConfig.behaviors.find((b) => b.type === "rotation");
    if (rotationBehavior !== undefined) {
      const avg = (rotationBehavior.config.minStart + rotationBehavior.config.maxStart) / 2;
      return Math.round(legacyClockwiseDirectionToGeometric(avg) / step) * step;
    }

    const rotationStatic = this.defaultConfig.behaviors.find((b) => b.type === "rotationStatic");
    if (rotationStatic !== undefined) {
      const avg = (rotationStatic.config.min + rotationStatic.config.max) / 2;
      return Math.round(legacyClockwiseDirectionToGeometric(avg) / step) * step;
    }

    return undefined;
  }

  /** Flat map of parameter defaults (parameterName → value). */
  static get default() {
    return Object.fromEntries(Object.entries(this.parameters).map(([name, cfg]) => [name, cfg.value]));
  }

  /**
   * Global density scalar applied on top of user density and performance mode. Subclasses may override to make their effect globally denser or sparser.
   */
  static get densityScalar() {
    return 0.25;
  }

  /** Default soft toggle fade duration used by standard particle effects. */
  static get defaultFadeDurationMs() {
    return 3000;
  }

  /** Whether this effect should prewarm even when it is being soft-created at alpha 0 for a fade-in. */
  static get softFadePrewarm() {
    return false;
  }

  /**
   * Compute a density scale factor from Foundry's canvas Performance Mode. MAX = 1.0, HIGH = 0.75, MED = 0.5, LOW = 0.25 Falls back to 1.0 if the setting or CONST are unavailable.
   */
  static getPerformanceDensityScale() {
    let scale = 1.0;

    try {
      const mode = game.settings.get("core", "performanceMode");
      const PM = globalThis.CONST?.CANVAS_PERFORMANCE_MODES;

      if (PM && typeof mode === "number") {
        switch (mode) {
          case PM.LOW:
            scale = 0.25;
            break;
          case PM.MED:
            scale = 0.5;
            break;
          case PM.HIGH:
            scale = 0.75;
            break;
          case PM.MAX:
            scale = 1.0;
            break;
          default:
            scale = 1.0;
            break;
        }
      }
    } catch {
      scale = 1.0;
    }

    return scale;
  }

  /**
   * Convenience helper: take a base density (e.g. from options.density.value) and apply both performance-mode scaling and the class's densityScalar.
   * @param {number} baseDensity
   * @returns {number}
   */
  static getScaledDensity(baseDensity) {
    const perfScale = this.getPerformanceDensityScale();
    return (Number(baseDensity) || 0) * perfScale * this.densityScalar;
  }

  /**
   * Default deadzone scaling for top-down effects. Subclasses may override these getters to tweak the size of the empty center area.
   *
   * The returned values are relative to the current view size and grid size.
   *
   * - factor: viewMin * factor
   * - minGrid: at least (gridSize * minGrid)
   * - maxGrid: at most  (gridSize * maxGrid)
   */
  static get topDownDeadzoneFactor() {
    return 0.075;
  }

  static get topDownDeadzoneMinGrid() {
    return 0.5;
  }

  static get topDownDeadzoneMaxGrid() {
    return 3.0;
  }

  /**
   * Compute the radius (in pixels) of the "dead zone" at the view center for top-down effects. Particles should not fully converge into this region.
   *
   * Effects should add this radius to their computed travel distance when setting a torus spawnShape's innerRadius.
   *
   * @param {object} d Particle dimension object from CONFIG.fxmaster.getParticleDimensions(...)
   * @returns {number}
   */
  getTopDownDeadzoneRadius(d) {
    const viewW = d?.width ?? d?.sceneWidth ?? canvas?.dimensions?.width ?? 0;
    const viewH = d?.height ?? d?.sceneHeight ?? canvas?.dimensions?.height ?? 0;
    const viewMin = Math.max(0, Math.min(viewW, viewH));

    const grid = d?.size ?? canvas?.dimensions?.size ?? 100;

    const factor = Number(this.constructor.topDownDeadzoneFactor ?? 0.075);
    const minGrid = Number(this.constructor.topDownDeadzoneMinGrid ?? 0.5);
    const maxGrid = Number(this.constructor.topDownDeadzoneMaxGrid ?? 3.0);

    const scaled = viewMin * (Number.isFinite(factor) ? factor : 0.075);
    const minPx = grid * (Number.isFinite(minGrid) ? minGrid : 0.5);
    const maxPx = grid * (Number.isFinite(maxGrid) ? maxGrid : 3.0);

    return Math.max(minPx, Math.min(scaled, maxPx));
  }

  /** Apply user options onto a mutable emitter config. */
  applyOptionsToConfig(options, config) {
    this._fxmLastOptions = options;

    this._applyScaleToConfig(options, config);
    this._applySpeedToConfig(options, config);
    this._applyDirectionalMovementToConfig(options, config);
    this._applyDirectionToConfig(options, config);
    this._applyLifetimeToConfig(options, config);
    this._applyTintToConfig(options, config);
    this._applyAlphaToConfig(options, config);
    this._applyDropShadowToConfig(options, config);
  }

  /** Multiply a stepped value-list by a factor. */
  _applyFactorToValueList(valueList, factor) {
    valueList.list = valueList.list.map((step) => ({ ...step, value: step.value * factor }));
  }

  /** Multiply a ranged number (min/max) by a factor. */
  _applyFactorToRandNumber(randNumber, factor) {
    randNumber.min *= factor;
    randNumber.max *= factor;
  }

  /** Scale size behaviors relative to grid size and user scale. */
  _applyScaleToConfig(options, config) {
    const factor = (options.scale?.value ?? 1) * (canvas.dimensions.size / 100);

    config.behaviors
      .filter((b) => b.type === "scale")
      .forEach(({ config }) => this._applyFactorToValueList(config.scale, factor));

    config.behaviors
      .filter((b) => b.type === "scaleStatic")
      .forEach(({ config }) => this._applyFactorToRandNumber(config, factor));
  }

  /** Scale velocities, lifetimes, and spawn frequency coherently. */
  _applySpeedToConfig(options, config) {
    const factor = (options.speed?.value ?? 1) * (canvas.dimensions.size / 100);

    config.behaviors
      .filter((b) => ["moveSpeed", "movePath"].includes(b.type))
      .forEach(({ config }) => this._applyFactorToValueList(config.speed, factor));

    config.behaviors
      .filter((b) => b.type === "moveSpeedStatic")
      .forEach(({ config }) => this._applyFactorToRandNumber(config, factor));

    this._applyFactorToRandNumber(config.lifetime, 1 / factor);
    config.frequency /= factor;
  }

  /**
   * If Directional Movement is enabled, collapse direction variance so that applying the direction parameter results in coherent travel direction.
   *
   * This is primarily intended for animal effects, which otherwise pick a random rotation per particle.
   */
  _applyDirectionalMovementToConfig(options, config) {
    const enabled = !!options?.directionalMovement?.value;
    if (!enabled) return;

    const behaviors = config.behaviors ?? [];

    behaviors
      .filter((b) => b.type === "rotation")
      .forEach((b) => {
        const cfg = b?.config;
        const minStart = Number(cfg?.minStart);
        const maxStart = Number(cfg?.maxStart);
        if (!Number.isFinite(minStart) || !Number.isFinite(maxStart)) return;
        const avg = (minStart + maxStart) / 2;
        cfg.minStart = avg;
        cfg.maxStart = avg;

        if (cfg.minSpeed !== undefined) cfg.minSpeed = 0;
        if (cfg.maxSpeed !== undefined) cfg.maxSpeed = 0;
        if (cfg.accel !== undefined) cfg.accel = 0;
      });

    behaviors
      .filter((b) => b.type === "rotationStatic")
      .forEach((b) => {
        const cfg = b?.config;
        const min = Number(cfg?.min);
        const max = Number(cfg?.max);
        if (!Number.isFinite(min) || !Number.isFinite(max)) return;
        const avg = (min + max) / 2;
        cfg.min = avg;
        cfg.max = avg;
      });
  }

  /** Center rotation ranges on the chosen direction while preserving spread. */
  _applyDirectionToConfig(options, config) {
    if (options?.topDown?.value) return;

    const directionalEnabled = !!options?.directionalMovement?.value;
    if (options?.directionalMovement && !directionalEnabled) return;

    let direction = options.direction?.value;
    if (direction === undefined) return;
    direction =
      CONFIG.fxmaster?.resolveSynchronizedDirection?.(options, direction, options?.__fxmParticleContext) ?? direction;

    const screenDirection = geometricDirectionToScreenDegrees(direction);

    const spreadRaw = options?.spread?.value;
    const spread =
      directionalEnabled && Number.isFinite(Number(spreadRaw)) ? Math.min(20, Math.max(0, Number(spreadRaw))) : null;

    config.behaviors
      .filter((b) => b.type === "rotation")
      .forEach(({ config }) => {
        const range = spread !== null ? spread * 2 : config.maxStart - config.minStart;
        config.minStart = screenDirection - range / 2;
        config.maxStart = screenDirection + range / 2;
      });

    config.behaviors
      .filter((b) => b.type === "rotationStatic")
      .forEach(({ config }) => {
        const range = spread !== null ? spread * 2 : config.max - config.min;
        config.min = screenDirection - range / 2;
        config.max = screenDirection + range / 2;
      });
  }

  /** Adjust emitter lifetime and frequency together. */
  _applyLifetimeToConfig(options, config) {
    const factor = options.lifetime?.value ?? 1;
    this._applyFactorToRandNumber(config.lifetime, factor);
    config.frequency *= factor;
  }

  static normalizeParticleEmitterColor(value, fallback = null) {
    if (value == null) return fallback;

    if (typeof value === "string") {
      let hex = value.trim();
      if (!hex) return fallback;
      if (hex.startsWith("#")) hex = hex.slice(1);
      if (/^0x/i.test(hex)) hex = hex.slice(2);
      if (hex.length === 3)
        hex = hex
          .split("")
          .map((ch) => ch + ch)
          .join("");
      return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex.toLowerCase()}` : fallback;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return `#${((value >>> 0) & 0xffffff).toString(16).padStart(6, "0")}`;
    }

    if (Array.isArray(value) && value.length >= 3) {
      const channels = value.slice(0, 3).map((channel) => Number(channel));
      if (!channels.every((channel) => Number.isFinite(channel))) return fallback;
      const scale = channels.every((channel) => channel >= 0 && channel <= 1) ? 255 : 1;
      const packed = channels
        .map((channel) => Math.clamp(Math.round(channel * scale), 0, 255))
        .reduce((acc, channel) => (acc << 8) | channel, 0);
      return `#${packed.toString(16).padStart(6, "0")}`;
    }

    if (typeof value === "object") {
      if ("value" in value) return this.normalizeParticleEmitterColor(value.value, fallback);
      if ("color" in value) return this.normalizeParticleEmitterColor(value.color, fallback);

      const r = value.r ?? value.red;
      const g = value.g ?? value.green;
      const b = value.b ?? value.blue;
      if ([r, g, b].every((channel) => Number.isFinite(Number(channel)))) {
        return this.normalizeParticleEmitterColor([r, g, b], fallback);
      }
    }

    return fallback;
  }

  static sanitizeParticleEmitterColorBehaviors(config) {
    for (const behavior of config?.behaviors ?? []) {
      if (behavior?.type === "colorStatic") {
        behavior.config ??= {};
        behavior.config.color = this.normalizeParticleEmitterColor(behavior.config.color, "#ffffff");
        continue;
      }

      if (behavior?.type !== "color") continue;
      const colorConfig = behavior.config?.color;
      if (Array.isArray(colorConfig?.list)) {
        for (const entry of colorConfig.list) {
          if (entry && "value" in entry) entry.value = this.normalizeParticleEmitterColor(entry.value, "#ffffff");
        }
      } else if (colorConfig && typeof colorConfig === "object") {
        if ("start" in colorConfig)
          colorConfig.start = this.normalizeParticleEmitterColor(colorConfig.start, "#ffffff");
        if ("end" in colorConfig) colorConfig.end = this.normalizeParticleEmitterColor(colorConfig.end, "#ffffff");
      }
    }
  }

  _resolveTintOption(options) {
    const tint = options?.tint;
    const payload = tint?.value && typeof tint.value === "object" ? tint.value : tint;
    const apply = !!(payload?.apply ?? tint?.apply);
    if (!apply) return null;

    return this.constructor.normalizeParticleEmitterColor(payload?.value ?? tint?.value ?? tint, null);
  }

  /** Apply a solid tint by replacing color behaviors when requested. */
  _applyTintToConfig(options, config) {
    const value = this._resolveTintOption(options);
    if (!value) return;
    config.behaviors = config.behaviors
      .filter(({ type }) => type !== "color" && type !== "colorStatic")
      .concat({ type: "colorStatic", config: { color: value } });
  }

  /** Modulate alpha behaviors by a scalar factor. */
  _applyAlphaToConfig(options, config) {
    const factor = options.alpha?.value ?? 1;

    config.behaviors
      .filter((b) => b.type === "alpha")
      .forEach(({ config }) => this._applyFactorToValueList(config.alpha, factor));

    config.behaviors
      .filter((b) => b.type === "alphaStatic")
      .forEach(({ config }) => {
        config.alpha *= factor;
      });
  }

  /** Copy shared DropShadowFilter options onto the emitter config. */
  _applyDropShadowToConfig(options, config) {
    if (!options?.dropShadow) return;

    config._dropShadowEnabled = !!options.dropShadow?.value;
    config._dropShadowOnly = !!options.shadowOnly?.value;
    config._dropshadowRotation = Number.isFinite(options.shadowRotation?.value) ? options.shadowRotation.value : 315;
    config._dropshadowDistance = Number.isFinite(options.shadowDistance?.value)
      ? options.shadowDistance.value
      : Math.hypot(50, 50);
    config._dropshadowBlur = Number.isFinite(options.shadowBlur?.value) ? options.shadowBlur.value : 2;
    config._dropshadowOpacity = Number.isFinite(options.shadowOpacity?.value) ? options.shadowOpacity.value : 1;
  }

  /** ----------------------------------------------------------------------- */
  /** Lateral Movement                                                         */
  /** ----------------------------------------------------------------------- */

  /**
   * Create an emitter using the configured FXMaster particle emitter container and then attach FXMaster wrappers before autoUpdate is bound to the ticker.
   *
   * @param {PIXI.particles.EmitterConfigV3} config
   * @returns {PIXI.particles.Emitter}
   */
  createEmitter(config) {
    const baseCreate = super.createEmitter?.bind(this);
    const emitter = config?._dropShadowEnabled
      ? this._fxmCreateDropShadowEmitter(config)
      : baseCreate
      ? baseCreate(config)
      : new PIXI.particles.Emitter(this, config);

    try {
      config._fxmOrbitFacesTangent = this.constructor.orbitFacesTangent !== false;
      emitter._fxmOrbitConfig = config;
      emitter._fxmOrbitFacesTangent = config._fxmOrbitFacesTangent;
      const opts = this._fxmLastOptions ?? this.options ?? {};
      this._fxmInstallLateralMovement(emitter, opts, { wrap: true });
      this._fxmInstallOrbitMovement(emitter, opts, { wrap: true });
      this._fxmInstallSynchronizedDirection(emitter, opts, { wrap: true });
      this._fxmInstallTokenAvoidance(emitter, opts, { wrap: true });
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    return emitter;
  }

  /**
   * Create an emitter inside a wrapper container and apply a wrapper-level DropShadowFilter.
   * @param {PIXI.particles.EmitterConfigV3 & { _dropShadowEnabled?: boolean, _dropShadowOnly?: boolean, _dropshadowRotation?: number, _dropshadowDistance?: number, _dropshadowBlur?: number, _dropshadowOpacity?: number }} config
   * @returns {PIXI.particles.Emitter}
   * @protected
   */
  _fxmCreateDropShadowEmitter(config) {
    const wrapper = new PIXI.Container();
    this.addChild(wrapper);

    config.autoUpdate = true;
    config.emit = false;
    const emitter = new PIXI.particles.Emitter(wrapper, config);

    if (!config._dropShadowEnabled) return emitter;
    this._fxmApplyDropShadowFilter(wrapper, emitter, config);
    return emitter;
  }

  /**
   * Apply and lifecycle-manage a DropShadowFilter for an emitter wrapper.
   * @param {PIXI.Container} wrapper
   * @param {PIXI.particles.Emitter} emitter
   * @param {object} config
   * @protected
   */
  _fxmApplyDropShadowFilter(wrapper, emitter, config) {
    const r = CONFIG.fxmaster.getParticleRenderer?.(this);
    const DropShadowCtor = PIXI?.filters?.DropShadowFilter;
    if (!r || !DropShadowCtor || !wrapper || !emitter) return;

    const BASE_OFFSET = { x: 50, y: -50 };
    const baseDistance = Math.hypot(BASE_OFFSET.x, BASE_OFFSET.y) || 50;

    const angleDeg = Number.isFinite(config._dropshadowRotation) ? config._dropshadowRotation : 315;
    const angleRad = Math.toRadians(angleDeg);
    const distance = Number.isFinite(config._dropshadowDistance) ? config._dropshadowDistance : baseDistance;
    const blur = Number.isFinite(config._dropshadowBlur) ? config._dropshadowBlur : 1;
    const alpha = Number.isFinite(config._dropshadowOpacity) ? config._dropshadowOpacity : 0.5;
    const shadowOnly = !!config._dropShadowOnly;

    const dir = { x: Math.cos(angleRad), y: Math.sin(angleRad) };
    const screenRect = new PIXI.Rectangle(0, 0, 1, 1);

    const updateScreenRect = () => {
      const scr = r.screen;
      screenRect.x = 0;
      screenRect.y = 0;
      screenRect.width = Math.max(1, scr.width | 0);
      screenRect.height = Math.max(1, scr.height | 0);
    };

    updateScreenRect();

    const shadow = new DropShadowCtor({
      offset: { x: 0, y: 0 },
      blur,
      alpha,
      color: 0x000000,
      quality: 20,
      shadowOnly,
      resolution: r.resolution || window.devicePixelRatio || 1,
    });

    shadow.autoFit = false;
    shadow.padding = 0;

    wrapper.filterArea = screenRect;
    shadow.filterArea = screenRect;

    const clampShadowResolution = () => {
      try {
        const gl = r.gl;
        const maxTex = gl?.getParameter?.(gl.MAX_TEXTURE_SIZE) || 8192;

        const wCSS = Math.max(1, screenRect.width | 0);
        const hCSS = Math.max(1, screenRect.height | 0);
        const maxDim = Math.max(wCSS, hCSS);

        const baseRes = r.resolution || window.devicePixelRatio || 1;
        const safeRes = Math.max(0.5, Math.min(baseRes, maxTex / maxDim));

        if (!Number.isFinite(safeRes) || safeRes <= 0) {
          shadow.enabled = false;
          shadow.alpha = 0;
          return;
        }

        if (!Number.isFinite(shadow.resolution) || shadow.resolution > safeRes || shadow.resolution <= 0) {
          shadow.resolution = safeRes;
        }
      } catch {
        try {
          shadow.enabled = false;
          shadow.alpha = 0;
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }
    };

    clampShadowResolution();

    const existing = wrapper.filters ?? null;
    wrapper.filters = existing ? existing.concat([shadow]) : [shadow];

    let lastOffX = NaN;
    let lastOffY = NaN;
    let lastBlur = NaN;
    let lastAlpha = NaN;
    let lastShadowOnly = undefined;

    const tick = () => {
      const zoom = canvas?.stage?.scale?.x ?? 1;

      const offX = dir.x * distance * zoom;
      const offY = dir.y * distance * zoom;

      if (offX !== lastOffX || offY !== lastOffY) {
        if (shadow.offset) {
          shadow.offset.x = offX;
          shadow.offset.y = offY;
        }
        lastOffX = offX;
        lastOffY = offY;
      }

      if (blur !== lastBlur) {
        if ("blur" in shadow) shadow.blur = blur;
        lastBlur = blur;
      }

      if (alpha !== lastAlpha) {
        if ("alpha" in shadow) shadow.alpha = alpha;
        lastAlpha = alpha;
      }

      if (shadowOnly !== lastShadowOnly) {
        if ("shadowOnly" in shadow) shadow.shadowOnly = shadowOnly;
        lastShadowOnly = shadowOnly;
      }
    };

    PIXI.Ticker.shared.add(tick);

    const onResize = () => {
      updateScreenRect();
      clampShadowResolution();
    };
    r.on?.("resize", onResize);

    const origDestroy = emitter.destroy?.bind(emitter);
    emitter.destroy = (...args) => {
      PIXI.Ticker.shared.remove(tick);
      try {
        r.off?.("resize", onResize);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }

      try {
        if (wrapper.filters) {
          const arr = wrapper.filters.filter((f) => f !== shadow);
          wrapper.filters = arr.length ? arr : null;
        }
        shadow.destroy?.();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }

      return origDestroy ? origDestroy(...args) : undefined;
    };
  }

  /**
   * Install a smooth side-to-side drift ("Lateral Movement") onto an emitter.
   *
   * This works by:
   * - restoring a stable travel heading (base rotation) before the emitter's native update runs so movement doesn't drift over time
   * - applying a lateral sine offset after update, then setting the visual rotation to match the curved path's tangent
   *
   * @param {PIXI.particles.Emitter} emitter
   * @param {object} options
   * @param {{wrap?: boolean}} [cfg]
   */
  _fxmInstallLateralMovement(emitter, options = {}, { wrap = true } = {}) {
    if (!emitter) return;

    const strength = Math.min(1, Math.max(0, Number(options?.lateralMovement?.value ?? options?.lateralMovement ?? 0)));

    if (!Number.isFinite(strength) || strength <= 0.001) {
      emitter._fxmLateralMovementStrength = 0;
      emitter._fxmLateralMovementPreUpdate = null;
      emitter._fxmLateralMovementUpdate = null;
      return;
    }

    emitter._fxmLateralMovementStrength = strength;

    const classMinPeriod = Number(this.constructor.lateralMovementPeriodMin ?? 10) || 10;
    const classMaxPeriod = Number(this.constructor.lateralMovementPeriodMax ?? 20) || 20;

    const emitterMinRaw = Number(emitter?._fxmLateralMovementPeriodMin);
    const emitterMaxRaw = Number(emitter?._fxmLateralMovementPeriodMax);

    const minPeriod = Math.max(
      0.25,
      Number.isFinite(emitterMinRaw) && emitterMinRaw > 0 ? emitterMinRaw : classMinPeriod,
    );
    const maxPeriod = Math.max(
      minPeriod,
      Number.isFinite(emitterMaxRaw) && emitterMaxRaw > 0 ? emitterMaxRaw : classMaxPeriod,
    );

    emitter._fxmLateralMovementPreUpdate = () => {
      fxmForEachEmitterParticle(emitter, (p) => {
        if (!p) return;

        const ox = p._fxmLM_ox || 0;
        const oy = p._fxmLM_oy || 0;
        if (ox || oy) {
          p.x -= ox;
          p.y -= oy;
          p._fxmLM_ox = 0;
          p._fxmLM_oy = 0;
        }

        if (typeof p._fxmLM_baseRot === "number") {
          p.rotation = p._fxmLM_baseRot;
        }
      });
    };

    emitter._fxmLateralMovementUpdate = (delta) => {
      const dt = fxmDeltaSeconds(delta);
      if (!(dt > 0)) return;

      fxmForEachEmitterParticle(emitter, (p) => {
        if (!p) return;

        const age = fxmGetParticleAge(p);
        const respawn =
          age !== undefined &&
          typeof p._fxmLM_lastAge === "number" &&
          Number.isFinite(p._fxmLM_lastAge) &&
          age < p._fxmLM_lastAge;
        p._fxmLM_lastAge = age;

        if (respawn || typeof p._fxmLM_t !== "number" || typeof p._fxmLM_baseRot !== "number") {
          p._fxmLM_baseRot = typeof p.rotation === "number" ? p.rotation : 0;
          p._fxmLM_visRot = p._fxmLM_baseRot;

          p._fxmLM_t = 0;

          const period1 = minPeriod + (maxPeriod - minPeriod) * Math.pow(Math.random(), 0.85);
          const period2 = minPeriod * 0.55 + (maxPeriod * 0.55 - minPeriod * 0.55) * Math.pow(Math.random(), 0.85);

          p._fxmLM_omega1 = (Math.PI * 2) / Math.max(0.001, period1);
          p._fxmLM_omega2 = (Math.PI * 2) / Math.max(0.001, period2);

          const w = Math.abs(p.width || 0);
          const h = Math.abs(p.height || 0);
          const size = w && h ? Math.min(w, h) : Math.max(w, h, 1);

          const ampFactor = Number(this.constructor.lateralMovementAmplitudeFactor ?? 1) || 1;
          const ampMinPx = Math.max(0, Number(this.constructor.lateralMovementAmplitudeMinPx ?? 0) || 0);

          const aBaseRaw = size * (0.01 + 0.045 * strength) * ampFactor;
          const aBase = Math.max(aBaseRaw, ampMinPx * (0.35 + 0.65 * strength));
          p._fxmLM_a1 = aBase * (0.85 + 0.3 * Math.random());
          p._fxmLM_a2 = aBase * (0.12 + 0.22 * Math.random());

          p._fxmLM_ph1 = Math.random() * Math.PI * 2;
          p._fxmLM_ph2 = Math.random() * Math.PI * 2;

          p._fxmLM_prevBaseX = p.x;
          p._fxmLM_prevBaseY = p.y;
          p._fxmLM_prevW = 0;
        }

        p._fxmLM_t += dt;

        const baseRot = p._fxmLM_baseRot || 0;
        const cos = Math.cos(baseRot);
        const sin = Math.sin(baseRot);

        const nx = -sin;
        const ny = cos;

        const t = p._fxmLM_t || 0;
        const w1 = Math.sin((p._fxmLM_omega1 || 0) * t + (p._fxmLM_ph1 || 0)) * (p._fxmLM_a1 || 0);
        const w2 = Math.sin((p._fxmLM_omega2 || 0) * t + (p._fxmLM_ph2 || 0)) * (p._fxmLM_a2 || 0);
        const w = w1 + w2;

        const prevBX = typeof p._fxmLM_prevBaseX === "number" ? p._fxmLM_prevBaseX : p.x;
        const prevBY = typeof p._fxmLM_prevBaseY === "number" ? p._fxmLM_prevBaseY : p.y;
        const baseDx = p.x - prevBX;
        const baseDy = p.y - prevBY;

        const prevW = typeof p._fxmLM_prevW === "number" ? p._fxmLM_prevW : 0;
        const dw = w - prevW;

        const tdx = baseDx + nx * dw;
        const tdy = baseDy + ny * dw;

        const targetRot = Math.atan2(tdy, tdx);
        const curRot = typeof p._fxmLM_visRot === "number" ? p._fxmLM_visRot : baseRot;
        const turnSpeed = 2.2 + 3.2 * strength;
        const steerT = 1 - Math.exp(-turnSpeed * dt);
        const nextRot = fxmAngleLerp(curRot, targetRot, steerT);

        p._fxmLM_visRot = nextRot;
        p.rotation = nextRot;

        const ox = nx * w;
        const oy = ny * w;
        p.x += ox;
        p.y += oy;

        p._fxmLM_ox = ox;
        p._fxmLM_oy = oy;

        p._fxmLM_prevBaseX = p.x - ox;
        p._fxmLM_prevBaseY = p.y - oy;
        p._fxmLM_prevW = w;
      });
    };

    if (!wrap) return;

    if (emitter._fxmLateralMovementWrapped) return;

    const wasAuto = !!emitter.autoUpdate;
    if (wasAuto) emitter.autoUpdate = false;

    const origUpdate = emitter.update.bind(emitter);
    emitter._fxmLateralMovementOrigUpdate = origUpdate;
    emitter.update = (delta) => {
      try {
        emitter._fxmLateralMovementPreUpdate?.();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      origUpdate(delta);
      try {
        emitter._fxmLateralMovementUpdate?.(delta);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    };

    emitter._fxmLateralMovementWrapped = true;

    if (wasAuto) emitter.autoUpdate = true;
  }

  /**
   * Install circular orbit movement onto an emitter.
   *
   * Particles are positioned on a ring within the active spawn rectangle and rotated along the tangent heading.
   *
   * @param {PIXI.particles.Emitter} emitter
   * @param {object} options
   * @param {{wrap?: boolean}} [cfg]
   * @returns {void}
   */
  _fxmInstallOrbitMovement(emitter, options = {}, { wrap = true } = {}) {
    if (!emitter) return;

    const enabled = !!fxmOptionValue(options?.orbit, false);
    if (!enabled) {
      emitter._fxmOrbitMovementUpdate = null;
      return;
    }

    const config = emitter?._fxmOrbitConfig ?? emitter?._origConfig ?? emitter?.config ?? {};
    const rect = fxmOrbitRectFromConfig(config);
    const distance = fxmClampNumber(fxmOptionValue(options?.orbitDistance, 0.5), 0, 1, 0.5);
    const radii = fxmOrbitRadii(Math.min(rect.w, rect.h), distance);
    const grid = Math.max(1, Number(canvas?.dimensions?.size ?? 100) || 100);
    const speedScale = Math.max(0.05, Number(fxmOptionValue(options?.speed, 1)) || 1);
    const tangentialSpeed = (16 + 34 * Math.sqrt(speedScale)) * (grid / 100);
    const direction = -1;
    const facesTangent = emitter?._fxmOrbitFacesTangent !== false && config?._fxmOrbitFacesTangent !== false;

    emitter._fxmOrbitMovementUpdate = (delta) => {
      const dt = fxmDeltaSeconds(delta);
      if (!(dt > 0)) return;

      fxmForEachEmitterParticle(emitter, (particle) => {
        if (!particle) return;

        const age = fxmGetParticleAge(particle);
        const respawn =
          age !== undefined &&
          typeof particle._fxmOrbitLastAge === "number" &&
          Number.isFinite(particle._fxmOrbitLastAge) &&
          age < particle._fxmOrbitLastAge;
        particle._fxmOrbitLastAge = age;

        if (respawn || !particle._fxmOrbitSeeded) {
          const theta = Math.random() * Math.PI * 2;
          const u = Math.random();
          const radius = Math.sqrt(u * (radii.max * radii.max - radii.min * radii.min) + radii.min * radii.min);
          particle._fxmOrbitTheta = theta;
          particle._fxmOrbitRadius = radius;
          particle._fxmOrbitOmegaScale = 0.82 + Math.random() * 0.36;
          particle._fxmOrbitRadialPhase = Math.random() * Math.PI * 2;
          particle._fxmOrbitRadialScale = 0.012 + Math.random() * 0.025;
          particle._fxmOrbitVisualRotation =
            typeof particle.rotation === "number" ? particle.rotation : theta + direction * Math.PI * 0.5;
          particle._fxmOrbitSeeded = true;
        }

        const baseRadius = Math.max(1, Number(particle._fxmOrbitRadius) || (radii.min + radii.max) * 0.5);
        const omega = (tangentialSpeed / baseRadius) * (Number(particle._fxmOrbitOmegaScale) || 1);
        particle._fxmOrbitTheta = (Number(particle._fxmOrbitTheta) || 0) + direction * omega * dt;

        const radial =
          baseRadius *
          (1 +
            Math.sin((Number(particle._fxmOrbitTheta) || 0) * 0.7 + (Number(particle._fxmOrbitRadialPhase) || 0)) *
              (Number(particle._fxmOrbitRadialScale) || 0));
        const theta = Number(particle._fxmOrbitTheta) || 0;
        const centerX = rect.x + rect.w * 0.5;
        const centerY = rect.y + rect.h * 0.5;
        particle.x = centerX + Math.cos(theta) * radial;
        particle.y = centerY + Math.sin(theta) * radial;

        if (!facesTangent) return;

        const heading = theta + direction * Math.PI * 0.5;
        const current =
          typeof particle._fxmOrbitVisualRotation === "number" ? particle._fxmOrbitVisualRotation : heading;
        const next = fxmAngleLerp(current, heading, 1 - Math.exp(-8 * dt));
        particle._fxmOrbitVisualRotation = next;
        particle.rotation = next;
      });
    };

    if (!wrap || emitter._fxmOrbitMovementWrapped) return;

    const wasAuto = !!emitter.autoUpdate;
    if (wasAuto) emitter.autoUpdate = false;

    const origUpdate = emitter.update.bind(emitter);
    emitter._fxmOrbitMovementOrigUpdate = origUpdate;
    emitter.update = (delta) => {
      origUpdate(delta);
      try {
        emitter._fxmOrbitMovementUpdate?.(delta);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    };

    emitter._fxmOrbitMovementWrapped = true;

    if (wasAuto) emitter.autoUpdate = true;
  }

  /**
   * Install wind-source direction synchronization for directional particle travel.
   * @param {PIXI.particles.Emitter} emitter
   * @param {object} options
   * @param {{wrap?: boolean}} [cfg]
   */
  _fxmInstallSynchronizedDirection(emitter, options = {}, { wrap = true } = {}) {
    if (!emitter) return;

    const enabled = CONFIG.fxmaster?.synchronizedDirectionOptionEnabled?.(options) ?? false;
    if (!enabled) {
      emitter._fxmSynchronizedDirectionUpdate = null;
      return;
    }

    const fallbackDirection = Number(fxmOptionValue(options?.direction, this.constructor.defaultDirection ?? 0));
    const fallback = Number.isFinite(fallbackDirection) ? fallbackDirection : 0;

    emitter._fxmSynchronizedDirectionUpdate = (delta, phase = "after") => {
      const dtRaw = fxmDeltaSeconds(delta);
      const dt = Math.min(0.06, Math.max(0, dtRaw));
      if (!(dt > 0)) return;

      const direction =
        CONFIG.fxmaster?.resolveSynchronizedDirection?.(options, fallback, options?.__fxmParticleContext) ?? fallback;
      const screenRadians = (geometricDirectionToScreenDegrees(direction) * Math.PI) / 180;
      const nx = Math.cos(screenRadians);
      const ny = Math.sin(screenRadians);
      const steer = Math.min(1, 1 - Math.exp(-7.5 * dt));
      const rotate = Math.min(1, 1 - Math.exp(-8.5 * dt));
      const grid = Math.max(1, Number(canvas?.dimensions?.size ?? 100) || 100);
      const fallbackSpeed = grid * 1.4;
      const pathBehavior = typeof emitter.getBehavior === "function" ? emitter.getBehavior("movePath") : null;
      const config = fxmEmitterConfig(emitter);
      const steerVelocity = config?._fxmSynchronizedDirectionVelocity !== false;
      const retargetMovePath = pathBehavior && config?._fxmSynchronizedDirectionMovePath !== false;
      const retargetAfterUpdate = config?._fxmSynchronizedDirectionMovePathAfter !== false;

      fxmRetargetEmitterRotationBehaviors(emitter, screenRadians);
      if (pathBehavior && !retargetMovePath) return;
      if (phase === "before" && !retargetMovePath) return;
      if (phase === "after" && retargetMovePath && !retargetAfterUpdate) return;

      fxmForEachEmitterParticle(emitter, (particle) => {
        if (!particle) return;
        const retargetedPath = retargetMovePath
          ? fxmRetargetMovePathParticle(particle, pathBehavior, screenRadians, rotate)
          : false;
        if (phase !== "before" && steerVelocity) {
          const velocitySteered = fxmSteerParticleVelocity(particle, nx, ny, steer, fallbackSpeed);
          if (!velocitySteered && config?._fxmSynchronizedDirectionDisplacement !== false) {
            fxmSteerParticleDisplacement(particle, nx, ny, steer);
          }
        }

        const rotSpeed = Number(particle?.config?.rotSpeed);
        const preserveIndependentRotation = retargetedPath && Number.isFinite(rotSpeed) && Math.abs(rotSpeed) > 1e-4;
        if (!preserveIndependentRotation) {
          const currentRotation = typeof particle.rotation === "number" ? particle.rotation : screenRadians;
          particle.rotation = fxmAngleLerp(currentRotation, screenRadians, rotate);
        }

        if (typeof particle._fxmLM_baseRot === "number")
          particle._fxmLM_baseRot = fxmAngleLerp(particle._fxmLM_baseRot, screenRadians, rotate * 0.75);
        if (typeof particle._fxmLM_visRot === "number")
          particle._fxmLM_visRot = fxmAngleLerp(particle._fxmLM_visRot, screenRadians, rotate);
      });
    };

    if (!wrap || emitter._fxmSynchronizedDirectionWrapped) return;

    const wasAuto = !!emitter.autoUpdate;
    if (wasAuto) emitter.autoUpdate = false;

    const origUpdate = emitter.update.bind(emitter);
    const config = fxmEmitterConfig(emitter);
    const preUpdate =
      config?._fxmSynchronizedDirectionPreUpdate === true ||
      (fxmEmitterHasMovePath(config) && config?._fxmSynchronizedDirectionMovePath !== false);
    emitter._fxmSynchronizedDirectionOrigUpdate = origUpdate;
    emitter.update = (delta) => {
      try {
        if (preUpdate) emitter._fxmSynchronizedDirectionUpdate?.(delta, "before");
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      origUpdate(delta);
      try {
        emitter._fxmSynchronizedDirectionUpdate?.(delta, "after");
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    };

    emitter._fxmSynchronizedDirectionWrapped = true;

    if (wasAuto) emitter.autoUpdate = true;
  }

  /**
   * Resolve and cache the original directional movement heading for a particle.
   *
   * Directional avoidance uses this as the forward path so creatures can skirt
   * around tokens without being steered backward or orbiting the token edge.
   *
   * @param {any} particle
   * @param {number|null} fallbackRotation
   * @param {{reset?: boolean}} [options]
   * @returns {{x:number,y:number,angle:number}|null}
   */
  _fxmTokenAvoidanceForward(particle, fallbackRotation = null, { reset = false } = {}) {
    if (!particle) return null;

    const age = fxmGetParticleAge(particle);
    const respawn =
      age !== undefined &&
      typeof particle._fxmTA_lastAge === "number" &&
      Number.isFinite(particle._fxmTA_lastAge) &&
      age < particle._fxmTA_lastAge;
    if (age !== undefined) particle._fxmTA_lastAge = age;

    if (
      !reset &&
      !respawn &&
      typeof particle._fxmTA_forwardX === "number" &&
      typeof particle._fxmTA_forwardY === "number"
    ) {
      const len = Math.hypot(particle._fxmTA_forwardX, particle._fxmTA_forwardY);
      if (len > 0.001) {
        const x = particle._fxmTA_forwardX / len;
        const y = particle._fxmTA_forwardY / len;
        return { x, y, angle: Math.atan2(y, x) };
      }
    }

    const velocity = fxmParticleVelocityVector(particle);
    let x = velocity?.x;
    let y = velocity?.y;

    if (!(Number.isFinite(x) && Number.isFinite(y))) {
      const angle =
        typeof particle.rotation === "number" && Number.isFinite(particle.rotation)
          ? particle.rotation
          : Number.isFinite(fallbackRotation)
          ? fallbackRotation
          : null;
      if (angle === null) return null;
      x = Math.cos(angle);
      y = Math.sin(angle);
    }

    const len = Math.hypot(x, y);
    if (!(len > 0.001)) return null;
    x /= len;
    y /= len;
    particle._fxmTA_forwardX = x;
    particle._fxmTA_forwardY = y;
    return { x, y, angle: Math.atan2(y, x) };
  }

  /**
   * Install token avoidance for creature-style particle effects.
   *
   * When enabled, particles are pushed away from visible tokens. By default
   * only recently moving tokens act as avoidance sources; the optional
   * tokenAvoidanceAtRest toggle makes stationary tokens repel particles too.
   *
   * @param {PIXI.particles.Emitter} emitter
   * @param {object} options
   * @param {{wrap?: boolean}} [cfg]
   */
  _fxmInstallTokenAvoidance(emitter, options = {}, { wrap = true } = {}) {
    if (!emitter) return;

    const enabled = !!fxmOptionValue(options?.tokenAvoidance, false);
    const strength = fxmClampNumber(fxmOptionValue(options?.tokenAvoidanceStrength, 0.65), 0, 1, 0.65);
    const radiusScale = fxmClampNumber(fxmOptionValue(options?.tokenAvoidanceRadius, 1), 0, 3, 1);

    if (!enabled || strength <= 0.001 || radiusScale <= 0.001) {
      emitter._fxmTokenAvoidanceUpdate = null;
      return;
    }

    const includeAtRest = !!fxmOptionValue(options?.tokenAvoidanceAtRest, false);
    const selectedDispositions = fxmTokenAvoidanceDispositionSelection(options?.tokenAvoidanceDispositions);
    const directionalMode =
      !!fxmOptionValue(options?.directionalMovement, false) && !fxmOptionValue(options?.orbit, false);
    const rawDirection = Number(fxmOptionValue(options?.direction, NaN));
    const fallbackDirectionalRotation = Number.isFinite(rawDirection)
      ? (geometricDirectionToScreenDegrees(rawDirection) * Math.PI) / 180
      : null;
    emitter._fxmTokenAvoidanceState ??= new Map();

    emitter._fxmTokenAvoidanceUpdate = (delta) => {
      const dtRaw = fxmDeltaSeconds(delta);
      const dt = Math.min(0.05, Math.max(0, dtRaw));
      if (!(dt > 0)) return;

      const tokens = canvas?.tokens?.placeables ?? [];
      if (!tokens.length) return;

      const grid = Math.max(1, Number(canvas?.dimensions?.size ?? 100) || 100);
      const now = globalThis.performance?.now?.() ?? Date.now();
      const minMove = Math.max(0.75, grid * 0.006);
      const movingHoldMs = 360;
      const targets = [];
      const seen = new Set();
      const state = emitter._fxmTokenAvoidanceState ?? new Map();
      emitter._fxmTokenAvoidanceState = state;

      for (const token of tokens) {
        if (!fxmTokenAvoidanceVisible(token)) continue;
        const disposition = fxmTokenAvoidanceDisposition(token);
        if (!disposition || !selectedDispositions.has(disposition)) continue;
        const id = fxmTokenAvoidanceId(token);
        if (!id) continue;

        const center = fxmTokenAvoidanceCenter(token);
        if (!center) continue;
        seen.add(id);

        const footprint = fxmTokenAvoidanceFootprint(token);
        const previous = state.get(id);
        const movedPx = previous ? Math.hypot(center.x - previous.x, center.y - previous.y) : 0;
        const moving = movedPx >= minMove;
        const activeUntil = includeAtRest
          ? now + 1000
          : moving
          ? now + movingHoldMs
          : previous?.activeUntil ?? -Infinity;
        const velocityBoost = moving ? Math.min(1.85, 1.0 + movedPx / Math.max(grid * 0.18, 1)) : 1.0;

        state.set(id, {
          x: center.x,
          y: center.y,
          footprint,
          activeUntil,
          seenAt: now,
        });

        if (!includeAtRest && activeUntil < now) continue;

        const radius = Math.max(grid * 0.35, footprint * radiusScale);
        targets.push({
          x: center.x,
          y: center.y,
          radius,
          weight: includeAtRest && !moving ? 0.78 : velocityBoost,
        });
      }

      for (const [id, entry] of state.entries()) {
        if (seen.has(id)) continue;
        if (now - (entry?.seenAt ?? now) > 1000) state.delete(id);
      }

      const baseSpeed = grid * (0.65 + 3.7 * strength);
      const maxStep = grid * (0.014 + 0.06 * strength);
      const turnRate = 10.0 + 18.0 * strength;
      const velocityTurnRate = 14.0 + 30.0 * strength;
      const restoreDirectionalParticle = (particle) => {
        if (!directionalMode || !particle) return;
        const forward = this._fxmTokenAvoidanceForward(particle, fallbackDirectionalRotation, { reset: false });
        if (!forward) return;
        const restoreT = Math.min(0.35, 1 - Math.exp(-(2.6 + 5.0 * strength) * dt));
        fxmSteerParticleVelocity(particle, forward.x, forward.y, restoreT, baseSpeed);
        const currentRotation = typeof particle.rotation === "number" ? particle.rotation : forward.angle;
        const nextRotation = fxmAngleLerp(currentRotation, forward.angle, restoreT * 0.85);
        particle.rotation = nextRotation;
        if (typeof particle._fxmLM_baseRot === "number")
          particle._fxmLM_baseRot = fxmAngleLerp(particle._fxmLM_baseRot, forward.angle, restoreT * 0.55);
        if (typeof particle._fxmLM_visRot === "number")
          particle._fxmLM_visRot = fxmAngleLerp(particle._fxmLM_visRot, forward.angle, restoreT * 0.85);
      };

      if (!targets.length) {
        if (directionalMode) fxmForEachEmitterParticle(emitter, restoreDirectionalParticle);
        return;
      }

      fxmForEachEmitterParticle(emitter, (particle) => {
        if (!particle) return;
        const px = Number(particle.x);
        const py = Number(particle.y);
        if (!Number.isFinite(px) || !Number.isFinite(py)) return;

        let forceX = 0;
        let forceY = 0;

        for (const target of targets) {
          let dx = px - target.x;
          let dy = py - target.y;
          let dist = Math.hypot(dx, dy);
          if (dist >= target.radius) continue;

          if (!(dist > 0.001)) {
            const seed = typeof particle._fxmTA_seed === "number" ? particle._fxmTA_seed : Math.random() * Math.PI * 2;
            particle._fxmTA_seed = seed;
            dx = Math.cos(seed);
            dy = Math.sin(seed);
            dist = 1;
          }

          const t = 1 - dist / Math.max(target.radius, 1);
          const falloff = t * t * (3 - 2 * t);
          const weight = falloff * target.weight;
          forceX += (dx / dist) * weight;
          forceY += (dy / dist) * weight;
        }

        const force = Math.hypot(forceX, forceY);
        if (!(force > 0.0005)) {
          restoreDirectionalParticle(particle);
          return;
        }

        const nx = forceX / force;
        const ny = forceY / force;
        const influence = Math.min(1.85, Math.max(0.18, force));
        let steerX = nx;
        let steerY = ny;
        let pushX = nx;
        let pushY = ny;
        let targetRotation = Math.atan2(ny, nx);
        let velocitySteer = Math.min(1, 1 - Math.exp(-velocityTurnRate * dt * influence));
        let positionPushScale = 0.34;

        if (directionalMode) {
          const forward = this._fxmTokenAvoidanceForward(particle, fallbackDirectionalRotation, { reset: false });
          if (forward) {
            const fx = forward.x;
            const fy = forward.y;
            const sx = -fy;
            const sy = fx;
            const sideDot = nx * sx + ny * sy;
            let sideSign = Math.sign(sideDot);
            if (!sideSign) {
              const seed =
                typeof particle._fxmTA_seed === "number" ? particle._fxmTA_seed : Math.random() * Math.PI * 2;
              particle._fxmTA_seed = seed;
              sideSign = Math.sign(Math.sin(seed)) || 1;
            }

            const awayForward = Math.max(0, nx * fx + ny * fy);
            const sideAmt = (0.5 + Math.min(1.35, Math.abs(sideDot) + influence * 0.32)) * (0.72 + 0.58 * strength);
            const forwardAmt = 1.0 + awayForward * 0.26;
            steerX = fx * forwardAmt + sx * sideSign * sideAmt;
            steerY = fy * forwardAmt + sy * sideSign * sideAmt;
            const steerLen = Math.hypot(steerX, steerY) || 1;
            steerX /= steerLen;
            steerY /= steerLen;

            pushX = sx * sideSign * (0.85 + 0.4 * influence) + fx * awayForward * 0.22;
            pushY = sy * sideSign * (0.85 + 0.4 * influence) + fy * awayForward * 0.22;
            const pushLen = Math.hypot(pushX, pushY) || 1;
            pushX /= pushLen;
            pushY /= pushLen;

            targetRotation = Math.atan2(steerY, steerX);
            velocitySteer = Math.min(0.72, 1 - Math.exp(-(8.0 + 16.0 * strength) * dt * influence));
            positionPushScale = 0.62;
          }
        }

        const steeredVelocity = fxmSteerParticleVelocity(particle, steerX, steerY, velocitySteer, baseSpeed);

        if (!directionalMode && !steeredVelocity) positionPushScale = 0.82;
        const step = Math.min(maxStep, baseSpeed * dt * Math.min(1.35, force) * positionPushScale);
        particle.x += pushX * step;
        particle.y += pushY * step;

        const currentRotation = typeof particle.rotation === "number" ? particle.rotation : targetRotation;
        const steer = Math.min(1, 1 - Math.exp(-turnRate * dt * influence));
        const nextRotation = fxmAngleLerp(currentRotation, targetRotation, steer);
        particle.rotation = nextRotation;

        if (typeof particle._fxmLM_baseRot === "number")
          particle._fxmLM_baseRot = fxmAngleLerp(
            particle._fxmLM_baseRot,
            targetRotation,
            Math.max(steer * 0.65, velocitySteer),
          );
        if (typeof particle._fxmLM_visRot === "number")
          particle._fxmLM_visRot = fxmAngleLerp(particle._fxmLM_visRot, targetRotation, Math.max(steer, velocitySteer));
      });
    };

    if (!wrap || emitter._fxmTokenAvoidanceWrapped) return;

    const wasAuto = !!emitter.autoUpdate;
    if (wasAuto) emitter.autoUpdate = false;

    const origUpdate = emitter.update.bind(emitter);
    emitter._fxmTokenAvoidanceOrigUpdate = origUpdate;
    emitter.update = (delta) => {
      origUpdate(delta);
      try {
        emitter._fxmTokenAvoidanceUpdate?.(delta);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    };

    emitter._fxmTokenAvoidanceWrapped = true;

    if (wasAuto) emitter.autoUpdate = true;
  }

  /**
   * Register a canvasPan hook that keeps emitter owner positions aligned to the current view center.
   *
   * Used by any effect that spawns relative to the view center via emitter ownerPos offsets.
   * @protected
   */
  _fxmRegisterCanvasPanOwnerPosHook() {
    this._fxmUnregisterCanvasPanOwnerPosHook();

    const ctx = this.__fxmParticleContext ?? this.options?.__fxmParticleContext;
    const scopedContext = CONFIG.fxmaster?.isScopedParticleContext?.(ctx) ?? !!ctx?.dimensions;
    if (scopedContext) return;

    if (!globalThis.Hooks?.on || !globalThis.canvas) return;

    const resolveOwnerPosition = (position = null) => {
      const d = CONFIG.fxmaster.getParticleDimensions?.(this) ?? canvas.dimensions;
      if (!d) return null;
      const px = position?.x ?? canvas.stage?.pivot?.x ?? 0;
      const py = position?.y ?? canvas.stage?.pivot?.y ?? 0;
      return {
        x: px - d.sceneX - d.sceneWidth / 2,
        y: py - d.sceneY - d.sceneHeight / 2,
      };
    };

    this._fxmLastCanvasPanOwnerPos = resolveOwnerPosition();

    this._fxmCanvasPanHookId = Hooks.on("canvasPan", (_canvas, position) => {
      const owner = resolveOwnerPosition(position);
      if (!owner) return;

      const last = this._fxmLastCanvasPanOwnerPos;
      if (last && Math.abs(owner.x - last.x) < 0.001 && Math.abs(owner.y - last.y) < 0.001) return;
      this._fxmLastCanvasPanOwnerPos = owner;

      for (const e of this.emitters ?? []) {
        try {
          e.updateOwnerPos(owner.x, owner.y);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }
    });
  }

  /**
   * Unregister the canvasPan hook used by this effect (if any).
   * @protected
   */
  _fxmUnregisterCanvasPanOwnerPosHook() {
    if (this._fxmCanvasPanHookId !== undefined) {
      Hooks.off("canvasPan", this._fxmCanvasPanHookId);
      this._fxmCanvasPanHookId = undefined;
    }
    this._fxmLastCanvasPanOwnerPos = null;
  }

  /** Optionally pre-warm emitters before playing. */
  play({ prewarm = false } = {}) {
    if (this._fxmCanvasPanOwnerPosEnabled) this._fxmRegisterCanvasPanOwnerPosHook();
    else this._fxmUnregisterCanvasPanOwnerPosHook();

    if (prewarm) {
      this.emitters.forEach((emitter) => {
        emitter.autoUpdate = false;
        emitter.emit = true;
        emitter.update(emitter.maxLifetime);
        emitter.autoUpdate = true;
      });
    }
    super.play();
  }

  /** @override */
  stop() {
    this._fxmUnregisterCanvasPanOwnerPosHook();
    super.stop?.();
  }

  /**
   * Resolve the ticker that should drive FXMaster alpha fades.
   *
   * Foundry's canvas app ticker is the most reliable render-loop source in V13/V14. The fade ticker is also stored so an interrupted fade is removed from the exact ticker that owns it instead of guessing on the next fade.
   *
   * @returns {PIXI.Ticker|null}
   * @protected
   */
  _fxmFadeTicker() {
    return canvas?.app?.ticker ?? PIXI?.Ticker?.shared ?? null;
  }

  /**
   * Normalize a fade timeout, falling back to the standard particle duration.
   * @param {number|undefined|null} timeout
   * @returns {number}
   * @protected
   */
  _fxmFadeDuration(timeout) {
    const requested = Number(timeout);
    if (Number.isFinite(requested)) return Math.max(0, requested);
    const fallback = Number(this.constructor?.defaultFadeDurationMs ?? 3000);
    return Number.isFinite(fallback) ? Math.max(0, fallback) : 3000;
  }

  /**
   * Cancel an in-flight FXMaster alpha fade.
   * @param {{resolve?: boolean}} [options]
   * @protected
   */
  _fxmCancelAlphaFade({ resolve = true } = {}) {
    const fadeTicker = this._fadeTicker;
    if (!fadeTicker) return;

    const tickers = new Set();
    if (this._fadeTickerSource) tickers.add(this._fadeTickerSource);
    if (canvas?.app?.ticker) tickers.add(canvas.app.ticker);
    if (PIXI?.Ticker?.shared) tickers.add(PIXI.Ticker.shared);

    for (const ticker of tickers) {
      try {
        ticker?.remove?.(fadeTicker);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    this._fadeTicker = null;
    this._fadeTickerSource = null;

    if (!resolve) {
      this._fadeResolve = null;
      return;
    }

    const r = this._fadeResolve;
    this._fadeResolve = null;
    try {
      r?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  /**
   * Keep sibling background surfaces synchronized during alpha fades.
   * Background surfaces live beside the particle container in the wrapper so
   * they need their runtime alpha uniform refreshed when the owning effect
   * fades, not only on the next layer animation pass.
   * @protected
   */
  _fxmSyncBackgroundSurfaceAlpha() {
    try {
      this.__fxmBackgroundSurface?.update?.({ fx: this });
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  /**
   * Fade to transparent over a timeout and resolve when complete.
   * @param {{timeout?: number}} [options]
   * @returns {Promise<void>}
   */
  async fadeOut({ timeout = undefined } = {}) {
    for (const emitter of this.emitters) {
      try {
        emitter.emit = false;
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    this._fxmCancelAlphaFade({ resolve: true });

    const startAlpha = this.alpha ?? 1;
    const duration = this._fxmFadeDuration(timeout);
    if (!duration) {
      this.alpha = 0;
      this._fxmSyncBackgroundSurfaceAlpha();
      return;
    }

    const ticker = this._fxmFadeTicker();
    if (!ticker) {
      this.alpha = 0;
      this._fxmSyncBackgroundSurfaceAlpha();
      return;
    }

    return new Promise((resolve) => {
      this._fadeResolve = resolve;
      this._fadeTickerSource = ticker;
      const start = ticker.lastTime ?? performance.now();
      this._fadeTicker = () => {
        if (this.destroyed) {
          this._fxmCancelAlphaFade({ resolve: true });
          return;
        }
        const now = ticker.lastTime ?? performance.now();
        const u = Math.min(1, (now - start) / duration);
        this.alpha = startAlpha * (1 - u);
        this._fxmSyncBackgroundSurfaceAlpha();
        if (u >= 1) this._fxmCancelAlphaFade({ resolve: true });
      };
      ticker.add(this._fadeTicker);
    });
  }

  /** Fade alpha from current value to a target over a timeout. */
  async fadeToAlpha({ to = 1, timeout = undefined } = {}) {
    const duration = this._fxmFadeDuration(timeout);
    const target = Number(to);
    const resolvedTarget = Number.isFinite(target) ? target : 1;
    const from = Number(this.alpha ?? 1);

    this._fxmCancelAlphaFade({ resolve: true });

    if (!duration) {
      this.alpha = resolvedTarget;
      this._fxmSyncBackgroundSurfaceAlpha();
      return;
    }

    const ticker = this._fxmFadeTicker();
    if (!ticker) {
      this.alpha = resolvedTarget;
      this._fxmSyncBackgroundSurfaceAlpha();
      return;
    }

    return new Promise((resolve) => {
      this._fadeResolve = resolve;
      this._fadeTickerSource = ticker;
      const start = ticker.lastTime ?? performance.now();
      this._fadeTicker = () => {
        if (this.destroyed) {
          this._fxmCancelAlphaFade({ resolve: true });
          return;
        }
        const now = ticker.lastTime ?? performance.now();
        const u = Math.min(1, (now - start) / duration);
        this.alpha = from + (resolvedTarget - from) * u;
        this._fxmSyncBackgroundSurfaceAlpha();
        if (u >= 1) this._fxmCancelAlphaFade({ resolve: true });
      };
      ticker.add(this._fadeTicker);
    });
  }

  /** Symmetric fade-in helper. */
  async fadeIn({ timeout = undefined } = {}) {
    return this.fadeToAlpha({ to: 1, timeout });
  }

  /**
   * Convert legacy (V1) options to V2 semantics based on scene dimensions.
   * @param {object} options
   * @param {Scene} scene
   */
  static convertOptionsToV2(options, scene) {
    return Object.fromEntries(
      Object.entries(options).map(([k, v]) => {
        switch (k) {
          case "scale":
            return [k, this._convertScaleToV2(v, scene)];
          case "speed":
            return [k, this._convertSpeedToV2(v, scene)];
          case "density":
            return [k, this._convertDensityToV2(v, scene)];
          default:
            return [k, v];
        }
      }),
    );
  }

  /** Scale - normalized UI value based on grid size. */
  static _convertScaleToV2(scale, scene) {
    const decimals = this.parameters.scale?.decimals ?? 1;
    return roundToDecimals(scale * (100 / scene.dimensions.size), decimals);
  }

  /** Speed - normalized UI value relative to max default moveSpeed and grid size. */
  static _convertSpeedToV2(speed, scene) {
    const speeds = this.defaultConfig.behaviors
      .filter(({ type }) => type === "moveSpeed")
      .flatMap(({ config }) => config.speed.list.map((v) => v.value));
    const maximumSpeed = Math.max(...speeds);

    const decimals = this.parameters.speed?.decimals ?? 1;
    return roundToDecimals((speed / maximumSpeed) * (100 / scene.dimensions.size), decimals);
  }

  /** Density - normalized per-grid-unit value. */
  static _convertDensityToV2(density, scene) {
    const d = scene.dimensions;
    const gridUnits = (d.width / d.size) * (d.height / d.size);
    const decimals = this.parameters.density?.decimals ?? 1;
    return roundToDecimals(density / gridUnits, decimals);
  }

  static computeMaxParticlesFromView(options = {}, { minViewCells = 3000 } = {}) {
    const d = options?.__fxmParticleContext?.dimensions ?? canvas.dimensions;
    const rawViewCells = (d.width / d.size) * (d.height / d.size);
    const viewCells = Math.max(1, Math.max(rawViewCells, minViewCells));

    const baseDensity = options.density?.value ?? this.parameters?.density?.value ?? 0;
    const density = this.getScaledDensity(baseDensity);

    const maxParticles = Math.max(1, Math.round(viewCells * density));

    return { viewCells, density, maxParticles };
  }
}
