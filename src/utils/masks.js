/**
 * FXMaster: Mask & Render-Texture Utilities
 *
 * Token sprite pooling, scene allow-mask construction, below-tokens cutout compositing, region mask building, and dynamic-ring handling.
 *
 * These utilities are the backbone of FXMaster's per-frame masking pipeline that gates which screen regions show effects.
 */

import { packageId } from "../constants.js";
import { logger } from "../logger.js";
import {
  traceRegionShapePIXI,
  traceRegionShapePath2D,
  estimateRegionInradius,
  getEventGate,
  getRegionElevationWindow,
  inRangeElev,
  regionWorldBounds,
  regionWorldBoundsAligned,
} from "./geometry.js";
import { getCssViewportMetrics, safeMaskResolutionForCssArea, snappedStageMatrix } from "./viewport.js";

let _tmpRTCopySprite = null;
let _tmpTokensEraseSprite = null;

/* Region-mask softening scratch objects. */
let _tmpRegionCanvasSprite = null;

let _tmpSceneSuppressionSprite = null;
let _sceneSuppressionSoftCache = new Map();
let _sceneSuppressionSoftCacheTick = 0;

/** Maximum device-independent pixel density used for cached world-space suppression masks. */
const SCENE_SUPPRESSION_SOFT_MAX_PIXELS_PER_WORLD = 1;
/** Maximum texture span for a cached world-space suppression mask. */
const SCENE_SUPPRESSION_SOFT_MAX_TEXTURE_SPAN = 3072;
/** Maximum texel budget for a cached world-space suppression mask. */
const SCENE_SUPPRESSION_SOFT_MAX_TEXTURE_AREA = 2_000_000;

/**
 * Destroy a texture after the current render cycle has finished.
 *
 * Resolution or viewport changes can force a new render texture allocation while sprites and shader uniforms still reference the previous texture for the current frame.
 * Deferring destruction avoids transient null `texture.orig` access during Sprite vertex calculation.
 *
 * @param {PIXI.Texture|PIXI.RenderTexture|null} texture
 * @returns {void}
 * @private
 */
function _destroyTextureDeferred(texture) {
  if (!texture || texture.destroyed) return;

  const destroy = () => {
    try {
      if (!texture.destroyed) texture.destroy(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  };

  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => requestAnimationFrame(destroy));
    return;
  }

  setTimeout(destroy, 0);
}

/** @type {{ solids: PIXI.Graphics, holes: PIXI.Graphics }|null} */
let _regionMaskGfx = null;

/** @returns {{ solids: PIXI.Graphics, holes: PIXI.Graphics }} */
export function _getRegionMaskGfx() {
  if (_regionMaskGfx?.solids && _regionMaskGfx?.holes) return _regionMaskGfx;
  _regionMaskGfx = { solids: new PIXI.Graphics(), holes: new PIXI.Graphics() };
  return _regionMaskGfx;
}

/** @type {{ bg: PIXI.Graphics, scene: PIXI.Graphics, solids: PIXI.Graphics, holes: PIXI.Graphics }|null} */
let _sceneAllowMaskGfx = null;

/** @returns {{ bg: PIXI.Graphics, scene: PIXI.Graphics, solids: PIXI.Graphics, holes: PIXI.Graphics }} */
export function _getSceneAllowMaskGfx() {
  if (_sceneAllowMaskGfx?.bg && _sceneAllowMaskGfx?.scene && _sceneAllowMaskGfx?.solids && _sceneAllowMaskGfx?.holes)
    return _sceneAllowMaskGfx;
  _sceneAllowMaskGfx = {
    bg: new PIXI.Graphics(),
    scene: new PIXI.Graphics(),
    solids: new PIXI.Graphics(),
    holes: new PIXI.Graphics(),
  };
  return _sceneAllowMaskGfx;
}

/**
 * Interpret a `belowTokens` option consistently.
 * Supports booleans, `{ value: boolean }`, and legacy truthy/falsy values.
 * @param {*} v
 * @returns {boolean}
 * @private
 */
export function _belowTokensEnabled(v) {
  if (v === true) return true;
  if (v && typeof v === "object" && "value" in v) return !!v.value;
  return !!v;
}

/**
 * RenderTexture pool.
 */
export class RTPool {
  /**
   * @param {{maxPerKey?:number}} [opts]
   */
  constructor({ maxPerKey = 8 } = {}) {
    this._pool = new Map();
    this._maxPerKey = Math.max(1, maxPerKey | 0);
  }
  /**
   * @param {number} w
   * @param {number} h
   * @param {number} [res=1]
   * @returns {string}
   * @private
   */
  _key(w, h, res = 1) {
    return `${w | 0}x${h | 0}@${res || 1}`;
  }

  /**
   * Acquire a RenderTexture.
   * @param {number} w
   * @param {number} h
   * @param {number} [res=1]
   * @returns {PIXI.RenderTexture}
   */
  acquire(w, h, res = 1) {
    const key = this._key(w, h, res);
    const list = this._pool.get(key);
    if (list && list.length) {
      const rt = list.pop();
      if (list.length) this._pool.set(key, list);
      else this._pool.delete(key);
      return rt;
    }
    return PIXI.RenderTexture.create({ width: w | 0, height: h | 0, resolution: res || 1 });
  }

  /**
   * Release a RenderTexture back to the pool.
   * @param {PIXI.RenderTexture} rt
   */
  release(rt) {
    if (!rt) return;
    try {
      const key = this._key(rt.width | 0, rt.height | 0, rt.resolution || 1);
      const list = this._pool.get(key) || [];
      list.push(rt);
      this._pool.set(key, list);
      while (list.length > this._maxPerKey) {
        const old = list.shift();
        try {
          old.destroy(true);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }
    } catch {
      try {
        rt.destroy(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
  }

  /**
   * Destroy all pooled textures and clear the pool.
   */
  drain() {
    try {
      for (const list of this._pool.values())
        for (const rt of list)
          try {
            rt.destroy(true);
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
    } finally {
      this._pool.clear();
    }
  }
}

/** @type {PIXI.Sprite[]} */
const _tokenSpritePool = [];

/**
 * Return a sprite from the pool or create a new one.
 * @param {PIXI.Texture} tex
 * @returns {PIXI.Sprite}
 * @private
 */
function _acquireTokenSprite(tex) {
  const spr = _tokenSpritePool.pop() ?? new PIXI.Sprite();
  spr.texture = tex;
  return spr;
}

/**
 * Return sprites to the pool for reuse, reducing allocation churn during frequent mask repaints (e.g. smooth panning with 20+ tokens).
 * @param {PIXI.Sprite[]} sprites
 */
export function releaseTokenSprites(sprites) {
  for (const spr of sprites) {
    if (!spr || spr.destroyed) continue;
    try {
      spr.texture = PIXI.Texture.EMPTY;
      if (spr.parent) spr.parent.removeChild(spr);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    _tokenSpritePool.push(spr);
  }
}

/**
 * Collect token sprites in world space for alpha masking.
 * @param {{ respectOcclusion?: boolean, shouldIncludeToken?: (t: Token) => boolean }} [opts]
 * @returns {PIXI.Sprite[]}
 */
export function collectTokenAlphaSprites(opts = {}) {
  const respectOcc = !!opts.respectOcclusion;
  const shouldInclude = typeof opts.shouldIncludeToken === "function" ? opts.shouldIncludeToken : null;

  const out = [];
  for (const t of canvas.tokens?.placeables ?? []) {
    if (!t.visible || t.document.hidden) continue;

    if (t.hasDynamicRing) continue;

    if (respectOcc && _isTokenOccludedByOverhead(t)) continue;
    if (shouldInclude && !shouldInclude(t)) continue;

    const icon = t.mesh ?? t;
    const tex = icon?.texture;
    if (!tex?.baseTexture?.valid) continue;

    const spr = _acquireTokenSprite(tex);
    try {
      spr.anchor.set(icon.anchor?.x ?? 0.5, icon.anchor?.y ?? 0.5);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      const stageLocal = stageLocalMatrixOf(icon);
      const vals = [stageLocal.a, stageLocal.b, stageLocal.c, stageLocal.d, stageLocal.tx, stageLocal.ty];
      if (!vals.every(Number.isFinite)) {
        spr.destroy(true);
        continue;
      }
      if (vals.some((v) => Math.abs(v) > 1e7)) {
        spr.destroy(true);
        continue;
      }
      spr.transform.setFromMatrix(stageLocal);
    } catch {
      try {
        spr.destroy(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      continue;
    }
    out.push(spr);
  }
  return out;
}

/**
 * Compute a display object's transform relative to `canvas.stage`.
 * @param {PIXI.DisplayObject} displayObject
 * @returns {PIXI.Matrix}
 */
export function stageLocalMatrixOf(displayObject) {
  const chain = [];
  let obj = displayObject;
  while (obj && obj !== canvas.stage) {
    chain.push(obj);
    obj = obj.parent;
  }
  const M = new PIXI.Matrix();
  for (let i = chain.length - 1; i >= 0; i--) {
    const tr = chain[i]?.transform;

    /**
     * PIXI updates `localTransform` during `updateTransform()`. Mask repaints can run before the next render tick. When available, `updateLocalTransform()` forces a recompute so that token cutouts stay synchronized with token motion.
     */
    try {
      if (tr && typeof tr.updateLocalTransform === "function") tr.updateLocalTransform();
    } catch {}

    const lt = tr?.localTransform || PIXI.Matrix.IDENTITY;
    M.append(lt);
  }
  return M;
}

/**
 * Return true if an overhead tile or something at higher elevation covers the token
 */
function _isTokenOccludedByOverhead(token) {
  if (token.controlled) return false;

  const candidates = canvas.primary.quadtree.getObjects(token.bounds);

  for (let candidate of candidates) {
    if (!candidate?.isOccludable) continue;
    const tElev = Number(token.elevation ?? 0);
    const candElev = Number(candidate.elevation ?? 0);
    if (Number.isFinite(candElev) && Number.isFinite(tElev) && candElev <= tElev) continue;
    const corners = candidate.restrictsLight && candidate.restrictsWeather;
    if (!candidate.testOcclusion?.(token, { corners })) continue;
    return true;
  }

  return false;
}

/**
 * Compose a cutout mask by subtracting token silhouettes from a base mask.
 * @param {PIXI.RenderTexture} baseRT
 * @param {{outRT?: PIXI.RenderTexture}} [opts]
 * @returns {PIXI.RenderTexture}
 */
export function composeMaskMinusTokens(baseRT, { outRT } = {}) {
  const r = canvas?.app?.renderer;
  if (!r || !baseRT) return baseRT;

  const out =
    outRT ??
    PIXI.RenderTexture.create({
      width: baseRT.width | 0,
      height: baseRT.height | 0,
      resolution: baseRT.resolution || 1,
    });

  const spr = (_tmpRTCopySprite ??= new PIXI.Sprite());
  spr.texture = baseRT;
  spr.blendMode = PIXI.BLEND_MODES.NORMAL;
  spr.alpha = 1;
  spr.position.set(0, 0);
  spr.scale.set(1, 1);
  spr.rotation = 0;
  r.render(spr, { renderTexture: out, clear: true });

  const Msnap = snappedStageMatrix();
  const c = new PIXI.Container();
  c.transform.setFromMatrix(Msnap);
  c.roundPixels = false;
  for (const s of collectTokenAlphaSprites({ respectOcclusion: true })) {
    s.blendMode = PIXI.BLEND_MODES.DST_OUT;
    s.roundPixels = false;
    c.addChild(s);
  }
  if (c.children.length) r.render(c, { renderTexture: out, clear: false, skipUpdateTransform: false });

  subtractDynamicRingsFromRT(out);
  const poolable = [];
  for (const child of c.children) poolable.push(child);
  try {
    c.removeChildren();
    releaseTokenSprites(poolable);
    c.destroy({ children: false, texture: false, baseTexture: false });
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  try {
    out.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
    out.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
  } catch (err) {
    logger.debug("FXMaster:", err);
  }
  return out;
}

/**
 * Compose a cutout mask by subtracting an existing tokens silhouette RT from a base mask.
 *
 * This is a cheaper alternative to {@link composeMaskMinusTokens} because it avoids re-collecting and re-rendering token sprites for each cutout. It assumes both RTs are in the same CSS-space viewport coordinates (e.g. produced by {@link buildSceneAllowMaskRT} and {@link repaintTokensMaskInto}).
 *
 * @param {PIXI.RenderTexture} baseRT
 * @param {PIXI.RenderTexture} tokensRT
 * @param {{outRT?: PIXI.RenderTexture}} [opts]
 * @returns {PIXI.RenderTexture|null}
 */
export function composeMaskMinusTokensRT(baseRT, tokensRT, { outRT } = {}) {
  const r = canvas?.app?.renderer;
  if (!r || !baseRT || !tokensRT) return baseRT;

  const out =
    outRT ??
    PIXI.RenderTexture.create({
      width: baseRT.width | 0,
      height: baseRT.height | 0,
      resolution: baseRT.resolution || 1,
    });

  try {
    const spr = (_tmpRTCopySprite ??= new PIXI.Sprite());
    spr.texture = baseRT;
    spr.blendMode = PIXI.BLEND_MODES.NORMAL;
    spr.alpha = 1;
    spr.position.set(0, 0);
    spr.scale.set(1, 1);
    spr.rotation = 0;
    r.render(spr, { renderTexture: out, clear: true });
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  try {
    const spr = (_tmpTokensEraseSprite ??= new PIXI.Sprite());
    spr.texture = tokensRT;
    spr.blendMode = PIXI.BLEND_MODES.ERASE;
    spr.alpha = 1;
    spr.position.set(0, 0);
    spr.scale.set(1, 1);
    spr.rotation = 0;
    r.render(spr, { renderTexture: out, clear: false });
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  return out;
}

/**
 * Ensure a CSS-space sprite mask exists under a node and is projected locally.
 * @param {PIXI.Container} node
 * @param {PIXI.Texture|PIXI.RenderTexture|null} texture
 * @param {string} [name="fxmaster:css-mask"]
 * @returns {PIXI.Sprite|null}
 */
export function ensureCssSpaceMaskSprite(node, texture, name = "fxmaster:css-mask") {
  if (!node) return null;
  let spr = node.children?.find?.((c) => c?.name === name) || null;

  if (!spr || spr.destroyed) {
    spr = new PIXI.Sprite(safeMaskTexture(texture));
    spr.name = name;
    spr.renderable = true;
    spr.eventMode = "none";
    spr.interactive = false;
    spr.cursor = null;
    node.addChildAt(spr, 0);
  } else {
    spr.texture = safeMaskTexture(texture);
  }

  const { cssW, cssH } = getCssViewportMetrics();
  spr.x = 0;
  spr.y = 0;
  spr.width = cssW;
  spr.height = cssH;

  applyMaskSpriteTransform(node, spr);
  node.mask = spr;
  return spr;
}

/**
 * Render a tokens-only silhouette into a given RT.
 * @param {PIXI.RenderTexture} outRT
 */
export function repaintTokensMaskInto(outRT) {
  const r = canvas?.app?.renderer;
  if (!r || !outRT) return;
  const Msnap = snappedStageMatrix();
  const cont = new PIXI.Container();
  cont.transform.setFromMatrix(Msnap);
  cont.roundPixels = false;
  for (const s of collectTokenAlphaSprites()) {
    s.blendMode = PIXI.BLEND_MODES.NORMAL;
    s.roundPixels = false;
    cont.addChild(s);
  }
  r.render(cont, { renderTexture: outRT, clear: true, skipUpdateTransform: false });
  paintDynamicRingsInto(outRT);
  const poolable = [];
  for (const child of cont.children) poolable.push(child);
  try {
    cont.removeChildren();
    releaseTokenSprites(poolable);
    cont.destroy({ children: false, texture: false, baseTexture: false });
  } catch (err) {
    logger.debug("FXMaster:", err);
  }
}

/**
 * Return a non-null texture suitable for sprite masks.
 * Falls back to {@link PIXI.Texture.WHITE} when the input is null, destroyed, or missing required metadata (for example, a missing {@code orig} after texture destruction).
 *
 * @param {PIXI.Texture|PIXI.RenderTexture|null} tex
 * @returns {PIXI.Texture|PIXI.RenderTexture}
 */
export function safeMaskTexture(tex) {
  try {
    if (!tex) return PIXI.Texture.WHITE;
    if (tex.destroyed) return PIXI.Texture.WHITE;
    if (tex.baseTexture?.destroyed) return PIXI.Texture.WHITE;
    if (!tex.orig) return PIXI.Texture.WHITE;
    return tex;
  } catch {
    return PIXI.Texture.WHITE;
  }
}

/**
 * Render a hard-edged binary region mask into a render texture.
 *
 * @param {PIXI.RenderTexture} rt
 * @param {PlaceableObject} region
 * @param {PIXI.Matrix} stageMatrix
 * @returns {void}
 * @private
 */
function _renderBinaryRegionMaskRT(rt, region, stageMatrix) {
  const r = canvas?.app?.renderer;
  if (!r || !rt) return;

  const { solids: solidsGfx, holes: holesGfx } = _getRegionMaskGfx();
  solidsGfx.clear();
  holesGfx.clear();

  solidsGfx.transform.setFromMatrix(stageMatrix);
  holesGfx.transform.setFromMatrix(stageMatrix);

  const shapes = region?.document?.shapes ?? [];

  solidsGfx.beginFill(0xffffff, 1.0);
  for (const s of shapes) {
    if (!s?.hole) traceRegionShapePIXI(solidsGfx, s);
  }
  solidsGfx.endFill();

  holesGfx.beginFill(0xffffff, 1.0);
  for (const s of shapes) {
    if (s?.hole) traceRegionShapePIXI(holesGfx, s);
  }
  holesGfx.endFill();

  /**
   * These shared graphics objects are also used by scene-suppression rendering, which flips the solids pass to ERASE and the holes pass to NORMAL.
   * Reset both blend modes here so hard scene suppression cannot leak into later region mask builds.
   */
  solidsGfx.blendMode = PIXI.BLEND_MODES.NORMAL;
  holesGfx.blendMode = PIXI.BLEND_MODES.ERASE;

  r.render(solidsGfx, { renderTexture: rt, clear: true });
  r.render(holesGfx, { renderTexture: rt, clear: false });
}

/**
 * Compute the inward edge fade width for a region in CSS pixels.
 *
 * @param {PlaceableObject} region
 * @param {PIXI.Matrix} stageMatrix
 * @param {number} edgeFadePercent
 * @param {number} featherPx
 * @returns {number}
 * @private
 */
function _computeRegionFadeCssPx(region, stageMatrix, edgeFadePercent, featherPx) {
  const pct = Math.min(Math.max(Number(edgeFadePercent) || 0, 0), 1);
  let fadeCssPx = Math.max(0, Number(featherPx) || 0);

  if (pct > 0) {
    const inradWorld = estimateRegionInradius(region);
    if (Number.isFinite(inradWorld) && inradWorld > 0) {
      let worldPerCss = 1;
      try {
        const cssToWorld = stageMatrix.clone().invert();
        worldPerCss = 0.5 * (Math.hypot(cssToWorld.a, cssToWorld.b) + Math.hypot(cssToWorld.c, cssToWorld.d));
        if (!Number.isFinite(worldPerCss) || worldPerCss <= 1e-6) worldPerCss = 1;
      } catch {
        worldPerCss = 1;
      }
      const inradCss = inradWorld / Math.max(worldPerCss, 1e-6);
      fadeCssPx = Math.max(fadeCssPx, pct * inradCss);
    }
  }

  return fadeCssPx;
}

/**
 * Compute the CSS-space bounds needed to bake a soft suppression mask.
 *
 * The bounds are expanded by the fade width so the inward ramp still has access to transparent pixels outside the region when the region boundary reaches the viewport edge.
 *
 * @param {PlaceableObject} region
 * @param {PIXI.Matrix} stageMatrix
 * @param {number} viewportWidth
 * @param {number} viewportHeight
 * @param {number} padCss
 * @returns {{ x:number, y:number, width:number, height:number }|null}
 * @private
 */
function _computeRegionSoftMaskBounds(region, stageMatrix, viewportWidth, viewportHeight, padCss) {
  const worldBounds = regionWorldBoundsAligned(region);
  if (!worldBounds) return null;

  const pts = [
    { x: worldBounds.minX, y: worldBounds.minY },
    { x: worldBounds.maxX, y: worldBounds.minY },
    { x: worldBounds.maxX, y: worldBounds.maxY },
    { x: worldBounds.minX, y: worldBounds.maxY },
  ];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const tmp = new PIXI.Point();
  for (const pt of pts) {
    stageMatrix.apply(pt, tmp);
    minX = Math.min(minX, tmp.x);
    minY = Math.min(minY, tmp.y);
    maxX = Math.max(maxX, tmp.x);
    maxY = Math.max(maxY, tmp.y);
  }

  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;

  const aaPad = 2;
  const grow = Math.max(aaPad, Math.ceil(padCss) + aaPad);

  const clipMinX = Math.floor(-grow);
  const clipMinY = Math.floor(-grow);
  const clipMaxX = Math.ceil(viewportWidth + grow);
  const clipMaxY = Math.ceil(viewportHeight + grow);

  const x0 = Math.max(clipMinX, Math.floor(minX - grow));
  const y0 = Math.max(clipMinY, Math.floor(minY - grow));
  const x1 = Math.min(clipMaxX, Math.ceil(maxX + grow));
  const y1 = Math.min(clipMaxY, Math.ceil(maxY + grow));

  if (!(x1 > x0 && y1 > y0)) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Create a canvas element for temporary region-mask rasterization.
 *
 * @param {number} width
 * @param {number} height
 * @returns {HTMLCanvasElement|null}
 * @private
 */
function _createRegionMaskCanvas(width, height) {
  const doc = globalThis.document;
  if (!doc?.createElement) return null;
  const canvasEl = doc.createElement("canvas");
  canvasEl.width = Math.max(1, Math.ceil(Number(width) || 1));
  canvasEl.height = Math.max(1, Math.ceil(Number(height) || 1));
  return canvasEl;
}

/**
 * Rasterize a region into a binary local-space canvas.
 *
 * @param {PlaceableObject} region
 * @param {{ x:number, y:number, width:number, height:number }} bounds
 * @param {PIXI.Matrix} stageMatrix
 * @param {number} resolution
 * @returns {HTMLCanvasElement|null}
 * @private
 */
function _rasterizeRegionBinaryCanvas(region, bounds, stageMatrix, resolution) {
  const res = Math.max(0.25, Number(resolution) || 1);
  const canvasEl = _createRegionMaskCanvas(bounds.width * res, bounds.height * res);
  if (!canvasEl) return null;

  const ctx = canvasEl.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  ctx.setTransform(
    stageMatrix.a * res,
    stageMatrix.b * res,
    stageMatrix.c * res,
    stageMatrix.d * res,
    (stageMatrix.tx - bounds.x) * res,
    (stageMatrix.ty - bounds.y) * res,
  );
  ctx.imageSmoothingEnabled = false;

  const shapes = region?.document?.shapes ?? [];

  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#ffffff";
  for (const s of shapes) {
    if (s?.hole) continue;
    ctx.beginPath();
    traceRegionShapePath2D(ctx, s);
    ctx.fill();
  }

  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = "#ffffff";
  for (const s of shapes) {
    if (!s?.hole) continue;
    ctx.beginPath();
    traceRegionShapePath2D(ctx, s);
    ctx.fill();
  }

  return canvasEl;
}

/**
 * Run an exact one-dimensional squared Euclidean distance transform.
 *
 * @param {Float32Array} f
 * @param {number} n
 * @param {Float32Array} d
 * @param {Int32Array} v
 * @param {Float32Array} z
 * @returns {void}
 * @private
 */
function _edt1dExact(f, n, d, v, z) {
  const INF = 1e20;
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;

  for (let q = 1; q < n; q++) {
    let p = v[k];
    let s = (f[q] + q * q - (f[p] + p * p)) / (2 * (q - p));

    while (k > 0 && s <= z[k]) {
      k--;
      p = v[k];
      s = (f[q] + q * q - (f[p] + p * p)) / (2 * (q - p));
    }

    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }

  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const p = v[k];
    const dx = q - p;
    d[q] = dx * dx + f[p];
  }
}

/**
 * Compute the exact squared distance from every pixel to the nearest matching feature pixel.
 *
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 * @param {number} featureValue
 * @returns {Float32Array}
 * @private
 */
function _edt2dFromBinaryMask(mask, width, height, featureValue) {
  const W = Math.max(1, width | 0);
  const H = Math.max(1, height | 0);
  const INF = 1e20;
  const n = W * H;

  const maxN = Math.max(W, H);
  const f = new Float32Array(maxN);
  const d = new Float32Array(maxN);
  const v = new Int32Array(maxN);
  const z = new Float32Array(maxN + 1);
  const tmp = new Float32Array(n);

  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) f[x] = mask[row + x] === featureValue ? 0 : INF;
    _edt1dExact(f, W, d, v, z);
    for (let x = 0; x < W; x++) tmp[row + x] = d[x];
  }

  const out = new Float32Array(n);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = tmp[y * W + x];
    _edt1dExact(f, H, d, v, z);
    for (let y = 0; y < H; y++) out[y * W + x] = d[y];
  }

  return out;
}

/**
 * Convert a binary region canvas into an inward-faded alpha mask.
 *
 * Alpha is derived from the exact distance to the nearest transparent pixel, so solids fade inward from their outer edge and holes apply the same fade along their boundary.
 *
 * @param {HTMLCanvasElement} binaryCanvas
 * @param {number} fadePx
 * @returns {HTMLCanvasElement|null}
 * @private
 */
function _bakeInwardFadeCanvas(binaryCanvas, fadePx) {
  const W = Math.max(1, binaryCanvas?.width | 0);
  const H = Math.max(1, binaryCanvas?.height | 0);
  if (!(W > 0 && H > 0)) return null;

  const ctx = binaryCanvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  const img = ctx.getImageData(0, 0, W, H);
  const src = img.data;
  const mask = new Uint8Array(W * H);

  let hasInside = false;
  for (let i = 0, p = 0; i < src.length; i += 4, p++) {
    const inside = src[i + 3] >= 128 ? 1 : 0;
    mask[p] = inside;
    hasInside ||= inside === 1;
  }

  if (!hasInside) {
    ctx.clearRect(0, 0, W, H);
    return binaryCanvas;
  }

  const fade = Math.max(1e-6, Number(fadePx) || 0);
  const distSq = _edt2dFromBinaryMask(mask, W, H, 0);
  const out = ctx.createImageData(W, H);

  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    if (!mask[p]) continue;
    const edgeDist = Math.max(0, Math.sqrt(distSq[p]) - 0.5);
    const alpha = Math.max(0, Math.min(1, edgeDist / fade));
    const v = Math.round(alpha * 255);
    out.data[i + 0] = v;
    out.data[i + 1] = v;
    out.data[i + 2] = v;
    out.data[i + 3] = v;
  }

  ctx.clearRect(0, 0, W, H);
  ctx.putImageData(out, 0, 0);
  return binaryCanvas;
}

/**
 * Render a soft region mask using a locally baked distance field instead of a viewport blur pass.
 *
 * @param {PIXI.RenderTexture} rt
 * @param {PlaceableObject} region
 * @param {PIXI.Matrix} stageMatrix
 * @param {{ viewportWidth:number, viewportHeight:number, resolution:number, fadeCssPx:number }} options
 * @returns {boolean}
 * @private
 */
function _renderSoftRegionMaskRT(rt, region, stageMatrix, { viewportWidth, viewportHeight, resolution, fadeCssPx }) {
  const r = canvas?.app?.renderer;
  if (!r || !rt || !(fadeCssPx > 0)) return false;

  const bounds = _computeRegionSoftMaskBounds(region, stageMatrix, viewportWidth, viewportHeight, fadeCssPx);
  if (!bounds) {
    r.render(new PIXI.Graphics(), { renderTexture: rt, clear: true });
    return true;
  }

  const softRes = safeMaskResolutionForCssArea(bounds.width, bounds.height, Number(resolution) || 1);
  const binaryCanvas = _rasterizeRegionBinaryCanvas(region, bounds, stageMatrix, softRes);
  if (!binaryCanvas) return false;

  const alphaCanvas = _bakeInwardFadeCanvas(binaryCanvas, fadeCssPx * softRes);
  if (!alphaCanvas) return false;

  let texture = null;
  try {
    const base = PIXI.BaseTexture.from(alphaCanvas, {
      scaleMode: PIXI.SCALE_MODES.LINEAR,
      mipmap: PIXI.MIPMAP_MODES.OFF,
      alphaMode: PIXI.ALPHA_MODES.NO_PREMULTIPLIED,
    });
    texture = new PIXI.Texture(base);

    const spr = (_tmpRegionCanvasSprite ??= new PIXI.Sprite());
    spr.texture = texture;
    spr.blendMode = PIXI.BLEND_MODES.NORMAL;
    spr.alpha = 1;
    spr.position.set(bounds.x, bounds.y);
    spr.scale.set(1, 1);
    spr.rotation = 0;
    spr.roundPixels = false;
    spr.width = bounds.width;
    spr.height = bounds.height;
    spr.filters = null;

    r.render(spr, { renderTexture: rt, clear: true });
    spr.texture = PIXI.Texture.EMPTY;
  } catch (err) {
    logger.debug("FXMaster:", err);
    if (texture) {
      try {
        texture.destroy(true);
      } catch (e) {
        logger.debug("FXMaster:", e);
      }
    }
    return false;
  }

  try {
    texture?.destroy(true);
  } catch (err) {
    logger.debug("FXMaster:", err);
  }
  return true;
}

/**
 * Estimate the average CSS-pixel scale of the current stage matrix.
 *
 * @param {PIXI.Matrix} stageMatrix
 * @returns {number}
 * @private
 */
function _averageStageCssScale(stageMatrix) {
  const sx = Math.hypot(stageMatrix?.a ?? 1, stageMatrix?.b ?? 0);
  const sy = Math.hypot(stageMatrix?.c ?? 0, stageMatrix?.d ?? 1);
  const scale = 0.5 * (sx + sy);
  return Number.isFinite(scale) && scale > 1e-6 ? scale : 1;
}

/**
 * Compute the inward fade width for a region in world units.
 *
 * @param {PlaceableObject} region
 * @param {PIXI.Matrix} stageMatrix
 * @param {number} edgeFadePercent
 * @param {number} featherPx
 * @returns {number}
 * @private
 */
function _computeRegionFadeWorld(region, stageMatrix, edgeFadePercent, featherPx = 0) {
  const pct = Math.min(Math.max(Number(edgeFadePercent) || 0, 0), 1);
  let fadeWorld = 0;

  if (pct > 0) {
    const inradWorld = estimateRegionInradius(region);
    if (Number.isFinite(inradWorld) && inradWorld > 0) fadeWorld = Math.max(fadeWorld, pct * inradWorld);
  }

  const featherCss = Math.max(0, Number(featherPx) || 0);
  if (featherCss > 0) {
    const cssPerWorld = _averageStageCssScale(stageMatrix);
    fadeWorld = Math.max(fadeWorld, featherCss / Math.max(cssPerWorld, 1e-6));
  }

  return fadeWorld;
}

/**
 * Rasterize a region into a binary world-space canvas at a chosen pixel density.
 *
 * @param {PlaceableObject} region
 * @param {{ x:number, y:number, width:number, height:number }} boundsWorld
 * @param {number} pixelsPerWorld
 * @returns {HTMLCanvasElement|null}
 * @private
 */
function _rasterizeRegionBinaryCanvasWorld(region, boundsWorld, pixelsPerWorld) {
  const ppw = Math.max(0.25, Number(pixelsPerWorld) || 1);
  const canvasEl = _createRegionMaskCanvas(boundsWorld.width * ppw, boundsWorld.height * ppw);
  if (!canvasEl) return null;

  const ctx = canvasEl.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  ctx.setTransform(ppw, 0, 0, ppw, -boundsWorld.x * ppw, -boundsWorld.y * ppw);
  ctx.imageSmoothingEnabled = false;

  const shapes = region?.document?.shapes ?? [];

  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#ffffff";
  for (const s of shapes) {
    if (s?.hole) continue;
    ctx.beginPath();
    traceRegionShapePath2D(ctx, s);
    ctx.fill();
  }

  ctx.globalCompositeOperation = "destination-out";
  for (const s of shapes) {
    if (!s?.hole) continue;
    ctx.beginPath();
    traceRegionShapePath2D(ctx, s);
    ctx.fill();
  }

  return canvasEl;
}

/**
 * Destroy a cached scene-suppression soft-mask entry.
 *
 * @param {{ texture?: PIXI.Texture|null }|null} entry
 * @returns {void}
 * @private
 */
function _destroySceneSuppressionSoftCacheEntry(entry) {
  if (!entry) return;
  try {
    entry.texture?.destroy(true);
  } catch (err) {
    logger.debug("FXMaster:", err);
  }
}

/**
 * Prune stale or excess scene-suppression soft-mask cache entries.
 *
 * @param {string|null} sceneId
 * @param {number} [maxEntries=48]
 * @returns {void}
 * @private
 */
function _trimSceneSuppressionSoftCache(sceneId, maxEntries = 48) {
  for (const [key, entry] of _sceneSuppressionSoftCache) {
    if (sceneId && entry?.sceneId === sceneId) continue;
    _destroySceneSuppressionSoftCacheEntry(entry);
    _sceneSuppressionSoftCache.delete(key);
  }

  if (_sceneSuppressionSoftCache.size <= maxEntries) return;

  const victims = [..._sceneSuppressionSoftCache.entries()]
    .sort((a, b) => (a[1]?.lastUsed ?? 0) - (b[1]?.lastUsed ?? 0))
    .slice(0, Math.max(0, _sceneSuppressionSoftCache.size - maxEntries));

  for (const [key, entry] of victims) {
    _destroySceneSuppressionSoftCacheEntry(entry);
    _sceneSuppressionSoftCache.delete(key);
  }
}

/**
 * Clear all cached scene-suppression soft masks.
 *
 * @returns {void}
 */
export function clearSceneSuppressionSoftMaskCache() {
  for (const entry of _sceneSuppressionSoftCache.values()) _destroySceneSuppressionSoftCacheEntry(entry);
  _sceneSuppressionSoftCache.clear();
  _sceneSuppressionSoftCacheTick = 0;
}

/**
 * Retrieve or build a cached world-space soft suppression mask for a region.
 *
 * The cache is camera-independent, so pan and zoom reuse the same baked mask and only re-render the sprite with the updated stage transform. Rebuilds occur when the region geometry or edge-fade setting changes.
 *
 * @param {PlaceableObject} region
 * @param {PIXI.Matrix} stageMatrix
 * @param {number} edgeFadePercent
 * @returns {{ texture: PIXI.Texture, boundsWorld: { x:number, y:number, width:number, height:number }, pixelsPerWorld: number }|null}
 * @private
 */
function _getSceneSuppressionSoftMaskEntry(region, stageMatrix, edgeFadePercent) {
  const sceneId = canvas?.scene?.id ?? null;
  const regionId = region?.document?.id ?? region?.id ?? null;
  if (!sceneId || !regionId) return null;

  /**
   * Use camera-independent world bounds for the cached soft mask.
   * CSS-aligned bounds track the snapped viewport and would invalidate the cache on every pan or zoom,
   * forcing a full distance-field rebake whenever the camera moves.
   */
  const worldBounds = regionWorldBounds(region);
  if (!worldBounds) return null;

  const fadeWorld = _computeRegionFadeWorld(region, stageMatrix, edgeFadePercent, 0);
  if (!(fadeWorld > 0)) return null;

  const roughWidth = worldBounds.maxX - worldBounds.minX + fadeWorld * 2;
  const roughHeight = worldBounds.maxY - worldBounds.minY + fadeWorld * 2;
  if (!(roughWidth > 0 && roughHeight > 0)) return null;

  /**
   * Keep the cached bake density stable in world space.
   * Scene suppression masks are reused across both particles and filters, so camera movement must not raise the bake density or mutate the cache key.
   */
  let targetPixelsPerWorld = SCENE_SUPPRESSION_SOFT_MAX_PIXELS_PER_WORLD;
  {
    const maxDimWorld = Math.max(roughWidth, roughHeight, 1e-6);
    const worldArea = Math.max(roughWidth * roughHeight, 1e-6);
    const spanCap = SCENE_SUPPRESSION_SOFT_MAX_TEXTURE_SPAN / maxDimWorld;
    const areaCap = Math.sqrt(SCENE_SUPPRESSION_SOFT_MAX_TEXTURE_AREA / worldArea);
    targetPixelsPerWorld = Math.max(0.25, Math.min(targetPixelsPerWorld, spanCap, areaCap));
  }

  /**
   * Pad by the fade width plus a small texel margin so the inward ramp still sees transparent pixels outside the region.
   * The margin is derived from the baked texture density, not the camera scale, so the cache remains pan/zoom invariant.
   */
  let aaPadWorld = 2 / Math.max(targetPixelsPerWorld, 1e-6);
  let boundsWorld = {
    x: worldBounds.minX - (fadeWorld + aaPadWorld),
    y: worldBounds.minY - (fadeWorld + aaPadWorld),
    width: worldBounds.maxX - worldBounds.minX + (fadeWorld + aaPadWorld) * 2,
    height: worldBounds.maxY - worldBounds.minY + (fadeWorld + aaPadWorld) * 2,
  };

  {
    const maxDimWorld = Math.max(boundsWorld.width, boundsWorld.height, 1e-6);
    const worldArea = Math.max(boundsWorld.width * boundsWorld.height, 1e-6);
    const spanCap = SCENE_SUPPRESSION_SOFT_MAX_TEXTURE_SPAN / maxDimWorld;
    const areaCap = Math.sqrt(SCENE_SUPPRESSION_SOFT_MAX_TEXTURE_AREA / worldArea);
    const cappedPixelsPerWorld = Math.max(0.25, Math.min(targetPixelsPerWorld, spanCap, areaCap));
    if (cappedPixelsPerWorld < targetPixelsPerWorld) {
      targetPixelsPerWorld = cappedPixelsPerWorld;
      aaPadWorld = 2 / Math.max(targetPixelsPerWorld, 1e-6);
      boundsWorld = {
        x: worldBounds.minX - (fadeWorld + aaPadWorld),
        y: worldBounds.minY - (fadeWorld + aaPadWorld),
        width: worldBounds.maxX - worldBounds.minX + (fadeWorld + aaPadWorld) * 2,
        height: worldBounds.maxY - worldBounds.minY + (fadeWorld + aaPadWorld) * 2,
      };
    }
  }

  if (!(boundsWorld.width > 0 && boundsWorld.height > 0)) return null;

  const key = `${sceneId}:${regionId}:${Math.round(edgeFadePercent * 1000000)}`;
  const shapesRef = region?.document?._source?.shapes ?? region?.document?.shapes ?? null;
  const boundsSig = `${worldBounds.x}|${worldBounds.y}|${boundsWorld.width}|${boundsWorld.height}`;

  const cached = _sceneSuppressionSoftCache.get(key) ?? null;
  if (
    cached &&
    cached.shapesRef === shapesRef &&
    cached.boundsSig === boundsSig &&
    Math.abs((cached.fadeWorld ?? 0) - fadeWorld) <= 1e-6 &&
    Math.abs((cached.pixelsPerWorld ?? 0) - targetPixelsPerWorld) <= 1e-6
  ) {
    cached.lastUsed = ++_sceneSuppressionSoftCacheTick;
    return cached;
  }

  if (cached) {
    _destroySceneSuppressionSoftCacheEntry(cached);
    _sceneSuppressionSoftCache.delete(key);
  }

  const binaryCanvas = _rasterizeRegionBinaryCanvasWorld(region, boundsWorld, targetPixelsPerWorld);
  if (!binaryCanvas) return null;

  const alphaCanvas = _bakeInwardFadeCanvas(binaryCanvas, fadeWorld * targetPixelsPerWorld);
  if (!alphaCanvas) return null;

  let texture = null;
  try {
    const base = PIXI.BaseTexture.from(alphaCanvas, {
      scaleMode: PIXI.SCALE_MODES.LINEAR,
      mipmap: PIXI.MIPMAP_MODES.OFF,
      alphaMode: PIXI.ALPHA_MODES.NO_PREMULTIPLIED,
    });
    try {
      if (base?.resource && "autoUpdate" in base.resource) base.resource.autoUpdate = false;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    texture = new PIXI.Texture(base);
  } catch (err) {
    logger.debug("FXMaster:", err);
    try {
      texture?.destroy(true);
    } catch (e) {
      logger.debug("FXMaster:", e);
    }
    return null;
  }

  const entry = {
    sceneId,
    regionId,
    shapesRef,
    boundsSig,
    fadeWorld,
    boundsWorld,
    pixelsPerWorld: targetPixelsPerWorld,
    texture,
    lastUsed: ++_sceneSuppressionSoftCacheTick,
  };

  _sceneSuppressionSoftCache.set(key, entry);
  _trimSceneSuppressionSoftCache(sceneId);
  return entry;
}

/**
 * Render a cached world-space soft suppression mask directly into a scene allow-mask RT.
 *
 * @param {PIXI.RenderTexture} rt
 * @param {PlaceableObject} region
 * @param {PIXI.Matrix} stageMatrix
 * @param {number} edgeFadePercent
 * @returns {boolean}
 * @private
 */
function _renderSceneSuppressionSoftMask(rt, region, stageMatrix, edgeFadePercent) {
  const r = canvas?.app?.renderer;
  if (!r || !rt) return false;

  const entry = _getSceneSuppressionSoftMaskEntry(region, stageMatrix, edgeFadePercent);
  if (!entry?.texture) return false;

  const bounds = entry.boundsWorld;
  const ppw = Math.max(1e-6, entry.pixelsPerWorld || 1);
  const matrix = new PIXI.Matrix(
    stageMatrix.a / ppw,
    stageMatrix.b / ppw,
    stageMatrix.c / ppw,
    stageMatrix.d / ppw,
    stageMatrix.a * bounds.x + stageMatrix.c * bounds.y + stageMatrix.tx,
    stageMatrix.b * bounds.x + stageMatrix.d * bounds.y + stageMatrix.ty,
  );

  const spr = (_tmpSceneSuppressionSprite ??= new PIXI.Sprite());
  spr.texture = entry.texture;
  spr.blendMode = PIXI.BLEND_MODES.ERASE;
  spr.alpha = 1;
  spr.roundPixels = false;
  spr.filters = null;
  spr.transform.setFromMatrix(matrix);

  r.render(spr, { renderTexture: rt, clear: false });
  spr.texture = PIXI.Texture.EMPTY;
  return true;
}

/**
 * Render a hard-edged suppression region directly into a scene allow-mask RT.
 *
 * @param {PIXI.RenderTexture} rt
 * @param {PlaceableObject} region
 * @param {PIXI.Matrix} stageMatrix
 * @returns {void}
 * @private
 */
function _renderSceneSuppressionHardRegion(rt, region, stageMatrix) {
  const r = canvas?.app?.renderer;
  if (!r || !rt || !region) return;

  const { solids: solidsGfx, holes: holesGfx } = _getRegionMaskGfx();
  solidsGfx.clear();
  holesGfx.clear();

  solidsGfx.transform.setFromMatrix(stageMatrix);
  holesGfx.transform.setFromMatrix(stageMatrix);

  solidsGfx.beginFill(0xffffff, 1);
  holesGfx.beginFill(0xffffff, 1);

  const shapes = region?.document?.shapes ?? [];
  for (const s of shapes) {
    if (s?.hole) traceRegionShapePIXI(holesGfx, s);
    else traceRegionShapePIXI(solidsGfx, s);
  }

  solidsGfx.endFill();
  holesGfx.endFill();

  solidsGfx.blendMode = PIXI.BLEND_MODES.ERASE;
  holesGfx.blendMode = PIXI.BLEND_MODES.NORMAL;

  r.render(solidsGfx, { renderTexture: rt, clear: false });
  r.render(holesGfx, { renderTexture: rt, clear: false });
}

/**
 * Build a CSS-space alpha mask RenderTexture for a region.
 * White = inside (allowed), transparent = outside (suppressed).
 * - Camera-aligned via `snappedStageMatrix()` to avoid seams.
 * - Renders solids first, then ERASEs holes.
 * - Uses the provided {@link RTPool} when available.
 *
 * @param {PlaceableObject} region
 * @param {object} [opts]
 * @param {RTPool} [opts.rtPool]
 * @param {number} [opts.resolution]
 * @param {number} [opts.edgeFadePercent=0] - Inward edge fade percentage in [0..1].
 * @param {number} [opts.featherPx=0] - Inward edge feather width in CSS pixels.
 * @returns {PIXI.RenderTexture|null}
 */
export function buildRegionMaskRT(region, { rtPool, resolution, edgeFadePercent = 0, featherPx = 0 } = {}) {
  const r = canvas?.app?.renderer;
  if (!r) return null;

  const { cssW, cssH } = getCssViewportMetrics();
  const VW = Math.max(1, cssW | 0);
  const VH = Math.max(1, cssH | 0);

  const res = resolution ?? safeMaskResolutionForCssArea(VW, VH, 1);

  const rt = rtPool
    ? rtPool.acquire(VW, VH, res)
    : PIXI.RenderTexture.create({ width: VW, height: VH, resolution: res });

  try {
    rt.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
    rt.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  const stageMatrix = snappedStageMatrix();
  const fadeCssPx = _computeRegionFadeCssPx(region, stageMatrix, edgeFadePercent, featherPx);

  if (fadeCssPx > 0) {
    try {
      if (
        _renderSoftRegionMaskRT(rt, region, stageMatrix, {
          viewportWidth: VW,
          viewportHeight: VH,
          resolution: res,
          fadeCssPx,
        })
      ) {
        return rt;
      }
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  _renderBinaryRegionMaskRT(rt, region, stageMatrix);
  return rt;
}

/**
 * Project a CSS-space mask sprite into a container's local space (pixel-snapped).
 * Keeps the existing "roundPixels" behavior mirrored from the particle layer.
 *
 * @param {PIXI.Container} container
 * @param {PIXI.Sprite} spr
 */
export function applyMaskSpriteTransform(container, spr) {
  const r = canvas?.app?.renderer;
  const res = r?.resolution || window.devicePixelRatio || 1;

  const stageMatrix = snappedStageMatrix();
  const localToStage = stageLocalMatrixOf(container);
  const localToCss = new PIXI.Matrix(
    stageMatrix.a * localToStage.a + stageMatrix.c * localToStage.b,
    stageMatrix.b * localToStage.a + stageMatrix.d * localToStage.b,
    stageMatrix.a * localToStage.c + stageMatrix.c * localToStage.d,
    stageMatrix.b * localToStage.c + stageMatrix.d * localToStage.d,
    stageMatrix.a * localToStage.tx + stageMatrix.c * localToStage.ty + stageMatrix.tx,
    stageMatrix.b * localToStage.tx + stageMatrix.d * localToStage.ty + stageMatrix.ty,
  );

  const cssToLocal = localToCss.invert();
  cssToLocal.tx = Math.round(cssToLocal.tx * res) / res;
  cssToLocal.ty = Math.round(cssToLocal.ty * res) / res;
  spr.transform.setFromMatrix(cssToLocal);
  spr.roundPixels = false;
  container.roundPixels = false;
}

/**
 * Compute whether a region should be "passed through" by elevation + viewer-gating.
 *
 * @param {PlaceableObject} placeable
 * @param {{behaviorType:string}} options
 * - behaviorType: e.g. `${packageId}.particleEffectsRegion` or `${packageId}.filterEffectsRegion`
 * @returns {boolean}
 */
export function computeRegionGatePass(placeable, { behaviorType }) {
  const doc = placeable?.document;
  if (!doc) return true;

  const fxBeh = (doc.behaviors ?? []).find((b) => b.type === behaviorType && !b.disabled);
  if (!fxBeh) return true;

  const gmAlways = !!fxBeh.getFlag?.(packageId, "gmAlwaysVisible");
  if (gmAlways && game.user?.isGM) return true;

  const { mode, latched } = getEventGate(placeable, behaviorType);
  if (mode === "enterExit") return !!latched;
  if (mode === "enter" && !latched) return false;

  const win = getRegionElevationWindow(doc);
  const gateMode = fxBeh.getFlag?.(packageId, "gateMode");

  const tokenElevation = (t) => {
    const d = Number(t?.document?.elevation);
    if (Number.isFinite(d)) return d;
    const e = Number(t?.elevation);
    return Number.isFinite(e) ? e : NaN;
  };

  if (gateMode === "pov") {
    const selected = canvas.tokens?.controlled ?? [];
    if (!selected?.length) return false;
    if (!win) return true;
    for (const t of selected) {
      const elev = tokenElevation(t);
      if (Number.isFinite(elev) && inRangeElev(elev, win)) return true;
    }
    return false;
  }

  if (gateMode === "targets") {
    const targets = fxBeh.getFlag?.(packageId, "tokenTargets");
    const ids = Array.isArray(targets) ? targets : targets ? [targets] : [];
    if (!ids.length) return false;

    const selected = canvas.tokens?.controlled ?? [];
    if (!selected.length) return false;

    const inList = (t) => {
      const id = t?.document?.id;
      const uuid = t?.document?.uuid;
      return ids.includes(id) || ids.includes(uuid);
    };
    const pool = selected.filter(inList);
    if (!pool.length) return false;

    if (!win) return true;
    for (const t of pool) {
      const elev = tokenElevation(t);
      if (Number.isFinite(elev) && inRangeElev(elev, win)) return true;
    }
    return false;
  }

  return true;
}

/**
 * Build a scene-wide "allow" mask render texture.
 *
 * Supports two suppression paths:
 * - `weatherRegions`: hard binary suppression with legacy global hole behavior.
 * - `suppressionRegions`: per-region suppression masks that may use inward edge fade.
 *
 * The legacy `regions` option is retained as an alias for `weatherRegions`.
 *
 * @param {{
 * regions?: Region[]|null,
 * weatherRegions?: Region[]|null,
 * suppressionRegions?: Array<{ region: Region, edgeFadePercent?: number }>,
 * reuseRT?: PIXI.RenderTexture|null
 * }} [opts]
 * @returns {PIXI.RenderTexture|null}
 */
export function buildSceneAllowMaskRT({
  regions = null,
  weatherRegions = null,
  suppressionRegions = [],
  reuseRT = null,
} = {}) {
  const r = canvas?.app?.renderer;
  if (!r) return null;

  const { cssW, cssH } = getCssViewportMetrics();
  const res = safeMaskResolutionForCssArea(cssW, cssH);
  const hardRegions = Array.isArray(weatherRegions) ? weatherRegions : Array.isArray(regions) ? regions : [];

  let rt = reuseRT ?? null;
  const needsNew =
    !rt || (rt.width | 0) !== (cssW | 0) || (rt.height | 0) !== (cssH | 0) || (rt.resolution || 1) !== res;

  if (needsNew) {
    const oldRT = reuseRT ?? null;
    rt = PIXI.RenderTexture.create({
      width: cssW | 0,
      height: cssH | 0,
      resolution: res,
      multisample: 0,
    });
    try {
      rt.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
      rt.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    _destroyTextureDeferred(oldRT);
  }

  /** Paint background black (suppressed by default). */
  {
    const { bg } = _getSceneAllowMaskGfx();
    bg.clear();
    bg.beginFill(0x000000, 1).drawRect(0, 0, cssW, cssH).endFill();
    r.render(bg, { renderTexture: rt, clear: true });
  }

  /** Paint scene area white (allowed inside scene dimensions). */
  const M = snappedStageMatrix();
  const d = canvas.dimensions;
  if (d) {
    const { scene } = _getSceneAllowMaskGfx();
    scene.clear();

    scene.transform.setFromMatrix(new PIXI.Matrix());

    const x0w = d.sceneRect.x;
    const y0w = d.sceneRect.y;
    const x1w = x0w + d.sceneRect.width;
    const y1w = y0w + d.sceneRect.height;

    const p0 = new PIXI.Point();
    const p1 = new PIXI.Point();
    M.apply({ x: x0w, y: y0w }, p0);
    M.apply({ x: x1w, y: y1w }, p1);

    const minX = Math.min(p0.x, p1.x);
    const minY = Math.min(p0.y, p1.y);
    const maxX = Math.max(p0.x, p1.x);
    const maxY = Math.max(p0.y, p1.y);

    /**
     * Seam prevention: avoid rounding to the nearest pixel.
     * Rounding can shrink the transformed scene rect by 1px depending on fractional camera alignment, producing a 1px transparent seam that appears to jump between edges at different zoom levels. Bounds are expanded to cover the transformed scene rect.
     */
    const left = Math.floor(minX);
    const top = Math.floor(minY);
    const right = Math.ceil(maxX);
    const bottom = Math.ceil(maxY);

    const x = Math.max(0, Math.min(cssW, left));
    const y = Math.max(0, Math.min(cssH, top));
    const w = Math.max(0, Math.min(cssW, right) - x);
    const h = Math.max(0, Math.min(cssH, bottom) - y);

    if (w > 0 && h > 0) {
      scene.beginFill(0xffffff, 1.0);
      scene.drawRect(x, y, w, h);
      scene.endFill();
      r.render(scene, { renderTexture: rt, clear: false });
    }
  }

  /** Apply hard-edged weather suppression with legacy global hole restoration. */
  if (hardRegions.length) {
    const { solids: solidsGfx, holes: holesGfx } = _getSceneAllowMaskGfx();
    solidsGfx.clear();
    holesGfx.clear();

    solidsGfx.transform.setFromMatrix(M);
    holesGfx.transform.setFromMatrix(M);

    solidsGfx.beginFill(0xffffff, 1);
    holesGfx.beginFill(0xffffff, 1);

    for (const region of hardRegions) {
      const shapes = region?.document?.shapes ?? [];
      for (const s of shapes) {
        if (s?.hole) traceRegionShapePIXI(holesGfx, s);
        else traceRegionShapePIXI(solidsGfx, s);
      }
    }

    solidsGfx.endFill();
    holesGfx.endFill();

    solidsGfx.blendMode = PIXI.BLEND_MODES.ERASE;
    holesGfx.blendMode = PIXI.BLEND_MODES.NORMAL;

    r.render(solidsGfx, { renderTexture: rt, clear: false });
    r.render(holesGfx, { renderTexture: rt, clear: false });
  }

  /** Apply per-region suppression masks so local holes stay attached to the source region. */
  if (Array.isArray(suppressionRegions) && suppressionRegions.length) {
    _trimSceneSuppressionSoftCache(canvas?.scene?.id ?? null);

    for (const entry of suppressionRegions) {
      const region = entry?.region ?? entry;
      if (!region) continue;

      const edgeFadePercent = Math.min(Math.max(Number(entry?.edgeFadePercent) || 0, 0), 1);
      if (edgeFadePercent > 0) {
        if (_renderSceneSuppressionSoftMask(rt, region, M, edgeFadePercent)) continue;
      }
      _renderSceneSuppressionHardRegion(rt, region, M);
    }
  }

  return rt;
}

/**
 * Ensure (or rebuild) the below-tokens artifacts for a given base allow-mask RT:
 * - a "cutout" RT = base minus token silhouettes
 * - a tokens-only RT (alpha mask)
 *
 * Returns updated RTs (existing ones are destroyed/replaced if dimension/res changed).
 *
 * @param {PIXI.RenderTexture} baseRT
 * @param {{ cutoutRT?: PIXI.RenderTexture|null, tokensMaskRT?: PIXI.RenderTexture|null }} [state]
 * @returns {{ cutoutRT: PIXI.RenderTexture, tokensMaskRT: PIXI.RenderTexture }}
 */
export function ensureBelowTokensArtifacts(baseRT, state = {}) {
  const r = canvas?.app?.renderer;
  if (!r || !baseRT) return { cutoutRT: null, tokensMaskRT: null };

  const W = Math.max(1, baseRT.width | 0);
  const H = Math.max(1, baseRT.height | 0);
  const res = baseRT.resolution || 1;

  let cutoutRT = state.cutoutRT;
  const cutoutBad = !cutoutRT || cutoutRT.width !== W || cutoutRT.height !== H || (cutoutRT.resolution || 1) !== res;
  if (cutoutBad) {
    try {
      cutoutRT?.destroy(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    cutoutRT = PIXI.RenderTexture.create({ width: W, height: H, resolution: res, multisample: 0 });
  }
  composeMaskMinusTokens(baseRT, { outRT: cutoutRT });
  try {
    cutoutRT.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
    cutoutRT.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  let tokensMaskRT = state.tokensMaskRT;
  const tokensBad =
    !tokensMaskRT || tokensMaskRT.width !== W || tokensMaskRT.height !== H || (tokensMaskRT.resolution || 1) !== res;
  if (tokensBad) {
    try {
      tokensMaskRT?.destroy(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    tokensMaskRT = PIXI.RenderTexture.create({ width: W, height: H, resolution: res, multisample: 0 });
  }
  repaintTokensMaskInto(tokensMaskRT);
  try {
    tokensMaskRT.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
    tokensMaskRT.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  return { cutoutRT, tokensMaskRT };
}

/**
 * Apply scene-mask uniforms to a list of FXMaster filters.
 * Honors per-filter "belowTokens" option by swapping the sampler and providing token silhouettes.
 * @param {PIXI.Filter[]} filters
 * @param {{
 * baseMaskRT: PIXI.RenderTexture,
 * cutoutRT?: PIXI.RenderTexture|null,
 * tokensMaskRT?: PIXI.RenderTexture|null,
 * cssW: number,
 * cssH: number,
 * deviceToCss: number,
 * maskSoft?: boolean
 * }} cfg
 */
export function applyMaskUniformsToFilters(
  filters,
  { baseMaskRT, cutoutRT = null, tokensMaskRT = null, cssW, cssH, deviceToCss, maskSoft = false },
) {
  const rtCssW = baseMaskRT ? Math.max(1, baseMaskRT.width | 0) : Math.max(1, cssW | 0);
  const rtCssH = baseMaskRT ? Math.max(1, baseMaskRT.height | 0) : Math.max(1, cssH | 0);

  for (const f of filters) {
    if (!f) continue;
    const u = f.uniforms || {};
    const wantBelow = _belowTokensEnabled(f?.__fxmBelowTokens ?? f?.options?.belowTokens);
    const rt = wantBelow ? cutoutRT || baseMaskRT : baseMaskRT;

    if ("maskSampler" in u) u.maskSampler = rt;
    if ("hasMask" in u) u.hasMask = rt ? 1.0 : 0.0;
    if ("maskReady" in u) u.maskReady = rt ? 1.0 : 0.0;
    if ("maskSoft" in u) u.maskSoft = maskSoft ? 1.0 : 0.0;

    if ("viewSize" in u) {
      const arr = u.viewSize instanceof Float32Array && u.viewSize.length >= 2 ? u.viewSize : new Float32Array(2);
      arr[0] = rtCssW;
      arr[1] = rtCssH;
      u.viewSize = arr;
    }

    if ("deviceToCss" in u) u.deviceToCss = deviceToCss;

    if (wantBelow && tokensMaskRT) {
      if ("tokenSampler" in u) u.tokenSampler = tokensMaskRT;
      if ("hasTokenMask" in u) u.hasTokenMask = 1.0;
    } else {
      if ("tokenSampler" in u) u.tokenSampler = PIXI.Texture.EMPTY;
      if ("hasTokenMask" in u) u.hasTokenMask = 0.0;
    }
  }
}

/**
 * Subtract dynamic token rings from a render texture via DST_OUT.
 * Safe: temporarily flips mesh.blendMode and restores it.
 * @param {PIXI.RenderTexture} outRT
 */
export function subtractDynamicRingsFromRT(outRT) {
  const r = canvas?.app?.renderer;
  if (!r || !outRT) return;
  const M = snappedStageMatrix();
  for (const t of canvas.tokens?.placeables ?? []) {
    if (!t?.visible || t.document?.hidden) continue;
    if (!t?.mesh || !t?.hasDynamicRing) continue;
    const oldBM = t.mesh.blendMode;
    const oldAlph = t.mesh.worldAlpha;
    try {
      t.mesh.blendMode = PIXI.BLEND_MODES.DST_OUT;
      t.mesh.worldAlpha = 1;
      r.render(t.mesh, { renderTexture: outRT, clear: false, transform: M, skipUpdateTransform: false });
    } finally {
      t.mesh.blendMode = oldBM;
      t.mesh.worldAlpha = oldAlph;
    }
  }
}

/**
 * Paint dynamic token rings (normal blend) into a tokens-only RT.
 * @param {PIXI.RenderTexture} outRT
 */
export function paintDynamicRingsInto(outRT) {
  const r = canvas?.app?.renderer;
  if (!r || !outRT) return;
  const M = snappedStageMatrix();
  for (const t of canvas.tokens?.placeables ?? []) {
    if (!t?.visible || t.document?.hidden) continue;
    if (!t?.mesh || !t?.hasDynamicRing) continue;
    const oldBM = t.mesh.blendMode;
    const oldAlph = t.mesh.worldAlpha;
    try {
      t.mesh.blendMode = PIXI.BLEND_MODES.NORMAL;
      t.mesh.worldAlpha = 1;
      r.render(t.mesh, { renderTexture: outRT, clear: false, transform: M, skipUpdateTransform: false });
    } finally {
      t.mesh.blendMode = oldBM;
      t.mesh.worldAlpha = oldAlph;
    }
  }
}
