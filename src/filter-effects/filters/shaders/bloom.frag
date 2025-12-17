// SPDX-FileCopyrightText: 2025 Gambit

#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
precision highp int;
#else
precision mediump float;
precision mediump int;
#endif

uniform sampler2D uSampler;     // scene color
uniform sampler2D maskSampler;  // region/suppression mask

// Mask RT size in CSS px
uniform vec2  viewSize;

// Pixi filter pipeline
uniform vec4  inputSize;   // xy: input size in CSS px; zw: 1/size
uniform vec4  outputFrame; // CSS px: (x,y,w,h) area spanned by vTextureCoord

// Region mask flags
uniform float hasMask;
uniform float maskReady;
uniform float invertMask;
uniform float strength;

// Effect params
uniform float threshold;
uniform float bloomScale;
uniform float blurRadius;

// ---- Region fade (shared schema) ----
// 0=polygon, 1=rect, 2=ellipse, -1=none
uniform int   uRegionShape;
uniform mat3  uCssToWorld;

// Rect/Ellipse analytics
uniform vec2  uCenter;
uniform vec2  uHalfSize;
uniform float uRotation;

// Polygon SDF (absolute-width & inradius only)
uniform sampler2D uSdf;
uniform mat3  uUvFromWorld;
uniform vec2  uSdfScaleOff;
uniform float uSdfInsideMax;
uniform vec2  uSdfTexel;

// Absolute width
uniform float uFadeWorld;   // world px
uniform float uFadePx;      // CSS px

// Percent mode
uniform float uUsePct;      // 1 => use uFadePct
uniform float uFadePct;     // 0..1

// Polygon edges (percent mode)
#define MAX_EDGES 64
uniform float uEdgeCount;
uniform vec4  uEdges[MAX_EDGES]; // (Ax,Ay,Bx,By) world units
uniform float uSmoothKWorld;     // world-px smoothing radius

varying vec2 vTextureCoord;

/* ---------- helpers ---------- */
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3  softClip(vec3 c){ float m = max(c.r, max(c.g, c.b)); return (m > 1.0) ? (c / m) : c; }

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

/* ---- Polygon SDF (absolute-width) ---- */
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
/* 3×3 Gaussian smoothing of inside distance (derivative-free) */
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

/* ---------- main ---------- */
vec3 brightPassWeighted(vec2 uv, float w, float thr) {
  vec3 col = texture2D(uSampler, uv).rgb;
  float Y  = luma(col);
  float t  = max(Y - thr, 0.0) / max(1.0 - thr, 0.0001);
  return col * t * w;
}

void main(void) {
  vec4 src = texture2D(uSampler, vTextureCoord);

  // CSS px of the sampled screen point
  vec2 screenPx = outputFrame.xy + vTextureCoord * inputSize.xy;

  // Region/suppression mask
  float inMask = src.a;
  if (hasMask > 0.5) {
    bool maskUsable = (maskReady > 0.5) &&
                      (viewSize.x >= 1.0) &&
                      (viewSize.y >= 1.0);
    if (maskUsable) {
      vec2 maskUV = screenPx / viewSize;
      float aRaw  = texture2D(maskSampler, maskUV).r;
      float a     = clamp(aRaw, 0.0, 1.0);
      float m     = smoothstep(0.48, 0.52, a);
      if (invertMask > 0.5) m = 1.0 - m;
      inMask *= m;
    }
  }

  // Region edge fade (percent or absolute)
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

  // Bloom strength, gated by mask & fade
  float k = clamp(bloomScale * strength, 0.0, 1.0) *
            clamp(inMask * fadeEdge, 0.0, 1.0);
  if (k <= 0.0001) { gl_FragColor = src; return; }

  // Convert blur (px) → UV
  vec2 pxUV = (blurRadius <= 0.0001) ? vec2(0.0) : (vec2(blurRadius) * inputSize.zw);

  // 9-tap bright gather
  const float wCenter   = 0.28;
  const float wCardinal = 0.12;
  const float wDiagonal = 0.08;

  vec3 acc = vec3(0.0);
  float wsum = 0.0;

  acc  += brightPassWeighted(vTextureCoord, wCenter, threshold);
  wsum += wCenter;

  if (blurRadius > 0.0001) {
    vec2 d = pxUV;
    acc  += brightPassWeighted(vTextureCoord + vec2( d.x, 0.0), wCardinal, threshold);
    acc  += brightPassWeighted(vTextureCoord + vec2(-d.x, 0.0), wCardinal, threshold);
    acc  += brightPassWeighted(vTextureCoord + vec2(0.0,  d.y), wCardinal, threshold);
    acc  += brightPassWeighted(vTextureCoord + vec2(0.0, -d.y), wCardinal, threshold);
    wsum += 4.0 * wCardinal;

    acc  += brightPassWeighted(vTextureCoord + vec2( d.x,  d.y), wDiagonal, threshold);
    acc  += brightPassWeighted(vTextureCoord + vec2(-d.x,  d.y), wDiagonal, threshold);
    acc  += brightPassWeighted(vTextureCoord + vec2( d.x, -d.y), wDiagonal, threshold);
    acc  += brightPassWeighted(vTextureCoord + vec2(-d.x, -d.y), wDiagonal, threshold);
    wsum += 4.0 * wDiagonal;
  }

  vec3 bloom = (wsum > 0.0) ? (acc / wsum) : vec3(0.0);
  bloom *= k;

  vec3 outRGB = softClip(src.rgb + bloom);
  gl_FragColor = vec4(outRGB, src.a);
}
