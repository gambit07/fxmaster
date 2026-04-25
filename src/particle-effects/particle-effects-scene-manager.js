/**
 * FXMaster: Particle Scene Suppression Manager Builds and applies a CSS-space allow-mask to scene-level particle containers.
 *
 * Container Masks Approach:
 * - SceneMaskManager produces two RTs for particles: { base, cutout }.
 * - ParticleEffectsLayer owns 4 scene buckets (below/above - base/cutout)
 */

import { logger } from "../logger.js";
import { SceneMaskManager } from "../common/base-effects-scene-manager.js";
import { _belowTilesEnabled, _belowTokensEnabled, coalesceNextFrame } from "../utils.js";

/** ------------------------------------------------------------------ */
/**  Shared helpers                                                     */
/** ------------------------------------------------------------------ */

/**
 * Gather all live and dying scene-level particle effects from a layer.
 *
 * @param {object} layer - The ParticleEffectsLayer instance.
 * @returns {{liveFx: object[], dyingFx: object[]}}
 * @private
 */
function _collectEffects(layer) {
  const liveFx = [];
  try {
    const map = layer?.particleEffects;
    if (map?.values) for (const fx of map.values()) liveFx.push(fx);
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  const dyingFx = [];
  try {
    for (const fx of layer?._dyingSceneEffects ?? []) dyingFx.push(fx);
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  return { liveFx, dyingFx };
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
  const { liveFx, dyingFx } = _collectEffects(layer);
  const hasAny = liveFx.length > 0 || dyingFx.length > 0;

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

  const allFx = [...liveFx, ...dyingFx];
  const anyBelow = _anyBelowTokens(allFx);
  const anyBelowTiles = _anyBelowTiles(allFx);
  const hasSuppression = !!SceneMaskManager.instance.hasSuppressionRegions?.("particles");

  /**
   * Plain scene particles no longer need a compositor-owned scene allow-mask just to remain scene-bounded. The final compositor output is already clipped to the visible scene area, so keeping a second, snapped scene mask active for simple scene particles only introduces camera-edge drift while panning.
   *
   * Keep the scene mask pipeline active only when it is actually needed for suppression or below-object cutouts.
   */
  const needsMasking = hasSuppression || anyBelow || anyBelowTiles;

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

  return { needsMasking, anyBelow, anyBelowTiles };
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

    const { needsMasking, anyBelow, anyBelowTiles } = _applySuppressionMasks(layer, { syncRefresh: false });
    if (!needsMasking) return;

    const r = canvas?.app?.renderer;
    const hiDpi = (r?.resolution ?? window.devicePixelRatio ?? 1) !== 1;
    const hasSuppression = !!SceneMaskManager.instance.hasSuppressionRegions?.("particles");
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
