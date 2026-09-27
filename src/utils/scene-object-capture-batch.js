import { logger } from "../logger.js";

/** Capture compatible live objects together using their current world transforms and blend state. */
export class SceneObjectCaptureBatch {
  constructor() {
    this.container = new PIXI.Container();
    this.container._render = this._renderObjects.bind(this);
    this.objects = null;
    this.failed = false;
  }

  /**
   * Submit an ordered capture or return null when individual rendering is required.
   * @param {PIXI.Renderer} renderer
   * @param {PIXI.RenderTexture} target
   * @param {PIXI.DisplayObject[]} objects
   * @param {{forceAlpha?:boolean,surfaceForObject:Function}} options
   * @returns {boolean|null}
   */
  render(renderer, target, objects, { forceAlpha = false, surfaceForObject }) {
    if (this.objects) return null;
    if (this.failed) return null;
    if (forceAlpha) return null;
    if (!renderer?.render || !renderer.batch?.flush || !renderer.renderTexture?.bind) return null;
    if (!target?.valid || target.destroyed || !target.baseTexture?.valid || target.baseTexture.destroyed) return null;
    if (objects.length < 2) return null;

    const Mesh = foundry?.canvas?.primary?.PrimarySpriteMesh;
    const Shader = foundry?.canvas?.rendering?.shaders?.PrimaryBaseSamplerShader;
    if (!Mesh || !Shader) return null;
    const seen = new Set();
    for (const object of objects) {
      if (object?.constructor !== Mesh || object.destroyed || !object.texture?.valid || seen.has(object)) return null;
      if (object.shader?.constructor !== Shader || object.pluginName !== object.shader.pluginName) return null;
      if (
        object.children.length ||
        object.mask ||
        object.filters?.length ||
        object.render !== PIXI.Container.prototype.render ||
        object._render !== Mesh.prototype._render ||
        object._updateBatchData !== Mesh.prototype._updateBatchData
      )
        return null;
      if (object.texture.baseTexture === target.baseTexture) return null;
      if (surfaceForObject(object)) return null;
      seen.add(object);
    }

    this.objects = objects;
    try {
      renderer.render(this.container, { renderTexture: target, clear: false, skipUpdateTransform: true });
      return true;
    } catch (error) {
      this.failed = true;

      throw error;
    } finally {
      this.objects = null;
    }
  }

  /** Render borrowed objects without changing their transforms, parentage or alpha. */
  _renderObjects(renderer) {
    for (const object of this.objects) object.render(renderer);
  }

  /** Release the submission container without destroying captured objects or textures. */
  destroy() {
    this.objects = null;
    try {
      this.container.destroy();
    } catch (error) {
      logger.debug("FXMaster:", error);
    }
  }
}
