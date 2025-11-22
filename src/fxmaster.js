import { registerSettings } from "./settings.js";
import { registerHooks } from "./hooks.js";
import { FXMASTER } from "./config.js";
import { registerHandlebarsHelpers } from "./handlebars-helpers.js";
import { registerGetSceneControlButtonsHook } from "./controls.js";
import { packageId } from "./constants.js";
import { ParticleEffectsRegionLayer } from "./particle-effects/particle-effects-region-layer.js";
import { ParticleRegionBehaviorType } from "./particle-effects/particle-effects-region-behavior.js";
import { DefaultRectangleSpawnMixin } from "./particle-effects/effects/mixins/default-rectangle-spawn.js";
import { FXMasterParticleEffect } from "./particle-effects/effects/effect.js";
import { SuppressSceneParticlesBehaviorType } from "./particle-effects/suppress-scene-particles-region-behavior.js";
import { FilterEffectsSceneManager } from "./filter-effects/filter-effects-scene-manager.js";
import { FilterEffectsRegionLayer } from "./filter-effects/filter-effects-region-layer.js";
import { FilterRegionBehaviorType } from "./filter-effects/filter-effects-region-behavior.js";
import { FXMasterFilterEffectMixin } from "./filter-effects/filters/mixins/filter.js";
import { SuppressSceneFiltersBehaviorType } from "./filter-effects/suppress-scene-filters-region-behavior.js";
import customVertex2D from "./filter-effects/filters/shaders/custom-vertex-2d.vert";
import { SpecialEffectsLayer } from "./special-effects/special-effects-layer.js";
import { regionWorldBoundsAligned, regionWorldBounds, rectFromAligned, asFloat3 } from "./utils.js";
import "../css/filters-config.css";
import "../css/particle-effects-config.css";
import "../css/specials-config.css";
import "../css/common.css";

CONFIG.fxmaster = CONFIG.fxmaster || {};
CONFIG.fxmaster.FXMasterParticleEffect = FXMasterParticleEffect;
CONFIG.fxmaster.DefaultRectangleSpawnMixin = DefaultRectangleSpawnMixin;
CONFIG.fxmaster.customVertex2D = customVertex2D;
CONFIG.fxmaster.FXMasterFilterEffectMixin = FXMasterFilterEffectMixin;
CONFIG.fxmaster.regionWorldBoundsAligned = regionWorldBoundsAligned;
CONFIG.fxmaster.regionWorldBounds = regionWorldBounds;
CONFIG.fxmaster.rectFromAligned = rectFromAligned;
CONFIG.fxmaster.asFloat3 = asFloat3;

window.FXMASTER = {
  filters: FilterEffectsSceneManager.instance,
};

function registerLayers() {
  CONFIG.Canvas.layers.particleeffects = { layerClass: ParticleEffectsRegionLayer, group: "primary" };
  CONFIG.Canvas.layers.specials = { layerClass: SpecialEffectsLayer, group: "interface" };
  CONFIG.Canvas.layers.filtereffects = { layerClass: FilterEffectsRegionLayer, group: "primary" };
}

Hooks.once("init", function () {
  registerSettings();
  registerHooks();
  registerLayers();
  registerHandlebarsHelpers();

  const TYPE = `${packageId}.particleEffectsRegion`;
  const FILTER_TYPE = `${packageId}.filterEffectsRegion`;
  const SUPPRESS_SCENE_FILTERS = `${packageId}.suppressSceneFilters`;
  const SUPPRESS_SCENE_PARTICLES = `${packageId}.suppressSceneParticles`;

  foundry.utils.mergeObject(CONFIG.fxmaster, {
    filterEffects: FXMASTER.filterEffects,
    particleEffects: FXMASTER.particleEffects,
    specialEffects: FXMASTER.specialEffects,
  });

  Hooks.callAll(`${packageId}.preRegisterParticleEffects`, CONFIG.fxmaster);
  Hooks.callAll(`${packageId}.preRegisterFilterEffects`, CONFIG.fxmaster);

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
  CONFIG.RegionBehavior.dataModels[TYPE] = ParticleRegionBehaviorType;
  CONFIG.RegionBehavior.typeIcons[TYPE] = "fas fa-hat-wizard";
  CONFIG.RegionBehavior.typeLabels[TYPE] = "FXMASTER.Regions.BehaviorNames.ParticleEffectRegionBehaviorName";
  CONFIG.RegionBehavior.dataModels[FILTER_TYPE] = FilterRegionBehaviorType;
  CONFIG.RegionBehavior.typeIcons[FILTER_TYPE] = "fas fa-filter";
  CONFIG.RegionBehavior.typeLabels[FILTER_TYPE] = "FXMASTER.Regions.BehaviorNames.FilterEffectRegionBehaviorName";
  CONFIG.RegionBehavior.dataModels[SUPPRESS_SCENE_FILTERS] = SuppressSceneFiltersBehaviorType;
  CONFIG.RegionBehavior.typeIcons[SUPPRESS_SCENE_FILTERS] = "fas fa-ban";
  CONFIG.RegionBehavior.typeLabels[SUPPRESS_SCENE_FILTERS] =
    "FXMASTER.Regions.BehaviorNames.SuppressSceneFiltersRegionBehaviorName";
  CONFIG.RegionBehavior.dataModels[SUPPRESS_SCENE_PARTICLES] = SuppressSceneParticlesBehaviorType;
  CONFIG.RegionBehavior.typeIcons[SUPPRESS_SCENE_PARTICLES] = "fas fa-cloud-slash";
  CONFIG.RegionBehavior.typeLabels[SUPPRESS_SCENE_PARTICLES] =
    "FXMASTER.Regions.BehaviorNames.SuppressSceneParticlesRegionBehaviorName";
});

registerGetSceneControlButtonsHook();
