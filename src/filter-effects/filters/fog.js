import fragment from "./shaders/fog.frag";
import customVertex2D from "./shaders/custom-vertex-2d.vert";
import { FXMasterFilterEffectMixin } from "./mixins/filter.js";
import { MAX_EDGES } from "../../constants.js";
import { asFloat3 } from "../../utils.js";

/**
 * FogFilter
 * ---------
 * Scene/region animated fog. Supports:
 * - Region masks and uniform strength (for graceful fades).
 * - Analytic fades (rect/ellipse) and polygon fades (SDF/edge-based).
 * - Tint color, density, scale, and time-based motion.
 */
export class FogFilter extends FXMasterFilterEffectMixin(PIXI.Filter) {
  /**
   * Construct a FogFilter, wiring mask/fade uniforms and default params.
   * @param {object} [options={}] - Initial filter options.
   * @param {string} [id] - Stable id for filter instances.
   */
  constructor(options = {}, id) {
    super(options, id, customVertex2D, fragment);

    const u = (this.uniforms ??= {});
    this.initMaskUniforms(u, { withStrength: true, strengthDefault: 1.0 });
    this.initFadeUniforms(u);
    this.initRegionFadeUniforms(u, { maxEdges: MAX_EDGES });

    this.ensureVec4Uniform("srcFrame", [0, 0, 1, 1]);
    this.ensureVec2Uniform("camFrac", [0, 0]);
    u.viewSize = u.viewSize instanceof Float32Array ? u.viewSize : new Float32Array([1, 1]);

    u.time = typeof u.time === "number" ? u.time : 0.0;
    u.density = typeof u.density === "number" ? u.density : 0.65;
    u.dimensions = u.dimensions instanceof Float32Array ? u.dimensions : new Float32Array([1.0, 1.0]);
    u.color = u.color instanceof Float32Array ? u.color : new Float32Array([0, 0, 0]);

    this._speed = typeof this._speed === "number" ? this._speed : 1.0;

    this.configure(options);
  }

  /** i18n label key used by UI. */
  static label = "FXMASTER.Filters.Effects.Fog";

  /** FontAwesome icon class used by UI. */
  static icon = "fas fa-cloud";

  /**
   * Parameter schema exposed to configuration UIs.
   * @returns {Record<string, object>} Parameter descriptors.
   */
  static get parameters() {
    return {
      belowTokens: { label: "FXMASTER.Params.BelowTokens", type: "checkbox", value: false },
      color: {
        label: "FXMASTER.Params.Tint",
        type: "color",
        value: { value: "#000000", apply: false },
        skipInitialAnimation: true,
      },
      dimensions: {
        label: "FXMASTER.Params.Scale",
        type: "range",
        max: 5,
        min: 0,
        step: 0.1,
        value: 0.1,
        skipInitialAnimation: true,
      },
      speed: {
        label: "FXMASTER.Params.Speed",
        type: "range",
        max: 5,
        min: 0,
        step: 0.1,
        value: 0.5,
        skipInitialAnimation: true,
      },
      density: {
        label: "FXMASTER.Params.Opacity",
        type: "range",
        max: 1,
        min: 0,
        step: 0.05,
        value: 0.5,
        skipInitialAnimation: true,
      },
    };
  }

  /**
   * Neutral (no-op) option values.
   * @returns {{density:number}}
   */
  static get neutral() {
    return { density: 0 };
  }

  /** @returns {number} Red tint channel. */ get r() {
    try {
      return (this.uniforms?.color ?? [0, 0, 0])[0];
    } catch {
      return 0;
    }
  }
  /** @param {number} v */ set r(v) {
    try {
      (this.uniforms.color ??= new Float32Array([0, 0, 0]))[0] = Number(v) || 0;
    } catch {}
  }
  /** @returns {number} Green tint channel. */ get g() {
    try {
      return (this.uniforms?.color ?? [0, 0, 0])[1];
    } catch {
      return 0;
    }
  }
  /** @param {number} v */ set g(v) {
    try {
      (this.uniforms.color ??= new Float32Array([0, 0, 0]))[1] = Number(v) || 0;
    } catch {}
  }
  /** @returns {number} Blue tint channel. */ get b() {
    try {
      return (this.uniforms?.color ?? [0, 0, 0])[2];
    } catch {
      return 0;
    }
  }
  /** @param {number} v */ set b(v) {
    try {
      (this.uniforms.color ??= new Float32Array([0, 0, 0]))[2] = Number(v) || 0;
    } catch {}
  }

  /** @returns {number} Fog density in [0,1]. */ get density() {
    try {
      return typeof this.uniforms?.density === "number" ? this.uniforms.density : 0;
    } catch {
      return 0;
    }
  }
  /** @param {number} v */ set density(v) {
    try {
      const u = this.uniforms;
      if (u) u.density = Math.max(0, Math.min(1, Number(v) || 0));
    } catch {}
  }

  /** @returns {number} Fog scale (grid-relative). */ get dimensions() {
    try {
      return this.uniforms?.dimensions ? this.uniforms.dimensions[0] : 1;
    } catch {
      return 1;
    }
  }
  /** @param {number} value */ set dimensions(value) {
    try {
      const grid = canvas?.dimensions?.size ?? 100;
      const scaled = ((Number(value) || 0) * 100) / grid;
      (this.uniforms.dimensions ??= new Float32Array(2))[0] = Math.max(0, scaled);
      this.uniforms.dimensions[1] = Math.max(0, scaled);
    } catch {}
  }

  /** @returns {number} Animation speed scalar. */ get speed() {
    return this._speed;
  }
  /** @param {number} v */ set speed(v) {
    this._speed = Math.max(0, Number(v) || 0);
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
   * Apply resolved tint payload to uniforms — but only if the payload
   * actually contains tint info. Region-layer rebases (bounds-only)
   * must NOT clobber a previously chosen tint.
   * @param {{rgb:Float32Array|null,hasRGB:boolean,enabled:boolean|undefined}} payload
   * @private
   */
  _applyTintUniforms({ rgb, hasRGB, enabled }) {
    const u = (this.uniforms ??= {});
    const hasToggle = enabled !== undefined;
    if (!hasRGB && !hasToggle) return;

    if (hasRGB && rgb) this._tintRGB = asFloat3(rgb);
    if (hasToggle) this._tintEnabled = !!enabled;

    const wantTint = hasToggle ? this._tintEnabled : hasRGB ? true : this._tintEnabled ?? false;

    const out = wantTint ? this._tintRGB ?? new Float32Array([1, 1, 1]) : new Float32Array([0, 0, 0]);

    u.color ??= new Float32Array(3);
    u.color[0] = out[0];
    u.color[1] = out[1];
    u.color[2] = out[2];
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

    if (typeof options.density === "number") this.density = options.density;
    if (typeof options.dimensions === "number") this.dimensions = options.dimensions;
    if (typeof options.speed === "number") this.speed = options.speed;

    this.applyFadeOptionsFrom(options);

    if (options.belowTokens !== undefined) {
      try {
        this.options.belowTokens = !!options.belowTokens;
      } catch {}
    }

    super.applyOptions(options);
  }

  /**
   * Configure the filter from options (tint, density/scale/speed, fades).
   * Accepts hex, or { value, apply } for tint.
   * @param {object} [options={}] - Options payload.
   */
  configure(options = {}) {
    super.configure(options);
    this.applyOptions(options);
  }

  /**
   * Begin playing the effect; advances time with an internal ticker.
   * @param {{skipFading?:boolean}} [opts] - Options and play flags.
   * @returns {this} The filter instance.
   */
  play({ skipFading = true, ...opts } = {}) {
    this.configure(opts);
    super.play?.({ skipFading, ...opts });

    if (!this._fogTick) {
      this._fogTick = this.addFilterTicker((deltaMS) => {
        try {
          const dt = deltaMS ?? 16.6;
          const u = this.uniforms;
          if (!u) return;
          u.time = (typeof u.time === "number" ? u.time : 0) + dt * this.speed * 0.1;
          if (u.time > 1e9) u.time = 0;
        } catch {}
      });
    }
    return this;
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
   * PIXI.Filter hook: sync matrices and apply with scene-rect locking.
   * @param {PIXI.FilterSystem} filterManager - Filter system.
   * @param {PIXI.RenderTexture} input - Input texture.
   * @param {PIXI.RenderTexture} output - Output texture.
   * @param {PIXI.CLEAR_MODES|boolean} clear - Clear flag.
   * @param {object} currentState - Filter state.
   * @returns {void}
   */
  apply(filterManager, input, output, clear, currentState) {
    (this.uniforms.filterMatrix ??= new PIXI.Matrix()).copyFrom(currentState.target.worldTransform).invert();
    this.lockAndSync(filterManager, currentState, { area: "sceneRect" });
    return super.apply(filterManager, input, output, clear, currentState);
  }
}
