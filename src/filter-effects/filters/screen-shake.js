import { FXMasterFilterEffectMixin, preprocessShader } from "./mixins/filter.js";
import fragment from "./shaders/screen-shake.frag";
import { MAX_EDGES } from "../../constants.js";
import { clamp01, clampRange } from "../../utils.js";

const SHAKE_AXIS_OPTIONS = {
  both: "FXMASTER.ScreenShake.Axis.Both",
  horizontal: "FXMASTER.ScreenShake.Axis.Horizontal",
  vertical: "FXMASTER.ScreenShake.Axis.Vertical",
};

const MAX_DISPLACEMENT_PX = 48;
const MAX_BLUR_OFFSET_PX = 16;
const AUDIO_CHANNEL_OPTIONS = {
  music: "FXMASTER.Common.Music",
  environment: "FXMASTER.Common.Environment",
  interface: "FXMASTER.Common.Interface",
};
const VALID_AUDIO_CHANNELS = Object.keys(AUDIO_CHANNEL_OPTIONS);
const AUDIO_IGNORE_VOLUME = true;

/**
 * Return the current wall-clock time in milliseconds.
 *
 * @returns {number}
 */
function nowMs() {
  return Date.now?.() ?? Math.round(performance?.now?.() ?? 0);
}

/**
 * Return whether the current client has photosensitive motion reduction enabled.
 *
 * @returns {boolean}
 */
function photosensitiveModeEnabled() {
  try {
    if (canvas?.photosensitiveMode === true) return true;
  } catch {
    return false;
  }

  try {
    return game?.settings?.get?.("core", "photosensitiveMode") === true;
  } catch {
    return false;
  }
}

/**
 * Return a deterministic hash in the range -1..1.
 *
 * @param {number} value
 * @param {number} seed
 * @returns {number}
 */
function hashSigned(value, seed) {
  const n = Math.sin(value * 12.9898 + seed * 78.233) * 43758.5453123;
  return (n - Math.floor(n)) * 2 - 1;
}

/**
 * Sample smooth deterministic one-dimensional noise.
 *
 * @param {number} value
 * @param {number} seed
 * @returns {number}
 */
function smoothNoise(value, seed) {
  const i = Math.floor(value);
  const f = value - i;
  const t = f * f * (3 - 2 * f);
  const a = hashSigned(i, seed);
  const b = hashSigned(i + 1, seed);
  return a + (b - a) * t;
}

/**
 * ScreenShakeFilter displaces the FXMaster compositor input with a decaying smooth-noise offset.
 */
export class ScreenShakeFilter extends FXMasterFilterEffectMixin(PIXI.Filter) {
  /**
   * Construct a ScreenShakeFilter with mask and displacement uniforms.
   *
   * @param {object} [options={}] Initial filter options.
   * @param {string} [id] Stable id for filter instances.
   */
  constructor(options = {}, id) {
    super(options, id, PIXI.Filter.defaultVertex, preprocessShader(fragment));

    const u = (this.uniforms ??= {});
    this.initMaskUniforms(u, { withStrength: true, strengthDefault: 1.0 });
    this.initFadeUniforms(u);
    this.initRegionFadeUniforms(u, { maxEdges: MAX_EDGES });
    this.ensureVec4Uniform("srcFrame", [0, 0, 1, 1]);
    this.ensureVec4Uniform("outputFrame", [0, 0, 1, 1]);
    this.ensureVec2Uniform("camFrac", [0, 0]);
    this.ensureVec2Uniform("shakeOffsetPx", [0, 0]);
    this.ensureVec2Uniform("blurOffsetPx", [0, 0]);

    u.blurStrength = typeof u.blurStrength === "number" ? u.blurStrength : 0.0;
    u.edgeZoom = typeof u.edgeZoom === "number" ? u.edgeZoom : 1.0;

    this._seed = Math.random() * 10000;
    this._elapsedMs = 0;
    this._startedAt = 0;
    this._expiresAt = 0;
    this._optionsSnapshot = {};
    this._lastBlurDirection = [1, 0];
    this._audioPrevLevel = 0;
    this._audioWarmFrames = 0;
    this._audioCooldownUntil = 0;
    this._burstStartedAt = 0;
    this._burstExpiresAt = 0;

    this.configure(options);
  }

  static label = "FXMASTER.Filters.Effects.ScreenShake";

  static icon = "fas fa-burst";

  static initialFadeDurationMs = 500;

  static fadeOutDurationMs = 500;

  /**
   * Parameter schema exposed to configuration UIs.
   *
   * @returns {Record<string, object>} Parameter descriptors.
   */
  static get parameters() {
    return {
      belowTokens: { label: "FXMASTER.Params.BelowTokens", type: "checkbox", value: false },
      belowTiles: { label: "FXMASTER.Params.BelowTiles", type: "checkbox", value: false },
      soundFxEnabled: { label: "FXMASTER.Params.SoundFxEnabled", type: "checkbox", value: false },
      timed: {
        label: "FXMASTER.Params.Timed",
        type: "checkbox",
        value: true,
        tooltip: "FXMASTER.ParamTooltips.ScreenShakeTimed",
        hideWhen: { audioAware: true },
      },
      strength: {
        label: "FXMASTER.Params.Strength",
        type: "range",
        max: 1,
        min: 0,
        step: 0.01,
        value: 0.55,
        tooltip: "FXMASTER.ParamTooltips.ScreenShakeStrength",
      },
      blur: {
        label: "FXMASTER.Params.Blur",
        type: "range",
        max: 1,
        min: 0,
        step: 0.01,
        value: 0.12,
        tooltip: "FXMASTER.ParamTooltips.ScreenShakeBlur",
      },
      duration: {
        label: "FXMASTER.Params.Duration",
        type: "range",
        max: 10,
        min: 0.1,
        step: 0.1,
        value: 1.5,
        tooltip: "FXMASTER.ParamTooltips.ScreenShakeDuration",
        showWhen: ({ get }) => get("timed") === true || get("audioAware") === true,
      },
      speed: {
        label: "FXMASTER.Params.ShakeSpeed",
        type: "range",
        max: 1,
        min: 0,
        step: 0.01,
        value: 0.55,
        tooltip: "FXMASTER.ParamTooltips.ScreenShakeSpeed",
      },
      smoothness: {
        label: "FXMASTER.Params.Smoothness",
        type: "range",
        max: 1,
        min: 0,
        step: 0.01,
        value: 0.45,
        tooltip: "FXMASTER.ParamTooltips.ScreenShakeSmoothness",
      },
      decay: {
        label: "FXMASTER.Params.Decay",
        type: "range",
        max: 1,
        min: 0,
        step: 0.01,
        value: 0.8,
        tooltip: "FXMASTER.ParamTooltips.ScreenShakeDecay",
        showWhen: ({ get }) => get("timed") === true || get("audioAware") === true,
      },
      axis: {
        label: "FXMASTER.Params.Axis",
        type: "select",
        value: "both",
        options: SHAKE_AXIS_OPTIONS,
        tooltip: "FXMASTER.ParamTooltips.ScreenShakeAxis",
      },
      edgeProtection: {
        label: "FXMASTER.Params.EdgeProtection",
        type: "range",
        max: 1,
        min: 0,
        step: 0.01,
        value: 0.6,
        tooltip: "FXMASTER.ParamTooltips.ScreenShakeEdgeProtection",
      },
      audioAware: {
        label: "FXMASTER.Params.AudioAware",
        type: "checkbox",
        value: false,
        tooltip: "FXMASTER.ParamTooltips.AudioAware",
      },
      audioChannels: {
        label: "FXMASTER.Params.AudioChannels",
        type: "multi-select",
        tooltip: "FXMASTER.ParamTooltips.AudioChannels",
        options: AUDIO_CHANNEL_OPTIONS,
        value: ["environment"],
        showWhen: { audioAware: true },
      },
      audioBassThreshold: {
        label: "FXMASTER.Params.AudioBassThreshold",
        type: "range",
        tooltip: "FXMASTER.ParamTooltips.AudioBassThreshold",
        max: 1,
        min: 0,
        step: 0.01,
        value: 0.75,
        showWhen: { audioAware: true },
      },
    };
  }

  /**
   * Neutral option values.
   *
   * @returns {{strength:number, blur:number}}
   */
  static get neutral() {
    return { strength: 0, blur: 0 };
  }

  /**
   * Prepare stored scene options for a new or updated screen shake row.
   *
   * @param {object} [options={}] Options payload.
   * @param {{previousOptions?: object|null, forceRestart?: boolean, changedParam?: string|null, now?: number}} [context]
   * @returns {object} Prepared options.
   */
  static prepareSceneOptions(
    options = {},
    { previousOptions = null, forceRestart = false, changedParam = null, now } = {},
  ) {
    const prepared = { ...(options ?? {}) };
    const audioAware = prepared.audioAware === true;
    const timed = prepared.timed !== false && !audioAware;
    const currentTime = Number.isFinite(Number(now)) ? Number(now) : nowMs();

    if (!timed) {
      delete prepared.startedAt;
      delete prepared.expiresAt;
      return prepared;
    }

    const durationMs = Math.max(100, Number(prepared.duration ?? this.default.duration ?? 1.5) * 1000);
    const previousStartedAt = Number(previousOptions?.startedAt);
    const previousExpiresAt = Number(previousOptions?.expiresAt);
    const missingTiming = !Number.isFinite(previousStartedAt) || !Number.isFinite(previousExpiresAt);
    const timedChanged =
      previousOptions &&
      (previousOptions.timed !== prepared.timed || previousOptions.audioAware !== prepared.audioAware);
    const durationChanged = changedParam === "duration";
    const alreadyExpired = Number.isFinite(previousExpiresAt) && currentTime >= previousExpiresAt;
    const shouldRestart = forceRestart || missingTiming || timedChanged || durationChanged || alreadyExpired;

    if (shouldRestart) {
      prepared.startedAt = currentTime;
      prepared.expiresAt = currentTime + durationMs;
    } else {
      prepared.startedAt = previousStartedAt;
      prepared.expiresAt = previousExpiresAt;
    }

    return prepared;
  }

  /**
   * Return whether the timed shake has expired.
   *
   * @returns {boolean}
   */
  isTimedExpired() {
    if (this._timed !== true) return false;
    const expiresAt = Number(this._expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt > 0) return nowMs() >= expiresAt;
    const durationMs = Math.max(100, this._duration * 1000);
    return this._elapsedMs >= durationMs;
  }

  /**
   * Configure runtime state from options.
   *
   * @param {object} [options={}] Options payload.
   */
  configure(options = {}) {
    super.configure(options);
    this._applyScreenShakeOptions(this.options);
  }

  /**
   * Apply options to uniforms and runtime state.
   *
   * @param {object} [options=this.options] Options payload.
   */
  applyOptions(options = this.options) {
    this._applyScreenShakeOptions(options);
    super.applyOptions(options);
  }

  /**
   * Begin playing the effect and install the offset ticker.
   *
   * @param {object} [opts={}] Options payload.
   * @returns {this}
   */
  play(opts = {}) {
    this.configure(opts);
    super.play?.({ skipFading: true, ...opts });
    this.enabled = true;

    if (!this._startedAt) this._startedAt = nowMs();
    if (this._timed && !this._expiresAt) this._expiresAt = this._startedAt + Math.max(100, this._duration * 1000);

    if (!this._screenShakeTick) {
      this._screenShakeTick = this.addFilterTicker((deltaMS) => this._updateShake(deltaMS));
    }

    this._updateShake(0);
    return this;
  }

  /**
   * Fade out the effect and remove the ticker.
   *
   * @param {{durationMs?: number, skipFading?: boolean}} [opts={}] Stop options.
   * @returns {Promise<any>} Awaitable stop result.
   */
  stop({ durationMs = this.constructor.fadeOutDurationMs, skipFading } = {}) {
    const fadeDuration = Number.isFinite(Number(durationMs))
      ? Math.max(0, Number(durationMs))
      : this.constructor.fadeOutDurationMs;
    return this.stopWithUniformFade({
      uniformKey: "strength",
      durationMs: fadeDuration,
      skipFading,
      onDone: () => {
        this._screenShakeTick = null;
        this._setShakeOffset(0, 0, 1, 0, 0, 0);
      },
    });
  }

  /**
   * Apply the filter with scene-rect locking.
   *
   * @param {PIXI.FilterSystem} filterSystem Filter system.
   * @param {PIXI.RenderTexture} input Input texture.
   * @param {PIXI.RenderTexture} output Output texture.
   * @param {PIXI.CLEAR_MODES|boolean} clear Clear flag.
   * @param {object} currentState Current filter state.
   * @returns {void}
   */
  apply(filterSystem, input, output, clear, currentState) {
    return this.applyWithLock(filterSystem, input, output, clear, currentState, {
      area: "sceneRect",
      setDeviceToCss: false,
    });
  }

  /**
   * Apply and clamp Screen Shake options.
   *
   * @param {object} [options={}] Options payload.
   * @returns {void}
   * @private
   */
  _applyScreenShakeOptions(options = {}) {
    const source = options && typeof options === "object" ? options : {};
    this._optionsSnapshot = { ...source };
    this._strength = clamp01(source.strength, this.constructor.default.strength);
    this._blur = clamp01(source.blur, this.constructor.default.blur);
    this._duration = clampRange(source.duration, 0.1, 10, this.constructor.default.duration);
    this._speed = clamp01(source.speed, this.constructor.default.speed);
    this._smoothness = clamp01(source.smoothness, this.constructor.default.smoothness);
    this._decay = clamp01(source.decay, this.constructor.default.decay);
    this._axis = String(source.axis ?? this.constructor.default.axis ?? "both");
    if (!(this._axis in SHAKE_AXIS_OPTIONS)) this._axis = "both";
    this._edgeProtection = clamp01(source.edgeProtection, this.constructor.default.edgeProtection);
    this._audioAware = source.audioAware === true;
    this._audioChannels = this._normalizeAudioChannels(source.audioChannels);
    this._audioBassThreshold = clamp01(source.audioBassThreshold, this.constructor.default.audioBassThreshold ?? 0.75);
    this._timed = source.timed !== false && !this._audioAware;

    if (!this._audioAware) {
      this._audioPrevLevel = 0;
      this._audioWarmFrames = 0;
      this._audioCooldownUntil = 0;
      this._burstStartedAt = 0;
      this._burstExpiresAt = 0;
    }

    const startedAt = Number(source.startedAt);
    const expiresAt = Number(source.expiresAt);
    if (Number.isFinite(startedAt) && startedAt > 0) this._startedAt = startedAt;
    if (Number.isFinite(expiresAt) && expiresAt > 0) this._expiresAt = expiresAt;

    if (this.uniforms && typeof this._strength === "number") this.uniforms.strength = this._strength;
    if (this.uniforms && typeof this._blur === "number") this.uniforms.blurStrength = this._blur;

    this.applyMaskOptionsFrom(source);
    this.applyFadeOptionsFrom(source);
  }

  /**
   * Update the shake offset for the current frame.
   *
   * @param {number} [deltaMS=16.6] Frame delta in milliseconds.
   * @returns {void}
   * @private
   */
  _updateShake(deltaMS = 16.6) {
    const dt = Number.isFinite(Number(deltaMS)) ? Math.max(0, Number(deltaMS)) : 16.6;
    this._elapsedMs += dt;

    if (!this.enabled || photosensitiveModeEnabled()) {
      this._setShakeOffset(0, 0, 1, 0, 0, 0);
      return;
    }

    const currentTime = nowMs();
    const durationMs = Math.max(100, this._duration * 1000);
    let elapsedMs = this._startedAt ? Math.max(0, currentTime - this._startedAt) : this._elapsedMs;
    let envelopeActive = this._timed;

    if (this._audioAware) {
      this._updateAudioTrigger(currentTime, durationMs);
      if (!this._burstStartedAt || currentTime >= this._burstExpiresAt) {
        this._setShakeOffset(0, 0, 1, 0, 0, 0);
        return;
      }

      elapsedMs = Math.max(0, currentTime - this._burstStartedAt);
      envelopeActive = true;
    }

    const progress = envelopeActive ? clamp01(elapsedMs / durationMs, 0) : 0;

    if (this._timed && progress >= 1) {
      this.enabled = false;
      this._setShakeOffset(0, 0, 1, 0, 0, 0);
      return;
    }

    if (this._audioAware && progress >= 1) {
      this._burstStartedAt = 0;
      this._burstExpiresAt = 0;
      this._setShakeOffset(0, 0, 1, 0, 0, 0);
      return;
    }

    const speedHz = 1.5 + this._speed * 22.5;
    const smoothFactor = 1.25 - this._smoothness * 0.95;
    const t =
      (this._audioAware && this._burstStartedAt
        ? elapsedMs * 0.001
        : this._startedAt
        ? currentTime * 0.001
        : this._elapsedMs * 0.001) *
      speedHz *
      smoothFactor;
    const decayPower = 0.35 + this._decay * 2.65;
    const decayFactor = envelopeActive ? Math.pow(Math.max(0, 1 - progress), decayPower) : 1;
    const amplitude = this._strength * MAX_DISPLACEMENT_PX * decayFactor;

    let x = smoothNoise(t, this._seed) * amplitude;
    let y = smoothNoise(t + 41.37, this._seed + 19.11) * amplitude;

    if (this._axis === "horizontal") y = 0;
    else if (this._axis === "vertical") x = 0;

    const offsetLength = Math.hypot(x, y);
    if (offsetLength > 0.001) this._lastBlurDirection = [x / offsetLength, y / offsetLength];

    const blurDistance = this._blur > 0 ? Math.min(MAX_BLUR_OFFSET_PX, amplitude * 0.35) * this._blur : 0;
    const [blurDirX, blurDirY] = this._lastBlurDirection;
    const maxOffset = Math.max(Math.abs(x), Math.abs(y)) + blurDistance * 2;
    const viewportMin = Math.max(
      1,
      Math.min(canvas?.app?.renderer?.screen?.width ?? 1, canvas?.app?.renderer?.screen?.height ?? 1),
    );
    const edgeZoom = 1 + this._edgeProtection * (maxOffset / viewportMin) * 3;
    this._setShakeOffset(x, y, edgeZoom, blurDirX * blurDistance, blurDirY * blurDistance, this._blur * decayFactor);
  }

  /**
   * Return sanitized audio channels for audio-aware mode.
   *
   * @param {string[]|string|null|undefined} value Channel selection.
   * @returns {string[]} Sanitized channels.
   * @private
   */
  _normalizeAudioChannels(value) {
    const array = Array.isArray(value) ? value : value ? [value] : [];
    const out = array.map(String).filter((channel) => VALID_AUDIO_CHANNELS.includes(channel));
    return out.length ? out : ["environment"];
  }

  /**
   * Sample the configured audio channels and start a shake burst on a bass rising edge.
   *
   * @param {number} currentTime Current wall-clock time in milliseconds.
   * @param {number} durationMs Burst duration in milliseconds.
   * @returns {void}
   * @private
   */
  _updateAudioTrigger(currentTime, durationMs) {
    let level = 0;

    try {
      for (const channel of this._audioChannels ?? ["environment"]) {
        const value = game?.audio?.getBandLevel?.(channel, "bass", { ignoreVolume: AUDIO_IGNORE_VOLUME }) ?? 0;
        if (value > level) level = value;
      }
    } catch {
      level = 0;
    }

    if (this._audioWarmFrames < 2) {
      this._audioWarmFrames++;
      this._audioPrevLevel = level;
      return;
    }

    const threshold = this._audioBassThreshold ?? 0.75;
    const rising = this._audioPrevLevel < threshold && level >= threshold;
    const cooled = currentTime >= (this._audioCooldownUntil ?? 0);

    if (rising && cooled) {
      this._seed = Math.random() * 10000;
      this._burstStartedAt = currentTime;
      this._burstExpiresAt = currentTime + durationMs;
      this._audioCooldownUntil = currentTime + Math.max(250, durationMs * 0.7);
    }

    this._audioPrevLevel = level;
  }

  /**
   * Write a two-component vector uniform.
   *
   * @param {string} name Uniform name.
   * @param {number} x Horizontal CSS-pixel value.
   * @param {number} y Vertical CSS-pixel value.
   * @returns {void}
   * @private
   */
  _writeVec2Uniform(name, x, y) {
    const u = this.uniforms;
    if (!u) return;

    const current = u[name];
    const value = current instanceof Float32Array && current.length >= 2 ? current : new Float32Array(2);
    value[0] = Number.isFinite(x) ? x : 0;
    value[1] = Number.isFinite(y) ? y : 0;
    u[name] = value;
  }

  /**
   * Write shake and blur uniforms.
   *
   * @param {number} x Horizontal CSS-pixel offset.
   * @param {number} y Vertical CSS-pixel offset.
   * @param {number} edgeZoom Edge overscan zoom.
   * @param {number} blurX Horizontal CSS-pixel blur offset.
   * @param {number} blurY Vertical CSS-pixel blur offset.
   * @param {number} blurStrength Blur blend strength.
   * @returns {void}
   * @private
   */
  _setShakeOffset(x, y, edgeZoom, blurX = 0, blurY = 0, blurStrength = this._blur ?? 0) {
    const u = this.uniforms;
    if (!u) return;

    this._writeVec2Uniform("shakeOffsetPx", x, y);
    this._writeVec2Uniform("blurOffsetPx", blurX, blurY);
    u.blurStrength = clamp01(blurStrength, 0);
    u.edgeZoom = Number.isFinite(edgeZoom) ? Math.max(1, edgeZoom) : 1;
  }
}
