import { ParticleAccumulationBackgroundSurface, clamp } from "./background-surface-base.js";
import { unwrapParticleBackgroundOption } from "./background-state.js";

export const SNOW_BACKGROUND_FRAGMENT_SHADER = `
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
uniform float uDriftStrength;
uniform float uDriftScale;
uniform vec2 uWind;
uniform mat3 uCssToWorld;
uniform vec3 uColor;
uniform sampler2D uTrailTexture;
uniform sampler2D uTrailAgeTexture;
uniform float uTrailsEnabled;
uniform float uTrailStrength;
uniform float uTrailRefillEnabled;
uniform float uTrailRefillDuration;
uniform float uTrailClock;
uniform vec4 uTrailBounds;
uniform vec2 uTrailTexel;

vec2 hash22(vec2 p) {
  p += uSeed * vec2(19.19, -7.73);
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return -1.0 + 2.0 * fract((p3.xx + p3.yz) * p3.zy);
}

float gradientNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

  float n00 = dot(hash22(i), f);
  float n10 = dot(hash22(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
  float n01 = dot(hash22(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
  float n11 = dot(hash22(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));

  float nx0 = mix(n00, n10, u.x);
  float nx1 = mix(n01, n11, u.x);
  return clamp(0.5 + 0.72 * mix(nx0, nx1, u.y), 0.0, 1.0);
}

float fbm2(vec2 p) {
  float value = 0.0;
  float amplitude = 0.58;
  float normalization = 0.0;
  mat2 turn = mat2(0.80, -0.60, 0.60, 0.80);
  for (int i = 0; i < 2; i++) {
    value += amplitude * gradientNoise(p);
    normalization += amplitude;
    p = turn * p * 2.01 + vec2(13.7, 7.9);
    amplitude *= 0.5;
  }
  return value / max(normalization, 0.0001);
}

float fbm3(vec2 p) {
  float value = 0.0;
  float amplitude = 0.54;
  float normalization = 0.0;
  mat2 turn = mat2(0.80, -0.60, 0.60, 0.80);
  for (int i = 0; i < 3; i++) {
    value += amplitude * gradientNoise(p);
    normalization += amplitude;
    p = turn * p * 2.01 + vec2(13.7, 7.9);
    amplitude *= 0.5;
  }
  return value / max(normalization, 0.0001);
}


float sampleTrailAlpha(vec2 uv) {
  return texture2D(uTrailTexture, clamp(uv, vec2(0.0), vec2(1.0))).a;
}

float sampleFilteredTrailMask(vec2 uv, vec2 texel) {
  vec2 tx = max(texel, vec2(0.00001));
  vec2 nearTx = tx * 0.55;
  vec2 farTx = tx * 1.35;
  float center = sampleTrailAlpha(uv);

  float nearAxial = (
    sampleTrailAlpha(uv + vec2(nearTx.x, 0.0)) +
    sampleTrailAlpha(uv - vec2(nearTx.x, 0.0)) +
    sampleTrailAlpha(uv + vec2(0.0, nearTx.y)) +
    sampleTrailAlpha(uv - vec2(0.0, nearTx.y))
  ) * 0.25;
  float nearDiagonal = (
    sampleTrailAlpha(uv + nearTx) +
    sampleTrailAlpha(uv - nearTx) +
    sampleTrailAlpha(uv + vec2(nearTx.x, -nearTx.y)) +
    sampleTrailAlpha(uv + vec2(-nearTx.x, nearTx.y))
  ) * 0.25;
  float farAxial = (
    sampleTrailAlpha(uv + vec2(farTx.x, 0.0)) +
    sampleTrailAlpha(uv - vec2(farTx.x, 0.0)) +
    sampleTrailAlpha(uv + vec2(0.0, farTx.y)) +
    sampleTrailAlpha(uv - vec2(0.0, farTx.y))
  ) * 0.25;
  float farDiagonal = (
    sampleTrailAlpha(uv + farTx) +
    sampleTrailAlpha(uv - farTx) +
    sampleTrailAlpha(uv + vec2(farTx.x, -farTx.y)) +
    sampleTrailAlpha(uv + vec2(-farTx.x, farTx.y))
  ) * 0.25;

  float blur = center * 0.34 + nearAxial * 0.24 + nearDiagonal * 0.12 + farAxial * 0.20 + farDiagonal * 0.10;
  float feather = center * 0.18 + nearAxial * 0.24 + nearDiagonal * 0.16 + farAxial * 0.22 + farDiagonal * 0.20;
  float mask = max(center * 0.70, max(blur, feather * 1.02));
  mask = smoothstep(0.010, 0.90, mask);
  return mask * mask * (3.0 - 2.0 * mask);
}

vec4 chooseTrailAge(vec4 best, vec4 candidate) {
  if (candidate.a > best.a) return candidate;
  return best;
}

vec4 sampleTrailAge(vec2 uv, vec2 texel) {
  vec2 tx = max(texel, vec2(0.00001));
  vec4 best = texture2D(uTrailAgeTexture, clamp(uv, vec2(0.0), vec2(1.0)));
  best = chooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv + vec2(tx.x, 0.0), vec2(0.0), vec2(1.0))));
  best = chooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv - vec2(tx.x, 0.0), vec2(0.0), vec2(1.0))));
  best = chooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv + vec2(0.0, tx.y), vec2(0.0), vec2(1.0))));
  best = chooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv - vec2(0.0, tx.y), vec2(0.0), vec2(1.0))));
  best = chooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv + tx, vec2(0.0), vec2(1.0))));
  best = chooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv - tx, vec2(0.0), vec2(1.0))));
  best = chooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv + vec2(tx.x, -tx.y), vec2(0.0), vec2(1.0))));
  best = chooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv + vec2(-tx.x, tx.y), vec2(0.0), vec2(1.0))));
  vec2 wide = tx * 1.85;
  best = chooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv + vec2(wide.x, 0.0), vec2(0.0), vec2(1.0))));
  best = chooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv - vec2(wide.x, 0.0), vec2(0.0), vec2(1.0))));
  best = chooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv + vec2(0.0, wide.y), vec2(0.0), vec2(1.0))));
  best = chooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv - vec2(0.0, wide.y), vec2(0.0), vec2(1.0))));
  return best;
}

float sampleTrailAgeCoverage(vec2 uv, vec2 texel) {
  vec2 tx = max(texel, vec2(0.00001));
  float center = texture2D(uTrailAgeTexture, clamp(uv, vec2(0.0), vec2(1.0))).a;
  float axial = 0.0;
  axial += texture2D(uTrailAgeTexture, clamp(uv + vec2(tx.x, 0.0), vec2(0.0), vec2(1.0))).a;
  axial += texture2D(uTrailAgeTexture, clamp(uv - vec2(tx.x, 0.0), vec2(0.0), vec2(1.0))).a;
  axial += texture2D(uTrailAgeTexture, clamp(uv + vec2(0.0, tx.y), vec2(0.0), vec2(1.0))).a;
  axial += texture2D(uTrailAgeTexture, clamp(uv - vec2(0.0, tx.y), vec2(0.0), vec2(1.0))).a;
  axial *= 0.25;

  float diagonal = 0.0;
  diagonal += texture2D(uTrailAgeTexture, clamp(uv + tx, vec2(0.0), vec2(1.0))).a;
  diagonal += texture2D(uTrailAgeTexture, clamp(uv - tx, vec2(0.0), vec2(1.0))).a;
  diagonal += texture2D(uTrailAgeTexture, clamp(uv + vec2(tx.x, -tx.y), vec2(0.0), vec2(1.0))).a;
  diagonal += texture2D(uTrailAgeTexture, clamp(uv + vec2(-tx.x, tx.y), vec2(0.0), vec2(1.0))).a;
  diagonal *= 0.25;

  float coverage = center * 0.50 + axial * 0.34 + diagonal * 0.16;
  return smoothstep(0.025, 0.72, coverage);
}

void main() {
  float progress = clamp(uProgress, 0.0, 1.0);
  if (progress <= 0.0001 || uOpacity <= 0.0001 || uRuntimeAlpha <= 0.0001) {
    gl_FragColor = vec4(0.0);
    return;
  }

  vec2 world = (uCssToWorld * vec3(vCssCoord, 1.0)).xy;
  float grid = max(1.0, uGridSize);
  vec2 p = world / grid;

  float driftScale = max(0.05, uDriftScale);
  vec2 largeP = p / driftScale;

  float warpA = fbm2(largeP * 0.88 + vec2(uSeed * 0.071, -uSeed * 0.049));
  float warpB = fbm2(largeP * 0.73 + vec2(-uSeed * 0.057, uSeed * 0.083));
  vec2 warpedP = p + (vec2(warpA, warpB) - 0.5) * driftScale * 0.12;

  float broad = gradientNoise(warpedP * 0.18 + vec2(uSeed * 0.031, -uSeed * 0.047));
  float medium = fbm2(warpedP * 0.30 + vec2(-uSeed * 0.081, uSeed * 0.059));

  vec2 wind = normalize(uWind);
  vec2 crossWind = vec2(-wind.y, wind.x);
  vec2 oriented = vec2(dot(p, wind), dot(p, crossWind));
  oriented += vec2(warpA - 0.5, warpB - 0.5) * driftScale * vec2(0.42, 0.22);
  vec2 driftP = vec2(oriented.x / (driftScale * 2.10), oriented.y / (driftScale * 0.72));
  vec2 driftOffset = vec2(uSeed * 0.109, -uSeed * 0.091);
  float driftNoise = fbm2(driftP + driftOffset);
  float ridge = 1.0 - abs(2.0 * driftNoise - 1.0);
  ridge = smoothstep(0.74, 0.97, ridge);

  float mound = 0.72 * broad + 0.28 * medium;
  float height = clamp(
    0.30 + 0.52 * mound + uDriftStrength * (0.30 * (ridge - 0.38) + 0.08 * (driftNoise - 0.5)),
    0.16,
    1.0
  );

  float deposition = clamp(
    0.88 * broad + 0.12 * medium +
      uDriftStrength * (0.05 * (driftNoise - 0.5) + 0.025 * (ridge - 0.55)),
    0.0,
    1.0
  );
  float depositionRank = smoothstep(0.18, 0.94, deposition);
  depositionRank = pow(depositionRank, 1.55);
  float arrivalField = 1.0 - depositionRank;
  float variationSpan = mix(0.66, 1.0, clamp(uFillVariation, 0.0, 1.0));
  arrivalField = clamp(0.5 + (arrivalField - 0.5) * variationSpan, 0.0, 1.0);

  float growthWindow = mix(0.18, 0.085, clamp(uFillVariation, 0.0, 1.0));
  float arrival = mix(0.0, 1.0 - growthWindow, arrivalField);
  float localAge = clamp((progress - arrival) / max(growthWindow, 0.0001), 0.0, 1.0);
  float settled = localAge * localAge * (3.0 - 2.0 * localAge);

  float detail = gradientNoise(p * 1.35 + vec2(uSeed * 0.137, uSeed * 0.113));

  float slopeLight = clamp((driftNoise - (0.55 * medium + 0.45 * broad)) * 0.30, -0.06, 0.06);
  float light = clamp(
    0.90 + 0.14 * height + uDriftStrength * slopeLight + 0.018 * (detail - 0.5),
    0.82,
    1.05
  );

  float trailMask = 0.0;
  if (uTrailsEnabled > 0.5) {
    vec2 trailSize = max(uTrailBounds.zw, vec2(1.0));
    vec2 trailUv = (world - uTrailBounds.xy) / trailSize;
    float inside =
      step(0.0, trailUv.x) * step(trailUv.x, 1.0) *
      step(0.0, trailUv.y) * step(trailUv.y, 1.0);
    vec2 sampledTrailUv = clamp(trailUv, vec2(0.0), vec2(1.0));
    vec2 trailTexel = max(uTrailTexel, vec2(0.00001));
    trailMask = sampleFilteredTrailMask(sampledTrailUv, trailTexel) * inside;

    if (uTrailRefillEnabled > 0.5) {
      vec4 ageSample = sampleTrailAge(sampledTrailUv, trailTexel);
      vec3 stampBytes = floor(ageSample.rgb * 255.0 + 0.5);
      float stampUnits = dot(stampBytes, vec3(65536.0, 256.0, 1.0));
      float ageUnits = mod(uTrailClock - stampUnits + 16777216.0, 16777216.0);
      float ageSeconds = ageUnits * 0.05;
      float remaining = clamp(1.0 - ageSeconds / max(0.25, uTrailRefillDuration), 0.0, 1.0);
      remaining = remaining * remaining * (3.0 - 2.0 * remaining);
      trailMask *= remaining * sampleTrailAgeCoverage(sampledTrailUv, trailTexel);
    }
  }
  float trailCut = clamp(trailMask * uTrailStrength, 0.0, 1.0);
  float trackedHeight = mix(height, max(0.12, height * 0.30), trailCut);

  float depthOpacity = mix(0.86, 1.03, trackedHeight);
  float alpha = clamp(settled * depthOpacity * uOpacity * uRuntimeAlpha, 0.0, 1.0);
  alpha *= 1.0 - 0.96 * trailCut;

  vec3 coolShadow = uColor * vec3(0.93, 0.97, 1.015);
  vec3 brightSnow = min(vec3(1.0), uColor * 1.035);
  float shadeMix = clamp(0.32 + 0.56 * trackedHeight + uDriftStrength * slopeLight * 3.0, 0.0, 1.0);
  vec3 color = mix(coolShadow, brightSnow, shadeMix) * light;
  gl_FragColor = vec4(color * alpha, alpha);
}
`;

export const SNOWSTORM_BACKGROUND_FRAGMENT_SHADER = `

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
uniform float uDriftStrength;
uniform float uDriftScale;
uniform vec2 uWind;
uniform mat3 uCssToWorld;
uniform vec3 uColor;
uniform sampler2D uTrailTexture;
uniform sampler2D uTrailAgeTexture;
uniform float uTrailsEnabled;
uniform float uTrailStrength;
uniform float uTrailRefillEnabled;
uniform float uTrailRefillDuration;
uniform float uTrailClock;
uniform vec4 uTrailBounds;
uniform vec2 uTrailTexel;
uniform float uTime;
uniform float uSnowstormSweepOpacity;
uniform float uSnowstormSweepScale;
uniform float uSnowstormSweepSpeed;
uniform float uSnowstormSweepStrength;

vec2 hash22(vec2 p) {
  p += uSeed * vec2(19.19, -7.73);
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return -1.0 + 2.0 * fract((p3.xx + p3.yz) * p3.zy);
}

float gradientNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

  float n00 = dot(hash22(i), f);
  float n10 = dot(hash22(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
  float n01 = dot(hash22(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
  float n11 = dot(hash22(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));

  float nx0 = mix(n00, n10, u.x);
  float nx1 = mix(n01, n11, u.x);
  return clamp(0.5 + 0.72 * mix(nx0, nx1, u.y), 0.0, 1.0);
}

float fbm2(vec2 p) {
  float value = 0.0;
  float amplitude = 0.58;
  float normalization = 0.0;
  mat2 turn = mat2(0.80, -0.60, 0.60, 0.80);
  for (int i = 0; i < 2; i++) {
    value += amplitude * gradientNoise(p);
    normalization += amplitude;
    p = turn * p * 2.01 + vec2(13.7, 7.9);
    amplitude *= 0.5;
  }
  return value / max(normalization, 0.0001);
}

float fbm3(vec2 p) {
  float value = 0.0;
  float amplitude = 0.54;
  float normalization = 0.0;
  mat2 turn = mat2(0.80, -0.60, 0.60, 0.80);
  for (int i = 0; i < 3; i++) {
    value += amplitude * gradientNoise(p);
    normalization += amplitude;
    p = turn * p * 2.01 + vec2(13.7, 7.9);
    amplitude *= 0.5;
  }
  return value / max(normalization, 0.0001);
}


float sampleTrailAlpha(vec2 uv) {
  return texture2D(uTrailTexture, clamp(uv, vec2(0.0), vec2(1.0))).a;
}

float sampleFilteredTrailMask(vec2 uv, vec2 texel) {
  vec2 tx = max(texel, vec2(0.00001));
  vec2 nearTx = tx * 0.55;
  vec2 farTx = tx * 1.35;
  float center = sampleTrailAlpha(uv);

  float nearAxial = (
    sampleTrailAlpha(uv + vec2(nearTx.x, 0.0)) +
    sampleTrailAlpha(uv - vec2(nearTx.x, 0.0)) +
    sampleTrailAlpha(uv + vec2(0.0, nearTx.y)) +
    sampleTrailAlpha(uv - vec2(0.0, nearTx.y))
  ) * 0.25;
  float nearDiagonal = (
    sampleTrailAlpha(uv + nearTx) +
    sampleTrailAlpha(uv - nearTx) +
    sampleTrailAlpha(uv + vec2(nearTx.x, -nearTx.y)) +
    sampleTrailAlpha(uv + vec2(-nearTx.x, nearTx.y))
  ) * 0.25;
  float farAxial = (
    sampleTrailAlpha(uv + vec2(farTx.x, 0.0)) +
    sampleTrailAlpha(uv - vec2(farTx.x, 0.0)) +
    sampleTrailAlpha(uv + vec2(0.0, farTx.y)) +
    sampleTrailAlpha(uv - vec2(0.0, farTx.y))
  ) * 0.25;
  float farDiagonal = (
    sampleTrailAlpha(uv + farTx) +
    sampleTrailAlpha(uv - farTx) +
    sampleTrailAlpha(uv + vec2(farTx.x, -farTx.y)) +
    sampleTrailAlpha(uv + vec2(-farTx.x, farTx.y))
  ) * 0.25;

  float blur = center * 0.34 + nearAxial * 0.24 + nearDiagonal * 0.12 + farAxial * 0.20 + farDiagonal * 0.10;
  float feather = center * 0.18 + nearAxial * 0.24 + nearDiagonal * 0.16 + farAxial * 0.22 + farDiagonal * 0.20;
  float mask = max(center * 0.70, max(blur, feather * 1.02));
  mask = smoothstep(0.010, 0.90, mask);
  return mask * mask * (3.0 - 2.0 * mask);
}

vec4 chooseTrailAge(vec4 best, vec4 candidate) {
  if (candidate.a > best.a) return candidate;
  return best;
}

vec4 sampleTrailAge(vec2 uv, vec2 texel) {
  vec2 tx = max(texel, vec2(0.00001));
  vec4 best = texture2D(uTrailAgeTexture, clamp(uv, vec2(0.0), vec2(1.0)));
  best = chooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv + vec2(tx.x, 0.0), vec2(0.0), vec2(1.0))));
  best = chooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv - vec2(tx.x, 0.0), vec2(0.0), vec2(1.0))));
  best = chooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv + vec2(0.0, tx.y), vec2(0.0), vec2(1.0))));
  best = chooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv - vec2(0.0, tx.y), vec2(0.0), vec2(1.0))));
  best = chooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv + tx, vec2(0.0), vec2(1.0))));
  best = chooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv - tx, vec2(0.0), vec2(1.0))));
  best = chooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv + vec2(tx.x, -tx.y), vec2(0.0), vec2(1.0))));
  best = chooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv + vec2(-tx.x, tx.y), vec2(0.0), vec2(1.0))));
  vec2 wide = tx * 1.85;
  best = chooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv + vec2(wide.x, 0.0), vec2(0.0), vec2(1.0))));
  best = chooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv - vec2(wide.x, 0.0), vec2(0.0), vec2(1.0))));
  best = chooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv + vec2(0.0, wide.y), vec2(0.0), vec2(1.0))));
  best = chooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv - vec2(0.0, wide.y), vec2(0.0), vec2(1.0))));
  return best;
}

float sampleTrailAgeCoverage(vec2 uv, vec2 texel) {
  vec2 tx = max(texel, vec2(0.00001));
  float center = texture2D(uTrailAgeTexture, clamp(uv, vec2(0.0), vec2(1.0))).a;
  float axial = 0.0;
  axial += texture2D(uTrailAgeTexture, clamp(uv + vec2(tx.x, 0.0), vec2(0.0), vec2(1.0))).a;
  axial += texture2D(uTrailAgeTexture, clamp(uv - vec2(tx.x, 0.0), vec2(0.0), vec2(1.0))).a;
  axial += texture2D(uTrailAgeTexture, clamp(uv + vec2(0.0, tx.y), vec2(0.0), vec2(1.0))).a;
  axial += texture2D(uTrailAgeTexture, clamp(uv - vec2(0.0, tx.y), vec2(0.0), vec2(1.0))).a;
  axial *= 0.25;

  float diagonal = 0.0;
  diagonal += texture2D(uTrailAgeTexture, clamp(uv + tx, vec2(0.0), vec2(1.0))).a;
  diagonal += texture2D(uTrailAgeTexture, clamp(uv - tx, vec2(0.0), vec2(1.0))).a;
  diagonal += texture2D(uTrailAgeTexture, clamp(uv + vec2(tx.x, -tx.y), vec2(0.0), vec2(1.0))).a;
  diagonal += texture2D(uTrailAgeTexture, clamp(uv + vec2(-tx.x, tx.y), vec2(0.0), vec2(1.0))).a;
  diagonal *= 0.25;

  float coverage = center * 0.50 + axial * 0.34 + diagonal * 0.16;
  return smoothstep(0.025, 0.72, coverage);
}

float snowstormSweepSheet(vec2 p) {
  float opacity = clamp(uSnowstormSweepOpacity, 0.0, 1.0);
  float strength = clamp(uSnowstormSweepStrength, 0.0, 1.0);
  if (opacity <= 0.0001 || strength <= 0.0001) return 0.0;

  vec2 wind = normalize(uWind);
  vec2 crossWind = vec2(-wind.y, wind.x);
  float normalizedScale = clamp(uSnowstormSweepScale, 0.0, 1.0);
  float sheetScale = mix(0.72, 2.35, normalizedScale);
  vec2 oriented = vec2(dot(p, crossWind), dot(p, wind)) / max(0.20, sheetScale * 2.35);
  float time = uTime * mix(0.35, 10.0, clamp(uSnowstormSweepSpeed, 0.0, 1.0));

  float fogGust = gradientNoise(oriented * vec2(0.040, 0.120) + vec2(time * 0.030, -time * 0.018));
  float fogSheet = smoothstep(0.36, 0.96, 1.0 - abs(fogGust * 2.0 - 1.0));
  float sheetDetail = fbm2(oriented * vec2(0.075, 0.185) + vec2(time * 0.050 + uSeed * 0.013, -time * 0.028));
  float fineStreak = gradientNoise(oriented * vec2(0.26, 0.92) + vec2(-time * 0.040, time * 0.024 + uSeed * 0.031));
  float detailBoost = mix(0.70, 1.18, sheetDetail) + smoothstep(0.68, 0.985, 1.0 - abs(fineStreak * 2.0 - 1.0)) * 0.34;
  return clamp(fogSheet * detailBoost * mix(0.36, 1.18, strength), 0.0, 1.0);
}

void main() {
  float progress = clamp(uProgress, 0.0, 1.0);
  if (progress <= 0.0001 || uOpacity <= 0.0001 || uRuntimeAlpha <= 0.0001) {
    gl_FragColor = vec4(0.0);
    return;
  }

  vec2 world = (uCssToWorld * vec3(vCssCoord, 1.0)).xy;
  float grid = max(1.0, uGridSize);
  vec2 p = world / grid;

  float driftScale = max(0.05, uDriftScale);
  vec2 largeP = p / driftScale;

  float warpA = fbm2(largeP * 0.88 + vec2(uSeed * 0.071, -uSeed * 0.049));
  float warpB = fbm2(largeP * 0.73 + vec2(-uSeed * 0.057, uSeed * 0.083));
  vec2 warpedP = p + (vec2(warpA, warpB) - 0.5) * driftScale * 0.12;

  float broad = gradientNoise(warpedP * 0.18 + vec2(uSeed * 0.031, -uSeed * 0.047));
  float medium = fbm2(warpedP * 0.30 + vec2(-uSeed * 0.081, uSeed * 0.059));

  vec2 wind = normalize(uWind);
  vec2 crossWind = vec2(-wind.y, wind.x);
  vec2 oriented = vec2(dot(p, wind), dot(p, crossWind));
  oriented += vec2(warpA - 0.5, warpB - 0.5) * driftScale * vec2(0.42, 0.22);
  vec2 driftP = vec2(oriented.x / (driftScale * 2.10), oriented.y / (driftScale * 0.72));
  vec2 driftOffset = vec2(uSeed * 0.109, -uSeed * 0.091);
  float driftNoise = fbm2(driftP + driftOffset);
  float ridge = 1.0 - abs(2.0 * driftNoise - 1.0);
  ridge = smoothstep(0.74, 0.97, ridge);

  float mound = 0.72 * broad + 0.28 * medium;
  float height = clamp(
    0.30 + 0.52 * mound + uDriftStrength * (0.30 * (ridge - 0.38) + 0.08 * (driftNoise - 0.5)),
    0.16,
    1.0
  );

  float deposition = clamp(
    0.88 * broad + 0.12 * medium +
      uDriftStrength * (0.05 * (driftNoise - 0.5) + 0.025 * (ridge - 0.55)),
    0.0,
    1.0
  );
  float depositionRank = smoothstep(0.18, 0.94, deposition);
  depositionRank = pow(depositionRank, 1.55);
  float arrivalField = 1.0 - depositionRank;
  float variationSpan = mix(0.66, 1.0, clamp(uFillVariation, 0.0, 1.0));
  arrivalField = clamp(0.5 + (arrivalField - 0.5) * variationSpan, 0.0, 1.0);

  float growthWindow = mix(0.18, 0.085, clamp(uFillVariation, 0.0, 1.0));
  float arrival = mix(0.0, 1.0 - growthWindow, arrivalField);
  float localAge = clamp((progress - arrival) / max(growthWindow, 0.0001), 0.0, 1.0);
  float settled = localAge * localAge * (3.0 - 2.0 * localAge);

  float detail = gradientNoise(p * 1.35 + vec2(uSeed * 0.137, uSeed * 0.113));

  float slopeLight = clamp((driftNoise - (0.55 * medium + 0.45 * broad)) * 0.30, -0.06, 0.06);
  float light = clamp(
    0.90 + 0.14 * height + uDriftStrength * slopeLight + 0.018 * (detail - 0.5),
    0.82,
    1.05
  );

  float trailMask = 0.0;
  if (uTrailsEnabled > 0.5) {
    vec2 trailSize = max(uTrailBounds.zw, vec2(1.0));
    vec2 trailUv = (world - uTrailBounds.xy) / trailSize;
    float inside =
      step(0.0, trailUv.x) * step(trailUv.x, 1.0) *
      step(0.0, trailUv.y) * step(trailUv.y, 1.0);
    vec2 sampledTrailUv = clamp(trailUv, vec2(0.0), vec2(1.0));
    vec2 trailTexel = max(uTrailTexel, vec2(0.00001));
    trailMask = sampleFilteredTrailMask(sampledTrailUv, trailTexel) * inside;

    if (uTrailRefillEnabled > 0.5) {
      vec4 ageSample = sampleTrailAge(sampledTrailUv, trailTexel);
      vec3 stampBytes = floor(ageSample.rgb * 255.0 + 0.5);
      float stampUnits = dot(stampBytes, vec3(65536.0, 256.0, 1.0));
      float ageUnits = mod(uTrailClock - stampUnits + 16777216.0, 16777216.0);
      float ageSeconds = ageUnits * 0.05;
      float remaining = clamp(1.0 - ageSeconds / max(0.25, uTrailRefillDuration), 0.0, 1.0);
      remaining = remaining * remaining * (3.0 - 2.0 * remaining);
      trailMask *= remaining * sampleTrailAgeCoverage(sampledTrailUv, trailTexel);
    }
  }
  float trailCut = clamp(trailMask * uTrailStrength, 0.0, 1.0);
  float trackedHeight = mix(height, max(0.12, height * 0.30), trailCut);

  float depthOpacity = mix(0.86, 1.03, trackedHeight);
  float alpha = clamp(settled * depthOpacity * uOpacity * uRuntimeAlpha, 0.0, 1.0);
  alpha *= 1.0 - 0.96 * trailCut;

  vec3 coolShadow = uColor * vec3(0.93, 0.97, 1.015);
  vec3 brightSnow = min(vec3(1.0), uColor * 1.035);
  float shadeMix = clamp(0.32 + 0.56 * trackedHeight + uDriftStrength * slopeLight * 3.0, 0.0, 1.0);
  vec3 color = mix(coolShadow, brightSnow, shadeMix) * light;
  float sweep = snowstormSweepSheet(p);
  float sweepProgress = mix(0.58, 1.0, progress);
  float opacityLimit = clamp(uOpacity * uRuntimeAlpha, 0.0, 1.0);
  float sweepAlpha = clamp(sweep * uSnowstormSweepOpacity * opacityLimit * sweepProgress, 0.0, 0.58 * opacityLimit);
  vec3 sweepColor = min(vec3(1.0), uColor * vec3(0.91, 0.98, 1.08));
  float combinedAlpha = clamp(alpha + sweepAlpha * (1.0 - alpha * 0.32), 0.0, opacityLimit);
  vec3 combinedColor = color * alpha + sweepColor * sweepAlpha * (1.0 - alpha * 0.18);
  gl_FragColor = vec4(combinedColor, combinedAlpha);
}

`;

/**
 * Procedural settled-snow surface rendered behind a particle emitter.
 */
export class SnowBackgroundSurface extends ParticleAccumulationBackgroundSurface {
  /** @override */
  static get surfaceType() {
    return "snow";
  }

  /** @override */
  static get fragmentShader() {
    return SNOW_BACKGROUND_FRAGMENT_SHADER;
  }

  /** @override */
  static get defaultColorHex() {
    return "#edf5ff";
  }

  /** @override */
  static get defaultColorRgb() {
    return [0.93, 0.96, 1.0];
  }

  /** @override */
  static get trailRefillDurationMultiplier() {
    return 1;
  }
}

/**
 * Snowstorm settled-snow background with a capped sweep layer.
 */
export class SnowstormBackgroundSurface extends ParticleAccumulationBackgroundSurface {
  /** @override */
  static get surfaceType() {
    return "snowstorm";
  }

  /** @override */
  static get fragmentShader() {
    return SNOWSTORM_BACKGROUND_FRAGMENT_SHADER;
  }

  /** @override */
  static get defaultColorHex() {
    return "#edf5ff";
  }

  /** @override */
  static get defaultColorRgb() {
    return [0.93, 0.96, 1.0];
  }

  /** @override */
  static get maxOpacity() {
    return 0.7;
  }

  /** @override */
  static get trailRefillDurationMultiplier() {
    return 1;
  }

  /** @override */
  _updateSurfaceUniforms({ tick, uniforms } = {}) {
    if (!uniforms) return;
    const enabledRaw = unwrapParticleBackgroundOption(this.options?.backgroundSweepEnabled);
    const enabled = enabledRaw === undefined ? true : !!enabledRaw;
    uniforms.uTime = (Number(tick) || 0) / 1000;
    uniforms.uSnowstormSweepOpacity = enabled
      ? clamp(unwrapParticleBackgroundOption(this.options?.backgroundSweepOpacity), 0, 1, 0.48)
      : 0;
    uniforms.uSnowstormSweepScale = clamp(
      unwrapParticleBackgroundOption(this.options?.backgroundSweepScale),
      0,
      1,
      0.55,
    );
    uniforms.uSnowstormSweepSpeed = clamp(
      unwrapParticleBackgroundOption(this.options?.backgroundSweepSpeed),
      0,
      1,
      0.8,
    );
    uniforms.uSnowstormSweepStrength = enabled
      ? clamp(unwrapParticleBackgroundOption(this.options?.backgroundSweepStrength), 0, 1, 0.55)
      : 0;
  }
}
