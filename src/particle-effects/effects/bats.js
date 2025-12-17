import { FXMasterParticleEffect } from "./effect.js";
import { DefaultRectangleSpawnMixin } from "./mixins/default-rectangle-spawn.js";

/**
 * A full-screen particle effect which renders flying bats.
 */
export class BatsParticleEffect extends DefaultRectangleSpawnMixin(FXMasterParticleEffect) {
  /** @override */
  static label = "FXMASTER.Particles.Effects.Bats";

  /** @override */
  static get icon() {
    return "modules/fxmaster/assets/particle-effects/icons/bats.webp";
  }

  /** @override */
  static get group() {
    return "animals";
  }

  static get densityScalar() {
    return 0.3;
  }

  /** @override */
  static get parameters() {
    return foundry.utils.mergeObject(
      super.parameters,
      {
        density: { min: 0.005, value: 0.05, max: 0.1, step: 0.005, decimals: 3 },
        "-=direction": null,
      },
      { performDeletions: true },
    );
  }

  /**
   * Configuration for the particle emitter for flying bats
   * @type {PIXI.particles.EmitterConfigV3}
   */
  static BATS_CONFIG = {
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
              { time: 0, value: 200 },
              { time: 1, value: 260 },
            ],
          },
          minMult: 0.8,
        },
      },
      {
        type: "scale",
        config: {
          scale: {
            list: [
              { value: 0.02, time: 0 },
              { value: 0.1, time: 0.05 },
              { value: 0.1, time: 0.95 },
              { value: 0.02, time: 1 },
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
            framerate: 30,
            loop: true,
            textures: [
              { texture: 1, count: 1 },
              { texture: 2, count: 1 },
              { texture: 3, count: 1 },
              { texture: 4, count: 1 },
              { texture: 5, count: 2 },
              { texture: 4, count: 1 },
              { texture: 3, count: 1 },
              { texture: 2, count: 1 },
            ].map(({ texture, count }) => ({
              texture: `modules/fxmaster/assets/particle-effects/effects/bats/bat${texture}.webp`,
              count,
            })),
          },
        },
      },
    ],
  };

  /** @override */
  static get defaultConfig() {
    return this.BATS_CONFIG;
  }
}
