import { FXMasterParticleEffect } from "./effect.js";

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

  /** @override */
  static get parameters() {
    const p = super.parameters;
    return {
      belowTokens: p.belowTokens,
      tint: p.tint,
      topDown: { label: "FXMASTER.Params.TopDown", type: "checkbox", value: false },
      scale: p.scale,
      direction: { ...p.direction, showWhen: { topDown: false } },
      speed: p.speed,
      lifetime: p.lifetime,
      density: p.density,
      alpha: p.alpha,
    };
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
              { time: 0, value: 0.9 },
              { time: 1, value: 0.5 },
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
      config.behaviors.push({
        type: "spawnShape",
        config: {
          type: "rect",
          data: { x: 0, y: -0.1 * d.height, w: d.width, h: d.height },
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
    } catch {}

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
    const ownerX = ctx ? 0 : canvas.stage.pivot.x - d.sceneX - d.sceneWidth / 2;
    const ownerY = ctx ? 0 : canvas.stage.pivot.y - d.sceneY - d.sceneHeight / 2;
    emitter.updateOwnerPos(ownerX, ownerY);

    return [emitter];
  }
}
