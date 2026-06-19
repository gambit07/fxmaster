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

    const direction = options.direction?.value;
    if (direction === undefined) return;

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
   * Register a canvasPan hook that keeps emitter owner positions aligned to the current view center.
   *
   * Used by any effect that spawns relative to the view center via emitter ownerPos offsets.
   * @protected
   */
  _fxmRegisterCanvasPanOwnerPosHook() {
    this._fxmUnregisterCanvasPanOwnerPosHook();

    const ctx = this.__fxmParticleContext ?? this.options?.__fxmParticleContext;
    if (ctx) return;

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
   * Fade to transparent over a timeout and resolve when complete.
   * @param {{timeout?: number}} [options]
   * @returns {Promise<void>}
   */
  async fadeOut({ timeout = 3000 } = {}) {
    for (const emitter of this.emitters) {
      try {
        emitter.emit = false;
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    if (this._fadeTicker && (canvas?.app?.ticker || PIXI.Ticker.shared)) {
      const t = canvas?.app?.ticker ?? PIXI.Ticker.shared;
      try {
        t.remove(this._fadeTicker);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this._fadeTicker = null;
      try {
        this._fadeResolve?.();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this._fadeResolve = null;
    }

    const startAlpha = this.alpha ?? 1;
    if (!timeout || timeout <= 0) {
      this.alpha = 0;
      return;
    }

    const ticker = PIXI.Ticker.shared;
    return new Promise((resolve) => {
      this._fadeResolve = resolve;
      const start = ticker.lastTime ?? performance.now();
      this._fadeTicker = () => {
        if (this.destroyed) {
          ticker.remove(this._fadeTicker);
          this._fadeTicker = null;
          const r = this._fadeResolve;
          this._fadeResolve = null;
          try {
            r?.();
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
          return;
        }
        const now = ticker.lastTime ?? performance.now();
        const u = Math.min(1, (now - start) / timeout);
        this.alpha = startAlpha * (1 - u);
        if (u >= 1) {
          ticker.remove(this._fadeTicker);
          this._fadeTicker = null;
          const r = this._fadeResolve;
          this._fadeResolve = null;
          try {
            r?.();
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
        }
      };
      ticker.add(this._fadeTicker);
    });
  }

  /** Fade alpha from current value to a target over a timeout. */
  async fadeToAlpha({ to = 1, timeout = 3000 } = {}) {
    const ticker = PIXI.Ticker.shared;
    const from = Number(this.alpha ?? 1);
    if (!timeout || timeout <= 0) {
      this.alpha = to;
      return;
    }

    if (this._fadeTicker && (canvas?.app?.ticker || PIXI.Ticker.shared)) {
      const t = canvas?.app?.ticker ?? PIXI.Ticker.shared;
      try {
        t.remove(this._fadeTicker);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this._fadeTicker = null;
      try {
        this._fadeResolve?.();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this._fadeResolve = null;
    }

    return new Promise((resolve) => {
      this._fadeResolve = resolve;
      const start = ticker.lastTime ?? performance.now();
      this._fadeTicker = () => {
        if (this.destroyed) {
          ticker.remove(this._fadeTicker);
          this._fadeTicker = null;
          const r = this._fadeResolve;
          this._fadeResolve = null;
          try {
            r?.();
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
          return;
        }
        const now = ticker.lastTime ?? performance.now();
        const u = Math.min(1, (now - start) / timeout);
        this.alpha = from + (to - from) * u;
        if (u >= 1) {
          ticker.remove(this._fadeTicker);
          this._fadeTicker = null;
          const r = this._fadeResolve;
          this._fadeResolve = null;
          try {
            r?.();
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
        }
      };
      ticker.add(this._fadeTicker);
    });
  }

  /** Symmetric fade-in helper. */
  async fadeIn({ timeout = 3000 } = {}) {
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
