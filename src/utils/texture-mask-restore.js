import { logger } from "../logger.js";

/** Render full-frame texture restores without an intermediate sprite-mask filter target. */
export class TextureMaskRestore {
  /** Create reusable restore resources lazily. */
  constructor() {
    this.mesh = null;
    this.geometry = null;
    this.shader = null;
    this.failed = false;

    this.sequenceContainer = null;
    this.sequenceOperations = null;
    this.sequenceFailed = false;
  }

  /**
   * Accept complete, untrimmed render textures with normalized UV coordinates.
   * @param {PIXI.Texture} texture
   * @returns {boolean}
   */
  #isFullRenderTexture(texture) {
    const base = texture?.baseTexture;
    const frame = texture?.frame;
    const orig = texture?.orig;
    return (
      !!texture &&
      !texture.destroyed &&
      texture.valid === true &&
      !!base?.framebuffer &&
      !base.destroyed &&
      base.valid === true &&
      !texture.trim &&
      !texture.rotate &&
      frame?.x === 0 &&
      frame?.y === 0 &&
      frame.width === base.width &&
      frame.height === base.height &&
      orig?.width === frame.width &&
      orig?.height === frame.height
    );
  }

  /**
   * Create the unit quad and premultiplied mask shader.
   * @returns {PIXI.Mesh}
   */
  #getMesh() {
    if (this.mesh && !this.mesh.destroyed) return this.mesh;
    this.geometry = new PIXI.MeshGeometry(
      new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      new Uint16Array([0, 1, 2, 0, 2, 3]),
    );
    this.shader = PIXI.Shader.from(
      `
      attribute vec2 aVertexPosition;
      attribute vec2 aTextureCoord;
      uniform mat3 projectionMatrix;
      uniform mat3 translationMatrix;
      varying vec2 vTextureCoord;
      void main() {
        gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);
        vTextureCoord = aTextureCoord;
      }
      `,
      `
      varying vec2 vTextureCoord;
      uniform sampler2D sourceSampler;
      uniform sampler2D maskSampler;
      uniform float npmAlpha;
      void main() {
        vec4 source = texture2D(sourceSampler, vTextureCoord);
        vec4 mask = texture2D(maskSampler, vTextureCoord);
        float coverage = mask.r * (1.0 - npmAlpha * (1.0 - mask.a));
        gl_FragColor = source * coverage;
      }
      `,
      { sourceSampler: PIXI.Texture.EMPTY, maskSampler: PIXI.Texture.EMPTY, npmAlpha: 0 },
    );
    this.mesh = new PIXI.Mesh(this.geometry, this.shader);
    this.mesh.name = "fxmasterTextureMaskRestore";
    this.mesh.eventMode = "none";
    this.mesh.blendMode = PIXI.BLEND_MODES.NORMAL;
    this.mesh.roundPixels = false;
    return this.mesh;
  }

  /**
   * Restore source pixels through the mask's red channel using normal premultiplied blending.
   * @param {PIXI.Renderer} renderer
   * @param {PIXI.RenderTexture} mask
   * @param {PIXI.RenderTexture} source
   * @param {PIXI.RenderTexture} output
   * @param {{width:number,height:number}} viewport
   * @returns {boolean} Whether the direct restore completed.
   */
  render(renderer, mask, source, output, { width, height }) {
    const unsupported =
      this.failed ||
      !renderer ||
      !this.#isFullRenderTexture(source) ||
      !this.#isFullRenderTexture(mask) ||
      !this.#isFullRenderTexture(output) ||
      !source.baseTexture.alphaMode ||
      source.baseTexture === output.baseTexture ||
      mask.baseTexture === output.baseTexture ||
      !Number.isFinite(width) ||
      width <= 0 ||
      !Number.isFinite(height) ||
      height <= 0;
    if (unsupported) return false;
    try {
      const mesh = this.#getMesh();
      mesh.scale.set(width, height);
      this.shader.uniforms.sourceSampler = source;
      this.shader.uniforms.maskSampler = mask;
      this.shader.uniforms.npmAlpha = mask.baseTexture.alphaMode ? 0 : 1;
      renderer.render(mesh, { renderTexture: output, clear: false, skipUpdateTransform: false });

      return true;
    } catch (err) {
      this.failed = true;

      logger.debug("FXMaster:", err);

      return false;
    } finally {
      if (this.shader?.uniforms) {
        this.shader.uniforms.sourceSampler = PIXI.Texture.EMPTY;
        this.shader.uniforms.maskSampler = PIXI.Texture.EMPTY;
      }
    }
  }

  /**
   * Submit ordered restores together while preserving individual shader draws and blending.
   * @param {PIXI.Renderer} renderer
   * @param {Array<{mask:PIXI.RenderTexture,source:PIXI.RenderTexture}>} operations
   * @param {PIXI.RenderTexture} output
   * @param {{width:number,height:number}} viewport
   * @returns {boolean|null} True on success, false after a failed attempt, or null before submission.
   */
  renderSequence(renderer, operations, output, { width, height }) {
    const compatible =
      !this.failed &&
      !this.sequenceFailed &&
      !this.sequenceOperations &&
      renderer?.batch &&
      renderer?.geometry &&
      renderer?.shader &&
      !renderer.context?.isLost &&
      Array.isArray(operations) &&
      operations.length > 1 &&
      this.#isFullRenderTexture(output) &&
      Number.isFinite(width) &&
      width > 0 &&
      Number.isFinite(height) &&
      height > 0 &&
      operations.every(
        (operation) =>
          this.#isFullRenderTexture(operation?.mask) &&
          this.#isFullRenderTexture(operation?.source) &&
          operation.source.baseTexture.alphaMode &&
          operation.source.baseTexture !== output.baseTexture &&
          operation.mask.baseTexture !== output.baseTexture,
      );
    if (!compatible) {
      return null;
    }

    try {
      const mesh = this.#getMesh();
      mesh.scale.set(width, height);
      const parent = mesh.enableTempParent();
      try {
        mesh.updateTransform();
      } finally {
        mesh.disableTempParent(parent);
      }
      if (!this.sequenceContainer || this.sequenceContainer.destroyed) {
        this.sequenceContainer = new PIXI.Container();
        this.sequenceContainer.name = "fxmasterTextureMaskRestoreSequence";
        this.sequenceContainer.eventMode = "none";
        this.sequenceContainer._render = (activeRenderer) => this.#renderSequenceContents(activeRenderer);
      }
      this.sequenceOperations = operations;
      renderer.render(this.sequenceContainer, { renderTexture: output, clear: false, skipUpdateTransform: true });

      return true;
    } catch (err) {
      this.sequenceFailed = true;

      logger.debug("FXMaster:", err);
      return false;
    } finally {
      this.sequenceOperations = null;
      if (this.shader?.uniforms) {
        this.shader.uniforms.sourceSampler = PIXI.Texture.EMPTY;
        this.shader.uniforms.maskSampler = PIXI.Texture.EMPTY;
      }
    }
  }

  /**
   * Draw each queued mask through the existing restore shader in source order.
   * @param {PIXI.Renderer} renderer
   */
  #renderSequenceContents(renderer) {
    for (const { mask, source } of this.sequenceOperations ?? []) {
      this.shader.uniforms.sourceSampler = source;
      this.shader.uniforms.maskSampler = mask;
      this.shader.uniforms.npmAlpha = mask.baseTexture.alphaMode ? 0 : 1;
      this.mesh.render(renderer);
    }
  }

  /** Release owned quad resources without destroying sampled textures or shared shader programs. */
  destroy() {
    this.sequenceContainer?.destroy();
    this.sequenceContainer = null;
    this.sequenceOperations = null;
    this.sequenceFailed = false;
    this.mesh?.destroy();
    this.geometry?.destroy();
    this.shader?.destroy();
    this.mesh = null;
    this.geometry = null;
    this.shader = null;
    this.failed = false;
  }
}
