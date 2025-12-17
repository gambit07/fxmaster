/**
 * FXMaster: Base Effects Layer
 *
 * Abstract base class for Particle and Filter effects layers.
 * Provides:
 * - Shared {@link RTPool} management for render textures.
 * - A camera-tracking animation loop via {@link BaseEffectsLayer#_animate}.
 * - Common teardown logic for subclasses.
 *
 * @abstract
 * @extends {CONFIG.fxmaster.FullCanvasObjectMixinNS}
 */
import { RTPool, snappedStageMatrix } from "../utils.js";

export class BaseEffectsLayer extends CONFIG.fxmaster.FullCanvasObjectMixinNS(CONFIG.fxmaster.CanvasLayerNS) {
  constructor() {
    super();
    /**
     * Whether this layer has registered its animate callback with the PIXI ticker.
     * @type {boolean}
     * @protected
     */
    this._ticker = false;

    /**
     * Whether the layer is currently tearing down.
     * Used to short-circuit animation work during teardown.
     * @type {boolean}
     * @protected
     */
    this._tearingDown = false;

    /**
     * Last observed camera transform matrix components for change detection.
     * @type {{a:number,b:number,c:number,d:number,tx:number,ty:number}|null}
     * @protected
     */
    this._lastRegionsMatrix = null;

    /**
     * Render-texture pool shared by subclasses.
     * @type {RTPool}
     * @protected
     */
    this._rtPool = new RTPool();

    this.sortableChildren = true;
    this.eventMode = "none";
  }

  /**
   * Draw the layer contents.
   * Subclasses must implement this method.
   *
   * @abstract
   * @protected
   * @returns {Promise<void>}
   */
  async _draw() {
    throw new Error("BaseEffectsLayer subclasses must implement _draw()");
  }

  /**
   * Tear down the layer:
   * - Marks the instance as tearing down.
   * - Unregisters the animation ticker.
   * - Drains the render-texture pool.
   *
   * @protected
   * @returns {Promise<*>} The result of the parent {@link CanvasLayer#_tearDown} call.
   */
  async _tearDown() {
    this._tearingDown = true;

    if (this._ticker) {
      try {
        canvas.app.ticker.remove(this._animate, this);
      } catch {}
      this._ticker = false;
    }

    this._lastRegionsMatrix = null;
    this._drainRtPool();

    const res = await super._tearDown();
    this._tearingDown = false;
    return res;
  }

  /**
   * Shared animation loop that monitors camera movement.
   *
   * When the snapped stage matrix changes beyond a small epsilon, this will:
   * - Invoke {@link BaseEffectsLayer#_onCameraChange}.
   * - Cache the new matrix for subsequent comparisons.
   *
   * Subclasses overriding this method should call `super._animate()` to
   * preserve camera-change detection.
   *
   * @protected
   * @returns {void}
   */
  _animate() {
    if (this._tearingDown) return;

    const M = snappedStageMatrix();
    this._currentCameraMatrix = M;
    const L = this._lastRegionsMatrix;
    const eps = 1e-4;
    const changed =
      !L ||
      Math.abs(L.a - M.a) > eps ||
      Math.abs(L.b - M.b) > eps ||
      Math.abs(L.c - M.c) > eps ||
      Math.abs(L.d - M.d) > eps ||
      Math.abs(L.tx - M.tx) > eps ||
      Math.abs(L.ty - M.ty) > eps;

    if (changed) {
      this._onCameraChange();
      this._lastRegionsMatrix = { a: M.a, b: M.b, c: M.c, d: M.d, tx: M.tx, ty: M.ty };
    }
  }

  /**
   * Hook invoked when the camera (stage transform) changes.
   * Subclasses should override this to react to camera movement.
   *
   * @protected
   * @returns {void}
   */
  _onCameraChange() {}

  /**
   * Acquire a pooled {@link PIXI.RenderTexture} from the internal {@link RTPool}.
   *
   * @protected
   * @param {number} w - Render texture width in pixels.
   * @param {number} h - Render texture height in pixels.
   * @param {number} res - Resolution of the render texture.
   * @returns {PIXI.RenderTexture} The acquired render texture.
   */
  _acquireRT(w, h, res) {
    return this._rtPool.acquire(w, h, res);
  }

  /**
   * Release a {@link PIXI.RenderTexture} back to the internal {@link RTPool}.
   *
   * @protected
   * @param {PIXI.RenderTexture} rt - The render texture to release.
   * @returns {void}
   */
  _releaseRT(rt) {
    return this._rtPool.release(rt);
  }

  /**
   * Drain and destroy all render textures in the internal {@link RTPool}.
   *
   * @protected
   * @returns {void}
   */
  _drainRtPool() {
    return this._rtPool.drain();
  }
}
