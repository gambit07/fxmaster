/**
 * FXMaster: Region & Behavior Hooks
 *
 * Registers Foundry hooks for region and region-behavior CRUD events. Handles particle and filter effect drawing, suppression mask updates, and the FXMaster-specific switchParticleEffect and updateParticleEffects hooks.
 *
 * @module hooks/region-hooks
 */

import { packageId } from "../constants.js";
import { logger } from "../logger.js";
import { coalesceNextFrame, onSwitchParticleEffects, onUpdateParticleEffects } from "../utils.js";
import { isEnabled } from "../settings.js";

const PARTICLE_TYPE = `${packageId}.particleEffectsRegion`;
const FILTER_TYPE = `${packageId}.filterEffectsRegion`;
const SUPPRESS_SCENE_FILTERS = `${packageId}.suppressSceneFilters`;
const SUPPRESS_SCENE_PARTICLES = `${packageId}.suppressSceneParticles`;
const SUPPRESS_WEATHER = "suppressWeather";

/**
 * Convert a region behavior collection into a plain array of behavior documents.
 * @param {Iterable<object>|{contents?: object[]}|null|undefined} behaviorDocs
 * @returns {object[]}
 * @private
 */
function normalizeRegionBehaviorDocs(behaviorDocs) {
  if (!behaviorDocs) return [];
  if (Array.isArray(behaviorDocs)) return behaviorDocs;
  if (Array.isArray(behaviorDocs.contents)) return behaviorDocs.contents;
  if (typeof behaviorDocs.toArray === "function") return behaviorDocs.toArray();
  if (typeof behaviorDocs.values === "function") return Array.from(behaviorDocs.values());
  return Array.from(behaviorDocs);
}

/**
 * Build an authoritative region-behavior snapshot for behavior CRUD hooks.
 * @param {foundry.documents.RegionDocument|object|null} regionDoc
 * @param {foundry.documents.RegionBehavior|object|null} behaviorDoc
 * @param {{ deleted?: boolean }} [options]
 * @returns {object[]}
 * @private
 */
function buildBehaviorHookSnapshot(regionDoc, behaviorDoc, { deleted = false } = {}) {
  const docs = normalizeRegionBehaviorDocs(regionDoc?.behaviors);
  const byId = new Map();

  for (const doc of docs) {
    const id = doc?.id ?? doc?._id ?? null;
    if (id != null) byId.set(String(id), doc);
    else byId.set(Symbol("behavior"), doc);
  }

  const hookId = behaviorDoc?.id ?? behaviorDoc?._id ?? null;
  if (hookId != null) {
    if (deleted) byId.delete(String(hookId));
    else byId.set(String(hookId), behaviorDoc);
  } else if (behaviorDoc && !deleted) {
    byId.set(Symbol("hookBehavior"), behaviorDoc);
  }

  return [...byId.values()];
}

/**
 * Refresh region-scoped masks and gates without rebuilding effect instances.
 *
 * This path is used from the Region placeable refresh hook, where effect instances already exist and only their masks or visibility gates need to be synchronized.
 *
 * @param {PlaceableObject|null} placeable
 * @returns {void}
 * @private
 */
function refreshRegionEffects(placeable) {
  if (!placeable) return;

  try {
    canvas.particleeffects?.forceRegionMaskRefresh?.(placeable.id);
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  try {
    canvas.particleeffects?.applyElevationGateForAll?.();
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  try {
    canvas.filtereffects?.forceRegionMaskRefresh?.(placeable.id);
  } catch (err) {
    logger.debug("FXMaster:", err);
  }
}

/**
 * Rebuild or destroy region-scoped effects using the region document supplied by the current behavior hook payload.
 *
 * Behavior CRUD hooks can observe a newer region document than the Region placeable. Passing the hook document's behavior set into the draw routines keeps redraw decisions aligned with the update that triggered the hook.
 *
 * @param {foundry.documents.RegionDocument|object|null} regionDoc
 * @returns {void}
 * @private
 */
function syncRegionScopedEffects(regionDoc, { behaviorDocs = null } = {}) {
  if (regionDoc?.parent !== canvas.scene) return;

  const placeable = regionDoc?.object ?? canvas.regions.get(regionDoc?.id);
  if (!placeable) return;

  const snapshot = normalizeRegionBehaviorDocs(behaviorDocs ?? regionDoc?.behaviors);
  const enabled = isEnabled();
  const hasParticleBehavior = snapshot.some((behavior) => behavior?.type === PARTICLE_TYPE && !behavior?.disabled);
  const hasFilterBehavior = snapshot.some((behavior) => behavior?.type === FILTER_TYPE && !behavior?.disabled);

  if (enabled && hasParticleBehavior) {
    canvas.particleeffects?.drawRegionParticleEffects?.(placeable, {
      soft: false,
      behaviorDocs: snapshot,
    });
  } else {
    try {
      canvas.particleeffects?.destroyRegionParticleEffects?.(regionDoc.id);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  if (enabled && hasFilterBehavior) {
    canvas.filtereffects?.drawRegionFilterEffects?.(placeable, {
      soft: false,
      behaviorDocs: snapshot,
    });
  } else {
    try {
      canvas.filtereffects?.destroyRegionFilterEffects?.(regionDoc.id);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }
}

/**
 * Determine whether a region update originated from behavior CRUD or FXMaster behavior-side flag churn.
 *
 * Dedicated behavior hooks already handle those updates. Reprocessing them from the parent region hook can observe a transient behavior collection and incorrectly tear down region-local effects.
 *
 * @param {object} [changed]
 * @returns {boolean}
 * @private
 */
function isFxmasterBehaviorDrivenRegionUpdate(changed = {}) {
  if (!changed || typeof changed !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(changed, "behaviors")) return true;

  const pkgFlags = changed?.flags?.[packageId];
  return !!pkgFlags && typeof pkgFlags === "object";
}

/**
 * Refresh scene-suppression masks for a behavior type.
 *
 * RegionBehavior CRUD can observe a newer region document than the live Region placeable tree. Deferring the suppression refresh allows the placeable-backed suppression scan to see the completed add, update, or delete.
 *
 * @param {string|null|undefined} type
 * @param {object} ctx
 * @param {{ deferred?: boolean }} [options]
 * @returns {void}
 * @private
 */
function refreshSuppressionForBehavior(type, ctx, { deferred = false } = {}) {
  const requestParticles = deferred
    ? ctx.requestDeferredSceneParticlesSuppressionRefresh
    : ctx.requestSceneParticlesSuppressionRefresh;
  const requestFilters = deferred ? ctx.requestDeferredFilterSuppressionRefresh : ctx.requestFilterSuppressionRefresh;

  if (type === SUPPRESS_WEATHER || type === SUPPRESS_SCENE_PARTICLES) {
    requestParticles?.();
  }
  if (type === SUPPRESS_WEATHER || type === SUPPRESS_SCENE_FILTERS) {
    requestFilters?.();
  }
}

/**
 * Register region and behavior lifecycle hooks.
 *
 * @param {object} ctx - Shared hook context from {@link createHookContext}.
 */
export function registerRegionHooks(ctx) {
  Hooks.on(`${packageId}.switchParticleEffect`, onSwitchParticleEffects);
  Hooks.on(`${packageId}.updateParticleEffects`, onUpdateParticleEffects);

  const requestDeferredRegionScopedEffectsSync = (() => {
    const pendingRegionIds = new Set();
    const run = coalesceNextFrame(
      () => {
        const ids = [...pendingRegionIds];
        pendingRegionIds.clear();

        for (const regionId of ids) {
          const regionDoc = canvas.scene?.regions?.get?.(regionId) ?? canvas.regions?.get?.(regionId)?.document ?? null;
          if (regionDoc) syncRegionScopedEffects(regionDoc);
        }
      },
      { key: "fxm:deferredRegionScopedEffectsSync" },
    );

    return (regionId) => {
      if (!regionId) return;
      pendingRegionIds.add(regionId);
      run();
    };
  })();

  Hooks.on("preDeleteRegion", (regionDoc) => {
    try {
      canvas.particleeffects?.destroyRegionParticleEffects?.(regionDoc.id);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      canvas.filtereffects?.destroyRegionFilterEffects?.(regionDoc.id);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  });

  Hooks.on("createRegion", (regionDoc) => {
    if (regionDoc?.parent !== canvas.scene) return;

    syncRegionScopedEffects(regionDoc);
    ctx.requestSceneParticlesSuppressionRefresh();
    ctx.requestFilterSuppressionRefresh();
    ctx.scheduleOpenWindowsRefresh();
  });

  Hooks.on("deleteRegion", (regionDoc) => {
    if (regionDoc?.parent !== canvas.scene) return;

    try {
      canvas.particleeffects?.destroyRegionParticleEffects?.(regionDoc.id);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      canvas.filtereffects?.destroyRegionFilterEffects?.(regionDoc.id);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    ctx.requestSceneParticlesSuppressionRefresh();
    ctx.requestFilterSuppressionRefresh();
    ctx.scheduleOpenWindowsRefresh();
  });

  Hooks.on("updateRegion", (regionDoc, changed) => {
    if (regionDoc?.parent !== canvas.scene) return;
    if (isFxmasterBehaviorDrivenRegionUpdate(changed)) return;

    if (!isEnabled()) {
      try {
        canvas.particleeffects?.destroyRegionParticleEffects?.(regionDoc.id);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      try {
        canvas.filtereffects?.destroyRegionFilterEffects?.(regionDoc.id);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    } else {
      syncRegionScopedEffects(regionDoc);
    }

    ctx.requestSceneParticlesSuppressionRefresh();
    ctx.requestFilterSuppressionRefresh();
    ctx.scheduleOpenWindowsRefresh();
  });

  Hooks.on("refreshRegion", (placeable) => {
    if (placeable?.document?.parent !== canvas.scene) return;
    if (isEnabled()) refreshRegionEffects(placeable);
  });

  Hooks.on("createRegionBehavior", (behaviorDoc) => {
    const type = behaviorDoc?.type;
    const regionDoc = behaviorDoc?.parent;
    if (!type || regionDoc?.parent !== canvas.scene) return;

    refreshSuppressionForBehavior(type, ctx, { deferred: true });

    if (type === PARTICLE_TYPE || type === FILTER_TYPE) {
      const behaviorDocs = buildBehaviorHookSnapshot(regionDoc, behaviorDoc);
      syncRegionScopedEffects(regionDoc, { behaviorDocs });
      requestDeferredRegionScopedEffectsSync(regionDoc.id);
      ctx.scheduleOpenWindowsRefresh();
    }
  });

  Hooks.on("updateRegionBehavior", (behaviorDoc) => {
    const type = behaviorDoc?.type;
    const regionDoc = behaviorDoc?.parent;
    if (!type || regionDoc?.parent !== canvas.scene) return;

    refreshSuppressionForBehavior(type, ctx, { deferred: true });

    if (type === PARTICLE_TYPE || type === FILTER_TYPE) {
      const behaviorDocs = buildBehaviorHookSnapshot(regionDoc, behaviorDoc);
      syncRegionScopedEffects(regionDoc, { behaviorDocs });
      requestDeferredRegionScopedEffectsSync(regionDoc.id);
      ctx.scheduleOpenWindowsRefresh();
    }
  });

  Hooks.on("deleteRegionBehavior", (behaviorDoc) => {
    const type = behaviorDoc?.type;
    const regionDoc = behaviorDoc?.parent;
    if (!type || regionDoc?.parent !== canvas.scene) return;

    refreshSuppressionForBehavior(type, ctx, { deferred: true });

    if (type === PARTICLE_TYPE || type === FILTER_TYPE) {
      const behaviorDocs = buildBehaviorHookSnapshot(regionDoc, behaviorDoc, { deleted: true });
      syncRegionScopedEffects(regionDoc, { behaviorDocs });
      requestDeferredRegionScopedEffectsSync(regionDoc.id);
      ctx.scheduleOpenWindowsRefresh();
    }
  });
}
