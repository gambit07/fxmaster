
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
uniform vec2  viewSize;     /** CSS px of mask RT (usually screen size) */
uniform vec4  inputSize;    /** xy: input size in CSS px; zw: 1/size */
uniform vec4  outputFrame;  /** xy: offset in CSS px;   zw: size */

uniform float hasMask;
uniform float maskReady;

/** ---- Effect params ---- */
uniform float time;
uniform vec3  color;
uniform float density;
uniform vec2  dimensions;

uniform float invertMask;
uniform float maskSoft;
uniform float strength;

/** ---- Region fade (shared with Color) ---- */
uniform int   uRegionShape;
uniform mat3  uCssToWorld;

/** Rect/Ellipse analytics */
uniform vec2  uCenter;
uniform vec2  uHalfSize;
uniform float uRotation;

/** Polygon SDF (absolute-width & inradius only) */
uniform sampler2D uSdf;
uniform mat3  uUvFromWorld;   /** world -> SDF UV */
uniform vec2  uSdfScaleOff;   /** [scale, offset] for decode */
uniform float uSdfInsideMax;  /** inradius (world px) */
uniform vec2  uSdfTexel;      /** 1/texture size (UV texel) */

/** Absolute width */
uniform float uFadeWorld;     /** world px */
uniform float uFadePx;        /** CSS px */

/** Percent mode */
uniform float uUsePct;        /** 1 => use uFadePct */
uniform float uFadePct;       /** 0..1 */

/** SDF-backed polygon % fades (used for multi-shape regions) */
uniform float uUseSdf;        /** 1 => use SDF for polygon % fades */

/** Polygon edges (percent mode) */
#define MAX_EDGES 64
uniform float uEdgeCount;
uniform vec4  uEdges[MAX_EDGES]; /** (Ax,Ay,Bx,By) world units */
uniform float uSmoothKWorld;     /** world-px smoothing radius */

varying vec2 vFilterCoord;   /** world-anchored coord (from custom vertex) */
varying vec2 vTextureCoord;  /** sampler UVs */

/** ---------------- noise ---------------- */
float rand(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453123); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  float a = rand(i + vec2(0.0,0.0)), b = rand(i + vec2(1.0,0.0));
  float c = rand(i + vec2(0.0,1.0)), d = rand(i + vec2(1.0,1.0));
  vec2 u = f*f*(3.0-2.0*f);
  return mix(a,b,u.x) + (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;
}
/**
 * Non-standard FBM variant: feeds back through sin(v * 1.07) each octave instead of the usual accumulation (v += a * noise(p)). This produces a more organic, swirling fog pattern and is intentional - do not "fix" to standard FBM without comparing the visual output.
 */
float fbm(vec2 p){
  float v=0.0,a=0.5; vec2 shift=vec2(100.0);
  mat2 rot = mat2(cos(0.5), sin(0.5), -sin(0.5), cos(0.5));
  for(int i=0;i<10;i++){ v=(sin(v*1.07))+(a*noise(p)); p=rot*p*1.9+shift; a*=0.5; }
  return v;
}
vec3 applyContrast(vec3 c, float contrast){ float t=(1.0-contrast)*0.5; return c*contrast + vec3(t); }

/** ---------------- main ---------------- */

/** Shared region fade infrastructure */
#include <region-fade-common>

void main(void){
  vec4 src = texture2D(uSampler, vTextureCoord);
  float inMask = src.a;

  /** SCREEN position in CSS px (match Color) */
  vec2 screenPx = outputFrame.xy + vTextureCoord * inputSize.xy;

  /** Region/suppression gating in CSS px */
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

  /** Per-pixel edge fade */
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
    float fadeWorld = (uFadeWorld > 0.0) ? uFadeWorld
                     : (uFadePx > 0.0   ? uFadePx * worldPerCss() : 0.0);
    if (fadeWorld > 0.0) {
      if      (uRegionShape == 1 || uRegionShape == 2) fadeEdge = maskAnalytic_abs(pW, fadeWorld, uRegionShape);
      else if (uRegionShape == 0)                      fadeEdge = maskPolySdf_abs(pW, fadeWorld);
    }
  }

  /** Fog intensity gated by region mask & fade */
  float k = clamp(density, 0.0, 1.0) * clamp(strength, 0.0, 1.0) * inMask * fadeEdge;
  if (k <= 0.0001) { gl_FragColor = src; return; }

  /** World-anchored fog pattern */
  vec2 p = vFilterCoord * 7.0 * dimensions * 0.00025;
  float t = (time * 0.0025);

  vec2 q; q.x = fbm(p); q.y = fbm(p);
  vec2 r; r.x = fbm(p*q + vec2(1.7,9.2) + 0.15*t);
           r.y = fbm(p*q + vec2(9.3,2.8) + 0.35*t);
  float f = fbm(p*0.2 + r*3.102);

  vec3 baseFog = mix(color, vec3(1.2), clamp(abs(r.x), 0.4, 1.0));
  float shape  = f*f*f + 0.6*f*f + 0.5*f;
  vec3 fogRGB  = applyContrast(baseFog * shape, 3.0);

  vec3 outRGB = mix(src.rgb, fogRGB, k);
  gl_FragColor = vec4(outRGB, src.a);
}
