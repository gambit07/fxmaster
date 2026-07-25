import { FXMasterParticleEffect } from "./effect.js";
import { RainProceduralSurface } from "./rain-procedural-surface.js";
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

  /** @returns {number} Top-down center opening factor. */
  static get topDownDeadzoneFactor() {
    return 0.12;
  }

  static get topDownDeadzoneMinGrid() {
    return 1.5;
  }

  static get topDownDeadzoneMaxGrid() {
    return 5.5;
  }

  /**
   * Resolve the top-down center opening in scene pixels.
   *
   * @param {object} d Particle dimension object from CONFIG.fxmaster.getParticleDimensions(...)
   * @param {{visibleMinGrid?:number}} [view]
   * @returns {number}
   */
  getTopDownDeadzoneRadius(d, view = {}) {
    const grid = Math.max(1, Number(d?.size ?? canvas?.dimensions?.size ?? 100) || 100);
    const baseGrid = super.getTopDownDeadzoneRadius(d) / grid;

    const gridDensity = this.constructor._clampNumber(Math.pow(grid / 100, 0.76), 0.4, 1.98, 1);
    const lowGridTrim = 0.58 + 0.42 * this.constructor._smoothstep(90, 150, grid);
    let radiusGrid = baseGrid * gridDensity * lowGridTrim;

    const visibleMinGrid = Number(view?.visibleMinGrid);
    if (Number.isFinite(visibleMinGrid) && visibleMinGrid > 0) {
      const gridNorm = this.constructor._smoothstep(96, 200, grid);
      const visibleSpanAdjust = this.constructor._clampNumber(Math.pow(visibleMinGrid / 18, 0.18), 0.78, 1.24, 1);
      const maxVisibleFraction = 0.12 + gridNorm * 0.435;
      const minVisibleFraction = 0.008 + gridNorm * 0.145;
      const maxVisibleGrid = this.constructor._clampNumber(visibleMinGrid * maxVisibleFraction, 0.4, 13.8, 5.5);
      const minVisibleGrid = this.constructor._clampNumber(visibleMinGrid * minVisibleFraction, 0.3, 6.8, 1.5);
      radiusGrid = this.constructor._clampNumber(
        radiusGrid * visibleSpanAdjust,
        minVisibleGrid,
        maxVisibleGrid,
        radiusGrid,
      );
    }

    return radiusGrid * grid;
  }

  /**
   * @param {number} edge0
   * @param {number} edge1
   * @param {number} value
   * @returns {number}
   * @private
   */
  static _smoothstep(edge0, edge1, value) {
    const lo = Number(edge0);
    const hi = Number(edge1);
    const x = Number(value);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !Number.isFinite(x) || lo === hi) return x >= hi ? 1 : 0;
    const t = this._clampNumber((x - lo) / (hi - lo), 0, 1, 0);
    return t * t * (3 - 2 * t);
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

  /**
   * Splash particles are still sprite-sheet animations. Keep their live count,
   * size, and playback speed in a narrower band than the procedural rain field
   * so dense rain on high-pixel-density scenes does not become oversized white
   * flashing.
   */
  static SPLASH_TUNING = {
    sideMinActive: 22,
    sideMaxActive: 235,
    topMinActive: 36,
    topMaxActive: 370,
    sideMaxSpawnRate: 760,
    topMaxSpawnRate: 1200,
    viewScaleMin: 0.85,
    viewScaleMax: 1.65,
    gridScaleExponent: 0.5,
    gridScaleMin: 0.65,
    gridScaleMax: 1.75,
    scaleFactorMin: 0.25,
    scaleFactorMax: 2.75,
    animationSpeedMin: 0.92,
    animationSpeedMax: 1.1,
    animationLifetimeMin: 0.455,
    animationLifetimeMax: 0.545,
  };

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
      splashDensity: {
        label: "FXMASTER.Params.SplashDensity",
        type: "range",
        min: 0.1,
        value: 0.255556,
        max: 1.5,
        step: 0.05,
        decimals: 2,
        showWhen: { splash: true },
        tooltip: "FXMASTER.ParamTooltips.SplashDensity",
      },
      splashScale: {
        label: "FXMASTER.Params.SplashScale",
        type: "range",
        min: 0.1,
        value: 0.261111,
        max: 1.55,
        step: 0.05,
        decimals: 2,
        showWhen: { splash: true },
        tooltip: "FXMASTER.ParamTooltips.SplashScale",
      },
      scale: { ...p.scale, value: 2.277778 },
      direction: { ...p.direction, showWhen: { topDown: false } },
      synchronizedDirection: { ...this.synchronizedDirectionParameter, showWhen: { topDown: false } },
      speed: { ...p.speed, value: 0.644444 },
      lifetime: { ...p.lifetime, min: 2, value: 2.5, max: 5, step: 0.1, decimals: 1 },
      density: { ...p.density, min: 0.02, value: 2.29697, max: 5.8, step: 0.01, decimals: 2 },
      alpha: p.alpha,
      backgroundEnabled: {
        label: "FXMASTER.Params.Background",
        type: "checkbox",
        value: false,
        tooltip: "FXMASTER.ParamTooltips.RainBackground",
      },
      backgroundMode: {
        label: "FXMASTER.Params.BackgroundMode",
        type: "select",
        value: "accumulate",
        options: {
          full: "FXMASTER.Params.BackgroundModeFull",
          accumulate: "FXMASTER.Params.BackgroundModeAccumulate",
        },
        showWhen: { backgroundEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.RainBackgroundMode",
      },
      backgroundDuration: {
        label: "FXMASTER.Params.BackgroundDuration",
        type: "range",
        min: 10,
        value: 180,
        max: 3600,
        step: 10,
        decimals: 0,
        labelOutput: "minutes",
        showWhen: { backgroundEnabled: true, backgroundMode: "accumulate" },
        tooltip: "FXMASTER.ParamTooltips.RainBackgroundDuration",
      },
      backgroundGroundMovementSpeed: {
        label: "FXMASTER.Params.BackgroundGroundMovementSpeed",
        type: "range",
        min: 0,
        value: 0.1,
        max: 2.5,
        step: 0.05,
        decimals: 2,
        showWhen: { backgroundEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.RainBackgroundGroundMovementSpeed",
      },
      backgroundCoverage: {
        label: "FXMASTER.Params.BackgroundCoverage",
        type: "range",
        min: 0.05,
        value: 0.65,
        max: 1,
        step: 0.01,
        decimals: 2,
        showWhen: { backgroundEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.RainBackgroundCoverage",
      },
      backgroundPatchSize: {
        label: "FXMASTER.Params.BackgroundPatchSize",
        type: "range",
        min: 0.35,
        value: 0.85,
        max: 5,
        step: 0.05,
        decimals: 2,
        showWhen: { backgroundEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.RainBackgroundPatchSize",
      },
      backgroundFillVariation: {
        label: "FXMASTER.Params.BackgroundFillVariation",
        type: "range",
        min: 0,
        value: 0.7,
        max: 1,
        step: 0.05,
        decimals: 2,
        showWhen: { backgroundEnabled: true, backgroundMode: "accumulate" },
        tooltip: "FXMASTER.ParamTooltips.RainBackgroundFillVariation",
      },
      backgroundOpacity: {
        label: "FXMASTER.Params.BackgroundWetnessOpacity",
        type: "range",
        min: 0,
        value: 0.28,
        max: 1,
        step: 0.01,
        decimals: 2,
        showWhen: { backgroundEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.RainBackgroundOpacity",
      },
      backgroundReflectionStrength: {
        label: "FXMASTER.Params.BackgroundRainReflectivity",
        type: "range",
        min: 0,
        value: 0.58,
        max: 1,
        step: 0.01,
        decimals: 2,
        showWhen: { backgroundEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.RainBackgroundReflectivity",
      },
      backgroundShimmerStrength: {
        label: "FXMASTER.Params.BackgroundRainShimmer",
        type: "range",
        min: 0,
        value: 0.42,
        max: 1,
        step: 0.01,
        decimals: 2,
        showWhen: { backgroundEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.RainBackgroundShimmer",
      },
      backgroundShimmerSpeed: {
        label: "FXMASTER.Params.BackgroundRainShimmerSpeed",
        type: "range",
        min: 0,
        value: 0.7,
        max: 5,
        step: 0.05,
        decimals: 2,
        showWhen: ({ get }) => get("backgroundEnabled") === true && Number(get("backgroundShimmerStrength") ?? 0) > 0,
        tooltip: "FXMASTER.ParamTooltips.RainBackgroundShimmerSpeed",
      },
      backgroundInteractionEnabled: {
        label: "FXMASTER.Params.BackgroundInteraction",
        type: "checkbox",
        value: false,
        showWhen: { backgroundEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.RainBackgroundInteraction",
      },
      backgroundInteractionRadius: {
        label: "FXMASTER.Params.BackgroundInteractionRadius",
        type: "range",
        min: 0,
        value: 0.5,
        max: 2,
        step: 0.05,
        decimals: 2,
        showWhen: { backgroundEnabled: true, backgroundInteractionEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.RainBackgroundInteractionRadius",
      },
      backgroundInteractionStrength: {
        label: "FXMASTER.Params.BackgroundInteractionStrength",
        type: "range",
        min: 0,
        value: 0.75,
        max: 1,
        step: 0.05,
        decimals: 2,
        showWhen: { backgroundEnabled: true, backgroundInteractionEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.RainBackgroundInteractionStrength",
      },
      backgroundInteractionLiftChance: {
        label: "FXMASTER.Params.BackgroundInteractionLiftChance",
        type: "range",
        min: 0,
        value: 0.35,
        max: 1,
        step: 0.05,
        decimals: 2,
        showWhen: { backgroundEnabled: true, backgroundInteractionEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.RainBackgroundInteractionLiftChance",
      },
      backgroundInteractionElevationThreshold: {
        label: "FXMASTER.Params.BackgroundInteractionElevationThreshold",
        type: "number-infinity",
        min: 0,
        value: 5,
        max: "Infinity",
        step: 0.5,
        decimals: 1,
        showWhen: { backgroundEnabled: true, backgroundInteractionEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.BackgroundInteractionElevationThreshold",
      },
      backgroundInteractionSettleTime: {
        label: "FXMASTER.Params.BackgroundInteractionSettleTime",
        type: "range",
        min: 0.1,
        value: 1.4,
        max: 5,
        step: 0.1,
        decimals: 1,
        showWhen: { backgroundEnabled: true, backgroundInteractionEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.RainBackgroundInteractionSettleTime",
      },
    };
  }

  /** @override */
  static get backgroundSurface() {
    return { type: "rain", profile: "wet-surface" };
  }

  static get usesRegionSurfaceEdgeFade() {
    return true;
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
      { type: "alphaStatic", config: { alpha: 1 } },
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

  /**
   * Clamp a finite number without relying on Foundry's Math.clamp polyfill.
   * @param {number} value
   * @param {number} min
   * @param {number} max
   * @param {number} fallback
   * @returns {number}
   * @private
   */
  static _clampNumber(value, min, max, fallback = min) {
    const number = Number(value);
    const safe = Number.isFinite(number) ? number : fallback;
    return Math.max(min, Math.min(max, safe));
  }

  /**
   * Convert the general Density control into a bounded splash population.
   * Falling rain is procedural, so splashes no longer need to scale like a full
   * particle weather field. Keeping this curve sublinear prevents large or
   * high-pixel-density views at density 5 from becoming fields of white flashes.
   *
   * @param {object} options
   * @param {number} viewCells
   * @param {boolean} topDown
   * @returns {number}
   * @private
   */
  _computeSplashParticleLimit(options, viewCells, topDown) {
    const tuning = this.constructor.SPLASH_TUNING;
    const rawDensity = Number(options?.density?.value ?? this.constructor.parameters?.density?.value ?? 0.5);
    const normalizedDensity = this.constructor._clampNumber(
      Math.log(1 + Math.max(0, rawDensity)) / Math.log(9),
      0,
      1,
      0.5,
    );
    const splashDensity = this.constructor._clampNumber(
      Number(options?.splashDensity?.value ?? this.constructor.parameters?.splashDensity?.value ?? 1),
      0.1,
      1.5,
      1,
    );
    const performanceScale = this.constructor._clampNumber(
      Number(this.constructor.getPerformanceDensityScale?.() ?? 1),
      0.25,
      1,
      1,
    );
    const viewScale = this.constructor._clampNumber(
      Math.sqrt(Math.max(1, Number(viewCells) || 1) / 3000),
      tuning.viewScaleMin,
      tuning.viewScaleMax,
      1,
    );
    const gridSize = Math.max(1, Number(canvas?.dimensions?.size ?? 100) || 100);
    const gridDensityScale = this.constructor._clampNumber(Math.pow(gridSize / 100, 0.16), 0.9, 1.24, 1);
    const curve = Math.pow(normalizedDensity * Math.sqrt(performanceScale), 1.08);
    const minimum = topDown ? tuning.topMinActive : tuning.sideMinActive;
    const maximum = topDown ? tuning.topMaxActive : tuning.sideMaxActive;
    const baseTarget = (minimum + (maximum - minimum) * curve) * viewScale * gridDensityScale;
    return Math.max(1, Math.round(baseTarget * splashDensity));
  }

  /**
   * Apply tint or the default rain color to splash sprites.
   *
   * @param {object} options
   * @param {PIXI.particles.EmitterConfigV3} config
   * @private
   */
  _applySplashColorToConfig(options, config) {
    const color = this._resolveTintOption(options) ?? "#badcf5";
    config.behaviors = config.behaviors
      .filter(({ type }) => type !== "color" && type !== "colorStatic")
      .concat({ type: "colorStatic", config: { color } });
  }

  /**
   * Apply splash-specific particle options without using the moving-particle lifetime mapper.
   * @param {object} options
   * @param {PIXI.particles.EmitterConfigV3} config
   * @private
   */
  _applyOptionsToSplashConfig(options, config) {
    this._fxmLastOptions = options;
    const tuning = this.constructor.SPLASH_TUNING;

    const scaleOption = this.constructor._clampNumber(options?.scale?.value, 0.1, 5, 1);
    const splashScaleOption = this.constructor._clampNumber(options?.splashScale?.value, 0.35, 1.55, 1);
    const gridSize = Math.max(1, Number(canvas?.dimensions?.size ?? 100) || 100);
    const gridScale = this.constructor._clampNumber(
      Math.pow(gridSize / 100, tuning.gridScaleExponent),
      tuning.gridScaleMin,
      tuning.gridScaleMax,
      1,
    );
    const scaleFactor = this.constructor._clampNumber(
      scaleOption * splashScaleOption * gridScale,
      tuning.scaleFactorMin,
      tuning.scaleFactorMax,
      1,
    );
    config.behaviors
      ?.filter((behavior) => behavior.type === "scaleStatic")
      .forEach(({ config }) => this._applyFactorToRandNumber(config, scaleFactor));

    this._applySplashColorToConfig(options, config);
    this._applyAlphaToConfig(options, config);
    this._applyDropShadowToConfig(options, config);

    const speedOption = this.constructor._clampNumber(options?.speed?.value, 0.1, 5, 1);
    const speedOffset =
      speedOption >= 1 ? Math.log(speedOption) / Math.log(5) : -Math.log(1 / speedOption) / Math.log(10);
    const animationSpeed = this.constructor._clampNumber(
      1 + speedOffset * 0.1,
      tuning.animationSpeedMin,
      tuning.animationSpeedMax,
      1,
    );
    const lifetime = this.constructor._clampNumber(
      0.5 / animationSpeed,
      tuning.animationLifetimeMin,
      tuning.animationLifetimeMax,
      0.5,
    );
    config.lifetime.min = lifetime * 0.96;
    config.lifetime.max = lifetime * 1.04;
  }

  /**
   * Configure a safe emission rate for animated splash sprites.
   * @param {PIXI.particles.EmitterConfigV3} config
   * @param {number} targetActive
   * @param {boolean} topDown
   * @private
   */
  _configureSplashEmission(config, targetActive, topDown) {
    const tuning = this.constructor.SPLASH_TUNING;
    const active = Math.max(1, Math.round(Number(targetActive) || 1));
    const lifetime = Math.max(0.05, ((config.lifetime?.min ?? 0.5) + (config.lifetime?.max ?? 0.5)) / 2);
    const maxSpawnRate = topDown ? tuning.topMaxSpawnRate : tuning.sideMaxSpawnRate;
    const spawnRate = Math.min(active / lifetime, maxSpawnRate);
    config.maxParticles = Math.max(active, Math.ceil(spawnRate * lifetime * 1.15));
    config.frequency = 1 / Math.max(1, spawnRate);
    config._fxmSplashTargetActive = active;
    config._fxmSplashSpawnRate = spawnRate;
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
    container.name = "fxmRainSplashEmitterContainer";
    container.sortableChildren = false;
    container.eventMode = "none";

    this.addChild(container);

    const emitter = new PIXI.particles.Emitter(container, config);
    emitter.autoUpdate = true;

    return emitter;
  }

  /**
   * Install the full-scene procedural rain pass. The renderer is a child of
   * this effect so it automatically inherits the same masks, stack placement,
   * opacity fades, Regions, and Levels routing as the former rain emitter.
   *
   * @param {object} options
   * @returns {RainProceduralSurface|null}
   * @private
   */
  _installProceduralRain(options) {
    try {
      this._fxmRainProceduralSurface?.destroy?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    this._fxmRainProceduralSurface = null;

    try {
      const surface = new RainProceduralSurface({
        owner: this,
        options,
        dimensions: CONFIG.fxmaster.getParticleDimensions?.(options),
        renderer: CONFIG.fxmaster.getParticleRenderer?.(options),
        ticker: CONFIG.fxmaster.getParticleTicker?.(options),
      });
      this.addChildAt(surface.displayObject, 0);
      this._fxmRainProceduralSurface = surface;
      return surface;
    } catch (err) {
      logger.debug("FXMaster:", err);
      return null;
    }
  }

  /**
   * Build the procedural rain surface and optional splash emitter. Falling
   * rain is no longer represented by individual particles; only the animated
   * impact splashes use a particle emitter.
   */
  getParticleEmitters(options = {}) {
    options = this.constructor.mergeWithDefaults(options);
    this._fxmLastOptions = options;
    this._installProceduralRain(options);

    const topDown = !!options?.topDown?.value;
    if (topDown) return this._getTopDownSplashEmitters(options);

    this._fxmCanvasPanOwnerPosEnabled = false;

    const splashEnabled = options?.splash?.value ?? true;
    if (!splashEnabled) return [];

    const d = CONFIG.fxmaster.getParticleDimensions(options);

    const { viewCells } = this.constructor.computeMaxParticlesFromView(options, {
      minViewCells: this.constructor.MIN_VIEW_CELLS ?? 3000,
    });

    const ctx = options?.__fxmParticleContext ?? this.__fxmParticleContext;
    const scopedContext = CONFIG.fxmaster?.isScopedParticleContext?.(ctx) ?? !!ctx?.dimensions;
    const splashConfig = this._createSplashConfig(false);
    const splashMax = this._computeSplashParticleLimit(options, viewCells, false);
    splashConfig.behaviors.push({
      type: "spawnShape",
      config: {
        type: "rect",
        data: {
          x: scopedContext ? d.sceneRect.x : 0,
          y: (scopedContext ? d.sceneRect.y : 0) + 0.25 * d.height,
          w: d.width,
          h: 0.75 * d.height,
        },
      },
    });

    this._applyOptionsToSplashConfig(options, splashConfig);
    this._configureSplashEmission(splashConfig, splashMax, false);
    return [this.createEmitter(splashConfig)];
  }

  /**
   * Build the optional top-down splash emitter. The radial falling-rain field
   * itself is rendered by RainProceduralSurface.
   *
   * @param {object} options
   * @returns {PIXI.particles.Emitter[]}
   * @private
   */
  _getTopDownSplashEmitters(options) {
    const splashEnabled = options?.splash?.value ?? true;
    this._fxmCanvasPanOwnerPosEnabled = splashEnabled;
    if (!splashEnabled) return [];

    const d = CONFIG.fxmaster.getParticleDimensions?.(options ?? this) ?? canvas.dimensions;

    const { viewCells } = this.constructor.computeMaxParticlesFromView(options, {
      minViewCells: this.constructor.MIN_VIEW_CELLS ?? 3000,
    });

    /** Ignore user-selected direction in top-down mode to preserve the expected fall orientation. */
    const optsNoDir = foundry.utils.deepClone(options);
    try {
      delete optsNoDir.direction;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    const ctx = options?.__fxmParticleContext ?? this.__fxmParticleContext;
    const scopedContext = CONFIG.fxmaster?.isScopedParticleContext?.(ctx) ?? !!ctx?.dimensions;
    const ownerX = scopedContext ? 0 : canvas.stage.pivot.x - d.sceneX - d.sceneWidth / 2;
    const ownerY = scopedContext ? 0 : canvas.stage.pivot.y - d.sceneY - d.sceneHeight / 2;

    const splashConfig = this._createSplashConfig(true);
    const splashMax = this._computeSplashParticleLimit(options, viewCells, true);
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

    this._applyOptionsToSplashConfig(optsNoDir, splashConfig);
    this._configureSplashEmission(splashConfig, splashMax, true);

    const splashEmitter = this.createEmitter(splashConfig);
    splashEmitter.updateOwnerPos(ownerX, ownerY);
    return [splashEmitter];
  }

  /**
   * Rain parameter edits replace the procedural field immediately. Rendering
   * both authored fields during the generic soft transition adds cost and can
   * produce an apparent camera fade without improving the visual transition.
   */
  static get softOptionTransition() {
    return false;
  }

  static get alwaysSoftToggleFade() {
    return true;
  }

  /** @override */
  play(options = {}) {
    this._fxmRainProceduralSurface?.start?.();
    const payload = options && typeof options === "object" ? options : {};
    super.play({ ...payload, prewarm: false });
  }

  /** @override */
  async fadeOut(options = {}) {
    this._fxmRainProceduralSurface?.start?.();
    return super.fadeOut(options);
  }

  /** @override */
  async fadeIn(options = {}) {
    this._fxmRainProceduralSurface?.start?.();
    const payload = options && typeof options === "object" ? options : {};
    return super.fadeIn(payload);
  }

  /** @override */
  stop() {
    this._fxmRainProceduralSurface?.stop?.();
    super.stop();
  }

  /** @override */
  destroy(options) {
    try {
      this._fxmRainProceduralSurface?.destroy?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    this._fxmRainProceduralSurface = null;
    super.destroy(options);
  }
}
