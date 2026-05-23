/**
 * FXMaster: Region & Behavior Hooks
 *
 * Registers Foundry hooks for region and region-behavior CRUD events. Handles particle and filter effect drawing, suppression mask updates, and the FXMaster-specific switchParticleEffect and updateParticleEffects hooks.
 *
 * @module hooks/region-hooks
 */

import { packageId } from "../constants.js";
import { logger } from "../logger.js";
import {
  coalesceNextFrame,
  getRegionPlaceableOrDocumentAdapter,
  getSceneRegionDocumentById,
  regionDocumentCanApplyInCurrentView,
  onSwitchParticleEffects,
  onUpdateParticleEffects,
  fxmDocumentId,
} from "../utils.js";
import { isEnabled } from "../settings.js";
import { invalidateEffectStackCache } from "../common/effect-stack.js";

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
    const id = fxmDocumentId(doc) || null;
    if (id != null) byId.set(String(id), doc);
    else byId.set(Symbol("behavior"), doc);
  }

  const hookId = fxmDocumentId(behaviorDoc) || null;
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

  if (!regionDocumentCanApplyInCurrentView(placeable?.document ?? null, canvas?.scene ?? null)) {
    try {
      canvas.particleeffects?.destroyRegionParticleEffects?.(placeable.id);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      canvas.filtereffects?.destroyRegionFilterEffects?.(placeable.id);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    return;
  }

  try {
    const layer = canvas.particleeffects;
    if (typeof layer?.requestRegionMaskRefresh === "function") layer.requestRegionMaskRefresh(placeable.id);
    else layer?.forceRegionMaskRefresh?.(placeable.id);
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  try {
    canvas.particleeffects?.applyElevationGateForAll?.();
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  try {
    const layer = canvas.filtereffects;
    if (typeof layer?.requestRegionMaskRefresh === "function") layer.requestRegionMaskRefresh(placeable.id);
    else layer?.forceRegionMaskRefresh?.(placeable.id);
  } catch (err) {
    logger.debug("FXMaster:", err);
  }
}

/**
 * Normalize a Region-local sync request into particle/filter booleans.
 *
 * @param {{ particles?: boolean, filters?: boolean }|null|undefined} kinds
 * @returns {{ particles: boolean, filters: boolean }}
 * @private
 */
function normalizeRegionScopedSyncKinds(kinds = null) {
  if (!kinds) return { particles: true, filters: true };
  return {
    particles: kinds.particles !== false,
    filters: kinds.filters !== false,
  };
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
function syncRegionScopedEffects(regionDoc, { behaviorDocs = null, kinds = null } = {}) {
  if (regionDoc?.parent !== canvas.scene) return;

  const syncKinds = normalizeRegionScopedSyncKinds(kinds);
  if (!syncKinds.particles && !syncKinds.filters) return;

  if (!regionDocumentCanApplyInCurrentView(regionDoc, canvas?.scene ?? null)) {
    if (syncKinds.particles) {
      try {
        canvas.particleeffects?.destroyRegionParticleEffects?.(regionDoc?.id);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
    if (syncKinds.filters) {
      try {
        canvas.filtereffects?.destroyRegionFilterEffects?.(regionDoc?.id);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
    return;
  }

  const placeable = getRegionPlaceableOrDocumentAdapter(regionDoc);
  if (!placeable) return;

  const snapshot = normalizeRegionBehaviorDocs(behaviorDocs ?? regionDoc?.behaviors);
  const enabled = isEnabled();
  const hasParticleBehavior = snapshot.some((behavior) => behavior?.type === PARTICLE_TYPE && !behavior?.disabled);
  const hasFilterBehavior = snapshot.some((behavior) => behavior?.type === FILTER_TYPE && !behavior?.disabled);

  if (syncKinds.particles && enabled && hasParticleBehavior) {
    canvas.particleeffects?.drawRegionParticleEffects?.(placeable, {
      soft: false,
      behaviorDocs: snapshot,
    });
  } else if (syncKinds.particles) {
    try {
      canvas.particleeffects?.destroyRegionParticleEffects?.(regionDoc.id);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  if (syncKinds.filters && enabled && hasFilterBehavior) {
    canvas.filtereffects?.drawRegionFilterEffects?.(placeable, {
      soft: false,
      behaviorDocs: snapshot,
    });
  } else if (syncKinds.filters) {
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
 * Return whether a Region document update requires rebuilding Region-local particle/filter instances instead of just refreshing masks and gates. Shape edits are handled by mask refreshes; Level/elevation ownership changes need a rebuild so stack-row Level metadata is current.
 *
 * @param {object} [changed]
 * @returns {boolean}
 * @private
 */
function regionUpdateRequiresRegionEffectRebuild(changed = {}) {
  if (!changed || typeof changed !== "object") return false;
  for (const key of ["levels", "level", "elevation", "shapes"]) {
    if (Object.prototype.hasOwnProperty.call(changed, key)) return true;
  }
  return false;
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
 * Determine which scene-suppression pipelines can be affected by a Region's enabled behaviors.
 *
 * @param {foundry.documents.RegionDocument|object|null} regionDoc
 * @param {{ behaviorDocs?: Iterable<object>|object[]|null }} [options]
 * @returns {{ particles: boolean, filters: boolean }}
 * @private
 */
function getRegionSuppressionRefreshKinds(regionDoc, { behaviorDocs = null } = {}) {
  const kinds = { particles: false, filters: false };
  const behaviors = normalizeRegionBehaviorDocs(behaviorDocs ?? regionDoc?.behaviors);

  for (const behavior of behaviors) {
    if (!behavior || behavior.disabled) continue;
    if (behavior.type === SUPPRESS_WEATHER) {
      kinds.particles = true;
      kinds.filters = true;
    } else if (behavior.type === SUPPRESS_SCENE_PARTICLES) {
      kinds.particles = true;
    } else if (behavior.type === SUPPRESS_SCENE_FILTERS) {
      kinds.filters = true;
    }

    if (kinds.particles && kinds.filters) break;
  }

  return kinds;
}

/**
 * Refresh only the scene-suppression pipelines touched by a Region document.
 *
 * @param {foundry.documents.RegionDocument|object|null} regionDoc
 * @param {object} ctx
 * @param {{ deferred?: boolean, behaviorDocs?: Iterable<object>|object[]|null }} [options]
 * @returns {void}
 * @private
 */
function refreshSuppressionForRegion(regionDoc, ctx, { deferred = false, behaviorDocs = null } = {}) {
  const kinds = getRegionSuppressionRefreshKinds(regionDoc, { behaviorDocs });
  const requestParticles = deferred
    ? ctx.requestDeferredSceneParticlesSuppressionRefresh
    : ctx.requestSceneParticlesSuppressionRefresh;
  const requestFilters = deferred ? ctx.requestDeferredFilterSuppressionRefresh : ctx.requestFilterSuppressionRefresh;

  if (kinds.particles) requestParticles?.();
  if (kinds.filters) requestFilters?.();
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
    const pendingBehaviorSnapshots = new Map();
    const pendingSyncKinds = new Map();
    const run = coalesceNextFrame(
      () => {
        const ids = [...pendingRegionIds];
        const snapshots = new Map(pendingBehaviorSnapshots);
        const kindsByRegion = new Map(pendingSyncKinds);
        pendingRegionIds.clear();
        pendingBehaviorSnapshots.clear();
        pendingSyncKinds.clear();

        for (const regionId of ids) {
          const regionDoc = getSceneRegionDocumentById(regionId, canvas?.scene ?? null);
          if (!regionDoc) continue;
          const behaviorDocs = snapshots.has(regionId) ? snapshots.get(regionId) : null;
          const kinds = kindsByRegion.get(regionId) ?? null;
          syncRegionScopedEffects(regionDoc, { behaviorDocs, kinds });
        }
      },
      { key: "fxm:deferredRegionScopedEffectsSync" },
    );

    return (regionId, behaviorDocs = null, kinds = null) => {
      if (!regionId) return;
      pendingRegionIds.add(regionId);
      if (behaviorDocs !== null) pendingBehaviorSnapshots.set(regionId, normalizeRegionBehaviorDocs(behaviorDocs));
      if (kinds) {
        const prev = pendingSyncKinds.get(regionId) ?? { particles: false, filters: false };
        pendingSyncKinds.set(regionId, {
          particles: !!prev.particles || kinds.particles !== false,
          filters: !!prev.filters || kinds.filters !== false,
        });
      }
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

    invalidateEffectStackCache();
    syncRegionScopedEffects(regionDoc);
    refreshSuppressionForRegion(regionDoc, ctx);
    ctx.scheduleOpenWindowsRefresh();
  });

  Hooks.on("deleteRegion", (regionDoc) => {
    if (regionDoc?.parent !== canvas.scene) return;

    invalidateEffectStackCache();
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

    refreshSuppressionForRegion(regionDoc, ctx);
    ctx.scheduleOpenWindowsRefresh();
  });

  Hooks.on("updateRegion", (regionDoc, changed) => {
    if (regionDoc?.parent !== canvas.scene) return;
    if (isFxmasterBehaviorDrivenRegionUpdate(changed)) return;

    invalidateEffectStackCache();

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
    } else if (regionUpdateRequiresRegionEffectRebuild(changed)) {
      syncRegionScopedEffects(regionDoc);
    } else {
      const placeable = canvas?.regions?.get?.(regionDoc.id) ?? getRegionPlaceableOrDocumentAdapter(regionDoc);
      refreshRegionEffects(placeable);
    }

    refreshSuppressionForRegion(regionDoc, ctx);
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

    invalidateEffectStackCache();
    refreshSuppressionForBehavior(type, ctx, { deferred: true });

    if (type === PARTICLE_TYPE || type === FILTER_TYPE) {
      const behaviorDocs = buildBehaviorHookSnapshot(regionDoc, behaviorDoc);
      requestDeferredRegionScopedEffectsSync(regionDoc.id, behaviorDocs, {
        particles: type === PARTICLE_TYPE,
        filters: type === FILTER_TYPE,
      });
      ctx.scheduleOpenWindowsRefresh();
    }
  });

  Hooks.on("updateRegionBehavior", (behaviorDoc) => {
    const type = behaviorDoc?.type;
    const regionDoc = behaviorDoc?.parent;
    if (!type || regionDoc?.parent !== canvas.scene) return;

    invalidateEffectStackCache();
    refreshSuppressionForBehavior(type, ctx, { deferred: true });

    if (type === PARTICLE_TYPE || type === FILTER_TYPE) {
      const behaviorDocs = buildBehaviorHookSnapshot(regionDoc, behaviorDoc);
      requestDeferredRegionScopedEffectsSync(regionDoc.id, behaviorDocs, {
        particles: type === PARTICLE_TYPE,
        filters: type === FILTER_TYPE,
      });
      ctx.scheduleOpenWindowsRefresh();
    }
  });

  Hooks.on("deleteRegionBehavior", (behaviorDoc) => {
    const type = behaviorDoc?.type;
    const regionDoc = behaviorDoc?.parent;
    if (!type || regionDoc?.parent !== canvas.scene) return;

    invalidateEffectStackCache();
    refreshSuppressionForBehavior(type, ctx, { deferred: true });

    if (type === PARTICLE_TYPE || type === FILTER_TYPE) {
      const behaviorDocs = buildBehaviorHookSnapshot(regionDoc, behaviorDoc, { deleted: true });
      requestDeferredRegionScopedEffectsSync(regionDoc.id, behaviorDocs, {
        particles: type === PARTICLE_TYPE,
        filters: type === FILTER_TYPE,
      });
      ctx.scheduleOpenWindowsRefresh();
    }
  });
}
