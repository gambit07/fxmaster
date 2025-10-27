import { FXMasterFilterEffectMixin } from "./mixins/filter.js";
import fragment from "./shaders/color.frag";
import { MAX_EDGES } from "../../constants.js";
import { clampMin, clampNonNeg, asFloat3 } from "../../utils.js";

/**
 * ColorFilter
 * -----------
 * Scene/region color grading with optional tint. Supports:
 * - Region masks and uniform strength (for graceful fades).
 * - Analytic fades (rect/ellipse) and polygon fades (SDF/edge-based).
 * - Saturation/contrast/brightness/gamma and optional tint override.
 * - Below Tokens (via managers): when options.belowTokens=true the managers feed a
 *   token-cutout mask so the filter does not affect tokens.
 */
export class ColorFilter extends FXMasterFilterEffectMixin(PIXI.Filter) {
  /**
   * Construct a ColorFilter, wiring mask and fade uniforms and default params.
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
    // Mask + strength for fade-out on removal
    this.initMaskUniforms(u, { withStrength: true, strengthDefault: 1.0 });
    this.initFadeUniforms(u);
    this.initRegionFadeUniforms(u, { maxEdges: MAX_EDGES });

    // Pipeline consistency uniforms
    this.ensureVec4Uniform("srcFrame", [0, 0, 1, 1]);
    this.ensureVec2Uniform("camFrac", [0, 0]);

    // Color/tone defaults
    u.red = typeof u.red === "number" ? u.red : 1.0;
    u.green = typeof u.green === "number" ? u.green : 1.0;
    u.blue = typeof u.blue === "number" ? u.blue : 1.0;
    u.brightness = typeof u.brightness === "number" ? u.brightness : 1.0;
    u.contrast = typeof u.contrast === "number" ? u.contrast : 1.0;
    u.saturation = typeof u.saturation === "number" ? u.saturation : 1.0;
    u.gamma = typeof u.gamma === "number" ? u.gamma : 1.0;

    this._tintRGB = asFloat3([1, 1, 1]);
    this._tintEnabled = false;

    this.configure(options);
  }

  /** i18n label key used by UI. */
  static label = "FXMASTER.Filters.Effects.Color";

  /** FontAwesome icon class used by UI. */
  static icon = "fas fa-palette";

  /**
   * Parameter schema exposed to configuration UIs.
   * Note: `belowTokens` is used by the managers to route a token-cutout mask
   *       to this filter; the shader itself does not change.
   * @returns {Record<string, object>} Parameter descriptors.
   */
  static get parameters() {
    return {
      belowTokens: { label: "FXMASTER.Params.BelowTokens", type: "checkbox", value: false },
      color: {
        label: "FXMASTER.Params.Tint",
        type: "color",
        value: { value: "#ffffff", apply: false },
        skipInitialAnimation: true,
      },
      saturation: { label: "FXMASTER.Params.Saturation", type: "range", max: 2.0, min: 0.0, step: 0.1, value: 1.0 },
      contrast: { label: "FXMASTER.Params.Contrast", type: "range", max: 2.0, min: 0.0, step: 0.1, value: 1.0 },
      brightness: { label: "FXMASTER.Params.Brightness", type: "range", max: 2.0, min: 0.0, step: 0.1, value: 1.0 },
      gamma: { label: "FXMASTER.Params.Gamma", type: "range", max: 2.0, min: 0.0, step: 0.1, value: 1.0 },
    };
  }

  /**
   * Neutral (no-op) option values.
   * @returns {{saturation:number,contrast:number,brightness:number,gamma:number,fadePercent:number}}
   */
  static get neutral() {
    return { saturation: 1, contrast: 1, brightness: 1, gamma: 1, fadePercent: 0 };
  }

  /**
   * Internal helper to set a uniform with optional clamping.
   * @param {string} key - Uniform key.
   * @param {any} val - Value.
   * @param {(v:any)=>any} [clampFn] - Optional clamp function.
   * @private
   */
  _setUniform(key, val, clampFn) {
    const x = clampFn ? clampFn(val) : val;
    if (x === undefined) return;
    try {
      if (this.uniforms) this.uniforms[key] = x;
    } catch {}
  }

  /** @returns {number} Red multiplier. */ get red() {
    try {
      return this.uniforms.red;
    } catch {
      return 1;
    }
  }
  /** @param {number} v */ set red(v) {
    this._setUniform("red", Math.min(Math.max(Number(v) || 0, 0), 2));
  }

  /** @returns {number} Green multiplier. */ get green() {
    try {
      return this.uniforms.green;
    } catch {
      return 1;
    }
  }
  /** @param {number} v */ set green(v) {
    this._setUniform("green", Math.min(Math.max(Number(v) || 0, 0), 2));
  }

  /** @returns {number} Blue multiplier. */ get blue() {
    try {
      return this.uniforms.blue;
    } catch {
      return 1;
    }
  }
  /** @param {number} v */ set blue(v) {
    this._setUniform("blue", Math.min(Math.max(Number(v) || 0, 0), 2));
  }

  /** @returns {number} Brightness. */ get brightness() {
    try {
      return this.uniforms.brightness;
    } catch {
      return 1;
    }
  }
  /** @param {number} v */ set brightness(v) {
    this._setUniform("brightness", v, (n) => clampMin(Number(n)));
  }

  /** @returns {number} Contrast. */ get contrast() {
    try {
      return this.uniforms.contrast;
    } catch {
      return 1;
    }
  }
  /** @param {number} v */ set contrast(v) {
    this._setUniform("contrast", clampNonNeg(Number(v)));
  }

  /** @returns {number} Saturation. */ get saturation() {
    try {
      return this.uniforms.saturation;
    } catch {
      return 1;
    }
  }
  /** @param {number} v */ set saturation(v) {
    this._setUniform("saturation", clampNonNeg(Number(v)));
  }

  /** @returns {number} Gamma. */ get gamma() {
    try {
      return this.uniforms.gamma;
    } catch {
      return 1;
    }
  }
  /** @param {number} v */ set gamma(v) {
    this._setUniform("gamma", clampMin(Number(v), 0.0001));
  }

  /**
   * Resolve tint color and enabled-flag from options.
   * Accepts { value, apply } objects or raw hex strings.
   * @param {object} [options={}] - Options payload.
   * @returns {{rgb:Float32Array|null,hasRGB:boolean,enabled:boolean|undefined}}
   * @private
   */
  _resolveTintFromOptions(options = {}) {
    let rgb = null,
      hasRGB = false,
      enabled;
    const pickApply = (obj) => (obj && typeof obj.apply === "boolean" ? obj.apply : undefined);

    if (options.color && typeof options.color === "object" && "value" in options.color) {
      const parsed = this.parseColorOption(options.color, { defaultHex: "#ffffff" });
      if (parsed) {
        rgb = parsed;
        hasRGB = true;
      }
      enabled = pickApply(options.color);
    }
    if (!hasRGB) {
      const flat = typeof options.color === "string" ? options.color : undefined;
      if (flat) {
        const parsed = this.parseColorOption(flat, { defaultHex: "#ffffff" });
        if (parsed) {
          rgb = parsed;
          hasRGB = true;
        }
      }
    }
    return { rgb, hasRGB, enabled };
  }

  /**
   * Apply resolved tint payload to uniforms.
   * @param {{rgb:Float32Array|null,hasRGB:boolean,enabled:boolean|undefined}} payload
   * @private
   */
  _applyTintUniforms({ rgb, hasRGB, enabled }) {
    if (hasRGB && rgb) this._tintRGB = asFloat3(rgb);
    if (enabled !== undefined) this._tintEnabled = !!enabled;

    if (this._tintEnabled) {
      this._setUniform("red", this._tintRGB[0]);
      this._setUniform("green", this._tintRGB[1]);
      this._setUniform("blue", this._tintRGB[2]);
    } else {
      this._setUniform("red", 1.0);
      this._setUniform("green", 1.0);
      this._setUniform("blue", 1.0);
    }
  }

  /**
   * Apply options to uniforms and state (mask, tint, scalars, fade).
   * Preserves existing fade when not supplied.
   * @param {object} [options=this.options] - Options payload.
   */
  applyOptions(options = this.options) {
    if (!options || typeof options !== "object") return;

    this.applyMaskOptionsFrom(options);
    this._applyTintUniforms(this._resolveTintFromOptions(options));

    if (options.brightness !== undefined) this.brightness = clampMin(Number(options.brightness), 0.0);
    if (options.contrast !== undefined) this.contrast = clampNonNeg(Number(options.contrast));
    if (options.saturation !== undefined) this.saturation = clampNonNeg(Number(options.saturation));
    if (options.gamma !== undefined) this.gamma = clampMin(Number(options.gamma), 0.0001);

    this.applyFadeOptionsFrom(options);

    if (options.belowTokens !== undefined) {
      try {
        this.options.belowTokens = !!options.belowTokens;
      } catch {}
    }

    super.applyOptions(options);
  }

  /**
   * Configure the filter from options, then apply options.
   * @param {object} [options={}] - Options payload.
   */
  configure(options = {}) {
    super.configure(options);
    this.applyOptions(options);
  }

  /**
   * Begin playing the effect; enables strength and respects skipFading.
   * @param {object} [opts={}] - Options payload and play flags.
   * @returns {any} Return value from base play.
   */
  play(opts = {}) {
    try {
      this.configure(opts);
    } catch {}
    this._setUniform("strength", 1.0);
    return super.play?.({ skipFading: true, ...opts });
  }

  /**
   * Stop the effect, fading the strength uniform unless skipFading is true.
   * @param {{durationMs?:number,skipFading?:boolean}} [opts]
   * @returns {Promise<any>} Awaitable stop result.
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
