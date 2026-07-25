import fragment from "./shaders/fog.frag";
import { MAX_EDGES } from "../../constants.js";
import customVertex2D from "./shaders/custom-vertex-2d.vert";
import { FXMasterFilterEffectMixin, preprocessShader } from "./mixins/filter.js";
import {
  _belowTilesEnabled,
  _belowTokensEnabled,
  asFloat3,
  geometricDirectionToCanvasVector,
  normalizeDirectionDegrees,
} from "../../utils.js";
import { logger } from "../../logger.js";

const FOG_FILTER_TRAIL_TEXELS_PER_GRID = 40;
const FOG_FILTER_TRAIL_TEXTURE_MIN = 128;
const FOG_FILTER_TRAIL_TEXTURE_MAX = 3072;
const FOG_FILTER_TRAIL_SAMPLE_INTERVAL_MS = 33;
const FOG_FILTER_TRAIL_REDRAW_INTERVAL_MS = 50;
const FOG_FILTER_TRAIL_MAX_SEGMENTS = 112;
const FOG_FILTER_TRAIL_TELEPORT_GRID_SPACES = 8;

function fogFilterClamp(value, min, max, fallback = min) {
  const n = Number(value);
  const safe = Number.isFinite(n) ? n : fallback;
  return Math.max(min, Math.min(max, safe));
}

function fogFilterOptionValue(value, fallback = undefined) {
  if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "value")) return value.value;
  return value === undefined ? fallback : value;
}

function fogFilterOptionEnabled(value) {
  const raw = fogFilterOptionValue(value, false);
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (!normalized || ["false", "0", "off", "no"].includes(normalized)) return false;
    if (["true", "1", "on", "yes"].includes(normalized)) return true;
  }
  if (typeof raw === "number") return raw > 0;
  return raw === true;
}

function fogFilterNowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function fogFilterEmptyTexture() {
  return globalThis.PIXI?.Texture?.EMPTY ?? globalThis.PIXI?.Texture?.WHITE ?? null;
}

function fogFilterDestroyTexture(texture) {
  try {
    texture?.destroy?.(true);
  } catch (_err) {
    try {
      texture?.destroy?.();
    } catch (_innerErr) {}
  }
}

function fogFilterUpdateTexture(texture) {
  texture?.baseTexture?.update?.();
  texture?.source?.update?.();
}

function fogFilterSceneBounds() {
  const d = globalThis.canvas?.dimensions;
  const rect = d?.sceneRect;
  if (rect && Number.isFinite(rect.x) && Number.isFinite(rect.y) && rect.width > 0 && rect.height > 0) {
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }
  const sceneX = Number(d?.sceneX ?? 0);
  const sceneY = Number(d?.sceneY ?? 0);
  const sceneWidth = Number(d?.sceneWidth ?? d?.width ?? 0);
  const sceneHeight = Number(d?.sceneHeight ?? d?.height ?? 0);
  if (sceneWidth > 0 && sceneHeight > 0) return { x: sceneX, y: sceneY, width: sceneWidth, height: sceneHeight };
  return null;
}

function fogFilterTokenId(token) {
  return String(token?.document?.uuid ?? token?.document?.id ?? token?.id ?? token?.objectId ?? "");
}

function fogFilterTokenVisible(token) {
  if (!token || token.destroyed) return false;
  if (token.document?.hidden) return false;
  if (token.visible === false) return false;
  if (token.alpha === 0) return false;
  return true;
}

function fogFilterTokenCenter(token) {
  const c = token?.center;
  const cx = Number(c?.x);
  const cy = Number(c?.y);
  if (Number.isFinite(cx) && Number.isFinite(cy)) return { x: cx, y: cy };
  const grid = Number(globalThis.canvas?.dimensions?.size) || 100;
  const x = Number(token?.document?.x ?? token?.x);
  const y = Number(token?.document?.y ?? token?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const docWidth = Number(token?.document?.width);
  const docHeight = Number(token?.document?.height);
  const w = Number(token?.w ?? token?.width ?? (Number.isFinite(docWidth) && docWidth > 0 ? docWidth * grid : grid));
  const h = Number(
    token?.h ?? token?.height ?? (Number.isFinite(docHeight) && docHeight > 0 ? docHeight * grid : grid),
  );
  return {
    x: x + (Number.isFinite(w) && w > 0 ? w : grid) * 0.5,
    y: y + (Number.isFinite(h) && h > 0 ? h : grid) * 0.5,
  };
}

function fogFilterTokenFootprint(token) {
  const grid = Number(globalThis.canvas?.dimensions?.size) || 100;
  const docWidth = Number(token?.document?.width);
  const docHeight = Number(token?.document?.height);
  const w = Number(token?.w ?? token?.width ?? (Number.isFinite(docWidth) && docWidth > 0 ? docWidth * grid : grid));
  const h = Number(
    token?.h ?? token?.height ?? (Number.isFinite(docHeight) && docHeight > 0 ? docHeight * grid : grid),
  );
  return Math.max(grid * 0.35, Number.isFinite(w) && w > 0 ? w : grid, Number.isFinite(h) && h > 0 ? h : grid);
}

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
    super(options, id, customVertex2D, preprocessShader(fragment));

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
    u.uFogDirection = u.uFogDirection instanceof Float32Array ? u.uFogDirection : new Float32Array([1, 0]);
    u.uFogTrailTexture = u.uFogTrailTexture ?? fogFilterEmptyTexture();
    u.uFogTrailsEnabled = typeof u.uFogTrailsEnabled === "number" ? u.uFogTrailsEnabled : 0.0;
    u.uFogTrailStrength = typeof u.uFogTrailStrength === "number" ? u.uFogTrailStrength : 0.0;
    u.uFogTrailTime = typeof u.uFogTrailTime === "number" ? u.uFogTrailTime : 0.0;
    u.uFogTrailRefillProgress = typeof u.uFogTrailRefillProgress === "number" ? u.uFogTrailRefillProgress : 0.0;
    u.uFogTrailBounds = u.uFogTrailBounds instanceof Float32Array ? u.uFogTrailBounds : new Float32Array([0, 0, 1, 1]);
    u.uFogTrailTexel = u.uFogTrailTexel instanceof Float32Array ? u.uFogTrailTexel : new Float32Array([1, 1]);

    this._speed = typeof this._speed === "number" ? this._speed : 1.0;
    this._direction = typeof this._direction === "number" ? this._direction : 0;
    this._synchronizedDirection = false;
    this._fogTokenTrailsEnabled = false;
    this._fogTrailWidth = 1.1;
    this._fogTrailStrength = 0.85;
    this._fogTrailSettleMs = 3000;
    this._fogTrailPositions = new Map();
    this._fogTrailSegments = [];
    this._fogTrailLastSampleMs = 0;
    this._fogTrailLastRedrawMs = 0;
    this._fogTrailNeedsRedraw = false;
    this._fogTrailHasContent = false;

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
      belowTiles: { label: "FXMASTER.Params.BelowTiles", type: "checkbox", value: false },
      soundFxEnabled: { label: "FXMASTER.Params.SoundFxEnabled", type: "checkbox", value: false },
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
        value: 0.2,
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
      direction: {
        label: "FXMASTER.Params.Direction",
        type: "range",
        min: 0,
        value: 0,
        max: 360,
        step: 5,
        decimals: 0,
        compassDirection: true,
        skipInitialAnimation: true,
      },
      synchronizedDirection: {
        label: "FXMASTER.Params.SynchronizedDirection",
        type: "checkbox",
        value: false,
        tooltip: "FXMASTER.ParamTooltips.SynchronizedDirection",
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
      tokenTrailsEnabled: {
        label: "FXMASTER.Params.TokenTrails",
        type: "checkbox",
        value: false,
        tooltip: "FXMASTER.ParamTooltips.FogTokenTrails",
      },
      tokenTrailWidth: {
        label: "FXMASTER.Params.TokenTrailWidth",
        type: "range",
        min: 0,
        value: 1.1,
        max: 2,
        step: 0.05,
        decimals: 2,
        showWhen: { tokenTrailsEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.TokenTrailWidth",
      },
      tokenTrailStrength: {
        label: "FXMASTER.Params.TokenTrailStrength",
        type: "range",
        min: 0,
        value: 0.85,
        max: 1,
        step: 0.01,
        decimals: 2,
        showWhen: { tokenTrailsEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.FogTokenTrailStrength",
      },
      tokenTrailSettleTime: {
        label: "FXMASTER.Params.TokenTrailSettleTime",
        type: "range",
        min: 0.4,
        value: 3,
        max: 5,
        step: 0.1,
        decimals: 1,
        showWhen: { tokenTrailsEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.FogTokenTrailSettleTime",
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
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
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
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
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
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
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
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
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
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  /** @returns {number} Animation speed scalar. */ get speed() {
    return this._speed;
  }
  /** @param {number} v */ set speed(v) {
    this._speed = Math.max(0, Number(v) || 0);
  }

  /** @returns {number} Fog drift direction. */ get direction() {
    return this._direction;
  }
  /** @param {number} v */ set direction(v) {
    this._direction = normalizeDirectionDegrees(v, 0);
    this._applyFogDirectionUniform();
  }

  _applyFogDirectionUniform() {
    const options = this.options ?? {};
    const direction = this._synchronizedDirection
      ? CONFIG.fxmaster?.resolveSynchronizedDirection?.(options, this._direction, this.__fxmRuntimeContext) ??
        this._direction
      : this._direction;
    const vector = geometricDirectionToCanvasVector(direction, this._direction);
    const u = this.uniforms;
    if (!u) return;
    u.uFogDirection ??= new Float32Array([1, 0]);
    u.uFogDirection[0] = vector.x;
    u.uFogDirection[1] = vector.y;
  }

  /**
   * Resolve tint color and enabled-flag from options. Accepts { value, apply } objects or raw hex strings.
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
   * Apply resolved tint payload to uniforms - but only if the payload actually contains tint info. Region-layer rebases (bounds-only) must NOT clobbering time a previously chosen tint.
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
   * Ensure token-trail runtime state exists before options can touch it.
   * The filter mixin may call applyOptions during the base PIXI.Filter
   * constructor, before this subclass constructor has finished assigning
   * instance fields.
   * @private
   */
  _ensureFogTrailState() {
    if (typeof this._fogTokenTrailsEnabled !== "boolean") this._fogTokenTrailsEnabled = false;
    if (!Number.isFinite(this._fogTrailWidth)) this._fogTrailWidth = 1.1;
    if (!Number.isFinite(this._fogTrailStrength)) this._fogTrailStrength = 0.85;
    if (!Number.isFinite(this._fogTrailSettleMs)) this._fogTrailSettleMs = 3000;
    if (!(this._fogTrailPositions instanceof Map)) this._fogTrailPositions = new Map();
    if (!Array.isArray(this._fogTrailSegments)) this._fogTrailSegments = [];
    if (!Number.isFinite(this._fogTrailLastSampleMs)) this._fogTrailLastSampleMs = 0;
    if (!Number.isFinite(this._fogTrailLastRedrawMs)) this._fogTrailLastRedrawMs = 0;
    if (typeof this._fogTrailNeedsRedraw !== "boolean") this._fogTrailNeedsRedraw = false;
    if (typeof this._fogTrailHasContent !== "boolean") this._fogTrailHasContent = false;
  }

  /**
   * Apply options to uniforms and state (mask, tint, scalars, fade). Preserves existing fade when not supplied.
   * @param {object} [options=this.options] - Options payload.
   */
  applyOptions(options = this.options) {
    this._ensureFogTrailState();
    if (!options || typeof options !== "object") return;

    this.applyMaskOptionsFrom(options);
    this._applyTintUniforms(this._resolveTintFromOptions(options));

    if (typeof options.density === "number") this.density = options.density;
    if (typeof options.dimensions === "number") this.dimensions = options.dimensions;
    if (typeof options.speed === "number") this.speed = options.speed;
    if (typeof options.direction === "number") this.direction = options.direction;
    if (options.synchronizedDirection !== undefined)
      this._synchronizedDirection = fogFilterOptionEnabled(options.synchronizedDirection);
    this._applyFogDirectionUniform();

    if (options.tokenTrailsEnabled !== undefined)
      this._fogTokenTrailsEnabled = fogFilterOptionEnabled(options.tokenTrailsEnabled);
    if (options.tokenTrailWidth !== undefined)
      this._fogTrailWidth = fogFilterClamp(
        fogFilterOptionValue(options.tokenTrailWidth, this._fogTrailWidth),
        0,
        2,
        this._fogTrailWidth,
      );
    if (options.tokenTrailStrength !== undefined)
      this._fogTrailStrength = fogFilterClamp(
        fogFilterOptionValue(options.tokenTrailStrength, this._fogTrailStrength),
        0,
        1,
        this._fogTrailStrength,
      );
    if (options.tokenTrailSettleTime !== undefined)
      this._fogTrailSettleMs =
        fogFilterClamp(
          fogFilterOptionValue(options.tokenTrailSettleTime, this._fogTrailSettleMs / 1000),
          0.4,
          5,
          this._fogTrailSettleMs / 1000,
        ) * 1000;
    if (!this._fogTokenTrailsEnabled || this._fogTrailStrength <= 0.001 || this._fogTrailWidth <= 0.001)
      this._clearFogTrailMask();
    this._syncFogTrailUniforms();

    this.applyFadeOptionsFrom(options);

    if (options.belowTokens !== undefined) {
      try {
        this.options.belowTokens = _belowTokensEnabled(options.belowTokens);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
    if (options.belowTiles !== undefined) {
      try {
        this.options.belowTiles = _belowTilesEnabled(options.belowTiles);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    super.applyOptions(options);
  }

  /**
   * Configure the filter from options (tint, density/scale/speed, fades). Accepts hex, or { value, apply } for tint.
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
    this._resetFogTrailRuntime();
    super.play?.({ skipFading, ...opts });

    if (!this._fogTick) {
      this._fogTick = this.addFilterTicker((deltaMS) => {
        try {
          const dt = deltaMS ?? 16.6;
          const u = this.uniforms;
          if (!u) return;
          u.time = (typeof u.time === "number" ? u.time : 0) + dt * this.speed * 0.1;
          if (u.time > 1e9) u.time = 0;
          u.uFogTrailTime = (typeof u.uFogTrailTime === "number" ? u.uFogTrailTime : 0) + dt * 0.1;
          if (u.uFogTrailTime > 1e9) u.uFogTrailTime = 0;
          this._applyFogDirectionUniform();
          this._updateFogTokenTrails(dt);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      });
    }
    return this;
  }

  _ensureFogTrailResources() {
    this._ensureFogTrailState();
    const bounds = fogFilterSceneBounds();
    if (!bounds) return false;

    const grid = Number(globalThis.canvas?.dimensions?.size) || 100;
    const rawW = Math.ceil((bounds.width / grid) * FOG_FILTER_TRAIL_TEXELS_PER_GRID);
    const rawH = Math.ceil((bounds.height / grid) * FOG_FILTER_TRAIL_TEXELS_PER_GRID);
    const scale = Math.min(
      1,
      FOG_FILTER_TRAIL_TEXTURE_MAX / Math.max(1, rawW),
      FOG_FILTER_TRAIL_TEXTURE_MAX / Math.max(1, rawH),
    );
    const texW = Math.max(FOG_FILTER_TRAIL_TEXTURE_MIN, Math.ceil(rawW * scale));
    const texH = Math.max(FOG_FILTER_TRAIL_TEXTURE_MIN, Math.ceil(rawH * scale));
    const key = `${Math.round(bounds.x)},${Math.round(bounds.y)},${Math.round(bounds.width)},${Math.round(
      bounds.height,
    )},${texW},${texH}`;
    if (this._fogTrailCanvas && this._fogTrailTexture && this._fogTrailSizeKey === key) return true;

    fogFilterDestroyTexture(this._fogTrailTexture);
    this._fogTrailCanvas = document.createElement("canvas");
    this._fogTrailCanvas.width = texW;
    this._fogTrailCanvas.height = texH;
    this._fogTrailCtx = this._fogTrailCanvas.getContext("2d", { alpha: true });
    if (!this._fogTrailCtx) return false;
    this._fogTrailCtx.imageSmoothingEnabled = true;
    this._fogTrailCtx.imageSmoothingQuality = "high";
    this._fogTrailTexture = globalThis.PIXI?.Texture?.from?.(this._fogTrailCanvas) ?? null;
    if (this._fogTrailTexture?.baseTexture && globalThis.PIXI?.SCALE_MODES) {
      this._fogTrailTexture.baseTexture.scaleMode = globalThis.PIXI.SCALE_MODES.LINEAR;
    }
    this._fogTrailBounds = bounds;
    this._fogTrailSizeKey = key;
    this._fogTrailScaleX = texW / Math.max(1, bounds.width);
    this._fogTrailScaleY = texH / Math.max(1, bounds.height);
    this._fogTrailPositions.clear();
    this._fogTrailSegments.length = 0;
    this._fogTrailHasContent = false;
    this._fogTrailNeedsRedraw = false;
    this._syncFogTrailUniforms();
    return !!this._fogTrailTexture;
  }

  _fogTrailWorldToMask(point) {
    const b = this._fogTrailBounds ?? fogFilterSceneBounds() ?? { x: 0, y: 0 };
    return {
      x: (point.x - b.x) * (this._fogTrailScaleX || 1),
      y: (point.y - b.y) * (this._fogTrailScaleY || 1),
    };
  }

  _syncFogTrailUniforms() {
    this._ensureFogTrailState();
    const u = this.uniforms;
    if (!u) return;
    const active = !!this._fogTokenTrailsEnabled && !!this._fogTrailHasContent && !!this._fogTrailTexture;
    u.uFogTrailTexture = active ? this._fogTrailTexture : fogFilterEmptyTexture();
    u.uFogTrailsEnabled = active ? 1.0 : 0.0;
    u.uFogTrailStrength = active ? this._fogTrailStrength : 0.0;
    u.uFogTrailRefillProgress = 0.0;
    u.uFogTrailBounds ??= new Float32Array(4);
    u.uFogTrailTexel ??= new Float32Array(2);
    const b = this._fogTrailBounds ?? fogFilterSceneBounds() ?? { x: 0, y: 0, width: 1, height: 1 };
    u.uFogTrailBounds[0] = Number(b.x) || 0;
    u.uFogTrailBounds[1] = Number(b.y) || 0;
    u.uFogTrailBounds[2] = Math.max(1, Number(b.width) || 1);
    u.uFogTrailBounds[3] = Math.max(1, Number(b.height) || 1);
    u.uFogTrailTexel[0] = this._fogTrailCanvas?.width ? 1 / this._fogTrailCanvas.width : 1;
    u.uFogTrailTexel[1] = this._fogTrailCanvas?.height ? 1 / this._fogTrailCanvas.height : 1;
  }

  _clearFogTrailMask() {
    this._ensureFogTrailState();
    if (this._fogTrailCtx && this._fogTrailCanvas) {
      this._fogTrailCtx.clearRect(0, 0, this._fogTrailCanvas.width, this._fogTrailCanvas.height);
      fogFilterUpdateTexture(this._fogTrailTexture);
    }
    this._fogTrailSegments?.splice?.(0);
    this._fogTrailHasContent = false;
    this._fogTrailNeedsRedraw = false;
    this._syncFogTrailUniforms();
  }

  _resetFogTrailRuntime() {
    this._ensureFogTrailState();
    this._fogTrailPositions?.clear?.();
    this._fogTrailSegments?.splice?.(0);
    this._fogTrailLastSampleMs = 0;
    this._fogTrailLastRedrawMs = 0;
    this._fogTrailNeedsRedraw = false;
    this._fogTrailHasContent = false;
    if (this._fogTrailCtx && this._fogTrailCanvas) {
      this._fogTrailCtx.clearRect(0, 0, this._fogTrailCanvas.width, this._fogTrailCanvas.height);
      fogFilterUpdateTexture(this._fogTrailTexture);
    }
    this._syncFogTrailUniforms();
  }

  _sampleFogTrailTokens(now) {
    this._ensureFogTrailState();
    if (now - this._fogTrailLastSampleMs < FOG_FILTER_TRAIL_SAMPLE_INTERVAL_MS) return;
    this._fogTrailLastSampleMs = now;

    const tokens = globalThis.canvas?.tokens?.placeables ?? [];
    const seen = new Set();
    const grid = Math.max(1, Number(globalThis.canvas?.dimensions?.size) || 100);
    const minDistance = Math.max(1.5, grid * 0.018);
    const teleportDistance = Math.max(grid, grid * FOG_FILTER_TRAIL_TELEPORT_GRID_SPACES);

    for (const token of tokens) {
      if (!fogFilterTokenVisible(token)) continue;
      const id = fogFilterTokenId(token);
      if (!id) continue;
      const center = fogFilterTokenCenter(token);
      if (!center) continue;
      seen.add(id);

      const footprint = fogFilterTokenFootprint(token);
      const previous = this._fogTrailPositions.get(id);
      if (!previous) {
        this._fogTrailPositions.set(id, { x: center.x, y: center.y, footprint, seenAt: now });
        continue;
      }

      const distance = Math.hypot(center.x - previous.x, center.y - previous.y);
      if (distance > teleportDistance) {
        this._fogTrailPositions.set(id, { x: center.x, y: center.y, footprint, seenAt: now });
        continue;
      }

      if (distance >= minDistance) {
        this._fogTrailSegments.push({
          from: { x: previous.x, y: previous.y },
          to: { x: center.x, y: center.y },
          fromMs: previous.seenAt ?? now,
          toMs: now,
          width: Math.max(grid * 0.25, Math.max(previous.footprint ?? footprint, footprint) * this._fogTrailWidth),
        });
        if (this._fogTrailSegments.length > FOG_FILTER_TRAIL_MAX_SEGMENTS) {
          this._fogTrailSegments.splice(0, this._fogTrailSegments.length - FOG_FILTER_TRAIL_MAX_SEGMENTS);
        }
        this._fogTrailNeedsRedraw = true;
        this._fogTrailPositions.set(id, { x: center.x, y: center.y, footprint, seenAt: now });
      } else {
        previous.footprint = footprint;
        previous.seenAt = now;
      }
    }

    for (const [id, position] of this._fogTrailPositions.entries()) {
      if (seen.has(id)) continue;
      if (now - (position.seenAt ?? now) > 1200) this._fogTrailPositions.delete(id);
    }
  }

  _pruneFogTrailSegments(now) {
    this._ensureFogTrailState();
    if (!this._fogTrailSegments.length) return;
    const cutoff = now - this._fogTrailSettleMs - 250;
    const before = this._fogTrailSegments.length;
    this._fogTrailSegments = this._fogTrailSegments.filter((segment) => {
      const last = Number(segment?.toMs ?? segment?.fromMs ?? 0) || 0;
      return last >= cutoff;
    });
    if (this._fogTrailSegments.length !== before) this._fogTrailNeedsRedraw = true;
  }

  _redrawFogTrailMask(now) {
    this._ensureFogTrailState();
    if (!this._fogTrailCtx || !this._fogTrailCanvas) return;
    if (!this._fogTrailNeedsRedraw && now - this._fogTrailLastRedrawMs < FOG_FILTER_TRAIL_REDRAW_INTERVAL_MS) return;
    this._fogTrailLastRedrawMs = now;
    this._fogTrailNeedsRedraw = false;

    const ctx = this._fogTrailCtx;
    ctx.clearRect(0, 0, this._fogTrailCanvas.width, this._fogTrailCanvas.height);

    let drew = false;
    const avgScale = 0.5 * ((this._fogTrailScaleX || 1) + (this._fogTrailScaleY || 1));
    const settleMs = Math.max(400, this._fogTrailSettleMs);
    const alphaForTime = (stampMs) => {
      const age = Math.max(0, now - (Number(stampMs) || now));
      const life = fogFilterClamp(1 - age / settleMs, 0, 1, 0);
      return Math.pow(life, 0.72);
    };

    const segments = [...this._fogTrailSegments].sort(
      (a, b) => (Number(a?.toMs ?? 0) || 0) - (Number(b?.toMs ?? 0) || 0),
    );
    for (const segment of segments) {
      const a = this._fogTrailWorldToMask(segment.from);
      const b = this._fogTrailWorldToMask(segment.to);
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 0.25) continue;

      const alphaA = alphaForTime(segment.fromMs);
      const alphaB = alphaForTime(segment.toMs);
      const alpha = Math.max(alphaA, alphaB);
      if (alpha <= 0.003) continue;

      const width = Math.max(2.5, (Number(segment.width) || 1) * avgScale);
      const ux = (b.x - a.x) / len;
      const uy = (b.y - a.y) / len;
      const capOverlap = Math.min(width * 0.55, len * 0.5);
      const sx = a.x - ux * capOverlap;
      const sy = a.y - uy * capOverlap;
      const ex = b.x + ux * capOverlap;
      const ey = b.y + uy * capOverlap;
      const grad = ctx.createLinearGradient(sx, sy, ex, ey);
      grad.addColorStop(0, `rgba(255,255,255,${alphaA})`);
      grad.addColorStop(1, `rgba(255,255,255,${alphaB})`);

      const drawStroke = (lineWidth, alphaScale) => {
        ctx.globalAlpha = alphaScale;
        ctx.lineWidth = Math.max(0.5, lineWidth);
        ctx.strokeStyle = grad;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
      };

      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      drawStroke(width * 1.72, 0.1);
      drawStroke(width * 1.12, 0.18);
      drawStroke(width * 0.68, 0.34);
      drawStroke(width * 0.36, 0.46);
      ctx.restore();
      drew = true;
    }

    this._fogTrailHasContent = drew;
    fogFilterUpdateTexture(this._fogTrailTexture);
    this._syncFogTrailUniforms();
  }

  _updateFogTokenTrails(_deltaMS = 16.6) {
    this._ensureFogTrailState();
    if (!this._fogTokenTrailsEnabled || this._fogTrailStrength <= 0.001 || this._fogTrailWidth <= 0.001) {
      if (this._fogTrailHasContent) this._clearFogTrailMask();
      else this._syncFogTrailUniforms();
      return;
    }
    if (!this._ensureFogTrailResources()) return;

    const now = fogFilterNowMs();
    this._sampleFogTrailTokens(now);
    this._pruneFogTrailSegments(now);
    this._redrawFogTrailMask(now);
    if (!this._fogTrailSegments.length && this._fogTrailHasContent) this._clearFogTrailMask();
    else this._syncFogTrailUniforms();
  }

  _destroyFogTrailResources() {
    this._clearFogTrailMask();
    fogFilterDestroyTexture(this._fogTrailTexture);
    this._fogTrailTexture = null;
    this._fogTrailCanvas = null;
    this._fogTrailCtx = null;
    this._fogTrailBounds = null;
    this._fogTrailPositions?.clear?.();
    this._fogTrailSegments?.splice?.(0);
  }

  /**
   * Stop the effect, fading the strength uniform unless skipFading is true.
   * @param {{durationMs?:number,skipFading?:boolean}} [opts]
   * @returns {Promise<any>} Awaitable stop result.
   */
  stop({ durationMs = 3000, skipFading } = {}) {
    this._resetFogTrailRuntime();
    return this.stopWithUniformFade({ uniformKey: "strength", durationMs, skipFading });
  }

  /** @override */
  destroy(options) {
    this._destroyFogTrailResources();
    super.destroy(options);
  }

  /**
   * Sync matrices and apply with scene-rect locking.
   * @param {PIXI.FilterSystem} filterManager - Filter system.
   * @param {PIXI.RenderTexture} input - Input texture.
   * @param {PIXI.RenderTexture} output - Output texture.
   * @param {PIXI.CLEAR_MODES|boolean} clear - Clear flag.
   * @param {object} currentState - Filter state.
   * @returns {void}
   */
  apply(filterManager, input, output, clear, currentState) {
    const targetMatrix = this.__fxmTargetWorldTransform ?? currentState?.target?.worldTransform ?? PIXI.Matrix.IDENTITY;
    (this.uniforms.filterMatrix ??= new PIXI.Matrix()).copyFrom(targetMatrix).invert();
    return this.applyWithLock(filterManager, input, output, clear, currentState, { area: "sceneRect" });
  }
}
