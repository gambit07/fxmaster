/**
 * FXMaster: Utilities
 * Helpers for flags, math, colors, geometry, masks, and render-texture pooling.
 */

import { packageId } from "./constants.js";

/**
 * Reset a namespaced flag on a document, removing stale keys.
 * @param {foundry.abstract.Document} document
 * @param {string} key
 * @param {*} value
 * @returns {Promise<foundry.abstract.Document>}
 */
export async function resetFlag(document, key, value) {
  if (typeof value === "object" && !Array.isArray(value) && value !== null) {
    const oldFlags = document.getFlag(packageId, key);
    const keys = oldFlags ? Object.keys(oldFlags) : [];
    keys.forEach((k) => {
      if (value[k]) return;
      value[`-=${k}`] = null;
    });
  }
  return document.setFlag(packageId, key, value);
}

/**
 * Round a number to a fixed number of decimals.
 * @param {number} number
 * @param {number} decimals
 * @returns {number}
 */
export function roundToDecimals(number, decimals) {
  return Number(Math.round(number + "e" + decimals) + "e-" + decimals);
}

/**
 * Return a copy of an object without a given key.
 * @param {object} object
 * @param {string|number|symbol} key
 * @returns {object}
 */
export function omit(object, key) {
  const { [key]: _omitted, ...rest } = object;
  return rest;
}

/**
 * Resolve module dialog colors from CSS variables.
 * @returns {{baseColor:string, highlightColor:string}}
 */
export function getDialogColors() {
  const rgbColor = getCssVarValue("--color-warm-2");
  const rgbColorHighlight = getCssVarValue("--color-warm-3");
  const baseColor = addAlphaToRgb(rgbColor, 1);
  const highlightColor = addAlphaToRgb(rgbColorHighlight, 1);
  return { baseColor, highlightColor };
}

/**
 * Resolve a CSS variable to a computed color value.
 * @param {string} varName
 * @returns {string}
 * @private
 */
function getCssVarValue(varName) {
  const el = document.createElement("div");
  el.style.color = `var(${varName})`;
  el.style.display = "none";
  document.body.appendChild(el);
  const computed = getComputedStyle(el).color;
  document.body.removeChild(el);
  return computed;
}

/**
 * Convert an rgb() string to rgba() with custom alpha.
 * @param {string} rgbString
 * @param {number} alpha
 * @returns {string}
 * @private
 */
function addAlphaToRgb(rgbString, alpha) {
  const m = rgbString.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
  return m ? `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})` : rgbString;
}

/**
 * Toggle a named particle effect in the current scene.
 * @param {{name:string,type:string,options:object}} parameters
 * @returns {Promise<void>}
 */
export async function onSwitchParticleEffects(parameters) {
  if (!canvas.scene) return;
  const current = canvas.scene.getFlag(packageId, "effects") ?? {};
  const key = `core_${parameters.type}`;
  const disable = key in current;
  const effects = disable
    ? omit(current, key)
    : { ...current, [key]: { type: parameters.type, options: parameters.options } };

  if (Object.keys(effects).length === 0) await canvas.scene.unsetFlag(packageId, "effects");
  else await resetFlag(canvas.scene, "effects", effects);
}

/**
 * Replace current scene particle effects with a new set.
 * @param {Array<object>} parametersArray
 * @returns {Promise<void>}
 */
export async function onUpdateParticleEffects(parametersArray) {
  if (!canvas.scene) return;
  const scene = canvas.scene;
  const old = scene.getFlag(packageId, "effects") || {};
  const added = Object.fromEntries(parametersArray.map((p) => [foundry.utils.randomID(), p]));
  const merged = foundry.utils.mergeObject(old, added, { inplace: false });
  await resetFlag(canvas.scene, "effects", merged);
}

/**
 * Cleanup filter effects for a deleted region.
 * @param {string} regionId
 */
export function cleanupRegionFilterEffects(regionId) {
  try {
    canvas.filtereffects?.destroyRegionFilterEffects?.(regionId);
  } catch {}
}

/**
 * Cleanup particle effects for a deleted region.
 * @param {string} regionId
 */
export function cleanupRegionParticleEffects(regionId) {
  try {
    canvas.particleeffects?.destroyRegionParticleEffects?.(regionId);
  } catch {}
}

/**
 * Parse and cache special FX definitions.
 * @returns {Promise<void>}
 */
export async function parseSpecialEffects() {
  let effectsMap = game.settings.get(packageId, "dbSpecialEffects") || {};
  if (!effectsMap || Object.keys(effectsMap).length === 0) {
    const { registerAnimations } = await import("./animation-files.js");
    effectsMap = await registerAnimations({ initialScan: true });
    await game.settings.set(packageId, "dbSpecialEffects", effectsMap);
  }
  CONFIG.fxmaster.userSpecials = effectsMap;
}

/**
 * Get the renderer pixel rectangle.
 * @returns {PIXI.Rectangle}
 */
export function pixelsArea() {
  const r = canvas?.app?.renderer;
  if (!r) return new PIXI.Rectangle(0, 0, 0, 0);
  const { width, height } = r.view;
  return new PIXI.Rectangle(0, 0, width | 0, height | 0);
}

export const clampRange = (v, lo, hi, def) => (Number.isFinite((v = Number(v))) ? Math.min(Math.max(v, lo), hi) : def);
export const clamp01 = (v, def) => clampRange(v, 0, 1, def);
export const clampNonNeg = (v, def = 0) => (Number.isFinite((v = Number(v))) ? Math.max(0, v) : def);
export const clampMin = (v, m = 1e-4, def) => (Number.isFinite((v = Number(v))) ? Math.max(v, m) : def);
export const num = (v, d = 0) => (v === undefined || v === null || Number.isNaN(Number(v)) ? d : Number(v));
export const asFloat3 = (arr) => new Float32Array([arr[0], arr[1], arr[2]]);

const TAU = Math.PI * 2;

/**
 * Rotate a point around a center by radians.
 * @param {number} px
 * @param {number} py
 * @param {number} cx
 * @param {number} cy
 * @param {number} angleRad
 * @returns {{x:number,y:number}}
 * @private
 */
function rotatePoint(px, py, cx, cy, angleRad) {
  if (!angleRad) return { x: px, y: py };
  const s = Math.sin(angleRad),
    c = Math.cos(angleRad);
  const dx = px - cx,
    dy = py - cy;
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
}

/**
 * Centroid of a set of points.
 * @param {{x:number,y:number}[]} points
 * @returns {{x:number,y:number}}
 * @private
 */
function centroid(points) {
  if (!points?.length) return { x: 0, y: 0 };
  let sx = 0,
    sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / points.length, y: sy / points.length };
}

/**
 * Convert a rotated rectangle to polygon points.
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {number} rotRad
 * @returns {{x:number,y:number}[]}
 * @private
 */
function rectToPolygon(x, y, w, h, rotRad) {
  if (!rotRad)
    return [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ];
  const cx = x + w / 2,
    cy = y + h / 2;
  const corners = [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
  return corners.map((p) => rotatePoint(p.x, p.y, cx, cy, rotRad));
}

/**
 * Approximate a rotated ellipse by a polygon.
 * @param {number} cx
 * @param {number} cy
 * @param {number} rx
 * @param {number} ry
 * @param {number} rotRad
 * @param {number} [segments=48]
 * @returns {{x:number,y:number}[]}
 * @private
 */
function ellipseToPolygon(cx, cy, rx, ry, rotRad, segments = 48) {
  if (!segments || segments < 8) segments = 8;
  const poly = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * TAU;
    const px = cx + rx * Math.cos(a);
    const py = cy + ry * Math.sin(a);
    poly.push(rotRad ? rotatePoint(px, py, cx, cy, rotRad) : { x: px, y: py });
  }
  return poly;
}

/**
 * Trace a region shape into a PIXI.Graphics path.
 * @param {PIXI.Graphics} g
 * @param {object} s
 * @param {{ ellipseSegments?: number }} [opts]
 */
function traceRegionShapePIXI(g, s, opts = {}) {
  const type = s?.type;
  const rotRad = ((s?.rotation || 0) * Math.PI) / 180;
  const ellipseSegments = Number.isFinite(opts.ellipseSegments) ? Math.max(8, opts.ellipseSegments | 0) : 48;

  if (type === "polygon") {
    const pts = s.points ?? [];
    if (!pts.length) return;
    if (!rotRad) {
      g.drawShape(new PIXI.Polygon(pts));
      return;
    }
    const c = centroid(pts);
    const rotPts = pts.map((p) => rotatePoint(p.x, p.y, c.x, c.y, rotRad));
    g.drawShape(new PIXI.Polygon(rotPts));
    return;
  }

  if (type === "ellipse" || type === "circle") {
    const cx = s.x ?? 0,
      cy = s.y ?? 0;
    const rx = Math.max(0, type === "circle" ? s.radius ?? 0 : s.radiusX ?? 0);
    const ry = Math.max(0, type === "circle" ? s.radius ?? 0 : s.radiusY ?? 0);
    if (!rotRad) {
      g.drawEllipse(cx, cy, rx, ry);
      return;
    }
    const poly = ellipseToPolygon(cx, cy, rx, ry, rotRad, ellipseSegments);
    g.drawShape(new PIXI.Polygon(poly));
    return;
  }

  if (type === "rectangle") {
    const x = s.x ?? 0,
      y = s.y ?? 0,
      w = s.width ?? 0,
      h = s.height ?? 0;
    if (!rotRad) {
      g.drawRect(x, y, w, h);
      return;
    }
    const poly = rectToPolygon(x, y, w, h, rotRad);
    g.drawShape(new PIXI.Polygon(poly));
    return;
  }

  if (Array.isArray(s?.points) && s.points.length) {
    g.drawShape(new PIXI.Polygon(s.points));
  }
}

/**
 * Trace a region shape into a Canvas2D path.
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} s
 */
export function traceRegionShapePath2D(ctx, s) {
  const type = s?.type;
  const rotRad = ((s?.rotation || 0) * Math.PI) / 180;

  ctx.save();
  if (rotRad) {
    let cx = 0,
      cy = 0;
    if (type === "polygon") {
      const c = centroid(s.points ?? []);
      cx = c.x;
      cy = c.y;
    } else if (type === "ellipse" || type === "circle") {
      cx = s.x ?? 0;
      cy = s.y ?? 0;
    } else if (type === "rectangle") {
      const x = s.x ?? 0,
        y = s.y ?? 0,
        w = s.width ?? 0,
        h = s.height ?? 0;
      cx = x + w / 2;
      cy = y + h / 2;
    }
    ctx.translate(cx, cy);
    ctx.rotate(rotRad);
    ctx.translate(-cx, -cy);
  }

  if (type === "polygon") {
    const pts = s.points ?? [];
    if (!pts.length) {
      ctx.restore();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.restore();
    return;
  }

  if (type === "ellipse" || type === "circle") {
    const cx = s.x ?? 0,
      cy = s.y ?? 0;
    const rx = Math.max(0, type === "circle" ? s.radius ?? 0 : s.radiusX ?? 0);
    const ry = Math.max(0, type === "circle" ? s.radius ?? 0 : s.radiusY ?? 0);
    ctx.beginPath();
    if (typeof ctx.ellipse === "function") ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU);
    else {
      const pts = ellipseToPolygon(cx, cy, rx, ry, 0, 48);
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
    }
    ctx.restore();
    return;
  }

  if (type === "rectangle") {
    const x = s.x ?? 0,
      y = s.y ?? 0,
      w = s.width ?? 0,
      h = s.height ?? 0;
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.closePath();
    ctx.restore();
    return;
  }

  if (Array.isArray(s?.points) && s.points.length) {
    ctx.beginPath();
    ctx.moveTo(s.points[0].x, s.points[0].y);
    for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
    ctx.closePath();
    ctx.restore();
  }
}

/**
 * Return a pixel-snapped stage matrix.
 * @param {PIXI.Container} [stage]
 * @returns {PIXI.Matrix}
 */
export function snappedStageMatrix(stage = canvas.stage) {
  const M = stage.worldTransform.clone();
  const res = canvas?.app?.renderer?.resolution || 1;
  M.tx = Math.round(M.tx * res) / res;
  M.ty = Math.round(M.ty * res) / res;
  return M;
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
export function ellipseSteps(rx, ry, stageMatrix = canvas.stage.worldTransform) {
  const sx = Math.hypot(stageMatrix.a, stageMatrix.b);
  const sy = Math.hypot(stageMatrix.c, stageMatrix.d);
  const rxS = Math.max(1, rx * sx);
  const ryS = Math.max(1, ry * sy);
  const p = Math.PI * (3 * (rxS + ryS) - Math.sqrt((3 * rxS + ryS) * (rxS + 3 * ryS)));
  return Math.ceil(Math.max(64, Math.min(512, p / 2)));
}

/**
 * Compute world-space AABB of a region's non-hole shapes.
 * @param {PlaceableObject} placeable
 * @returns {{minX:number,minY:number,maxX:number,maxY:number}|null}
 */
export function regionWorldBounds(placeable) {
  const shapes = placeable?.document?.shapes ?? [];
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const include = (x, y) => {
    if (Number.isFinite(x) && Number.isFinite(y)) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  };
  for (const s of shapes) {
    if (s.hole) continue;
    if (s.type === "rectangle") {
      include(s.x, s.y);
      include(s.x + s.width, s.y + s.height);
    } else if (s.type === "ellipse" || s.type === "circle") {
      const rx = Math.max(0, s.type === "circle" ? s.radius ?? 0 : s.radiusX ?? 0);
      const ry = Math.max(0, s.type === "circle" ? s.radius ?? 0 : s.radiusY ?? 0);
      include(s.x - rx, s.y - ry);
      include(s.x + rx, s.y + ry);
    } else {
      const pts = s.points || [];
      if (typeof pts[0] === "object") for (const p of pts) include(p.x, p.y);
      else for (let i = 0; i + 1 < pts.length; i += 2) include(pts[i], pts[i + 1]);
    }
  }
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * Compute a CSS-aligned world AABB (holes ignored).
 * @param {PlaceableObject} placeable
 * @returns {{minX:number,minY:number,maxX:number,maxY:number}|null}
 */
export function regionWorldBoundsAligned(placeable) {
  const Ms = snappedStageMatrix();
  const Minv = Ms.clone().invert();
  const toCss = (x, y) => ({ x: Ms.a * x + Ms.c * y + Ms.tx, y: Ms.b * x + Ms.d * y + Ms.ty });
  const toWorld = (x, y) => ({ x: Minv.a * x + Minv.c * y + Minv.tx, y: Minv.b * x + Minv.d * y + Minv.ty });

  let cssMinX = Infinity,
    cssMinY = Infinity,
    cssMaxX = -Infinity,
    cssMaxY = -Infinity;
  const includeCss = (X, Y) => {
    cssMinX = Math.min(cssMinX, X);
    cssMaxX = Math.max(cssMaxX, X);
    cssMinY = Math.min(cssMinY, Y);
    cssMaxY = Math.max(cssMaxY, Y);
  };

  for (const s of placeable?.document?.shapes ?? []) {
    if (s.hole) continue;
    if (s.type === "rectangle") {
      const a = toCss(s.x, s.y),
        b = toCss(s.x + s.width, s.y),
        c = toCss(s.x + s.width, s.y + s.height),
        d = toCss(s.x, s.y + s.height);
      includeCss(a.x, a.y);
      includeCss(b.x, b.y);
      includeCss(c.x, c.y);
      includeCss(d.x, d.y);
    } else if (s.type === "ellipse" || s.type === "circle") {
      const rx = Math.max(0, s.type === "circle" ? s.radius ?? 0 : s.radiusX ?? 0);
      const ry = Math.max(0, s.type === "circle" ? s.radius ?? 0 : s.radiusY ?? 0);
      const steps = ellipseSteps(rx, ry, Ms);
      for (let i = 0; i < steps; i++) {
        const t = (i / steps) * TAU;
        const p = toCss(s.x + rx * Math.cos(t), s.y + ry * Math.sin(t));
        includeCss(p.x, p.y);
      }
    } else {
      const pts = s.points || [];
      if (typeof pts[0] === "object")
        for (const p of pts) {
          const q = toCss(p.x, p.y);
          includeCss(q.x, q.y);
        }
      else
        for (let i = 0; i + 1 < pts.length; i += 2) {
          const q = toCss(pts[i], pts[i + 1]);
          includeCss(q.x, q.y);
        }
    }
  }
  if (!Number.isFinite(cssMinX)) return null;
  const wTL = toWorld(cssMinX, cssMinY),
    wTR = toWorld(cssMaxX, cssMinY),
    wBR = toWorld(cssMaxX, cssMaxY),
    wBL = toWorld(cssMinX, cssMaxY);
  const eps = 1e-3;
  return {
    minX: Math.min(wTL.x, wTR.x, wBR.x, wBL.x) + eps,
    minY: Math.min(wTL.y, wTR.y, wBR.y, wBL.y) + eps,
    maxX: Math.max(wTL.x, wTR.x, wBR.x, wBL.x) - eps,
    maxY: Math.max(wTL.y, wTR.y, wBR.y, wBL.y) - eps,
  };
}

/**
 * Convert bounds to a rectangle object.
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} rb
 * @returns {{x:number,y:number,width:number,height:number}}
 */
export function rectFromAligned(rb) {
  const x = rb.minX,
    y = rb.minY,
    w = rb.maxX - rb.minX,
    h = rb.maxY - rb.minY;
  if (!(w > 0 && h > 0)) throw new Error("invalid bounds");
  return { x, y, width: w, height: h };
}

/**
 * Compute a rectangle from raw shapes.
 * @param {Array<object>} shapes
 * @returns {{x:number,y:number,width:number,height:number}}
 */
export function rectFromShapes(shapes) {
  const b = regionWorldBounds({ document: { shapes } });
  if (!b) throw new Error("no shapes");
  return { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY };
}

/**
 * Build polygon edges (Ax,Ay,Bx,By)* for SDF or fades.
 * @param {PlaceableObject} placeable
 * @returns {Float32Array}
 */
export function buildPolygonEdges(placeable) {
  const out = [];
  for (const s of placeable?.document?.shapes ?? []) {
    if (s.type !== "polygon") continue;
    const pts = s.points || [];
    if (!pts.length) continue;
    if (typeof pts[0] === "object") {
      const n = pts.length;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        out.push(pts[i].x, pts[i].y, pts[j].x, pts[j].y);
      }
    } else {
      const n = (pts.length / 2) | 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        out.push(pts[2 * i], pts[2 * i + 1], pts[2 * j], pts[2 * j + 1]);
      }
    }
  }
  return new Float32Array(out);
}

/**
 * Determine if a region has multiple non-hole shapes.
 * @param {PlaceableObject} placeable
 * @returns {boolean}
 */
export function hasMultipleNonHoleShapes(placeable) {
  let n = 0;
  for (const s of placeable?.document?.shapes ?? []) {
    if (s?.hole) continue;
    if (s.type === "rectangle" || s.type === "ellipse" || s.type === "circle" || s.type === "polygon")
      if (++n > 1) return true;
  }
  return false;
}

/**
 * Convert a percentage to a world fade width based on region min-side.
 * @param {PlaceableObject} placeable
 * @param {number} pctLike
 * @returns {number}
 */
export function edgeFadeWorldWidth(placeable, pctLike) {
  const b = regionWorldBounds(placeable) ?? regionWorldBoundsAligned(placeable);
  if (!b) return 1e-6;
  const w = Math.max(1e-6, b.maxX - b.minX);
  const h = Math.max(1e-6, b.maxY - b.minY);
  const frac = Math.max(0, Number(pctLike) || 0);
  const f = frac > 1 ? Math.min(1, frac / 100) : frac;
  return Math.max(1e-6, Math.min(w, h) * f);
}

/**
 * Get the event gate settings for a region behavior.
 * @param {PlaceableObject} placeable
 * @param {string} behaviorType
 * @returns {{mode:string,latched:boolean}}
 */
export function getEventGate(placeable, behaviorType) {
  const fxBeh = placeable?.document?.behaviors?.find((b) => b.type === behaviorType && !b.disabled);
  if (!fxBeh) return { mode: "none", latched: false };
  const eg = fxBeh.getFlag?.("fxmaster", "eventGate");
  return { mode: eg?.mode ?? "none", latched: !!eg?.latched };
}

/**
 * Get the elevation window for a region.
 * @param {foundry.abstract.Document} doc
 * @returns {{min:number,max:number}|null}
 */
export function getRegionElevationWindow(doc) {
  const top = doc?.elevation?.top,
    bottom = doc?.elevation?.bottom;
  const hasTop = top !== undefined && top !== null && `${top}`.trim() !== "";
  const hasBottom = bottom !== undefined && bottom !== null && `${bottom}`.trim() !== "";
  if (!hasTop && !hasBottom) return null;
  return { min: hasBottom ? Number(bottom) : -Infinity, max: hasTop ? Number(top) : +Infinity };
}

/**
 * Test whether an elevation lies within a window.
 * @param {number} elev
 * @param {{min:number,max:number}} win
 * @returns {boolean}
 */
export const inRangeElev = (elev, win) => elev >= win.min && elev <= win.max;

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
        } catch {}
      }
    } catch {
      try {
        rt.destroy(true);
      } catch {}
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
          } catch {}
    } finally {
      this._pool.clear();
    }
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

    if (respectOcc && _isTokenOccludedByOverhead(t)) continue;
    if (shouldInclude && !shouldInclude(t)) continue;

    const icon = t.icon ?? t.mesh ?? t;
    const tex = icon?.texture;
    if (!tex?.baseTexture?.valid) continue;

    const spr = new PIXI.Sprite(tex);
    try {
      spr.anchor.set(icon.anchor?.x ?? 0.5, icon.anchor?.y ?? 0.5);
    } catch {}
    try {
      const stageLocal = stageLocalMatrixOf(icon);
      spr.transform.setFromMatrix(stageLocal);
    } catch {
      try {
        spr.destroy(true);
      } catch {}
      continue;
    }
    out.push(spr);
  }
  return out;
}

export function stageLocalMatrixOf(displayObject) {
  const chain = [];
  let obj = displayObject;
  while (obj && obj !== canvas.stage) {
    chain.push(obj);
    obj = obj.parent;
  }
  const M = new PIXI.Matrix();
  for (let i = chain.length - 1; i >= 0; i--) {
    const lt = chain[i]?.transform?.localTransform || PIXI.Matrix.IDENTITY;
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

  r.render(new PIXI.Sprite(baseRT), { renderTexture: out, clear: true });

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
  try {
    c.destroy({ children: true, texture: false, baseTexture: false });
  } catch {}

  try {
    out.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
    out.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
  } catch {}
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

  const r = canvas?.app?.renderer;
  const res = r?.resolution || 1;
  const cssW = Math.max(1, ((r?.view?.width ?? r?.screen?.width) / res) | 0);
  const cssH = Math.max(1, ((r?.view?.height ?? r?.screen?.height) / res) | 0);
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
  try {
    cont.destroy({ children: true, texture: false, baseTexture: false });
  } catch {}
}

/**
 * Return a non-null texture suitable for sprite masks.
 * @param {PIXI.Texture|PIXI.RenderTexture|null} tex
 * @returns {PIXI.Texture|PIXI.RenderTexture}
 */
export function safeMaskTexture(tex) {
  return tex ?? PIXI.Texture.WHITE;
}

/**
 * Build a CSS-space alpha mask RenderTexture for a region.
 * White = inside (allowed), transparent = outside (suppressed).
 * - Camera-aligned via snappedStageMatrix() to avoid seams.
 * - Renders solids first, then ERASEs holes.
 * - Uses the provided RTPool when available.
 *
 * @param {PlaceableObject} region
 * @param {{rtPool?: import('./utils.js').RTPool, resolution?: number}} [opts]
 * @returns {PIXI.RenderTexture}
 */
export function buildRegionMaskRT(region, { rtPool, resolution } = {}) {
  const r = canvas?.app?.renderer;
  const screen = r?.screen ?? r?.view ?? { width: 1, height: 1 };
  const VW = Math.max(1, screen.width | 0);
  const VH = Math.max(1, screen.height | 0);

  const gl = r?.gl;
  const MAX_GL = gl?.getParameter?.(gl.MAX_TEXTURE_SIZE) || 8192;
  const res = resolution ?? Math.min(r?.resolution || 1, MAX_GL / Math.max(VW, VH));

  const rt = rtPool
    ? rtPool.acquire(VW, VH, res)
    : PIXI.RenderTexture.create({ width: VW, height: VH, resolution: res });

  const solidsGfx = new PIXI.Graphics();
  const holesGfx = new PIXI.Graphics();

  const M = snappedStageMatrix();
  solidsGfx.transform.setFromMatrix(M);
  holesGfx.transform.setFromMatrix(M);

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
  holesGfx.blendMode = PIXI.BLEND_MODES.ERASE;

  r.render(solidsGfx, { renderTexture: rt, clear: true });
  r.render(holesGfx, { renderTexture: rt, clear: false });

  try {
    rt.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
    rt.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
  } catch {}

  try {
    solidsGfx.destroy(true);
  } catch {}
  try {
    holesGfx.destroy(true);
  } catch {}

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
  try {
    container.updateTransform();
  } catch {}
  const Minv = container.worldTransform.clone().invert();
  const res = canvas?.app?.renderer?.resolution || 1;
  Minv.tx = Math.round(Minv.tx * res) / res;
  Minv.ty = Math.round(Minv.ty * res) / res;
  spr.transform.setFromMatrix(Minv);
  spr.roundPixels = false;
  container.roundPixels = false;
}

/**
 * Compute whether a region should be "passed through" by elevation + viewer-gating.
 *
 * @param {PlaceableObject} placeable
 * @param {{behaviorType:string}} options
 *   - behaviorType: e.g. `${packageId}.particleEffectsRegion` or `${packageId}.filterEffectsRegion`
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
 * Coalesce calls to the next animation frame.
 * Multiple invocations within the same frame result in a single callback,
 * executed with the latest arguments and the last call-site `this`.
 *
 * Usage:
 *   const oncePerFrame = coalesceNextFrame(fn, { key: "unique-key" });
 *   oncePerFrame(arg1, arg2);
 *   oncePerFrame.cancel();  // optional
 *   oncePerFrame.flush();   // optional - run immediately if pending
 *
 * @template {(...args:any[]) => any} F
 * @param {F} fn - The function to call once per frame.
 * @param {{ key?: any }} [opts] - Optional grouping key for coalescing.
 * @returns {F & { cancel: () => void, flush: () => void }}
 */
export function coalesceNextFrame(fn, { key } = {}) {
  const stateMap = (coalesceNextFrame._map ??= new Map());
  const k = key ?? fn;

  const getState = () => {
    let s = stateMap.get(k);
    if (!s) {
      s = { raf: null, args: null, ctx: null, pending: false };
      stateMap.set(k, s);
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

  wrapper.cancel = () => {
    const s = getState();
    if (s.raf != null) {
      try {
        const cancel = globalThis.cancelAnimationFrame ?? clearTimeout;
        cancel(s.raf);
      } catch {}
      s.raf = null;
    }
    s.pending = false;
    s.args = s.ctx = null;
  };

  wrapper.flush = () => {
    const s = getState();
    if (!s.pending) return;
    if (s.raf != null) {
      try {
        const cancel = globalThis.cancelAnimationFrame ?? clearTimeout;
        cancel(s.raf);
      } catch {}
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

/**
 * Paint the scene "allow mask" (white=allow, black=suppress) into the given RT.
 * - Fills the scene rect in white.
 * - Subtracts suppression-region solids (ERASE).
 * - Adds back region holes (normal blend).
 *
 * @param {PIXI.RenderTexture} rt
 * @param {{ regions?: PlaceableObject[] }} [opts]
 */
export function paintSceneAllowMaskInto(rt, { regions = [] } = {}) {
  const r = canvas?.app?.renderer;
  if (!r || !rt) return;

  const screenW = Math.max(1, rt.width | 0);
  const screenH = Math.max(1, rt.height | 0);

  {
    const bg = new PIXI.Graphics();
    bg.beginFill(0x000000, 1).drawRect(0, 0, screenW, screenH).endFill();
    r.render(bg, { renderTexture: rt, clear: true });
    try {
      bg.destroy(true);
    } catch {}
  }

  const camM = snappedStageMatrix(canvas.regions ?? canvas.stage);

  {
    const dims = canvas.scene?.dimensions;
    const rect = dims?.sceneRect;
    if (rect) {
      const g = new PIXI.Graphics();
      g.transform.setFromMatrix(camM);
      g.beginFill(0xffffff, 1)
        .drawRect(rect.x | 0, rect.y | 0, rect.width | 0, rect.height | 0)
        .endFill();
      r.render(g, { renderTexture: rt, clear: false });
      try {
        g.destroy(true);
      } catch {}
    }
  }

  if (Array.isArray(regions) && regions.length) {
    const solidsGfx = new PIXI.Graphics();
    solidsGfx.transform.setFromMatrix(camM);
    const holesGfx = new PIXI.Graphics();
    holesGfx.transform.setFromMatrix(camM);

    solidsGfx.beginFill(0xffffff, 1);
    holesGfx.beginFill(0xffffff, 1);

    for (const region of regions) {
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

    try {
      solidsGfx.destroy(true);
    } catch {}
    try {
      holesGfx.destroy(true);
    } catch {}
  }

  try {
    rt.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
    rt.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
  } catch {}
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
    } catch {}
    cutoutRT = PIXI.RenderTexture.create({ width: W, height: H, resolution: res, multisample: 0 });
  }
  composeMaskMinusTokens(baseRT, { outRT: cutoutRT });
  try {
    cutoutRT.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
    cutoutRT.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
  } catch {}

  let tokensMaskRT = state.tokensMaskRT;
  const tokensBad =
    !tokensMaskRT || tokensMaskRT.width !== W || tokensMaskRT.height !== H || (tokensMaskRT.resolution || 1) !== res;
  if (tokensBad) {
    try {
      tokensMaskRT?.destroy(true);
    } catch {}
    tokensMaskRT = PIXI.RenderTexture.create({ width: W, height: H, resolution: res, multisample: 0 });
  }
  repaintTokensMaskInto(tokensMaskRT);
  try {
    tokensMaskRT.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
    tokensMaskRT.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
  } catch {}

  return { cutoutRT, tokensMaskRT };
}

/**
 * Apply scene-mask uniforms to a list of FXMaster filters.
 * Honors per-filter "belowTokens" option by swapping the sampler and providing token silhouettes.
 * @param {PIXI.Filter[]} filters
 * @param {{
 *   baseMaskRT: PIXI.RenderTexture,
 *   cutoutRT?: PIXI.RenderTexture|null,
 *   tokensMaskRT?: PIXI.RenderTexture|null,
 *   cssW: number,
 *   cssH: number,
 *   deviceToCss: number
 * }} cfg
 */
export function applyMaskUniformsToFilters(
  filters,
  { baseMaskRT, cutoutRT = null, tokensMaskRT = null, cssW, cssH, deviceToCss },
) {
  for (const f of filters) {
    if (!f) continue;
    const u = f.uniforms || {};
    const wantBelow = !!(f?.__fxmBelowTokens ?? f?.options?.belowTokens);
    const rt = wantBelow ? cutoutRT || baseMaskRT : baseMaskRT;

    if ("maskSampler" in u) u.maskSampler = rt;
    if ("hasMask" in u) u.hasMask = rt ? 1.0 : 0.0;
    if ("maskReady" in u) u.maskReady = rt ? 1.0 : 0.0;

    if ("viewSize" in u) {
      u.viewSize =
        u.viewSize instanceof Float32Array && u.viewSize.length >= 2
          ? ((u.viewSize[0] = cssW), (u.viewSize[1] = cssH), u.viewSize)
          : new Float32Array([cssW, cssH]);
    }
    if ("deviceToCss" in u) u.deviceToCss = deviceToCss;

    if (wantBelow && tokensMaskRT) {
      if ("tokenSampler" in u) u.tokenSampler = tokensMaskRT;
      if ("hasTokenMask" in u) u.hasTokenMask = 1.0;
    } else {
      if ("hasTokenMask" in u) u.hasTokenMask = 0.0;
    }
  }
}

/**
 * Return viewport metrics in CSS pixels.
 * @returns {{cssW:number, cssH:number, deviceToCss:number, rect: PIXI.Rectangle}}
 */
export function getCssViewportMetrics() {
  const r = globalThis.canvas?.app?.renderer;
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
 * Build (or reuse) a CSS-space allow-mask RT for the current scene view,
 * then paint the scene-rect minus suppression regions into it.
 *
 * White = allow, transparent = suppress.
 *
 * @param {{ regions?: PlaceableObject[], reuseRT?: PIXI.RenderTexture|null }} [opts]
 * @returns {PIXI.RenderTexture|null}
 */
export function buildSceneAllowMaskRT({ regions = [], reuseRT = null } = {}) {
  const r = canvas?.app?.renderer;
  if (!r) return null;

  const cssW = Math.max(1, r.screen?.width | 0 || 1);
  const cssH = Math.max(1, r.screen?.height | 0 || 1);

  const gl = r.gl;
  const MAX = gl?.getParameter?.(gl.MAX_TEXTURE_SIZE) || 8192;
  const res = Math.min(r.resolution || 1, MAX / Math.max(cssW, cssH));

  let rt = reuseRT ?? null;
  const needsNew = !rt || (rt.width | 0) !== cssW || (rt.height | 0) !== cssH || (rt.resolution || 1) !== res;

  if (needsNew) {
    try {
      reuseRT?.destroy(true);
    } catch {}
    rt = PIXI.RenderTexture.create({ width: cssW, height: cssH, resolution: res, multisample: 0 });
    try {
      rt.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
      rt.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
    } catch {}
  }

  paintSceneAllowMaskInto(rt, { regions });

  return rt;
}

/**
 * Subtract dynamic token rings from a render texture via DST_OUT.
 * Safe: temporarily flips mesh.blendMode and restores it.
 * @param {PIXI.RenderTexture} outRT
 */
export function subtractDynamicRingsFromRT(outRT) {
  const r = canvas?.app?.renderer;
  if (!r || !outRT) return;
  for (const t of canvas.tokens?.placeables ?? []) {
    if (!t?.visible || t.document?.hidden) continue;
    if (!t?.mesh || !t?.hasDynamicRing) continue;
    const oldBM = t.mesh.blendMode;
    const oldAlph = t.mesh.worldAlpha;
    try {
      t.mesh.blendMode = PIXI.BLEND_MODES.DST_OUT;
      t.mesh.worldAlpha = 1;
      r.render(t.mesh, { renderTexture: outRT, clear: false, skipUpdateTransform: false });
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
  for (const t of canvas.tokens?.placeables ?? []) {
    if (!t?.visible || t.document?.hidden) continue;
    if (!t?.mesh || !t?.hasDynamicRing) continue;
    const oldBM = t.mesh.blendMode;
    const oldAlph = t.mesh.worldAlpha;
    try {
      t.mesh.blendMode = PIXI.BLEND_MODES.NORMAL;
      t.mesh.worldAlpha = 1;
      r.render(t.mesh, { renderTexture: outRT, clear: false, skipUpdateTransform: false });
    } finally {
      t.mesh.blendMode = oldBM;
      t.mesh.worldAlpha = oldAlph;
    }
  }
}
