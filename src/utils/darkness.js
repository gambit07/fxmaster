/**
 * Helpers for reading the current scene darkness level and evaluating FXMaster darkness-activation ranges.
 */

import { clamp01 } from "./math.js";

const DARKNESS_EPSILON = 1e-4;
const DEFAULT_DARKNESS_RANGE = Object.freeze({ min: 0, max: 1 });

/**
 * Clamp a numeric darkness value into the inclusive [0, 1] range.
 *
 * @param {*} value
 * @param {number} [fallback=0]
 * @returns {number}
 */
function clampDarknessNumber(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return clamp01(fallback);
  return clamp01(n);
}

/**
 * Read the active scene darkness level from the scene environment fields.
 *
 * @param {*} [scene]
 * @returns {number}
 */
export function getSceneDarknessLevel(scene) {
  const liveCanvas = globalThis.canvas ?? null;
  const activeScene = scene ?? liveCanvas?.scene ?? globalThis.game?.scenes?.current ?? null;

  const candidates = [
    liveCanvas?.environment?.darknessLevel,
    activeScene?._source?.environment?.darknessLevel,
    activeScene?.environment?.darknessLevel,
  ];

  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n)) return clamp01(n);
  }

  return 0;
}

/**
 * Normalize a stored darkness-activation range into a clamped ordered pair.
 *
 * Accepts the FXMaster object form `{ min, max }` and a few permissive fallbacks.
 *
 * @param {*} value
 * @returns {{ min: number, max: number }}
 */
export function normalizeDarknessActivationRange(value) {
  let min = DEFAULT_DARKNESS_RANGE.min;
  let max = DEFAULT_DARKNESS_RANGE.max;

  if (Array.isArray(value)) {
    if (value.length > 0) min = clampDarknessNumber(value[0], DEFAULT_DARKNESS_RANGE.min);
    if (value.length > 1) max = clampDarknessNumber(value[1], DEFAULT_DARKNESS_RANGE.max);
  } else if (value && typeof value === "object") {
    const hasMin =
      Object.prototype.hasOwnProperty.call(value, "min") || Object.prototype.hasOwnProperty.call(value, "from");
    const hasMax =
      Object.prototype.hasOwnProperty.call(value, "max") || Object.prototype.hasOwnProperty.call(value, "to");
    if (hasMin) min = clampDarknessNumber(value.min ?? value.from, DEFAULT_DARKNESS_RANGE.min);
    if (hasMax) max = clampDarknessNumber(value.max ?? value.to, DEFAULT_DARKNESS_RANGE.max);
  }

  if (min > max) {
    const swap = min;
    min = max;
    max = swap;
  }

  return { min, max };
}

/**
 * Resolve whether darkness activation is enabled for an effect options object.
 *
 * @param {object|null|undefined} options
 * @returns {boolean}
 */
export function resolveDarknessActivationEnabled(options) {
  const explicit = options?.darknessActivationEnabled;
  if (typeof explicit === "boolean") return explicit;
}

/**
 * Determine whether the supplied darkness level falls inside a normalized FXMaster darkness-activation range.
 *
 * @param {*} range
 * @param {number} [darknessLevel=getSceneDarknessLevel()]
 * @returns {boolean}
 */
export function isDarknessRangeActive(range, darknessLevel = getSceneDarknessLevel()) {
  const { min, max } = normalizeDarknessActivationRange(range);
  const level = clampDarknessNumber(darknessLevel, 0);
  return level + DARKNESS_EPSILON >= min && level - DARKNESS_EPSILON <= max;
}

/**
 * Evaluate whether an effect options object should be active at the supplied scene darkness level.
 *
 * @param {object|null|undefined} options
 * @param {number} [darknessLevel=getSceneDarknessLevel()]
 * @returns {boolean}
 */
export function isEffectActiveForSceneDarkness(options, darknessLevel = getSceneDarknessLevel()) {
  if (!resolveDarknessActivationEnabled(options)) return true;
  return isDarknessRangeActive(options?.darknessActivationRange, darknessLevel);
}
