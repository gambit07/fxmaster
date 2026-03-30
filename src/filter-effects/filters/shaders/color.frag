// SPDX-FileCopyrightText: 2025 Gambit
/* Region/scene gating + color controls + hybrid fade to edge.
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
uniform float maskSoft;
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

/* SDF-backed polygon % fades (used for multi-shape regions) */
uniform float uUseSdf;        // 1 => use SDF for polygon % fades

/* Polygon edges (analytic percent fade) */
#define MAX_EDGES 64
uniform float uEdgeCount;      // <= MAX_EDGES
uniform vec4  uEdges[MAX_EDGES]; // (Ax,Ay,Bx,By) in world units
uniform float uSmoothKWorld;   // world-px smoothing radius for edge combiner

varying vec2 vTextureCoord;

float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3  softClip(vec3 c){ float m = max(c.r, max(c.g, c.b)); return (m > 1.0) ? (c / m) : c; }


/* Shared region fade infrastructure */
#include <region-fade-common>

/* ---------- Main ---------- */
void main(void) {
  vec4 src = texture2D(uSampler, vTextureCoord);

  // pixel position in CSS px that sampled src
  vec2 screenPx = outputFrame.xy + vTextureCoord * inputSize.xy;
  vec2 snapPx   = screenPx - camFrac;

  /* Region/suppression gating */
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
      float a = clamp(texture2D(maskSampler, maskUV).r, 0.0, 1.0);

      // For the scene allow-mask, a hard step avoids 1px seams; for region masks keep a soft edge.
      float m = (maskSoft > 0.5) ? a : ((uRegionShape < 0) ? step(0.5, a) : smoothstep(0.48, 0.52, a));
      if (invertMask > 0.5) m = 1.0 - m;
      inMask *= m;
    }
  }

  /* Fade factor */
  float fade = 1.0;
  vec2 pW = applyCssToWorld(snapPx);

  if (uUsePct > 0.5) {
    float pct = clamp(uFadePct, 0.0, 1.0);
    if (pct > 0.0) {
      if (uRegionShape == 1)       fade = fadePctRect(pW, pct);
      else if (uRegionShape == 2)  fade = fadePctEllipse(pW, pct);
      else if (uRegionShape == 0) {
        fade = (uUseSdf > 0.5) ? fadePctPoly_sdf(pW, pct) : fadePctPoly_edges(pW, pct);
      }
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
