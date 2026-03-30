/**
 * FXMaster: Hook Context
 *
 * Shared mutable state and helper functions consumed by the domain-specific hook registrars. Created once by {@link registerHooks} and passed to each sub-registrar so that all hooks share a single consistent state object without relying on a monolithic closure.
 *
 * @module hooks/context
 */

import { packageId } from "../constants.js";
import { logger } from "../logger.js";
import { coalesceNextFrame, getCssViewportMetrics } from "../utils.js";
import { isEnabled } from "../settings.js";
import { refreshSceneParticlesSuppressionMasks } from "../particle-effects/particle-effects-scene-manager.js";
import { FilterEffectsSceneManager } from "../filter-effects/filter-effects-scene-manager.js";

/**
 * Build and return the shared hook context object.
 *
 * This factory is called once from {@link registerHooks}. The returned context is then passed to each domain-specific registrar.
 *
 * @returns {object} The shared hook context.
 */
export function createHookContext() {
  /** @type {Set<Application>} Open Particle Effects Management windows. */
  const openPFx = new Set();
  /** @type {Set<Application>} Open Filter Effects Management windows. */
  const openFFx = new Set();
  /** @type {Set<Application>} Open API Effects Management windows. */
  const openAFx = new Set();

  /** Resize handler references for cleanup. */
  const resizeHandlers = { _fmResizeHandler: null, _flResizeHandler: null, _fxResizeHandler: null };

  const sceneHasAnySceneFilters = () => {
    try {
      const f = canvas?.scene?.getFlag?.(packageId, "filters") ?? {};
      return !!f && Object.keys(f).length > 0;
    } catch {
      return false;
    }
  };

  const sceneHasAnySceneParticles = () => {
    try {
      const e = canvas?.scene?.getFlag?.(packageId, "effects") ?? {};
      return !!e && Object.keys(e).length > 0;
    } catch {
      return false;
    }
  };

  /**
   * Cache for scene-level below-tokens queries derived from scene flags.
   *
   * Region-level below-tokens requirements are computed from live layer state and are intentionally not cached.
   * Region behavior state can change without a scene flag update (for example: region effects created during canvasReady, soft redraws, or module toggles).
   *
   * @type {{sceneFilters: boolean|null, sceneParticles: boolean|null}}
   */
  const belowTokensCache = {
    sceneFilters: null,
    sceneParticles: null,
  };

  /**
   * Invalidate cached scene-level below-tokens query results.
   */
  const invalidateBelowTokensCache = () => {
    belowTokensCache.sceneFilters = null;
    belowTokensCache.sceneParticles = null;
  };

  /**
   * Determine whether any scene-level filter effects require below-tokens cutouts.
   *
   * @returns {boolean}
   */
  const sceneWantsBelowTokensFilters = () => {
    if (belowTokensCache.sceneFilters !== null) return belowTokensCache.sceneFilters;
    try {
      const infos = canvas?.scene?.getFlag?.(packageId, "filters") ?? {};
      for (const v of Object.values(infos)) {
        const bt = v?.options?.belowTokens;
        if (bt === true) {
          belowTokensCache.sceneFilters = true;
          return true;
        }
        if (bt && typeof bt === "object" && "value" in bt && bt.value === true) {
          belowTokensCache.sceneFilters = true;
          return true;
        }
      }
      belowTokensCache.sceneFilters = false;
      return false;
    } catch {
      return false;
    }
  };

  /**
   * Determine whether any scene-level particle effects require below-tokens cutouts.
   *
   * @returns {boolean}
   */
  const sceneWantsBelowTokensParticles = () => {
    if (belowTokensCache.sceneParticles !== null) return belowTokensCache.sceneParticles;
    try {
      const infos = canvas?.scene?.getFlag?.(packageId, "effects") ?? {};
      for (const v of Object.values(infos)) {
        const bt = v?.options?.belowTokens;
        if (bt === true) {
          belowTokensCache.sceneParticles = true;
          return true;
        }
        if (bt && typeof bt === "object" && "value" in bt && bt.value === true) {
          belowTokensCache.sceneParticles = true;
          return true;
        }
      }
      belowTokensCache.sceneParticles = false;
      return false;
    } catch {
      return false;
    }
  };

  /**
   * Determine whether any region filter effects require below-tokens cutouts.
   *
   * This value is computed from live layer state and is not cached.
   *
   * @returns {boolean}
   */
  const regionWantsBelowTokensFilters = () => {
    try {
      const rm = canvas?.filtereffects?.regionMasks;
      if (!rm || !rm.size) return false;
      for (const entry of rm.values()) {
        for (const f of entry?.filters ?? []) {
          if (f?.__fxmBelowTokens) return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  };

  /**
   * Determine whether any region particle effects require below-tokens cutouts.
   *
   * This value is computed from live layer state and is not cached.
   *
   * @returns {boolean}
   */
  const regionWantsBelowTokensParticles = () => {
    try {
      const re = canvas?.particleeffects?.regionEffects;
      if (!re || !re.size) return false;
      for (const entries of re.values()) {
        for (const e of entries ?? []) {
          const fx = e?.fx ?? e;
          if (fx?.__fxmBelowTokens) return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  };

  /* ---- Coalesced refresh helpers ---- */

  const requestFilterSuppressionRefresh = () => {
    invalidateBelowTokensCache();
    if (isEnabled()) FilterEffectsSceneManager.instance.refreshSceneFilterSuppressionMasks();
  };

  /**
   * Request a deferred scene-filter suppression refresh on the next animation frame.
   * RegionBehavior CRUD can observe a newer region document than the live Region placeable tree.
   */
  const requestDeferredFilterSuppressionRefresh = coalesceNextFrame(
    function requestDeferredFilterSuppressionRefresh() {
      requestFilterSuppressionRefresh();
    },
    { key: "fxm:deferredFilterSuppressionRefresh" },
  );

  const requestRegionMaskRefreshAll = () => {
    if (!isEnabled()) return;
    try {
      canvas.filtereffects?.forceRegionMaskRefreshAll?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  };

  const requestSceneParticlesSuppressionRefresh = () => {
    invalidateBelowTokensCache();
    try {
      refreshSceneParticlesSuppressionMasks?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  };

  /**
   * Request a deferred scene-particle suppression refresh on the next animation frame.
   * RegionBehavior CRUD can observe a newer region document than the live Region placeable tree.
   */
  const requestDeferredSceneParticlesSuppressionRefresh = coalesceNextFrame(
    function requestDeferredSceneParticlesSuppressionRefresh() {
      requestSceneParticlesSuppressionRefresh();
    },
    { key: "fxm:deferredSceneParticlesSuppressionRefresh" },
  );

  const requestTokenMaskRefresh = coalesceNextFrame(
    function requestTokenMaskRefresh() {
      if (!isEnabled()) return;

      const needFilterTokens = sceneWantsBelowTokensFilters() || regionWantsBelowTokensFilters();
      const needParticleTokens = sceneWantsBelowTokensParticles() || regionWantsBelowTokensParticles();

      if (needFilterTokens) {
        try {
          FilterEffectsSceneManager.instance.refreshSceneFilterSuppressionMasks();
        } catch (err) {
          logger.debug("FXMaster:", err);
        }

        try {
          canvas.filtereffects?.notifyTokensChanged?.();
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }

      if (needParticleTokens) {
        try {
          refreshSceneParticlesSuppressionMasks?.();
        } catch (err) {
          logger.debug("FXMaster:", err);
        }

        try {
          canvas.particleeffects?.notifyTokensChanged?.();
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }
    },
    { key: "fxm:token:maskRefresh" },
  );

  /* ---- Filter-area pinning ---- */

  const pinEnvFilterArea = () => {
    const env = canvas?.environment;
    if (!env) return;
    const { rect: cssRect } = getCssViewportMetrics();
    const fa = env.filterArea instanceof PIXI.Rectangle ? env.filterArea : new PIXI.Rectangle();
    fa.copyFrom(cssRect);
    try {
      env.filterArea = fa;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  };

  const clearEnvFilterArea = () => {
    try {
      if (canvas?.environment) canvas.environment.filterArea = null;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  };

  const ensurePinned = () => {
    const hasFilters = Array.isArray(canvas?.environment?.filters) && canvas.environment.filters.length > 0;
    if (isEnabled() && hasFilters) pinEnvFilterArea();
    else clearEnvFilterArea();
  };

  let _resize;
  const bind = () => {
    if (_resize && canvas?.app?.renderer) canvas.app.renderer.off("resize", _resize);
    _resize = () => ensurePinned();
    canvas?.app?.renderer?.on?.("resize", _resize);
    ensurePinned();
  };
  const unbind = () => {
    try {
      if (_resize && canvas?.app?.renderer) canvas.app.renderer.off("resize", _resize);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    _resize = null;
  };

  /* ---- Management window tracking ---- */

  const refreshOpenFxMasterWindows = ({ hard = false } = {}) => {
    for (const app of [...openPFx, ...openFFx, ...openAFx]) {
      try {
        app.render(!hard);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
  };

  const scheduleOpenWindowsRefresh = coalesceNextFrame(
    function scheduleOpenWindowsRefresh() {
      refreshOpenFxMasterWindows({ hard: true });
    },
    { key: "fxm:openWindowsRefresh" },
  );

  const requestRedrawAllRegionParticles = coalesceNextFrame(
    function requestRedrawAllRegionParticles() {
      if (!isEnabled()) return;
      try {
        for (const reg of canvas.regions.placeables) {
          canvas.particleeffects?.drawRegionParticleEffects?.(reg, { soft: false });
        }
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    },
    { key: "fxm:redrawAllRegionParticles" },
  );

  return {
    openPFx,
    openFFx,
    openAFx,
    resizeHandlers,
    sceneHasAnySceneFilters,
    sceneHasAnySceneParticles,
    invalidateBelowTokensCache,
    sceneWantsBelowTokensFilters,
    sceneWantsBelowTokensParticles,
    regionWantsBelowTokensFilters,
    regionWantsBelowTokensParticles,
    requestFilterSuppressionRefresh,
    requestDeferredFilterSuppressionRefresh,
    requestRegionMaskRefreshAll,
    requestSceneParticlesSuppressionRefresh,
    requestDeferredSceneParticlesSuppressionRefresh,
    requestTokenMaskRefresh,
    bind,
    unbind,
    ensurePinned,
    scheduleOpenWindowsRefresh,
    requestRedrawAllRegionParticles,
  };
}
