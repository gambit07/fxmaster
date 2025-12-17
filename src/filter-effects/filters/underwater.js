import { FXMasterFilterEffectMixin } from "./mixins/filter.js";
import fragment from "./shaders/underwater.frag";
import { MAX_EDGES } from "../../constants.js";

/** Displacement map used to simulate moving water ripples. */
const MAP_URL = "modules/fxmaster/assets/filter-effects/effects/underwater/displacement-map.webp";

/** Fallback texel size if the displacement map isn't loaded yet. */
const FALLBACK_TEXEL = 1 / 256;

/**
 * UnderwaterFilter
 * ----------------
 * Scene/region displacement-based "underwater" refraction.
 * - Region masks for per-region visibility with uniform strength.
 * - Analytic (rect/ellipse) and polygon fades (SDF/edge-based).
 * - Uses a repeating displacement map with animated offset for motion.
 */
export class UnderwaterFilter extends FXMasterFilterEffectMixin(PIXI.Filter) {
  /**
   * Construct an UnderwaterFilter, initialize map/region uniforms and defaults.
   * @param {object} [options={}] - Initial filter options.
   * @param {string} [id] - Stable id for filter instances.
   */
  constructor(options = {}, id) {
    super({}, id, PIXI.Filter.defaultVertex, fragment);

    const u = (this.uniforms ||= {});
    this.initMaskUniforms(u, { withStrength: true, strengthDefault: 1.0 });
    this.initFadeUniforms(u);
    this.initRegionFadeUniforms(u, { maxEdges: MAX_EDGES });

    // CSS mapping
    this.ensureVec4Uniform("srcFrame", [0, 0, 1, 1]);
    this.ensureVec2Uniform("camFrac", [0, 0]);
    this.ensureVec4Uniform("outputFrame", [0, 0, 1, 1]);

    // Displacement map & sampling controls
    const tex = PIXI.Texture.from(MAP_URL);
    try {
      tex.baseTexture.wrapMode = PIXI.WRAP_MODES.REPEAT;
      if (typeof PIXI.MIPMAP_MODES !== "undefined") tex.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
    } catch {}
    u.mapSampler = tex;
    u.mapScale = u.mapScale || new Float32Array([6.0, 6.0]);
    u.mapRepeat = u.mapRepeat || new Float32Array([1.0, 1.0]);
    u.mapTexel = u.mapTexel || new Float32Array([FALLBACK_TEXEL, FALLBACK_TEXEL]);
    this._phaseX = 0.0;
    this._phaseY = 0.0;
    u.mapOffset = u.mapOffset || new Float32Array([u.mapTexel[0] * 0.5, u.mapTexel[1] * 0.5]);

    u.tokenSampler = u.tokenSampler || PIXI.Texture.EMPTY;
    u.hasTokenMask = typeof u.hasTokenMask === "number" ? u.hasTokenMask : 0.0;
    u.mapWorldPeriod = u.mapWorldPeriod || new Float32Array([1000.0, 1000.0]);
    u.sceneRect = u.sceneRect || new Float32Array([0, 0, 1, 1]);

    const setTexel = () => {
      try {
        const w = tex.baseTexture.realWidth | 0;
        const h = tex.baseTexture.realHeight | 0;
        if (w && h) {
          u.mapTexel = new Float32Array([1 / w, 1 / h]);
          this.#syncOffsetFromPhase();
        }
      } catch {}
    };
    try {
      tex.baseTexture.valid ? setTexel() : tex.baseTexture.once?.("loaded", setTexel);
    } catch {}

    // Animation speed (CSS px per second mapped to uv step)
    this._speed = typeof this._speed === "number" ? this._speed : 30.0;

    super.configure(options);
    this.applyOptions(this.options);
  }

  /** i18n label key used by UI. */
  static label = "FXMASTER.Filters.Effects.Underwater";

  /** FontAwesome icon class used by UI. */
  static icon = "fas fa-water";

  /**
   * Parameter schema exposed to configuration UIs.
   * @returns {Record<string, object>} Parameter descriptors.
   */
  static get parameters() {
    return {
      belowTokens: { label: "FXMASTER.Params.BelowTokens", type: "checkbox", value: false },
      speed: { label: "FXMASTER.Params.Speed", type: "range", min: 0.0, max: 200.0, step: 1.0, value: 30.0 },
      scale: { label: "FXMASTER.Params.Scale", type: "range", min: 0.0, max: 32.0, step: 0.5, value: 6.0 },
    };
  }

  /**
   * Neutral (no-op) option values.
   * @returns {{speed:number,scale:number,fadePercent:number}}
   */
  static get neutral() {
    return { speed: 0.0, scale: 0.0, fadePercent: 0.0 };
  }

  /**
   * Apply options to uniforms and state.
   * Accepts direct values or { value } wrappers; updates speed, scale, and fade.
   * @param {object} [opts={}] - Options payload.
   */
  applyOptions(opts = {}) {
    super.applyOptions(opts);
    const o = this.options;

    if (typeof o.speed === "number") this._speed = Math.max(0, o.speed);
    if (typeof o.scale === "number")
      this.uniforms.mapScale = new Float32Array([Math.max(0, o.scale), Math.max(0, o.scale)]);

    this.applyFadeOptionsFrom(o);
  }

  /**
   * Configure the filter from options, then apply options.
   * @param {object} [options={}] - Options payload.
   */
  configure(options = {}) {
    super.configure(options);
    this.applyOptions(this.options);
  }

  /**
   * Begin playing the effect; installs a ticker that advances the displacement phase.
   * @param {{skipFading?:boolean}} [opts] - Options and play flags.
   * @returns {this} The filter instance.
   */
  play({ skipFading = true, ...opts } = {}) {
    this.configure(opts);
    super.play?.({ skipFading, ...opts });

    if (!this._uwTick) {
      this._uwTick = this.addFilterTicker((deltaMS) => {
        const r = canvas?.app?.renderer;
        const wCSS = Math.max(1, r?.screen?.width | 0);
        const dt = (deltaMS ?? 16.6) / 1000.0;

        const stepX = ((this._speed || 0) * dt) / wCSS;
        this._phaseX = (this._phaseX + stepX) % 1;

        this.#syncOffsetFromPhase();
      });
    }
    return this;
  }

  /**
   * Stop the effect and cancel the internal ticker.
   * @param {{skipFading?:boolean}} [opts]
   * @returns {Promise<any>} Awaitable stop result.
   */
  stop({ skipFading = true, ...opts } = {}) {
    this._uwTick?.();
    this._uwTick = null;
    this.#syncOffsetFromPhase();
    return super.stop?.({ skipFading, ...opts });
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

  /**
   * Sync the displacement texture offset from the current phase,
   * accounting for half-texel padding and wrap-safe ranges.
   * @private
   */
  #syncOffsetFromPhase() {
    const u = this.uniforms;
    const hx = (u.mapTexel?.[0] ?? FALLBACK_TEXEL) * 0.5;
    const hy = (u.mapTexel?.[1] ?? FALLBACK_TEXEL) * 0.5;
    const rx = Math.max(1e-6, 1 - 2 * hx);
    const ry = Math.max(1e-6, 1 - 2 * hy);

    const px = this._phaseX - Math.floor(this._phaseX);
    const py = this._phaseY - Math.floor(this._phaseY);

    if (!(u.mapOffset instanceof Float32Array) || u.mapOffset.length < 2) u.mapOffset = new Float32Array(2);
    u.mapOffset[0] = hx + px * rx;
    u.mapOffset[1] = hy + py * ry;
  }
}
