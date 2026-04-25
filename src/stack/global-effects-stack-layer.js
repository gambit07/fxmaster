import { BaseEffectsLayer } from "../common/base-effects-layer.js";
import { GlobalEffectsCompositor } from "./global-effects-compositor.js";
import { isEnabled } from "../settings.js";
import { logger } from "../logger.js";

/**
 * Visible post-scene layer that presents the composited FXMaster stack output.
 */
export class GlobalEffectsStackLayer extends BaseEffectsLayer {
  /**
   * Return the canvas layer configuration.
   *
   * @returns {object}
   */
  static get layerOptions() {
    return foundry.utils.mergeObject(super.layerOptions, { name: "fxstack" });
  }

  /**
   * Draw the compositor presentation layer.
   *
   * @returns {Promise<void>}
   */
  async _draw() {
    GlobalEffectsCompositor.instance.attachLayer(this);

    if (!this._ticker) {
      const priority = PIXI.UPDATE_PRIORITY?.LOW ?? -25;
      try {
        canvas.app.ticker.add(this._animate, this, priority);
      } catch {
        canvas.app.ticker.add(this._animate, this);
      }
      this._ticker = true;
    }

    if (isEnabled()) GlobalEffectsCompositor.instance.renderFrame();
  }

  /**
   * Tear down the compositor presentation layer.
   *
   * @returns {Promise<*>}
   */
  async _tearDown() {
    try {
      GlobalEffectsCompositor.instance.detachLayer(this);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    return super._tearDown();
  }

  /**
   * Advance the compositor output.
   *
   * @returns {void}
   */
  _animate() {
    super._animate();
    GlobalEffectsCompositor.instance.renderFrame();
  }
}
