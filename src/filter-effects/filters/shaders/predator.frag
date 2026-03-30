// SPDX-FileCopyrightText: 2025 Gambit

#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
precision highp int;
#else
precision mediump float;
precision mediump int;
#endif

#ifdef GL_OES_standard_derivatives
#extension GL_OES_standard_derivatives : enable
#endif

uniform sampler2D uSampler;
uniform sampler2D maskSampler;

/* ---- Pixi pipeline frames (match Color) ---- */
uniform vec2  viewSize;     // CSS px of mask RT (usually screen size)
uniform vec4  inputSize;    // xy: input size in CSS px; zw: 1/size
uniform vec4  outputFrame;  // xy: offset in CSS px;    zw: size

/* Kept for ABI/back-compat; not used for mask sample */
uniform vec4  srcFrame;     // CSS px: (x,y,w,h)
uniform vec2  camFrac;      // CSS px: fractional camera translation

uniform float hasMask;
uniform float maskReady;
uniform float invertMask; // 0/1
uniform float maskSoft;

// Effect params
uniform float time;        // seconds
uniform float speedPx;     // px/s (negative => down)
uniform float lineWidthPx; // stripe thickness in px
uniform float noiseAmt;    // 0..1
uniform float contrast;    // ~1.5
uniform float aaPx;        // AA width in px (fallback / minimum)

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
uniform mat3  uUvFromWorld;
uniform vec2  uSdfScaleOff;
uniform float uSdfInsideMax;
uniform vec2  uSdfTexel;

// Absolute width (compatibility)
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


/* Shared region fade infrastructure */
#include <region-fade-common>

void main() {
  vec4 src = texture2D(uSampler, vTextureCoord);

  // SCREEN position in CSS px (match Color)
  vec2 screenPx = outputFrame.xy + vTextureCoord * inputSize.xy;

  // --- Region/suppression gating ---
  float inMask = src.a;
  if (hasMask > 0.5) {
    bool maskUsable = (maskReady > 0.5) &&
                      (viewSize.x >= 1.0) &&
                      (viewSize.y >= 1.0);
    if (maskUsable) {
      vec2 maskUV = screenPx / max(viewSize, vec2(1.0));
      float aRaw  = texture2D(maskSampler, maskUV).r;
      float a     = clamp(aRaw, 0.0, 1.0);
      float m     = (maskSoft > 0.5) ? a : smoothstep(0.48, 0.52, a);
      if (invertMask > 0.5) m = 1.0 - m;
      inMask *= m;
    }
  }

  // --- Per-pixel region edge fade (percent or absolute) ---
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

  // --- Stripe model in screen pixels ---
  float halfW = max(0.5, lineWidthPx * 0.5);
  float pitch = max(2.0, halfW * 4.0);

  float phasePx = screenPx.y + time * speedPx;
  float t  = fract(phasePx / pitch);
  float d  = abs(t - 0.5) * pitch;

  // Derivative-aware AA
  float aaDyn = aaPx;
  #ifdef GL_OES_standard_derivatives
    float fwPhase = fwidth(phasePx);
    float fwDist  = fwidth(d);
    aaDyn = max(aaPx, 1.25 * fwPhase + 0.5 * fwDist);
  #endif

  float stripeMask = 1.0 - smoothstep(halfW, halfW + aaDyn, d);
  stripeMask = pow(stripeMask, max(contrast, 0.5));

  // Light grain for texture
  vec2  hp = screenPx + vec2(37.0, 73.0);
  float g  = fract(sin(dot(hp, vec2(127.1,311.7))) * 43758.5453123) - 0.5;
  float grain = g * 0.25 * clamp(noiseAmt, 0.0, 1.0);

  float modulator = clamp(0.85 + 0.30 * stripeMask + grain, 0.0, 1.25);
  vec3 pred = src.rgb * modulator;

  // Gate stripes by mask * fade
  float mixAmt = clamp(inMask * fadeEdge, 0.0, 1.0);
  vec3 outRGB = mix(src.rgb, pred, mixAmt);
  gl_FragColor = vec4(outRGB, src.a);
}
