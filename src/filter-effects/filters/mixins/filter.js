/**
 * FXMasterFilterEffectMixin
 * -------------------------
 * Provides option plumbing, viewport locking, mask helpers, and lifecycle.
 * `applyWithLock()` clamps `this.resolution` so the pass never exceeds gl.MAX_TEXTURE_SIZE along either edge.
 */

export const normalize = (opts) => {
  const out = {};
  if (!opts || typeof opts !== "object") return out;
  for (const [k, v] of Object.entries(opts)) {
    if (v && typeof v === "object" && "value" in v && Object.keys(v).length <= 2) {
      out[k] = v.value;
      if (k === "color" && typeof v.apply === "boolean") {
        out.color = { value: v.value, apply: v.apply };
      }
    } else {
      out[k] = v;
    }
  }
  return out;
};

export function FXMasterFilterEffectMixin(Base) {
  return class extends Base {
    constructor(options, id, ...args) {
      super(...args);
      this.id = id;
      this.enabled = false;

      try {
        const r = canvas?.app?.renderer;
        if (r) {
          this.resolution = r.resolution || 1;
          this.filterArea = new PIXI.Rectangle(0, 0, r.screen.width | 0, r.screen.height | 0);
        }
      } catch {}
      this.autoFit = false;
      this.padding = 0;

      this.options = { ...this.constructor.default, ...(options ?? {}) };
      this.applyOptions(this.options);
      this.applyOptions(this.constructor.neutral);

      this._fxTickers = [];
      this._fadeCancel = null;
      this._fadeGen = 0;
    }

    static label = "FXMASTER.Common.FilterEffect";
    static icon = "fas fa-filter";
    static get parameters() {
      return {};
    }
    static get default() {
      return Object.fromEntries(Object.entries(this.parameters).map(([k, cfg]) => [k, cfg.value]));
    }
    static get neutral() {
      return {};
    }

    configure(options) {
      const incoming = options ?? {};
      this.options = { ...this.constructor.default, ...this.options, ...incoming };
      this.options = normalize(this.options);
    }

    get optionContext() {
      return this;
    }

    applyOptions(options = this.options) {
      const normalized = normalize(options) || {};
      for (const [key, val] of Object.entries(normalized)) this.optionContext[key] = val;
    }

    play(_options = {}) {
      this.cancelUniformFade?.();
      this._fadeGen++;
      this.applyOptions(this.options);
      this.enabled = true;

      try {
        if (this.uniforms && typeof this.uniforms.strength === "number") {
          const raw = this.options?.strength;
          const val =
            raw && typeof raw === "object" && "value" in raw
              ? raw.value
              : typeof raw === "number"
              ? raw
              : this.constructor?.default?.strength ?? 1;
          this.uniforms.strength = Number.isFinite(val) ? val : 1;
        }
      } catch {}

      return this;
    }

    async stop(_options = {}) {
      this.enabled = false;
      this.cancelUniformFade?.();
      this.removeAllFilterTickers?.();
      this.neutralizeMask?.();
      this.applyOptions(this.constructor.neutral);
      return true;
    }

    async step() {}

    lockViewport(opts = {}) {
      const { area = "sceneRect", setSrcFrame = true, setCamFrac = true, setDeviceToCss = true } = opts;

      const r = canvas?.app?.renderer;
      if (!r) return;

      const sw = r.screen?.width | 0 || 1;
      const sh = r.screen?.height | 0 || 1;

      let fx = 0,
        fy = 0,
        fw = sw,
        fh = sh;
      if (area === "sceneRect") {
        try {
          const rect = canvas?.scene?.dimensions?.sceneRect;
          if (rect) {
            const rx0 = rect.x | 0,
              ry0 = rect.y | 0;
            const rx1 = (rect.x + rect.width) | 0;
            const ry1 = (rect.y + rect.height) | 0;
            const ix0 = Math.max(0, rx0),
              iy0 = Math.max(0, ry0);
            const ix1 = Math.min(sw, rx1),
              iy1 = Math.min(sh, ry1);
            fx = Math.max(0, ix0);
            fy = Math.max(0, iy0);
            fw = Math.max(0, ix1 - ix0);
            fh = Math.max(0, iy1 - iy0);
            if (fw === 0 || fh === 0) {
              fx = 0;
              fy = 0;
              fw = sw;
              fh = sh;
            }
          }
        } catch {}
      }

      try {
        this.filterArea = new PIXI.Rectangle(fx, fy, fw, fh);
      } catch {}
      this.autoFit = false;
      this.padding = 0;

      const u = this.uniforms || {};

      if (setSrcFrame && "srcFrame" in u) {
        u.srcFrame =
          u.srcFrame instanceof Float32Array
            ? (u.srcFrame.set([0, 0, sw, sh]), u.srcFrame)
            : new Float32Array([0, 0, sw, sh]);
      }

      if (setCamFrac && "camFrac" in u) {
        const r = canvas?.app?.renderer;
        const res = r?.resolution || window.devicePixelRatio || 1;
        const M = canvas?.stage?.worldTransform;

        const fxFrac = M ? (M.tx * res - Math.round(M.tx * res)) / res : 0;
        const fyFrac = M ? (M.ty * res - Math.round(M.ty * res)) / res : 0;
        u.camFrac =
          u.camFrac instanceof Float32Array
            ? (u.camFrac.set([fxFrac, fyFrac]), u.camFrac)
            : new Float32Array([fxFrac, fyFrac]);
      }

      if (setDeviceToCss && "deviceToCss" in u) {
        const v = 1 / (r.resolution || window.devicePixelRatio || 1);
        if (!(typeof u.deviceToCss === "number" && u.deviceToCss > 0)) u.deviceToCss = v;
      }
    }

    writeSrcFrameFrom(filterSystem, currentState) {
      const u = this.uniforms || {};
      if (!("srcFrame" in u)) return;

      const r = canvas?.app?.renderer;
      const wCSS = r?.screen?.width | 0 || 1;
      const hCSS = r?.screen?.height | 0 || 1;

      const A = filterSystem?.activeState ?? currentState;
      const sf = A?.sourceFrame;

      if (u.srcFrame instanceof Float32Array && u.srcFrame.length >= 4) {
        if (sf) {
          u.srcFrame[0] = sf.x || 0;
          u.srcFrame[1] = sf.y || 0;
          u.srcFrame[2] = sf.width || wCSS;
          u.srcFrame[3] = sf.height || hCSS;
        } else {
          u.srcFrame[0] = 0;
          u.srcFrame[1] = 0;
          u.srcFrame[2] = wCSS;
          u.srcFrame[3] = hCSS;
        }
      } else {
        u.srcFrame = new Float32Array(
          sf ? [sf.x || 0, sf.y || 0, sf.width || wCSS, sf.height || hCSS] : [0, 0, wCSS, hCSS],
        );
      }
    }

    updateOutputFrame(filterSystem, key = "outputFrame") {
      const u = this.uniforms;
      if (!u) return;
      const dest = filterSystem?.activeState?.destinationFrame || filterSystem?.destinationFrame;
      if (!dest) return;
      const arr = u[key] instanceof Float32Array && u[key].length >= 4 ? u[key] : new Float32Array(4);
      arr[0] = dest.x || 0;
      arr[1] = dest.y || 0;
      arr[2] = dest.width || 1;
      arr[3] = dest.height || 1;
      u[key] = arr;
    }

    lockAndSync(filterSystem, currentState, lockOpts = {}) {
      this.lockViewport(lockOpts);
      this.writeSrcFrameFrom(filterSystem, currentState);
      this.updateOutputFrame(filterSystem);
    }

    /** FINAL GUARD: clamp this.resolution before delegating to Pixi.Filter.apply */
    applyWithLock(
      filterSystem,
      input,
      output,
      clear,
      currentState,
      lockOpts = { area: "sceneRect", setDeviceToCss: false },
    ) {
      this.lockAndSync(filterSystem, currentState, lockOpts);

      try {
        const r = canvas?.app?.renderer;
        const gl = r?.gl;
        const max = gl?.getParameter?.(gl.MAX_TEXTURE_SIZE) || 8192;

        const area = this.filterArea instanceof PIXI.Rectangle ? this.filterArea : r?.screen ?? { width: 1, height: 1 };
        const wCSS = Math.max(1, area.width | 0);
        const hCSS = Math.max(1, area.height | 0);

        const base = r?.resolution || window.devicePixelRatio || 1;
        const safe = Math.max(0.5, Math.min(base, max / Math.max(wCSS, hCSS)));

        if (!Number.isFinite(this.resolution) || this.resolution > safe || this.resolution <= 0) {
          this.resolution = safe;
        }
      } catch {}

      return super.apply(filterSystem, input, output, clear, currentState);
    }

    initMaskUniforms(u = this.uniforms, { withStrength = false, strengthDefault = 1.0 } = {}) {
      if (!u) return;
      u.maskSampler = u.maskSampler || PIXI.Texture.EMPTY;
      u.viewSize = u.viewSize || new Float32Array([1, 1]);
      u.hasMask = typeof u.hasMask === "number" ? u.hasMask : 0.0;
      u.maskReady = typeof u.maskReady === "number" ? u.maskReady : 0.0;
      u.invertMask = typeof u.invertMask === "number" ? u.invertMask : 0.0;
      if (withStrength) u.strength = typeof u.strength === "number" ? u.strength : strengthDefault;
      return u;
    }

    applyMaskOptionsFrom(options = {}) {
      const u = this.uniforms;
      if (!u || !options) return;
      if ("maskSampler" in options && options.maskSampler) {
        u.maskSampler = options.maskSampler;
        try {
          const bt = u.maskSampler.baseTexture;
          if (bt) {
            bt.scaleMode = PIXI.SCALE_MODES.LINEAR;
            if (typeof PIXI.MIPMAP_MODES !== "undefined") bt.mipmap = PIXI.MIPMAP_MODES.OFF;
          }
        } catch {}
      }
      if ("hasMask" in options && typeof options.hasMask === "number") u.hasMask = options.hasMask;
      if ("maskReady" in options && typeof options.maskReady === "number") u.maskReady = options.maskReady;
      if ("invertMask" in options && typeof options.invertMask === "number") u.invertMask = options.invertMask;
      if ("viewSize" in options && Array.isArray(options.viewSize) && options.viewSize.length === 2) {
        u.viewSize = new Float32Array([Math.max(1, options.viewSize[0] | 0), Math.max(1, options.viewSize[1] | 0)]);
      }
    }

    neutralizeMask() {
      const u = this.uniforms;
      if (!u) return;
      if ("maskReady" in u) u.maskReady = 0.0;
      if ("hasMask" in u) u.hasMask = 0.0;
      if ("invertMask" in u) u.invertMask = 0.0;
      if ("maskSampler" in u) {
        try {
          u.maskSampler = PIXI.Texture.EMPTY;
        } catch {}
      }
    }

    ensureVec2Uniform(key, def = [0, 0]) {
      const u = this.uniforms || (this.uniforms = {});
      const a = u[key];
      if (a instanceof Float32Array && a.length >= 2) return a;
      u[key] = new Float32Array(def.length >= 2 ? def.slice(0, 2) : [0, 0]);
      return u[key];
    }

    ensureVec4Uniform(key, def = [0, 0, 1, 1]) {
      const u = this.uniforms || (this.uniforms = {});
      const a = u[key];
      if (a instanceof Float32Array && a.length >= 4) return a;
      u[key] = new Float32Array(def.length >= 4 ? def.slice(0, 4) : [0, 0, 1, 1]);
      return u[key];
    }

    parseColorOption(raw, { defaultHex = "#000000" } = {}) {
      if (typeof raw === "string") {
        const rgb = [0, 0, 0];
        try {
          PIXI.utils.hex2rgb(PIXI.utils.string2hex(raw), rgb);
        } catch {}
        return rgb;
      }
      if (raw && typeof raw === "object") {
        const hex = raw.value ?? defaultHex;
        const apply = !!raw.apply;
        if (!apply) return [0, 0, 0];
        const rgb = [0, 0, 0];
        try {
          PIXI.utils.hex2rgb(PIXI.utils.string2hex(hex), rgb);
        } catch {}
        return rgb;
      }
      return null;
    }

    addFilterTicker(cb, { priority } = {}) {
      if (typeof cb !== "function") return () => {};
      const ticker = canvas?.app?.ticker ?? PIXI.Ticker.shared;
      const fn = () => {
        try {
          cb(ticker.deltaMS ?? 16.6);
        } catch {}
      };
      try {
        if (priority != null && ticker.add.length >= 3) ticker.add(fn, this, priority);
        else ticker.add(fn, this);
        (this._fxTickers ||= []).push({ ticker, fn });
      } catch {}
      return () => this.removeFilterTicker(fn);
    }

    removeFilterTicker(fn) {
      const ticker = canvas?.app?.ticker ?? PIXI.Ticker.shared;
      try {
        ticker.remove(fn, this);
      } catch {}
      this._fxTickers = (this._fxTickers || []).filter((t) => t.fn !== fn);
    }

    removeAllFilterTickers() {
      const ticker = canvas?.app?.ticker ?? PIXI.Ticker.shared;
      for (const { fn } of this._fxTickers || []) {
        try {
          ticker.remove(fn, this);
        } catch {}
      }
      this._fxTickers = [];
    }

    destroy(options) {
      this.cancelUniformFade?.();
      this.removeAllFilterTickers?.();
      super.destroy?.(options);
    }

    /** Cancel any active uniform fade, if present. */
    cancelUniformFade() {
      try {
        this._fadeCancel?.();
      } catch {}
      this._fadeCancel = null;
    }

    /**
     * Animate a uniform from its current numeric value to 'to' over durationMs.
     * Stores a cancel function on this._fadeCancel for cancelUniformFade().
     */
    _startUniformFade(uniformKey, { to, durationMs, easing, onDone }) {
      const tkr = canvas?.app?.ticker;
      if (!tkr || !this.uniforms) {
        try {
          this.uniforms[uniformKey] = to;
        } catch {}
        return onDone?.();
      }

      const ease = typeof easing === "function" ? easing : (t) => t;
      const start = Number(this.uniforms[uniformKey]) || 0;
      const delta = to - start;

      let elapsed = 0;
      const tick = () => {
        const dt = tkr.deltaMS ?? 16.6;
        elapsed += dt;
        const t = Math.min(1, elapsed / durationMs);
        const k = ease(t);
        try {
          this.uniforms[uniformKey] = start + delta * k;
        } catch {}

        if (t >= 1) {
          this._fadeCancel?.();
          this._fadeCancel = null;
          try {
            this.uniforms[uniformKey] = to;
          } catch {}
          try {
            onDone?.();
          } catch {}
        }
      };

      tkr.add(tick, this);
      this._fadeCancel = () => {
        try {
          tkr.remove(tick, this);
        } catch {}
      };
    }

    /**
     * Fade a uniform to a target value, then stop the filter with consistent teardown.
     * Returns a Promise<boolean> that resolves true when fully stopped.
     *
     * options:
     * - uniformKey: string                // which uniform to fade (default "strength")
     * - durationMs: number                // fade duration in ms (default 3000)
     * - to: number                        // target uniform value (default 0)
     * - skipFading: boolean               // if true, jumps to 'to' immediately
     * - disableOnDone: boolean            // disable filter when done (default true)
     * - neutralizeMaskOnStop: boolean     // clear mask uniforms when done (default true)
     * - removeTickersOnStop: boolean      // remove any filter tickers (default true)
     * - easing: (t)=>t                    // easing function, t in [0,1] (default linear)
     * - onDone: ()=>void                  // optional hook after stop completes
     */
    stopWithUniformFade({
      uniformKey = "strength",
      durationMs = 3000,
      to = 0,
      skipFading,
      disableOnDone = true,
      neutralizeMaskOnStop = true,
      removeTickersOnStop = true,
      easing,
      onDone,
    } = {}) {
      const skip = Boolean(skipFading);
      const myGen = ++this._fadeGen;

      this.cancelUniformFade?.();

      const tkr = canvas?.app?.ticker;
      const u = this.uniforms ?? {};

      const finish = () => {
        if (myGen !== this._fadeGen) return;
        if (neutralizeMaskOnStop) this.neutralizeMask?.();
        if (removeTickersOnStop) this.removeAllFilterTickers?.();
        if (disableOnDone) this.enabled = false;

        const out = super.stop?.({ skipFading: true }) ?? true;
        const done = (res) => {
          try {
            onDone?.();
          } catch {}
          return !!res;
        };
        return out instanceof Promise ? out.then(done) : Promise.resolve(done(out));
      };

      if (skip || !tkr || durationMs <= 0) {
        try {
          if (u) u[uniformKey] = to;
        } catch {}
        return finish();
      }

      return new Promise((resolve) => {
        this._startUniformFade(uniformKey, {
          to,
          durationMs,
          easing,
          onDone: () => {
            if (myGen !== this._fadeGen) return;
            finish().then(() => resolve(true));
          },
        });
      });
    }

    initFadeUniforms(u) {
      if (typeof u.uUsePct !== "number") u.uUsePct = 0.0;
      if (typeof u.uFadePct !== "number") u.uFadePct = 0.0;
      if (typeof u.uFadeWorld !== "number") u.uFadeWorld = 0.0;
      if (typeof u.uFadePx !== "number") u.uFadePx = 0.0;
    }

    applyFadeOptionsFrom(options = {}) {
      if (options.fadePercent !== undefined) {
        const pct = Math.min(Math.max(Number(options.fadePercent) || 0, 0), 1);
        this.uniforms.uUsePct = pct > 0 ? 1.0 : 0.0;
        this.uniforms.uFadePct = pct;
      }
      if (options.featherPx !== undefined) {
        this.uniforms.uFadePx = Math.max(0, Number(options.featherPx) || 0);
      }
    }

    initRegionFadeUniforms(u, { maxEdges = 64 } = {}) {
      u.uRegionShape = typeof u.uRegionShape === "number" ? u.uRegionShape : -1;
      u.uCssToWorld ??= new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
      u.uCenter ??= new Float32Array([0, 0]);
      u.uHalfSize ??= new Float32Array([1, 1]);
      if (typeof u.uRotation !== "number") u.uRotation = 0.0;
      u.uSdf ??= PIXI.Texture.EMPTY;
      u.uUvFromWorld ??= new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
      u.uSdfScaleOff ??= new Float32Array([1, 0]);
      u.uSdfTexel ??= new Float32Array([0, 0]);
      if (typeof u.uSdfInsideMax !== "number") u.uSdfInsideMax = 0.0;
      u.uEdges ??= new Float32Array(maxEdges * 4);
      if (typeof u.uEdgeCount !== "number") u.uEdgeCount = 0;
      if (typeof u.uSmoothKWorld !== "number") u.uSmoothKWorld = 0.0;
    }
  };
}
