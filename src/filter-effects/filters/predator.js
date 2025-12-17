import { FXMasterFilterEffectMixin } from "./mixins/filter.js";
import fragment from "./shaders/predator.frag";
import { MAX_EDGES } from "../../constants.js";
import { clampRange, num } from "../../utils.js";

const UI_PERIOD_MAX = 0.1;
const PERIOD_RESPONSE_GAMMA = 1.0;
const SPEED_MAX_PX = 160.0;
const REF_WIDTH_PX = 4.0;
const WIDTH_EXP = 0.75;

/**
 * PredatorFilter
 * --------------
 * Scanline/thermal "predator vision" effect.
 * - Region masks for per-region visibility.
 * - Analytic (rect/ellipse) and polygon fades (SDF/edge-based).
 * - Time-based noise and animated scan motion with width-aware AA.
 */
export class PredatorFilter extends FXMasterFilterEffectMixin(PIXI.Filter) {
  /**
   * Construct a PredatorFilter and initialize uniforms.
   * @param {object} [options={}] - Initial filter options.
   * @param {string} [id] - Stable id for filter instances.
   */
  constructor(options = {}, id) {
    super(options, id, PIXI.Filter.defaultVertex, fragment);

    const u = (this.uniforms ??= {});
    this.initMaskUniforms(u, { withStrength: false });
    this.initFadeUniforms(u);
    this.initRegionFadeUniforms(u, { maxEdges: MAX_EDGES });

    // Screen-space mapping (used for mask & gating)
    this.ensureVec4Uniform("srcFrame", [0, 0, 1, 1]);
    this.ensureVec2Uniform("camFrac", [0, 0]);

    // Effect params
    u.time = 0.0;
    u.seed = Math.random() * 1000.0;
    u.speedPx = 0.0;
    u.lineWidthPx = 3.0;
    u.noiseAmt = 0.1;
    u.contrast = 1.5;
    u.aaPx = 1.0;

    // UI param uniforms
    this._period = 0.0;
    this.period = num(options?.period?.value ?? options?.period, 0.0);
    this.lineWidth = num(options?.lineWidth?.value ?? options?.lineWidth, 3.0);
    this.noise = num(options?.noise?.value ?? options?.noise, 0.1);

    this._tickerFn = null;

    this.configure(options);
  }

  /** i18n label key used by UI. */
  static label = "FXMASTER.Filters.Effects.Predator";

  /** FontAwesome icon class used by UI. */
  static icon = "fas fa-wave-square";

  /**
   * Parameter schema exposed to configuration UIs.
   * @returns {Record<string, object>} Parameter descriptors.
   */
  static get parameters() {
    return {
      belowTokens: { label: "FXMASTER.Params.BelowTokens", type: "checkbox", value: false },
      noise: { label: "FXMASTER.Params.Noise", type: "range", max: 1.0, min: 0.0, step: 0.1, value: 0.1 },
      period: { label: "FXMASTER.Params.Speed", type: "range", max: 0.1, min: 0.0, step: 0.001, value: 0.001 },
      lineWidth: { label: "FXMASTER.Params.LineWidth", type: "range", max: 10.0, min: 0.5, step: 0.5, value: 3.0 },
    };
  }

  /**
   * Neutral (no-op) option values.
   * @returns {{noise:number,period:number,lineWidth:number}}
   */
  static get neutral() {
    return { noise: 0.0, period: 0.0, lineWidth: 3.0 };
  }

  /** @returns {number} Noise amount in [0,1]. */ get noise() {
    return this.uniforms.noiseAmt;
  }
  /** @param {number} v */ set noise(v) {
    this.uniforms.noiseAmt = clampRange(num(v, 0.1), 0.0, 1.0);
  }

  /** @returns {number} UI period in [0, UI_PERIOD_MAX]. */ get period() {
    return this._period;
  }
  /** @param {number} v */ set period(v) {
    this._period = Math.max(0, Math.min(UI_PERIOD_MAX, Number(v) || 0));
    const f = periodNorm(this._period);
    const w = Math.max(1.0, this.uniforms.lineWidthPx || 3.0);
    const wf = Math.pow(w / REF_WIDTH_PX, WIDTH_EXP);
    this.uniforms.speedPx = -(f * SPEED_MAX_PX) * wf;
    this.uniforms.aaPx = aaFrom(this.uniforms.speedPx, w);
  }

  /** @returns {number} Scanline width in CSS px. */ get lineWidth() {
    return this.uniforms.lineWidthPx;
  }
  /** @param {number} v */ set lineWidth(v) {
    const w = Math.max(1.0, Number(v) || 3.0);
    this.uniforms.lineWidthPx = w;
    const f = periodNorm(this._period);
    const wf = Math.pow(w / REF_WIDTH_PX, WIDTH_EXP);
    this.uniforms.speedPx = -(f * SPEED_MAX_PX) * wf;
    this.uniforms.aaPx = aaFrom(this.uniforms.speedPx, w);
  }

  /**
   * Configure filter uniforms and state from options.
   * Accepts direct values or { value } wrappers; updates mask options and fades.
   * @param {object} [options={}] - Options payload.
   */
  configure(options = {}) {
    super.configure(options);
    const o = this.options;

    if (o.noise !== undefined) this.noise = o.noise;
    if (o.period !== undefined) this.period = o.period;
    if (o.lineWidth !== undefined) this.lineWidth = o.lineWidth;

    this.applyFadeOptionsFrom(o);
    this.applyMaskOptionsFrom(o);
  }

  /**
   * Begin playing the effect; installs a ticker to advance time and noise.
   * @param {{skipFading?:boolean}} [opts] - Options and play flags.
   * @returns {this} The filter instance.
   */
  play({ skipFading = true, ...opts } = {}) {
    this.configure(opts);
    this.enabled = true;
    super.play?.({ skipFading, ...opts });

    if (!this._predTick) {
      this._predTick = this.addFilterTicker(
        (deltaMS) => {
          const dt = (deltaMS || 16.6) / 1000.0;
          this.uniforms.time += dt;
          if (this.uniforms.time > 1e6) this.uniforms.time = 0.0;
          this.uniforms.seed += dt * 7.0;
        },
        { units: "s" },
      );
    }
    return this;
  }

  /**
   * Stop the effect: removes ticker, disables filter, and clears mask uniforms.
   * @param {{skipFading?:boolean}} [opts]
   * @returns {Promise<any>|boolean} Awaitable stop result or true.
   */
  async stop({ durationMs = 0, skipFading = true } = {}) {
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

/**
 * Compute anti-alias width based on motion speed and line width.
 * @param {number} speedPx - Motion speed in px/s.
 * @param {number} lineWidthPx - Scanline width in px.
 * @returns {number} AA width in px.
 */
function aaFrom(speedPx, lineWidthPx) {
  const BASE = 0.6,
    EXTRA = 0.004;
  const w = Math.max(1.0, lineWidthPx);
  return Math.max(0.75, BASE * w) + Math.abs(speedPx) * EXTRA;
}

/**
 * Map UI period in [0, UI_PERIOD_MAX] to normalized [0,1] speed factor.
 * @param {number} pUI - UI period.
 * @returns {number} Normalized factor.
 */
function periodNorm(pUI) {
  const t = Math.max(0, Math.min(1, (Number(pUI) || 0) / UI_PERIOD_MAX));
  return Math.pow(t, PERIOD_RESPONSE_GAMMA);
}
