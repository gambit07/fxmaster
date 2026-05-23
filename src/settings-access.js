import { packageId } from "./constants.js";

/**
 * Determine whether FXMaster effects are globally enabled.
 *
 * @returns {boolean} Whether the module is enabled for the current world and client.
 */
export function isEnabled() {
  return (
    globalThis.game?.settings?.get(packageId, "enable") && !globalThis.game?.settings?.get(packageId, "disableAll")
  );
}

/**
 * Return whether Region particle/filter/suppression behaviors may be projected onto visible overhead native Scene Level surfaces.
 *
 * @returns {boolean}
 */
export function applyRegionBehaviorsToOverheadLevels() {
  try {
    return globalThis.game?.settings?.get(packageId, "applyRegionBehaviorsToOverheadLevels") === true;
  } catch (_err) {
    return false;
  }
}

/**
 * Return whether the normal Foundry grid should be captured into the FX stack input.
 *
 * @returns {boolean}
 */
export function compositeGridInFxStack() {
  try {
    return globalThis.game?.settings?.get(packageId, "compositeGridInFxStack") === true;
  } catch (_err) {
    return false;
  }
}
