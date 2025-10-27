import { FXMasterParticleEffect } from "./effect.js";
import { withSteppedGradientColor } from "./helpers/with-stepped-gradient-color.js";

/**
 * A full-screen particle effect which renders floating embers.
 */
export class EmbersParticleEffect extends FXMasterParticleEffect {
  /** @override */
  static label = "FXMASTER.Particles.Effects.Embers";

  /** @override */
  static get icon() {
    return "modules/fxmaster/assets/particle-effects/icons/embers.webp";
  }

  /** @override */
  static get group() {
    return "ambient";
  }

  /** @override */
  static get parameters() {
    return foundry.utils.mergeObject(
      super.parameters,
      {
        density: { min: 0.05, value: 0.7, max: 1.4, step: 0.05, decimals: 2 },
        tint: { value: { value: "#f77300" } },
        "-=direction": null,
      },
      { performDeletions: true },
    );
  }

  /**
   * Configuration for the particle emitter for floating embers
   * @type {PIXI.particles.EmitterConfigV3}
   */
  static EMBERS_CONFIG = {
    layerLevel: "aboveDarkness",
    blendMode: PIXI.BLEND_MODES.ADD,
    lifetime: { min: 4, max: 6 },
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
        config: { min: 24, max: 40 },
      },
      {
        type: "scale",
        config: {
          scale: {
            list: [
              { value: 0.15, time: 0 },
              { value: 0.01, time: 1 },
            ],
          },
          minMult: 0.85,
        },
      },
      {
        type: "rotation",
        config: { accel: 0, minSpeed: 100, maxSpeed: 200, minStart: 0, maxStart: 365 },
      },
      {
        type: "textureSingle",
        config: { texture: "modules/fxmaster/assets/particle-effects/effects/embers/ember.webp" },
      },
      {
        type: "color",
        config: {
          color: {
            list: [
              { value: "f77300", time: 0 },
              { value: "f72100", time: 1 },
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
    return this.EMBERS_CONFIG;
  }

  /** @override */
  getParticleEmitters(options = {}) {
    options = this.constructor.mergeWithDefaults(options);
    const d = canvas.dimensions;
    const maxParticles = (d.width / d.size) * (d.height / d.size) * options.density.value;
    const config = foundry.utils.deepClone(this.constructor.EMBERS_CONFIG);
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
