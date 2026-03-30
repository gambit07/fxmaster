/**
 * FXMaster: Scene, Input & Miscellaneous Hooks
 *
 * Handles the `ready` one-shot, `updateScene` flag processing, canvas pan/zoom mask refresh, `dropCanvasData` video creation, and `hotbarDrop` macro creation.
 *
 * @module hooks/scene-hooks
 */

import { packageId } from "../constants.js";
import { logger } from "../logger.js";
import { coalesceNextFrame, updateSceneControlHighlights, parseSpecialEffects } from "../utils.js";
import { isEnabled } from "../settings.js";
import { SpecialEffectsManagement } from "../special-effects/applications/special-effects-management.js";
import { SpecialEffectsLayer } from "../special-effects/special-effects-layer.js";
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
 * Register scene update, input, and miscellaneous hooks.
 *
 * @param {object} ctx - Shared hook context from {@link createHookContext}.
 */
export function registerSceneHooks(ctx) {
  Hooks.once("ready", async () => {
    const version = game.modules.get(packageId).version;
    if (game.settings.get(packageId, "releaseMessage") !== version && game.user.isGM) {
      const content = `
        <div class="fxmaster-announcement" style="border:4px solid #4A90E2; border-radius:6px; padding:12px;">
          <h3 style="margin:0;">🎉Welcome to Gambit's FXMaster V7.5.1!</h3>
            <p style="font-size: 1em;">Resolved some missing localizations. This release adds some new features including adding an Edge Fade % to Region Particle Effects and adding an Edge Fade % to both Particle and Filter Region Suppression effects! Please check out the <a href= "https://github.com/gambit07/fxmaster/releases/latest" target="_blank" style="color: #dd6b20; text-decoration: none; font-weight: bold;">Release Notes</a> for more detail.</p>
            <p style="font-size: 1em;">If you'd like to support my development time and get access to the <a href="https://foundryvtt.com/packages/fxmaster-plus" target="_blank" style="color: #CC66CC; text-decoration: none; font-weight: bold;">Gambit's FXMaster+</a>, <a href="https://foundryvtt.com/packages/gambitsAssetPreviewer" target="_blank" style="color: #CC66CC; text-decoration: none; font-weight: bold;">Gambit's Asset Previewer</a>, and <a href="https://foundryvtt.com/packages/gambitsImageViewer" target="_blank" style="color: #CC66CC; text-decoration: none; font-weight: bold;">Gambit's Image Viewer</a> modules, please consider supporting the project on <a href="https://patreon.com/GambitsLounge" target="_blank" style="color: #dd6b20; text-decoration: none; font-weight: bold;">Patreon</a>.</p><p>FXMaster+ Effects: <ul><li><span style="color: #3276c4; text-decoration: none; font-weight: bold;">Water</span></li><li><span style="color: #7c7c7c; text-decoration: none; font-weight: bold;">Lightning Bolts</span></li><li><span style="color: #0ada64; text-decoration: none; font-weight: bold;">Glitch</span></li><li><span style="color: #017371; text-decoration: none; font-weight: bold;">Fish</span></li><li><span style="color: #3bd1ffff; text-decoration: none; font-weight: bold;">Ice</span></li><li><span style="color: #a08332ff; text-decoration: none; font-weight: bold;">Sandstorm</span></li><li><span style="color: #74653fff; text-decoration: none; font-weight: bold;">Duststorm</span></li><li><span style="color: #53c57e; text-decoration: none; font-weight: bold;">Ghosts</span></li><li><span style="color: rgb(211, 176, 0); text-decoration: none; font-weight: bold;">Sunlight</span></li><li><span style="color: #7f00ff; text-decoration: none; font-weight: bold;">Magic Crystals</span></li><li><span style="color: #d5b60a; text-decoration: none; font-weight: bold;">Fireflies</span></li><li><span style="color: #ffb7c5; text-decoration: none; font-weight: bold;">Sakura Bloom</span></li><li><span style="color: #ffb7c5; text-decoration: none; font-weight: bold;">Sakura Blossoms</span></li><li><span style="text-decoration: none; font-weight: bold;">And add your own Particle Effects!</span></li></ul></p><p>If you have any questions about the module feel free to join the <a href= "https://discord.gg/YvxHrJ4tVu" target="_blank" style="color: #4e5d94; text-decoration: none; font-weight: bold;">Discord</a>!
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

    if (isEnabled()) await parseSpecialEffects();
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

    if (effectsChanged) {
      if (isEnabled()) canvas.particleeffects?.drawParticleEffects?.({ soft: true });
      ctx.requestSceneParticlesSuppressionRefresh();
    }

    if (filtersChanged) {
      if (isEnabled()) {
        FilterEffectsSceneManager.instance.update();
        ctx.ensurePinned();
      }
    }

    if (effectsChanged || filtersChanged || data.active === true) updateSceneControlHighlights();

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

  Hooks.on("dropCanvasData", async (canvas, data) => {
    if (data.type !== "SpecialEffect") return;

    /** Load video metadata with a timeout and error handler to prevent hanging. */
    const VIDEO_LOAD_TIMEOUT_MS = 10000;
    const loaded = await new Promise((resolve) => {
      const vid = document.createElement("video");
      const timer = setTimeout(() => {
        vid.onloadedmetadata = null;
        vid.onerror = null;
        resolve(false);
      }, VIDEO_LOAD_TIMEOUT_MS);

      vid.addEventListener(
        "loadedmetadata",
        () => {
          clearTimeout(timer);
          data.width = vid.videoWidth * data.scale.x;
          data.height = vid.videoHeight * data.scale.y;
          resolve(true);
        },
        false,
      );
      vid.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          resolve(false);
        },
        false,
      );
      vid.src = data.file;
    });

    if (!loaded) {
      ui.notifications.warn(game.i18n.format("FXMASTER.Common.VideoLoadFailed", { file: data.file }));
      return;
    }

    const tileData = {
      alpha: 1,
      flags: {},
      height: data.height,
      hidden: false,
      texture: { src: data.file },
      locked: false,
      occlusion: { mode: 1, alpha: 0 },
      overhead: false,
      rotation: 0,
      tileSize: 100,
      video: { loop: true, autoplay: true, volume: 0 },
      width: data.width,
      x: data.x - 0.5 * data.width,
      y: data.y - 0.5 * data.height,
      z: 100,
    };
    ui.notifications.info(game.i18n.format("FXMASTER.Common.TileCreated", { effect: data.label }));
    await canvas.scene.createEmbeddedDocuments("Tile", [tileData]);
  });

  Hooks.on("hotbarDrop", (hotbar, data) => {
    if (data.type !== "SpecialEffect") return;
    const macroCommand = SpecialEffectsLayer._createMacro(data);
    const macroData = {
      command: macroCommand,
      name: data.label,
      type: "script",
      author: game.user.id,
    };
    Macro.create(macroData).then((macro) => {
      if (macro) game.user.assignHotbarMacro(macro, hotbar);
    });
    return false;
  });

  Hooks.on("updateSetting", (setting) => {
    if (setting.key === "fxmaster.specialEffects") {
      parseSpecialEffects();
      Object.values(ui.windows).forEach((w) => {
        if (w instanceof SpecialEffectsManagement) {
          w.render(false);
        }
      });
    }
  });
}
