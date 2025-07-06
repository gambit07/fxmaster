import { FXMasterParticleEffect } from "./effect.js";
import { DefaultRectangleSpawnMixin } from "./mixins/default-rectangle-spawn.js";

/**
 * A full-screen particle effect which renders gently falling autumn leaves.
 */
export class AutumnLeavesParticleEffect extends DefaultRectangleSpawnMixin(FXMasterParticleEffect) {
  /** @override */
  static label = "FXMASTER.ParticleEffectAutumnLeaves";

  /** @override */
  static get icon() {
    return "modules/fxmaster/assets/particle-effects/icons/autumn-leaves.webp";
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
        density: { min: 0.05, value: 0.25, max: 1, step: 0.05, decimals: 2 },
        "-=direction": null,
      },
      { performDeletions: true },
    );
  }

  /**
   * Configuration for the particle emitter for falling leaves
   * @type {PIXI.particles.EmitterConfigV3}
   */
  static LEAF_CONFIG = {
    lifetime: { min: 10, max: 10 },
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
              { time: 0, value: 0.2 },
              { time: 1, value: 0.4 },
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
        type: "textureRandom",
        config: {
          textures: Array.fromRange(6).map((n) => `ui/particles/leaf${n + 1}.png`),
        },
      },
    ],
  };

  /** @override */
  static get defaultConfig() {
    return this.LEAF_CONFIG;
  }
}
