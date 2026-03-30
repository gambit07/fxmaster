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

// CSS px: (stage unsnapped) - (stage snapped). Used to align with snapped-mask RTs.
uniform vec2  camFrac;

// Region-mask flags
uniform float hasMask;
uniform float maskReady;
uniform float invertMask;  // 0/1
uniform float maskSoft;
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

/* SDF-backed polygon % fades (used for multi-shape regions) */
uniform float uUseSdf;        // 1 => use SDF for polygon % fades

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

/* ---------------- main ---------------- */

/* Shared region fade infrastructure */
#include <region-fade-common>

void main(){
  vec4 src = texture2D(uSampler, vTextureCoord);

  // CSS px of the sampled screen point
  vec2 screenPx = outputFrame.xy + vTextureCoord * inputSize.xy;
  vec2 snapPx   = screenPx - camFrac;

  // Region/suppression mask in screen pixels
  float inMask = src.a;
  if (hasMask > 0.5) {
    bool maskUsable = (maskReady > 0.5) &&
                      (viewSize.x >= 1.0) &&
                      (viewSize.y >= 1.0);
    if (maskUsable) {
      // Scene masks are binary and should be stable across pan/zoom.
      // Use screen-space sampling for scene (uRegionShape < 0), and snapped sampling for region masks.
      vec2 samplePx = (uRegionShape < 0) ? screenPx : snapPx;

      // Sample at texel centers to reduce boundary jitter.
      vec2 maskPx = floor(samplePx) + 0.5;
      vec2 maskUV = clamp(maskPx / max(viewSize, vec2(1.0)), 0.0, 1.0);
      float a     = clamp(texture2D(maskSampler, maskUV).r, 0.0, 1.0);

      // Hard step for scene allow-mask to avoid 1px seams; soft edge for region masks.
      float m     = (maskSoft > 0.5) ? a : ((uRegionShape < 0) ? step(0.5, a) : smoothstep(0.48, 0.52, a));
      if (invertMask > 0.5) m = 1.0 - m;
      inMask *= m;
    }
  }

  // Per-pixel region fade (percent or absolute)
  float fadeEdge = 1.0;
  vec2  pW       = applyCssToWorld((uRegionShape < 0) ? screenPx : snapPx);

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

  // Grain basis (stable integer pixels) - scale by noiseSize
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
