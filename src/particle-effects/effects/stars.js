import { FXMasterParticleEffect } from "./effect.js";
import { withSteppedGradientColor } from "./helpers/with-stepped-gradient-color.js";
/**
 * A full-screen particle effect which renders drifting stars.
 */
export class StarsParticleEffect extends FXMasterParticleEffect {
  /** @override */
  static label = "FXMASTER.ParticleEffectStars";

  /** @override */
  static get icon() {
    return "modules/fxmaster/assets/particle-effects/icons/stars.png";
  }

  /** @override */
  static get parameters() {
    return foundry.utils.mergeObject(
      super.parameters,
      {
        density: { min: 0.05, value: 0.3, max: 1, step: 0.05, decimals: 2 },
        tint: { value: { value: "#bee8ee" } },
        "-=direction": null,
      },
      { performDeletions: true },
    );
  }

  /**
   * Configuration for the particle emitter for drifting stars
   * @type {PIXI.particles.EmitterConfigV3}
   */
  static STARS_CONFIG = {
    lifetime: { min: 8, max: 15 },
    behaviors: [
      {
        type: "alpha",
        config: {
          alpha: {
            list: [
              { value: 0, time: 0 },
              { value: 0.9, time: 0.3 },
              { value: 0.9, time: 0.95 },
              { value: 0, time: 1 },
            ],
          },
        },
      },
      {
        type: "moveSpeedStatic",
        config: { min: 3, max: 5 },
      },
      {
        type: "scale",
        config: {
          scale: {
            list: [
              { value: 0.05, time: 0 },
              { value: 0.03, time: 1 },
            ],
          },
          minMult: 0.85,
        },
      },
      {
        type: "rotation",
        config: { accel: 0, minSpeed: 20, maxSpeed: 50, minStart: 0, maxStart: 365 },
      },
      {
        type: "textureRandom",
        config: {
          textures: Array.fromRange(8).map(
            (n) => `modules/fxmaster/assets/particle-effects/effects/stars/star${n + 1}.png`,
          ),
        },
      },
      {
        type: "color",
        config: {
          color: {
            list: [
              { value: "bee8ee", time: 0 },
              { value: "d0e8ec", time: 1 },
            ],
          },
        },
      },
      {
        type: "blendMode",
        config: {
          blendMode: "screen",
        },
      },
    ],
  };

  /** @override */
  static get defaultConfig() {
    return this.STARS_CONFIG;
  }

  /** @override */
  getParticleEmitters(options = {}) {
    options = this.constructor.mergeWithDefaults(options);
    const d = canvas.dimensions;
    const maxParticles = (d.width / d.size) * (d.height / d.size) * options.density.value;
    const config = foundry.utils.deepClone(this.constructor.STARS_CONFIG);
    config.maxParticles = maxParticles;
    config.frequency = config.lifetime.min / maxParticles;
    config.behaviors.push({
      type: "spawnShape",
      config: {
        type: "rect",
        data: { x: d.sceneRect.x, y: d.sceneRect.y, w: d.sceneRect.width, h: d.sceneRect.height },
      },
    });
    this.applyOptionsToConfig(options, config);

    const emitter = withSteppedGradientColor(this.createEmitter(config), config);
    return [emitter];
  }
}
