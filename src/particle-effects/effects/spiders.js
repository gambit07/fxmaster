import { FXMasterParticleEffect } from "./effect.js";
import { DefaultRectangleSpawnMixin } from "./mixins/default-rectangle-spawn.js";

/**
 * A full-screen particle effect which renders crawling spiders.
 */
export class SpiderParticleEffect extends DefaultRectangleSpawnMixin(FXMasterParticleEffect) {
  /** @override */
  static label = "FXMASTER.Particles.Effects.Spiders";

  /** @override */
  static get icon() {
    return "modules/fxmaster/assets/particle-effects/icons/spiders.webp";
  }

  /** @override */
  static get group() {
    return "animals";
  }

  static get densityScalar() {
    return 0.5;
  }

  static MIN_VIEW_CELLS = 15000;

  /** @override */
  static get parameters() {
    return foundry.utils.mergeObject(
      super.parameters,
      {
        density: { min: 0.05, value: 0.3, max: 0.7, step: 0.05, decimals: 2 },
        "-=direction": null,
      },
      { performDeletions: true },
    );
  }

  /**
   * Configuration for the particle emitter for crawling spiders
   * @type {PIXI.particles.EmitterConfigV3}
   */
  static SPIDERS_CONFIG = {
    lifetime: { min: 5, max: 10 },
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
              { time: 0, value: 15 },
              { time: 1, value: 25 },
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
              { value: 0.05, time: 0 },
              { value: 0.08, time: 0.05 },
              { value: 0.08, time: 0.95 },
              { value: 0.05, time: 1 },
            ],
          },
          minMult: 0.2,
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
            textures: Array.fromRange(25).map((n) => ({
              count: 1,
              texture: `modules/fxmaster/assets/particle-effects/effects/spiders/spider${String(n + 1).padStart(
                2,
                "0",
              )}.webp`,
            })),
          },
        },
      },
    ],
  };

  /** @override */
  static get defaultConfig() {
    return this.SPIDERS_CONFIG;
  }
}
