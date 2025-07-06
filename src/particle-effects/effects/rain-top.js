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
  static label = "FXMASTER.ParticleEffectRainTop";

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
        "-=direction": null,
      },
      { performDeletions: true },
    );
  }

  /**
   * Configuration for the particle emitter for raindrops from top down
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
      {
        type: "rotationStatic",
        config: { min: 180, max: 180 },
      },
      {
        type: "textureSingle",
        config: { texture: "ui/particles/rain.png" },
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
    const maxParticles = (d.width / d.size) * (d.height / d.size) * options.density.value;
    const sceneRadius = Math.sqrt(d.sceneWidth * d.sceneWidth + d.sceneHeight * d.sceneHeight) / 2;
    const config = foundry.utils.deepClone(this.constructor.RAIN_TOP_CONFIG);
    config.maxParticles = maxParticles;
    config.frequency = config.lifetime.min / maxParticles;
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
    const moveSpeedList = config.behaviors.find(({ type }) => type === "moveSpeed").config.speed.list;
    const averageSpeed = moveSpeedList.reduce((acc, cur) => acc + cur.value, 0) / moveSpeedList.length;
    config.behaviors.push({
      type: "spawnShape",
      config: {
        type: "torus",
        data: {
          x: d.sceneRect.x + d.sceneWidth / 2,
          y: d.sceneRect.y + d.sceneHeight / 2,
          radius: averageSpeed * config.lifetime.max + sceneRadius * 2,
          innerRadius: averageSpeed * config.lifetime.max,
          affectRotation: true,
        },
      },
    });

    const emitter = this.createEmitter(config);
    emitter.updateOwnerPos(
      canvas.stage.pivot.x - d.sceneX - d.sceneWidth / 2,
      canvas.stage.pivot.y - d.sceneY - d.sceneHeight / 2,
    );
    return [emitter];
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
