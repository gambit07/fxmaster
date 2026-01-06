import { FXMasterParticleEffect } from "./effect.js";

/**
 * A full-screen weather effect which renders drifting snowflakes.
 */
export class SnowParticleEffect extends FXMasterParticleEffect {
  /** @override */
  static label = "FXMASTER.Particles.Effects.Snow";

  /** @override */
  static get icon() {
    return "modules/fxmaster/assets/particle-effects/icons/snow.webp";
  }

  /** @override */
  static get group() {
    return "weather";
  }

  static get densityScalar() {
    return 0.05;
  }

  /**
   * Configuration for the particle emitter for snow
   * @type {PIXI.particles.EmitterConfigV3}
   */
  static SNOW_CONFIG = {
    lifetime: { min: 4, max: 4 },
    behaviors: [
      {
        type: "alpha",
        config: {
          alpha: {
            list: [
              { time: 0, value: 0.9 },
              { time: 1, value: 0.5 },
            ],
          },
        },
      },
      {
        type: "moveSpeed",
        config: {
          speed: {
            list: [
              { time: 0, value: 190 },
              { time: 1, value: 210 },
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
              { time: 0, value: 0.2 },
              { time: 1, value: 0.4 },
            ],
          },
          minMult: 0.5,
        },
      },
      {
        type: "rotation",
        config: { accel: 0, minSpeed: 0, maxSpeed: 200, minStart: 50, maxStart: 75 },
      },
      {
        type: "textureSingle",
        config: {
          texture: "modules/fxmaster/assets/particle-effects/effects/snow/snow.webp",
        },
      },
    ],
  };

  /** @override */
  static get defaultConfig() {
    return this.SNOW_CONFIG;
  }

  /** @override */
  getParticleEmitters(options = {}) {
    options = this.constructor.mergeWithDefaults(options);

    const d = CONFIG.fxmaster.getParticleDimensions(options);

    const { maxParticles } = this.constructor.computeMaxParticlesFromView(options, {
      minViewCells: this.constructor.MIN_VIEW_CELLS ?? 10000,
    });

    const config = foundry.utils.deepClone(this.constructor.SNOW_CONFIG);
    config.maxParticles = maxParticles;

    const lifetime = config.lifetime ?? 1;
    let avgLifetime;
    if (typeof lifetime === "number") {
      avgLifetime = lifetime;
    } else {
      const min = lifetime.min ?? lifetime.max ?? 1;
      const max = lifetime.max ?? lifetime.min ?? min;
      avgLifetime = (min + max) / 2;
    }
    config.frequency = avgLifetime / maxParticles;

    config.behaviors ??= [];

    config.behaviors.push({
      type: "spawnShape",
      config: {
        type: "rect",
        data: { x: 0, y: -0.1 * d.height, w: d.width, h: d.height },
      },
    });

    this.applyOptionsToConfig(options, config);
    return [this.createEmitter(config)];
  }
}
