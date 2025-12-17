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

// Pixi pipeline
uniform vec4  inputSize;   // xy: input size in CSS px; zw: 1/size
uniform vec4  outputFrame; // CSS px: (x,y,w,h) spanned by vTextureCoord

// Region-mask flags
uniform float hasMask;
uniform float maskReady;
uniform float invertMask;  // 0/1
uniform float strength;    // 0..1

// Effect params
uniform float time;
uniform float noiseStrength; // 0..1
uniform float sepiaAmount;   // 0..1

// Newly exposed params
uniform float noiseSize;      // ≥0, grain scale (1 == original)
uniform float scratch;        // 0..1, line visibility
uniform float scratchDensity; // 0..1, line frequency

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

// Absolute width (compat)
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

/* -------- noise -------- */
float h2(vec2 p){ p=fract(p*vec2(0.1031,0.11369)); p+=dot(p,p+19.19); return fract(p.x*p.y); }
vec2 rot(vec2 p){ const float c=0.956304756, s=0.292371705; return mat2(c,-s,s,c)*p; }
vec3 Overlay(vec3 src, vec3 dst){
  return vec3(
    (dst.x<=0.5)?(2.0*src.x*dst.x):(1.0-2.0*(1.0-dst.x)*(1.0-src.x)),
    (dst.y<=0.5)?(2.0*src.y*dst.y):(1.0-2.0*(1.0-dst.y)*(1.0-src.y)),
    (dst.z<=0.5)?(2.0*src.z*dst.z):(1.0-2.0*(1.0-dst.z)*(1.0-src.z))
  );
}
const vec3 SEPIA_RGB = vec3(112.0/255.0, 66.0/255.0, 20.0/255.0);

/* -------- helpers -------- */
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

/* Signed distances for absolute rect/ellipse */
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

/* Polygon SDF (absolute-width) with tiny Gaussian smoothing */
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

/* Percent fades */
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
float lseSmoothMin(float dMin, float sumExp, float tau) {
  return dMin - tau * log(max(sumExp, 1e-9));
}
float fadePctPoly_edges(vec2 pW, float pct) {
  float inradFallback = 0.5 * max(uSdfScaleOff.x, 1e-6);
  float inrad  = (uSdfInsideMax > 0.0) ? uSdfInsideMax : inradFallback;
  float band   = max(pct * inrad, 1e-6);
  float tau    = max(uSmoothKWorld, band * 0.25);

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

/* ---------------- main ---------------- */
void main(){
  vec4 src = texture2D(uSampler, vTextureCoord);

  // CSS px of the sampled screen point
  vec2 screenPx = outputFrame.xy + vTextureCoord * inputSize.xy;

  // Region/suppression mask in screen pixels
  float inMask = src.a;
  if (hasMask > 0.5) {
    bool maskUsable = (maskReady > 0.5) &&
                      (viewSize.x >= 1.0) &&
                      (viewSize.y >= 1.0);
    if (maskUsable) {
      vec2 maskUV = screenPx / max(viewSize, vec2(1.0));
      float aRaw  = texture2D(maskSampler, maskUV).r;
      float a     = clamp(aRaw, 0.0, 1.0);
      float m     = smoothstep(0.48, 0.52, a);
      if (invertMask > 0.5) m = 1.0 - m;
      inMask *= m;
    }
  }

  // Per-pixel region fade (percent or absolute)
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

  // Grain basis (stable integer pixels) — scale by noiseSize
  float ns = max(noiseSize, 0.0001);
  vec2 pix = floor(screenPx / ns);
  vec2 q   = rot(pix);

  float ph1=h2(q), ph2=h2(q.yx+7.0), ph3=h2(q+13.7);
  float f1=18.0+6.0*(h2(q+31.0)-0.5);
  float f2=29.0+8.0*(h2(q+53.0)-0.5);
  float f3=41.0+10.0*(h2(q+97.0)-0.5);
  float s1=sign(sin(6.28318530718*(time*f1+ph1)));
  float s2=sign(sin(6.28318530718*(time*f2+ph2)));
  float s3=sign(sin(6.28318530718*(time*f3+ph3)));
  float fpsGate=48.0, frame=floor(time*fpsGate);
  vec2  jump=vec2(37.0,61.0)*frame;
  float gateRand=h2(q+jump);
  float gate=step(0.40, gateRand);
  float n=(s1+s2+s3)/3.0; n*=gate; n = sign(n)*pow(abs(n), 0.35);

  // Weight gated by region mask * fade
  float weight = clamp(inMask * (strength > 0.0 ? strength : 1.0) * fadeEdge, 0.0, 1.0);

  float baseStrength = mix(0.10, 0.18, h2(q + 211.0));
  float strengthN    = baseStrength * clamp(noiseStrength, 0.0, 1.0) * weight;
  vec3 color         = clamp(src.rgb + n * strengthN, 0.0, 1.0);

  if (scratch > 0.0) {
    float spacing = mix(300.0, 60.0, clamp(scratchDensity, 0.0, 1.0));
    float colId   = floor(screenPx.x / spacing);
    float jitter  = h2(vec2(colId, frame));
    float center  = colId * spacing + jitter * spacing;
    float dist    = abs(screenPx.x - center);

    float sigma   = 1.2;
    float line    = exp(-0.5 * (dist*dist) / max(sigma*sigma, 1e-4));
    float flicker = 0.6 + 0.4 * h2(vec2(colId + frame, 7.23));
    float sAmt    = scratch * weight * flicker;

    color = clamp(color + vec3(line) * 0.25 * sAmt, 0.0, 1.0);
  }

  if (sepiaAmount > 0.0) {
    float gray      = (color.r + color.g + color.b) / 3.0;
    vec3  grayscale = vec3(gray);
    vec3  sep       = Overlay(SEPIA_RGB, grayscale);
    color           = mix(grayscale, sep, clamp(sepiaAmount, 0.0, 1.0));
  }

  vec3 finalRGB = mix(src.rgb, color, weight);
  gl_FragColor  = vec4(finalRGB, src.a);
}
