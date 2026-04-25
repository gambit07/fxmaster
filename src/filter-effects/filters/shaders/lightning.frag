
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
precision highp int;
#else
precision mediump float;
precision mediump int;
#endif

/** -------- Inputs -------- */
uniform sampler2D uSampler;
uniform sampler2D maskSampler;

/** Use Pixi frames like Color */
uniform vec2  viewSize;     /** CSS px of mask RT (usually screen size) */
uniform vec4  inputSize;    /** xy: input size in CSS px; zw: 1/size */
uniform vec4  outputFrame;  /** xy: offset in CSS px;    zw: size */

/** Keep for ABI/back-compat; not used for mask sample now */
uniform vec4  srcFrame;
uniform vec2  camFrac;

uniform float hasMask;
uniform float maskReady;
uniform float invertMask;
uniform float maskSoft;

/** Effect */
uniform float brightness;

/** -------- Region fade (same schema as Color/Fog) -------- */
uniform int   uRegionShape;
uniform mat3  uCssToWorld;

uniform vec2  uCenter;
uniform vec2  uHalfSize;
uniform float uRotation;

uniform sampler2D uSdf;
uniform mat3  uUvFromWorld;    /** world -> SDF UV */
uniform vec2  uSdfScaleOff;    /** [scale, offset] for decode */
uniform float uSdfInsideMax;   /** inradius (world px) */
uniform vec2  uSdfTexel;       /** 1/texture size (UV texel) */

uniform float uFadeWorld;      /** world px */
uniform float uFadePx;         /** CSS px */

uniform float uUsePct;         /** 1 => use uFadePct */
uniform float uFadePct;        /** 0..1 */

/** SDF-backed polygon % fades (used for multi-shape regions) */
uniform float uUseSdf;        /** 1 => use SDF for polygon % fades */

#define MAX_EDGES 64
uniform float uEdgeCount;
uniform vec4  uEdges[MAX_EDGES]; /** (Ax,Ay,Bx,By) world units */
uniform float uSmoothKWorld;     /** world-px smoothing radius */

varying vec2 vTextureCoord;

/** ---------------- main ---------------- */

/** Shared region fade infrastructure */
#include <region-fade-common>

void main(void) {
  vec4 src = texture2D(uSampler, vTextureCoord);

  /** SCREEN position in CSS px (match Color) */
  vec2 screenPx = outputFrame.xy + vTextureCoord * inputSize.xy;

  /** region/suppression gating */
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

  /** region edge fade (percent or absolute) */
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

  /** brightness flash, gated by mask * fade */
  float mixAmt = clamp(inMask * fadeEdge, 0.0, 1.0);
  vec3 lit     = src.rgb * max(brightness, 0.0);
  vec3 outRgb  = mix(src.rgb, lit, mixAmt);
  gl_FragColor = vec4(outRgb, src.a);
}
