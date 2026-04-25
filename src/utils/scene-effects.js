/**
 * FXMaster: Scene Effect Helpers
 *
 * High-level operations for toggling particle effects, cleaning up region effects, and updating scene control button highlights.
 */

import { packageId } from "../constants.js";
import { logger } from "../logger.js";
import { ensureSingleSceneLevelSelection, isLegacyOperatorKey, resetFlag } from "./compat.js";
import { omit } from "./math.js";
import { buildSceneEffectUid, promoteEffectStackUids } from "../common/effect-stack.js";

/**
 * Toggle a named core particle effect in the current scene.
 * @param {{name:string,type:string,options:object}} parameters
 * @returns {Promise<void>}
 */
export async function onSwitchParticleEffects(parameters) {
  if (!canvas.scene) return;
  const scene = canvas.scene;
  const current = scene.getFlag(packageId, "effects") ?? {};
  const key = `core_${parameters.type}`;
  const disable = key in current;
  const options = ensureSingleSceneLevelSelection(
    parameters.options && typeof parameters.options === "object" ? { ...parameters.options } : {},
    scene,
  );
  const effects = disable ? omit(current, key) : { ...current, [key]: { type: parameters.type, options } };

  if (Object.keys(effects).length === 0) await scene.unsetFlag(packageId, "effects");
  else await resetFlag(scene, "effects", effects);

  if (!disable) {
    await promoteEffectStackUids([buildSceneEffectUid("particle", key)], scene);
  }
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
  const added = Object.fromEntries(
    parametersArray.map((p) => {
      const info = p && typeof p === "object" ? { ...p } : {};
      info.options = ensureSingleSceneLevelSelection(
        info.options && typeof info.options === "object" ? { ...info.options } : {},
        scene,
      );
      return [foundry.utils.randomID(), info];
    }),
  );
  const merged = foundry.utils.mergeObject(old, added, { inplace: false });
  await resetFlag(scene, "effects", merged);
  await promoteEffectStackUids(
    Object.keys(added).map((id) => buildSceneEffectUid("particle", id)),
    scene,
  );
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

  CONFIG.fxmaster.FXMasterBaseFormV2.setSceneEffectsControlHighlight(hasAnyEffects);
}
