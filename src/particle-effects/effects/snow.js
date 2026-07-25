import { FXMasterParticleEffect } from "./effect.js";
import { logger } from "../../logger.js";

/**
 * A full-screen weather effect which renders drifting snowflakes.
 */
export class SnowParticleEffect extends FXMasterParticleEffect {
  /** @override */
  static label = "FXMASTER.Particles.Effects.Snow";

  /** @override */
  static get icon() {
    return "modules/fxmaster/assets/particle-effects/icons/snow.webp";
  }

  /** @override */
  static get group() {
    return "weather";
  }

  static get densityScalar() {
    return 0.05;
  }

  /** Prewarm snowflakes behind alpha 0 so soft toggles have a visible alpha fade instead of waiting for new flakes to populate. */
  static get softFadePrewarm() {
    return true;
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
      scale: p.scale,
      direction: { ...p.direction, showWhen: { topDown: false } },
      synchronizedDirection: { ...this.synchronizedDirectionParameter, showWhen: { topDown: false } },
      speed: { ...p.speed, value: 0.3 },
      lifetime: p.lifetime,
      density: { ...p.density, value: 0.4 },
      alpha: p.alpha,
      backgroundEnabled: {
        label: "FXMASTER.Params.Background",
        type: "checkbox",
        value: false,
        tooltip: "FXMASTER.ParamTooltips.Background",
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
        tooltip: "FXMASTER.ParamTooltips.BackgroundDuration",
      },
      backgroundOpacity: {
        label: "FXMASTER.Params.BackgroundOpacity",
        type: "range",
        min: 0,
        value: 0.7,
        max: 1,
        step: 0.01,
        decimals: 2,
        showWhen: { backgroundEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.BackgroundOpacity",
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
        value: 0.5,
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
        value: 0.8,
        max: 12,
        step: 0.05,
        decimals: 2,
        showWhen: { backgroundEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.BackgroundDriftScale",
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
    return { type: "snow" };
  }

  /**
   * Configuration for the particle emitter for snow
   * @type {PIXI.particles.EmitterConfigV3}
   */
  static SNOW_CONFIG = {
    lifetime: { min: 4, max: 4 },
    behaviors: [
      {
        type: "alpha",
        config: {
          alpha: {
            list: [
              { time: 0, value: 0 },
              { time: 0.08, value: 0.9 },
              { time: 0.62, value: 0.85 },
              { time: 0.82, value: 0.45 },
              { time: 1, value: 0 },
            ],
          },
        },
      },
      {
        type: "moveSpeed",
        config: {
          speed: {
            list: [
              { time: 0, value: 190 },
              { time: 1, value: 210 },
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
              { time: 0, value: 0.2 },
              { time: 1, value: 0.4 },
            ],
          },
          minMult: 0.5,
        },
      },
      {
        type: "rotation",
        config: { accel: 0, minSpeed: 0, maxSpeed: 200, minStart: 50, maxStart: 75 },
      },
      {
        type: "textureSingle",
        config: {
          texture: "modules/fxmaster/assets/particle-effects/effects/snow/snow.webp",
        },
      },
    ],
  };

  /** @override */
  static get defaultConfig() {
    return this.SNOW_CONFIG;
  }

  /** @override */
  getParticleEmitters(options = {}) {
    options = this.constructor.mergeWithDefaults(options);

    const topDown = !!options?.topDown?.value;

    const d = CONFIG.fxmaster.getParticleDimensions(options);

    const { maxParticles } = this.constructor.computeMaxParticlesFromView(options, {
      minViewCells: this.constructor.MIN_VIEW_CELLS ?? 10000,
    });

    const config = foundry.utils.deepClone(this.constructor.SNOW_CONFIG);
    config.maxParticles = maxParticles;

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

      const ctx = options?.__fxmParticleContext ?? this.__fxmParticleContext;
      const scopedContext = CONFIG.fxmaster?.isScopedParticleContext?.(ctx) ?? !!ctx?.dimensions;
      const spawnX = scopedContext ? d.sceneRect.x : 0;
      const spawnY = (scopedContext ? d.sceneRect.y : 0) - 0.1 * d.height;

      config.behaviors.push({
        type: "spawnShape",
        config: {
          type: "rect",
          data: { x: spawnX, y: spawnY, w: d.width, h: d.height },
        },
      });

      this.applyOptionsToConfig(options, config);
      return [this.createEmitter(config)];
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

    const emitter = this.createEmitter(config);

    const ctx = options?.__fxmParticleContext ?? this.__fxmParticleContext;
    const scopedContext = CONFIG.fxmaster?.isScopedParticleContext?.(ctx) ?? !!ctx?.dimensions;
    const ownerX = scopedContext ? 0 : canvas.stage.pivot.x - d.sceneX - d.sceneWidth / 2;
    const ownerY = scopedContext ? 0 : canvas.stage.pivot.y - d.sceneY - d.sceneHeight / 2;
    emitter.updateOwnerPos(ownerX, ownerY);

    return [emitter];
  }
}
