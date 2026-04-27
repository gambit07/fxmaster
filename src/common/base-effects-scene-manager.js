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
import {
  buildSceneAllowMaskRT,
  clearSceneSuppressionSoftMaskCache,
  coalesceNextFrame,
  computeRegionGatePass,
  getCanvasLevel,
  getCanvasLiveLevelSurfaceRevealState,
  getCssViewportMetrics,
  getDocumentLevelsSet,
  getSceneLevels as getSceneLevelDocuments,
  getRegionElevationWindow,
  inferVisibleLevelForDocument,
  isDocumentOnCurrentCanvasLevel,
  syncCanvasLiveLevelSurfaceState,
  repaintTokensMaskInto,
  repaintTilesMaskInto,
  safeMaskResolutionForCssArea,
} from "../utils.js";

/** @type {PIXI.Sprite|null} */
let _tmpBaseCopySprite = null;
/** @type {PIXI.Sprite|null} */
let _tmpTokensEraseSprite = null;

const SUPPRESS_WEATHER = "suppressWeather";
const SUPPRESS_SCENE_PARTICLES = `${packageId}.suppressSceneParticles`;
const SUPPRESS_SCENE_FILTERS = `${packageId}.suppressSceneFilters`;

/**
 * Resolve a configured image source path from scene or Level data.
 *
 * @param {*} sourceValue
 * @returns {string}
 * @private
 */
function resolveConfiguredImageSourcePath(sourceValue) {
  if (typeof sourceValue === "string") return sourceValue;
  if (sourceValue && typeof sourceValue === "object" && typeof sourceValue.src === "string") return sourceValue.src;
  return "";
}

/**
 * Normalize a source path for stable equality checks.
 *
 * @param {string|null|undefined} sourcePath
 * @returns {string}
 * @private
 */
function normalizeComparableSourcePath(sourcePath) {
  if (typeof sourcePath !== "string") return "";
  const trimmed = sourcePath.trim();
  if (!trimmed) return "";

  const originPattern = new RegExp("^https?:\\/\\/[^/]+", "i");
  const filePattern = new RegExp("^file:\\/\\/", "i");

  try {
    const decoded = decodeURI(trimmed);
    return decoded.replace(originPattern, "").replace(filePattern, "");
  } catch {
    return trimmed.replace(originPattern, "").replace(filePattern, "");
  }
}

/**
 * Add a comparable source path into an output set when it is usable.
 *
 * @param {Set<string>} output
 * @param {string|null|undefined} sourcePath
 * @returns {void}
 * @private
 */
function addComparableSourcePath(output, sourcePath) {
  if (!(output instanceof Set)) return;
  const normalized = normalizeComparableSourcePath(sourcePath);
  if (normalized) output.add(normalized);
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
function collectComparableSourcePaths(value, output, seen = new Set()) {
  if (!value || !(output instanceof Set)) return;

  if (typeof value === "string") {
    addComparableSourcePath(output, value);
    return;
  }

  if (typeof value !== "object" && typeof value !== "function") return;
  if (seen.has(value)) return;
  seen.add(value);

  const directCandidates = [value?.src, value?.currentSrc, value?.url, value?.href, value?.path, value?.cacheId];
  for (const candidate of directCandidates) addComparableSourcePath(output, candidate);

  const cacheIds = value?.textureCacheIds;
  if (Array.isArray(cacheIds)) {
    for (const candidate of cacheIds) addComparableSourcePath(output, candidate);
  }

  const nestedCandidates = [
    value?.texture,
    value?.baseTexture,
    value?.resource,
    value?.source,
    value?.parentTextureArray,
    value?.object,
    value?.document,
    value?._source,
  ];
  for (const nested of nestedCandidates) {
    if (!nested || nested === value) continue;
    collectComparableSourcePaths(nested, output, seen);
  }
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
  return Number(level?.elevation?.bottom ?? level?.bottom ?? Number.NaN);
}

/**
 * Return the top elevation for a Level document.
 *
 * @param {any} level
 * @returns {number}
 * @private
 */
function getLevelTop(level) {
  return Number(level?.elevation?.top ?? level?.top ?? Number.NaN);
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
  if (!candidate || !target) return false;

  const candidateBottom = getLevelBottom(candidate);
  const targetBottom = getLevelBottom(target);
  if (Number.isFinite(candidateBottom) && Number.isFinite(targetBottom)) return candidateBottom > targetBottom + 1e-4;

  const candidateTop = getLevelTop(candidate);
  const targetTop = getLevelTop(target);
  if (Number.isFinite(candidateTop) && Number.isFinite(targetTop)) return candidateTop > targetTop + 1e-4;

  return false;
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
  const regionLevels = getDocumentLevelsSet(document);
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
  if (fallbackLevel?.id) ids.add(fallbackLevel.id);

  const currentLevel = getCanvasLevel();
  if (currentLevel?.id) ids.add(currentLevel.id);

  const levels = getDocumentLevelsSet(document);
  if (levels?.size) {
    for (const levelId of levels) {
      if (getSceneLevelById(levelId, document?.parent ?? canvas?.scene ?? null)) ids.add(levelId);
    }
  }

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

  const candidates = [level?.background, level?.foreground, level?._source?.background, level?._source?.foreground];

  for (const candidate of candidates) {
    const direct = resolveConfiguredImageSourcePath(candidate);
    if (direct) addComparableSourcePath(output, direct);
    collectComparableSourcePaths(candidate, output);
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
 * @returns {{ levelTextures: PIXI.DisplayObject[]|null, tileMeshes: PIXI.DisplayObject[]|null, protectedLevelImagePathsByKey: Map<string, Set<string>>, upperSurfaceObjectsByKey: Map<string, PIXI.DisplayObject[]>, suppressionBehaviorSummaryByDocument: WeakMap<object, object>, syncedLiveLevelSurfaceState: boolean }}
 * @private
 */
function createSuppressionRefreshContext() {
  return {
    levelTextures: null,
    tileMeshes: null,
    protectedLevelImagePathsByKey: new Map(),
    upperSurfaceObjectsByKey: new Map(),
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

  const candidateId = value?.id ?? value?._id ?? value?.document?.id ?? value?.document?._id ?? null;
  if (candidateId && getSceneLevelById(candidateId)) output.add(candidateId);

  const nested = [
    value?.level ?? null,
    value?.levels ?? null,
    value?.document?.level ?? null,
    value?.document?.levels ?? null,
    value?._source?.level ?? null,
    value?._source?.levels ?? null,
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
    document?._source?.level ?? null,
    document?._source?.levels ?? null,
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

  const source = value?._source ?? null;
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
  const fallback = Number(fallbackElevation);
  const trustDocumentElevation = isDocumentBackedSurface(document) || !Number.isFinite(fallback);
  const sourceElevation = trustDocumentElevation ? document?.elevation ?? document?._source?.elevation ?? null : null;
  const scalarElevation = Number(sourceElevation);
  if (Number.isFinite(scalarElevation)) return { min: scalarElevation, max: scalarElevation };

  const bottom = sourceElevation?.bottom ?? document?._source?.elevation?.bottom;
  const top = sourceElevation?.top ?? document?._source?.elevation?.top;
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

  const ids = new Set();
  for (const sceneLevel of getSceneLevels()) {
    const levelId = sceneLevel?.id ?? null;
    if (!levelId) continue;

    const levelPaths = new Set();
    addLevelConfiguredImagePaths(sceneLevel, levelPaths);
    for (const pathValue of surfacePaths) {
      if (!levelPaths.has(pathValue)) continue;
      ids.add(levelId);
      break;
    }
  }

  return ids;
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
function surfaceTargetsLevelIds(
  { mesh = null, object = null, document = null, level = null, elevation = Number.NaN, window = null } = {},
  levelIds,
) {
  if (!(levelIds?.size > 0)) return false;

  const configuredIds = resolveSurfaceConfiguredLevelIds({ mesh, object, document, level });
  if (configuredIds.size) return surfaceLevelIdsIntersect(configuredIds, levelIds);

  const ownerIds = resolveSurfaceOwnerLevelIds({ mesh, object, document, level });
  if (ownerIds.size) return surfaceLevelIdsIntersect(ownerIds, levelIds);

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
 * Return all currently visible overlay Levels above a target Level.
 *
 * @param {any} targetLevel
 * @param {{ protectedLevelIds?: Set<string>|null }} [options]
 * @returns {Array<any>}
 * @private
 */
function getVisibleOverlayLevelsAboveTarget(targetLevel, { protectedLevelIds = null } = {}) {
  if (!targetLevel) return [];

  return getSceneLevels().filter((level) => {
    const levelId = level?.id ?? null;
    if (!levelId) return false;
    if (protectedLevelIds?.has(levelId)) return false;
    if (!(level?.isVisible || level?.isView)) return false;
    return levelIsAboveTargetLevel(level, targetLevel);
  });
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

    const linked = mesh?.object ?? mesh?.placeable ?? mesh?._object ?? mesh?.sourceElement ?? null;
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

    const hoverFade = mesh?._hoverFadeState ?? mesh?.hoverFadeState ?? tile?.hoverFadeState ?? null;
    if (hoverFade?.faded || hoverFade?.fading) return true;

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

  const window = getSurfaceElevationWindow(document ?? object ?? level ?? null, elevation);
  if (surfaceTargetsLevelIds({ mesh, object, document, level, elevation, window }, protectedLevelIds)) return false;
  return surfaceTargetsLevelIds({ mesh, object, document, level, elevation, window }, overlayLevelIds);
}

/**
 * Collect currently rendered upper-level surfaces above a target Level.
 *
 * @param {any|null|undefined} targetLevel
 * @param {{ protectedLevelIds?: Set<string>|null, context?: object|null }} [options]
 * @returns {PIXI.DisplayObject[]}
 * @private
 */
function collectUpperSurfaceObjectsForTargetLevel(targetLevel, { protectedLevelIds = null, context = null } = {}) {
  if (!targetLevel || !canvas?.primary) return [];

  const cacheKey = context ? `${targetLevel?.id ?? ""}:${getLevelIdsCacheKey(protectedLevelIds)}` : null;
  const cache = context?.upperSurfaceObjectsByKey ?? null;
  if (cacheKey && cache?.has(cacheKey)) return cache.get(cacheKey) ?? [];
  const remember = (objects) => {
    const value = objects ?? [];
    if (cacheKey) cache?.set(cacheKey, value);
    return value;
  };

  const overlayLevels = getVisibleOverlayLevelsAboveTarget(targetLevel, { protectedLevelIds });
  if (!overlayLevels.length) return remember([]);

  syncSuppressionLiveLevelState(context);

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
    if (revealState.revealed) continue;
    push(captureObject);
  }

  for (const mesh of getSuppressionContextTileMeshes(context)) {
    const tileObject = mesh?.object ?? mesh?.placeable ?? mesh?._object ?? mesh?.sourceElement ?? null;
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
    if (revealState.revealed) continue;
    push(captureObject);
  }

  return remember(objects);
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
 * Collect hard-edged suppressWeather descriptors and configurable FXMaster suppression descriptors for a pipeline.
 *
 * @param {PlaceableObject[]} regions
 * @param {"filters"|"particles"} kind
 * @param {object|null} [context]
 * @returns {{ weatherRegions: Array<{ region: PlaceableObject, preserveObjects?: PIXI.DisplayObject[] }>, suppressionRegions: Array<{ region: PlaceableObject, edgeFadePercent: number, preserveObjects?: PIXI.DisplayObject[] }>, soft: boolean }}
 * @private
 */
function collectSuppressionInputs(regions, kind, context = null) {
  const weatherRegions = [];
  const suppressionRegions = [];
  const behaviorType = kind === "filters" ? SUPPRESS_SCENE_FILTERS : SUPPRESS_SCENE_PARTICLES;

  let soft = false;

  for (const region of regions ?? []) {
    const doc = region?.document;
    if (!doc) continue;

    const behaviorSummary = getSuppressionBehaviorSummary(doc, context);
    const hasWeather = behaviorSummary.hasWeather;
    const weatherPasses = hasWeather && computeRegionGatePass(region, { behaviorType: SUPPRESS_WEATHER });

    const kindBehaviors = kind === "filters" ? behaviorSummary.filterBehaviors : behaviorSummary.particleBehaviors;
    const kindPasses = !!kindBehaviors.length && computeRegionGatePass(region, { behaviorType });

    if (!weatherPasses && !kindPasses) continue;

    const targetLevel = resolveSuppressionRegionTargetLevel(doc);
    const protectedLevelIds = getSuppressionAllowedLevelIds(doc, targetLevel);
    const preserveObjects = targetLevel
      ? collectUpperSurfaceObjectsForTargetLevel(targetLevel, { protectedLevelIds, context })
      : [];

    if (weatherPasses) {
      const descriptor = { region };
      if (preserveObjects.length) descriptor.preserveObjects = preserveObjects;
      weatherRegions.push(descriptor);
    }

    if (!kindPasses) continue;

    let edgeFadePercent = 0;
    for (const behavior of kindBehaviors) {
      const pct = Math.min(Math.max(Number(behavior.getFlag?.(packageId, "edgeFadePercent")) || 0, 0), 1);
      edgeFadePercent = Math.max(edgeFadePercent, pct);
    }

    if (edgeFadePercent > 0) soft = true;

    const descriptor = { region, edgeFadePercent };
    if (preserveObjects.length) descriptor.preserveObjects = preserveObjects;
    suppressionRegions.push(descriptor);
  }

  return { weatherRegions, suppressionRegions, soft };
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
  const W = Math.max(1, width | 0);
  const H = Math.max(1, height | 0);
  const res = resolution || 1;

  const bad =
    !reuseRT ||
    reuseRT.destroyed ||
    (reuseRT.width | 0) !== W ||
    (reuseRT.height | 0) !== H ||
    (reuseRT.resolution || 1) !== res;

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

  const W = Math.max(1, baseRT.width | 0);
  const H = Math.max(1, baseRT.height | 0);
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
    this._tilesVisibleRT = null;

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

    /**
     * Short-lived region suppression presence cache.
     * @type {{particles:{key:string|null,value:boolean}, filters:{key:string|null,value:boolean}}}
     * @private
     */
    this._suppressionPresenceCache = {
      particles: { key: null, value: false },
      filters: { key: null, value: false },
    };

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
        tiles: this._tilesRT,
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
      tiles: this._tilesRT,
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
        for (const key of ["_tilesRT", "_tilesVisibleRT"]) {
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

      const needTiles = this._belowTilesNeeded.particles || this._belowTilesNeeded.filters;
      if (!needTiles) {
        for (const key of ["_tilesRT", "_tilesVisibleRT"]) {
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

    try {
      this.refreshTokensSync?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    if (this._kindActive[kind]) this.refresh(kind);
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
   */
  refreshTokensSync() {
    if (!canvas?.ready) return;

    const needTokens = this._belowTokensNeeded.particles || this._belowTokensNeeded.filters;
    const needTiles = this._belowTilesNeeded.particles || this._belowTilesNeeded.filters;

    if (!needTokens && !needTiles) return;

    const { cssW, cssH } = getCssViewportMetrics();
    const res = safeMaskResolutionForCssArea(cssW, cssH, 1);

    if (needTiles) this._syncDynamicCoverageSources();

    if (needTokens) {
      this._tokensRT = ensureRenderTexture(this._tokensRT, { width: cssW, height: cssH, resolution: res });
      repaintTokensMaskInto(this._tokensRT);
    } else if (this._tokensRT) {
      try {
        this._tokensRT.destroy(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this._tokensRT = null;
    }

    if (needTiles) {
      this._tilesRT = ensureRenderTexture(this._tilesRT, { width: cssW, height: cssH, resolution: res });
      this._tilesVisibleRT = ensureRenderTexture(this._tilesVisibleRT, { width: cssW, height: cssH, resolution: res });
      repaintTilesMaskInto(this._tilesRT, { mode: "suppression" });
      repaintTilesMaskInto(this._tilesVisibleRT, { mode: "visible" });
    } else {
      for (const key of ["_tilesRT", "_tilesVisibleRT"]) {
        if (!this[key]) continue;
        try {
          this[key].destroy(true);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        this[key] = null;
      }
    }

    if (this._kindActive.particles && this._baseParticlesRT) {
      if (this._belowTokensNeeded.particles && this._tokensRT) {
        this._cutoutParticlesTokensRT = rebuildCutoutFromBase(
          this._baseParticlesRT,
          this._tokensRT,
          this._cutoutParticlesTokensRT,
        );
      }
      if (this._belowTilesNeeded.particles && this._tilesRT) {
        this._cutoutParticlesTilesRT = rebuildCutoutFromBase(
          this._baseParticlesRT,
          this._tilesRT,
          this._cutoutParticlesTilesRT,
        );
      }
      if (this._belowTokensNeeded.particles && this._belowTilesNeeded.particles && this._tokensRT && this._tilesRT) {
        this._cutoutParticlesCombinedRT = rebuildCutoutFromBase(
          this._baseParticlesRT,
          [this._tokensRT, this._tilesRT],
          this._cutoutParticlesCombinedRT,
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
      if (this._belowTilesNeeded.filters && this._tilesRT) {
        this._cutoutFiltersTilesRT = rebuildCutoutFromBase(
          this._baseFiltersRT,
          this._tilesRT,
          this._cutoutFiltersTilesRT,
        );
      }
      if (this._belowTokensNeeded.filters && this._belowTilesNeeded.filters && this._tokensRT && this._tilesRT) {
        this._cutoutFiltersCombinedRT = rebuildCutoutFromBase(
          this._baseFiltersRT,
          [this._tokensRT, this._tilesRT],
          this._cutoutFiltersCombinedRT,
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

    const regions = canvas.regions?.placeables ?? [];
    const suppressionContext = createSuppressionRefreshContext();

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
        const { weatherRegions, suppressionRegions, soft } = collectSuppressionInputs(
          regions,
          "particles",
          suppressionContext,
        );
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
        const { weatherRegions, suppressionRegions, soft } = collectSuppressionInputs(
          regions,
          "filters",
          suppressionContext,
        );
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

    if (needTokens || needTiles) {
      const { cssW, cssH } = getCssViewportMetrics();
      const res = safeMaskResolutionForCssArea(cssW, cssH, 1);

      if (needTiles) this._syncDynamicCoverageSources();

      if (needTokens) {
        this._tokensRT = ensureRenderTexture(this._tokensRT, { width: cssW, height: cssH, resolution: res });
        repaintTokensMaskInto(this._tokensRT);
      } else if (this._tokensRT) {
        try {
          this._tokensRT.destroy(true);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        this._tokensRT = null;
      }

      if (needTiles) {
        this._tilesRT = ensureRenderTexture(this._tilesRT, { width: cssW, height: cssH, resolution: res });
        this._tilesVisibleRT = ensureRenderTexture(this._tilesVisibleRT, {
          width: cssW,
          height: cssH,
          resolution: res,
        });
        repaintTilesMaskInto(this._tilesRT, { mode: "suppression" });
        repaintTilesMaskInto(this._tilesVisibleRT, { mode: "visible" });
      } else {
        for (const key of ["_tilesRT", "_tilesVisibleRT"]) {
          if (!this[key]) continue;
          try {
            this[key].destroy(true);
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
          this[key] = null;
        }
      }
    } else {
      if (this._tokensRT) {
        try {
          this._tokensRT.destroy(true);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        this._tokensRT = null;
      }
      for (const key of ["_tilesRT", "_tilesVisibleRT"]) {
        if (!this[key]) continue;
        try {
          this[key].destroy(true);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        this[key] = null;
      }
    }

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

      if (this._kindActive.particles && this._baseParticlesRT && this._belowTilesNeeded.particles && this._tilesRT) {
        this._cutoutParticlesTilesRT = rebuildCutoutFromBase(
          this._baseParticlesRT,
          this._tilesRT,
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
        this._tilesRT
      ) {
        this._cutoutParticlesCombinedRT = rebuildCutoutFromBase(
          this._baseParticlesRT,
          [this._tokensRT, this._tilesRT],
          this._cutoutParticlesCombinedRT,
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

      if (this._kindActive.filters && this._baseFiltersRT && this._belowTilesNeeded.filters && this._tilesRT) {
        this._cutoutFiltersTilesRT = rebuildCutoutFromBase(
          this._baseFiltersRT,
          this._tilesRT,
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
        this._tilesRT
      ) {
        this._cutoutFiltersCombinedRT = rebuildCutoutFromBase(
          this._baseFiltersRT,
          [this._tokensRT, this._tilesRT],
          this._cutoutFiltersCombinedRT,
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
    this._baseParticlesSoft = false;
    this._baseFiltersSoft = false;
    try {
      clearSceneSuppressionSoftMaskCache();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    this._cleanupArtifacts();
  }

  /**
   * @param {"particles"|"filters"} kind
   * @returns {boolean}
   */
  hasSuppressionRegions(kind = "particles") {
    const normalizedKind = kind === "filters" ? "filters" : "particles";
    const regions = canvas?.regions?.placeables ?? [];
    const controlledTokens = Array.from(canvas?.tokens?.controlled ?? [])
      .map(
        (token) =>
          `${token?.document?.id ?? token?.id ?? ""}:${Number(token?.document?.elevation ?? token?.elevation ?? 0)}`,
      )
      .join("|");
    const tick = Number(canvas?.app?.ticker?.lastTime ?? 0).toFixed(3);
    const key = [
      canvas?.scene?.id ?? "scene",
      normalizedKind,
      canvas?.level?.id ?? "",
      regions.length,
      controlledTokens,
      tick,
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
}
