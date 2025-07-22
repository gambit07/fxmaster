import { FXMasterParticleEffect } from "./effect.js";
import { DefaultRectangleSpawnMixin } from "./mixins/default-rectangle-spawn.js";

/**
 * A full-screen particle effect which renders scurrying rats.
 */
export class RatsParticleEffect extends DefaultRectangleSpawnMixin(FXMasterParticleEffect) {
  /** @override */
  static label = "FXMASTER.ParticleEffectRats";

  /** @override */
  static get icon() {
    return "modules/fxmaster/assets/particle-effects/icons/rats.webp";
  }

  /** @override */
  static get group() {
    return "animals";
  }

  /** @override */
  static get parameters() {
    return foundry.utils.mergeObject(
      super.parameters,
      {
        density: { min: 0.001, value: 0.006, max: 0.3, step: 0.001, decimals: 3 },
        "-=direction": null,
      },
      { performDeletions: true },
    );
  }

  /**
   * Configuration for the particle emitter for scurrying rats
   * @type {PIXI.particles.EmitterConfigV3}
   */
  static RATS_CONFIG = {
    lifetime: { min: 20, max: 40 },
    behaviors: [
      {
        type: "alpha",
        config: {
          alpha: {
            list: [
              { value: 0, time: 0 },
              { value: 1, time: 0.02 },
              { value: 1, time: 0.98 },
              { value: 0, time: 1 },
            ],
          },
        },
      },
      {
        type: "moveSpeedStatic",
        config: { min: 120, max: 200 },
      },
      {
        type: "scale",
        config: {
          scale: {
            list: [
              { value: 0.03, time: 0 },
              { value: 0.125, time: 0.1 },
              { value: 0.125, time: 0.9 },
              { value: 0.03, time: 1 },
            ],
          },
          minMult: 0.5,
        },
      },
      {
        type: "rotationStatic",
        config: { min: 0, max: 359 },
      },
      {
        type: "animatedSingle",
        config: {
          anim: {
            framerate: "10",
            loop: true,
            textures: Array.fromRange(5).map(
              (n) => `modules/fxmaster/assets/particle-effects/effects/rats/rat${n + 1}.webp`,
            ),
          },
        },
      },
    ],
  };

  /** @override */
  static get defaultConfig() {
    return this.RATS_CONFIG;
  }
}
