/** Reuse borrowed binary masks while their ordered source state remains identical within one frame. */
export class SurfaceMaskReuse {
  /** @param {object} owner */
  constructor(owner) {
    this.owner = owner;
    this.entries = [];
    this.frame = null;
  }

  /** Release borrowed references without destroying textures. */
  clear() {
    this.entries.length = 0;
    this.frame = null;
  }

  /** @param {PIXI.RenderTexture} texture */
  forget(texture) {
    this.entries = this.entries.filter((entry) => entry.texture !== texture);
  }

  /** @param {PIXI.RenderTexture} texture @returns {boolean} */
  #usable(texture) {
    const base = texture?.baseTexture;
    const frame = texture?.frame;
    const orig = texture?.orig;
    return !!(
      texture?.valid &&
      !texture.destroyed &&
      base?.valid &&
      !base.destroyed &&
      base.framebuffer &&
      texture.resolution === 1 &&
      !texture.multisample &&
      !texture.trim &&
      !texture.rotate &&
      frame?.x === 0 &&
      frame?.y === 0 &&
      frame.width === base.width &&
      frame.height === base.height &&
      orig?.width === frame.width &&
      orig?.height === frame.height &&
      Number.isInteger(frame.width) &&
      frame.width > 0 &&
      Number.isInteger(frame.height) &&
      frame.height > 0
    );
  }

  /** Read exact render inputs for supported static meshes without updating transforms or bounds. */
  #state(objects, texture) {
    const board = globalThis.canvas;
    const renderer = board?.app?.renderer;
    const Mesh = globalThis.foundry?.canvas?.primary?.PrimarySpriteMesh;
    const Shader = globalThis.foundry?.canvas?.rendering?.shaders?.PrimaryBaseSamplerShader;
    const ImageResource = globalThis.PIXI?.ImageResource;
    const ImageBitmapResource = globalThis.PIXI?.ImageBitmapResource;
    if (!renderer || !Mesh || !Shader || (!ImageResource && !ImageBitmapResource) || !this.#usable(texture))
      return null;
    const plugin = renderer.plugins?.[Shader.classPluginName];
    if (
      !plugin ||
      plugin.render !== PIXI.BatchRenderer.prototype.render ||
      plugin._preRenderBatch !== Shader._preRenderBatch ||
      plugin._packInterleavedGeometry !== Shader._packInterleavedGeometry
    )
      return null;
    const filter = this.owner?._binaryMaskFilter;
    const scratch = this.owner?._surfaceMaskScratchRT;
    const list = this.owner?._surfaceMaskRenderList;
    const sprite = this.owner?._surfaceMaskThresholdSprite;
    if (
      !filter?.enabled ||
      filter.destroyed ||
      !this.#usable(scratch) ||
      !list ||
      list.destroyed ||
      !sprite ||
      sprite.destroyed
    )
      return null;
    if (
      scratch.baseTexture === texture.baseTexture ||
      scratch.width !== texture.width ||
      scratch.height !== texture.height
    )
      return null;
    if (!Array.isArray(objects) || objects.length < 2 || objects.length > 128) return null;
    if (
      renderer.resolution !== 1 ||
      texture.width !== renderer.screen?.width ||
      texture.height !== renderer.screen?.height
    )
      return null;
    if (renderer.mask?.maskStack?.length || renderer.filter?.defaultFilterStack?.length > 1) return null;
    const occlusion = board.masks?.occlusion;
    const maskTexture = occlusion?.renderTexture;
    const matrix = board.stage?.worldTransform;
    if (!matrix || !maskTexture?.valid || maskTexture.destroyed) return null;
    const tint = plugin._shader?.uniforms?.tint;
    const state = [
      board,
      board.scene,
      board.level,
      renderer,
      plugin,
      plugin._shader,
      tint?.[0],
      tint?.[1],
      tint?.[2],
      tint?.[3],
      filter,
      filter.program,
      filter.program?.fragmentSrc,
      filter.uniforms?.threshold,
      filter.resolution,
      filter.padding,
      filter.multisample,
      this.owner._binaryMaskPass?.failed,
      scratch,
      list,
      list._render,
      sprite,
      renderer.screen.width,
      renderer.screen.height,
      renderer.resolution,
      board.screenDimensions?.[0],
      board.screenDimensions?.[1],
      matrix.a,
      matrix.b,
      matrix.c,
      matrix.d,
      matrix.tx,
      matrix.ty,
      maskTexture,
      maskTexture.baseTexture,
      maskTexture.baseTexture?.dirtyId,
      maskTexture.width,
      maskTexture.height,
      maskTexture.resolution,
      occlusion.vision,
      occlusion.mapElevation,
      texture.baseTexture,
      texture.baseTexture.dirtyId,
      texture.baseTexture.dirtyStyleId,
      texture.width,
      texture.height,
      texture.resolution,
    ];
    for (const object of objects) {
      const source = object?.texture;
      const base = source?.baseTexture;
      const shader = object?.shader;
      const resource = base?.resource;
      const staticImage =
        resource &&
        !resource.destroyed &&
        ((ImageResource && resource.constructor === ImageResource) ||
          (ImageBitmapResource && resource.constructor === ImageBitmapResource));
      if (
        object?.constructor !== Mesh ||
        object.destroyed ||
        !source?.valid ||
        source.destroyed ||
        !base?.valid ||
        base.destroyed ||
        base === texture.baseTexture ||
        !staticImage ||
        shader?.constructor !== Shader ||
        !shader.enabled ||
        object.pluginName !== Shader.classPluginName ||
        shader.pluginName !== object.pluginName ||
        object.children?.length !== 0 ||
        object.mask ||
        object.filters?.length ||
        object.cullArea ||
        object.blendMode !== PIXI.BLEND_MODES.NORMAL ||
        object.render !== PIXI.Container.prototype.render ||
        object._render !== Mesh.prototype._render ||
        object._renderWithCulling !== Mesh.prototype._renderWithCulling ||
        object.getBounds !== Mesh.prototype.getBounds ||
        object.calculateBounds !== Mesh.prototype.calculateBounds ||
        object.calculateVertices !== Mesh.prototype.calculateVertices ||
        object.calculateTrimmedVertices !== Mesh.prototype.calculateTrimmedVertices ||
        object.updateUvs !== Mesh.prototype.updateUvs ||
        object._updateBatchData !== Mesh.prototype._updateBatchData
      )
        return null;
      const world = object.worldTransform;
      const occluded = object._occlusionState;
      if (!world || !occluded) return null;
      state.push(
        object,
        source,
        base,
        resource,
        resource.source,
        resource.width,
        resource.height,
        base.dirtyId,
        base.dirtyStyleId,
        base.alphaMode,
        base.scaleMode,
        base.mipmap,
        base.wrapMode,
        source.rotate,
        source._updateID,
        world.a,
        world.b,
        world.c,
        world.d,
        world.tx,
        world.ty,
        object.worldAlpha,
        object.alpha,
        object.visible,
        object.renderable,
        object.cullable,
        object.roundPixels,
        object.tint,
        object.anchor?.x,
        object.anchor?.y,
        object._paddingX,
        object._paddingY,
        shader,
        object.unoccludedAlpha,
        object.occludedAlpha,
        object._occlusionElevation,
        occluded.fade,
        occluded.radial,
        occluded.vision,
        occluded.surface,
      );
      for (const rect of [source.frame, source.orig, source.trim]) {
        state.push(rect?.x, rect?.y, rect?.width, rect?.height);
      }
      for (const values of [object.vertexData, object.uvs, object.indices]) {
        if (!values || values.length > 8) return null;
        state.push(values, values.length);
        for (let index = 0; index < values.length; index++) state.push(values[index]);
      }
    }
    return state;
  }

  /**
   * Remember a newly rendered, unmodified Region mask as a read-only source.
   * @param {PIXI.DisplayObject[]} objects
   * @param {PIXI.RenderTexture} texture
   * @param {number} frame
   */
  remember(objects, texture, frame) {
    if (!Number.isSafeInteger(frame) || frame < 1) return;
    if (this.frame !== frame) this.clear();
    this.frame = frame;
    this.forget(texture);
    if (this.entries.length >= 16) return;
    try {
      const state = this.#state(objects, texture);
      if (state) this.entries.push({ objects: objects.slice(), texture, state });
    } catch (_err) {}
  }

  /**
   * Borrow a mask only while every ordered source and exact render input still matches.
   * @param {PIXI.DisplayObject[]} objects
   * @param {number} frame
   * @returns {PIXI.RenderTexture|null}
   */
  find(objects, frame) {
    if (this.frame !== frame || !Array.isArray(objects)) return null;
    for (const entry of this.entries) {
      if (entry.objects.length !== objects.length || !entry.objects.every((object, index) => object === objects[index]))
        continue;
      try {
        const state = this.#state(objects, entry.texture);
        if (
          state?.length === entry.state.length &&
          state.every((value, index) => Object.is(value, entry.state[index]))
        ) {
          return entry.texture;
        }
      } catch (_err) {}
    }
    return null;
  }
}
