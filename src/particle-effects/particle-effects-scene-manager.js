/**
 * FXMaster: Particle Scene Suppression Manager Builds and applies a CSS-space allow-mask to scene-level particle containers.
 *
 * Container Masks Approach:
 * - SceneMaskManager produces two RTs for particles: { base, cutout }.
 * - ParticleEffectsLayer owns 4 scene buckets (below/above - base/cutout)
 */

import { logger } from "../logger.js";
import { SceneMaskManager } from "../common/base-effects-scene-manager.js";
import { hasStackedSuppressionAffectingSceneRows } from "../common/effect-stack.js";
import { applyRegionBehaviorsToOverheadLevels } from "../settings.js";
import { _belowTilesEnabled, _belowTokensEnabled, coalesceNextFrame, getSelectedSceneLevelIds } from "../utils.js";

/** ------------------------------------------------------------------ */
/**  Shared helpers                                                     */
/** ------------------------------------------------------------------ */

/**
 * Return live and dying scene-level particle effects using a layer-owned scratch array.
 *
 * @param {object} layer - ParticleEffectsLayer instance.
 * @returns {object[]}
 * @private
 */
function _collectAllEffectsScratch(layer) {
  const allFx = layer ? (layer._fxmSceneParticleRuntimeScratch ??= []) : [];
  allFx.length = 0;

  try {
    const map = layer?.particleEffects;
    if (map?.values) for (const fx of map.values()) if (fx) allFx.push(fx);
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  try {
    for (const fx of layer?._dyingSceneEffects ?? []) if (fx) allFx.push(fx);
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  return allFx;
}

/**
 * Determine whether any effect in a combined list has the `belowTokens` option enabled.
 *
 * @param {object[]} allFx - Combined live + dying effects.
 * @returns {boolean}
 * @private
 */
function _anyBelowTokens(allFx) {
  return allFx.some((fx) =>
    _belowTokensEnabled(fx?.__fxmBelowTokens ?? fx?._fxmOptsCache?.belowTokens ?? fx?.options?.belowTokens),
  );
}

/**
 * Determine whether any effect in a combined list has the `belowTiles` option enabled.
 *
 * @param {object[]} allFx - Combined live + dying effects.
 * @returns {boolean}
 * @private
 */
function _anyBelowTiles(allFx) {
  return allFx.some((fx) =>
    _belowTilesEnabled(fx?.__fxmBelowTiles ?? fx?._fxmOptsCache?.belowTiles ?? fx?.options?.belowTiles),
  );
}

/**
 * Extract a normalized Level selection from a live scene-particle runtime.
 *
 * @param {object|null|undefined} fx
 * @returns {*}
 * @private
 */
function _runtimeLevelsValue(fx) {
  return (
    fx?.__fxmLevels?.value ??
    fx?.__fxmLevels ??
    fx?._fxmOptsCache?.levels?.value ??
    fx?._fxmOptsCache?.levels ??
    fx?.options?.levels?.value ??
    fx?.options?.levels ??
    null
  );
}

/**
 * Return the union of explicit Level ids selected by all active scene particles. A null return means at least one scene particle applies to all Levels.
 *
 * @param {object[]} allFx
 * @returns {Set<string>|null}
 * @private
 */
function _collectSelectedSceneParticleLevelIds(allFx) {
  const selected = new Set();
  for (const fx of allFx ?? []) {
    const levels = getSelectedSceneLevelIds(_runtimeLevelsValue(fx), canvas?.scene ?? null);
    if (!levels?.size) return null;
    for (const levelId of levels) selected.add(String(levelId));
  }
  return selected;
}

/**
 * Normalize the runtime mode for compositor-side scene-particle suppression.
 *
 * V22 intentionally supports only the stable modes for this path:
 * - "off" disables compositor-side scene-particle suppression.
 * - any other value keeps compositor-side scene-particle suppression always on.
 *
 * V21 attempted an adaptive handoff from compositor-side suppression back to the shared scene-particle mask after panning stopped. That handoff could rebind a render texture into the particle mask graph while the compositor was still sampling related textures, producing WebGL feedback-loop errors.
 *
 * @returns {"off"|"always"}
 * @private
 */
function _sceneParticleSuppressionCompositorMode() {
  if (CONFIG?.fxmaster?.overheadPerformance?.compositorSceneParticleSuppression === false) return "off";
  const raw = String(
    CONFIG?.fxmaster?.overheadPerformance?.compositorSceneParticleSuppressionMode ?? "always",
  ).toLowerCase();
  if (["off", "never", "false", "0"].includes(raw)) return "off";
  return "always";
}

/**
 * Return whether scene-particle suppression should currently be handled by the compositor instead of the shared scene allow-mask.
 *
 * @param {object|null|undefined} [layer]
 * @returns {boolean}
 */
export function sceneParticleCompositorSuppressionIsInteractionActive(layer = canvas?.particleeffects) {
  void layer;
  return _sceneParticleSuppressionCompositorMode() !== "off";
}

/**
 * V22 compatibility shim for callers that marked the V21 adaptive window. The adaptive timer is intentionally not scheduled; stale V21 timers are cancelled so the stable compositor-side path remains active continuously.
 *
 * @param {object|null|undefined} [layer]
 * @param {{reason?: string, holdMs?: number}} [options]
 * @returns {boolean}
 */
export function markSceneParticleSuppressionCompositorInteraction(layer = canvas?.particleeffects, options = {}) {
  void options;
  try {
    if (!layer) return false;
    if (layer._fxmSceneParticleSuppressionCompositorSettleTimer) {
      globalThis.clearTimeout?.(layer._fxmSceneParticleSuppressionCompositorSettleTimer);
      layer._fxmSceneParticleSuppressionCompositorSettleTimer = null;
    }
    layer._fxmSceneParticleSuppressionCompositorActiveUntil = 0;
    return _sceneParticleSuppressionCompositorMode() !== "off";
  } catch (err) {
    logger.debug("FXMaster:", err);
    return false;
  }
}

/**
 * Return whether active suppress-scene-particles Regions can affect the supplied scene-particle runtimes. This avoids rebuilding the expensive scene allow mask on every camera movement when, for example, a Level 2 suppression Region is present but all active scene particles are explicitly assigned to Levels 1 & 3.
 *
 * @param {object[]} allFx
 * @returns {boolean}
 * @private
 */
function _hasRelevantSuppressionForSceneParticles(allFx) {
  try {
    if (!allFx?.length) return false;
    if (!hasStackedSuppressionAffectingSceneRows(canvas?.scene, "particles")) return false;
    const selectedLevels = _collectSelectedSceneParticleLevelIds(allFx);
    const manager = SceneMaskManager.instance;
    if (typeof manager.hasSuppressionRegionsForLevelSelection === "function") {
      return manager.hasSuppressionRegionsForLevelSelection("particles", selectedLevels);
    }
    return !!manager.hasSuppressionRegions?.("particles");
  } catch (err) {
    logger.debug("FXMaster:", err);
    return !!SceneMaskManager.instance.hasSuppressionRegions?.("particles");
  }
}

/**
 * Return whether the global compositor can handle scene-particle suppression for the supplied particle runtimes without requiring the shared scene allow-mask. This mirrors the scene-filter compositor suppression path and is limited to explicit-Level scene particles with no below-token or below-tile cutouts.
 *
 * @param {object[]} allFx
 * @param {{anyBelow?: boolean, anyBelowTiles?: boolean, hasRelevantSuppression?: boolean}} [state]
 * @returns {boolean}
 * @private
 */
function _sceneParticleSuppressionCanUseCompositor(
  allFx,
  { anyBelow = false, anyBelowTiles = false, hasRelevantSuppression = false, layer = canvas?.particleeffects } = {},
) {
  try {
    if (CONFIG?.fxmaster?.overheadPerformance?.compositorSceneParticleSuppression === false) return false;
    if (!sceneParticleCompositorSuppressionIsInteractionActive(layer)) return false;
    if (!applyRegionBehaviorsToOverheadLevels()) return false;
    if (!hasRelevantSuppression || anyBelow || anyBelowTiles) return false;
    if (!allFx?.length) return false;
    if (typeof CONFIG?.fxmaster?.getGlobalEffectsCompositor !== "function") return false;

    const selectedLevels = _collectSelectedSceneParticleLevelIds(allFx);
    if (!(selectedLevels?.size > 0)) return false;

    const compositor = CONFIG.fxmaster.getGlobalEffectsCompositor?.();
    if (typeof compositor?.canHandleSceneParticleSuppressionForSelectedLevelIds !== "function") return false;

    return compositor.canHandleSceneParticleSuppressionForSelectedLevelIds(selectedLevels) === true;
  } catch (err) {
    logger.debug("FXMaster:", err);
    return false;
  }
}

/**
 * Return whether the current ParticleEffectsLayer needs the scene-particle suppression base mask for active scene particles.
 *
 * @param {object|null|undefined} layer
 * @returns {boolean}
 */
export function sceneParticlesHaveRelevantSuppressionRegions(layer) {
  const allFx = _collectAllEffectsScratch(layer);
  if (!allFx.length) return false;

  const anyBelow = _anyBelowTokens(allFx);
  const anyBelowTiles = _anyBelowTiles(allFx);
  const hasRelevantSuppression = _hasRelevantSuppressionForSceneParticles(allFx);
  return (
    hasRelevantSuppression &&
    !_sceneParticleSuppressionCanUseCompositor(allFx, {
      anyBelow,
      anyBelowTiles,
      hasRelevantSuppression,
      layer,
    })
  );
}

/**
 * Compute scene particle mask requirements, configure {@link SceneMaskManager}, and bind the resulting textures.
 *
 * The base scene-allow mask remains active whenever any scene particle runtime exists so the global compositor preserves the same scene clipping that the live canvas layer previously inherited from its parent mask.
 *
 * @param {object} layer - The ParticleEffectsLayer instance.
 * @param {{syncRefresh?: boolean}} [opts]
 * @returns {{needsMasking: boolean, anyBelow: boolean}} The computed state, so callers that need to perform additional work (e.g. async refresh) can branch on it.
 * @private
 */
function _applySuppressionMasks(layer, { syncRefresh = true } = {}) {
  const allFx = _collectAllEffectsScratch(layer);
  const hasAny = allFx.length > 0;

  if (!hasAny) {
    try {
      SceneMaskManager.instance.setBelowTokensNeeded?.("particles", false);
      SceneMaskManager.instance.setBelowTilesNeeded?.("particles", false);
      SceneMaskManager.instance.setKindActive?.("particles", false);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      layer.setSceneMaskTextures?.({
        base: null,
        cutoutTokens: null,
        cutoutTiles: null,
        cutoutCombined: null,
      });
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    return { needsMasking: false, anyBelow: false };
  }

  const anyBelow = _anyBelowTokens(allFx);
  const anyBelowTiles = _anyBelowTiles(allFx);
  const hasSuppression = _hasRelevantSuppressionForSceneParticles(allFx);
  const compositorHandlesSuppression = _sceneParticleSuppressionCanUseCompositor(allFx, {
    anyBelow,
    anyBelowTiles,
    hasRelevantSuppression: hasSuppression,
    layer,
  });

  /**
   * Plain scene particles no longer need a compositor-owned scene allow-mask just to remain scene-bounded. The final compositor output is already clipped to the visible scene area, so keeping a second, snapped scene mask active for simple scene particles only introduces camera-edge drift while panning.
   *
   * Keep the scene mask pipeline active only when it is actually needed for suppression or below-object cutouts. When explicit-Level scene-particle suppression can be handled by the global compositor, avoid rebuilding the broad scene allow-mask during camera movement.
   */
  const needsMasking = (hasSuppression && !compositorHandlesSuppression) || anyBelow || anyBelowTiles;

  if (!needsMasking) {
    try {
      SceneMaskManager.instance.setBelowTokensNeeded?.("particles", false);
      SceneMaskManager.instance.setBelowTilesNeeded?.("particles", false);
      SceneMaskManager.instance.setKindActive?.("particles", false);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      layer.setSceneMaskTextures?.({
        base: null,
        cutoutTokens: null,
        cutoutTiles: null,
        cutoutCombined: null,
      });
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    return { needsMasking: false, anyBelow: false, anyBelowTiles: false };
  }

  try {
    SceneMaskManager.instance.setKindActive?.("particles", true);
    SceneMaskManager.instance.setBelowTokensNeeded?.("particles", anyBelow);
    SceneMaskManager.instance.setBelowTilesNeeded?.("particles", anyBelowTiles);
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  if (syncRefresh) {
    _refreshAndBind(layer, anyBelow, anyBelowTiles);
  }

  return { needsMasking, anyBelow, anyBelowTiles, hasSuppression: hasSuppression && !compositorHandlesSuppression };
}

/**
 * Perform a synchronous SceneMaskManager refresh and bind the resulting textures onto the layer. Falls back to a retry if the first refresh yields a destroyed or missing base texture.
 *
 * @param {object} layer - The ParticleEffectsLayer instance.
 * @param {boolean} anyBelow - Whether any effect needs belowTokens masking.
 * @param {boolean} anyBelowTiles - Whether any effect needs belowTiles masking.
 * @private
 */
function _refreshAndBind(layer, anyBelow, anyBelowTiles) {
  let { base, cutoutTokens, cutoutTiles, cutoutCombined } = SceneMaskManager.instance.getMasks("particles");

  if (!base || base.destroyed) {
    try {
      SceneMaskManager.instance.refreshSync("particles");
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    ({ base, cutoutTokens, cutoutTiles, cutoutCombined } = SceneMaskManager.instance.getMasks("particles"));
  }

  if (!base || base.destroyed) {
    try {
      layer.setSceneMaskTextures?.({
        base: null,
        cutoutTokens: null,
        cutoutTiles: null,
        cutoutCombined: null,
      });
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    return;
  }

  try {
    layer._ensureSceneContainers?.();
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  try {
    layer.setSceneMaskTextures?.({
      base,
      cutoutTokens: anyBelow ? cutoutTokens : null,
      cutoutTiles: anyBelowTiles ? cutoutTiles : null,
      cutoutCombined: anyBelow && anyBelowTiles ? cutoutCombined : null,
    });
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  try {
    layer._sanitizeSceneMasks?.();
  } catch (err) {
    logger.debug("FXMaster:", err);
  }
}

/** ------------------------------------------------------------------ */
/**  Coalesced (deferred) path                                          */
/** ------------------------------------------------------------------ */

/**
 * Apply particle scene suppression masks on the next animation frame.
 *
 * {@link SceneMaskManager.refresh} is animation-frame coalesced and may destroy and recreate render textures when it runs. Deferring mask binding until after the refresh executes prevents sprites from holding references to destroyed textures.
 *
 * @type {(layer: object) => void}
 */
const applySceneParticleMasksNextFrame = coalesceNextFrame(
  (layer) => {
    try {
      if (!layer || layer.destroyed) return;
      _applySuppressionMasks(layer, { syncRefresh: true });
    } catch (err) {
      logger?.error?.(err);
    }
  },
  { key: "fxm:sceneParticlesApplySceneMasks" },
);

/**
 * Recompute and attach suppression masks for scene-level particles.
 *
 * When `sync` is `false` and the situation does not require an immediate refresh, the heavy work is deferred to the next animation frame via {@link applySceneParticleMasksNextFrame}. Suppression-active scenes use the synchronous path so the scene allow-mask and region masks stay in lockstep while the camera moves.
 *
 * @param {{sync?: boolean}} [opts]
 */
export function refreshSceneParticlesSuppressionMasks({ sync = false } = {}) {
  try {
    const layer = canvas.particleeffects;
    if (!layer) return;

    layer._dyingSceneEffects ??= new Set();

    const { needsMasking, anyBelow, anyBelowTiles, hasSuppression } = _applySuppressionMasks(layer, {
      syncRefresh: false,
    });
    if (!needsMasking) return;

    const r = canvas?.app?.renderer;
    const hiDpi = (r?.resolution ?? window.devicePixelRatio ?? 1) !== 1;
    const wantSync = sync || hasSuppression || ((anyBelow || anyBelowTiles) && hiDpi);

    if (wantSync) {
      try {
        SceneMaskManager.instance.refreshSync("particles");
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      _refreshAndBind(layer, anyBelow, anyBelowTiles);
    } else {
      try {
        SceneMaskManager.instance.refresh("particles");
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      applySceneParticleMasksNextFrame(layer);
    }
  } catch (err) {
    logger?.error?.(err);
  }
}
