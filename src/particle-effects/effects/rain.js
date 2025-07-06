import { FXMasterParticleEffect } from "./effect.js";

/**
 * A full-screen weather effect which renders rain drops and splashes.
 */
export class RainParticleEffect extends FXMasterParticleEffect {
  /** @override */
  static label = "FXMASTER.ParticleEffectRain";

  /** @override */
  static get icon() {
    return "modules/fxmaster/assets/particle-effects/icons/rain-splash.webp";
  }

  /** @override */
  static get group() {
    return "weather";
  }

  /**
   * Configuration for the particle emitter for rain
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
      {
        type: "moveSpeedStatic",
        config: { min: 2800, max: 3500 },
      },
      {
        type: "scaleStatic",
        config: { min: 0.8, max: 1 },
      },
      {
        type: "rotationStatic",
        config: { min: 75, max: 75 },
      },
      {
        type: "textureSingle",
        config: { texture: "ui/particles/rain.png" },
      },
    ],
  };

  /**
   * Configuration for the particle emitter for splashes
   * @type {PIXI.particles.EmitterConfigV3}
   */
  static SPLASH_CONFIG = {
    lifetime: { min: 0.5, max: 0.5 },
    pos: { x: 0, y: 0 },
    behaviors: [
      {
        type: "moveSpeedStatic",
        config: { min: 0, max: 0 },
      },
      {
        type: "scaleStatic",
        config: { min: 0.48, max: 0.6 },
      },
      {
        type: "rotationStatic",
        config: { min: -90, max: -90 },
      },
      {
        type: "noRotation",
        config: {},
      },
      {
        type: "textureSingle",
        config: { texture: "ui/particles/drop.png" },
      },
    ],
  };

  /** @override */
  static get defaultConfig() {
    return this.RAIN_CONFIG;
  }

  /** @override */
  getParticleEmitters(options = {}) {
    options = this.constructor.mergeWithDefaults(options);
    const d = canvas.dimensions;
    const maxParticles = (d.width / d.size) * (d.height / d.size) * options.density.value;

    // Create an emitter for rain drops
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

    // Create a second emitter for splashes
    const splashConfig = foundry.utils.deepClone(this.constructor.SPLASH_CONFIG);
    splashConfig.maxParticles = 0.5 * maxParticles;
    splashConfig.frequency = 2 / maxParticles;
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

    // Return both emitters
    return [this.createEmitter(rainConfig), this.createEmitter(splashConfig)];
  }
}
