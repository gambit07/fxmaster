import { registerSettings } from "./settings.js";
import { registerHooks } from "./hooks.js";
import { FXMASTER } from "./config.js";
import { registerHandlebarsHelpers } from "./handlebars-helpers.js";
import { registerGetSceneControlButtonsHook } from "./controls.js";
import { packageId } from "./constants.js";
import { registerPresetApi } from "./api.js";
import { ParticleEffectsLayer } from "./particle-effects/particle-effects-layer.js";
import { ParticleRegionBehaviorType } from "./particle-effects/particle-effects-region-behavior.js";
import { DefaultRectangleSpawnMixin } from "./particle-effects/effects/mixins/default-rectangle-spawn.js";
import { FXMasterParticleEffect } from "./particle-effects/effects/effect.js";
import { SuppressSceneParticlesBehaviorType } from "./particle-effects/suppress-scene-particles-region-behavior.js";
import { FilterEffectsSceneManager } from "./filter-effects/filter-effects-scene-manager.js";
import { FilterEffectsLayer } from "./filter-effects/filter-effects-layer.js";
import { FilterRegionBehaviorType } from "./filter-effects/filter-effects-region-behavior.js";
import { FXMasterFilterEffectMixin } from "./filter-effects/filters/mixins/filter.js";
import { SuppressSceneFiltersBehaviorType } from "./filter-effects/suppress-scene-filters-region-behavior.js";
import { SpecialEffectsLayer } from "./special-effects/special-effects-layer.js";
import customVertex2D from "./filter-effects/filters/shaders/custom-vertex-2d.vert";
import { GlobalEffectsStackLayer } from "./stack/global-effects-stack-layer.js";
import { GlobalEffectsCompositor } from "./stack/global-effects-compositor.js";
import {
  regionWorldBoundsAligned,
  regionWorldBounds,
  regionContainsPoint,
  getRegionElevationWindow,
  getDocumentLevelsSet,
  getSelectedSceneLevelIds,
  getDocumentAssignedLevelIds,
  inferVisibleLevelForDocument,
  rectFromAligned,
  normalizeDirectionDegrees,
  legacyClockwiseDirectionToGeometric,
  geometricDirectionToScreenDegrees,
  geometricDirectionToScreenRadians,
  geometricDirectionToCanvasVector,
  isPlainObject,
  hasOwn,
  collectionValues,
} from "./utils.js";
import { FXMasterBaseFormV2 } from "./base-form.js";
import {
  normalizeRegisteredEffectParameters,
  normalizeEffectOptionsForRuntime,
  normalizeEffectOptionsForStorageFromLegacy,
  compressNormalizedRangeValue,
  expandNormalizedRangeValue,
  scaleNormalizedStoredRangeValue,
} from "./common/effect-parameter-normalization.js";
import "../css/filters-config.css";
import "../css/particle-effects-config.css";
import "../css/common.css";
import "../css/fx-layers.css";

CONFIG.fxmaster = CONFIG.fxmaster || {};
CONFIG.fxmaster.FXMasterParticleEffect = FXMasterParticleEffect;
CONFIG.fxmaster.normalizeParticleEmitterColor =
  FXMasterParticleEffect.normalizeParticleEmitterColor.bind(FXMasterParticleEffect);
CONFIG.fxmaster.sanitizeParticleEmitterColorBehaviors =
  FXMasterParticleEffect.sanitizeParticleEmitterColorBehaviors.bind(FXMasterParticleEffect);
CONFIG.fxmaster.FXMasterBaseFormV2 = FXMasterBaseFormV2;
CONFIG.fxmaster.DefaultRectangleSpawnMixin = DefaultRectangleSpawnMixin;
CONFIG.fxmaster.customVertex2D = customVertex2D;
CONFIG.fxmaster.FXMasterFilterEffectMixin = FXMasterFilterEffectMixin;
CONFIG.fxmaster.regionWorldBoundsAligned = regionWorldBoundsAligned;
CONFIG.fxmaster.regionWorldBounds = regionWorldBounds;
CONFIG.fxmaster.regionContainsPoint = regionContainsPoint;
CONFIG.fxmaster.getRegionElevationWindow = getRegionElevationWindow;
CONFIG.fxmaster.getDocumentLevelsSet = getDocumentLevelsSet;
CONFIG.fxmaster.getSelectedSceneLevelIds = getSelectedSceneLevelIds;
CONFIG.fxmaster.getDocumentAssignedLevelIds = getDocumentAssignedLevelIds;
CONFIG.fxmaster.inferVisibleLevelForDocument = inferVisibleLevelForDocument;
CONFIG.fxmaster.rectFromAligned = rectFromAligned;
CONFIG.fxmaster.normalizeDirectionDegrees = normalizeDirectionDegrees;
CONFIG.fxmaster.legacyClockwiseDirectionToGeometric = legacyClockwiseDirectionToGeometric;
CONFIG.fxmaster.geometricDirectionToScreenDegrees = geometricDirectionToScreenDegrees;
CONFIG.fxmaster.geometricDirectionToScreenRadians = geometricDirectionToScreenRadians;
CONFIG.fxmaster.geometricDirectionToCanvasVector = geometricDirectionToCanvasVector;
CONFIG.fxmaster.isPlainObject = isPlainObject;
CONFIG.fxmaster.hasOwn = hasOwn;
CONFIG.fxmaster.collectionValues = collectionValues;
CONFIG.fxmaster.normalizeEffectOptionsForRuntime = normalizeEffectOptionsForRuntime;
CONFIG.fxmaster.normalizeEffectOptionsForStorageFromLegacy = normalizeEffectOptionsForStorageFromLegacy;
CONFIG.fxmaster.compressNormalizedRangeValue = compressNormalizedRangeValue;
CONFIG.fxmaster.expandNormalizedRangeValue = expandNormalizedRangeValue;
CONFIG.fxmaster.scaleNormalizedStoredRangeValue = scaleNormalizedStoredRangeValue;
CONFIG.fxmaster.GlobalEffectsCompositor = GlobalEffectsCompositor;
CONFIG.fxmaster.SpecialEffectsLayer = SpecialEffectsLayer;
CONFIG.fxmaster.getGlobalEffectsCompositor = () => GlobalEffectsCompositor.instance;
CONFIG.fxmaster.overheadPerformance = {
  ...(CONFIG.fxmaster.overheadPerformance ?? {}),
  sceneSuppressionLevelIntersection: true,
  flattenSceneLevelMasks: true,
  regionParticleScratchComposite: true,
  batchedSurfaceMasks: true,
  sceneRowSelectedLevelTilesExpandCoverage:
    CONFIG.fxmaster.overheadPerformance?.sceneRowSelectedLevelTilesExpandCoverage ?? false,
  sceneRowUseDefinedSurfaceFootprints: CONFIG.fxmaster.overheadPerformance?.sceneRowUseDefinedSurfaceFootprints ?? true,
  sceneRowDefinedSurfaceFootprintWindowFallback:
    CONFIG.fxmaster.overheadPerformance?.sceneRowDefinedSurfaceFootprintWindowFallback ?? false,
  configuredLevelImageSceneRectFallback:
    CONFIG.fxmaster.overheadPerformance?.configuredLevelImageSceneRectFallback ?? true,
  compositorSceneFilterSuppression: CONFIG.fxmaster.overheadPerformance?.compositorSceneFilterSuppression ?? true,
  compositorSceneParticleSuppression: CONFIG.fxmaster.overheadPerformance?.compositorSceneParticleSuppression ?? true,
  compositorSceneParticleSuppressionMode:
    CONFIG.fxmaster.overheadPerformance?.compositorSceneParticleSuppressionMode ?? "always",
  compositorSceneParticleSuppressionIdleDelayMs:
    CONFIG.fxmaster.overheadPerformance?.compositorSceneParticleSuppressionIdleDelayMs ?? 180,
  compositorSuppressionMaskCaching: CONFIG.fxmaster.overheadPerformance?.compositorSuppressionMaskCaching ?? true,
  nativeLevelDynamicCoveragePresyncOnlyWhenMoving:
    CONFIG.fxmaster.overheadPerformance?.nativeLevelDynamicCoveragePresyncOnlyWhenMoving ?? true,
  sharedCoverageSameFrameDeduplication:
    CONFIG.fxmaster.overheadPerformance?.sharedCoverageSameFrameDeduplication ?? true,
  skipInitialStackBlitForSimpleHiDpiFrames:
    CONFIG.fxmaster.overheadPerformance?.skipInitialStackBlitForSimpleHiDpiFrames ?? true,
};

const PARTICLE_REGION_BEHAVIOR_TYPE = `${packageId}.particleEffectsRegion`;
const FILTER_REGION_BEHAVIOR_TYPE = `${packageId}.filterEffectsRegion`;
const SUPPRESS_SCENE_FILTERS_REGION_BEHAVIOR_TYPE = `${packageId}.suppressSceneFilters`;
const SUPPRESS_SCENE_PARTICLES_REGION_BEHAVIOR_TYPE = `${packageId}.suppressSceneParticles`;

function registerRegionBehaviorTypes() {
  const config = CONFIG?.RegionBehavior ?? null;
  if (!config?.dataModels) return false;

  config.dataModels[PARTICLE_REGION_BEHAVIOR_TYPE] = ParticleRegionBehaviorType;
  config.dataModels[FILTER_REGION_BEHAVIOR_TYPE] = FilterRegionBehaviorType;
  config.dataModels[SUPPRESS_SCENE_FILTERS_REGION_BEHAVIOR_TYPE] = SuppressSceneFiltersBehaviorType;
  config.dataModels[SUPPRESS_SCENE_PARTICLES_REGION_BEHAVIOR_TYPE] = SuppressSceneParticlesBehaviorType;

  if (config.typeIcons) {
    config.typeIcons[PARTICLE_REGION_BEHAVIOR_TYPE] = "fas fa-hat-wizard";
    config.typeIcons[FILTER_REGION_BEHAVIOR_TYPE] = "fas fa-filter";
    config.typeIcons[SUPPRESS_SCENE_FILTERS_REGION_BEHAVIOR_TYPE] = "fas fa-ban";
    config.typeIcons[SUPPRESS_SCENE_PARTICLES_REGION_BEHAVIOR_TYPE] = "fas fa-cloud-slash";
  }

  if (config.typeLabels) {
    config.typeLabels[PARTICLE_REGION_BEHAVIOR_TYPE] =
      "FXMASTER.Regions.BehaviorNames.ParticleEffectRegionBehaviorName";
    config.typeLabels[FILTER_REGION_BEHAVIOR_TYPE] = "FXMASTER.Regions.BehaviorNames.FilterEffectRegionBehaviorName";
    config.typeLabels[SUPPRESS_SCENE_FILTERS_REGION_BEHAVIOR_TYPE] =
      "FXMASTER.Regions.BehaviorNames.SuppressSceneFiltersRegionBehaviorName";
    config.typeLabels[SUPPRESS_SCENE_PARTICLES_REGION_BEHAVIOR_TYPE] =
      "FXMASTER.Regions.BehaviorNames.SuppressSceneParticlesRegionBehaviorName";
  }

  return true;
}

registerRegionBehaviorTypes();

/**
 * Helpers to allow particle effects to run in other renderers ie not Canvas Provides an override context on either:
 * - the effect instance: effect.__fxmParticleContext
 * - the options object passed to the effect: options.__fxmParticleContext
 * The override shape is: { dimensions: {width,height,size,sceneRect}, renderer, ticker }
 */
CONFIG.fxmaster.getParticleContext = function (source) {
  return source?.__fxmParticleContext ?? null;
};
CONFIG.fxmaster.getParticleDimensions = function (source) {
  return CONFIG.fxmaster.getParticleContext(source)?.dimensions ?? canvas?.dimensions ?? null;
};
CONFIG.fxmaster.getParticleRenderer = function (source) {
  return CONFIG.fxmaster.getParticleContext(source)?.renderer ?? canvas?.app?.renderer ?? null;
};
CONFIG.fxmaster.getParticleTicker = function (source) {
  return CONFIG.fxmaster.getParticleContext(source)?.ticker ?? canvas?.app?.ticker ?? PIXI?.Ticker?.shared ?? null;
};

window.FXMASTER = {
  filters: FilterEffectsSceneManager.instance,
  getGlobalEffectsCompositor: () => GlobalEffectsCompositor.instance,
  specials: {
    playVideo: (data) => canvas?.specials?.playVideo?.(data) ?? Promise.resolve(),
  },
};

function registerLayers() {
  CONFIG.Canvas.layers.particleeffects = { layerClass: ParticleEffectsLayer, group: "primary" };
  CONFIG.Canvas.layers.specials = { layerClass: SpecialEffectsLayer, group: "interface" };
  CONFIG.Canvas.layers.filtereffects = { layerClass: FilterEffectsLayer, group: "primary" };
  CONFIG.Canvas.layers.fxstack = { layerClass: GlobalEffectsStackLayer, group: "rendered" };
}

Hooks.once("init", function () {
  registerSettings();
  registerHooks();
  registerLayers();
  registerHandlebarsHelpers();
  registerPresetApi();

  foundry.utils.mergeObject(CONFIG.fxmaster, {
    filterEffects: FXMASTER.filterEffects,
    particleEffects: FXMASTER.particleEffects,
  });

  Hooks.callAll(`${packageId}.preRegisterParticleEffects`, CONFIG.fxmaster);
  Hooks.callAll(`${packageId}.preRegisterFilterEffects`, CONFIG.fxmaster);
  normalizeRegisteredEffectParameters(CONFIG.fxmaster);

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
  registerRegionBehaviorTypes();
});

registerGetSceneControlButtonsHook();
