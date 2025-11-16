// SPDX-FileCopyrightText: 2025 Gambit
// Region/scene gating + color controls + hybrid fade to edge.
// Rect/ellipse: analytic percent/absolute fades.
// Polygon: percent = smooth-min over edges; absolute = SDF with tiny Gaussian smoothing.

/* ---------- Precision ---------- */
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
precision highp int;
#else
precision mediump float;
precision mediump int;
#endif

/* ---------- Inputs ---------- */
uniform sampler2D uSampler;     // scene color
uniform sampler2D maskSampler;  // region/suppression mask

// Mask RT size in CSS px
uniform vec2  viewSize;

// Pixi filter pipeline
uniform vec4  inputSize;    // xy: input size in CSS px; zw: 1/size
uniform vec4  outputFrame;  // xy: offset in CSS px; zw: size

uniform vec2  camFrac;      // (stage unsnapped) - (stage snapped)

// Region-mask flags
uniform float hasMask;
uniform float maskReady;
uniform float invertMask;
uniform float strength;

// Color controls
uniform float red, green, blue;
uniform float brightness, contrast, saturation, gamma;

/* ---------- Fade uniforms ---------- */
// 0=polygon, 1=rect, 2=ellipse, -1=none
uniform int   uRegionShape;

// CSS -> World affine (column-major)
uniform mat3  uCssToWorld;

// Rect/Ellipse analytics
uniform vec2  uCenter;
uniform vec2  uHalfSize;
uniform float uRotation;

/* Polygon SDF (absolute-width & inradius only) */
uniform sampler2D uSdf;
uniform mat3  uUvFromWorld;    // world -> SDF UV
uniform vec2  uSdfScaleOff;    // [scale, offset] for decode
uniform float uSdfInsideMax;   // inradius (world px)
uniform vec2  uSdfTexel;       // 1/texture size (UV texel)

/* Absolute width mode (kept for compatibility) */
uniform float uFadeWorld;      // world px
uniform float uFadePx;         // CSS px

/* Percent mode */
uniform float uUsePct;         // 1 => use uFadePct
uniform float uFadePct;        // 0..1

/* Polygon edges (analytic percent fade) */
#define MAX_EDGES 64
uniform float uEdgeCount;      // <= MAX_EDGES
uniform vec4  uEdges[MAX_EDGES]; // (Ax,Ay,Bx,By) in world units
uniform float uSmoothKWorld;   // world-px smoothing radius for edge combiner

varying vec2 vTextureCoord;

/* ---------- Helpers ---------- */
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

/* Smooth-min (polynomial) for rect channels */
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5*(b - a)/max(k, 1e-6), 0.0, 1.0);
  return mix(b, a, h) - k*h*(1.0 - h);
}

/* Signed distances (world px) */
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

/* Distance to segment (world px) */
float distToSegment(vec2 p, vec2 a, vec2 b){
  vec2 ab = b - a;
  float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  vec2 c = a + t * ab;
  return length(p - c);
}

/* ---------- SDF helpers (polygon absolute-width) ---------- */
vec2 worldToSdfUV(vec2 pW) {
  vec3 c0 = uUvFromWorld[0], c1 = uUvFromWorld[1];
  return vec2(c0.x*pW.x + c0.y*pW.y + c0.z,
              c1.x*pW.x + c1.y*pW.y + c1.z);
}
float sdfDecode(float t) { return t * uSdfScaleOff.x + uSdfScaleOff.y; }
float insideDistAt(vec2 uv) {
  uv = clamp(uv, 0.0, 1.0);
  float s = sdfDecode(texture2D(uSdf, uv).r);
  return max(-s, 0.0); // inside distance only
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
  return -di; // signed again (<0 inside)
}

/* ---------- Percent fades (edge-anchored) ---------- */
float fadePctRect(vec2 pW, float pct) {
  vec2 p = rotateVec(pW - uCenter, -uRotation);
  vec2 halfSize = max(uHalfSize, vec2(1e-6));
  float dx = halfSize.x - abs(p.x);
  float dy = halfSize.y - abs(p.y);
  float inrad = min(halfSize.x, halfSize.y);
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

/* Stable log-sum-exp smooth-min across N edges */
float lseSmoothMin(float dMin, float sumExp, float tau) {
  return dMin - tau * log(max(sumExp, 1e-9));
}
float fadePctPoly_edges(vec2 pW, float pct) {
  float inradFallback = 0.5 * max(uSdfScaleOff.x, 1e-6);
  float inrad  = (uSdfInsideMax > 0.0) ? uSdfInsideMax : inradFallback;
  float band   = max(pct * inrad, 1e-6);

  // blend edges with LSE; temperature scales with band
  float tau = max(uSmoothKWorld, band * 0.25); // 25% of band or world smoothing hint

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

/* ---------- Absolute-width fades (world px) ---------- */
float maskPolySdf_abs(vec2 pW, float fadeWorld) {
  float d = sdPolySmooth(pW); // signed (<0 inside)
  return 1.0 - smoothstep(0.0, fadeWorld, d + fadeWorld);
}
float maskAnalytic_abs(vec2 pW, float fadeWorld, int shape) {
  float sd = (shape == 1)
    ? sdRect(pW, uCenter, uHalfSize, uRotation)
    : sdEllipse(pW, uCenter, uHalfSize, uRotation);
  return 1.0 - smoothstep(0.0, fadeWorld, sd + fadeWorld);
}

/* ---------- Main ---------- */
void main(void) {
  vec4 src = texture2D(uSampler, vTextureCoord);

  // pixel position in CSS px that sampled src
  vec2 screenPx = outputFrame.xy + vTextureCoord * inputSize.xy;

  vec2 snapPx = screenPx - camFrac;

  /* Region/suppression gating */
  float inMask = src.a;
  if (hasMask > 0.5) {
    if (maskReady < 0.5 || viewSize.x < 1.0 || viewSize.y < 1.0) {
      gl_FragColor = src; return;
    }
    // Use snapped pixels for the mask UV
    vec2 maskUV = clamp(snapPx / max(viewSize, vec2(1.0)), 0.0, 1.0);
    float a = clamp(texture2D(maskSampler, maskUV).r, 0.0, 1.0);
    float m = smoothstep(0.49, 0.51, a);
    if (invertMask > 0.5) m = 1.0 - m;
    inMask *= m;
  }

  /* Fade factor */
  float fade = 1.0;
  vec2 pW = applyCssToWorld(snapPx);

  if (uUsePct > 0.5) {
    float pct = clamp(uFadePct, 0.0, 1.0);
    if (pct > 0.0) {
      if (uRegionShape == 1)       fade = fadePctRect(pW, pct);
      else if (uRegionShape == 2)  fade = fadePctEllipse(pW, pct);
      else if (uRegionShape == 0)  fade = fadePctPoly_edges(pW, pct); // polygon: analytic edges
    }
  } else {
    float fadeWorld = (uFadeWorld > 0.0) ? uFadeWorld
                     : (uFadePx > 0.0   ? uFadePx * worldPerCss() : 0.0);
    if (fadeWorld > 0.0) {
      if (uRegionShape == 1 || uRegionShape == 2) fade = maskAnalytic_abs(pW, fadeWorld, uRegionShape);
      else if (uRegionShape == 0)                 fade = maskPolySdf_abs(pW, fadeWorld);
    }
  }

  /* Color pipeline */
  vec3 color = src.rgb;
  color *= vec3(red, green, blue);
  color *= max(brightness, 0.0);

  float c = max(contrast, 0.0);
  color = (color - 0.5) * c + 0.5;
  color = softClip(color);

  float s = max(saturation, 0.0);
  float Y = luma(color);
  color = mix(vec3(Y), color, s);
  color = softClip(color);

  float g = max(gamma, 0.0001);
  color = pow(clamp(color, 0.0, 1.0), vec3(1.0 / g));

  /* Compose */
  float w = clamp(inMask * fade * strength, 0.0, 1.0);
  vec3 finalRGB = mix(src.rgb, color, w);
  gl_FragColor  = vec4(finalRGB, src.a);
}