import { logger } from "../logger.js";

/** Draw prepared scene-mask textures with their existing fragment shader. */
export class SceneMaskPass {
  /** @param {PIXI.Filter} filter @param {"clip"|"surface"|"binary"} kind */
  constructor(filter, kind) {
    this.filter = filter;
    this.kind = kind;
    this.samplers =
      kind === "binary" ? [] : kind === "clip" ? ["clipSampler", "coverageSampler"] : ["occlusionSampler"];
    this.uniformNames =
      kind === "binary"
        ? ["threshold"]
        : kind === "clip"
        ? [...this.samplers, "useCoverage"]
        : [...this.samplers, "occlusionElevation", "screenDimensions"];
    this.mesh = null;
    this.geometry = null;
    this.shader = null;
    this.failed = false;
  }

  /** @param {PIXI.RenderTexture} texture @returns {boolean} */
  #isFullTexture(texture) {
    const base = texture?.baseTexture;
    const frame = texture?.frame;
    const orig = texture?.orig;
    return (
      !!texture?.valid &&
      !texture.destroyed &&
      !!base?.framebuffer &&
      base.valid &&
      !base.destroyed &&
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
      uniform vec2 textureDimensions;
      uniform vec2 screenDimensions;
      varying vec2 vTextureCoord;
      varying vec2 vMaskTextureCoord;
      void main() {
        gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);
        vTextureCoord = aTextureCoord;
        vMaskTextureCoord = aTextureCoord * textureDimensions / screenDimensions;
      }
      `,
      this.filter.program.fragmentSrc.replace(/^\s*#define SHADER_NAME[^\n]*$/gm, ""),
      {
        uSampler: PIXI.Texture.EMPTY,
        textureDimensions: new Float32Array(2),
        screenDimensions: new Float32Array([1, 1]),
      },
    );
    this.mesh = new PIXI.Mesh(this.geometry, this.shader);
    this.mesh.name = "fxmasterSceneMask";
    this.mesh.eventMode = "none";
    this.mesh.blendMode = PIXI.BLEND_MODES.NORMAL;
    this.mesh.roundPixels = false;
    return this.mesh;
  }

  /**
   * Composite compatible masks without an intermediate source capture.
   * @param {PIXI.Renderer} renderer
   * @param {PIXI.RenderTexture} source
   * @param {PIXI.RenderTexture} target
   * @returns {boolean}
   */
  render(renderer, source, target) {
    const filter = this.filter;
    const uniforms = filter.uniforms;
    const resolution = filter.resolution || target?.resolution;
    const unsupported =
      this.failed ||
      !renderer?.filter?.getOptimalFilterTexture ||
      !renderer.filter.returnFilterTexture ||
      !this.#isFullTexture(source) ||
      !this.#isFullTexture(target) ||
      source.width !== target.width ||
      source.height !== target.height ||
      !Number.isInteger(target.width) ||
      !Number.isInteger(target.height) ||
      source.resolution !== 1 ||
      target.resolution !== 1 ||
      resolution !== 1 ||
      filter.padding !== 0 ||
      !filter.enabled ||
      (filter.multisample ?? target.multisample) !== 0 ||
      (this.kind === "binary" && (source.multisample || target.multisample)) ||
      source.baseTexture === target.baseTexture;
    if (unsupported) return false;
    for (const name of this.samplers) {
      const texture = uniforms[name];
      if (!texture?.valid || texture.destroyed || !texture.baseTexture?.valid || texture.baseTexture.destroyed) {
        return false;
      }
      if (texture.baseTexture === target.baseTexture) {
        return false;
      }
    }
    try {
      if (this.kind !== "binary") {
        const probe = renderer.filter.getOptimalFilterTexture(target.width, target.height, resolution, 0);
        const matches = probe.width === target.width && probe.height === target.height;
        renderer.filter.returnFilterTexture(probe);
        if (!matches) return false;
      }
      const mesh = this.#getMesh();
      mesh.scale.set(target.width, target.height);
      const u = this.shader.uniforms;
      u.uSampler = source;
      u.textureDimensions[0] = target.width;
      u.textureDimensions[1] = target.height;
      for (const name of this.uniformNames) u[name] = uniforms[name];
      renderer.render(mesh, { renderTexture: target, clear: false, skipUpdateTransform: false });

      return true;
    } catch (err) {
      this.failed = true;

      logger.debug("FXMaster:", err);
      return false;
    } finally {
      if (this.shader?.uniforms) {
        this.shader.uniforms.uSampler = PIXI.Texture.EMPTY;
        for (const name of this.samplers) this.shader.uniforms[name] = PIXI.Texture.EMPTY;
      }
    }
  }

  /** Release owned quad resources while retaining borrowed filters, programs and textures. */
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
