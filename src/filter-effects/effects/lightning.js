import { FXMasterFilterEffectMixin, preprocessShader } from "../mixins/filter.js";
import fragment from "../shaders/lightning.frag";
import { packageId, MAX_EDGES } from "../../constants.js";
import { easeFunctions } from "../../ease.js";
import { logger } from "../../logger.js";

/** Produces randomized, audio-aware, and synchronized lightning flashes. */
export class LightningFilter extends FXMasterFilterEffectMixin(PIXI.Filter) {
  /**
   * @param {object} [options={}] Initial filter options.
   * @param {string} [id] Stable filter identifier.
   */
  constructor(options = {}, id) {
    super(options, id, PIXI.Filter.defaultVertexSrc, preprocessShader(fragment));

    const u = (this.uniforms ??= {});
    this.initMaskUniforms(u, { withStrength: true });
    this.initFadeUniforms(u);
    this.initRegionFadeUniforms(u, { maxEdges: MAX_EDGES });

    this.ensureVec2Uniform("camFrac", [0, 0]);
    this.ensureVec4Uniform("outputFrame", [0, 0, 1, 1]);

    u.brightness = typeof u.brightness === "number" ? u.brightness : 1.0;
    if (!(u.color instanceof Float32Array) || u.color.length < 3) u.color = new Float32Array([1, 1, 1]);
    u.uPresentationPass = typeof u.uPresentationPass === "number" ? u.uPresentationPass : 0;

    this._tickerFn = null;
    this._driverTicker = null;
    this._accumMS = 0;
    this._nextMS = 0;
    this._animating = false;
    this._flashGeneration = 0;
    this._activeAnimations = new Set();
    this._pendingFlashTimeouts = new Map();

    this.configure(options);
    this._nextMS = this._sampleIntervalMS();
  }

  static label = "FXMASTER.Filters.Effects.Lightning";

  static icon = "fas fa-bolt-lightning";

  static get aboveDarknessPresentation() {
    return {
      option: "aboveDarkness",
      uniform: "uPresentationPass",
      values: { normal: 0, belowDarkness: 1, aboveDarkness: 2 },
      blendMode: PIXI.BLEND_MODES.NORMAL,
    };
  }

  /** @returns {Record<string, object>} Configuration parameter descriptors. */
  static get parameters() {
    const base = {
      belowTokens: { label: "FXMASTER.Params.BelowTokens", type: "checkbox", value: false },
      belowTiles: { label: "FXMASTER.Params.BelowTiles", type: "checkbox", value: false },
      soundFxEnabled: { label: "FXMASTER.Params.SoundFxEnabled", type: "checkbox", value: false },
      color: {
        label: "FXMASTER.Params.Tint",
        type: "color",
        value: { value: "#ffffff", apply: false },
        skipInitialAnimation: true,
      },
      frequency: {
        label: "FXMASTER.Params.Period",
        type: "range",
        max: 30000,
        min: 100,
        step: 100,
        value: 5000,
        showWhen: { audioAware: false },
      },
      spark_duration: { label: "FXMASTER.Params.Duration", type: "range", max: 2000, min: 100, step: 5, value: 300 },
      brightness: { label: "FXMASTER.Params.Brightness", type: "range", max: 4.0, min: 0.0, step: 0.1, value: 1.3 },
    };

    const audio = {
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
        options: {
          music: "FXMASTER.Common.Music",
          environment: "FXMASTER.Common.Environment",
          interface: "FXMASTER.Common.Interface",
        },
        value: ["environment"],
        showWhen: { audioAware: true },
      },
      audioBassThreshold: {
        label: "FXMASTER.Params.AudioBassThreshold",
        type: "range",
        tooltip: "FXMASTER.ParamTooltips.AudioBassThreshold",
        max: 1.0,
        min: 0.0,
        step: 0.01,
        value: 0.75,
        showWhen: { audioAware: true },
      },
    };

    return {
      ...base,
      ...audio,
      aboveDarkness: {
        label: "FXMASTER.Params.AboveDarkness",
        type: "checkbox",
        value: false,
        tooltip: "FXMASTER.ParamTooltips.AboveDarkness",
      },
    };
  }

  /** @returns {{brightness:number}} Neutral option values. */
  static get neutral() {
    return { brightness: 1.0 };
  }

  /** @returns {boolean} Whether shader uniforms remain accessible. */
  _canAccessUniforms() {
    if (this.destroyed) return false;
    return true;
  }

  /** @returns {object|null} Active shader uniforms. */
  _getUniformsSafe() {
    if (!this._canAccessUniforms()) return null;
    try {
      const uniforms = this.uniforms;
      return uniforms && typeof uniforms === "object" ? uniforms : null;
    } catch {
      return null;
    }
  }

  /**
   * @param {number} generation Flash-generation token.
   * @returns {boolean} Whether the scheduled sequence remains active.
   */
  _isFlashGenerationActive(generation) {
    return generation === this._flashGeneration && this.enabled && !this.destroyed;
  }

  /** Cancel queued delays and active brightness animations. */
  _cancelFlashWork() {
    this._flashGeneration++;
    this._animating = false;

    for (const [timeoutId, resolve] of this._pendingFlashTimeouts) {
      clearTimeout(timeoutId);
      resolve(false);
    }
    this._pendingFlashTimeouts.clear();

    const animationApi = CONFIG.fxmaster.CanvasAnimationNS;
    for (const name of this._activeAnimations) {
      try {
        animationApi?.terminateAnimation?.(name);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
    this._activeAnimations.clear();
  }

  /** Remove the active flash driver ticker. */
  _removeTicker() {
    const t = this._driverTicker;
    if (!this._tickerFn) return;
    try {
      t?.remove(this._tickerFn);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    this._tickerFn = null;
    this._driverTicker = null;
  }

  /** @returns {"time"|"audio"} Active flash driver mode. */
  _getConfiguredDriverMode() {
    return this.audioAware ? "audio" : "time";
  }

  /** @returns {boolean} Whether synchronized mode suppresses autonomous flashes. */
  _isManualFlashOnly() {
    return !!this._fxpManualFlash;
  }

  /** Refresh the active driver after an option change. */
  _refreshDriverTicker() {
    const manualOnly = this._isManualFlashOnly();

    this._removeTicker();
    this._cancelFlashWork();
    this._accumMS = 0;
    this._nextMS = 0;
    this._audioPrevLevel = 0;
    this._audioWarmFrames = 0;
    this._lastPatternTime = 0;
    this._audioCooldownMS = this._sampleAudioCooldownMS();
    this.brightness = 1.0;

    if (!this.enabled || manualOnly) return;

    if (this._getConfiguredDriverMode() === "audio") {
      this._startAudioTicker();
      return;
    }

    this._nextMS = this._sampleIntervalMS();
    this._startTimeTicker();
  }

  /**
   * Wait for a cancellable gap between flashes.
   * @param {number} durationMs Gap duration in milliseconds.
   * @param {number} generation Flash-generation token.
   * @returns {Promise<boolean>} Whether the sequence remains active after the gap.
   */
  _waitForFlashGap(durationMs, generation) {
    if (!this._isFlashGenerationActive(generation)) return Promise.resolve(false);

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this._pendingFlashTimeouts.delete(timeoutId);
        resolve(this._isFlashGenerationActive(generation));
      }, Math.max(0, Number(durationMs) || 0));

      this._pendingFlashTimeouts.set(timeoutId, resolve);
    });
  }

  /**
   * Animate brightness to a target value.
   * @param {number} toVal Target brightness.
   * @param {number} duration Animation duration in milliseconds.
   * @param {Function} easing Easing function.
   * @param {number} generation Flash-generation token.
   * @returns {Promise<boolean>} Whether the sequence remains active after the animation.
   */
  _animateBrightness(toVal, duration, easing, generation) {
    if (!this._isFlashGenerationActive(generation)) return Promise.resolve(false);

    const animationApi = CONFIG.fxmaster.CanvasAnimationNS;
    if (typeof animationApi?.animate !== "function") {
      this.brightness = toVal;
      return Promise.resolve(true);
    }

    const name = `${packageId}.${this.constructor.name}.${this.id}.${foundry.utils.randomID()}`;
    this._activeAnimations.add(name);

    const attributes = [{ parent: this, attribute: "brightness", to: toVal }];
    return animationApi
      .animate(attributes, {
        name,
        context: this,
        duration,
        easing,
      })
      .then(() => this._isFlashGenerationActive(generation))
      .catch(() => false)
      .finally(() => {
        this._activeAnimations.delete(name);
      });
  }

  /** @returns {number} Current brightness multiplier. */
  get brightness() {
    const uniforms = this._getUniformsSafe();
    return typeof uniforms?.brightness === "number" ? uniforms.brightness : 1;
  }
  /** @param {number} v Brightness multiplier. */
  set brightness(v) {
    const uniforms = this._getUniformsSafe();
    if (!uniforms) return;
    uniforms.brightness = Math.max(0, Number(v) || 0);
  }

  /** @returns {number} Mean flash interval in milliseconds. */
  get frequency() {
    try {
      const value = Number(this.options?.frequency);
      return Number.isFinite(value) ? Math.max(100, Math.min(30000, value)) : 5000;
    } catch {
      return 5000;
    }
  }
  /** @param {number} v Mean flash interval in milliseconds. */
  set frequency(v) {
    const value = Number(v);
    this.options = {
      ...(this.options ?? {}),
      frequency: Number.isFinite(value) ? Math.max(100, Math.min(30000, value)) : 5000,
    };
  }

  /** @returns {number} Flash duration in milliseconds. */
  get spark_duration() {
    try {
      const value = Number(this.options?.spark_duration);
      return Number.isFinite(value) ? Math.max(100, Math.min(2000, value)) : 300;
    } catch {
      return 300;
    }
  }
  /** @param {number} v Flash duration in milliseconds. */
  set spark_duration(v) {
    const value = Number(v);
    this.options = {
      ...(this.options ?? {}),
      spark_duration: Number.isFinite(value) ? Math.max(100, Math.min(2000, value)) : 300,
    };
  }

  /** @returns {boolean} Whether audio-aware mode is enabled. */
  get audioAware() {
    try {
      return !!this.options?.audioAware;
    } catch {
      return false;
    }
  }
  /** @param {boolean} v Audio-aware state. */
  set audioAware(v) {
    this.options = { ...(this.options ?? {}), audioAware: !!v };
  }

  /** @returns {string[]} Selected audio channels. */
  get audioChannels() {
    try {
      const channel = this.options?.audioChannels;
      const arr = Array.isArray(channel) ? channel : channel ? [channel] : [];
      const valid = ["music", "environment", "interface"];
      const out = arr.filter((c) => valid.includes(c));
      return out.length ? out : ["environment"];
    } catch {
      return ["environment"];
    }
  }
  /** @param {string[]|string} v Selected audio channels. */
  set audioChannels(v) {
    const arr = Array.isArray(v) ? v : v ? [v] : [];
    this.options = { ...(this.options ?? {}), audioChannels: arr };
  }

  /** @returns {number} Bass threshold from zero to one. */
  get audioBassThreshold() {
    try {
      return Math.min(1, Math.max(0, Number(this.options?.audioBassThreshold ?? 0.75)));
    } catch {
      return 0.75;
    }
  }
  /** @param {number} v Bass threshold. */
  set audioBassThreshold(v) {
    const val = Math.min(1, Math.max(0, Number(v) || 0));
    this.options = { ...(this.options ?? {}), audioBassThreshold: val };
  }

  /** @param {object} [options={}] Filter options. */
  configure(options = {}) {
    const previousDriverMode = this._getConfiguredDriverMode();
    const previousFrequency = this.frequency;
    const previousAudioBassThreshold = this.audioBassThreshold;
    const previousAudioChannels = this.audioChannels.join("|");

    super.configure(options);
    const o = this.options;

    this.applyMaskOptionsFrom(o);

    const color = this.parseColorOption(o.color, { defaultHex: "#ffffff" }) ?? [1, 1, 1];
    const u = this._getUniformsSafe();
    if (u) {
      if (!(u.color instanceof Float32Array) || u.color.length < 3) u.color = new Float32Array([1, 1, 1]);
      u.color[0] = color[0];
      u.color[1] = color[1];
      u.color[2] = color[2];
    }

    if (typeof o.frequency === "number") this.frequency = o.frequency;
    if (typeof o.spark_duration === "number") this.spark_duration = o.spark_duration;

    if (typeof o.audioAware === "boolean") this.audioAware = o.audioAware;
    if (o.audioChannels !== undefined) this.audioChannels = o.audioChannels;
    if (typeof o.audioBassThreshold === "number") this.audioBassThreshold = o.audioBassThreshold;

    this.applyFadeOptionsFrom(o);

    const nextDriverMode = this._getConfiguredDriverMode();
    const nextAudioChannels = this.audioChannels.join("|");
    const tickerOptionsChanged =
      previousDriverMode !== nextDriverMode ||
      previousFrequency !== this.frequency ||
      previousAudioBassThreshold !== this.audioBassThreshold ||
      previousAudioChannels !== nextAudioChannels;

    if (tickerOptionsChanged) this._refreshDriverTicker();
  }

  /** @returns {number} Randomized delay until the next flash in milliseconds. */
  _sampleIntervalMS() {
    const mean = Math.max(50, this.frequency);
    const u = Math.random();
    const exp = -Math.log(1 - u) * mean;
    return Math.max(60, exp + (Math.random() - 0.5) * 0.15 * mean);
  }

  /** @returns {number} Randomized audio-trigger cooldown in milliseconds. */
  _sampleAudioCooldownMS() {
    const mean = Math.max(100, this.frequency);
    return Math.max(60, mean * (0.65 + Math.random() * 0.7));
  }

  /** @returns {Promise<boolean>} Whether one flash completed while still active. */
  _flashOnce(generation = this._flashGeneration) {
    if (!this._isFlashGenerationActive(generation)) return Promise.resolve(false);

    const basePeak = this.options?.brightness ?? 1.3;
    const peak = basePeak * (0.85 + Math.random() * 0.3);
    const baseDur = this.spark_duration;
    const dur = Math.max(60, baseDur * (0.9 + Math.random() * 0.2));
    const attackDur = Math.max(20, Math.min(45, dur * 0.12));
    const decayDur = Math.max(30, Math.min(140, dur * 0.22));
    const tailDur = Math.max(30, dur - attackDur - decayDur);
    const flash = Math.max(0, peak - 1.0);
    const afterglow = 1.0 + flash * 0.12;

    return this._animateBrightness(peak, attackDur, easeFunctions.OutCubic, generation)
      .then((advanced) => {
        if (!advanced) return false;
        return this._animateBrightness(afterglow, decayDur, easeFunctions.OutCirc, generation);
      })
      .then((advanced) => {
        if (!advanced) return false;
        return this._animateBrightness(1.0, tailDur, easeFunctions.OutSine, generation);
      })
      .catch(() => false);
  }

  /** Start the time-based flash driver. */
  _startTimeTicker() {
    const t = this.__fxmFilterContext?.ticker ?? canvas?.app?.ticker ?? PIXI.Ticker.shared;
    this._driverTicker = t;
    this._accumMS = 0;
    this._animating = false;
    this._tickerFn = () => {
      const dt = t.deltaMS || 16.6;
      this._accumMS += dt;
      if (!this._animating && this._accumMS >= this._nextMS) {
        const generation = this._flashGeneration;
        this._animating = true;
        this._accumMS = 0;
        this._nextMS = this._sampleIntervalMS();
        this._flashOnce(generation).finally(() => {
          if (generation === this._flashGeneration) this._animating = false;
        });
      }
    };
    t.add(this._tickerFn);
  }

  /** Start the bass-reactive flash driver. */
  _startAudioTicker() {
    this._audioPrevLevel = 0;
    this._audioWarmFrames = 0;
    this._lastPatternTime = 0;
    this._audioCooldownMS = this._sampleAudioCooldownMS();

    const IGNORE_VOL = true;
    const t = this.__fxmFilterContext?.ticker ?? canvas?.app?.ticker ?? PIXI.Ticker.shared;
    this._driverTicker = t;

    this._animating = false;
    this._tickerFn = () => {
      if (!this._animating && this.brightness !== 1.0) this.brightness = 1.0;

      const channels = this.audioChannels;
      const threshold = this.audioBassThreshold;

      let level = 0;
      try {
        for (const ctx of channels) {
          const v = game.audio.getBandLevel(ctx, "bass", { ignoreVolume: IGNORE_VOL }) || 0;
          if (v > level) level = v;
        }
      } catch {
        level = 0;
      }

      if (this._audioWarmFrames < 2) {
        this._audioWarmFrames++;
        this._audioPrevLevel = level;
        return;
      }

      const now = t.lastTime ?? performance.now();
      const rising = this._audioPrevLevel < threshold && level >= threshold;
      const cooled = now - this._lastPatternTime >= this._audioCooldownMS;

      if (!this._animating && rising && cooled) {
        this._lastPatternTime = now;
        this._audioCooldownMS = this._sampleAudioCooldownMS();
        this._triggerFlashPattern();
      }

      this._audioPrevLevel = level;
    };
    t.add(this._tickerFn);
  }

  /** Trigger one to three flashes with short randomized gaps. */
  _triggerFlashPattern() {
    const generation = this._flashGeneration;
    this._animating = true;
    const bursts = Math.random() < 0.7 ? 1 : Math.random() < 0.6 ? 2 : 3;
    let p = Promise.resolve(true);
    for (let i = 0; i < bursts; i++) {
      p = p.then((active) => {
        if (active === false || !this._isFlashGenerationActive(generation)) return false;
        return this._flashOnce(generation);
      });
      if (i < bursts - 1) {
        const gap = 40 + Math.random() * 120;
        p = p.then((active) => {
          if (active === false || !this._isFlashGenerationActive(generation)) return false;
          return this._waitForFlashGap(gap, generation);
        });
      }
    }
    p.finally(() => {
      if (generation === this._flashGeneration) this._animating = false;
    });
  }

  /** @returns {Promise<boolean>} Whether a non-overlapping synchronized flash completed. */
  flashOnce() {
    if (this._animating) return Promise.resolve(false);

    const generation = this._flashGeneration;
    this._animating = true;

    return Promise.resolve(this._flashOnce(generation)).finally(() => {
      if (generation === this._flashGeneration) this._animating = false;
    });
  }

  /**
   * @param {object} [options={}] Filter options.
   * @returns {this} Filter instance.
   */
  play(options = {}) {
    this._cancelFlashWork();
    this.configure(options);
    super.play(options);

    this._refreshDriverTicker();
    return this;
  }

  /**
   * @param {{skipFading?:boolean}} [options] Stop options.
   * @returns {Promise<any>} Stop result.
   */
  async stop({ durationMs = 3000, skipFading } = {}) {
    this._removeTicker();
    return this.stopWithUniformFade({
      durationMs,
      skipFading,
      onDone: () => {
        this._cancelFlashWork();
        this._accumMS = 0;
        this._animating = false;
        this._audioPrevLevel = 0;
        this._audioWarmFrames = 0;
        this._lastPatternTime = 0;
        const uniforms = this._getUniformsSafe();
        if (uniforms) uniforms.brightness = 1.0;
      },
    });
  }

  /** @param {object} [options] Destruction options. */
  destroy(options) {
    this._removeTicker();
    this._cancelFlashWork();
    super.destroy(options);
  }

  /** Apply the filter within the scene rendering area. */
  apply(filterSystem, input, output, clear, currentState) {
    return this.applyWithLock(filterSystem, input, output, clear, currentState, {
      area: "sceneRect",
      setDeviceToCss: false,
    });
  }
}
