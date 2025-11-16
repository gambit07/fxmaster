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
uniform vec2  viewSize;     // CSS px of mask RT (usually screen size)
uniform vec4  inputSize;    // xy: input size in CSS px; zw: 1/size
uniform vec4  outputFrame;  // xy: offset in CSS px;   zw: size

uniform float hasMask;
uniform float maskReady;

/* ---- Effect params ---- */
uniform float time;
uniform vec3  color;
uniform float density;
uniform vec2  dimensions;

uniform float invertMask;
uniform float strength;

/* ---- Region fade (shared with Color) ---- */
// 0=polygon, 1=rect, 2=ellipse, -1=none
uniform int   uRegionShape;
uniform mat3  uCssToWorld;

/* Rect/Ellipse analytics */
uniform vec2  uCenter;
uniform vec2  uHalfSize;
uniform float uRotation;

/* Polygon SDF (absolute-width & inradius only) */
uniform sampler2D uSdf;
uniform mat3  uUvFromWorld;   // world -> SDF UV
uniform vec2  uSdfScaleOff;   // [scale, offset] for decode
uniform float uSdfInsideMax;  // inradius (world px)
uniform vec2  uSdfTexel;      // 1/texture size (UV texel)

/* Absolute width */
uniform float uFadeWorld;     // world px
uniform float uFadePx;        // CSS px

/* Percent mode */
uniform float uUsePct;        // 1 => use uFadePct
uniform float uFadePct;       // 0..1

/* Polygon edges (percent mode) */
#define MAX_EDGES 64
uniform float uEdgeCount;
uniform vec4  uEdges[MAX_EDGES]; // (Ax,Ay,Bx,By) world units
uniform float uSmoothKWorld;     // world-px smoothing radius

varying vec2 vFilterCoord;   // world-anchored coord (from custom vertex)
varying vec2 vTextureCoord;  // sampler UVs

/* ---------------- noise ---------------- */
float rand(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453123); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  float a = rand(i + vec2(0.0,0.0)), b = rand(i + vec2(1.0,0.0));
  float c = rand(i + vec2(0.0,1.0)), d = rand(i + vec2(1.0,1.0));
  vec2 u = f*f*(3.0-2.0*f);
  return mix(a,b,u.x) + (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;
}
float fbm(vec2 p){
  float v=0.0,a=0.5; vec2 shift=vec2(100.0);
  mat2 rot = mat2(cos(0.5), sin(0.5), -sin(0.5), cos(0.5));
  for(int i=0;i<10;i++){ v=(sin(v*1.07))+(a*noise(p)); p=rot*p*1.9+shift; a*=0.5; }
  return v;
}
vec3 applyContrast(vec3 c, float contrast){ float t=(1.0-contrast)*0.5; return c*contrast + vec3(t); }

/* ---------------- helpers ---------------- */
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

/* ---- Signed distances (world px) for rect/ellipse absolute mode ---- */
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

/* ---- SDF helpers (polygon absolute-width) ---- */
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
/* Stable log-sum-exp smooth-min across N edges (analytic polygon) */
float lseSmoothMin(float dMin, float sumExp, float tau) {
  return dMin - tau * log(max(sumExp, 1e-9));
}
float fadePctPoly_edges(vec2 pW, float pct) {
  float inradFallback = 0.5 * max(uSdfScaleOff.x, 1e-6);
  float inrad  = (uSdfInsideMax > 0.0) ? uSdfInsideMax : inradFallback;
  float band   = max(pct * inrad, 1e-6);

  float tau = max(uSmoothKWorld, band * 0.25); // 25% of band or world hint

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

/* ---- Absolute-width fades (world px) ---- */
float maskPolySdf_abs(vec2 pW, float fadeWorld) {
  float d = sdPolySmooth(pW);
  return 1.0 - smoothstep(0.0, fadeWorld, d + fadeWorld);
}
float maskAnalytic_abs(vec2 pW, float fadeWorld, int shape) {
  float sd = (shape == 1)
    ? sdRect(pW, uCenter, uHalfSize, uRotation)
    : sdEllipse(pW, uCenter, uHalfSize, uRotation);
  return 1.0 - smoothstep(0.0, fadeWorld, sd + fadeWorld);
}

/* ---------------- main ---------------- */
void main(void){
  vec4 src = texture2D(uSampler, vTextureCoord);
  float inMask = src.a;

  /* SCREEN position in CSS px (match Color) */
  vec2 screenPx = outputFrame.xy + vTextureCoord * inputSize.xy;

  /* Region/suppression gating in CSS px */
  if (hasMask > 0.5) {
    if (maskReady < 0.5 || viewSize.x < 1.0 || viewSize.y < 1.0) { gl_FragColor = src; return; }
    vec2 maskUV = screenPx / max(viewSize, vec2(1.0));
    float aRaw  = texture2D(maskSampler, maskUV).r;
    float a     = clamp(aRaw, 0.0, 1.0);
    float m     = smoothstep(0.48, 0.52, a);
    if (invertMask > 0.5) m = 1.0 - m;
    inMask *= m;
  }

  /* Per-pixel edge fade */
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
    float fadeWorld = (uFadeWorld > 0.0) ? uFadeWorld
                     : (uFadePx > 0.0   ? uFadePx * worldPerCss() : 0.0);
    if (fadeWorld > 0.0) {
      if      (uRegionShape == 1 || uRegionShape == 2) fadeEdge = maskAnalytic_abs(pW, fadeWorld, uRegionShape);
      else if (uRegionShape == 0)                      fadeEdge = maskPolySdf_abs(pW, fadeWorld);
    }
  }

  /* Fog intensity gated by region mask & fade */
  float k = clamp(density, 0.0, 1.0) * clamp(strength, 0.0, 1.0) * inMask * fadeEdge;
  if (k <= 0.0001) { gl_FragColor = src; return; }

  /* World-anchored fog pattern */
  vec2 p = (vFilterCoord * 8.0 - vFilterCoord) * dimensions * 0.00025;
  float t = (time * 0.0025);

  vec2 q; q.x = fbm(p); q.y = fbm(p);
  vec2 r; r.x = fbm(p*q + vec2(1.7,9.2) + 0.15*t);
           r.y = fbm(p*q + vec2(9.3,2.8) + 0.35*t);
  float f = fbm(p*0.2 + r*3.102);

  vec3 baseFog = mix(color, vec3(1.5), clamp(abs(r.x), 0.4, 1.0));
  float shape  = f*f*f + 0.6*f*f + 0.5*f;
  vec3 fogRGB  = applyContrast(baseFog * shape, 3.0);

  vec3 outRGB = mix(src.rgb, fogRGB, k);
  gl_FragColor = vec4(outRGB, src.a);
}
