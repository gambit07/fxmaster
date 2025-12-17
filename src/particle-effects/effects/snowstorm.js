import { FXMasterParticleEffect } from "./effect.js";

/**
 * A full-screen particle effect which renders heavy snow fall.
 */
export class SnowstormParticleEffect extends FXMasterParticleEffect {
  /** @override */
  static label = "FXMASTER.Particles.Effects.Snowstorm";

  /** @override */
  static get icon() {
    return "modules/fxmaster/assets/particle-effects/icons/snow-storm.webp";
  }

  /** @override */
  static get group() {
    return "weather";
  }

  /** @override */
  static get parameters() {
    return foundry.utils.mergeObject(super.parameters, {
      density: { min: 0.05, value: 0.6, max: 1, step: 0.05, decimals: 2 },
    });
  }

  /**
   * Configuration for the particle emitter for heavy snow fall
   * @type {PIXI.particles.EmitterConfigV3}
   */
  static SNOWSTORM_CONFIG = {
    lifetime: { min: 2.5, max: 6 },
    behaviors: [
      {
        type: "alphaStatic",
        config: { alpha: 1 },
      },
      {
        type: "movePath",
        config: {
          path: "sin(x / 150) * 25",
          speed: {
            list: [
              { value: 400, time: 0 },
              { value: 350, time: 1 },
            ],
          },
          minMult: 0.2,
        },
      },
      {
        type: "scale",
        config: {
          scale: {
            list: [
              { value: 0.2, time: 0 },
              { value: 0.08, time: 1 },
            ],
          },
          minMult: 0.8,
        },
      },
      {
        type: "rotation",
        config: { accel: 0, minSpeed: -60, maxSpeed: 60, minStart: 86, maxStart: 94 },
      },
      {
        type: "textureRandom",
        config: {
          textures: Array.fromRange(2).map(
            (n) => `modules/fxmaster/assets/particle-effects/effects/snowstorm/snow${n + 1}.webp`,
          ),
        },
      },
    ],
  };

  /** @override */
  static get defaultConfig() {
    return this.SNOWSTORM_CONFIG;
  }

  /** @override */
  getParticleEmitters(options = {}) {
    options = this.constructor.mergeWithDefaults(options);

    const d = canvas.dimensions;

    const { maxParticles } = this.constructor.computeMaxParticlesFromView(options, {
      minViewCells: this.constructor.MIN_VIEW_CELLS ?? 10000,
    });

    const config = foundry.utils.deepClone(this.constructor.defaultConfig);
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

    config.behaviors.push({
      type: "spawnShape",
      config: {
        type: "rect",
        data: { x: d.sceneRect.x, y: d.sceneRect.y, w: d.sceneRect.width, h: d.sceneRect.height },
      },
    });

    this.applyOptionsToConfig(options, config);

    return [this.createEmitter(config)];
  }
}
