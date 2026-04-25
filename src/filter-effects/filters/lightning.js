import { FXMasterFilterEffectMixin, preprocessShader } from "./mixins/filter.js";
import fragment from "./shaders/lightning.frag";
import { packageId, MAX_EDGES } from "../../constants.js";
import { easeFunctions } from "../../ease.js";
import { logger } from "../../logger.js";

/**
 * LightningFilter
 * ---------------
 * Scene/region lightning flashes.
 * - Procedural flashes driven by a ticker using randomized intervals.
 */
export class LightningFilter extends FXMasterFilterEffectMixin(PIXI.Filter) {
  /**
   * Construct a LightningFilter, wiring mask and fade uniforms, and defaults.
   * @param {object} [options={}] - Initial filter options.
   * @param {string} [id] - Stable id for filter instances.
   */
  constructor(options = {}, id) {
    super(options, id, PIXI.Filter.defaultVertex, preprocessShader(fragment));

    const u = (this.uniforms ??= {});
    this.initMaskUniforms(u, { withStrength: false });
    this.initFadeUniforms(u);
    this.initRegionFadeUniforms(u, { maxEdges: MAX_EDGES });

    this.ensureVec4Uniform("srcFrame", [0, 0, 1, 1]);
    this.ensureVec2Uniform("camFrac", [0, 0]);
    this.ensureVec4Uniform("outputFrame", [0, 0, 1, 1]);

    u.brightness = typeof u.brightness === "number" ? u.brightness : 1.0;

    this._tickerFn = null;
    this._accumMS = 0;
    this._nextMS = 0;
    this._animating = false;
    this._flashGeneration = 0;
    this._activeAnimations = new Set();
    this._pendingFlashTimeouts = new Set();

    this.configure(options);
    this._nextMS = this._sampleIntervalMS();
  }

  /** i18n label key used by UI. */
  static label = "FXMASTER.Filters.Effects.Lightning";

  /** FontAwesome icon class used by UI. */
  static icon = "fas fa-bolt-lightning";

  /**
   * Parameter schema exposed to configuration UIs.
   * @returns {Record<string, object>} Parameter descriptors.
   */
  static get parameters() {
    const base = {
      belowTokens: { label: "FXMASTER.Params.BelowTokens", type: "checkbox", value: false },
      belowTiles: { label: "FXMASTER.Params.BelowTiles", type: "checkbox", value: false },
      soundFxEnabled: { label: "FXMASTER.Params.SoundFxEnabled", type: "checkbox", value: false },
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
      audioAware: { label: "FXMASTER.Params.ThunderAware", type: "checkbox", value: false },
      audioChannels: {
        label: "FXMASTER.Params.ThunderChannels",
        type: "multi-select",
        options: {
          music: "FXMASTER.Common.Music",
          environment: "FXMASTER.Common.Environment",
          interface: "FXMASTER.Common.Interface",
        },
        value: ["environment"],
        showWhen: { audioAware: true },
      },
      audioBassThreshold: {
        label: "FXMASTER.Params.ThunderBassThreshold",
        type: "range",
        max: 1.0,
        min: 0.0,
        step: 0.01,
        value: 0.75,
        showWhen: { audioAware: true },
      },
    };

    return { ...base, ...audio };
  }

  /**
   * Neutral (no-op) option values.
   * @returns {{brightness:number}}
   */
  static get neutral() {
    return { brightness: 1.0 };
  }

  /**
   * Return whether the filter can safely access shader-backed uniforms.
   *
   * @returns {boolean}
   */
  _canAccessUniforms() {
    if (this.destroyed || this._destroyed) return false;
    return true;
  }

  /**
   * Safely read the live uniforms object.
   *
   * @returns {object|null}
   */
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
   * Determine whether a scheduled flash sequence is still valid.
   *
   * @param {number} generation - The flash-generation token captured by the caller.
   * @returns {boolean}
   */
  _isFlashGenerationActive(generation) {
    return generation === this._flashGeneration && this.enabled && !this.destroyed && !this._destroyed;
  }

  /**
   * Terminate all queued timeouts and active CanvasAnimation instances used by lightning flashes.
   *
   * @returns {void}
   */
  _cancelFlashWork() {
    this._flashGeneration++;
    this._animating = false;

    for (const timeoutId of this._pendingFlashTimeouts) {
      clearTimeout(timeoutId);
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

  /**
   * Remove the currently bound driver ticker.
   *
   * @returns {void}
   */
  _removeTicker() {
    const t = canvas?.app?.ticker ?? PIXI.Ticker.shared;
    if (!this._tickerFn) return;
    try {
      t.remove(this._tickerFn);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    this._tickerFn = null;
  }

  /**
   * Return the active driver mode implied by the current options.
   *
   * @returns {"time"|"audio"}
   */
  _getConfiguredDriverMode() {
    return this.audioAware ? "audio" : "time";
  }

  /**
   * Return whether synchronized manual-flash mode is currently holding the autonomous ticker.
   *
   * @returns {boolean}
   */
  _isManualFlashOnly() {
    return !!this._fxpManualFlash;
  }

  /**
   * Refresh the active driver ticker after an option change.
   *
   * @returns {void}
   */
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
   * Wait for a short flash-pattern gap while allowing pending work to be cancelled.
   *
   * @param {number} durationMs - Gap duration in milliseconds.
   * @param {number} generation - Flash-generation token captured by the caller.
   * @returns {Promise<boolean>} Resolves `true` when the delay completes while still active.
   */
  _waitForFlashGap(durationMs, generation) {
    if (!this._isFlashGenerationActive(generation)) return Promise.resolve(false);

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this._pendingFlashTimeouts.delete(timeoutId);
        resolve(this._isFlashGenerationActive(generation));
      }, Math.max(0, Number(durationMs) || 0));

      this._pendingFlashTimeouts.add(timeoutId);
    });
  }

  /**
   * Run a named CanvasAnimation attribute tween for brightness.
   *
   * @param {number} toVal - Target brightness.
   * @param {number} duration - Tween duration in milliseconds.
   * @param {Function} easing - Easing function.
   * @param {number} generation - Flash-generation token captured by the caller.
   * @returns {Promise<boolean>}
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

  /** @returns {number} Current brightness multiplier. */ get brightness() {
    const uniforms = this._getUniformsSafe();
    return typeof uniforms?.brightness === "number" ? uniforms.brightness : 1;
  }
  /** @param {number} v */ set brightness(v) {
    const uniforms = this._getUniformsSafe();
    if (!uniforms) return;
    uniforms.brightness = Math.max(0, Number(v) || 0);
  }

  /** @returns {number} Mean flash interval (ms). */ get frequency() {
    try {
      return this.options?.frequency;
    } catch {
      return 500;
    }
  }
  /** @param {number} v */ set frequency(v) {
    this.options = { ...(this.options ?? {}), frequency: Math.max(1, Number(v) || 1) };
  }

  /** @returns {number} Flash duration (ms). */ get spark_duration() {
    try {
      return this.options?.spark_duration;
    } catch {
      return 300;
    }
  }
  /** @param {number} v */ set spark_duration(v) {
    this.options = { ...(this.options ?? {}), spark_duration: Math.max(1, Number(v) || 1) };
  }

  /** @returns {boolean} Audio-aware mode. */ get audioAware() {
    try {
      return !!this.options?.audioAware;
    } catch {
      return false;
    }
  }
  /** @param {boolean} v */ set audioAware(v) {
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
  /** @param {string[]|string} v */
  set audioChannels(v) {
    const arr = Array.isArray(v) ? v : v ? [v] : [];
    this.options = { ...(this.options ?? {}), audioChannels: arr };
  }

  /** @returns {number} Bass threshold 0..1. */
  get audioBassThreshold() {
    try {
      return Math.min(1, Math.max(0, Number(this.options?.audioBassThreshold ?? 0.75)));
    } catch {
      return 0.75;
    }
  }
  /** @param {number} v */
  set audioBassThreshold(v) {
    const val = Math.min(1, Math.max(0, Number(v) || 0));
    this.options = { ...(this.options ?? {}), audioBassThreshold: val };
  }

  /**
   * Configure filter uniforms and state from options. Updates mask options, brightness, timing, and optional region fade percent.
   * @param {object} [options={}] - Options payload.
   */
  configure(options = {}) {
    const previousDriverMode = this._getConfiguredDriverMode();
    const previousFrequency = this.frequency;
    const previousAudioBassThreshold = this.audioBassThreshold;
    const previousAudioChannels = this.audioChannels.join("|");

    super.configure(options);
    const o = this.options;

    this.applyMaskOptionsFrom(o);

    if (typeof o.brightness === "number") this.brightness = o.brightness;
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

  /**
   * Sample a randomized interval (ms) for the next flash using an exponential distribution.
   * @returns {number} Milliseconds until the next flash.
   * @private
   */
  _sampleIntervalMS() {
    const mean = Math.max(50, this.frequency);
    const u = Math.random();
    const exp = -Math.log(1 - u) * mean;
    return Math.max(60, exp + (Math.random() - 0.5) * 0.15 * mean);
  }

  /** Mean cooldown around current frequency with ±35% jitter (audio mode). */
  _sampleAudioCooldownMS() {
    const mean = Math.max(60, this.frequency || 500);
    return Math.max(60, mean * (0.65 + Math.random() * 0.7));
  }

  /**
   * Run a single flash animation: ease up to peak, then ease back to 1.0.
   * @returns {Promise<void>} Resolves when the flash finishes.
   * @private
   */
  _flashOnce(generation = this._flashGeneration) {
    if (!this._isFlashGenerationActive(generation)) return Promise.resolve(false);

    const basePeak = this.options?.brightness ?? 1.3;
    const peak = basePeak * (0.85 + Math.random() * 0.3);
    const baseDur = this.spark_duration;
    const dur = Math.max(60, baseDur * (0.9 + Math.random() * 0.2));
    const upDur = Math.max(30, dur * 0.3);
    const downDur = Math.max(30, dur - upDur);

    return this._animateBrightness(peak, upDur, easeFunctions.OutCubic, generation)
      .then((advanced) => {
        if (!advanced) return false;
        return this._animateBrightness(1.0, downDur, easeFunctions.InQuad, generation);
      })
      .catch(() => false);
  }

  /** Start time-based ticker */
  _startTimeTicker() {
    const t = canvas?.app?.ticker ?? PIXI.Ticker.shared;
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

  /** Start audio-driven ticker (bass-reactive across selected channels) */
  _startAudioTicker() {
    this._audioPrevLevel = 0;
    this._audioWarmFrames = 0;
    this._lastPatternTime = 0;
    this._audioCooldownMS = this._sampleAudioCooldownMS();

    const IGNORE_VOL = true;
    const t = canvas?.app?.ticker ?? PIXI.Ticker.shared;

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

  /** Randomized burst: 1–3 flashes with short jittered gaps (audio mode). */
  _triggerFlashPattern() {
    const generation = this._flashGeneration;
    this._animating = true;
    const bursts = Math.random() < 0.7 ? 1 : Math.random() < 0.6 ? 2 : 3;
    let p = Promise.resolve();
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

  /**
   * Trigger a single flash while preventing overlapping manual sync flashes.
   *
   * @returns {Promise<boolean>}
   */
  flashOnce() {
    if (this._animating) return Promise.resolve(false);

    const generation = this._flashGeneration;
    this._animating = true;

    return Promise.resolve(this._flashOnce(generation)).finally(() => {
      if (generation === this._flashGeneration) this._animating = false;
    });
  }

  /**
   * Ticker that triggers flashes at intervals
   * @param {object} [options={}] - Options payload.
   * @returns {this} The filter instance.
   */
  play(options = {}) {
    this._cancelFlashWork();
    this.configure(options);
    this.enabled = true;

    this._refreshDriverTicker();
    return this;
  }

  /**
   * Removes ticker, resets brightness, and clears mask uniforms.
   * @param {{skipFading?:boolean}} [opts]
   * @returns {Promise<any>} Awaitable stop result.
   */
  async stop({ skipFading = true } = {}) {
    this._cancelFlashWork();
    this._removeTicker();
    this._accumMS = 0;
    this._animating = false;
    this._audioPrevLevel = 0;
    this._audioWarmFrames = 0;
    this._lastPatternTime = 0;

    this.cancelUniformFade?.();
    this.neutralizeMask();
    const uniforms = this._getUniformsSafe();
    if (uniforms) uniforms.brightness = 1.0;

    return super.stop?.({ skipFading });
  }

  /**
   * Destroy the filter and terminate active flash work first.
   *
   * @param {object} [options] - PIXI destroy options.
   * @returns {void}
   */
  destroy(options) {
    this._cancelFlashWork();
    super.destroy(options);
  }

  /**
   * Run apply lock and scene-rect area
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
