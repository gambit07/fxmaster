/**
 * FXMaster: Canvas Lifecycle Hooks
 *
 * Handles canvasInit, canvasReady, and activateScene - the core lifecycle events that set up and tear down FXMaster's rendering pipeline.
 *
 * @module hooks/canvas-hooks
 */

import { logger } from "../logger.js";
import {
  clearCoalesceMap,
  getRegionEffectPlaceablesForCurrentView,
  syncCanvasLiveLevelSurfaceState,
} from "../utils.js";
import { isEnabled } from "../settings.js";
import { SceneMaskManager } from "../common/base-effects-scene-manager.js";
import { FilterEffectsSceneManager } from "../filter-effects/filter-effects-scene-manager.js";
import { invalidateEffectStackCache } from "../common/effect-stack.js";

function runPostCanvasReadyMaskRefresh(ctx) {
  if (!isEnabled() || !canvas?.ready) return;

  try {
    invalidateEffectStackCache();
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  try {
    ctx.invalidateBelowTokensCache?.();
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  try {
    syncCanvasLiveLevelSurfaceState?.();
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  try {
    FilterEffectsSceneManager.instance.refreshViewMaskGeometry();
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  try {
    SceneMaskManager.instance.refreshTokensSync?.({ force: true, presyncedDynamicCoverage: true });
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  try {
    SceneMaskManager.instance.refreshSync?.("all");
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  try {
    canvas.filtereffects?.forceRegionMaskRefreshAll?.();
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  try {
    canvas.filtereffects?.refreshCoverageCutoutsSync?.({ refreshSharedMasks: true });
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  try {
    canvas.particleeffects?.forceRegionMaskRefreshAll?.();
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  try {
    canvas.particleeffects?.refreshCoverageCutoutsSync?.({ refreshSharedMasks: true });
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  try {
    ctx.requestFilterSuppressionRefresh?.();
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  try {
    ctx.requestSceneParticlesSuppressionRefresh?.();
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  try {
    ctx.requestTokenMaskRefresh?.();
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  try {
    canvas.particleeffects?.refreshAboveSceneMask?.();
  } catch (err) {
    logger.debug("FXMaster:", err);
  }
}

function schedulePostCanvasReadyMaskRefresh(ctx) {
  const frameDelays = [1, 3, 8];
  for (const frames of frameDelays) {
    let remaining = frames;
    const step = () => {
      if (!canvas?.ready) return;
      remaining -= 1;
      if (remaining > 0) {
        requestAnimationFrame(step);
        return;
      }
      runPostCanvasReadyMaskRefresh(ctx);
    };
    requestAnimationFrame(step);
  }
}

/**
 * Register canvas lifecycle hooks.
 *
 * @param {object} ctx - Shared hook context from {@link createHookContext}.
 */
export function registerCanvasHooks(ctx) {
  Hooks.on("canvasInit", async () => {
    invalidateEffectStackCache();

    /**
     * Clear stale coalesce entries that may reference destroyed PIXI objects from the previous canvas lifecycle.
     */
    clearCoalesceMap();

    /** Invalidate cached below-object results for the new canvas. */
    ctx.invalidateBelowTokensCache();

    /**
     * Reset the shared SceneMaskManager so stale RenderTexture references from the previous canvas do not survive across scene transitions.
     */
    try {
      SceneMaskManager.reset();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    if (isEnabled()) {
      try {
        await FilterEffectsSceneManager.instance.clear();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
    try {
      if (ctx.resizeHandlers._fmResizeHandler && globalThis.canvas?.app?.renderer) {
        globalThis.canvas.app.renderer.off("resize", ctx.resizeHandlers._fmResizeHandler);
      }
      if (ctx.resizeHandlers._flResizeHandler && globalThis.canvas?.app?.renderer) {
        globalThis.canvas.app.renderer.off("resize", ctx.resizeHandlers._flResizeHandler);
      }
      if (ctx.resizeHandlers._fxResizeHandler && globalThis.canvas?.app?.renderer) {
        globalThis.canvas.app.renderer.off("resize", ctx.resizeHandlers._fxResizeHandler);
      }
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    ctx.resizeHandlers._fmResizeHandler = null;
    ctx.resizeHandlers._flResizeHandler = null;
    ctx.resizeHandlers._fxResizeHandler = null;

    try {
      ctx.unbind();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  });

  Hooks.on("activateScene", () => {
    invalidateEffectStackCache();
    ctx.scheduleOpenWindowsRefresh();
    if (isEnabled()) {
      ctx.requestSceneParticlesSuppressionRefresh();
      ctx.requestRegionMaskRefreshAll();
      ctx.requestTokenMaskRefresh();
      try {
        canvas.particleeffects?.refreshAboveSceneMask?.();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
  });

  Hooks.on("canvasReady", async () => {
    invalidateEffectStackCache();
    const enabled = isEnabled();

    if (enabled) {
      await FilterEffectsSceneManager.instance.activate();
      try {
        if (ctx.resizeHandlers._fmResizeHandler && canvas?.app?.renderer)
          canvas.app.renderer.off("resize", ctx.resizeHandlers._fmResizeHandler);
        ctx.resizeHandlers._fmResizeHandler = () => {
          try {
            FilterEffectsSceneManager.instance.refreshViewMaskGeometry();
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
          ctx.requestFilterSuppressionRefresh();
        };
        canvas?.app?.renderer?.on?.("resize", ctx.resizeHandlers._fmResizeHandler);

        if (ctx.resizeHandlers._flResizeHandler && canvas?.app?.renderer)
          canvas.app.renderer.off("resize", ctx.resizeHandlers._flResizeHandler);
        ctx.resizeHandlers._flResizeHandler = () => {
          try {
            canvas.filtereffects?.forceRegionMaskRefreshAll?.();
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
        };
        canvas?.app?.renderer?.on?.("resize", ctx.resizeHandlers._flResizeHandler);

        if (ctx.resizeHandlers._fxResizeHandler && canvas?.app?.renderer)
          canvas.app.renderer.off("resize", ctx.resizeHandlers._fxResizeHandler);
        ctx.resizeHandlers._fxResizeHandler = () => {
          try {
            if (ctx.sceneHasAnySceneParticles()) ctx.requestSceneParticlesSuppressionRefresh();
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
          try {
            canvas.particleeffects?.forceRegionMaskRefreshAll?.();
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
          try {
            canvas.particleeffects?.refreshAboveSceneMask?.();
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
        };
        canvas?.app?.renderer?.on?.("resize", ctx.resizeHandlers._fxResizeHandler);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    if (enabled) {
      for (const region of getRegionEffectPlaceablesForCurrentView(canvas?.scene ?? null)) {
        try {
          canvas.particleeffects?.drawRegionParticleEffects?.(region, { soft: false });
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        try {
          canvas.filtereffects?.drawRegionFilterEffects?.(region, { soft: false });
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }
    }

    if (enabled) {
      try {
        FilterEffectsSceneManager.instance.refreshViewMaskGeometry();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      try {
        canvas.filtereffects?.forceRegionMaskRefreshAll?.();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      try {
        ctx.requestSceneParticlesSuppressionRefresh();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      try {
        canvas.particleeffects?.forceRegionMaskRefreshAll?.();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      try {
        canvas.particleeffects?.refreshAboveSceneMask?.();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    try {
      const needFilterCoverage =
        ctx.sceneWantsBelowTokensFilters() ||
        ctx.sceneWantsBelowTilesFilters() ||
        ctx.regionWantsBelowTokensFilters() ||
        ctx.regionWantsBelowTilesFilters();
      const needParticleCoverage =
        ctx.sceneWantsBelowTokensParticles() ||
        ctx.sceneWantsBelowTilesParticles() ||
        ctx.regionWantsBelowTokensParticles() ||
        ctx.regionWantsBelowTilesParticles();
      if (needFilterCoverage) SceneMaskManager.instance.refreshSync?.("filters");
      if (needParticleCoverage) SceneMaskManager.instance.refreshSync?.("particles");
      if (needFilterCoverage || needParticleCoverage) ctx.requestTokenMaskRefresh();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    if (enabled) {
      try {
        ctx.bind();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    } else {
      try {
        ctx.unbind();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    schedulePostCanvasReadyMaskRefresh(ctx);
    ctx.scheduleOpenWindowsRefresh();
  });
}
