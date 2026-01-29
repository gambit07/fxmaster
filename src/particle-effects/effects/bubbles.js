import { FXMasterParticleEffect } from "./effect.js";
import { DefaultRectangleSpawnMixin } from "./mixins/default-rectangle-spawn.js";

/**
 * A full-screen particle effect which renders floating bubbles.
 */
export class BubblesParticleEffect extends DefaultRectangleSpawnMixin(FXMasterParticleEffect) {
  /** @override */
  static label = "FXMASTER.Particles.Effects.Bubbles";

  /** @override */
  static get icon() {
    return "modules/fxmaster/assets/particle-effects/icons/bubbles.webp";
  }

  /** @override */
  static get group() {
    return "ambient";
  }

  /** @override */
  static get parameters() {
    const p = super.parameters;
    return {
      belowTokens: p.belowTokens,
      tint: p.tint,
      topDown: { label: "FXMASTER.Params.TopDown", type: "checkbox", value: false },
      scale: p.scale,
      speed: p.speed,
      lifetime: p.lifetime,
      density: { ...p.density, min: 0.01, value: 0.15, max: 0.5, step: 0.01, decimals: 2 },
      alpha: p.alpha,
    };
  }

  /**
   * Configuration for the particle emitter for floating bubbles
   * @type {PIXI.particles.EmitterConfigV3}
   */
  static BUBBLES_CONFIG = {
    lifetime: { min: 8, max: 10 },
    behaviors: [
      {
        type: "alpha",
        config: {
          alpha: {
            list: [
              { value: 0, time: 0 },
              { value: 0.85, time: 0.05 },
              { value: 0.85, time: 0.85 },
              { value: 0, time: 1 },
            ],
          },
        },
      },
      {
        type: "moveSpeed",
        config: {
          speed: {
            list: [
              { time: 0, value: 20 },
              { time: 1, value: 60 },
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
              { value: 0.25, time: 0 },
              { value: 0.5, time: 1 },
            ],
          },
          minMult: 0.5,
        },
      },
      {
        type: "rotation",
        config: { accel: 0, minSpeed: 100, maxSpeed: 200, minStart: 0, maxStart: 365 },
      },
      {
        type: "textureSingle",
        config: { texture: "modules/fxmaster/assets/particle-effects/effects/bubbles/bubble.webp" },
      },
    ],
  };

  /** @override */
  static get defaultConfig() {
    return this.BUBBLES_CONFIG;
  }

  /** @override */
  getParticleEmitters(options = {}) {
    options = this.constructor.mergeWithDefaults(options);
    const topDown = !!options?.topDown?.value;

    if (!topDown) {
      this._fxmCanvasPanOwnerPosEnabled = false;
      return super.getParticleEmitters(options);
    }

    this._fxmCanvasPanOwnerPosEnabled = true;

    const d = CONFIG.fxmaster.getParticleDimensions(options);

    const { maxParticles } = this.constructor.computeMaxParticlesFromView(options, {
      minViewCells: this.constructor.MIN_VIEW_CELLS ?? 3000,
    });

    const sceneRadius = Math.sqrt(d.sceneWidth * d.sceneWidth + d.sceneHeight * d.sceneHeight) / 2;

    const config = foundry.utils.deepClone(this.constructor.BUBBLES_CONFIG);
    config.maxParticles = maxParticles;

    const lifetime = config.lifetime ?? 1;
    const lifetimeMin = typeof lifetime === "number" ? lifetime : lifetime.min ?? 1;
    config.frequency = lifetimeMin / maxParticles;

    config.behaviors = (config.behaviors ?? []).filter((b) => b.type !== "rotation" && b.type !== "rotationStatic");
    config.behaviors.push({ type: "rotationStatic", config: { min: 180, max: 180 } });

    this.applyOptionsToConfig(options, config);

    const moveSpeedBehavior = config.behaviors.find(({ type }) => type === "moveSpeed");
    const moveSpeedList = moveSpeedBehavior?.config?.speed?.list ?? [{ value: 20 }, { value: 60 }];
    const averageSpeed =
      moveSpeedList.reduce((acc, cur) => acc + (cur.value ?? 0), 0) / Math.max(1, moveSpeedList.length);

    const lifetimeMax = typeof config.lifetime === "number" ? config.lifetime : config.lifetime?.max ?? lifetimeMin;

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
