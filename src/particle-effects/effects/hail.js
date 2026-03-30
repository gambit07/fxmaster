import { FXMasterParticleEffect } from "./effect.js";
import { withSteppedGradientColor } from "./helpers/with-stepped-gradient-color.js";
import { logger } from "../../logger.js";

/**
 * A full-screen weather effect which renders falling hailstones.
 *
 * Notes:
 * - Uses a 12-frame spritesheet and selects a random frame per particle.
 * - Adds a subtle screen blend + stepped color gradient to read as slightly reflective.
 */
export class HailParticleEffect extends FXMasterParticleEffect {
  /** @override */
  static label = "FXMASTER.Particles.Effects.Hail";

  /** @override */
  static get icon() {
    return "modules/fxmaster/assets/particle-effects/icons/hail.webp";
  }

  /** @override */
  static get group() {
    return "weather";
  }

  static get topDownDeadzoneFactor() {
    return 0.035;
  }

  static get topDownDeadzoneMinGrid() {
    return 0.25;
  }

  static get topDownDeadzoneMaxGrid() {
    return 2.0;
  }

  static get densityScalar() {
    return 0.08;
  }

  /** @override */
  static get parameters() {
    const p = super.parameters;
    return {
      belowTokens: p.belowTokens,
      soundFxEnabled: p.soundFxEnabled,
      tint: p.tint,
      topDown: { label: "FXMASTER.Params.TopDown", type: "checkbox", value: false },
      scale: p.scale,
      direction: { ...p.direction, showWhen: { topDown: false } },
      speed: { ...p.speed, min: 0.1, value: 1, max: 10, step: 0.05, decimals: 2 },
      lifetime: p.lifetime,
      density: { ...p.density, min: 0.05, value: 0.6, max: 2, step: 0.05, decimals: 2 },
      alpha: p.alpha,
    };
  }

  /* ----------------------------------------------------------------------- */
  /* Texture / Spritesheet                                                    */
  /* ----------------------------------------------------------------------- */

  static get SPRITESHEET_URL() {
    return "modules/fxmaster/assets/particle-effects/effects/hail/hail.webp";
  }

  static _textureCache;

  /**
   * Build and cache textures for the 12-frame 4x3 grid spritesheet.
   * @returns {PIXI.Texture[]}
   */
  get _textures() {
    if (!this.constructor._textureCache) {
      const sheetTexture = PIXI.Texture.from(this.constructor.SPRITESHEET_URL);
      const base = sheetTexture?.baseTexture ?? sheetTexture;

      try {
        if (base && "scaleMode" in base) base.scaleMode = PIXI.SCALE_MODES.LINEAR;
      } catch (err) {
        logger.debug("FXMaster:", err);
      }

      const TILE = 512;
      const COLS = 4;
      const COUNT = 12;

      const textures = [];
      for (let i = 0; i < COUNT; i++) {
        const col = i % COLS;
        const row = Math.floor(i / COLS);
        const frame = new PIXI.Rectangle(col * TILE, row * TILE, TILE, TILE);
        textures.push(new PIXI.Texture(base, frame));
      }

      this.constructor._textureCache = textures;
    }
    return this.constructor._textureCache;
  }

  /* ----------------------------------------------------------------------- */
  /* Emitter Config                                                           */
  /* ----------------------------------------------------------------------- */

  /**
   * Configuration for the particle emitter for hail
   * @type {PIXI.particles.EmitterConfigV3}
   */
  static HAIL_CONFIG = {
    lifetime: { min: 0.65, max: 0.8 },
    behaviors: [
      {
        type: "alpha",
        config: {
          alpha: {
            list: [
              { time: 0, value: 0.95 },
              { time: 1, value: 0.8 },
            ],
          },
        },
      },
      {
        type: "moveSpeed",
        config: {
          speed: {
            list: [
              // Accelerate over lifetime to give some gravity in side-view mode.
              { time: 0, value: 600 },
              { time: 0.4, value: 1200 },
              { time: 1, value: 1800 },
            ],
          },
          minMult: 0.85,
        },
      },
      {
        type: "scale",
        config: {
          scale: {
            list: [
              { time: 0, value: 0.075 },
              { time: 1, value: 0.14 },
            ],
          },
          minMult: 0.65,
        },
      },
      {
        type: "rotationStatic",
        config: { min: 90, max: 90 },
      },
      {
        type: "textureRandom",
        config: {
          textures: [],
        },
      },
      {
        type: "color",
        config: {
          color: {
            list: [
              { value: "e7fbff", time: 0 },
              { value: "ffffff", time: 0.35 },
              { value: "dff6ff", time: 0.7 },
              { value: "ffffff", time: 1 },
            ],
          },
        },
      },
      {
        type: "blendMode",
        config: {
          blendMode: "screen",
        },
      },
    ],
  };

  /** @override */
  static get defaultConfig() {
    return this.HAIL_CONFIG;
  }

  /** @override */
  getParticleEmitters(options = {}) {
    options = this.constructor.mergeWithDefaults(options);

    const topDown = !!options?.topDown?.value;

    const d = CONFIG.fxmaster.getParticleDimensions(options);

    const { maxParticles } = this.constructor.computeMaxParticlesFromView(options, {
      minViewCells: this.constructor.MIN_VIEW_CELLS ?? 12000,
    });

    const config = foundry.utils.deepClone(this.constructor.HAIL_CONFIG);
    config.maxParticles = maxParticles;

    const texBehavior = config.behaviors?.find?.((b) => b.type === "textureRandom");
    if (texBehavior?.config) texBehavior.config.textures = this._textures;

    const lifetime = config.lifetime ?? 1;
    let avgLifetime;
    if (typeof lifetime === "number") {
      avgLifetime = lifetime;
    } else {
      const min = lifetime.min ?? lifetime.max ?? 1;
      const max = lifetime.max ?? lifetime.min ?? min;
      avgLifetime = (min + max) / 2;
    }
    config.frequency = avgLifetime / maxParticles;

    config.behaviors ??= [];

    if (!topDown) {
      this._fxmCanvasPanOwnerPosEnabled = false;

      config.behaviors.push({
        type: "spawnShape",
        config: {
          type: "rect",
          data: { x: 0, y: -0.1 * d.height, w: d.width, h: d.height },
        },
      });

      this.applyOptionsToConfig(options, config);
      const emitter = withSteppedGradientColor(this.createEmitter(config), config, 8);
      return [emitter];
    }

    this._fxmCanvasPanOwnerPosEnabled = true;

    const sceneRadius = Math.sqrt(d.sceneWidth * d.sceneWidth + d.sceneHeight * d.sceneHeight) / 2;

    config.behaviors = config.behaviors.filter((b) => b.type !== "rotation" && b.type !== "rotationStatic");
    config.behaviors.push({ type: "rotationStatic", config: { min: 180, max: 180 } });

    const optsNoDir = foundry.utils.deepClone(options);
    try {
      delete optsNoDir.direction;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    this.applyOptionsToConfig(optsNoDir, config);

    const moveSpeedBehavior = config.behaviors.find(({ type }) => type === "moveSpeed");
    const moveSpeedList = moveSpeedBehavior?.config?.speed?.list ?? [];
    const averageSpeed =
      moveSpeedList.reduce((acc, cur) => acc + (cur.value ?? 0), 0) / Math.max(1, moveSpeedList.length);

    const lifetimeMax = typeof config.lifetime === "number" ? config.lifetime : config.lifetime?.max ?? avgLifetime;

    const holeRadius = this.getTopDownDeadzoneRadius(d);

    const travel = averageSpeed * lifetimeMax;
    const innerRadius = travel + holeRadius;
    const outerRadius = innerRadius + sceneRadius * 2;

    config.behaviors.push({
      type: "spawnShape",
      config: {
        type: "torus",
        data: {
          x: d.sceneRect.x + d.sceneWidth / 2,
          y: d.sceneRect.y + d.sceneHeight / 2,
          radius: outerRadius,
          innerRadius,
          affectRotation: true,
        },
      },
    });

    const emitter = withSteppedGradientColor(this.createEmitter(config), config, 8);

    const ctx = options?.__fxmParticleContext ?? this.__fxmParticleContext;
    const ownerX = ctx ? 0 : canvas.stage.pivot.x - d.sceneX - d.sceneWidth / 2;
    const ownerY = ctx ? 0 : canvas.stage.pivot.y - d.sceneY - d.sceneHeight / 2;
    emitter.updateOwnerPos(ownerX, ownerY);

    return [emitter];
  }
}
