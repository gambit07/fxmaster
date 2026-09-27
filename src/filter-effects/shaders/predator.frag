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

#ifdef GL_OES_standard_derivatives
#extension GL_OES_standard_derivatives : enable
#endif

uniform sampler2D uSampler;
uniform sampler2D maskSampler;

uniform vec2 viewSize;
uniform vec4 inputSize;
uniform vec4 outputFrame;
uniform vec4 srcFrame;
uniform vec2 camFrac;

uniform float hasMask;
uniform float maskReady;
uniform float invertMask;
uniform float maskSoft;
uniform float maskWorldReady;
uniform mat3 uMaskUvFromWorld;
uniform vec2 maskTexelUV;

uniform float time;
uniform float seed;
uniform float speedWorld;
uniform float lineWidthWorld;
uniform float noiseAmt;
uniform float scanlineStrength;
uniform float thermalStrength;
uniform float tokenHeatSeek;
uniform float tokenHeatReady;
uniform sampler2D tokenHeatSampler;
uniform mat3 uHeatUvFromWorld;
uniform float strength;
uniform float thermalContrast;
uniform float edgeDefinition;
uniform float stripeContrast;
uniform float aaCssPx;

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

vec2 fxmMaskUvFromCss(vec2 cssPx) {
  if (maskWorldReady > 0.5) {
    vec2 world = applyCssToWorld(cssPx);
    return (uMaskUvFromWorld * vec3(world, 1.0)).xy;
  }
  return cssPx / max(viewSize, vec2(1.0));
}

float fxmMaskSampleUv(vec2 uv) {
  if (maskWorldReady > 0.5 && (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0)) return 0.0;
  return clamp(texture2D(maskSampler, clamp(uv, vec2(0.0), vec2(1.0))).r, 0.0, 1.0);
}

float fxmMaskSample(vec2 cssPx) {
  return fxmMaskSampleUv(fxmMaskUvFromCss(cssPx));
}

float fxmLuma(vec3 color) {
  return dot(color, vec3(0.2126, 0.7152, 0.0722));
}

float fxmHash(vec2 point) {
  return fract(sin(dot(point, vec2(127.1, 311.7))) * 43758.5453123);
}

vec3 fxmThermalPalette(float heat) {
  float t = clamp(heat, 0.0, 1.0);
  if (t < 0.18) return mix(vec3(0.015, 0.005, 0.08), vec3(0.0, 0.08, 0.55), t / 0.18);
  if (t < 0.38) return mix(vec3(0.0, 0.08, 0.55), vec3(0.42, 0.02, 0.58), (t - 0.18) / 0.20);
  if (t < 0.58) return mix(vec3(0.42, 0.02, 0.58), vec3(0.95, 0.04, 0.03), (t - 0.38) / 0.20);
  if (t < 0.78) return mix(vec3(0.95, 0.04, 0.03), vec3(1.0, 0.48, 0.02), (t - 0.58) / 0.20);
  if (t < 0.92) return mix(vec3(1.0, 0.48, 0.02), vec3(1.0, 0.95, 0.16), (t - 0.78) / 0.14);
  return mix(vec3(1.0, 0.95, 0.16), vec3(1.0), (t - 0.92) / 0.08);
}

float fxmThermalEdge(vec2 uv) {
  if (edgeDefinition <= 0.001) return 0.0;

  vec2 texel = max(inputSize.zw, vec2(0.000001));
  float left = fxmLuma(texture2D(uSampler, clamp(uv - vec2(texel.x, 0.0), vec2(0.0), vec2(1.0))).rgb);
  float right = fxmLuma(texture2D(uSampler, clamp(uv + vec2(texel.x, 0.0), vec2(0.0), vec2(1.0))).rgb);
  float up = fxmLuma(texture2D(uSampler, clamp(uv - vec2(0.0, texel.y), vec2(0.0), vec2(1.0))).rgb);
  float down = fxmLuma(texture2D(uSampler, clamp(uv + vec2(0.0, texel.y), vec2(0.0), vec2(1.0))).rgb);
  return clamp(length(vec2(right - left, down - up)) * 2.75, 0.0, 1.0);
}

void main() {
  vec4 src = texture2D(uSampler, vTextureCoord);

  vec2 screenPx = outputFrame.xy + vTextureCoord * inputSize.xy;
  vec2 snapPx = screenPx - camFrac;
  vec2 worldPx = applyCssToWorld(snapPx);

  float inMask = src.a;
  if (hasMask > 0.5) {
    bool maskUsable = (maskReady > 0.5) && (viewSize.x >= 1.0) && (viewSize.y >= 1.0);
    if (maskUsable) {
      vec2 samplePx = (uRegionShape < 0) ? screenPx : snapPx;
      vec2 maskPx = floor(samplePx) + 0.5;
      float alpha = fxmMaskSample(maskPx);
      float maskValue = (maskSoft > 0.5)
        ? alpha
        : ((uRegionShape < 0) ? step(0.5, alpha) : smoothstep(0.48, 0.52, alpha));
      if (invertMask > 0.5) maskValue = 1.0 - maskValue;
      inMask *= maskValue;
    }
  }

  float fadeEdge = 1.0;
  vec2 fadeWorld = applyCssToWorld((uRegionShape < 0) ? screenPx : snapPx);

  if (uUsePct > 0.5) {
    float pct = clamp(uFadePct, 0.0, 1.0);
    if (pct > 0.0) {
      if (uRegionShape == 1) fadeEdge = fadePctRect(fadeWorld, pct);
      else if (uRegionShape == 2) fadeEdge = fadePctEllipse(fadeWorld, pct);
      else if (uRegionShape == 0) {
        fadeEdge = (uUseSdf > 0.5) ? fadePctPoly_sdf(fadeWorld, pct) : fadePctPoly_edges(fadeWorld, pct);
      }
    }
  } else {
    float fadeWidth = (uFadeWorld > 0.0)
      ? uFadeWorld
      : (uFadePx > 0.0 ? uFadePx * worldPerCss() : 0.0);
    if (fadeWidth > 0.0) {
      if (uRegionShape == 1 || uRegionShape == 2) {
        float distance = (uRegionShape == 1)
          ? sdRect(fadeWorld, uCenter, uHalfSize, uRotation)
          : sdEllipse(fadeWorld, uCenter, uHalfSize, uRotation);
        fadeEdge = 1.0 - smoothstep(0.0, fadeWidth, distance + fadeWidth);
      } else if (uRegionShape == 0) {
        float distance = sdPolySmooth(fadeWorld);
        fadeEdge = 1.0 - smoothstep(0.0, fadeWidth, distance + fadeWidth);
      }
    }
  }

  float mixAmount = clamp(inMask * fadeEdge * strength, 0.0, 1.0);
  if (mixAmount <= 0.0001) {
    gl_FragColor = src;
    return;
  }

  float halfWidth = max(0.25, lineWidthWorld * 0.5);
  float pitch = max(1.0, halfWidth * 4.0);
  float phaseWorld = worldPx.y + time * speedWorld;
  float phase = fract(phaseWorld / pitch);
  float stripeDistance = abs(phase - 0.5) * pitch;

  float aaWorld = max(0.001, aaCssPx * worldPerCss());
  #ifdef GL_OES_standard_derivatives
    aaWorld = max(aaWorld, 1.25 * fwidth(phaseWorld) + 0.5 * fwidth(stripeDistance));
  #endif

  float stripeMask = 1.0 - smoothstep(halfWidth, halfWidth + aaWorld, stripeDistance);
  stripeMask = pow(stripeMask, max(stripeContrast, 0.5));

  vec3 predator = src.rgb;
  float thermalAmount = tokenHeatSeek > 0.5 ? 1.0 : clamp(thermalStrength, 0.0, 1.0);
  if (thermalAmount > 0.0001) {
    float luminance = fxmLuma(src.rgb);
    float contrastScale = mix(0.75, 2.5, clamp(thermalContrast, 0.0, 1.0));
    float heat = clamp((luminance - 0.5) * contrastScale + 0.5, 0.0, 1.0);

    if (tokenHeatSeek > 0.5) {
      vec2 heatUv = (uHeatUvFromWorld * vec3(applyCssToWorld(screenPx), 1.0)).xy;
      float tokenAlpha = 0.0;
      if (tokenHeatReady > 0.5 && all(greaterThanEqual(heatUv, vec2(0.0))) && all(lessThanEqual(heatUv, vec2(1.0)))) {
        tokenAlpha = texture2D(tokenHeatSampler, heatUv).a;
      }
      heat = mix(0.05 + heat * 0.22, 0.68 + heat * 0.30, tokenAlpha);
    }

    float edgeAmount = 0.0;
    if (edgeDefinition > 0.0001) {
      edgeAmount = clamp(fxmThermalEdge(vTextureCoord) * edgeDefinition, 0.0, 1.0);
    }

    vec3 thermal = fxmThermalPalette(heat);
    if (edgeAmount > 0.0001) {
      float edgeHeat = clamp(heat + 0.22, 0.0, 1.0);
      thermal = mix(thermal, fxmThermalPalette(edgeHeat), edgeAmount * 0.75);
    }
    thermal *= mix(0.82, 1.12, luminance);
    predator = mix(src.rgb, thermal, thermalAmount);
  }

  float scanModulation = 1.0 + clamp(scanlineStrength, 0.0, 1.0) * (stripeMask * 0.30 - 0.15);
  float grain = 0.0;
  if (noiseAmt > 0.0001) {
    float grainSize = max(1.0, lineWidthWorld * 0.75);
    vec2 grainCell = floor(worldPx / grainSize);
    float grainFrame = floor(seed * 0.5);
    grain = fxmHash(grainCell + vec2(grainFrame * 17.0, grainFrame * 31.0)) - 0.5;
    grain *= 0.25 * clamp(noiseAmt, 0.0, 1.0);
  }

  predator = clamp(predator * scanModulation + grain, 0.0, 1.25);

  vec3 outputColor = mix(src.rgb, predator, mixAmount);
  gl_FragColor = vec4(outputColor, src.a);
}
