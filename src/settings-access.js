import { packageId } from "./constants.js";

/**
 * Cached setting values, keyed by setting name.
 * 
 * Avoids WorldSettings#getSetting - linear scan of all settings documents,
 * which adds latency that can add up with enough call frequency.
 *
 * @type {Map<string, boolean>}
 */
const settingCache = new Map();
let cacheHooksRegistered = false;

/**
 * Read a cached boolean module setting.
 * 
 * Invalidates on any possible action that can result in a setting change.
 * Failed reads are not cached and hooks register on first use
 * 
 * @param {string} key
 * @returns {boolean}
 */
function cachedFlag(key) {
  const hit = settingCache.get(key);
  if (hit !== undefined) return hit;

  const settings = globalThis.game?.settings;
  if (!settings) return false;

  if (!cacheHooksRegistered) {
    cacheHooksRegistered = true;
    const invalidate = () => settingCache.clear();
    Hooks.on("updateSetting", invalidate);
    Hooks.on("createSetting", invalidate);
    Hooks.on("clientSettingChanged", invalidate);
  }

  let value;
  try {
    value = settings.get(packageId, key) === true;
  } catch (_err) {
    return false;
  }
  settingCache.set(key, value);
  return value;
}

/**
 * Determine whether FXMaster effects are globally enabled.
 *
 * @returns {boolean} Whether the module is enabled for the current world and client.
 */
export function isEnabled() {
  return cachedFlag("enable") && !cachedFlag("disableAll");
}

/**
 * Return whether Region particle/filter/suppression behaviors may be projected onto visible overhead native Scene Level surfaces.
 *
 * @returns {boolean}
 */
export function applyRegionBehaviorsToOverheadLevels() {
  return cachedFlag("applyRegionBehaviorsToOverheadLevels");
}

/**
 * Return whether the normal Foundry grid should be captured into the FX stack input.
 *
 * @returns {boolean}
 */
export function compositeGridInFxStack() {
  return cachedFlag("compositeGridInFxStack");
}

/**
 * Return whether FXMaster compositor output should render above Foundry visibility and fog.
 *
 * @returns {boolean}
 */
export function displayEffectsOverVision() {
  return cachedFlag("displayEffectsOverVision");
}

/**
 * Return whether token movement grid-space highlights should be hidden.
 *
 * @returns {boolean}
 */
export function disableGridMovementHighlighting() {
  return cachedFlag("disableGridMovementHighlighting");
}
