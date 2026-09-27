/**
 * FXMaster: Scene Hooks
 *
 * Handles the `ready` one-shot, `updateScene` flag processing, and canvas pan/zoom mask refresh coordination.
 *
 * @module hooks/scene-hooks
 */

import { API_EFFECT_UPDATE_OPTIONS_FLAG, packageId } from "../constants.js";
import { logger } from "../logger.js";
import {
  coalesceNextFrame,
  getRegionEffectPlaceablesForCurrentView,
  hasActiveRadialRestrictWeatherTilesForMask,
  installCanvasPanAfterHook,
  syncActiveRadialRestrictWeatherTileMasksForCamera,
  updateSceneControlHighlights,
} from "../utils.js";
import {
  cleanupLegacyAnimationData,
  isEnabled,
  migrateDirectionConventionData,
  migrateParameterRangeData,
} from "../settings.js";
import { DIRECTION_CONVENTION_MIGRATION_VERSION } from "../migrations/direction-convention.js";
import { PARAMETER_RANGE_MIGRATION_VERSION } from "../migrations/parameter-ranges.js";
import { FilterEffectsSceneManager } from "../filter-effects/filter-effects-scene-manager.js";
import { invalidateEffectStackCache } from "../common/effect-stack.js";
import { SceneMaskManager } from "../common/base-effects-scene-manager.js";
import {
  ParticleEffectsRegionBehaviorConfig,
  SuppressSceneParticlesRegionBehaviorConfig,
} from "../particle-effects/particle-effects-region-config.js";
import {
  FilterEffectsRegionBehaviorConfig,
  SuppressSceneFiltersRegionBehaviorConfig,
} from "../filter-effects/filter-effects-region-config.js";

const PARTICLE_TYPE = `${packageId}.particleEffectsRegion`;
const FILTER_TYPE = `${packageId}.filterEffectsRegion`;
const SUPPRESS_SCENE_FILTERS = `${packageId}.suppressSceneFilters`;
const SUPPRESS_SCENE_PARTICLES = `${packageId}.suppressSceneParticles`;
const POST_CANVAS_PAN_RADIAL_FOLLOWUP_DELAY_MS = 10;

/**
 * Read one-shot API effect render options from the same scene update that changed the effect flags.
 *
 * When the internal flag object already exists, Foundry may diff only the changing nonce field on later updates. In that case, the current stored flag value is used as long as the update touched the flag path.
 *
 * @param {Scene} scene
 * @param {object} flat Flattened updateScene data.
 * @returns {boolean}
 */
function shouldSkipApiEffectFading(scene, flat) {
  const base = "flags." + packageId + "." + API_EFFECT_UPDATE_OPTIONS_FLAG;
  const touched = Object.keys(flat ?? {}).some((key) => key === base || key.startsWith(base + "."));
  if (!touched) return false;

  if (flat?.[base]?.skipFading === true) return true;
  if (flat?.[base]?.skipFading === false) return false;
  if (flat?.[base + ".skipFading"] === true) return true;
  if (flat?.[base + ".skipFading"] === false) return false;

  return scene?.getFlag?.(packageId, API_EFFECT_UPDATE_OPTIONS_FLAG)?.skipFading === true;
}

/**
 * Determine whether a scene update removed the scene-level Screen Shake filter row.
 *
 * @param {object} flat Flattened updateScene data.
 * @returns {boolean}
 */
function updateDeletesScreenShakeFilter(flat) {
  const entries = Object.entries(flat ?? {});
  const filtersFlag = `flags.${packageId}.filters`;
  const screenShakeFlag = `${filtersFlag}.core_screenShake`;
  const legacyDeleteFlag = `${filtersFlag}.-=core_screenShake`;
  const legacyUnsetFiltersFlag = `flags.${packageId}.-=filters`;

  for (const [key, value] of entries) {
    if (key === legacyDeleteFlag || key === legacyUnsetFiltersFlag) return true;
    if (key !== screenShakeFlag) continue;
    if (value === null || value === undefined) return true;
    if (value?.constructor?.name === "ForcedDeletion") return true;
  }

  return false;
}

/**
 * Rebuild active canvas runtimes after document migrations update stored effect data.
 *
 * @param {object} ctx - Shared hook context from {@link createHookContext}.
 * @returns {Promise<void>}
 */
async function refreshMigratedEffectRuntimes(ctx) {
  if (!isEnabled() || !canvas?.scene) return;

  invalidateEffectStackCache();

  try {
    await canvas.particleeffects?.drawParticleEffects?.({ soft: false });
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  try {
    await FilterEffectsSceneManager.instance.update({ skipFading: true });
    ctx.ensurePinned?.();
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  for (const region of getRegionEffectPlaceablesForCurrentView(canvas.scene)) {
    try {
      await canvas.particleeffects?.drawRegionParticleEffects?.(region, { soft: false });
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    try {
      await canvas.filtereffects?.drawRegionFilterEffects?.(region, { soft: false });
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  updateSceneControlHighlights();
  ctx.scheduleLayersWindowRefresh?.();
  ctx.scheduleOpenWindowsRefresh?.();
}

/**
 * Register scene update and camera hooks.
 *
 * @param {object} ctx - Shared hook context from {@link createHookContext}.
 */
export function registerSceneHooks(ctx) {
  Hooks.once("ready", async () => {
    const version = game.modules.get(packageId).version;
    if (game.settings.get(packageId, "releaseMessage") !== version && game.user.isGM) {
      const content = `
        <div class="fxmaster-announcement" style="border:4px solid #4A90E2; border-radius:6px; padding:12px;">
          <h3 style="margin:0;">🎉Welcome to Gambit's FXMaster V8.4.0!</h3>
            <p style="font-size: 1em;">Big Performance Improvements! This release has been primarily focused on performance, along with updates to a new set of effect image icons, a new region boundary avoidance parameter, and more!</p><p style="font-size: 1em;">Please check out the <a href= "https://github.com/gambit07/fxmaster/releases/latest" target="_blank" style="color: #dd6b20; text-decoration: none; font-weight: bold;">Release Notes</a> for more detail.</p><ul><li>If you'd like to support my development time and get access to these modules <ul><li><a href="https://foundryvtt.com/packages/fxmaster-plus" target="_blank" style="color: #CC66CC; text-decoration: none; font-weight: bold;">Gambit's FXMaster+</a></li><li><a href="https://foundryvtt.com/packages/gambitsGames" target="_blank" style="color: #CC66CC; text-decoration: none; font-weight: bold;">Gambit's Games</a></li><li><a href="https://foundryvtt.com/packages/gambitsAssetPreviewer" target="_blank" style="color: #CC66CC; text-decoration: none; font-weight: bold;">Gambit's Asset Previewer</a></li><li><a href="https://foundryvtt.com/packages/gambitsImageViewer" target="_blank" style="color: #CC66CC; text-decoration: none; font-weight: bold;">Gambit's Image Viewer</a></li></ul>Please consider supporting the project on <a href="https://patreon.com/GambitsLounge" target="_blank" style="color: #dd6b20; text-decoration: none; font-weight: bold;">Patreon</a>.</li><li><b>FXMaster+</b> adds an additional <b>20+</b> effects to FXMaster! FXMaster+ also allows you to quickly build your own Particle Effects for even more flexibility.</li><li>If you are a <b>NEW</b> FXMaster user: Checkout the <a href="#" data-fxmaster-action="open-overview" style="color: #52f3ff; text-decoration: none; font-weight: bold;">FXMaster Overview</a></li><li>If you have any questions about the module feel free to join the <a href= "https://discord.gg/YvxHrJ4tVu" target="_blank" style="color: #4e5d94; text-decoration: none; font-weight: bold;">Discord</a>!</li></ul></div>
      `;
      ChatMessage.create({ content });
      game.settings.set(packageId, "releaseMessage", version);
    }

    const sheetClasses = CONFIG?.RegionBehavior?.sheetClasses;
    if (sheetClasses) {
      const setSheet = (type, cls) => {
        sheetClasses[type] ??= {};
        sheetClasses[type]["core.RegionBehaviorConfig"] ??= {};
        sheetClasses[type]["core.RegionBehaviorConfig"].cls = cls;
      };
      setSheet(PARTICLE_TYPE, ParticleEffectsRegionBehaviorConfig);
      setSheet(SUPPRESS_SCENE_PARTICLES, SuppressSceneParticlesRegionBehaviorConfig);
      setSheet(FILTER_TYPE, FilterEffectsRegionBehaviorConfig);
      setSheet(SUPPRESS_SCENE_FILTERS, SuppressSceneFiltersRegionBehaviorConfig);
    }

    const directionVersionBefore =
      Number(game.settings.get(packageId, "directionConventionMigrationVersion") ?? 0) || 0;
    const parameterVersionBefore = Number(game.settings.get(packageId, "parameterRangeMigrationVersion") ?? 0) || 0;
    const migrationPending =
      directionVersionBefore < DIRECTION_CONVENTION_MIGRATION_VERSION ||
      parameterVersionBefore < PARAMETER_RANGE_MIGRATION_VERSION;

    await cleanupLegacyAnimationData();
    await migrateDirectionConventionData();
    await migrateParameterRangeData();

    if (migrationPending) await refreshMigratedEffectRuntimes(ctx);
  });

  Hooks.on("updateScene", async (scene, data) => {
    if (scene !== canvas.scene) return;

    const flat = foundry.utils.flattenObject(data ?? {});

    const effectsChanged = Object.keys(flat).some(
      (k) => k.startsWith(`flags.${packageId}.effects`) || k.startsWith(`flags.${packageId}.-=effects`),
    );

    const filtersChanged = Object.keys(flat).some(
      (k) => k.startsWith(`flags.${packageId}.filters`) || k.startsWith(`flags.${packageId}.-=filters`),
    );

    const stackChanged = Object.keys(flat).some(
      (k) => k.startsWith(`flags.${packageId}.stack`) || k.startsWith(`flags.${packageId}.-=stack`),
    );

    const skipFading = shouldSkipApiEffectFading(scene, flat);
    const screenShakeDeleted = filtersChanged && updateDeletesScreenShakeFilter(flat);

    if (effectsChanged || filtersChanged || stackChanged || data.active === true) invalidateEffectStackCache();

    if (effectsChanged) {
      if (isEnabled()) await canvas.particleeffects?.drawParticleEffects?.({ soft: !skipFading });
      ctx.requestSceneParticlesSuppressionRefresh();
    }

    if (filtersChanged) {
      if (isEnabled()) {
        await FilterEffectsSceneManager.instance.update({ skipFading });
        ctx.ensurePinned();
      }
    }

    const soundFxManualSelectionChanged = Object.keys(flat).some((k) => k.includes("soundFxManualSoundIds"));

    if (effectsChanged || filtersChanged || stackChanged || data.active === true) updateSceneControlHighlights();

    if (effectsChanged || filtersChanged || stackChanged) ctx.scheduleLayersWindowRefresh();
    if (soundFxManualSelectionChanged) ctx.schedulePairedSoundFxWindowsRefresh?.();
    if (screenShakeDeleted || data.active === true) ctx.scheduleOpenWindowsRefresh();

    if (data.width !== undefined || data.height !== undefined) {
      if (isEnabled()) {
        FilterEffectsSceneManager.instance.refreshViewMaskGeometry();
        try {
          canvas.filtereffects?.forceRegionMaskRefreshAll?.();
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        try {
          canvas.particleeffects?.refreshAboveSceneMask?.();
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        try {
          canvas.particleeffects?.refreshBelowTokensSceneMask?.();
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        ctx.requestSceneParticlesSuppressionRefresh();
        ctx.requestFilterSuppressionRefresh();
      }
    }
  });

  const requestViewMaskRefresh = coalesceNextFrame(
    function requestViewMaskRefresh() {
      if (!isEnabled()) return;

      const hasRadialRestriction = hasActiveRadialRestrictWeatherTilesForMask("all", {
        includeOffscreen: true,
      });
      const filterMaskNeedsRefresh =
        hasRadialRestriction || SceneMaskManager.instance.usesWorldAtlas?.("filters") !== true;
      const particleMaskNeedsRefresh =
        hasRadialRestriction || SceneMaskManager.instance.usesWorldAtlas?.("particles") !== true;

      const filterTickerHandlesCamera =
        !hasRadialRestriction && FilterEffectsSceneManager.instance.handlesCameraMaskRefresh === true;
      const particleTickerHandlesCamera =
        !hasRadialRestriction && canvas?.particleeffects?.handlesCameraMaskRefresh === true;
      if (ctx.sceneHasAnySceneFilters() && filterMaskNeedsRefresh && !filterTickerHandlesCamera) {
        ctx.requestFilterSuppressionRefresh();
      }
      if (ctx.sceneHasAnySceneParticles() && particleMaskNeedsRefresh && !particleTickerHandlesCamera) {
        ctx.requestSceneParticlesSuppressionRefresh();
      }
    },
    { key: "fxm:view:maskRefresh" },
  );

  let postCanvasPanRadialFollowupTimer = null;

  const schedulePostCanvasPanRadialFollowup = () => {
    if (postCanvasPanRadialFollowupTimer !== null) return;
    const setTimer = globalThis.setTimeout ?? setTimeout;
    postCanvasPanRadialFollowupTimer = setTimer(() => {
      postCanvasPanRadialFollowupTimer = null;
      runPostCanvasPanRadialSync({ dispatchPointerMove: false, scheduleFollowup: false });
    }, POST_CANVAS_PAN_RADIAL_FOLLOWUP_DELAY_MS);
  };

  const runPostCanvasPanRadialSync = ({ dispatchPointerMove = true, scheduleFollowup = true } = {}) => {
    if (!isEnabled()) return;
    if (!hasActiveRadialRestrictWeatherTilesForMask("all", { includeOffscreen: true })) return;

    try {
      syncActiveRadialRestrictWeatherTileMasksForCamera("all", {
        includeOffscreen: true,
        dispatchPointerMove,
      });
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    requestViewMaskRefresh();
    requestViewMaskRefresh.flush?.();

    if (scheduleFollowup) schedulePostCanvasPanRadialFollowup();
  };

  const requestPostCanvasPanRadialSync = () => runPostCanvasPanRadialSync();

  let postCanvasPanHookInstalled = installCanvasPanAfterHook(requestPostCanvasPanRadialSync);

  const handleCanvasViewChange = () => {
    if (!isEnabled()) return;

    if (postCanvasPanHookInstalled && hasActiveRadialRestrictWeatherTilesForMask("all", { includeOffscreen: true })) {
      return;
    }

    requestViewMaskRefresh();
  };

  Hooks.on("canvasPan", handleCanvasViewChange);

  Hooks.once("ready", () => {
    if (!postCanvasPanHookInstalled) {
      postCanvasPanHookInstalled = installCanvasPanAfterHook(requestPostCanvasPanRadialSync);
    }
  });
}
