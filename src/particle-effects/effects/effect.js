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

/**
 * Abstract particle effect with parameter plumbing and utilities.
 * Subclasses must provide a PIXI EmitterConfig via `defaultConfig`.
 */
export class FXMasterParticleEffect extends CONFIG.fxmaster.ParticleEffectNS {
  /** Human-readable label, typically a localization key. */
  static label = "FXMASTER.Common.ParticleEffect";

  /** Effect group used by the weather UI. */
  static get group() {
    return "other";
  }

  /** Icon path shown in the UI. */
  static get icon() {
    return "modules/fxmaster/assets/particle-effects/icons/snow.webp";
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

  /** Apply user options onto a mutable emitter config. */
  applyOptionsToConfig(options, config) {
    this._applyScaleToConfig(options, config);
    this._applySpeedToConfig(options, config);
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

  /** Center rotation ranges on the chosen direction while preserving spread. */
  _applyDirectionToConfig(options, config) {
    const direction = options.direction?.value;
    if (direction === undefined) return;

    config.behaviors
      .filter((b) => b.type === "rotation")
      .forEach(({ config }) => {
        const range = config.maxStart - config.minStart;
        config.minStart = direction - range / 2;
        config.maxStart = direction + range / 2;
      });

    config.behaviors
      .filter((b) => b.type === "rotationStatic")
      .forEach(({ config }) => {
        const range = config.max - config.min;
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

  /** Optionally pre-warm emitters before playing. */
  play({ prewarm = false } = {}) {
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
      t.remove(this._fadeTicker);
      this._fadeTicker = null;
    }

    const startAlpha = this.alpha ?? 1;
    if (!timeout || timeout <= 0) {
      this.alpha = 0;
      return;
    }

    const ticker = PIXI.Ticker.shared;
    return new Promise((resolve) => {
      const start = ticker.lastTime ?? performance.now();
      this._fadeTicker = () => {
        if (this.destroyed) {
          ticker.remove(this._fadeTicker);
          this._fadeTicker = null;
          resolve();
          return;
        }
        const now = ticker.lastTime ?? performance.now();
        const u = Math.min(1, (now - start) / timeout);
        this.alpha = startAlpha * (1 - u);
        if (u >= 1) {
          ticker.remove(this._fadeTicker);
          this._fadeTicker = null;
          resolve();
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
      t.remove(this._fadeTicker);
      this._fadeTicker = null;
    }

    return new Promise((resolve) => {
      const start = ticker.lastTime ?? performance.now();
      this._fadeTicker = () => {
        if (this.destroyed) {
          ticker.remove(this._fadeTicker);
          this._fadeTicker = null;
          resolve();
          return;
        }
        const now = ticker.lastTime ?? performance.now();
        const u = Math.min(1, (now - start) / timeout);
        this.alpha = from + (to - from) * u;
        if (u >= 1) {
          ticker.remove(this._fadeTicker);
          this._fadeTicker = null;
          resolve();
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
