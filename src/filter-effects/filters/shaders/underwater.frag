// SPDX-FileCopyrightText: 2025 Gambit

#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
precision highp int;
#else
precision mediump float;
precision mediump int;
#endif

uniform sampler2D uSampler;
uniform sampler2D maskSampler;

/* ---- Pixi pipeline frames (match Color) ---- */
uniform vec2  viewSize;     // CSS px of mask RT
uniform vec4  inputSize;    // xy: input size in CSS px; zw: 1/size
uniform vec4  outputFrame;  // xy: offset in CSS px;    zw: size

/* Kept for ABI/back-compat; not used for mask sample now */
uniform vec4  srcFrame;     // CSS px area spanned by vTextureCoord
uniform vec2  camFrac;      // CSS px fractional camera translation

uniform float hasMask;
uniform float maskReady;
uniform float invertMask;
uniform float feather;      // optional mask feather (CSS px)
uniform float strength;     // 0..1 overall effect strength

/* -------- Displacement map -------- */
uniform sampler2D mapSampler;
uniform vec2      mapScale;   // displacement in pixels (x,y)
uniform vec2      mapRepeat;
uniform vec2      mapOffset;
uniform vec2      mapTexel;   // 1/texSize (set from JS)

/* -------- NEW: tokens-only mask for belowTokens -------- */
uniform sampler2D tokenSampler;  // CSS-space tokens mask (alpha)
uniform float     hasTokenMask;  // 1 when provided, else 0

varying vec2 vTextureCoord;

/* -------- Region fade (same schema as other filters) -------- */
// 0=polygon, 1=rect, 2=ellipse, -1=none
uniform int   uRegionShape;
uniform mat3  uCssToWorld;

// Rect/Ellipse analytics
uniform vec2  uCenter;
uniform vec2  uHalfSize;
uniform float uRotation;

// Polygon SDF (absolute-width & inradius only)
uniform sampler2D uSdf;
uniform mat3  uUvFromWorld;    // world -> SDF UV
uniform vec2  uSdfScaleOff;    // [scale, offset] for decode
uniform float uSdfInsideMax;   // inradius (world px)
uniform vec2  uSdfTexel;       // 1/texture size (UV texel)

// Absolute width (compat)
uniform float uFadeWorld;      // world px
uniform float uFadePx;         // CSS px

// Percent mode
uniform float uUsePct;         // 1 => use uFadePct
uniform float uFadePct;        // 0..1

// Polygon edges (percent mode)
#define MAX_EDGES 64
uniform float uEdgeCount;
uniform vec4  uEdges[MAX_EDGES]; // (Ax,Ay,Bx,By) world units
uniform float uSmoothKWorld;     // world-px smoothing radius

/* ====================== Helpers ====================== */

vec2 wrapUV(vec2 uv){ return fract(uv); }

vec2 applyCssToWorld(vec2 css) { return (uCssToWorld * vec3(css, 1.0)).xy; }
float worldPerCss() {
  vec2 col0 = vec2(uCssToWorld[0][0], uCssToWorld[1][0]);
  vec2 col1 = vec2(uCssToWorld[0][1], uCssToWorld[1][1]);
  return max(1e-6, 0.5 * (length(col0) + length(col1)));
}
vec2 rotateVec(vec2 p, float ang) {
  float c = cos(ang), s = sin(ang);
  return vec2(c*p.x - s*p.y, s*p.x + c*p.y);
}
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5*(b - a)/max(k, 1e-6), 0.0, 1.0);
  return mix(b, a, h) - k*h*(1.0 - h);
}
float distToSegment(vec2 p, vec2 a, vec2 b){
  vec2 ab = b - a;
  float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  vec2 c = a + t * ab;
  return length(p - c);
}

/* ---- Signed distances for absolute rect/ellipse ---- */
float sdRect(vec2 pW, vec2 center, vec2 halfSize, float rot) {
  vec2 p = rotateVec(pW - center, -rot);
  vec2 q = abs(p) - halfSize;
  float outside = length(max(q, 0.0));
  float inside  = min(max(q.x, q.y), 0.0);
  return outside + inside; // <0 inside
}
float sdEllipse(vec2 pW, vec2 center, vec2 halfSize, float rot) {
  vec2 p = rotateVec(pW - center, -rot);
  float R = max(halfSize.x, halfSize.y);
  float r = length(p / max(halfSize, vec2(1e-6)));
  return (r - 1.0) * R; // <0 inside (approx)
}

/* ---- Polygon SDF (absolute-width) with tiny Gaussian smoothing ---- */
vec2 worldToSdfUV(vec2 pW) {
  vec3 c0 = uUvFromWorld[0], c1 = uUvFromWorld[1];
  return vec2(c0.x*pW.x + c0.y*pW.y + c0.z,
              c1.x*pW.x + c1.y*pW.y + c1.z);
}
float sdfDecode(float t) { return t * uSdfScaleOff.x + uSdfScaleOff.y; }
float insideDistAt(vec2 uv) {
  uv = clamp(uv, 0.0, 1.0);
  float s = sdfDecode(texture2D(uSdf, uv).r);
  return max(-s, 0.0);
}
float sdPolySmooth(vec2 pW) {
  vec2 uv = worldToSdfUV(pW);
  vec2 t  = (uSdfTexel.x > 0.0 && uSdfTexel.y > 0.0) ? uSdfTexel : vec2(1.0/1024.0);
  float di =
      1.0 * insideDistAt(uv + vec2(-t.x, -t.y)) +
      2.0 * insideDistAt(uv + vec2( 0.0, -t.y)) +
      1.0 * insideDistAt(uv + vec2( t.x, -t.y)) +
      2.0 * insideDistAt(uv + vec2(-t.x,  0.0)) +
      4.0 * insideDistAt(uv + vec2( 0.0,  0.0)) +
      2.0 * insideDistAt(uv + vec2( t.x,  0.0)) +
      1.0 * insideDistAt(uv + vec2(-t.x,  t.y)) +
      2.0 * insideDistAt(uv + vec2( 0.0,  t.y)) +
      1.0 * insideDistAt(uv + vec2( t.x,  t.y));
  di *= 1.0 / 16.0;
  return -di; // signed: <0 inside
}

/* ---- Percent fades ---- */
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
/* Stable log-sum-exp smooth-min across polygon edges */
float lseSmoothMin(float dMin, float sumExp, float tau) {
  return dMin - tau * log(max(sumExp, 1e-9));
}
float fadePctPoly_edges(vec2 pW, float pct) {
  float inradFallback = 0.5 * max(uSdfScaleOff.x, 1e-6);
  float inrad  = (uSdfInsideMax > 0.0) ? uSdfInsideMax : inradFallback;
  float band   = max(pct * inrad, 1e-6);
  float tau    = max(uSmoothKWorld, band * 0.25); // 25% of band or world hint

  float dMin = 1e20;
  for (int i = 0; i < MAX_EDGES; ++i) {
    if (float(i) >= uEdgeCount) break;
    vec4 AB = uEdges[i];
    float di = distToSegment(pW, AB.xy, AB.zw);
    dMin = min(dMin, di);
  }
  float sumExp = 0.0;
  for (int i = 0; i < MAX_EDGES; ++i) {
    if (float(i) >= uEdgeCount) break;
    vec4 AB = uEdges[i];
    float di = distToSegment(pW, AB.xy, AB.zw);
    sumExp += exp(-(di - dMin) / max(tau, 1e-6));
  }
  float d = lseSmoothMin(dMin, sumExp, tau);
  return clamp(d / band, 0.0, 1.0);
}

/* ====================== Main ====================== */
void main(void) {
  vec4 src = texture2D(uSampler, vTextureCoord);

  /* SCREEN position in CSS px (match Color) */
  vec2 screenPx = outputFrame.xy + vTextureCoord * inputSize.xy;

  /* ---- Region/suppression mask ---- */
  float inMask = src.a;
  if (hasMask > 0.5) {
    if (maskReady < 0.5 || viewSize.x < 1.0 || viewSize.y < 1.0) { gl_FragColor = src; return; }

    vec2 maskUV = screenPx / max(viewSize, vec2(1.0));
    float a = texture2D(maskSampler, maskUV).r;

    // Optional feather in CSS px
    if (feather > 0.5) {
      vec2 px = 1.0 / max(viewSize, vec2(1.0));
      vec2 o  = px * feather;
      float s = 0.0;
      s += texture2D(maskSampler, maskUV + vec2(-o.x, -o.y)).r;
      s += texture2D(maskSampler, maskUV + vec2( 0.0, -o.y)).r;
      s += texture2D(maskSampler, maskUV + vec2( o.x, -o.y)).r;
      s += texture2D(maskSampler, maskUV + vec2(-o.x,  0.0)).r;
      s += a;
      s += texture2D(maskSampler, maskUV + vec2( o.x,  0.0)).r;
      s += texture2D(maskSampler, maskUV + vec2(-o.x,  o.y)).r;
      s += texture2D(maskSampler, maskUV + vec2( 0.0,  o.y)).r;
      s += texture2D(maskSampler, maskUV + vec2( o.x,  o.y)).r;
      a = s / 9.0;
    }

    float m = smoothstep(0.49, 0.51, a);
    if (invertMask > 0.5) m = 1.0 - m;
    inMask *= m;
  }

  /* ---- Region edge fade (percent or absolute) ---- */
  float fadeEdge = 1.0;
  vec2  pW       = applyCssToWorld(screenPx);

  if (uUsePct > 0.5) {
    float pct = clamp(uFadePct, 0.0, 1.0);
    if (pct > 0.0) {
      if      (uRegionShape == 1) fadeEdge = fadePctRect(pW, pct);
      else if (uRegionShape == 2) fadeEdge = fadePctEllipse(pW, pct);
      else if (uRegionShape == 0) fadeEdge = fadePctPoly_edges(pW, pct);
    }
  } else {
    float fw = (uFadeWorld > 0.0) ? uFadeWorld
             : (uFadePx > 0.0   ? uFadePx * worldPerCss() : 0.0);
    if (fw > 0.0) {
      if      (uRegionShape == 1 || uRegionShape == 2) {
        float sd = (uRegionShape == 1)
          ? sdRect(pW, uCenter, uHalfSize, uRotation)
          : sdEllipse(pW, uCenter, uHalfSize, uRotation);
        fadeEdge = 1.0 - smoothstep(0.0, fw, sd + fw);
      } else if (uRegionShape == 0) {
        float d = sdPolySmooth(pW);
        fadeEdge = 1.0 - smoothstep(0.0, fw, d + fw);
      }
    }
  }

  /* ---- Final weight = mask * strength * fade ---- */
  float weight = clamp(inMask * (strength > 0.0 ? strength : 1.0) * fadeEdge, 0.0, 1.0);
  if (weight <= 0.0001) { gl_FragColor = src; return; }

  /* ---- Displacement with tile-edge seam avoidance ---- */
  vec2 uvBase   = vTextureCoord * mapRepeat + mapOffset;
  vec2 uvA      = wrapUV(uvBase);
  vec2 uvB      = wrapUV(uvBase + vec2(0.5, 0.0));
  vec2 pad      = max(mapTexel * 0.5, vec2(0.00025));
  uvA = clamp(uvA, pad, vec2(1.0) - pad);
  uvB = clamp(uvB, pad, vec2(1.0) - pad);

  vec2 dispA    = texture2D(mapSampler, uvA).rg;
  vec2 dispB    = texture2D(mapSampler, uvB).rg;
  vec2 disp     = ((dispA + dispB) * 0.5) - 0.5;
  vec2 dispPx   = disp * mapScale;

  // Convert pixel displacement to UV offset
  vec2 uvOffset = dispPx / max(viewSize, vec2(1.0));
  vec2 duv      = vTextureCoord + uvOffset;

  // Sample displaced color
  vec4 displaced = texture2D(uSampler, duv);

  // ---- NEW: token-aware guard for displaced sample ----
  // If the displaced lookup would read from a token pixel,
  // cancel the refraction (use undisplaced src at this pixel).
  float tokenA = 0.0;
  if (hasTokenMask > 0.5) {
    vec2 displacedScreenPx = screenPx + dispPx;
    vec2 tokenUV = displacedScreenPx / max(viewSize, vec2(1.0));
    // 3x3 max in CSS pixels to be robust at edges
    vec2 cssPx = 1.0 / max(viewSize, vec2(1.0));
    for (int dy = -1; dy <= 1; ++dy) {
      for (int dx = -1; dx <= 1; ++dx) {
        vec2 off = vec2(float(dx), float(dy)) * cssPx;
        tokenA = max(tokenA, texture2D(tokenSampler, tokenUV + off).a);
      }
    }
  }

  vec3 refracted = mix(displaced.rgb, src.rgb, tokenA);

  vec3 outRgb    = mix(src.rgb, refracted, weight);
  gl_FragColor   = vec4(outRgb, src.a);
}
