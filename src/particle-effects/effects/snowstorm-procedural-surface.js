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
varying vec2 vStormCoord;
void main() {
  vec3 position = translationMatrix * vec3(aVertexPosition, 1.0);
  vStormCoord = uBoundsOriginGrid + aVertexPosition * uBoundsSizeGrid;
  gl_Position = vec4((projectionMatrix * position).xy, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vStormCoord;
uniform float uTime;
uniform float uAlpha;
uniform float uWorldAlpha;
uniform float uScale;
uniform float uDensity;
uniform float uDensityControl;
uniform float uSpeed;
uniform float uLifetime;
uniform float uSeed;
uniform float uGustStrength;
uniform float uTopDown;
uniform float uDeadzoneRadiusGrid;
uniform float uRotationStrength;
uniform float uTopDownDensityBoost;
uniform vec2 uFocusGrid;
uniform vec2 uTopDownPreviousFocusGrid;
uniform vec2 uTopDownCurrentFocusGrid;
uniform float uTopDownBlend;
uniform vec2 uDirection;
uniform vec3 uColor;

const mat3 FXM_SNOW_PRNG = mat3(
  13.323122, 23.5112, 21.71123,
  21.1212, 28.7312, 11.9312,
  21.8112, 14.7212, 61.3934
);

float snowHash(vec2 p) {
  p += uSeed * vec2(17.13, -9.71);
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 snowHash22(vec2 p) {
  return vec2(snowHash(p), snowHash(p + vec2(19.19, 37.37))) * 2.0 - 1.0;
}

float snowNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = dot(snowHash22(i), f);
  float b = dot(snowHash22(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
  float c = dot(snowHash22(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
  float d = dot(snowHash22(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
  return clamp(0.5 + 0.70 * mix(mix(a, b, u.x), mix(c, d, u.x), u.y), 0.0, 1.0);
}

#ifndef FXM_SNOWSTORM_TOP_DOWN
float snowDensityForLayer(vec2 uv, float layer) {
  vec3 sb = vec3(floor(uv), 31.189 + layer + uSeed * 0.017);
  vec3 m = floor(sb) / 10000.0 + fract(sb);
  vec3 mp = (31415.9 + m) / fract(FXM_SNOW_PRNG * m);
  vec3 r = fract(mp);
  vec2 s = abs(fract(uv) + 0.9 * r.xy - 0.95) + 0.01 * abs(2.0 * fract(10.0 * uv.yx) - 1.0);
  float d = 0.6 * (s.x + s.y) + max(s.x, s.y) - 0.01;
  float e = 0.005 + 0.05 * min(0.5 * abs(layer - 5.0 - sin(uTime * 0.1)), 1.0);
  return smoothstep(e * 2.0, -e * 2.0, d) * r.x / (0.5 + layer * 0.015);
}
#endif

float densityAmount() {
  float normalized = clamp(uDensity, 0.0, 4.80);
  return smoothstep(0.006, 1.0, pow(normalized / 2.75, 0.72)) * 1.28;
}

const float FXM_TWO_PI = 6.28318530718;
const float FXM_PI = 3.14159265359;

float fxmWrapCell(float value, float count) {
  float safeCount = max(1.0, count);
  return mod(mod(value, safeCount) + safeCount, safeCount);
}

float topDownParticleAmount(float amount) {
  return clamp(pow(max(amount, 0.0), 0.84) * 1.18, 0.0, 1.56);
}

float densityLayerCoverage() {
  float control = clamp(uDensityControl, 0.0, 1.0);
  return clamp(0.035 + 0.965 * pow(control, 0.78), 0.0, 1.0);
}

float densityLayerGate(float layerIndex, float maxLayerIndex) {
  float layerNorm = clamp(layerIndex / max(1.0, maxLayerIndex), 0.0, 1.0);
  float coverage = densityLayerCoverage();
  return smoothstep(layerNorm - 0.24, layerNorm + 0.12, coverage);
}

#ifndef FXM_SNOWSTORM_SIDE_VIEW
float topDownDeadzoneFade(vec2 relative, float stopRadius) {
  float radius = length(relative);
  float deadzone = max(0.10, stopRadius);
  float boost = clamp((uTopDownDensityBoost - 1.0) / 2.50, 0.0, 1.0);
  float broadNoise = snowNoise(relative * 0.105 + vec2(uSeed * 7.10, uSeed * -5.30));
  float detailNoise = snowNoise(relative * 0.275 + vec2(uSeed * -11.40, uSeed * 8.60));
  float shapeOffset = (broadNoise - 0.5) * max(0.18, deadzone * 0.17);
  shapeOffset += (detailNoise - 0.5) * max(0.08, deadzone * 0.065);
  float localDeadzone = max(0.08, deadzone + shapeOffset);
  float fadeStart = localDeadzone * mix(0.98, 1.04, boost);
  float minFeather = mix(0.80, 1.58, smoothstep(0.75, 1.85, localDeadzone));
  float feather = max(minFeather, localDeadzone * mix(1.18, 1.62, boost));
  feather *= mix(0.94, 1.13, broadNoise) * mix(0.97, 1.07, detailNoise);
  float fadeEnd = localDeadzone + feather;
  float fadeT = clamp((radius - fadeStart) / max(0.0001, fadeEnd - fadeStart), 0.0, 1.0);
  float ramp = smoothstep(0.00, 0.98, fadeT);
  float terminalTaper = mix(0.15, 1.0, smoothstep(0.38, 0.98, fadeT));
  return ramp * terminalTaper;
}

float topDownSnowCellParticle(
  vec2 cellUv,
  vec2 cellBase,
  float angularSegments,
  float radialSpacing,
  float radialSpeed,
  float radialPhase,
  float stopRadius,
  float time,
  float layer,
  float motionMix,
  float lifetimeNorm,
  float gustStrength,
  float arcToRadial,
  float spawnChance,
  float edgePopulation
) {
  vec2 hashCell = vec2(fxmWrapCell(cellBase.x, angularSegments), cellBase.y);
  vec2 cellFract = cellUv - cellBase;
  float radialBand = cellBase.y;
  float h1 = snowHash(hashCell + vec2(layer * 17.3, layer * 3.9));
  float h2 = snowHash(hashCell + vec2(layer * 29.1 + 8.7, layer * 7.2));
  float h3 = snowHash(hashCell + vec2(layer * 41.9 + 2.3, layer * 13.4));
  float h4 = snowHash(hashCell + vec2(layer * 53.1 + 5.5, layer * 19.8));
  float h5 = snowHash(hashCell + vec2(layer * 67.7 + 9.1, layer * 23.6));
  float presence = smoothstep(1.0 - spawnChance, min(0.995, 1.0 - spawnChance + 0.12), h3) * edgePopulation;
  float age = fract(cellUv.y + h5);
  float ageFade = smoothstep(0.02, 0.16, age) * (1.0 - smoothstep(mix(0.60, 0.94, lifetimeNorm), 1.0, age));
  float baseSize = mix(0.105, 0.205, h4) * mix(0.78, 1.16, lifetimeNorm);
  float size = baseSize * mix(1.10, 0.58, age);
  float horizontalMargin = clamp(size / max(0.52, arcToRadial) + 0.055, 0.16, 0.42);
  vec2 center = vec2(mix(horizontalMargin, 1.0 - horizontalMargin, h1), mix(0.18, 0.82, h2));
  float particleRadius = max(0.0, (radialBand + center.y) * radialSpacing - time * radialSpeed - radialPhase + stopRadius);
  float swayRamp = smoothstep(stopRadius + max(0.38, stopRadius * 0.20), stopRadius + max(1.75, stopRadius * 0.84), particleRadius);
  float pathPhase = particleRadius * mix(1.02, 1.72, motionMix) + time * mix(0.44, 0.86, lifetimeNorm) + layer * 1.917 + h5 * FXM_TWO_PI;
  float pathSway = sin(pathPhase) + 0.42 * sin(pathPhase * 0.51 + time * mix(0.55, 0.95, motionMix) + h4 * FXM_TWO_PI);
  float radialMargin = clamp(size * 0.90 + 0.035, 0.13, 0.28);
  center.x = clamp(
    center.x + pathSway * gustStrength * mix(0.18, 0.48, motionMix) * swayRamp,
    horizontalMargin,
    1.0 - horizontalMargin
  );
  center.y = clamp(center.y, radialMargin, 1.0 - radialMargin);
  vec2 delta = cellFract - center;
  vec2 metric = vec2(delta.x * arcToRadial, delta.y);
  float dist = length(metric);
  float dotShape = 1.0 - smoothstep(size * 0.38, size, dist);
  float halo = (1.0 - smoothstep(size * 0.82, size * 1.90, dist)) * 0.12;
  return max(0.0, dotShape + halo) * presence * ageFade * mix(0.72, 1.22, h5);
}

float topDownParticleLayer(
  float radius,
  float deadzoneRadius,
  float angle,
  float amount,
  float time,
  float gustStrength,
  float layer,
  float lifetimeNorm,
  float rotationStrength,
  float deadzoneFade
) {
  float stopRadius = max(0.05, uDeadzoneRadiusGrid);
  float densityMix = clamp(amount / 1.56, 0.0, 1.0);
  float motionMix = smoothstep(0.010, 0.115, amount);
  float layerSeed = snowHash(vec2(layer * 13.17, uSeed * 37.11));
  float anglePhase = fract((angle + FXM_PI) / FXM_TWO_PI);
  float ringDistance = radius - stopRadius;
  float radialSpacing = max(0.13, uScale * mix(0.66, 0.24, pow(densityMix, 0.84)));
  radialSpacing *= mix(1.22, 0.80, lifetimeNorm) * mix(0.86, 1.18, layerSeed);
  float angularSegments = mix(44.0, 184.0, pow(densityMix, 0.72)) * mix(0.92, 1.16, lifetimeNorm);
  angularSegments += layer * mix(1.70, 3.20, densityMix);
  angularSegments = max(12.0, floor(angularSegments + 0.5));
  float radialSpeed = mix(0.38, 0.76, densityMix) * mix(1.12, 0.76, lifetimeNorm);
  radialSpeed *= mix(0.82, 1.26, snowHash(vec2(layer * 7.91, 19.3)));
  float radialPhase = snowHash(vec2(layer * 5.17, 4.17)) * radialSpacing * 1.37;
  float radialCoord = (ringDistance + time * radialSpeed + radialPhase) / radialSpacing;
  float radialBand = floor(radialCoord);
  float radialHashA = snowHash(vec2(radialBand * 1.31 + layer * 0.47, layer * 7.43 + uSeed * 13.0));
  float radialHashB = snowHash(vec2(radialBand * 2.17 - layer * 0.91, layer * 11.19 + 5.3));
  float radialHashC = snowHash(vec2(radialBand * 3.13 + layer * 1.37, layer * 17.71 - 2.1));
  float angularJitter = (snowHash(vec2(radialBand * 0.61, layer * 9.31)) - 0.5) * mix(0.80, 2.20, densityMix);
  float gust = snowNoise(vec2(radialBand * 0.10 + layer * 0.21, time * 0.060 + radialHashC * 3.0));
  float centerShoulder = max(1.0, stopRadius * 0.72);
  float centerPopulation = smoothstep(
    stopRadius + centerShoulder * 0.76,
    stopRadius + centerShoulder * 4.25,
    deadzoneRadius
  );
  float edgePopulation = mix(0.002, 1.0, max(centerPopulation, pow(deadzoneFade, 1.70) * 0.52));
  float edgeSway = smoothstep(0.12, 0.82, edgePopulation);
  float particleSwayPhase = time * mix(0.42, 0.92, radialHashA) + radialCoord * mix(0.64, 1.38, radialHashB) + layer * 1.87 + radialHashC * FXM_TWO_PI;
  float broadSway = sin(particleSwayPhase) * gustStrength * mix(0.76, 1.90, motionMix) * edgeSway;
  float counterSway = sin(particleSwayPhase * mix(1.56, 2.02, radialHashB) + layerSeed * FXM_TWO_PI) * gustStrength * mix(0.22, 0.72, motionMix) * edgeSway;
  float gustPush = (gust - 0.5) * gustStrength * mix(0.38, 1.18, motionMix) * edgeSway;
  float rotationControl = clamp(rotationStrength, 0.0, 1.0);
  float rotation = rotationControl * 0.32;
  float rotationSway = smoothstep(0.001, 0.080, rotationControl);
  float globalSpin = mix(-1.0, 1.0, step(0.5, snowHash(vec2(101.7, 17.19))));
  float spinHold = snowNoise(vec2(floor(time * 0.030 + layer * 0.17), layer * 0.31 + uSeed));
  float angularTravel = rotation * globalSpin * (time * mix(0.10, 0.32, spinHold) + max(0.0, ringDistance) * mix(0.020, 0.062, densityMix));
  float rotationGust = (gust - 0.5) * gustStrength * rotation * 0.48;
  float angularSway = (broadSway + counterSway + gustPush) * rotationSway;
  float angularCoord = fract(anglePhase + (angularTravel + rotationGust) / FXM_TWO_PI) * angularSegments + angularJitter + angularSway;
  vec2 cellUv = vec2(angularCoord, radialCoord);
  vec2 baseCell = floor(cellUv);
  float arcToRadial = max(0.52, (FXM_TWO_PI * max(radius, stopRadius + radialSpacing) / max(8.0, angularSegments)) / radialSpacing);
  float spawnChance = clamp((mix(0.18, 0.92, densityMix) + lifetimeNorm * 0.08 + layer * 0.006) * edgePopulation, 0.012, 0.98);

  return topDownSnowCellParticle(
    cellUv,
    baseCell,
    angularSegments,
    radialSpacing,
    radialSpeed,
    radialPhase,
    stopRadius,
    time,
    layer,
    motionMix,
    lifetimeNorm,
    gustStrength,
    arcToRadial,
    spawnChance,
    edgePopulation
  );
}

float topDownSnowAmount(vec2 coord, vec2 particleFocusGrid, vec2 deadzoneFocusGrid, float deadzoneFade, float amount, float time, float gustStrength) {
  vec2 relative = coord - particleFocusGrid;
  vec2 deadzoneRelative = coord - deadzoneFocusGrid;
  float radius = length(relative);
  float deadzoneRadius = length(deadzoneRelative);
  float angle = atan(relative.y, relative.x);
  float lifetimeNorm = smoothstep(0.1, 5.0, clamp(uLifetime, 0.1, 5.0));
  float rotation = clamp(uRotationStrength, 0.0, 1.0);
  float topAmount = topDownParticleAmount(amount);
  float resolvedDeadzoneFade = clamp(deadzoneFade, 0.0, 1.0);
  if (resolvedDeadzoneFade <= 0.0005) return 0.0;
  float accumulation = 0.0;

  for (int i = 0; i < 22; i++) {
    float layerIndex = float(i);
    float layer = mix(1.0, 32.0, layerIndex / 21.0);
    float layerGate = densityLayerGate(layerIndex, 21.0);
    if (layerGate <= 0.001) continue;
    accumulation += topDownParticleLayer(
      radius,
      deadzoneRadius,
      angle,
      topAmount,
      time,
      gustStrength,
      layer,
      lifetimeNorm,
      rotation,
      resolvedDeadzoneFade
    ) * layerGate;
  }

  float granularVariation = snowNoise(relative * 0.060 + vec2(time * 0.018, uSeed * 0.37));
  accumulation *= 1.06 * mix(0.88, 1.14, granularVariation) * mix(0.68, 1.12, densityLayerCoverage());
  return accumulation * resolvedDeadzoneFade;
}
#endif

void main() {
  float effectiveAlpha = uAlpha * uWorldAlpha;
  if (effectiveAlpha <= 0.0001 || uScale <= 0.0001) {
    gl_FragColor = vec4(0.0);
    return;
  }

  float amount = densityAmount();
  float gustStrength = clamp(uGustStrength, 0.0, 1.0);
  float time = uTime * max(0.05, uSpeed);
  float accumulation = 0.0;

#if defined(FXM_SNOWSTORM_TOP_DOWN)
  float focusBlend = smoothstep(0.0, 1.0, clamp(uTopDownBlend, 0.0, 1.0));
  float oldWeight = pow(1.0 - focusBlend, 1.15);
  float newWeight = smoothstep(0.02, 0.94, focusBlend);
  float draggedBlend = clamp(newWeight / max(0.0001, oldWeight + newWeight), 0.0, 1.0);
  vec2 draggedFocus = mix(uTopDownPreviousFocusGrid, uTopDownCurrentFocusGrid, draggedBlend);
  float draggedFade = topDownDeadzoneFade(vStormCoord - draggedFocus, uDeadzoneRadiusGrid);
  float deadzoneFade = draggedFade;

  if (focusBlend < 0.999) {
    float previousFade = topDownDeadzoneFade(vStormCoord - uTopDownPreviousFocusGrid, uDeadzoneRadiusGrid);
    float currentFade = topDownDeadzoneFade(vStormCoord - uTopDownCurrentFocusGrid, uDeadzoneRadiusGrid);
    float crossfadeFade = (previousFade * oldWeight + currentFade * newWeight) / max(0.0001, oldWeight + newWeight);
    deadzoneFade = min(draggedFade, crossfadeFade);
  }

  accumulation = topDownSnowAmount(vStormCoord, draggedFocus, draggedFocus, deadzoneFade, amount, time, gustStrength);
  float life = smoothstep(0.10, 5.0, clamp(uLifetime, 0.10, 5.0));
  float topAlpha = clamp((1.0 - exp(-accumulation * mix(0.62, 1.70, amount) * mix(0.82, 1.26, life))) * effectiveAlpha, 0.0, 0.93);
  vec3 topColor = min(vec3(1.0), uColor * 0.96);
  gl_FragColor = vec4(topColor * topAlpha, topAlpha);
#elif defined(FXM_SNOWSTORM_SIDE_VIEW)
  vec2 direction = normalize(uDirection);
  vec2 crossDirection = vec2(-direction.y, direction.x);
  vec2 p = vStormCoord / max(0.20, uScale * 2.35);
  vec2 oriented = vec2(dot(p, crossDirection), dot(p, direction));

  for (int i = 0; i < 26; i++) {
    float layerIndex = float(i);
    float f = mix(5.0, 32.0, layerIndex / 25.0);
    float layerGate = densityLayerGate(layerIndex, 25.0);
    float f1 = 1.0 + f * mix(1.12, 1.72, amount);
    float f2 = fract(f * 6.258817) - 0.80;
    float f3 = 1.0 + f * 0.045;
    vec2 snowUv = oriented * f1 * 0.075;
    float gustNoise = snowNoise(vec2(oriented.x * 0.045 + time * 0.050, oriented.y * 0.090 + f * 0.13));
    float gustBand = smoothstep(0.36, 0.94, 1.0 - abs(gustNoise * 2.0 - 1.0));
    float gustOffset = gustStrength * (gustBand - 0.45) * (0.45 + f * 0.022);
    snowUv += vec2(snowUv.y * 1.2 * f2 + gustOffset, -time / f3);
    snowUv.x += sin(oriented.y * 0.028 + time * 0.18 + f) * gustStrength * 0.36;
    accumulation += snowDensityForLayer(snowUv, f) * layerGate * mix(0.78, 1.44, gustBand * gustStrength);
  }
  accumulation *= mix(0.74, 1.08, densityLayerCoverage());

  float highDensityLift = smoothstep(1.0, 2.85, uDensity);
  float sideAlpha = clamp((1.0 - exp(-accumulation * mix(0.58, 1.52, amount) * mix(1.0, 1.18, highDensityLift))) * effectiveAlpha, 0.0, 0.97);
  vec3 sideColor = min(vec3(1.0), uColor * 0.96);
  gl_FragColor = vec4(sideColor * sideAlpha, sideAlpha);
#else
  if (uTopDown > 0.5) {
      float focusBlend = smoothstep(0.0, 1.0, clamp(uTopDownBlend, 0.0, 1.0));
      float oldWeight = pow(1.0 - focusBlend, 1.15);
      float newWeight = smoothstep(0.02, 0.94, focusBlend);
      float draggedBlend = clamp(newWeight / max(0.0001, oldWeight + newWeight), 0.0, 1.0);
      vec2 draggedFocus = mix(uTopDownPreviousFocusGrid, uTopDownCurrentFocusGrid, draggedBlend);
      float draggedFade = topDownDeadzoneFade(vStormCoord - draggedFocus, uDeadzoneRadiusGrid);
      float deadzoneFade = draggedFade;

      if (focusBlend < 0.999) {
        float previousFade = topDownDeadzoneFade(vStormCoord - uTopDownPreviousFocusGrid, uDeadzoneRadiusGrid);
        float currentFade = topDownDeadzoneFade(vStormCoord - uTopDownCurrentFocusGrid, uDeadzoneRadiusGrid);
        float crossfadeFade = (previousFade * oldWeight + currentFade * newWeight) / max(0.0001, oldWeight + newWeight);
        deadzoneFade = min(draggedFade, crossfadeFade);
      }

      accumulation = topDownSnowAmount(vStormCoord, draggedFocus, draggedFocus, deadzoneFade, amount, time, gustStrength);
      float life = smoothstep(0.10, 5.0, clamp(uLifetime, 0.10, 5.0));
      float topAlpha = clamp((1.0 - exp(-accumulation * mix(0.62, 1.70, amount) * mix(0.82, 1.26, life))) * effectiveAlpha, 0.0, 0.93);
      vec3 topColor = min(vec3(1.0), uColor * 0.96);
      gl_FragColor = vec4(topColor * topAlpha, topAlpha);
    return;
  }
  vec2 direction = normalize(uDirection);
  vec2 crossDirection = vec2(-direction.y, direction.x);
  vec2 p = vStormCoord / max(0.20, uScale * 2.35);
  vec2 oriented = vec2(dot(p, crossDirection), dot(p, direction));

  for (int i = 0; i < 26; i++) {
    float layerIndex = float(i);
    float f = mix(5.0, 32.0, layerIndex / 25.0);
    float layerGate = densityLayerGate(layerIndex, 25.0);
    float f1 = 1.0 + f * mix(1.12, 1.72, amount);
    float f2 = fract(f * 6.258817) - 0.80;
    float f3 = 1.0 + f * 0.045;
    vec2 snowUv = oriented * f1 * 0.075;
    float gustNoise = snowNoise(vec2(oriented.x * 0.045 + time * 0.050, oriented.y * 0.090 + f * 0.13));
    float gustBand = smoothstep(0.36, 0.94, 1.0 - abs(gustNoise * 2.0 - 1.0));
    float gustOffset = gustStrength * (gustBand - 0.45) * (0.45 + f * 0.022);
    snowUv += vec2(snowUv.y * 1.2 * f2 + gustOffset, -time / f3);
    snowUv.x += sin(oriented.y * 0.028 + time * 0.18 + f) * gustStrength * 0.36;
    accumulation += snowDensityForLayer(snowUv, f) * layerGate * mix(0.78, 1.44, gustBand * gustStrength);
  }
  accumulation *= mix(0.74, 1.08, densityLayerCoverage());

  float highDensityLift = smoothstep(1.0, 2.85, uDensity);
  float sideAlpha = clamp((1.0 - exp(-accumulation * mix(0.58, 1.52, amount) * mix(1.0, 1.18, highDensityLift))) * effectiveAlpha, 0.0, 0.97);
  vec3 sideColor = min(vec3(1.0), uColor * 0.96);
  gl_FragColor = vec4(sideColor * sideAlpha, sideAlpha);
#endif
}
`;

const SNOWSTORM_FRAGMENT_SHADER_SIDE_VIEW = `#define FXM_SNOWSTORM_SIDE_VIEW 1\n${FRAGMENT_SHADER}`;
const SNOWSTORM_FRAGMENT_SHADER_TOP_DOWN = `#define FXM_SNOWSTORM_TOP_DOWN 1\n${FRAGMENT_SHADER}`;

class SnowstormProceduralQuad extends PIXI.Container {
  /** @param {PIXI.Shader} shader */
  constructor(shader) {
    super();
    this.shader = shader;
    this.geometry = new PIXI.Geometry()
      .addAttribute("aVertexPosition", [0, 0, 1, 0, 1, 1, 0, 1], 2)
      .addIndex([0, 1, 2, 0, 2, 3]);
    this.state = PIXI.State.for2d();
    this.state.blendMode = PIXI.BLEND_MODES.SCREEN;
    this.name = "fxmProceduralSnowstormSurface";
    this.eventMode = "none";
    this.roundPixels = false;
    this.renderable = false;
  }

  /** @override */
  _render(renderer) {
    const shader = this.shader;
    if (!shader || !this.geometry || !this.state) return;
    shader.uniforms.translationMatrix = this.transform.worldTransform.toArray(true);
    shader.uniforms.uWorldAlpha = this.worldAlpha;
    renderer.batch.flush();
    renderer.state.set(this.state);
    renderer.shader.bind(shader);
    renderer.geometry.bind(this.geometry, shader);
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

const SNOWSTORM_PROGRAM_CACHE = new Map();

function snowstormProgramForMode(topDown = false) {
  const key = topDown ? "top-down" : "side-view";
  let program = SNOWSTORM_PROGRAM_CACHE.get(key);
  if (!program) {
    const fragmentShader = topDown ? SNOWSTORM_FRAGMENT_SHADER_TOP_DOWN : SNOWSTORM_FRAGMENT_SHADER_SIDE_VIEW;
    const name = topDown ? "fxmaster-snowstorm-top-down" : "fxmaster-snowstorm-side-view";
    program = PIXI.Program.from(VERTEX_SHADER, fragmentShader, name);
    SNOWSTORM_PROGRAM_CACHE.set(key, program);
  }
  return program;
}

function createSnowstormShader(uniforms, { topDown = false } = {}) {
  return new PIXI.Shader(snowstormProgramForMode(topDown), uniforms);
}

const SNOWSTORM_TOP_DOWN_RECENTER_FADE_MS = 1800;
const SNOWSTORM_TOP_DOWN_CAMERA_PAN_THRESHOLD_PX = 0.35;
const SNOWSTORM_TOP_DOWN_CAMERA_ZOOM_THRESHOLD = 0.0006;
const SNOWSTORM_TOP_DOWN_FOCUS_EPSILON_GRID = 0.04;

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

function mixPoint(from, to, amount = 0) {
  const a = copyPoint(from);
  const b = copyPoint(to, a);
  const t = clamp(amount, 0, 1, 0);
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
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

function normalizedRangeFraction(owner, key, value, fallback = 0) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return clamp(fallback, 0, 1, 0);
  if (raw <= 0) return 0;

  let parameter = null;
  try {
    parameter = owner?.constructor?.parameters?.[key] ?? null;
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  const range = parameter?.__fxmInternalRange;
  const min = Number(range?.min ?? parameter?.min ?? 0);
  const max = Number(range?.max ?? parameter?.max ?? 1);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return clamp(raw, 0, 1, fallback);
  return clamp((raw - min) / (max - min), 0, 1, fallback);
}

function clamp(value, min, max, fallback = min) {
  const number = Number(value);
  const safe = Number.isFinite(number) ? number : fallback;
  return Math.max(min, Math.min(max, safe));
}

function smoothstepNumber(edge0, edge1, value) {
  const lo = Number(edge0);
  const hi = Number(edge1);
  const x = Number(value);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !Number.isFinite(x) || lo === hi) return x >= hi ? 1 : 0;
  const t = clamp((x - lo) / (hi - lo), 0, 1, 0);
  return t * t * (3 - 2 * t);
}

function unwrapOption(value, fallback = undefined) {
  if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "value")) return value.value;
  return value === undefined ? fallback : value;
}

function parseHexColor(value, fallback = [0.95, 1.0, 1.0]) {
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
  const value = apply ? payload?.value ?? tint?.value : "#f2ffff";
  return parseHexColor(value);
}

function stableSeed(value) {
  const text = String(value ?? "fxmaster-snowstorm");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
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

function monotonicNow(ticker = null) {
  const tickerTime = Number(ticker?.lastTime);
  if (Number.isFinite(tickerTime) && tickerTime >= 0) return tickerTime;
  const performanceTime = Number(globalThis.performance?.now?.());
  return Number.isFinite(performanceTime) ? performanceTime : Date.now();
}

/**
 * Procedural snowstorm renderer based on Foundry's blizzard weather composition.
 */
export class SnowstormProceduralSurface {
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
    this._configuredTopDown = false;
    this._viewInitialized = false;
    this._lastCameraMatrix = null;
    this._topDownPreviousFocusGrid = null;
    this._topDownCurrentFocusGrid = null;
    this._topDownBlend = 1;
    this._topDownTransitionStart = 0;
    this._topDownTransitionActive = false;
    this._topDownPendingFocusGrid = null;
    this._topDownRecenterAfter = 0;
    this._baseDeadzoneGrid = 0.75;
    this._topDownDeadzoneGrid = 0.75;
    this._topDownPendingDeadzoneGrid = null;
    this._topDownDeadzoneApplyAfter = 0;
    this._topDownDeadzoneTargetGrid = 0.75;
    this._topDownDeadzoneLastUpdate = 0;
    this._cameraChangePending = false;
    this._canvasPanHookId = undefined;
    this._uniforms = {
      translationMatrix: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
      uBoundsOriginGrid: new Float32Array([0, 0]),
      uBoundsSizeGrid: new Float32Array([1, 1]),
      uTime: 0,
      uAlpha: 1,
      uWorldAlpha: 1,
      uScale: 2.5,
      uDensity: 0.6,
      uDensityControl: 0.3,
      uSpeed: 5,
      uLifetime: 1,
      uSeed: stableSeed(owner?.id ?? "fxmaster-snowstorm"),
      uGustStrength: 0.75,
      uTopDown: 0,
      uDeadzoneRadiusGrid: 1,
      uRotationStrength: 0.35,
      uTopDownDensityBoost: 1,
      uFocusGrid: new Float32Array([0, 0]),
      uTopDownPreviousFocusGrid: new Float32Array([0, 0]),
      uTopDownCurrentFocusGrid: new Float32Array([0, 0]),
      uTopDownBlend: 1,
      uDirection: new Float32Array([0.258819, 0.965926]),
      uColor: new Float32Array([0.95, 1.0, 1.0]),
    };
    this._shaderTopDownMode = !!unwrapOption(this.options?.topDown);
    this.shader = createSnowstormShader(this._uniforms, { topDown: this._shaderTopDownMode });
    this.displayObject = new SnowstormProceduralQuad(this.shader);
    this._tick = (delta) => this.update(delta);
    this.configure({ options: this.options, dimensions, renderer: this.renderer, ticker: this.ticker });
  }

  _resolveSynchronizedDirectionVector(fallback = 300) {
    const raw = unwrapOption(this.options?.direction, fallback);
    const direction =
      CONFIG.fxmaster?.resolveSynchronizedDirection?.(this.options, raw, this.options?.__fxmParticleContext) ?? raw;
    return geometricDirectionToCanvasVector(direction, fallback);
  }

  _updateDirectionUniform() {
    const uniforms = this.shader?.uniforms;
    if (!uniforms?.uDirection) return;
    const direction = this._resolveSynchronizedDirectionVector(300);
    uniforms.uDirection[0] = direction.x;
    uniforms.uDirection[1] = direction.y;
  }

  _ensureShaderMode(topDown) {
    const mode = !!topDown;
    if (this._shaderTopDownMode === mode && this.shader) return;
    const uniforms = this._uniforms ?? this.shader?.uniforms ?? {};
    const previousShader = this.shader ?? null;
    this.shader = createSnowstormShader(uniforms, { topDown: mode });
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
    const dimensionsSource =
      dimensions ?? CONFIG.fxmaster?.getParticleDimensions?.(this.options) ?? this.context?.dimensions;
    const sceneBounds = resolveDimensions(dimensionsSource);
    const sceneMinPx = Math.min(sceneBounds.width, sceneBounds.height);
    const largeSceneSpeedBoost = smoothstepNumber(8000, 16000, sceneMinPx);
    const topDown = !!unwrapOption(this.options?.topDown);
    this._ensureShaderMode(topDown);
    const uniforms = this.shader?.uniforms;
    if (uniforms) {
      const direction = this._resolveSynchronizedDirectionVector();
      const performanceScale = clamp(this.owner?.constructor?.getPerformanceDensityScale?.(), 0.25, 1, 1);
      const density = clamp(unwrapOption(this.options?.density), 0, 2.4, 0.72);
      if (topDown !== this._configuredTopDown) {
        this._viewInitialized = false;
        this._topDownTransitionActive = false;
        this._topDownBlend = 1;
        this._topDownPendingFocusGrid = null;
        this._topDownRecenterAfter = 0;
      }
      this._configuredTopDown = topDown;
      const densityFraction = normalizedRangeFraction(this.owner, "density", density, 0.3);
      const densityControl = clamp(densityFraction * performanceScale, 0, 1, densityFraction);
      const effectiveDensity = topDown ? Math.max(densityFraction * 0.1, 0.0026) : Math.max(density, 0.012);
      uniforms.uAlpha = clamp(unwrapOption(this.options?.alpha), 0, 1, 1);
      uniforms.uScale = clamp(unwrapOption(this.options?.scale), 0.1, 5, 2.5);
      uniforms.uDensity =
        clamp(effectiveDensity * (topDown ? 1.7 : 2.1), topDown ? 0.0044 : 0.025, topDown ? 0.17 : 4.8, 0.72) *
        performanceScale;
      uniforms.uDensityControl = densityControl;
      const speed = clamp(unwrapOption(this.options?.speed), 0.1, 10, 5);
      const topDownSpeedFraction = normalizedRangeFraction(this.owner, "speed", speed, 0.5);
      const topDownBaseSpeed = speed * (1.0 + 0.32 * Math.pow(topDownSpeedFraction, 1.1));
      const topDownSceneSpeedScale = 1.0 + largeSceneSpeedBoost * 0.85 * Math.pow(topDownSpeedFraction, 1.55);
      const topDownMaxSpeed = 13.2 * (1.0 + largeSceneSpeedBoost * 0.85);
      uniforms.uSpeed = topDown ? clamp(topDownBaseSpeed * topDownSceneSpeedScale, 0.1, topDownMaxSpeed, speed) : speed;
      uniforms.uLifetime = clamp(unwrapOption(this.options?.lifetime), 0.1, 5, 1);
      uniforms.uGustStrength = topDown ? 1.0 : 0.9;
      uniforms.uTopDown = topDown ? 1 : 0;
      uniforms.uRotationStrength = topDown ? clamp(unwrapOption(this.options?.rotationStrength), 0, 1, 0.35) : 0;
      uniforms.uDirection[0] = direction.x;
      uniforms.uDirection[1] = direction.y;
      uniforms.uColor = resolveTintColor(this.options);
      uniforms.uSeed = stableSeed(
        this.owner?.__fxmBackgroundUid ?? this.owner?.id ?? this.owner?.constructor?.label ?? "fxmaster-snowstorm",
      );
    }
    this.setDimensions(dimensionsSource);
    this.update(0);
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
      anchorWorld = { x: bounds.x + bounds.width * 0.5, y: bounds.y + bounds.height * 0.5 };
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
      anchorGrid: { x: anchorWorld.x / gridSize, y: anchorWorld.y / gridSize },
      screenGridSize,
      visibleMinGrid,
      topDownDensityBoost: clamp(
        Math.max(Math.pow(screenGridSize / 72, 0.62), Math.pow(148 / screenGridSize, 0.54)),
        1.1,
        4.35,
        1,
      ),
      matrix: rawMatrix,
      matrixSnapshot: copyMatrixSnapshot(rawMatrix),
      metrics,
    };
  }

  _initializeTopDownField(target, now) {
    const focus = copyPoint(target.anchorGrid);
    this._topDownPreviousFocusGrid = copyPoint(focus);
    this._topDownCurrentFocusGrid = copyPoint(focus);
    this._topDownBlend = 1;
    this._topDownTransitionStart = now;
    this._topDownTransitionActive = false;
    this._topDownPendingFocusGrid = null;
    this._topDownRecenterAfter = 0;
    this._topDownPendingDeadzoneGrid = null;
    this._topDownDeadzoneApplyAfter = 0;
    this._topDownDeadzoneTargetGrid = this._topDownDeadzoneGrid;
    this._topDownDeadzoneLastUpdate = now;
  }

  _snapTopDownFocus(focus, { fade = false, now = monotonicNow(this.ticker) } = {}) {
    const resolved = copyPoint(focus);
    const previous = this._topDownCurrentFocusGrid ?? resolved;
    const moved = Math.hypot(resolved.x - previous.x, resolved.y - previous.y) > SNOWSTORM_TOP_DOWN_FOCUS_EPSILON_GRID;
    const shouldFade = fade && moved;
    this._topDownPreviousFocusGrid = shouldFade ? copyPoint(previous) : copyPoint(resolved);
    this._topDownCurrentFocusGrid = copyPoint(resolved);
    this._topDownBlend = shouldFade ? 0 : 1;
    this._topDownTransitionStart = now;
    this._topDownTransitionActive = shouldFade;
    this._topDownPendingFocusGrid = null;
    this._topDownRecenterAfter = 0;
    this._topDownPendingDeadzoneGrid = null;
    this._topDownDeadzoneApplyAfter = 0;
    this._topDownDeadzoneTargetGrid = this._topDownDeadzoneGrid;
    this._topDownDeadzoneLastUpdate = now;
  }

  _advanceTopDownRecenterFade(now) {
    if (!this._topDownTransitionActive) return;
    this._topDownBlend = clamp((now - this._topDownTransitionStart) / SNOWSTORM_TOP_DOWN_RECENTER_FADE_MS, 0, 1, 1);
    if (this._topDownBlend >= 1) this._topDownTransitionActive = false;
  }

  _queueTopDownRecenter(target, now, settleMs) {
    this._topDownPendingFocusGrid = copyPoint(target.anchorGrid, this._topDownPendingFocusGrid);
    this._topDownRecenterAfter = Math.max(
      Number(this._topDownRecenterAfter) || 0,
      now + Math.max(0, Number(settleMs) || 0),
    );
  }

  _updateTopDownField(target, now, cameraChange) {
    const focus = copyPoint(target?.anchorGrid, this._topDownCurrentFocusGrid ?? { x: 0, y: 0 });

    if (this._hasScopedContext()) {
      this._snapTopDownFocus(focus);
      return;
    }

    const previous = this._topDownCurrentFocusGrid ?? focus;
    const moved = Math.hypot(focus.x - previous.x, focus.y - previous.y) > SNOWSTORM_TOP_DOWN_FOCUS_EPSILON_GRID;
    const cameraActive =
      (Number(cameraChange?.pan) || 0) > SNOWSTORM_TOP_DOWN_CAMERA_PAN_THRESHOLD_PX ||
      (Number(cameraChange?.zoom) || 0) > SNOWSTORM_TOP_DOWN_CAMERA_ZOOM_THRESHOLD ||
      (Number(cameraChange?.zoomPixels) || 0) > SNOWSTORM_TOP_DOWN_CAMERA_PAN_THRESHOLD_PX ||
      this._cameraChangePending;

    if (moved && cameraActive) {
      const priorBlend = smoothstepNumber(0, 1, this._topDownBlend);
      const previousSource = this._topDownTransitionActive
        ? mixPoint(this._topDownPreviousFocusGrid, this._topDownCurrentFocusGrid, priorBlend)
        : previous;
      this._topDownPreviousFocusGrid = copyPoint(previousSource);
      this._topDownCurrentFocusGrid = copyPoint(focus);
      this._topDownBlend = 0;
      this._topDownTransitionStart = now;
      this._topDownTransitionActive = true;
      this._topDownPendingFocusGrid = null;
      this._topDownRecenterAfter = 0;
      this._cameraChangePending = false;
      return;
    }

    this._advanceTopDownRecenterFade(now);
    this._cameraChangePending = false;
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
    this._topDownDeadzoneTargetGrid = resolved;

    if (!Number.isFinite(Number(now)) || !this._viewInitialized) {
      this._topDownDeadzoneGrid = resolved;
      this._topDownDeadzoneLastUpdate = Number(now) || 0;
      return resolved;
    }

    const current = clamp(Number(this._topDownDeadzoneGrid) || resolved, 0.25, 10.5, resolved);
    const previousUpdate = Number(this._topDownDeadzoneLastUpdate);
    const deltaMs =
      Number.isFinite(previousUpdate) && previousUpdate > 0 ? clamp(now - previousUpdate, 0, 1000, 0) : 1000 / 60;
    this._topDownDeadzoneLastUpdate = now;

    const responseMs = zoomActive ? 520 : 300;
    const blend = 1 - Math.exp(-deltaMs / Math.max(1, responseMs));
    const smoothed = Math.abs(resolved - current) <= 0.004 ? resolved : current + (resolved - current) * blend;
    this._topDownDeadzoneGrid = clamp(smoothed, 0.25, 10.5, resolved);
    this._topDownPendingDeadzoneGrid = null;
    this._topDownDeadzoneApplyAfter = 0;
    return this._topDownDeadzoneGrid;
  }

  _updateViewUniforms(now = monotonicNow(this.ticker)) {
    const uniforms = this.shader?.uniforms;
    if (!uniforms || !this.bounds) return;

    const target = this._resolveViewTarget();
    const topDown = uniforms.uTopDown > 0.5;
    uniforms.uTopDownDensityBoost = target.topDownDensityBoost;

    if (!topDown) {
      uniforms.uTopDownBlend = 1;
      uniforms.uTopDownPreviousFocusGrid[0] = target.anchorGrid.x;
      uniforms.uTopDownPreviousFocusGrid[1] = target.anchorGrid.y;
      uniforms.uTopDownCurrentFocusGrid[0] = target.anchorGrid.x;
      uniforms.uTopDownCurrentFocusGrid[1] = target.anchorGrid.y;
      uniforms.uFocusGrid[0] = target.anchorGrid.x;
      uniforms.uFocusGrid[1] = target.anchorGrid.y;
      this._viewInitialized = true;
      this._lastCameraMatrix = target.matrixSnapshot;
      this._cameraChangePending = false;
      return;
    }

    const cameraChange = cameraChangeDetails(target.matrixSnapshot, this._lastCameraMatrix, target.cssW, target.cssH);
    const zoomActive =
      (Number(cameraChange?.zoom) || 0) > SNOWSTORM_TOP_DOWN_CAMERA_ZOOM_THRESHOLD ||
      (Number(cameraChange?.zoomPixels) || 0) > SNOWSTORM_TOP_DOWN_CAMERA_PAN_THRESHOLD_PX;
    uniforms.uDeadzoneRadiusGrid = this._resolveTopDownDeadzoneGrid(target, now, zoomActive);

    if (!this._viewInitialized) {
      this._initializeTopDownField(target, now);
      this._viewInitialized = true;
    } else {
      this._updateTopDownField(target, now, cameraChange);
    }

    const previousFocus = this._topDownPreviousFocusGrid ?? target.anchorGrid;
    const currentFocus = this._topDownCurrentFocusGrid ?? target.anchorGrid;
    uniforms.uFocusGrid[0] = currentFocus.x;
    uniforms.uFocusGrid[1] = currentFocus.y;
    uniforms.uTopDownPreviousFocusGrid[0] = previousFocus.x;
    uniforms.uTopDownPreviousFocusGrid[1] = previousFocus.y;
    uniforms.uTopDownCurrentFocusGrid[0] = currentFocus.x;
    uniforms.uTopDownCurrentFocusGrid[1] = currentFocus.y;
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

  /** @param {object|null|undefined} dimensions */
  setDimensions(dimensions) {
    if (this.destroyed) return;
    this.bounds = resolveDimensions(dimensions);
    try {
      this.displayObject.position.set(this.bounds.x, this.bounds.y);
      this.displayObject.width = this.bounds.width;
      this.displayObject.height = this.bounds.height;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    const uniforms = this.shader?.uniforms;
    if (!uniforms) return;
    uniforms.uBoundsOriginGrid[0] = this.bounds.x / this.bounds.gridSize;
    uniforms.uBoundsOriginGrid[1] = this.bounds.y / this.bounds.gridSize;
    uniforms.uBoundsSizeGrid[0] = this.bounds.width / this.bounds.gridSize;
    uniforms.uBoundsSizeGrid[1] = this.bounds.height / this.bounds.gridSize;

    let deadzone = this.bounds.gridSize * 0.75;
    try {
      deadzone = Number(this.owner?.getTopDownDeadzoneRadius?.(this.bounds.source)) || deadzone;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    this._baseDeadzoneGrid = clamp(deadzone / this.bounds.gridSize, 0.25, 10.5, 0.75);
    this._topDownDeadzoneGrid = this._baseDeadzoneGrid;
    this._topDownDeadzoneTargetGrid = this._baseDeadzoneGrid;
    this._topDownDeadzoneLastUpdate = monotonicNow(this.ticker);
    this._topDownPendingDeadzoneGrid = null;
    this._topDownDeadzoneApplyAfter = 0;
    uniforms.uDeadzoneRadiusGrid = this._baseDeadzoneGrid;
    this._updateViewUniforms(monotonicNow(this.ticker));
  }

  start() {
    if (this.destroyed) return;
    this._registerCanvasPanHook();
    this._viewInitialized = false;
    this.displayObject.renderable = true;
    if (this.running) return;
    this.running = true;
    try {
      this.ticker?.add?.(this._tick);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    this.update(0);
  }

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

  /** @param {number|object} [_delta] */
  update(_delta = 0) {
    if (this.destroyed || !this.displayObject || this.displayObject.destroyed || !this.shader?.uniforms) return;
    const now = monotonicNow(this.ticker);
    this.shader.uniforms.uTime = now / 1000;
    this._updateDirectionUniform();
    this._updateViewUniforms(now);
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
  }
}

export const SNOWSTORM_PROCEDURAL_VERTEX_SHADER = VERTEX_SHADER;
export const SNOWSTORM_PROCEDURAL_FRAGMENT_SHADER = FRAGMENT_SHADER;
export const SNOWSTORM_PROCEDURAL_FRAGMENT_SHADER_SIDE_VIEW = SNOWSTORM_FRAGMENT_SHADER_SIDE_VIEW;
export const SNOWSTORM_PROCEDURAL_FRAGMENT_SHADER_TOP_DOWN = SNOWSTORM_FRAGMENT_SHADER_TOP_DOWN;
