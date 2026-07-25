/**
 * Shared state helpers for persistent particle backgrounds.
 */

const MIN_REASONABLE_EPOCH_MS = Date.UTC(2000, 0, 1);
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_SERVER_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * State profile used by the epoch-millisecond plus monotonic-runtime clock.
 * Increment this when a future timing migration needs to restart accumulation.
 */
export const PARTICLE_BACKGROUND_STATE_PROFILE = 3;

/**
 * Profile for the persisted token-movement epoch. Movement history is stored
 * once per Scene, while this per-effect epoch decides which history belongs to
 * a particular background activation.
 */
export const PARTICLE_BACKGROUND_MOVEMENT_STATE_PROFILE = 1;

/**
 * Profile for persistent post-coverage background animation clocks. The clock
 * is stored independently from accumulation so full-coverage surfaces can
 * animate consistently across clients and canvas reloads.
 */
export const PARTICLE_BACKGROUND_ANIMATION_STATE_PROFILE = 1;

/**
 * Unwrap FXMaster's particle option wrapper while preserving structured values such as colors.
 *
 * @param {unknown} value
 * @returns {any}
 */
export function unwrapParticleBackgroundOption(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Object.prototype.hasOwnProperty.call(value, "value")
  ) {
    return value;
  }

  if (typeof value.apply === "boolean") return { value: value.value, apply: value.apply };
  return unwrapParticleBackgroundOption(value.value);
}

/**
 * Normalize an epoch-millisecond timestamp.
 *
 * Deliberately do not infer Unix seconds from a small number. Foundry and
 * integrations can expose relative millisecond clocks whose magnitude may
 * resemble Unix seconds; multiplying one of those values by 1000 causes a
 * background configured in seconds to complete roughly 1000 times too fast.
 *
 * @param {unknown} value
 * @param {number} [referenceNow=Date.now()]
 * @returns {number|null}
 */
export function normalizeParticleBackgroundTimestamp(value, referenceNow = Date.now()) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;

  const reference = Number.isFinite(Number(referenceNow)) ? Number(referenceNow) : Date.now();
  if (numeric < MIN_REASONABLE_EPOCH_MS) return null;
  if (numeric > reference + MAX_FUTURE_CLOCK_SKEW_MS) return null;
  return numeric;
}

/**
 * Return an epoch-millisecond clock.
 *
 * Foundry's synchronized server clock is used only when it is already an
 * epoch-millisecond value close to the local wall clock. Relative clocks and
 * ambiguous second-like values fall back to Date.now().
 *
 * @returns {number}
 */
export function particleBackgroundNow() {
  const localNow = Date.now();
  const serverNow = normalizeParticleBackgroundTimestamp(globalThis.game?.time?.serverTime, localNow);
  if (serverNow !== null && Math.abs(serverNow - localNow) <= MAX_SERVER_CLOCK_SKEW_MS) return serverNow;
  return localNow;
}

/**
 * Return a monotonic millisecond clock for frame-to-frame accumulation.
 *
 * @returns {number}
 */
export function particleBackgroundMonotonicNow() {
  try {
    const value = Number(globalThis.performance?.now?.());
    if (Number.isFinite(value) && value >= 0) return value;
  } catch (_err) {}
  return Date.now();
}

/**
 * @param {object|null|undefined} options
 * @returns {boolean}
 */
export function particleBackgroundEnabled(options) {
  return !!unwrapParticleBackgroundOption(options?.backgroundEnabled);
}

/**
 * @param {object|null|undefined} options
 * @returns {"full"|"accumulate"}
 */
export function particleBackgroundMode(options) {
  return String(unwrapParticleBackgroundOption(options?.backgroundMode) ?? "full") === "accumulate"
    ? "accumulate"
    : "full";
}

/**
 * Resolve the configured fill duration in seconds.
 *
 * @param {object|null|undefined} options
 * @returns {number}
 */
export function particleBackgroundDurationSeconds(options) {
  const value = Number(unwrapParticleBackgroundOption(options?.backgroundDuration));
  const safe = Number.isFinite(value) ? value : 180;
  return Math.max(1, Math.min(3600, safe));
}

/**
 * Return whether an enabled background currently reacts to token movement.
 * Procedural snow/sand surfaces use trails while scatter profiles use physical interaction.
 *
 * @param {object|null|undefined} options
 * @returns {boolean}
 */
export function particleBackgroundInteractionEnabled(options) {
  return (
    particleBackgroundEnabled(options) &&
    (!!unwrapParticleBackgroundOption(options?.backgroundTrailsEnabled) ||
      !!unwrapParticleBackgroundOption(options?.backgroundInteractionEnabled))
  );
}

/**
 * Return whether the background has an authored post-coverage animation.
 * This is intentionally separate from token interaction: an animated surface
 * needs a synchronized activation epoch even when trails are disabled.
 *
 * @param {object|null|undefined} options
 * @returns {boolean}
 */
export function particleBackgroundAnimationEnabled(options) {
  return particleBackgroundEnabled(options) && !!unwrapParticleBackgroundOption(options?.backgroundMigrationEnabled);
}

/**
 * Resolve the authored migration speed in grid spaces per minute.
 *
 * @param {object|null|undefined} options
 * @returns {number}
 */
export function particleBackgroundMigrationSpeed(options) {
  const numeric = Number(unwrapParticleBackgroundOption(options?.backgroundMigrationSpeed));
  return Math.max(0.01, Math.min(1, Number.isFinite(numeric) ? numeric : 0.06));
}

/**
 * Normalize a persisted 32-bit procedural seed.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function normalizeParticleBackgroundPatternSeed(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.trunc(numeric) >>> 0;
}

/**
 * Generate a new 32-bit procedural seed. The value is written to document
 * state, so all clients render the same randomized accumulation pattern.
 *
 * @returns {number}
 */
export function createParticleBackgroundPatternSeed() {
  try {
    const values = new Uint32Array(1);
    globalThis.crypto?.getRandomValues?.(values);
    if (values[0] !== 0) return values[0] >>> 0;
  } catch (_err) {}

  const random = Math.floor(Math.random() * 0x100000000) >>> 0;
  const time = Date.now() >>> 0;
  return (random ^ time ^ 0x9e3779b9) >>> 0;
}

/**
 * Preserve or initialize persistent background state when an effect definition is updated.
 *
 * The state lives beside the authored options so management forms can continue rebuilding their
 * parameter object without erasing the activation epoch.
 *
 * @param {object|null|undefined} previousDefinition
 * @param {object|null|undefined} nextOptions
 * @param {{now?: number}} [config]
 * @returns {object|null}
 */
export function reconcileParticleBackgroundState(
  previousDefinition,
  nextOptions,
  { now = particleBackgroundNow() } = {},
) {
  const previousOptions = previousDefinition?.options ?? {};
  const previousState =
    previousDefinition?.state && typeof previousDefinition.state === "object"
      ? foundry.utils.deepClone(previousDefinition.state)
      : {};

  const enabled = particleBackgroundEnabled(nextOptions);
  const previousEnabled = particleBackgroundEnabled(previousOptions);
  const interactionEnabled = particleBackgroundInteractionEnabled(nextOptions);
  const previousInteractionEnabled = particleBackgroundInteractionEnabled(previousOptions);
  const animationEnabled = particleBackgroundAnimationEnabled(nextOptions);
  const previousAnimationEnabled = particleBackgroundAnimationEnabled(previousOptions);
  if (!enabled) {
    delete previousState.background;
    delete previousState.backgroundMovement;
    delete previousState.backgroundAnimation;
    return Object.keys(previousState).length ? previousState : null;
  }

  const mode = particleBackgroundMode(nextOptions);
  const nowMs = normalizeParticleBackgroundTimestamp(now, Date.now()) ?? particleBackgroundNow();
  const previousMode = particleBackgroundMode(previousOptions);
  const durationSeconds = particleBackgroundDurationSeconds(nextOptions);
  const previousDurationSeconds = particleBackgroundDurationSeconds(previousOptions);
  const storedDurationSeconds = Number(previousState?.background?.durationSeconds);
  const comparisonDuration = Number.isFinite(storedDurationSeconds) ? storedDurationSeconds : previousDurationSeconds;
  const durationChanged =
    previousEnabled && previousMode === "accumulate" && Math.abs(comparisonDuration - durationSeconds) > 1e-6;

  let backgroundRestarted = !previousEnabled || previousMode !== mode;

  if (mode !== "accumulate") {
    delete previousState.background;
  } else {
    const previousProfile = Number(previousState?.background?.profile);
    const existingStartedAt = normalizeParticleBackgroundTimestamp(previousState?.background?.startedAt, nowMs);
    const shouldRestart =
      !previousEnabled ||
      previousMode !== "accumulate" ||
      durationChanged ||
      previousProfile !== PARTICLE_BACKGROUND_STATE_PROFILE ||
      existingStartedAt === null;

    const previousRevision = Number(previousState?.background?.revision);
    const existingPatternSeed = normalizeParticleBackgroundPatternSeed(previousState?.background?.patternSeed);
    previousState.background = {
      ...(previousState.background && typeof previousState.background === "object" ? previousState.background : {}),
      startedAt: shouldRestart ? nowMs : existingStartedAt,
      revision: shouldRestart ? (Number.isFinite(previousRevision) ? previousRevision + 1 : 1) : previousRevision || 1,
      patternSeed:
        shouldRestart || existingPatternSeed === null ? createParticleBackgroundPatternSeed() : existingPatternSeed,
      durationSeconds,
      clockUnit: "epoch-ms",
      profile: PARTICLE_BACKGROUND_STATE_PROFILE,
    };
    backgroundRestarted ||= shouldRestart;
  }

  if (!animationEnabled) {
    delete previousState.backgroundAnimation;
  } else {
    const previousAnimation =
      previousState.backgroundAnimation && typeof previousState.backgroundAnimation === "object"
        ? previousState.backgroundAnimation
        : {};
    const existingAnimationStartedAt = normalizeParticleBackgroundTimestamp(previousAnimation.startedAt, nowMs);
    const previousAnimationRevision = Number(previousAnimation.revision);
    const migrationSpeed = particleBackgroundMigrationSpeed(nextOptions);
    const storedAnimationSpeed = Number(previousAnimation.speed);
    const previousMigrationSpeed = Number.isFinite(storedAnimationSpeed)
      ? Math.max(0.01, Math.min(1, storedAnimationSpeed))
      : particleBackgroundMigrationSpeed(previousOptions);
    const speedChanged = Math.abs(previousMigrationSpeed - migrationSpeed) > 1e-6;
    const storedBaseDistance = Number(previousAnimation.baseDistance);
    const existingBaseDistance =
      Number.isFinite(storedBaseDistance) && storedBaseDistance >= 0 ? storedBaseDistance : 0;
    const shouldRestartAnimation =
      backgroundRestarted ||
      !previousAnimationEnabled ||
      Number(previousAnimation.profile) !== PARTICLE_BACKGROUND_ANIMATION_STATE_PROFILE ||
      existingAnimationStartedAt === null;

    let animationStartedAt = existingAnimationStartedAt;
    let animationBaseDistance = existingBaseDistance;
    let animationRevision = previousAnimationRevision || 1;

    if (shouldRestartAnimation) {
      animationStartedAt = nowMs;
      animationBaseDistance = 0;
      animationRevision = Number.isFinite(previousAnimationRevision) ? previousAnimationRevision + 1 : 1;
    } else if (speedChanged) {
      let previousMotionStartedAt = existingAnimationStartedAt;
      if (previousMode === "accumulate") {
        const backgroundStartedAt = normalizeParticleBackgroundTimestamp(previousState?.background?.startedAt, nowMs);
        if (backgroundStartedAt !== null) {
          previousMotionStartedAt = Math.max(
            previousMotionStartedAt,
            backgroundStartedAt + previousDurationSeconds * 1000,
          );
        }
      }
      animationBaseDistance += (Math.max(0, nowMs - previousMotionStartedAt) / 60000) * previousMigrationSpeed;
      animationStartedAt = nowMs;
      animationRevision = Number.isFinite(previousAnimationRevision) ? previousAnimationRevision + 1 : 1;
    }

    previousState.backgroundAnimation = {
      ...previousAnimation,
      startedAt: animationStartedAt,
      baseDistance: animationBaseDistance,
      speed: migrationSpeed,
      revision: animationRevision,
      clockUnit: "epoch-ms",
      profile: PARTICLE_BACKGROUND_ANIMATION_STATE_PROFILE,
    };
  }

  if (!interactionEnabled) {
    delete previousState.backgroundMovement;
  } else {
    const previousMovement =
      previousState.backgroundMovement && typeof previousState.backgroundMovement === "object"
        ? previousState.backgroundMovement
        : {};
    const existingMovementStartedAt = normalizeParticleBackgroundTimestamp(previousMovement.startedAt, nowMs);
    const previousMovementRevision = Number(previousMovement.revision);
    const shouldRestartMovement =
      backgroundRestarted ||
      !previousInteractionEnabled ||
      Number(previousMovement.profile) !== PARTICLE_BACKGROUND_MOVEMENT_STATE_PROFILE ||
      existingMovementStartedAt === null;

    previousState.backgroundMovement = {
      ...previousMovement,
      startedAt: shouldRestartMovement ? nowMs : existingMovementStartedAt,
      revision: shouldRestartMovement
        ? Number.isFinite(previousMovementRevision)
          ? previousMovementRevision + 1
          : 1
        : previousMovementRevision || 1,
      clockUnit: "epoch-ms",
      profile: PARTICLE_BACKGROUND_MOVEMENT_STATE_PROFILE,
    };
  }

  return previousState;
}
