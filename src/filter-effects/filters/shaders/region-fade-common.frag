/**
 * FXMaster: Shared Region Fade Infrastructure
 * ============================================
 * Common SDF, signed-distance, and fade functions used by all FXMaster fragment shaders. Injected at compile time by the filter mixin's shader-assembly step
 *
 * Requires the following uniforms to be declared by the host shader before the include point:
 *
 *   uniform int   uRegionShape;
 *   uniform mat3  uCssToWorld;
 *   uniform vec2  uCenter;
 *   uniform vec2  uHalfSize;
 *   uniform float uRotation;
 *   uniform sampler2D uSdf;
 *   uniform mat3  uUvFromWorld;
 *   uniform vec2  uSdfScaleOff;
 *   uniform float uSdfInsideMax;
 *   uniform vec2  uSdfTexel;
 *   uniform float uFadeWorld;
 *   uniform float uFadePx;
 *   uniform float uUsePct;
 *   uniform float uFadePct;
 *   uniform float uUseSdf;
 *   uniform float uEdgeCount;
 *   uniform vec4  uEdges[MAX_EDGES];
 *   uniform float uSmoothKWorld;
 */

/* ---- Coordinate helpers ---- */

vec2 applyCssToWorld(vec2 css) {
  return (uCssToWorld * vec3(css, 1.0)).xy;
}

float worldPerCss() {
  vec2 col0 = vec2(uCssToWorld[0][0], uCssToWorld[1][0]);
  vec2 col1 = vec2(uCssToWorld[0][1], uCssToWorld[1][1]);
  return max(1e-6, 0.5 * (length(col0) + length(col1)));
}

vec2 rotateVec(vec2 p, float ang) {
  float c = cos(ang), s = sin(ang);
  return vec2(c*p.x - s*p.y, s*p.x + c*p.y);
}

/* ---- Smooth-min (polynomial) for rect channel blending ---- */

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5*(b - a)/max(k, 1e-6), 0.0, 1.0);
  return mix(b, a, h) - k*h*(1.0 - h);
}

/* ---- Segment distance (world px) ---- */

float distToSegment(vec2 p, vec2 a, vec2 b) {
  vec2 ab = b - a;
  float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  vec2 c = a + t * ab;
  return length(p - c);
}

/* ---- Signed distances for rect / ellipse (world px) ---- */

float sdRect(vec2 pW, vec2 center, vec2 halfSize, float rot) {
  vec2 p = rotateVec(pW - center, -rot);
  vec2 q = abs(p) - halfSize;
  float outside = length(max(q, 0.0));
  float inside  = min(max(q.x, q.y), 0.0);
  return outside + inside;
}

/**
 * Approximate signed distance to a rotated ellipse.
 *
 * This normalises the point into unit-circle space and scales the result by
 * the major radius. The approximation is cheap (no iteration) but its error
 * grows with aspect ratio: for a 10:1 ellipse the fade band near the narrow
 * ends can be up to ~10x wider than intended. For the typical Foundry VTT
 * use-case (region emanations with mild aspect ratios ≤ 3:1) the quality is
 * acceptable. A Newton-iteration solver (cf. Iq/Shadertoy) would give exact
 * results at a higher per-pixel cost.
 */
float sdEllipse(vec2 pW, vec2 center, vec2 halfSize, float rot) {
  vec2 p = rotateVec(pW - center, -rot);
  float R = max(halfSize.x, halfSize.y);
  float r = length(p / max(halfSize, vec2(1e-6)));
  return (r - 1.0) * R;
}

/* ---- Polygon SDF helpers ---- */

vec2 worldToSdfUV(vec2 pW) {
  vec3 c0 = uUvFromWorld[0], c1 = uUvFromWorld[1];
  return vec2(c0.x*pW.x + c0.y*pW.y + c0.z,
              c1.x*pW.x + c1.y*pW.y + c1.z);
}

float sdfDecode(float t) {
  return t * uSdfScaleOff.x + uSdfScaleOff.y;
}

float insideDistAt(vec2 uv) {
  uv = clamp(uv, 0.0, 1.0);
  float s = sdfDecode(texture2D(uSdf, uv).r);
  return max(-s, 0.0);
}

/**
 * 5-tap cross smoothing of SDF inside-distance (cheaper than 3x3 Gaussian).
 * Uses bilinear filtering for inter-texel blending.
 */
float sdPolySmooth(vec2 pW) {
  vec2 uv = worldToSdfUV(pW);
  vec2 t  = (uSdfTexel.x > 0.0 && uSdfTexel.y > 0.0) ? uSdfTexel : vec2(1.0/1024.0);
  float di =
      4.0 * insideDistAt(uv) +
      2.0 * insideDistAt(uv + vec2( t.x,  0.0)) +
      2.0 * insideDistAt(uv + vec2(-t.x,  0.0)) +
      2.0 * insideDistAt(uv + vec2( 0.0,  t.y)) +
      2.0 * insideDistAt(uv + vec2( 0.0, -t.y));
  di *= 1.0 / 12.0;
  return -di;
}


/* ---- Absolute-width fades (world px) ----
 * Legacy helper names referenced by some FXMaster shaders.
 * Returns a fade factor in [0,1]:
 *   1.0 = fully visible deep inside the region
 *   0.0 = fully faded at/outside the boundary
 */

float maskAnalytic_abs(vec2 pW, float fadeWorld, int shape) {
  float fw = max(fadeWorld, 1e-6);
  float sd = (shape == 2)
    ? sdEllipse(pW, uCenter, uHalfSize, uRotation)
    : sdRect(pW, uCenter, uHalfSize, uRotation);
  float insideD = max(-sd, 0.0);
  return smoothstep(0.0, fw, insideD);
}

float maskPolySdf_abs(vec2 pW, float fadeWorld) {
  float fw = max(fadeWorld, 1e-6);
  float sd = sdPolySmooth(pW);
  float insideD = max(-sd, 0.0);
  return smoothstep(0.0, fw, insideD);
}

/* ---- Percent fades (edge-anchored) ---- */

float fadePctRect(vec2 pW, float pct) {
  vec2 p = rotateVec(pW - uCenter, -uRotation);
  vec2 hs = max(uHalfSize, vec2(1e-6));
  float dx = hs.x - abs(p.x);
  float dy = hs.y - abs(p.y);
  float inrad = min(hs.x, hs.y);
  float band  = max(pct * inrad, 1e-6);
  float d = smin(dx, dy, band);
  return clamp(d / band, 0.0, 1.0);
}

float fadePctEllipse(vec2 pW, float pct) {
  vec2 p = rotateVec(pW - uCenter, -uRotation);
  vec2 n = p / max(uHalfSize, vec2(1e-6));
  float r = length(n);
  float band = max(pct, 1e-6);
  return clamp((1.0 - r) / band, 0.0, 1.0);
}

float fadePctPoly_edges(vec2 pW, float pct) {
  float inradFallback = 0.5 * max(uSdfScaleOff.x, 1e-6);
  float inrad  = (uSdfInsideMax > 0.0) ? uSdfInsideMax : inradFallback;
  float band   = max(pct * inrad, 1e-6);

  float dMin = 1e20;
  for (int i = 0; i < MAX_EDGES; ++i) {
    if (float(i) >= uEdgeCount) break;
    vec4 AB = uEdges[i];
    float di = distToSegment(pW, AB.xy, AB.zw);
    dMin = min(dMin, di);
  }

  return clamp(dMin / band, 0.0, 1.0);
}

float fadePctPoly_sdf(vec2 pW, float pct) {
  float inradFallback = 0.5 * max(uSdfScaleOff.x, 1e-6);
  float inrad = (uSdfInsideMax > 0.0) ? uSdfInsideMax : inradFallback;
  float band  = max(pct * inrad, 1e-6);
  float insideD = max(-sdPolySmooth(pW), 0.0);
  return clamp(insideD / band, 0.0, 1.0);
}

/**
 * Compute the combined edge fade factor for any region shape.
 *
 * @param pW        World-space position of the fragment.
 * @param usePct    1.0 when using percent-of-inradius mode; 0.0 for absolute-width mode.
 * @param fadePct   Fade fraction in [0,1] (percent mode).
 * @param fadeWorld  Absolute fade width in world pixels (absolute mode).
 * @param fadePx    Absolute fade width in CSS pixels (absolute mode fallback).
 * @return          Fade multiplier in [0,1]; 1 = fully visible, 0 = fully faded.
 */
float computeRegionFade(vec2 pW, float usePct, float fadePct, float fadeWorld, float fadePx) {
  if (usePct > 0.5) {
    float pct = clamp(fadePct, 0.0, 1.0);
    if (pct <= 0.0) return 1.0;
    if      (uRegionShape == 1) return fadePctRect(pW, pct);
    else if (uRegionShape == 2) return fadePctEllipse(pW, pct);
    else if (uRegionShape == 0) {
      return (uUseSdf > 0.5) ? fadePctPoly_sdf(pW, pct) : fadePctPoly_edges(pW, pct);
    }
    return 1.0;
  } else {
    float fw = (fadeWorld > 0.0) ? fadeWorld
             : (fadePx > 0.0   ? fadePx * worldPerCss() : 0.0);
    if (fw <= 0.0) return 1.0;
    if (uRegionShape == 1 || uRegionShape == 2) {
      float sd = (uRegionShape == 1)
        ? sdRect(pW, uCenter, uHalfSize, uRotation)
        : sdEllipse(pW, uCenter, uHalfSize, uRotation);
      return 1.0 - smoothstep(0.0, fw, sd + fw);
    } else if (uRegionShape == 0) {
      float d = sdPolySmooth(pW);
      return 1.0 - smoothstep(0.0, fw, d + fw);
    }
    return 1.0;
  }
}
