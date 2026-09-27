import { packageId } from "../constants.js";
import { isEnabled } from "../settings-access.js";
import {
  collectionValues,
  computeRegionGatePass,
  getRegionEffectPlaceablesForCurrentView,
  getRegionParticleEffectDefinitions,
  getRegionFilterEffectDefinitions,
  getSceneDarknessLevel,
  isEffectActiveForSceneDarkness,
  isEffectActiveForCurrentOrVisibleCanvasLevel,
  normalizeSceneLevelSelection,
} from "../utils.js";

/**
 * Collect effect definitions that are active in the current scene view.
 * @param {Scene} scene
 * @returns {Array<object>}
 */
export function collectActiveEffectDefinitions(scene) {
  const active = [];
  if (!scene || !isEnabled()) return active;
  const darkness = getSceneDarknessLevel();
  const kinds = [
    ["particle", "effects", "particleEffectsRegion", getRegionParticleEffectDefinitions],
    ["filter", "filters", "filterEffectsRegion", getRegionFilterEffectDefinitions],
  ];
  for (const [kind, flag] of kinds) {
    const registry = CONFIG.fxmaster[`${kind}Effects`] ?? {};
    for (const [id, definition] of Object.entries(scene.getFlag(packageId, flag) ?? {})) {
      if (!definition || !registry[definition.type]) continue;
      const options = normalizeSceneLevelSelection({ ...(definition.options ?? {}) }, scene);
      if (!isEffectActiveForSceneDarkness(options, darkness)) continue;
      if (!isEffectActiveForCurrentOrVisibleCanvasLevel(options, scene)) continue;
      active.push({ scope: "scene", kind, id, type: definition.type, options });
    }
  }
  for (const placeable of getRegionEffectPlaceablesForCurrentView(scene)) {
    for (const behavior of collectionValues(placeable.document?.behaviors)) {
      if (behavior.disabled) continue;
      const kindInfo = kinds.find(([, , type]) => behavior.type === `${packageId}.${type}`);
      if (!kindInfo) continue;
      if (!computeRegionGatePass(placeable, { behaviorType: behavior.type, behaviorId: behavior.id })) continue;
      const [kind, , , getDefinitions] = kindInfo;
      const registry = CONFIG.fxmaster[`${kind}Effects`] ?? {};
      for (const [type, definition] of Object.entries(getDefinitions(behavior) ?? {})) {
        if (!registry[type] || !isEffectActiveForSceneDarkness(definition?.options, darkness)) continue;
        active.push({ scope: "region", kind, type, options: definition?.options ?? {}, placeable, behavior });
      }
    }
  }
  return active;
}
