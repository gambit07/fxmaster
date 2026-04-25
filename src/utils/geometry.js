/**
 * FXMaster: Geometry Utilities
 *
 * Region shape tracing (PIXI and Canvas2D), polygon edge building, world-space bounds computation, signed-distance helpers, and inradius estimation for the filter-effects edge-fade pipeline.
 */

import { ellipseSteps, snappedStageMatrix } from "./viewport.js";
import { logger } from "../logger.js";
/** Circle constant (`2π`). */
export const TAU = Math.PI * 2;

/**
 * Rotate a point around a center by radians.
 * @param {number} px
 * @param {number} py
 * @param {number} cx
 * @param {number} cy
 * @param {number} angleRad
 * @returns {{x:number,y:number}}
 */
export function rotatePoint(px, py, cx, cy, angleRad) {
  if (!angleRad) return { x: px, y: py };
  const s = Math.sin(angleRad),
    c = Math.cos(angleRad);
  const dx = px - cx,
    dy = py - cy;
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
}

/**
 * Compute the centroid of a point set. Accepts either an array of `{x, y}` points or a flat number array.
 * @param {Array<{x:number,y:number}>|number[]} points
 * @returns {{x:number,y:number}}
 */
export function centroid(points) {
  if (!points?.length) return { x: 0, y: 0 };

  if (typeof points[0] === "number") {
    const n = (points.length / 2) | 0;
    if (n <= 0) return { x: 0, y: 0 };
    let sx = 0,
      sy = 0;
    for (let i = 0; i < n; i++) {
      sx += points[2 * i];
      sy += points[2 * i + 1];
    }
    return { x: sx / n, y: sy / n };
  }

  let sx = 0,
    sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / points.length, y: sy / points.length };
}

/**
 * Convert a rectangle into polygon corner points, optionally rotated about its center.
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {number} rotRad
 * @returns {{x:number,y:number}[]}
 */
export function rectToPolygon(x, y, w, h, rotRad) {
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
 * Approximate an ellipse with polygon points, optionally rotated about its center.
 * @param {number} cx
 * @param {number} cy
 * @param {number} rx
 * @param {number} ry
 * @param {number} rotRad
 * @param {number} [segments=48]
 * @returns {{x:number,y:number}[]}
 */
export function ellipseToPolygon(cx, cy, rx, ry, rotRad, segments = 48) {
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
 * @returns {void}
 */
export function traceRegionShapePIXI(g, s, opts = {}) {
  if (!g || !s) return;

  if (typeof s.drawShape === "function") {
    try {
      s.drawShape(g);
      return;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  if (Array.isArray(s?.polygons) && s.polygons.length) {
    for (const poly of s.polygons) {
      if (!poly) continue;
      g.drawShape(poly);
    }
    return;
  }

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
    /**
     * Region polygons may represent points as either an array of {x, y} objects or as a flat number array [x0, y0, x1, y1, ...].
     */
    if (typeof pts[0] === "number") {
      const rotFlat = [];
      for (let i = 0; i + 1 < pts.length; i += 2) {
        const rp = rotatePoint(pts[i], pts[i + 1], c.x, c.y, rotRad);
        rotFlat.push(rp.x, rp.y);
      }
      g.drawShape(new PIXI.Polygon(rotFlat));
      return;
    }
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
 * @returns {void}
 */
export function traceRegionShapePath2D(ctx, s) {
  if (!ctx || !s) return;

  const polys = s?.polygons;
  if (Array.isArray(polys) && polys.length) {
    for (const poly of polys) {
      const pts = poly?.points ?? poly;
      if (!pts || pts.length < 6) continue;
      ctx.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
      ctx.closePath();
    }
    return;
  }

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
    /**
     * Region polygons may represent points as either an array of {x, y} objects or as a flat number array [x0, y0, x1, y1, ...].
     */
    if (typeof pts[0] === "number") {
      if (pts.length < 4) {
        ctx.restore();
        return;
      }
      ctx.moveTo(pts[0], pts[1]);
      for (let i = 2; i + 1 < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
    } else {
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    }
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
    const pts = s.points;
    ctx.beginPath();
    if (typeof pts[0] === "number") {
      if (pts.length >= 4) {
        ctx.moveTo(pts[0], pts[1]);
        for (let i = 2; i + 1 < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
      }
    } else {
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    }
    ctx.closePath();
    ctx.restore();
  }
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
    if (!s || s.hole) continue;

    const b = s?.bounds;
    if (b && Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.width) && Number.isFinite(b.height)) {
      include(b.x, b.y);
      include(b.x + b.width, b.y + b.height);
      continue;
    }

    const polys = s?.polygons;
    if (Array.isArray(polys) && polys.length) {
      for (const poly of polys) {
        const pts = poly?.points ?? poly;
        if (!pts || pts.length < 2) continue;
        for (let i = 0; i + 1 < pts.length; i += 2) include(pts[i], pts[i + 1]);
      }
      continue;
    }

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
    if (!s || s.hole) continue;

    const b = s?.bounds;
    if (b && Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.width) && Number.isFinite(b.height)) {
      const a = toCss(b.x, b.y);
      const b2 = toCss(b.x + b.width, b.y);
      const c = toCss(b.x + b.width, b.y + b.height);
      const d = toCss(b.x, b.y + b.height);
      includeCss(a.x, a.y);
      includeCss(b2.x, b2.y);
      includeCss(c.x, c.y);
      includeCss(d.x, d.y);
      continue;
    }

    const polys = s?.polygons;
    if (Array.isArray(polys) && polys.length) {
      for (const poly of polys) {
        const pts = poly?.points ?? poly;
        if (!pts || pts.length < 2) continue;
        for (let i = 0; i + 1 < pts.length; i += 2) {
          const q = toCss(pts[i], pts[i + 1]);
          includeCss(q.x, q.y);
        }
      }
      continue;
    }
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
 * Build polygon edges `(Ax, Ay, Bx, By)*` for SDF or edge-fade sampling.
 * @param {PlaceableObject} placeable
 * @param {{maxEdges?: number}} [opts]
 * @returns {Float32Array}
 */
export function buildPolygonEdges(placeable, { maxEdges = Infinity } = {}) {
  const polys = [];

  const toFlat = (pts) => {
    if (!pts) return null;

    if (typeof pts[0] === "number") return Array.from(pts);
    if (typeof pts[0] === "object") {
      const out = [];
      for (const p of pts) {
        if (!p) continue;
        out.push(p.x, p.y);
      }
      return out;
    }
    return null;
  };

  const normalizeFlat = (flat) => {
    if (!Array.isArray(flat) || flat.length < 6) return null;
    const n = (flat.length / 2) | 0;
    if (n < 3) return null;

    let m = n;

    const lx = flat[2 * (n - 1)];
    const ly = flat[2 * (n - 1) + 1];
    if (lx === flat[0] && ly === flat[1]) m = n - 1;
    if (m < 3) return null;

    return flat.slice(0, m * 2);
  };

  const addPoly = (pts) => {
    const flat = normalizeFlat(toFlat(pts));
    if (!flat) return;
    const m = (flat.length / 2) | 0;
    polys.push({ flat, m });
  };

  const isEmptyShape = (s) => {
    try {
      if (typeof s?.isEmpty === "function") return !!s.isEmpty();
      return !!s?.isEmpty;
    } catch {
      return false;
    }
  };

  for (const s of placeable?.document?.shapes ?? []) {
    if (!s) continue;
    if (isEmptyShape(s)) continue;

    if (Array.isArray(s?.polygons) && s.polygons.length) {
      for (const poly of s.polygons) {
        if (!poly) continue;
        addPoly(poly?.points ?? poly);
      }
      continue;
    }

    const type = s?.type;
    const rotRad = ((s?.rotation || 0) * Math.PI) / 180;

    if (type === "polygon") {
      const pts = s.points ?? [];
      if (!pts?.length) continue;
      if (!rotRad) {
        addPoly(pts);
        continue;
      }

      if (typeof pts[0] === "object") {
        const c = centroid(pts);
        const rotPts = pts.map((p) => rotatePoint(p.x, p.y, c.x, c.y, rotRad));
        addPoly(rotPts);
      } else {
        const c = centroid(pts);
        const rotPts = [];
        const n = (pts.length / 2) | 0;
        for (let i = 0; i < n; i++) {
          const rp = rotatePoint(pts[2 * i], pts[2 * i + 1], c.x, c.y, rotRad);
          rotPts.push(rp);
        }
        addPoly(rotPts);
      }
      continue;
    }

    if (type === "rectangle") {
      const x = s.x ?? 0,
        y = s.y ?? 0,
        w = s.width ?? 0,
        h = s.height ?? 0;
      addPoly(rectToPolygon(x, y, w, h, rotRad));
      continue;
    }

    if (type === "ellipse" || type === "circle") {
      const cx = s.x ?? 0,
        cy = s.y ?? 0;
      const rx = Math.max(0, type === "circle" ? s.radius ?? 0 : s.radiusX ?? 0);
      const ry = Math.max(0, type === "circle" ? s.radius ?? 0 : s.radiusY ?? 0);
      addPoly(ellipseToPolygon(cx, cy, rx, ry, rotRad, 48));
      continue;
    }

    if (Array.isArray(s?.points) && s.points.length) addPoly(s.points);
  }

  if (!polys.length) return new Float32Array();

  const totalEdges = polys.reduce((a, p) => a + p.m, 0) || 0;
  if (totalEdges <= 0) return new Float32Array();

  let cap = Number(maxEdges);
  if (!Number.isFinite(cap) || cap <= 0) cap = totalEdges;
  cap = Math.min(totalEdges, cap);

  const polyCount = polys.length;
  let minPer = 3;
  if (polyCount * minPer > cap) minPer = 2;
  if (polyCount * minPer > cap) minPer = 1;

  const alloc = polys.map((p) => {
    const share = (cap * p.m) / totalEdges;
    let a = Math.round(share);
    a = Math.max(minPer, a);
    a = Math.min(p.m, a);
    return a;
  });

  let sumAlloc = alloc.reduce((a, b) => a + b, 0);

  while (sumAlloc > cap) {
    let idx = -1;
    let best = -1;
    for (let i = 0; i < alloc.length; i++) {
      const slack = alloc[i] - minPer;
      if (slack > best) {
        best = slack;
        idx = i;
      }
    }
    if (idx < 0 || alloc[idx] <= minPer) break;
    alloc[idx] -= 1;
    sumAlloc -= 1;
  }

  while (sumAlloc < cap) {
    let idx = -1;
    let bestScore = -1;
    for (let i = 0; i < alloc.length; i++) {
      if (alloc[i] >= polys[i].m) continue;

      const score = polys[i].m / Math.max(1, alloc[i]);
      if (score > bestScore) {
        bestScore = score;
        idx = i;
      }
    }
    if (idx < 0) break;
    alloc[idx] += 1;
    sumAlloc += 1;
  }

  const edges = [];

  const emitEdges = (flat, m, want) => {
    if (m < 2 || want < 2) return;

    let idxs;
    if (want >= m) {
      idxs = Array.from({ length: m }, (_, i) => i);
    } else {
      idxs = [];
      const step = m / want;
      let last = -1;
      for (let i = 0; i < want; i++) {
        let k = Math.floor(i * step);
        if (k <= last) k = last + 1;
        if (k >= m) k = m - 1;
        idxs.push(k);
        last = k;
      }

      if (idxs.length >= 2 && idxs[0] == idxs[idxs.length - 1]) idxs.pop();
      if (idxs.length < 2) return;
    }

    const L = idxs.length;
    for (let i = 0; i < L; i++) {
      const a = idxs[i];
      const b = idxs[(i + 1) % L];
      edges.push(flat[2 * a], flat[2 * a + 1], flat[2 * b], flat[2 * b + 1]);
    }
  };

  for (let i = 0; i < polys.length; i++) {
    emitEdges(polys[i].flat, polys[i].m, alloc[i]);
  }

  return new Float32Array(edges);
}

/**
 * Determine if a region has multiple non-hole shapes.
 * @param {PlaceableObject} placeable
 * @returns {boolean}
 */
export function hasMultipleNonHoleShapes(placeable) {
  let n = 0;
  for (const s of placeable?.document?.shapes ?? []) {
    if (!s || s.hole) continue;

    const empty = typeof s.isEmpty === "function" ? s.isEmpty() : !!s.isEmpty;
    if (empty) continue;
    if (!s.type) continue;
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
 * Estimate the maximum interior distance ("inradius") for a single region shape.
 *
 * This value is used to scale Edge Fade % for polygon-based shapes where there's no cheap analytic inradius (e.g. line, cone, ring, emanation, token, polygon).
 *
 * The estimate is intentionally conservative, because an over-estimate can cause Edge Fade % to completely fade out small shapes.
 *
 * @param {object} shape
 * @returns {number}
 */
export function estimateShapeInradiusWorld(shape) {
  if (!shape) return 0;

  const raw = shape;
  const data = typeof raw?.toObject === "function" ? raw.toObject() : raw;
  const type = raw?.type ?? data?.type;

  const num = (v, d = NaN) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const pos = (v) => {
    const n = num(v);
    return Number.isFinite(n) ? Math.max(0, n) : NaN;
  };

  const b = raw?.bounds ?? data?.bounds;
  const bw = Number.isFinite(b?.width) ? Math.max(0, b.width) : NaN;
  const bh = Number.isFinite(b?.height) ? Math.max(0, b.height) : NaN;
  const minSide = Number.isFinite(bw) && Number.isFinite(bh) ? Math.min(bw, bh) : NaN;

  if (type === "circle") {
    const r = pos(raw?.radius ?? data?.radius);
    if (Number.isFinite(r)) return r;
    if (Number.isFinite(minSide)) return 0.5 * minSide;
  }
  if (type === "ellipse") {
    const rx = pos(raw?.radiusX ?? data?.radiusX);
    const ry = pos(raw?.radiusY ?? data?.radiusY);
    if (Number.isFinite(rx) && Number.isFinite(ry)) return Math.min(rx, ry);
    if (Number.isFinite(minSide)) return 0.25 * minSide;
  }
  if (type === "rectangle" || type === "token") {
    const w = pos(raw?.width ?? data?.width);
    const h = pos(raw?.height ?? data?.height);
    if (Number.isFinite(w) && Number.isFinite(h)) return 0.5 * Math.min(w, h);
    if (Number.isFinite(minSide)) return 0.5 * minSide;
  }

  if (type === "ring") {
    const thick = pos(raw?.width ?? data?.width ?? raw?.thickness ?? data?.thickness);
    if (Number.isFinite(thick) && thick > 0) return 0.5 * thick;

    const outer = pos(raw?.outerRadius ?? data?.outerRadius ?? raw?.radius ?? data?.radius);
    const inner = pos(raw?.innerRadius ?? data?.innerRadius);
    if (Number.isFinite(outer) && Number.isFinite(inner)) return Math.max(0, 0.5 * (outer - inner));

    const R = Number.isFinite(outer) ? outer : Number.isFinite(minSide) ? 0.5 * minSide : NaN;
    const A = pos(raw?.area ?? data?.area);
    if (Number.isFinite(R) && Number.isFinite(A) && A > 0) {
      const ri2 = Math.max(0, R * R - A / Math.PI);
      const ri = Math.sqrt(ri2);
      return Math.max(0, 0.5 * (R - ri));
    }

    if (Number.isFinite(minSide)) return 0.125 * minSide;
  }

  if (type === "line") {
    const A = pos(raw?.area ?? data?.area);

    const thick = pos(raw?.width ?? data?.width ?? raw?.thickness ?? data?.thickness);
    if (Number.isFinite(thick) && thick > 0) return 0.5 * thick;

    const L = pos(raw?.length ?? data?.length ?? raw?.distance ?? data?.distance);
    const major = Number.isFinite(bw) && Number.isFinite(bh) ? Math.max(bw, bh) : NaN;
    const len = Number.isFinite(L) && L > 0 ? L : major;
    if (Number.isFinite(A) && A > 0 && Number.isFinite(len) && len > 0) {
      const approxT = A / len;
      if (Number.isFinite(approxT) && approxT > 0) return 0.5 * approxT;
    }

    if (Number.isFinite(minSide)) return 0.5 * minSide;
  }

  if (type === "cone") {
    const R = pos(raw?.radius ?? data?.radius ?? raw?.distance ?? data?.distance);
    const angleDeg = pos(raw?.angle ?? data?.angle);
    if (Number.isFinite(R) && Number.isFinite(angleDeg) && angleDeg > 0) {
      const theta = (angleDeg * Math.PI) / 180;
      const s = Math.sin(theta / 2);
      const rin = (R * s) / (1 + s);
      if (Number.isFinite(rin) && rin > 0) return rin;
    }
    if (Number.isFinite(minSide)) return 0.25 * minSide;
  }

  if (type === "emanation") {
    const base = raw?.shape ?? raw?.base ?? raw?.sourceShape ?? raw?.source ?? data?.shape ?? data?.base;
    const dist = pos(raw?.distance ?? data?.distance ?? raw?.padding ?? data?.padding ?? raw?.offset ?? data?.offset);
    if (base && Number.isFinite(dist)) {
      const r0 = estimateShapeInradiusWorld(base);
      if (Number.isFinite(r0) && r0 > 0) return r0 + dist;
    }
    if (Number.isFinite(minSide)) return 0.25 * minSide;
  }

  if (Number.isFinite(minSide)) return 0.25 * minSide;

  const w = pos(raw?.width ?? data?.width);
  const h = pos(raw?.height ?? data?.height);
  if (Number.isFinite(w) && Number.isFinite(h)) return 0.25 * Math.min(w, h);

  return 0;
}

/**
 * Estimate the region inradius used to scale Edge Fade % for polygon-based fades.
 *
 * For Regions composed of multiple shapes, Edge Fade % should not completely fade out smaller sub-shapes. Use the minimum per-shape inradius as the scaling reference.
 *
 * @param {PlaceableObject} placeable
 * @returns {number}
 */
export function estimateRegionInradius(placeable) {
  const shapes = placeable?.document?.shapes ?? [];

  let minR = Infinity;
  let maxR = 0;
  for (const s of shapes) {
    if (!s || s.hole) continue;
    const empty = typeof s.isEmpty === "function" ? s.isEmpty() : !!s.isEmpty;
    if (empty) continue;
    const r = estimateShapeInradiusWorld(s);
    if (Number.isFinite(r) && r > 0) {
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
    }
  }

  if (minR !== Infinity) {
    const CAP_RATIO = 3.0;
    const ref = Math.min(maxR || minR, minR * CAP_RATIO);
    return Math.max(1e-6, ref);
  }

  const b = regionWorldBounds(placeable) ?? regionWorldBoundsAligned(placeable);
  if (b && [b.minX, b.minY, b.maxX, b.maxY].every(Number.isFinite)) {
    const w = Math.max(1e-6, b.maxX - b.minX);
    const h = Math.max(1e-6, b.maxY - b.minY);
    return Math.max(1e-6, 0.25 * Math.min(w, h));
  }

  return 1e-6;
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
