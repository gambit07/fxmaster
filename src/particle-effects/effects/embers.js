import { FXMasterParticleEffect } from "./effect.js";
import { withSteppedGradientColor } from "./helpers/with-stepped-gradient-color.js";

/**
 * A full-screen particle effect which renders floating embers.
 */
export class EmbersParticleEffect extends FXMasterParticleEffect {
  /** @override */
  static label = "FXMASTER.Particles.Effects.Embers";

  /** @override */
  static get icon() {
    return "modules/fxmaster/assets/particle-effects/icons/embers.webp";
  }

  /** @override */
  static get group() {
    return "ambient";
  }

  static get densityScalar() {
    return 0.2;
  }

  static MIN_VIEW_CELLS = 8000;

  /** @override */
  static get parameters() {
    const p = super.parameters;
    return {
      belowTokens: p.belowTokens,
      tint: { ...p.tint, value: { ...p.tint.value, value: "#f77300" } },
      topDown: { label: "FXMASTER.Params.TopDown", type: "checkbox", value: false },
      scale: p.scale,
      speed: p.speed,
      lifetime: p.lifetime,
      density: { ...p.density, min: 0.05, value: 0.7, max: 1.4, step: 0.05, decimals: 2 },
      alpha: p.alpha,
    };
  }

  /**
   * Configuration for the particle emitter for floating embers
   * @type {PIXI.particles.EmitterConfigV3}
   */
  static EMBERS_CONFIG = {
    layerLevel: "aboveDarkness",
    blendMode: PIXI.BLEND_MODES.ADD,
    lifetime: { min: 4, max: 6 },
    behaviors: [
      {
        type: "alpha",
        config: {
          alpha: {
            list: [
              { value: 0, time: 0 },
              { value: 0.9, time: 0.3 },
              { value: 0.9, time: 0.95 },
              { value: 0, time: 1 },
            ],
          },
        },
      },
      {
        type: "moveSpeedStatic",
        config: { min: 24, max: 40 },
      },
      {
        type: "scale",
        config: {
          scale: {
            list: [
              { value: 0.15, time: 0 },
              { value: 0.01, time: 1 },
            ],
          },
          minMult: 0.85,
        },
      },
      {
        type: "rotation",
        config: { accel: 0, minSpeed: 100, maxSpeed: 200, minStart: 0, maxStart: 365 },
      },
      {
        type: "textureSingle",
        config: { texture: "modules/fxmaster/assets/particle-effects/effects/embers/ember.webp" },
      },
      {
        type: "color",
        config: {
          color: {
            list: [
              { value: "f77300", time: 0 },
              { value: "f72100", time: 1 },
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
    return this.EMBERS_CONFIG;
  }

  /** @override */
  getParticleEmitters(options = {}) {
    options = this.constructor.mergeWithDefaults(options);
    const topDown = !!options?.topDown?.value;

    const d = CONFIG.fxmaster.getParticleDimensions(options);

    const { maxParticles } = this.constructor.computeMaxParticlesFromView(options, {
      minViewCells: this.constructor.MIN_VIEW_CELLS ?? 3000,
    });

    const config = foundry.utils.deepClone(this.constructor.EMBERS_CONFIG);
    config.maxParticles = maxParticles;

    const lifetime = config.lifetime ?? 1;
    const lifetimeMin = typeof lifetime === "number" ? lifetime : lifetime.min ?? lifetime.max ?? 1;
    config.frequency = lifetimeMin / maxParticles;

    config.behaviors ??= [];

    if (!topDown) {
      this._fxmCanvasPanOwnerPosEnabled = false;
      config.behaviors.push({
        type: "spawnShape",
        config: {
          type: "rect",
          data: {
            x: d.sceneRect.x,
            y: d.sceneRect.y,
            w: d.sceneRect.width,
            h: d.sceneRect.height,
          },
        },
      });

      this.applyOptionsToConfig(options, config);
      const emitter = withSteppedGradientColor(this.createEmitter(config), config);
      return [emitter];
    }

    this._fxmCanvasPanOwnerPosEnabled = true;

    const sceneRadius = Math.sqrt(d.sceneWidth * d.sceneWidth + d.sceneHeight * d.sceneHeight) / 2;

    config.behaviors = config.behaviors.filter((b) => b.type !== "rotation" && b.type !== "rotationStatic");
    config.behaviors.push({ type: "rotationStatic", config: { min: 180, max: 180 } });

    this.applyOptionsToConfig(options, config);

    const ms = config.behaviors.find(({ type }) => type === "moveSpeedStatic")?.config;
    const avgSpeed = ms ? ((ms.min ?? 0) + (ms.max ?? 0)) / 2 : 0;
    const lifetimeMax = typeof config.lifetime === "number" ? config.lifetime : config.lifetime?.max ?? lifetimeMin;

    const holeRadius = this.getTopDownDeadzoneRadius(d);

    const travel = avgSpeed * lifetimeMax;
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

    const emitter = withSteppedGradientColor(this.createEmitter(config), config);

    const ctx = options?.__fxmParticleContext ?? this.__fxmParticleContext;
    const ownerX = ctx ? 0 : canvas.stage.pivot.x - d.sceneX - d.sceneWidth / 2;
    const ownerY = ctx ? 0 : canvas.stage.pivot.y - d.sceneY - d.sceneHeight / 2;
    emitter.updateOwnerPos(ownerX, ownerY);

    return [emitter];
  }
}
