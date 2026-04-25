import { FXMasterParticleEffect } from "./effect.js";
import { DefaultRectangleSpawnMixin } from "./mixins/default-rectangle-spawn.js";

/**
 * A full-screen particle effect which renders swirling fog.
 */
export class FogParticleEffect extends DefaultRectangleSpawnMixin(FXMasterParticleEffect) {
  /** @override */
  static label = "FXMASTER.Particles.Effects.Fog";

  /** @override */
  static get icon() {
    return "modules/fxmaster/assets/particle-effects/icons/fog.webp";
  }

  /** @override */
  static get group() {
    return "weather";
  }

  static get densityScalar() {
    return 0.3;
  }

  static MIN_VIEW_CELLS = 6000;

  /** @override */
  static get parameters() {
    const params = foundry.utils.mergeObject({}, super.parameters, { inplace: false });

    params.density = {
      ...params.density,
      min: 0.01,
      value: 0.08,
      max: 0.15,
      step: 0.01,
      decimals: 2,
    };

    delete params.direction;
    return params;
  }

  /**
   * Configuration for the particle emitter for swirling fog
   * @type {PIXI.particles.EmitterConfigV3}
   */
  static FOG_CONFIG = {
    lifetime: { min: 10, max: 25 },
    behaviors: [
      {
        type: "alpha",
        config: {
          alpha: {
            list: [
              { value: 0, time: 0 },
              { value: 0.1, time: 0.1 },
              { value: 0.3, time: 0.5 },
              { value: 0.1, time: 0.9 },
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
              { time: 0, value: 15 },
              { time: 1, value: 10 },
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
              { value: 1.5, time: 0 },
              { value: 1, time: 1 },
            ],
          },
          minMult: 0.5,
        },
      },
      {
        type: "rotation",
        config: { accel: 0, minSpeed: 0.15, maxSpeed: 0.35, minStart: 0, maxStart: 365 },
      },
      {
        type: "textureRandom",
        config: {
          textures: Array.fromRange(4).map(
            (n) => `modules/fxmaster/assets/particle-effects/effects/clouds/cloud${n + 1}.webp`,
          ),
        },
      },
      {
        type: "colorStatic",
        config: {
          color: "dddddd",
        },
      },
    ],
  };

  /**
   * Extra spawn padding in scene pixels for fog-style soft sprites.
   *
   * Fog uses large cloud textures that are clipped back to the scene bounds by the stack pass. Without overscan, the particle field can visibly thin out at scene edges while panning, which reads like the overlay drifting off the map even though the transform is correct.
   *
   * @param {object} d
   * @returns {number}
   */
  static getSceneSpawnPadding(d) {
    const grid = Math.max(1, Number(d?.size) || 100);
    const sceneW = Math.max(1, Number(d?.sceneRect?.width ?? d?.sceneWidth ?? d?.width) || 1);
    const sceneH = Math.max(1, Number(d?.sceneRect?.height ?? d?.sceneHeight ?? d?.height) || 1);
    return Math.max(grid * 6, Math.min(sceneW, sceneH) * 0.12);
  }

  /** @override */
  getParticleEmitters(options = {}) {
    options = this.constructor.mergeWithDefaults(options);

    const { maxParticles } = this.constructor.computeMaxParticlesFromView(options, {
      minViewCells: this.constructor.MIN_VIEW_CELLS ?? 3000,
    });

    const d = CONFIG.fxmaster.getParticleDimensions(options);
    const config = foundry.utils.deepClone(this.constructor.defaultConfig);

    const rect =
      d?.sceneRect ?? new PIXI.Rectangle(0, 0, d?.sceneWidth ?? d?.width ?? 1, d?.sceneHeight ?? d?.height ?? 1);
    const padding = this.constructor.getSceneSpawnPadding(d);
    const spawnX = (Number(rect.x) || 0) - padding;
    const spawnY = (Number(rect.y) || 0) - padding;
    const spawnW = Math.max(1, (Number(rect.width) || 1) + padding * 2);
    const spawnH = Math.max(1, (Number(rect.height) || 1) + padding * 2);

    const sceneArea = Math.max(1, (Number(rect.width) || 1) * (Number(rect.height) || 1));
    const spawnArea = Math.max(1, spawnW * spawnH);
    const areaRatio = spawnArea / sceneArea;

    config.maxParticles = Math.max(maxParticles, Math.round(maxParticles * areaRatio));

    const lifetime = config.lifetime ?? 1;
    const lifetimeMin = typeof lifetime === "number" ? lifetime : lifetime.min ?? 1;
    config.frequency = lifetimeMin / config.maxParticles;

    config.behaviors ??= [];
    config.behaviors.push({
      type: "spawnShape",
      config: {
        type: "rect",
        data: {
          x: spawnX,
          y: spawnY,
          w: spawnW,
          h: spawnH,
        },
      },
    });

    this.applyOptionsToConfig(options, config);

    return [this.createEmitter(config)];
  }

  /** @override */
  static get defaultConfig() {
    return this.FOG_CONFIG;
  }
}
