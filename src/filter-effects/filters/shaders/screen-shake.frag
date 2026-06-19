/**
 * SPDX-FileCopyrightText: 2026 Gambit
 */

#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
precision highp int;
#else
precision mediump float;
precision mediump int;
#endif

uniform sampler2D uSampler;
uniform sampler2D maskSampler;

uniform vec2 viewSize;
uniform vec4 inputSize;
uniform vec4 outputFrame;
uniform vec2 camFrac;

uniform float hasMask;
uniform float maskReady;
uniform float invertMask;
uniform float maskSoft;
uniform float strength;
uniform vec2 shakeOffsetPx;
uniform vec2 blurOffsetPx;
uniform float blurStrength;
uniform float edgeZoom;

uniform int uRegionShape;
uniform mat3 uCssToWorld;

uniform vec2 uCenter;
uniform vec2 uHalfSize;
uniform float uRotation;

uniform sampler2D uSdf;
uniform mat3 uUvFromWorld;
uniform vec2 uSdfScaleOff;
uniform float uSdfInsideMax;
uniform vec2 uSdfTexel;

uniform float uFadeWorld;
uniform float uFadePx;
uniform float uUsePct;
uniform float uFadePct;
uniform float uUseSdf;

#define MAX_EDGES 64
uniform float uEdgeCount;
uniform vec4 uEdges[MAX_EDGES];
uniform float uSmoothKWorld;

varying vec2 vTextureCoord;

#include <region-fade-common>

void main(void) {
  vec4 src = texture2D(uSampler, vTextureCoord);

  vec2 screenPx = outputFrame.xy + vTextureCoord * outputFrame.zw;
  vec2 snapPx = screenPx - camFrac;

  float inMask = src.a;
  if (hasMask > 0.5) {
    bool maskUsable = (maskReady > 0.5) && (viewSize.x >= 1.0) && (viewSize.y >= 1.0);
    if (maskUsable) {
      vec2 samplePx = (uRegionShape < 0) ? screenPx : snapPx;
      vec2 maskPx = floor(samplePx) + 0.5;
      vec2 maskUV = clamp(maskPx / max(viewSize, vec2(1.0)), 0.0, 1.0);
      float a = clamp(texture2D(maskSampler, maskUV).r, 0.0, 1.0);
      float m = (maskSoft > 0.5) ? a : ((uRegionShape < 0) ? step(0.5, a) : smoothstep(0.48, 0.52, a));
      if (invertMask > 0.5) m = 1.0 - m;
      inMask *= m;
    }
  }

  float fade = 1.0;
  vec2 pW = applyCssToWorld(snapPx);

  if (uUsePct > 0.5) {
    float pct = clamp(uFadePct, 0.0, 1.0);
    if (pct > 0.0) {
      if (uRegionShape == 1) fade = fadePctRect(pW, pct);
      else if (uRegionShape == 2) fade = fadePctEllipse(pW, pct);
      else if (uRegionShape == 0) fade = (uUseSdf > 0.5) ? fadePctPoly_sdf(pW, pct) : fadePctPoly_edges(pW, pct);
    }
  } else {
    float fadeWorld = (uFadeWorld > 0.0) ? uFadeWorld : (uFadePx > 0.0 ? uFadePx * worldPerCss() : 0.0);
    if (fadeWorld > 0.0) {
      if (uRegionShape == 1 || uRegionShape == 2) fade = maskAnalytic_abs(pW, fadeWorld, uRegionShape);
      else if (uRegionShape == 0) fade = maskPolySdf_abs(pW, fadeWorld);
    }
  }

  float weight = clamp(inMask * fade * strength, 0.0, 1.0);
  if (weight <= 0.0001) {
    gl_FragColor = src;
    return;
  }

  vec2 centeredUv = (vTextureCoord - 0.5) / max(edgeZoom, 1.0) + 0.5;
  vec2 shiftedUv = clamp(centeredUv - shakeOffsetPx * inputSize.zw, vec2(0.0), vec2(1.0));
  vec4 shifted = texture2D(uSampler, shiftedUv);

  float blurAmount = clamp(blurStrength, 0.0, 1.0);
  if (blurAmount > 0.0001) {
    vec2 blurUv = blurOffsetPx * inputSize.zw;
    vec4 blurred = shifted * 0.34;
    blurred += texture2D(uSampler, clamp(shiftedUv - blurUv, vec2(0.0), vec2(1.0))) * 0.22;
    blurred += texture2D(uSampler, clamp(shiftedUv + blurUv, vec2(0.0), vec2(1.0))) * 0.22;
    blurred += texture2D(uSampler, clamp(shiftedUv - blurUv * 2.0, vec2(0.0), vec2(1.0))) * 0.11;
    blurred += texture2D(uSampler, clamp(shiftedUv + blurUv * 2.0, vec2(0.0), vec2(1.0))) * 0.11;
    shifted = mix(shifted, blurred, blurAmount);
  }

  gl_FragColor = mix(src, shifted, weight);
}
