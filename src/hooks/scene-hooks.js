/**
 * FXMaster: Scene Hooks
 *
 * Handles the `ready` one-shot, `updateScene` flag processing, and canvas pan/zoom mask refresh coordination.
 *
 * @module hooks/scene-hooks
 */

import { API_EFFECT_UPDATE_OPTIONS_FLAG, packageId } from "../constants.js";
import { logger } from "../logger.js";
import { coalesceNextFrame, updateSceneControlHighlights } from "../utils.js";
import { cleanupLegacyAnimationData, isEnabled } from "../settings.js";
import { FilterEffectsSceneManager } from "../filter-effects/filter-effects-scene-manager.js";
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

/**
 * Read one-shot API effect render options from the same scene update that changed the effect flags.
 *
 * When the internal flag object already exists, Foundry may diff only the changing nonce field on later updates.
 * In that case, the current stored flag value is used as long as the update touched the flag path.
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
          <h3 style="margin:0;">🎉Welcome to Gambit's FXMaster V8.0.2!</h3>
            <p style="font-size: 1em;">Tons of great new features in V8 to make your effects more customizable than ever, including Level specific placement, a new Layer Manager tool for ordering effect layers, new Macro functionality, and more! If you run into any issues please join the Discord below and report them! *8.0.2: Small bugfix for some full white particle effect overlays occurring in V13. Also please check out the <a href= "https://github.com/gambit07/fxmaster/releases/latest" target="_blank" style="color: #dd6b20; text-decoration: none; font-weight: bold;">Release Notes</a> for more detail.</p>
            <p style="font-size: 1em;">If you'd like to support my development time and get access to the <a href="https://foundryvtt.com/packages/fxmaster-plus" target="_blank" style="color: #CC66CC; text-decoration: none; font-weight: bold;">Gambit's FXMaster+</a>, <a href="https://foundryvtt.com/packages/gambitsAssetPreviewer" target="_blank" style="color: #CC66CC; text-decoration: none; font-weight: bold;">Gambit's Asset Previewer</a>, and <a href="https://foundryvtt.com/packages/gambitsImageViewer" target="_blank" style="color: #CC66CC; text-decoration: none; font-weight: bold;">Gambit's Image Viewer</a> modules, please consider supporting the project on <a href="https://patreon.com/GambitsLounge" target="_blank" style="color: #dd6b20; text-decoration: none; font-weight: bold;">Patreon</a>.</p><p>FXMaster+ Effects: <ul><li><span style="color: #535353; text-decoration: none; font-weight: bold;">Wind</span></li><li><span style="color: #6e6e6e; text-decoration: none; font-weight: bold;">Wind Wisps</span></li><li><span style="color: #3276c4; text-decoration: none; font-weight: bold;">Water</span></li><li><span style="color: #7c7c7c; text-decoration: none; font-weight: bold;">Lightning Bolts</span></li><li><span style="color: #0ada64; text-decoration: none; font-weight: bold;">Glitch</span></li><li><span style="color: #017371; text-decoration: none; font-weight: bold;">Fish</span></li><li><span style="color: #3bd1ffff; text-decoration: none; font-weight: bold;">Ice</span></li><li><span style="color: #a08332ff; text-decoration: none; font-weight: bold;">Sandstorm</span></li><li><span style="color: #74653fff; text-decoration: none; font-weight: bold;">Duststorm</span></li><li><span style="color: #53c57e; text-decoration: none; font-weight: bold;">Ghosts</span></li><li><span style="color: rgb(211, 176, 0); text-decoration: none; font-weight: bold;">Sunlight</span></li><li><span style="color: #7f00ff; text-decoration: none; font-weight: bold;">Magic Crystals</span></li><li><span style="color: #d5b60a; text-decoration: none; font-weight: bold;">Fireflies</span></li><li><span style="color: #ffb7c5; text-decoration: none; font-weight: bold;">Sakura Bloom</span></li><li><span style="color: #ffb7c5; text-decoration: none; font-weight: bold;">Sakura Blossoms</span></li><li><span style="text-decoration: none; font-weight: bold;">And add your own Particle Effects!</span></li></ul></p><p>If you have any questions about the module feel free to join the <a href= "https://discord.gg/YvxHrJ4tVu" target="_blank" style="color: #4e5d94; text-decoration: none; font-weight: bold;">Discord</a>!
          </div>
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

    await cleanupLegacyAnimationData();
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

    if (effectsChanged || filtersChanged || stackChanged || data.active === true) updateSceneControlHighlights();

    if (effectsChanged || filtersChanged || stackChanged) ctx.scheduleLayersWindowRefresh();
    if (data.active === true) ctx.scheduleOpenWindowsRefresh();

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

      if (ctx.sceneHasAnySceneFilters()) ctx.requestFilterSuppressionRefresh();
      if (ctx.sceneHasAnySceneParticles()) ctx.requestSceneParticlesSuppressionRefresh();
    },
    { key: "fxm:view:maskRefresh" },
  );

  Hooks.on("canvasPan", () => requestViewMaskRefresh());
  Hooks.on("canvasZoom", () => requestViewMaskRefresh());
}
