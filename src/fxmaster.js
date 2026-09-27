import { collectActiveEffectDefinitions } from "./common/effect-activation.js";
import { registerSettings } from "./settings.js";
import { registerHooks } from "./hooks.js";
import { FXMASTER } from "./config.js";
import { registerHandlebarsHelpers } from "./handlebars-helpers.js";
import { registerGetSceneControlButtonsHook } from "./controls.js";
import { packageId } from "./constants.js";
import { registerPresetApi } from "./api.js";
import { ParticleEffectsLayer } from "./particle-effects/particle-effects-layer.js";
import { registerParticleBackgroundQueries } from "./particle-effects/backgrounds/particle-background-query-sync.js";
import { createParticleBackgroundSurface } from "./particle-effects/backgrounds/background-surface-factory.js";
import { createParticleBackgroundTrailStore } from "./particle-effects/backgrounds/snow-trail-store.js";
import {
  particleBackgroundEnabled,
  particleBackgroundMonotonicNow,
  particleBackgroundNow,
} from "./particle-effects/backgrounds/background-state.js";
import { ParticleRegionBehaviorType } from "./particle-effects/particle-effects-region-behavior.js";
import { DefaultRectangleSpawnMixin } from "./particle-effects/mixins/default-rectangle-spawn.js";
import { FXMasterParticleEffect } from "./particle-effects/effect.js";
import { SuppressSceneParticlesBehaviorType } from "./particle-effects/suppress-scene-particles-region-behavior.js";
import { FilterEffectsSceneManager } from "./filter-effects/filter-effects-scene-manager.js";
import { FilterEffectsLayer } from "./filter-effects/filter-effects-layer.js";
import { FilterRegionBehaviorType } from "./filter-effects/filter-effects-region-behavior.js";
import {
  FILTER_PRESENTATION_PASSES,
  FILTER_PRESENTATION_PASS_VALUES,
  FXMasterFilterEffectMixin,
} from "./filter-effects/mixins/filter.js";
import { SuppressSceneFiltersBehaviorType } from "./filter-effects/suppress-scene-filters-region-behavior.js";
import { SpecialEffectsLayer } from "./special-effects/special-effects-layer.js";
import customVertex2D from "./filter-effects/shaders/custom-vertex-2d.vert";
import { prepareFilterShaderSources } from "./filter-effects/shader-sources.js";
import { GlobalEffectsStackLayer } from "./stack/global-effects-stack-layer.js";
import { GlobalEffectsCompositor } from "./stack/global-effects-compositor.js";
import {
  regionWorldBoundsAligned,
  regionWorldBounds,
  regionContainsPoint,
  getRegionElevationWindow,
  inRangeElev,
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
  computeRegionGatePass,
  getRegionParticleEffectDefinitions,
  installTileRefreshStateGuard,
  installTokenRulerGridHighlightGuard,
} from "./utils.js";
import { FXMasterBaseFormV2 } from "./base-form.js";
import {
  normalizeRegisteredEffectParameters,
  normalizeEffectDefinition,
  normalizeEffectOptionsForRuntime,
  normalizeEffectOptionsForStorageFromLegacy,
  compressNormalizedRangeValue,
  expandNormalizedRangeValue,
  scaleNormalizedStoredRangeValue,
} from "./common/effect-parameter-normalization.js";
import {
  SynchronizedDirectionRuntime,
  synchronizedDirectionOptionEnabled,
  synchronizedDirectionAvailable,
  shortestDirectionDeltaDegrees,
  lerpDirectionDegrees,
  smoothDirectionBlend,
} from "./common/synchronized-direction.js";
import { directionDegreesToCompass, isCompassDirectionParameter } from "./common/compass-direction.js";
import "../css/filters-config.css";
import "../css/particle-effects-config.css";
import "../css/common.css";
import "../css/fx-layers.css";

CONFIG.fxmaster = CONFIG.fxmaster || {};
CONFIG.fxmaster.collectActiveEffectDefinitions = collectActiveEffectDefinitions;
CONFIG.fxmaster.FXMasterParticleEffect = FXMasterParticleEffect;
CONFIG.fxmaster.normalizeParticleEmitterColor =
  FXMasterParticleEffect.normalizeParticleEmitterColor.bind(FXMasterParticleEffect);
CONFIG.fxmaster.sanitizeParticleEmitterColorBehaviors =
  FXMasterParticleEffect.sanitizeParticleEmitterColorBehaviors.bind(FXMasterParticleEffect);
CONFIG.fxmaster.FXMasterBaseFormV2 = FXMasterBaseFormV2;
CONFIG.fxmaster.DefaultRectangleSpawnMixin = DefaultRectangleSpawnMixin;
CONFIG.fxmaster.createParticleBackgroundSurface = createParticleBackgroundSurface;
CONFIG.fxmaster.createParticleBackgroundTrailStore = createParticleBackgroundTrailStore;
CONFIG.fxmaster.particleBackgroundEnabled = particleBackgroundEnabled;
CONFIG.fxmaster.particleBackgroundNow = particleBackgroundNow;
CONFIG.fxmaster.particleBackgroundMonotonicNow = particleBackgroundMonotonicNow;
CONFIG.fxmaster.customVertex2D = customVertex2D;
CONFIG.fxmaster.FXMasterFilterEffectMixin = FXMasterFilterEffectMixin;
CONFIG.fxmaster.prepareFilterShaderSources = prepareFilterShaderSources;
CONFIG.fxmaster.filterPresentationPasses = FILTER_PRESENTATION_PASSES;
CONFIG.fxmaster.filterPresentationPassValues = FILTER_PRESENTATION_PASS_VALUES;
CONFIG.fxmaster.regionWorldBoundsAligned = regionWorldBoundsAligned;
CONFIG.fxmaster.regionWorldBounds = regionWorldBounds;
CONFIG.fxmaster.regionContainsPoint = regionContainsPoint;
CONFIG.fxmaster.getRegionElevationWindow = getRegionElevationWindow;
CONFIG.fxmaster.inRangeElev = inRangeElev;
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
CONFIG.fxmaster.directionDegreesToCompass = directionDegreesToCompass;
CONFIG.fxmaster.isCompassDirectionParameter = isCompassDirectionParameter;
CONFIG.fxmaster.isPlainObject = isPlainObject;
CONFIG.fxmaster.hasOwn = hasOwn;
CONFIG.fxmaster.collectionValues = collectionValues;
CONFIG.fxmaster.computeRegionGatePass = computeRegionGatePass;
CONFIG.fxmaster.getRegionParticleEffectDefinitions = getRegionParticleEffectDefinitions;
CONFIG.fxmaster.normalizeEffectDefinition = normalizeEffectDefinition;
CONFIG.fxmaster.normalizeEffectOptionsForRuntime = normalizeEffectOptionsForRuntime;
CONFIG.fxmaster.normalizeEffectOptionsForStorageFromLegacy = normalizeEffectOptionsForStorageFromLegacy;
CONFIG.fxmaster.compressNormalizedRangeValue = compressNormalizedRangeValue;
CONFIG.fxmaster.expandNormalizedRangeValue = expandNormalizedRangeValue;
CONFIG.fxmaster.scaleNormalizedStoredRangeValue = scaleNormalizedStoredRangeValue;
CONFIG.fxmaster.SynchronizedDirectionRuntime = SynchronizedDirectionRuntime;
CONFIG.fxmaster.registerSynchronizedDirectionSource =
  SynchronizedDirectionRuntime.registerSource.bind(SynchronizedDirectionRuntime);
CONFIG.fxmaster.unregisterSynchronizedDirectionSource =
  SynchronizedDirectionRuntime.unregisterSource.bind(SynchronizedDirectionRuntime);
CONFIG.fxmaster.resolveSynchronizedDirection =
  SynchronizedDirectionRuntime.resolveDirection.bind(SynchronizedDirectionRuntime);
CONFIG.fxmaster.getSynchronizedDirectionSourceLabel =
  SynchronizedDirectionRuntime.getSourceLabel.bind(SynchronizedDirectionRuntime);
CONFIG.fxmaster.hasSynchronizedDirectionSource =
  SynchronizedDirectionRuntime.hasSource.bind(SynchronizedDirectionRuntime);
CONFIG.fxmaster.synchronizedDirectionOptionEnabled = synchronizedDirectionOptionEnabled;
CONFIG.fxmaster.synchronizedDirectionAvailable = synchronizedDirectionAvailable;
CONFIG.fxmaster.shortestDirectionDeltaDegrees = shortestDirectionDeltaDegrees;
CONFIG.fxmaster.lerpDirectionDegrees = lerpDirectionDegrees;
CONFIG.fxmaster.smoothDirectionBlend = smoothDirectionBlend;
CONFIG.fxmaster.GlobalEffectsCompositor = GlobalEffectsCompositor;
CONFIG.fxmaster.SpecialEffectsLayer = SpecialEffectsLayer;
CONFIG.fxmaster.getGlobalEffectsCompositor = () => GlobalEffectsCompositor.instance;
CONFIG.fxmaster.resolveWeatherEffectConfigLabel = resolveWeatherEffectConfigLabel;

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

/**
 * Resolve particle runtime context from an effect instance or options object.
 *
 * @param {object|null|undefined} source
 * @returns {object|null}
 */
CONFIG.fxmaster.getParticleContext = function (source) {
  return source?.__fxmParticleContext ?? source?.options?.__fxmParticleContext ?? null;
};

/**
 * Determine whether a particle context represents a scoped non-scene renderer.
 *
 * @param {object|null|undefined} context
 * @returns {boolean}
 */
CONFIG.fxmaster.isScopedParticleContext = function (context) {
  if (!context || typeof context !== "object") return false;
  if (context.dimensions || context.renderer || context.ticker) return true;
  if (context.regionId || context.behaviorId) return true;
  const scope = String(context.scope ?? "")
    .trim()
    .toLowerCase();
  return !!scope && scope !== "scene";
};

/**
 * Determine whether a particle source is running in a scoped non-scene renderer.
 *
 * @param {object|null|undefined} source
 * @returns {boolean}
 */
CONFIG.fxmaster.isScopedParticleSource = function (source) {
  return CONFIG.fxmaster.isScopedParticleContext(CONFIG.fxmaster.getParticleContext(source));
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

/**
 * Resolve the label used by the Scene weather selector.
 *
 * @param {typeof FXMasterParticleEffect|null|undefined} effectClass
 * @param {string} [fallbackLabel=""]
 * @returns {string}
 */
function resolveWeatherEffectConfigLabel(effectClass, fallbackLabel = "") {
  const explicit = effectClass?.weatherEffectLabel ?? effectClass?.weatherLabel ?? null;
  const rawLabel = String(explicit ?? effectClass?.label ?? fallbackLabel ?? "").trim();
  if (!rawLabel) return "FXMaster";

  const weatherLabel = rawLabel.endsWith("WeatherEffectsConfig") ? rawLabel : `${rawLabel}WeatherEffectsConfig`;
  if (rawLabel.startsWith("FXMASTER.")) return weatherLabel;

  const i18n = globalThis.game?.i18n ?? null;
  if (i18n?.has?.(weatherLabel)) return weatherLabel;

  const localized = i18n?.has?.(rawLabel) ? i18n.localize(rawLabel) : rawLabel;
  return /\(FXMaster\)\s*$/i.test(localized) ? localized : `${localized} (FXMaster)`;
}

Hooks.once("init", function () {
  installTileRefreshStateGuard();
  registerSettings();
  installTokenRulerGridHighlightGuard();
  Hooks.once("ready", installTokenRulerGridHighlightGuard);
  Hooks.on("canvasReady", installTokenRulerGridHighlightGuard);
  registerHooks();
  registerLayers();
  registerParticleBackgroundQueries();
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
        label: resolveWeatherEffectConfigLabel(effectClass),
        effects: [{ id: `${id}Particles`, effectClass }],
      },
    ]),
  );

  CONFIG.originalWeatherEffects = CONFIG.weatherEffects;
  CONFIG.weatherEffects = { ...CONFIG.weatherEffects, ...weatherEffects };
  registerRegionBehaviorTypes();
});

registerGetSceneControlButtonsHook();
