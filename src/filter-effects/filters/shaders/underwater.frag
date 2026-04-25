
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
precision highp int;
#else
precision mediump float;
precision mediump int;
#endif

uniform sampler2D uSampler;
uniform sampler2D maskSampler;

/** ---- Pixi pipeline frames (match Color) ---- */
uniform vec2  viewSize;     /** CSS px of mask RT */
uniform vec4  inputSize;    /** xy: input size in CSS px; zw: 1/size */
uniform vec4  outputFrame;  /** xy: offset in CSS px;    zw: size */

/** Kept for ABI/back-compat; not used for mask sample now */
uniform vec4  srcFrame;     /** CSS px area spanned by vTextureCoord */
uniform vec2  camFrac;      /** CSS px fractional camera translation */

uniform float hasMask;
uniform float maskReady;
uniform float invertMask;
uniform float maskSoft;
uniform float feather;      /** optional mask feather (CSS px) */
uniform float strength;     /** 0..1 overall effect strength */

/** -------- Displacement map -------- */
uniform sampler2D mapSampler;
uniform vec2      mapScale;   /** displacement in pixels (x,y) */
uniform vec2      mapRepeat;
uniform vec2      mapOffset;
uniform vec2      mapTexel;   /** 1/texSize (set from JS) */

/** -------- NEW: tokens-only mask for belowTokens -------- */
uniform sampler2D tokenSampler;  /** CSS-space tokens mask (alpha) */
uniform float     hasTokenMask;  /** 1 when provided, else 0 */

varying vec2 vTextureCoord;

/** -------- Region fade (same schema as other filters) -------- */
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

/** ====================== Helpers ====================== */

vec2 wrapUV(vec2 uv){ return fract(uv); }

/** ====================== Main ====================== */

/** Shared region fade infrastructure */
#include <region-fade-common>

void main(void) {
  vec4 src = texture2D(uSampler, vTextureCoord);

  /** SCREEN position in CSS px (match Color) */
  vec2 screenPx = outputFrame.xy + vTextureCoord * inputSize.xy;

  /** ---- Region/suppression mask ---- */
  float inMask = src.a;
  if (hasMask > 0.5) {
    bool maskUsable = (maskReady > 0.5) &&
                      (viewSize.x >= 1.0) &&
                      (viewSize.y >= 1.0);
    if (maskUsable) {
      vec2 maskUV = screenPx / max(viewSize, vec2(1.0));
      float a = texture2D(maskSampler, maskUV).r;

      if (feather > 0.5) {
        vec2 px = 1.0 / max(viewSize, vec2(1.0));
        vec2 o  = px * feather;
        float s = 0.0;
        s += texture2D(maskSampler, maskUV + vec2(-o.x, -o.y)).r;
        s += texture2D(maskSampler, maskUV + vec2( 0.0, -o.y)).r;
        s += texture2D(maskSampler, maskUV + vec2( o.x, -o.y)).r;
        s += texture2D(maskSampler, maskUV + vec2(-o.x,  0.0)).r;
        s += a;
        s += texture2D(maskSampler, maskUV + vec2( o.x,  0.0)).r;
        s += texture2D(maskSampler, maskUV + vec2(-o.x,  o.y)).r;
        s += texture2D(maskSampler, maskUV + vec2( 0.0,  o.y)).r;
        s += texture2D(maskSampler, maskUV + vec2( o.x,  o.y)).r;
        a = s / 9.0;
      }

      float m = (maskSoft > 0.5) ? a : smoothstep(0.49, 0.51, a);
      if (invertMask > 0.5) m = 1.0 - m;
      inMask *= m;
    }
  }

  /** ---- Region edge fade (percent or absolute) ---- */
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

  /** ---- Final weight = mask * strength * fade ---- */
  float weight = clamp(inMask * (strength > 0.0 ? strength : 1.0) * fadeEdge, 0.0, 1.0);
  if (weight <= 0.0001) { gl_FragColor = src; return; }

  /** ---- Displacement with tile-edge seam avoidance ---- */
  vec2 uvBase   = vTextureCoord * mapRepeat + mapOffset;
  vec2 uvA      = wrapUV(uvBase);
  vec2 uvB      = wrapUV(uvBase + vec2(0.5, 0.0));
  vec2 pad      = max(mapTexel * 0.5, vec2(0.00025));
  uvA = clamp(uvA, pad, vec2(1.0) - pad);
  uvB = clamp(uvB, pad, vec2(1.0) - pad);

  vec2 dispA    = texture2D(mapSampler, uvA).rg;
  vec2 dispB    = texture2D(mapSampler, uvB).rg;
  vec2 disp     = ((dispA + dispB) * 0.5) - 0.5;
  vec2 dispPx   = disp * mapScale;

  vec2 uvOffset = dispPx / max(viewSize, vec2(1.0));
  vec2 duv      = vTextureCoord + uvOffset;

  vec4 displaced = texture2D(uSampler, duv);

  float tokenA = 0.0;
  if (hasTokenMask > 0.5) {
    vec2 displacedScreenPx = screenPx + dispPx;
    vec2 tokenUV = displacedScreenPx / max(viewSize, vec2(1.0));
    vec2 cssPx = 1.0 / max(viewSize, vec2(1.0));
    for (int dy = -1; dy <= 1; ++dy) {
      for (int dx = -1; dx <= 1; ++dx) {
        vec2 off = vec2(float(dx), float(dy)) * cssPx;
        tokenA = max(tokenA, texture2D(tokenSampler, tokenUV + off).a);
      }
    }
  }

  vec3 refracted = mix(displaced.rgb, src.rgb, tokenA);

  vec3 outRgb    = mix(src.rgb, refracted, weight);
  gl_FragColor   = vec4(outRgb, src.a);
}
