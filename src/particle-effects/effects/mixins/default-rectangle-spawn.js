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
      const d = canvas.dimensions;
      const maxParticles = (d.width / d.size) * (d.height / d.size) * options.density.value;
      const config = foundry.utils.deepClone(this.constructor.defaultConfig);
      config.maxParticles = maxParticles;
      config.frequency = config.lifetime.min / maxParticles;
      config.behaviors.push({
        type: "spawnShape",
        config: {
          type: "rect",
          data: { x: d.sceneRect.x, y: d.sceneRect.y, w: d.sceneRect.width, h: d.sceneRect.height },
        },
      });
      this.applyOptionsToConfig(options, config);

      return [this.createEmitter(config)];
    }
  };
}
