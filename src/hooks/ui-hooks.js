/**
 * FXMaster: UI & Window Hooks
 *
 * Tracks open management windows, updates scene control button highlights, and handles settings changes and resize events.
 *
 * @module hooks/ui-hooks
 */

import { packageId } from "../constants.js";
import { logger } from "../logger.js";
import { coalesceNextFrame, updateSceneControlHighlights } from "../utils.js";
import { isEnabled } from "../settings.js";

/**
 * Register UI lifecycle hooks.
 *
 * @param {object} ctx - Shared hook context from {@link createHookContext}.
 */
export function registerUIHooks(ctx) {
  Hooks.on("renderParticleEffectsManagement", (app) => {
    ctx.openPFx.add(app);
  });
  Hooks.on("closeParticleEffectsManagement", (app) => {
    ctx.openPFx.delete(app);
  });
  Hooks.on("renderFilterEffectsManagement", (app) => {
    ctx.openFFx.add(app);
  });
  Hooks.on("closeFilterEffectsManagement", (app) => {
    ctx.openFFx.delete(app);
  });
  Hooks.on("renderApiEffectsManagement", (app) => {
    ctx.openAFx.add(app);
  });
  Hooks.on("closeApiEffectsManagement", (app) => {
    ctx.openAFx.delete(app);
  });

  Hooks.on("renderFxLayersManagement", (app) => {
    ctx.openLFx.add(app);
  });
  Hooks.on("closeFxLayersManagement", (app) => {
    ctx.openLFx.delete(app);
  });

  Hooks.on("updateSetting", (setting) => {
    if (setting?.key !== `${packageId}.enable`) return;
    try {
      if (isEnabled()) ctx.bind();
      else ctx.unbind();
      ctx.requestFilterSuppressionRefresh();
      ctx.requestSceneParticlesSuppressionRefresh();
      ctx.requestRegionMaskRefreshAll();
      ctx.scheduleOpenWindowsRefresh();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  });

  const scheduleSceneControlHighlights = coalesceNextFrame(
    function scheduleSceneControlHighlights() {
      try {
        updateSceneControlHighlights();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    },
    { key: "fxm:sceneControlHighlights" },
  );

  Hooks.on("renderSceneControls", () => {
    try {
      updateSceneControlHighlights();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  });

  Hooks.on("canvasReady", () => scheduleSceneControlHighlights());
  Hooks.on("activateScene", () => scheduleSceneControlHighlights());
}
