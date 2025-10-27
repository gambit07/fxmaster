import { FXMasterParticleEffect } from "./effect.js";

/**
 * A full-screen particle effect which renders drifting bubbles.
 */
export class CloudsParticleEffect extends FXMasterParticleEffect {
  /** @override */
  static label = "FXMASTER.Particles.Effects.Clouds";

  /** @override */
  static get icon() {
    return "modules/fxmaster/assets/particle-effects/icons/clouds.webp";
  }

  /** @override */
  static get group() {
    return "weather";
  }

  /** @override */
  static get parameters() {
    return foundry.utils.mergeObject(super.parameters, {
      density: { min: 0.001, value: 0.03, max: 0.2, step: 0.001, decimals: 3 },
      dropShadow: { label: "FXMASTER.Params.Shadow", type: "checkbox", value: false },
      shadowRotation: {
        label: "FXMASTER.Params.ShadowRotation",
        type: "range",
        min: 0,
        value: 315,
        max: 360,
        step: 1,
        decimals: 0,
      },
      shadowDistance: {
        label: "FXMASTER.Params.ShadowDistance",
        type: "range",
        min: 0,
        value: 70,
        max: 300,
        step: 1,
        decimals: 0,
      },
      shadowBlur: {
        label: "FXMASTER.Params.ShadowBlur",
        type: "range",
        min: 0,
        value: 2,
        max: 20,
        step: 0.5,
        decimals: 1,
      },
      shadowOpacity: {
        label: "FXMASTER.Params.ShadowOpacity",
        type: "range",
        min: 0,
        value: 1,
        max: 1,
        step: 0.05,
        decimals: 2,
      },
    });
  }

  /**
   * Configuration for the particle emitter for drifting clouds
   * @type {PIXI.particles.EmitterConfigV3}
   */
  static CLOUDS_CONFIG = {
    behaviors: [
      {
        type: "alpha",
        config: {
          alpha: {
            list: [
              { value: 0, time: 0 },
              { value: 0.5, time: 0.05 },
              { value: 0.5, time: 0.95 },
              { value: 0, time: 1 },
            ],
          },
        },
      },
      { type: "moveSpeedStatic", config: { min: 30, max: 100 } },
      { type: "scaleStatic", config: { min: 0.08, max: 0.8 } },
      { type: "rotationStatic", config: { min: 80, max: 100 } },
      {
        type: "textureRandom",
        config: {
          textures: Array.fromRange(4).map(
            (n) => `modules/fxmaster/assets/particle-effects/effects/clouds/cloud${n + 1}.webp`,
          ),
        },
      },
    ],
  };

  /** @override */
  static get defaultConfig() {
    return this.CLOUDS_CONFIG;
  }

  /** @override */
  getParticleEmitters(options = {}) {
    options = this.constructor.mergeWithDefaults(options);
    const d = canvas.dimensions;
    const maxParticles = (d.width / d.size) * (d.height / d.size) * options.density.value;

    const offsetFactor = 2 / 3;
    const config = foundry.utils.deepClone(this.constructor.CLOUDS_CONFIG);
    const speed = config.behaviors.find(({ type }) => type === "moveSpeedStatic")?.config;
    if (speed === undefined) {
      throw new Error("Expected CLOUDS_CONFIG to have a moveSpeedStatic behavior but it didn't.");
    }

    const diagonal = Math.sqrt(d.sceneRect.width * d.sceneRect.width + d.sceneRect.height * d.sceneRect.height);
    const averageSpeed = (speed.min + speed.max) / 2;
    const averageDiagonalTime = diagonal / averageSpeed;
    const minLifetime = averageDiagonalTime / offsetFactor / 2;
    const maxLifetime = averageDiagonalTime / offsetFactor;

    const angle = Math.toRadians(options.direction.value);
    const directionVector = {
      x: Math.cos(angle),
      y: Math.sin(angle),
    };

    config.maxParticles = maxParticles;
    config.frequency = (minLifetime + maxLifetime) / 2 / maxParticles;
    config.lifetime = { min: minLifetime, max: maxLifetime };
    config.behaviors.push({
      type: "spawnShape",
      config: {
        type: "rect",
        data: {
          x: d.sceneRect.x - directionVector.x * d.sceneRect.width * offsetFactor,
          y: d.sceneRect.y - directionVector.y * d.sceneRect.height * offsetFactor,
          w: d.sceneRect.width,
          h: d.sceneRect.height,
        },
      },
    });

    config._dropShadowEnabled = !!options.dropShadow?.value;
    config._dropshadowRotation = Number.isFinite(options.shadowRotation?.value) ? options.shadowRotation.value : 315;
    config._dropshadowDistance = Number.isFinite(options.shadowDistance?.value)
      ? options.shadowDistance.value
      : Math.hypot(50, 50);
    config._dropshadowBlur = Number.isFinite(options.shadowBlur?.value) ? options.shadowBlur.value : 2;
    config._dropshadowOpacity = Number.isFinite(options.shadowOpacity?.value) ? options.shadowOpacity.value : 1;

    this.applyOptionsToConfig(options, config);

    return [this.createEmitter(config)];
  }

  /**
   * Wrapper container + per-sprite init in a ticker.
   * @param {PIXI.particles.EmitterConfigV3 & {
   *   _dropShadowEnabled?: boolean,
   *   _dropshadowRotation?: number,
   *   _dropshadowDistance?: number,
   *   _dropshadowBlur?: number,
   *   _dropshadowOpacity?: number
   * }} config
   * @returns {PIXI.particles.Emitter}
   */
  createEmitter(config) {
    const wrapper = new PIXI.Container();
    this.addChild(wrapper);

    config.autoUpdate = true;
    config.emit = false;
    const emitter = new PIXI.particles.Emitter(wrapper, config);

    if (!config._dropShadowEnabled) return emitter;

    const DropShadowCtor = PIXI.filters.DropShadowFilter;

    const BASE_OFFSET = { x: 50, y: -50 };
    const baseDistance = Math.hypot(BASE_OFFSET.x, BASE_OFFSET.y) || 50;

    const angleDeg = Number.isFinite(config._dropshadowRotation) ? config._dropshadowRotation : 315;
    const angleRad = Math.toRadians(angleDeg);
    const distance = Number.isFinite(config._dropshadowDistance) ? config._dropshadowDistance : baseDistance;
    const blur = Number.isFinite(config._dropshadowBlur) ? config._dropshadowBlur : 1;
    const alpha = Number.isFinite(config._dropshadowOpacity) ? config._dropshadowOpacity : 0.5;

    const dir = { x: Math.cos(angleRad), y: Math.sin(angleRad) };

    const shadowOptions = {
      offset: { x: 0, y: 0 },
      blur: blur,
      alpha: alpha,
      color: 0x000000,
      quality: 20,
      shadowOnly: false,
      resolution: 1,
    };

    const tick = () => {
      const zoom = canvas?.stage?.scale?.x ?? 1;

      const offX = dir.x * distance * zoom;
      const offY = dir.y * distance * zoom;

      for (const sprite of wrapper.children) {
        if (!sprite || sprite.destroyed) continue;
        if (!(sprite instanceof PIXI.Sprite) && !(sprite instanceof PIXI.AnimatedSprite)) continue;

        let shadow = sprite.__fxmCloudShadowRef;
        if (!shadow) {
          shadow = new DropShadowCtor(shadowOptions);
          const existing = sprite.filters ?? null;
          sprite.filters = existing ? existing.concat([shadow]) : [shadow];
          sprite.__fxmCloudShadowRef = shadow;
        }

        try {
          if (shadow.offset) {
            shadow.offset.x = offX;
            shadow.offset.y = offY;
          }
          if ("blur" in shadow) shadow.blur = blur;
          if ("alpha" in shadow) shadow.alpha = alpha;
        } catch {
          /* no-op */
        }
      }
    };

    PIXI.Ticker.shared.add(tick);

    const origDestroy = emitter.destroy?.bind(emitter);
    emitter.destroy = (...args) => {
      PIXI.Ticker.shared.remove(tick);
      return origDestroy ? origDestroy(...args) : undefined;
    };

    return emitter;
  }
}
