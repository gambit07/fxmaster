import { FXMasterParticleEffect } from "./effect.js";
import { DefaultRectangleSpawnMixin } from "./mixins/default-rectangle-spawn.js";

/**
 * A full-screen particle effect which renders floating bubbles.
 */
export class BubblesParticleEffect extends DefaultRectangleSpawnMixin(FXMasterParticleEffect) {
  /** @override */
  static label = "FXMASTER.Particles.Effects.Bubbles";

  /** @override */
  static get icon() {
    return "modules/fxmaster/assets/particle-effects/icons/bubbles.webp";
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
        density: { min: 0.01, value: 0.15, max: 0.5, step: 0.01, decimals: 2 },
        "-=direction": null,
      },
      { performDeletions: true },
    );
  }

  /**
   * Configuration for the particle emitter for floating bubbles
   * @type {PIXI.particles.EmitterConfigV3}
   */
  static BUBBLES_CONFIG = {
    lifetime: { min: 8, max: 10 },
    behaviors: [
      {
        type: "alpha",
        config: {
          alpha: {
            list: [
              { value: 0, time: 0 },
              { value: 0.85, time: 0.05 },
              { value: 0.85, time: 0.98 },
              { value: 0, time: 1 },
            ],
          },
        },
      },
      {
        type: "moveSpeed",
        config: {
          speed: {
            list: [
              { time: 0, value: 20 },
              { time: 1, value: 60 },
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
              { value: 0.25, time: 0 },
              { value: 0.5, time: 1 },
            ],
          },
          minMult: 0.5,
        },
      },
      {
        type: "rotation",
        config: { accel: 0, minSpeed: 100, maxSpeed: 200, minStart: 0, maxStart: 365 },
      },
      {
        type: "textureSingle",
        config: { texture: "modules/fxmaster/assets/particle-effects/effects/bubbles/bubble.webp" },
      },
    ],
  };

  /** @override */
  static get defaultConfig() {
    return this.BUBBLES_CONFIG;
  }
}
