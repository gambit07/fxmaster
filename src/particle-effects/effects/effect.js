import { roundToDecimals } from "../../utils.js";

/**
 * An abstract base class for defining particle-based effects
 * @param {PIXI.Container} parent     The parent container within which the effect is rendered
 * @param {object} [options]          Options passed to the getParticleEmitters method which can be used to customize
 *                                    values of the emitter configuration.
 * @abstract
 */
export class FXMasterParticleEffect extends CONFIG.fxmaster.ParticleEffectNS {
  /**
   * A human-readable label for the particle effect. This can be a localization string.
   * @type {string}
   * @override
   */
  static label = "FXMASTER.ParticleEffect";

  /**
   * The weather effect group this effect belongs to.
   * @type {string}
   */
  static get group() {
    return "other";
  }

  /** @type {string} */
  static get icon() {
    return "modules/fxmaster/assets/particle-effects/icons/snow.webp";
  }

  static get parameters() {
    return {
      scale: {
        label: "FXMASTER.Scale",
        type: "range",
        min: 0.1,
        value: 1,
        max: 5,
        step: 0.1,
        decimals: 1,
      },
      direction: {
        label: "FXMASTER.Direction",
        type: "range",
        min: 0,
        value: this.defaultDirection,
        max: 360,
        step: 5,
        decimals: 0,
      },
      speed: {
        label: "FXMASTER.Speed",
        type: "range",
        min: 0.1,
        value: 1,
        max: 5,
        step: 0.1,
        decimals: 1,
      },
      lifetime: {
        label: "FXMASTER.Lifetime",
        type: "range",
        min: 0.1,
        value: 1,
        max: 5,
        step: 0.1,
        decimals: 1,
      },
      density: {
        label: "FXMASTER.Density",
        type: "range",
        min: 0.1,
        value: 0.5,
        max: 5,
        step: 0.1,
        decimals: 1,
      },
      alpha: {
        label: "FXMASTER.Opacity",
        type: "range",
        min: 0,
        value: 1,
        max: 1,
        step: 0.1,
        decimals: 1,
      },
      tint: {
        label: "FXMASTER.Tint",
        type: "color",
        value: {
          value: "#FFFFFF",
          apply: false,
        },
      },
    };
  }

  /**
   * Merge the given options with the default parameters.
   */
  static mergeWithDefaults(options) {
    return foundry.utils.mergeObject(this.parameters, options, { insertKeys: false, inplace: false });
  }

  /**
   * Return the default config for this effect.
   * @abstract
   * @returns {PIXI.particles.EmitterConfigV3}
   */
  static get defaultConfig() {
    throw new Error("Subclasses of FXMasterParticleEffect must implement defaultConfig");
  }

  static get defaultDirection() {
    const step = 5;

    const rotationBehavior = this.defaultConfig.behaviors.find((b) => b.type === "rotation");
    if (rotationBehavior !== undefined) {
      const avg = (rotationBehavior.config.minStart + rotationBehavior.config.maxStart) / 2;
      return Math.round(avg / step) * step; // ← force valid
    }

    const rotationStatic = this.defaultConfig.behaviors.find((b) => b.type === "rotationStatic");
    if (rotationStatic !== undefined) {
      const avg = (rotationStatic.config.min + rotationStatic.config.max) / 2;
      return Math.round(avg / step) * step;
    }

    return undefined;
  }

  static get default() {
    return Object.fromEntries(
      Object.entries(this.parameters).map(([parameterName, parameterConfig]) => [parameterName, parameterConfig.value]),
    );
  }

  applyOptionsToConfig(options, config) {
    this._applyScaleToConfig(options, config);
    this._applySpeedToConfig(options, config);
    this._applyDirectionToConfig(options, config);
    this._applyLifetimeToConfig(options, config);
    this._applyTintToConfig(options, config);
    this._applyAlphaToConfig(options, config);
  }

  /** @protected */
  _applyFactorToValueList(valueList, factor) {
    valueList.list = valueList.list.map((valueStep) => ({
      ...valueStep,
      value: valueStep.value * factor,
    }));
  }

  /** @protected */
  _applyFactorToRandNumber(randNumber, factor) {
    randNumber.min = randNumber.min * factor;
    randNumber.max = randNumber.max * factor;
  }

  /** @protected */
  _applyScaleToConfig(options, config) {
    const factor = (options.scale?.value ?? 1) * (canvas.dimensions.size / 100);

    config.behaviors
      .filter((behavior) => behavior.type === "scale")
      .forEach(({ config }) => this._applyFactorToValueList(config.scale, factor));

    config.behaviors
      .filter((behavior) => behavior.type === "scaleStatic")
      .forEach(({ config }) => this._applyFactorToRandNumber(config, factor));
  }

  /** @protected */
  _applySpeedToConfig(options, config) {
    const factor = (options.speed?.value ?? 1) * (canvas.dimensions.size / 100);

    config.behaviors
      .filter((behavior) => ["moveSpeed", "movePath"].includes(behavior.type))
      .forEach(({ config }) => this._applyFactorToValueList(config.speed, factor));

    config.behaviors
      .filter((behavior) => behavior.type === "moveSpeedStatic")
      .forEach(({ config }) => this._applyFactorToRandNumber(config, factor));

    this._applyFactorToRandNumber(config.lifetime, 1 / factor);
    config.frequency /= factor;
  }

  /** @protected */
  _applyDirectionToConfig(options, config) {
    const direction = options.direction?.value;
    if (direction !== undefined) {
      config.behaviors
        .filter((behavior) => behavior.type === "rotation")
        .forEach(({ config }) => {
          const range = config.maxStart - config.minStart;
          config.minStart = direction - range / 2;
          config.maxStart = direction + range / 2;
        });

      config.behaviors
        .filter((behavior) => behavior.type === "rotationStatic")
        .forEach(({ config }) => {
          const range = config.max - config.min;
          config.min = direction - range / 2;
          config.max = direction + range / 2;
        });
    }
  }

  /** @protected */
  _applyLifetimeToConfig(options, config) {
    const factor = options.lifetime?.value ?? 1;
    this._applyFactorToRandNumber(config.lifetime, factor);
    config.frequency *= factor;
  }

  /** @protected */
  _applyTintToConfig(options, config) {
    if (options.tint?.value.apply) {
      const value = options.tint.value.value;
      config.behaviors = config.behaviors
        .filter(({ type }) => type !== "color" && type !== "colorStatic")
        .concat({
          type: "colorStatic",
          config: {
            color: value,
          },
        });
    }
  }

  /** @protected */
  _applyAlphaToConfig(options, config) {
    const factor = options.alpha?.value ?? 1;

    config.behaviors
      .filter((behavior) => behavior.type === "alpha")
      .forEach(({ config }) => this._applyFactorToValueList(config.alpha, factor));

    config.behaviors
      .filter((behavior) => behavior.type === "alphaStatic")
      .forEach(({ config }) => {
        config.alpha *= factor;
      });
  }

  /** @override */
  play({ prewarm = false } = {}) {
    if (prewarm) {
      this.emitters.forEach((emitter) => {
        emitter.autoUpdate = false;
        emitter.emit = true;
        emitter.update(emitter.maxLifetime);
        emitter.autoUpdate = true;
      });
    }
    super.play();
  }

  /**
   * Fade this effect out, playing it once and then stopping it.
   * @param {{timeout?: number}} [options]         Additional options to configure the fade out
   * @param {number}             [options.timeout] If given, the effect will be stopped after the given number in ms,
   *                                               regardless of if it has finished playing or not.
   * @returns {Promise<void>}                      A promise that resolves as soon as this effect has finished fading out
   */
  async fadeOut({ timeout } = {}) {
    const emitterPromises = this.emitters.map(
      (emitter) =>
        new Promise((resolve) => {
          emitter.emitterLifetime = 0.1;
          emitter.playOnceAndDestroy(() => {
            resolve();
          });
        }),
    );
    const promises = [Promise.all(emitterPromises)];
    if (timeout !== undefined) {
      promises.push(new Promise((resolve) => setTimeout(resolve, timeout)).then(this.destroy.bind(this)));
    }

    await Promise.race(promises);
    this.stop();
  }

  static convertOptionsToV2(options, scene) {
    return Object.fromEntries(
      Object.entries(options).map(([optionKey, optionValue]) => {
        switch (optionKey) {
          case "scale": {
            return [optionKey, this._convertScaleToV2(optionValue, scene)];
          }
          case "speed": {
            return [optionKey, this._convertSpeedToV2(optionValue, scene)];
          }
          case "density": {
            return [optionKey, this._convertDensityToV2(optionValue, scene)];
          }
          default: {
            return [optionKey, optionValue];
          }
        }
      }),
    );
  }

  /** @protected */
  static _convertScaleToV2(scale, scene) {
    const decimals = this.parameters.scale?.decimals ?? 1;
    return roundToDecimals(scale * (100 / scene.dimensions.size), decimals);
  }

  /** @protected */
  static _convertSpeedToV2(speed, scene) {
    const speeds = this.defaultConfig.behaviors
      .filter(({ type }) => type === "moveSpeed")
      .flatMap(({ config }) => config.speed.list.map((valueStep) => valueStep.value));
    const maximumSpeed = Math.max(...speeds);

    const decimals = this.parameters.speed?.decimals ?? 1;
    return roundToDecimals((speed / maximumSpeed) * (100 / scene.dimensions.size), decimals);
  }

  /** @protected */
  static _convertDensityToV2(density, scene) {
    const d = scene.dimensions;
    const gridUnits = (d.width / d.size) * (d.height / d.size);

    const decimals = this.parameters.density?.decimals ?? 1;
    return roundToDecimals(density / gridUnits, decimals);
  }
}
