import { FXMasterParticleEffect } from "./effect.js";

/**
 * Full-screen rain with optional splash particles (toggled via options.splash.value).
 */
export class RainParticleEffect extends FXMasterParticleEffect {
  /** @override */
  static label = "FXMASTER.Particles.Effects.Rain";

  /** @override */
  static get icon() {
    return "modules/fxmaster/assets/particle-effects/icons/rain.webp";
  }

  /** @override */
  static get group() {
    return "weather";
  }

  static get parameters() {
    return foundry.utils.mergeObject(
      super.parameters,
      {
        splash: { label: "FXMASTER.Common.Splash", type: "checkbox", value: true },
      },
      { performDeletions: true },
    );
  }

  /**
   * Base rain config
   * @type {PIXI.particles.EmitterConfigV3}
   */
  static RAIN_CONFIG = {
    lifetime: { min: 0.5, max: 0.5 },
    pos: { x: 0, y: 0 },
    behaviors: [
      {
        type: "alpha",
        config: {
          alpha: {
            list: [
              { time: 0, value: 0.7 },
              { time: 1, value: 0.1 },
            ],
          },
        },
      },
      { type: "moveSpeedStatic", config: { min: 2800, max: 3500 } },
      { type: "scaleStatic", config: { min: 0.8, max: 1 } },
      { type: "rotationStatic", config: { min: 75, max: 75 } },
      { type: "textureSingle", config: { texture: "ui/particles/rain.png" } },
    ],
  };

  /**
   * Splash config (second emitter, optional)
   * @type {PIXI.particles.EmitterConfigV3}
   */
  static SPLASH_CONFIG = {
    lifetime: { min: 0.5, max: 0.5 },
    pos: { x: 0, y: 0 },
    behaviors: [
      { type: "moveSpeedStatic", config: { min: 0, max: 0 } },
      { type: "scaleStatic", config: { min: 0.48, max: 0.6 } },
      { type: "rotationStatic", config: { min: -90, max: -90 } },
      { type: "noRotation", config: {} },
      { type: "textureSingle", config: { texture: "ui/particles/drop.png" } },
    ],
  };

  /** @override */
  static get defaultConfig() {
    return this.RAIN_CONFIG;
  }

  /**
   * Build one (rain) or two (rain + splash) emitters depending on options.splash.value.
   */
  getParticleEmitters(options = {}) {
    options = this.constructor.mergeWithDefaults(options);

    const splashEnabled = options?.splash?.value ?? true;
    const splashIntensity = 1;

    const d = canvas.dimensions;
    const maxParticles = (d.width / d.size) * (d.height / d.size) * options.density.value;

    const rainConfig = foundry.utils.deepClone(this.constructor.RAIN_CONFIG);
    rainConfig.maxParticles = maxParticles;
    rainConfig.frequency = 1 / maxParticles;
    rainConfig.behaviors.push({
      type: "spawnShape",
      config: {
        type: "rect",
        data: {
          x: -0.05 * d.width,
          y: -0.1 * d.height,
          w: d.width,
          h: 0.8 * d.height,
        },
      },
    });
    this.applyOptionsToConfig(options, rainConfig);

    const emitters = [this.createEmitter(rainConfig)];

    if (splashEnabled && splashIntensity > 0) {
      const splashConfig = foundry.utils.deepClone(this.constructor.SPLASH_CONFIG);

      const splashMax = Math.max(1, splashIntensity * 0.5 * maxParticles);
      splashConfig.maxParticles = splashMax;
      splashConfig.frequency = 1 / splashMax;

      splashConfig.behaviors.push({
        type: "spawnShape",
        config: {
          type: "rect",
          data: {
            x: 0,
            y: 0.25 * d.height,
            w: d.width,
            h: 0.75 * d.height,
          },
        },
      });

      this.applyOptionsToConfig(options, splashConfig);
      emitters.push(this.createEmitter(splashConfig));
    }

    return emitters;
  }
}
