import { FXMasterParticleEffect } from "./effect.js";

/**
 * A full-screen weather effect which renders rain drops from top down.
 */
export class RainTopParticleEffect extends FXMasterParticleEffect {
  /**
   * The id of the canvasPan hook registered by this effect.
   * @type {number|undefined}
   * @private
   */
  _canvasPanHookId;

  /** @override */
  static label = "FXMASTER.Particles.Effects.RainTop";

  /** @override */
  static get icon() {
    return "modules/fxmaster/assets/particle-effects/icons/rain.webp";
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
        density: { min: 0.01, value: 0.3, max: 1, step: 0.01, decimals: 2 },
        lifetime: { min: 2, value: 2.5, max: 5, step: 0.1, decimals: 1 },
        "-=direction": null,
        splash: { label: "FXMASTER.Params.Splash", type: "checkbox", value: true },
      },
      { performDeletions: true },
    );
  }

  /**
   * Configuration for the particle emitter for raindrops from top down.
   * @type {PIXI.particles.EmitterConfigV3}
   */
  static RAIN_TOP_CONFIG = {
    lifetime: { min: 0.6, max: 0.7 },
    behaviors: [
      {
        type: "alpha",
        config: {
          alpha: {
            list: [
              { value: 0, time: 0 },
              { value: 0.6, time: 0.8 },
              { value: 0.23, time: 1 },
            ],
          },
        },
      },
      {
        type: "scale",
        config: {
          scale: {
            list: [
              { value: 3, time: 0 },
              { value: 0.4, time: 1 },
            ],
          },
          minMult: 0.7,
        },
      },
      { type: "rotationStatic", config: { min: 180, max: 180 } },
      {
        type: "textureSingle",
        config: {
          texture: "modules/fxmaster/assets/particle-effects/effects/rain/rain.webp",
        },
      },
    ],
  };

  /**
   * Splash config for top-down rain
   * @type {PIXI.particles.EmitterConfigV3}
   */
  static SPLASH_TOP_CONFIG = {
    lifetime: { min: 0.5, max: 0.5 },
    behaviors: [
      { type: "moveSpeedStatic", config: { min: 0, max: 0 } },
      { type: "scaleStatic", config: { min: 0.48, max: 0.6 } },
      { type: "rotationStatic", config: { min: -90, max: -90 } },
      { type: "noRotation", config: {} },
      {
        type: "textureSingle",
        config: {
          texture: "modules/fxmaster/assets/particle-effects/effects/rain/drop.webp",
        },
      },
    ],
  };

  /** @override */
  static get defaultConfig() {
    return this.RAIN_TOP_CONFIG;
  }

  /** @override */
  getParticleEmitters(options = {}) {
    options = this.constructor.mergeWithDefaults(options);

    const d = canvas.dimensions;

    const { maxParticles, viewCells, density } = this.constructor.computeMaxParticlesFromView(options, {
      minViewCells: this.constructor.MIN_VIEW_CELLS ?? 3000,
    });

    const sceneRadius = Math.sqrt(d.sceneWidth * d.sceneWidth + d.sceneHeight * d.sceneHeight) / 2;

    const config = foundry.utils.deepClone(this.constructor.RAIN_TOP_CONFIG);
    config.maxParticles = maxParticles;

    const lifetime = config.lifetime ?? 1;
    const lifetimeMin = typeof lifetime === "number" ? lifetime : lifetime.min ?? lifetime.max ?? 1;
    config.frequency = lifetimeMin / maxParticles;

    config.behaviors.push({
      type: "moveSpeed",
      config: {
        speed: {
          list: [
            { time: 0, value: 1600 },
            { time: 1, value: 2000 },
          ],
        },
        minMult: 0.8,
      },
    });

    this.applyOptionsToConfig(options, config);

    const moveSpeedBehavior = config.behaviors.find(({ type }) => type === "moveSpeed");
    const moveSpeedList = moveSpeedBehavior?.config?.speed?.list ?? [{ value: 1600 }, { value: 2000 }];
    const averageSpeed =
      moveSpeedList.reduce((acc, cur) => acc + (cur.value ?? 0), 0) / Math.max(1, moveSpeedList.length);

    config.behaviors.push({
      type: "spawnShape",
      config: {
        type: "torus",
        data: {
          x: d.sceneRect.x + d.sceneWidth / 2,
          y: d.sceneRect.y + d.sceneHeight / 2,
          radius: averageSpeed * (config.lifetime?.max ?? lifetimeMin) + sceneRadius * 2,
          innerRadius: averageSpeed * (config.lifetime?.max ?? lifetimeMin),
          affectRotation: true,
        },
      },
    });

    const rainEmitter = this.createEmitter(config);

    const ownerX = canvas.stage.pivot.x - d.sceneX - d.sceneWidth / 2;
    const ownerY = canvas.stage.pivot.y - d.sceneY - d.sceneHeight / 2;
    rainEmitter.updateOwnerPos(ownerX, ownerY);

    const emitters = [rainEmitter];

    const splashEnabled = options?.splash?.value ?? true;
    if (splashEnabled) {
      const splashConfig = foundry.utils.deepClone(this.constructor.SPLASH_TOP_CONFIG);

      const splashBase = viewCells * density * 0.4;
      const splashMax = Math.max(1, Math.round(Math.min(splashBase, maxParticles)));
      splashConfig.maxParticles = splashMax;

      const splashLifetime = splashConfig.lifetime?.min ?? 0.5;
      splashConfig.frequency = splashLifetime / splashMax;

      splashConfig.behaviors.push({
        type: "spawnShape",
        config: {
          type: "rect",
          data: {
            x: d.sceneRect.x + d.sceneWidth / 2 - d.width / 2,
            y: d.sceneRect.y + d.sceneHeight / 2 - d.height / 2,
            w: d.width,
            h: d.height,
          },
        },
      });

      this.applyOptionsToConfig(options, splashConfig);

      const splashEmitter = this.createEmitter(splashConfig);
      splashEmitter.updateOwnerPos(ownerX, ownerY);
      emitters.push(splashEmitter);
    }

    return emitters;
  }

  /** @override */
  play() {
    this._unregisterCanvasPanHook();
    this._canvasPanHookId = Hooks.on("canvasPan", (_canvas, position) => {
      const d = canvas.dimensions;
      for (let e of this.emitters) {
        e.updateOwnerPos(position.x - d.sceneX - d.sceneWidth / 2, position.y - d.sceneY - d.sceneHeight / 2);
      }
    });
    super.play();
  }

  /** @override */
  stop() {
    this._unregisterCanvasPanHook();
    super.stop();
  }

  /**
   * Unregister the canvasPan hook used by this effect.
   * @private
   */
  _unregisterCanvasPanHook() {
    if (this._canvasPanHookId !== undefined) {
      Hooks.off("canvasPan", this._canvasPanHookId);
      this._canvasPanHookId = undefined;
    }
  }
}
