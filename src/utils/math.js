/**
 * FXMaster: Math & Numeric Utilities
 *
 * Numeric coercion helpers plus lightweight renderer pixel-bound helpers used throughout the masking pipeline.
 */

/**
 * Round a number to a fixed number of decimals.
 * @param {number} number
 * @param {number} decimals
 * @returns {number}
 */
export function roundToDecimals(number, decimals) {
  return Number(Math.round(number + "e" + decimals) + "e-" + decimals);
}

/**
 * Return a copy of an object without a given key.
 * @param {object} object
 * @param {string|number|symbol} key
 * @returns {object}
 */
export function omit(object, key) {
  const { [key]: _omitted, ...rest } = object;
  return rest;
}

/**
 * Get the renderer pixel rectangle.
 * @returns {PIXI.Rectangle}
 */
export function pixelsArea() {
  const r = canvas?.app?.renderer;
  if (!r) return new PIXI.Rectangle(0, 0, 0, 0);
  const { width, height } = r.view;
  return new PIXI.Rectangle(0, 0, width | 0, height | 0);
}

/**
 * Clamp a numeric value into a closed range, or return a default when the input is not finite.
 * @param {*} v
 * @param {number} lo
 * @param {number} hi
 * @param {*} def
 * @returns {number|*}
 */
export const clampRange = (v, lo, hi, def) => (Number.isFinite((v = Number(v))) ? Math.min(Math.max(v, lo), hi) : def);

/**
 * Clamp a value to the inclusive range [0, 1].
 * @param {*} v
 * @param {*} def
 * @returns {number|*}
 */
export const clamp01 = (v, def) => clampRange(v, 0, 1, def);

/**
 * Clamp a value to be non-negative.
 * @param {*} v
 * @param {number} [def=0]
 * @returns {number}
 */
export const clampNonNeg = (v, def = 0) => (Number.isFinite((v = Number(v))) ? Math.max(0, v) : def);

/**
 * Clamp a value to be at least a minimum threshold.
 * @param {*} v
 * @param {number} [m=1e-4]
 * @param {*} def
 * @returns {number|*}
 */
export const clampMin = (v, m = 1e-4, def) => (Number.isFinite((v = Number(v))) ? Math.max(v, m) : def);

/**
 * Coerce a value to a number, falling back to a default for nullish or NaN inputs.
 * @param {*} v
 * @param {number} [d=0]
 * @returns {number}
 */
export const num = (v, d = 0) => (v === undefined || v === null || Number.isNaN(Number(v)) ? d : Number(v));

/**
 * Coerce a 3-element array-like into a Float32Array.
 * @param {ArrayLike<number>} arr
 * @returns {Float32Array}
 */
export const asFloat3 = (arr) => new Float32Array([arr[0], arr[1], arr[2]]);
