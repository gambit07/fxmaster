/**
 * FXMaster: Scene Effect Helpers
 *
 * High-level operations for toggling particle effects, cleaning up region effects, parsing special effects from flags, and updating scene control button highlights.
 */

import { packageId } from "../constants.js";
import { logger } from "../logger.js";
import { isLegacyOperatorKey, resetFlag } from "./compat.js";
import { omit } from "./math.js";

/**
 * Toggle a named core particle effect in the current scene.
 * @param {{name:string,type:string,options:object}} parameters
 * @returns {Promise<void>}
 */
export async function onSwitchParticleEffects(parameters) {
  if (!canvas.scene) return;
  const current = canvas.scene.getFlag(packageId, "effects") ?? {};
  const key = `core_${parameters.type}`;
  const disable = key in current;
  const effects = disable
    ? omit(current, key)
    : { ...current, [key]: { type: parameters.type, options: parameters.options } };

  if (Object.keys(effects).length === 0) await canvas.scene.unsetFlag(packageId, "effects");
  else await resetFlag(canvas.scene, "effects", effects);
}

/**
 * Replace current scene particle effects with a new set.
 * @param {Array<object>} parametersArray
 * @returns {Promise<void>}
 */
export async function onUpdateParticleEffects(parametersArray) {
  if (!canvas.scene) return;
  const scene = canvas.scene;
  const old = scene.getFlag(packageId, "effects") || {};
  const added = Object.fromEntries(parametersArray.map((p) => [foundry.utils.randomID(), p]));
  const merged = foundry.utils.mergeObject(old, added, { inplace: false });
  await resetFlag(canvas.scene, "effects", merged);
}

/**
 * Cleanup filter effects for a deleted region.
 * @param {string} regionId
 */
export function cleanupRegionFilterEffects(regionId) {
  try {
    canvas.filtereffects?.destroyRegionFilterEffects?.(regionId);
  } catch (err) {
    logger.debug("FXMaster:", err);
  }
}

/**
 * Cleanup particle effects for a deleted region.
 * @param {string} regionId
 */
export function cleanupRegionParticleEffects(regionId) {
  try {
    canvas.particleeffects?.destroyRegionParticleEffects?.(regionId);
  } catch (err) {
    logger.debug("FXMaster:", err);
  }
}

/**
 * Parse and cache special FX definitions.
 * @returns {Promise<void>}
 */
export async function parseSpecialEffects() {
  let effectsMap = game.settings.get(packageId, "dbSpecialEffects") || {};
  if (!effectsMap || typeof effectsMap !== "object") effectsMap = {};

  CONFIG.fxmaster.userSpecials = effectsMap;
}

/**
 * Refresh scene control highlights so the Effects tools reflect the currently active core and API-driven scene effects.
 * @returns {void}
 */
export function updateSceneControlHighlights() {
  const scene = canvas?.scene;
  if (!scene) return;

  const effects = scene.getFlag(packageId, "effects") ?? {};
  const filters = scene.getFlag(packageId, "filters") ?? {};

  const isDeletionKey = isLegacyOperatorKey;
  const isCoreKey = (id) => typeof id === "string" && id.startsWith("core_");

  const hasCoreParticles = Object.entries(effects).some(([id, v]) => !isDeletionKey(id) && isCoreKey(id) && v);
  const hasApiParticles = Object.entries(effects).some(([id, v]) => !isDeletionKey(id) && !isCoreKey(id) && v);

  const hasCoreFilters = Object.entries(filters).some(([id, v]) => !isDeletionKey(id) && isCoreKey(id) && v);
  const hasApiFilters = Object.entries(filters).some(([id, v]) => !isDeletionKey(id) && !isCoreKey(id) && v);

  const hasApiEffects = hasApiParticles || hasApiFilters;
  const hasAnyEffects = hasCoreParticles || hasCoreFilters || hasApiEffects;

  CONFIG.fxmaster.FXMasterBaseFormV2.setToolButtonHighlight("particle-effects", hasCoreParticles);
  CONFIG.fxmaster.FXMasterBaseFormV2.setToolButtonHighlight("filters", hasCoreFilters);
  CONFIG.fxmaster.FXMasterBaseFormV2.setToolButtonHighlight("api-effects", hasApiEffects);

  const controlBtn = document.querySelector(`#scene-controls-layers button.control[data-control="effects"]`);

  const controlEl = controlBtn?.matches?.("li") ? controlBtn.querySelector?.("button") ?? controlBtn : controlBtn;

  if (controlEl) {
    if (hasAnyEffects) {
      controlEl.style.setProperty("background-color", "var(--color-warm-2)");
      controlEl.style.setProperty("border-color", "var(--color-warm-3)");
    } else {
      controlEl.style.removeProperty("background-color");
      controlEl.style.removeProperty("border-color");
    }
  }
}
