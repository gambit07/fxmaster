/**
 * A mixin which extends {@link FXMasterParticleEffect} with default rectangle spawing behavior.
 * @param {typeof import("../effect.js").FXMasterParticleEffect} Base The base effect class which this mixin extends
 * @returns {import("../effect.js").FXMasterParticleEffect} The extended effect class
 */
export function DefaultRectangleSpawnMixin(Base) {
  return class extends Base {
    /** @override */
    getParticleEmitters(options = {}) {
      options = this.constructor.mergeWithDefaults(options);

      const { maxParticles } = this.constructor.computeMaxParticlesFromView(options, {
        minViewCells: this.constructor.MIN_VIEW_CELLS ?? 3000,
      });

      const d = CONFIG.fxmaster.getParticleDimensions(options);
      const config = foundry.utils.deepClone(this.constructor.defaultConfig);

      config.maxParticles = maxParticles;

      const lifetime = config.lifetime ?? 1;
      const lifetimeMin = typeof lifetime === "number" ? lifetime : lifetime.min ?? 1;
      config.frequency = lifetimeMin / maxParticles;

      config.behaviors ??= [];
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

      return [this.createEmitter(config)];
    }
  };
}
