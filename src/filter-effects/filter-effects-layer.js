/**
 * FilterEffectsLayer
 * ------------------
 * Builds and maintains region-scoped filter runtimes for FXMaster.
 * - Renders per-region screen-space masks aligned to the camera.
 * - Updates region filter uniforms, cutouts, and elevation gates.
 * - Exposes live runtime lookups for the global compositor stack.
 */
import { packageId, MAX_EDGES } from "../constants.js";
import { logger } from "../logger.js";
import { isEnabled } from "../settings.js";
import { normalize } from "./filters/mixins/filter.js";
import {
  _belowTokensEnabled,
  _belowTilesEnabled,
  _belowForegroundEnabled,
  traceRegionShapePath2D,
  snappedStageMatrix,
  mat3FromPixi,
  regionWorldBoundsAligned,
  buildPolygonEdges,
  hasMultipleNonHoleShapes,
  edgeFadeWorldWidth,
  estimateRegionInradius,
  composeMaskMinusTokens,
  composeMaskMinusTokensRT,
  composeMaskMinusTiles,
  composeMaskMinusTilesRT,
  composeMaskMinusCoverageRT,
  rectFromAligned,
  rectFromShapes,
  buildRegionMaskRT,
  computeRegionGatePass,
  coalesceNextFrame,
  getCssViewportMetrics,
  getSnappedCameraCss,
  getSceneDarknessLevel,
  isEffectActiveForSceneDarkness,
} from "../utils.js";
import { BaseEffectsLayer } from "../common/base-effects-layer.js";
import { SceneMaskManager } from "../common/base-effects-scene-manager.js";
import { buildRegionEffectUid } from "../common/effect-stack.js";

const FILTER_TYPE = `${packageId}.filterEffectsRegion`;

/**
 * Track global renderer.roundPixels mutations without attaching state to the PIXI renderer object. Keyed by the renderer instance.
 * @type {WeakMap<object, {count:number, prev:boolean}>}
 * @private
 */
const _rendererRoundPixelsState = new WeakMap();

/**
 * WeakMap cache for geometry keys. Keyed on the shapes array reference so the entry is automatically collected when the Foundry document updates its shapes (producing a new array object).
 * @type {WeakMap<object, string>}
 */
const _geomKeyCache = new WeakMap();

/**
 * Build a stable string key representing the geometry of a set of region shapes. The key is used to detect when an SDF texture needs rebuilding. Results are cached on the shapes array reference via a {@link WeakMap} so repeated calls during the same frame (or subsequent frames with unchanged geometry) skip the full serialisation walk.
 * @param {object[]} shapes - Array of shape descriptors from a region document.
 * @returns {string} A comma-separated canonical representation of the shapes.
 */
function _geomKeyFromShapes(shapes) {
  if (shapes && typeof shapes === "object" && _geomKeyCache.has(shapes)) {
    return _geomKeyCache.get(shapes);
  }

  const parts = [];

  const fmtNum = (n) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return "";
    return Math.round(v * 10000) / 10000;
  };

  const pushArray = (arr, prefix) => {
    if (!Array.isArray(arr) || !arr.length) return;
    if (typeof arr[0] === "number") {
      parts.push(prefix);
      for (const v of arr) parts.push(fmtNum(v));
      return;
    }
    if (typeof arr[0] === "object") {
      parts.push(prefix);
      for (const p of arr) {
        if (!p) continue;
        parts.push(fmtNum(p.x), fmtNum(p.y));
      }
    }
  };

  const pushObjectPrimitives = (obj, prefix = "", depth = 0) => {
    if (!obj || typeof obj !== "object") return;
    const keys = Object.keys(obj).sort();
    for (const k of keys) {
      if (k === "type" || k === "hole") continue;
      const v = obj[k];
      if (v == null) continue;
      const key = prefix ? `${prefix}.${k}` : k;
      const t = typeof v;
      if (t === "number") parts.push(key, fmtNum(v));
      else if (t === "boolean") parts.push(key, v ? 1 : 0);
      else if (t === "string") parts.push(key, v);
      else if (Array.isArray(v)) pushArray(v, key);
      else if (t === "object" && depth < 1) pushObjectPrimitives(v, key, depth + 1);
    }
  };

  for (const s of shapes ?? []) {
    if (!s) continue;
    const data = typeof s.toObject === "function" ? s.toObject() : s;
    const type = data?.type ?? s.type ?? "unknown";
    const hole = !!(data?.hole ?? s.hole);
    parts.push(type, hole ? 1 : 0);
    pushObjectPrimitives(data);
  }

  const key = parts.join(",");
  if (shapes && typeof shapes === "object") {
    _geomKeyCache.set(shapes, key);
  }
  return key;
}

function _regionHasHoleShapes(placeable) {
  return (placeable?.document?.shapes ?? []).some((s) => !!s?.hole);
}

function _analyzeAnalyticShape(placeable) {
  const shapes = (placeable?.document?.shapes ?? []).filter((s) => !s.hole);
  if (shapes.length !== 1) return null;

  const raw = shapes[0];
  const s = typeof raw?.toObject === "function" ? raw.toObject() : raw;
  const type = s?.type ?? raw?.type ?? "unknown";

  /** If a shape is represented by multiple polygons do not treat it as a simple analytic primitive. */
  const polys = s?.polygons ?? raw?.polygons;
  if (Array.isArray(polys) && polys.length > 1) return null;

  const num = (v, d = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const abs = (v, d = 0) => Math.abs(num(v, d));
  const degToRad = (deg) => (num(deg, 0) * Math.PI) / 180;

  /**
   * Attempt to convert a single shape datum into an analytic primitive.
   * @param {object} data
   * @param {number} extra
   */
  const analyticFrom = (data, extra = 0) => {
    if (!data || typeof data !== "object") return null;
    const t = data.type;

    if (t === "rectangle") {
      const x = num(data.x);
      const y = num(data.y);
      const w = num(data.width);
      const h = num(data.height);
      const rot = degToRad(data.rotation);
      const center = { x: x + w * 0.5, y: y + h * 0.5 };
      const half = { x: abs(w) * 0.5 + extra, y: abs(h) * 0.5 + extra };
      return { mode: 1, center, half, rotation: rot };
    }

    if (t === "circle") {
      const r = abs(data.radius);
      const rr = r + extra;
      const center = { x: num(data.x), y: num(data.y) };
      const half = { x: rr, y: rr };
      const rot = degToRad(data.rotation);
      return { mode: 2, center, half, rotation: rot };
    }

    if (t === "ellipse") {
      const rx = abs(data.radiusX);
      const ry = abs(data.radiusY);
      const center = { x: num(data.x), y: num(data.y) };
      const half = { x: rx + extra, y: ry + extra };
      const rot = degToRad(data.rotation);
      return { mode: 2, center, half, rotation: rot };
    }

    if (t === "token") {
      if (Number.isFinite(Number(data.width)) && Number.isFinite(Number(data.height))) {
        const x = num(data.x);
        const y = num(data.y);
        const w = num(data.width);
        const h = num(data.height);
        const rot = degToRad(data.rotation);
        const center = { x: x + w * 0.5, y: y + h * 0.5 };
        const half = { x: abs(w) * 0.5 + extra, y: abs(h) * 0.5 + extra };
        return { mode: 1, center, half, rotation: rot };
      }
    }

    return null;
  };

  if (type === "emanation") {
    const rot = degToRad(raw?.rotation ?? s?.rotation ?? 0);

    const cRaw = raw?.center ?? s?.center ?? null;
    const bRaw = raw?.bounds ?? s?.bounds ?? null;

    const bw = Number(bRaw?.width);
    const bh = Number(bRaw?.height);

    /**
     * Heuristic: does this emanation polygon approximate an ellipse? Checks edge uniformity and area-to-bounding-box ratio. bw/bh MUST be declared above this function to avoid TDZ issues.
     */
    const emanationLooksEllipseLike = () => {
      const baseType = s?.base?.type ?? raw?.base?.type ?? null;
      if (baseType === "token") return false;
      const polysLive = raw?.polygons ?? s?.polygons;
      if (!Array.isArray(polysLive) || polysLive.length !== 1) return false;

      const p0 = polysLive[0];
      const pts = p0?.points ?? p0;
      if (!Array.isArray(pts) || pts.length < 8) return false;

      const flat = typeof pts[0] === "number";
      const n = flat ? (pts.length / 2) | 0 : pts.length | 0;
      if (n < 6) return false;

      let maxLen = 0;
      let sumLen = 0;
      let count = 0;

      const getXY = (i) => {
        if (flat) return [Number(pts[i * 2]), Number(pts[i * 2 + 1])];
        const p = pts[i];
        return [Number(p?.x), Number(p?.y)];
      };

      for (let i = 0; i < n; i++) {
        const [x0, y0] = getXY(i);
        const [x1, y1] = getXY((i + 1) % n);
        if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) continue;
        const dx = x1 - x0;
        const dy = y1 - y0;
        const len = Math.hypot(dx, dy);
        if (!Number.isFinite(len) || len <= 0) continue;
        sumLen += len;
        if (len > maxLen) maxLen = len;
        count++;
      }

      if (count < 6) return false;
      const mean = sumLen / count;
      if (!Number.isFinite(mean) || mean <= 0) return false;

      const edgeUniform = maxLen / mean < 1.8;

      const area = Number(raw?.area ?? s?.area);
      const ratio =
        Number.isFinite(area) && Number.isFinite(bw) && Number.isFinite(bh) && bw > 0 && bh > 0
          ? area / (bw * bh)
          : NaN;
      const ellipseRatio = Math.PI / 4;
      const ratioLooksEllipse = Number.isFinite(ratio) ? Math.abs(ratio - ellipseRatio) < 0.012 : true;

      return edgeUniform && ratioLooksEllipse;
    };

    const cx = Number(cRaw?.x);
    const cy = Number(cRaw?.y);
    const bx = Number(bRaw?.x);
    const by = Number(bRaw?.y);

    if (Number.isFinite(bw) && Number.isFinite(bh) && bw > 0 && bh > 0) {
      const center =
        Number.isFinite(cx) && Number.isFinite(cy)
          ? { x: cx, y: cy }
          : Number.isFinite(bx) && Number.isFinite(by)
          ? { x: bx + 0.5 * bw, y: by + 0.5 * bh }
          : null;

      if (center && emanationLooksEllipseLike()) {
        return {
          mode: 2,
          center,
          half: { x: 0.5 * bw, y: 0.5 * bh },
          rotation: rot,
        };
      }
    }

    return null;
  }

  return analyticFrom({ ...s, type }, 0);
}

function _regionMaxFadeFrac(placeable, behaviors) {
  let maxFrac = 0;

  for (const b of behaviors ?? []) {
    const defs = b.getFlag(packageId, "filters");
    if (!defs) continue;

    for (const [, { options }] of Object.entries(defs)) {
      const raw = Number(options?.fadePercent ?? 0);
      if (!Number.isFinite(raw) || raw <= 0) continue;

      const frac = raw > 1 ? Math.min(1, raw / 100) : Math.min(1, raw);
      if (frac > maxFrac) maxFrac = frac;
    }
  }

  return maxFrac;
}

function _edtSignedFromBinary(binaryCanvas, { encK = 8.0 } = {}) {
  let W = Math.max(1, binaryCanvas?.width | 0);
  let H = Math.max(1, binaryCanvas?.height | 0);
  if (!Number.isFinite(W) || !Number.isFinite(H)) {
    W = 1;
    H = 1;
  }

  const ctx = binaryCanvas.getContext("2d", { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, W, H).data;

  const inside = new Uint8Array(W * H);
  for (let i = 0, p = 0; i < img.length; i += 4, p++) inside[p] = img[i + 3] >= 128 ? 1 : 0;

  const INF = 1e20;
  const n = W * H;

  /** 1D exact EDT. */
  const edt1d = (f, n, d, v, z) => {
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
  };

  /** 2D exact EDT from a binary feature predicate. */
  const maxN = Math.max(W, H);
  const f = new Float32Array(maxN);
  const d = new Float32Array(maxN);
  const v = new Int32Array(maxN);
  const z = new Float32Array(maxN + 1);

  const tmp = new Float32Array(n);

  const edt2dMask = (featureIsInside) => {
    /** Row pass */
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const isFeature = inside[row + x] === (featureIsInside ? 1 : 0);
        f[x] = isFeature ? 0 : INF;
      }
      edt1d(f, W, d, v, z);
      for (let x = 0; x < W; x++) tmp[row + x] = d[x];
    }

    /** Column pass */
    const out = new Float32Array(n);
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) f[y] = tmp[y * W + x];
      edt1d(f, H, d, v, z);
      for (let y = 0; y < H; y++) out[y * W + x] = d[y];
    }
    return out;
  };

  /** dOut: distance to inside features. dIn: distance to outside features. */
  const dOut = edt2dMask(true);
  const dIn = edt2dMask(false);

  const can = document.createElement("canvas");
  can.width = W;
  can.height = H;
  const octx = can.getContext("2d");
  const out = octx.createImageData(W, H);
  for (let i = 0; i < n; i++) {
    const sd = Math.sqrt(dOut[i]) - Math.sqrt(dIn[i]);
    const v = Math.max(0, Math.min(255, Math.round(127.5 + encK * sd)));
    out.data[i * 4 + 0] = v;
    out.data[i * 4 + 1] = v;
    out.data[i * 4 + 2] = v;
    out.data[i * 4 + 3] = 255;
  }
  octx.putImageData(out, 0, 0);
  return { sdfCanvas: can };
}

function _buildRegionSDF_FromBinary(placeable, worldBounds, { maxDistWorld = null } = {}) {
  const minSize = 1e-3;
  const safeBounds = {
    x: Number(worldBounds.x),
    y: Number(worldBounds.y),
    width: Math.max(Number(worldBounds.width), minSize),
    height: Math.max(Number(worldBounds.height), minSize),
  };

  const r = canvas.app.renderer;
  const view = r.view;
  const devW = Math.max(1, view.width | 0);
  const devH = Math.max(1, view.height | 0);

  const gl = r.gl;
  const maxTex = gl?.getParameter?.(gl.MAX_TEXTURE_SIZE) || 8192;

  /** Base resolution: one SDF texel roughly corresponds to one renderer output pixel in world units. */
  let wpt = Math.max(safeBounds.width / devW, safeBounds.height / devH);
  if (!Number.isFinite(wpt) || wpt <= 0) wpt = 1;

  const encK = 8.0;
  if (Number.isFinite(Number(maxDistWorld)) && Number(maxDistWorld) > 0) {
    /** Signed SDF uses half of the 8-bit range for inside distances. */
    const maxSdTex = 127.0 / encK;
    const wantWpt = Number(maxDistWorld) / Math.max(maxSdTex, 1e-6);
    if (Number.isFinite(wantWpt) && wantWpt > 0) wpt = Math.max(wpt, wantWpt);
  }

  let W = Math.max(1, Math.ceil(safeBounds.width / wpt));
  let H = Math.max(1, Math.ceil(safeBounds.height / wpt));

  const overW = W > maxTex;
  const overH = H > maxTex;
  if (overW || overH) {
    const scale = Math.min(maxTex / W, maxTex / H);
    W = Math.max(1, Math.floor(W * scale));
    H = Math.max(1, Math.floor(H * scale));

    wpt = safeBounds.width / W;
  }

  let padPx = 2;
  padPx = Math.min(padPx, Math.floor((W - 1) / 2), Math.floor((H - 1) / 2));
  if (!Number.isFinite(padPx) || padPx < 0) padPx = 0;

  const innerW = Math.max(1, W - 2 * padPx);
  const innerH = Math.max(1, H - 2 * padPx);

  /** World-units per texel for SDF decode. */
  const wptX = safeBounds.width / innerW;
  const wptY = safeBounds.height / innerH;
  wpt = Math.max(wptX, wptY);

  /** Encoding scale is fixed at encK=8.0 for best precision. */
  const bin = document.createElement("canvas");
  bin.width = W;
  bin.height = H;
  const ctx = bin.getContext("2d", { willReadFrequently: true });

  /** Map safeBounds -> [padPx, padPx]..[W-padPx, H-padPx] */
  const sx = innerW / safeBounds.width;
  const sy = innerH / safeBounds.height;
  const ox = padPx - safeBounds.x * sx;
  const oy = padPx - safeBounds.y * sy;

  ctx.save();
  ctx.setTransform(sx, 0, 0, sy, ox, oy);
  ctx.imageSmoothingEnabled = false;

  const shapes = placeable?.document?.shapes ?? [];

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

  ctx.restore();

  const { sdfCanvas } = _edtSignedFromBinary(bin, { encK });

  const base = PIXI.BaseTexture.from(sdfCanvas, {
    scaleMode: PIXI.SCALE_MODES.LINEAR,
    mipmap: PIXI.MIPMAP_MODES.OFF,
    alphaMode: PIXI.ALPHA_MODES.NO_PREMULTIPLIED,
  });

  const texture = new PIXI.Texture(base);

  /** World -> UV mapping for the inset-drawn binary/SDF texture. */
  const uSx = innerW / (W * safeBounds.width);
  const uSy = innerH / (H * safeBounds.height);
  const uTx = padPx / W - safeBounds.x * uSx;
  const uTy = padPx / H - safeBounds.y * uSy;
  const uUvFromWorld = new Float32Array([uSx, 0, uTx, 0, uSy, uTy, 0, 0, 1]);

  const scale = (255 / encK) * wpt;
  const offset = -0.5 * scale;
  const uSdfScaleOff = new Float32Array([scale, offset]);

  const uSdfScaleOff4 = new Float32Array([uSx, uSy, uTx, uTy]);

  const bt = texture.baseTexture;
  const texW = Math.max(1, bt.width | 0);
  const texH = Math.max(1, bt.height | 0);
  const uSdfTexel = new Float32Array([1 / texW, 1 / texH]);
  const insideMax = 0.5 * Math.max(safeBounds.width, safeBounds.height);

  return { texture, uUvFromWorld, uSdfScaleOff, uSdfScaleOff4, uSdfTexel, insideMax };
}

/**
 * Normalize a region behavior collection or array into an array of behavior documents.
 *
 * @param {Iterable<foundry.documents.RegionBehavior>|foundry.documents.RegionBehavior[]|null|undefined} behaviorDocs
 * @returns {foundry.documents.RegionBehavior[]}
 * @private
 */
function normalizeRegionBehaviorDocs(behaviorDocs) {
  if (!behaviorDocs) return [];
  if (Array.isArray(behaviorDocs)) return behaviorDocs;
  if (Array.isArray(behaviorDocs.contents)) return behaviorDocs.contents;
  if (typeof behaviorDocs.toArray === "function") return behaviorDocs.toArray();
  if (typeof behaviorDocs.values === "function") return Array.from(behaviorDocs.values());
  return Array.from(behaviorDocs);
}

/**
 * Select the appropriate region mask texture for a filter.
 *
 * @param {{ maskRT?: PIXI.RenderTexture|null, maskCutoutTokensRT?: PIXI.RenderTexture|null, maskCutoutTilesRT?: PIXI.RenderTexture|null, maskCutoutCombinedRT?: PIXI.RenderTexture|null }|null|undefined} entry
 * @param {boolean} belowTokens
 * @param {boolean} belowTiles
 * @returns {PIXI.RenderTexture|null}
 */
function chooseRegionFilterMaskTexture(entry, belowTokens, belowTiles) {
  if (!entry) return null;
  if (belowTokens && belowTiles) {
    return entry.maskCutoutCombinedRT || entry.maskCutoutTokensRT || entry.maskCutoutTilesRT || entry.maskRT || null;
  }
  if (belowTokens) return entry.maskCutoutTokensRT || entry.maskCutoutCombinedRT || entry.maskRT || null;
  if (belowTiles) return entry.maskCutoutTilesRT || entry.maskCutoutCombinedRT || entry.maskRT || null;
  return entry.maskRT || null;
}

export class FilterEffectsLayer extends BaseEffectsLayer {
  constructor() {
    super();
    this.regionMasks = new Map();
    this._sdfCache = new Map();
    this._gatePassCache = new Map();
    this.stackEntries = new Map();

    this._tokensDirty = false;

    /**
     * Whether any region-scoped filters currently require below-tokens cutouts. Used to keep SceneMaskManager's shared token silhouettes alive without forcing the scene-level filter masking pipeline to stay active.
     * @type {boolean}
     * @private
     */
    this._regionBelowTokensNeeded = false;
    this._regionBelowTilesNeeded = false;

    this._lastCutoutCamFrac = null;
    this._lastRegionDarknessSignatures = new Map();
    this._lastDarknessLevel = getSceneDarknessLevel();

    this._rebuiltThisTick = false;

    /**
     * `roundPixels = true` is required for consistent mask alignment, but the setting must not leak beyond the layer lifecycle.
     *
     * A small reference-counted state is stored per renderer so multiple instances, including reload edge cases, do not compete for the same renderer flag.
     * @type {boolean}
     * @private
     */
    this._didPinRendererRoundPixels = false;

    try {
      const r = canvas?.app?.renderer;
      if (r && typeof r.roundPixels === "boolean") {
        const st = _rendererRoundPixelsState.get(r) ?? { count: 0, prev: !!r.roundPixels };
        if ((st.count | 0) === 0) st.prev = !!r.roundPixels;
        st.count = (st.count | 0) + 1;
        _rendererRoundPixelsState.set(r, st);

        r.roundPixels = true;
        this._didPinRendererRoundPixels = true;
      }
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  /**
   * Return the live filter runtime for a stored stack uid.
   *
   * @param {string} uid
   * @returns {PIXI.Filter|null}
   */
  getStackFilter(uid) {
    return this.stackEntries.get(uid)?.filter ?? null;
  }

  /**
   * Build a signature describing which region-scoped filters for a single region are active at the supplied darkness level.
   *
   * @param {PlaceableObject} placeable
   * @param {number} darknessLevel
   * @returns {string}
   */
  _buildRegionDarknessActivationSignature(placeable, darknessLevel = getSceneDarknessLevel()) {
    const regionId = placeable?.id ?? "";
    const behaviors = Array.from(placeable?.document?.behaviors ?? []).filter(
      (behavior) => behavior?.type === FILTER_TYPE && !behavior?.disabled,
    );

    const parts = [];
    for (const behavior of behaviors) {
      const defs = behavior.getFlag(packageId, "filters") ?? {};
      for (const [id, info] of Object.entries(defs)) {
        parts.push(
          `${regionId}:${behavior.id}:${id}:${isEffectActiveForSceneDarkness(info?.options, darknessLevel) ? 1 : 0}`,
        );
      }
    }

    return parts.sort().join("|");
  }

  /**
   * Notify the layer that token silhouettes changed (movement, resize, visibility, etc). Used to cheaply recompose below-tokens cutout RTs without rebuilding base region masks.
   */
  notifyTokensChanged() {
    this._tokensDirty = true;

    if (this._recomposeScheduled) return;
    const ticker = canvas?.app?.ticker;
    if (!ticker) return;

    this._recomposeScheduled = true;

    const PRIO = PIXI.UPDATE_PRIORITY?.LOW ?? -25;
    const fn = () => {
      try {
        ticker.remove(fn, this);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this._recomposeScheduled = false;

      if (this._rebuiltThisTick) return;

      try {
        this._recomposeBelowTokensCutoutsSync();
      } catch (err) {
        logger?.error?.("FXMaster: error recomposing token cutout masks", err);
      }
    };

    try {
      ticker.add(fn, this, PRIO);
    } catch {
      ticker.add(fn, this);
    }
  }

  /**
   * Keep SceneMaskManager informed about region-level below-tokens and below-tiles requirements.
   *
   * @private
   */
  _updateRegionBelowTokensNeeded() {
    let anyBelowTokens = false;
    let anyBelowTiles = false;
    for (const entry of this.regionMasks.values()) {
      const filters = entry?.filters ?? [];
      if (filters.some((f) => !!f.__fxmBelowTokens)) anyBelowTokens = true;
      if (filters.some((f) => !!f.__fxmBelowTiles)) anyBelowTiles = true;
      if (anyBelowTokens && anyBelowTiles) break;
    }

    const changedTokens = this._regionBelowTokensNeeded !== anyBelowTokens;
    const changedTiles = this._regionBelowTilesNeeded !== anyBelowTiles;
    this._regionBelowTokensNeeded = anyBelowTokens;
    this._regionBelowTilesNeeded = anyBelowTiles;

    if (!changedTokens && !changedTiles) return;

    try {
      SceneMaskManager.instance.setBelowTokensNeeded?.("filters", anyBelowTokens, "regions");
      SceneMaskManager.instance.setBelowTilesNeeded?.("filters", anyBelowTiles, "regions");
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  /**
   * Recompose all region cutout masks that have below-tokens or below-tiles enabled. Uses shared coverage RenderTextures maintained by {@link SceneMaskManager}.
   */
  _recomposeBelowTokensCutoutsSync({ refreshSharedMasks = true } = {}) {
    let anyBelowTokens = false;
    let anyBelowTiles = false;
    for (const entry of this.regionMasks.values()) {
      const filters = entry?.filters ?? [];
      if (filters.some((f) => !!f.__fxmBelowTokens) && entry.maskRT && entry.maskCutoutTokensRT) anyBelowTokens = true;
      if (filters.some((f) => !!f.__fxmBelowTiles) && entry.maskRT && entry.maskCutoutTilesRT) anyBelowTiles = true;
      if (anyBelowTokens && anyBelowTiles) break;
    }
    if (!anyBelowTokens && !anyBelowTiles) {
      try {
        this._updateRegionBelowTokensNeeded();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this._tokensDirty = false;
      return;
    }

    try {
      SceneMaskManager.instance.setBelowTokensNeeded?.("filters", anyBelowTokens, "regions");
      SceneMaskManager.instance.setBelowTilesNeeded?.("filters", anyBelowTiles, "regions");
      if (refreshSharedMasks) SceneMaskManager.instance.refreshTokensSync?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    const { tokens, tiles } = SceneMaskManager.instance.getMasks?.("filters") ?? {};
    for (const entry of this.regionMasks.values()) {
      if (!entry?.maskRT) continue;
      const filters = entry.filters ?? [];
      const wantsBelowTokens = filters.some((f) => !!f.__fxmBelowTokens);
      const wantsBelowTiles = filters.some((f) => !!f.__fxmBelowTiles);

      try {
        if (wantsBelowTokens && entry.maskCutoutTokensRT) {
          if (tokens) composeMaskMinusTokensRT(entry.maskRT, tokens, { outRT: entry.maskCutoutTokensRT });
          else composeMaskMinusTokens(entry.maskRT, { outRT: entry.maskCutoutTokensRT });
        }
        if (wantsBelowTiles && entry.maskCutoutTilesRT) {
          if (tiles) composeMaskMinusTilesRT(entry.maskRT, tiles, { outRT: entry.maskCutoutTilesRT });
          else composeMaskMinusTiles(entry.maskRT, { outRT: entry.maskCutoutTilesRT });
        }
        if (wantsBelowTokens && wantsBelowTiles && entry.maskCutoutCombinedRT) {
          composeMaskMinusCoverageRT(entry.maskRT, [tokens, tiles], { outRT: entry.maskCutoutCombinedRT });
        }
      } catch (err) {
        logger?.error?.("FXMaster: error recomposing region coverage cutout mask", err);
      }
    }

    this._tokensDirty = false;
  }

  /**
   * Recompose live region below-object cutout masks against the current shared scene coverage textures.
   *
   * Region-scoped below-tiles filters use per-region cutout render textures derived from the shared SceneMaskManager tile silhouettes. Tile hover fade updates those shared silhouettes every frame in the compositor, so region cutouts must also be refreshed against the latest shared masks instead of waiting for token/camera invalidation.
   *
   * @param {{ refreshSharedMasks?: boolean }} [options]
   * @returns {void}
   */
  refreshCoverageCutoutsSync({ refreshSharedMasks = false } = {}) {
    try {
      this._recomposeBelowTokensCutoutsSync({ refreshSharedMasks });
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  async _draw() {
    if (!isEnabled()) return;

    for (const region of canvas.regions.placeables) {
      await this.drawRegionFilterEffects(region, { soft: true });
    }

    this._refreshEnvFilterArea();

    if (!this._ticker) {
      const PRIO = PIXI.UPDATE_PRIORITY?.HIGH ?? 25;
      try {
        canvas.app.ticker.add(this._animate, this, PRIO);
      } catch {
        canvas.app.ticker.add(this._animate, this);
      }
      this._ticker = true;
    }

    this._waitForStableViewThenRefresh();
  }

  async _tearDown() {
    this._tearingDown = true;

    if (this._ticker) {
      try {
        canvas.app.ticker.remove(this._animate, this);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this._ticker = false;
    }

    if (this._stableRefresh && typeof this._stableRefresh.cancel === "function") {
      try {
        this._stableRefresh.cancel();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this._stableRefresh = null;
    }

    this._lastRegionsMatrix = null;
    this._tokensDirty = false;
    this._lastCutoutCamFrac = null;

    this._destroyRegionMasks();

    try {
      for (const e of this._sdfCache.values()) {
        try {
          e.texture?.destroy(true);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }
    } finally {
      this._sdfCache.clear();
    }

    this._drainRtPool();

    /** Restore renderer.roundPixels (global) when this layer pinned it. */
    try {
      const r = canvas?.app?.renderer;
      const st = r ? _rendererRoundPixelsState.get(r) : null;
      if (r && st && this._didPinRendererRoundPixels) {
        st.count = Math.max(0, (st.count | 0) - 1);
        if ((st.count | 0) === 0) {
          r.roundPixels = !!st.prev;
          _rendererRoundPixelsState.delete(r);
        } else {
          _rendererRoundPixelsState.set(r, st);
        }
      }
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    this._didPinRendererRoundPixels = false;

    return super._tearDown();
  }

  /**
   * Draw region-scoped filter effects for a region placeable.
   *
   * An authoritative behavior snapshot may be supplied during behavior CRUD so effect selection does not depend on a stale placeable behavior collection.
   *
   * @param {PlaceableObject} placeable
   * @param {{ soft?: boolean, behaviorDocs?: Iterable<foundry.documents.RegionBehavior>|foundry.documents.RegionBehavior[]|null }} [options]
   * @returns {Promise<void>}
   */
  async drawRegionFilterEffects(placeable, { soft = false, behaviorDocs = null } = {}) {
    const regionId = placeable.id;
    this._destroyRegionMasks(regionId);

    const behaviors = normalizeRegionBehaviorDocs(behaviorDocs ?? placeable?.document?.behaviors).filter(
      (behavior) => behavior.type === FILTER_TYPE && !behavior.disabled,
    );
    if (!behaviors.length) return;

    const r = canvas.app.renderer;
    const { cssW, cssH, deviceToCss, deviceRect } = getCssViewportMetrics();

    const maskRT = buildRegionMaskRT(placeable, { rtPool: this._rtPool });
    try {
      maskRT.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
      maskRT.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    const gl = r.gl;
    const MAX_GL = gl?.getParameter?.(gl.MAX_TEXTURE_SIZE) || 8192;
    const devW = Math.max(1, deviceRect.width | 0);
    const devH = Math.max(1, deviceRect.height | 0);
    const capScale = Math.min(1, MAX_GL / Math.max(devW, devH));

    const rbAligned = regionWorldBoundsAligned(placeable);
    const Ms = snappedStageMatrix();
    const cssToWorld = Ms.clone().invert();
    const cssToWorldMat3 = mat3FromPixi(cssToWorld);
    const worldPerCss = 0.5 * (Math.hypot(cssToWorld.a, cssToWorld.b) + Math.hypot(cssToWorld.c, cssToWorld.d));

    const analytic = _analyzeAnalyticShape(placeable);
    const maxFadeFrac = _regionMaxFadeFrac(placeable, behaviors);
    const wantsEdgeFade = maxFadeFrac > 0;
    const hasHoles = _regionHasHoleShapes(placeable);
    const forceMultiSdf = hasMultipleNonHoleShapes(placeable);
    const forceComplexFade = forceMultiSdf || (wantsEdgeFade && hasHoles);

    let worldBoundsRect;
    try {
      if (rbAligned && [rbAligned.minX, rbAligned.minY, rbAligned.maxX, rbAligned.maxY].every(Number.isFinite)) {
        worldBoundsRect = rectFromAligned(rbAligned);
      } else {
        worldBoundsRect = rectFromShapes(placeable?.document?.shapes ?? []);
      }
    } catch (e) {
      logger?.error?.("FXMaster: failed to compute region world bounds for SDF.", e);
      throw e;
    }

    /** Polygon edge lists are only needed when doing polygon-based edge fading (uRegionShape=0). For the common single-shape analytic cases (rect/circle/ellipse) skip computing edges entirely for performance. */
    let edgeCount = 0;
    const uEdgesArray = new Float32Array(MAX_EDGES * 4);

    let fadeMode = -1;
    let fadeCenter = null,
      fadeHalf = null,
      fadeRotation = 0;
    let sdfTex = null,
      uUvFromWorld = null,
      uSdfScaleOff = null,
      uSdfScaleOff4 = null,
      uSdfTexel = null,
      uSdfInsideMax = 0;

    /** For uRegionShape=0 (polygon) Edge Fade %, decide between edge-list (fastPoly) and SDF (% fade). Multi-shape regions always use the SDF path. */
    let fastPoly = false;

    if (analytic && !forceComplexFade) {
      fadeMode = analytic.mode;
      fadeCenter = new Float32Array([analytic.center.x, analytic.center.y]);
      fadeHalf = new Float32Array([Math.max(1e-6, analytic.half.x), Math.max(1e-6, analytic.half.y)]);
      fadeRotation = analytic.rotation || 0;
    } else if (wantsEdgeFade) {
      fadeMode = 0;

      uSdfInsideMax = estimateRegionInradius(placeable);

      fastPoly = !forceComplexFade && !analytic;

      if (fastPoly) {
        const builtEdges = buildPolygonEdges(placeable, { maxEdges: MAX_EDGES }) || [];
        edgeCount = Math.min((builtEdges.length / 4) | 0, MAX_EDGES);
        if (edgeCount > 0) uEdgesArray.set(builtEdges.slice(0, edgeCount * 4));

        sdfTex = PIXI.Texture.WHITE;
        uUvFromWorld = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
        uSdfScaleOff = new Float32Array([1, 0]);
        uSdfScaleOff4 = new Float32Array([1, 0, 0, 1]);
        uSdfTexel = new Float32Array([1, 1]);
      } else {
        const shapes = placeable?.document?.shapes ?? [];
        const geomKey = _geomKeyFromShapes(shapes);

        const desiredMaxDistWorld = Math.max(1e-6, maxFadeFrac * uSdfInsideMax);

        let cacheEntry = this._sdfCache.get(regionId);
        const needsRebuild =
          !cacheEntry ||
          cacheEntry.geomKey !== geomKey ||
          (Number(cacheEntry.maxDistWorld) || 0) + 1e-6 < desiredMaxDistWorld;

        if (needsRebuild) {
          try {
            cacheEntry?.texture?.destroy(true);
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
          const built = _buildRegionSDF_FromBinary(
            placeable,
            {
              x: worldBoundsRect.x,
              y: worldBoundsRect.y,
              width: worldBoundsRect.width,
              height: worldBoundsRect.height,
            },
            { maxDistWorld: desiredMaxDistWorld },
          );
          cacheEntry = {
            geomKey,
            maxDistWorld: desiredMaxDistWorld,
            texture: built.texture,
            uUvFromWorld: built.uUvFromWorld,
            uSdfScaleOff: built.uSdfScaleOff,
            uSdfScaleOff4: built.uSdfScaleOff4,
            uSdfTexel: built.uSdfTexel,
          };
          this._sdfCache.set(regionId, cacheEntry);
        }

        sdfTex = cacheEntry.texture;
        uUvFromWorld = cacheEntry.uUvFromWorld;
        uSdfScaleOff = cacheEntry.uSdfScaleOff;
        uSdfScaleOff4 = cacheEntry.uSdfScaleOff4;

        const bt = cacheEntry.texture?.baseTexture;
        const w = Math.max(1, bt?.width | 0);
        const h = Math.max(1, bt?.height | 0);
        uSdfTexel = new Float32Array([1 / w, 1 / h]);

        edgeCount = 0;
      }
    }

    let anyWantsBelowTokens = false;
    let anyWantsBelowTiles = false;
    for (const behavior of behaviors) {
      const defs = behavior.getFlag(packageId, "filters");
      if (!defs) continue;
      for (const [, { options: ropts }] of Object.entries(defs)) {
        if (!isEffectActiveForSceneDarkness(ropts, getSceneDarknessLevel())) continue;
        if (_belowTokensEnabled(ropts?.belowTokens)) anyWantsBelowTokens = true;
        if (_belowTilesEnabled(ropts?.belowTiles)) anyWantsBelowTiles = true;
        if (anyWantsBelowTokens && anyWantsBelowTiles) break;
      }
      if (anyWantsBelowTokens && anyWantsBelowTiles) break;
    }

    let maskCutoutTokensRT = null;
    let maskCutoutTilesRT = null;
    let maskCutoutCombinedRT = null;
    if (anyWantsBelowTokens || anyWantsBelowTiles) {
      try {
        SceneMaskManager.instance.setBelowTokensNeeded?.("filters", anyWantsBelowTokens, "regions");
        SceneMaskManager.instance.setBelowTilesNeeded?.("filters", anyWantsBelowTiles, "regions");
        SceneMaskManager.instance.refreshTokensSync?.();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      const { tokens, tiles } = SceneMaskManager.instance.getMasks?.("filters") ?? {};
      if (anyWantsBelowTokens) {
        const outRT = this._acquireRT(maskRT.width | 0, maskRT.height | 0, maskRT.resolution || 1);
        maskCutoutTokensRT = tokens
          ? composeMaskMinusTokensRT(maskRT, tokens, { outRT })
          : composeMaskMinusTokens(maskRT, { outRT });
      }
      if (anyWantsBelowTiles) {
        const outRT = this._acquireRT(maskRT.width | 0, maskRT.height | 0, maskRT.resolution || 1);
        maskCutoutTilesRT = tiles
          ? composeMaskMinusTilesRT(maskRT, tiles, { outRT })
          : composeMaskMinusTiles(maskRT, { outRT });
      }
      if (anyWantsBelowTokens && anyWantsBelowTiles) {
        const outRT = this._acquireRT(maskRT.width | 0, maskRT.height | 0, maskRT.resolution || 1);
        maskCutoutCombinedRT = composeMaskMinusCoverageRT(maskRT, [tokens, tiles], { outRT });
      }
      for (const rt of [maskCutoutTokensRT, maskCutoutTilesRT, maskCutoutCombinedRT]) {
        if (!rt?.baseTexture) continue;
        try {
          rt.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
          rt.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }
    }

    const defaultSmoothK = Math.max(2.0 * worldPerCss, 1e-6);
    const appliedFilters = [];

    const darknessLevel = getSceneDarknessLevel();

    for (const behavior of behaviors) {
      const filterDefs = behavior.getFlag(packageId, "filters");
      if (!filterDefs || Object.keys(filterDefs).length === 0) continue;

      for (const [id, { type, options: rawOptions }] of Object.entries(filterDefs)) {
        if (!isEffectActiveForSceneDarkness(rawOptions, darknessLevel)) continue;
        const FilterClass = CONFIG.fxmaster.filterEffects[type];
        if (!FilterClass) {
          logger.warn(game.i18n.format("FXMASTER.Filters.TypeErrors.TypeUnknown", { id, type }));
          continue;
        }

        const options = normalize(rawOptions ?? {});
        const filter = new FilterClass(options, id);
        const wantBelow = _belowTokensEnabled(options?.belowTokens);
        const wantBelowTiles = _belowTilesEnabled(options?.belowTiles);
        const wantBelowForeground = _belowForegroundEnabled(options?.belowForeground);
        const uid = buildRegionEffectUid("filter", regionId, behavior.id, id);
        filter.__fxmBelowTokens = wantBelow;
        filter.__fxmBelowTiles = wantBelowTiles;
        filter.__fxmBelowForeground = wantBelowForeground;
        filter.__fxmStackUid = uid;

        if (filter.uniforms) {
          const u = filter.uniforms;

          u.maskSampler = chooseRegionFilterMaskTexture(
            { maskRT, maskCutoutTokensRT, maskCutoutTilesRT, maskCutoutCombinedRT },
            wantBelow,
            wantBelowTiles,
          );
          u.hasMask = 1.0;
          u.viewSize =
            u.viewSize instanceof Float32Array && u.viewSize.length >= 2
              ? ((u.viewSize[0] = cssW), (u.viewSize[1] = cssH), u.viewSize)
              : new Float32Array([cssW, cssH]);
          u.deviceToCss = deviceToCss;
          u.maskReady = 1.0;
          u.maskSoft = 0.0;
          filter.__fxmMaskVariants = {
            baseMaskRT: maskRT ?? null,
            cutoutTokensRT: maskCutoutTokensRT ?? null,
            cutoutTilesRT: maskCutoutTilesRT ?? null,
            cutoutCombinedRT: maskCutoutCombinedRT ?? null,
            tokensMaskRT: null,
            cssW,
            cssH,
            deviceToCss,
            maskSoft: false,
          };
          u.uCssToWorld = cssToWorldMat3;

          const raw = Math.max(0, Number(options?.fadePercent) || 0);
          const fadeFrac = raw > 1 ? Math.min(1, raw / 100) : Math.min(1, raw);
          const fadeWorld = fadeFrac > 0 ? edgeFadeWorldWidth(placeable, fadeFrac) : 0;

          u.uRegionShape = fadeMode;

          u.uUseSdf = fadeMode === 0 && !fastPoly && sdfTex ? 1 : 0;

          if (fadeMode === 0) {
            if ("uFadePct" in u) u.uFadePct = fadeFrac;
            if ("uUsePct" in u) u.uUsePct = 1.0;
            if ("uFadeWorld" in u) u.uFadeWorld = 0.0;
          } else {
            if ("uFadePct" in u) u.uFadePct = fadeFrac;
            if ("uFadeWorld" in u) u.uFadeWorld = fadeWorld;
            if ("uUsePct" in u) u.uUsePct = "uFadePct" in u ? 1.0 : 0.0;
          }

          if ("uSmoothKWorld" in u) {
            u.uSmoothKWorld = Math.max(fadeWorld > 0 ? 0.25 * fadeWorld : defaultSmoothK, 1e-6);
          }

          if (fadeMode === 1 || fadeMode === 2) {
            u.uCenter = fadeCenter;
            u.uHalfSize = fadeHalf;
            u.uRotation = fadeRotation || 0.0;
            if ("uEdges" in u) {
              u.uEdges = uEdgesArray;
              if ("uEdgeCount" in u) u.uEdgeCount = edgeCount;
            }
          } else if (fadeMode === 0) {
            u.uSdf = sdfTex;
            u.uUvFromWorld = uUvFromWorld;

            if (u.uSdfScaleOff instanceof Float32Array && u.uSdfScaleOff.length >= 4 && uSdfScaleOff4) {
              u.uSdfScaleOff[0] = uSdfScaleOff4[0];
              u.uSdfScaleOff[1] = uSdfScaleOff4[1];
              u.uSdfScaleOff[2] = uSdfScaleOff4[2];
              u.uSdfScaleOff[3] = uSdfScaleOff4[3];
            } else if ("uSdfScaleOff" in u) {
              u.uSdfScaleOff = uSdfScaleOff;
            }
            if ("uSdfDecode" in u) u.uSdfDecode = uSdfScaleOff;

            u.uSdfTexel = uSdfTexel;
            if ("uSdfInsideMax" in u) u.uSdfInsideMax = uSdfInsideMax;
            if ("uEdges" in u) {
              u.uEdges = uEdgesArray;
              if ("uEdgeCount" in u) u.uEdgeCount = edgeCount;
            }
          }
        }

        try {
          if (!(filter.filterArea instanceof PIXI.Rectangle)) filter.filterArea = new PIXI.Rectangle();
          filter.filterArea.copyFrom(deviceRect);
          filter.autoFit = false;
          filter.padding = 0;
          filter.resolution = (r.resolution || 1) * capScale;
        } catch (err) {
          logger.debug("FXMaster:", err);
        }

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
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
        }

        try {
          const u2 = filter.uniforms;
          if (u2 && typeof u2.strength === "number") filter.__fxmBaseStrength = u2.strength;
        } catch (err) {
          logger.debug("FXMaster:", err);
        }

        appliedFilters.push(filter);
        this.stackEntries.set(uid, { uid, filter, regionId, behaviorId: behavior.id, effectId: id });
      }
    }

    if (appliedFilters.length > 0) {
      this.regionMasks.set(regionId, {
        filters: appliedFilters,
        maskRT,
        maskCutoutTokensRT,
        maskCutoutTilesRT,
        maskCutoutCombinedRT,
      });
      this._lastRegionDarknessSignatures.set(
        regionId,
        this._buildRegionDarknessActivationSignature(placeable, darknessLevel),
      );
      this._applyElevationGate(placeable);
      this._refreshEnvFilterArea();
      this._updateRegionBelowTokensNeeded();
    } else {
      this._releaseRT(maskRT);
      for (const rt of [maskCutoutTokensRT, maskCutoutTilesRT, maskCutoutCombinedRT]) if (rt) this._releaseRT(rt);
      this._updateRegionBelowTokensNeeded();
    }
  }

  forceRegionMaskRefreshAll() {
    for (const region of canvas.regions.placeables) {
      if (this.regionMasks.has(region.id)) this._rebuildRegionMaskFor(region);
    }
    this._refreshEnvFilterArea();
  }

  forceRegionMaskRefresh(regionId) {
    const region = canvas.regions?.get(regionId);
    if (region && this.regionMasks.has(regionId)) this._rebuildRegionMaskFor(region);
    this._refreshEnvFilterArea();
  }

  /**
   * Schedule a mask refresh for one or more regions on the next animation frame. Multiple calls within the same frame are batched so that no region ID is lost.
   * @param {string} regionId
   */
  requestRegionMaskRefresh(regionId) {
    this._pendingRegionRefreshIds ??= new Set();
    this._pendingRegionRefreshIds.add(regionId);
    this._coalescedRegionRefresh ??= coalesceNextFrame(
      () => {
        const ids = this._pendingRegionRefreshIds;
        this._pendingRegionRefreshIds = new Set();
        for (const rid of ids) this.forceRegionMaskRefresh(rid);
      },
      { key: this },
    );
    this._coalescedRegionRefresh();
  }

  requestRegionMaskRefreshAll() {
    this._coalescedRefreshAll ??= coalesceNextFrame(
      function () {
        this.forceRegionMaskRefreshAll();
      },
      { key: this },
    );

    this._coalescedRefreshAll();
  }

  destroyRegionFilterEffects(regionId) {
    this._destroyRegionMasks(regionId);
    this._updateRegionBelowTokensNeeded();
  }

  _refreshEnvFilterArea() {
    if (this.regionMasks.size === 0) return;

    const env = canvas.environment;
    const r = canvas.app.renderer;
    if (!env || !r) return;
    const { rect: cssRect, deviceRect } = getCssViewportMetrics();

    const hasSceneMask = !!(env.mask && env.mask.name === "fxmaster:iface-mask-gfx");

    if (!hasSceneMask) {
      try {
        if (!(env.filterArea instanceof PIXI.Rectangle)) env.filterArea = new PIXI.Rectangle();
        env.filterArea.copyFrom(cssRect);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    } else {
      try {
        delete env.filterArea;
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    for (const entry of this.regionMasks.values()) {
      for (const f of entry.filters ?? []) {
        try {
          if (!(f.filterArea instanceof PIXI.Rectangle)) f.filterArea = new PIXI.Rectangle();
          f.filterArea.copyFrom(deviceRect);
          f.autoFit = false;
          f.padding = 0;
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }
    }
  }

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
        for (const rt of [entry.maskCutoutTokensRT, entry.maskCutoutTilesRT, entry.maskCutoutCombinedRT]) {
          if (rt) this._releaseRT(rt);
        }
        this.regionMasks.delete(regionId);
        this._lastRegionDarknessSignatures.delete(regionId);
        for (const f of entry.filters ?? []) {
          if (f?.__fxmStackUid) this.stackEntries.delete(f.__fxmStackUid);
        }
      }
      const sdf = this._sdfCache.get(regionId);
      if (sdf) {
        try {
          sdf.texture?.destroy(true);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        this._sdfCache.delete(regionId);
      }

      try {
        this._gatePassCache.delete(regionId);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    } else {
      for (const entry of this.regionMasks.values()) {
        removeFromTarget(entry.filters);
        for (const f of entry.filters) f.destroy?.();
        this._releaseRT(entry.maskRT);
        for (const rt of [entry.maskCutoutTokensRT, entry.maskCutoutTilesRT, entry.maskCutoutCombinedRT]) {
          if (rt) this._releaseRT(rt);
        }
      }
      this.regionMasks.clear();
      this.stackEntries.clear();
      for (const e of this._sdfCache.values()) {
        try {
          e.texture?.destroy(true);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }
      this._sdfCache.clear();

      this._gatePassCache.clear();
    }

    /**
     * Region mask membership changed; update below-tokens requirements.
     */
    try {
      this._updateRegionBelowTokensNeeded();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  _rebuildRegionMaskFor(placeable) {
    const regionId = placeable.id;
    const entry = this.regionMasks.get(regionId);
    if (!entry) return;

    const r = canvas.app.renderer;

    const { cssW, cssH, deviceToCss, deviceRect } = getCssViewportMetrics();

    const newRT = buildRegionMaskRT(placeable, { rtPool: this._rtPool });
    try {
      this._releaseRT(entry.maskRT);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    entry.maskRT = newRT;

    const anyWantsBelowTokens = (entry.filters || []).some((f) => !!f.__fxmBelowTokens);
    const anyWantsBelowTiles = (entry.filters || []).some((f) => !!f.__fxmBelowTiles);
    if (anyWantsBelowTokens || anyWantsBelowTiles) {
      try {
        SceneMaskManager.instance.setBelowTokensNeeded?.("filters", anyWantsBelowTokens, "regions");
        SceneMaskManager.instance.setBelowTilesNeeded?.("filters", anyWantsBelowTiles, "regions");
        SceneMaskManager.instance.refreshTokensSync?.();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      const { tokens, tiles } = SceneMaskManager.instance.getMasks?.("filters") ?? {};

      const rebuildVariant = (want, key, builder) => {
        const old = entry[key];
        if (!want) {
          if (old) this._releaseRT(old);
          entry[key] = null;
          return;
        }
        const reuse =
          !!old &&
          (old.width | 0) === (newRT.width | 0) &&
          (old.height | 0) === (newRT.height | 0) &&
          (old.resolution || 1) === (newRT.resolution || 1);
        const outRT = reuse ? old : this._acquireRT(newRT.width | 0, newRT.height | 0, newRT.resolution || 1);
        entry[key] = builder(outRT);
        if (old && !reuse && old !== entry[key]) this._releaseRT(old);
        try {
          entry[key].baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
          entry[key].baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      };

      rebuildVariant(anyWantsBelowTokens, "maskCutoutTokensRT", (outRT) =>
        tokens ? composeMaskMinusTokensRT(newRT, tokens, { outRT }) : composeMaskMinusTokens(newRT, { outRT }),
      );
      rebuildVariant(anyWantsBelowTiles, "maskCutoutTilesRT", (outRT) =>
        tiles ? composeMaskMinusTilesRT(newRT, tiles, { outRT }) : composeMaskMinusTiles(newRT, { outRT }),
      );
      rebuildVariant(anyWantsBelowTokens && anyWantsBelowTiles, "maskCutoutCombinedRT", (outRT) =>
        composeMaskMinusCoverageRT(newRT, [tokens, tiles], { outRT }),
      );
    } else {
      for (const key of ["maskCutoutTokensRT", "maskCutoutTilesRT", "maskCutoutCombinedRT"]) {
        if (entry[key]) this._releaseRT(entry[key]);
        entry[key] = null;
      }
    }

    const devW = Math.max(1, deviceRect.width | 0);
    const devH = Math.max(1, deviceRect.height | 0);
    const gl = r.gl;
    const MAX_GL = gl?.getParameter?.(gl.MAX_TEXTURE_SIZE) || 8192;
    const capScale = Math.min(1, MAX_GL / Math.max(devW, devH));

    const rbAligned = regionWorldBoundsAligned(placeable);

    const Ms = snappedStageMatrix();
    const cssToWorld = Ms.clone().invert();
    const cssToWorldMat3 = mat3FromPixi(cssToWorld);

    const analytic = _analyzeAnalyticShape(placeable);
    const behaviors = normalizeRegionBehaviorDocs(placeable?.document?.behaviors).filter(
      (behavior) => behavior.type === FILTER_TYPE && !behavior.disabled,
    );
    const maxFadeFrac = _regionMaxFadeFrac(placeable, behaviors);
    const wantsEdgeFade = maxFadeFrac > 0;
    const hasHoles = _regionHasHoleShapes(placeable);
    const forceMultiSdf = hasMultipleNonHoleShapes(placeable);
    const forceComplexFade = forceMultiSdf || (wantsEdgeFade && hasHoles);
    const mode = wantsEdgeFade && (forceComplexFade || !analytic) ? 0 : analytic ? analytic.mode : -1;

    const fastPoly = mode === 0 && !forceComplexFade && !analytic;

    const worldPerCss = 0.5 * (Math.hypot(cssToWorld.a, cssToWorld.b) + Math.hypot(cssToWorld.c, cssToWorld.d));

    let edgeCount = 0;
    const uEdgesArray = new Float32Array(MAX_EDGES * 4);
    if (mode === 0 && fastPoly) {
      const builtEdges = buildPolygonEdges(placeable, { maxEdges: MAX_EDGES }) || [];
      edgeCount = Math.min((builtEdges.length / 4) | 0, MAX_EDGES);
      if (edgeCount > 0) uEdgesArray.set(builtEdges.slice(0, edgeCount * 4));
    }

    for (const f of entry.filters) {
      const u = f?.uniforms;
      if (!u) continue;

      const wantBelow = !!f.__fxmBelowTokens;
      const wantBelowTiles = !!f.__fxmBelowTiles;
      const rtForThisFilter = chooseRegionFilterMaskTexture(entry, wantBelow, wantBelowTiles) || newRT;

      u.maskSampler = rtForThisFilter;
      u.hasMask = 1.0;
      u.viewSize =
        u.viewSize instanceof Float32Array && u.viewSize.length >= 2
          ? ((u.viewSize[0] = cssW), (u.viewSize[1] = cssH), u.viewSize)
          : new Float32Array([cssW, cssH]);
      u.deviceToCss = deviceToCss;
      u.maskReady = 1.0;
      u.maskSoft = 0.0;
      f.__fxmMaskVariants = {
        baseMaskRT: newRT ?? null,
        cutoutTokensRT: entry.maskCutoutTokensRT ?? null,
        cutoutTilesRT: entry.maskCutoutTilesRT ?? null,
        cutoutCombinedRT: entry.maskCutoutCombinedRT ?? null,
        tokensMaskRT: null,
        cssW,
        cssH,
        deviceToCss,
        maskSoft: false,
      };

      u.uCssToWorld = cssToWorldMat3;
      u.uRegionShape = mode;

      /** 1 => SDF-backed polygon fades; 0 => edge-list (fastPoly) fades. */
      u.uUseSdf = mode === 0 && !fastPoly ? 1.0 : 0.0;

      if (mode === 0) {
        const insideMax = estimateRegionInradius(placeable);

        let worldBoundsRect;
        const rb = rbAligned ?? regionWorldBoundsAligned(placeable);
        if (rb && [rb.minX, rb.minY, rb.maxX, rb.maxY].every(Number.isFinite)) {
          worldBoundsRect = rectFromAligned(rb);
        } else {
          worldBoundsRect = rectFromShapes(placeable?.document?.shapes ?? []);
        }
        let sdfTex = PIXI.Texture.WHITE;
        let uUvFromWorld = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
        let uSdfScaleOff = new Float32Array([1, 0]);
        let uSdfScaleOff4 = new Float32Array([1, 0, 0, 1]);
        let uSdfTexel = new Float32Array([1, 1]);

        if (!fastPoly) {
          let sdf = this._sdfCache.get(regionId);
          const geomKey = _geomKeyFromShapes(placeable?.document?.shapes ?? []);
          if (!sdf || sdf.geomKey !== geomKey) {
            try {
              sdf?.texture?.destroy(true);
            } catch (err) {
              logger.debug("FXMaster:", err);
            }
            const b = _buildRegionSDF_FromBinary(placeable, {
              x: worldBoundsRect.x,
              y: worldBoundsRect.y,
              width: worldBoundsRect.width,
              height: worldBoundsRect.height,
            });
            sdf = {
              geomKey,
              texture: b.texture,
              uUvFromWorld: b.uUvFromWorld,
              uSdfScaleOff: b.uSdfScaleOff,
              uSdfScaleOff4: b.uSdfScaleOff4,
              uSdfTexel: b.uSdfTexel,
            };
            this._sdfCache.set(regionId, sdf);
          }

          sdfTex = sdf.texture;
          uUvFromWorld = sdf.uUvFromWorld;
          uSdfScaleOff = sdf.uSdfScaleOff;
          uSdfScaleOff4 = sdf.uSdfScaleOff4;

          const bt = sdf.texture?.baseTexture;
          const w = Math.max(1, bt?.width | 0);
          const h = Math.max(1, bt?.height | 0);
          uSdfTexel = new Float32Array([1 / w, 1 / h]);
        }

        u.uSdf = sdfTex;
        u.uUvFromWorld = uUvFromWorld;

        if (u.uSdfScaleOff instanceof Float32Array && u.uSdfScaleOff.length >= 4 && uSdfScaleOff4) {
          u.uSdfScaleOff[0] = uSdfScaleOff4[0];
          u.uSdfScaleOff[1] = uSdfScaleOff4[1];
          u.uSdfScaleOff[2] = uSdfScaleOff4[2];
          u.uSdfScaleOff[3] = uSdfScaleOff4[3];
        } else if ("uSdfScaleOff" in u) {
          u.uSdfScaleOff = uSdfScaleOff;
        }
        if ("uSdfDecode" in u) u.uSdfDecode = uSdfScaleOff;

        u.uSdfTexel = uSdfTexel;
        if ("uSdfInsideMax" in u) u.uSdfInsideMax = insideMax;

        const raw = Math.max(0, Number(f.options?.fadePercent) || 0);
        const fadeFrac = raw > 1 ? Math.min(1, raw / 100) : Math.min(1, raw);
        if ("uFadePct" in u) u.uFadePct = fadeFrac;
        if ("uUsePct" in u) u.uUsePct = 1.0;
        if ("uFadeWorld" in u) u.uFadeWorld = 0.0;

        u.uEdges = uEdgesArray;
        u.uEdgeCount = fastPoly ? edgeCount : 0;
        u.uSmoothKWorld = Math.max(2.0 * worldPerCss, 1e-6);
      } else if (analytic) {
        u.uCenter = new Float32Array([analytic.center.x, analytic.center.y]);
        u.uHalfSize = new Float32Array([analytic.half.x, analytic.half.y]);
        u.uRotation = analytic.rotation || 0.0;

        const raw = Math.max(0, Number(f.options?.fadePercent) || 0);
        const fadeFrac = raw > 1 ? Math.min(1, raw / 100) : Math.min(1, raw);
        if ("uFadePct" in u) u.uFadePct = fadeFrac;
        if ("uUsePct" in u) u.uUsePct = "uFadePct" in u ? 1.0 : 0.0;
      }

      try {
        if (!(f.filterArea instanceof PIXI.Rectangle)) f.filterArea = new PIXI.Rectangle();
        f.filterArea.copyFrom(deviceRect);
        f.autoFit = false;
        f.padding = 0;
        f.resolution = (r.resolution || 1) * capScale;
      } catch (err) {
        logger.debug("FXMaster:", err);
      }

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

  _waitForStableViewThenRefresh() {
    const r = canvas?.app?.renderer;
    if (!r) return;

    if (this._stableRefresh && typeof this._stableRefresh.cancel === "function") {
      try {
        this._stableRefresh.cancel();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this._stableRefresh = null;
    }

    let tries = 0;
    let lastKey = "";

    const keyNow = () => {
      const M = snappedStageMatrix();
      const { deviceRect } = getCssViewportMetrics();
      const vw = deviceRect.width | 0;
      const vh = deviceRect.height | 0;
      const res = r.resolution || 1;
      return `${vw}x${vh}@${res}|${M.a.toFixed(6)},${M.b.toFixed(6)},${M.c.toFixed(6)},${M.d.toFixed(6)},${M.tx},${
        M.ty
      }`;
    };

    const step = () => {
      if (this._tearingDown) return;
      if (!canvas?.app?.renderer) return;

      const k = keyNow();
      if (k === lastKey) {
        tries += 1;
      } else {
        tries = 0;
        lastKey = k;
      }

      if (tries >= 2) {
        try {
          this._stableRefresh?.cancel?.();
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        this._stableRefresh = null;

        try {
          this.forceRegionMaskRefreshAll();
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        return;
      }

      try {
        this._stableRefresh?.();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    };

    this._stableRefresh = coalesceNextFrame(step, { key: this });

    try {
      this._stableRefresh();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  _animate() {
    this._rebuiltThisTick = false;

    super._animate();

    let anyBelowTokens = false;
    let anyBelowTiles = false;
    for (const entry of this.regionMasks.values()) {
      const filters = entry?.filters ?? [];
      if (filters.some((f) => !!f.__fxmBelowTokens) && entry.maskRT && entry.maskCutoutTokensRT) anyBelowTokens = true;
      if (filters.some((f) => !!f.__fxmBelowTiles) && entry.maskRT && entry.maskCutoutTilesRT) anyBelowTiles = true;
      if (anyBelowTokens && anyBelowTiles) break;
    }

    if (anyBelowTokens || anyBelowTiles) {
      const r = canvas?.app?.renderer;
      const res = r?.resolution || 1;
      const { txCss, tyCss } = getSnappedCameraCss();
      const fx = (((txCss * res) % 1) + 1) % 1;
      const fy = (((tyCss * res) % 1) + 1) % 1;

      const prev = this._lastCutoutCamFrac;
      /**
       * Sub-pixel threshold: skip token mask recomposition for camera movements smaller than ~1% of a device pixel to avoid expensive per-frame work.
       */
      const SUB_PIXEL_THRESHOLD = 0.01;
      const fracMoved =
        !prev || Math.abs(prev.x - fx) > SUB_PIXEL_THRESHOLD || Math.abs(prev.y - fy) > SUB_PIXEL_THRESHOLD;

      if (!this._rebuiltThisTick && (this._tokensDirty || fracMoved)) {
        try {
          this._recomposeBelowTokensCutoutsSync();
        } catch (err) {
          logger?.error?.("FXMaster: error recomposing token cutout masks", err);
        }
      }

      this._tokensDirty = false;
      this._lastCutoutCamFrac = { x: fx, y: fy };
    } else {
      this._tokensDirty = false;
      this._lastCutoutCamFrac = null;
    }

    for (const reg of canvas.regions.placeables) {
      if (this.regionMasks.has(reg.id)) this._applyElevationGate(reg);
    }

    this._refreshEnvFilterArea();

    try {
      const darknessLevel = getSceneDarknessLevel();
      if (Math.abs(darknessLevel - (this._lastDarknessLevel ?? darknessLevel)) > 1e-4) {
        this._lastDarknessLevel = darknessLevel;
        for (const region of canvas.regions?.placeables ?? []) {
          const signature = this._buildRegionDarknessActivationSignature(region, darknessLevel);
          if (signature !== (this._lastRegionDarknessSignatures.get(region.id) ?? "")) {
            this._lastRegionDarknessSignatures.set(region.id, signature);
            void this.drawRegionFilterEffects(region, { soft: true });
          }
        }
      }
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    try {
      for (const entry of this.regionMasks.values()) {
        const list = entry.filters ?? [];
        for (const f of list) {
          if (typeof f?.lockViewport === "function") {
            f.lockViewport({ setDeviceToCss: false, setCamFrac: true });
          }
        }
      }
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  _onCameraChange() {
    this._rebuiltThisTick = true;
    this.forceRegionMaskRefreshAll();
  }

  _applyElevationGate(placeable) {
    const entry = this.regionMasks.get(placeable.id);
    if (!entry) return;

    const pass = computeRegionGatePass(placeable, { behaviorType: `${packageId}.filterEffectsRegion` });
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
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    this._gatePassCache.set(placeable.id, pass);
  }
}
