import { packageId } from "../../../constants.js";
import { FXMasterFilterEffectMixin } from "./filter";

/**
 * @typedef {Object} AnimationOptions
 * @property {number} [duration=4000] The duration of the animation
 */

/**
 * A mixin which extends {@link PIXI.Filter} with some common behavior and fading.
 * @param {PIXI.Filter} Base The base filter class which this mixin extends
 * @returns The extended filter class
 */
export function FadingFilterMixin(Base) {
  return class extends FXMasterFilterEffectMixin(Base) {
    /**
     * The currently running animation, if any.
     * @type {Promise<boolean> | undefined}
     */
    currentAnimation;

    /** Has this filter already been initialized? */
    initialized = false;

    /**
     * Apply options to this filter effect as an animation.
     * @param {object} [options] The options to animate
     * @param {AnimationOptions} [animationOptions={}] Additional options to adjust the animation behavior
     */
    async animateOptions(options = this.options, { duration = 4_000 } = {}) {
      const name = `${packageId}.${this.constructor.name}.${this.id}`;
      if (this.currentAnimation !== undefined) {
        CONFIG.fxmaster.CanvasAnimationNS.terminateAnimation(name);
        await this.currentAnimation;
      }
      const data = { name, duration };

      const [toAnimate, toSet] = Object.entries(options)
        .partition(([key]) => !!this.constructor.parameters[key]?.skipInitialAnimation && !this.initialized)
        .map(Object.fromEntries);

      this.applyOptions(toSet);

      const anim = Object.entries(toAnimate).map(([key, value]) => ({
        parent: this.optionContext,
        attribute: key,
        to: value,
      }));
      this.currentAnimation = CONFIG.fxmaster.CanvasAnimationNS.animate(anim, data).finally(
        () => (this.currentAnimation = undefined),
      );
      return this.currentAnimation;
    }

    /** @override */
    play({ skipFading = false, ...otherOptions } = {}) {
      if (skipFading) {
        super.play({ skipFading, ...otherOptions });
      } else {
        this.enabled = true;
        this.animateOptions();
      }
      this.initialized = true;
    }

    /** @override */
    async stop({ skipFading = false, ...otherOptions } = {}) {
      if (skipFading) {
        return super.stop({ skipFading, ...otherOptions });
      } else {
        const completed = await this.animateOptions(this.constructor.neutral);
        if (completed) {
          this.enabled = false;
        }
        return completed;
      }
    }
  };
}
