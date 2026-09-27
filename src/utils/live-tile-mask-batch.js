import { logger } from "../logger.js";

/** Submit compatible live tile meshes together while preserving their shader and transform updates. */
export class LiveTileMaskBatch {
  constructor() {
    this.container = new PIXI.Container();
    this.container._render = this._renderMeshes.bind(this);
    this.meshes = null;
    this.blendMode = PIXI.BLEND_MODES.NORMAL;
    this.rendered = false;
  }

  /**
   * Render an ordered group, returning null when individual submissions are required.
   * @param {PIXI.Renderer} renderer
   * @param {PIXI.RenderTexture} target
   * @param {PIXI.DisplayObject[]} meshes
   * @param {{ transform: PIXI.Matrix, clear: boolean, blendMode: number }} options
   * @returns {boolean|null}
   */
  render(renderer, target, meshes, { transform, clear, blendMode }) {
    if (this.meshes) return null;
    if (!renderer?.render || !renderer.batch?.flush || !renderer.renderTexture?.bind) return null;
    if (!target?.baseTexture?.valid || target.destroyed || target.baseTexture.destroyed) return null;
    if (meshes.length < 2) return null;

    const Mesh = foundry?.canvas?.primary?.PrimarySpriteMesh;
    const Shader = foundry?.canvas?.rendering?.shaders?.PrimaryBaseSamplerShader;
    if (!Mesh || !Shader) return null;
    const seen = new Set();
    for (const mesh of meshes) {
      if (mesh?.constructor !== Mesh || mesh.destroyed || !mesh.texture?.valid || seen.has(mesh)) return null;
      if (mesh.shader?.constructor !== Shader || mesh.pluginName !== mesh.shader.pluginName) return null;
      if (
        mesh.children.length ||
        mesh.mask ||
        mesh.filters?.length ||
        mesh.render !== PIXI.Container.prototype.render ||
        mesh.updateTransform !== Mesh.prototype.updateTransform ||
        mesh._render !== Mesh.prototype._render ||
        mesh._updateBatchData !== Mesh.prototype._updateBatchData
      )
        return null;
      if (mesh.texture.baseTexture === target.baseTexture) return null;
      seen.add(mesh);
    }

    this.meshes = meshes;
    this.blendMode = blendMode;
    this.rendered = false;

    try {
      renderer.render(this.container, { renderTexture: target, clear, transform, skipUpdateTransform: false });
      return this.rendered;
    } finally {
      this.meshes = null;
    }
  }

  /**
   * Render each live mesh with independent root transforms and its original parent restored.
   * @param {PIXI.Renderer} renderer
   * @returns {void}
   * @private
   */
  _renderMeshes(renderer) {
    for (const mesh of this.meshes) {
      const previousBlendMode = mesh.blendMode;
      try {
        mesh.blendMode = this.blendMode;
        const parent = mesh.enableTempParent();
        try {
          mesh.updateTransform();
        } finally {
          mesh.disableTempParent(parent);
        }
        mesh.render(renderer);
        this.rendered = true;
      } catch (error) {
        logger.debug("FXMaster:", error);
        renderer.batch.flush();
      } finally {
        mesh.blendMode = previousBlendMode;
      }
    }
  }

  /** Release the submission container without destroying borrowed meshes or textures. */
  destroy() {
    this.meshes = null;
    this.container.destroy();
  }
}
