import { FXMasterParticleEffect } from "./effect.js";

/**
 * Full-screen rain with optional splash particles (toggled via options.splash.value).
 * Uses a standard PIXI.Container for the emitter parent.
 */
export class RainParticleEffect extends FXMasterParticleEffect {
  /** @override */
  static label = "FXMASTER.Particles.Effects.Rain";

  /** @override */
  static get icon() {
    return "modules/fxmaster/assets/particle-effects/icons/rain.webp";
  }

  /** @override */
  static get group() {
    return "weather";
  }

  /**
   * Make rain a bit denser than the global default while still respecting
   * performance mode scaling.
   */
  static get densityScalar() {
    return 0.14;
  }

  /** @override */
  static get parameters() {
    const p = super.parameters;
    return {
      belowTokens: p.belowTokens,
      tint: p.tint,
      topDown: { label: "FXMASTER.Params.TopDown", type: "checkbox", value: false },
      splash: { label: "FXMASTER.Params.Splash", type: "checkbox", value: true },
      scale: p.scale,
      direction: { ...p.direction, showWhen: { topDown: false } },
      speed: p.speed,
      lifetime: { ...p.lifetime, min: 2, value: 2.5, max: 5, step: 0.1, decimals: 1 },
      density: p.density,
      alpha: p.alpha,
    };
  }

  /**
   * Base rain config
   * @type {PIXI.particles.EmitterConfigV3}
   */
  static RAIN_CONFIG = {
    lifetime: { min: 0.5, max: 0.5 },
    pos: { x: 0, y: 0 },
    behaviors: [
      {
        type: "alpha",
        config: {
          alpha: {
            list: [
              { time: 0, value: 0.7 },
              { time: 1, value: 0.1 },
            ],
          },
        },
      },
      { type: "moveSpeedStatic", config: { min: 2800, max: 3500 } },
      { type: "scaleStatic", config: { min: 0.8, max: 1 } },
      { type: "rotationStatic", config: { min: 75, max: 75 } },
      {
        type: "textureSingle",
        config: {
          texture: "modules/fxmaster/assets/particle-effects/effects/rain/rain.webp",
        },
      },
    ],
  };

  /**
   * Top-down rain config (legacy "rain-top" behavior).
   * @type {PIXI.particles.EmitterConfigV3}
   */
  static RAIN_TOP_CONFIG = {
    lifetime: { min: 0.6, max: 0.7 },
    behaviors: [
      {
        type: "alpha",
        config: {
          alpha: {
            list: [
              { value: 0, time: 0 },
              { value: 0.6, time: 0.8 },
              { value: 0.23, time: 1 },
            ],
          },
        },
      },
      {
        type: "scale",
        config: {
          scale: {
            list: [
              { value: 3, time: 0 },
              { value: 0.4, time: 1 },
            ],
          },
          minMult: 0.7,
        },
      },
      { type: "rotationStatic", config: { min: 180, max: 180 } },
      {
        type: "textureSingle",
        config: {
          texture: "modules/fxmaster/assets/particle-effects/effects/rain/rain.webp",
        },
      },
    ],
  };

  /**
   * Splash config (second emitter, optional)
   * @type {PIXI.particles.EmitterConfigV3}
   */
  static SPLASH_CONFIG = {
    lifetime: { min: 0.5, max: 0.5 },
    pos: { x: 0, y: 0 },
    behaviors: [
      { type: "moveSpeedStatic", config: { min: 0, max: 0 } },
      { type: "scaleStatic", config: { min: 0.48, max: 0.6 } },
      { type: "rotationStatic", config: { min: -90, max: -90 } },
      { type: "noRotation", config: {} },
      {
        type: "textureSingle",
        config: {
          texture: "modules/fxmaster/assets/particle-effects/effects/rain/drop.webp",
        },
      },
    ],
  };

  /** @override */
  static get defaultConfig() {
    return this.RAIN_CONFIG;
  }

  /**
   * Create an emitter backed by a standard PIXI.Container.
   * @param {PIXI.particles.EmitterConfigV3} config
   * @returns {PIXI.particles.Emitter}
   */
  createEmitter(config) {
    const container = new PIXI.Container();
    container.sortableChildren = false;
    container.eventMode = "none";

    this.addChild(container);

    const emitter = new PIXI.particles.Emitter(container, config);
    emitter.autoUpdate = true;

    return emitter;
  }

  /**
   * Build one (rain) or two (rain + splash) emitters depending on options.splash.value.
   * Particle counts are derived from view size (in grid cells),
   * user density, and Foundry's Performance Mode via FXMasterParticleEffect helpers.
   */
  getParticleEmitters(options = {}) {
    options = this.constructor.mergeWithDefaults(options);

    const topDown = !!options?.topDown?.value;
    if (topDown) return this._getTopDownEmitters(options);

    this._fxmCanvasPanOwnerPosEnabled = false;

    const splashEnabled = options?.splash?.value ?? true;
    const splashIntensity = 1;

    const d = CONFIG.fxmaster.getParticleDimensions(options);

    const { viewCells, density, maxParticles } = this.constructor.computeMaxParticlesFromView(options, {
      minViewCells: this.constructor.MIN_VIEW_CELLS ?? 3000,
    });

    const rainConfig = foundry.utils.deepClone(this.constructor.RAIN_CONFIG);
    rainConfig.maxParticles = maxParticles;

    rainConfig.frequency = 1 / maxParticles;

    rainConfig.behaviors.push({
      type: "spawnShape",
      config: {
        type: "rect",
        data: {
          x: -0.05 * d.width,
          y: -0.1 * d.height,
          w: d.width,
          h: 0.8 * d.height,
        },
      },
    });

    this.applyOptionsToConfig(options, rainConfig);
    const emitters = [this.createEmitter(rainConfig)];

    if (splashEnabled && splashIntensity > 0) {
      const splashConfig = foundry.utils.deepClone(this.constructor.SPLASH_CONFIG);

      const splashBase = viewCells * density * splashIntensity * 0.5;
      const splashMax = Math.max(1, Math.round(Math.min(splashBase, maxParticles)));

      splashConfig.maxParticles = splashMax;
      splashConfig.frequency = 1 / splashMax;

      splashConfig.behaviors.push({
        type: "spawnShape",
        config: {
          type: "rect",
          data: {
            x: 0,
            y: 0.25 * d.height,
            w: d.width,
            h: 0.75 * d.height,
          },
        },
      });

      this.applyOptionsToConfig(options, splashConfig);
      emitters.push(this.createEmitter(splashConfig));
    }

    return emitters;
  }

  /**
   * Build top-down rain (and optional splash) emitters.
   * @private
   */
  _getTopDownEmitters(options) {
    this._fxmCanvasPanOwnerPosEnabled = true;

    const d = CONFIG.fxmaster.getParticleDimensions?.(options ?? this) ?? canvas.dimensions;

    const { maxParticles, viewCells, density } = this.constructor.computeMaxParticlesFromView(options, {
      minViewCells: this.constructor.MIN_VIEW_CELLS ?? 3000,
    });

    const sceneRadius = Math.sqrt(d.sceneWidth * d.sceneWidth + d.sceneHeight * d.sceneHeight) / 2;

    const config = foundry.utils.deepClone(this.constructor.RAIN_TOP_CONFIG);
    config.maxParticles = maxParticles;

    const lifetime = config.lifetime ?? 1;
    const lifetimeMin = typeof lifetime === "number" ? lifetime : lifetime.min ?? lifetime.max ?? 1;
    config.frequency = lifetimeMin / maxParticles;

    config.behaviors.push({
      type: "moveSpeed",
      config: {
        speed: {
          list: [
            { time: 0, value: 1600 },
            { time: 1, value: 2000 },
          ],
        },
        minMult: 0.8,
      },
    });

    // Overrides any user-selected direction in top-down mode cause bad
    const optsNoDir = foundry.utils.deepClone(options);
    try {
      delete optsNoDir.direction;
    } catch {}

    this.applyOptionsToConfig(optsNoDir, config);

    const moveSpeedBehavior = config.behaviors.find(({ type }) => type === "moveSpeed");
    const moveSpeedList = moveSpeedBehavior?.config?.speed?.list ?? [{ value: 1600 }, { value: 2000 }];
    const averageSpeed =
      moveSpeedList.reduce((acc, cur) => acc + (cur.value ?? 0), 0) / Math.max(1, moveSpeedList.length);

    const lifetimeMax = typeof config.lifetime === "number" ? config.lifetime : config.lifetime?.max ?? lifetimeMin;

    config.behaviors.push({
      type: "spawnShape",
      config: {
        type: "torus",
        data: {
          x: d.sceneRect.x + d.sceneWidth / 2,
          y: d.sceneRect.y + d.sceneHeight / 2,
          radius: averageSpeed * lifetimeMax + sceneRadius * 2,
          innerRadius: averageSpeed * lifetimeMax,
          affectRotation: true,
        },
      },
    });

    const rainEmitter = this.createEmitter(config);

    const ctx = options?.__fxmParticleContext ?? this.__fxmParticleContext;
    const ownerX = ctx ? 0 : canvas.stage.pivot.x - d.sceneX - d.sceneWidth / 2;
    const ownerY = ctx ? 0 : canvas.stage.pivot.y - d.sceneY - d.sceneHeight / 2;
    rainEmitter.updateOwnerPos(ownerX, ownerY);

    const emitters = [rainEmitter];

    const splashEnabled = options?.splash?.value ?? true;
    if (splashEnabled) {
      const splashConfig = foundry.utils.deepClone(this.constructor.SPLASH_CONFIG);

      const splashBase = viewCells * density * 0.4;
      const splashMax = Math.max(1, Math.round(Math.min(splashBase, maxParticles)));
      splashConfig.maxParticles = splashMax;

      const splashLifetime = splashConfig.lifetime?.min ?? 0.5;
      splashConfig.frequency = splashLifetime / splashMax;

      splashConfig.behaviors.push({
        type: "spawnShape",
        config: {
          type: "rect",
          data: {
            x: d.sceneRect.x + d.sceneWidth / 2 - (d.width ?? d.sceneWidth) / 2,
            y: d.sceneRect.y + d.sceneHeight / 2 - (d.height ?? d.sceneHeight) / 2,
            w: d.width ?? d.sceneWidth,
            h: d.height ?? d.sceneHeight,
          },
        },
      });

      this.applyOptionsToConfig(optsNoDir, splashConfig);

      const splashEmitter = this.createEmitter(splashConfig);
      splashEmitter.updateOwnerPos(ownerX, ownerY);
      emitters.push(splashEmitter);
    }

    return emitters;
  }
}
