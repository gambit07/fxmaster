/**
 * FilterEffectsRegionLayer
 * ------------------
 * Applies region-scoped post-processing filters in FXMaster.
 * - Renders a per-region, screen-space (CSS px) alpha mask aligned to the camera.
 * - Attaches configured filter instances to `canvas.environment`, wiring mask uniforms.
 * - Keeps masks and filter areas in sync with camera transforms and viewport changes.
 * - Provides analytic fade info (rect/ellipse) and SDF masks (polygons) to filters that opt-in.
 * - (NEW) Supports below-tokens rendering: when a filter has options.belowTokens=true,
 *   it receives a cutout mask (region mask with token alpha subtracted) so the effect
 *   appears visually beneath tokens.
 */

import { packageId } from "../constants.js";
import { logger } from "../logger.js";
import { isEnabled } from "../settings.js";
import { normalize } from "./filters/mixins/filter.js";

const FILTER_TYPE = `${packageId}.filterEffectsRegion`;

/* ---------------------------- Utilities ---------------------------- */

/**
 * Return the stage world transform with translation snapped to whole pixels.
 * Keeps rasterization stable across frames and matches region mask painting.
 * @returns {PIXI.Matrix} Snapped world transform.
 */
function _snappedStageMatrix() {
  const M = canvas.stage.worldTransform.clone();
  const res = canvas?.app?.renderer?.resolution || 1;
  M.tx = Math.round(M.tx * res) / res;
  M.ty = Math.round(M.ty * res) / res;
  return M;
}

/**
 * Convert a PIXI.Matrix into a 3x3 column-major Float32Array.
 * @param {PIXI.Matrix} M - PIXI 2D affine matrix.
 * @returns {Float32Array} 3x3 homogeneous matrix.
 */
function _mat3FromPixi(M) {
  return new Float32Array([M.a, M.b, 0, M.c, M.d, 0, M.tx, M.ty, 1]);
}

/**
 * Build a world->UV mat3 for a padded world AABB.
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} boundsPadded - Padded world bounds.
 * @returns {Float32Array} 3x3 matrix mapping world to [0..1]x[0..1].
 */
function _uvFromWorldMat3(boundsPadded) {
  const scaleX = 1 / Math.max(1e-6, boundsPadded.maxX - boundsPadded.minX);
  const scaleY = 1 / Math.max(1e-6, boundsPadded.maxY - boundsPadded.minY);
  const tx = -boundsPadded.minX * scaleX;
  const ty = -boundsPadded.minY * scaleY;
  return new Float32Array([scaleX, 0, tx, 0, scaleY, ty, 0, 0, 1]);
}

/**
 * Compute a basic (camera-agnostic) world AABB for region shapes (holes ignored).
 * @param {PlaceableObject} placeable - Region placeable.
 * @returns {{minX:number,minY:number,maxX:number,maxY:number}|null} World bounds or null.
 */
function _regionWorldBounds(placeable) {
  const shapes = placeable?.document?.shapes ?? [];
  if (!shapes.length) return null;
  let minX = Infinity,
    minY = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity;

  const include = (x, y) => {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  };

  for (const s of shapes) {
    if (s.hole) continue;
    if (s.type === "rectangle") {
      include(s.x, s.y);
      include(s.x + s.width, s.y + s.height);
    } else if (s.type === "ellipse") {
      include(s.x - s.radiusX, s.y - s.radiusY);
      include(s.x + s.radiusX, s.y + s.radiusY);
    } else if (Array.isArray(s.points) && s.points.length >= 2) {
      for (let i = 0; i < s.points.length; i += 2) include(s.points[i], s.points[i + 1]);
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * Compute world bounds aligned to mask rasterization:
 * 1) Transform shapes to CSS px via snapped camera matrix.
 * 2) Compute a CSS-space AABB (ignoring holes).
 * 3) Transform that AABB back to world space.
 * @param {PlaceableObject} placeable - Region placeable.
 * @returns {{minX:number,minY:number,maxX:number,maxY:number}|null} Aligned world bounds.
 */
function _regionWorldBoundsAligned(placeable) {
  const shapes = placeable?.document?.shapes ?? [];
  if (!shapes.length) return null;

  const Ms = _snappedStageMatrix();
  const Minv = Ms.clone().invert();

  const toCss = (x, y) => ({ x: Ms.a * x + Ms.c * y + Ms.tx, y: Ms.b * x + Ms.d * y + Ms.ty });
  const toWorld = (x, y) => ({ x: Minv.a * x + Minv.c * y + Minv.tx, y: Minv.b * x + Minv.d * y + Minv.ty });

  let cssMinX = Infinity,
    cssMinY = Infinity;
  let cssMaxX = -Infinity,
    cssMaxY = -Infinity;

  const scaleX = Math.hypot(Ms.a, Ms.b);
  const scaleY = Math.hypot(Ms.c, Ms.d);
  const ellipseSteps = (rx, ry) => {
    const rxS = Math.max(1, rx * scaleX);
    const ryS = Math.max(1, ry * scaleY);
    const p = Math.PI * (3.0 * (rxS + ryS) - Math.sqrt((3.0 * rxS + ryS) * (rxS + 3.0 * ryS)));
    return Math.ceil(Math.max(64, Math.min(512, p / 2.0)));
  };

  const includeCssPoint = (X, Y) => {
    cssMinX = Math.min(cssMinX, X);
    cssMaxX = Math.max(cssMaxX, X);
    cssMinY = Math.min(cssMinY, Y);
    cssMaxY = Math.max(cssMaxY, Y);
  };

  for (const s of shapes) {
    if (s.hole) continue;
    if (s.type === "rectangle") {
      const p0 = toCss(s.x, s.y);
      const p1 = toCss(s.x + s.width, s.y);
      const p2 = toCss(s.x + s.width, s.y + s.height);
      const p3 = toCss(s.x, s.y + s.height);
      includeCssPoint(p0.x, p0.y);
      includeCssPoint(p1.x, p1.y);
      includeCssPoint(p2.x, p2.y);
      includeCssPoint(p3.x, p3.y);
    } else if (s.type === "ellipse") {
      const steps = ellipseSteps(s.radiusX, s.radiusY);
      for (let i = 0; i < steps; i++) {
        const t = (i / steps) * Math.PI * 2;
        const ex = s.x + s.radiusX * Math.cos(t);
        const ey = s.y + s.radiusY * Math.sin(t);
        const p = toCss(ex, ey);
        includeCssPoint(p.x, p.y);
      }
    } else if (Array.isArray(s.points) && s.points.length >= 6) {
      for (let i = 0; i < s.points.length; i += 2) {
        const p = toCss(s.points[i], s.points[i + 1]);
        includeCssPoint(p.x, p.y);
      }
    }
  }

  if (!Number.isFinite(cssMinX)) return null;

  const wTL = toWorld(cssMinX, cssMinY);
  const wTR = toWorld(cssMaxX, cssMinY);
  const wBR = toWorld(cssMaxX, cssMaxY);
  const wBL = toWorld(cssMinX, cssMaxY);

  const minX = Math.min(wTL.x, wTR.x, wBR.x, wBL.x);
  const maxX = Math.max(wTL.x, wTR.x, wBR.x, wBL.x);
  const minY = Math.min(wTL.y, wTR.y, wBR.y, wBL.y);
  const maxY = Math.max(wTL.y, wTR.y, wBR.y, wBL.y);

  const EPS = 1e-3;
  return { minX: minX + EPS, minY: minY + EPS, maxX: maxX - EPS, maxY: maxY - EPS };
}

/* ----------------------- CPU SDF (polygon) ------------------------ */

/**
 * Build a geometry key string for caching (stable across camera moves).
 * @param {Array} shapes - Region shape objects.
 * @returns {string} Stable key.
 */
function _geomKeyFromShapes(shapes) {
  const parts = [];
  for (const s of shapes) {
    parts.push(s.type, s.hole ? 1 : 0);
    if (s.type === "rectangle") parts.push(s.x, s.y, s.width, s.height);
    else if (s.type === "ellipse") parts.push(s.x, s.y, s.radiusX, s.radiusY);
    else if (Array.isArray(s.points)) parts.push(...s.points);
  }
  return parts.join(",");
}

/**
 * Choose SDF padding in world units based on region size (clamped).
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} bounds - World bounds.
 * @returns {number} Padding in world units.
 */
function _chooseSdfPaddingWorld(bounds) {
  const w = Math.max(0, bounds.maxX - bounds.minX);
  const h = Math.max(0, bounds.maxY - bounds.minY);
  const diag = Math.hypot(w, h);
  return Math.min(Math.max(diag * 0.05, 16), 256);
}

/**
 * Choose SDF world-per-texel to target a max texture edge (512..1024).
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} boundsPadded - Padded bounds.
 * @param {number} [maxEdge=768] - Target edge length in texels.
 * @param {number} [maxTex=1024] - Hard cap for texture edge.
 * @returns {number} World units per texel.
 */
function _chooseWorldPerTexel(boundsPadded, maxEdge = 768, maxTex = 1024) {
  const wW = Math.max(1e-6, boundsPadded.maxX - boundsPadded.minX);
  const hW = Math.max(1e-6, boundsPadded.maxY - boundsPadded.minY);
  const target = Math.min(maxEdge, maxTex);
  const pxPerWorld = target / Math.max(wW, hW);
  const worldPerTexel = 1 / Math.max(1, pxPerWorld);
  return worldPerTexel;
}

/**
 * Exact squared Euclidean distance transform in 1D (Felzenszwalb & Huttenlocher).
 * @param {Float64Array|Float32Array|number[]} f - Input costs.
 * @param {number} n - Length.
 * @returns {Float64Array} Squared distances.
 */
function _edt1d(f, n) {
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const d = new Float64Array(n);
  let k = 0;
  v[0] = 0;
  z[0] = Number.NEGATIVE_INFINITY;
  z[1] = Number.POSITIVE_INFINITY;

  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Number.POSITIVE_INFINITY;
  }

  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const val = q - v[k];
    d[q] = val * val + f[v[k]];
  }
  return d;
}

/**
 * 2D EDT: input f = 0 at feature pixels, +INF elsewhere; returns Float32 distances (sqrt).
 * @param {Float64Array|Float32Array|number[]} f - Input as row-major 2D image.
 * @param {number} width - Image width.
 * @param {number} height - Image height.
 * @returns {Float32Array} Distances in pixels (texels).
 */
function _edt2d(f, width, height) {
  const INF = 1e20;
  const Dcol = new Float64Array(width * height);
  const g = new Float64Array(height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) g[y] = f[y * width + x];
    const d = _edt1d(g, height);
    for (let y = 0; y < height; y++) Dcol[y * width + x] = d[y];
  }
  const out = new Float32Array(width * height);
  const hrow = new Float64Array(width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) hrow[x] = Dcol[y * width + x];
    const d = _edt1d(hrow, width);
    for (let x = 0; x < width; x++) {
      const v = d[x];
      out[y * width + x] = v >= INF / 2 ? 1e6 : Math.sqrt(Math.max(0, v));
    }
  }
  return out;
}

/**
 * Rasterize region shapes into a binary grid (inside=1, outside=0).
 * Uses a 2D Canvas with even-odd fill in world->texture mapping space.
 * @param {PlaceableObject} region - Region placeable.
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} boundsPadded - Padded world bounds.
 * @param {number} worldPerTexel - World units per texel.
 * @returns {{insideMask:Uint8Array,width:number,height:number}} Binary mask and size.
 */
function _rasterizeRegionToBinary(region, boundsPadded, worldPerTexel) {
  const wW = Math.max(1e-6, boundsPadded.maxX - boundsPadded.minX);
  const hW = Math.max(1e-6, boundsPadded.maxY - boundsPadded.minY);
  let W = Math.max(1, Math.round(wW / worldPerTexel));
  let H = Math.max(1, Math.round(hW / worldPerTexel));
  const MAX_TEX = 2048;
  const scaleClamp = Math.max(W / MAX_TEX, H / MAX_TEX, 1);
  if (scaleClamp > 1) {
    W = Math.max(1, Math.round(W / scaleClamp));
    H = Math.max(1, Math.round(H / scaleClamp));
  }

  const scaleX = W / wW;
  const scaleY = H / hW;
  const offX = -boundsPadded.minX * scaleX;
  const offY = -boundsPadded.minY * scaleY;

  let cnv, ctx;
  try {
    cnv = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(W, H) : document.createElement("canvas");
    if (!(cnv instanceof OffscreenCanvas)) (cnv.width = W), (cnv.height = H);
    ctx = cnv.getContext("2d", { willReadFrequently: true });
  } catch {
    const c2 = document.createElement("canvas");
    c2.width = W;
    c2.height = H;
    ctx = c2.getContext("2d", { willReadFrequently: true });
    cnv = c2;
  }

  ctx.save();
  ctx.setTransform(scaleX, 0, 0, scaleY, offX, offY);
  ctx.imageSmoothingEnabled = false;
  ctx.beginPath();

  const shapes = region.document.shapes ?? [];
  for (const s of shapes) {
    if (!s) continue;
    if (s.type === "rectangle") {
      ctx.rect(s.x, s.y, s.width, s.height);
    } else if (s.type === "ellipse") {
      ctx.ellipse(s.x, s.y, s.radiusX, s.radiusY, 0, 0, Math.PI * 2);
    } else if (Array.isArray(s.points) && s.points.length >= 6) {
      ctx.moveTo(s.points[0], s.points[1]);
      for (let i = 2; i < s.points.length; i += 2) ctx.lineTo(s.points[i], s.points[i + 1]);
      ctx.closePath();
    }
  }
  ctx.fillStyle = "#ffffff";
  try {
    ctx.fill("evenodd");
  } catch {
    ctx.fill();
  }
  ctx.restore();

  const img = ctx.getImageData(0, 0, W, H).data;
  const inside = new Uint8Array(W * H);
  for (let i = 0, p = 3; i < inside.length; i++, p += 4) inside[i] = img[p] > 0 ? 1 : 0;

  return { insideMask: inside, width: W, height: H };
}

/**
 * Build SDF for a polygonal region (packed into an RGBA8 texture).
 * Also returns uniforms for mapping world->UV and SDF scaling.
 * @param {PlaceableObject} region - Region placeable.
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} bounds - World bounds.
 * @param {number} [paddingWorldOptional] - Optional padding override (world units).
 * @returns {{
 *  texture: PIXI.Texture, uUvFromWorld: Float32Array, uSdfScaleOff: Float32Array,
 *  uSdfTexel: Float32Array, paddedBounds: object, insideMax: number
 * }} SDF texture and metadata.
 */
function _buildPolygonSDF(region, bounds, paddingWorldOptional) {
  const padW = paddingWorldOptional ?? _chooseSdfPaddingWorld(bounds);
  const padded = {
    minX: bounds.minX - padW,
    minY: bounds.minY - padW,
    maxX: bounds.maxX + padW,
    maxY: bounds.maxY + padW,
  };

  const worldPerTexel = _chooseWorldPerTexel(padded);
  const { insideMask, width, height } = _rasterizeRegionToBinary(region, padded, worldPerTexel);

  const INF = 1e20;
  const fInside = new Float64Array(width * height);
  const fOutside = new Float64Array(width * height);
  for (let i = 0; i < insideMask.length; i++) {
    fInside[i] = insideMask[i] ? 0 : INF;
    fOutside[i] = insideMask[i] ? INF : 0;
  }

  const distToInsideT = _edt2d(fInside, width, height);
  const distToOutsideT = _edt2d(fOutside, width, height);

  // Separable 3x3 max for a 1-texel dilation - inside only.
  const rad = 1;
  const W = width,
    H = height;
  const tmp = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      if (!insideMask[row + x]) {
        tmp[row + x] = distToOutsideT[row + x];
        continue;
      }
      let m = 0;
      for (let k = -rad; k <= rad; k++) {
        const xx = Math.min(W - 1, Math.max(0, x + k));
        m = Math.max(m, distToOutsideT[row + xx]);
      }
      tmp[row + x] = m;
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      if (!insideMask[idx]) continue;
      let m = 0;
      for (let k = -rad; k <= rad; k++) {
        const yy = Math.min(H - 1, Math.max(0, y + k));
        m = Math.max(m, tmp[yy * W + x]);
      }
      distToOutsideT[idx] = m;
    }
  }

  const sdf = new Float32Array(W * H);
  let maxAbs = 0;
  let maxInside = 0;
  for (let i = 0; i < sdf.length; i++) {
    const dInWorld = distToInsideT[i] * worldPerTexel;
    const dOutWorld = distToOutsideT[i] * worldPerTexel;
    const val = insideMask[i] ? -dOutWorld : dInWorld;
    sdf[i] = val;
    if (insideMask[i] && dOutWorld > maxInside) maxInside = dOutWorld;
    const a = Math.abs(val);
    if (a > maxAbs) maxAbs = a;
  }
  const range = Math.max(maxAbs, 1);

  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0, j = 0; i < sdf.length; i++, j += 4) {
    const n = Math.min(1, Math.max(0, 0.5 + 0.5 * (sdf[i] / range)));
    const b = Math.round(n * 255);
    rgba[j] = b;
    rgba[j + 1] = b;
    rgba[j + 2] = b;
    rgba[j + 3] = 255;
  }

  const tex = PIXI.Texture.fromBuffer(rgba, W, H);
  try {
    tex.baseTexture.wrapMode = PIXI.WRAP_MODES.CLAMP;
    tex.baseTexture.scaleMode = PIXI.SCALE_MODES.NEAREST;
    tex.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
  } catch {}

  const uUvFromWorld = _uvFromWorldMat3(padded);
  const uSdfScaleOff = new Float32Array([2 * range, -range]);
  const uSdfTexel = new Float32Array([1 / Math.max(1, W), 1 / Math.max(1, H)]);

  return {
    texture: tex,
    uUvFromWorld,
    uSdfScaleOff,
    uSdfTexel,
    paddedBounds: padded,
    insideMax: maxInside,
  };
}

/**
 * Determine if any enabled region filter needs a polygon SDF (fadePercent > 0).
 * @param {PlaceableObject} placeable - Region placeable.
 * @param {Array} behaviors - Enabled filter behaviors on the region.
 * @returns {boolean} True if SDF is needed for polygon fades.
 */
function _regionNeedsPolygonSDF(placeable, behaviors) {
  for (const b of behaviors) {
    const defs = b.getFlag(packageId, "filters");
    if (!defs) continue;
    for (const [, info] of Object.entries(defs)) {
      const fp = info?.options?.fadePercent;
      if (fp !== undefined && fp !== null && `${fp}`.trim() !== "" && Number(fp) > 0) return true;
    }
  }
  return false;
}

/**
 * Analyze whether the region is a single analytic shape (rect or ellipse).
 * If so, return parameters to drive an analytic fade path.
 * @param {PlaceableObject} placeable - Region placeable.
 * @returns {{mode:1|2,center:{x:number,y:number},half:{x:number,y:number},rotation:number}|null}
 */
function _analyzeAnalyticShape(placeable) {
  const shapes = (placeable?.document?.shapes ?? []).filter((s) => !s.hole);
  if (shapes.length !== 1) return null;
  const s = shapes[0];
  if (s.type === "rectangle") {
    const center = { x: s.x + s.width * 0.5, y: s.y + s.height * 0.5 };
    const half = { x: Math.abs(s.width) * 0.5, y: Math.abs(s.height) * 0.5 };
    const rotation = 0;
    return { mode: 1, center, half, rotation };
  }
  if (s.type === "ellipse") {
    const center = { x: s.x, y: s.y };
    const half = { x: Math.abs(s.radiusX), y: Math.abs(s.radiusY) };
    const rotation = 0;
    return { mode: 2, center, half, rotation };
  }
  return null;
}

/**
 * Build an edge list (Ax,Ay,Bx,By repeated) from polygon shapes in world units.
 * Rectangles and ellipses are ignored (handled analytically).
 * @param {PlaceableObject} placeable - Region placeable.
 * @returns {Float32Array} Packed edge endpoints.
 */
function _buildPolygonEdges(placeable) {
  const edges = [];
  const shapes = placeable?.document?.shapes ?? [];
  for (const s of shapes) {
    if (s.type !== "polygon" || !Array.isArray(s.points) || s.points.length < 4) continue;
    const pts = s.points;
    const n = (pts.length / 2) | 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = pts[2 * i],
        ay = pts[2 * i + 1];
      const bx = pts[2 * j],
        by = pts[2 * j + 1];
      edges.push(ax, ay, bx, by);
    }
  }
  return new Float32Array(edges);
}

/* -------------------- Tokens → cutout helpers (NEW) -------------------- */

/** Collect token sprites in world space to erase them from a CSS-space mask. */
function _collectTokenAlphaSprites() {
  const sprites = [];
  for (const t of canvas.tokens?.placeables ?? []) {
    if (!t.visible || t.document.hidden) continue;
    const icon = t.icon ?? t.mesh ?? t;
    const tex = icon?.texture;
    const wt = icon?.worldTransform;
    if (!tex?.baseTexture?.valid || !wt) continue;

    const spr = new PIXI.Sprite(tex);
    try {
      spr.anchor.set(icon.anchor?.x ?? 0.5, icon.anchor?.y ?? 0.5);
    } catch {}
    try {
      spr.transform.setFromMatrix(wt);
    } catch {
      try {
        spr.destroy(true);
      } catch {}
      continue;
    }
    sprites.push(spr);
  }
  return sprites;
}

/**
 * Compose a cutout mask from a base RT by erasing token silhouettes (DST_OUT).
 * The input and output are both CSS-space render textures.
 * @param {PIXI.RenderTexture} baseRT
 * @returns {PIXI.RenderTexture}
 */
function _composeMaskMinusTokens(baseRT, outRT) {
  const r = canvas?.app?.renderer;
  if (!r || !baseRT) return baseRT;

  const out =
    outRT ??
    PIXI.RenderTexture.create({
      width: baseRT.width | 0,
      height: baseRT.height | 0,
      resolution: baseRT.resolution || 1,
    });

  r.render(new PIXI.Sprite(baseRT), { renderTexture: out, clear: true });

  const cont = new PIXI.Container();
  for (const s of _collectTokenAlphaSprites()) {
    s.blendMode = PIXI.BLEND_MODES.DST_OUT;
    cont.addChild(s);
  }
  if (cont.children.length) r.render(cont, { renderTexture: out, clear: false });
  try {
    cont.destroy({ children: true, texture: false, baseTexture: false });
  } catch {}

  return out;
}

/* -------------------------- Layer class ---------------------------- */

export class FilterEffectsRegionLayer extends CONFIG.fxmaster.FullCanvasObjectMixinNS(CONFIG.fxmaster.CanvasLayerNS) {
  /**
   * Construct a new FilterEffectsRegionLayer.
   * Initializes caches, pooling, and per-frame watcher state.
   */
  constructor() {
    super();
    this.regionMasks = new Map();
    this.sortableChildren = true;
    this.eventMode = "none";
    this._ticker = false;
    this._lastRegionsMatrix = null;
    this._rtPool = new Map();
    this._scratchGfx = null;
    this._trailing = null;
    this._sdfCache = new Map();
    this._gatePassCache = new Map();
    this._tearingDown = false;

    try {
      canvas.app.renderer.roundPixels = false;
    } catch {}
  }

  /**
   * Draw existing region filters, align filter areas, start the watcher, and trigger an initial refresh.
   * @returns {Promise<void>}
   * @protected
   */
  async _draw() {
    if (!isEnabled()) return;

    for (const region of canvas.regions.placeables) {
      await this.drawRegionFilterEffects(region, { soft: true });
    }

    this._refreshEnvFilterArea();

    if (!this._ticker) {
      const PRIO = PIXI.UPDATE_PRIORITY?.HIGH ?? 25;
      try {
        canvas.app.ticker.add(this.#animate, this, PRIO);
      } catch {
        canvas.app.ticker.add(this.#animate, this);
      }
      this._ticker = true;
    }

    this._waitForStableViewThenRefresh();
  }

  /**
   * Tear down the layer: stop watcher, destroy region entries, cached SDFs, and RT pool.
   * @returns {Promise<void>}
   * @protected
   */
  async _tearDown() {
    this._tearingDown = true;
    if (this._ticker) {
      try {
        canvas.app.ticker.remove(this.#animate, this);
      } catch {}
      this._ticker = false;
    }
    this._lastRegionsMatrix = null;

    if (this._trailing) {
      try {
        cancelAnimationFrame(this._trailing);
      } catch {}
      this._trailing = null;
    }

    this._destroyRegionMasks();

    try {
      for (const e of this._sdfCache.values()) {
        try {
          e.texture?.destroy(true);
        } catch {}
      }
    } finally {
      this._sdfCache.clear();
    }

    try {
      this._scratchGfx?.destroy(true);
    } catch {}
    this._scratchGfx = null;

    this._drainRtPool();

    const res = await super._tearDown();
    this._tearingDown = false;
    return res;
  }

  /**
   * Build and attach filters for a single region placeable.
   * Creates a CSS-space alpha mask RT and configures filter uniforms and resolution.
   * Wires analytic/SDF uniforms so filters can implement fade effects.
   * (NEW) Routes belowTokens filters to a cutout (mask minus tokens) RT.
   * @param {PlaceableObject} placeable - Region.
   * @param {{soft?:boolean}} [opts] - Options; soft=true skips strong fades.
   * @returns {Promise<void>}
   */
  async drawRegionFilterEffects(placeable, { soft = false } = {}) {
    const regionId = placeable.id;
    this._destroyRegionMasks(regionId);

    const behaviors = placeable.document.behaviors.filter((b) => b.type === FILTER_TYPE && !b.disabled);
    if (!behaviors.length) return;

    const r = canvas.app.renderer;
    const screen = r.screen;

    const maskRT = this._buildRegionMaskRT(placeable);
    try {
      maskRT.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
      maskRT.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
    } catch {}

    let anyWantsBelow = false;

    const appliedFilters = [];

    const gl = r.gl;
    const MAX_GL = gl?.getParameter?.(gl.MAX_TEXTURE_SIZE) || 8192;
    const devW = Math.max(1, r.view.width | 0);
    const devH = Math.max(1, r.view.height | 0);
    const capScale = Math.min(1, MAX_GL / Math.max(devW, devH));

    const rbAligned = _regionWorldBoundsAligned(placeable);

    const Ms = _snappedStageMatrix();
    const cssToWorld = Ms.clone().invert();
    const cssToWorldMat3 = _mat3FromPixi(cssToWorld);

    const analytic = _analyzeAnalyticShape(placeable);
    const needsSdf = !analytic && _regionNeedsPolygonSDF(placeable, behaviors);

    const worldPerCss = 0.5 * (Math.hypot(cssToWorld.a, cssToWorld.b) + Math.hypot(cssToWorld.c, cssToWorld.d));

    const MAX_EDGES = 64;
    const builtEdges = _buildPolygonEdges(placeable);
    const edgeCount = Math.min(builtEdges.length / 4, MAX_EDGES);
    const uEdgesArray = new Float32Array(MAX_EDGES * 4);
    if (edgeCount > 0) uEdgesArray.set(builtEdges.slice(0, edgeCount * 4));

    let fadeMeta = {
      mode: analytic ? analytic.mode : needsSdf ? 0 : -1,
      cssToWorldMat3,
      center: null,
      half: null,
      rotation: 0,
      sdfTex: null,
      uUvFromWorld: null,
      uSdfScaleOff: null,
      uSdfTexel: null,
      uSdfInsideMax: 0,
      uEdgesArray,
      edgeCount,
      uSmoothKWorld: Math.max(2.0 * worldPerCss, 1e-6),
    };

    if (analytic) {
      fadeMeta.center = new Float32Array([analytic.center.x, analytic.center.y]);
      fadeMeta.half = new Float32Array([analytic.half.x, analytic.half.y]);
      fadeMeta.rotation = analytic.rotation || 0;
    } else if (needsSdf) {
      const shapes = placeable?.document?.shapes ?? [];
      const geomKey = _geomKeyFromShapes(shapes);
      let cacheEntry = this._sdfCache.get(regionId);
      const worldBounds = _regionWorldBounds(placeable);
      if (!cacheEntry || cacheEntry.geomKey !== geomKey) {
        try {
          cacheEntry?.texture?.destroy(true);
        } catch {}
        const built = _buildPolygonSDF(placeable, worldBounds);
        cacheEntry = {
          geomKey,
          texture: built.texture,
          uUvFromWorld: built.uUvFromWorld,
          uSdfScaleOff: built.uSdfScaleOff,
          uSdfTexel: built.uSdfTexel,
          uSdfInsideMax: built.insideMax,
        };
        this._sdfCache.set(regionId, cacheEntry);
      }
      fadeMeta.sdfTex = cacheEntry.texture;
      fadeMeta.uUvFromWorld = cacheEntry.uUvFromWorld;
      fadeMeta.uSdfScaleOff = cacheEntry.uSdfScaleOff;
      fadeMeta.uSdfInsideMax = cacheEntry.uSdfInsideMax;

      const bt = cacheEntry.texture?.baseTexture;
      const w = Math.max(1, bt?.width | 0);
      const h = Math.max(1, bt?.height | 0);
      fadeMeta.uSdfTexel = new Float32Array([1 / w, 1 / h]);
    }

    for (const behavior of behaviors) {
      const filterDefs = behavior.getFlag(packageId, "filters");
      if (!filterDefs || Object.keys(filterDefs).length === 0) continue;
      for (const [, { options: rawOptions }] of Object.entries(filterDefs)) {
        if (rawOptions?.belowTokens) {
          anyWantsBelow = true;
          break;
        }
      }
      if (anyWantsBelow) break;
    }

    let maskCutoutRT = null;
    if (anyWantsBelow) {
      const w = maskRT.width | 0,
        h = maskRT.height | 0,
        res = maskRT.resolution || 1;
      maskCutoutRT = this._acquireRT(w, h, res);
      _composeMaskMinusTokens(maskRT, maskCutoutRT);
      try {
        maskCutoutRT.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
        maskCutoutRT.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
      } catch {}
    }

    for (const behavior of behaviors) {
      const filterDefs = behavior.getFlag(packageId, "filters");
      if (!filterDefs || Object.keys(filterDefs).length === 0) continue;

      for (const [id, { type, options: rawOptions }] of Object.entries(filterDefs)) {
        const FilterClass = CONFIG.fxmaster.filterEffects[type];
        if (!FilterClass) {
          logger.warn(game.i18n.format("FXMASTER.Filters.TypeErrors.TypeUnknown", { id, type }));
          continue;
        }

        const options = normalize(rawOptions ?? {});
        const filter = new FilterClass(options, id);

        const wantBelow = !!options?.belowTokens;

        if (filter.uniforms) {
          const u = filter.uniforms;
          u.maskSampler = wantBelow && maskCutoutRT ? maskCutoutRT : maskRT;
          u.hasMask = 1.0;
          u.viewSize = new Float32Array([Math.max(1, screen.width | 0), Math.max(1, screen.height | 0)]);
          u.maskReady = 1.0;
          u.deviceToCss = 1 / (r.resolution || window.devicePixelRatio || 1);

          u.uCssToWorld = cssToWorldMat3;
          u.uRegionShape = fadeMeta.mode;

          if (fadeMeta.mode === 0) {
            if (fadeMeta.sdfTex) {
              u.uSdf = fadeMeta.sdfTex;
              u.uUvFromWorld = fadeMeta.uUvFromWorld;
              u.uSdfScaleOff = fadeMeta.uSdfScaleOff;
              u.uSdfTexel = fadeMeta.uSdfTexel;
            }
            u.uSdfInsideMax = fadeMeta.uSdfInsideMax;

            u.uEdges = uEdgesArray;
            u.uEdgeCount = edgeCount;
            u.uSmoothKWorld = fadeMeta.uSmoothKWorld;
          } else if (fadeMeta.mode === 1 || fadeMeta.mode === 2) {
            u.uCenter = fadeMeta.center;
            u.uHalfSize = fadeMeta.half;
            u.uRotation = fadeMeta.rotation || 0.0;
          }

          filter.__fxmBaseStrength = typeof u.strength === "number" ? u.strength : undefined;
        }

        try {
          filter.filterArea = new PIXI.Rectangle(0, 0, screen.width | 0, screen.height | 0);
        } catch {}
        filter.autoFit = false;
        filter.padding = 0;
        filter.resolution = (r.resolution || 1) * capScale;

        if (rbAligned && typeof filter.configure === "function") {
          filter.configure({
            regionMinX: rbAligned.minX,
            regionMinY: rbAligned.minY,
            regionMaxX: rbAligned.maxX,
            regionMaxY: rbAligned.maxY,
          });
        }

        try {
          filter.play({ ...(rawOptions ?? {}), skipFading: !!soft });
        } catch {
          try {
            filter.enabled = true;
          } catch {}
        }

        appliedFilters.push(filter);
      }
    }

    if (appliedFilters.length > 0) {
      canvas.environment.filters = [...(canvas.environment.filters ?? []), ...appliedFilters];
      this.regionMasks.set(regionId, { filters: appliedFilters, maskRT, maskCutoutRT });
      this._applyElevationGate(placeable);
      this._refreshEnvFilterArea();
    } else {
      this._releaseRT(maskRT);
      if (maskCutoutRT) this._releaseRT(maskCutoutRT);
    }
  }

  /**
   * Repaint masks for all regions in-place and update filter areas.
   * Call when camera matrix changes or shapes update.
   */
  forceRegionMaskRefreshAll() {
    for (const region of canvas.regions.placeables) {
      if (this.regionMasks.has(region.id)) this._rebuildRegionMaskFor(region);
    }
    this._refreshEnvFilterArea();
  }

  /**
   * Repaint a single region’s mask and update filter areas.
   * @param {string} regionId - Region id.
   */
  forceRegionMaskRefresh(regionId) {
    const region = canvas.regions?.get(regionId);
    if (region && this.regionMasks.has(regionId)) this._rebuildRegionMaskFor(region);
    this._refreshEnvFilterArea();
  }

  /**
   * Immediate refresh of all masks followed by a trailing, coalesced call via RAF.
   * Helps avoid redundant work during rapid viewport changes.
   */
  requestRegionMaskRefreshAll() {
    if (this._trailing) return;
    this._trailing = requestAnimationFrame(() => {
      this._trailing = null;
      this.forceRegionMaskRefreshAll();
    });
  }

  requestRegionMaskRefresh(regionId) {
    if (this._trailing) return;
    this._trailing = requestAnimationFrame(() => {
      this._trailing = null;
      this.forceRegionMaskRefresh(regionId);
    });
  }

  /**
   * Remove a region’s filters and release its mask RT.
   * @param {string} regionId - Region id.
   */
  destroyRegionFilterEffects(regionId) {
    this._destroyRegionMasks(regionId);
  }

  /**
   * Keep environment and per-filter areas aligned to the current screen size.
   * Called after mask rebuilds and viewport changes.
   */
  _refreshEnvFilterArea() {
    if (this.regionMasks.size === 0) return;

    const env = canvas.environment;
    const r = canvas.app.renderer;
    if (!env || !r) return;

    const screen = r.screen;
    const sw = Math.max(1, screen.width | 0);
    const sh = Math.max(1, screen.height | 0);

    const hasSceneMask = !!(env.mask && env.mask.name === "fxmaster:iface-mask-gfx");

    if (!hasSceneMask) {
      const fa = env.filterArea instanceof PIXI.Rectangle ? env.filterArea : new PIXI.Rectangle(0, 0, sw, sh);

      fa.x = 0;
      fa.y = 0;
      if (fa.width !== sw || fa.height !== sh) {
        fa.width = sw;
        fa.height = sh;
      }
      try {
        env.filterArea = fa;
      } catch {}
    }

    for (const entry of this.regionMasks.values()) {
      for (const f of entry.filters) {
        if (f.filterArea instanceof PIXI.Rectangle) {
          const fa = f.filterArea;
          if (fa.x !== 0) fa.x = 0;
          if (fa.y !== 0) fa.y = 0;
          if (fa.width !== sw || fa.height !== sh) {
            fa.width = sw;
            fa.height = sh;
          }
        } else {
          try {
            f.filterArea = new PIXI.Rectangle(0, 0, sw, sh);
          } catch {}
        }
        f.autoFit = false;
        f.padding = 0;
      }
    }
  }

  /**
   * Compute a pool key for a render texture.
   * @param {number} w - Width (CSS px).
   * @param {number} h - Height (CSS px).
   * @param {number} res - Resolution (device px per CSS px).
   * @returns {string} Pool key.
   */
  _rtKey(w, h, res) {
    return `${w}x${h}@${res}`;
  }

  /**
   * Acquire a RenderTexture from the pool or create one if none are available.
   * @param {number} w - Width.
   * @param {number} h - Height.
   * @param {number} res - Resolution.
   * @returns {PIXI.RenderTexture} Render texture.
   */
  _acquireRT(w, h, res) {
    const key = this._rtKey(w, h, res);
    const list = this._rtPool.get(key) || [];
    const rt = list.pop();
    if (list.length) this._rtPool.set(key, list);
    else this._rtPool.delete(key);
    if (rt) return rt;

    return PIXI.RenderTexture.create({
      width: w,
      height: h,
      resolution: res,
    });
  }

  /**
   * Return a RenderTexture to the pool or destroy it if pooling fails.
   * @param {PIXI.RenderTexture} rt - Render texture.
   */
  _releaseRT(rt) {
    try {
      const w = rt.width | 0,
        h = rt.height | 0,
        res = rt.resolution || 1;
      const key = this._rtKey(w, h, res);
      const list = this._rtPool.get(key) || [];
      list.push(rt);
      this._rtPool.set(key, list);
      const MAX_PER_KEY = 8; // safe default: one or two regions & a couple of alternates
      while (list.length > MAX_PER_KEY) {
        const old = list.shift();
        try {
          old.destroy(true);
        } catch {}
      }
    } catch {
      try {
        rt.destroy(true);
      } catch {}
    }
  }

  /**
   * Destroy all pooled RenderTextures and clear the pool.
   */
  _drainRtPool() {
    try {
      for (const list of this._rtPool.values()) {
        for (const rt of list) {
          try {
            rt.destroy(true);
          } catch {}
        }
      }
    } finally {
      this._rtPool.clear();
    }
  }

  /**
   * Remove and destroy region entries (all or one), releasing their RTs and SDFs.
   * @param {string} [regionId] - Optional region id to remove; removes all if omitted.
   */
  _destroyRegionMasks(regionId) {
    const removeFromTarget = (filtersToRemove = []) => {
      const target = canvas.environment;
      if (!target?.filters?.length) return;
      target.filters = target.filters.filter((f) => !filtersToRemove.includes(f));
    };

    if (regionId) {
      const entry = this.regionMasks.get(regionId);
      if (entry) {
        removeFromTarget(entry.filters);
        for (const f of entry.filters) f.destroy?.();
        this._releaseRT(entry.maskRT);
        if (entry.maskCutoutRT) this._releaseRT(entry.maskCutoutRT);
        this.regionMasks.delete(regionId);
      }
      const sdf = this._sdfCache.get(regionId);
      if (sdf) {
        try {
          sdf.texture?.destroy(true);
        } catch {}
        this._sdfCache.delete(regionId);
      }

      try {
        this._gatePassCache.delete(regionId);
      } catch {}
    } else {
      for (const entry of this.regionMasks.values()) {
        removeFromTarget(entry.filters);
        for (const f of entry.filters) f.destroy?.();
        this._releaseRT(entry.maskRT);
        if (entry.maskCutoutRT) this._releaseRT(entry.maskCutoutRT);
      }
      this.regionMasks.clear();
      for (const e of this._sdfCache.values()) {
        try {
          e.texture?.destroy(true);
        } catch {}
      }
      this._sdfCache.clear();

      this._gatePassCache.clear();
    }
  }

  /**
   * Build a screen-space alpha mask RenderTexture for a region.
   * Draws shapes in CSS px via the snapped camera matrix (holes respected).
   * @param {PlaceableObject} region - Region placeable.
   * @returns {PIXI.RenderTexture} Render texture mask.
   */
  _buildRegionMaskRT(region) {
    const r = canvas.app.renderer;
    const screen = r.screen;

    const VW = Math.max(1, screen.width | 0);
    const VH = Math.max(1, screen.height | 0);
    const gl = r.gl;
    const MAX_GL = gl?.getParameter?.(gl.MAX_TEXTURE_SIZE) || 8192;
    let res = r.resolution || 1;
    const maxResW = MAX_GL / VW,
      maxResH = MAX_GL / VH;
    res = Math.min(res, maxResW, maxResH);

    const gfx = this._scratchGfx ?? (this._scratchGfx = new PIXI.Graphics());
    gfx.clear();
    gfx.transform.setFromMatrix(PIXI.Matrix.IDENTITY);
    gfx.roundPixels = false;

    const Ms = _snappedStageMatrix();

    const T = (x, y) => {
      const X = Ms.a * x + Ms.c * y + Ms.tx;
      const Y = Ms.b * x + Ms.d * y + Ms.ty;
      return [X, Y];
    };

    const scaleX = Math.hypot(Ms.a, Ms.b);
    const scaleY = Math.hypot(Ms.c, Ms.d);
    const ellipseSteps = (rx, ry) => {
      const rxS = Math.max(1, rx * scaleX);
      const ryS = Math.max(1, ry * scaleY);
      const p = Math.PI * (3.0 * (rxS + ryS) - Math.sqrt((3.0 * rxS + ryS) * (rxS + 3.0 * ryS)));
      const steps = Math.ceil(Math.max(64, Math.min(512, p / 2.0)));
      return steps;
    };

    gfx.beginFill(0xffffff, 1.0);
    for (const s of region.document.shapes) {
      const drawPoly = (pts) => {
        if (!Array.isArray(pts) || pts.length < 6) return;
        const out = new Array(pts.length);
        for (let i = 0; i < pts.length; i += 2) {
          const [X, Y] = T(pts[i], pts[i + 1]);
          out[i] = X;
          out[i + 1] = Y;
        }
        gfx.drawShape(new PIXI.Polygon(out));
      };
      const drawRect = (x, y, w, h) => {
        const p0 = T(x, y),
          p1 = T(x + w, y);
        const p2 = T(x + w, y + h),
          p3 = T(x, y + h);
        gfx.drawShape(new PIXI.Polygon([p0[0], p0[1], p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]]));
      };
      const drawEllipse = (cx, cy, rx, ry) => {
        const steps = ellipseSteps(rx, ry);
        const poly = [];
        for (let i = 0; i < steps; i++) {
          const t = (i / steps) * 2.0 * Math.PI;
          const [X, Y] = T(cx + rx * Math.cos(t), cy + ry * Math.sin(t));
          poly.push(X, Y);
        }
        gfx.drawShape(new PIXI.Polygon(poly));
      };
      const draw = () => {
        switch (s.type) {
          case "polygon":
            drawPoly(s.points);
            break;
          case "ellipse":
            drawEllipse(s.x, s.y, s.radiusX, s.radiusY);
            break;
          case "rectangle":
            drawRect(s.x, s.y, s.width, s.height);
            break;
          default:
            if (Array.isArray(s.points)) drawPoly(s.points);
            break;
        }
      };
      if (s.hole) {
        gfx.beginHole();
        draw();
        gfx.endHole();
      } else draw();
    }
    gfx.endFill();

    const rt = this._acquireRT(VW, VH, res);
    const rdr = canvas.app.renderer;
    rdr.render(gfx, { renderTexture: rt, clear: true });

    try {
      rt.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
      rt.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
    } catch {}

    return rt;
  }

  /**
   * Rebuild a region’s mask RT and update attached filters and uniforms.
   * Recomputes region-aligned world bounds for filters that consume them.
   * Keeps cached SDFs when geometry is unchanged.
   * (NEW) Rebuilds cutout RT if any filter wants belowTokens.
   * @param {PlaceableObject} placeable - Region placeable.
   */
  _rebuildRegionMaskFor(placeable) {
    const regionId = placeable.id;
    const entry = this.regionMasks.get(regionId);
    if (!entry) return;

    const r = canvas.app.renderer;
    const screen = r.screen;

    const newRT = this._buildRegionMaskRT(placeable);
    try {
      this._releaseRT(entry.maskRT);
    } catch {}
    entry.maskRT = newRT;

    const anyWantsBelow = (entry.filters || []).some((f) => !!f?.options?.belowTokens);
    if (anyWantsBelow) {
      const w = newRT.width | 0,
        h = newRT.height | 0,
        res = newRT.resolution || 1;
      const needsNew =
        !entry.maskCutoutRT ||
        entry.maskCutoutRT.width !== w ||
        entry.maskCutoutRT.height !== h ||
        (entry.maskCutoutRT.resolution || 1) !== res;
      if (needsNew) {
        if (entry.maskCutoutRT) this._releaseRT(entry.maskCutoutRT);
        entry.maskCutoutRT = this._acquireRT(w, h, res);
      }
      _composeMaskMinusTokens(newRT, entry.maskCutoutRT);
      try {
        entry.maskCutoutRT.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
        entry.maskCutoutRT.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
      } catch {}
    } else {
      if (entry.maskCutoutRT) {
        this._releaseRT(entry.maskCutoutRT);
        entry.maskCutoutRT = null;
      }
    }

    const devW = Math.max(1, r.view.width | 0);
    const devH = Math.max(1, r.view.height | 0);
    const gl = r.gl;
    const MAX_GL = gl?.getParameter?.(gl.MAX_TEXTURE_SIZE) || 8192;
    const capScale = Math.min(1, MAX_GL / Math.max(devW, devH));

    const rbAligned = _regionWorldBoundsAligned(placeable);

    const Ms = _snappedStageMatrix();
    const cssToWorld = Ms.clone().invert();
    const cssToWorldMat3 = _mat3FromPixi(cssToWorld);

    const analytic = _analyzeAnalyticShape(placeable);
    const behaviors = placeable.document.behaviors.filter((b) => b.type === FILTER_TYPE && !b.disabled);
    const needsSdf = !analytic && _regionNeedsPolygonSDF(placeable, behaviors);
    const mode = analytic ? analytic.mode : needsSdf ? 0 : -1;

    const worldPerCss = 0.5 * (Math.hypot(cssToWorld.a, cssToWorld.b) + Math.hypot(cssToWorld.c, cssToWorld.d));

    const MAX_EDGES = 64;
    const builtEdges = _buildPolygonEdges(placeable);
    const edgeCount = Math.min(builtEdges.length / 4, MAX_EDGES);
    const uEdgesArray = new Float32Array(MAX_EDGES * 4);
    if (edgeCount > 0) uEdgesArray.set(builtEdges.slice(0, edgeCount * 4));

    for (const f of entry.filters) {
      const u = f?.uniforms;
      if (!u) continue;

      const wantBelow = !!f?.options?.belowTokens;
      const rtForThisFilter = wantBelow && entry.maskCutoutRT ? entry.maskCutoutRT : newRT;

      u.maskSampler = rtForThisFilter;
      u.hasMask = 1.0;
      u.viewSize = new Float32Array([Math.max(1, screen.width | 0), Math.max(1, screen.height | 0)]);
      u.maskReady = 1.0;
      u.deviceToCss = 1 / (r.resolution || window.devicePixelRatio || 1);

      u.uCssToWorld = cssToWorldMat3;
      u.uRegionShape = mode;

      if (mode === 0) {
        let sdf = this._sdfCache.get(regionId);
        if (!sdf) {
          const worldBounds = _regionWorldBounds(placeable);
          const built = _buildPolygonSDF(placeable, worldBounds);
          sdf = {
            geomKey: _geomKeyFromShapes(placeable?.document?.shapes ?? []),
            texture: built.texture,
            uUvFromWorld: built.uUvFromWorld,
            uSdfScaleOff: built.uSdfScaleOff,
            uSdfTexel: built.uSdfTexel,
            uSdfInsideMax: built.insideMax,
          };
          this._sdfCache.set(regionId, sdf);
        }

        const bt = sdf.texture?.baseTexture;
        const w = Math.max(1, bt?.width | 0);
        const h = Math.max(1, bt?.height | 0);
        const uSdfTexel = new Float32Array([1 / w, 1 / h]);

        u.uSdf = sdf.texture;
        u.uUvFromWorld = sdf.uUvFromWorld;
        u.uSdfScaleOff = sdf.uSdfScaleOff;
        u.uSdfTexel = uSdfTexel;
        u.uSdfInsideMax = sdf.uSdfInsideMax;

        u.uEdges = uEdgesArray;
        u.uEdgeCount = edgeCount;
        u.uSmoothKWorld = Math.max(2.0 * worldPerCss, 1e-6);
      } else if (analytic) {
        u.uCenter = new Float32Array([analytic.center.x, analytic.center.y]);
        u.uHalfSize = new Float32Array([analytic.half.x, analytic.half.y]);
        u.uRotation = analytic.rotation || 0.0;
      }

      try {
        f.filterArea = new PIXI.Rectangle(0, 0, screen.width | 0, screen.height | 0);
      } catch {}
      f.autoFit = false;
      f.padding = 0;
      f.resolution = (r.resolution || 1) * capScale;

      if (rbAligned && typeof f.configure === "function") {
        f.configure({
          regionMinX: rbAligned.minX,
          regionMinY: rbAligned.minY,
          regionMaxX: rbAligned.maxX,
          regionMaxY: rbAligned.maxY,
        });
      }
    }

    this._applyElevationGate(placeable);
    this._refreshEnvFilterArea();
  }

  /**
   * Get the current stage transform for alignment checks.
   * @returns {PIXI.Matrix} World transform matrix.
   */
  _getRegionsMatrix() {
    const M = canvas.stage.worldTransform.clone();
    const res = canvas?.app?.renderer?.resolution || 1;
    M.tx = Math.round(M.tx * res) / res;
    M.ty = Math.round(M.ty * res) / res;
    return M;
  }

  /**
   * Wait for a stable camera/viewport, then perform a one-time refresh.
   * Uses two consecutive identical samples to consider the view stable.
   */
  _waitForStableViewThenRefresh() {
    let tries = 0;
    let lastKey = "";
    const r = canvas.app.renderer;

    const keyNow = () => {
      const M = this._getRegionsMatrix();
      const vw = Math.max(1, r.view.width | 0);
      const vh = Math.max(1, r.view.height | 0);
      const res = r.resolution || 1;
      return `${vw}x${vh}@${res}|${M.a.toFixed(6)},${M.b.toFixed(6)},${M.c.toFixed(6)},${M.d.toFixed(6)},${M.tx},${
        M.ty
      }`;
    };

    const tick = () => {
      const k = keyNow();
      if (k === lastKey) {
        tries += 1;
      } else {
        tries = 0;
        lastKey = k;
      }

      if (tries >= 2) {
        try {
          this.forceRegionMaskRefreshAll();
        } catch {}
        return;
      }
      requestAnimationFrame(tick);
    };

    requestAnimationFrame(() => requestAnimationFrame(tick));
  }

  /**
   * Evaluate per-viewer elevation gating for a region.
   * Honors GM override, event gates, POV/Targets modes, and open-ended bounds.
   * @param {PlaceableObject} placeable - Region placeable.
   * @returns {boolean} True if the region passes elevation visibility.
   */
  _isRegionElevationPass(placeable) {
    const doc = placeable?.document;
    if (!doc) return true;

    const fxBeh = doc.behaviors?.find((b) => b.type === `${packageId}.filterEffectsRegion` && !b.disabled);
    if (!fxBeh) return true;

    const gmAlways = !!fxBeh.getFlag?.(packageId, "gmAlwaysVisible");
    if (gmAlways && game.user?.isGM) return true;

    const { mode, latched } = this._getEventGate(placeable);
    if (mode === "enterExit") return !!latched;
    if (mode === "enter" && !latched) return false;

    const win = this._getRegionElevationWindow(doc);

    const gateMode = fxBeh.getFlag?.(packageId, "gateMode");

    if (gateMode === "pov") {
      const selected = canvas.tokens.controlled;
      if (!selected?.length) return false;
      if (!win) return true;
      for (const t of selected) {
        const elev = Number(t?.document?.elevation);
        if (Number.isFinite(elev) && this._inRangeElev(elev, win)) return true;
      }
      return false;
    }

    if (gateMode === "targets") {
      const targets = fxBeh.getFlag?.(packageId, "tokenTargets");
      const ids = Array.isArray(targets) ? targets : targets ? [targets] : [];
      if (!ids.length) return true;
      if (!win) return true;

      for (const id of ids) {
        let token = null;
        try {
          token = typeof id === "string" && id.includes(".") ? fromUuidSync(id) : canvas.tokens?.get(id);
        } catch {}
        const elev = Number(token?.document?.elevation);
        if (Number.isFinite(elev) && this._inRangeElev(elev, win)) return true;
      }
      return false;
    }

    return true;
  }

  /**
   * Apply the elevation gate by updating uniforms and toggling filter enable states.
   * @param {PlaceableObject} placeable - Region placeable.
   */
  _applyElevationGate(placeable) {
    const entry = this.regionMasks.get(placeable.id);
    if (!entry) return;

    const pass = this._isRegionElevationPass(placeable);
    const prev = this._gatePassCache.get(placeable.id);
    if (prev === pass) return;

    for (const f of entry.filters ?? []) {
      const u = f?.uniforms;
      if (u) {
        if ("hasMask" in u) u.hasMask = pass ? 1.0 : 0.0;
        if ("maskReady" in u) u.maskReady = pass ? 1.0 : 0.0;

        if (typeof u.strength === "number") {
          const base = f.__fxmBaseStrength;
          u.strength = pass ? (typeof base === "number" ? base : u.strength) : 0.0;
        }
      }
      try {
        if (f.enabled !== !!pass) f.enabled = !!pass;
      } catch {}
    }

    this._gatePassCache.set(placeable.id, pass);
  }

  /**
   * Retrieve current event gate state from region flags.
   * @param {PlaceableObject} placeable - Region placeable.
   * @returns {{mode:"enterExit"|"enter"|"exitOnly"|"none",latched:boolean}} Gate mode and state.
   */
  _getEventGate(placeable) {
    const fxBeh = placeable?.document?.behaviors?.find(
      (b) => b.type === `${packageId}.filterEffectsRegion` && !b.disabled,
    );
    if (!fxBeh) return { mode: "none", latched: false };
    const eg = fxBeh.getFlag?.(packageId, "eventGate");
    return {
      mode: eg?.mode ?? "none",
      latched: !!eg?.latched,
    };
  }

  /**
   * Parse region elevation window, supporting open-ended bounds.
   * Returns {min, max} with +/-Infinity for missing sides, or null if both missing.
   * @param {RegionDocument} doc - Region document.
   * @returns {{min:number,max:number}|null} Inclusive elevation window or null.
   */
  _getRegionElevationWindow(doc) {
    const rawTop = doc?.elevation?.top;
    const rawBottom = doc?.elevation?.bottom;

    const hasTop = rawTop !== undefined && rawTop !== null && `${rawTop}`.trim() !== "";
    const hasBottom = rawBottom !== undefined && rawBottom !== null && `${rawBottom}`.trim() !== "";

    if (!hasTop && !hasBottom) return null;

    const top = hasTop ? Number(rawTop) : Number.POSITIVE_INFINITY;
    const bottom = hasBottom ? Number(rawBottom) : Number.NEGATIVE_INFINITY;

    return { min: bottom, max: top };
  }

  /**
   * Inclusive elevation range test.
   * @param {number} elev - Elevation value.
   * @param {{min:number,max:number}} win - Window.
   * @returns {boolean} True if in range.
   */
  _inRangeElev(elev, win) {
    return elev >= win.min && elev <= win.max;
  }

  /**
   * Per-frame watcher:
   * - Updates masks/areas when the stage transform changes.
   * - Re-applies elevation gating.
   * - Keeps filter areas current.
   * @private
   */
  #animate() {
    if (this._tearingDown) return;
    if (this.regionMasks.size === 0) return;

    const Msrc = canvas?.stage?.worldTransform;
    if (!Msrc) return;

    const M = { a: Msrc.a, b: Msrc.b, c: Msrc.c, d: Msrc.d, tx: Math.round(Msrc.tx), ty: Math.round(Msrc.ty) };
    const L = this._lastRegionsMatrix;
    const eps = 1e-4;
    const changed =
      !L ||
      Math.abs(L.a - M.a) > eps ||
      Math.abs(L.b - M.b) > eps ||
      Math.abs(L.c - M.c) > eps ||
      Math.abs(L.d - M.d) > eps ||
      Math.abs(L.tx - M.tx) > eps ||
      Math.abs(L.ty - M.ty) > eps;

    if (changed) {
      this.forceRegionMaskRefreshAll();
      this._lastRegionsMatrix = M;
    }

    for (const reg of canvas.regions.placeables) {
      if (this.regionMasks.has(reg.id)) this._applyElevationGate(reg);
    }

    this._refreshEnvFilterArea();
  }
}
