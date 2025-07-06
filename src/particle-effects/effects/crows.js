import { FXMasterParticleEffect } from "./effect.js";
import { DefaultRectangleSpawnMixin } from "./mixins/default-rectangle-spawn.js";

/**
 * A full-screen particle effect which renders flying crows.
 */
export class CrowsParticleEffect extends DefaultRectangleSpawnMixin(FXMasterParticleEffect) {
  /** @override */
  static label = "FXMASTER.ParticleEffectCrows";

  /** @override */
  static get icon() {
    return "modules/fxmaster/assets/particle-effects/icons/crows.webp";
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
        density: { min: 0.001, value: 0.006, max: 0.01, step: 0.001, decimals: 3 },
        "-=direction": null,
      },
      { performDeletions: true },
    );
  }

  /**
   * Configuration for the particle emitter for flying crows
   * @type {PIXI.particles.EmitterConfigV3}
   */
  static CROWS_CONFIG = {
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
        type: "moveSpeed",
        config: {
          speed: {
            list: [
              { time: 0, value: 90 },
              { time: 1, value: 100 },
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
              { value: 0.03, time: 0 },
              { value: 0.12, time: 0.1 },
              { value: 0.12, time: 0.9 },
              { value: 0.03, time: 1 },
            ],
          },
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
            framerate: 15,
            loop: true,
            textures: [
              { texture: 1, count: 20 },
              { texture: 2, count: 3 },
              { texture: 3, count: 2 },
              { texture: 4, count: 2 },
              { texture: 3, count: 2 },
              { texture: 2, count: 3 },
            ].map(({ texture, count }) => ({
              texture: `modules/fxmaster/assets/particle-effects/effects/crows/crow${texture}.webp`,
              count,
            })),
          },
        },
      },
    ],
  };

  /** @override */
  static get defaultConfig() {
    return this.CROWS_CONFIG;
  }
}
