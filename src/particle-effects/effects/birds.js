import { FXMasterParticleEffect } from "./effect.js";

/**
 * A full-screen particle effect which renders flying birds.
 */
export class BirdsParticleEffect extends FXMasterParticleEffect {
  /** @override */
  static label = "FXMASTER.ParticleEffectBirds";

  /** @override */
  static get icon() {
    return "modules/fxmaster/assets/particle-effects/icons/crows.png";
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
        animations: {
          label: "FXMASTER.Animations",
          type: "multi-select",
          options: {
            glide: "FXMASTER.ParicleEffectBirdsAnimationsGlide",
            flap: "FXMASTER.ParicleEffectBirdsAnimationsFlap",
            mixed: "FXMASTER.ParicleEffectBirdsAnimationsMixed",
          },
          value: ["mixed"],
        },
      },
      { performDeletions: true },
    );
  }

  /**
   * Configuration for the particle emitter for flying birds
   * @type {PIXI.particles.EmitterConfigV3}
   */
  static BIRDS_CONFIG = {
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
              { value: 0.3, time: 0 },
              { value: 0.7, time: 0.1 },
              { value: 0.7, time: 0.9 },
              { value: 0.3, time: 1 },
            ],
          },
        },
      },
      {
        type: "rotationStatic",
        config: { min: 0, max: 359 },
      },
    ],
  };

  /** @override */
  static get defaultConfig() {
    return this.BIRDS_CONFIG;
  }

  /** @override */
  getParticleEmitters(options = {}) {
    options = this.constructor.mergeWithDefaults(options);
    const d = canvas.dimensions;
    const maxParticles = (d.width / d.size) * (d.height / d.size) * options.density.value;
    const config = foundry.utils.deepClone(this.constructor.BIRDS_CONFIG);
    config.maxParticles = maxParticles;
    config.frequency = config.lifetime.min / maxParticles;
    config.behaviors.push({
      type: "spawnShape",
      config: {
        type: "rect",
        data: { x: d.sceneRect.x, y: d.sceneRect.y, w: d.sceneRect.width, h: d.sceneRect.height },
      },
    });
    config.behaviors.push({
      type: "animatedRandom",
      config: {
        anims: this._getAnimations(options),
      },
    });
    this.applyOptionsToConfig(options, config);

    return [this.createEmitter(config)];
  }

  /**
   * Get the animation to use for this effect.
   * @returns The animations to use for the effect
   * @protected
   */
  _getAnimations(options) {
    const animations = {
      glide: [
        { textureNumber: 2, count: 30 },
        ...Array(4)
          .fill([
            { texture: 1, count: 3 },
            { texture: 2, count: 2 },
            { texture: 3, count: 3 },
            { texture: 2, count: 2 },
          ])
          .deepFlatten(),
        { texture: 2, count: 68 },
      ],
      flap: [
        { texture: 1, count: 3 },
        { texture: 2, count: 2 },
        { texture: 3, count: 3 },
        { texture: 2, count: 2 },
      ],
      mixed: [
        { texture: 2, count: 7 },
        { texture: 1, count: 3 },
        { texture: 2, count: 2 },
        { texture: 3, count: 3 },
        { texture: 2, count: 7 },
      ],
    };

    const getAnim = (animation) => ({
      framerate: 20,
      loop: true,
      textures: animation.map(({ texture, count }) => ({
        texture: `modules/fxmaster/assets/particle-effects/effects/birds/bird${texture}.png`,
        count,
      })),
    });

    const anims = (options.animations?.value ?? [])
      .filter((animation) => Object.keys(animations).includes(animation))
      .map((animation) => getAnim(animations[animation]));

    if (anims.length === 0) {
      anims.push(getAnim(animations.mixed));
    }

    return anims;
  }
}
