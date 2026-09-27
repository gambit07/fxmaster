import { logger } from "../logger.js";

/** Compose matching screen-space masks without intermediate copy and erase draws. */
export class CutoutMaskPass {
  constructor() {
    this.mesh = null;
    this.geometry = null;
    this.shader = null;
    this.failed = false;
    this.busy = false;
    this.results = new WeakMap();
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
      orig?.x === 0 &&
      orig?.y === 0 &&
      frame.width === base.width &&
      frame.height === base.height &&
      orig.width === frame.width &&
      orig.height === frame.height &&
      !texture.multisample &&
      base.format === PIXI.FORMATS.RGBA &&
      base.type === PIXI.TYPES.UNSIGNED_BYTE &&
      base.alphaMode !== PIXI.ALPHA_MODES.NPM
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
      precision highp float;
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
      precision highp float;
      varying vec2 vTextureCoord;
      uniform sampler2D baseSampler;
      uniform sampler2D coverageSampler;
      uniform sampler2D secondCoverageSampler;
      uniform float useSecondCoverage;
      void main() {
        vec4 color = texture2D(baseSampler, vTextureCoord);
        color *= 1.0 - texture2D(coverageSampler, vTextureCoord).a;
        if (useSecondCoverage > 0.5) color *= 1.0 - texture2D(secondCoverageSampler, vTextureCoord).a;
        gl_FragColor = color;
      }
      `,
      {
        baseSampler: PIXI.Texture.EMPTY,
        coverageSampler: PIXI.Texture.EMPTY,
        secondCoverageSampler: PIXI.Texture.EMPTY,
        useSecondCoverage: 0,
      },
    );
    this.mesh = new PIXI.Mesh(this.geometry, this.shader);
    this.mesh.name = "fxmasterCutoutMask";
    this.mesh.eventMode = "none";
    this.mesh.blendMode = PIXI.BLEND_MODES.NONE;
    this.mesh.roundPixels = false;
    return this.mesh;
  }

  /**
   * Multiply a base mask by the inverse alpha of one or two matching coverage textures. Reuse completed cutouts while input and output pixel revisions remain unchanged.
   * @param {PIXI.Renderer} renderer
   * @param {PIXI.RenderTexture} base
   * @param {PIXI.RenderTexture[]} coverage
   * @param {PIXI.RenderTexture} target
   * @returns {boolean}
   */
  render(renderer, base, coverage, target) {
    const inputs = [base, ...coverage];
    const textures = [...inputs, target];
    const unsupported =
      this.busy ||
      this.failed ||
      typeof renderer?.render !== "function" ||
      coverage.length < 1 ||
      coverage.length > 2 ||
      textures.some((texture) => !this.#isFullTexture(texture)) ||
      textures.some((texture) => texture.resolution !== 1) ||
      !Number.isInteger(target.width) ||
      !Number.isInteger(target.height) ||
      inputs.some((texture) => texture.width !== target.width || texture.height !== target.height) ||
      textures.some((texture, index) =>
        textures.slice(0, index).some((prior) => prior.baseTexture === texture.baseTexture),
      ) ||
      target.baseTexture.maskStack?.length ||
      target.baseTexture.clear?.alpha !== 0;
    if (unsupported) return false;

    const previous = this.results.get(target);
    const canCache = textures.every((texture) => Number.isFinite(texture.baseTexture.dirtyId));
    if (
      canCache &&
      previous?.renderer === renderer &&
      previous.contextId === renderer.CONTEXT_UID &&
      previous.width === target.width &&
      previous.height === target.height &&
      previous.targetBase === target.baseTexture &&
      previous.targetRevision === target.baseTexture.dirtyId &&
      previous.inputs.length === inputs.length &&
      inputs.every((texture, index) => {
        const state = previous.inputs[index];
        return (
          state.texture === texture &&
          state.base === texture.baseTexture &&
          state.revision === texture.baseTexture.dirtyId &&
          state.scaleMode === texture.baseTexture.scaleMode &&
          state.coverageKind === texture.__fxmasterCoverageKind
        );
      })
    ) {
      return true;
    }
    this.results.delete(target);
    this.busy = true;
    const modes = coverage.map((texture) => ({
      baseTexture: texture.baseTexture,
      scaleMode: texture.baseTexture.scaleMode,
    }));
    const inputStates = canCache
      ? inputs.map((texture) => ({
          texture,
          base: texture.baseTexture,
          revision: texture.baseTexture.dirtyId,
          scaleMode: texture.baseTexture.scaleMode,
          coverageKind: texture.__fxmasterCoverageKind,
        }))
      : null;
    try {
      const mesh = this.#getMesh();
      mesh.scale.set(target.width, target.height);
      const uniforms = this.shader.uniforms;
      uniforms.baseSampler = base;
      uniforms.coverageSampler = coverage[0];
      uniforms.secondCoverageSampler = coverage[1] ?? coverage[0];
      uniforms.useSecondCoverage = coverage.length === 2 ? 1 : 0;
      for (const texture of coverage) {
        if (texture.__fxmasterCoverageKind === "tiles") texture.baseTexture.scaleMode = PIXI.SCALE_MODES.NEAREST;
      }
      renderer.render(mesh, { renderTexture: target, clear: true, skipUpdateTransform: false });

      if (inputStates) {
        this.results.set(target, {
          renderer,
          contextId: renderer.CONTEXT_UID,
          width: target.width,
          height: target.height,
          targetBase: target.baseTexture,
          targetRevision: target.baseTexture.dirtyId,
          inputs: inputStates,
        });
      }

      return true;
    } catch (err) {
      this.failed = true;

      logger.debug("FXMaster:", err);
      return false;
    } finally {
      for (const { baseTexture, scaleMode } of modes) {
        try {
          if (!baseTexture.destroyed) baseTexture.scaleMode = scaleMode;
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }
      if (this.shader?.uniforms) {
        for (const name of ["baseSampler", "coverageSampler", "secondCoverageSampler"])
          this.shader.uniforms[name] = PIXI.Texture.EMPTY;
      }
      this.busy = false;
    }
  }

  /** Release owned quad resources without destroying borrowed textures. */
  destroy() {
    this.mesh?.destroy();
    this.geometry?.destroy();
    this.shader?.destroy();
    this.mesh = null;
    this.geometry = null;
    this.shader = null;
    this.failed = false;
    this.busy = false;
    this.results = new WeakMap();
  }
}
