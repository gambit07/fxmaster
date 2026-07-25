import { FXMasterParticleEffect } from "./effect.js";
import { SnowstormProceduralSurface } from "./snowstorm-procedural-surface.js";
import { logger } from "../../logger.js";

/**
 * A full-screen particle effect which renders heavy snow fall.
 */
export class SnowstormParticleEffect extends FXMasterParticleEffect {
  /** @override */
  static label = "FXMASTER.Particles.Effects.Snowstorm";

  /**
   * Top-down snowstorm uses the same view-aware center coverage as top-down rain.
   */
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
   * Resolve the top-down center opening in scene pixels, matching top-down rain's
   * pan/zoom-aware deadzone coverage.
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

      const sceneMinPx = Math.max(
        1,
        Math.min(
          Number(d?.sceneWidth ?? d?.width ?? canvas?.dimensions?.sceneWidth ?? canvas?.dimensions?.width ?? 1) || 1,
          Number(d?.sceneHeight ?? d?.height ?? canvas?.dimensions?.sceneHeight ?? canvas?.dimensions?.height ?? 1) ||
            1,
        ),
      );
      const compactScene = 1 - this.constructor._smoothstep(3600, 7200, sceneMinPx);
      if (compactScene > 0.001) {
        const closeZoom = 1 - this.constructor._smoothstep(5.5, 15, visibleMinGrid);
        const farZoom = this.constructor._smoothstep(12, 34, visibleMinGrid);
        const farTrim = 1 - compactScene * farZoom * 0.64;
        const closeBoost = 1 + compactScene * closeZoom * 0.12;
        radiusGrid *= farTrim * closeBoost;

        if (closeZoom > 0.001) {
          const closeMaxFraction = 0.28 + 0.07 * (1 - closeZoom);
          const closeMaxGrid = Math.max(0.46, visibleMinGrid * closeMaxFraction);
          radiusGrid = Math.min(radiusGrid, closeMaxGrid);
        }

        const closeMinGrid = 0.34 + compactScene * closeZoom * 0.22;
        radiusGrid = Math.max(radiusGrid, closeMinGrid);
      }
    }

    return radiusGrid * grid;
  }

  /** @private */
  static _smoothstep(edge0, edge1, value) {
    const lo = Number(edge0);
    const hi = Number(edge1);
    const x = Number(value);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !Number.isFinite(x) || lo === hi) return x >= hi ? 1 : 0;
    const t = this._clampNumber((x - lo) / (hi - lo), 0, 1, 0);
    return t * t * (3 - 2 * t);
  }

  /** @private */
  static _clampNumber(value, min, max, fallback = min) {
    const number = Number(value);
    const safe = Number.isFinite(number) ? number : fallback;
    return Math.max(min, Math.min(max, safe));
  }

  /** @override */
  static get icon() {
    return "modules/fxmaster/assets/particle-effects/icons/snow-storm.webp";
  }

  /** @override */
  static get group() {
    return "weather";
  }

  static get densityScalar() {
    return 0.1;
  }

  /** @override */
  static get parameters() {
    const p = super.parameters;
    return {
      belowTokens: p.belowTokens,
      belowTiles: p.belowTiles,
      soundFxEnabled: p.soundFxEnabled,
      tint: p.tint,
      topDown: { label: "FXMASTER.Params.TopDown", type: "checkbox", value: false },
      rotationStrength: {
        label: "FXMASTER.Params.RotationStrength",
        type: "range",
        min: 0,
        value: 0.35,
        max: 1,
        step: 0.01,
        decimals: 2,
        showWhen: { topDown: true },
        tooltip: "FXMASTER.ParamTooltips.RotationStrength",
      },
      scale: { ...p.scale, value: 2.5 },
      direction: { ...p.direction, showWhen: { topDown: false } },
      synchronizedDirection: { ...this.synchronizedDirectionParameter, showWhen: { topDown: false } },
      speed: { ...p.speed, min: 0.1, max: 10, value: 8, step: 0.05, decimals: 2 },
      lifetime: p.lifetime,
      density: { ...p.density, min: 0, value: 0.72, max: 2.4, step: 0.01, decimals: 2 },
      alpha: p.alpha,
      backgroundEnabled: {
        label: "FXMASTER.Params.Background",
        type: "checkbox",
        value: false,
        tooltip: "FXMASTER.ParamTooltips.SnowstormBackground",
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
        tooltip: "FXMASTER.ParamTooltips.BackgroundMode",
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
        tooltip: "FXMASTER.ParamTooltips.SnowstormBackgroundDuration",
      },
      backgroundOpacity: {
        label: "FXMASTER.Params.BackgroundOpacity",
        type: "range",
        min: 0,
        value: 0.2,
        max: 1,
        step: 0.01,
        decimals: 2,
        showWhen: { backgroundEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.SnowstormBackgroundOpacity",
      },
      backgroundFillVariation: {
        label: "FXMASTER.Params.BackgroundFillVariation",
        type: "range",
        min: 0,
        value: 0.75,
        max: 1,
        step: 0.05,
        decimals: 2,
        showWhen: { backgroundEnabled: true, backgroundMode: "accumulate" },
        tooltip: "FXMASTER.ParamTooltips.BackgroundFillVariation",
      },
      backgroundDriftStrength: {
        label: "FXMASTER.Params.BackgroundDriftStrength",
        type: "range",
        min: 0,
        value: 0,
        max: 1,
        step: 0.05,
        decimals: 2,
        showWhen: { backgroundEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.BackgroundDriftStrength",
      },
      backgroundDriftScale: {
        label: "FXMASTER.Params.BackgroundDriftScale",
        type: "range",
        min: 0.05,
        value: 0.1,
        max: 12,
        step: 0.05,
        decimals: 2,
        showWhen: { backgroundEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.BackgroundDriftScale",
      },
      backgroundSweepEnabled: {
        label: "FXMASTER.Params.BackgroundSweep",
        type: "checkbox",
        value: true,
        showWhen: { backgroundEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.SnowstormBackgroundSweep",
      },
      backgroundSweepOpacity: {
        label: "FXMASTER.Params.BackgroundSweepOpacity",
        type: "range",
        min: 0,
        value: 0.4,
        max: 1,
        step: 0.01,
        decimals: 2,
        showWhen: { backgroundEnabled: true, backgroundSweepEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.SnowstormBackgroundSweepOpacity",
      },
      backgroundSweepScale: {
        label: "FXMASTER.Params.BackgroundSweepScale",
        type: "range",
        min: 0,
        value: 1,
        max: 1,
        step: 0.01,
        decimals: 2,
        showWhen: { backgroundEnabled: true, backgroundSweepEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.SnowstormBackgroundSweepScale",
      },
      backgroundSweepSpeed: {
        label: "FXMASTER.Params.BackgroundSweepSpeed",
        type: "range",
        min: 0,
        value: 0.8,
        max: 1,
        step: 0.01,
        decimals: 2,
        showWhen: { backgroundEnabled: true, backgroundSweepEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.SnowstormBackgroundSweepSpeed",
      },
      backgroundSweepStrength: {
        label: "FXMASTER.Params.BackgroundSweepStrength",
        type: "range",
        min: 0,
        value: 1,
        max: 1,
        step: 0.01,
        decimals: 2,
        showWhen: { backgroundEnabled: true, backgroundSweepEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.SnowstormBackgroundSweepStrength",
      },
      backgroundTrailsEnabled: {
        label: "FXMASTER.Params.BackgroundTrails",
        type: "checkbox",
        value: false,
        showWhen: { backgroundEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.BackgroundTrails",
      },
      backgroundTrailRefillEnabled: {
        label: "FXMASTER.Params.BackgroundTrailRefill",
        type: "checkbox",
        value: true,
        showWhen: { backgroundEnabled: true, backgroundTrailsEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.BackgroundTrailRefill",
      },
      backgroundTrailRefillDuration: {
        label: "FXMASTER.Params.BackgroundTrailRefillDuration",
        type: "range",
        min: 10,
        value: 90,
        max: 3600,
        step: 10,
        decimals: 0,
        labelOutput: "minutes",
        showWhen: { backgroundEnabled: true, backgroundTrailsEnabled: true, backgroundTrailRefillEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.BackgroundTrailRefillDuration",
      },
      backgroundTrailWidth: {
        label: "FXMASTER.Params.BackgroundTrailWidth",
        type: "range",
        min: 0,
        value: 0.5,
        max: 2,
        step: 0.05,
        decimals: 2,
        showWhen: { backgroundEnabled: true, backgroundTrailsEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.BackgroundTrailWidth",
      },
      backgroundTrailStrength: {
        label: "FXMASTER.Params.BackgroundTrailStrength",
        type: "range",
        min: 0,
        value: 0.25,
        max: 1,
        step: 0.01,
        decimals: 2,
        showWhen: { backgroundEnabled: true, backgroundTrailsEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.BackgroundTrailStrength",
      },
      backgroundInteractionElevationThreshold: {
        label: "FXMASTER.Params.BackgroundInteractionElevationThreshold",
        type: "number-infinity",
        min: 0,
        value: 5,
        max: "Infinity",
        step: 0.5,
        decimals: 1,
        showWhen: { backgroundEnabled: true, backgroundTrailsEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.BackgroundTrailElevationThreshold",
      },
    };
  }

  /** @override */
  static get backgroundSurface() {
    return { type: "snowstorm" };
  }

  static get usesRegionSurfaceEdgeFade() {
    return true;
  }

  static get alwaysSoftToggleFade() {
    return true;
  }

  /** @override */
  static get softOptionTransition() {
    return false;
  }

  /**
   * Configuration for the particle emitter for heavy snow fall
   * @type {PIXI.particles.EmitterConfigV3}
   */
  static SNOWSTORM_CONFIG = {
    lifetime: { min: 2.5, max: 6 },
    behaviors: [
      {
        type: "alphaStatic",
        config: { alpha: 1 },
      },
      {
        type: "movePath",
        config: {
          path: "sin(x / 150) * 25",
          speed: {
            list: [
              { value: 400, time: 0 },
              { value: 350, time: 1 },
            ],
          },
          minMult: 0.2,
        },
      },
      {
        type: "scale",
        config: {
          scale: {
            list: [
              { value: 0.2, time: 0 },
              { value: 0.08, time: 1 },
            ],
          },
          minMult: 0.8,
        },
      },
      {
        type: "rotation",
        config: { accel: 0, minSpeed: -60, maxSpeed: 60, minStart: 86, maxStart: 94 },
      },
      {
        type: "textureRandom",
        config: {
          textures: Array.fromRange(2).map(
            (n) => `modules/fxmaster/assets/particle-effects/effects/snowstorm/snow${n + 1}.webp`,
          ),
        },
      },
    ],
  };

  /** @override */
  static get defaultConfig() {
    return this.SNOWSTORM_CONFIG;
  }

  _destroyProceduralSnowstorm() {
    try {
      this._fxmSnowstormProceduralSurface?.destroy?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    this._fxmSnowstormProceduralSurface = null;
  }

  _installProceduralSnowstorm(options) {
    this._destroyProceduralSnowstorm();
    try {
      const surface = new SnowstormProceduralSurface({
        owner: this,
        options,
        dimensions: CONFIG.fxmaster.getParticleDimensions?.(options),
        renderer: CONFIG.fxmaster.getParticleRenderer?.(options),
        ticker: CONFIG.fxmaster.getParticleTicker?.(options),
      });
      this.addChildAt(surface.displayObject, 0);
      this._fxmSnowstormProceduralSurface = surface;
      return surface;
    } catch (err) {
      logger.debug("FXMaster:", err);
      return null;
    }
  }

  /** @override */
  getParticleEmitters(options = {}) {
    options = this.constructor.mergeWithDefaults(options);
    this._fxmCanvasPanOwnerPosEnabled = false;
    this._installProceduralSnowstorm(options);
    return [];
  }

  /** @override */
  play({ prewarm = false } = {}) {
    this._fxmSnowstormProceduralSurface?.start?.();
    super.play({ prewarm });
  }

  /** @override */
  async fadeOut(options = {}) {
    this._fxmSnowstormProceduralSurface?.start?.();
    return super.fadeOut(options);
  }

  /** @override */
  async fadeIn(options = {}) {
    this._fxmSnowstormProceduralSurface?.start?.();
    const payload = options && typeof options === "object" ? options : {};
    return super.fadeIn(payload);
  }

  /** @override */
  stop() {
    this._fxmSnowstormProceduralSurface?.stop?.();
    super.stop();
  }

  /** @override */
  destroy(options) {
    this._destroyProceduralSnowstorm();
    super.destroy(options);
  }
}
