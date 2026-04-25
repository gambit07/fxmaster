import { logger } from "../logger.js";

const loggedTransformUpdateFailures = new WeakSet();

function debugTransformUpdateFailure(transform, err) {
  if (!transform || loggedTransformUpdateFailures.has(transform)) return;
  loggedTransformUpdateFailures.add(transform);
  logger.debug("FXMaster: failed to update PIXI local transform", err);
}

/**
 * FXMaster: Viewport & Camera Utilities
 *
 * Camera snapping, stage matrix helpers, resolution safety, and CSS-space viewport metrics.
 */

/**
 * Read the current stage transform from live local-transform state.
 *
 * PIXI can leave {@link PIXI.DisplayObject#worldTransform} one render behind during batched pan or zoom updates. The stage is a root container, so its current screen-space transform can be read directly from its local transform after forcing a local update.
 *
 * @param {PIXI.Container} [stage=canvas.stage]
 * @returns {PIXI.Matrix}
 * @private
 */
function currentStageMatrix(stage = canvas.stage) {
  const tr = stage?.transform ?? null;
  try {
    if (tr && typeof tr.updateLocalTransform === "function") tr.updateLocalTransform();
  } catch (err) {
    debugTransformUpdateFailure(tr, err);
  }

  const src = tr?.localTransform ?? stage?.localTransform ?? stage?.worldTransform ?? PIXI.Matrix.IDENTITY;
  if (src?.clone) return src.clone();
  return new PIXI.Matrix(src?.a ?? 1, src?.b ?? 0, src?.c ?? 0, src?.d ?? 1, src?.tx ?? 0, src?.ty ?? 0);
}

/**
 * Cache of the main stage transform for the current ticker frame.
 *
 * Scene suppression and region masking can rebuild from different managers during the same frame. Reusing one snapped camera snapshot per frame keeps both paths aligned while the camera is moving.
 *
 * @type {{ key: string|null, raw: PIXI.Matrix|null, snapped: PIXI.Matrix|null }}
 * @private
 */
let _stageFrameMatrixCache = { key: null, raw: null, snapped: null };

/**
 * Build a cache key for the current main-stage camera frame.
 *
 * This cache is only used for `canvas.stage`. Other containers use direct reads because they are not shared across the masking pipeline.
 *
 * @param {PIXI.Container} [stage=canvas.stage]
 * @returns {string|null}
 * @private
 */
function stageFrameCacheKey(stage = canvas.stage, raw = null) {
  if (!stage || stage !== canvas.stage) return null;

  const r = canvas?.app?.renderer;
  const ticker = canvas?.app?.ticker;
  const viewW = r?.view?.width ?? r?.screen?.width ?? 0;
  const viewH = r?.view?.height ?? r?.screen?.height ?? 0;
  const res = r?.resolution || window.devicePixelRatio || 1;
  const lastTime = ticker?.lastTime ?? 0;

  const M = raw ?? currentStageMatrix(stage);
  return `${lastTime}|${res}|${viewW}|${viewH}|${M.a}|${M.b}|${M.c}|${M.d}|${M.tx}|${M.ty}`;
}

/**
 * Read the current stage transform and return both raw and snapped variants.
 *
 * When called repeatedly during one ticker frame for the main canvas stage, the same snapshot is returned so scene suppression masks and region masks observe one camera state.
 *
 * @param {PIXI.Container} [stage=canvas.stage]
 * @returns {{ raw: PIXI.Matrix, snapped: PIXI.Matrix }}
 * @private
 */
function stageMatrixSnapshot(stage = canvas.stage) {
  const raw = currentStageMatrix(stage);
  const key = stageFrameCacheKey(stage, raw);
  if (key && _stageFrameMatrixCache.key === key && _stageFrameMatrixCache.raw && _stageFrameMatrixCache.snapped) {
    return {
      raw: _stageFrameMatrixCache.raw.clone(),
      snapped: _stageFrameMatrixCache.snapped.clone(),
    };
  }

  const snapped = raw.clone();

  const r = canvas?.app?.renderer;
  const res = r?.resolution || window.devicePixelRatio || 1;
  snapped.tx = Math.round(snapped.tx * res) / res;
  snapped.ty = Math.round(snapped.ty * res) / res;

  if (key) {
    _stageFrameMatrixCache = {
      key,
      raw: raw.clone(),
      snapped: snapped.clone(),
    };
  }

  return { raw, snapped };
}

/**
 * Read a display object's current local transform matrix.
 *
 * @param {PIXI.DisplayObject|null|undefined} displayObject
 * @returns {PIXI.Matrix}
 */
function currentLocalMatrix(displayObject) {
  const tr = displayObject?.transform ?? null;
  try {
    if (tr && typeof tr.updateLocalTransform === "function") tr.updateLocalTransform();
  } catch (err) {
    debugTransformUpdateFailure(tr, err);
  }

  const src =
    tr?.localTransform ?? displayObject?.localTransform ?? displayObject?.worldTransform ?? PIXI.Matrix.IDENTITY;
  if (src?.clone) return src.clone();
  return new PIXI.Matrix(src?.a ?? 1, src?.b ?? 0, src?.c ?? 0, src?.d ?? 1, src?.tx ?? 0, src?.ty ?? 0);
}

/**
 * Compose the current transform chain for a display object.
 *
 * The returned matrix is derived from live local-transform state so camera changes can be sampled before the next renderer pass. When the main stage is part of the chain, its translation can optionally be snapped to the current renderer resolution.
 *
 * @param {PIXI.DisplayObject|null|undefined} displayObject
 * @param {{ snapStage?: boolean }} [options]
 * @returns {PIXI.Matrix}
 */
export function currentWorldMatrix(displayObject, { snapStage = true } = {}) {
  if (!displayObject) return new PIXI.Matrix();

  const chain = [];
  let obj = displayObject;
  while (obj) {
    chain.push(obj);
    obj = obj.parent ?? null;
  }

  const matrix = new PIXI.Matrix();
  for (let i = chain.length - 1; i >= 0; i--) {
    const node = chain[i];
    matrix.append(node === canvas?.stage && snapStage ? snappedStageMatrix(node) : currentLocalMatrix(node));
  }

  return matrix;
}

/**
 * Return the current parent transform that should be supplied when rendering a display object directly.
 *
 * @param {PIXI.DisplayObject|null|undefined} displayObject
 * @param {{ snapStage?: boolean }} [options]
 * @returns {PIXI.Matrix}
 */
export function currentRenderParentMatrix(displayObject, { snapStage = true } = {}) {
  return currentWorldMatrix(displayObject?.parent ?? null, { snapStage });
}

/**
 * Return snapped camera translation in CSS space and the remaining fractional offset.
 * @returns {{ txCss: number, tyCss: number, txSnapCss: number, tySnapCss: number, camFracX: number, camFracY: number }}
 */
export function getSnappedCameraCss() {
  const r = canvas?.app?.renderer;
  const res = r?.resolution || window.devicePixelRatio || 1;
  const { raw: stageM } = stageMatrixSnapshot();

  const txCss = stageM.tx;
  const tyCss = stageM.ty;

  const txSnapCss = Math.round(txCss * res) / res;
  const tySnapCss = Math.round(tyCss * res) / res;

  const camFracX = txCss - txSnapCss;
  const camFracY = tyCss - tySnapCss;

  return { txCss, tyCss, txSnapCss, tySnapCss, camFracX, camFracY };
}

/**
 * Return a pixel-snapped stage matrix aligned to the current CSS-space camera.
 * @param {PIXI.Container} [stage=canvas.stage]
 * @returns {PIXI.Matrix}
 */
export function snappedStageMatrix(stage = canvas.stage) {
  return stageMatrixSnapshot(stage).snapped;
}

/**
 * Compare two camera matrix snapshots component-wise within an epsilon tolerance. Returns `true` when any component differs by more than `eps`, or when `last` is nullish (first frame).
 * @param {{a:number, b:number, c:number, d:number, tx:number, ty:number}} current
 * @param {{a:number, b:number, c:number, d:number, tx:number, ty:number}|null|undefined} last
 * @param {number} [eps=1e-4] - Per-component tolerance.
 * @returns {boolean} `true` if the matrices differ beyond `eps`.
 */
export function cameraMatrixChanged(current, last, eps = 1e-4) {
  if (!last) return true;
  return (
    Math.abs(last.a - current.a) > eps ||
    Math.abs(last.b - current.b) > eps ||
    Math.abs(last.c - current.c) > eps ||
    Math.abs(last.d - current.d) > eps ||
    Math.abs(last.tx - current.tx) > eps ||
    Math.abs(last.ty - current.ty) > eps
  );
}

/**
 * Convert a PIXI.Matrix to a column-major 3x3 matrix.
 * @param {PIXI.Matrix} M
 * @returns {Float32Array}
 */
export function mat3FromPixi(M) {
  return new Float32Array([M.a, M.b, 0, M.c, M.d, 0, M.tx, M.ty, 1]);
}

/**
 * Estimate tessellation steps for an ellipse under a given transform.
 * @param {number} rx
 * @param {number} ry
 * @param {PIXI.Matrix} [stageMatrix]
 * @returns {number}
 */
export function ellipseSteps(rx, ry, stageMatrix = stageMatrixSnapshot().raw) {
  const sx = Math.hypot(stageMatrix.a, stageMatrix.b);
  const sy = Math.hypot(stageMatrix.c, stageMatrix.d);
  const rxS = Math.max(1, rx * sx);
  const ryS = Math.max(1, ry * sy);
  const p = Math.PI * (3 * (rxS + ryS) - Math.sqrt((3 * rxS + ryS) * (rxS + 3 * ryS)));
  return Math.ceil(Math.max(64, Math.min(512, p / 2)));
}

/**
 * Return viewport metrics in CSS pixels.
 * @returns {{cssW:number, cssH:number, deviceToCss:number, rect: PIXI.Rectangle, deviceRect: PIXI.Rectangle}}
 */
export function getCssViewportMetrics() {
  const r = canvas?.app?.renderer;
  const res = r?.resolution || window.devicePixelRatio || 1;

  const deviceW = Math.max(1, (r?.view?.width ?? r?.screen?.width ?? 1) | 0);
  const deviceH = Math.max(1, (r?.view?.height ?? r?.screen?.height ?? 1) | 0);
  const deviceRect = new PIXI.Rectangle(0, 0, deviceW, deviceH);

  const cssW = Math.max(1, (r?.screen?.width ?? Math.round(deviceW / res)) | 0);
  const cssH = Math.max(1, (r?.screen?.height ?? Math.round(deviceH / res)) | 0);
  const rect = new PIXI.Rectangle(0, 0, cssW, cssH);

  return { cssW, cssH, deviceToCss: 1 / res, rect, deviceRect };
}

/**
 * Compute a safe render resolution for a given CSS-sized area, respecting both renderer.resolution and MAX_TEXTURE_SIZE.
 *
 * @param {number} cssW
 * @param {number} cssH
 * @returns {number}
 */
export function safeResolutionForCssArea(cssW, cssH) {
  const r = canvas?.app?.renderer;
  if (!r) return 1;

  const gl = r.gl;
  const max = gl?.getParameter?.(gl.MAX_TEXTURE_SIZE) || 8192;
  const base = r.resolution || window.devicePixelRatio || 1;

  const span = Math.max(1, cssW | 0, cssH | 0);
  const texLimited = max / span;

  const safe = Math.max(0.5, Math.min(base, texLimited));
  return safe;
}

/**
 * Compute a safe resolution for alpha/binary mask render textures. This function delegates to {@link safeResolutionForCssArea} and additionally caps the returned resolution to a maximum (default 1.0).
 *
 * @param {number} cssW - Viewport width in CSS pixels.
 * @param {number} cssH - Viewport height in CSS pixels.
 * @param {number} [max=1] - Maximum allowed resolution.
 * @returns {number}
 */
export function safeMaskResolutionForCssArea(cssW, cssH, max = 1) {
  const safe = safeResolutionForCssArea(cssW, cssH);
  const cap = Number.isFinite(max) ? max : 1;
  return Math.max(0.5, Math.min(cap, safe));
}
