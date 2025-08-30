import { packageId } from "./constants.js";
import {
  onSwitchParticleEffects,
  onUpdateParticleEffects,
  cleanupRegionParticleEffects,
  parseSpecialEffects,
} from "./utils.js";
import { isEnabled } from "./settings.js";
import { SpecialEffectsManagement } from "./special-effects/applications/special-effects-management.js";
import { SpecialEffectsLayer } from "./special-effects/special-effects-layer.js";
import { drawDrawingsMaskIfCurrentScene, drawDrawingsMask } from "./particle-effects/drawings-mask.js";
import { ParticleEffectsRegionBehaviorConfig } from "./particle-effects/particle-effects-region-config.js";

const TYPE = `${packageId}.particleEffectsRegion`;

export const registerHooks = function () {
  Hooks.on(`${packageId}.switchParticleEffect`, onSwitchParticleEffects);
  Hooks.on(`${packageId}.updateParticleEffects`, onUpdateParticleEffects);

  Hooks.on("preDeleteRegion", (regionDoc, _options) => {
    cleanupRegionParticleEffects(regionDoc.id);
  });

  // Re-add existing effects to regions when changed. System doesn't allow movement but this should handle that as well. In theory
  Hooks.on("updateRegion", (regionDoc, _diff, _options, _userId) => {
    if (!regionDoc?.behaviors?.some((b) => (b.type === TYPE || b.type === "suppressWeather") && !b.disabled)) return;

    const placeable = canvas.regions.get(regionDoc.id);
    if (placeable) {
      canvas.fxmaster.drawRegionParticleEffects(placeable);
    }

    drawDrawingsMaskIfCurrentScene(regionDoc.parent);
  });

  Hooks.on("updateRegionBehavior", (behaviorDoc, _diff, _options, _userId) => {
    if (behaviorDoc.type !== "suppressWeather") return;
    drawDrawingsMaskIfCurrentScene(behaviorDoc.parent.parent);
  });

  Hooks.on("deleteRegionBehavior", (behaviorDoc, _diff, _options, _userId) => {
    if (behaviorDoc.type !== "suppressWeather") return;
    drawDrawingsMaskIfCurrentScene(behaviorDoc.parent.parent);
  });

  Hooks.on("createRegionBehavior", (behaviorDoc, _diff, _options, _userId) => {
    if (behaviorDoc.type !== "suppressWeather") return;
    drawDrawingsMaskIfCurrentScene(behaviorDoc.parent.parent);
  });

  Hooks.on("canvasReady", () => {
    if (!canvas.fxmaster) return;
    drawDrawingsMask();

    for (const region of canvas.regions.placeables) {
      canvas.fxmaster.drawRegionParticleEffects(region, { soft: true });
    }
  });

  Hooks.once("ready", async () => {
    const version = game.modules.get(packageId).version;
    if (game.settings.get(packageId, "releaseMessage") !== version && game.user.isGM) {
      const content = `
        <div class="fxmaster-announcement" style="border:2px solid #4A90E2; border-radius:8px; padding:12px; background:#f4faff;">
          <h3 style="margin:0; color:#2a4365;">🎉Welcome to Gambit's FXMaster!</h3>
            <p style="color: #2a4365; font-size: 1em;">This V${version} release adds a couple tweaks for this months FXMaster+ particle effect Magic Crystals. Check out the readme and release notes on <a href="https://github.com/gambit07/fxmaster" target="_blank" style="color: #3182ce; text-decoration: none; font-weight: bold;">GitHub</a>.</p>
            <p style="color: #2a4365; font-size: 1em;">If you'd like to support my development time and get access to new Particle Effects <span style="color: #FFD500">Fireflies</span>, <span style="color: #C11C84">Sakura Bloom & Sakura Blossoms</span>, please consider supporting the project on <a href="https://patreon.com/GambitsLounge" target="_blank" style="color: #dd6b20; text-decoration: none; font-weight: bold;">Patreon</a>.</p>
          </div>
        `;
      ChatMessage.create({ content });

      game.settings.set(packageId, "releaseMessage", version);
    }

    CONFIG.RegionBehavior.sheetClasses[TYPE]["core.RegionBehaviorConfig"].cls = ParticleEffectsRegionBehaviorConfig;

    if (isEnabled()) await parseSpecialEffects();
  });

  Hooks.on("updateScene", (scene, data) => {
    if (!isEnabled() || scene !== canvas.scene) {
      return;
    }
    if (
      foundry.utils.hasProperty(data, "flags.fxmaster.effects") ||
      foundry.utils.hasProperty(data, "flags.fxmaster.-=effects")
    ) {
      canvas.fxmaster.drawParticleEffects({ soft: true });
    }
  });

  Hooks.on("dropCanvasData", async (canvas, data) => {
    if (data.type !== "SpecialEffect") return;

    await new Promise((resolve) => {
      const vid = document.createElement("video");
      vid.addEventListener(
        "loadedmetadata",
        () => {
          data.width = vid.videoWidth * data.scale.x;
          data.height = vid.videoHeight * data.scale.y;
          resolve();
        },
        false,
      );
      vid.src = data.file;
    });

    const tileData = {
      alpha: 1,
      flags: {},
      height: data.height,
      hidden: false,
      texture: { src: data.file },
      locked: false,
      occlusion: { mode: 1, alpha: 0 },
      overHead: false,
      rotation: 0,
      tileSize: 100,
      video: { loop: true, autoplay: true, volume: 0 },
      width: data.width,
      x: data.x - data.anchor.x * data.width,
      y: data.y - data.anchor.y * data.height,
      z: 100,
    };
    ui.notifications.info(game.i18n.format("FXMASTER.TileCreated", { effect: data.label }));
    canvas.scene.createEmbeddedDocuments("Tile", [tileData]).then(() => {});
  });

  Hooks.on("hotbarDrop", (hotbar, data) => {
    if (data.type !== "SpecialEffect") return;
    const macroCommand = SpecialEffectsLayer._createMacro(data);
    data.type = "Macro";
    data.data = {
      command: macroCommand,
      name: data.label,
      type: "script",
      author: game.user.id,
    };
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

  Hooks.on("renderDrawingHUD", (hud, html) => {
    // Normalize raw DOM element for v13
    const container = html instanceof jQuery ? html[0] : html;
    if (!(container instanceof HTMLElement)) return;

    const leftCol = container.querySelector(".col.left");
    if (!leftCol) return;

    const maskToggle = document.createElement("div");
    maskToggle.classList.add("control-icon");
    if (hud.object.document.flags?.fxmaster?.masking) maskToggle.classList.add("active");
    maskToggle.title = game.i18n.localize("FXMASTER.MaskParticleEffects");
    maskToggle.dataset.action = "mask";
    maskToggle.innerHTML = `<div style="text-align:center;"><i class="fas fa-cloud fa-xs"></i></div>`;

    leftCol.appendChild(maskToggle);
    maskToggle.addEventListener("click", (evt) => {
      evt.preventDefault();
      const isMask = hud.object.document.flags?.fxmaster?.masking;
      const updates = hud.layer.controlled.map((o) => ({
        _id: o.id,
        "flags.fxmaster.masking": !isMask,
      }));
      maskToggle.classList.toggle("active", !isMask);
      canvas.scene.updateEmbeddedDocuments(hud.object.document.documentName, updates);
    });
  });

  Hooks.on("renderSceneControls", (controls) => {
    if (controls.control.name !== "effects") return;

    const hasParticles = !!Object.keys(canvas.scene.getFlag(packageId, "effects") || {}).length;
    const hasFilters = !!Object.keys(canvas.scene.getFlag(packageId, "filters") || {}).length;
    if (!hasParticles && !hasFilters) return;

    const particlesBtn = document.querySelector(`[data-tool="particle-effects"]`);
    const filtersBtn = document.querySelector(`[data-tool="filters"]`);

    if (hasParticles) {
      particlesBtn.style.setProperty("background-color", "var(--color-warm-2)");
      particlesBtn.style.setProperty("border-color", "var(--color-warm-3)");
    }
    if (hasFilters) {
      filtersBtn.style.setProperty("background-color", "var(--color-warm-2)");
      filtersBtn.style.setProperty("border-color", "var(--color-warm-3)");
    }
  });
};
