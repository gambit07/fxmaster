/**
 * Adjust the color behavior of an emitter to use a stepped gradient instead of interpolation.
 * @param {PIXI.particles.Emitter} emitter        The emitter to adjust
 * @param {PIXI.particles.EmitterConfigV3} config The emitter config containing the original value list
 * @param {number} [steps=10]                     The number of steps to use
 * @returns {PIXI.particles.Emitter}
 */
export function withSteppedGradientColor(emitter, config, steps = 10) {
  const colorBehavior = emitter.getBehavior("color");

  if (colorBehavior) {
    emitter
      .getBehavior("color")
      .list.reset(
        PIXI.particles.ParticleUtils.createSteppedGradient(
          config.behaviors.find(({ type }) => type === "color").config.color.list,
          steps,
        ),
      );
  }

  return emitter;
}
