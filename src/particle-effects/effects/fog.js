import { FXMasterParticleEffect } from "./effect.js";
import { DefaultRectangleSpawnMixin } from "./mixins/default-rectangle-spawn.js";

/**
 * A full-screen particle effect which renders swirling fog.
 */
export class FogParticleEffect extends DefaultRectangleSpawnMixin(FXMasterParticleEffect) {
  /** @override */
  static label = "FXMASTER.Particles.Effects.Fog";

  /** @override */
  static get icon() {
    return "modules/fxmaster/assets/particle-effects/icons/fog.webp";
  }

  /** @override */
  static get group() {
    return "weather";
  }

  /** @override */
  static get parameters() {
    return foundry.utils.mergeObject(
      super.parameters,
      {
        density: { min: 0.01, value: 0.08, max: 0.15, step: 0.01, decimals: 2 },
        "-=direction": null,
      },
      { performDeletions: true },
    );
  }

  /**
   * Configuration for the particle emitter for swirling fog
   * @type {PIXI.particles.EmitterConfigV3}
   */
  static FOG_CONFIG = {
    lifetime: { min: 10, max: 25 },
    behaviors: [
      {
        type: "alpha",
        config: {
          alpha: {
            list: [
              { value: 0, time: 0 },
              { value: 0.1, time: 0.1 },
              { value: 0.3, time: 0.5 },
              { value: 0.1, time: 0.9 },
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
              { time: 1, value: 10 },
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
              { value: 1.5, time: 0 },
              { value: 1, time: 1 },
            ],
          },
          minMult: 0.5,
        },
      },
      {
        type: "rotation",
        config: { accel: 0, minSpeed: 0.15, maxSpeed: 0.35, minStart: 0, maxStart: 365 },
      },
      {
        type: "textureRandom",
        config: {
          textures: Array.fromRange(4).map(
            (n) => `modules/fxmaster/assets/particle-effects/effects/clouds/cloud${n + 1}.webp`,
          ),
        },
      },
      {
        type: "colorStatic",
        config: {
          color: "dddddd",
        },
      },
    ],
  };

  /** @override */
  static get defaultConfig() {
    return this.FOG_CONFIG;
  }
}
