import { FXMasterParticleEffect } from "./effect.js";

/**
 * A full-screen particle effect which renders drifting bubbles.
 */
export class CloudsParticleEffect extends FXMasterParticleEffect {
  /** @override */
  static label = "FXMASTER.ParticleEffectClouds";

  /** @override */
  static get icon() {
    return "modules/fxmaster/assets/particle-effects/icons/clouds.webp";
  }

  /** @override */
  static get group() {
    return "weather";
  }

  /** @override */
  static get parameters() {
    return foundry.utils.mergeObject(super.parameters, {
      density: { min: 0.001, value: 0.03, max: 0.2, step: 0.001, decimals: 3 },
    });
  }

  /**
   * Configuration for the particle emitter for drifting clouds
   * @type {PIXI.particles.EmitterConfigV3}
   */
  static CLOUDS_CONFIG = {
    behaviors: [
      {
        type: "alpha",
        config: {
          alpha: {
            list: [
              { value: 0, time: 0 },
              { value: 0.5, time: 0.05 },
              { value: 0.5, time: 0.95 },
              { value: 0, time: 1 },
            ],
          },
        },
      },
      { type: "moveSpeedStatic", config: { min: 30, max: 100 } },
      { type: "scaleStatic", config: { min: 0.08, max: 0.8 } },
      { type: "rotationStatic", config: { min: 80, max: 100 } },
      {
        type: "textureRandom",
        config: {
          textures: Array.fromRange(4).map(
            (n) => `modules/fxmaster/assets/particle-effects/effects/clouds/cloud${n + 1}.webp`,
          ),
        },
      },
    ],
  };

  /** @override */
  static get defaultConfig() {
    return this.CLOUDS_CONFIG;
  }

  /** @override */
  getParticleEmitters(options = {}) {
    options = this.constructor.mergeWithDefaults(options);
    const d = canvas.dimensions;
    const maxParticles = (d.width / d.size) * (d.height / d.size) * options.density.value;

    const offsetFactor = 2 / 3;
    const config = foundry.utils.deepClone(this.constructor.CLOUDS_CONFIG);
    const speed = config.behaviors.find(({ type }) => type === "moveSpeedStatic")?.config;
    if (speed === undefined) {
      throw new Error("Expected CLOUDS_CONFIG to have a moveSpeedStatic behavior but it didn't.");
    }

    const diagonal = Math.sqrt(d.sceneRect.width * d.sceneRect.width + d.sceneRect.height * d.sceneRect.height);
    const averageSpeed = (speed.min + speed.max) / 2;
    const averageDiagonalTime = diagonal / averageSpeed;
    const minLifetime = averageDiagonalTime / offsetFactor / 2;
    const maxLifetime = averageDiagonalTime / offsetFactor;

    const angle = Math.toRadians(options.direction.value);
    const directionVector = {
      x: Math.cos(angle),
      y: Math.sin(angle),
    };

    config.maxParticles = maxParticles;
    config.frequency = (minLifetime + maxLifetime) / 2 / maxParticles;
    config.lifetime = { min: minLifetime, max: maxLifetime };
    config.behaviors.push({
      type: "spawnShape",
      config: {
        type: "rect",
        data: {
          x: d.sceneRect.x - directionVector.x * d.sceneRect.width * offsetFactor,
          y: d.sceneRect.y - directionVector.y * d.sceneRect.height * offsetFactor,
          w: d.sceneRect.width,
          h: d.sceneRect.height,
        },
      },
    });
    this.applyOptionsToConfig(options, config);

    return [this.createEmitter(config)];
  }
}
