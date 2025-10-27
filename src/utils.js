import { packageId } from "./constants.js";

/**
 * Reset a flag to a given value, replacing inner objects.
 * @param {foundry.abstract.Document} document The document on which to reset the flag
 * @param {string}                    key      The flag key
 * @param {*}                         value    The flag value
 * @return {Promise<Document>}  A Promise resolving to the updated document
 */
export async function resetFlag(document, key, value) {
  if (typeof value === "object" && !Array.isArray(value) && value !== null) {
    const oldFlags = document.getFlag(packageId, key);
    const keys = oldFlags ? Object.keys(oldFlags) : [];
    keys.forEach((k) => {
      if (value[k]) return;
      value[`-=${k}`] = null;
    });
  }

  return document.setFlag(packageId, key, value);
}

/**
 * Round a number to the given number of decimals.
 * @param {number} number   The number to round
 * @param {number} decimals The number of decimals to round to
 * @returns {number} The rounded result
 */
export function roundToDecimals(number, decimals) {
  return Number(Math.round(number + "e" + decimals) + "e-" + decimals);
}

/**
 * Omit a specific key from an object.
 * @param {object} object The object from which to omit
 * @param {string|number|symbol} key The key to omit
 * @returns {object} The object without the given key.
 */
export function omit(object, key) {
  const { [key]: _omitted, ...rest } = object;
  return rest;
}

export function getDialogColors() {
  const rgbColor = getCssVarValue("--color-warm-2");
  const rgbColorHighlight = getCssVarValue("--color-warm-3");
  let baseColor = addAlphaToRgb(rgbColor, 1);
  let highlightColor = addAlphaToRgb(rgbColorHighlight, 1);

  return { baseColor, highlightColor };
}

function getCssVarValue(varName) {
  const tempEl = document.createElement("div");
  tempEl.style.color = `var(${varName})`;
  tempEl.style.display = "none";
  document.body.appendChild(tempEl);

  const computedColor = getComputedStyle(tempEl).color;
  document.body.removeChild(tempEl);
  return computedColor;
}

function addAlphaToRgb(rgbString, alpha) {
  const match = rgbString.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
  if (match) {
    return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${alpha})`;
  }
  return rgbString;
}

/**
 * Handle a request to toggle a named particle effect in the current scene.
 * @param {{name: string, type: string, options: object}} parameters The parameters that define the named particle effect
 */
export async function onSwitchParticleEffects(parameters) {
  console.log("made it here", canvas.scene, parameters);
  if (!canvas.scene) {
    return;
  }
  console.log(parameters, "parameters");
  const currentEffects = canvas.scene.getFlag(packageId, "effects") ?? {};
  console.log(currentEffects, "currentEffects");
  const key = `core_${parameters.type}`;
  const shouldSwitchOff = key in currentEffects;
  const effects = shouldSwitchOff
    ? omit(currentEffects, key)
    : { ...currentEffects, [key]: { type: parameters.type, options: parameters.options } };

  if (Object.keys(effects).length == 0) {
    await canvas.scene.unsetFlag(packageId, "effects");
  } else {
    await resetFlag(canvas.scene, "effects", effects);
  }
}

/**
 * Handle a request to set the particle effects in the current scene.
 * @param {Array<object>} parametersArray The array of parameters defining the effects to be activated
 */
export async function onUpdateParticleEffects(parametersArray) {
  if (!canvas.scene) return;

  const scene = canvas.scene;
  // Grab whatever is already there (or {})
  const old = scene.getFlag(packageId, "effects") || {};

  // Map new parameters under fresh IDs
  const added = Object.fromEntries(parametersArray.map((p) => [foundry.utils.randomID(), p]));

  // Merge — this leaves old keys alone, adds (or overwrites) the new ones
  const merged = foundry.utils.mergeObject(old, added, { inplace: false });

  await resetFlag(canvas.scene, "effects", merged);
}

/**
 * Handle removing region particle effects on region deletion.
 * @param {String} regionId Deleted Region ID
 */
export function cleanupRegionFilterEffects(regionId) {
  try {
    canvas.filtereffects?.destroyRegionFilterEffects?.(regionId);
  } catch {}
}

export function cleanupRegionParticleEffects(regionId) {
  try {
    canvas.particleeffects?.destroyRegionParticleEffects?.(regionId);
  } catch {}
}

export async function parseSpecialEffects() {
  let effectsMap = game.settings.get(packageId, "dbSpecialEffects") || {};

  if (!effectsMap || Object.keys(effectsMap).length === 0) {
    const { registerAnimations } = await import("./animation-files.js");
    effectsMap = await registerAnimations({ initialScan: true });
    await game.settings.set(packageId, "dbSpecialEffects", effectsMap);
  }

  CONFIG.fxmaster.userSpecials = effectsMap;
}

export function pixelsArea() {
  const r = canvas?.app?.renderer;
  if (!r) return new PIXI.Rectangle(0, 0, 0, 0);
  const { width, height } = r.view; // device pixels
  return new PIXI.Rectangle(0, 0, width | 0, height | 0);
}

export const clampRange = (v, lo, hi, def) => (Number.isFinite((v = Number(v))) ? Math.min(Math.max(v, lo), hi) : def);
export const clamp01 = (v, def) => clampRange(v, 0, 1, def);
export const clampNonNeg = (v, def = 0) => (Number.isFinite((v = Number(v))) ? Math.max(0, v) : def);
export const clampMin = (v, m = 1e-4, def) => (Number.isFinite((v = Number(v))) ? Math.max(v, m) : def);
export const num = (v, d = 0) => (v === undefined || v === null || Number.isNaN(Number(v)) ? d : Number(v));
export const asFloat3 = (arr) => new Float32Array([arr[0], arr[1], arr[2]]);
