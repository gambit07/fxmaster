import {
  PARTICLE_BACKGROUND_ANIMATION_STATE_PROFILE,
  PARTICLE_BACKGROUND_STATE_PROFILE,
  normalizeParticleBackgroundTimestamp,
  particleBackgroundMigrationSpeed,
  particleBackgroundMonotonicNow,
  particleBackgroundNow,
  unwrapParticleBackgroundOption,
} from "./background-state.js";
import { ParticleAccumulationBackgroundSurface, clamp } from "./background-surface-base.js";

const SAND_FRAGMENT_SHADER = `
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
uniform float uRippleStrength;
uniform float uMigrationDistance;
uniform vec2 uWind;
uniform mat3 uCssToWorld;
uniform vec3 uColor;
uniform sampler2D uTrailTexture;
uniform sampler2D uTrailAgeTexture;
uniform vec2 uTrailTexel;
uniform float uTrailsEnabled;
uniform float uTrailStrength;
uniform float uTrailRefillEnabled;
uniform float uTrailRefillDuration;
uniform float uTrailClock;
uniform vec4 uTrailBounds;

float sandHash21(vec2 p) {
  p += uSeed * vec2(17.41, -9.13);
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 sandHash22(vec2 p) {
  return -1.0 + 2.0 * vec2(sandHash21(p), sandHash21(p + vec2(19.19, -31.37)));
}

float sandGradientNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

  float n00 = dot(sandHash22(i), f);
  float n10 = dot(sandHash22(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
  float n01 = dot(sandHash22(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
  float n11 = dot(sandHash22(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));

  float nx0 = mix(n00, n10, u.x);
  float nx1 = mix(n01, n11, u.x);
  return clamp(0.5 + 0.72 * mix(nx0, nx1, u.y), 0.0, 1.0);
}

float sandFbm2(vec2 p) {
  float value = 0.0;
  float amplitude = 0.58;
  float normalization = 0.0;
  mat2 turn = mat2(0.80, -0.60, 0.60, 0.80);
  for (int i = 0; i < 2; i++) {
    value += amplitude * sandGradientNoise(p);
    normalization += amplitude;
    p = turn * p * 2.01 + vec2(13.7, 7.9);
    amplitude *= 0.5;
  }
  return value / max(normalization, 0.0001);
}

float sandFbm3(vec2 p) {
  float value = 0.0;
  float amplitude = 0.54;
  float normalization = 0.0;
  mat2 turn = mat2(0.80, -0.60, 0.60, 0.80);
  for (int i = 0; i < 3; i++) {
    value += amplitude * sandGradientNoise(p);
    normalization += amplitude;
    p = turn * p * 2.01 + vec2(11.3, 8.7);
    amplitude *= 0.5;
  }
  return value / max(normalization, 0.0001);
}

float sandTrailAlpha(vec2 uv) {
  return texture2D(uTrailTexture, clamp(uv, vec2(0.0), vec2(1.0))).a;
}

float sandFilteredTrailMask(vec2 uv, vec2 texel) {
  vec2 tx = max(texel, vec2(0.00001));
  vec2 nearTx = tx * 0.55;
  vec2 farTx = tx * 1.35;
  float center = sandTrailAlpha(uv);

  float nearAxial = (
    sandTrailAlpha(uv + vec2(nearTx.x, 0.0)) +
    sandTrailAlpha(uv - vec2(nearTx.x, 0.0)) +
    sandTrailAlpha(uv + vec2(0.0, nearTx.y)) +
    sandTrailAlpha(uv - vec2(0.0, nearTx.y))
  ) * 0.25;
  float nearDiagonal = (
    sandTrailAlpha(uv + nearTx) +
    sandTrailAlpha(uv - nearTx) +
    sandTrailAlpha(uv + vec2(nearTx.x, -nearTx.y)) +
    sandTrailAlpha(uv + vec2(-nearTx.x, nearTx.y))
  ) * 0.25;
  float farAxial = (
    sandTrailAlpha(uv + vec2(farTx.x, 0.0)) +
    sandTrailAlpha(uv - vec2(farTx.x, 0.0)) +
    sandTrailAlpha(uv + vec2(0.0, farTx.y)) +
    sandTrailAlpha(uv - vec2(0.0, farTx.y))
  ) * 0.25;
  float farDiagonal = (
    sandTrailAlpha(uv + farTx) +
    sandTrailAlpha(uv - farTx) +
    sandTrailAlpha(uv + vec2(farTx.x, -farTx.y)) +
    sandTrailAlpha(uv + vec2(-farTx.x, farTx.y))
  ) * 0.25;

  float blur = center * 0.34 + nearAxial * 0.24 + nearDiagonal * 0.12 + farAxial * 0.20 + farDiagonal * 0.10;
  float feather = center * 0.18 + nearAxial * 0.24 + nearDiagonal * 0.16 + farAxial * 0.22 + farDiagonal * 0.20;
  float mask = max(center * 0.70, max(blur, feather * 1.02));
  mask = smoothstep(0.010, 0.90, mask);
  return mask * mask * (3.0 - 2.0 * mask);
}

vec4 sandChooseTrailAge(vec4 best, vec4 candidate) {
  if (candidate.a > best.a) return candidate;
  return best;
}

vec4 sandTrailAge(vec2 uv, vec2 texel) {
  vec2 tx = max(texel, vec2(0.00001));
  vec4 best = texture2D(uTrailAgeTexture, clamp(uv, vec2(0.0), vec2(1.0)));
  best = sandChooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv + vec2(tx.x, 0.0), vec2(0.0), vec2(1.0))));
  best = sandChooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv - vec2(tx.x, 0.0), vec2(0.0), vec2(1.0))));
  best = sandChooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv + vec2(0.0, tx.y), vec2(0.0), vec2(1.0))));
  best = sandChooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv - vec2(0.0, tx.y), vec2(0.0), vec2(1.0))));
  best = sandChooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv + tx, vec2(0.0), vec2(1.0))));
  best = sandChooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv - tx, vec2(0.0), vec2(1.0))));
  best = sandChooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv + vec2(tx.x, -tx.y), vec2(0.0), vec2(1.0))));
  best = sandChooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv + vec2(-tx.x, tx.y), vec2(0.0), vec2(1.0))));
  vec2 wide = tx * 1.85;
  best = sandChooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv + vec2(wide.x, 0.0), vec2(0.0), vec2(1.0))));
  best = sandChooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv - vec2(wide.x, 0.0), vec2(0.0), vec2(1.0))));
  best = sandChooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv + vec2(0.0, wide.y), vec2(0.0), vec2(1.0))));
  best = sandChooseTrailAge(best, texture2D(uTrailAgeTexture, clamp(uv - vec2(0.0, wide.y), vec2(0.0), vec2(1.0))));
  return best;
}

float sandTrailAgeCoverage(vec2 uv, vec2 texel) {
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

  float duneScale = max(0.05, uDriftScale);
  vec2 wind = uWind / max(length(uWind), 0.0001);
  vec2 crossWind = vec2(-wind.y, wind.x);

  float migration = max(0.0, uMigrationDistance);
  float meander =
    0.34 * sin(migration * 0.47 + uSeed * 5.31) +
    0.18 * sin(migration * 0.17 - uSeed * 3.71);
  vec2 broadShift = wind * (migration * 0.44) + crossWind * (meander * 0.45);
  vec2 ridgeShift = wind * (migration * 0.88) + crossWind * meander;
  vec2 rippleShift = wind * (migration * 1.55) + crossWind * (meander * 1.20);
  vec2 broadSourceP = p - broadShift;

  vec2 broadP = broadSourceP / duneScale;
  float warpA = sandFbm2(broadP * 0.82 + vec2(uSeed * 0.053, -uSeed * 0.071));
  float warpB = sandFbm2(broadP * 0.69 + vec2(-uSeed * 0.063, uSeed * 0.047));
  vec2 warpedP = broadSourceP + (vec2(warpA, warpB) - 0.5) * duneScale * 0.14;

  float broad = sandFbm3(warpedP / (duneScale * 0.78) + vec2(uSeed * 0.029, -uSeed * 0.041));
  float medium = sandFbm2(warpedP / (duneScale * 0.38) + vec2(-uSeed * 0.077, uSeed * 0.061));

  vec2 ridgeP = warpedP - (ridgeShift - broadShift);
  vec2 oriented = vec2(dot(ridgeP, wind), dot(ridgeP, crossWind));
  float duneNoise = sandFbm2(
    vec2(oriented.x / (duneScale * 1.85), oriented.y / (duneScale * 0.72)) +
      vec2(uSeed * 0.097, -uSeed * 0.083)
  );

  float ridgePhase = oriented.y / max(0.45, duneScale * 0.72);
  ridgePhase += oriented.x / max(2.0, duneScale * 4.6);
  ridgePhase += (duneNoise - 0.5) * 2.6;
  float ridgeWave = 0.5 + 0.5 * sin(ridgePhase * 6.2831853);
  float ridge = smoothstep(0.56, 0.94, ridgeWave);
  ridge *= smoothstep(0.28, 0.76, 0.68 * broad + 0.32 * duneNoise);

  float mound = 0.70 * broad + 0.30 * medium;
  float height = clamp(
    0.22 + 0.50 * mound + uDriftStrength * (0.10 * ridge + 0.18 * (duneNoise - 0.42)),
    0.10,
    1.0
  );

  float deposition = clamp(
    0.82 * broad + 0.18 * medium + uDriftStrength * 0.04 * (duneNoise - 0.5),
    0.0,
    1.0
  );
  float depositionRank = smoothstep(0.22, 0.75, deposition);
  depositionRank = pow(depositionRank, 1.72);
  float arrivalField = pow(1.0 - depositionRank, 1.40);
  float variationSpan = mix(0.64, 1.0, clamp(uFillVariation, 0.0, 1.0));
  arrivalField = clamp(0.5 + (arrivalField - 0.5) * variationSpan, 0.0, 1.0);

  float growthWindow = mix(0.19, 0.075, clamp(uFillVariation, 0.0, 1.0));
  float arrival = mix(0.0, 1.0 - growthWindow, arrivalField);
  float localAge = clamp((progress - arrival) / max(growthWindow, 0.0001), 0.0, 1.0);
  float settled = localAge * localAge * (3.0 - 2.0 * localAge);

  vec2 rippleP = p - rippleShift;
  float fineWarp = sandGradientNoise(rippleP * 0.42 + vec2(uSeed * 0.131, uSeed * 0.109));
  float gritStrength = clamp(uRippleStrength, 0.0, 1.0);
  vec2 gritWarp = vec2(
    sandGradientNoise(p * 1.7 + vec2(uSeed * 0.173, -uSeed * 0.119)),
    sandGradientNoise(p * 1.3 + vec2(-uSeed * 0.097, uSeed * 0.181))
  ) - 0.5;
  float fineGrain = sandGradientNoise((p + gritWarp * 0.035 + wind * migration * 0.012) * mix(22.0, 58.0, gritStrength));
  float coarseGrain = sandGradientNoise((p - gritWarp * 0.025 - wind * migration * 0.016) * mix(9.0, 24.0, gritStrength));
  float pixelGrit = ((fineGrain - 0.5) * 0.7 + (coarseGrain - 0.5) * 0.35) * gritStrength;
  float darkSpecks = smoothstep(0.70, 0.96, fineGrain) * (0.55 + 0.45 * smoothstep(0.48, 0.90, fineWarp)) * gritStrength;
  float lightSpecks = smoothstep(0.76, 0.98, coarseGrain) * (0.50 + 0.50 * smoothstep(0.35, 0.88, 1.0 - fineWarp)) * gritStrength;
  float grain = mix(fineGrain, coarseGrain, 0.35);

  float trailMask = 0.0;
  if (uTrailsEnabled > 0.5) {
    vec2 trailSize = max(uTrailBounds.zw, vec2(1.0));
    vec2 trailUv = (world - uTrailBounds.xy) / trailSize;
    float inside =
      step(0.0, trailUv.x) * step(trailUv.x, 1.0) *
      step(0.0, trailUv.y) * step(trailUv.y, 1.0);
    vec2 sampledTrailUv = clamp(trailUv, vec2(0.0), vec2(1.0));
    vec2 trailTexel = max(uTrailTexel, vec2(0.00001));
    trailMask = sandFilteredTrailMask(sampledTrailUv, trailTexel) * inside;

    if (uTrailRefillEnabled > 0.5) {
      vec4 ageSample = sandTrailAge(sampledTrailUv, trailTexel);
      vec3 stampBytes = floor(ageSample.rgb * 255.0 + 0.5);
      float stampUnits = dot(stampBytes, vec3(65536.0, 256.0, 1.0));
      float ageUnits = mod(uTrailClock - stampUnits + 16777216.0, 16777216.0);
      float ageSeconds = ageUnits * 0.05;
      float remaining = clamp(1.0 - ageSeconds / max(0.25, uTrailRefillDuration), 0.0, 1.0);
      remaining = remaining * remaining * (3.0 - 2.0 * remaining);
      trailMask *= remaining * sandTrailAgeCoverage(sampledTrailUv, trailTexel);
    }
  }

  float trailCut = clamp(trailMask * uTrailStrength, 0.0, 1.0);
  float trackedHeight = mix(height, max(0.08, height * 0.30), trailCut);
  float growingHeight = mix(0.10, trackedHeight, settled);

  float depthOpacity = mix(0.74, 1.02, growingHeight);
  float alpha = clamp(settled * depthOpacity * uOpacity * uRuntimeAlpha, 0.0, 1.0);
  alpha *= 1.0 - 0.58 * trailCut;

  vec3 shadowSand = uColor * vec3(0.72, 0.65, 0.52);
  vec3 sunSand = min(vec3(1.0), uColor * vec3(1.15, 1.10, 1.02));
  float gritLight = pixelGrit * 0.105 + (lightSpecks - darkSpecks) * 0.060 + (grain - 0.5) * 0.045 * gritStrength;
  float shadeMix = clamp(
    0.30 + 0.54 * growingHeight + 0.028 * ridge * uDriftStrength + gritLight,
    0.0,
    1.0
  );
  vec3 color = mix(shadowSand, sunSand, shadeMix);
  vec3 gritTint = mix(uColor * vec3(0.62, 0.56, 0.46), min(vec3(1.0), uColor * vec3(1.23, 1.17, 1.05)), step(pixelGrit, 0.0));
  float speckleMask = clamp((darkSpecks + lightSpecks) * 0.24, 0.0, 0.25);
  color = mix(color, gritTint, speckleMask);
  color *= 1.0 - 0.18 * trailCut;
  gl_FragColor = vec4(color * alpha, alpha);
}
`;

/**
 * Procedural settled-sand surface used by Sandstorm and future granular effects.
 * It reuses the shared accumulation surface timing, world-space placement,
 * movement journal, and trail-mask lifecycle while supplying a sand-specific
 * shader and defaults.
 */
export class SandBackgroundSurface extends ParticleAccumulationBackgroundSurface {
  /** @override */
  static get surfaceType() {
    return "sand";
  }

  /** @override */
  static get fragmentShader() {
    return SAND_FRAGMENT_SHADER;
  }

  /** @override */
  static get defaultColorHex() {
    return "#d3aa68";
  }

  /** @override */
  static get defaultColorRgb() {
    return [0.827, 0.667, 0.408];
  }

  /** @override */
  configure(config = {}) {
    super.configure(config);
    if (this._destroyed) return;

    this.rippleStrength = clamp(unwrapParticleBackgroundOption(this.options?.backgroundSandRippleStrength), 0, 1, 0.45);
    this.migrationEnabled = !!unwrapParticleBackgroundOption(this.options?.backgroundMigrationEnabled);
    this.migrationSpeed = particleBackgroundMigrationSpeed(this.options);

    if (this.filter?.uniforms) this.filter.uniforms.uRippleStrength = this.rippleStrength;

    const now = particleBackgroundNow();
    const tick = particleBackgroundMonotonicNow();
    this.update({ now, tick });
  }

  /**
   * Resolve the synchronized epoch at which dune migration was enabled.
   * Legacy definitions without animation state receive a local fallback until
   * they are next saved, at which point reconciliation persists the epoch.
   *
   * @param {number} now
   * @returns {number}
   */
  _resolveMigrationStartedAt(now) {
    const animation = this.state?.backgroundAnimation ?? {};
    const storedStartedAt =
      Number(animation.profile) === PARTICLE_BACKGROUND_ANIMATION_STATE_PROFILE
        ? normalizeParticleBackgroundTimestamp(animation.startedAt, now)
        : null;

    if (storedStartedAt !== null) {
      this._localMigrationStartedAtEpoch = null;
      return storedStartedAt;
    }

    this._localMigrationStartedAtEpoch ??= now;
    return this._localMigrationStartedAtEpoch;
  }

  /**
   * Migration begins only once accumulation has actually completed. In full
   * coverage mode, the animation activation epoch is the start point.
   *
   * @param {number} now
   * @returns {number}
   */
  _resolveMigrationEpoch(now) {
    const animationStartedAt = this._resolveMigrationStartedAt(now);
    if (this.mode !== "accumulate") return animationStartedAt;

    const backgroundStartedAt =
      Number(this.state?.background?.profile) === PARTICLE_BACKGROUND_STATE_PROFILE
        ? normalizeParticleBackgroundTimestamp(this.state?.background?.startedAt, now)
        : null;
    const coverageCompletedAt = backgroundStartedAt === null ? now : backgroundStartedAt + this.durationSeconds * 1000;
    return Math.max(animationStartedAt, coverageCompletedAt);
  }

  /**
   * Seed post-coverage motion from a persisted epoch, then advance with the
   * monotonic runtime clock so wall-clock corrections cannot visibly jerk the
   * dunes during a session. The resulting value is measured in grid spaces.
   *
   * @param {number} now
   * @param {number} tick
   * @param {number} progress
   */
  _syncMigrationClock(now, tick, progress) {
    const nowMs = normalizeParticleBackgroundTimestamp(now, Date.now()) ?? particleBackgroundNow();
    const monotonicTick = Number.isFinite(Number(tick)) ? Number(tick) : particleBackgroundMonotonicNow();

    if (!this.migrationEnabled || progress < 1 - 1e-6) {
      this._migrationClockSignature = "idle";
      this._migrationBaseDistance = 0;
      this._migrationBaseTick = monotonicTick;
      return;
    }

    const startedAt = this._resolveMigrationEpoch(nowMs);
    const animation = this.state?.backgroundAnimation ?? {};
    const persistedBaseDistance = Math.max(0, Number(animation.baseDistance) || 0);
    const signature = [
      startedAt,
      persistedBaseDistance,
      this.migrationSpeed,
      animation.profile ?? 0,
      animation.revision ?? 0,
    ].join(":");
    if (signature === this._migrationClockSignature) return;

    this._migrationClockSignature = signature;
    this._migrationBaseDistance =
      persistedBaseDistance + Math.max(0, (nowMs - startedAt) / 60000) * this.migrationSpeed;
    this._migrationBaseTick = monotonicTick;
  }

  /**
   * Return cumulative downwind migration in grid spaces.
   *
   * @param {number} now
   * @param {number} tick
   * @param {number} progress
   * @returns {number}
   */
  migrationDistanceAt(now, tick, progress) {
    this._syncMigrationClock(now, tick, progress);
    if (!this.migrationEnabled || progress < 1 - 1e-6) return 0;
    const elapsedMinutes = Math.max(0, Number(tick) - Number(this._migrationBaseTick ?? tick)) / 60000;
    return Math.max(0, Number(this._migrationBaseDistance ?? 0) + elapsedMinutes * this.migrationSpeed);
  }

  /** @override */
  _updateSurfaceUniforms({ now, tick, progress, uniforms } = {}) {
    if (!uniforms) return;
    uniforms.uMigrationDistance = this.migrationDistanceAt(now, tick, progress);
  }
}
