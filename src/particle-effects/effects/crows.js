import { FXMasterParticleEffect } from "./effect.js";
import { DefaultRectangleSpawnMixin } from "./mixins/default-rectangle-spawn.js";

/**
 * A full-screen particle effect which renders flying crows.
 */
export class CrowsParticleEffect extends DefaultRectangleSpawnMixin(FXMasterParticleEffect) {
  /** @override */
  static label = "FXMASTER.Particles.Effects.Crows";

  /** @override */
  static get icon() {
    return "modules/fxmaster/assets/particle-effects/icons/crows.webp";
  }

  /** @override */
  static get group() {
    return "animals";
  }

  static get lateralMovementPeriodMin() {
    return 5;
  }
  static get lateralMovementPeriodMax() {
    return 10;
  }

  /** @override */
  static get parameters() {
    const p = super.parameters;
    return {
      belowTokens: p.belowTokens,
      tint: p.tint,
      directionalMovement: {
        label: "FXMASTER.Params.DirectionalMovement",
        type: "checkbox",
        value: false,
      },
      direction: { ...p.direction, showWhen: { directionalMovement: true } },
      spread: {
        label: "FXMASTER.Params.Spread",
        type: "range",
        min: 0,
        value: 0,
        max: 20,
        step: 1,
        decimals: 0,
        showWhen: { directionalMovement: true },
      },
      lateralMovement: {
        label: "FXMASTER.Params.LateralMovement",
        type: "range",
        min: 0,
        value: 0,
        max: 1,
        step: 0.05,
        decimals: 2,
      },
      scale: p.scale,
      speed: p.speed,
      lifetime: p.lifetime,
      density: { ...p.density, min: 0.001, value: 0.006, max: 0.01, step: 0.001, decimals: 3 },
      alpha: p.alpha,
    };
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
