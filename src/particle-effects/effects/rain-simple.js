import { FXMasterParticleEffect } from "./effect.js";

/**
 * A full-screen weather effect which renders rain drops.
 */
export class RainSimpleParticleEffect extends FXMasterParticleEffect {
  /** @override */
  static label = "FXMASTER.ParticleEffectRainSimple";

  /** @override */
  static get icon() {
    return "modules/fxmaster/assets/particle-effects/icons/rain.webp";
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

  /** @override */
  static get defaultConfig() {
    return this.RAIN_CONFIG;
  }

  /** @override */
  getParticleEmitters(options = {}) {
    options = this.constructor.mergeWithDefaults(options);
    const d = canvas.dimensions;
    const maxParticles = (d.width / d.size) * (d.height / d.size) * options.density.value;

    const config = foundry.utils.deepClone(this.constructor.RAIN_CONFIG);
    config.maxParticles = maxParticles;
    config.frequency = 1 / maxParticles;
    config.behaviors.push({
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
    this.applyOptionsToConfig(options, config);

    return [this.createEmitter(config)];
  }
}
