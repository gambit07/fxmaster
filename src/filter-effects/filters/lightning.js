import { FXMasterFilterEffectMixin } from "./mixins/filter.js";
import fragment from "./shaders/lightning.frag";
import { packageId, MAX_EDGES } from "../../constants.js";
import { easeFunctions } from "../../ease.js";

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
    super(options, id, PIXI.Filter.defaultVertex, fragment);

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
    const v13plus = !foundry.utils.isNewerVersion("13.0.0", game.version);

    const base = {
      belowTokens: { label: "FXMASTER.Params.BelowTokens", type: "checkbox", value: false },
      frequency: { label: "FXMASTER.Params.Period", type: "range", max: 10000, min: 100, step: 5, value: 500 },
      spark_duration: { label: "FXMASTER.Params.Duration", type: "range", max: 2000, min: 100, step: 5, value: 300 },
      brightness: { label: "FXMASTER.Params.Brightness", type: "range", max: 4.0, min: 0.0, step: 0.1, value: 1.3 },
    };

    const audio = v13plus
      ? {
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
        }
      : {};

    return { ...base, ...audio };
  }

  /**
   * Neutral (no-op) option values.
   * @returns {{brightness:number}}
   */
  static get neutral() {
    return { brightness: 1.0 };
  }

  /** @returns {number} Current brightness multiplier. */ get brightness() {
    try {
      return this.uniforms?.brightness;
    } catch {
      return 1;
    }
  }
  /** @param {number} v */ set brightness(v) {
    try {
      this.uniforms.brightness = Math.max(0, Number(v) || 0);
    } catch {}
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
   * Configure filter uniforms and state from options.
   * Updates mask options, brightness, timing, and optional region fade percent.
   * @param {object} [options={}] - Options payload.
   */
  configure(options = {}) {
    super.configure(options);
    const o = this.options;

    this.applyMaskOptionsFrom(o);

    if (typeof o.brightness === "number") this.brightness = o.brightness;
    if (typeof o.frequency === "number") this.frequency = o.frequency;
    if (typeof o.spark_duration === "number") this.spark_duration = o.spark_duration;

    const v13plus = !foundry.utils.isNewerVersion("13.0.0", game.version);
    if (v13plus) {
      if (typeof o.audioAware === "boolean") this.audioAware = o.audioAware;
      if (o.audioChannels !== undefined) this.audioChannels = o.audioChannels;
      if (typeof o.audioBassThreshold === "number") this.audioBassThreshold = o.audioBassThreshold;
    } else {
      this.audioAware = false;
    }

    this.applyFadeOptionsFrom(o);
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
  _flashOnce() {
    const basePeak = this.options?.brightness ?? 1.3;
    const peak = basePeak * (0.85 + Math.random() * 0.3);
    const baseDur = this.spark_duration;
    const dur = Math.max(60, baseDur * (0.9 + Math.random() * 0.2));
    const upDur = Math.max(30, dur * 0.3);
    const downDur = Math.max(30, dur - upDur);

    const animate = (toVal, duration, easing) => {
      const attributes = [{ parent: this, attribute: "brightness", to: toVal }];
      return CONFIG.fxmaster.CanvasAnimationNS.animate(attributes, {
        name: `${packageId}.${this.constructor.name}.${this.id}.${foundry.utils.randomID()}`,
        context: this,
        duration,
        easing,
      });
    };

    return animate(peak, upDur, easeFunctions.OutCubic)
      .then(() => animate(1.0, downDur, easeFunctions.InQuad))
      .catch(() => {});
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
        this._animating = true;
        this._accumMS = 0;
        this._nextMS = this._sampleIntervalMS();
        this._flashOnce().finally(() => {
          this._animating = false;
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

    const channels = this.audioChannels;

    const THRESH = this.audioBassThreshold;
    const IGNORE_VOL = true;
    const t = canvas?.app?.ticker ?? PIXI.Ticker.shared;

    this._animating = false;
    this._tickerFn = () => {
      if (!this._animating && this.brightness !== 1.0) this.brightness = 1.0;

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
      const rising = this._audioPrevLevel < THRESH && level >= THRESH;
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
    this._animating = true;
    const bursts = Math.random() < 0.7 ? 1 : Math.random() < 0.6 ? 2 : 3;
    let p = Promise.resolve();
    for (let i = 0; i < bursts; i++) {
      p = p.then(() => this._flashOnce());
      if (i < bursts - 1) {
        const gap = 40 + Math.random() * 120; // 40–160ms between sub-flashes
        p = p.then(() => new Promise((res) => setTimeout(res, gap)));
      }
    }
    p.finally(() => {
      this._animating = false;
    });
  }

  /**
   * Ticker that triggers flashes at intervals
   * @param {object} [options={}] - Options payload.
   * @returns {this} The filter instance.
   */
  play(options = {}) {
    this.configure(options);
    this.enabled = true;

    const t = canvas?.app?.ticker ?? PIXI.Ticker.shared;
    if (this._tickerFn) {
      try {
        t.remove(this._tickerFn);
      } catch {}
      this._tickerFn = null;
    }

    if (this.audioAware) {
      this.brightness = 1.0;
      this._startAudioTicker();
    } else {
      this._nextMS = this._sampleIntervalMS();
      this._startTimeTicker();
    }
    return this;
  }

  /**
   * Removes ticker, resets brightness, and clears mask uniforms.
   * @param {{skipFading?:boolean}} [opts]
   * @returns {Promise<any>} Awaitable stop result.
   */
  async stop({ skipFading = true } = {}) {
    const t = canvas?.app?.ticker ?? PIXI.Ticker.shared;
    if (this._tickerFn) {
      try {
        t.remove(this._tickerFn);
      } catch {}
      this._tickerFn = null;
    }
    this._accumMS = 0;
    this._animating = false;
    this._audioPrevLevel = 0;
    this._audioWarmFrames = 0;
    this._lastPatternTime = 0;

    this.cancelUniformFade?.();
    this.neutralizeMask();
    try {
      if (this.uniforms) {
        this.uniforms.brightness = 1.0;
      }
    } catch {}

    return super.stop?.({ skipFading });
  }

  /**
   *Run apply lock and scene-rect area
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
