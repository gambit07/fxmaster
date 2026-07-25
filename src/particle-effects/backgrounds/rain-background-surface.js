import {
  particleBackgroundMonotonicNow,
  particleBackgroundNow,
  unwrapParticleBackgroundOption,
} from "./background-state.js";
import { ParticleAccumulationBackgroundSurface, clamp } from "./background-surface-base.js";

const RAIN_FRAGMENT_SHADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vCssCoord;
uniform float uProgress;
uniform float uOpacity;
uniform float uRuntimeAlpha;
uniform float uSeed;
uniform float uGridSize;
uniform float uFillVariation;
uniform float uCoverage;
uniform float uPatchScale;
uniform float uReflectionStrength;
uniform float uShimmerStrength;
uniform float uShimmerSpeed;
uniform float uGroundMovementSpeed;
uniform float uTime;
uniform float uRainSheetTime;
uniform float uRainDensity;
uniform float uRainScale;
uniform float uRainSpeed;
uniform float uRainTopDown;
uniform float uRainBackgroundQuality;
uniform float uRainInteractionStrength;
uniform float uRainInteractionLiftChance;
uniform float uRainInteractionSettleTime;
uniform sampler2D uTrailTexture;
uniform sampler2D uTrailAgeTexture;
uniform float uTrailsEnabled;
uniform float uTrailStrength;
uniform float uTrailRefillEnabled;
uniform float uTrailClock;
uniform vec4 uTrailBounds;
uniform vec2 uWind;
uniform vec2 uRainSheetWind;
uniform vec2 uRainSheetBasis;
uniform vec2 uRainSheetPreviousBasis;
uniform float uRainSheetBasisBlend;
uniform vec2 uRainSheetTravel;
uniform vec2 uRainSheetPreviousTravel;
uniform mat3 uCssToWorld;
uniform vec3 uColor;

const float FXM_TAU = 6.28318530717958647692;

float rainHash12(vec2 p) {
  p += uSeed * vec2(13.17, -8.63);
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 rainHash22(vec2 p) {
  float n = rainHash12(p);
  return vec2(n, rainHash12(p + vec2(19.19, 7.17)));
}

float rainValueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = rainHash12(i);
  float b = rainHash12(i + vec2(1.0, 0.0));
  float c = rainHash12(i + vec2(0.0, 1.0));
  float d = rainHash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float rainFbm2(vec2 p) {
  float value = 0.62 * rainValueNoise(p);
  p = mat2(0.80, -0.60, 0.60, 0.80) * p * 2.03 + vec2(7.3, 13.1);
  value += 0.38 * rainValueNoise(p);
  return value;
}

float rainDensityAmount(float density) {
  float normalized = clamp(log(1.0 + max(0.0, density)) / log(8.50), 0.0, 1.0);
  float shaped = pow(normalized, 0.82);
  float lowDensityGate = smoothstep(0.006, 0.115, normalized);
  return shaped * lowDensityGate;
}

float rainFbm3(vec2 p) {
  float value = 0.68 * rainValueNoise(p);
  p = mat2(0.80, -0.60, 0.60, 0.80) * p * 2.03 + vec2(7.3, 13.1);
  value += 0.32 * rainValueNoise(p);
  return value;
}

float rainStormBackdropSpeed(float speedFactor) {
  float speed = max(0.05, uRainSpeed);
  float groundSpeed = clamp(uGroundMovementSpeed, 0.0, 2.5);
  return (0.44 + 0.28 * sqrt(speed)) * groundSpeed * speedFactor;
}

float rainStormFogFbm(vec2 uv, float t) {
  uv = uv * 2.0 + vec2(t * 0.060, -t * 0.035);
  float value = 0.74 * rainValueNoise(uv);
  uv = mat2(0.80, -0.60, 0.60, 0.80) * uv * 2.42 + vec2(4.7, -6.1) + vec2(-t * 0.020, t * 0.025);
  value += 0.26 * rainValueNoise(uv);
  return value;
}

float rainStormCoreMist(vec2 uv, float t) {
  vec2 shifted = uv * 4.5;
  float flow = rainStormFogFbm(shifted + t * 0.115, t);
  vec2 mv = vec2(
    flow,
    rainValueNoise(shifted * 1.37 + vec2(-t * 0.051, t * 0.067) + vec2(19.3, -12.7))
  ) * 0.42;
  float primary = rainStormFogFbm(shifted + mv - t * 0.0275, t);
  float veil = rainValueNoise(shifted * 0.62 + vec2(17.3, -11.9) - t * 0.018);
  return primary * 0.76 + veil * 0.24;
}

float rainStormCoreFogSheet(
  vec2 p,
  vec2 basisDir,
  vec2 motionDir,
  vec2 sheetTravel,
  float spatialScale,
  float speedFactor,
  float densityAmount,
  float seedOffset
) {
  vec2 d = basisDir / max(length(basisDir), 0.0001);
  vec2 motion = motionDir / max(length(motionDir), 0.0001);
  vec2 crossDir = vec2(-d.y, d.x);
  float scale = sqrt(max(0.10, uRainScale));
  vec2 oriented = vec2(dot(p, crossDir), dot(p, d));
  float windLean = dot(motion, crossDir);

  float sheetSpeed = rainStormBackdropSpeed(speedFactor);
  float travelScale = sheetSpeed * max(6.0, spatialScale * scale);
  float forwardTravel = sheetTravel.y * travelScale;
  float lateralTravel = (sheetTravel.x * 0.34 + sheetTravel.y * windLean * 0.22) * travelScale;
  vec2 uv = vec2(
    (oriented.x - lateralTravel * 0.62 - oriented.y * windLean * 0.030) / max(3.0, spatialScale * 0.62 * scale),
    (oriented.y - forwardTravel) / max(5.0, spatialScale * 1.42 * scale)
  );
  uv += vec2(seedOffset * 0.011, -seedOffset * 0.017);

  float t = -uRainSheetTime * rainStormBackdropSpeed(speedFactor * 0.42) + seedOffset * 0.013;

  float morphSpeed = (0.15 + 0.13 * sqrt(max(0.05, uRainSpeed))) * (0.70 + 0.30 * speedFactor);
  float morphTime = uRainSheetTime * morphSpeed + seedOffset * 0.019;
  vec2 morphUv = uv;
  float broadFlow = rainFbm3(
    morphUv * vec2(0.46, 0.72) + vec2(seedOffset * 0.017, -seedOffset * 0.023) + vec2(0.0, -morphTime * 0.62)
  );
  float crossFlow = rainFbm2(
    morphUv * vec2(1.08, 1.64) + vec2(-seedOffset * 0.029, seedOffset * 0.031) + vec2(morphTime * 0.17, -morphTime * 0.44)
  );
  float veinPhase = morphUv.y * 2.85 - morphTime * 2.75 + broadFlow * FXM_TAU + seedOffset * 0.047;
  float movingVein = 0.5 + 0.5 * sin(veinPhase);
  float advectedVein = rainFbm2(
    morphUv * vec2(1.65, 2.45) + vec2((crossFlow - 0.5) * 0.36, -morphTime * 0.55)
  );
  vec2 morphedUv = uv + vec2((broadFlow - 0.5) * 0.115 + windLean * 0.035, (crossFlow - 0.5) * 0.085);

  float mist = rainStormCoreMist(morphedUv * 2.0 - 1.0, t) * 1.33;
  float activeMist = mist * mix(0.92, 1.10, broadFlow) + movingVein * 0.075 + advectedVein * 0.055;
  float slopeMask = smoothstep(0.58 - movingVein * 0.045, 1.36, activeMist);

  float broad = rainFbm3(
    morphedUv * vec2(0.82, 2.28) + vec2(seedOffset * 0.031, -seedOffset * 0.041) + vec2(0.0, -morphTime * 0.18)
  );
  float softFront = smoothstep(
    mix(0.66, 0.45, densityAmount),
    0.96,
    broad * 0.60 + activeMist * 0.25 + max(movingVein, advectedVein) * 0.15
  );
  float breakup = mix(0.72, 1.07, smoothstep(0.20, 0.92, crossFlow * 0.44 + advectedVein * 0.36 + broadFlow * 0.20));
  float livingSheet = mix(0.92, 1.08, smoothstep(0.18, 0.88, broadFlow * 0.46 + movingVein * 0.31 + crossFlow * 0.23));

  return clamp((slopeMask * 0.70 + softFront * 0.40) * breakup * livingSheet * mix(0.48, 1.12, densityAmount), 0.0, 1.18);
}

float rainStormTopDownWetFilm(vec2 p, vec2 dir, float densityAmount) {
  vec2 d = dir / max(length(dir), 0.0001);
  vec2 crossDir = vec2(-d.y, d.x);
  float scale = sqrt(max(0.10, uRainScale));
  float t = uTime * rainStormBackdropSpeed(0.34);

  vec2 uvA = p / max(2.2, 6.8 * scale);
  vec2 uvB = mat2(0.64, -0.77, 0.77, 0.64) * p / max(2.0, 5.2 * scale);
  vec2 warp = vec2(
    rainFbm3(uvA * 1.38 + vec2(t * 0.18, -t * 0.11) + vec2(uSeed * 0.041, -uSeed * 0.063)),
    rainFbm3(uvB * 1.17 + vec2(-t * 0.13, t * 0.16) + vec2(-uSeed * 0.072, uSeed * 0.055))
  ) - 0.5;

  float broad = rainFbm3(uvA * 2.18 + warp * 0.72 + vec2(t * 0.29, -t * 0.21));
  float shear = rainFbm3(uvB * 2.64 - warp.yx * 0.48 + vec2(-t * 0.18, t * 0.25));
  float grain = rainFbm2(p * mix(0.44, 0.76, densityAmount) + vec2(uSeed * 0.13 + t * 0.08, -uSeed * 0.17 - t * 0.05));

  vec2 braidedUv = vec2(
    dot(p, d) / max(1.6, 4.8 * scale),
    dot(p, crossDir) / max(1.5, 3.6 * scale)
  );
  float braided = rainFbm2(braidedUv + warp * 0.34 + vec2(-t * 0.10, t * 0.14));
  float wetFront = smoothstep(
    mix(0.62, 0.42, densityAmount),
    0.96,
    broad * 0.46 + shear * 0.34 + grain * 0.12 + braided * 0.08
  );
  float anisotropicSheen = smoothstep(0.42, 0.90, braided * 0.62 + shear * 0.38);
  return clamp(wetFront * (0.70 + 0.30 * anisotropicSheen), 0.0, 1.08);
}

float rainStormSheetField(vec2 p, vec2 dir, vec2 motionDir, vec2 sheetTravel, float densityAmount) {
  vec2 d = dir / max(length(dir), 0.0001);
  vec2 motion = motionDir / max(length(motionDir), 0.0001);
  vec2 crossDir = vec2(-d.y, d.x);
  float quality = clamp(uRainBackgroundQuality, 0.55, 1.0);

  if (uRainTopDown < 0.5) {
    float storm = 0.0;
    storm += rainStormCoreFogSheet(p, d, motion, sheetTravel, 15.5, 0.82, densityAmount, 11.7) * 0.82;
    storm += rainStormCoreFogSheet(p, normalize(d * 0.96 + crossDir * 0.16), motion, sheetTravel, 22.0, 0.58, densityAmount, 47.3) * mix(0.40, 0.56, quality);
    return clamp(storm, 0.0, 1.18);
  }

  float film = rainStormTopDownWetFilm(p, normalize(vec2(0.70710678, -0.70710678)), densityAmount);
  if (quality < 0.84) return clamp(film * 0.92, 0.0, 1.08);
  float filmB = rainStormTopDownWetFilm(p + vec2(13.1, -7.4), normalize(vec2(-0.38, 0.92)), densityAmount);
  return clamp(film * 0.76 + filmB * 0.36, 0.0, 1.12);
}

vec4 rainTokenWake(vec2 world, vec2 p) {
  if (uTrailsEnabled <= 0.5 || uRainInteractionStrength <= 0.001) return vec4(0.0);

  vec2 trailSize = max(uTrailBounds.zw, vec2(1.0));
  vec2 trailUv = (world - uTrailBounds.xy) / trailSize;
  float inside =
    step(0.0, trailUv.x) * step(trailUv.x, 1.0) *
    step(0.0, trailUv.y) * step(trailUv.y, 1.0);
  vec2 sampledTrailUv = clamp(trailUv, vec2(0.0), vec2(1.0));
  float rawMask = texture2D(uTrailTexture, sampledTrailUv).a * inside;
  float mask = smoothstep(0.018, 0.82, rawMask);
  if (mask <= 0.0001) return vec4(0.0);

  float ageSeconds = 0.0;
  float life = 1.0;
  if (uTrailRefillEnabled > 0.5) {
    vec4 ageSample = texture2D(uTrailAgeTexture, sampledTrailUv);
    vec3 stampBytes = floor(ageSample.rgb * 255.0 + 0.5);
    float stampUnits = dot(stampBytes, vec3(65536.0, 256.0, 1.0));
    float ageUnits = mod(uTrailClock - stampUnits + 16777216.0, 16777216.0);
    ageSeconds = ageUnits * 0.05;
    life = clamp(1.0 - ageSeconds / max(0.4, uRainInteractionSettleTime), 0.0, 1.0);
    life = life * life * (3.0 - 2.0 * life);
    mask *= step(0.001, ageSample.a);
  }

  float edge = smoothstep(0.06, 0.46, mask) * (1.0 - smoothstep(0.72, 1.0, mask));
  float turbulence = rainFbm2(p * 2.55 + vec2(uSeed * 0.29, -uSeed * 0.23));
  float fine = rainFbm2(p * 6.4 + vec2(-uSeed * 0.41, uSeed * 0.37));
  float pulse = 0.5 + 0.5 * sin(ageSeconds * 13.5 + turbulence * FXM_TAU * 2.3 + fine * 3.1);
  float broken = smoothstep(0.30, 0.92, turbulence * 0.62 + fine * 0.38);
  float wake = mask * life;
  float splash = wake * (0.42 + 0.58 * max(edge, broken * pulse));

  float liftChance = clamp(uRainInteractionLiftChance, 0.0, 1.0);
  float liftNoise = rainFbm2(p * 9.2 + vec2(uSeed * -0.51, uSeed * 0.47));
  liftNoise = liftNoise * 0.62 + fine * 0.26 + turbulence * 0.12;
  float liftGate = smoothstep(mix(0.98, 0.50, liftChance), 1.0, liftNoise + pulse * 0.16);
  float liftLife = smoothstep(0.02, 0.20, life) * (1.0 - smoothstep(0.82, 1.0, life) * 0.22);
  float lift = wake * edge * liftGate * liftLife * liftChance;
  return vec4(wake, splash, life, lift);
}

void main() {
  float progress = clamp(uProgress, 0.0, 1.0);
  if (progress <= 0.0001 || uRuntimeAlpha <= 0.0001) {
    gl_FragColor = vec4(0.0);
    return;
  }

  vec2 world = (uCssToWorld * vec3(vCssCoord, 1.0)).xy;
  float grid = max(1.0, uGridSize);
  vec2 p = world / grid;
  float fillVariation = clamp(uFillVariation, 0.0, 1.0);

  float patchScale = clamp(uPatchScale, 0.35, 5.0);
  float patchSpacing = max(1.15, patchScale * 2.35);
  float coverage = clamp(uCoverage, 0.05, 1.0);
  float coverageInfluence = smoothstep(0.04, 0.70, coverage);
  float patchInfluence = smoothstep(0.35, 1.15, patchScale);
  float backgroundCoverage = coverageInfluence * mix(0.35, 1.0, patchInfluence);

  float waterMask = 0.0;
  float waterCore = 0.0;
  float waterAge = 0.0;

  if (uRainTopDown > 0.5) {
    vec2 q = p / patchSpacing;
    vec2 baseCell = floor(q - vec2(0.5));
    float presenceChance = clamp(0.045 + coverage * 0.86, 0.035, 0.88);
    float radiusScale = mix(0.74, 1.28, smoothstep(0.05, 1.0, coverage));

    for (int y = 0; y < 2; y++) {
      for (int x = 0; x < 2; x++) {
        vec2 cell = baseCell + vec2(float(x), float(y));
        vec2 randomPair = rainHash22(cell + vec2(uSeed * 5.17, -uSeed * 3.91));
        float cellBasin = rainFbm2(
          (cell + randomPair * 0.55) * 0.31 + vec2(uSeed * 0.047, -uSeed * 0.039)
        );
        float localChance = clamp(
          presenceChance + (cellBasin - 0.5) * 0.42 * fillVariation,
          0.02,
          0.94
        );
        float patchEnabled = step(
          rainHash12(cell + vec2(41.7, -23.9)),
          localChance
        );

        vec2 center = cell + vec2(0.5) + (randomPair - 0.5) * 0.34;
        vec2 delta = q - center;
        float angle = rainHash12(cell + vec2(8.31, 17.73)) * FXM_TAU;
        vec2 axis = vec2(cos(angle), sin(angle));
        vec2 local = vec2(dot(delta, axis), dot(delta, vec2(-axis.y, axis.x)));

        float aspect = mix(1.05, 1.68, rainHash12(cell + vec2(-11.9, 5.7)));
        vec2 ellipseLocal = local / vec2(aspect, 1.0);
        float polarAngle = atan(ellipseLocal.y, ellipseLocal.x);

        float phaseA = rainHash12(cell + vec2(23.4, -9.1)) * FXM_TAU;
        float phaseB = rainHash12(cell + vec2(-31.7, 12.8)) * FXM_TAU;
        float phaseC = rainHash12(cell + vec2(5.6, 34.2)) * FXM_TAU;
        float shoreline = 1.0;
        shoreline += sin(polarAngle + phaseC) * 0.055 * fillVariation;
        shoreline += sin(polarAngle * 2.0 + phaseA) * 0.042 * fillVariation;
        shoreline += sin(polarAngle * 3.0 + phaseB) * 0.018 * fillVariation;

        float randomArrival = rainHash12(cell + vec2(-37.1, 14.9));
        float basinArrival = clamp(0.82 * randomArrival + 0.18 * (1.0 - cellBasin), 0.0, 1.0);
        float arrival = pow(basinArrival, 1.40) * 0.78 * fillVariation;
        float growthWindow = mix(0.54, 0.24, fillVariation);
        float localAge = smoothstep(arrival, min(1.0, arrival + growthWindow), progress);

        float targetRadius = mix(0.245, 0.385, rainHash12(cell + vec2(16.7, -28.3)));
        targetRadius *= radiusScale * mix(0.92, 1.09, cellBasin);
        float growth = mix(0.040, 1.0, pow(localAge, 0.72));
        float normalizedDistance = length(ellipseLocal) / max(0.008, targetRadius * growth * shoreline);

        float shape = 1.0 - smoothstep(0.66, 1.22, normalizedDistance);
        float core = 1.0 - smoothstep(0.08, 0.92, normalizedDistance);
        float contribution = patchEnabled * shape * localAge;
        waterMask = 1.0 - (1.0 - waterMask) * (1.0 - contribution);
        waterCore = max(waterCore, patchEnabled * core * localAge);
        waterAge = max(waterAge, contribution * localAge);
      }
    }
  }

  vec2 wind = uWind / max(length(uWind), 0.0001);

  float wetField = rainFbm2(p / max(5.0, patchSpacing * 4.4) + vec2(uSeed * 0.061, -uSeed * 0.043));
  float wetFieldB = rainFbm2(p / max(3.8, patchSpacing * 3.1) + vec2(-uSeed * 0.083, uSeed * 0.057));
  float wetArrival = mix(0.0, clamp(0.07 + wetField * 0.64, 0.025, 0.74), fillVariation);
  float wetAge = smoothstep(wetArrival, min(1.0, wetArrival + mix(0.56, 0.30, fillVariation)), progress);
  wetAge = max(wetAge * mix(0.24, 1.0, backgroundCoverage), progress * (0.03 + 0.32 * backgroundCoverage));

  float angleA = rainHash12(vec2(uSeed * 0.31, 9.17)) * FXM_TAU;
  float angleB = rainHash12(vec2(-4.73, uSeed * 0.27)) * FXM_TAU;
  vec2 seededA = vec2(cos(angleA), sin(angleA));
  vec2 seededB = vec2(cos(angleB), sin(angleB));
  vec2 mixedDirA = mix(seededA, wind, 0.18);
  vec2 mixedDirB = mix(seededB, vec2(-wind.y, wind.x), 0.14);
  vec2 dirA = mixedDirA / max(length(mixedDirA), 0.0001);
  vec2 dirB = mixedDirB / max(length(mixedDirB), 0.0001);
  float broadStructure = mix(wetField, wetFieldB, 0.43);
  broadStructure += sin(dot(p, dirA) * 0.21 + wetFieldB * 2.2) * 0.055;
  broadStructure += sin(dot(p, dirB) * 0.29 - wetField * 1.7) * 0.045;
  float broadBand = smoothstep(0.24, 0.82, broadStructure);

  float phaseFieldA = rainFbm2(p * 0.19 + vec2(uSeed * 0.12, -uSeed * 0.09));
  float phaseFieldB = rainFbm2(p * 0.27 + vec2(-uSeed * 0.15, uSeed * 0.11));
  float rateField = rainValueNoise(p * 0.13 + vec2(uSeed * 0.07, uSeed * 0.16));
  float shimmerSpeed = clamp(uShimmerSpeed, 0.0, 5.0);
  float shimmerTime = uTime * shimmerSpeed * 3.35;
  float pulseA = 0.5 + 0.5 * sin(
    shimmerTime * mix(0.72, 1.52, rateField) + phaseFieldA * FXM_TAU * 2.6
  );
  float pulseB = 0.5 + 0.5 * sin(
    shimmerTime * mix(1.34, 0.58, rateField) + phaseFieldB * FXM_TAU * 3.1 + 1.7
  );
  float standingA = sin(dot(p, dirA) * 5.6 + phaseFieldA * 2.1);
  standingA *= cos(shimmerTime * 0.83 + phaseFieldB * 1.4);
  float standingB = sin(dot(p, dirB) * 8.1 - phaseFieldB * 2.4);
  standingB *= cos(shimmerTime * 1.17 + phaseFieldA * 1.9 + 0.8);
  float standingLight = clamp(0.50 + standingA * 0.25 + standingB * 0.25, 0.0, 1.0);
  float glintStructure = smoothstep(
    0.46,
    0.88,
    rainFbm2(p * 0.82 + vec2(-uSeed * 0.21, uSeed * 0.18) + vec2(shimmerTime * 0.030, -shimmerTime * 0.021))
  );
  float localPulse = pow(clamp(pulseA * pulseB, 0.0, 1.0), mix(6.0, 3.65, shimmerSpeed / 5.0));
  float shimmerGlint = glintStructure * max(localPulse, pow(standingLight, mix(6.0, 3.95, shimmerSpeed / 5.0)) * 0.90);

  float reflection = clamp(uReflectionStrength, 0.0, 1.0);
  float shimmer = clamp(uShimmerStrength, 0.0, 1.0);
  float wetOpacity = clamp(uOpacity, 0.0, 1.0);
  float densityAmount = rainDensityAmount(uRainDensity);
  vec2 sheetWind = uRainSheetWind / max(length(uRainSheetWind), 0.0001);
  vec2 sheetBasis = uRainSheetBasis / max(length(uRainSheetBasis), 0.0001);
  vec2 sheetPreviousBasis = uRainSheetPreviousBasis / max(length(uRainSheetPreviousBasis), 0.0001);
  float sheetBasisBlend = clamp(uRainSheetBasisBlend, 0.0, 1.0);
  float rainSheets = rainStormSheetField(p, sheetBasis, sheetWind, uRainSheetTravel, densityAmount);
  if (sheetBasisBlend < 0.999) {
    float previousRainSheets = rainStormSheetField(p, sheetPreviousBasis, sheetWind, uRainSheetPreviousTravel, densityAmount);
    rainSheets = mix(previousRainSheets, rainSheets, sheetBasisBlend);
  }
  vec4 tokenWake = rainTokenWake(world, p);
  float coverageDamp = mix(0.04, 1.0, backgroundCoverage);
  float rainSheetLight = rainSheets * coverageDamp;
  float motionWetAge = max(wetAge, mix(0.10, 1.0, smoothstep(0.0, 0.14, progress)) * backgroundCoverage);
  float sheetEnergy = motionWetAge * rainSheets * coverageDamp * (0.78 + 1.02 * densityAmount) * (0.78 + 0.62 * wetOpacity);
  float wakeWetness = clamp(max(max(waterMask, wetAge), motionWetAge * 0.62), 0.0, 1.0);
  float interactionStrength = clamp(uRainInteractionStrength, 0.0, 1.0);
  float liftEnergy = tokenWake.w * interactionStrength;
  float wakeEnergy = (tokenWake.y + tokenWake.w * 1.35) * interactionStrength;
  wakeEnergy *= smoothstep(0.015, 0.18, progress) * (0.34 + 0.66 * wakeWetness);
  wakeEnergy *= mix(0.52, 1.0, densityAmount) * (0.72 + 0.38 * wetOpacity);
  liftEnergy *= smoothstep(0.015, 0.18, progress) * mix(0.62, 1.0, densityAmount);

  float sceneSheenAlpha = wetAge * reflection * (0.040 + 0.17 * reflection + 0.11 * wetOpacity);
  sceneSheenAlpha *= (0.54 + 0.46 * broadBand) * mix(0.34, 1.0, backgroundCoverage);
  sceneSheenAlpha += wetAge * shimmer * shimmerGlint * 0.070 * mix(0.25, 1.0, backgroundCoverage);
  sceneSheenAlpha += sheetEnergy * (0.165 + reflection * 0.240 + shimmer * 0.125);
  sceneSheenAlpha += wakeEnergy * (0.120 + reflection * 0.190 + shimmer * 0.135);
  sceneSheenAlpha += liftEnergy * (0.070 + reflection * 0.120 + shimmer * 0.170);
  sceneSheenAlpha = clamp(sceneSheenAlpha * uRuntimeAlpha, 0.0, max(mix(0.10, 0.52, backgroundCoverage), wakeEnergy * 0.46 + liftEnergy * 0.30));

  vec3 coolSheen = min(vec3(1.0), mix(uColor, vec3(0.82, 0.90, 0.96), 0.68));
  vec3 sheenColor = mix(
    coolSheen * 0.72,
    vec3(0.95, 0.982, 1.0),
    clamp(broadBand * 0.34 + shimmerGlint * 0.26 + rainSheetLight * 0.76 + wakeEnergy * 0.92 + liftEnergy * 0.88, 0.0, 1.0)
  );
  sheenColor = mix(sheenColor, vec3(0.92, 0.972, 1.0), clamp(wakeEnergy * 0.42 + liftEnergy * 0.34, 0.0, 0.50));

  float patchAge = smoothstep(0.08, 0.88, waterAge);
  float patchCore = smoothstep(0.04, 0.82, waterCore);
  float patchRim = clamp((waterMask - waterCore * 0.58) * 1.92, 0.0, 1.0);
  float patchBreakup = rainFbm2(p * 1.18 + vec2(uSeed * 0.24, -uSeed * 0.19));
  float patchMicroBreakup = rainFbm2(p * 3.85 + vec2(-uSeed * 0.37, uSeed * 0.31));
  float patchDepth = waterMask * patchAge * mix(0.72, 1.08, patchBreakup);
  patchDepth *= mix(0.78, 1.08, patchCore) * mix(0.92, 1.06, patchMicroBreakup);

  float patchShadowAlpha = patchDepth * wetOpacity * uRuntimeAlpha;
  patchShadowAlpha *= (0.026 + 0.112 * backgroundCoverage) * (0.72 + 0.28 * reflection);
  patchShadowAlpha = clamp(patchShadowAlpha, 0.0, mix(0.055, 0.185, backgroundCoverage));

  float patchRimLight = patchRim * patchAge * (
    reflection * (0.020 + 0.050 * broadBand + 0.075 * rainSheetLight) +
    shimmer * max(shimmerGlint * 0.030, rainSheetLight * 0.045)
  );
  patchRimLight = clamp(
    patchRimLight + wakeEnergy * (0.080 + reflection * 0.120 + shimmer * 0.070) +
    liftEnergy * (0.105 + reflection * 0.110 + shimmer * 0.110),
    0.0,
    0.34
  );
  sceneSheenAlpha = clamp(sceneSheenAlpha + patchRimLight * 0.38 * uRuntimeAlpha, 0.0, 0.64);

  vec3 depthShadow = mix(vec3(0.006, 0.010, 0.014), uColor * 0.20, 0.24);
  vec3 softReflection = min(vec3(1.0), uColor * 0.20 + vec3(0.20, 0.26, 0.31));
  vec3 patchDepthColor = mix(depthShadow, softReflection, patchRimLight);
  patchDepthColor *= 1.0 - patchCore * 0.075;

  float outputAlpha = sceneSheenAlpha + patchShadowAlpha * (1.0 - sceneSheenAlpha);
  vec3 outputColor = sheenColor * sceneSheenAlpha;
  outputColor += patchDepthColor * patchShadowAlpha * (1.0 - sceneSheenAlpha);
  gl_FragColor = vec4(outputColor, outputAlpha);
}
`;

function rainBackgroundStageZoom() {
  const stage = globalThis.canvas?.stage ?? null;
  const sx = Math.abs(Number(stage?.scale?.x ?? 1)) || 1;
  const sy = Math.abs(Number(stage?.scale?.y ?? sx)) || sx;
  return Math.max(0.0001, sx, sy);
}

function rainBackgroundQualityForZoom() {
  const zoom = rainBackgroundStageZoom();
  if (zoom >= 2.25) return 0.68;
  if (zoom >= 1.45) return 0.82;
  return 1;
}

function rainBackgroundFilterResolutionForQuality(filter, quality) {
  const rendererResolution = Number(globalThis.canvas?.app?.renderer?.resolution ?? filter?.resolution ?? 1);
  const base = clamp(rendererResolution, 1, 1.25, 1);
  if (quality <= 0.7) return Math.min(base, 0.72);
  if (quality <= 0.85) return Math.min(base, 0.86);
  return base;
}

function rainBackgroundDirectionVector(degrees = 315) {
  const value = Number(degrees);
  const radians = ((Number.isFinite(value) ? value : 315) * Math.PI) / 180;
  return new Float32Array([Math.cos(radians), -Math.sin(radians)]);
}

function rainBackgroundNormalizeVector(vector, fallback = [1, 0]) {
  const x = Number(vector?.[0]);
  const y = Number(vector?.[1]);
  const length = Math.hypot(x, y);
  if (length > 0.0001) return new Float32Array([x / length, y / length]);
  return new Float32Array(fallback);
}

function rainBackgroundVectorDeltaRadians(a, b) {
  const ax = Number(a?.[0]) || 1;
  const ay = Number(a?.[1]) || 0;
  const bx = Number(b?.[0]) || 1;
  const by = Number(b?.[1]) || 0;
  return Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
}

function rainBackgroundBlendVectors(a, b, amount) {
  const t = clamp(amount, 0, 1, 0);
  return rainBackgroundNormalizeVector(
    [
      (Number(a?.[0]) || 0) + ((Number(b?.[0]) || 0) - (Number(a?.[0]) || 0)) * t,
      (Number(a?.[1]) || 0) + ((Number(b?.[1]) || 0) - (Number(a?.[1]) || 0)) * t,
    ],
    b,
  );
}

function rainBackgroundBlendTravel(a, b, amount) {
  const t = clamp(amount, 0, 1, 0);
  return new Float32Array([
    (Number(a?.[0]) || 0) + ((Number(b?.[0]) || 0) - (Number(a?.[0]) || 0)) * t,
    (Number(a?.[1]) || 0) + ((Number(b?.[1]) || 0) - (Number(a?.[1]) || 0)) * t,
  ]);
}

function rainBackgroundAdvanceTravel(travel, basis, motion, dt) {
  if (!(travel instanceof Float32Array) || travel.length < 2 || !(dt > 0)) return;
  const d = rainBackgroundNormalizeVector(basis);
  const m = rainBackgroundNormalizeVector(motion, d);
  const cross = [-d[1], d[0]];
  travel[0] += (m[0] * cross[0] + m[1] * cross[1]) * dt;
  travel[1] += (m[0] * d[0] + m[1] * d[1]) * dt;
  if (Math.abs(travel[0]) > 4096) travel[0] %= 4096;
  if (Math.abs(travel[1]) > 4096) travel[1] %= 4096;
}

function rainBackgroundSheetWindVector(options = {}) {
  const raw = Number(unwrapParticleBackgroundOption(options?.direction));
  const fallback = Number.isFinite(raw) ? raw : 315;
  const resolved =
    CONFIG.fxmaster?.resolveSynchronizedDirection?.(options, fallback, options?.__fxmParticleContext) ?? fallback;
  return rainBackgroundDirectionVector(resolved);
}

/**
 * Procedural rain wet-surface layer. It reuses the persistent background timing
 * and world-space placement from the shared accumulation surface, combines bounded
 * soft depth/shadow patches with a core Rain Storm-inspired moving fog/sheet sheen,
 * and keeps the broad moving layer responsive to the background coverage controls.
 */
export class RainBackgroundSurface extends ParticleAccumulationBackgroundSurface {
  /** @override */
  static get surfaceType() {
    return "rain";
  }

  /** @override */
  static get fragmentShader() {
    return RAIN_FRAGMENT_SHADER;
  }

  /** @override */
  static get defaultColorHex() {
    return "#6f9bb0";
  }

  /** @override */
  static get defaultColorRgb() {
    return [0.435, 0.608, 0.69];
  }

  /** @override */
  configure(config = {}) {
    const rawOptions = config?.options ?? this.options ?? {};
    const initialInteractionEnabled = !!unwrapParticleBackgroundOption(rawOptions?.backgroundInteractionEnabled);
    const initialInteractionRadius = clamp(
      unwrapParticleBackgroundOption(rawOptions?.backgroundInteractionRadius),
      0,
      2,
      0.85,
    );
    const initialInteractionStrength = clamp(
      unwrapParticleBackgroundOption(rawOptions?.backgroundInteractionStrength),
      0,
      1,
      0.75,
    );

    super.configure({
      ...config,
      options: {
        ...rawOptions,
        backgroundTrailsEnabled: initialInteractionEnabled,
        backgroundTrailRefillEnabled: initialInteractionEnabled,
        backgroundTrailWidth: initialInteractionRadius,
        backgroundTrailStrength: initialInteractionStrength,
      },
    });
    if (this._destroyed) return;

    this.coverage = clamp(unwrapParticleBackgroundOption(this.options?.backgroundCoverage), 0.05, 1, 0.65);
    this.patchScale = clamp(unwrapParticleBackgroundOption(this.options?.backgroundPatchSize), 0.35, 5, 0.85);
    this.reflectionStrength = clamp(
      unwrapParticleBackgroundOption(this.options?.backgroundReflectionStrength),
      0,
      1,
      0.58,
    );
    this.shimmerStrength = clamp(unwrapParticleBackgroundOption(this.options?.backgroundShimmerStrength), 0, 1, 0.42);
    this.shimmerSpeed = clamp(unwrapParticleBackgroundOption(this.options?.backgroundShimmerSpeed), 0, 5, 0.7);
    this.groundMovementSpeed = clamp(
      unwrapParticleBackgroundOption(this.options?.backgroundGroundMovementSpeed),
      0,
      2.5,
      1,
    );
    this.interactionEnabled = !!unwrapParticleBackgroundOption(this.options?.backgroundInteractionEnabled);
    this.interactionRadius = clamp(
      unwrapParticleBackgroundOption(this.options?.backgroundInteractionRadius),
      0,
      2,
      0.85,
    );
    this.interactionStrength = clamp(
      unwrapParticleBackgroundOption(this.options?.backgroundInteractionStrength),
      0,
      1,
      0.75,
    );
    this.interactionLiftChance = clamp(
      unwrapParticleBackgroundOption(this.options?.backgroundInteractionLiftChance),
      0,
      1,
      0.35,
    );
    this.interactionSettleTime = clamp(
      unwrapParticleBackgroundOption(this.options?.backgroundInteractionSettleTime),
      0.4,
      5,
      2.8,
    );
    this.trailsEnabled = this.interactionEnabled;
    this.trailRefillEnabled = this.interactionEnabled;
    this.trailWidth = this.interactionRadius;
    this.trailStrength = this.interactionStrength;
    this._configureInteractionTrailStore();
    this.rainDensity = clamp(unwrapParticleBackgroundOption(this.options?.density), 0.01, 6.5, 0.5);
    this.rainScale = clamp(unwrapParticleBackgroundOption(this.options?.scale), 0.1, 5, 1);
    this.rainSpeed = clamp(unwrapParticleBackgroundOption(this.options?.speed), 0.1, 5, 1);
    this.rainTopDown = !!unwrapParticleBackgroundOption(this.options?.topDown);
    this._rainSheetTravel ??= new Float32Array([0, 0]);
    this._rainSheetPreviousTravel ??= new Float32Array([0, 0]);
    if (!this._rainSheetTravelUsesLocalPhase) {
      this._rainSheetTravel[0] = 0;
      this._rainSheetTravel[1] = 0;
      this._rainSheetTravelUsesLocalPhase = true;
      this._rainSheetTime = 0;
    }

    const uniforms = this.filter?.uniforms;
    if (uniforms) {
      uniforms.uCoverage = this.coverage;
      uniforms.uPatchScale = this.patchScale;
      uniforms.uReflectionStrength = this.reflectionStrength;
      uniforms.uShimmerStrength = this.shimmerStrength;
      uniforms.uShimmerSpeed = this.shimmerSpeed;
      uniforms.uGroundMovementSpeed = this.groundMovementSpeed;
      uniforms.uRainDensity = this.rainDensity;
      uniforms.uRainScale = this.rainScale;
      uniforms.uRainSpeed = this.rainSpeed;
      uniforms.uRainTopDown = this.rainTopDown ? 1 : 0;
      this._syncRainSheetWindUniform({ uniforms });
      uniforms.uRainBackgroundQuality = rainBackgroundQualityForZoom();
      uniforms.uRainInteractionStrength = this.interactionEnabled ? this.interactionStrength : 0;
      uniforms.uRainInteractionLiftChance = this.interactionEnabled ? this.interactionLiftChance : 0;
      uniforms.uRainInteractionSettleTime = this.interactionSettleTime;
    }

    const now = particleBackgroundNow();
    const tick = particleBackgroundMonotonicNow();
    this.update({ now, tick });
  }

  shouldRestoreTokenTrailHistory() {
    return false;
  }

  _configureInteractionTrailStore() {
    const store = this.trailStore ?? null;
    if (!store) {
      this._syncTrailUniforms();
      return;
    }

    const tick = particleBackgroundMonotonicNow();
    try {
      store.setEnabled?.(this.trailsEnabled);
      if (this.bounds) store.setBounds?.(this.bounds);
      store.resetForSignature?.(this._trailResetSignature());
      store.setRefillEnabled?.(this.trailsEnabled, tick);
    } catch (_err) {}
    this._syncTrailUniforms(tick);
  }

  _syncRainSheetWindUniform({ uniforms, tick } = {}) {
    if (!uniforms) return;
    const target = rainBackgroundSheetWindVector(this.options);
    const currentTick = Number.isFinite(Number(tick)) ? Number(tick) : particleBackgroundMonotonicNow();

    if (!(this._rainSheetWind instanceof Float32Array) || this._rainSheetWind.length < 2) {
      this._rainSheetWind = new Float32Array(target);
      this._rainSheetWindTick = currentTick;
    }
    if (!(this._rainSheetBasis instanceof Float32Array) || this._rainSheetBasis.length < 2) {
      this._rainSheetBasis = new Float32Array(target);
      this._rainSheetPreviousBasis = new Float32Array(target);
      this._rainSheetBasisTarget = new Float32Array(target);
      this._rainSheetPreviousTravel = new Float32Array(this._rainSheetTravel);
      this._rainSheetBasisBlend = 1;
      this._rainSheetBasisStartTick = currentTick;
      this._rainSheetBasisElapsedMs = 1;
      this._rainSheetBasisDurationMs = 1;
    }
    if (!(this._rainSheetPreviousBasis instanceof Float32Array) || this._rainSheetPreviousBasis.length < 2) {
      this._rainSheetPreviousBasis = new Float32Array(this._rainSheetBasis);
    }
    if (!(this._rainSheetBasisTarget instanceof Float32Array) || this._rainSheetBasisTarget.length < 2) {
      this._rainSheetBasisTarget = new Float32Array(this._rainSheetBasis);
    }
    if (!(this._rainSheetTravel instanceof Float32Array) || this._rainSheetTravel.length < 2) {
      this._rainSheetTravel = new Float32Array([0, 0]);
    }
    if (!(this._rainSheetPreviousTravel instanceof Float32Array) || this._rainSheetPreviousTravel.length < 2) {
      this._rainSheetPreviousTravel = new Float32Array(this._rainSheetTravel);
    }

    const previousTick = Number.isFinite(Number(this._rainSheetWindTick))
      ? Number(this._rainSheetWindTick)
      : currentTick;
    const dt = Math.max(0, Math.min(0.04, (currentTick - previousTick) / 1000));
    this._rainSheetWindTick = currentTick;

    const blend = dt > 0 ? 1 - Math.exp(-2.15 * dt) : 0;
    this._rainSheetWind[0] += (target[0] - this._rainSheetWind[0]) * blend;
    this._rainSheetWind[1] += (target[1] - this._rainSheetWind[1]) * blend;

    const length = Math.hypot(this._rainSheetWind[0], this._rainSheetWind[1]);
    if (length > 0.0001) {
      this._rainSheetWind[0] /= length;
      this._rainSheetWind[1] /= length;
    } else {
      this._rainSheetWind[0] = target[0];
      this._rainSheetWind[1] = target[1];
    }

    if (!Number.isFinite(this._rainSheetTime)) this._rainSheetTime = 0;
    if (dt > 0) {
      this._rainSheetTime = (this._rainSheetTime + dt) % 4096;
      rainBackgroundAdvanceTravel(this._rainSheetTravel, this._rainSheetBasis, this._rainSheetWind, dt);
      rainBackgroundAdvanceTravel(this._rainSheetPreviousTravel, this._rainSheetPreviousBasis, this._rainSheetWind, dt);
    }
    this._rainSheetFrameDt = dt;

    const targetDelta = Math.abs(rainBackgroundVectorDeltaRadians(this._rainSheetBasisTarget, target));
    const transitionActive = clamp(this._rainSheetBasisBlend, 0, 1, 1) < 0.995;
    const updateThreshold = transitionActive ? 0.34 : 0.14;
    if (targetDelta > updateThreshold) {
      const visibleBasis = rainBackgroundBlendVectors(
        this._rainSheetPreviousBasis,
        this._rainSheetBasis,
        this._rainSheetBasisBlend,
      );
      const visibleTravel = rainBackgroundBlendTravel(
        this._rainSheetPreviousTravel,
        this._rainSheetTravel,
        this._rainSheetBasisBlend,
      );
      this._rainSheetPreviousBasis = visibleBasis;
      this._rainSheetPreviousTravel = new Float32Array(visibleTravel);
      this._rainSheetBasis = new Float32Array(target);
      this._rainSheetBasisTarget = new Float32Array(target);
      this._rainSheetTravel = new Float32Array(visibleTravel);
      this._rainSheetBasisBlend = 0;
      this._rainSheetBasisStartTick = currentTick;
      this._rainSheetBasisElapsedMs = 0;
      this._rainSheetBasisDurationMs =
        820 + Math.min(1180, (Math.abs(rainBackgroundVectorDeltaRadians(visibleBasis, target)) / Math.PI) * 1180);
    }

    const duration = Math.max(1, Number(this._rainSheetBasisDurationMs) || 1);
    const priorElapsed = Number.isFinite(Number(this._rainSheetBasisElapsedMs))
      ? Number(this._rainSheetBasisElapsedMs)
      : this._rainSheetBasisBlend >= 0.995
      ? duration
      : 0;
    this._rainSheetBasisElapsedMs = Math.min(duration, priorElapsed + dt * 1000);
    this._rainSheetBasisBlend = clamp(this._rainSheetBasisElapsedMs / duration, 0, 1, 1);

    uniforms.uRainSheetWind = this._rainSheetWind;
    uniforms.uRainSheetBasis = this._rainSheetBasis;
    uniforms.uRainSheetPreviousBasis = this._rainSheetPreviousBasis;
    uniforms.uRainSheetBasisBlend = this._rainSheetBasisBlend;
    uniforms.uRainSheetTravel = this._rainSheetTravel;
    uniforms.uRainSheetPreviousTravel = this._rainSheetPreviousTravel;
    uniforms.uRainSheetTime = this._rainSheetTime;
  }

  /** @override */
  _trailActivityDurationSeconds() {
    return this.interactionEnabled ? clamp(this.interactionSettleTime, 0.4, 5, 2.8) + 0.35 : 0;
  }

  /** @override */
  _updateSurfaceUniforms({ tick, uniforms } = {}) {
    if (!uniforms) return;
    uniforms.uCoverage = clamp(this.coverage, 0.05, 1, 0.65);
    uniforms.uPatchScale = clamp(this.patchScale, 0.35, 5, 0.85);
    uniforms.uReflectionStrength = clamp(this.reflectionStrength, 0, 1, 0.58);
    uniforms.uShimmerStrength = clamp(this.shimmerStrength, 0, 1, 0.42);
    uniforms.uShimmerSpeed = clamp(this.shimmerSpeed, 0, 5, 0.7);
    uniforms.uGroundMovementSpeed = clamp(this.groundMovementSpeed, 0, 2.5, 1);
    uniforms.uRainDensity = clamp(this.rainDensity, 0.01, 6.5, 0.5);
    uniforms.uRainScale = clamp(this.rainScale, 0.1, 5, 1);
    uniforms.uRainSpeed = clamp(this.rainSpeed, 0.1, 5, 1);
    uniforms.uRainTopDown = this.rainTopDown ? 1 : 0;
    this._syncRainSheetWindUniform({ uniforms, tick });
    const backgroundQuality = rainBackgroundQualityForZoom();
    uniforms.uRainBackgroundQuality = backgroundQuality;
    const filterResolution = rainBackgroundFilterResolutionForQuality(this.filter, backgroundQuality);
    if (this.filter && Math.abs((Number(this.filter.resolution) || 1) - filterResolution) > 0.01) {
      this.filter.resolution = filterResolution;
    }
    uniforms.uRainInteractionStrength = this.interactionEnabled ? clamp(this.interactionStrength, 0, 1, 0.75) : 0;
    uniforms.uRainInteractionLiftChance = this.interactionEnabled ? clamp(this.interactionLiftChance, 0, 1, 0.35) : 0;
    uniforms.uRainInteractionSettleTime = clamp(this.interactionSettleTime, 0.4, 5, 2.8);

    const frameDt = Number.isFinite(Number(this._rainSheetFrameDt))
      ? Math.max(0, Math.min(0.045, Number(this._rainSheetFrameDt)))
      : 0;
    this._rainSheetVisualTime = Math.max(0, Number(this._rainSheetVisualTime) || 0) + frameDt;
    uniforms.uTime = this._rainSheetVisualTime;
  }
}
