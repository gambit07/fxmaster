import { logger } from "../logger.js";

/** Composite prepared surface alpha with the existing occlusion fragment shader. */
export class SurfaceCoveragePass {
  /** @param {string} fragmentSource */
  constructor(fragmentSource) {
    this.fragmentSource = fragmentSource.replace(/^\s*#define SHADER_NAME[^\n]*$/gm, "");
    this.mesh = null;
    this.geometry = null;
    this.shader = null;
    this.failed = false;
  }

  /** @param {PIXI.RenderTexture} texture @returns {boolean} */
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

  /** @returns {PIXI.Mesh} */
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
      uniform mat3 maskUvToScreenUv;
      varying vec2 vTextureCoord;
      varying vec2 vOcclusionCoord;
      void main() {
        gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);
        vTextureCoord = aTextureCoord;
        vOcclusionCoord = (maskUvToScreenUv * vec3(aTextureCoord, 1.0)).xy;
      }
      `,
      this.fragmentSource,
      {
        uSampler: PIXI.Texture.EMPTY,
        occlusionSampler: PIXI.Texture.EMPTY,
        occlusionElevation: 1,
        unoccludedAlpha: 1,
        occludedAlpha: 0,
        maskUvToScreenUv: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
      },
    );
    this.mesh = new PIXI.Mesh(this.geometry, this.shader);
    this.mesh.name = "fxmasterSurfaceCoverage";
    this.mesh.eventMode = "none";
    this.mesh.blendMode = PIXI.BLEND_MODES.NORMAL;
    this.mesh.roundPixels = false;
    return this.mesh;
  }

  /**
   * Draw compatible full-frame coverage without an intermediate filter capture.
   * @param {PIXI.Renderer} renderer
   * @param {PIXI.RenderTexture} source
   * @param {PIXI.RenderTexture} target
   * @param {object} uniforms
   * @param {number|null} filterResolution
   * @returns {boolean}
   */
  render(renderer, source, target, uniforms, filterResolution) {
    const occlusion = uniforms?.occlusionSampler;
    const resolution = filterResolution || target?.resolution;
    const unsupported =
      this.failed ||
      !renderer ||
      !this.#isFullRenderTexture(source) ||
      !this.#isFullRenderTexture(target) ||
      !occlusion?.valid ||
      occlusion.destroyed ||
      !occlusion.baseTexture?.valid ||
      occlusion.baseTexture.destroyed ||
      source.baseTexture === target.baseTexture ||
      occlusion.baseTexture === target.baseTexture ||
      source.width !== target.width ||
      source.height !== target.height ||
      !Number.isInteger(target.width) ||
      !Number.isInteger(target.height) ||
      source.resolution !== 1 ||
      target.resolution !== 1 ||
      resolution !== 1;
    if (unsupported) return false;
    try {
      const mesh = this.#getMesh();
      mesh.scale.set(target.width, target.height);
      const u = this.shader.uniforms;
      u.uSampler = source;
      u.occlusionSampler = occlusion;
      u.occlusionElevation = uniforms.occlusionElevation;
      u.unoccludedAlpha = uniforms.unoccludedAlpha;
      u.occludedAlpha = uniforms.occludedAlpha;
      u.maskUvToScreenUv = uniforms.maskUvToScreenUv;
      renderer.render(mesh, { renderTexture: target, clear: false, skipUpdateTransform: false });

      return true;
    } catch (err) {
      this.failed = true;

      logger.debug("FXMaster:", err);
      return false;
    } finally {
      if (this.shader?.uniforms) {
        this.shader.uniforms.uSampler = PIXI.Texture.EMPTY;
        this.shader.uniforms.occlusionSampler = PIXI.Texture.EMPTY;
      }
    }
  }

  /** Release owned resources while preserving borrowed textures and shared shader programs. */
  destroy() {
    this.mesh?.destroy();
    this.geometry?.destroy();
    this.shader?.destroy();
    this.mesh = null;
    this.geometry = null;
    this.shader = null;
    this.failed = false;
  }
}
