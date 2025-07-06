import { registerSettings } from "./settings.js";
import { registerHooks } from "./hooks.js";
import { FXMASTER } from "./config.js";
import { ParticleEffectsLayer } from "./particle-effects/particle-effects-layer.js";
import { registerDrawingsMaskFunctionality } from "./particle-effects/drawings-mask.js";
import { FilterManager } from "./filter-effects/filter-manager.js";
import { SpecialEffectsLayer } from "./special-effects/special-effects-layer.js";
import { registerHandlebarsHelpers } from "./handlebars-helpers.js";
import { registerGetSceneControlButtonsHook } from "./controls.js";
import "../css/filters-config.css";
import "../css/particle-effects-config.css";
import "../css/specials-config.css";
import "../css/common.css";

window.FXMASTER = {
  filters: FilterManager.instance,
};

function registerLayers() {
  CONFIG.Canvas.layers.fxmaster = { layerClass: ParticleEffectsLayer, group: "primary" };
  CONFIG.Canvas.layers.specials = { layerClass: SpecialEffectsLayer, group: "interface" };
}

Hooks.once("init", function () {
  registerSettings();
  registerHooks();
  registerLayers();
  registerHandlebarsHelpers();

  foundry.utils.mergeObject(CONFIG.fxmaster, {
    filterEffects: FXMASTER.filterEffects,
    particleEffects: FXMASTER.particleEffects,
    specialEffects: FXMASTER.specialEffects,
  });

  const weatherEffects = Object.fromEntries(
    Object.entries(CONFIG.fxmaster.particleEffects).map(([id, effectClass]) => [
      `fxmaster.${id}`,
      {
        id: `fxmaster.${id}`,
        label: `${effectClass.label}WeatherEffectsConfig`,
        effects: [{ id: `${id}Particles`, effectClass }],
      },
    ]),
  );

  CONFIG.originalWeatherEffects = CONFIG.weatherEffects;
  CONFIG.weatherEffects = { ...CONFIG.weatherEffects, ...weatherEffects };
});

registerGetSceneControlButtonsHook();
registerDrawingsMaskFunctionality();
