import { FXMasterFilterEffectMixin } from "./mixins/filter.js";
import fragment from "./shaders/old-film.frag";
import { MAX_EDGES } from "../../constants.js";
import { clamp01, clampNonNeg } from "../../utils.js";

/**
 * OldFilmFilter
 * -------------
 * Scene/region old film effect with sepia tone and animated film grain.
 * - Supports region masks and uniform strength.
 * - Analytic (rect/ellipse) fades and polygon fades (SDF/edge-based).
 * - Time-based animation for noise.
 */
export class OldFilmFilter extends FXMasterFilterEffectMixin(PIXI.Filter) {
  /**
   * Construct an OldFilmFilter and initialize uniforms.
   * @param {object} [options={}] - Initial filter options.
   * @param {string} [id] - Stable id for filter instances.
   */
  constructor(options = {}, id) {
    super(options, id, PIXI.Filter.defaultVertex, fragment);

    const u = (this.uniforms ??= {});
    this.initMaskUniforms(u, { withStrength: true, strengthDefault: 1.0 });
    this.initFadeUniforms(u);
    this.initRegionFadeUniforms(u, { maxEdges: MAX_EDGES });

    // Pipeline state
    this.ensureVec4Uniform("srcFrame", [0, 0, 1, 1]);
    this.ensureVec2Uniform("camFrac", [0, 0]);

    // Effect params
    u.time = typeof u.time === "number" ? u.time : 0.0;
    u.noiseStrength = typeof u.noiseStrength === "number" ? u.noiseStrength : 0.1;
    u.sepiaAmount = typeof u.sepiaAmount === "number" ? u.sepiaAmount : 0.3;
    u.noiseSize = Number.isFinite(u.noiseSize) ? u.noiseSize : 1.0; // ≥0
    u.scratch = typeof u.scratch === "number" ? u.scratch : 0.5; // 0..1
    u.scratchDensity = typeof u.scratchDensity === "number" ? u.scratchDensity : 0.3; // 0..1

    this.configure(options);
  }

  /** i18n label key used by UI. */
  static label = "FXMASTER.Filters.Effects.OldFilm";

  /** FontAwesome icon class used by UI. */
  static icon = "fas fa-film";

  /**
   * Parameter schema exposed to configuration UIs.
   * @returns {Record<string, object>} Parameter descriptors.
   */
  static get parameters() {
    return {
      belowTokens: { label: "FXMASTER.Params.BelowTokens", type: "checkbox", value: false },
      sepia: {
        label: "FXMASTER.Params.Sepia",
        type: "range",
        max: 1.0,
        min: 0.0,
        step: 0.1,
        value: 0.3,
        skipInitialAnimation: true,
      },
      noise: {
        label: "FXMASTER.Params.Noise",
        type: "range",
        max: 1.0,
        min: 0.0,
        step: 0.1,
        value: 0.5,
        skipInitialAnimation: true,
      },
      noiseSize: {
        label: "FXMASTER.Params.NoiseSize",
        type: "range",
        max: 5.0,
        min: 0.0,
        step: 0.1,
        value: 1.0,
        skipInitialAnimation: true,
      },
      scratchDensity: {
        label: "FXMASTER.Params.ScratchDensity",
        type: "range",
        max: 1.0,
        min: 0.0,
        step: 0.05,
        value: 0.3,
        skipInitialAnimation: true,
      },
      scratch: {
        label: "FXMASTER.Params.ScratchSize",
        type: "range",
        max: 1.0,
        min: 0.0,
        step: 0.05,
        value: 0.05,
        skipInitialAnimation: true,
      },
    };
  }

  /**
   * Neutral (no-op) option values.
   * @returns {{sepia:number, noise:number, scratch:number}}
   */
  static get neutral() {
    return { sepia: 0.0, noise: 0.0, scratch: 0.0 };
  }

  /**
   * Apply uniforms from options with clamping and fade handling.
   * Accepts direct values or { value } wrappers.
   * @param {object} [opts={}] - Options payload.
   * @private
   */
  _applyUniforms(opts = {}) {
    super.applyOptions(opts);
    const o = this.options;

    const s = clamp01(o.sepia);
    if (s !== undefined) this.uniforms.sepiaAmount = s;
    const n = clamp01(o.noise);
    if (n !== undefined) this.uniforms.noiseStrength = n;

    const sc = clamp01(o.scratch);
    if (sc !== undefined) this.uniforms.scratch = sc;
    const sd = clamp01(o.scratchDensity);
    if (sd !== undefined) this.uniforms.scratchDensity = sd;
    if (o.noiseSize !== undefined) this.uniforms.noiseSize = clampNonNeg(Number(o.noiseSize), 1.0);

    this.applyFadeOptionsFrom(o);

    if (typeof o.maskSampler !== "undefined") this.uniforms.maskSampler = o.maskSampler;
    if (Array.isArray(o.viewSize) && o.viewSize.length === 2) this.uniforms.viewSize = new Float32Array(o.viewSize);
    if (typeof o.hasMask === "number") this.uniforms.hasMask = o.hasMask;
    if (typeof o.maskReady === "number") this.uniforms.maskReady = o.maskReady;
  }

  /**
   * Configure filter uniforms and state from options.
   * @param {object} [options={}] - Options payload.
   */
  configure(options = {}) {
    this._applyUniforms(options);
    super.configure(options);
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
   * Begin playing the effect; advances time each frame via an internal ticker.
   * Ensures strength is enabled for visible effect.
   * @param {{skipFading?:boolean}} [opts] - Options and play flags.
   * @returns {this} The filter instance.
   */
  play({ skipFading = true, ...opts } = {}) {
    this.configure(opts);
    this.enabled = true;
    try {
      if (this.uniforms) this.uniforms.strength = 1.0;
    } catch {}
    super.play?.({ skipFading, ...opts });

    if (!this._filmTick) {
      this._filmTick = this.addFilterTicker((deltaMS) => {
        try {
          const dt = (deltaMS ?? 16.6) * 0.001;
          this.uniforms.time = (this.uniforms.time + dt) % 1e6;
          if (typeof this.uniforms.strength !== "number") this.uniforms.strength = 1.0;
        } catch {}
      });
    }
    return this;
  }

  /**
   * Stop with a guaranteed flash-free fade:
   * - Fade strength -> 0 over duration
   * - Immediately disable the filter (enabled=false) when it hits 0
   * - Then run the normal teardown (removes tickers, neutralizes mask, etc.)
   */
  stop({ durationMs = 3000, skipFading } = {}) {
    return this.stopWithUniformFade({ uniformKey: "strength", durationMs, skipFading });
  }

  /**
   * PIXI.Filter hook: run the filter with FXMaster's lock and scene-rect area.
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
