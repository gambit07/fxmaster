import { FXMasterFilterEffectMixin, preprocessShader } from "../mixins/filter.js";
import fragment from "../shaders/predator.frag";
import { MAX_EDGES } from "../../constants.js";
import { clampRange, num } from "../../utils.js";
import {
  repaintTokensMaskInto,
  getCssViewportMetrics,
  safeResolutionForCssArea,
  snappedStageMatrix,
} from "../../utils/index.js";
import { renderTextureMatches } from "../../utils/render-textures.js";

const INTERNAL_SPEED_MAX = 0.1;
const INTERNAL_SPEED_DEFAULT = 0.03;
const SPEED_RESPONSE_GAMMA = 1.0;
const SPEED_MAX_WORLD_PX = 160.0;
const REF_WIDTH_WORLD_PX = 4.0;
const WIDTH_EXP = 0.75;
const INTERNAL_LINE_WIDTH_MIN = 0.5;
const INTERNAL_LINE_WIDTH_MAX = 20.0;
const NORMALIZED_LINE_WIDTH_DEFAULT = 0.5;
const INTERNAL_LINE_WIDTH_DEFAULT =
  INTERNAL_LINE_WIDTH_MIN + NORMALIZED_LINE_WIDTH_DEFAULT * (INTERNAL_LINE_WIDTH_MAX - INTERNAL_LINE_WIDTH_MIN);

/** Applies an animated, world-locked thermal scan treatment. */
export class PredatorFilter extends FXMasterFilterEffectMixin(PIXI.Filter) {
  /**
   * Construct a PredatorFilter and initialize uniforms.
   * @param {object} [options={}] - Initial filter options.
   * @param {string} [id] - Stable id for filter instances.
   */
  constructor(options = {}, id) {
    options = discardFormerPeriodOption(options);
    super(options, id, PIXI.Filter.defaultVertexSrc, preprocessShader(fragment));

    const u = (this.uniforms ??= {});
    this.initMaskUniforms(u, { withStrength: true });
    this.initFadeUniforms(u);
    this.initRegionFadeUniforms(u, { maxEdges: MAX_EDGES });

    this.ensureVec4Uniform("srcFrame", [0, 0, 1, 1]);
    this.ensureVec2Uniform("camFrac", [0, 0]);

    u.time = 0.0;
    u.seed = Math.random() * 1000.0;
    u.speedWorld = 0.0;
    u.lineWidthWorld = INTERNAL_LINE_WIDTH_DEFAULT;
    u.noiseAmt = 0.0;
    u.scanlineStrength = 1.0;
    u.thermalStrength = 0.0;
    u.tokenHeatSeek = 0.0;
    u.tokenHeatReady = 0.0;
    u.tokenHeatSampler = PIXI.Texture.EMPTY;
    u.uHeatUvFromWorld = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    u.thermalContrast = 0.0;
    u.edgeDefinition = 0.0;
    u.stripeContrast = 1.5;
    u.aaCssPx = 1.0;

    this._speed = 0.0;
    this.speed = num(this.options?.speed, INTERNAL_SPEED_DEFAULT);
    this.lineWidth = num(this.options?.lineWidth, INTERNAL_LINE_WIDTH_DEFAULT);
    this.noise = num(this.options?.noise, 0.0);
    this.scanlineStrength = num(this.options?.scanlineStrength, 1.0);
    this.thermalStrength = num(this.options?.thermalStrength, 0.0);
    this.thermalContrast = num(this.options?.thermalContrast, 0.0);
    this.edgeDefinition = num(this.options?.edgeDefinition, 0.0);

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
      belowTiles: { label: "FXMASTER.Params.BelowTiles", type: "checkbox", value: false },
      soundFxEnabled: { label: "FXMASTER.Params.SoundFxEnabled", type: "checkbox", value: false },
      tokenHeatSeek: {
        label: "FXMASTER.Params.TokenHeatSeek",
        tooltip: "FXMASTER.ParamTooltips.PredatorTokenHeatSeek",
        type: "checkbox",
        value: false,
      },
      tokenHeatSeekDispositions: {
        label: "FXMASTER.Params.TokenHeatSeekDispositions",
        tooltip: "FXMASTER.ParamTooltips.PredatorTokenHeatSeekDispositions",
        type: "multi-select",
        options: {
          friendly: "TOKEN.DISPOSITION.FRIENDLY",
          neutral: "TOKEN.DISPOSITION.NEUTRAL",
          hostile: "TOKEN.DISPOSITION.HOSTILE",
          secret: "TOKEN.DISPOSITION.SECRET",
        },
        value: ["friendly", "neutral", "hostile", "secret"],
        allowEmpty: false,
        showWhen: { tokenHeatSeek: true },
      },
      thermalStrength: {
        hideWhen: { tokenHeatSeek: true },
        label: "FXMASTER.Params.ThermalStrength",
        type: "range",
        max: 1.0,
        min: 0.0,
        step: 0.05,
        value: 0.0,
        tooltip: "FXMASTER.ParamTooltips.PredatorThermalStrength",
      },
      thermalContrast: {
        label: "FXMASTER.Params.ThermalContrast",
        type: "range",
        max: 1.0,
        min: 0.0,
        step: 0.05,
        value: 0.0,
        tooltip: "FXMASTER.ParamTooltips.PredatorThermalContrast",
      },
      edgeDefinition: {
        label: "FXMASTER.Params.EdgeDefinition",
        type: "range",
        max: 1.0,
        min: 0.0,
        step: 0.05,
        value: 0.0,
        tooltip: "FXMASTER.ParamTooltips.PredatorEdgeDefinition",
      },
      scanlineStrength: {
        label: "FXMASTER.Params.ScanlineStrength",
        type: "range",
        max: 1.0,
        min: 0.0,
        step: 0.05,
        value: 1.0,
        tooltip: "FXMASTER.ParamTooltips.PredatorScanlineStrength",
      },
      noise: {
        label: "FXMASTER.Params.SensorNoise",
        type: "range",
        max: 1.0,
        min: 0.0,
        step: 0.1,
        value: 0.0,
        tooltip: "FXMASTER.ParamTooltips.PredatorNoise",
      },
      speed: {
        label: "FXMASTER.Params.ScanlineSpeed",
        type: "range",
        max: INTERNAL_SPEED_MAX,
        min: 0.0,
        step: 0.001,
        value: INTERNAL_SPEED_DEFAULT,
        tooltip: "FXMASTER.ParamTooltips.PredatorSpeed",
      },
      lineWidth: {
        label: "FXMASTER.Params.ScanlineWidth",
        type: "range",
        min: 0.0,
        max: 1.0,
        step: 0.01,
        decimals: 2,
        value: NORMALIZED_LINE_WIDTH_DEFAULT,
        tooltip: "FXMASTER.ParamTooltips.PredatorLineWidth",
        __fxmInternalRange: {
          min: INTERNAL_LINE_WIDTH_MIN,
          max: INTERNAL_LINE_WIDTH_MAX,
          value: INTERNAL_LINE_WIDTH_DEFAULT,
          step: 0.5,
          decimals: 1,
        },
      },
    };
  }

  /**
   * Neutral option values.
   * @returns {Record<string, number>} Neutral parameter values.
   */
  static get neutral() {
    return {
      noise: 0.0,
      speed: 0.0,
      lineWidth: INTERNAL_LINE_WIDTH_DEFAULT,
      scanlineStrength: 0.0,
      thermalStrength: 0.0,
      thermalContrast: 0.0,
      edgeDefinition: 0.0,
    };
  }

  /** @returns {number} Noise amount in [0,1]. */
  get noise() {
    return this.uniforms.noiseAmt;
  }

  /** @param {number} value */
  set noise(value) {
    this.uniforms.noiseAmt = clampRange(num(value, 0.0), 0.0, 1.0);
  }

  /** @returns {number} Scanline intensity in [0,1]. */
  get scanlineStrength() {
    return this.uniforms.scanlineStrength;
  }

  /** @param {number} value */
  set scanlineStrength(value) {
    this.uniforms.scanlineStrength = clampRange(num(value, 1.0), 0.0, 1.0);
  }

  /** @returns {number} False-color thermal blend in [0,1]. */
  get thermalStrength() {
    return this.uniforms.thermalStrength;
  }

  /** @param {number} value */
  set thermalStrength(value) {
    this.uniforms.thermalStrength = clampRange(num(value, 0.0), 0.0, 1.0);
  }

  /** @returns {number} Thermal contrast in [0,1]. */
  get thermalContrast() {
    return this.uniforms.thermalContrast;
  }

  /** @param {number} value */
  set thermalContrast(value) {
    this.uniforms.thermalContrast = clampRange(num(value, 0.0), 0.0, 1.0);
  }

  /** @returns {number} Thermal edge emphasis in [0,1]. */
  get edgeDefinition() {
    return this.uniforms.edgeDefinition;
  }

  /** @param {number} value */
  set edgeDefinition(value) {
    this.uniforms.edgeDefinition = clampRange(num(value, 0.0), 0.0, 1.0);
  }

  /** @returns {number} Effective scan speed in [0, INTERNAL_SPEED_MAX]. */
  get speed() {
    return this._speed;
  }

  /** @param {number} value */
  set speed(value) {
    this._speed = Math.max(0, Math.min(INTERNAL_SPEED_MAX, Number(value) || 0));
    const factor = speedNorm(this._speed);
    const width = Math.max(1.0, this.uniforms.lineWidthWorld || INTERNAL_LINE_WIDTH_DEFAULT);
    const widthFactor = Math.pow(width / REF_WIDTH_WORLD_PX, WIDTH_EXP);
    this.uniforms.speedWorld = -(factor * SPEED_MAX_WORLD_PX) * widthFactor;
    this.uniforms.aaCssPx = aaFrom(this.uniforms.speedWorld, width);
  }

  /** @returns {number} Scanline width in world pixels. */
  get lineWidth() {
    return this.uniforms.lineWidthWorld;
  }

  /** @param {number} value */
  set lineWidth(value) {
    const numeric = Number(value);
    const width = Number.isFinite(numeric)
      ? Math.max(INTERNAL_LINE_WIDTH_MIN, Math.min(INTERNAL_LINE_WIDTH_MAX, numeric))
      : INTERNAL_LINE_WIDTH_DEFAULT;
    this.uniforms.lineWidthWorld = width;
    const factor = speedNorm(this._speed);
    const widthFactor = Math.pow(width / REF_WIDTH_WORLD_PX, WIDTH_EXP);
    this.uniforms.speedWorld = -(factor * SPEED_MAX_WORLD_PX) * widthFactor;
    this.uniforms.aaCssPx = aaFrom(this.uniforms.speedWorld, width);
  }

  /**
   * Configure filter uniforms and state from options.
   * @param {object} [options={}] - Options payload.
   */
  configure(options = {}) {
    super.configure(discardFormerPeriodOption(options));
    const prepared = this.options;

    if (prepared.noise !== undefined) this.noise = prepared.noise;
    if (prepared.speed !== undefined) this.speed = prepared.speed;
    if (prepared.lineWidth !== undefined) this.lineWidth = prepared.lineWidth;
    if (prepared.scanlineStrength !== undefined) this.scanlineStrength = prepared.scanlineStrength;
    if (prepared.thermalStrength !== undefined) this.thermalStrength = prepared.thermalStrength;
    if (prepared.thermalContrast !== undefined) this.thermalContrast = prepared.thermalContrast;
    if (prepared.edgeDefinition !== undefined) this.edgeDefinition = prepared.edgeDefinition;

    this.uniforms.tokenHeatSeek = prepared.tokenHeatSeek ? 1 : 0;
    const raw = prepared.tokenHeatSeekDispositions;
    const selected = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
    const names = { friendly: 1, neutral: 0, hostile: -1, secret: -2 };
    this._heatDispositions = new Set(selected.filter((name) => Object.hasOwn(names, name)).map((name) => names[name]));
    if (!this._heatDispositions.size) this._heatDispositions = new Set(Object.values(names));
    if (!prepared.tokenHeatSeek) this._releaseTokenHeatMask();

    this.applyFadeOptionsFrom(prepared);
    this.applyMaskOptionsFrom(prepared);
  }

  /**
   * Begin playing the effect and advance its animation state.
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
          this._refreshTokenHeatMask();
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
   * Stop the effect and clear its active state.
   * @param {{durationMs?:number,skipFading?:boolean}} [opts]
   * @returns {Promise<any>|boolean} Awaitable stop result or true.
   */
  async stop({ durationMs = 3000, skipFading } = {}) {
    return this.stopWithUniformFade({
      uniformKey: "strength",
      durationMs,
      skipFading,
      onDone: () => {
        this._predTick = null;
        this._releaseTokenHeatMask();
      },
    });
  }

  /** Refresh visible token silhouettes before the filter is rendered. */
  _refreshTokenHeatMask() {
    const uniforms = this.uniforms;
    if (!uniforms?.tokenHeatSeek || !this.enabled || !canvas?.ready) return;
    const { cssW, cssH } = getCssViewportMetrics();
    const width = Math.max(1, Math.ceil(cssW));
    const height = Math.max(1, Math.ceil(cssH));
    const resolution = safeResolutionForCssArea(width, height);
    let texture = this._tokenHeatTexture;
    if (!texture?.baseTexture?.valid || !renderTextureMatches(texture, width, height, resolution)) {
      this._releaseTokenHeatMask();
      texture = this._tokenHeatTexture = PIXI.RenderTexture.create({ width, height, resolution });
      texture.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
      texture.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
    }
    this._heatTokenPredicate ??= (token) =>
      token?.isVisible !== false &&
      token?.visible !== false &&
      !token?.document?.hidden &&
      this._heatDispositions.has(Number(token?.document?.disposition));
    repaintTokensMaskInto(texture, { shouldIncludeToken: this._heatTokenPredicate });
    const matrix = snappedStageMatrix();
    const uv = uniforms.uHeatUvFromWorld;
    uv[0] = matrix.a / texture.width;
    uv[1] = matrix.b / texture.height;
    uv[3] = matrix.c / texture.width;
    uv[4] = matrix.d / texture.height;
    uv[6] = matrix.tx / texture.width;
    uv[7] = matrix.ty / texture.height;
    uniforms.tokenHeatSampler = texture;
    uniforms.tokenHeatReady = 1;
  }

  /** Release the optional heat mask without destroying shared token textures. */
  _releaseTokenHeatMask() {
    if (this.uniforms) {
      this.uniforms.tokenHeatSampler = PIXI.Texture.EMPTY;
      this.uniforms.tokenHeatReady = 0;
    }
    this._tokenHeatTexture?.destroy(true);
    this._tokenHeatTexture = null;
  }

  /** @override */
  destroy(options) {
    this._releaseTokenHeatMask();
    super.destroy(options);
  }

  /**
   * Apply the filter to the active rendering area.
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
 * Remove obsolete Predator period data so the current Speed default is used.
 * @param {object|null|undefined} options
 * @returns {object}
 */
function discardFormerPeriodOption(options) {
  if (!options || typeof options !== "object" || !Object.hasOwn(options, "period")) return options;
  const prepared = { ...options };
  delete prepared.period;
  return prepared;
}

/**
 * Compute anti-alias width from motion speed and line width.
 * @param {number} speedWorld - Motion speed in world pixels per second.
 * @param {number} lineWidthWorld - Scanline width in world pixels.
 * @returns {number} Anti-alias width in CSS pixels.
 */
function aaFrom(speedWorld, lineWidthWorld) {
  const base = 0.6;
  const extra = 0.004;
  const width = Math.max(INTERNAL_LINE_WIDTH_MIN, lineWidthWorld);
  return Math.max(0.75, base * Math.sqrt(width)) + Math.abs(speedWorld) * extra;
}

/**
 * Map the effective speed value to a normalized motion factor.
 * @param {number} value - Effective speed value.
 * @returns {number} Normalized factor.
 */
function speedNorm(value) {
  const normalized = Math.max(0, Math.min(1, (Number(value) || 0) / INTERNAL_SPEED_MAX));
  return Math.pow(normalized, SPEED_RESPONSE_GAMMA);
}
