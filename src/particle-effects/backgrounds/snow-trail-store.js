import { ScatterBackgroundStore } from "./scatter-background-store.js";
import { logger } from "../../logger.js";

const TRAIL_PIXELS_PER_GRID = 48;
const TRAIL_TEXTURE_MAX_SIDE = 1792;
const TRAIL_TEXTURE_MAX_PIXELS = 3_145_728;
const TRAIL_TEXTURE_MIN_SIDE = 64;

const TRAIL_REFILL_TIME_UNIT_MS = 50;
const TRAIL_REFILL_TIME_CYCLE_UNITS = 0x1000000;

function finiteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, min, max, fallback = min) {
  return Math.max(min, Math.min(max, finiteNumber(value, fallback)));
}

function boundsSignature(bounds) {
  if (!bounds) return "";
  return [bounds.x, bounds.y, bounds.width, bounds.height, bounds.gridSize]
    .map((value) => finiteNumber(value, 0).toFixed(3))
    .join(":");
}

function createCanvas(width, height) {
  let canvas = null;
  try {
    canvas = globalThis.document?.createElement?.("canvas") ?? null;
  } catch (_err) {}

  if (!canvas) {
    try {
      if (typeof globalThis.OffscreenCanvas === "function") canvas = new globalThis.OffscreenCanvas(width, height);
    } catch (_err) {}
  }

  if (!canvas) return null;
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function createCanvasTexture(canvas, scaleMode = PIXI.SCALE_MODES.LINEAR) {
  const baseOptions = {
    scaleMode,
    mipmap: PIXI.MIPMAP_MODES.OFF,
    alphaMode: PIXI.ALPHA_MODES.NO_PREMULTIPLIED,
  };
  if (PIXI.WRAP_MODES?.CLAMP !== undefined) baseOptions.wrapMode = PIXI.WRAP_MODES.CLAMP;
  const base = PIXI.BaseTexture.from(canvas, baseOptions);
  return new PIXI.Texture(base);
}

function destroyTexture(texture) {
  try {
    texture?.destroy?.(true);
  } catch (err) {
    logger.debug("FXMaster:", err);
  }
}

function computeTrailTextureSize(bounds) {
  const gridSize = Math.max(1, finiteNumber(bounds?.gridSize, 100));
  let width = Math.max(
    TRAIL_TEXTURE_MIN_SIDE,
    (Math.max(1, finiteNumber(bounds?.width, 1)) / gridSize) * TRAIL_PIXELS_PER_GRID,
  );
  let height = Math.max(
    TRAIL_TEXTURE_MIN_SIDE,
    (Math.max(1, finiteNumber(bounds?.height, 1)) / gridSize) * TRAIL_PIXELS_PER_GRID,
  );

  const sideScale = Math.min(1, TRAIL_TEXTURE_MAX_SIDE / width, TRAIL_TEXTURE_MAX_SIDE / height);
  const areaScale = Math.min(1, Math.sqrt(TRAIL_TEXTURE_MAX_PIXELS / Math.max(1, width * height)));
  const scale = Math.min(sideScale, areaScale);
  width = Math.max(TRAIL_TEXTURE_MIN_SIDE, Math.round(width * scale));
  height = Math.max(TRAIL_TEXTURE_MIN_SIDE, Math.round(height * scale));

  return { width, height };
}

function normalizeTrailTick(tick) {
  const supplied = Number(tick);
  if (Number.isFinite(supplied) && supplied >= 0) return supplied;

  try {
    const monotonic = Number(globalThis.performance?.now?.());
    if (Number.isFinite(monotonic) && monotonic >= 0) return monotonic;
  } catch (_err) {}

  return Date.now();
}

function trailClockUnits(tick) {
  const units = normalizeTrailTick(tick) / TRAIL_REFILL_TIME_UNIT_MS;
  return ((units % TRAIL_REFILL_TIME_CYCLE_UNITS) + TRAIL_REFILL_TIME_CYCLE_UNITS) % TRAIL_REFILL_TIME_CYCLE_UNITS;
}

function encodeTrailTimestampUnits(clockUnits) {
  const units = Math.floor(finiteNumber(clockUnits, 0)) % TRAIL_REFILL_TIME_CYCLE_UNITS;
  const red = (units >>> 16) & 0xff;
  const green = (units >>> 8) & 0xff;
  const blue = units & 0xff;
  return `rgba(${red},${green},${blue},1)`;
}

/**
 * Clip a segment to a rectangle so Region-scoped surfaces do not hand very
 * large off-canvas coordinates to the browser's 2D rasterizer.
 *
 * @param {{x:number,y:number}} from
 * @param {{x:number,y:number}} to
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @param {number} padding
 * @returns {{from:{x:number,y:number},to:{x:number,y:number}}|null}
 */
function clipSegmentToRect(from, to, rect, padding = 0) {
  const minX = rect.x - padding;
  const minY = rect.y - padding;
  const maxX = rect.x + rect.width + padding;
  const maxY = rect.y + rect.height + padding;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let t0 = 0;
  let t1 = 1;

  const test = (p, q) => {
    if (Math.abs(p) < 1e-9) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };

  if (!test(-dx, from.x - minX)) return null;
  if (!test(dx, maxX - from.x)) return null;
  if (!test(-dy, from.y - minY)) return null;
  if (!test(dy, maxY - from.y)) return null;

  return {
    from: { x: from.x + dx * t0, y: from.y + dy * t0 },
    to: { x: from.x + dx * t1, y: from.y + dy * t1 },
  };
}

/**
 * Session-persistent world-space mask shared by every runtime instance of the
 * same snow effect row. Sharing keeps trails intact across emitter crossfades
 * and Region runtime rebuilds without serializing a large texture into flags.
 *
 * When refill is enabled, a second nearest-neighbor texture records the newest
 * stamp time for each trail pixel. The snow shader can then restore each path
 * independently without redrawing or uploading the full mask every frame.
 */
export class SnowTrailStore {
  constructor({ uid = "snow-background" } = {}) {
    this.type = "snow";
    this.uid = String(uid ?? "snow-background");
    this.enabled = false;
    this.refillEnabled = false;
    this.bounds = null;
    this.texture = PIXI.Texture.EMPTY;
    this.ageTexture = PIXI.Texture.EMPTY;
    this.uniformBounds = new Float32Array([0, 0, 1, 1]);
    this.uniformTexel = new Float32Array([1, 1]);
    this._boundsSignature = "";
    this._resetSignature = null;
    this._canvas = null;
    this._context = null;
    this._ownedTexture = null;
    this._ageCanvas = null;
    this._ageContext = null;
    this._ownedAgeTexture = null;
    this._dirty = false;
    this._ageDirty = false;
    this._refillPausedAtTick = null;
    this._refillPausedDurationMs = 0;
    this._hasContent = false;
    this._lastStampTick = 0;
    this._destroyed = false;
  }

  setEnabled(enabled) {
    if (this._destroyed) return;
    const next = !!enabled;
    if (this.enabled === next) return;
    this.enabled = next;

    if (!next) {
      this._replaceTexture({ allocate: false });
      this._hasContent = false;
      this._lastStampTick = 0;
      this._refillPausedAtTick = null;
      this._refillPausedDurationMs = 0;
    }
  }

  /**
   * Enable or disable per-pixel refill timestamps without altering the trail
   * mask. Existing persistent trails begin their refill from the moment this is
   * enabled; disabling refill freezes the visible trails again.
   *
   * @param {boolean} enabled
   * @param {number} [tick]
   */
  setRefillEnabled(enabled, tick) {
    if (this._destroyed) return;
    const next = !!enabled;
    const now = normalizeTrailTick(tick);
    if (this.refillEnabled === next) return;

    if (next) {
      if (this._refillPausedAtTick !== null) {
        this._refillPausedDurationMs += Math.max(0, now - this._refillPausedAtTick);
        this._refillPausedAtTick = null;
      }
      this.refillEnabled = true;
      if (this.enabled && this._canvas) this._ensureAgeTexture(now);
      return;
    }

    this.refillEnabled = false;
    if (this._ownedAgeTexture && this._refillPausedAtTick === null) this._refillPausedAtTick = now;
  }

  /**
   * Convert a monotonic millisecond clock to the shader's 24-bit time units.
   *
   * @param {number} [tick]
   * @returns {number}
   */
  refillClockAt(tick) {
    const now = normalizeTrailTick(tick);
    const pausedNow = this._refillPausedAtTick === null ? now : this._refillPausedAtTick;
    return trailClockUnits(Math.max(0, pausedNow - this._refillPausedDurationMs));
  }

  get hasRefillMask() {
    return !!this._ownedAgeTexture && this.ageTexture !== PIXI.Texture.EMPTY;
  }

  get hasTrailMask() {
    return !!(this.enabled && this._hasContent && this._ownedTexture && this.texture !== PIXI.Texture.EMPTY);
  }

  get lastStampTick() {
    return this._lastStampTick;
  }

  /**
   * Clear refill-backed trail pixels once their refill window has fully elapsed.
   * The visual shader already hides expired pixels, but the source mask can still
   * contain old alpha. Clearing it before a new stamp prevents stale, visually
   * refilled paths from being revived by nearby new trail timestamps.
   *
   * @param {number} [tick]
   * @param {number} [activeDurationSeconds=Infinity]
   * @returns {boolean}
   */
  clearExpiredRefillMask(tick, activeDurationSeconds = Infinity) {
    if (this._destroyed || !this.enabled || !this.refillEnabled || !this._hasContent) return false;
    const lastStampTick = Number(this._lastStampTick);
    if (!Number.isFinite(lastStampTick) || lastStampTick <= 0) return false;

    const seconds = Number(activeDurationSeconds);
    if (!Number.isFinite(seconds)) return false;

    const now = normalizeTrailTick(tick);
    const durationMs = Math.max(100, seconds * 1000 + 120);
    if (now - lastStampTick <= durationMs) return false;

    this.clear();
    return true;
  }

  /**
   * Return whether shader-side trail sampling can currently change pixels.
   * Trail stores are lazy-created so an enabled token-interaction option does
   * not have to keep an empty texture sample branch hot. Refill-based trails can
   * also stand down after the newest stamp has settled.
   *
   * @param {number} [tick]
   * @param {number} [activeDurationSeconds=Infinity]
   * @returns {boolean}
   */
  hasActiveMask(tick, activeDurationSeconds = Infinity) {
    if (this._destroyed || !this.enabled || !this.hasTrailMask) return false;
    if (!this.refillEnabled) return true;

    const lastStampTick = Number(this._lastStampTick);
    if (!Number.isFinite(lastStampTick) || lastStampTick <= 0) return false;

    const seconds = Number(activeDurationSeconds);
    if (!Number.isFinite(seconds)) return true;
    const now = normalizeTrailTick(tick);
    const durationMs = Math.max(100, seconds * 1000 + 250);
    return now - lastStampTick <= durationMs;
  }

  setBounds(bounds) {
    if (this._destroyed || !bounds) return;
    const normalized = {
      x: finiteNumber(bounds.x, 0),
      y: finiteNumber(bounds.y, 0),
      width: Math.max(1, finiteNumber(bounds.width, 1)),
      height: Math.max(1, finiteNumber(bounds.height, 1)),
      gridSize: Math.max(1, finiteNumber(bounds.gridSize, 100)),
    };
    const signature = boundsSignature(normalized);
    if (signature === this._boundsSignature) return;

    this.bounds = normalized;
    this._boundsSignature = signature;
    this.uniformBounds[0] = normalized.x;
    this.uniformBounds[1] = normalized.y;
    this.uniformBounds[2] = normalized.width;
    this.uniformBounds[3] = normalized.height;
    const hadTexture = !!(this._context && this._ownedTexture && this.texture !== PIXI.Texture.EMPTY);
    this._replaceTexture({ allocate: hadTexture });
  }

  resetForSignature(signature) {
    if (this._destroyed) return;
    const normalized = String(signature ?? "");
    if (normalized === this._resetSignature) return;
    this._resetSignature = normalized;
    this.clear();
  }

  _ensureTexture() {
    if (this._destroyed || !this.enabled || !this.bounds) return false;
    if (this._context && this._ownedTexture && this.texture !== PIXI.Texture.EMPTY) return true;
    return this._replaceTexture({ allocate: true });
  }

  _replaceTexture({ allocate = false } = {}) {
    if (this._destroyed) return false;

    const oldTexture = this._ownedTexture;
    this._ownedTexture = null;
    this.texture = PIXI.Texture.EMPTY;
    this._canvas = null;
    this._context = null;
    this._dirty = false;
    this._hasContent = false;
    this._lastStampTick = 0;
    this._replaceAgeTexture();
    this.uniformTexel[0] = 1;
    this.uniformTexel[1] = 1;
    destroyTexture(oldTexture);

    if (!allocate || !this.enabled || !this.bounds) return false;

    const size = computeTrailTextureSize(this.bounds);
    const canvas = createCanvas(size.width, size.height);
    const context = canvas?.getContext?.("2d", { alpha: true }) ?? null;
    if (!canvas || !context) return false;

    try {
      context.clearRect(0, 0, size.width, size.height);
      context.imageSmoothingEnabled = true;
      if ("imageSmoothingQuality" in context) context.imageSmoothingQuality = "high";
      context.lineCap = "round";
      context.lineJoin = "round";
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    try {
      const texture = createCanvasTexture(canvas, PIXI.SCALE_MODES.LINEAR);
      this._canvas = canvas;
      this._context = context;
      this.uniformTexel[0] = 1 / Math.max(1, canvas.width);
      this.uniformTexel[1] = 1 / Math.max(1, canvas.height);
      this._ownedTexture = texture;
      this.texture = texture;
      if (this.refillEnabled) this._ensureAgeTexture();
      return true;
    } catch (err) {
      logger.debug("FXMaster:", err);
      this._canvas = null;
      this._context = null;
      return false;
    }
  }

  _ensureAgeTexture(tick) {
    if (this._destroyed || !this.enabled || !this._canvas) return false;
    if (this._ageContext && this._ownedAgeTexture && this.ageTexture !== PIXI.Texture.EMPTY) return true;
    if (!this.refillEnabled) return false;
    return this._replaceAgeTexture({ initializeFromMask: true, tick });
  }

  _replaceAgeTexture({ initializeFromMask = false, tick } = {}) {
    if (this._destroyed) return false;

    const oldTexture = this._ownedAgeTexture;
    this._ownedAgeTexture = null;
    this.ageTexture = PIXI.Texture.EMPTY;
    this._ageCanvas = null;
    this._ageContext = null;
    this._ageDirty = false;
    destroyTexture(oldTexture);

    if (!this.refillEnabled || !this.enabled || !this._canvas) return false;

    const canvas = createCanvas(this._canvas.width, this._canvas.height);
    const context = canvas?.getContext?.("2d", { alpha: true }) ?? null;
    if (!canvas || !context) return false;

    try {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.imageSmoothingEnabled = false;
      context.lineCap = "round";
      context.lineJoin = "round";

      if (initializeFromMask && this._canvas) {
        context.save();
        context.globalCompositeOperation = "source-over";
        context.drawImage(this._canvas, 0, 0);
        context.globalCompositeOperation = "source-in";
        context.fillStyle = encodeTrailTimestampUnits(this.refillClockAt(tick));
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.restore();
      }

      const texture = createCanvasTexture(canvas, PIXI.SCALE_MODES.NEAREST);
      this._ageCanvas = canvas;
      this._ageContext = context;
      this._ownedAgeTexture = texture;
      this.ageTexture = texture;
      return true;
    } catch (err) {
      logger.debug("FXMaster:", err);
      this._ageCanvas = null;
      this._ageContext = null;
      return false;
    }
  }

  clear() {
    if (this._destroyed) return;
    const context = this._context;
    const canvas = this._canvas;
    if (!context || !canvas) return;

    try {
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.globalCompositeOperation = "source-over";
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.restore();
      this._dirty = true;
      this._hasContent = false;
      this._lastStampTick = 0;

      if (this._ageContext && this._ageCanvas) {
        this._ageContext.save();
        this._ageContext.setTransform(1, 0, 0, 1, 0, 0);
        this._ageContext.globalCompositeOperation = "source-over";
        this._ageContext.clearRect(0, 0, this._ageCanvas.width, this._ageCanvas.height);
        this._ageContext.restore();
        this._ageDirty = true;
      }

      this.flush();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  /**
   * Stamp a soft capsule into the track mask.
   *
   * @param {{from:{x:number,y:number},to:{x:number,y:number},width:number,tick?:number,ageMs?:number}} segment
   * @returns {boolean}
   */
  stampSegment({ from, to, width, tick, ageMs = 0 } = {}) {
    if (!this.enabled || this._destroyed || !this._ensureTexture()) return false;
    if (!from || !to || !this.bounds || !this._context || !this._canvas) return false;

    const a = { x: finiteNumber(from.x, Number.NaN), y: finiteNumber(from.y, Number.NaN) };
    const b = { x: finiteNumber(to.x, Number.NaN), y: finiteNumber(to.y, Number.NaN) };
    if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return false;

    const worldWidth = clamp(width, this.bounds.gridSize * 0.08, this.bounds.gridSize * 4, this.bounds.gridSize * 0.55);
    const clipped = clipSegmentToRect(a, b, this.bounds, worldWidth);
    if (!clipped) return false;

    const sx = this._canvas.width / this.bounds.width;
    const sy = this._canvas.height / this.bounds.height;
    const pxScale = Math.sqrt(Math.max(1e-6, sx * sy));
    const map = (point) => ({
      x: (point.x - this.bounds.x) * sx,
      y: (point.y - this.bounds.y) * sy,
    });
    const p0 = map(clipped.from);
    let p1 = map(clipped.to);
    const widthPx = Math.max(1.5, worldWidth * pxScale);
    const pathDx = p1.x - p0.x;
    const pathDy = p1.y - p0.y;
    const pathLength = Math.hypot(pathDx, pathDy);
    if (pathLength > 0.001) {
      const extension = Math.min(widthPx * 0.38, Math.max(widthPx * 0.1, pathLength * 0.3));
      p1 = {
        x: p1.x + (pathDx / pathLength) * extension,
        y: p1.y + (pathDy / pathLength) * extension,
      };
    }
    const context = this._context;

    const stroke = (target, lineWidth, style) => {
      target.beginPath();
      target.moveTo(p0.x, p0.y);
      target.lineTo(p1.x, p1.y);
      target.lineWidth = lineWidth;
      target.strokeStyle = style;
      target.stroke();
    };

    try {
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.globalCompositeOperation = "source-over";
      context.lineCap = "round";
      context.lineJoin = "round";
      stroke(context, widthPx * 2.75, "rgba(255,255,255,0.032)");
      stroke(context, widthPx * 2.42, "rgba(255,255,255,0.070)");
      stroke(context, widthPx * 2.06, "rgba(255,255,255,0.135)");
      stroke(context, widthPx * 1.68, "rgba(255,255,255,0.255)");
      stroke(context, widthPx * 1.3, "rgba(255,255,255,0.440)");
      stroke(context, widthPx * 1.02, "rgba(255,255,255,0.720)");
      stroke(context, widthPx * 0.84, "rgba(255,255,255,0.960)");
      context.restore();
      this._dirty = true;
      const stampedTick = normalizeTrailTick(tick);
      const stampAgeMs = Math.max(0, finiteNumber(ageMs, 0));
      this._hasContent = true;
      this._lastStampTick = Math.max(Number(this._lastStampTick) || 0, Math.max(0, stampedTick - stampAgeMs));

      if ((this.refillEnabled || this.hasRefillMask) && this._ensureAgeTexture(tick) && this._ageContext) {
        const ageContext = this._ageContext;
        ageContext.save();
        ageContext.setTransform(1, 0, 0, 1, 0, 0);
        ageContext.globalCompositeOperation = "source-over";
        ageContext.lineCap = "round";
        ageContext.lineJoin = "round";
        const ageUnits = Math.max(0, finiteNumber(ageMs, 0)) / TRAIL_REFILL_TIME_UNIT_MS;
        const stampUnits =
          (((this.refillClockAt(tick) - ageUnits) % TRAIL_REFILL_TIME_CYCLE_UNITS) + TRAIL_REFILL_TIME_CYCLE_UNITS) %
          TRAIL_REFILL_TIME_CYCLE_UNITS;
        stroke(ageContext, widthPx * 3.05, encodeTrailTimestampUnits(stampUnits));
        ageContext.restore();
        this._ageDirty = true;
      }

      return true;
    } catch (err) {
      logger.debug("FXMaster:", err);
      return false;
    }
  }

  flush() {
    if (this._destroyed) return;

    if (this._dirty && this._ownedTexture) {
      this._dirty = false;
      try {
        this._ownedTexture.baseTexture?.update?.();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      try {
        this._ownedTexture.source?.update?.();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    if (this._ageDirty && this._ownedAgeTexture) {
      this._ageDirty = false;
      try {
        this._ownedAgeTexture.baseTexture?.update?.();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      try {
        this._ownedAgeTexture.source?.update?.();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    destroyTexture(this._ownedTexture);
    destroyTexture(this._ownedAgeTexture);
    this.texture = PIXI.Texture.EMPTY;
    this.ageTexture = PIXI.Texture.EMPTY;
    this._ownedTexture = null;
    this._ownedAgeTexture = null;
    this._hasContent = false;
    this._lastStampTick = 0;
    this._canvas = null;
    this._context = null;
    this._ageCanvas = null;
    this._ageContext = null;
    this.bounds = null;
  }
}

/**
 * Create a trail store for a persistent particle background descriptor.
 *
 * @param {object|null|undefined} descriptor
 * @param {object} config
 * @returns {SnowTrailStore|ScatterBackgroundStore|null}
 */
export function createParticleBackgroundTrailStore(descriptor, config = {}) {
  const type = String(descriptor?.type ?? "");
  if (type === "snow") return new SnowTrailStore(config);
  if (type === "snowstorm") {
    const store = new SnowTrailStore(config);
    store.type = type;
    return store;
  }
  if (type === "sand" || type === "rain") {
    const store = new SnowTrailStore(config);
    store.type = type;
    return store;
  }
  if (type === "scatter") return new ScatterBackgroundStore({ ...config, descriptor });
  return null;
}
