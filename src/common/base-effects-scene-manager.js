/**
 * FXMaster: Scene Mask Manager (Singleton)
 * ----------------------------------------
 * Computes and maintains shared "Scene Allow" masks for both particle and filter systems.
 *
 * Responsibilities:
 * - Builds separate base allow masks for particles and filters:
 * - Particles: Scene Rect − (suppressWeather + fxmaster.suppressSceneParticles)
 * - Filters:   Scene Rect − (suppressWeather + fxmaster.suppressSceneFilters)
 * - Optionally derives "below tokens" cutout masks (Base Mask − Token Silhouettes) per kind only when needed by active consumers.
 * - Optionally maintains a shared tokens-only mask used by both systems, only when needed.
 * - Reacts to camera or viewport changes via a coalesced refresh.
 */

import { packageId } from "../constants.js";
import { logger } from "../logger.js";
import { applyRegionBehaviorsToOverheadLevels } from "../settings-access.js";
import {
  buildSceneAllowMaskRT,
  clearSceneSuppressionSoftMaskCache,
  coalesceNextFrame,
  computeRegionGatePass,
  getCanvasLevel,
  getCanvasLiveLevelSurfaceRevealState,
  getCanvasLiveLevelSurfaceState,
  getCssViewportMetrics,
  getDocumentLevelsSet,
  getDocumentAssignedLevelIds,
  getEventGate,
  getRegionEffectPlaceablesForCurrentView,
  regionDocumentCanApplyInCurrentView,
  getSceneLevels as getSceneLevelDocuments,
  getRegionElevationWindow,
  inferVisibleLevelForDocument,
  isDocumentOnCurrentCanvasLevel,
  tokenUpperLevelRevealAllowsBelowTokenMask,
  syncCanvasLiveLevelSurfaceState,
  repaintTokensMaskInto,
  repaintTilesMaskInto,
  buildBelowTokenMaskCoverageSignature,
  invalidateUpperLevelCoverageCache,
  rawStageMatrix,
  safeMaskResolutionForCssArea,
  snappedStageMatrix,
  hasActiveTileRestrictionsForMask,
  documentIncludedInLevel,
  fxmGetDocumentElevationWindow,
  fxmGetLevelConfiguredImagePaths,
  fxmGetRegionBehaviorEdgeFadePercent,
  fxmLevelBottom,
  fxmLevelIsAbove,
  fxmLevelTop,
  fxmRegionBehaviorRuntimeSignature,
  fxmResolveLevelIdsFromConfiguredSources,
  fxmCollectComparableSourcePaths,
  fxmReadDocumentSnapshotCompat,
  fxmReadDocumentSnapshotValue,
  fxmDocumentId,
  fxmLinkedPlaceableFromDisplayObject,
  fxmGetPublicHoverFadeState,
} from "../utils.js";

/** @type {PIXI.Sprite|null} */
let _tmpBaseCopySprite = null;
/** @type {PIXI.Sprite|null} */
let _tmpTokensEraseSprite = null;

/** @type {Map<string, { objects: PIXI.DisplayObject[], lastUsed: number }>} */
let _upperSurfaceObjectsPersistentCache = new Map();
let _upperSurfaceObjectsPersistentCacheTick = 0;
const UPPER_SURFACE_OBJECTS_PERSISTENT_CACHE_MAX = 96;

const SUPPRESS_WEATHER = "suppressWeather";
const SUPPRESS_SCENE_PARTICLES = `${packageId}.suppressSceneParticles`;
const SUPPRESS_SCENE_FILTERS = `${packageId}.suppressSceneFilters`;

/**
 * Return a compact signature for a suppression-relevant RegionBehavior.
 *
 * Suppression presence is queried from hot compositor paths. The cache key must avoid a per-frame ticker dependency, but still reflect behavior gates that can change without altering the region count (event-gate latches, POV/target gates, GM visibility, disabled state, and token target lists).
 *
 * @param {foundry.abstract.Document|null|undefined} behavior
 * @returns {string}
 * @private
 */
function suppressionBehaviorPresenceSignature(behavior) {
  if (!behavior) return "";

  const type = behavior.type ?? "";
  if (![SUPPRESS_WEATHER, SUPPRESS_SCENE_PARTICLES, SUPPRESS_SCENE_FILTERS].includes(type)) return "";

  return fxmRegionBehaviorRuntimeSignature(behavior);
}

/**
 * Return a stable cache signature for the suppression-relevant pieces of a Region document and its placeable. This intentionally excludes the global ticker; dynamic gate state is included explicitly instead.
 *
 * @param {PlaceableObject|null|undefined} region
 * @returns {string}
 * @private
 */
function suppressionRegionPresenceSignature(region) {
  const doc = region?.document ?? null;
  if (!doc) return "";

  const window = getRegionElevationWindow(doc);
  const behaviorSig = Array.from(doc.behaviors ?? [])
    .map((behavior) => suppressionBehaviorPresenceSignature(behavior))
    .filter(Boolean)
    .join(";");

  return [
    doc.id ?? region?.id ?? "",
    doc.uuid ?? "",
    doc.elevation?.bottom ?? "",
    doc.elevation?.top ?? "",
    window?.min ?? "",
    window?.max ?? "",
    behaviorSig,
  ].join("|");
}

/**
 * Return a stable cache signature for controlled tokens that can affect POV and target-gated suppression behaviors.
 *
 * @returns {string}
 * @private
 */
function controlledTokenSuppressionSignature() {
  return Array.from(canvas?.tokens?.controlled ?? [])
    .map((token) => {
      const document = token?.document ?? null;
      const elevation = Number(document?.elevation ?? token?.elevation ?? 0);
      const elevationKey = Number.isFinite(elevation) ? elevation.toFixed(3) : "NaN";
      return [document?.id ?? token?.id ?? "", document?.uuid ?? "", document?.hidden ? 1 : 0, elevationKey].join("~");
    })
    .sort()
    .join("|");
}

/**
 * Return a stable signature for event gates that may be stored outside the Region document source in some Foundry event flows.
 *
 * @param {PlaceableObject[]} regions
 * @returns {string}
 * @private
 */
function suppressionEventGateSignature(regions) {
  const parts = [];
  for (const region of regions ?? []) {
    const doc = region?.document ?? null;
    if (!doc) continue;
    for (const type of [SUPPRESS_WEATHER, SUPPRESS_SCENE_PARTICLES, SUPPRESS_SCENE_FILTERS]) {
      const gate = getEventGate(region, type);
      if (gate?.mode === "none" && !gate?.latched) continue;
      parts.push(`${doc.id ?? region?.id ?? ""}:${type}:${gate?.mode ?? "none"}:${gate?.latched ? 1 : 0}`);
    }
  }
  return parts.sort().join("|");
}

/**
 * Recursively collect comparable source paths from an arbitrary value.
 *
 * @param {*} value
 * @param {Set<string>} output
 * @param {Set<object>} [seen]
 * @returns {void}
 * @private
 */
function collectComparableSourcePaths(value, output) {
  fxmCollectComparableSourcePaths(value, output);
}

/**
 * Normalize the scene Level collection into an array.
 *
 * @param {Scene|null|undefined} [scene=canvas?.scene ?? null]
 * @returns {Array<any>}
 * @private
 */
function getSceneLevels(scene = canvas?.scene ?? null) {
  return getSceneLevelDocuments(scene);
}

/**
 * Resolve a scene Level by id.
 *
 * @param {string|null|undefined} levelId
 * @param {Scene|null|undefined} [scene=canvas?.scene ?? null]
 * @returns {any|null}
 * @private
 */
function getSceneLevelById(levelId, scene = canvas?.scene ?? null) {
  if (!levelId) return null;
  return getSceneLevels(scene).find((level) => level?.id === levelId) ?? null;
}

/**
 * Return the bottom elevation for a Level document.
 *
 * @param {any} level
 * @returns {number}
 * @private
 */
function getLevelBottom(level) {
  return fxmLevelBottom(level);
}

/**
 * Return the top elevation for a Level document.
 *
 * @param {any} level
 * @returns {number}
 * @private
 */
function getLevelTop(level) {
  return fxmLevelTop(level);
}

/**
 * Return whether one Level sits above another.
 *
 * @param {any} candidate
 * @param {any} target
 * @returns {boolean}
 * @private
 */
function levelIsAboveTargetLevel(candidate, target) {
  return fxmLevelIsAbove(candidate, target);
}

/**
 * Return whether one Level sits below another.
 *
 * @param {any} candidate
 * @param {any} target
 * @returns {boolean}
 * @private
 */
function levelIsBelowTargetLevel(candidate, target) {
  if (!candidate || !target) return false;
  if (candidate?.id && target?.id && candidate.id === target.id) return false;

  const candidateTop = getLevelTop(candidate);
  const targetBottom = getLevelBottom(target);
  if (Number.isFinite(candidateTop) && Number.isFinite(targetBottom)) return candidateTop <= targetBottom + 1e-4;

  const candidateBottom = getLevelBottom(candidate);
  if (Number.isFinite(candidateBottom) && Number.isFinite(targetBottom)) return candidateBottom < targetBottom - 1e-4;

  return !levelIsAboveTargetLevel(candidate, target);
}

/**
 * Resolve the Level a suppression region should be treated as belonging to.
 *
 * @param {foundry.abstract.Document|null|undefined} document
 * @returns {any|null}
 * @private
 */
function resolveSuppressionRegionTargetLevel(document) {
  const currentLevel = getCanvasLevel();
  if (!currentLevel) return null;
  if (!document) return currentLevel;

  const sceneLevels = getSceneLevels(document?.parent ?? canvas?.scene ?? null);
  const regionLevels = getDocumentAssignedLevelIds(document, document?.parent ?? canvas?.scene ?? null);
  if (regionLevels?.size) {
    if (currentLevel?.id && regionLevels.has(currentLevel.id)) return currentLevel;

    const preferred = sceneLevels.find((level) => regionLevels.has(level?.id) && (level?.isView || level?.isVisible));
    if (preferred) return preferred;

    const assigned = sceneLevels.find((level) => regionLevels.has(level?.id));
    if (assigned) return assigned;
  }

  const window = getRegionElevationWindow(document);
  if (window) {
    const currentBottom = getLevelBottom(currentLevel);
    const currentTop = getLevelTop(currentLevel);
    const overlapsCurrent =
      (!Number.isFinite(window.min) || !Number.isFinite(currentTop) || currentTop >= window.min - 1e-4) &&
      (!Number.isFinite(window.max) || !Number.isFinite(currentBottom) || currentBottom <= window.max + 1e-4);
    if (overlapsCurrent) return currentLevel;
  }

  const inferredElevation = Number.isFinite(Number(window?.min))
    ? Number(window.min)
    : Number(document?.elevation?.bottom ?? document?.elevation ?? Number.NaN);
  return inferVisibleLevelForDocument(document, inferredElevation) ?? currentLevel;
}

/**
 * Return the set of Level ids a suppression region is allowed to affect directly.
 *
 * @param {foundry.abstract.Document|null|undefined} document
 * @param {any|null|undefined} fallbackLevel
 * @returns {Set<string>}
 * @private
 */
function getSuppressionAllowedLevelIds(document, fallbackLevel = null) {
  const ids = new Set();
  const currentLevel = getCanvasLevel();
  const levels = getDocumentAssignedLevelIds(document, document?.parent ?? canvas?.scene ?? null);

  if (levels?.size) {
    const allowOverhead = applyRegionBehaviorsToOverheadLevels();
    for (const levelId of levels) {
      const level = getSceneLevelById(levelId, document?.parent ?? canvas?.scene ?? null);
      if (!level) continue;
      if (currentLevel?.id && levelId === currentLevel.id) {
        ids.add(levelId);
        continue;
      }
      if (allowOverhead && currentLevel && levelIsAboveTargetLevel(level, currentLevel)) ids.add(levelId);
    }
    return ids;
  }

  if (fallbackLevel?.id) ids.add(fallbackLevel.id);
  if (currentLevel?.id) ids.add(currentLevel.id);
  return ids;
}

/**
 * Add configured background and foreground image paths for a Level document.
 *
 * @param {any} level
 * @param {Set<string>} output
 * @returns {void}
 * @private
 */
function addLevelConfiguredImagePaths(level, output) {
  if (!level || !(output instanceof Set)) return;
  for (const pathValue of fxmGetLevelConfiguredImagePaths(level, { scene: level?.parent ?? canvas?.scene ?? null })) {
    output.add(pathValue);
  }
}

/**
 * Return a stable cache key for a set of Scene Level ids.
 *
 * @param {Set<string>|null|undefined} levelIds
 * @returns {string}
 * @private
 */
function getLevelIdsCacheKey(levelIds) {
  return Array.from(levelIds ?? [])
    .filter(Boolean)
    .sort()
    .join("|");
}

/**
 * Build a persistent cache key for upper-Level preservation object lists.
 *
 * The collected display objects are stable across frames unless Level visibility, hover reveal, controlled-token reveal, protected Levels, or the active scene changes. Cache misses still rebuild through the existing correctness path.
 *
 * @param {any|null|undefined} targetLevel
 * @param {Set<string>|null|undefined} protectedLevelIds
 * @returns {string|null}
 * @private
 */
function upperSurfaceObjectsPersistentCacheKey(targetLevel, protectedLevelIds) {
  if (!targetLevel?.id || !canvas?.level) return null;

  let surfaceState = null;
  try {
    surfaceState = getCanvasLiveLevelSurfaceState(canvas?.scene ?? null, { presynced: true });
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  /**
   * Avoid cross-frame reuse while Foundry is actively animating hover/reveal state. The per-refresh context cache remains active for the current call.
   */
  if (surfaceState?.forceRefresh) return null;

  return [
    canvas?.scene?.id ?? "scene",
    targetLevel.id,
    getLevelIdsCacheKey(protectedLevelIds),
    surfaceState?.key ?? "surface-state-unavailable",
  ].join("::");
}

/**
 * Get a cached upper-surface object list when every referenced DisplayObject is still live.
 *
 * @param {string|null} key
 * @returns {PIXI.DisplayObject[]|null}
 * @private
 */
function getCachedPersistentUpperSurfaceObjects(key) {
  if (!key) return null;
  const cached = _upperSurfaceObjectsPersistentCache.get(key) ?? null;
  if (!cached) return null;
  if (!Array.isArray(cached.objects) || cached.objects.some((object) => !object || object.destroyed)) {
    _upperSurfaceObjectsPersistentCache.delete(key);
    return null;
  }

  cached.lastUsed = ++_upperSurfaceObjectsPersistentCacheTick;
  return cached.objects;
}

/**
 * Store an upper-surface object list in the cross-frame cache.
 *
 * @param {string|null} key
 * @param {PIXI.DisplayObject[]} objects
 * @returns {PIXI.DisplayObject[]}
 * @private
 */
function rememberPersistentUpperSurfaceObjects(key, objects) {
  const value = Array.isArray(objects) ? objects : [];
  if (!key) return value;

  _upperSurfaceObjectsPersistentCache.set(key, {
    objects: value,
    lastUsed: ++_upperSurfaceObjectsPersistentCacheTick,
  });

  if (_upperSurfaceObjectsPersistentCache.size > UPPER_SURFACE_OBJECTS_PERSISTENT_CACHE_MAX) {
    const victims = [..._upperSurfaceObjectsPersistentCache.entries()]
      .sort((a, b) => (a[1]?.lastUsed ?? 0) - (b[1]?.lastUsed ?? 0))
      .slice(0, Math.max(0, _upperSurfaceObjectsPersistentCache.size - UPPER_SURFACE_OBJECTS_PERSISTENT_CACHE_MAX));
    for (const [victim] of victims) _upperSurfaceObjectsPersistentCache.delete(victim);
  }

  return value;
}

/**
 * Clear upper-Level preservation object cache.
 *
 * @returns {void}
 * @private
 */
function clearPersistentUpperSurfaceObjectsCache() {
  _upperSurfaceObjectsPersistentCache.clear();
  _upperSurfaceObjectsPersistentCacheTick = 0;
}

/**
 * Return a normalized set of configured image paths for protected levels.
 *
 * @param {Set<string>|null|undefined} protectedLevelIds
 * @param {object|null} [context]
 * @returns {Set<string>}
 * @private
 */
function getProtectedLevelImagePaths(protectedLevelIds, context = null) {
  const key = getLevelIdsCacheKey(protectedLevelIds);
  const cache = context?.protectedLevelImagePathsByKey ?? null;
  if (cache?.has(key)) return cache.get(key) ?? new Set();

  const paths = new Set();
  if (protectedLevelIds?.size > 0) {
    for (const levelId of protectedLevelIds) addLevelConfiguredImagePaths(getSceneLevelById(levelId), paths);
  }

  cache?.set(key, paths);
  return paths;
}

/**
 * Create per-refresh state for region suppression calculations.
 *
 * @returns {{ levelTextures: PIXI.DisplayObject[]|null, tileMeshes: PIXI.DisplayObject[]|null, protectedLevelImagePathsByKey: Map<string, Set<string>>, visibleOverlayLevelIdsByKey: Map<string, Set<string>>, visibleOverlayLevelsByKey: Map<string, Array<any>>, upperSurfaceObjectsByKey: Map<string, PIXI.DisplayObject[]>, suppressedUpperSurfaceObjectsByKey: Map<string, PIXI.DisplayObject[]>, visibleSurfaceObjectsByLevelKey: Map<string, PIXI.DisplayObject[]>, visibleLowerSurfaceObjectsByKey: Map<string, PIXI.DisplayObject[]>, visibleOtherLevelTokenPreservationByKey: Map<string, { objects: PIXI.DisplayObject[], shapes: object[] }>, currentLevelSurfaceScopedSuppressionByKey: Map<string, Set<string>>, suppressionBehaviorSummaryByDocument: WeakMap<object, object>, syncedLiveLevelSurfaceState: boolean }}
 * @private
 */
function createSuppressionRefreshContext() {
  return {
    levelTextures: null,
    tileMeshes: null,
    tokenPlaceables: null,
    directLowerLevelRevealTokenCandidates: null,
    protectedLevelImagePathsByKey: new Map(),
    visibleOverlayLevelIdsByKey: new Map(),
    visibleOverlayLevelsByKey: new Map(),
    upperSurfaceObjectsByKey: new Map(),
    suppressedUpperSurfaceObjectsByKey: new Map(),
    visibleSurfaceObjectsByLevelKey: new Map(),
    visibleLowerSurfaceObjectsByKey: new Map(),
    visibleOtherLevelTokenPreservationByKey: new Map(),
    currentLevelSurfaceScopedSuppressionByKey: new Map(),
    suppressionBehaviorSummaryByDocument: new WeakMap(),
    syncedLiveLevelSurfaceState: false,
  };
}

/**
 * Synchronize live Level surface state once for a region suppression refresh.
 *
 * @param {object|null} context
 * @returns {void}
 * @private
 */
function syncSuppressionLiveLevelState(context) {
  if (!canvas?.level || context?.syncedLiveLevelSurfaceState) return;

  try {
    syncCanvasLiveLevelSurfaceState();
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  if (context) context.syncedLiveLevelSurfaceState = true;
}

/**
 * Return cached Level surface meshes for a region suppression refresh.
 *
 * @param {object|null} context
 * @returns {PIXI.DisplayObject[]}
 * @private
 */
function getSuppressionContextLevelTextures(context) {
  if (Array.isArray(context?.levelTextures)) return context.levelTextures;
  const levelTextures = Array.from(canvas?.primary?.levelTextures ?? []);
  if (context) context.levelTextures = levelTextures;
  return levelTextures;
}

/**
 * Return cached tile meshes for a region suppression refresh.
 *
 * @param {object|null} context
 * @returns {PIXI.DisplayObject[]}
 * @private
 */
function getSuppressionContextTileMeshes(context) {
  if (Array.isArray(context?.tileMeshes)) return context.tileMeshes;
  const tileMeshes =
    typeof canvas?.primary?.tiles?.values === "function"
      ? Array.from(canvas.primary.tiles.values())
      : Array.from(canvas?.primary?.tiles ?? []);
  if (context) context.tileMeshes = tileMeshes;
  return tileMeshes;
}

/**
 * Return cached suppression behavior metadata for a Region document.
 *
 * @param {foundry.abstract.Document|null|undefined} document
 * @param {object|null} [context]
 * @returns {{ hasWeather: boolean, particleBehaviors: object[], filterBehaviors: object[] }}
 * @private
 */
function getSuppressionBehaviorSummary(document, context = null) {
  if (!document) return { hasWeather: false, particleBehaviors: [], filterBehaviors: [] };

  const cache = context?.suppressionBehaviorSummaryByDocument ?? null;
  if (cache?.has(document)) return cache.get(document);

  const summary = {
    hasWeather: false,
    particleBehaviors: [],
    filterBehaviors: [],
  };

  for (const behavior of document.behaviors ?? []) {
    if (!behavior || behavior.disabled) continue;
    if (behavior.type === SUPPRESS_WEATHER) summary.hasWeather = true;
    else if (behavior.type === SUPPRESS_SCENE_PARTICLES) summary.particleBehaviors.push(behavior);
    else if (behavior.type === SUPPRESS_SCENE_FILTERS) summary.filterBehaviors.push(behavior);
  }

  try {
    cache?.set(document, summary);
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  return summary;
}

/**
 * Add scene Level ids represented by an arbitrary value into an output set.
 *
 * @param {*} value
 * @param {Set<string>} output
 * @param {Set<object>} [seen]
 * @returns {void}
 * @private
 */
function addSceneLevelIdsFromValue(value, output, seen = new Set()) {
  if (!value || !output) return;

  if (typeof value === "string") {
    if (getSceneLevelById(value)) output.add(value);
    return;
  }

  if ((typeof value === "object" || typeof value === "function") && seen.has(value)) return;
  if (typeof value === "object" || typeof value === "function") seen.add(value);

  if (Array.isArray(value)) {
    for (const entry of value) addSceneLevelIdsFromValue(entry, output, seen);
    return;
  }

  if (value instanceof Set || (typeof value?.[Symbol.iterator] === "function" && typeof value !== "string")) {
    try {
      for (const entry of value) addSceneLevelIdsFromValue(entry, output, seen);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  const candidateId = fxmDocumentId(value) || fxmDocumentId(value?.document) || null;
  if (candidateId && getSceneLevelById(candidateId)) output.add(candidateId);

  const nested = [
    value?.level ?? null,
    value?.levels ?? null,
    value?.document?.level ?? null,
    value?.document?.levels ?? null,
    fxmReadDocumentSnapshotValue(value, "level") ?? null,
    fxmReadDocumentSnapshotValue(value, "levels") ?? null,
  ];
  for (const entry of nested) {
    if (!entry || entry === value) continue;
    addSceneLevelIdsFromValue(entry, output, seen);
  }
}

/**
 * Resolve the scene Level ids a live surface explicitly targets.
 *
 * @param {{ mesh?: object|null, object?: object|null, document?: foundry.abstract.Document|null, level?: object|null }} [options]
 * @returns {Set<string>}
 * @private
 */
function resolveSurfaceLevelIds({ mesh = null, object = null, document = null, level = null } = {}) {
  const ids = new Set();

  const candidates = [
    level,
    mesh?.level ?? null,
    mesh?.levels ?? null,
    mesh?.object?.level ?? null,
    mesh?.object?.levels ?? null,
    object?.level ?? null,
    object?.levels ?? null,
    object?.document?.level ?? null,
    object?.document?.levels ?? null,
    document,
    document?.level ?? null,
    document?.levels ?? null,
    fxmReadDocumentSnapshotValue(document, "level") ?? null,
    fxmReadDocumentSnapshotValue(document, "levels") ?? null,
  ];
  for (const candidate of candidates) addSceneLevelIdsFromValue(candidate, ids);

  const directLevels = getDocumentLevelsSet(document ?? object ?? null);
  if (directLevels?.size) {
    for (const levelId of directLevels) if (getSceneLevelById(levelId)) ids.add(levelId);
  }

  return ids;
}

/**
 * Return whether a value is a Foundry document-like source whose elevation field should be trusted over a live mesh fallback. V14 level texture meshes seemingly can expose PrimaryCanvasGroup as object/document, whose elevation is not the stacked texture's actual elevation.
 *
 * @param {*} value
 * @returns {boolean}
 * @private
 */
function isDocumentBackedSurface(value) {
  if (!value || typeof value !== "object") return false;

  const ctorName = value?.constructor?.name ?? "";
  if (typeof value?.documentName === "string" && value.documentName.length) return true;
  if (typeof value?.constructor?.documentName === "string" && value.constructor.documentName.length) return true;
  if (ctorName === "Level" || ctorName.endsWith("Document")) return true;

  const source = fxmReadDocumentSnapshotCompat(value);
  if (!source || typeof source !== "object") return false;
  return (
    source.elevation !== undefined ||
    source.levels !== undefined ||
    source.level !== undefined ||
    source.background !== undefined ||
    source.foreground !== undefined ||
    source.texture !== undefined
  );
}

/**
 * Return a normalized elevation window for a surface.
 *
 * @param {foundry.abstract.Document|object|null|undefined} document
 * @param {number} [fallbackElevation=Number.NaN]
 * @returns {{min:number,max:number}|null}
 * @private
 */
function getSurfaceElevationWindow(document, fallbackElevation = Number.NaN) {
  const publicWindow = fxmGetDocumentElevationWindow(document, fallbackElevation);
  if (publicWindow) return publicWindow;

  const fallback = Number(fallbackElevation);
  const trustDocumentElevation = isDocumentBackedSurface(document) || !Number.isFinite(fallback);
  const sourceElevation = trustDocumentElevation
    ? document?.elevation ?? fxmReadDocumentSnapshotValue(document, "elevation") ?? null
    : null;
  const scalarElevation = Number(sourceElevation);
  if (Number.isFinite(scalarElevation)) return { min: scalarElevation, max: scalarElevation };

  const bottom = sourceElevation?.bottom ?? fxmReadDocumentSnapshotValue(document, ["elevation", "bottom"]);
  const top = sourceElevation?.top ?? fxmReadDocumentSnapshotValue(document, ["elevation", "top"]);
  const hasBottom = bottom !== undefined && bottom !== null && `${bottom}`.trim() !== "";
  const hasTop = top !== undefined && top !== null && `${top}`.trim() !== "";
  if (hasBottom || hasTop) {
    return {
      min: hasBottom ? Number(bottom) : Number.NEGATIVE_INFINITY,
      max: hasTop ? Number(top) : Number.POSITIVE_INFINITY,
    };
  }

  if (Number.isFinite(fallback)) return { min: fallback, max: fallback };
  return null;
}

/**
 * Return whether an elevation window overlaps a specific Scene Level window.
 *
 * @param {{min:number,max:number}|null|undefined} window
 * @param {any} level
 * @returns {boolean}
 * @private
 */
function surfaceWindowOverlapsLevel(window, level) {
  if (!window || !level) return false;

  const levelBottom = getLevelBottom(level);
  const levelTop = getLevelTop(level);
  const windowMin = Number(window.min);
  const windowMax = Number(window.max);

  const reachesLevelBottom =
    !Number.isFinite(windowMax) || !Number.isFinite(levelBottom) || windowMax >= levelBottom - 1e-4;
  const reachesLevelTop = !Number.isFinite(windowMin) || !Number.isFinite(levelTop) || windowMin <= levelTop + 1e-4;
  return reachesLevelBottom && reachesLevelTop;
}

/**
 * Return whether two Level id sets intersect.
 *
 * @param {Set<string>} surfaceLevelIds
 * @param {Set<string>} candidateLevelIds
 * @returns {boolean}
 * @private
 */
function surfaceLevelIdsIntersect(surfaceLevelIds, candidateLevelIds) {
  if (!(surfaceLevelIds?.size > 0) || !(candidateLevelIds?.size > 0)) return false;
  for (const levelId of surfaceLevelIds) if (candidateLevelIds.has(levelId)) return true;
  return false;
}

/**
 * Resolve Level ids through Foundry's public document ownership API.
 *
 * @param {{ mesh?: object|null, object?: object|null, document?: foundry.abstract.Document|null, level?: object|null }} [surface]
 * @returns {Set<string>}
 * @private
 */
function resolveSurfaceIncludedLevelIds({ mesh = null, object = null, document = null, level = null } = {}) {
  const ids = new Set();
  const scene = canvas?.scene ?? document?.parent ?? object?.document?.parent ?? level?.parent ?? null;
  if (!scene) return ids;

  const candidates = [
    document,
    object?.document ?? null,
    object,
    mesh?.document ?? null,
    mesh?.object?.document ?? null,
    mesh?.object ?? null,
  ];
  const seenCandidates = new Set();

  const levels = getSceneLevels(scene);
  for (const candidate of candidates) {
    if (!candidate || seenCandidates.has(candidate)) continue;
    seenCandidates.add(candidate);
    for (const sceneLevel of levels) {
      const levelId = sceneLevel?.id ?? null;
      if (!levelId) continue;
      const included = documentIncludedInLevel(candidate, sceneLevel);
      if (included === true) ids.add(levelId);
    }
  }

  if (levels.length && ids.size >= levels.length) return new Set();
  return ids;
}

/**
 * Resolve Level ids by matching a live surface texture source against configured V14 Level background/foreground images.
 *
 * @param {{ mesh?: object|null, object?: object|null, document?: foundry.abstract.Document|null, level?: object|null }} [surface]
 * @returns {Set<string>}
 * @private
 */
function resolveSurfaceConfiguredLevelIds({ mesh = null, object = null, document = null, level = null } = {}) {
  const surfacePaths = new Set();
  collectComparableSourcePaths(mesh, surfacePaths);
  collectComparableSourcePaths(object, surfacePaths);
  collectComparableSourcePaths(document, surfacePaths);
  collectComparableSourcePaths(level, surfacePaths);
  if (!surfacePaths.size) return new Set();

  return fxmResolveLevelIdsFromConfiguredSources(surfacePaths, {
    scene: canvas?.scene ?? document?.parent ?? object?.document?.parent ?? level?.parent ?? null,
  });
}

/**
 * Resolve directly-owned Level ids from live surface fields that identify a single owner Level rather than a broad document visibility list.
 *
 * @param {{ mesh?: object|null, object?: object|null, document?: foundry.abstract.Document|null, level?: object|null }} [surface]
 * @returns {Set<string>}
 * @private
 */
function resolveSurfaceOwnerLevelIds({ mesh = null, object = null, document = null, level = null } = {}) {
  const ids = new Set();
  const candidates = [
    level,
    mesh?.level ?? null,
    mesh?.object?.level ?? null,
    object?.level ?? null,
    document?.level ?? null,
  ];
  for (const candidate of candidates) addSceneLevelIdsFromValue(candidate, ids);
  return ids;
}

/**
 * Return whether a surface explicitly or implicitly belongs to one of the supplied Level ids.
 *
 * @param {{ mesh?: object|null, object?: object|null, document?: foundry.abstract.Document|null, level?: object|null, elevation?: number, window?: {min:number,max:number}|null }} [surface]
 * @param {Set<string>|null|undefined} levelIds
 * @returns {boolean}
 * @private
 */
function _surfaceTargetsLevelIds(
  { mesh = null, object = null, document = null, level = null, elevation = Number.NaN, window = null } = {},
  levelIds,
) {
  if (!(levelIds?.size > 0)) return false;

  const configuredIds = resolveSurfaceConfiguredLevelIds({ mesh, object, document, level });
  if (configuredIds.size) return surfaceLevelIdsIntersect(configuredIds, levelIds);

  const ownerIds = resolveSurfaceOwnerLevelIds({ mesh, object, document, level });
  if (ownerIds.size) return surfaceLevelIdsIntersect(ownerIds, levelIds);

  const includedIds = resolveSurfaceIncludedLevelIds({ mesh, object, document, level });
  if (includedIds.size) return surfaceLevelIdsIntersect(includedIds, levelIds);

  const explicitIds = resolveSurfaceLevelIds({ mesh, object, document, level });
  if (explicitIds.size) return surfaceLevelIdsIntersect(explicitIds, levelIds);

  const inferredLevel = inferVisibleLevelForDocument(document ?? object ?? level ?? null, elevation);
  if (inferredLevel?.id) return levelIds.has(inferredLevel.id);

  const effectiveWindow = window ?? getSurfaceElevationWindow(document ?? object ?? level ?? null, elevation);
  if (effectiveWindow) {
    for (const levelId of levelIds) {
      const sceneLevel = getSceneLevelById(levelId);
      if (sceneLevel && surfaceWindowOverlapsLevel(effectiveWindow, sceneLevel)) return true;
    }
  }

  return false;
}

/**
 * Return whether a live surface has a direct, single-Level identity for one of the supplied ids. This intentionally avoids the broad elevation-window fallback used by general overlay preservation because Region-overhead masks must not let an intermediate Level capture the silhouette of a higher overlay.
 *
 * @param {{ mesh?: object|null, object?: object|null, document?: foundry.abstract.Document|null, level?: object|null, elevation?: number }} [surface]
 * @param {Set<string>|null|undefined} levelIds
 * @returns {boolean}
 * @private
 */
function surfaceStrictlyTargetsLevelIds(
  { mesh = null, object = null, document = null, level = null, elevation = Number.NaN } = {},
  levelIds,
) {
  if (!(levelIds?.size > 0)) return false;

  const configuredIds = resolveSurfaceConfiguredLevelIds({ mesh, object, document, level });
  if (configuredIds.size === 1) return surfaceLevelIdsIntersect(configuredIds, levelIds);

  const ownerIds = resolveSurfaceOwnerLevelIds({ mesh, object, document, level });
  if (ownerIds.size === 1) return surfaceLevelIdsIntersect(ownerIds, levelIds);

  const includedIds = resolveSurfaceIncludedLevelIds({ mesh, object, document, level });
  if (includedIds.size === 1) return surfaceLevelIdsIntersect(includedIds, levelIds);

  const explicitIds = resolveSurfaceLevelIds({ mesh, object, document, level });
  if (explicitIds.size === 1) return surfaceLevelIdsIntersect(explicitIds, levelIds);

  const inferredLevel = inferVisibleLevelForDocument(document ?? object ?? level ?? null, elevation);
  if (inferredLevel?.id) return levelIds.has(inferredLevel.id);

  const directLevelId = level?.id ?? document?.level?.id ?? object?.level?.id ?? object?.document?.level?.id ?? null;
  return directLevelId ? levelIds.has(directLevelId) : false;
}

/**
 * Return the strict, single-Level identity for a live surface using the same precedence as {@link surfaceStrictlyTargetsLevelIds}.
 *
 * This is used by the visible-overlay fast path so it can scan live surfaces once and mark the exact upper Levels that actually contribute pixels.
 *
 * @param {{ mesh?: object|null, object?: object|null, document?: foundry.abstract.Document|null, level?: object|null, elevation?: number }} [surface]
 * @returns {Set<string>}
 * @private
 */
function getStrictSurfaceLevelMatchIds({
  mesh = null,
  object = null,
  document = null,
  level = null,
  elevation = Number.NaN,
} = {}) {
  const configuredIds = resolveSurfaceConfiguredLevelIds({ mesh, object, document, level });
  if (configuredIds.size === 1) return configuredIds;

  const ownerIds = resolveSurfaceOwnerLevelIds({ mesh, object, document, level });
  if (ownerIds.size === 1) return ownerIds;

  const includedIds = resolveSurfaceIncludedLevelIds({ mesh, object, document, level });
  if (includedIds.size === 1) return includedIds;

  const explicitIds = resolveSurfaceLevelIds({ mesh, object, document, level });
  if (explicitIds.size === 1) return explicitIds;

  const inferredLevel = inferVisibleLevelForDocument(document ?? object ?? level ?? null, elevation);
  if (inferredLevel?.id) return new Set([inferredLevel.id]);

  const directLevelId = level?.id ?? document?.level?.id ?? object?.level?.id ?? object?.document?.level?.id ?? null;
  return directLevelId ? new Set([directLevelId]) : new Set();
}

/**
 * Add strict surface Level matches that intersect a candidate Level set.
 *
 * @param {Set<string>} output
 * @param {{ mesh?: object|null, object?: object|null, document?: foundry.abstract.Document|null, level?: object|null, elevation?: number }} surface
 * @param {Set<string>} candidateLevelIds
 * @returns {void}
 * @private
 */
function addStrictSurfaceLevelMatches(output, surface, candidateLevelIds) {
  if (!(output instanceof Set) || !(candidateLevelIds?.size > 0)) return;
  for (const levelId of getStrictSurfaceLevelMatchIds(surface)) {
    if (candidateLevelIds.has(levelId)) output.add(levelId);
  }
}

/**
 * Return whether a live display object resolves to one of the protected level image paths.
 *
 * @param {{ mesh?: object|null, object?: object|null, document?: foundry.abstract.Document|null, level?: object|null }} [surface]
 * @param {Set<string>|null|undefined} protectedImagePaths
 * @returns {boolean}
 * @private
 */
function surfaceUsesProtectedLevelImagePaths(
  { mesh = null, object = null, document = null, level = null } = {},
  protectedImagePaths,
) {
  if (!(protectedImagePaths?.size > 0)) return false;

  const paths = new Set();
  collectComparableSourcePaths(mesh, paths);
  collectComparableSourcePaths(object, paths);
  collectComparableSourcePaths(document, paths);
  collectComparableSourcePaths(level, paths);

  for (const pathValue of paths) {
    if (protectedImagePaths.has(pathValue)) return true;
  }

  return false;
}

/**
 * Return ids for currently visible overlay Levels above a target Level.
 *
 * This is a coarse fast path for the common case where no upper overlays are visible. It avoids calling the heavier per-Level surface collector once for every upper Level by scanning live Level/tile surfaces at most once per target/protected-Level combination.
 *
 * @param {any} targetLevel
 * @param {{ protectedLevelIds?: Set<string>|null, context?: object|null }} [options]
 * @returns {Set<string>}
 * @private
 */
function getVisibleOverlayLevelIdsAboveTarget(targetLevel, { protectedLevelIds = null, context = null } = {}) {
  if (!targetLevel) return new Set();

  const cacheKey = `${targetLevel?.id ?? ""}:${getLevelIdsCacheKey(protectedLevelIds)}:visible-overlays`;
  const cache = context?.visibleOverlayLevelIdsByKey ?? null;
  if (cache?.has(cacheKey)) return cache.get(cacheKey) ?? new Set();

  const remember = (ids) => {
    const value = ids instanceof Set ? ids : new Set();
    cache?.set(cacheKey, value);
    return value;
  };

  const candidateLevels = [];
  const visibleLevelIds = new Set();
  for (const level of getSceneLevels()) {
    const levelId = level?.id ?? null;
    if (!levelId) continue;
    if (protectedLevelIds?.has(levelId)) continue;
    if (!levelIsAboveTargetLevel(level, targetLevel)) continue;

    candidateLevels.push(level);
    if (level?.isVisible || level?.isView) visibleLevelIds.add(levelId);
  }

  if (!candidateLevels.length) return remember(visibleLevelIds);
  if (visibleLevelIds.size >= candidateLevels.length) return remember(visibleLevelIds);
  if (!canvas?.primary) return remember(visibleLevelIds);

  const candidateLevelIds = new Set(
    candidateLevels.map((level) => level?.id).filter((levelId) => levelId && !visibleLevelIds.has(levelId)),
  );
  if (!candidateLevelIds.size) return remember(visibleLevelIds);

  try {
    syncSuppressionLiveLevelState(context);
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  const allCandidatesVisible = () => visibleLevelIds.size >= candidateLevels.length;

  for (const mesh of getSuppressionContextLevelTextures(context)) {
    if (allCandidatesVisible()) break;

    const object = mesh?.object ?? null;
    const liveRenderObject = resolveLiveSurfaceDisplayObject(mesh, object);
    const captureObject = displayObjectContributesVisiblePixels(mesh)
      ? mesh
      : displayObjectContributesVisiblePixels(liveRenderObject)
      ? liveRenderObject
      : null;
    if (!captureObject) continue;
    if (!displayObjectIntersectsViewportForSuppression(captureObject)) continue;

    const document = mesh?.level?.document ?? mesh?.level ?? object?.document ?? object ?? null;
    const level = mesh?.level ?? object?.level ?? document?.level ?? null;
    const elevation = Number(
      mesh?.elevation ??
        document?.elevation?.bottom ??
        document?.elevation ??
        object?.document?.elevation?.bottom ??
        object?.document?.elevation ??
        Number.NaN,
    );
    addStrictSurfaceLevelMatches(visibleLevelIds, { mesh, object, document, level, elevation }, candidateLevelIds);
  }

  for (const mesh of getSuppressionContextTileMeshes(context)) {
    if (allCandidatesVisible()) break;

    const tileObject = fxmLinkedPlaceableFromDisplayObject(mesh);
    const liveRenderObject = resolveLiveSurfaceDisplayObject(mesh, tileObject);
    const captureObject = displayObjectContributesVisiblePixels(mesh)
      ? mesh
      : displayObjectContributesVisiblePixels(liveRenderObject)
      ? liveRenderObject
      : null;
    if (!captureObject) continue;
    if (!displayObjectIntersectsViewportForSuppression(captureObject)) continue;
    if (tileObject && !tileIsActiveOnCanvasForSuppression(tileObject)) continue;

    const document = tileObject?.document ?? null;
    const elevation = Number(mesh?.elevation ?? document?.elevation ?? tileObject?.elevation ?? Number.NaN);
    const level = mesh?.level ?? tileObject?.level ?? document?.level ?? null;
    addStrictSurfaceLevelMatches(
      visibleLevelIds,
      { mesh, object: tileObject, document: document ?? tileObject ?? null, level, elevation },
      candidateLevelIds,
    );
  }

  return remember(visibleLevelIds);
}

/**
 * Return all currently visible overlay Levels above a target Level.
 *
 * @param {any} targetLevel
 * @param {{ protectedLevelIds?: Set<string>|null, context?: object|null }} [options]
 * @returns {Array<any>}
 * @private
 */
function getVisibleOverlayLevelsAboveTarget(targetLevel, { protectedLevelIds = null, context = null } = {}) {
  if (!targetLevel) return [];

  const cacheKey = `${targetLevel?.id ?? ""}:${getLevelIdsCacheKey(protectedLevelIds)}:visible-overlay-levels`;
  const cache = context?.visibleOverlayLevelsByKey ?? null;
  if (cache?.has(cacheKey)) return cache.get(cacheKey) ?? [];

  const visibleLevelIds = getVisibleOverlayLevelIdsAboveTarget(targetLevel, { protectedLevelIds, context });
  const value = visibleLevelIds.size ? getSceneLevels().filter((level) => visibleLevelIds.has(level?.id ?? null)) : [];
  cache?.set(cacheKey, value);
  return value;
}

/**
 * Return whether a live display object currently contributes visible pixels.
 *
 * @param {PIXI.DisplayObject|null|undefined} object
 * @returns {boolean}
 * @private
 */
function displayObjectContributesVisiblePixels(object) {
  if (!object || object.destroyed) return false;
  if (object.visible === false || object.renderable === false) return false;

  const alpha = Number(object.worldAlpha ?? object.alpha ?? 1);
  return !(Number.isFinite(alpha) && alpha <= 0.001);
}

/**
 * Return whether a live display object intersects the current CSS viewport.
 *
 * @param {PIXI.DisplayObject|null|undefined} object
 * @returns {boolean}
 * @private
 */
function displayObjectIntersectsViewportForSuppression(object) {
  if (!object || object.destroyed) return false;

  const { cssW, cssH } = getCssViewportMetrics();
  const padding = 8;

  try {
    const bounds = object.getBounds?.(false) ?? null;
    if (!bounds) return true;
    if (bounds.x > cssW + padding) return false;
    if (bounds.y > cssH + padding) return false;
    if (bounds.x + bounds.width < -padding) return false;
    if (bounds.y + bounds.height < -padding) return false;
    return true;
  } catch (err) {
    logger.debug("FXMaster:", err);
    return true;
  }
}

/**
 * Collect visible live canvas surfaces that belong to one of the supplied Level ids.
 *
 * This is used for object-scoped suppression on a non-current, hoverable upper Level. It avoids rebuilding a full per-Level suppression plan and instead clips the already visible upper-Level surface silhouettes into the Region suppression mask.
 *
 * @param {Set<string>|null|undefined} levelIds
 * @param {{ context?: object|null, includeTiles?: boolean }} [options]
 * @returns {PIXI.DisplayObject[]}
 * @private
 */
function collectVisibleSurfaceObjectsForLevelIds(levelIds, { context = null, includeTiles = true } = {}) {
  if (!(levelIds?.size > 0) || !canvas?.primary) return [];

  const cacheKey = `${getLevelIdsCacheKey(levelIds)}::tiles:${includeTiles ? 1 : 0}:strict`;
  const cache = context?.visibleSurfaceObjectsByLevelKey ?? null;
  if (cache?.has(cacheKey)) return cache.get(cacheKey) ?? [];

  const remember = (objects) => {
    const value = objects ?? [];
    cache?.set(cacheKey, value);
    return value;
  };

  syncSuppressionLiveLevelState(context);

  const objects = [];
  const seen = new Set();
  const push = (object) => {
    if (!object || seen.has(object)) return;
    seen.add(object);
    objects.push(object);
  };

  for (const mesh of getSuppressionContextLevelTextures(context)) {
    const object = mesh?.object ?? null;
    const liveRenderObject = resolveLiveSurfaceDisplayObject(mesh, object);
    const captureObject = displayObjectContributesVisiblePixels(mesh)
      ? mesh
      : displayObjectContributesVisiblePixels(liveRenderObject)
      ? liveRenderObject
      : null;
    if (!captureObject) continue;
    if (!displayObjectIntersectsViewportForSuppression(captureObject)) continue;

    const document = mesh?.level?.document ?? mesh?.level ?? object?.document ?? object ?? null;
    const level = mesh?.level ?? object?.level ?? document?.level ?? null;
    const elevation = Number(
      mesh?.elevation ??
        document?.elevation?.bottom ??
        document?.elevation ??
        object?.document?.elevation?.bottom ??
        object?.document?.elevation ??
        Number.NaN,
    );
    if (!surfaceStrictlyTargetsLevelIds({ mesh, object, document, level, elevation }, levelIds)) continue;
    push(captureObject);
  }

  if (!includeTiles) return remember(objects);

  for (const mesh of getSuppressionContextTileMeshes(context)) {
    const tileObject = fxmLinkedPlaceableFromDisplayObject(mesh);
    const liveRenderObject = resolveLiveSurfaceDisplayObject(mesh, tileObject);
    const captureObject = displayObjectContributesVisiblePixels(mesh)
      ? mesh
      : displayObjectContributesVisiblePixels(liveRenderObject)
      ? liveRenderObject
      : null;
    if (!captureObject) continue;
    if (!displayObjectIntersectsViewportForSuppression(captureObject)) continue;
    if (tileObject && !tileIsActiveOnCanvasForSuppression(tileObject)) continue;

    const document = tileObject?.document ?? null;
    const elevation = Number(mesh?.elevation ?? document?.elevation ?? tileObject?.elevation ?? Number.NaN);
    const level = mesh?.level ?? tileObject?.level ?? document?.level ?? null;
    if (
      !surfaceStrictlyTargetsLevelIds(
        { mesh, object: tileObject, document: document ?? tileObject ?? null, level, elevation },
        levelIds,
      )
    )
      continue;
    push(captureObject);
  }

  return remember(objects);
}

/**
 * Return the world-space center point for a token-like placeable.
 *
 * @param {Token|null|undefined} token
 * @returns {PIXI.Point|{x:number,y:number}|null}
 * @private
 */
function getTokenCenterPointForSuppression(token) {
  const boundsCenter = token?.bounds?.center ?? null;
  if (Number.isFinite(boundsCenter?.x) && Number.isFinite(boundsCenter?.y)) return boundsCenter;

  const center = token?.center ?? null;
  if (Number.isFinite(center?.x) && Number.isFinite(center?.y)) return center;

  const x = Number(token?.document?.x ?? token?.x ?? Number.NaN);
  const y = Number(token?.document?.y ?? token?.y ?? Number.NaN);
  const width = Number(token?.document?.width ?? token?.w ?? token?.width ?? Number.NaN);
  const height = Number(token?.document?.height ?? token?.h ?? token?.height ?? Number.NaN);
  const gridSize = Number(canvas?.grid?.size ?? canvas?.dimensions?.size ?? 1);
  if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(width) && Number.isFinite(height)) {
    return { x: x + (width * gridSize) / 2, y: y + (height * gridSize) / 2 };
  }

  return null;
}

/**
 * Return whether Foundry's live scene mask currently includes a token center.
 *
 * @param {Token|null|undefined} token
 * @returns {boolean|null}
 * @private
 */
function sceneMaskContainsTokenCenterForSuppression(token) {
  const sceneMask = canvas?.masks?.scene ?? null;
  if (!sceneMask || sceneMask.destroyed) return null;

  const point = getTokenCenterPointForSuppression(token);
  if (!point) return null;

  try {
    if (typeof sceneMask.containsPoint === "function") return !!sceneMask.containsPoint(point);
  } catch (err) {
    logger.debug("FXMaster:", err);
    return null;
  }

  const hitArea = sceneMask.hitArea ?? null;
  const worldTransform = sceneMask.worldTransform ?? null;
  if (typeof hitArea?.contains !== "function" || typeof worldTransform?.applyInverse !== "function") return null;

  try {
    const localPoint = worldTransform.applyInverse(point, new PIXI.Point());
    return !!hitArea.contains(localPoint.x, localPoint.y);
  } catch (err) {
    logger.debug("FXMaster:", err);
    return null;
  }
}

/**
 * Return a token's public/inferred Level ids.
 *
 * @param {Token|null|undefined} token
 * @param {Scene|null|undefined} [scene=canvas?.scene ?? null]
 * @returns {Set<string>}
 * @private
 */
function getTokenSuppressionLevelIds(token, scene = canvas?.scene ?? null) {
  const document = token?.document ?? token ?? null;
  if (!document) return new Set();

  /**
   * Suppression ownership must use the token's authored/native Level, not Foundry's transient `includedInLevel` answer. While hovering a higher Level overlay, native Levels can reveal a lower-Level token through the current view; treating that reveal as Level ownership makes a Level 2 suppression Region affect the Level 1 token instead of preserving it.
   */
  const sceneForLookup = scene ?? document?.parent ?? canvas?.scene ?? null;
  const elevation = Number(token?.document?.elevation ?? token?.elevation ?? Number.NaN);

  const rawLevels = document?.levels ?? null;
  let directLevels = null;
  if (rawLevels instanceof Set) directLevels = new Set(Array.from(rawLevels).map(String).filter(Boolean));
  else if (Array.isArray(rawLevels)) directLevels = new Set(rawLevels.map(String).filter(Boolean));
  else if (typeof rawLevels?.values === "function") {
    try {
      directLevels = new Set(Array.from(rawLevels.values()).map(String).filter(Boolean));
    } catch (_err) {
      directLevels = null;
    }
  } else if (typeof rawLevels?.[Symbol.iterator] === "function" && typeof rawLevels !== "string") {
    try {
      directLevels = new Set(Array.from(rawLevels).map(String).filter(Boolean));
    } catch (_err) {
      directLevels = null;
    }
  }
  if (directLevels?.size) return directLevels;

  const directLevel = document?.level ?? null;
  const directLevelId = typeof directLevel === "string" ? directLevel : fxmDocumentId(directLevel) || null;
  if (directLevelId) {
    const level = getSceneLevelById(directLevelId, sceneForLookup);
    if (!level || !Number.isFinite(elevation)) return new Set([String(directLevelId)]);

    const bottom = getLevelBottom(level);
    const top = getLevelTop(level);
    const withinBottom = !Number.isFinite(bottom) || elevation >= bottom - 1e-4;
    const withinTop = !Number.isFinite(top) || elevation <= top + 1e-4;
    if (withinBottom && withinTop) return new Set([String(directLevelId)]);
  }

  /**
   * Use authored/elevation ownership before Foundry's visible-Level inference. canvas.inferLevelFromElevation intentionally falls back to the currently viewed Level when no visible Level contains the elevation. During native hover reveal this can classify a lower-Level token as the viewed Level, which prevents level-scoped suppression from restoring the revealed lower token aperture.
   */
  if (Number.isFinite(elevation)) {
    const ids = new Set();
    for (const level of getSceneLevels(sceneForLookup)) {
      const levelId = String(fxmDocumentId(level)).trim();
      if (!levelId) continue;
      const bottom = getLevelBottom(level);
      const top = getLevelTop(level);
      const withinBottom = !Number.isFinite(bottom) || elevation >= bottom - 1e-4;
      const withinTop = !Number.isFinite(top) || elevation <= top + 1e-4;
      if (withinBottom && withinTop) ids.add(levelId);
    }
    if (ids.size) return ids;

    const inferred = inferVisibleLevelForDocument(document, elevation);
    if (inferred?.id) {
      const bottom = getLevelBottom(inferred);
      const top = getLevelTop(inferred);
      const withinBottom = !Number.isFinite(bottom) || elevation >= bottom - 1e-4;
      const withinTop = !Number.isFinite(top) || elevation <= top + 1e-4;
      if (withinBottom && withinTop) return new Set([String(inferred.id)]);
    }
  }

  return new Set();
}

/**
 * Return whether a token elevation is outside every suppression target Level.
 *
 * @param {Token|null|undefined} token
 * @param {Set<string>|null|undefined} targetLevelIds
 * @returns {boolean}
 * @private
 */
function tokenElevationIsOutsideSuppressionTargets(token, targetLevelIds) {
  if (!(targetLevelIds?.size > 0)) return false;

  const elevation = Number(token?.document?.elevation ?? token?.elevation ?? Number.NaN);
  if (!Number.isFinite(elevation)) return false;

  const scene = token?.document?.parent ?? canvas?.scene ?? null;
  for (const levelId of targetLevelIds) {
    const level = getSceneLevelById(levelId, scene);
    if (!level) continue;

    const bottom = getLevelBottom(level);
    const top = getLevelTop(level);
    const withinBottom = !Number.isFinite(bottom) || elevation >= bottom - 1e-4;
    const withinTop = !Number.isFinite(top) || elevation <= top + 1e-4;
    if (withinBottom && withinTop) return false;
  }

  return true;
}

/**
 * Return whether a token belongs to the currently viewed Level for suppression preservation purposes.
 *
 * This deliberately avoids `document.includedInLevel`, because native Levels can report a lower-Level token as included in the current view while it is only temporarily revealed by a hover/occlusion opening.
 *
 * @param {Token|null|undefined} token
 * @returns {boolean}
 * @private
 */
function tokenIsOnCurrentCanvasLevelForSuppression(token) {
  if (!canvas?.level) return true;

  const currentLevelId = String(fxmDocumentId(canvas.level)).trim();
  if (!currentLevelId)
    return isDocumentOnCurrentCanvasLevel(
      token?.document ?? null,
      token?.document?.elevation ?? token?.elevation ?? Number.NaN,
    );

  const tokenLevelIds = getTokenSuppressionLevelIds(token, token?.document?.parent ?? canvas?.scene ?? null);
  if (tokenLevelIds.size) return tokenLevelIds.has(currentLevelId);

  return !tokenElevationIsOutsideSuppressionTargets(token, new Set([currentLevelId]));
}

/**
 * Return whether a token is visible or revealed enough to preserve from a screen-space suppression Region that targets other Levels.
 *
 * @param {Token|null|undefined} token
 * @returns {boolean}
 * @private
 */
function tokenIsVisibleOrRevealedForSuppression(token, { allowOffCurrentSceneMaskReveal = false } = {}) {
  if (!token || token.destroyed || token?.document?.hidden) return false;
  if (token?.controlled === true) return true;

  const onCurrentLevel = tokenIsOnCurrentCanvasLevelForSuppression(token);

  /**
   * Direct token hover is the most reliable signal for native Levels' local lower-Level reveal aperture. Do not require the broader upper-surface helper to also report a reveal here: while viewing the Region's assigned Level, Foundry can expose a lower-Level token through its own hover path without making the token appear to belong to the current Level.
   */
  if (!onCurrentLevel && tokenIsDirectlyHoveredForSuppression(token)) return true;

  const sceneMaskVisible = sceneMaskContainsTokenCenterForSuppression(token);
  if (sceneMaskVisible === true && (onCurrentLevel || allowOffCurrentSceneMaskReveal)) return true;

  try {
    if (tokenUpperLevelRevealAllowsBelowTokenMask(token, { requireDirectHoverForSceneMask: !onCurrentLevel }))
      return true;
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  const mesh = token?.mesh ?? token?.sprite ?? token;
  if (!displayObjectContributesVisiblePixels(mesh)) return false;

  /**
   * For off-current Levels, a live mesh can remain around while Foundry clips it through the Level scene mask. Avoid preserving it unless the scene mask or native reveal helpers above confirmed it is actually visible.
   */
  if (!onCurrentLevel) return false;

  return true;
}

/**
 * Return whether Foundry currently considers the token itself hovered.
 *
 * This is intentionally stricter than hovering a higher-Level overlay. The lower-Level reveal aperture is restored only when the lower token is directly hovered or controlled.
 *
 * @param {Token|null|undefined} token
 * @returns {boolean}
 * @private
 */
function tokenIsDirectlyHoveredForSuppression(token) {
  if (!token || token.destroyed) return false;
  if (token.hover === true || token.hovered === true) return true;

  const hovered = [canvas?.tokens?.hover, token?.layer?.hover, canvas?.activeLayer?.hover].filter(Boolean);
  const tokenId = token?.document?.id ?? token?.id ?? null;
  const tokenUuid = token?.document?.uuid ?? null;
  for (const candidate of hovered) {
    if (candidate === token) return true;
    const candidateId = candidate?.document?.id ?? candidate?.id ?? null;
    if (candidateId && tokenId && String(candidateId) === String(tokenId)) return true;
    const candidateUuid = candidate?.document?.uuid ?? null;
    if (candidateUuid && tokenUuid && candidateUuid === tokenUuid) return true;
  }

  return false;
}

/**
 * Return the only tokens that can trigger the direct lower-Level reveal path.
 *
 * Surface-scoped current-Level suppression is only needed when Foundry is revealing a lower-Level token through direct hover or explicit control. The old defensive path scanned every token for every target Level; this keeps the hot hover frame bounded to the active hover/control set.
 *
 * @returns {Token[]}
 * @private
 */
function getSuppressionContextTokenPlaceables(context = null) {
  if (Array.isArray(context?.tokenPlaceables)) return context.tokenPlaceables;
  const tokens = Array.from(canvas?.tokens?.placeables ?? []);
  if (context) context.tokenPlaceables = tokens;
  return tokens;
}

function getDirectLowerLevelRevealCandidateTokensForSuppression(context = null) {
  if (Array.isArray(context?.directLowerLevelRevealTokenCandidates))
    return context.directLowerLevelRevealTokenCandidates;

  const candidates = [];
  const seen = new Set();
  const push = (token) => {
    if (!token || token.destroyed || token?.document?.hidden) return;
    const documentName = String(token?.document?.documentName ?? token?.documentName ?? "");
    if (documentName && documentName !== "Token") return;
    const id = String(token?.document?.id ?? token?.id ?? "");
    const key = id || token;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(token);
  };

  push(canvas?.tokens?.hover ?? null);
  push(canvas?.activeLayer?.hover ?? null);
  for (const token of canvas?.tokens?.controlled ?? []) push(token);

  if (context) context.directLowerLevelRevealTokenCandidates = candidates;
  return candidates;
}

/**
 * Return whether a token is authored below a suppression target Level.
 *
 * @param {Token|null|undefined} token
 * @param {any|null|undefined} targetLevel
 * @param {Set<string>|null|undefined} tokenLevelIds
 * @returns {boolean}
 * @private
 */
function tokenIsBelowSuppressionTargetLevel(token, targetLevel, tokenLevelIds = null) {
  if (!token || !targetLevel) return false;

  if (tokenLevelIds?.size) {
    for (const levelId of tokenLevelIds) {
      const level = getSceneLevelById(levelId, token?.document?.parent ?? canvas?.scene ?? null);
      if (level && levelIsBelowTargetLevel(level, targetLevel)) return true;
    }
  }

  const tokenElevation = Number(token?.document?.elevation ?? token?.elevation ?? Number.NaN);
  const targetBottom = getLevelBottom(targetLevel);
  return Number.isFinite(tokenElevation) && Number.isFinite(targetBottom) && tokenElevation < targetBottom - 1e-4;
}

/**
 * Return whether a token is a directly revealed lower-/other-Level token for a current-Level suppression target.
 *
 * The diagnostic case that motivated this helper is: viewing Level 2, a Region assigned to Level 2 suppresses scene FX, and a Level 1 token is directly hovered. Foundry reveals the lower token through the Level 2 view, but a screen-space Region erase still suppresses lower-Level pixels. When that happens, the current-Level suppression Region needs to be clipped to the target Level's live surface coverage rather than applied as a broad 2D hole.
 *
 * @param {Token|null|undefined} token
 * @param {any|null|undefined} targetLevel
 * @param {Set<string>|null|undefined} targetLevelIds
 * @returns {boolean}
 * @private
 */
function tokenIsDirectLowerLevelRevealForSuppressionTarget(token, targetLevel, targetLevelIds) {
  if (!token || token.destroyed || token?.document?.hidden || !targetLevel || !(targetLevelIds?.size > 0)) return false;

  const tokenLevelIds = getTokenSuppressionLevelIds(token, token?.document?.parent ?? canvas?.scene ?? null);
  for (const levelId of tokenLevelIds) {
    if (targetLevelIds.has(String(levelId))) return false;
  }

  if (!tokenLevelIds.size && !tokenElevationIsOutsideSuppressionTargets(token, targetLevelIds)) return false;
  if (!tokenIsBelowSuppressionTargetLevel(token, targetLevel, tokenLevelIds)) return false;

  return token?.controlled === true || tokenIsDirectlyHoveredForSuppression(token);
}

/**
 * Return whether a current-Level suppression target has an active directly revealed lower-/other-Level token anywhere in the current view.
 *
 * This deliberately does not require overlap with the Region shape. The leak is caused by switching Foundry into a lower-Level reveal state while the current Level is viewed; once that state exists, a broad current-Level screen-space suppression hole can affect lower-Level pixels inside any same-Level Region.
 *
 * @param {any|null|undefined} targetLevel
 * @param {Set<string>|null|undefined} targetLevelIds
 * @param {object|null} [context]
 * @returns {boolean}
 * @private
 */
function hasDirectLowerLevelRevealForSuppressionTarget(targetLevel, targetLevelIds, context = null) {
  if (!targetLevel || !(targetLevelIds?.size > 0) || !canvas?.tokens) return false;

  const cacheKey = `${targetLevel?.id ?? ""}:${getLevelIdsCacheKey(targetLevelIds)}:direct-lower-reveal`;
  const cache = context?.currentLevelSurfaceScopedSuppressionByKey ?? null;
  if (cache?.has(cacheKey)) return (cache.get(cacheKey)?.size ?? 0) > 0;

  let active = false;
  for (const token of getDirectLowerLevelRevealCandidateTokensForSuppression(context)) {
    if (tokenIsDirectLowerLevelRevealForSuppressionTarget(token, targetLevel, targetLevelIds)) {
      active = true;
      break;
    }
  }

  const value = active ? new Set(targetLevelIds) : new Set();
  cache?.set(cacheKey, value);
  return active;
}

/**
 * Return Level ids whose visible target surfaces should be used to clip a current-Level Region suppression hole.
 *
 * Current-Level suppression normally uses the Region's 2D shape. That is fast, but native Levels can reveal lower-Level content while the current Level remains selected. During that state, a broad 2D erase affects the lower-Level pixels even when the Region is assigned only to the current Level. Clipping the erase to the assigned/current Level's live surface objects keeps suppression Level-scoped without depending on Foundry private APIs.
 *
 * @param {foundry.abstract.Document|null|undefined} document
 * @param {any|null|undefined} targetLevel
 * @param {Set<string>|null|undefined} regionLevelIds
 * @param {Set<string>|null|undefined} protectedLevelIds
 * @param {object|null} [context]
 * @returns {Set<string>}
 * @private
 */
function getCurrentLevelSurfaceScopedSuppressionLevelIds(
  document,
  targetLevel,
  regionLevelIds,
  protectedLevelIds,
  context = null,
) {
  if (!canvas?.level || !document || !targetLevel || !(regionLevelIds?.size > 0)) return new Set();

  const currentLevelId = String(fxmDocumentId(canvas.level)).trim();
  const targetLevelId = String(fxmDocumentId(targetLevel)).trim();
  if (!currentLevelId || !targetLevelId || currentLevelId !== targetLevelId) return new Set();
  if (!regionLevelIds.has(currentLevelId)) return new Set();

  const allowed = protectedLevelIds?.size
    ? new Set(Array.from(protectedLevelIds).map(String).filter(Boolean))
    : new Set([currentLevelId]);
  if (!allowed.size) return new Set();
  if (!hasDirectLowerLevelRevealForSuppressionTarget(targetLevel, allowed, context)) return new Set();

  return allowed;
}

/**
 * Return the approximate native-Level reveal radius for an off-target token.
 *
 * @param {Token|null|undefined} token
 * @returns {number}
 * @private
 */
function getTokenSuppressionRevealRadius(token) {
  const candidates = [];
  try {
    const occludableRadius = token?.document?.occludable?.radius;
    const lightRadius = typeof token?.getLightRadius === "function" ? token.getLightRadius(occludableRadius) : NaN;
    candidates.push(lightRadius);
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  const gridSize = Number(canvas?.grid?.size ?? canvas?.dimensions?.size ?? 1) || 1;
  candidates.push(
    token?.externalRadius,
    token?.document?.occludable?.radius,
    token?.bounds?.width ? token.bounds.width / 2 : NaN,
    token?.bounds?.height ? token.bounds.height / 2 : NaN,
    token?.w ? token.w / 2 : NaN,
    token?.h ? token.h / 2 : NaN,
    gridSize * 0.75,
  );

  const radius = Math.max(
    0,
    ...candidates.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0),
  );

  /**
   * Match Foundry's native occlusion aperture scale. The native occlusion mask draws a circle using max(token.externalRadius, token.getLightRadius(token occludable radius)) and does not clamp that radius to a few grid spaces. A cap here can leave suppression active around the outer part of a revealed lower-Level aperture.
   */
  return Math.max(1, radius);
}

/**
 * Return a lightweight world-space shape that mirrors the local lower-Level token reveal aperture closely enough for suppression preservation.
 *
 * @param {Token|null|undefined} token
 * @returns {object|null}
 * @private
 */
function buildTokenSuppressionRevealShape(token) {
  const center = token?.center ?? token?.bounds?.center ?? null;
  let x = Number(center?.x);
  let y = Number(center?.y);

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    const gridSize = Number(canvas?.grid?.size ?? canvas?.dimensions?.size ?? 1) || 1;
    const doc = token?.document ?? null;
    const tx = Number(doc?.x ?? token?.x ?? Number.NaN);
    const ty = Number(doc?.y ?? token?.y ?? Number.NaN);
    const tw = Number(doc?.width ?? token?.w ?? token?.width ?? 1) * gridSize;
    const th = Number(doc?.height ?? token?.h ?? token?.height ?? 1) * gridSize;
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) return null;
    x = tx + (Number.isFinite(tw) ? tw / 2 : gridSize / 2);
    y = ty + (Number.isFinite(th) ? th / 2 : gridSize / 2);
  }

  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  const radius = getTokenSuppressionRevealRadius(token);
  return {
    type: "circle",
    source: "token-reveal",
    tokenId: String(token?.document?.id ?? token?.id ?? ""),
    x,
    y,
    radius,
  };
}

/**
 * Collect visibly revealed token display objects whose Levels are outside the Region suppression target set.
 *
 * Region suppression masks are screen-space. A Level-scoped Region should not suppress lower-Level tokens that Foundry is currently revealing through a hover/occlusion opening unless that lower Level is also assigned to the Region.
 *
 * @param {any|null|undefined} targetLevel
 * @param {{ assignedLevelIds?: Set<string>|null, protectedLevelIds?: Set<string>|null, context?: object|null }} [options]
 * @returns {PIXI.DisplayObject[]}
 * @private
 */
function collectVisibleOtherLevelTokenPreservationForTargetLevel(
  targetLevel,
  { assignedLevelIds = null, protectedLevelIds = null, context = null } = {},
) {
  if (!targetLevel || !canvas?.tokens) return { objects: [], shapes: [] };

  const targetLevelIds = new Set(
    Array.from(assignedLevelIds?.size ? assignedLevelIds : protectedLevelIds ?? [])
      .map(String)
      .filter(Boolean),
  );
  if (targetLevel?.id) targetLevelIds.add(String(targetLevel.id));
  if (!targetLevelIds.size) return { objects: [], shapes: [] };

  const cacheKey = `${targetLevel?.id ?? ""}:${getLevelIdsCacheKey(targetLevelIds)}:tokens-preserve`;
  const cache = context?.visibleOtherLevelTokenPreservationByKey ?? null;
  if (cache?.has(cacheKey)) return cache.get(cacheKey) ?? { objects: [], shapes: [] };

  const remember = (value) => {
    const normalized = value ?? { objects: [], shapes: [] };
    cache?.set(cacheKey, normalized);
    return normalized;
  };

  const objects = [];
  const shapes = [];
  const seenObjects = new Set();
  const seenShapes = new Set();
  const push = (object) => {
    if (!object || object.destroyed || seenObjects.has(object)) return;
    seenObjects.add(object);
    objects.push(object);
  };

  const scene = canvas?.scene ?? null;
  for (const token of getSuppressionContextTokenPlaceables(context)) {
    if (!tokenIsVisibleOrRevealedForSuppression(token, { allowOffCurrentSceneMaskReveal: true })) continue;

    const tokenLevelIds = getTokenSuppressionLevelIds(token, token?.document?.parent ?? scene);
    let intersectsTarget = false;
    for (const levelId of tokenLevelIds) {
      if (targetLevelIds.has(String(levelId))) {
        intersectsTarget = true;
        break;
      }
    }
    if (intersectsTarget) continue;

    if (!tokenLevelIds.size && !tokenElevationIsOutsideSuppressionTargets(token, targetLevelIds)) continue;

    const tokenRevealsLowerLevel =
      tokenIsBelowSuppressionTargetLevel(token, targetLevel, tokenLevelIds) &&
      (token?.controlled === true ||
        tokenIsDirectlyHoveredForSuppression(token) ||
        sceneMaskContainsTokenCenterForSuppression(token) === true);

    /**
     * Add the reveal-aperture shape before requiring the token mesh itself to be renderable. Native Levels can reveal a lower token through an occlusion aperture while the token placeable/mesh is still clipped or not contributing visible pixels according to PIXI flags. The shape is what protects the lower-Level aperture from a current-Level Region suppression mask.
     */
    if (tokenRevealsLowerLevel) {
      const shape = buildTokenSuppressionRevealShape(token);
      if (shape) {
        const shapeKey = `${shape.tokenId}:${Math.round(shape.x * 10)}:${Math.round(shape.y * 10)}:${Math.round(
          shape.radius * 10,
        )}`;
        if (!seenShapes.has(shapeKey)) {
          seenShapes.add(shapeKey);
          shapes.push(shape);
        }
      }
    }

    const mesh = token?.mesh ?? token?.sprite ?? token;
    if (!displayObjectContributesVisiblePixels(mesh)) continue;
    if (!displayObjectIntersectsViewportForSuppression(mesh)) continue;

    push(mesh);
  }

  return remember({ objects, shapes });
}

/**
 * Return a compact signature for off-target token reveal apertures that should be restored into Level-scoped suppression allow masks.
 *
 * @param {PlaceableObject[]} regions
 * @param {Array<"particles"|"filters">} kinds
 * @returns {string}
 * @private
 */
function buildDynamicSuppressionPreservationSignature(regions, kinds = ["particles", "filters"]) {
  if (!canvas?.level) return "";

  const context = createSuppressionRefreshContext();
  if (!getDirectLowerLevelRevealCandidateTokensForSuppression(context).length) return "";

  const requested = new Set(kinds ?? []);
  const wantsParticles = requested.has("particles");
  const wantsFilters = requested.has("filters");
  if (!wantsParticles && !wantsFilters) return "";

  const parts = [];

  for (const region of regions ?? []) {
    const doc = region?.document ?? null;
    if (!doc) continue;
    if (!regionDocumentCanApplyInCurrentView(doc, doc?.parent ?? canvas?.scene ?? null)) continue;

    const regionLevelIds = getDocumentAssignedLevelIds(doc, doc?.parent ?? canvas?.scene ?? null);
    if (!(regionLevelIds?.size > 0)) continue;

    const summary = getSuppressionBehaviorSummary(doc, context);
    const hasRelevantSuppression =
      ((wantsParticles || wantsFilters) &&
        summary.hasWeather &&
        computeRegionGatePass(region, { behaviorType: SUPPRESS_WEATHER })) ||
      (wantsParticles &&
        !!summary.particleBehaviors.length &&
        computeRegionGatePass(region, { behaviorType: SUPPRESS_SCENE_PARTICLES })) ||
      (wantsFilters &&
        !!summary.filterBehaviors.length &&
        computeRegionGatePass(region, { behaviorType: SUPPRESS_SCENE_FILTERS }));

    if (!hasRelevantSuppression) continue;

    const targetLevel = resolveSuppressionRegionTargetLevel(doc);
    if (!targetLevel) continue;

    const protectedLevelIds = getSuppressionAllowedLevelIds(doc, targetLevel);
    const preservation = collectVisibleOtherLevelTokenPreservationForTargetLevel(targetLevel, {
      assignedLevelIds: regionLevelIds,
      protectedLevelIds,
      context,
    });

    const shapes = preservation?.shapes ?? [];
    if (!shapes.length) continue;

    parts.push(
      [
        doc?.id ?? region?.id ?? "",
        doc?.uuid ?? "",
        shapes
          .map((shape) =>
            [
              shape.type ?? "",
              shape.tokenId ?? "",
              Number(shape.x ?? 0).toFixed(2),
              Number(shape.y ?? 0).toFixed(2),
              Number(shape.radius ?? 0).toFixed(2),
              Number(shape.width ?? 0).toFixed(2),
              Number(shape.height ?? 0).toFixed(2),
            ].join("~"),
          )
          .join(";"),
      ].join("|"),
    );
  }

  return parts.sort().join("#");
}

/**
 * Collect visible lower-Level surfaces outside the Region suppression target set.
 *
 * @param {any|null|undefined} targetLevel
 * @param {{ assignedLevelIds?: Set<string>|null, protectedLevelIds?: Set<string>|null, context?: object|null }} [options]
 * @returns {PIXI.DisplayObject[]}
 * @private
 */
function _collectLowerSurfaceObjectsForTargetLevel(
  targetLevel,
  { assignedLevelIds = null, protectedLevelIds = null, context = null } = {},
) {
  if (!targetLevel || !canvas?.level) return [];

  const excludedIds = new Set(
    Array.from(assignedLevelIds?.size ? assignedLevelIds : protectedLevelIds ?? [])
      .map(String)
      .filter(Boolean),
  );
  if (targetLevel?.id) excludedIds.add(String(targetLevel.id));

  const cacheKey = `${targetLevel?.id ?? ""}:${getLevelIdsCacheKey(excludedIds)}:lower-surfaces`;
  const cache = context?.visibleLowerSurfaceObjectsByKey ?? null;
  if (cache?.has(cacheKey)) return cache.get(cacheKey) ?? [];

  const lowerLevelIds = new Set();
  for (const level of getSceneLevels(targetLevel?.parent ?? canvas?.scene ?? null)) {
    const levelId = String(level?.id ?? "");
    if (!levelId || excludedIds.has(levelId)) continue;
    if (levelIsBelowTargetLevel(level, targetLevel)) lowerLevelIds.add(levelId);
  }

  const objects = lowerLevelIds.size
    ? collectVisibleSurfaceObjectsForLevelIds(lowerLevelIds, { context, includeTiles: true })
    : [];
  cache?.set(cacheKey, objects);
  return objects;
}

/**
 * Merge display-object lists while preserving first occurrence order.
 *
 * @param  {...Array<PIXI.DisplayObject>|null|undefined} lists
 * @returns {PIXI.DisplayObject[]}
 * @private
 */
function mergeDisplayObjectLists(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const object of list ?? []) {
      if (!object || seen.has(object)) continue;
      seen.add(object);
      out.push(object);
    }
  }
  return out;
}

/**
 * Prefer the live placeable-backed display object for a preserved upper-Level surface.
 *
 * Hover-driven native-Level reveal can be represented on the interactive mesh rather than the cached primary backing surface. When restoring visible upper overlays into a suppression mask, sample whichever display object currently mirrors what the viewer sees.
 *
 * @param {PIXI.DisplayObject|null|undefined} primaryObject
 * @param {object|null|undefined} linkedObject
 * @returns {PIXI.DisplayObject|null}
 * @private
 */
function resolveLiveSurfaceDisplayObject(primaryObject, linkedObject) {
  const liveObject = linkedObject?.mesh ?? linkedObject?.primaryMesh ?? linkedObject?.sprite ?? null;
  return liveObject ?? primaryObject ?? linkedObject ?? null;
}

/**
 * Return whether a tile currently contributes a visible live surface on the canvas.
 *
 * @param {Tile|null|undefined} tile
 * @returns {boolean}
 * @private
 */
function tileIsActiveOnCanvasForSuppression(tile) {
  if (!tile || tile.document?.hidden) return false;
  if (!canvas?.level) return true;
  if (isDocumentOnCurrentCanvasLevel(tile.document ?? null, tile.document?.elevation ?? tile?.elevation ?? Number.NaN))
    return true;

  const primaryMeshes =
    typeof canvas?.primary?.tiles?.values === "function"
      ? Array.from(canvas.primary.tiles.values())
      : [tile?.mesh ?? null];
  for (const mesh of primaryMeshes) {
    if (!mesh) continue;

    const linked = fxmLinkedPlaceableFromDisplayObject(mesh);
    const linkedId = linked?.document?.id ?? linked?.id ?? null;
    const tileId = tile?.document?.id ?? tile?.id ?? null;
    if (tileId && linkedId && linkedId !== tileId) continue;
    if (!linkedId && linked && linked !== tile) continue;

    const visible = typeof tile?.isVisible === "boolean" ? tile.isVisible : tile?.visible;
    const meshVisible = mesh?.visible;
    const renderable = mesh?.renderable;
    const worldAlpha = Number(mesh?.worldAlpha ?? mesh?.alpha ?? tile?.alpha ?? tile?.document?.alpha ?? 0);
    if (meshVisible !== false && renderable !== false && worldAlpha > 0.001) return true;
    if (!mesh && visible !== false) return true;

    const hoverFade = fxmGetPublicHoverFadeState(mesh, tile);
    if (hoverFade?.faded) return true;

    const fadeOcclusion = Number(
      mesh?.fadeOcclusion ?? mesh?.shader?.uniforms?.fadeOcclusion ?? hoverFade?.occlusion ?? 0,
    );
    if (Number.isFinite(fadeOcclusion) && fadeOcclusion > 0) return true;
  }

  return tile?.occluded === true;
}

/**
 * Return whether a live surface belongs to one of the currently visible overlay Levels.
 *
 * @param {{ mesh?: object|null, object?: object|null, document?: foundry.abstract.Document|null, level?: object|null, elevation?: number }} [surface]
 * @param {any|null|undefined} targetLevel
 * @param {{ protectedLevelIds?: Set<string>|null, overlayLevels?: Array<any>|null }} [options]
 * @returns {boolean}
 * @private
 */
function surfaceBelongsToVisibleOverlayLevels(
  { mesh = null, object = null, document = null, level = null, elevation = Number.NaN } = {},
  targetLevel,
  { protectedLevelIds = null, overlayLevels = null } = {},
) {
  if (!targetLevel) return false;

  const activeOverlayLevels = Array.isArray(overlayLevels)
    ? overlayLevels
    : getVisibleOverlayLevelsAboveTarget(targetLevel, { protectedLevelIds });
  if (!activeOverlayLevels.length) return false;

  const overlayLevelIds = new Set(
    activeOverlayLevels.map((candidate) => candidate?.id).filter((id) => typeof id === "string" && id.length),
  );
  if (!overlayLevelIds.size) return false;

  if (surfaceStrictlyTargetsLevelIds({ mesh, object, document, level, elevation }, protectedLevelIds)) return false;
  return surfaceStrictlyTargetsLevelIds({ mesh, object, document, level, elevation }, overlayLevelIds);
}

/**
 * Collect currently rendered upper-level surfaces above a target Level.
 *
 * @param {any|null|undefined} targetLevel
 * @param {{ protectedLevelIds?: Set<string>|null, context?: object|null, includeRevealed?: boolean }} [options]
 * @returns {PIXI.DisplayObject[]}
 * @private
 */
function collectUpperSurfaceObjectsForTargetLevel(
  targetLevel,
  { protectedLevelIds = null, context = null, includeRevealed = false } = {},
) {
  if (!targetLevel || !canvas?.primary) return [];

  const cacheKey = context
    ? `${targetLevel?.id ?? ""}:${getLevelIdsCacheKey(protectedLevelIds)}:revealed:${includeRevealed ? 1 : 0}`
    : null;
  const cache = context?.upperSurfaceObjectsByKey ?? null;
  if (cacheKey && cache?.has(cacheKey)) return cache.get(cacheKey) ?? [];
  const remember = (objects) => {
    const value = objects ?? [];
    if (cacheKey) cache?.set(cacheKey, value);
    return value;
  };

  const overlayLevels = getVisibleOverlayLevelsAboveTarget(targetLevel, { protectedLevelIds, context });
  if (!overlayLevels.length) return remember([]);

  syncSuppressionLiveLevelState(context);

  const persistentCacheKey = `${upperSurfaceObjectsPersistentCacheKey(targetLevel, protectedLevelIds)}:revealed:${
    includeRevealed ? 1 : 0
  }`;
  const persistentObjects = getCachedPersistentUpperSurfaceObjects(persistentCacheKey);
  if (persistentObjects) return remember(persistentObjects);

  const protectedImagePaths = getProtectedLevelImagePaths(protectedLevelIds, context);
  const objects = [];
  const seen = new Set();
  const push = (object) => {
    if (!object || seen.has(object)) return;
    seen.add(object);
    objects.push(object);
  };

  for (const mesh of getSuppressionContextLevelTextures(context)) {
    const object = mesh?.object ?? null;
    const liveRenderObject = resolveLiveSurfaceDisplayObject(mesh, object);
    const captureObject = displayObjectContributesVisiblePixels(mesh)
      ? mesh
      : displayObjectContributesVisiblePixels(liveRenderObject)
      ? liveRenderObject
      : null;
    if (!captureObject) continue;
    const document = mesh?.level?.document ?? mesh?.level ?? object?.document ?? object ?? null;
    const level = mesh?.level ?? object?.level ?? document?.level ?? null;
    if (surfaceUsesProtectedLevelImagePaths({ mesh, object, document, level }, protectedImagePaths)) continue;
    const elevation = Number(
      mesh?.elevation ??
        document?.elevation?.bottom ??
        document?.elevation ??
        object?.document?.elevation?.bottom ??
        object?.document?.elevation ??
        Number.NaN,
    );
    if (
      !surfaceBelongsToVisibleOverlayLevels({ mesh, object, document, level, elevation }, targetLevel, {
        protectedLevelIds,
        overlayLevels,
      })
    )
      continue;
    const revealObject = liveRenderObject ?? captureObject;
    const revealState = getCanvasLiveLevelSurfaceRevealState(revealObject, {
      mesh: revealObject,
      object,
      document,
      level,
      elevation,
    });
    if (!includeRevealed && revealState.revealed) continue;
    push(captureObject);
  }

  for (const mesh of getSuppressionContextTileMeshes(context)) {
    const tileObject = fxmLinkedPlaceableFromDisplayObject(mesh);
    const liveRenderObject = resolveLiveSurfaceDisplayObject(mesh, tileObject);
    const captureObject = displayObjectContributesVisiblePixels(mesh)
      ? mesh
      : displayObjectContributesVisiblePixels(liveRenderObject)
      ? liveRenderObject
      : null;
    if (!captureObject) continue;

    const document = tileObject?.document ?? null;
    if (tileObject && !tileIsActiveOnCanvasForSuppression(tileObject)) continue;

    const elevation = Number(mesh?.elevation ?? document?.elevation ?? tileObject?.elevation ?? Number.NaN);
    const level = mesh?.level ?? tileObject?.level ?? document?.level ?? null;
    if (
      !surfaceBelongsToVisibleOverlayLevels(
        { mesh, object: tileObject, document: document ?? tileObject ?? null, level, elevation },
        targetLevel,
        { protectedLevelIds, overlayLevels },
      )
    )
      continue;
    const revealObject = liveRenderObject ?? captureObject;
    const revealState = getCanvasLiveLevelSurfaceRevealState(revealObject, {
      mesh: revealObject,
      object: tileObject,
      document: document ?? tileObject ?? null,
      level,
      elevation,
    });
    if (!includeRevealed && revealState.revealed) continue;
    push(captureObject);
  }

  return remember(rememberPersistentUpperSurfaceObjects(persistentCacheKey, objects));
}

/**
 * Collect visible upper-level surfaces that belong to Levels which should remain suppressed after unassigned intermediate overlays are restored.
 *
 * The ordinary preservation path erases a whole Region, then restores visible unassigned upper overlays so a lower-Level suppression Region does not mask roofs/floors above it. When a Region is assigned to non-contiguous Levels (for example Level 1 and Level 3), restoring the intermediate Level 2 overlay can otherwise re-allow the final Level 3 pixel in the screen-space allow mask. This helper reuses the cached upper-surface collection and returns only the protected upper objects that need to be erased again after restoration.
 *
 * @param {any|null|undefined} targetLevel
 * @param {{ protectedLevelIds?: Set<string>|null, preserveObjects?: PIXI.DisplayObject[]|null, context?: object|null }} [options]
 * @returns {PIXI.DisplayObject[]}
 * @private
 */
function collectSuppressedUpperSurfaceObjectsForTargetLevel(
  targetLevel,
  { protectedLevelIds = null, preserveObjects = null, context = null } = {},
) {
  if (!targetLevel || !(protectedLevelIds?.size > 0) || !canvas?.level) return [];

  const protectedUpperLevelIds = new Set();
  for (const levelId of protectedLevelIds) {
    if (!levelId || levelId === targetLevel.id) continue;
    const level = getSceneLevelById(levelId);
    if (!level) continue;
    if (!levelIsAboveTargetLevel(level, targetLevel)) continue;
    const visible =
      level?.isVisible ||
      level?.isView ||
      collectVisibleSurfaceObjectsForLevelIds(new Set([levelId]), { context, includeTiles: true }).length > 0;
    if (visible) protectedUpperLevelIds.add(levelId);
  }
  if (!protectedUpperLevelIds.size) return [];

  const cacheKey = `${targetLevel?.id ?? ""}:${getLevelIdsCacheKey(protectedUpperLevelIds)}:${getLevelIdsCacheKey(
    protectedLevelIds,
  )}`;
  const cache = context?.suppressedUpperSurfaceObjectsByKey ?? null;
  if (cache?.has(cacheKey)) return cache.get(cacheKey) ?? [];

  const remember = (objects) => {
    const value = objects ?? [];
    cache?.set(cacheKey, value);
    return value;
  };

  const preserved = Array.isArray(preserveObjects)
    ? preserveObjects
    : collectUpperSurfaceObjectsForTargetLevel(targetLevel, { protectedLevelIds, context });
  const preservedSet = new Set(preserved.filter(Boolean));
  if (!preservedSet.size) return remember([]);

  const allUpperObjects = collectUpperSurfaceObjectsForTargetLevel(targetLevel, { protectedLevelIds: null, context });
  if (!allUpperObjects.length) return remember([]);

  const suppressed = allUpperObjects.filter((object) => object && !preservedSet.has(object));
  return remember(suppressed);
}

/**
 * Destroy a render texture after the current render cycle has completed.
 *
 * During viewport or resolution changes, layer sprites and filter uniforms can still reference the previous render texture for the active frame while a replacement texture is being allocated. Deferring destruction avoids null texture metadata during PIXI sprite rendering.
 *
 * @param {PIXI.RenderTexture|null} texture
 * @returns {void}
 * @private
 */
function destroyRenderTextureDeferred(texture) {
  if (!texture || texture.destroyed) return;

  const destroy = () => {
    try {
      if (!texture.destroyed) texture.destroy(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  };

  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => requestAnimationFrame(destroy));
    return;
  }

  setTimeout(destroy, 0);
}

/**
 * Determine whether a region should contribute to a suppression mask for a given kind, respecting elevation and viewer gating.
 *
 * @param {PlaceableObject} placeable - The Region placeable to inspect.
 * @param {"filters"|"particles"} kind - Which pipeline is querying ("filters" or "particles").
 * @returns {boolean} True if this region should be considered for suppression for the given kind.
 * @private
 */
function regionPassesSuppressionGate(placeable, kind) {
  const doc = placeable?.document;
  if (!doc) return false;
  if (!regionDocumentCanApplyInCurrentView(doc, doc?.parent ?? canvas?.scene ?? null)) return false;

  const behaviors = doc.behaviors ?? [];

  const hasWeather = behaviors.some((b) => !b.disabled && b.type === SUPPRESS_WEATHER);
  const hasParticles = behaviors.some((b) => !b.disabled && b.type === SUPPRESS_SCENE_PARTICLES);
  const hasFilters = behaviors.some((b) => !b.disabled && b.type === SUPPRESS_SCENE_FILTERS);

  if (!hasWeather && !hasParticles && !hasFilters) return false;

  let pass = false;

  if (kind === "particles") {
    if (hasParticles && computeRegionGatePass(placeable, { behaviorType: SUPPRESS_SCENE_PARTICLES })) pass = true;
    if (hasWeather && computeRegionGatePass(placeable, { behaviorType: SUPPRESS_WEATHER })) pass = true;
  }

  if (kind === "filters") {
    if (hasFilters && computeRegionGatePass(placeable, { behaviorType: SUPPRESS_SCENE_FILTERS })) pass = true;
    if (hasWeather && computeRegionGatePass(placeable, { behaviorType: SUPPRESS_WEATHER })) pass = true;
  }

  return pass;
}

/**
 * Return Region-assigned Level ids that are visible above the current view while the Region is not assigned to the current Level.
 *
 * @param {foundry.abstract.Document|null|undefined} document
 * @returns {Set<string>}
 * @private
 */
function getAssignedNonCurrentVisibleLevelIds(document) {
  const ids = new Set();
  if (!applyRegionBehaviorsToOverheadLevels()) return ids;
  if (!canvas?.level || !document) return ids;

  const currentLevel = getCanvasLevel();
  if (!currentLevel?.id) return ids;

  const assigned = getDocumentAssignedLevelIds(document, document?.parent ?? canvas?.scene ?? null);
  if (!(assigned?.size > 0)) return ids;
  if (assigned.has(currentLevel.id)) return ids;

  const scene = document?.parent ?? canvas?.scene ?? null;
  for (const levelId of assigned) {
    const level = getSceneLevelById(levelId, scene);
    if (!level) continue;
    if (!levelIsAboveTargetLevel(level, currentLevel)) continue;
    ids.add(levelId);
  }

  return ids;
}

/**
 * Create an empty suppression input bucket for one scene-effect pipeline.
 *
 * @returns {{ weatherRegions: Array<object>, suppressionRegions: Array<object>, soft: boolean }}
 * @private
 */
function createSuppressionInputBucket() {
  return { weatherRegions: [], suppressionRegions: [], soft: false };
}

/**
 * Build a shared suppression descriptor.
 *
 * @param {PlaceableObject} region
 * @param {{ edgeFadePercent?: number|null, suppressOnlyObjects?: boolean, preserveObjects?: PIXI.DisplayObject[], preserveShapes?: object[], suppressObjects?: PIXI.DisplayObject[] }} [options]
 * @returns {object}
 * @private
 */
function buildSuppressionDescriptor(
  region,
  {
    edgeFadePercent = null,
    suppressOnlyObjects = false,
    preserveObjects = [],
    preserveShapes = [],
    suppressObjects = [],
  } = {},
) {
  const descriptor = edgeFadePercent == null ? { region } : { region, edgeFadePercent };
  if (suppressOnlyObjects) descriptor.suppressOnlyObjects = true;
  if (preserveObjects?.length) descriptor.preserveObjects = preserveObjects;
  if (preserveShapes?.length) descriptor.preserveShapes = preserveShapes;
  if (suppressObjects?.length) descriptor.suppressObjects = suppressObjects;
  return descriptor;
}

/**
 * Return the maximum configured edge fade across enabled suppression behaviors.
 *
 * @param {object[]} behaviors
 * @returns {number}
 * @private
 */
function getMaxSuppressionEdgeFadePercent(behaviors) {
  let edgeFadePercent = 0;
  for (const behavior of behaviors ?? []) {
    const pct = fxmGetRegionBehaviorEdgeFadePercent(behavior);
    edgeFadePercent = Math.max(edgeFadePercent, pct);
  }
  return edgeFadePercent;
}

/**
 * Build the Level-preservation options shared by suppression descriptors for one Region.
 *
 * @param {PlaceableObject} region
 * @param {object|null} [context]
 * @returns {{ suppressOnlyObjects: boolean, preserveObjects: PIXI.DisplayObject[], preserveShapes: object[], suppressObjects: PIXI.DisplayObject[] }}
 * @private
 */
function buildSuppressionDescriptorSharedOptions(region, context = null) {
  const doc = region?.document;
  if (!doc) return { suppressOnlyObjects: false, preserveObjects: [], preserveShapes: [], suppressObjects: [] };

  const regionLevelIds = getDocumentAssignedLevelIds(doc, doc?.parent ?? canvas?.scene ?? null);
  const targetLevel = resolveSuppressionRegionTargetLevel(doc);
  const defaultProtectedLevelIds = getSuppressionAllowedLevelIds(doc, targetLevel);
  const nonCurrentObjectOnlyLevelIds = getAssignedNonCurrentVisibleLevelIds(doc);
  const currentSurfaceScopedLevelIds = nonCurrentObjectOnlyLevelIds.size
    ? new Set()
    : getCurrentLevelSurfaceScopedSuppressionLevelIds(
        doc,
        targetLevel,
        regionLevelIds,
        defaultProtectedLevelIds,
        context,
      );
  const objectOnlyLevelIds = nonCurrentObjectOnlyLevelIds.size
    ? nonCurrentObjectOnlyLevelIds
    : currentSurfaceScopedLevelIds;
  let objectOnlySuppressObjects = objectOnlyLevelIds.size
    ? collectVisibleSurfaceObjectsForLevelIds(objectOnlyLevelIds, { context, includeTiles: true })
    : [];
  let suppressOnlyObjects = objectOnlyLevelIds.size > 0;

  if (suppressOnlyObjects && !objectOnlySuppressObjects.length) {
    if (currentSurfaceScopedLevelIds.size) {
      suppressOnlyObjects = false;
      objectOnlySuppressObjects = [];
    } else {
      return null;
    }
  }

  const protectedLevelIds = suppressOnlyObjects ? objectOnlyLevelIds : defaultProtectedLevelIds;
  const upperPreserveObjects = targetLevel
    ? collectUpperSurfaceObjectsForTargetLevel(targetLevel, {
        protectedLevelIds,
        context,
        includeRevealed: true,
      })
    : [];
  const otherLevelTokenPreservation =
    !suppressOnlyObjects && targetLevel && regionLevelIds?.size
      ? collectVisibleOtherLevelTokenPreservationForTargetLevel(targetLevel, {
          assignedLevelIds: regionLevelIds,
          protectedLevelIds,
          context,
        })
      : { objects: [], shapes: [] };
  const preserveObjects = mergeDisplayObjectLists(upperPreserveObjects, otherLevelTokenPreservation.objects);
  const preserveShapes = otherLevelTokenPreservation.shapes ?? [];
  const suppressObjects = suppressOnlyObjects
    ? objectOnlySuppressObjects
    : targetLevel
    ? collectSuppressedUpperSurfaceObjectsForTargetLevel(targetLevel, {
        protectedLevelIds,
        preserveObjects,
        context,
      })
    : [];

  return { suppressOnlyObjects, preserveObjects, preserveShapes, suppressObjects };
}

/**
 * Collect hard-edged suppressWeather descriptors and configurable FXMaster suppression descriptors for the requested pipelines in one Region pass.
 *
 * The Level-preservation inputs are shared by particles and filters, which avoids resolving target Levels, object-only upper overlays, and preserve/ suppress surface lists twice during a single SceneMaskManager refresh.
 *
 * @param {PlaceableObject[]} regions
 * @param {Array<"filters"|"particles">} kinds
 * @param {object|null} [context]
 * @returns {{ particles: { weatherRegions: Array<object>, suppressionRegions: Array<object>, soft: boolean }, filters: { weatherRegions: Array<object>, suppressionRegions: Array<object>, soft: boolean } }}
 * @private
 */
function collectSuppressionInputsForKinds(regions, kinds = ["particles", "filters"], context = null) {
  const requested = new Set(kinds ?? []);
  const wantsParticles = requested.has("particles");
  const wantsFilters = requested.has("filters");
  const particles = createSuppressionInputBucket();
  const filters = createSuppressionInputBucket();

  if (!wantsParticles && !wantsFilters) return { particles, filters };

  for (const region of regions ?? []) {
    const doc = region?.document;
    if (!doc) continue;
    if (!regionDocumentCanApplyInCurrentView(doc, doc?.parent ?? canvas?.scene ?? null)) continue;

    const behaviorSummary = getSuppressionBehaviorSummary(doc, context);
    const weatherPasses =
      (wantsParticles || wantsFilters) &&
      behaviorSummary.hasWeather &&
      computeRegionGatePass(region, { behaviorType: SUPPRESS_WEATHER });

    const particlePasses =
      wantsParticles &&
      !!behaviorSummary.particleBehaviors.length &&
      computeRegionGatePass(region, { behaviorType: SUPPRESS_SCENE_PARTICLES });
    const filterPasses =
      wantsFilters &&
      !!behaviorSummary.filterBehaviors.length &&
      computeRegionGatePass(region, { behaviorType: SUPPRESS_SCENE_FILTERS });

    if (!weatherPasses && !particlePasses && !filterPasses) continue;

    const sharedOptions = buildSuppressionDescriptorSharedOptions(region, context);
    if (!sharedOptions) continue;
    const { suppressOnlyObjects, preserveObjects, preserveShapes, suppressObjects } = sharedOptions;

    if (weatherPasses) {
      const descriptor = buildSuppressionDescriptor(region, {
        suppressOnlyObjects,
        preserveObjects,
        preserveShapes,
        suppressObjects,
      });
      if (wantsParticles) particles.weatherRegions.push(descriptor);
      if (wantsFilters) filters.weatherRegions.push(descriptor);
    }

    if (particlePasses) {
      const edgeFadePercent = getMaxSuppressionEdgeFadePercent(behaviorSummary.particleBehaviors);
      if (edgeFadePercent > 0) particles.soft = true;
      particles.suppressionRegions.push(
        buildSuppressionDescriptor(region, {
          edgeFadePercent,
          suppressOnlyObjects,
          preserveObjects,
          preserveShapes,
          suppressObjects,
        }),
      );
    }

    if (filterPasses) {
      const edgeFadePercent = getMaxSuppressionEdgeFadePercent(behaviorSummary.filterBehaviors);
      if (edgeFadePercent > 0) filters.soft = true;
      filters.suppressionRegions.push(
        buildSuppressionDescriptor(region, {
          edgeFadePercent,
          suppressOnlyObjects,
          preserveObjects,
          preserveShapes,
          suppressObjects,
        }),
      );
    }
  }

  return { particles, filters };
}

/**
 * Collect suppression descriptors for explicit stack operator rows.
 *
 * @param {Array<{row?: object, region?: PlaceableObject}>} operators
 * @param {"filters"|"particles"} kind
 * @param {object|null} [context]
 * @returns {{ weatherRegions: Array<object>, suppressionRegions: Array<object>, soft: boolean }}
 * @private
 */
function collectSuppressionInputsForOperatorRows(operators, kind, context = null) {
  const normalizedKind = kind === "filters" ? "filters" : "particles";
  const bucket = createSuppressionInputBucket();

  for (const entry of operators ?? []) {
    const region = entry?.region ?? null;
    const row = entry?.row ?? null;
    const doc = region?.document ?? null;
    if (!region || !doc || !row) continue;

    const behaviorType = String(row?.behaviorType ?? "");
    const suppressionKind = String(row?.suppressionKind ?? "");
    const affectsKind = suppressionKind === "all" || suppressionKind === normalizedKind;
    if (!affectsKind) continue;

    const sharedOptions = buildSuppressionDescriptorSharedOptions(region, context);
    if (!sharedOptions) continue;

    if (behaviorType === SUPPRESS_WEATHER) {
      bucket.weatherRegions.push(buildSuppressionDescriptor(region, sharedOptions));
      continue;
    }

    if (
      (normalizedKind === "filters" && behaviorType !== SUPPRESS_SCENE_FILTERS) ||
      (normalizedKind === "particles" && behaviorType !== SUPPRESS_SCENE_PARTICLES)
    )
      continue;

    const behaviorId = String(row?.behaviorId ?? "");
    const behavior = [...(doc?.behaviors ?? [])].find((candidate) => String(candidate?.id ?? "") === behaviorId);
    const edgeFadePercent = fxmGetRegionBehaviorEdgeFadePercent(behavior);
    if (edgeFadePercent > 0) bucket.soft = true;
    bucket.suppressionRegions.push(buildSuppressionDescriptor(region, { ...sharedOptions, edgeFadePercent }));
  }

  return bucket;
}

/**
 * Ensure a RenderTexture matches the provided logical dimensions and resolution.
 *
 * @param {PIXI.RenderTexture|null} reuseRT
 * @param {{width:number,height:number,resolution:number}} spec
 * @returns {PIXI.RenderTexture}
 * @private
 */
function ensureRenderTexture(reuseRT, { width, height, resolution }) {
  const W = Math.max(1, Number(width) || 1);
  const H = Math.max(1, Number(height) || 1);
  const res = resolution || 1;

  const bad =
    !reuseRT ||
    reuseRT.destroyed ||
    Math.abs(Number(reuseRT.width ?? 0) - W) > 0.001 ||
    Math.abs(Number(reuseRT.height ?? 0) - H) > 0.001 ||
    Math.abs(Number(reuseRT.resolution || 1) - res) > 0.0001;

  if (!bad) return reuseRT;

  const oldRT = reuseRT ?? null;

  const rt = PIXI.RenderTexture.create({
    width: W,
    height: H,
    resolution: res,
    multisample: 0,
  });

  try {
    rt.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
    rt.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  destroyRenderTextureDeferred(oldRT);
  return rt;
}

/**
 * Rebuild (or reuse) a cutout render texture by subtracting one or more silhouette render textures from a base allow mask.
 *
 * @param {PIXI.RenderTexture} baseRT
 * @param {PIXI.RenderTexture|PIXI.RenderTexture[]|null} coverageRTs
 * @param {PIXI.RenderTexture|null} reuseCutoutRT
 * @returns {PIXI.RenderTexture|null}
 * @private
 */
function rebuildCutoutFromBase(baseRT, coverageRTs, reuseCutoutRT) {
  const r = canvas?.app?.renderer;
  const list = Array.isArray(coverageRTs) ? coverageRTs.filter(Boolean) : coverageRTs ? [coverageRTs] : [];
  if (!r || !baseRT || !list.length) return null;

  const W = Math.max(1, Number(baseRT.width) || 1);
  const H = Math.max(1, Number(baseRT.height) || 1);
  const res = baseRT.resolution || 1;

  const cutoutRT = ensureRenderTexture(reuseCutoutRT, { width: W, height: H, resolution: res });

  try {
    const spr = (_tmpBaseCopySprite ??= new PIXI.Sprite());
    spr.texture = baseRT;
    spr.blendMode = PIXI.BLEND_MODES.NORMAL;
    spr.alpha = 1;
    spr.position.set(0, 0);
    spr.scale.set(1, 1);
    spr.rotation = 0;
    r.render(spr, { renderTexture: cutoutRT, clear: true });
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  const eraseSprite = (_tmpTokensEraseSprite ??= new PIXI.Sprite());
  eraseSprite.blendMode = PIXI.BLEND_MODES.ERASE;
  eraseSprite.alpha = 1;
  eraseSprite.position.set(0, 0);
  eraseSprite.scale.set(1, 1);
  eraseSprite.rotation = 0;

  for (const coverageRT of list) {
    if (!coverageRT) continue;
    try {
      eraseSprite.texture = coverageRT;
      r.render(eraseSprite, { renderTexture: cutoutRT, clear: false });
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  return cutoutRT;
}

/**
 * Rebuild a tokens+tiles cutout, preferring an already-built single-coverage cutout as the base.
 *
 * When both below-tokens and below-tiles are enabled, the old path copied the base mask and then erased two coverage RTs. If a tokens-only or tiles-only cutout was already rebuilt for a sibling row, copying that intermediate cutout and erasing the remaining coverage saves one fullscreen ERASE pass.
 *
 * @param {PIXI.RenderTexture} baseRT
 * @param {PIXI.RenderTexture|null} tokensRT
 * @param {PIXI.RenderTexture|null} tilesRT
 * @param {PIXI.RenderTexture|null} reuseCutoutRT
 * @param {{ tokensCutoutRT?: PIXI.RenderTexture|null, tilesCutoutRT?: PIXI.RenderTexture|null }} [opts]
 * @returns {PIXI.RenderTexture|null}
 * @private
 */
function rebuildCombinedCutoutFromBase(
  baseRT,
  tokensRT,
  tilesRT,
  reuseCutoutRT,
  { tokensCutoutRT = null, tilesCutoutRT = null } = {},
) {
  if (!baseRT || !tokensRT || !tilesRT) return null;
  if (tokensCutoutRT) return rebuildCutoutFromBase(tokensCutoutRT, tilesRT, reuseCutoutRT);
  if (tilesCutoutRT) return rebuildCutoutFromBase(tilesCutoutRT, tokensRT, reuseCutoutRT);
  return rebuildCutoutFromBase(baseRT, [tokensRT, tilesRT], reuseCutoutRT);
}

/**
 * Manages shared scene-level allow / cutout / token masks for particles and filters.
 *
 * This is implemented as a lazy singleton; use {@link SceneMaskManager.instance} to obtain the shared instance.
 */
export class SceneMaskManager {
  constructor() {
    /** @type {PIXI.RenderTexture|null} */
    this._baseParticlesRT = null;
    /** @type {PIXI.RenderTexture|null} */
    this._baseFiltersRT = null;

    /** @type {PIXI.RenderTexture|null} */
    this._cutoutParticlesTokensRT = null;
    /** @type {PIXI.RenderTexture|null} */
    this._cutoutParticlesTilesRT = null;
    /** @type {PIXI.RenderTexture|null} */
    this._cutoutParticlesCombinedRT = null;
    /** @type {PIXI.RenderTexture|null} */
    this._cutoutFiltersTokensRT = null;
    /** @type {PIXI.RenderTexture|null} */
    this._cutoutFiltersTilesRT = null;
    /** @type {PIXI.RenderTexture|null} */
    this._cutoutFiltersCombinedRT = null;

    /** @type {PIXI.RenderTexture|null} */
    this._tokensRT = null;
    /** @type {PIXI.RenderTexture|null} */
    this._tilesRT = null;
    /** @type {PIXI.RenderTexture|null} */
    this._tilesFiltersRT = null;
    /** @type {PIXI.RenderTexture|null} */
    this._tilesVisibleRT = null;

    /**
     * Per-render-frame dedupe key for shared below-token/below-tile coverage textures. Scene particles, scene filters, region particles, region filters, and the stack compositor can all ask for the same coverage repaint during one camera frame; repainting once is enough.
     * @type {string|null}
     * @private
     */
    this._sharedCoverageRefreshFrameKey = null;

    /**
     * Dynamic signature for lower-/other-Level token reveal apertures restored into Level-scoped suppression masks.
     * @type {string|null}
     * @private
     */
    this._dynamicSuppressionPreservationSignature = null;

    /** @type {boolean} */
    this._baseParticlesSoft = false;
    /** @type {boolean} */
    this._baseFiltersSoft = false;

    /**
     * Whether each pipeline currently has any active consumers. Defaults to true to preserve existing behavior until callers declare otherwise.
     * @type {{particles:boolean, filters:boolean}}
     * @private
     */
    this._kindActive = { particles: true, filters: true };

    /**
     * Whether each pipeline currently needs "below tokens" artifacts (cutout + tokens mask). Defaults to true to preserve existing behavior until callers declare otherwise.
     * @type {{particles:boolean, filters:boolean}}
     * @private
     */
    this._belowTokensNeeded = { particles: true, filters: true };

    /**
     * Track below-tokens needs by source so scene-level managers do not accidentally override region-level requirements (and vice-versa).
     *
     * The default source is "scene" to match historical call sites.
     * @type {{particles: Map<string, boolean>, filters: Map<string, boolean>}}
     * @private
     */
    this._belowTokensSources = {
      particles: new Map([["scene", true]]),
      filters: new Map([["scene", true]]),
    };

    /**
     * Last token silhouette signature used for shared below-token coverage.
     * @type {string|null}
     * @private
     */
    this._belowTokenCoverageSignature = null;

    /**
     * Whether each pipeline currently needs "below tiles" artifacts (cutouts built from tile silhouettes).
     * @type {{particles:boolean, filters:boolean}}
     * @private
     */
    this._belowTilesNeeded = { particles: false, filters: false };

    /**
     * Track below-tiles needs by source so scene-level managers do not accidentally override region-level requirements.
     * @type {{particles: Map<string, boolean>, filters: Map<string, boolean>}}
     * @private
     */
    this._belowTilesSources = {
      particles: new Map([["scene", false]]),
      filters: new Map([["scene", false]]),
    };

    this._pendingKinds = new Set();
    this._deferredBelowObjectRefreshSerial = 0;
    this._deferredBelowObjectRefreshActive = false;

    /**
     * Short-lived region suppression presence cache.
     * @type {{particles:{key:string|null,value:boolean}, filters:{key:string|null,value:boolean}}}
     * @private
     */
    this._suppressionPresenceCache = {
      particles: { key: null, value: false },
      filters: { key: null, value: false },
    };

    /** @type {Map<string, object>} */
    this._stackMaskCache = new Map();

    /**
     * Coalesced refresh callback used to delay recomputation until next animation frame.
     * @type {Function}
     * @private
     */
    this._scheduleRefresh = coalesceNextFrame(
      () => {
        const kinds = this._pendingKinds.size ? [...this._pendingKinds] : ["particles", "filters"];
        this._pendingKinds.clear();
        this._refreshImpl(kinds);
      },
      { key: "fxm:sceneMaskManager" },
    );
  }

  /** @type {SceneMaskManager|undefined} */
  static #instance;

  /**
   * Singleton accessor.
   * @returns {SceneMaskManager}
   */
  static get instance() {
    if (!this.#instance) this.#instance = new this();
    return this.#instance;
  }

  /**
   * Force primary/perception state to flush before repainting live tile coverage textures.
   *
   * Shared tile masks sample the live primary tile meshes directly so non-zero native occlusion modes can contribute their current revealed shape. Repainting from stale primary state can leave shared masks one frame behind hover or occlusion updates.
   *
   * @returns {void}
   * @private
   */
  _syncDynamicCoverageSources() {
    try {
      canvas?.perception?.applyRenderFlags?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    try {
      canvas?.primary?.update?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    try {
      canvas?.primary?.refreshPrimarySpriteMesh?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  /**
   * Return active scene-effect pipelines that can need dynamic lower-Level token reveal preservation under explicitly Level-scoped suppression Regions.
   *
   * @returns {Array<"particles"|"filters">}
   * @private
   */
  _dynamicSuppressionPreservationKinds() {
    if (!canvas?.level) return [];

    if (!getDirectLowerLevelRevealCandidateTokensForSuppression().length) return [];

    const regions = getRegionEffectPlaceablesForCurrentView(canvas?.scene ?? null);
    let wantsParticles = false;
    let wantsFilters = false;

    for (const region of regions ?? []) {
      const doc = region?.document ?? null;
      if (!doc) continue;
      if (!regionDocumentCanApplyInCurrentView(doc, doc?.parent ?? canvas?.scene ?? null)) continue;

      const regionLevelIds = getDocumentAssignedLevelIds(doc, doc?.parent ?? canvas?.scene ?? null);
      if (!(regionLevelIds?.size > 0)) continue;

      const summary = getSuppressionBehaviorSummary(doc, null);
      if (summary.hasWeather) {
        wantsParticles = true;
        wantsFilters = true;
      }
      if (summary.particleBehaviors.length) wantsParticles = true;
      if (summary.filterBehaviors.length) wantsFilters = true;
    }

    const kinds = [];
    if (wantsParticles && this._kindActive.particles) kinds.push("particles");
    if (wantsFilters && this._kindActive.filters) kinds.push("filters");
    return kinds;
  }

  /**
   * Return whether compositor dynamic-state tracking should include token hover state even if no below-token/tile cutout is otherwise active.
   *
   * @returns {boolean}
   */
  needsDynamicLevelSuppressionPreservation() {
    return this._dynamicSuppressionPreservationKinds().length > 0;
  }

  /**
   * Public wrapper used by the compositor's per-frame dynamic-state sync.
   *
   * Hover-revealed lower-Level token apertures can change independently of below-token/below-tile coverage. Let the compositor ask the scene mask manager to rebuild the base suppression masks when those apertures change, while keeping the expensive rebuild gated by a compact signature.
   *
   * @returns {boolean} True when a full base suppression refresh was performed.
   */
  refreshDynamicSuppressionPreservationIfNeeded() {
    return this._refreshDynamicSuppressionPreservationIfNeeded();
  }

  /**
   * Rebuild base suppression masks when off-target token reveal apertures change.
   *
   * @returns {boolean} True when a full base suppression refresh was performed.
   * @private
   */
  _refreshDynamicSuppressionPreservationIfNeeded() {
    const kinds = this._dynamicSuppressionPreservationKinds();
    if (!kinds.length) {
      this._dynamicSuppressionPreservationSignature = null;
      return false;
    }

    const regions = getRegionEffectPlaceablesForCurrentView(canvas?.scene ?? null);
    const signature = buildDynamicSuppressionPreservationSignature(regions, kinds);
    if (signature === this._dynamicSuppressionPreservationSignature) return false;

    this._dynamicSuppressionPreservationSignature = signature;
    this._refreshImpl(kinds);
    return true;
  }

  /**
   * Return whether a shared coverage RenderTexture is still usable for the supplied viewport spec.
   *
   * @param {PIXI.RenderTexture|null} rt
   * @param {{ width:number, height:number, resolution:number }} spec
   * @returns {boolean}
   * @private
   */
  _coverageTextureValid(rt, { width, height, resolution }) {
    return (
      !!rt &&
      !rt.destroyed &&
      !rt.baseTexture?.destroyed &&
      Math.abs(Number(rt.width ?? 0) - Math.max(1, Number(width) || 1)) <= 0.001 &&
      Math.abs(Number(rt.height ?? 0) - Math.max(1, Number(height) || 1)) <= 0.001 &&
      Math.abs(Number(rt.resolution || 1) - Number(resolution || 1)) <= 0.0001
    );
  }

  /**
   * Build a same-frame key for shared token/tile coverage repaints.
   *
   * @param {{ width:number, height:number, resolution:number, needTokens:boolean, needTiles:boolean, needParticleTiles?:boolean, needFilterTiles?:boolean }} spec
   * @returns {string}
   * @private
   */
  _sharedCoverageFrameKey({
    width,
    height,
    resolution,
    needTokens,
    needTiles,
    needParticleTiles = needTiles,
    needFilterTiles = needTiles,
  }) {
    const r = canvas?.app?.renderer ?? null;
    const ticker = canvas?.app?.ticker ?? null;
    const frameTime = Number(ticker?.lastTime ?? 0) || 0;
    const viewW = r?.view?.width ?? r?.screen?.width ?? width ?? 0;
    const viewH = r?.view?.height ?? r?.screen?.height ?? height ?? 0;
    const M = needTiles || needParticleTiles || needFilterTiles ? rawStageMatrix() : snappedStageMatrix();
    const cameraKey = M ? [M.a, M.b, M.c, M.d, M.tx, M.ty].map((value) => Number(value || 0).toFixed(3)).join(",") : "";
    return [
      canvas?.scene?.id ?? "scene",
      frameTime.toFixed(3),
      Number(viewW || 0).toFixed(3),
      Number(viewH || 0).toFixed(3),
      Number(width || 0).toFixed(3),
      Number(height || 0).toFixed(3),
      Number(resolution || 1).toFixed(4),
      cameraKey,
      needTokens ? 1 : 0,
      needTiles ? 1 : 0,
      needParticleTiles ? 1 : 0,
      needFilterTiles ? 1 : 0,
    ].join("|");
  }

  /**
   * Repaint below-token coverage when visible token silhouettes move without a camera change.
   *
   * @returns {boolean} True when coverage was repainted.
   */
  refreshBelowTokenCoverageForMotion() {
    const needTokens = this._belowTokensNeeded.particles || this._belowTokensNeeded.filters;
    if (!needTokens) {
      this._belowTokenCoverageSignature = null;
      return false;
    }

    const signature = buildBelowTokenMaskCoverageSignature();
    if (signature === this._belowTokenCoverageSignature) return false;

    this._belowTokenCoverageSignature = signature;
    this.refreshTokensSync({ force: true });
    return true;
  }

  /**
   * Destroy a shared coverage texture and clear the same-frame dedupe key.
   *
   * @param {string} key
   * @returns {void}
   * @private
   */
  _destroySharedCoverageTexture(key) {
    if (!this[key]) return;
    try {
      this[key].destroy(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    this[key] = null;
    if (key === "_tokensRT") this._belowTokenCoverageSignature = null;
    this._sharedCoverageRefreshFrameKey = null;
  }

  /**
   * Ensure the shared below-token and below-tile coverage textures are current.
   *
   * Multiple systems can request these masks during the same camera frame. When the texture dimensions and requested coverage set match, only the first call repaints token/tile silhouettes; later calls reuse the fresh textures and still rebuild their own derived cutouts as needed.
   *
   * @param {{ needTokens?: boolean, needTiles?: boolean, force?: boolean, presyncedDynamicCoverage?: boolean }} [options]
   * @returns {{ cssW:number, cssH:number, resolution:number, refreshed:boolean }}
   * @private
   */
  _ensureSharedCoverageTextures({
    needTokens = false,
    needTiles = false,
    force = false,
    presyncedDynamicCoverage = false,
  } = {}) {
    const needsTokens = !!needTokens;
    const needsTiles = !!needTiles;
    const wantsParticleTiles = needsTiles && !!this._belowTilesNeeded.particles;
    const wantsFilterTiles = needsTiles && !!this._belowTilesNeeded.filters;
    const needsParticleTiles = wantsParticleTiles && hasActiveTileRestrictionsForMask("particles");
    const needsFilterTiles = wantsFilterTiles && hasActiveTileRestrictionsForMask("filters");

    if (!needsTokens && !needsTiles) {
      this._destroySharedCoverageTexture("_tokensRT");
      this._destroySharedCoverageTexture("_tilesRT");
      this._destroySharedCoverageTexture("_tilesFiltersRT");
      this._destroySharedCoverageTexture("_tilesVisibleRT");
      this._sharedCoverageRefreshFrameKey = null;
      return { cssW: 0, cssH: 0, resolution: 1, refreshed: false };
    }

    const { cssW, cssH } = getCssViewportMetrics();
    const res = safeMaskResolutionForCssArea(cssW, cssH, 1);
    const spec = { width: cssW, height: cssH, resolution: res };

    const tokensValid = !needsTokens || this._coverageTextureValid(this._tokensRT, spec);
    const particleTilesValid = !needsParticleTiles || this._coverageTextureValid(this._tilesRT, spec);
    const filterTilesValid = !needsFilterTiles || this._coverageTextureValid(this._tilesFiltersRT, spec);
    const visibleTilesValid = !needsTiles || this._coverageTextureValid(this._tilesVisibleRT, spec);
    const tilesValid = !needsTiles || (particleTilesValid && filterTilesValid && visibleTilesValid);

    const dedupeEnabled = CONFIG?.fxmaster?.overheadPerformance?.sharedCoverageSameFrameDeduplication !== false;
    const frameKey = this._sharedCoverageFrameKey({
      width: cssW,
      height: cssH,
      resolution: res,
      needTokens: needsTokens,
      needTiles: needsTiles,
      needParticleTiles: needsParticleTiles,
      needFilterTiles: needsFilterTiles,
    });

    if (dedupeEnabled && !force && tokensValid && tilesValid && this._sharedCoverageRefreshFrameKey === frameKey) {
      if (!needsTokens) this._destroySharedCoverageTexture("_tokensRT");
      if (!needsParticleTiles) this._destroySharedCoverageTexture("_tilesRT");
      if (!needsFilterTiles) this._destroySharedCoverageTexture("_tilesFiltersRT");
      if (!needsTiles) this._destroySharedCoverageTexture("_tilesVisibleRT");
      this._sharedCoverageRefreshFrameKey = frameKey;
      return { cssW, cssH, resolution: res, refreshed: false };
    }

    if (needsTiles && !presyncedDynamicCoverage) this._syncDynamicCoverageSources();

    if (needsTokens) {
      this._tokensRT = ensureRenderTexture(this._tokensRT, { width: cssW, height: cssH, resolution: res });
      repaintTokensMaskInto(this._tokensRT);
      this._belowTokenCoverageSignature = buildBelowTokenMaskCoverageSignature();
    } else {
      this._destroySharedCoverageTexture("_tokensRT");
    }

    if (needsTiles) {
      this._tilesVisibleRT = ensureRenderTexture(this._tilesVisibleRT, { width: cssW, height: cssH, resolution: res });
      repaintTilesMaskInto(this._tilesVisibleRT, { mode: "visible" });
    } else {
      this._destroySharedCoverageTexture("_tilesVisibleRT");
    }

    if (needsParticleTiles) {
      this._tilesRT = ensureRenderTexture(this._tilesRT, { width: cssW, height: cssH, resolution: res });
      repaintTilesMaskInto(this._tilesRT, { mode: "suppression", restrictionKind: "particles" });
    } else {
      /**
       * When no active tile restricts particles, the suppression tile mask is identical to the visible tile mask. Leave the dedicated texture null so getMasks("particles") can fall back to the shared visible mask.
       */
      this._destroySharedCoverageTexture("_tilesRT");
    }

    if (needsFilterTiles) {
      this._tilesFiltersRT = ensureRenderTexture(this._tilesFiltersRT, { width: cssW, height: cssH, resolution: res });
      repaintTilesMaskInto(this._tilesFiltersRT, { mode: "suppression", restrictionKind: "filters" });
    } else {
      this._destroySharedCoverageTexture("_tilesFiltersRT");
    }

    this._sharedCoverageRefreshFrameKey = frameKey;
    return { cssW, cssH, resolution: res, refreshed: true };
  }

  /**
   * Reset the singleton, destroying all held render textures. Should be called during canvasInit to prevent stale RT references from surviving across canvas teardowns.
   */
  static reset() {
    if (this.#instance) {
      this.#instance.clear();
      this.#instance = undefined;
    }
  }

  /**
   * Backwards-compatible getter that returns the particle masks by default.
   * @returns {{base: PIXI.RenderTexture|null, cutout: PIXI.RenderTexture|null, cutoutTokens: PIXI.RenderTexture|null, cutoutTiles: PIXI.RenderTexture|null, cutoutCombined: PIXI.RenderTexture|null, tokens: PIXI.RenderTexture|null, tiles: PIXI.RenderTexture|null, visibleTiles: PIXI.RenderTexture|null, soft: boolean}}
   */
  get masks() {
    return this.getMasks("particles");
  }

  /**
   * Retrieve the precomputed mask bundle for a given system kind.
   *
   * `cutout` is kept as a backwards-compatible alias for the tokens-only cutout.
   *
   * @param {"particles"|"filters"} [kind="particles"]
   * @returns {{base: PIXI.RenderTexture|null, cutout: PIXI.RenderTexture|null, cutoutTokens: PIXI.RenderTexture|null, cutoutTiles: PIXI.RenderTexture|null, cutoutCombined: PIXI.RenderTexture|null, tokens: PIXI.RenderTexture|null, tiles: PIXI.RenderTexture|null, visibleTiles: PIXI.RenderTexture|null, soft: boolean}}
   */
  getMasks(kind = "particles") {
    if (kind === "filters") {
      return {
        base: this._baseFiltersRT,
        cutout: this._cutoutFiltersTokensRT,
        cutoutTokens: this._cutoutFiltersTokensRT,
        cutoutTiles: this._cutoutFiltersTilesRT,
        cutoutCombined: this._cutoutFiltersCombinedRT,
        tokens: this._tokensRT,
        tiles: this._tilesFiltersRT ?? this._tilesVisibleRT,
        visibleTiles: this._tilesVisibleRT,
        soft: !!this._baseFiltersSoft,
      };
    }
    return {
      base: this._baseParticlesRT,
      cutout: this._cutoutParticlesTokensRT,
      cutoutTokens: this._cutoutParticlesTokensRT,
      cutoutTiles: this._cutoutParticlesTilesRT,
      cutoutCombined: this._cutoutParticlesCombinedRT,
      tokens: this._tokensRT,
      tiles: this._tilesRT ?? this._tilesVisibleRT,
      visibleTiles: this._tilesVisibleRT,
      soft: !!this._baseParticlesSoft,
    };
  }

  /**
   * Declare whether a pipeline currently has active consumers. When inactive, its base and derived RTs are released to reduce VRAM pressure.
   * @param {"particles"|"filters"} kind
   * @param {boolean} active
   */
  setKindActive(kind, active) {
    if (kind !== "particles" && kind !== "filters") return;

    const next = !!active;
    const prev = !!this._kindActive[kind];
    if (prev === next) return;

    this._kindActive[kind] = next;

    if (!next) {
      if (kind === "particles") {
        try {
          this._baseParticlesRT?.destroy(true);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        this._baseParticlesRT = null;
        this._baseParticlesSoft = false;

        for (const key of ["_cutoutParticlesTokensRT", "_cutoutParticlesTilesRT", "_cutoutParticlesCombinedRT"]) {
          try {
            this[key]?.destroy(true);
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
          this[key] = null;
        }
      } else {
        try {
          this._baseFiltersRT?.destroy(true);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        this._baseFiltersRT = null;
        this._baseFiltersSoft = false;

        for (const key of ["_cutoutFiltersTokensRT", "_cutoutFiltersTilesRT", "_cutoutFiltersCombinedRT"]) {
          try {
            this[key]?.destroy(true);
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
          this[key] = null;
        }
      }

      /**
       * Shared coverage RenderTextures may still be required by region-level consumers even when the scene-level pipeline is inactive.
       */
      const needTokens = this._belowTokensNeeded.particles || this._belowTokensNeeded.filters;
      const needTiles = this._belowTilesNeeded.particles || this._belowTilesNeeded.filters;

      if (!needTokens && this._tokensRT) {
        try {
          this._tokensRT.destroy(true);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        this._tokensRT = null;
      }

      if (!needTiles) {
        for (const key of ["_tilesRT", "_tilesFiltersRT", "_tilesVisibleRT"]) {
          if (!this[key]) continue;
          try {
            this[key].destroy(true);
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
          this[key] = null;
        }
      }

      return;
    }

    this.refresh(kind);
  }

  _scheduleDeferredBelowObjectCoverageRefresh() {
    if (this._deferredBelowObjectRefreshActive) return;
    this._deferredBelowObjectRefreshSerial = (this._deferredBelowObjectRefreshSerial | 0) + 1;
    const serial = this._deferredBelowObjectRefreshSerial;

    this._deferredBelowObjectRefreshActive = true;
    const run = async () => {
      try {
        for (let i = 0; i < 4; i += 1) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          if (serial !== this._deferredBelowObjectRefreshSerial) return;
          try {
            syncCanvasLiveLevelSurfaceState();
            invalidateUpperLevelCoverageCache();
            this.refreshTokensSync({ presyncedDynamicCoverage: true });
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
        }
      } finally {
        this._deferredBelowObjectRefreshActive = false;
      }
    };

    void run();
  }

  /**
   * Declare whether a pipeline needs "below tokens" artifacts (cutouts + tokens-only silhouettes).
   *
   * This overload accepts an optional `source` to allow multiple subsystems (scene vs regions) to contribute requirements without clobbering each other.
   *
   * @param {"particles"|"filters"} kind
   * @param {boolean} needed
   * @param {string} [source="scene"]
   */
  setBelowTokensNeeded(kind, needed, source = "scene") {
    if (kind !== "particles" && kind !== "filters") return;

    const src = source ?? "scene";
    const map = this._belowTokensSources?.[kind] ?? (this._belowTokensSources[kind] = new Map());
    map.set(String(src), !!needed);

    const next = [...map.values()].some(Boolean);
    const prev = !!this._belowTokensNeeded[kind];
    if (prev === next) return;

    this._belowTokensNeeded[kind] = next;

    if (!next) {
      for (const key of kind === "particles"
        ? ["_cutoutParticlesTokensRT", "_cutoutParticlesCombinedRT"]
        : ["_cutoutFiltersTokensRT", "_cutoutFiltersCombinedRT"]) {
        try {
          this[key]?.destroy(true);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        this[key] = null;
      }

      const needTokens = this._belowTokensNeeded.particles || this._belowTokensNeeded.filters;
      if (!needTokens && this._tokensRT) {
        try {
          this._tokensRT.destroy(true);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        this._tokensRT = null;
      }

      return;
    }

    try {
      this.refreshTokensSync?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    this._scheduleDeferredBelowObjectCoverageRefresh();

    if (this._kindActive[kind]) this.refresh(kind);
  }

  /**
   * Declare whether a pipeline needs "below tiles" artifacts (cutouts built from tile silhouettes).
   *
   * This overload accepts an optional `source` to allow multiple subsystems (scene vs regions) to contribute requirements without clobbering each other.
   *
   * @param {"particles"|"filters"} kind
   * @param {boolean} needed
   * @param {string} [source="scene"]
   */
  setBelowTilesNeeded(kind, needed, source = "scene") {
    if (kind !== "particles" && kind !== "filters") return;

    const src = source ?? "scene";
    const map = this._belowTilesSources?.[kind] ?? (this._belowTilesSources[kind] = new Map());
    map.set(String(src), !!needed);

    const next = [...map.values()].some(Boolean);
    const prev = !!this._belowTilesNeeded[kind];
    if (prev === next) return;

    this._belowTilesNeeded[kind] = next;

    if (!next) {
      for (const key of kind === "particles"
        ? ["_cutoutParticlesTilesRT", "_cutoutParticlesCombinedRT"]
        : ["_cutoutFiltersTilesRT", "_cutoutFiltersCombinedRT"]) {
        try {
          this[key]?.destroy(true);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        this[key] = null;
      }

      if (kind === "particles") this._destroySharedCoverageTexture("_tilesRT");
      else this._destroySharedCoverageTexture("_tilesFiltersRT");

      const needTiles = this._belowTilesNeeded.particles || this._belowTilesNeeded.filters;
      if (!needTiles) this._destroySharedCoverageTexture("_tilesVisibleRT");

      return;
    }

    try {
      this.refreshTokensSync?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    this._scheduleDeferredBelowObjectCoverageRefresh();

    if (this._kindActive[kind]) this.refresh(kind);
  }

  /**
   * Retrieve a stack-row-specific mask bundle using only the supplied suppression operators.
   *
   * @param {"particles"|"filters"} kind
   * @param {Array<{row?: object, region?: PlaceableObject}>} operators
   * @param {{ belowTokens?: boolean, belowTiles?: boolean }} [options]
   * @returns {{base: PIXI.RenderTexture|null, cutout: PIXI.RenderTexture|null, cutoutTokens: PIXI.RenderTexture|null, cutoutTiles: PIXI.RenderTexture|null, cutoutCombined: PIXI.RenderTexture|null, tokens: PIXI.RenderTexture|null, tiles: PIXI.RenderTexture|null, visibleTiles: PIXI.RenderTexture|null, soft: boolean}}
   */
  getMasksForSuppressionOperators(
    kind = "particles",
    operators = [],
    { belowTokens = false, belowTiles = false } = {},
  ) {
    const normalizedKind = kind === "filters" ? "filters" : "particles";
    const useTokens = !!belowTokens;
    const useTiles = !!belowTiles;
    const operatorKey = (operators ?? [])
      .map((entry) => entry?.row?.uid ?? entry?.region?.document?.uuid ?? entry?.region?.document?.id ?? "")
      .filter(Boolean)
      .join(",");
    const { cssW, cssH } = getCssViewportMetrics();
    const res = safeMaskResolutionForCssArea(cssW, cssH, 1);
    const key = [
      canvas?.scene?.id ?? "scene",
      normalizedKind,
      operatorKey || "none",
      useTokens ? 1 : 0,
      useTiles ? 1 : 0,
      Number(cssW || 0).toFixed(3),
      Number(cssH || 0).toFixed(3),
      Number(res || 1).toFixed(4),
      canvas?.stage?.worldTransform?.tx ?? 0,
      canvas?.stage?.worldTransform?.ty ?? 0,
      canvas?.stage?.worldTransform?.a ?? 1,
      canvas?.stage?.worldTransform?.d ?? 1,
    ].join("|");

    let entry = this._stackMaskCache.get(key) ?? null;
    if (!entry) {
      entry = { base: null, cutoutTokens: null, cutoutTiles: null, cutoutCombined: null, soft: false, lastUsed: 0 };
      this._stackMaskCache.set(key, entry);
    }

    const context = createSuppressionRefreshContext();
    const { weatherRegions, suppressionRegions, soft } = collectSuppressionInputsForOperatorRows(
      operators,
      normalizedKind,
      context,
    );
    entry.base = buildSceneAllowMaskRT({
      weatherRegions,
      suppressionRegions,
      reuseRT: entry.base,
    });
    entry.soft = !!soft;

    const coverageNeedsTokens = useTokens || this._belowTokensNeeded.particles || this._belowTokensNeeded.filters;
    const coverageNeedsTiles = useTiles || this._belowTilesNeeded.particles || this._belowTilesNeeded.filters;
    if (coverageNeedsTokens || coverageNeedsTiles) {
      this._ensureSharedCoverageTextures({ needTokens: coverageNeedsTokens, needTiles: coverageNeedsTiles });
    }
    const tilesRT =
      normalizedKind === "filters"
        ? this._tilesFiltersRT ?? this._tilesVisibleRT
        : this._tilesRT ?? this._tilesVisibleRT;

    if (entry.base && useTokens && this._tokensRT) {
      entry.cutoutTokens = rebuildCutoutFromBase(entry.base, this._tokensRT, entry.cutoutTokens);
    } else if (entry.cutoutTokens) {
      try {
        entry.cutoutTokens.destroy(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      entry.cutoutTokens = null;
    }

    if (entry.base && useTiles && tilesRT) {
      entry.cutoutTiles = rebuildCutoutFromBase(entry.base, tilesRT, entry.cutoutTiles);
    } else if (entry.cutoutTiles) {
      try {
        entry.cutoutTiles.destroy(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      entry.cutoutTiles = null;
    }

    if (entry.base && useTokens && useTiles && this._tokensRT && tilesRT) {
      entry.cutoutCombined = rebuildCombinedCutoutFromBase(entry.base, this._tokensRT, tilesRT, entry.cutoutCombined, {
        tokensCutoutRT: entry.cutoutTokens,
        tilesCutoutRT: entry.cutoutTiles,
      });
    } else if (entry.cutoutCombined) {
      try {
        entry.cutoutCombined.destroy(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      entry.cutoutCombined = null;
    }

    entry.lastUsed = globalThis.performance?.now?.() ?? Date.now();
    this._trimStackMaskCache();

    return {
      base: entry.base,
      cutout: entry.cutoutTokens,
      cutoutTokens: entry.cutoutTokens,
      cutoutTiles: entry.cutoutTiles,
      cutoutCombined: entry.cutoutCombined,
      tokens: useTokens ? this._tokensRT : null,
      tiles: useTiles ? tilesRT : null,
      visibleTiles: useTiles ? this._tilesVisibleRT : null,
      soft: entry.soft,
    };
  }

  /**
   * Trim cached stack-row mask bundles.
   *
   * @returns {void}
   * @private
   */
  _trimStackMaskCache() {
    const maxEntries = 16;
    if (!(this._stackMaskCache instanceof Map) || this._stackMaskCache.size <= maxEntries) return;

    const victims = [...this._stackMaskCache.entries()]
      .sort((a, b) => (a[1]?.lastUsed ?? 0) - (b[1]?.lastUsed ?? 0))
      .slice(0, Math.max(0, this._stackMaskCache.size - maxEntries));

    for (const [key, entry] of victims) {
      for (const rt of [entry?.base, entry?.cutoutTokens, entry?.cutoutTiles, entry?.cutoutCombined]) {
        try {
          rt?.destroy?.(true);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }
      this._stackMaskCache.delete(key);
    }
  }

  /**
   * Schedule a mask refresh on the next animation frame.
   * @param {"particles"|"filters"|"all"} [kind="all"]
   */
  refresh(kind = "all") {
    if (kind === "all") {
      this._pendingKinds.add("particles");
      this._pendingKinds.add("filters");
    } else if (kind === "particles" || kind === "filters") {
      this._pendingKinds.add(kind);
    } else {
      return;
    }
    this._scheduleRefresh();
  }

  /**
   * Force an immediate, synchronous refresh of masks.
   * @param {"particles"|"filters"|"all"} [kind="all"]
   */
  refreshSync(kind = "all") {
    try {
      this._scheduleRefresh?.cancel?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    const kinds = kind === "all" ? ["particles", "filters"] : [kind];
    this._refreshImpl(kinds);
  }

  /**
   * Force an immediate, synchronous repaint of the shared coverage RTs (tokens and tiles) and any derived cutouts, without rebuilding base allow masks.
   *
   * This is intended for sub-pixel camera translation updates and token/tile motion, where rebuilding suppression geometry would be wasted work but stale coverage silhouettes would cause visible sliding or jitter in below-object masks.
   *
   * @param {{ presyncedDynamicCoverage?: boolean, force?: boolean }} [options]
   */
  refreshTokensSync({ presyncedDynamicCoverage = false, force = false } = {}) {
    if (!canvas?.ready) return;

    const needTokens = this._belowTokensNeeded.particles || this._belowTokensNeeded.filters;
    const needTiles = this._belowTilesNeeded.particles || this._belowTilesNeeded.filters;

    if (this._refreshDynamicSuppressionPreservationIfNeeded()) return;

    if (!needTokens && !needTiles) {
      this._ensureSharedCoverageTextures({ needTokens, needTiles, force });
      return;
    }

    this._ensureSharedCoverageTextures({ needTokens, needTiles, force, presyncedDynamicCoverage });

    const particleTilesRT = this._tilesRT ?? this._tilesVisibleRT;
    const filterTilesRT = this._tilesFiltersRT ?? this._tilesVisibleRT;

    if (this._kindActive.particles && this._baseParticlesRT) {
      if (this._belowTokensNeeded.particles && this._tokensRT) {
        this._cutoutParticlesTokensRT = rebuildCutoutFromBase(
          this._baseParticlesRT,
          this._tokensRT,
          this._cutoutParticlesTokensRT,
        );
      }
      if (this._belowTilesNeeded.particles && particleTilesRT) {
        this._cutoutParticlesTilesRT = rebuildCutoutFromBase(
          this._baseParticlesRT,
          particleTilesRT,
          this._cutoutParticlesTilesRT,
        );
      }
      if (this._belowTokensNeeded.particles && this._belowTilesNeeded.particles && this._tokensRT && particleTilesRT) {
        this._cutoutParticlesCombinedRT = rebuildCombinedCutoutFromBase(
          this._baseParticlesRT,
          this._tokensRT,
          particleTilesRT,
          this._cutoutParticlesCombinedRT,
          { tokensCutoutRT: this._cutoutParticlesTokensRT, tilesCutoutRT: this._cutoutParticlesTilesRT },
        );
      }
    }

    if (this._kindActive.filters && this._baseFiltersRT) {
      if (this._belowTokensNeeded.filters && this._tokensRT) {
        this._cutoutFiltersTokensRT = rebuildCutoutFromBase(
          this._baseFiltersRT,
          this._tokensRT,
          this._cutoutFiltersTokensRT,
        );
      }
      if (this._belowTilesNeeded.filters && filterTilesRT) {
        this._cutoutFiltersTilesRT = rebuildCutoutFromBase(
          this._baseFiltersRT,
          filterTilesRT,
          this._cutoutFiltersTilesRT,
        );
      }
      if (this._belowTokensNeeded.filters && this._belowTilesNeeded.filters && this._tokensRT && filterTilesRT) {
        this._cutoutFiltersCombinedRT = rebuildCombinedCutoutFromBase(
          this._baseFiltersRT,
          this._tokensRT,
          filterTilesRT,
          this._cutoutFiltersCombinedRT,
          { tokensCutoutRT: this._cutoutFiltersTokensRT, tilesCutoutRT: this._cutoutFiltersTilesRT },
        );
      }
    }
  }

  /**
   * Internal implementation of the mask refresh pipeline.
   * @param {Array<"particles"|"filters">} kinds
   * @private
   */
  _refreshImpl(kinds = ["particles", "filters"]) {
    if (!canvas?.ready) return;

    const regions = getRegionEffectPlaceablesForCurrentView(canvas?.scene ?? null);
    const suppressionContext = createSuppressionRefreshContext();
    const activeSuppressionKinds = [];
    if (kinds.includes("particles") && this._kindActive.particles) activeSuppressionKinds.push("particles");
    if (kinds.includes("filters") && this._kindActive.filters) activeSuppressionKinds.push("filters");
    let suppressionInputsByKind = null;
    const getSuppressionInputsByKind = () => {
      suppressionInputsByKind ??= collectSuppressionInputsForKinds(regions, activeSuppressionKinds, suppressionContext);
      return suppressionInputsByKind;
    };

    if (kinds.includes("particles")) {
      if (!this._kindActive.particles) {
        try {
          this._baseParticlesRT?.destroy(true);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        this._baseParticlesRT = null;
        this._baseParticlesSoft = false;

        for (const key of ["_cutoutParticlesTokensRT", "_cutoutParticlesTilesRT", "_cutoutParticlesCombinedRT"]) {
          try {
            this[key]?.destroy(true);
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
          this[key] = null;
        }
      } else {
        const { weatherRegions, suppressionRegions, soft } = getSuppressionInputsByKind().particles;
        this._baseParticlesRT = buildSceneAllowMaskRT({
          weatherRegions,
          suppressionRegions,
          reuseRT: this._baseParticlesRT,
        });
        this._baseParticlesSoft = soft;
      }
    }

    if (kinds.includes("filters")) {
      if (!this._kindActive.filters) {
        try {
          this._baseFiltersRT?.destroy(true);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        this._baseFiltersRT = null;
        this._baseFiltersSoft = false;

        for (const key of ["_cutoutFiltersTokensRT", "_cutoutFiltersTilesRT", "_cutoutFiltersCombinedRT"]) {
          try {
            this[key]?.destroy(true);
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
          this[key] = null;
        }
      } else {
        const { weatherRegions, suppressionRegions, soft } = getSuppressionInputsByKind().filters;
        this._baseFiltersRT = buildSceneAllowMaskRT({
          weatherRegions,
          suppressionRegions,
          reuseRT: this._baseFiltersRT,
        });
        this._baseFiltersSoft = soft;
      }
    }

    /**
     * Shared coverage RenderTextures are maintained only when at least one active consumer requires them.
     */
    const needTokens = this._belowTokensNeeded.particles || this._belowTokensNeeded.filters;
    const needTiles = this._belowTilesNeeded.particles || this._belowTilesNeeded.filters;

    this._ensureSharedCoverageTextures({ needTokens, needTiles });

    if (kinds.includes("particles")) {
      if (this._kindActive.particles && this._baseParticlesRT && this._belowTokensNeeded.particles && this._tokensRT) {
        this._cutoutParticlesTokensRT = rebuildCutoutFromBase(
          this._baseParticlesRT,
          this._tokensRT,
          this._cutoutParticlesTokensRT,
        );
      } else if (this._cutoutParticlesTokensRT) {
        try {
          this._cutoutParticlesTokensRT.destroy(true);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        this._cutoutParticlesTokensRT = null;
      }

      const particleTilesRT = this._tilesRT ?? this._tilesVisibleRT;
      if (this._kindActive.particles && this._baseParticlesRT && this._belowTilesNeeded.particles && particleTilesRT) {
        this._cutoutParticlesTilesRT = rebuildCutoutFromBase(
          this._baseParticlesRT,
          particleTilesRT,
          this._cutoutParticlesTilesRT,
        );
      } else if (this._cutoutParticlesTilesRT) {
        try {
          this._cutoutParticlesTilesRT.destroy(true);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        this._cutoutParticlesTilesRT = null;
      }

      if (
        this._kindActive.particles &&
        this._baseParticlesRT &&
        this._belowTokensNeeded.particles &&
        this._belowTilesNeeded.particles &&
        this._tokensRT &&
        particleTilesRT
      ) {
        this._cutoutParticlesCombinedRT = rebuildCombinedCutoutFromBase(
          this._baseParticlesRT,
          this._tokensRT,
          particleTilesRT,
          this._cutoutParticlesCombinedRT,
          { tokensCutoutRT: this._cutoutParticlesTokensRT, tilesCutoutRT: this._cutoutParticlesTilesRT },
        );
      } else if (this._cutoutParticlesCombinedRT) {
        try {
          this._cutoutParticlesCombinedRT.destroy(true);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        this._cutoutParticlesCombinedRT = null;
      }
    }

    if (kinds.includes("filters")) {
      if (this._kindActive.filters && this._baseFiltersRT && this._belowTokensNeeded.filters && this._tokensRT) {
        this._cutoutFiltersTokensRT = rebuildCutoutFromBase(
          this._baseFiltersRT,
          this._tokensRT,
          this._cutoutFiltersTokensRT,
        );
      } else if (this._cutoutFiltersTokensRT) {
        try {
          this._cutoutFiltersTokensRT.destroy(true);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        this._cutoutFiltersTokensRT = null;
      }

      const filterTilesRT = this._tilesFiltersRT ?? this._tilesVisibleRT;
      if (this._kindActive.filters && this._baseFiltersRT && this._belowTilesNeeded.filters && filterTilesRT) {
        this._cutoutFiltersTilesRT = rebuildCutoutFromBase(
          this._baseFiltersRT,
          filterTilesRT,
          this._cutoutFiltersTilesRT,
        );
      } else if (this._cutoutFiltersTilesRT) {
        try {
          this._cutoutFiltersTilesRT.destroy(true);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        this._cutoutFiltersTilesRT = null;
      }

      if (
        this._kindActive.filters &&
        this._baseFiltersRT &&
        this._belowTokensNeeded.filters &&
        this._belowTilesNeeded.filters &&
        this._tokensRT &&
        filterTilesRT
      ) {
        this._cutoutFiltersCombinedRT = rebuildCombinedCutoutFromBase(
          this._baseFiltersRT,
          this._tokensRT,
          filterTilesRT,
          this._cutoutFiltersCombinedRT,
          { tokensCutoutRT: this._cutoutFiltersTokensRT, tilesCutoutRT: this._cutoutFiltersTilesRT },
        );
      } else if (this._cutoutFiltersCombinedRT) {
        try {
          this._cutoutFiltersCombinedRT.destroy(true);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        this._cutoutFiltersCombinedRT = null;
      }
    }
  }

  /**
   * Destroy and clear all derived masks (cutouts and shared coverage RTs), but leave base allow masks untouched.
   * @private
   */
  _cleanupArtifacts() {
    for (const key of [
      "_cutoutParticlesTokensRT",
      "_cutoutParticlesTilesRT",
      "_cutoutParticlesCombinedRT",
      "_cutoutFiltersTokensRT",
      "_cutoutFiltersTilesRT",
      "_cutoutFiltersCombinedRT",
      "_tokensRT",
      "_tilesRT",
      "_tilesFiltersRT",
      "_tilesVisibleRT",
    ]) {
      if (!this[key]) continue;
      try {
        this[key].destroy(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this[key] = null;
    }
    this._sharedCoverageRefreshFrameKey = null;
  }

  /**
   * Fully clear the manager:
   * - Cancels any pending refresh
   * - Destroys and nulls out base and derived render textures
   */
  clear() {
    try {
      this._scheduleRefresh?.cancel?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    const destroyRT = (key) => {
      const rt = this[key];
      if (!rt) return;
      try {
        rt.destroy(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this[key] = null;
    };

    destroyRT("_baseParticlesRT");
    destroyRT("_baseFiltersRT");
    clearPersistentUpperSurfaceObjectsCache();
    this._baseParticlesSoft = false;
    this._baseFiltersSoft = false;
    try {
      clearSceneSuppressionSoftMaskCache();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    if (this._stackMaskCache instanceof Map) {
      for (const entry of this._stackMaskCache.values()) {
        for (const rt of [entry?.base, entry?.cutoutTokens, entry?.cutoutTiles, entry?.cutoutCombined]) {
          try {
            rt?.destroy?.(true);
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
        }
      }
      this._stackMaskCache.clear();
    }
    this._cleanupArtifacts();
  }

  /**
   * @param {"particles"|"filters"} kind
   * @returns {boolean}
   */
  hasSuppressionRegions(kind = "particles") {
    const normalizedKind = kind === "filters" ? "filters" : "particles";
    const regions = getRegionEffectPlaceablesForCurrentView(canvas?.scene ?? null);
    const regionSignature = regions.map((region) => suppressionRegionPresenceSignature(region)).join("#");
    const controlledTokens = controlledTokenSuppressionSignature();
    const eventGateSignature = suppressionEventGateSignature(regions);
    const key = [
      canvas?.scene?.id ?? "scene",
      normalizedKind,
      canvas?.level?.id ?? "",
      applyRegionBehaviorsToOverheadLevels() ? 1 : 0,
      game?.user?.isGM ? 1 : 0,
      regions.length,
      regionSignature,
      controlledTokens,
      eventGateSignature,
    ].join(":");
    const cached = this._suppressionPresenceCache?.[normalizedKind] ?? null;
    if (cached?.key === key) return cached.value === true;

    const value = regions.some((reg) => regionPassesSuppressionGate(reg, normalizedKind));
    if (cached) {
      cached.key = key;
      cached.value = value;
    }
    return value;
  }

  /**
   * Return whether active suppression Regions for a pipeline can affect at least one of the supplied scene-effect Level ids.
   *
   * Empty or missing selections mean the scene effect applies to all Levels, so this falls back to the broader suppression-presence test. The check is used by hot camera-move paths to avoid rebuilding scene-level allow masks for a Region whose assigned Level cannot suppress any currently active scene particle/filter Level.
   *
   * @param {"particles"|"filters"} [kind="particles"]
   * @param {Set<string>|string[]|null|undefined} [selectedLevelIds=null]
   * @returns {boolean}
   */
  hasSuppressionRegionsForLevelSelection(kind = "particles", selectedLevelIds = null) {
    const normalizedKind = kind === "filters" ? "filters" : "particles";
    if (CONFIG?.fxmaster?.overheadPerformance?.sceneSuppressionLevelIntersection === false) {
      return this.hasSuppressionRegions(normalizedKind);
    }

    const selected = selectedLevelIds instanceof Set ? selectedLevelIds : new Set(selectedLevelIds ?? []);
    if (!selected.size) return this.hasSuppressionRegions(normalizedKind);
    if (!this.hasSuppressionRegions(normalizedKind)) return false;

    const behaviorType = normalizedKind === "filters" ? SUPPRESS_SCENE_FILTERS : SUPPRESS_SCENE_PARTICLES;
    const regions = getRegionEffectPlaceablesForCurrentView(canvas?.scene ?? null);
    const context = createSuppressionRefreshContext();

    for (const region of regions ?? []) {
      const doc = region?.document ?? region;
      if (!doc) continue;
      if (!regionDocumentCanApplyInCurrentView(doc, doc?.parent ?? canvas?.scene ?? null)) continue;

      const summary = getSuppressionBehaviorSummary(doc, context);
      const behaviors = normalizedKind === "filters" ? summary.filterBehaviors : summary.particleBehaviors;
      const specificPasses = !!behaviors?.length && computeRegionGatePass(region, { behaviorType });
      const weatherPasses = !!summary.hasWeather && computeRegionGatePass(region, { behaviorType: SUPPRESS_WEATHER });
      if (!specificPasses && !weatherPasses) continue;

      const regionLevels = getDocumentAssignedLevelIds(doc, doc?.parent ?? canvas?.scene ?? null);
      if (!regionLevels?.size) return true;
      for (const levelId of regionLevels) {
        if (selected.has(String(levelId))) return true;
      }
    }

    return false;
  }
}
