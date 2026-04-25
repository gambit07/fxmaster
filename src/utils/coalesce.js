/**
 * FXMaster: Animation-Frame Coalescing
 *
 * A utility for deferring repeated calls to the next animation frame, keeping only the most recent invocation. Used throughout FXMaster to batch expensive operations (mask repaints, window refreshes, etc.) that may be requested multiple times per frame.
 */

import { logger } from "../logger.js";

/**
 * Module-scoped state map for all coalesced wrappers.
 *
 * @type {Map<any, {raf: number|null, args: any[]|null, ctx: any, pending: boolean}>}
 */
const _stateMap = new Map();

/**
 * Cancel all pending coalesced callbacks and clear the state map. Called on `canvasInit` to release references to destroyed PIXI objects.
 */
export function clearCoalesceMap() {
  for (const s of _stateMap.values()) {
    if (s.raf != null) {
      try {
        const cancel = globalThis.cancelAnimationFrame ?? clearTimeout;
        cancel(s.raf);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
  }
  _stateMap.clear();
}

/**
 * Wrap a function so that rapid repeated calls within the same frame are coalesced into a single invocation on the next animation frame.
 *
 * Only the most recent arguments survive - earlier calls in the same frame are silently replaced. This is intentional for operations like mask repaints where only the latest state matters.
 *
 * The returned wrapper exposes `.cancel()` and `.flush()` methods.
 *
 * @param {Function} fn - The function to coalesce.
 * @param {{key?: any}} [opts] - Optional deduplication key. Defaults to `fn`.
 * @returns {Function} The coalesced wrapper.
 */
export function coalesceNextFrame(fn, { key } = {}) {
  const k = key ?? fn;

  const getState = () => {
    let s = _stateMap.get(k);
    if (!s) {
      s = { raf: null, args: null, ctx: null, pending: false };
      _stateMap.set(k, s);
    }
    return s;
  };

  const schedule = () => {
    const s = getState();
    if (s.pending) return;
    s.pending = true;

    const _raf = globalThis.requestAnimationFrame ?? ((cb) => setTimeout(cb, 16));
    s.raf = _raf(() => {
      s.pending = false;
      s.raf = null;
      try {
        fn.apply(s.ctx, s.args || []);
      } finally {
        s.args = s.ctx = null;
      }
    });
  };

  /** @type {any} */
  function wrapper(...args) {
    const s = getState();
    s.args = args;
    s.ctx = this;
    schedule();
  }

  /** Cancel the pending animation frame without invoking the callback. */
  wrapper.cancel = () => {
    const s = getState();
    if (s.raf != null) {
      try {
        const cancel = globalThis.cancelAnimationFrame ?? clearTimeout;
        cancel(s.raf);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      s.raf = null;
    }
    s.pending = false;
    s.args = s.ctx = null;
  };

  /** Immediately invoke the pending callback (if any) and cancel the RAF. */
  wrapper.flush = () => {
    const s = getState();
    if (!s.pending) return;
    if (s.raf != null) {
      try {
        const cancel = globalThis.cancelAnimationFrame ?? clearTimeout;
        cancel(s.raf);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      s.raf = null;
    }
    s.pending = false;
    try {
      fn.apply(s.ctx, s.args || []);
    } finally {
      s.args = s.ctx = null;
    }
  };

  return wrapper;
}
