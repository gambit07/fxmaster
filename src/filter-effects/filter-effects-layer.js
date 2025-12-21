/**
 * FilterEffectsLayer
 * ------------------
 * Applies region-scoped post-processing filters in FXMaster.
 * - Renders a per-region, screen-space (CSS px) alpha mask aligned to the camera.
 * - Attaches configured filter instances to `canvas.environment`.
 * - Keeps masks and filter areas in sync with camera transforms.
 */

import { packageId, MAX_EDGES } from "../constants.js";
import { logger } from "../logger.js";
import { isEnabled } from "../settings.js";
import { normalize } from "./filters/mixins/filter.js";
import {
  traceRegionShapePath2D,
  snappedStageMatrix,
  mat3FromPixi,
  regionWorldBoundsAligned,
  buildPolygonEdges,
  hasMultipleNonHoleShapes,
  edgeFadeWorldWidth,
  composeMaskMinusTokens,
  composeMaskMinusTokensRT,
  rectFromAligned,
  rectFromShapes,
  buildRegionMaskRT,
  computeRegionGatePass,
  coalesceNextFrame,
  getCssViewportMetrics,
} from "../utils.js";
import { BaseEffectsLayer } from "../common/base-effects-layer.js";
import { SceneMaskManager } from "../common/base-effects-scene-manager.js";

const FILTER_TYPE = `${packageId}.filterEffectsRegion`;

function _geomKeyFromShapes(shapes) {
  const parts = [];
  for (const s of shapes) {
    parts.push(s.type, s.hole ? 1 : 0);
    if (s.type === "rectangle") parts.push(s.x, s.y, s.width, s.height);
    else if (s.type === "ellipse" || s.type === "circle") {
      const rx = s.type === "circle" ? s.radius ?? 0 : s.radiusX ?? 0;
      const ry = s.type === "circle" ? s.radius ?? 0 : s.radiusY ?? 0;
      parts.push(s.x ?? 0, s.y ?? 0, rx, ry);
    } else if (Array.isArray(s.points)) {
      if (typeof s.points[0] === "object") {
        for (const p of s.points) parts.push(p.x, p.y);
      } else {
        parts.push(...s.points);
      }
    }
  }
  return parts.join(",");
}

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
  if (s.type === "ellipse" || s.type === "circle") {
    const rX = s.type === "circle" ? s.radius ?? 0 : s.radiusX ?? 0;
    const rY = s.type === "circle" ? s.radius ?? 0 : s.radiusY ?? 0;
    const center = { x: Number(s.x) || 0, y: Number(s.y) || 0 };
    const half = { x: Math.abs(rX), y: Math.abs(rY) };
    const rotation = 0;
    return { mode: 2, center, half, rotation };
  }
  return null;
}

function _regionWantsEdgeFade(placeable, behaviors) {
  for (const b of behaviors ?? []) {
    const defs = b.getFlag(packageId, "filters");
    if (!defs) continue;
    for (const [, { options }] of Object.entries(defs)) {
      const v = options?.fadePercent ?? 0;
      if (typeof v === "number" && v > 0) return true;
    }
  }
  return false;
}

function _edtSignedFromBinary(binaryCanvas) {
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

  const INF = 1e12,
    n = W * H;
  const dIn = new Float32Array(n);
  const dOut = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    dIn[i] = inside[i] ? INF : 0;
    dOut[i] = inside[i] ? 0 : INF;
  }

  const dx = [-1, 0, 1, -1, 0, 1, -1, 0, 1],
    dy = [-1, -1, -1, 0, 0, 0, 1, 1, 1],
    w = [2, 1, 2, 1, 0, 1, 2, 1, 2];
  const pass = (D) => {
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        let best = D[i];
        for (let k = 0; k < 5; k++) {
          const nx = x + dx[k],
            ny = y + dy[k];
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const cand = D[ny * W + nx] + w[k];
          if (cand < best) best = cand;
        }
        D[i] = best;
      }
    for (let y = H - 1; y >= 0; y--)
      for (let x = W - 1; x >= 0; x--) {
        const i = y * W + x;
        let best = D[i];
        for (let k = 4; k < 9; k++) {
          const nx = x + dx[k],
            ny = y + dy[k];
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const cand = D[ny * W + nx] + w[k];
          if (cand < best) best = cand;
        }
        D[i] = best;
      }
  };
  pass(dIn);
  pass(dOut);

  const can = document.createElement("canvas");
  can.width = W;
  can.height = H;
  const octx = can.getContext("2d");
  const out = octx.createImageData(W, H);
  for (let i = 0; i < n; i++) {
    const sd = Math.sqrt(dOut[i]) - Math.sqrt(dIn[i]);
    const v = Math.max(0, Math.min(255, Math.round(127 + 8.0 * sd)));
    out.data[i * 4 + 0] = v;
    out.data[i * 4 + 1] = v;
    out.data[i * 4 + 2] = v;
    out.data[i * 4 + 3] = 255;
  }
  octx.putImageData(out, 0, 0);
  return { sdfCanvas: can };
}

function _buildRegionSDF_FromBinary(placeable, worldBounds) {
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

  let wpt = Math.max(safeBounds.width / devW, safeBounds.height / devH);
  if (!Number.isFinite(wpt) || wpt <= 0) wpt = 1;

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

  const bin = document.createElement("canvas");
  bin.width = W;
  bin.height = H;
  const ctx = bin.getContext("2d", { willReadFrequently: true });

  const sx = W / safeBounds.width;
  const sy = H / safeBounds.height;
  const ox = -safeBounds.x * sx;
  const oy = -safeBounds.y * sy;

  ctx.save();
  ctx.setTransform(sx, 0, 0, sy, ox, oy);
  ctx.imageSmoothingEnabled = false;

  const shapes = placeable?.document?.shapes ?? [];

  ctx.globalCompositeOperation = "source-over";
  ctx.beginPath();
  for (const s of shapes) {
    if (s?.hole) continue;
    traceRegionShapePath2D(ctx, s);
  }
  ctx.fillStyle = "#ffffff";
  ctx.fill();

  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  for (const s of shapes) {
    if (!s?.hole) continue;
    traceRegionShapePath2D(ctx, s);
  }
  ctx.fillStyle = "#ffffff";
  ctx.fill();

  ctx.restore();

  const { sdfCanvas } = _edtSignedFromBinary(bin);

  const base = PIXI.BaseTexture.from(sdfCanvas, {
    scaleMode: PIXI.SCALE_MODES.LINEAR,
    mipmap: PIXI.MIPMAP_MODES.OFF,
    alphaMode: PIXI.ALPHA_MODES.NO_PREMULTIPLIED,
  });

  const texture = new PIXI.Texture(base);

  const uSx = 1 / safeBounds.width;
  const uSy = 1 / safeBounds.height;
  const uTx = -safeBounds.x * uSx;
  const uTy = -safeBounds.y * uSy;
  const uUvFromWorld = new Float32Array([uSx, 0, uTx, 0, uSy, uTy, 0, 0, 1]);

  const scale = (255 / 8) * wpt;
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

export class FilterEffectsLayer extends BaseEffectsLayer {
  constructor() {
    super();
    this.regionMasks = new Map();
    this._sdfCache = new Map();
    this._gatePassCache = new Map();

    this._tokensDirty = false;

    this._lastCutoutCamFrac = null;

    this._rebuiltThisTick = false;

    try {
      canvas.app.renderer.roundPixels = true;
    } catch {}
  }

  /**
   * Notify the layer that token silhouettes changed (movement, resize, visibility, etc).
   * Used to cheaply recompose below-tokens cutout RTs without rebuilding base region masks.
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
      } catch {}
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
   * Recompose all region cutout masks that have belowTokens enabled (base - tokens silhouette).
   * Uses the shared tokens RenderTexture maintained by SceneMaskManager to avoid O(regions × tokens).
   * This is synchronous and safe to call during panning/zooming or token movement.
   */
  _recomposeBelowTokensCutoutsSync() {
    let anyBelowTokens = false;
    for (const entry of this.regionMasks.values()) {
      const filters = entry?.filters ?? [];
      if (filters.some((f) => !!f.__fxmBelowTokens) && entry.maskRT && entry.maskCutoutRT) {
        anyBelowTokens = true;
        break;
      }
    }
    if (!anyBelowTokens) {
      this._tokensDirty = false;
      return;
    }

    try {
      SceneMaskManager.instance.setKindActive?.("filters", true);
      SceneMaskManager.instance.setBelowTokensNeeded?.("filters", true);
    } catch {}

    try {
      SceneMaskManager.instance.refreshTokensSync?.();
    } catch {}

    const { tokens } = SceneMaskManager.instance.getMasks?.("filters") ?? {};
    for (const entry of this.regionMasks.values()) {
      if (!entry?.maskRT || !entry?.maskCutoutRT) continue;
      const anyBelow = (entry.filters ?? []).some((f) => !!f.__fxmBelowTokens);
      if (!anyBelow) continue;

      try {
        if (tokens) {
          composeMaskMinusTokensRT(entry.maskRT, tokens, { outRT: entry.maskCutoutRT });
        } else {
          composeMaskMinusTokens(entry.maskRT, { outRT: entry.maskCutoutRT });
        }
      } catch (err) {
        logger?.error?.("FXMaster: error recomposing token cutout mask", err);
      }
    }

    this._tokensDirty = false;
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
      } catch {}
      this._ticker = false;
    }

    if (this._stableRefresh && typeof this._stableRefresh.cancel === "function") {
      try {
        this._stableRefresh.cancel();
      } catch {}
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
        } catch {}
      }
    } finally {
      this._sdfCache.clear();
    }

    this._drainRtPool();

    return super._tearDown();
  }

  async drawRegionFilterEffects(placeable, { soft = false } = {}) {
    const regionId = placeable.id;
    this._destroyRegionMasks(regionId);

    const behaviors = placeable.document.behaviors.filter((b) => b.type === FILTER_TYPE && !b.disabled);
    if (!behaviors.length) return;

    const r = canvas.app.renderer;
    const { cssW, cssH, deviceToCss, deviceRect } = getCssViewportMetrics();

    const maskRT = buildRegionMaskRT(placeable, { rtPool: this._rtPool });
    try {
      maskRT.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
      maskRT.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
    } catch {}

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
    const wantsEdgeFade = _regionWantsEdgeFade(placeable, behaviors);
    const forceMultiSdf = hasMultipleNonHoleShapes(placeable);

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

    const builtEdges = buildPolygonEdges(placeable) || [];
    const edgeCount = Math.min((builtEdges.length / 4) | 0, MAX_EDGES);
    const uEdgesArray = new Float32Array(MAX_EDGES * 4);
    if (edgeCount > 0) uEdgesArray.set(builtEdges.slice(0, edgeCount * 4));

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

    if (analytic && !forceMultiSdf && !wantsEdgeFade) {
      fadeMode = analytic.mode;
      fadeCenter = new Float32Array([analytic.center.x, analytic.center.y]);
      fadeHalf = new Float32Array([Math.max(1e-6, analytic.half.x), Math.max(1e-6, analytic.half.y)]);
      fadeRotation = analytic.rotation || 0;
    } else if (wantsEdgeFade) {
      const shapes = placeable?.document?.shapes ?? [];
      const geomKey = _geomKeyFromShapes(shapes);

      let cacheEntry = this._sdfCache.get(regionId);
      if (!cacheEntry || cacheEntry.geomKey !== geomKey) {
        try {
          cacheEntry?.texture?.destroy(true);
        } catch {}
        const built = _buildRegionSDF_FromBinary(placeable, {
          x: worldBoundsRect.x,
          y: worldBoundsRect.y,
          width: worldBoundsRect.width,
          height: worldBoundsRect.height,
        });
        cacheEntry = {
          geomKey,
          texture: built.texture,
          uUvFromWorld: built.uUvFromWorld,
          uSdfScaleOff: built.uSdfScaleOff,
          uSdfScaleOff4: built.uSdfScaleOff4,
          uSdfTexel: built.uSdfTexel,
          uSdfInsideMax: built.insideMax,
        };
        this._sdfCache.set(regionId, cacheEntry);
      }

      fadeMode = 0;
      sdfTex = cacheEntry.texture;
      uUvFromWorld = cacheEntry.uUvFromWorld;
      uSdfScaleOff = cacheEntry.uSdfScaleOff;
      uSdfScaleOff4 = cacheEntry.uSdfScaleOff4;
      uSdfInsideMax = cacheEntry.uSdfInsideMax;

      const bt = cacheEntry.texture?.baseTexture;
      const w = Math.max(1, bt?.width | 0);
      const h = Math.max(1, bt?.height | 0);
      uSdfTexel = new Float32Array([1 / w, 1 / h]);
    }

    let anyWantsBelow = false;
    for (const behavior of behaviors) {
      const defs = behavior.getFlag(packageId, "filters");
      if (!defs) continue;
      for (const [, { options: ropts }] of Object.entries(defs)) {
        if (ropts?.belowTokens) {
          anyWantsBelow = true;
          break;
        }
      }
      if (anyWantsBelow) break;
    }

    let maskCutoutRT = null;
    if (anyWantsBelow) {
      const outRT = this._acquireRT(maskRT.width | 0, maskRT.height | 0, maskRT.resolution || 1);
      try {
        SceneMaskManager.instance.setKindActive?.("filters", true);
        SceneMaskManager.instance.setBelowTokensNeeded?.("filters", true);
        SceneMaskManager.instance.refreshTokensSync?.();
      } catch {}
      const { tokens } = SceneMaskManager.instance.getMasks?.("filters") ?? {};
      maskCutoutRT = tokens
        ? composeMaskMinusTokensRT(maskRT, tokens, { outRT })
        : composeMaskMinusTokens(maskRT, { outRT });
      try {
        maskCutoutRT.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
        maskCutoutRT.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
      } catch {}
    }

    const defaultSmoothK = Math.max(2.0 * worldPerCss, 1e-6);
    const appliedFilters = [];

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
        filter.__fxmBelowTokens = wantBelow;

        if (filter.uniforms) {
          const u = filter.uniforms;

          u.maskSampler = wantBelow && maskCutoutRT ? maskCutoutRT : maskRT;
          u.hasMask = 1.0;
          u.viewSize =
            u.viewSize instanceof Float32Array && u.viewSize.length >= 2
              ? ((u.viewSize[0] = cssW), (u.viewSize[1] = cssH), u.viewSize)
              : new Float32Array([cssW, cssH]);
          u.deviceToCss = deviceToCss;
          u.maskReady = 1.0;
          u.uCssToWorld = cssToWorldMat3;

          const raw = Math.max(0, Number(options?.fadePercent) || 0);
          const fadeFrac = raw > 1 ? Math.min(1, raw / 100) : Math.min(1, raw);
          const fadeWorld = fadeFrac > 0 ? edgeFadeWorldWidth(placeable, fadeFrac) : 0;

          u.uRegionShape = fadeMode;
          u.uUseSdf = fadeMode === 0 ? 1 : 0;

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
              if ("uEdgeCount" in u) u.uEdgeCount = 0;
            }
          }
        }

        try {
          if (!(filter.filterArea instanceof PIXI.Rectangle)) filter.filterArea = new PIXI.Rectangle();
          filter.filterArea.copyFrom(deviceRect);
          filter.autoFit = false;
          filter.padding = 0;
          filter.resolution = (r.resolution || 1) * capScale;
        } catch {}

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

        try {
          const u2 = filter.uniforms;
          if (u2 && typeof u2.strength === "number") filter.__fxmBaseStrength = u2.strength;
        } catch {}

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

  requestRegionMaskRefresh(regionId) {
    this._coalescedRegionRefresh ??= coalesceNextFrame(
      function (rid) {
        this.forceRegionMaskRefresh(rid);
      },
      { key: this },
    );

    this._coalescedRegionRefresh(regionId);
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
      } catch {}
    } else {
      try {
        delete env.filterArea;
      } catch {}
    }

    for (const entry of this.regionMasks.values()) {
      for (const f of entry.filters ?? []) {
        try {
          if (!(f.filterArea instanceof PIXI.Rectangle)) f.filterArea = new PIXI.Rectangle();
          f.filterArea.copyFrom(deviceRect);
          f.autoFit = false;
          f.padding = 0;
        } catch {}
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

  _rebuildRegionMaskFor(placeable) {
    const regionId = placeable.id;
    const entry = this.regionMasks.get(regionId);
    if (!entry) return;

    const r = canvas.app.renderer;

    const { cssW, cssH, deviceToCss, deviceRect } = getCssViewportMetrics();

    const newRT = buildRegionMaskRT(placeable, { rtPool: this._rtPool });
    try {
      this._releaseRT(entry.maskRT);
    } catch {}
    entry.maskRT = newRT;

    const anyWantsBelow = (entry.filters || []).some((f) => !!f.__fxmBelowTokens);
    if (anyWantsBelow) {
      const old = entry.maskCutoutRT;
      const reuse =
        !!old &&
        (old.width | 0) === (newRT.width | 0) &&
        (old.height | 0) === (newRT.height | 0) &&
        (old.resolution || 1) === (newRT.resolution || 1);

      const outRT = reuse ? old : this._acquireRT(newRT.width | 0, newRT.height | 0, newRT.resolution || 1);
      try {
        SceneMaskManager.instance.setKindActive?.("filters", true);
        SceneMaskManager.instance.setBelowTokensNeeded?.("filters", true);
        SceneMaskManager.instance.refreshTokensSync?.();
      } catch {}
      const { tokens } = SceneMaskManager.instance.getMasks?.("filters") ?? {};
      entry.maskCutoutRT = tokens
        ? composeMaskMinusTokensRT(newRT, tokens, { outRT })
        : composeMaskMinusTokens(newRT, { outRT });

      if (old && !reuse && old !== entry.maskCutoutRT) {
        try {
          this._releaseRT(old);
        } catch {}
      }

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
    const behaviors = placeable.document.behaviors.filter((b) => b.type === FILTER_TYPE && !b.disabled);
    const wantsEdgeFade = _regionWantsEdgeFade(placeable, behaviors);
    const forceMultiSdf = hasMultipleNonHoleShapes(placeable);
    const mode = wantsEdgeFade && (forceMultiSdf || !analytic) ? 0 : analytic ? analytic.mode : -1;

    const worldPerCss = 0.5 * (Math.hypot(cssToWorld.a, cssToWorld.b) + Math.hypot(cssToWorld.c, cssToWorld.d));

    const builtEdges = buildPolygonEdges(placeable);
    const edgeCount = Math.min(builtEdges.length / 4, MAX_EDGES);
    const uEdgesArray = new Float32Array(MAX_EDGES * 4);
    if (edgeCount > 0) uEdgesArray.set(builtEdges.slice(0, edgeCount * 4));

    for (const f of entry.filters) {
      const u = f?.uniforms;
      if (!u) continue;

      const wantBelow = !!f.__fxmBelowTokens;
      const rtForThisFilter = wantBelow && entry.maskCutoutRT ? entry.maskCutoutRT : newRT;

      u.maskSampler = rtForThisFilter;
      u.hasMask = 1.0;
      u.viewSize =
        u.viewSize instanceof Float32Array && u.viewSize.length >= 2
          ? ((u.viewSize[0] = cssW), (u.viewSize[1] = cssH), u.viewSize)
          : new Float32Array([cssW, cssH]);
      u.deviceToCss = deviceToCss;
      u.maskReady = 1.0;

      u.uCssToWorld = cssToWorldMat3;
      u.uRegionShape = mode;

      if (mode === 0) {
        let worldBoundsRect;
        const rb = rbAligned ?? regionWorldBoundsAligned(placeable);
        if (rb && [rb.minX, rb.minY, rb.maxX, rb.maxY].every(Number.isFinite)) {
          worldBoundsRect = rectFromAligned(rb);
        } else {
          worldBoundsRect = rectFromShapes(placeable?.document?.shapes ?? []);
        }

        let sdf = this._sdfCache.get(regionId);
        const geomKey = _geomKeyFromShapes(placeable?.document?.shapes ?? []);
        if (!sdf || sdf.geomKey !== geomKey) {
          try {
            sdf?.texture?.destroy(true);
          } catch {}
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
            uSdfInsideMax: b.insideMax,
          };
          this._sdfCache.set(regionId, sdf);
        }

        const bt = sdf.texture?.baseTexture;
        const w = Math.max(1, bt?.width | 0);
        const h = Math.max(1, bt?.height | 0);
        const uSdfTexel = new Float32Array([1 / w, 1 / h]);

        u.uSdf = sdf.texture;
        u.uUvFromWorld = sdf.uUvFromWorld;

        if (u.uSdfScaleOff instanceof Float32Array && u.uSdfScaleOff.length >= 4 && sdf.uSdfScaleOff4) {
          u.uSdfScaleOff[0] = sdf.uSdfScaleOff4[0];
          u.uSdfScaleOff[1] = sdf.uSdfScaleOff4[1];
          u.uSdfScaleOff[2] = sdf.uSdfScaleOff4[2];
          u.uSdfScaleOff[3] = sdf.uSdfScaleOff4[3];
        } else if ("uSdfScaleOff" in u) {
          u.uSdfScaleOff = sdf.uSdfScaleOff;
        }
        if ("uSdfDecode" in u) u.uSdfDecode = sdf.uSdfScaleOff;

        u.uSdfTexel = uSdfTexel;
        u.uSdfInsideMax = sdf.uSdfInsideMax;

        const raw = Math.max(0, Number(f.options?.fadePercent) || 0);
        const fadeFrac = raw > 1 ? Math.min(1, raw / 100) : Math.min(1, raw);
        if ("uFadePct" in u) u.uFadePct = fadeFrac;
        if ("uUsePct" in u) u.uUsePct = 1.0;
        if ("uFadeWorld" in u) u.uFadeWorld = 0.0;

        u.uEdges = uEdgesArray;
        u.uEdgeCount = edgeCount;
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
      } catch {}

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
      } catch {}
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
        } catch {}
        this._stableRefresh = null;

        try {
          this.forceRegionMaskRefreshAll();
        } catch {}
        return;
      }

      try {
        this._stableRefresh?.();
      } catch {}
    };

    this._stableRefresh = coalesceNextFrame(step, { key: this });

    try {
      this._stableRefresh();
    } catch {}
  }

  _animate() {
    this._rebuiltThisTick = false;

    super._animate();

    let anyBelowTokens = false;
    for (const entry of this.regionMasks.values()) {
      const filters = entry?.filters ?? [];
      if (filters.some((f) => !!f.__fxmBelowTokens) && entry.maskRT && entry.maskCutoutRT) {
        anyBelowTokens = true;
        break;
      }
    }

    if (anyBelowTokens) {
      const r = canvas?.app?.renderer;
      const res = r?.resolution || 1;
      const wt = canvas?.stage?.worldTransform;
      const tx = wt?.tx ?? 0;
      const ty = wt?.ty ?? 0;
      const fx = (((tx * res) % 1) + 1) % 1;
      const fy = (((ty * res) % 1) + 1) % 1;

      const prev = this._lastCutoutCamFrac;
      const fracMoved = !prev || Math.abs(prev.x - fx) > 1e-6 || Math.abs(prev.y - fy) > 1e-6;

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
      for (const entry of this.regionMasks.values()) {
        const list = entry.filters ?? [];
        for (const f of list) {
          if (typeof f?.lockViewport === "function") {
            f.lockViewport({ setDeviceToCss: false, setCamFrac: true });
          }
        }
      }
    } catch {}
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
      } catch {}
    }

    this._gatePassCache.set(placeable.id, pass);
  }
}
