import { registerSettings } from "./settings.js";
import { registerHooks } from "./hooks.js";
import { FXMASTER } from "./config.js";
import { WeatherLayer } from "./weatherEffects/WeatherLayer.js";
import { filterManager } from "./filterEffects/FilterManager.js";
import { executeWhenWorldIsMigratedToLatest, isOnTargetMigration, migrate } from "./migration.js";
import { SpecialsLayer } from "./specialEffects/SpecialsLayer.js";
import { registerHelpers } from "./helpers.js";
import { registerGetSceneControlButtonsHook } from "./controls.js";
import { isV9OrLater } from "./utils.js";
import { logger } from "./logger.js";
import { registerWrappers } from "./wrappers/index.js";

import "../css/common.css";

window.FXMASTER = {
  filters: filterManager,
};

function registerLayer() {
  CONFIG.Canvas.layers.fxmaster = isV9OrLater() ? { layerClass: WeatherLayer, group: "primary" } : WeatherLayer;
  CONFIG.Canvas.layers.specials = isV9OrLater() ? { layerClass: SpecialsLayer, group: "primary" } : SpecialsLayer;
}

function parseSpecialEffects() {
  const effectData = game.settings.get("fxmaster", "specialEffects");
  const specials = foundry.utils.deepClone(CONFIG.fxmaster.specials);
  effectData.reduce((acc, cur) => {
    if (!cur.folder) cur.folder = "Custom";
    const normalizedFolder = cur.folder.toLowerCase().replace(/ /g, "");
    if (!acc[normalizedFolder]) acc[normalizedFolder] = { label: cur.folder, effects: [] };
    acc[normalizedFolder].effects.push(cur);
    return acc;
  }, specials);
  Object.keys(specials).forEach((k) => {
    specials[k].effects.sort((a, b) => ("" + a.label).localeCompare(b.label));
  });
  CONFIG.fxmaster.userSpecials = specials;
}

Hooks.once("init", function () {
  // Register custom system settings
  registerSettings();
  registerHooks();
  registerLayer();
  registerWrappers();
  registerHelpers();

  // Adding filters, weathers and effects
  if (!CONFIG.fxmaster) CONFIG.fxmaster = {};
  foundry.utils.mergeObject(CONFIG.fxmaster, {
    filters: FXMASTER.filters,
    specials: FXMASTER.specials,
    weather: FXMASTER.weatherEffects,
  });

  Object.defineProperty(CONFIG.fxmaster.weather, "nature", {
    get: () => {
      logger.warn(
        `'CONFIG.fxmaster.weather.nature' is deprecated and will be removed in a future version. Please use 'CONFIG.fxmaster.weather.leaves' instead.`,
      );
      return CONFIG.fxmaster.weather.leaves;
    },
  });

  foundry.utils.mergeObject(CONFIG.weatherEffects, FXMASTER.weatherEffects);
});

Hooks.once("ready", () => {
  migrate();
});

Hooks.on("canvasInit", () => {
  if (!game.settings.get("fxmaster", "enable") || game.settings.get("fxmaster", "disableAll")) {
    return;
  }
  parseSpecialEffects();
  filterManager.clear();
});

Hooks.on("canvasReady", async () => {
  executeWhenWorldIsMigratedToLatest(async () => {
    if (!game.settings.get("fxmaster", "enable") || game.settings.get("fxmaster", "disableAll")) {
      return;
    }
    await filterManager.activate();
  });
});

Hooks.on("updateScene", (scene, data) => {
  if (
    !game.settings.get("fxmaster", "enable") ||
    game.settings.get("fxmaster", "disableAll") ||
    !isOnTargetMigration() ||
    scene !== canvas.scene
  ) {
    return;
  }
  if (hasProperty(data, "flags.fxmaster.effects") || hasProperty(data, "flags.fxmaster.-=effects")) {
    canvas.fxmaster.drawWeather({ soft: true });
  }
  if (hasProperty(data, "flags.fxmaster.invert") || hasProperty(data, "flags.fxmaster.-=invert")) {
    canvas.fxmaster.updateMask();
  }
  if (
    hasProperty(data, "flags.fxmaster.filters") ||
    hasProperty(data, "flags.fxmaster.-=filters") ||
    hasProperty(data, "flags.fxmaster.filteredLayers") ||
    hasProperty(data, "flags.fxmaster.-=filteredLayers")
  ) {
    filterManager.update();
  }
});

Hooks.on("dropCanvasData", async (canvas, data) => {
  if (!(canvas.activeLayer instanceof SpecialsLayer) || !canvas.scene) return;
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
    img: data.file,
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
  ui.notifications.info(`A new Tile was created for effect ${data.label}`);
  canvas.scene.createEmbeddedDocuments("Tile", [tileData]).then(() => {});
});

Hooks.on("hotbarDrop", (hotbar, data) => {
  if (data.type !== "SpecialEffect") return;
  const macroCommand = SpecialsLayer._createMacro(data);
  data.type = "Macro";
  data.data = {
    command: macroCommand,
    name: data.label,
    type: "script",
    author: game.user.id,
  };
});

Hooks.on("updateDrawing", (drawing) => {
  if (drawing.parent !== canvas.scene) {
    return;
  }
  canvas.fxmaster.updateMask();
});

Hooks.on("createDrawing", (drawing) => {
  if (drawing.parent !== canvas.scene) {
    return;
  }
  canvas.fxmaster.updateMask();
});

Hooks.on("deleteDrawing", (drawing) => {
  if (drawing.parent !== canvas.scene) {
    return;
  }
  canvas.fxmaster.updateMask();
});

Hooks.on("updateSetting", (data) => {
  if (data.data.key === "fxmaster.specialEffects") {
    parseSpecialEffects();
  }
});

Hooks.on("renderDrawingHUD", (hud, html, data) => {
  const maskToggle = document.createElement("div");
  maskToggle.classList.add("control-icon");
  if (data?.flags?.fxmaster?.masking) {
    maskToggle.classList.add("active");
  }
  maskToggle.setAttribute("title", game.i18n.localize("FXMASTER.MaskWeather"));
  maskToggle.dataset.action = "mask";
  maskToggle.innerHTML = "<i class='fas fa-cloud'></i>";
  html.find(".col.left").append(maskToggle);

  html.find(".control-icon[data-action='mask']").click(async () => {
    await hud.object.document.setFlag("fxmaster", "masking", !data?.flags?.fxmaster?.masking);
    hud.render(true);
  });
});

registerGetSceneControlButtonsHook();
