import { FXMasterParticleEffect } from "./effect.js";
import { logger } from "../../logger.js";

/**
 * Full-screen rain with optional splash particles (toggled via options.splash.value). Uses a standard PIXI.Container for the emitter parent.
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

  /**
   * Make rain a bit denser than the global default while still respecting performance mode scaling.
   */
  static get densityScalar() {
    return 0.14;
  }

  /** Rain splash spritesheet paths and grid metadata. */
  static SPLASH_SPRITESHEET = {
    side: "modules/fxmaster/assets/particle-effects/effects/rain/drop-side.webp",
    top: "modules/fxmaster/assets/particle-effects/effects/rain/drop-top.webp",
    frameWidth: 256,
    frameHeight: 256,
    columns: 5,
    rows: 5,
    frames: 25,
  };

  /** @type {Map<string, PIXI.Texture[]>|undefined} */
  static _splashTextureCache;

  /** @override */
  static get parameters() {
    const p = super.parameters;
    return {
      belowTokens: p.belowTokens,
      belowTiles: p.belowTiles,
      soundFxEnabled: p.soundFxEnabled,
      tint: p.tint,
      topDown: { label: "FXMASTER.Params.TopDown", type: "checkbox", value: false },
      splash: { label: "FXMASTER.Params.Splash", type: "checkbox", value: true },
      scale: p.scale,
      direction: { ...p.direction, showWhen: { topDown: false } },
      speed: p.speed,
      lifetime: { ...p.lifetime, min: 2, value: 2.5, max: 5, step: 0.1, decimals: 1 },
      density: p.density,
      alpha: p.alpha,
    };
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
      {
        type: "textureSingle",
        config: {
          texture: "modules/fxmaster/assets/particle-effects/effects/rain/rain.webp",
        },
      },
    ],
  };

  /**
   * Top-down rain config (legacy "rain-top" behavior).
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
   * Animated splash config for the optional second emitter.
   * @type {PIXI.particles.EmitterConfigV3}
   */
  static SPLASH_CONFIG = {
    lifetime: { min: 0.5, max: 0.5 },
    pos: { x: 0, y: 0 },
    behaviors: [
      { type: "moveSpeedStatic", config: { min: 0, max: 0 } },
      { type: "scaleStatic", config: { min: 0.135, max: 0.15 } },
      { type: "noRotation", config: {} },
      {
        type: "animatedSingle",
        config: {
          anim: {
            framerate: -1,
            loop: false,
            textures: [],
          },
        },
      },
    ],
  };

  /**
   * Build and cache splash frame textures for the selected view.
   * @param {boolean} topDown
   * @returns {PIXI.Texture[]}
   * @private
   */
  _getSplashTextures(topDown) {
    const mode = topDown ? "top" : "side";
    const cache = (this.constructor._splashTextureCache ??= new Map());
    const cached = cache.get(mode);
    if (cached) return cached;

    const metadata = this.constructor.SPLASH_SPRITESHEET;
    const sheetTexture = PIXI.Texture.from(metadata[mode]);
    const source = sheetTexture?.source ?? sheetTexture?.baseTexture ?? sheetTexture;
    const usesTextureSource = !!sheetTexture?.source;

    try {
      if (source && "scaleMode" in source) source.scaleMode = PIXI.SCALE_MODES?.LINEAR ?? "linear";
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    const logicalFrame = new PIXI.Rectangle(0, 0, metadata.frameWidth, metadata.frameHeight);
    const textures = [];
    for (let index = 0; index < metadata.frames; index++) {
      const frame = new PIXI.Rectangle(0, 0, 1, 1);
      const orig = logicalFrame.clone();
      const trim = logicalFrame.clone();
      const texture = usesTextureSource
        ? new PIXI.Texture({ source, frame, orig, trim })
        : new PIXI.Texture(source, frame, orig, trim);
      textures.push(texture);
    }

    const applyFrames = () => {
      const sheetWidth = Number(source?.width ?? sheetTexture?.width ?? 0);
      const sheetHeight = Number(source?.height ?? sheetTexture?.height ?? 0);
      const frameWidth = sheetWidth / metadata.columns;
      const frameHeight = sheetHeight / metadata.rows;
      const widthIsIntegral = Number.isFinite(frameWidth) && Math.abs(frameWidth - Math.round(frameWidth)) < 0.001;
      const heightIsIntegral = Number.isFinite(frameHeight) && Math.abs(frameHeight - Math.round(frameHeight)) < 0.001;
      const expectedRatio = metadata.frameWidth / metadata.frameHeight;
      const actualRatio = frameHeight ? frameWidth / frameHeight : 0;
      if (!widthIsIntegral || !heightIsIntegral || Math.abs(actualRatio - expectedRatio) > 0.001) return false;

      const resolvedFrameWidth = Math.round(frameWidth);
      const resolvedFrameHeight = Math.round(frameHeight);
      for (let index = 0; index < metadata.frames; index++) {
        const column = index % metadata.columns;
        const row = Math.floor(index / metadata.columns);
        const frame = new PIXI.Rectangle(
          column * resolvedFrameWidth,
          row * resolvedFrameHeight,
          resolvedFrameWidth,
          resolvedFrameHeight,
        );
        const texture = textures[index];
        texture.orig.copyFrom(logicalFrame);
        texture.trim.copyFrom(logicalFrame);
        if (usesTextureSource) {
          texture.frame.copyFrom(frame);
          texture.updateUvs();
        } else {
          texture.frame = frame;
        }
        texture.emit?.("update", texture);
      }
      return true;
    };

    const refreshFrames = () => {
      if (!applyFrames()) return;
      sheetTexture?.off?.("update", refreshFrames);
    };

    sheetTexture?.on?.("update", refreshFrames);
    refreshFrames();

    cache.set(mode, textures);
    return textures;
  }

  /**
   * Clone the splash config and assign its view-specific animation frames.
   * @param {boolean} topDown
   * @returns {PIXI.particles.EmitterConfigV3}
   * @private
   */
  _createSplashConfig(topDown) {
    const config = foundry.utils.deepClone(this.constructor.SPLASH_CONFIG);
    const animation = config.behaviors?.find(({ type }) => type === "animatedSingle");
    if (animation?.config?.anim) animation.config.anim.textures = this._getSplashTextures(topDown);
    return config;
  }

  /** @override */
  static get defaultConfig() {
    return this.RAIN_CONFIG;
  }

  /**
   * Create an emitter backed by a standard PIXI.Container.
   * @param {PIXI.particles.EmitterConfigV3} config
   * @returns {PIXI.particles.Emitter}
   */
  createEmitter(config) {
    const container = new PIXI.Container();
    container.sortableChildren = false;
    container.eventMode = "none";

    this.addChild(container);

    const emitter = new PIXI.particles.Emitter(container, config);
    emitter.autoUpdate = true;

    return emitter;
  }

  /**
   * Build one (rain) or two (rain + splash) emitters depending on options.splash.value. Particle counts are derived from view size (in grid cells), user density, and Foundry's Performance Mode via FXMasterParticleEffect helpers.
   */
  getParticleEmitters(options = {}) {
    options = this.constructor.mergeWithDefaults(options);

    const topDown = !!options?.topDown?.value;
    if (topDown) return this._getTopDownEmitters(options);

    this._fxmCanvasPanOwnerPosEnabled = false;

    const splashEnabled = options?.splash?.value ?? true;
    const splashIntensity = 1;

    const d = CONFIG.fxmaster.getParticleDimensions(options);

    const { viewCells, density, maxParticles } = this.constructor.computeMaxParticlesFromView(options, {
      minViewCells: this.constructor.MIN_VIEW_CELLS ?? 3000,
    });

    const rainConfig = foundry.utils.deepClone(this.constructor.RAIN_CONFIG);
    rainConfig.maxParticles = maxParticles;

    rainConfig.frequency = 1 / maxParticles;

    const ctx = options?.__fxmParticleContext ?? this.__fxmParticleContext;
    const spawnX = (ctx ? d.sceneRect.x : 0) - 0.05 * d.width;
    const spawnY = (ctx ? d.sceneRect.y : 0) - 0.1 * d.height;

    rainConfig.behaviors.push({
      type: "spawnShape",
      config: {
        type: "rect",
        data: {
          x: spawnX,
          y: spawnY,
          w: d.width,
          h: 0.8 * d.height,
        },
      },
    });

    this.applyOptionsToConfig(options, rainConfig);
    const emitters = [this.createEmitter(rainConfig)];

    if (splashEnabled && splashIntensity > 0) {
      const splashConfig = this._createSplashConfig(false);

      const splashBase = viewCells * density * splashIntensity * 0.5;
      const splashMax = Math.max(1, Math.round(Math.min(splashBase, maxParticles)));

      splashConfig.maxParticles = splashMax;
      splashConfig.frequency = 1 / splashMax;

      splashConfig.behaviors.push({
        type: "spawnShape",
        config: {
          type: "rect",
          data: {
            x: ctx ? d.sceneRect.x : 0,
            y: (ctx ? d.sceneRect.y : 0) + 0.25 * d.height,
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

  /**
   * Build top-down rain (and optional splash) emitters.
   * @private
   */
  _getTopDownEmitters(options) {
    this._fxmCanvasPanOwnerPosEnabled = true;

    const d = CONFIG.fxmaster.getParticleDimensions?.(options ?? this) ?? canvas.dimensions;

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

    /** Ignore user-selected direction in top-down mode to preserve the expected fall orientation. */
    const optsNoDir = foundry.utils.deepClone(options);
    try {
      delete optsNoDir.direction;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    this.applyOptionsToConfig(optsNoDir, config);

    const moveSpeedBehavior = config.behaviors.find(({ type }) => type === "moveSpeed");
    const moveSpeedList = moveSpeedBehavior?.config?.speed?.list ?? [{ value: 1600 }, { value: 2000 }];
    const averageSpeed =
      moveSpeedList.reduce((acc, cur) => acc + (cur.value ?? 0), 0) / Math.max(1, moveSpeedList.length);

    const lifetimeMax = typeof config.lifetime === "number" ? config.lifetime : config.lifetime?.max ?? lifetimeMin;

    config.behaviors.push({
      type: "spawnShape",
      config: {
        type: "torus",
        data: {
          x: d.sceneRect.x + d.sceneWidth / 2,
          y: d.sceneRect.y + d.sceneHeight / 2,
          radius: averageSpeed * lifetimeMax + sceneRadius * 2,
          innerRadius: averageSpeed * lifetimeMax,
          affectRotation: true,
        },
      },
    });

    const rainEmitter = this.createEmitter(config);

    const ctx = options?.__fxmParticleContext ?? this.__fxmParticleContext;
    const ownerX = ctx ? 0 : canvas.stage.pivot.x - d.sceneX - d.sceneWidth / 2;
    const ownerY = ctx ? 0 : canvas.stage.pivot.y - d.sceneY - d.sceneHeight / 2;
    rainEmitter.updateOwnerPos(ownerX, ownerY);

    const emitters = [rainEmitter];

    const splashEnabled = options?.splash?.value ?? true;
    if (splashEnabled) {
      const splashConfig = this._createSplashConfig(true);

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
            x: d.sceneRect.x + d.sceneWidth / 2 - (d.width ?? d.sceneWidth) / 2,
            y: d.sceneRect.y + d.sceneHeight / 2 - (d.height ?? d.sceneHeight) / 2,
            w: d.width ?? d.sceneWidth,
            h: d.height ?? d.sceneHeight,
          },
        },
      });

      this.applyOptionsToConfig(optsNoDir, splashConfig);

      const splashEmitter = this.createEmitter(splashConfig);
      splashEmitter.updateOwnerPos(ownerX, ownerY);
      emitters.push(splashEmitter);
    }

    return emitters;
  }
}
