import { FXMasterFilterEffectMixin } from "./mixins/filter.js";
import fragment from "./shaders/bloom.frag";
import { MAX_EDGES } from "../../constants.js";
import { clampRange } from "../../utils.js";

/**
 * BloomFilter
 * -----------
 * Scene/region post-process bloom with thresholded bright-pass, separable blur,
 * and additive upsample. Supports region masks, strength, and fade metadata
 * (analytic rect/ellipse or polygon with SDF/edges) provided by the layer.
 */
export class BloomFilter extends FXMasterFilterEffectMixin(PIXI.Filter) {
  /**
   * Construct a BloomFilter with defaults and uniform wiring.
   * Initializes mask uniforms, fade controls, and effect parameters.
   * @param {object} [options={}] - Initial filter options.
   * @param {string} [id] - Stable id for filter instances.
   */
  constructor(options = {}, id) {
    super(options, id, PIXI.Filter.defaultVertex, fragment);

    const r = canvas?.app?.renderer;
    if (r) {
      try {
        this.filterArea = new PIXI.Rectangle(0, 0, r.screen.width | 0, r.screen.height | 0);
      } catch {}
    }

    const u = (this.uniforms ??= {});
    this.initMaskUniforms(u, { withStrength: true, strengthDefault: 1.0 });
    this.initFadeUniforms(u);
    this.initRegionFadeUniforms(u, { maxEdges: MAX_EDGES });

    // Kept for pipeline consistency
    this.ensureVec4Uniform("srcFrame", [0, 0, 1, 1]);
    this.ensureVec2Uniform("camFrac", [0, 0]);

    // Effect params
    u.threshold = typeof u.threshold === "number" ? u.threshold : 0.5;
    u.bloomScale = typeof u.bloomScale === "number" ? u.bloomScale : 0.1;
    u.blurRadius = typeof u.blurRadius === "number" ? u.blurRadius : 1.0;

    this.configure(options);
  }

  /** i18n label key used by UI. */
  static label = "FXMASTER.Filters.Effects.Bloom";

  /** FontAwesome icon class used by UI. */
  static icon = "fas fa-ghost";

  /**
   * Parameter schema exposed to configuration UIs.
   * @returns {Record<string, object>} Parameter descriptors.
   */
  static get parameters() {
    return {
      belowTokens: { label: "FXMASTER.Params.BelowTokens", type: "checkbox", value: false },
      blur: { label: "FXMASTER.Params.Blur", type: "range", max: 10.0, min: 0.0, step: 1.0, value: 1.0 },
      bloomScale: { label: "FXMASTER.Params.Bloom", type: "range", max: 1.0, min: 0.0, step: 0.1, value: 0.1 },
      threshold: { label: "FXMASTER.Params.Threshold", type: "range", max: 1.0, min: 0.0, step: 0.1, value: 0.5 },
    };
  }

  /**
   * Neutral (no-op) option values.
   * @returns {{blur:number,bloomScale:number,threshold:number}} Neutral options.
   */
  static get neutral() {
    return { blur: 0.0, bloomScale: 0.0, threshold: 1.0 };
  }

  /**
   * Apply uniforms from options with clamping and fade handling.
   * Also forwards any mask-related options to the mixin.
   * @param {object} [opts={}] - Options payload.
   */
  _applyUniforms(opts = {}) {
    const blur = clampRange(opts.blur, 0.0, 10.0);
    const bloomScale = clampRange(opts.bloomScale, 0.0, 1.0);
    const threshold = clampRange(opts.threshold, 0.0, 1.0);
    if (typeof blur === "number") this.uniforms.blurRadius = blur;
    if (typeof bloomScale === "number") this.uniforms.bloomScale = bloomScale;
    if (typeof threshold === "number") this.uniforms.threshold = threshold;

    this.applyFadeOptionsFrom(opts);

    this.applyMaskOptionsFrom(opts);
  }

  /**
   * Configure filter uniforms and state from options.
   * @param {object} [options={}] - Options payload.
   */
  configure(options = {}) {
    super.configure(options);
    const o = this.options;

    if (o) this._applyUniforms(o);
  }

  /**
   * Apply options without re-initializing the instance.
   * @param {object} [options=this.options] - Options payload.
   */
  applyOptions(options = this.options) {
    this._applyUniforms(options);
    super.applyOptions(options);
  }

  /**
   * Begin playing the effect; ensures strength is enabled and respects skipFading.
   * @param {object} [opts={}] - Options payload and play flags.
   * @returns {any} Return value from base play.
   */
  play(opts = {}) {
    try {
      this.configure(opts);
    } catch {}
    try {
      if (this.uniforms) this.uniforms.strength = 1.0;
    } catch {}
    return super.play?.({ skipFading: true, ...opts });
  }

  /**
   * Stop the effect immediately; cancels fades and neutralizes mask.
   * @returns {Promise<any>} Return value from base stop.
   */
  stop({ durationMs = 3000, skipFading } = {}) {
    return this.stopWithUniformFade({ uniformKey: "strength", durationMs, skipFading });
  }

  /**
   * PIXI.Filter hook: run the filter with FXMaster's apply lock and scene-rect area.
   * @param {PIXI.FilterSystem} filterSystem - Filter system.
   * @param {PIXI.RenderTexture} input - Input texture.
   * @param {PIXI.RenderTexture} output - Output texture.
   * @param {PIXI.CLEAR_MODES|boolean} clear - Clear flag.
   * @param {object} currentState - Filter state.
   * @returns {void}
   */
  apply(filterSystem, input, output, clear, currentState) {
    return this.applyWithLock(filterSystem, input, output, clear, currentState, {
      area: "sceneRect",
      setDeviceToCss: false,
    });
  }
}
