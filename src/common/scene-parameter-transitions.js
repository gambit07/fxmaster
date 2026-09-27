/** Return a stable signature for stored effect options, including removed fields. */
export function sceneParameterOptionsSignature(options) {
  return JSON.stringify(options, (_key, value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, value[key]]),
    );
  });
}

/** Fade scene particles around parameter updates while retaining only the latest pending edit. */
export class SceneParameterTransitions {
  constructor({ durationMs = 500, onError = () => {} } = {}) {
    this.durationMs = durationMs;
    this.onError = onError;
    this.entries = new Map();
  }

  /** Whether an effect has an unfinished parameter transition. */
  has(key) {
    return this.entries.has(key);
  }

  /** Return the runtime whose settings are currently visible during a transition. */
  getRuntime(key) {
    return this.entries.get(key)?.runtime ?? null;
  }

  /** Whether the runtime exposes a numeric fade channel and its shared animator. */
  canFade(runtime) {
    return Number.isFinite(this._read(runtime)) && typeof runtime?.fadeToAlpha === "function";
  }

  /**
   * Queue a configuration callback, preserving the current fade-out when edits arrive together. The callback receives the current runtime, an ownership check, and its unfaded alpha, and returns the updated runtime and target alpha.
   * @param {string} key Effect ID.
   * @param {{runtime: object, signature: string, isCurrent: Function, apply: Function}} request Pending configuration.
   * @returns {Promise<void>}
   */
  request(key, request) {
    let entry = this.entries.get(key);
    if (entry) {
      const changed = entry.request.signature !== request.signature;
      entry.request = request;
      if (changed) {
        entry.revision++;
        if (entry.phase === "in") entry.cancelFade?.();
      }
      return entry.promise;
    }
    entry = {
      key,
      request,
      runtime: request.runtime,
      revision: 0,
      phase: "out",
      cancelFade: null,
      target: 1,
    };
    this.entries.set(key, entry);
    entry.promise = this._run(entry);
    return entry.promise;
  }

  /** Cancel pending edits before removal, an immediate update, or scene teardown. */
  cancel(key) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    entry.cancelFade?.();
    return true;
  }

  /** Cancel all pending edits without committing their settings. */
  clear() {
    for (const key of this.entries.keys()) this.cancel(key);
  }

  _read(runtime) {
    return Number(runtime?.alpha);
  }

  _write(runtime, value) {
    runtime.alpha = value;
    runtime._fxmSyncBackgroundSurfaceAlpha?.();
  }

  _cancelRuntimeFade(runtime) {
    runtime?._fxmCancelAlphaFade?.({ resolve: true });
  }

  _active(entry) {
    return this.entries.get(entry.key) === entry && !entry.runtime?.destroyed && entry.request.isCurrent(entry.runtime);
  }

  _fade(entry, target) {
    const runtime = entry.runtime;
    this._cancelRuntimeFade(runtime);
    if (Math.abs(this._read(runtime) - target) < 1e-6) {
      this._write(runtime, target);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        entry.cancelFade = null;
        if (error) reject(error);
        else resolve();
      };
      entry.cancelFade = () => {
        this._cancelRuntimeFade(runtime);
        finish();
      };
      try {
        Promise.resolve(runtime.fadeToAlpha({ to: target, timeout: this.durationMs })).then(() => finish(), finish);
      } catch (error) {
        finish(error);
      }
    });
  }

  async _run(entry) {
    try {
      while (this._active(entry)) {
        entry.phase = "out";
        await this._fade(entry, 0);
        if (!this._active(entry)) break;
        entry.phase = "apply";
        let revision;
        do {
          revision = entry.revision;
          const result = await entry.request.apply(entry.runtime, () => this._active(entry), entry.target);
          if (this.entries.get(entry.key) !== entry || !result) return;
          entry.runtime = result.runtime;
          entry.target = Number.isFinite(result.target) ? result.target : 1;
          if (!this._active(entry)) return;
          this._write(entry.runtime, 0);
        } while (revision !== entry.revision);
        entry.phase = "in";
        await this._fade(entry, entry.target);
        if (revision === entry.revision) break;
      }
    } catch (error) {
      if (this._active(entry)) this._write(entry.runtime, Number.isFinite(entry.target) ? entry.target : 1);
      this.onError(error);
    } finally {
      entry.cancelFade?.();
      if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    }
  }
}
