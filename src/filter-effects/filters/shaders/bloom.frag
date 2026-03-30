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
uniform float maskSoft;
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

/* SDF-backed polygon % fades (used for multi-shape regions) */
uniform float uUseSdf;        // 1 => use SDF for polygon % fades

// Polygon edges (percent mode)
#define MAX_EDGES 64
uniform float uEdgeCount;
uniform vec4  uEdges[MAX_EDGES]; // (Ax,Ay,Bx,By) world units
uniform float uSmoothKWorld;     // world-px smoothing radius

varying vec2 vTextureCoord;

/* ---------- helpers ---------- */
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3  softClip(vec3 c){ float m = max(c.r, max(c.g, c.b)); return (m > 1.0) ? (c / m) : c; }

/* ---------- main ---------- */
vec3 brightPassWeighted(vec2 uv, float w, float thr) {
  vec3 col = texture2D(uSampler, uv).rgb;
  float Y  = luma(col);
  float t  = max(Y - thr, 0.0) / max(1.0 - thr, 0.0001);
  return col * t * w;
}


/* Shared region fade infrastructure */
#include <region-fade-common>

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
      float m     = (maskSoft > 0.5) ? a : smoothstep(0.48, 0.52, a);
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
      else if (uRegionShape == 0) {
        fadeEdge = (uUseSdf > 0.5) ? fadePctPoly_sdf(pW, pct) : fadePctPoly_edges(pW, pct);
      }
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
