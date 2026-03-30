/**
 * FXMaster: Particle Scene Suppression Manager
 * Builds and applies a CSS-space allow-mask to scene-level particle containers.
 *
 * Container Masks Approach:
 * - SceneMaskManager produces two RTs for particles: { base, cutout }.
 * - ParticleEffectsLayer owns 4 scene buckets (below/above - base/cutout)
 */

import { logger } from "../logger.js";
import { SceneMaskManager } from "../common/base-effects-scene-manager.js";
import { coalesceNextFrame } from "../utils.js";

/* ------------------------------------------------------------------ */
/*  Shared helpers                                                     */
/* ------------------------------------------------------------------ */

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
  return allFx.some((fx) => {
    const bt = fx?._fxmOptsCache?.belowTokens ?? fx?.options?.belowTokens ?? fx?.__fxmBelowTokens;
    if (bt && typeof bt === "object" && "value" in bt) return bt.value === true;
    return bt === true;
  });
}

/**
 * Core determine needs - configure SceneMaskManager - apply textures pipeline shared by both the synchronous and coalesced code paths.
 *
 * @param {object} layer - The ParticleEffectsLayer instance.
 * @param {{syncRefresh?: boolean}} [opts]
 * @returns {{needsMasking: boolean, anyBelow: boolean}} The computed state,
 *   so callers that need to perform additional work (e.g. async refresh) can
 *   branch on it.
 * @private
 */
function _applySuppressionMasks(layer, { syncRefresh = true } = {}) {
  const { liveFx, dyingFx } = _collectEffects(layer);
  const hasAny = liveFx.length > 0 || dyingFx.length > 0;

  if (!hasAny) {
    try {
      SceneMaskManager.instance.setBelowTokensNeeded?.("particles", false);
      SceneMaskManager.instance.setKindActive?.("particles", false);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      layer.setSceneMaskTextures?.({ base: null, cutout: null });
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    return { needsMasking: false, anyBelow: false };
  }

  const allFx = [...liveFx, ...dyingFx];
  const anyBelow = _anyBelowTokens(allFx);
  const hasSuppression = !!SceneMaskManager.instance.hasSuppressionRegions?.("particles");
  const needsMasking = anyBelow || hasSuppression;

  try {
    SceneMaskManager.instance.setKindActive?.("particles", needsMasking);
    SceneMaskManager.instance.setBelowTokensNeeded?.("particles", anyBelow);
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  if (!needsMasking) {
    try {
      layer.setSceneMaskTextures?.({ base: null, cutout: null });
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      layer._sanitizeSceneMasks?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    return { needsMasking: false, anyBelow };
  }

  if (syncRefresh) {
    _refreshAndBind(layer, anyBelow);
  }

  return { needsMasking, anyBelow };
}

/**
 * Perform a synchronous SceneMaskManager refresh and bind the resulting textures onto the layer. Falls back to a retry if the first refresh yields a destroyed or missing base texture.
 *
 * @param {object} layer - The ParticleEffectsLayer instance.
 * @param {boolean} anyBelow - Whether any effect needs belowTokens masking.
 * @private
 */
function _refreshAndBind(layer, anyBelow) {
  let { base, cutout } = SceneMaskManager.instance.getMasks("particles");

  if (!base || base.destroyed) {
    try {
      SceneMaskManager.instance.refreshSync("particles");
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    ({ base, cutout } = SceneMaskManager.instance.getMasks("particles"));
  }

  if (!base || base.destroyed) {
    try {
      layer.setSceneMaskTextures?.({ base: null, cutout: null });
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
    layer.setSceneMaskTextures?.({ base, cutout: anyBelow ? cutout : null });
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  try {
    layer._sanitizeSceneMasks?.();
  } catch (err) {
    logger.debug("FXMaster:", err);
  }
}

/* ------------------------------------------------------------------ */
/*  Coalesced (deferred) path                                          */
/* ------------------------------------------------------------------ */

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
 * When `sync` is `false` and the situation does not require an immediate refresh, the heavy work is deferred to the next animation frame via {@link applySceneParticleMasksNextFrame}.
 * Suppression-active scenes use the synchronous path so the scene allow-mask and region masks stay in lockstep while the camera moves.
 *
 * @param {{sync?: boolean}} [opts]
 */
export function refreshSceneParticlesSuppressionMasks({ sync = false } = {}) {
  try {
    const layer = canvas.particleeffects;
    if (!layer) return;

    layer._dyingSceneEffects ??= new Set();

    const { needsMasking, anyBelow } = _applySuppressionMasks(layer, { syncRefresh: false });
    if (!needsMasking) return;

    const r = canvas?.app?.renderer;
    const hiDpi = (r?.resolution ?? window.devicePixelRatio ?? 1) !== 1;
    const hasSuppression = !!SceneMaskManager.instance.hasSuppressionRegions?.("particles");
    const wantSync = sync || hasSuppression || (anyBelow && hiDpi);

    if (wantSync) {
      try {
        SceneMaskManager.instance.refreshSync("particles");
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      _refreshAndBind(layer, anyBelow);
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
