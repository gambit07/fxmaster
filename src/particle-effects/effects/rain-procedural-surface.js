import { logger } from "../../logger.js";
import { geometricDirectionToCanvasVector } from "../../utils/math.js";
import { getCssViewportMetrics, rawStageMatrix } from "../../utils/viewport.js";

const VERTEX_SHADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
attribute vec2 aVertexPosition;
uniform mat3 projectionMatrix;
uniform mat3 translationMatrix;
uniform vec2 uBoundsOriginGrid;
uniform vec2 uBoundsSizeGrid;
varying vec2 vRainCoord;
void main() {
  vec3 position = translationMatrix * vec3(aVertexPosition, 1.0);
  vRainCoord = uBoundsOriginGrid + aVertexPosition * uBoundsSizeGrid;
  gl_Position = vec4((projectionMatrix * position).xy, 0.0, 1.0);
}
`;
const FRAGMENT_SHADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vRainCoord;
uniform float uMotion;
uniform float uTopDownMotion;
uniform float uAlpha;
uniform float uWorldAlpha;
uniform float uScale;
uniform float uDensity;
uniform float uLifetime;
uniform float uTopDown;
uniform float uSeed;
uniform float uPixelRain;
uniform float uTopDownDensityBoost;
uniform float uDeadzoneGrid;
uniform float uTopDownBlend;
uniform float uTopDownPreviousSeed;
uniform float uTopDownCurrentSeed;
uniform vec2 uDirection;
uniform vec2 uTopDownPreviousFocusGrid;
uniform vec2 uTopDownCurrentFocusGrid;
uniform vec3 uColor;

const float FXM_PI = 3.14159265358979323846;
const float FXM_TAU = 6.28318530717958647692;

float rainHash12Seeded(vec2 p, float seedOffset) {
  p += (uSeed + seedOffset) * vec2(11.73, -8.91);
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 rainHash32Seeded(vec2 p, float seedOffset) {
  return vec3(
    rainHash12Seeded(p, seedOffset),
    rainHash12Seeded(p + vec2(17.17, 41.37), seedOffset),
    rainHash12Seeded(p + vec2(-29.41, 9.73), seedOffset)
  );
}

float rainHash12(vec2 p) {
  return rainHash12Seeded(p, 0.0);
}

vec3 rainHash32(vec2 p) {
  return rainHash32Seeded(p, 0.0);
}

float rainDensityAmount() {
  float normalized = clamp(log(1.0 + max(0.0, uDensity)) / log(7.20), 0.0, 1.0);
  float shaped = pow(normalized, 0.94);
  float lowDensityGate = smoothstep(0.010, 0.135, normalized);
  return shaped * lowDensityGate;
}

float rainLifetimeAmount() {
  return smoothstep(2.0, 5.0, clamp(uLifetime, 0.1, 5.0));
}

#ifndef FXM_RAIN_TOP_DOWN
vec2 sideRainLayer(
  vec2 oriented,
  float layer,
  float baseLaneWidth,
  float spacing,
  float speedFactor,
  float alphaFactor
) {
  float densityAmount = rainDensityAmount();
  float laneScale = mix(0.62, 1.88, densityAmount);
  float laneWidth = max(0.080, baseLaneWidth / laneScale);
  float laneCoord = oriented.x / laneWidth;
  float laneId = floor(laneCoord);
  float lanePhase = rainHash12(vec2(laneId, layer * 17.0));

  float cycleCoord = (oriented.y - uMotion * speedFactor) / max(0.5, spacing) + lanePhase;
  float cycleId = floor(cycleCoord);
  float phase = fract(cycleCoord);
  vec3 randomValues = rainHash32(vec2(laneId, cycleId) + vec2(layer * 31.7, layer * -13.9));
  float detailRandom = rainHash12(vec2(laneId - layer * 7.3, cycleId + layer * 19.1));

  float densityChance = mix(0.045, 0.80, densityAmount);
  densityChance *= mix(0.88, 1.12, clamp(layer / 1.55, 0.0, 1.0));
  float present = step(randomValues.z, clamp(densityChance, 0.018, 0.84));
  float laneCenter = mix(0.10, 0.90, randomValues.x);

  float lifetimeAmount = rainLifetimeAmount();
  float depth = clamp(layer / 1.70, 0.0, 1.0);
  float depthScale = mix(0.70, 1.24, depth);
  float commonLength = mix(0.15, 0.70, pow(randomValues.y, 1.18));
  float longDrop = smoothstep(0.76, 0.98, detailRandom) * mix(0.18, 0.72, randomValues.x);
  float streakLength = (commonLength + longDrop) * max(0.08, uScale);
  streakLength *= mix(0.46, 2.10, lifetimeAmount) * depthScale;
  float streakWidth = mix(0.0036, 0.0115, pow(randomValues.x, 1.25)) * sqrt(max(0.08, uScale));
  streakWidth *= mix(0.72, 1.34, depth);

  float alongDistance = fract(1.0 - phase) * spacing;
  float normalizedAlong = clamp(alongDistance / max(streakLength, 0.001), 0.0, 1.0);
  float dropSlant = (detailRandom - 0.5) * 0.050;
  float crossOffset = (fract(laneCoord) - laneCenter) * laneWidth;
  crossOffset -= dropSlant * alongDistance;
  float crossDistance = abs(crossOffset);

  float antiAlias = max(uPixelRain * 1.05, streakWidth * 0.24);
  float headToTail = max(0.0, 1.0 - normalizedAlong);
  float tailStrength = pow(headToTail, mix(1.10, 1.48, detailRandom));
  float tipBulge = exp(-normalizedAlong * normalizedAlong * 118.0);
  float widthProfile = mix(0.055, 0.72, pow(headToTail, 0.54));
  widthProfile += tipBulge * 0.11;

  float line = 1.0 - smoothstep(
    streakWidth * widthProfile,
    streakWidth * widthProfile + antiAlias,
    crossDistance
  );
  float core = 1.0 - smoothstep(
    streakWidth * widthProfile * 0.23,
    streakWidth * widthProfile * 0.23 + antiAlias,
    crossDistance
  );
  float softEdge = 1.0 - smoothstep(
    streakWidth * widthProfile * 1.32,
    streakWidth * widthProfile * 2.65 + antiAlias,
    crossDistance
  );
  float body = 1.0 - smoothstep(streakLength, streakLength + antiAlias * 3.0, alongDistance);

  float tipDistance = length(vec2(crossOffset * 1.08, alongDistance * 1.10));
  float tip = 1.0 - smoothstep(
    streakWidth * 1.02,
    streakWidth * 1.02 + antiAlias * 1.18,
    tipDistance
  );
  float shoulderDistance = length(vec2(crossOffset * 0.88, alongDistance * 0.64));
  float shoulder = 1.0 - smoothstep(
    streakWidth * 1.28,
    streakWidth * 1.28 + antiAlias * 1.65,
    shoulderDistance
  );
  float filament = 0.88 + 0.12 * sin(normalizedAlong * mix(15.0, 24.0, detailRandom) + detailRandom * 17.0);
  float longitudinalVariation = mix(0.76, 1.0, smoothstep(0.03, 0.72, headToTail)) * filament;
  float intensityRandom = rainHash12(vec2(laneId + 5.7, cycleId - layer * 9.1));
  float dropIntensity = mix(0.38, 1.08, pow(intensityRandom, 0.72)) * mix(0.72, 1.24, lifetimeAmount);

  float mask = present * body * (
    line * (0.060 + 0.82 * tailStrength) +
    core * (0.018 + 0.15 * pow(tailStrength, 2.45)) +
    softEdge * 0.018 +
    shoulder * 0.018
  ) * alphaFactor * dropIntensity * longitudinalVariation;
  float highlight = present * max(tip * 0.90, core * pow(tailStrength, 3.2) * 0.50);
  highlight *= alphaFactor * dropIntensity;
  return vec2(mask, highlight);
}
#endif

#ifndef FXM_RAIN_SIDE_VIEW
float topDownLegacyDeadzoneFade(float radius, float stopRadius) {
  float deadzone = max(0.10, stopRadius);
  float boost = clamp((uTopDownDensityBoost - 1.0) / 2.50, 0.0, 1.0);
  float fadeStart = deadzone * mix(0.98, 1.04, boost);
  float fadeEnd = deadzone + max(1.15, deadzone * mix(0.84, 1.18, boost));
  float fadeT = clamp((radius - fadeStart) / max(0.0001, fadeEnd - fadeStart), 0.0, 1.0);
  float ramp = smoothstep(0.0, 0.80, fadeT);
  float terminalTaper = mix(0.38, 1.0, smoothstep(0.18, 0.84, fadeT));
  return ramp * terminalTaper;
}

float topDownDeadzoneTransitionMask(vec2 focusGrid) {
  return topDownLegacyDeadzoneFade(length(vRainCoord - focusGrid), uDeadzoneGrid);
}

vec2 topDownRainLayer(
  float radius,
  float angle,
  float layer,
  float baseSectorCount,
  float spacing,
  float speedFactor,
  float alphaFactor,
  float seedOffset
) {
  float densityAmount = rainDensityAmount();
  float rawScreenDensityBoost = clamp(uTopDownDensityBoost, 1.02, 4.05);
  float screenDensityBoost = mix(1.0, rawScreenDensityBoost, smoothstep(0.08, 0.72, densityAmount));
  float sectorCount = baseSectorCount * mix(0.92, 3.78, densityAmount) * screenDensityBoost;
  float sectorCoord = (angle + FXM_PI) * sectorCount / FXM_TAU;
  float sectorId = floor(sectorCoord);
  float sectorPhase = rainHash12Seeded(vec2(sectorId, layer * 23.0), seedOffset);

  float stopSeed = rainHash12Seeded(
    vec2(sectorId + layer * 29.3, layer * 51.7),
    seedOffset + 93.1
  );
  float stopRadius = uDeadzoneGrid * mix(0.90, 1.34, stopSeed);
  float radialTravel = max(0.0, radius - stopRadius * 0.82);
  float effectiveSpacing = max(
    0.30,
    spacing / (mix(0.92, screenDensityBoost * 1.20, 0.88) * mix(0.88, 2.08, densityAmount))
  );
  float cycleCoord = (radialTravel + uTopDownMotion * 0.58 * speedFactor) / effectiveSpacing + sectorPhase;
  float cycleId = floor(cycleCoord);
  float phase = fract(cycleCoord);
  vec3 randomValues = rainHash32Seeded(
    vec2(sectorId, cycleId) + vec2(layer * 37.1, layer * -21.3),
    seedOffset
  );
  float detailRandom = rainHash12Seeded(
    vec2(sectorId - layer * 5.9, cycleId + layer * 14.7),
    seedOffset
  );

  float densityChance = mix(0.12, 0.997, densityAmount) * mix(0.92, 1.62, densityAmount * max(0.0, screenDensityBoost - 1.0));
  float legacyDeadzoneFade = topDownLegacyDeadzoneFade(radius, stopRadius);
  float centerShoulder = max(1.0, stopRadius * 0.72);
  float centerPopulation = smoothstep(
    stopRadius + centerShoulder * 0.10,
    stopRadius + centerShoulder * 2.65,
    radius
  );
  densityChance *= mix(0.035, 1.0, max(centerPopulation, legacyDeadzoneFade * 0.92));
  float present = step(randomValues.z, clamp(densityChance, 0.035, 0.998));
  float centerFraction = mix(0.10, 0.90, randomValues.x);

  float perspective = mix(0.40, 1.36, smoothstep(stopRadius, stopRadius + 9.0, radius));
  float lifetimeAmount = rainLifetimeAmount();
  float commonLength = mix(0.13, 0.58, pow(randomValues.y, 1.12));
  float longDrop = smoothstep(0.78, 0.98, detailRandom) * mix(0.12, 0.44, randomValues.x);
  float streakLength = (commonLength + longDrop) * max(0.08, uScale) * perspective;
  streakLength *= mix(0.48, 2.02, lifetimeAmount);
  float streakWidth = mix(0.0038, 0.0125, pow(randomValues.x, 1.20));
  streakWidth *= sqrt(max(0.08, uScale)) * perspective;

  float alongDistance = phase * effectiveSpacing;
  float normalizedAlong = clamp(alongDistance / max(streakLength, 0.001), 0.0, 1.0);
  float angularDistance = (fract(sectorCoord) - centerFraction) * FXM_TAU / sectorCount;
  float dropSlant = (detailRandom - 0.5) * streakWidth * 0.88 / max(radius, 0.70);
  angularDistance -= dropSlant * normalizedAlong;

  float missSeed = rainHash12Seeded(
    vec2(sectorId + layer * 43.7, cycleId - layer * 18.9),
    seedOffset + 71.3
  );
  float missDistance = (missSeed - 0.5) * stopRadius * 1.70;
  float crossOffset = angularDistance * max(radius, 0.70) - missDistance;
  float crossDistance = abs(crossOffset);

  float antiAlias = max(uPixelRain * 1.10, streakWidth * 0.25);
  float headToTail = max(0.0, 1.0 - normalizedAlong);
  float tailStrength = pow(headToTail, mix(1.12, 1.48, detailRandom));
  float tipBulge = exp(-normalizedAlong * normalizedAlong * 108.0);
  float widthProfile = mix(0.060, 0.73, pow(headToTail, 0.56));
  widthProfile += tipBulge * 0.11;

  float line = 1.0 - smoothstep(
    streakWidth * widthProfile,
    streakWidth * widthProfile + antiAlias,
    crossDistance
  );
  float core = 1.0 - smoothstep(
    streakWidth * widthProfile * 0.24,
    streakWidth * widthProfile * 0.24 + antiAlias,
    crossDistance
  );
  float softEdge = 1.0 - smoothstep(
    streakWidth * widthProfile * 1.28,
    streakWidth * widthProfile * 2.48 + antiAlias,
    crossDistance
  );
  float body = 1.0 - smoothstep(streakLength, streakLength + antiAlias * 3.0, alongDistance);
  float tipDistance = length(vec2(crossDistance * 1.08, alongDistance * 1.10));
  float tip = 1.0 - smoothstep(
    streakWidth * 1.04,
    streakWidth * 1.04 + antiAlias * 1.20,
    tipDistance
  );
  float centerFade = legacyDeadzoneFade;
  float intensityRandom = rainHash12Seeded(
    vec2(sectorId - 7.1, cycleId + layer * 11.3),
    seedOffset
  );
  float dropIntensity = mix(0.40, 1.08, pow(intensityRandom, 0.72)) * mix(0.74, 1.24, lifetimeAmount);
  float filament = 0.88 + 0.12 * sin(normalizedAlong * mix(14.0, 22.0, detailRandom) + detailRandom * 19.0);

  float mask = present * body * (
    line * (0.060 + 0.82 * tailStrength) +
    core * (0.018 + 0.15 * pow(tailStrength, 2.45)) +
    softEdge * 0.017
  ) * alphaFactor * centerFade * dropIntensity * filament;
  float highlight = present * max(tip * 0.90, core * pow(tailStrength, 3.2) * 0.49);
  highlight *= alphaFactor * centerFade * dropIntensity;
  return vec2(mask, highlight);
}

vec2 topDownRainField(vec2 focusGrid, float seedOffset) {
  vec2 relative = vRainCoord - focusGrid;
  float radius = max(length(relative), 0.001);
  float angle = atan(relative.y, relative.x);
  vec2 rain = vec2(0.0);
  rain += topDownRainLayer(radius, angle, 0.40, 146.0, 2.82, 0.74, 0.48, seedOffset + 47.9);
  rain += topDownRainLayer(radius, angle, 0.66, 198.0, 3.40, 0.86, 1.00, seedOffset);
  rain += topDownRainLayer(radius, angle, 0.98, 258.0, 4.34, 1.00, 0.84, seedOffset + 13.7);
  rain += topDownRainLayer(radius, angle, 1.38, 336.0, 5.52, 1.15, 0.70, seedOffset + 29.3);
  rain += topDownRainLayer(radius, angle, 1.82, 428.0, 6.84, 1.28, 0.52, seedOffset + 64.1);
  rain += topDownRainLayer(radius, angle, 2.30, 520.0, 8.28, 1.42, 0.36, seedOffset + 91.6);
  rain += topDownRainLayer(radius, angle, 2.78, 596.0, 9.80, 1.56, 0.24, seedOffset + 118.4);
  return rain * 1.44;
}

float topDownDeadzoneEdgeTransition(vec2 focusGrid, float focusBlend) {
  float radius = length(vRainCoord - focusGrid);
  float inner = max(0.10, uDeadzoneGrid * 0.88);
  float outer = uDeadzoneGrid + max(1.10, uDeadzoneGrid * 1.26);
  float enter = smoothstep(inner, inner + max(0.34, uDeadzoneGrid * 0.18), radius);
  float exit = 1.0 - smoothstep(outer, outer + max(0.45, uDeadzoneGrid * 0.24), radius);
  float band = clamp(enter * exit, 0.0, 1.0);
  float blend = smoothstep(0.0, 1.0, clamp(focusBlend, 0.0, 1.0));
  return mix(1.0, mix(0.40, 1.0, blend), band * (1.0 - blend));
}
#endif

void main() {
  if ((uAlpha * uWorldAlpha) <= 0.0001 || uDensity <= 0.0001 || uScale <= 0.0001) {
    gl_FragColor = vec4(0.0);
    return;
  }

  float effectiveAlpha = uAlpha * uWorldAlpha;
  vec2 rain = vec2(0.0);

#if defined(FXM_RAIN_TOP_DOWN)
  rain = topDownRainField(uTopDownCurrentFocusGrid, uTopDownCurrentSeed);
  float focusBlend = smoothstep(0.0, 1.0, clamp(uTopDownBlend, 0.0, 1.0));
  if (focusBlend < 0.999) {
    vec2 previousRain = topDownRainField(uTopDownPreviousFocusGrid, uTopDownPreviousSeed);
    float previousGap = 1.0 - topDownDeadzoneTransitionMask(uTopDownPreviousFocusGrid);
    float currentGap = 1.0 - topDownDeadzoneTransitionMask(uTopDownCurrentFocusGrid);
    float transitionArea = clamp(max(previousGap, currentGap) * 1.20, 0.0, 1.0);
    rain = mix(rain, mix(previousRain, rain, focusBlend), transitionArea);
    rain *= topDownDeadzoneEdgeTransition(uTopDownCurrentFocusGrid, focusBlend);
  }
#elif defined(FXM_RAIN_SIDE_VIEW)
  vec2 p = vRainCoord;
  vec2 direction = uDirection / max(length(uDirection), 0.0001);
  vec2 crossDirection = vec2(-direction.y, direction.x);
  vec2 oriented = vec2(dot(p, crossDirection), dot(p, direction));
  rain += sideRainLayer(oriented, 0.44, 0.18, 2.45, 0.79, 0.28);
  rain += sideRainLayer(oriented, 0.72, 0.29, 3.18, 0.89, 0.58);
  rain += sideRainLayer(oriented, 1.10, 0.44, 4.28, 1.02, 0.42);
  rain += sideRainLayer(oriented, 1.62, 0.65, 5.52, 1.16, 0.28);
#else
  if (uTopDown > 0.5) {
    rain = topDownRainField(uTopDownCurrentFocusGrid, uTopDownCurrentSeed);
    float focusBlend = smoothstep(0.0, 1.0, clamp(uTopDownBlend, 0.0, 1.0));
    if (focusBlend < 0.999) {
      vec2 previousRain = topDownRainField(uTopDownPreviousFocusGrid, uTopDownPreviousSeed);
      float previousGap = 1.0 - topDownDeadzoneTransitionMask(uTopDownPreviousFocusGrid);
      float currentGap = 1.0 - topDownDeadzoneTransitionMask(uTopDownCurrentFocusGrid);
      float transitionArea = clamp(max(previousGap, currentGap) * 1.20, 0.0, 1.0);
      rain = mix(rain, mix(previousRain, rain, focusBlend), transitionArea);
      rain *= topDownDeadzoneEdgeTransition(uTopDownCurrentFocusGrid, focusBlend);
    }
  } else {
    vec2 p = vRainCoord;
    vec2 direction = uDirection / max(length(uDirection), 0.0001);
    vec2 crossDirection = vec2(-direction.y, direction.x);
    vec2 oriented = vec2(dot(p, crossDirection), dot(p, direction));
    rain += sideRainLayer(oriented, 0.44, 0.18, 2.45, 0.79, 0.28);
    rain += sideRainLayer(oriented, 0.72, 0.29, 3.18, 0.89, 0.58);
    rain += sideRainLayer(oriented, 1.10, 0.44, 4.28, 1.02, 0.42);
    rain += sideRainLayer(oriented, 1.62, 0.65, 5.52, 1.16, 0.28);
  }
#endif

  float bodyAlpha = (1.0 - exp(-max(0.0, rain.x) * 1.12)) * effectiveAlpha;
  float headAlpha = (1.0 - exp(-max(0.0, rain.y) * 1.26)) * effectiveAlpha;
  float alpha = clamp(bodyAlpha + headAlpha * 0.19, 0.0, 0.90);
  if (alpha <= 0.0001) {
    gl_FragColor = vec4(0.0);
    return;
  }

  vec3 rainColor = min(vec3(1.0), uColor * (0.74 + 0.26 * bodyAlpha) + vec3(0.18) * headAlpha);
  gl_FragColor = vec4(rainColor * alpha, alpha);
}
`;

const RAIN_FRAGMENT_SHADER_SIDE_VIEW = `#define FXM_RAIN_SIDE_VIEW 1\n${FRAGMENT_SHADER}`;
const RAIN_FRAGMENT_SHADER_TOP_DOWN = `#define FXM_RAIN_TOP_DOWN 1\n${FRAGMENT_SHADER}`;

/**
 * Procedural rain surface display.
 */
class RainProceduralQuad extends PIXI.Container {
  /** @param {PIXI.Shader} shader */
  constructor(shader) {
    super();
    this.shader = shader;
    this.geometry = new PIXI.Geometry()
      .addAttribute("aVertexPosition", [0, 0, 1, 0, 1, 1, 0, 1], 2)
      .addIndex([0, 1, 2, 0, 2, 3]);
    this.state = PIXI.State.for2d();
    this.name = "fxmProceduralRainSurface";
    this.eventMode = "none";
    this.roundPixels = false;
    this.renderable = false;
  }

  get blendMode() {
    return this.state?.blendMode ?? PIXI.BLEND_MODES.NORMAL;
  }

  set blendMode(value) {
    if (this.state) this.state.blendMode = value;
  }

  /** @override */
  _render(renderer) {
    const shader = this.shader;
    const geometry = this.geometry;
    const state = this.state;
    if (!shader || !geometry || !state) return;

    shader.uniforms.translationMatrix = this.transform.worldTransform.toArray(true);
    shader.uniforms.uWorldAlpha = this.worldAlpha;

    renderer.batch.flush();
    renderer.state.set(state);
    renderer.shader.bind(shader);
    renderer.geometry.bind(geometry, shader);
    renderer.geometry.draw(PIXI.DRAW_MODES.TRIANGLES);
  }

  /** @override */
  _calculateBounds() {
    this._bounds.addFrame(this.transform, 0, 0, 1, 1);
  }

  /** @override */
  destroy(options) {
    const geometry = this.geometry;
    const shader = this.shader;
    this.geometry = null;
    this.shader = null;
    this.state = null;
    super.destroy(options);
    geometry?.dispose?.();
    shader?.destroy?.();
  }
}

const RAIN_PROGRAM_CACHE = new Map();

function rainProgramForMode(topDown = false) {
  const key = topDown ? "top-down" : "side-view";
  let program = RAIN_PROGRAM_CACHE.get(key);
  if (!program) {
    const fragmentShader = topDown ? RAIN_FRAGMENT_SHADER_TOP_DOWN : RAIN_FRAGMENT_SHADER_SIDE_VIEW;
    const name = topDown ? "fxmaster-rain-top-down" : "fxmaster-rain-side-view";
    program = PIXI.Program.from(VERTEX_SHADER, fragmentShader, name);
    RAIN_PROGRAM_CACHE.set(key, program);
  }
  return program;
}

function createRainShader(uniforms, { topDown = false } = {}) {
  return new PIXI.Shader(rainProgramForMode(topDown), uniforms);
}

const RAIN_BASE_SPEED_GRID_PER_SECOND = 31;
const RAIN_TOP_DOWN_PAN_SETTLE_MS = 145;
const RAIN_TOP_DOWN_RECENTER_FADE_MS = 210;
const RAIN_TOP_DOWN_ZOOM_SETTLE_MS = 360;
const RAIN_TOP_DOWN_CAMERA_PAN_THRESHOLD_PX = 0.35;
const RAIN_TOP_DOWN_CAMERA_ZOOM_THRESHOLD = 0.0006;
const RAIN_TOP_DOWN_FOCUS_EPSILON_GRID = 0.04;
const RAIN_MOTION_MAX_STEP_MS = 100;
const RAIN_MOTION_STATES = new Map();

function clamp(value, min, max, fallback = min) {
  const number = Number(value);
  const safe = Number.isFinite(number) ? number : fallback;
  return Math.max(min, Math.min(max, safe));
}

function unwrapOption(value, fallback = undefined) {
  if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "value")) {
    return value.value;
  }
  return value === undefined ? fallback : value;
}

function stableSeed(value) {
  const text = String(value ?? "fxmaster-rain");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return 1 + ((hash >>> 0) % 100000) / 997;
}

function parseHexColor(value, fallback = [0.73, 0.86, 0.97]) {
  let hex = typeof value === "string" ? value.trim() : "";
  if (/^[0-9a-f]{6}$/i.test(hex)) hex = `#${hex}`;
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return new Float32Array(fallback);
  return new Float32Array([
    Number.parseInt(hex.slice(1, 3), 16) / 255,
    Number.parseInt(hex.slice(3, 5), 16) / 255,
    Number.parseInt(hex.slice(5, 7), 16) / 255,
  ]);
}

function resolveTintColor(options) {
  const tint = options?.tint;
  const payload = tint?.value && typeof tint.value === "object" ? tint.value : tint;
  const apply = !!(payload?.apply ?? tint?.apply);
  const value = apply ? payload?.value ?? tint?.value : "#badcf5";
  return parseHexColor(value);
}

function resolveDimensions(source) {
  const dimensions = source?.dimensions ?? source ?? globalThis.canvas?.dimensions ?? {};
  const rect = dimensions.sceneRect ?? dimensions.rect ?? {};
  const x = Number(rect.x ?? dimensions.sceneX ?? 0) || 0;
  const y = Number(rect.y ?? dimensions.sceneY ?? 0) || 0;
  const width = Math.max(1, Number(rect.width ?? rect.w ?? dimensions.sceneWidth ?? dimensions.width ?? 1) || 1);
  const height = Math.max(1, Number(rect.height ?? rect.h ?? dimensions.sceneHeight ?? dimensions.height ?? 1) || 1);
  const gridSize = Math.max(1, Number(dimensions.size ?? globalThis.canvas?.dimensions?.size ?? 100) || 100);
  return { x, y, width, height, gridSize, source: dimensions };
}

function resolveDeltaMS(delta, ticker) {
  const candidates = [delta?.deltaMS, ticker?.deltaMS, delta?.elapsedMS];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value >= 0) return Math.min(value, RAIN_MOTION_MAX_STEP_MS);
  }

  const raw = Number(delta);
  if (Number.isFinite(raw) && raw >= 0) {
    if (raw < 5) return Math.min(raw * (1000 / 60), RAIN_MOTION_MAX_STEP_MS);
    return Math.min(raw, RAIN_MOTION_MAX_STEP_MS);
  }
  return 1000 / 60;
}

function monotonicNow(ticker = null) {
  const tickerTime = Number(ticker?.lastTime);
  if (Number.isFinite(tickerTime) && tickerTime >= 0) return tickerTime;
  const performanceTime = Number(globalThis.performance?.now?.());
  return Number.isFinite(performanceTime) ? performanceTime : Date.now();
}

function resolveMotionKey(owner, context) {
  return String(
    owner?.__fxmBackgroundUid ??
      owner?.id ??
      context?.behaviorId ??
      context?.regionId ??
      owner?.constructor?.label ??
      "fxmaster-rain",
  );
}

function getMotionState(key, speed, now) {
  let state = RAIN_MOTION_STATES.get(key);
  if (!state) {
    state = {
      distance: stableSeed(key) * 0.037,
      lastTime: now,
      speed: clamp(speed, 0.1, 5, 1),
      lastAccess: now,
    };
    RAIN_MOTION_STATES.set(key, state);
  }
  state.lastAccess = now;
  return state;
}

function advanceMotionState(state, now) {
  if (!state) return 0;
  const previous = Number(state.lastTime);
  if (Number.isFinite(previous) && now > previous) {
    const deltaMs = Math.min(now - previous, RAIN_MOTION_MAX_STEP_MS);
    state.distance += (deltaMs / 1000) * RAIN_BASE_SPEED_GRID_PER_SECOND * clamp(state.speed, 0.1, 5, 1);
    state.lastTime = now;
  } else if (!Number.isFinite(previous)) {
    state.lastTime = now;
  }
  state.lastAccess = now;
  return Number(state.distance) || 0;
}

function finiteOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function stageScale(matrix = null) {
  try {
    const m = matrix ?? rawStageMatrix(globalThis.canvas?.stage);
    return Math.max(0.0001, Math.hypot(finiteOr(m?.a, 1), finiteOr(m?.b, 0)));
  } catch (err) {
    logger.debug("FXMaster:", err);
    return 1;
  }
}

function cssPointToWorld(x, y, matrix = null) {
  try {
    const source = matrix ?? rawStageMatrix(globalThis.canvas?.stage);
    const inverse = source?.clone
      ? source.clone()
      : new PIXI.Matrix(
          source?.a ?? 1,
          source?.b ?? 0,
          source?.c ?? 0,
          source?.d ?? 1,
          source?.tx ?? 0,
          source?.ty ?? 0,
        );
    inverse.invert();
    return {
      x: inverse.a * x + inverse.c * y + inverse.tx,
      y: inverse.b * x + inverse.d * y + inverse.ty,
    };
  } catch (err) {
    logger.debug("FXMaster:", err);
    return { x, y };
  }
}

function copyPoint(point, fallback = { x: 0, y: 0 }) {
  return {
    x: finiteOr(point?.x, finiteOr(fallback?.x, 0)),
    y: finiteOr(point?.y, finiteOr(fallback?.y, 0)),
  };
}

function copyMatrixSnapshot(matrix) {
  return {
    a: finiteOr(matrix?.a, 1),
    b: finiteOr(matrix?.b, 0),
    c: finiteOr(matrix?.c, 0),
    d: finiteOr(matrix?.d, 1),
    tx: finiteOr(matrix?.tx, 0),
    ty: finiteOr(matrix?.ty, 0),
  };
}

function cameraChangeDetails(current, previous, cssW, cssH) {
  if (!current || !previous) return { pan: 0, zoom: 0, zoomPixels: 0, total: 0 };
  const pan = Math.hypot(current.tx - previous.tx, current.ty - previous.ty);
  const zoom = Math.max(
    Math.abs(current.a - previous.a),
    Math.abs(current.b - previous.b),
    Math.abs(current.c - previous.c),
    Math.abs(current.d - previous.d),
  );
  const zoomPixels = zoom * Math.max(cssW, cssH) * 0.35;
  return { pan, zoom, zoomPixels, total: pan + zoomPixels };
}

function topDownFieldSeed(owner, context, serial = 0) {
  return stableSeed(`${resolveMotionKey(owner, context)}:top-down-field:${Math.max(0, Number(serial) || 0)}`);
}

/**
 * Single-surface procedural rain renderer.
 */
export class RainProceduralSurface {
  /**
   * @param {{owner?:PIXI.Container|null, options?:object, dimensions?:object, renderer?:object, ticker?:object}} [config]
   */
  constructor({ owner = null, options = {}, dimensions = null, renderer = null, ticker = null } = {}) {
    this.owner = owner ?? null;
    this.options = options ?? {};
    this.context = this.options?.__fxmParticleContext ?? owner?.__fxmParticleContext ?? null;
    this.renderer =
      renderer ?? CONFIG.fxmaster?.getParticleRenderer?.(this.options) ?? globalThis.canvas?.app?.renderer;
    this.ticker =
      ticker ?? CONFIG.fxmaster?.getParticleTicker?.(this.options) ?? globalThis.PIXI?.Ticker?.shared ?? null;
    this.running = false;
    this.destroyed = false;
    this.speed = 1;
    this._motionKey = null;
    this._motionState = null;
    this._topDownMotionDistance = 0;
    this._lastCameraMatrix = null;
    this._viewInitialized = false;
    this._configuredTopDown = false;
    this._topDownPreviousFocusGrid = null;
    this._topDownCurrentFocusGrid = null;
    this._topDownPreviousSeed = topDownFieldSeed(this.owner, this.context, 0);
    this._topDownCurrentSeed = this._topDownPreviousSeed;
    this._topDownBlend = 1;
    this._topDownTransitionStart = 0;
    this._topDownTransitionSerial = 0;
    this._topDownTransitionActive = false;
    this._topDownPendingFocusGrid = null;
    this._topDownRecenterAfter = 0;
    this._baseDeadzoneGrid = 0.75;
    this._topDownDeadzoneGrid = 0.75;
    this._topDownPendingDeadzoneGrid = null;
    this._topDownDeadzoneApplyAfter = 0;
    this._cameraChangePending = false;
    this._canvasPanHookId = undefined;

    this._uniforms = {
      translationMatrix: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
      uBoundsOriginGrid: new Float32Array([0, 0]),
      uBoundsSizeGrid: new Float32Array([1, 1]),
      uMotion: 0,
      uTopDownMotion: 0,
      uAlpha: 1,
      uWorldAlpha: 1,
      uScale: 1,
      uDensity: 0.5,
      uLifetime: 2.5,
      uTopDown: 0,
      uSeed: stableSeed("fxmaster-rain"),
      uPixelRain: 0.01,
      uTopDownDensityBoost: 1,
      uDeadzoneGrid: 0.75,
      uTopDownBlend: 1,
      uTopDownPreviousSeed: this._topDownPreviousSeed,
      uTopDownCurrentSeed: this._topDownCurrentSeed,
      uDirection: new Float32Array([0.258819, 0.965926]),
      uTopDownPreviousFocusGrid: new Float32Array([0, 0]),
      uTopDownCurrentFocusGrid: new Float32Array([0, 0]),
      uColor: new Float32Array([0.73, 0.86, 0.97]),
    };
    this._shaderTopDownMode = !!unwrapOption(this.options?.topDown, false);
    this.shader = createRainShader(this._uniforms, { topDown: this._shaderTopDownMode });

    this.displayObject = new RainProceduralQuad(this.shader);
    this._tick = (delta) => this.update(delta);
    this.configure({ options: this.options, dimensions, renderer: this.renderer, ticker: this.ticker });
  }

  _resolveSynchronizedDirectionVector(fallback = 285) {
    const raw = unwrapOption(this.options?.direction, fallback);
    const direction =
      CONFIG.fxmaster?.resolveSynchronizedDirection?.(this.options, raw, this.options?.__fxmParticleContext) ?? raw;
    return geometricDirectionToCanvasVector(direction, fallback);
  }

  _updateDirectionUniform() {
    const uniforms = this.shader?.uniforms;
    if (!uniforms?.uDirection) return;
    const direction = this._resolveSynchronizedDirectionVector(285);
    uniforms.uDirection[0] = direction.x;
    uniforms.uDirection[1] = direction.y;
  }

  _ensureShaderMode(topDown) {
    const mode = !!topDown;
    if (this._shaderTopDownMode === mode && this.shader) return;
    const uniforms = this._uniforms ?? this.shader?.uniforms ?? {};
    const previousShader = this.shader ?? null;
    this.shader = createRainShader(uniforms, { topDown: mode });
    this._uniforms = uniforms;
    this._shaderTopDownMode = mode;
    if (this.displayObject) this.displayObject.shader = this.shader;
    try {
      previousShader?.destroy?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  /**
   * @param {{options?:object, dimensions?:object, renderer?:object, ticker?:object}} [config]
   */
  configure({
    options = this.options ?? {},
    dimensions = null,
    renderer = this.renderer ?? null,
    ticker = this.ticker ?? null,
  } = {}) {
    if (this.destroyed) return;
    this.options = options ?? {};
    this.context = this.options?.__fxmParticleContext ?? this.owner?.__fxmParticleContext ?? this.context ?? null;
    this.renderer = renderer ?? this.renderer ?? null;
    this.ticker = ticker ?? this.ticker ?? null;

    const topDown = !!unwrapOption(this.options?.topDown, false);
    this._ensureShaderMode(topDown);
    const uniforms = this.shader?.uniforms;
    if (uniforms) {
      const direction = this._resolveSynchronizedDirectionVector();
      const density = clamp(unwrapOption(this.options?.density), 0.01, 5.8, 0.5);
      const performanceScale = clamp(this.owner?.constructor?.getPerformanceDensityScale?.(), 0.25, 1, 1);

      if (topDown !== this._configuredTopDown) {
        this._viewInitialized = false;
        this._topDownTransitionActive = false;
        this._topDownBlend = 1;
        this._topDownPendingFocusGrid = null;
        this._topDownRecenterAfter = 0;
        this._topDownMotionDistance = Number(uniforms.uTopDownMotion ?? uniforms.uMotion) || 0;
      }
      this._configuredTopDown = topDown;
      this.speed = clamp(unwrapOption(this.options?.speed), 0.1, 5, 1);
      uniforms.uAlpha = clamp(unwrapOption(this.options?.alpha), 0, 1, 1);
      uniforms.uScale = clamp(unwrapOption(this.options?.scale), 0.1, 5, 1);
      uniforms.uDensity = density * performanceScale;
      uniforms.uLifetime = clamp(unwrapOption(this.options?.lifetime), 0.1, 5, 2.5);
      uniforms.uTopDown = topDown ? 1 : 0;
      uniforms.uDirection[0] = direction.x;
      uniforms.uDirection[1] = direction.y;
      uniforms.uColor = resolveTintColor(this.options);
    }

    this.setDimensions(
      dimensions ?? CONFIG.fxmaster?.getParticleDimensions?.(this.options) ?? this.context?.dimensions,
    );
    if (this.running) this._attachMotionState({ promoteSpeed: true });
    this.update(0);
  }

  /** @param {object|null|undefined} dimensions */
  setDimensions(dimensions) {
    if (this.destroyed) return;
    this.bounds = resolveDimensions(dimensions);
    const { x, y, width, height, gridSize, source } = this.bounds;

    try {
      this.displayObject.position.set(x, y);
      this.displayObject.width = width;
      this.displayObject.height = height;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    const uniforms = this.shader?.uniforms;
    if (uniforms) {
      uniforms.uBoundsOriginGrid[0] = x / gridSize;
      uniforms.uBoundsOriginGrid[1] = y / gridSize;
      uniforms.uBoundsSizeGrid[0] = width / gridSize;
      uniforms.uBoundsSizeGrid[1] = height / gridSize;

      let deadzone = gridSize * 0.75;
      try {
        deadzone = Number(this.owner?.getTopDownDeadzoneRadius?.(source)) || deadzone;
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this._baseDeadzoneGrid = clamp(deadzone / gridSize, 0.25, 10.5, 0.75);
      this._topDownDeadzoneGrid = this._baseDeadzoneGrid;
      this._topDownPendingDeadzoneGrid = null;
      this._topDownDeadzoneApplyAfter = 0;
      uniforms.uDeadzoneGrid = this._baseDeadzoneGrid;
    }
  }

  _syncSeed() {
    const uniforms = this.shader?.uniforms;
    if (!uniforms) return;
    const key = resolveMotionKey(this.owner, this.context);
    uniforms.uSeed = stableSeed(key);
  }

  _attachMotionState({ promoteSpeed = false } = {}) {
    const now = monotonicNow(this.ticker);
    const key = resolveMotionKey(this.owner, this.context);
    if (this._motionKey !== key || !this._motionState) {
      this._motionKey = key;
      this._motionState = getMotionState(key, this.speed, now);
    }
    if (promoteSpeed && this._motionState) this._motionState.speed = this.speed;
    return this._motionState;
  }

  _hasScopedContext() {
    return CONFIG.fxmaster?.isScopedParticleContext?.(this.context) ?? !!this.context?.dimensions;
  }

  _resolveViewTarget() {
    const metrics = getCssViewportMetrics?.() ?? {};
    const cssW = Math.max(1, Number(metrics.cssW ?? this.renderer?.screen?.width ?? 1) || 1);
    const cssH = Math.max(1, Number(metrics.cssH ?? this.renderer?.screen?.height ?? 1) || 1);
    const viewportCenter = { x: cssW * 0.5, y: cssH * 0.5 };

    let rawMatrix;
    try {
      rawMatrix = rawStageMatrix(globalThis.canvas?.stage);
    } catch (err) {
      logger.debug("FXMaster:", err);
      rawMatrix = new PIXI.Matrix();
    }

    const gridSize = Math.max(1, Number(this.bounds?.gridSize) || 100);
    const screenGridSize = Math.max(8, gridSize * stageScale(rawMatrix));
    const visibleMinGrid = Math.max(0.01, Math.min(cssW, cssH) / screenGridSize);

    let anchorWorld;
    if (this._hasScopedContext()) {
      const bounds = this.bounds ?? resolveDimensions(null);
      anchorWorld = {
        x: bounds.x + bounds.width * 0.5,
        y: bounds.y + bounds.height * 0.5,
      };
    } else {
      const pivotX = Number(globalThis.canvas?.stage?.pivot?.x);
      const pivotY = Number(globalThis.canvas?.stage?.pivot?.y);
      anchorWorld =
        Number.isFinite(pivotX) && Number.isFinite(pivotY)
          ? { x: pivotX, y: pivotY }
          : cssPointToWorld(viewportCenter.x, viewportCenter.y, rawMatrix);
    }

    return {
      cssW,
      cssH,
      viewportCenter,
      anchorWorld,
      anchorGrid: {
        x: anchorWorld.x / gridSize,
        y: anchorWorld.y / gridSize,
      },
      screenGridSize,
      visibleMinGrid,
      pixelRain: 1 / screenGridSize,
      topDownDensityBoost: clamp(
        Math.max(Math.pow(screenGridSize / 72, 0.62), Math.pow(148 / screenGridSize, 0.54)),
        1.1,
        4.35,
        1,
      ),
      topDownMotionScale: clamp(Math.pow(104 / screenGridSize, 0.86), 0.2, 1.0, 1),
      matrix: rawMatrix,
      matrixSnapshot: copyMatrixSnapshot(rawMatrix),
      metrics,
    };
  }

  _initializeTopDownField(target, now) {
    const focus = copyPoint(target.anchorGrid);
    const seed = topDownFieldSeed(this.owner, this.context, this._topDownTransitionSerial);
    this._topDownPreviousFocusGrid = copyPoint(focus);
    this._topDownCurrentFocusGrid = copyPoint(focus);
    this._topDownPreviousSeed = seed;
    this._topDownCurrentSeed = seed;
    this._topDownBlend = 1;
    this._topDownTransitionStart = now;
    this._topDownTransitionActive = false;
    this._topDownPendingFocusGrid = null;
    this._topDownRecenterAfter = 0;
    this._topDownPendingDeadzoneGrid = null;
    this._topDownDeadzoneApplyAfter = 0;
  }

  _snapTopDownFocus(focus, { fade = false, now = monotonicNow(this.ticker) } = {}) {
    const resolved = copyPoint(focus);
    const previous = this._topDownCurrentFocusGrid ?? resolved;
    const moved = Math.hypot(resolved.x - previous.x, resolved.y - previous.y) > RAIN_TOP_DOWN_FOCUS_EPSILON_GRID;
    const shouldFade = fade && moved;
    this._topDownPreviousFocusGrid = shouldFade ? copyPoint(previous) : copyPoint(resolved);
    this._topDownCurrentFocusGrid = copyPoint(resolved);
    this._topDownPreviousSeed = this._topDownCurrentSeed;
    this._topDownBlend = shouldFade ? 0 : 1;
    this._topDownTransitionStart = now;
    this._topDownTransitionActive = shouldFade;
    this._topDownPendingFocusGrid = null;
    this._topDownRecenterAfter = 0;
    this._topDownPendingDeadzoneGrid = null;
    this._topDownDeadzoneApplyAfter = 0;
  }

  _advanceTopDownRecenterFade(now) {
    if (!this._topDownTransitionActive) return;
    this._topDownBlend = clamp((now - this._topDownTransitionStart) / RAIN_TOP_DOWN_RECENTER_FADE_MS, 0, 1, 1);
    if (this._topDownBlend >= 1) this._topDownTransitionActive = false;
  }

  _queueTopDownRecenter(target, now, settleMs) {
    this._topDownPendingFocusGrid = copyPoint(target.anchorGrid, this._topDownPendingFocusGrid);
    this._topDownRecenterAfter = Math.max(
      Number(this._topDownRecenterAfter) || 0,
      now + Math.max(0, Number(settleMs) || 0),
    );
  }

  _resolveTopDownDeadzoneGrid(target, now = null, zoomActive = false) {
    const gridSize = Math.max(1, Number(this.bounds?.gridSize) || 100);
    let radiusGrid = clamp(Number(this._baseDeadzoneGrid) || 0.75, 0.25, 10.5, 0.75);

    try {
      const radiusPixels = Number(
        this.owner?.getTopDownDeadzoneRadius?.(this.bounds?.source, {
          visibleMinGrid: target?.visibleMinGrid,
          screenGridSize: target?.screenGridSize,
          cssW: target?.cssW,
          cssH: target?.cssH,
        }),
      );
      if (Number.isFinite(radiusPixels) && radiusPixels > 0) radiusGrid = radiusPixels / gridSize;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    const resolved = clamp(radiusGrid, 0.25, 10.5, 0.75);
    if (!Number.isFinite(Number(now)) || !this._viewInitialized) {
      this._topDownDeadzoneGrid = resolved;
      this._topDownPendingDeadzoneGrid = null;
      this._topDownDeadzoneApplyAfter = 0;
      return resolved;
    }

    const current = clamp(Number(this._topDownDeadzoneGrid) || resolved, 0.25, 10.5, resolved);
    const changed = Math.abs(resolved - current) > 0.01;
    if (zoomActive && changed) {
      this._topDownPendingDeadzoneGrid = resolved;
      this._topDownDeadzoneApplyAfter = Math.max(
        Number(this._topDownDeadzoneApplyAfter) || 0,
        now + RAIN_TOP_DOWN_ZOOM_SETTLE_MS,
      );
      return current;
    }

    if (this._topDownPendingDeadzoneGrid !== null) {
      this._topDownPendingDeadzoneGrid = resolved;
      if (now >= (Number(this._topDownDeadzoneApplyAfter) || 0)) {
        this._topDownDeadzoneGrid = clamp(Number(this._topDownPendingDeadzoneGrid), 0.25, 10.5, resolved);
        this._topDownPendingDeadzoneGrid = null;
        this._topDownDeadzoneApplyAfter = 0;
        return this._topDownDeadzoneGrid;
      }
      return current;
    }

    this._topDownDeadzoneGrid = resolved;
    return resolved;
  }

  _updateTopDownField(target, now, cameraChange) {
    if (this._hasScopedContext()) {
      this._snapTopDownFocus(target.anchorGrid);
      return;
    }

    const zoomActive =
      (Number(cameraChange?.zoom) || 0) > RAIN_TOP_DOWN_CAMERA_ZOOM_THRESHOLD ||
      (Number(cameraChange?.zoomPixels) || 0) > RAIN_TOP_DOWN_CAMERA_PAN_THRESHOLD_PX;
    const panActive =
      (Number(cameraChange?.pan) || 0) > RAIN_TOP_DOWN_CAMERA_PAN_THRESHOLD_PX ||
      (!zoomActive && this._cameraChangePending);

    if (zoomActive) {
      this._queueTopDownRecenter(target, now, RAIN_TOP_DOWN_ZOOM_SETTLE_MS);
      this._advanceTopDownRecenterFade(now);
      return;
    }

    if (panActive) {
      this._queueTopDownRecenter(target, now, RAIN_TOP_DOWN_PAN_SETTLE_MS);
      this._advanceTopDownRecenterFade(now);
      return;
    }

    if (this._topDownPendingFocusGrid && now >= (Number(this._topDownRecenterAfter) || 0)) {
      this._snapTopDownFocus(this._topDownPendingFocusGrid, { fade: true, now });
      return;
    }

    this._advanceTopDownRecenterFade(now);
  }

  _updateViewUniforms(_deltaMs, now) {
    const uniforms = this.shader?.uniforms;
    if (!uniforms) return;

    const target = this._resolveViewTarget();
    const topDown = uniforms.uTopDown > 0.5;
    uniforms.uPixelRain = target.pixelRain;
    uniforms.uTopDownDensityBoost = target.topDownDensityBoost;

    if (!topDown) {
      uniforms.uTopDownMotion = uniforms.uMotion;
      uniforms.uTopDownBlend = 1;
      this._viewInitialized = true;
      this._lastCameraMatrix = target.matrixSnapshot;
      this._cameraChangePending = false;
      return;
    }

    const cameraChange = cameraChangeDetails(target.matrixSnapshot, this._lastCameraMatrix, target.cssW, target.cssH);
    const zoomActive =
      (Number(cameraChange?.zoom) || 0) > RAIN_TOP_DOWN_CAMERA_ZOOM_THRESHOLD ||
      (Number(cameraChange?.zoomPixels) || 0) > RAIN_TOP_DOWN_CAMERA_PAN_THRESHOLD_PX;
    uniforms.uDeadzoneGrid = this._resolveTopDownDeadzoneGrid(target, now, zoomActive);

    if (!this._viewInitialized) {
      this._initializeTopDownField(target, now);
      this._viewInitialized = true;
    } else {
      this._updateTopDownField(target, now, cameraChange);
    }

    if (this.running) {
      const motionScale = clamp(Number(target.topDownMotionScale), 0.25, 1.12, 1);
      this._topDownMotionDistance +=
        (_deltaMs / 1000) * RAIN_BASE_SPEED_GRID_PER_SECOND * clamp(this.speed, 0.1, 5, 1) * motionScale;
    }
    uniforms.uTopDownMotion = Number(this._topDownMotionDistance) || 0;

    const previousFocus = this._topDownPreviousFocusGrid ?? target.anchorGrid;
    const currentFocus = this._topDownCurrentFocusGrid ?? target.anchorGrid;
    uniforms.uTopDownPreviousFocusGrid[0] = previousFocus.x;
    uniforms.uTopDownPreviousFocusGrid[1] = previousFocus.y;
    uniforms.uTopDownCurrentFocusGrid[0] = currentFocus.x;
    uniforms.uTopDownCurrentFocusGrid[1] = currentFocus.y;
    uniforms.uTopDownPreviousSeed = this._topDownPreviousSeed;
    uniforms.uTopDownCurrentSeed = this._topDownCurrentSeed;
    uniforms.uTopDownBlend = this._topDownBlend;
    this._lastCameraMatrix = target.matrixSnapshot;
    this._cameraChangePending = false;
  }

  _registerCanvasPanHook() {
    if (this._hasScopedContext() || this._canvasPanHookId !== undefined || !globalThis.Hooks?.on) return;
    this._canvasPanHookId = Hooks.on("canvasPan", () => {
      this._cameraChangePending = true;
    });
  }

  _unregisterCanvasPanHook() {
    if (this._canvasPanHookId !== undefined) {
      try {
        Hooks.off("canvasPan", this._canvasPanHookId);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
    this._canvasPanHookId = undefined;
    this._cameraChangePending = false;
  }

  /** Begin shader animation. */
  start() {
    if (this.destroyed) return;
    this._syncSeed();
    this._attachMotionState({ promoteSpeed: true });
    this._registerCanvasPanHook();
    this._viewInitialized = false;
    this.displayObject.renderable = true;
    if (!this.running) {
      this.running = true;
      try {
        this.ticker?.add?.(this._tick);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
    this.update(0);
  }

  /** Stop shader animation and hide the quad. */
  stop() {
    if (this.destroyed) return;
    if (this.running) {
      try {
        this.ticker?.remove?.(this._tick);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
    this.running = false;
    this._unregisterCanvasPanHook();
    if (this.displayObject) this.displayObject.renderable = false;
  }

  /** @param {number|object} [delta] */
  update(delta = 0) {
    if (this.destroyed || !this.displayObject || this.displayObject.destroyed) return;
    const deltaMs = resolveDeltaMS(delta, this.ticker);
    const uniforms = this.shader?.uniforms;
    if (!uniforms) return;
    const now = monotonicNow(this.ticker);

    if (this.running) {
      const nextSpeed = clamp(unwrapOption(this.options?.speed), 0.1, 5, this.speed);
      if (Math.abs(nextSpeed - this.speed) > 0.0001) {
        this.speed = nextSpeed;
        if (this._motionState) this._motionState.speed = nextSpeed;
      }
      const state = this._attachMotionState({ promoteSpeed: true });
      uniforms.uMotion = advanceMotionState(state, now);
    }
    this._updateDirectionUniform();
    this._updateViewUniforms(deltaMs, now);
  }

  destroy() {
    if (this.destroyed) return;
    this.stop();
    this.destroyed = true;

    try {
      this.displayObject?.parent?.removeChild?.(this.displayObject);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      this.displayObject?.destroy?.({ children: true });
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    this.shader = null;
    this._uniforms = null;
    this.displayObject = null;
    this.owner = null;
    this.ticker = null;
    this._motionState = null;
  }
}

export const RAIN_PROCEDURAL_VERTEX_SHADER = VERTEX_SHADER;
export const RAIN_PROCEDURAL_FRAGMENT_SHADER = FRAGMENT_SHADER;
export const RAIN_PROCEDURAL_FRAGMENT_SHADER_SIDE_VIEW = RAIN_FRAGMENT_SHADER_SIDE_VIEW;
export const RAIN_PROCEDURAL_FRAGMENT_SHADER_TOP_DOWN = RAIN_FRAGMENT_SHADER_TOP_DOWN;
