/**
 * FXMasterParticleEffect (abstract)
 * ---------------------------------
 * Base class for particle effects in FXMaster.
 * - Defines common UI parameters and sensible defaults.
 * - Maps user options (scale, speed, direction, lifetime, tint, alpha) onto
 *   PIXI emitter configs.
 * - Provides helpers for pre-warming (play) and graceful teardown (fadeOut).
 * - Includes V1→V2 option converters for scene-dimension-aware values.
 */

import { roundToDecimals } from "../../utils.js";

/* ------------------------------------------------------------------------- */
/* Lateral Movement Helpers                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Convert a PIXI.Ticker delta or seconds to seconds.
 * PIXI-particles expects seconds.
 * Foundry/PIXI commonly provide deltaTime where 1.0 ~= one 60fps frame.
 * @param {number} delta
 * @returns {number}
 */
function fxmDeltaSeconds(delta) {
  if (typeof delta !== "number" || !Number.isFinite(delta) || delta <= 0) return 1 / 60;

  if (delta < 0.1) return delta; // already seconds
  if (delta < 5) return delta / 60; // ticker units
  return delta;
}

/**
 * Best-effort particle age access for respawn detection across PIXI-particles versions.
 * @param {any} p
 * @returns {number|undefined}
 */
function fxmGetParticleAge(p) {
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

function fxmNextParticle(p) {
  return p?.next ?? p?._next ?? p?.nextParticle ?? p?._nextParticle ?? p?.__next ?? null;
}

/**
 * Iterate active particles for an emitter with minimal allocations.
 * @param {PIXI.particles.Emitter} emitter
 * @param {(p:any)=>void} fn
 */
function fxmForEachEmitterParticle(emitter, fn) {
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
 * Abstract particle effect with parameter plumbing and utilities.
 * Subclasses must provide a PIXI EmitterConfig via `defaultConfig`.
 */
export class FXMasterParticleEffect extends CONFIG.fxmaster.ParticleEffectNS {
  /** Human-readable label, typically a localization key. */
  static label = "FXMASTER.Common.ParticleEffect";

  /**
   * Hide this effect from the management UI.
   * Useful for backwards-compatibility aliases (e.g. legacy "rain-top")
   * that should still load from scene flags.
   */
  static hidden = false;

  /**
   * Whether this effect should keep its emitters' ownerPos synced to the current
   * canvas pan.
   *
   * IMPORTANT: Do not define this as a class field. The upstream ParticleEffect
   * base class builds emitters during its constructor, and many FXMaster effects
   * toggle this flag inside getParticleEmitters(). Class fields are initialized
   * after super(), which would overwrite whatever getParticleEmitters() set and
   * break pan re-centering.
   *
   * Subclasses should set `this._fxmCanvasPanOwnerPosEnabled = true/false` while
   * building emitters.
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
   * Subclasses can override these getters to tune how long each
   * side-to-side glide takes (longer period = longer, more drawn-out arcs).
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
   * Small sprite-based effects (rats/spiders) can override this to make the
   * lateral drift more noticeable without needing extreme strength values.
   */
  static get lateralMovementAmplitudeFactor() {
    return 1;
  }

  /**
   * Minimum lateral movement amplitude in pixels (at strength=1).
   *
   * This prevents sub-pixel drift for very small sprites where size-based
   * scaling would otherwise be imperceptible.
   */
  static get lateralMovementAmplitudeMinPx() {
    return 0;
  }

  /** Parameter schema used to render controls and hold defaults. */
  static get parameters() {
    return {
      belowTokens: { label: "FXMASTER.Params.BelowTokens", type: "checkbox", value: false },
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

  /** Merge provided options into the parameter schema without inserting new keys. */
  static mergeWithDefaults(options) {
    const merged = foundry.utils.mergeObject(this.parameters, options, { insertKeys: false, inplace: false });

    if (options && typeof options === "object") {
      for (const [k, v] of Object.entries(options)) {
        if (k in merged) continue;
        if (k.startsWith("__") || k.startsWith("_")) merged[k] = v;
      }
    }

    return merged;
  }

  /**
   * Default PIXI emitter configuration for the effect.
   * Subclasses must override.
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
      return Math.round(avg / step) * step;
    }

    const rotationStatic = this.defaultConfig.behaviors.find((b) => b.type === "rotationStatic");
    if (rotationStatic !== undefined) {
      const avg = (rotationStatic.config.min + rotationStatic.config.max) / 2;
      return Math.round(avg / step) * step;
    }

    return undefined;
  }

  /** Flat map of parameter defaults (parameterName → value). */
  static get default() {
    return Object.fromEntries(Object.entries(this.parameters).map(([name, cfg]) => [name, cfg.value]));
  }

  /**
   * Global density scalar applied on top of user density and performance mode.
   * Subclasses may override to make their effect globally denser or sparser.
   */
  static get densityScalar() {
    return 0.25;
  }

  /**
   * Compute a density scale factor from Foundry's canvas Performance Mode.
   * MAX = 1.0, HIGH = 0.75, MED = 0.5, LOW = 0.25
   * Falls back to 1.0 if the setting or CONST are unavailable.
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
   * Convenience helper: take a base density (e.g. from options.density.value)
   * and apply both performance-mode scaling and the class's densityScalar.
   * @param {number} baseDensity
   * @returns {number}
   */
  static getScaledDensity(baseDensity) {
    const perfScale = this.getPerformanceDensityScale();
    return (Number(baseDensity) || 0) * perfScale * this.densityScalar;
  }

  /**
   * Default deadzone scaling for top-down effects (to avoid a vortex-like convergence).
   * Subclasses may override these getters to tweak the size of the empty center area.
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
   * Compute the radius (in pixels) of the "dead zone" at the view center for
   * top-down effects. Particles should not fully converge into this region.
   *
   * Effects should add this radius to their computed travel distance when
   * setting a torus spawnShape's innerRadius.
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
   * If Directional Movement is enabled, collapse direction variance so that
   * applying the direction parameter results in coherent travel direction.
   *
   * This is primarily intended for animal effects, which otherwise pick a
   * random rotation per particle.
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

    const spreadRaw = options?.spread?.value;
    const spread =
      directionalEnabled && Number.isFinite(Number(spreadRaw)) ? Math.min(180, Math.max(0, Number(spreadRaw))) : null;

    config.behaviors
      .filter((b) => b.type === "rotation")
      .forEach(({ config }) => {
        const range = spread !== null ? spread * 2 : config.maxStart - config.minStart;
        config.minStart = direction - range / 2;
        config.maxStart = direction + range / 2;
      });

    config.behaviors
      .filter((b) => b.type === "rotationStatic")
      .forEach(({ config }) => {
        const range = spread !== null ? spread * 2 : config.max - config.min;
        config.min = direction - range / 2;
        config.max = direction + range / 2;
      });
  }

  /** Adjust emitter lifetime and frequency together. */
  _applyLifetimeToConfig(options, config) {
    const factor = options.lifetime?.value ?? 1;
    this._applyFactorToRandNumber(config.lifetime, factor);
    config.frequency *= factor;
  }

  /** Apply a solid tint by replacing color behaviors when requested. */
  _applyTintToConfig(options, config) {
    if (!options.tint?.value.apply) return;
    const value = options.tint.value.value;
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

  /* ----------------------------------------------------------------------- */
  /* Lateral Movement                                                         */
  /* ----------------------------------------------------------------------- */

  /**
   * Create an emitter using the upstream ParticleEffectNS implementation and
   * then attach FXMaster wrappers (e.g. Lateral Movement) before autoUpdate is
   * bound to the ticker.
   *
   * @param {PIXI.particles.EmitterConfigV3} config
   * @returns {PIXI.particles.Emitter}
   */
  createEmitter(config) {
    const baseCreate = super.createEmitter?.bind(this);
    const emitter = baseCreate ? baseCreate(config) : new PIXI.particles.Emitter(this, config);

    try {
      const opts = this._fxmLastOptions ?? this.options ?? {};
      this._fxmInstallLateralMovement(emitter, opts, { wrap: true });
    } catch {}

    return emitter;
  }

  /**
   * Install a smooth side-to-side drift ("Lateral Movement") onto an emitter.
   *
   * This works by:
   * - restoring a stable travel heading (base rotation) before the emitter's
   *   native update runs so movement doesn't drift over time
   * - applying a lateral sine offset after update, then setting the visual
   *   rotation to match the curved path's tangent
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
        const turnSpeed = 2.2 + 3.2 * strength; // 1/sec
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
      } catch {}
      origUpdate(delta);
      try {
        emitter._fxmLateralMovementUpdate?.(delta);
      } catch {}
    };

    emitter._fxmLateralMovementWrapped = true;

    if (wasAuto) emitter.autoUpdate = true;
  }

  /**
   * Register a canvasPan hook that keeps emitter owner positions aligned to the
   * current view center.
   *
   * This mirrors the behavior previously implemented by the legacy rain-top
   * effect, and is used by any effect that spawns relative to the view center
   * via emitter ownerPos offsets.
   * @protected
   */
  _fxmRegisterCanvasPanOwnerPosHook() {
    this._fxmUnregisterCanvasPanOwnerPosHook();

    const ctx = this.__fxmParticleContext ?? this.options?.__fxmParticleContext;
    if (ctx) return;

    if (!globalThis.Hooks?.on || !globalThis.canvas) return;

    this._fxmCanvasPanHookId = Hooks.on("canvasPan", (_canvas, position) => {
      const d = CONFIG.fxmaster.getParticleDimensions?.(this) ?? canvas.dimensions;
      const px = position?.x ?? canvas.stage?.pivot?.x ?? 0;
      const py = position?.y ?? canvas.stage?.pivot?.y ?? 0;
      for (const e of this.emitters ?? []) {
        try {
          e.updateOwnerPos(px - d.sceneX - d.sceneWidth / 2, py - d.sceneY - d.sceneHeight / 2);
        } catch {}
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
  async fadeOut({ timeout = 2000 } = {}) {
    for (const emitter of this.emitters) {
      try {
        emitter.emit = false;
      } catch {}
    }

    if (this._fadeTicker && (canvas?.app?.ticker || PIXI.Ticker.shared)) {
      const t = canvas?.app?.ticker ?? PIXI.Ticker.shared;
      try {
        t.remove(this._fadeTicker);
      } catch {}
      this._fadeTicker = null;
      try {
        this._fadeResolve?.();
      } catch {}
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
          } catch {}
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
          } catch {}
        }
      };
      ticker.add(this._fadeTicker);
    });
  }

  /** Fade alpha from current value to a target over a timeout. */
  async fadeToAlpha({ to = 1, timeout = 2000 } = {}) {
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
      } catch {}
      this._fadeTicker = null;
      try {
        this._fadeResolve?.();
      } catch {}
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
          } catch {}
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
          } catch {}
        }
      };
      ticker.add(this._fadeTicker);
    });
  }

  /** Symmetric fade-in helper. */
  async fadeIn({ timeout = 2000 } = {}) {
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

  /** Scale → normalized UI value based on grid size. */
  static _convertScaleToV2(scale, scene) {
    const decimals = this.parameters.scale?.decimals ?? 1;
    return roundToDecimals(scale * (100 / scene.dimensions.size), decimals);
  }

  /** Speed → normalized UI value relative to max default moveSpeed and grid size. */
  static _convertSpeedToV2(speed, scene) {
    const speeds = this.defaultConfig.behaviors
      .filter(({ type }) => type === "moveSpeed")
      .flatMap(({ config }) => config.speed.list.map((v) => v.value));
    const maximumSpeed = Math.max(...speeds);

    const decimals = this.parameters.speed?.decimals ?? 1;
    return roundToDecimals((speed / maximumSpeed) * (100 / scene.dimensions.size), decimals);
  }

  /** Density → normalized per-grid-unit value. */
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
