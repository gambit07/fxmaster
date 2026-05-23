/**
 * FXMaster: Version Compatibility Helpers
 *
 * Centralises Foundry version differences around flag update operators. V13 uses legacy "-=key" / "==key" update syntax, while V14+ prefers explicit DataFieldOperator instances.
 */

import { ALL_LEVELS_SELECTION, packageId } from "../constants.js";
import { logger } from "../logger.js";
import { applyRegionBehaviorsToOverheadLevels } from "../settings-access.js";
import {
  fxmGetDocumentElevationWindow,
  fxmGetDocumentLevelIds,
  fxmDocumentIncludedInLevel,
  fxmDocumentId,
  fxmGetLevelConfiguredImagePaths,
  fxmGetLevelTexturePlan,
  fxmClearLevelTexturePlanCache,
  fxmGetSceneLevelById,
  fxmGetSceneLevels as fxmGetSceneLevelsPublic,
  fxmGetSceneSurfaces,
  fxmReadDocumentSnapshotValue,
  fxmLevelBottom,
  fxmLevelIsAbove,
  fxmLevelTop,
  fxmResolveLevelIdsFromConfiguredSources,
  fxmCollectComparableSourcePaths,
  fxmLinkedPlaceableFromDisplayObject,
  fxmGetPublicHoverFadeState,
  fxmSceneHasSurfaces,
} from "./foundry-public.js";

/**
 * Check whether a key name is one of Foundry's legacy special keys.
 * @param {string} key
 * @returns {boolean}
 */
export function isLegacyOperatorKey(key) {
  return typeof key === "string" && (key.startsWith("-=") || key.startsWith("=="));
}

/**
 * Module-scoped cache for the V14+ ForcedDeletion operator singleton.
 * @type {foundry.data.operators.ForcedDeletion|null|undefined}
 */
let _cachedForcedDeletion;

/**
 * Get a V14+ ForcedDeletion operator instance.
 *
 * Prefers Foundry DataFieldOperator APIs when available.
 *
 * @returns {foundry.data.operators.ForcedDeletion|null}
 */
export function getForcedDeletionOperator() {
  const ForcedDeletion = foundry?.data?.operators?.ForcedDeletion;
  if (!ForcedDeletion) return null;

  if (_cachedForcedDeletion !== undefined) return _cachedForcedDeletion;

  if (typeof ForcedDeletion.create === "function") {
    _cachedForcedDeletion = ForcedDeletion.create();
    return _cachedForcedDeletion;
  }
  try {
    _cachedForcedDeletion = new ForcedDeletion();
    return _cachedForcedDeletion;
  } catch {
    _cachedForcedDeletion = null;
    return null;
  }
}

/**
 * Module-scoped reference to the V14+ ForcedReplacement factory.
 * @type {Function|null|undefined}
 */
let _cachedReplacementFactory;

/**
 * Get a V14+ ForcedReplacement operator for a replacement value.
 *
 * Prefers Foundry DataFieldOperator APIs when available.
 *
 * @param {*} replacement
 * @returns {foundry.data.operators.ForcedReplacement|null}
 */
export function getForcedReplacementOperator(replacement) {
  const ForcedReplacement = foundry?.data?.operators?.ForcedReplacement;
  if (!ForcedReplacement) return null;

  if (_cachedReplacementFactory === undefined) {
    if (typeof ForcedReplacement.create === "function") {
      _cachedReplacementFactory = ForcedReplacement.create.bind(ForcedReplacement);
    } else {
      _cachedReplacementFactory = null;
    }
  }

  if (typeof _cachedReplacementFactory === "function") {
    try {
      return _cachedReplacementFactory(replacement);
    } catch {}
  }

  return null;
}

/**
 * Add a "delete this key" operator to an update object in a way which is compatible with both V13 and V14+ Foundry.
 *
 * @param {object} update - The update object to mutate.
 * @param {string} key - The key to delete.
 * @returns {object} The same update object.
 */
export function addDeletionKey(update, key) {
  const op = getForcedDeletionOperator();
  if (op) update[key] = op;
  else update[`-=${key}`] = null;
  return update;
}

/**
 * Add a "replace this key" operator to an update object in a way which is compatible with both V13 and V14+ Foundry.
 *
 * @param {object} update - The update object to mutate.
 * @param {string} key - The key to replace.
 * @param {*} replacement - The replacement value.
 * @returns {object} The same update object.
 */
export function addReplacementKey(update, key, replacement) {
  const op = getForcedReplacementOperator(replacement);
  if (op) update[key] = op;
  else update[`==${key}`] = replacement;
  return update;
}

/**
 * Create an update object which replaces a specific key.
 * @param {string} key
 * @param {*} replacement
 * @returns {object}
 */
export function replacementUpdate(key, replacement) {
  return addReplacementKey({}, key, replacement);
}

/**
 * Create an update object which deletes a specific key.
 * @param {string} key
 * @returns {object}
 */
export function deletionUpdate(key) {
  return addDeletionKey({}, key);
}

/**
 * Reset a namespaced flag on a document, removing stale keys not present in the next value before calling `setFlag`.
 *
 * @param {foundry.abstract.Document} document
 * @param {string} key
 * @param {*} value
 * @returns {Promise<foundry.abstract.Document>}
 */
export async function resetFlag(document, key, value) {
  if (typeof value === "object" && !Array.isArray(value) && value !== null) {
    const oldFlags = document.getFlag(packageId, key);
    const keys = oldFlags ? Object.keys(oldFlags) : [];
    for (const k of keys) {
      if (isLegacyOperatorKey(k)) continue;
      if (Object.prototype.hasOwnProperty.call(value, k)) continue;
      addDeletionKey(value, k);
    }
  }
  return document.setFlag(packageId, key, value);
}

/**
 * Return the currently viewed Level document, if any.
 *
 * @returns {foundry.documents.Level|null}
 */
export function getCanvasLevel() {
  return canvas?.level ?? null;
}

/**
 * Return a normalized bottom elevation for a native Scene Level.
 *
 * @param {foundry.documents.Level|null|undefined} level
 * @returns {number}
 * @private
 */
function _fxmLevelBottom(level) {
  const value = fxmLevelBottom(level);
  return Number.isFinite(value) ? value : Number(level?.elevation?.bottom ?? level?.bottom ?? Number.NaN);
}

/**
 * Return a normalized top elevation for a native Scene Level.
 *
 * @param {foundry.documents.Level|null|undefined} level
 * @returns {number}
 * @private
 */
function _fxmLevelTop(level) {
  const value = fxmLevelTop(level);
  return Number.isFinite(value) ? value : Number(level?.elevation?.top ?? level?.top ?? Number.NaN);
}

/**
 * Return whether one native Scene Level sits above another.
 *
 * @param {foundry.documents.Level|null|undefined} candidate
 * @param {foundry.documents.Level|null|undefined} target
 * @returns {boolean}
 * @private
 */
function _fxmLevelIsAbove(candidate, target) {
  if (fxmLevelIsAbove(candidate, target)) return true;
  if (!candidate || !target) return false;

  const candidateBottom = _fxmLevelBottom(candidate);
  const targetBottom = _fxmLevelBottom(target);
  if (Number.isFinite(candidateBottom) && Number.isFinite(targetBottom)) return candidateBottom > targetBottom + 1e-4;

  const candidateTop = _fxmLevelTop(candidate);
  const targetTop = _fxmLevelTop(target);
  if (Number.isFinite(candidateTop) && Number.isFinite(targetTop)) return candidateTop > targetTop + 1e-4;

  return false;
}

/**
 * Return collection values without assuming whether Foundry exposed an Array, Collection, Map, Set, or iterable-like object.
 *
 * @param {*} value
 * @returns {Array}
 * @private
 */
function _fxmCollectionValues(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value?.values === "function") {
    try {
      return Array.from(value.values());
    } catch (_err) {
      return [];
    }
  }
  try {
    return Array.from(value);
  } catch (_err) {
    return [];
  }
}

/**
 * Return whether a display object currently contributes visible pixels.
 *
 * @param {PIXI.DisplayObject|null|undefined} object
 * @returns {boolean}
 * @private
 */
function _fxmDisplayObjectContributesVisiblePixels(object) {
  if (!object || object.destroyed) return false;
  if (object.visible === false || object.renderable === false) return false;
  const alpha = Number(object.worldAlpha ?? object.alpha ?? 1);
  return !(Number.isFinite(alpha) && alpha <= 0.001);
}

/**
 * Prefer the live placeable-backed display object for a native Level surface.
 *
 * @param {PIXI.DisplayObject|null|undefined} primaryObject
 * @param {object|null|undefined} linkedObject
 * @returns {PIXI.DisplayObject|null}
 * @private
 */
function _fxmResolveLiveSurfaceDisplayObject(primaryObject, linkedObject) {
  return (
    linkedObject?.mesh ?? linkedObject?.primaryMesh ?? linkedObject?.sprite ?? primaryObject ?? linkedObject ?? null
  );
}

/**
 * Return whether an arbitrary level-like value resolves to a specific Level id.
 *
 * @param {*} value
 * @param {string} levelId
 * @returns {boolean}
 * @private
 */
function _fxmValueTargetsLevelId(value, levelId) {
  if (!value || !levelId) return false;
  const id = fxmDocumentId(value) || fxmDocumentId(value?.document);
  if (id === levelId) return true;

  const levels = getDocumentLevelsSet(value?.document ?? value ?? null);
  return !!levels?.has(levelId);
}

/**
 * Collect texture/source paths from a PIXI object, document, or nested texture.
 *
 * @param {*} value
 * @param {Set<string>} output
 * @param {Set<object>} [seen]
 * @returns {void}
 * @private
 */
function _fxmCollectComparableSourcePaths(value, output) {
  fxmCollectComparableSourcePaths(value, output);
}

/**
 * Resolve Level ids by matching a live surface's texture source against native Level background/foreground artwork.
 *
 * @param {{ mesh?: object|null, object?: object|null, document?: foundry.abstract.Document|null, level?: object|null }} surface
 * @returns {Set<string>}
 * @private
 */
function _fxmResolveSurfaceConfiguredLevelIds({ mesh = null, object = null, document = null, level = null } = {}) {
  const surfacePaths = new Set();
  for (const value of [mesh, object, document, level]) _fxmCollectComparableSourcePaths(value, surfacePaths);
  if (!surfacePaths.size) return new Set();
  return fxmResolveLevelIdsFromConfiguredSources(surfacePaths, {
    scene: canvas?.scene ?? document?.parent ?? object?.document?.parent ?? level?.parent ?? null,
  });
}

/**
 * Return whether a live canvas surface can be associated with a specific native Level id.
 *
 * @param {{ mesh?: object|null, object?: object|null, document?: foundry.abstract.Document|null, level?: object|null, elevation?: number }} surface
 * @param {string} levelId
 * @returns {boolean}
 * @private
 */
function _fxmLiveSurfaceTargetsLevelId(
  { mesh = null, object = null, document = null, level = null, elevation = Number.NaN } = {},
  levelId,
) {
  if (!levelId) return false;

  const configuredIds = _fxmResolveSurfaceConfiguredLevelIds({ mesh, object, document, level });
  if (configuredIds.size) return configuredIds.has(levelId);

  const directCandidates = [
    level,
    mesh?.level ?? null,
    mesh?.object?.level ?? null,
    object?.level ?? null,
    object?.document?.level ?? null,
    document?.level ?? null,
  ];
  for (const candidate of directCandidates) if (_fxmValueTargetsLevelId(candidate, levelId)) return true;

  const documentCandidates = [
    document,
    object?.document ?? null,
    object,
    mesh?.document ?? null,
    mesh?.object?.document ?? null,
    mesh?.object ?? null,
  ];

  const sceneLevel = fxmGetSceneLevelById(
    levelId,
    document?.parent ?? object?.document?.parent ?? canvas?.scene ?? null,
  );
  if (sceneLevel) {
    for (const candidate of documentCandidates) {
      const included = fxmDocumentIncludedInLevel(candidate, sceneLevel);
      if (included !== null) return included;
    }
  }

  for (const candidate of documentCandidates) {
    const levels = getDocumentLevelsSet(candidate);
    if (levels?.has(levelId)) return true;
  }

  const inferred = inferVisibleLevelForDocument(document ?? object?.document ?? object ?? level ?? null, elevation);
  return inferred?.id === levelId;
}

/**
 * Return whether a native Level has any live visible primary surface in the current canvas view.
 *
 * Level documents are not always marked isVisible while their V14 overlay meshes are still rendered/hoverable. Scene and Region runtimes need to stay alive for those live surfaces, but this check stays intentionally cheap and only samples the primary Level/tile collections.
 *
 * @param {foundry.documents.Level|null|undefined} level
 * @returns {boolean}
 * @private
 */
function _fxmLevelHasLiveVisibleCanvasSurface(level) {
  const levelId = fxmDocumentId(level);
  if (!levelId || !canvas?.primary) return false;

  for (const mesh of _fxmCollectionValues(canvas.primary.levelTextures ?? [])) {
    const object = mesh?.object ?? null;
    const liveObject = _fxmResolveLiveSurfaceDisplayObject(mesh, object);
    const captureObject = _fxmDisplayObjectContributesVisiblePixels(mesh)
      ? mesh
      : _fxmDisplayObjectContributesVisiblePixels(liveObject)
      ? liveObject
      : null;
    if (!captureObject) continue;

    const document = mesh?.level?.document ?? mesh?.level ?? object?.document ?? object ?? null;
    const surfaceLevel = mesh?.level ?? object?.level ?? document?.level ?? null;
    const elevation = Number(
      mesh?.elevation ??
        document?.elevation?.bottom ??
        document?.elevation ??
        object?.document?.elevation?.bottom ??
        object?.document?.elevation ??
        Number.NaN,
    );
    if (_fxmLiveSurfaceTargetsLevelId({ mesh, object, document, level: surfaceLevel, elevation }, levelId)) return true;
  }

  for (const mesh of _fxmCollectionValues(canvas.primary.tiles ?? [])) {
    const tileObject = fxmLinkedPlaceableFromDisplayObject(mesh);
    const document = tileObject?.document ?? null;
    if (document?.hidden) continue;

    const liveObject = _fxmResolveLiveSurfaceDisplayObject(mesh, tileObject);
    const captureObject = _fxmDisplayObjectContributesVisiblePixels(mesh)
      ? mesh
      : _fxmDisplayObjectContributesVisiblePixels(liveObject)
      ? liveObject
      : null;
    if (!captureObject) continue;

    const elevation = Number(mesh?.elevation ?? document?.elevation ?? tileObject?.elevation ?? Number.NaN);
    const surfaceLevel = mesh?.level ?? tileObject?.level ?? document?.level ?? null;
    if (
      _fxmLiveSurfaceTargetsLevelId(
        { mesh, object: tileObject, document: document ?? tileObject ?? null, level: surfaceLevel, elevation },
        levelId,
      )
    )
      return true;
  }

  return false;
}

/**
 * Return the Region documents attached to a Scene in a Collection-safe way.
 *
 * @param {foundry.documents.Scene|null|undefined} scene
 * @returns {foundry.documents.Region[]}
 * @private
 */
function _fxmSceneRegionDocuments(scene) {
  const regions = scene?.regions ?? null;
  if (!regions) return [];
  if (Array.isArray(regions?.contents)) return regions.contents.filter(Boolean);
  if (Array.isArray(regions)) return regions.filter(Boolean);
  if (typeof regions?.toArray === "function") return regions.toArray().filter(Boolean);
  if (typeof regions?.values === "function") return Array.from(regions.values()).filter(Boolean);
  try {
    return Array.from(regions).filter(Boolean);
  } catch (_err) {
    return [];
  }
}

/**
 * Build a lightweight Region placeable adapter for Region documents whose live PlaceableObject is not currently materialized by the canvas Level view.
 *
 * The FXMaster region mask/effect code only needs `id` and `document`; live canvas Region placeables are still preferred whenever Foundry exposes them.
 *
 * @param {foundry.documents.Region|null|undefined} document
 * @returns {{id:string, document: foundry.documents.Region, _fxmDocumentRegionAdapter: true}|null}
 * @private
 */
function _fxmRegionDocumentAdapter(document) {
  const id = fxmDocumentId(document) || null;
  if (!id) return null;
  return { id, document, _fxmDocumentRegionAdapter: true };
}

/**
 * Resolve a Region document to a live placeable when possible, otherwise to a lightweight adapter that can still be used for document-shape masks.
 *
 * @param {foundry.documents.Region|null|undefined} document
 * @returns {PlaceableObject|{id:string, document: foundry.documents.Region, _fxmDocumentRegionAdapter: true}|null}
 */
export function getRegionPlaceableOrDocumentAdapter(document) {
  if (!document) return null;
  const live = document?.object ?? canvas?.regions?.get?.(fxmDocumentId(document)) ?? null;
  if (live) return live;
  return _fxmRegionDocumentAdapter(document);
}

/**
 * Return whether a Region document is assigned only to non-current upper Levels that can still contribute visible/hoverable overlay surfaces in this view.
 *
 * @param {foundry.documents.Region|null|undefined} document
 * @param {foundry.documents.Scene|null|undefined} scene
 * @returns {boolean}
 * @private
 */
function _fxmRegionTargetsNonCurrentVisibleUpperLevel(document, scene) {
  if (!document || !canvas?.level) return false;

  const currentLevel = getCanvasLevel();
  if (!currentLevel?.id) return false;

  const assigned = getDocumentAssignedLevelIds(document, scene ?? document?.parent ?? canvas?.scene ?? null);
  if (!(assigned?.size > 0)) return false;
  if (assigned.has(currentLevel.id)) return false;

  const levels = getSceneLevels(scene ?? document?.parent ?? canvas?.scene ?? null);
  for (const levelId of assigned) {
    const level = levels.find((candidate) => candidate?.id === levelId);
    if (!level) continue;
    if (_fxmLevelIsAbove(level, currentLevel)) return true;
  }

  return false;
}

/**
 * Return whether a Region document is assigned to the currently viewed native Scene Level, or has no explicit native Level assignment. Unassigned Regions keep the pre-Level behavior and are treated as current-view effects.
 *
 * @param {foundry.documents.Region|null|undefined} document
 * @returns {boolean}
 */
export function regionDocumentTargetsCurrentCanvasLevel(document) {
  if (!document || !canvas?.level) return true;

  const currentLevel = getCanvasLevel();
  if (!currentLevel?.id) return true;

  const assigned = getDocumentAssignedLevelIds(document, document?.parent ?? canvas?.scene ?? null);
  if (assigned?.size) return assigned.has(currentLevel.id);

  return true;
}

/**
 * Return whether a Region document should contribute visual FXMaster Region behaviors in the current native Level view. The current Level is always allowed; non-current overhead Levels are allowed only by the world setting.
 *
 * @param {foundry.documents.Region|null|undefined} document
 * @param {foundry.documents.Scene|null|undefined} scene
 * @returns {boolean}
 */
export function regionDocumentCanApplyInCurrentView(document, scene = canvas?.scene ?? null) {
  if (!document || !canvas?.level) return true;
  if (regionDocumentTargetsCurrentCanvasLevel(document)) return true;
  if (!applyRegionBehaviorsToOverheadLevels()) return false;
  return _fxmRegionTargetsNonCurrentVisibleUpperLevel(document, scene ?? document?.parent ?? canvas?.scene ?? null);
}

/**
 * Return live Region placeables plus document adapters for Regions assigned to non-current upper Levels that are still visible/hoverable in the active native Level view.
 *
 * Foundry V14 may not materialize a Region placeable for a Region assigned only to an upper Level while the viewed Level is lower. FXMaster still needs those Region definitions so their particles, filters, and suppression can affect the visible upper-Level overlay surface.
 *
 * @param {foundry.documents.Scene|null|undefined} [scene=canvas?.scene ?? null]
 * @returns {Array<PlaceableObject|{id:string, document: foundry.documents.Region, _fxmDocumentRegionAdapter: true}>}
 */
export function getRegionEffectPlaceablesForCurrentView(scene = canvas?.scene ?? null) {
  const out = [];
  const seen = new Set();

  const push = (placeable) => {
    const id = fxmDocumentId(placeable) || fxmDocumentId(placeable?.document) || null;
    if (!id || seen.has(id)) return;
    if (!regionDocumentCanApplyInCurrentView(placeable?.document ?? null, scene)) return;
    seen.add(id);
    out.push(placeable);
  };

  for (const placeable of canvas?.regions?.placeables ?? []) push(placeable);

  if (!scene || !canvas?.level) return out;

  for (const document of _fxmSceneRegionDocuments(scene)) {
    const id = fxmDocumentId(document) || null;
    if (!id || seen.has(id)) continue;
    if (!regionDocumentCanApplyInCurrentView(document, scene)) continue;
    const adapter = getRegionPlaceableOrDocumentAdapter(document);
    if (adapter) push(adapter);
  }

  return out;
}

/**
 * Resolve the scene foreground threshold without touching deprecated Scene#foregroundElevation accessors.
 *
 * Foundry V14+ replaces the foreground elevation concept with the currently viewed Level document. For scenes without native Levels, the source foreground elevation is read directly from document source data to avoid compatibility warnings.
 *
 * @param {foundry.documents.Scene|null|undefined} [scene]
 * @returns {number}
 */
export function getSceneForegroundElevation(scene = canvas?.scene ?? null) {
  const activeLevelTop = Number(getCanvasLevel()?.elevation?.top ?? Number.NaN);
  if (Number.isFinite(activeLevelTop)) return activeLevelTop;

  const firstLevelTop = Number(scene?.firstLevel?.elevation?.top ?? Number.NaN);
  if (Number.isFinite(firstLevelTop)) return firstLevelTop;

  const foundryGeneration = Number(
    globalThis.game?.release?.generation ?? String(globalThis.game?.version ?? "").split(".")[0],
  );
  if (!Number.isFinite(foundryGeneration) || foundryGeneration < 14) {
    const legacyValue = Number(scene?.foregroundElevation ?? Number.NaN);
    if (Number.isFinite(legacyValue)) return legacyValue;
  }

  const snapshotValue = Number(fxmReadDocumentSnapshotValue(scene, "foregroundElevation") ?? Number.NaN);
  if (Number.isFinite(snapshotValue)) return snapshotValue;

  return Number.NaN;
}

/**
 * Return the configured occlusion modes for a tile or tile document without touching deprecated accessors.
 *
 * @param {Tile|foundry.documents.Tile|null|undefined} tileOrDoc
 * @returns {unknown}
 */
export function getTileOcclusionModes(tileOrDoc) {
  const doc = tileOrDoc?.document ?? tileOrDoc ?? null;
  const modes = doc?.occlusion?.modes;
  if (modes !== undefined) return modes;

  const foundryGeneration = Number(
    globalThis.game?.release?.generation ?? String(globalThis.game?.version ?? "").split(".")[0],
  );
  if (!Number.isFinite(foundryGeneration) || foundryGeneration < 14) {
    const legacyDocMode = doc?.occlusion?.mode ?? tileOrDoc?.occlusion?.mode;
    if (legacyDocMode !== undefined) return legacyDocMode;
  }

  const snapshotMode =
    fxmReadDocumentSnapshotValue(doc, ["occlusion", "mode"]) ??
    fxmReadDocumentSnapshotValue(tileOrDoc, ["occlusion", "mode"]);
  if (snapshotMode !== undefined) return snapshotMode;

  const legacyMode = doc?.occlusionMode ?? tileOrDoc?.occlusionMode;
  if (legacyMode !== undefined) return legacyMode;

  return 0;
}

/**
 * Return whether a tile exposes any active occlusion mode.
 *
 * @param {Tile|foundry.documents.Tile|null|undefined} tileOrDoc
 * @returns {boolean}
 */
export function tileHasActiveOcclusion(tileOrDoc) {
  const modes = getTileOcclusionModes(tileOrDoc);
  const noneMode = CONST?.TILE_OCCLUSION_MODES?.NONE;

  const isActiveMode = (mode) => {
    const n = Number(mode);
    if (!Number.isFinite(n)) return false;
    if (noneMode !== undefined && n === Number(noneMode)) return false;
    return n > 0;
  };

  if (typeof modes === "number") return isActiveMode(modes);
  if (Array.isArray(modes)) return modes.some(isActiveMode);
  if (typeof modes?.has === "function") {
    if (noneMode !== undefined && modes.has(noneMode) && modes.size === 1) return false;
    try {
      for (const mode of modes) if (isActiveMode(mode)) return true;
      return false;
    } catch {
      return false;
    }
  }
  if (modes && typeof modes[Symbol.iterator] === "function") {
    try {
      for (const mode of modes) if (isActiveMode(mode)) return true;
      return false;
    } catch {
      return false;
    }
  }

  return isActiveMode(modes);
}

/**
 * Return whether a tile should be treated as overhead for masking and weather-occlusion logic.
 *
 * @param {Tile|foundry.documents.Tile|null|undefined} tileOrDoc
 * @returns {boolean}
 */
export function isTileOverhead(tileOrDoc) {
  const doc = tileOrDoc?.document ?? tileOrDoc ?? null;
  if (!doc) return false;

  const sourceOverhead =
    fxmReadDocumentSnapshotValue(doc, "overhead") ?? fxmReadDocumentSnapshotValue(tileOrDoc, "overhead");
  if (sourceOverhead !== undefined) return sourceOverhead === true;

  const tileElevation = Number(doc?.elevation ?? tileOrDoc?.elevation ?? Number.NaN);
  const foregroundElevation = getSceneForegroundElevation(doc?.parent ?? canvas?.scene ?? null);
  if (Number.isFinite(tileElevation) && Number.isFinite(foregroundElevation)) {
    return tileElevation >= foregroundElevation;
  }

  return false;
}

/**
 * Build a cached public-field Level texture plan.
 *
 * @param {foundry.documents.Scene|null|undefined} [scene=canvas?.scene ?? null]
 * @returns {object}
 */
export function getSceneLevelTexturePlan(scene = canvas?.scene ?? null) {
  return fxmGetLevelTexturePlan(scene);
}

/** @returns {void} */
export function clearSceneLevelTexturePlanCache() {
  fxmClearLevelTexturePlanCache();
}

/**
 * Return configured public background/foreground image paths for a Level.
 *
 * @param {foundry.documents.Level|null|undefined} level
 * @param {{foregroundOnly?:boolean,scene?:foundry.documents.Scene|null}} [options]
 * @returns {Set<string>}
 */
export function getConfiguredLevelImagePaths(level, options = {}) {
  return fxmGetLevelConfiguredImagePaths(level, options);
}

/**
 * Add configured public background/foreground image paths for a Level.
 *
 * @param {foundry.documents.Level|null|undefined} level
 * @param {Set<string>} output
 * @param {{foregroundOnly?:boolean,scene?:foundry.documents.Scene|null}} [options]
 * @returns {void}
 */
export function addConfiguredLevelImagePaths(level, output, options = {}) {
  if (!(output instanceof Set)) return;
  for (const path of getConfiguredLevelImagePaths(level, options)) output.add(path);
}

/**
 * Resolve Level ids by matching source paths against the cached public-field Level texture plan.
 *
 * @param {Set<string>} sourcePaths
 * @param {{foregroundOnly?:boolean,scene?:foundry.documents.Scene|null}} [options]
 * @returns {Set<string>}
 */
export function getLevelIdsForConfiguredImagePaths(sourcePaths, options = {}) {
  return fxmResolveLevelIdsFromConfiguredSources(sourcePaths, options);
}

/**
 * Normalize a document levels collection into a Set of Level ids.
 *
 * @param {foundry.abstract.Document|null|undefined} document
 * @returns {Set<string>|null}
 */
export function getDocumentLevelsSet(document) {
  const publicIds = fxmGetDocumentLevelIds(document);
  if (publicIds?.size) return publicIds;

  const raw = document?.levels ?? fxmReadDocumentSnapshotValue(document, "levels") ?? null;
  if (!raw) return null;
  if (raw instanceof Set) return raw;
  if (Array.isArray(raw)) return new Set(raw.filter((id) => typeof id === "string" && id.length));
  if (typeof raw[Symbol.iterator] === "function") {
    try {
      return new Set(Array.from(raw).filter((id) => typeof id === "string" && id.length));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Return whether a document is included in a specific native Level, preferring Foundry's public document ownership API when available.
 *
 * @param {foundry.abstract.Document|null|undefined} document
 * @param {foundry.documents.Level|null|undefined} level
 * @returns {boolean|null}
 */
export function documentIncludedInLevel(document, level) {
  return fxmDocumentIncludedInLevel(document, level);
}

/**
 * Resolve Level ids using Foundry's public document ownership method.
 *
 * @param {foundry.abstract.Document|null|undefined} document
 * @param {foundry.documents.Scene|null|undefined} [scene=canvas?.scene ?? null]
 * @returns {Set<string>|null}
 * @private
 */
function getDocumentIncludedLevelIds(document, scene = canvas?.scene ?? null) {
  const ids = new Set();
  let sawAnswer = false;
  const levels = getSceneLevels(scene ?? document?.parent ?? canvas?.scene ?? null);
  for (const level of levels) {
    const levelId = fxmDocumentId(level).trim();
    if (!levelId) continue;
    const included = documentIncludedInLevel(document, level);
    if (included !== null) sawAnswer = true;
    if (included === true) ids.add(levelId);
  }
  if (!ids.size) return sawAnswer ? new Set() : null;
  return ids.size < levels.length ? ids : null;
}

/**
 * Public wrapper for Foundry Scene#getSurfaces. This is intended for Region-defined surfaces; Level artwork pixels still use FXMaster masks.
 *
 * @param {foundry.documents.Scene|null|undefined} [scene=canvas?.scene ?? null]
 * @param {object} [options={}]
 * @returns {Array}
 */
export function getSceneSurfaces(scene = canvas?.scene ?? null, options = {}) {
  return fxmGetSceneSurfaces(scene, options);
}

/**
 * Return whether the scene has public Region-defined surfaces matching options.
 *
 * @param {foundry.documents.Scene|null|undefined} [scene=canvas?.scene ?? null]
 * @param {object} [options={}]
 * @returns {boolean}
 */
export function sceneHasSurfaces(scene = canvas?.scene ?? null, options = {}) {
  return fxmSceneHasSurfaces(scene, options);
}

/**
 * Return Region documents attached to a Scene in a Collection-safe way.
 *
 * @param {foundry.documents.Scene|null|undefined} [scene=canvas?.scene ?? null]
 * @returns {foundry.documents.Region[]}
 */
export function getSceneRegionDocuments(scene = canvas?.scene ?? null) {
  return _fxmSceneRegionDocuments(scene);
}

/**
 * Resolve a Region document by id across live canvas placeables and Scene embedded Region collections. Foundry versions expose embedded collections through slightly different helpers, so Region-level gates should not rely on only Collection#get.
 *
 * @param {string|null|undefined} regionId
 * @param {foundry.documents.Scene|null|undefined} [scene=canvas?.scene ?? null]
 * @returns {foundry.documents.Region|null}
 */
export function getSceneRegionDocumentById(regionId, scene = canvas?.scene ?? null) {
  const id = String(regionId ?? "").trim();
  if (!id) return null;

  try {
    const live = canvas?.regions?.get?.(id) ?? null;
    if (live?.document) return live.document;
  } catch (_err) {
    /** Canvas Regions may be unavailable during setup/teardown. */
  }

  const collection = scene?.regions ?? null;
  try {
    const direct = collection?.get?.(id) ?? null;
    if (direct) return direct?.document ?? direct;
  } catch (_err) {
    /** Some collection-like accessors do not implement get(id). */
  }

  for (const document of _fxmSceneRegionDocuments(scene)) {
    if (fxmDocumentId(document) === id) return document;
  }

  return null;
}

/**
 * Return native Scene Level ids that a document effectively targets. Explicit Level assignments are preferred; when Foundry stores Region assignment as an elevation window instead of a levels array, infer the matching Level ids from that window. A null result means the document is not level-limited.
 *
 * @param {foundry.abstract.Document|null|undefined} document
 * @param {foundry.documents.Scene|null|undefined} [scene=canvas?.scene ?? null]
 * @returns {Set<string>|null}
 */
export function getDocumentAssignedLevelIds(document, scene = canvas?.scene ?? null) {
  const explicit = getDocumentLevelsSet(document);
  if (explicit?.size) return explicit;

  const included = getDocumentIncludedLevelIds(document, scene);
  if (included?.size) return included;

  const window = getDocumentElevationWindow(document);
  if (!window) return null;

  const ids = new Set();
  for (const level of getSceneLevels(scene ?? document?.parent ?? canvas?.scene ?? null)) {
    const levelId = fxmDocumentId(level).trim();
    if (!levelId) continue;

    const bottom = _fxmLevelBottom(level);
    const top = _fxmLevelTop(level);
    const windowMin = Number.isFinite(Number(window.min)) ? Number(window.min) : Number.NEGATIVE_INFINITY;
    const windowMax = Number.isFinite(Number(window.max)) ? Number(window.max) : Number.POSITIVE_INFINITY;
    const levelMin = Number.isFinite(bottom) ? bottom : Number.NEGATIVE_INFINITY;
    const levelMax = Number.isFinite(top) ? top : Number.POSITIVE_INFINITY;
    const overlapMin = Math.max(windowMin, levelMin);
    const overlapMax = Math.min(windowMax, levelMax);
    if (overlapMax - overlapMin > 1e-4) ids.add(levelId);
  }

  if (!ids.size) {
    const inferredElevation = Number.isFinite(Number(window.min))
      ? Number(window.min)
      : Number.isFinite(Number(window.max))
      ? Number(window.max)
      : Number.NaN;
    const inferred = inferVisibleLevelForDocument(document, inferredElevation);
    if (inferred?.id) ids.add(inferred.id);
  }

  return ids.size ? ids : null;
}

/**
 * Infer the visible Level document for a given embedded document elevation.
 *
 * @param {foundry.abstract.Document|null|undefined} document
 * @param {number} elevation
 * @returns {foundry.documents.Level|null}
 */
export function inferVisibleLevelForDocument(document, elevation) {
  const infer = canvas?.inferLevelFromElevation;
  const levelElevation = Number(elevation ?? document?.elevation ?? document?.parent?.elevation ?? Number.NaN);
  if (typeof infer !== "function" || !Number.isFinite(levelElevation)) return null;

  const levels = getDocumentLevelsSet(document);
  const options = levels?.size ? { levels } : undefined;
  try {
    return infer.call(canvas, levelElevation, options) ?? null;
  } catch {
    return null;
  }
}

/**
 * Return whether a document belongs to the currently viewed canvas level.
 *
 * When native Levels are inactive, this always returns true.
 *
 * @param {foundry.abstract.Document|null|undefined} document
 * @param {number} [elevation]
 * @returns {boolean}
 */
export function isDocumentOnCurrentCanvasLevel(document, elevation) {
  const currentLevel = getCanvasLevel();
  if (!currentLevel) return true;

  const included = documentIncludedInLevel(document, currentLevel);
  if (included !== null) return included;

  const levels = getDocumentLevelsSet(document);
  if (levels?.size) return levels.has(currentLevel.id);

  const inferredLevel = inferVisibleLevelForDocument(document, elevation ?? document?.elevation ?? Number.NaN);
  if (!inferredLevel) return true;
  return inferredLevel.id === currentLevel.id;
}

/** Small epsilon used to place level-scoped FX just inside a level boundary. */
const OCCLUSION_EPSILON = 1e-4;

/**
 * Return a normalized elevation window for a document or level-like source.
 *
 * Supports both modern `{bottom, top}` ranges and legacy scalar elevations.
 *
 * @param {foundry.abstract.Document|object|null|undefined} document
 * @returns {{min:number,max:number}|null}
 */
function getDocumentElevationWindow(document) {
  const publicWindow = fxmGetDocumentElevationWindow(document);
  if (publicWindow) return publicWindow;

  const sourceElevation = document?.elevation ?? fxmReadDocumentSnapshotValue(document, "elevation") ?? null;
  const scalarElevation = Number(sourceElevation);
  if (Number.isFinite(scalarElevation)) return { min: scalarElevation, max: scalarElevation };

  const bottom = sourceElevation?.bottom ?? fxmReadDocumentSnapshotValue(document, ["elevation", "bottom"]);
  const top = sourceElevation?.top ?? fxmReadDocumentSnapshotValue(document, ["elevation", "top"]);
  const hasBottom = bottom !== undefined && bottom !== null && String(bottom).trim() !== "";
  const hasTop = top !== undefined && top !== null && String(top).trim() !== "";
  if (!hasBottom && !hasTop) return null;

  return {
    min: hasBottom ? Number(bottom) : Number.NEGATIVE_INFINITY,
    max: hasTop ? Number(top) : Number.POSITIVE_INFINITY,
  };
}

/**
 * Resolve a scalar occlusion elevation from an elevation window.
 *
 * Region and level-scoped FX should sit just inside the top of their own level so upper levels can occlude them while same-level content does not incorrectly behave as a roof.
 *
 * @param {{min:number,max:number}|null|undefined} window
 * @returns {number|null}
 */
function resolveOcclusionElevationFromWindow(window) {
  if (!window) return null;

  const min = Number(window.min);
  const max = Number(window.max);

  if (Number.isFinite(min) && Number.isFinite(max)) {
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    if (Math.abs(hi - lo) <= OCCLUSION_EPSILON) return hi;
    const nearTop = hi - OCCLUSION_EPSILON;
    return nearTop > lo ? nearTop : lo + (hi - lo) * 0.5;
  }

  if (Number.isFinite(max)) return max - OCCLUSION_EPSILON;
  if (Number.isFinite(min)) return min + OCCLUSION_EPSILON;
  return null;
}

/**
 * Normalize the scene's level collection into an array.
 *
 * Foundry V14 can expose native scene Levels through several accessors depending on canvas state and document preparation. This helper treats every accessor as a source of Level documents, while de-duplicating by id.
 *
 * @param {Scene|null|undefined} scene
 * @returns {foundry.documents.Level[]}
 */
export function getSceneLevels(scene) {
  const publicLevels = fxmGetSceneLevelsPublic(scene);
  if (publicLevels.length) return publicLevels;

  const levels = [];
  const seen = new Set();

  const push = (level) => {
    if (!level) return;
    const id = fxmDocumentId(level).trim();
    const looksLikeLevel =
      !!id || "elevation" in Object(level) || "isView" in Object(level) || "isVisible" in Object(level);
    if (!looksLikeLevel) return;
    const key = id || level;
    if (seen.has(key)) return;
    seen.add(key);
    levels.push(level);
  };

  const pushAll = (value) => {
    if (!value) return;
    if (Array.isArray(value)) return value.forEach(push);
    if (typeof value?.toArray === "function") return value.toArray().forEach(push);
    if (typeof value?.values === "function") return Array.from(value.values()).forEach(push);
    try {
      return Array.from(value).forEach(push);
    } catch (_err) {
      push(value);
    }
  };

  pushAll(scene?.levels?.contents ?? scene?.levels ?? null);

  try {
    pushAll(scene?.getEmbeddedCollection?.("Level"));
  } catch (_err) {
    /** Older Foundry versions do not expose Level as an embedded document collection. */
  }

  try {
    push(scene?.initialLevel);
  } catch (_err) {
    /** Older Foundry versions do not expose this accessor. */
  }

  try {
    push(scene?.firstLevel);
  } catch (_err) {
    /** Older Foundry versions do not expose this accessor. */
  }

  try {
    if (!scene?.id || canvas?.scene?.id === scene.id) push(canvas?.level);
  } catch (_err) {
    /** The canvas may not be ready while flags are being prepared. */
  }

  try {
    pushAll(scene?.availableLevels);
  } catch (_err) {
    /** Available levels are a useful V14 fallback, but may depend on user/canvas state. */
  }

  return levels;
}

function getSceneLevelIds(scene = canvas?.scene ?? null) {
  const ids = getSceneLevels(scene)
    .map((level) => fxmDocumentId(level).trim())
    .filter(Boolean);
  return Array.from(new Set(ids));
}

/**
 * Return the implicit native Level id for scenes that contain exactly one Level.
 *
 * Single-level scenes do not need an explicit stored level selector: an empty selector already means "all levels", which maps to the scene's current native level in Foundry V14. This helper is retained for compatibility with older imports but intentionally returns an empty selection.
 *
 * @param {Scene|null|undefined} [_scene=canvas?.scene ?? null]
 * @returns {string[]}
 */
export function resolveSingleSceneLevelSelection(_scene = canvas?.scene ?? null) {
  return [];
}

/**
 * Normalize an effect option bag's Level selection.
 *
 * Empty selections mean "all levels". A single-level scene also behaves as all levels, so redundant Level ids are not stored; the native V14 compositor can treat that redundant mask path differently from the no-selection path.
 *
 * This mutates and returns the provided options object.
 *
 * @param {object|null|undefined} options
 * @param {Scene|null|undefined} [scene=canvas?.scene ?? null]
 * @returns {object}
 */
export function normalizeSceneLevelSelection(options = {}, scene = canvas?.scene ?? null) {
  const out = options && typeof options === "object" ? options : {};
  const sceneLevelIds = getSceneLevelIds(scene);

  if (out.levels == null || out.levels === "" || out.levels === ALL_LEVELS_SELECTION) {
    delete out.levels;
    return out;
  }

  const selected = getSelectedSceneLevelIds(out.levels, scene);
  if (
    !selected?.size ||
    sceneLevelIds.length === 1 ||
    (sceneLevelIds.length > 1 && selected.size >= sceneLevelIds.length)
  ) {
    delete out.levels;
    return out;
  }

  out.levels = Array.from(selected);
  return out;
}

/**
 * Backwards-compatible name for Level selection normalization.
 *
 * @param {object|null|undefined} options
 * @param {Scene|null|undefined} [scene=canvas?.scene ?? null]
 * @returns {object}
 */
export function ensureSingleSceneLevelSelection(options = {}, scene = canvas?.scene ?? null) {
  return normalizeSceneLevelSelection(options, scene);
}

/**
 * Normalize a scene-effect level selection into a Set of selected Level ids.
 *
 * Empty selections mean "all levels" and therefore return null.
 *
 * @param {*} value
 * @param {Scene|null|undefined} [scene=canvas?.scene ?? null]
 * @returns {Set<string>|null}
 */
export function getSelectedSceneLevelIds(value, scene = canvas?.scene ?? null) {
  const raw =
    value instanceof Set
      ? Array.from(value)
      : Array.isArray(value)
      ? value
      : value == null || value === ""
      ? []
      : [value];
  const ids = raw.map(String).filter((id) => id.length && id !== ALL_LEVELS_SELECTION);
  if (!ids.length) return null;

  const sceneLevelIds = new Set(getSceneLevelIds(scene));
  if (sceneLevelIds.size <= 1) return null;

  const filtered = ids.filter((id) => sceneLevelIds.has(id));
  return filtered.length ? new Set(filtered) : null;
}

/**
 * Return whether a scene-scoped effect should be active on the currently viewed canvas level.
 *
 * Effects with no explicit level selection apply to all levels. If native scene levels are inactive (or no current level is available yet), the effect remains active.
 *
 * @param {object|null|undefined} options
 * @param {Scene|null|undefined} [scene=canvas?.scene ?? null]
 * @returns {boolean}
 */
export function isEffectActiveForCurrentCanvasLevel(options, scene = canvas?.scene ?? null) {
  const selectedLevels = getSelectedSceneLevelIds(options?.levels, scene);
  if (!selectedLevels?.size) return true;

  const sceneLevelIds = getSceneLevelIds(scene);
  if (sceneLevelIds.length === 1) return true;

  const currentLevel = getCanvasLevel();
  if (!currentLevel?.id) return true;
  return selectedLevels.has(currentLevel.id);
}

/**
 * Return whether a native Scene Level should keep a Level-limited scene effect alive in the current view.
 *
 * Foundry V14 can leave both lower and upper Level documents visible at once. A scene particle assigned to a non-current Level still needs its runtime whenever that Level contributes visible canvas surfaces; the stack compositor clips the rendered output back to the selected surface masks and restores any unselected visible Levels in draw order.
 *
 * @param {foundry.documents.Level|null|undefined} level
 * @param {foundry.documents.Level|null|undefined} currentLevel
 * @returns {boolean}
 */
function isSceneLevelVisibleOverlayForCurrentView(level, currentLevel) {
  if (!level) return false;
  if (level.id && currentLevel?.id && level.id === currentLevel.id) return true;
  if (level.isVisible || level.isView) return true;
  return _fxmLevelHasLiveVisibleCanvasSurface(level);
}

export function isEffectActiveForCurrentOrVisibleCanvasLevel(options, scene = canvas?.scene ?? null) {
  const selectedLevels = getSelectedSceneLevelIds(options?.levels, scene);
  if (!selectedLevels?.size) return true;

  const sceneLevelIds = getSceneLevelIds(scene);
  if (sceneLevelIds.length <= 1) return true;

  const currentLevel = getCanvasLevel();
  if (!currentLevel?.id) return true;
  if (selectedLevels.has(currentLevel.id)) return true;

  for (const level of getSceneLevels(scene)) {
    if (!level?.id || !selectedLevels.has(level.id)) continue;
    if (isSceneLevelVisibleOverlayForCurrentView(level, currentLevel)) return true;
  }

  return false;
}

/**
 * Resolve the elevation at which a document-scoped FX row should participate in occlusion.
 *
 * Scene-scoped weather-like FX intentionally live at the layer fallback elevation (usually `Infinity`). Region-scoped FX, however, need to sit within their assigned level so upper native scene levels can continue to cover them.
 *
 * @param {foundry.abstract.Document|null|undefined} document
 * @param {{ fallback?: number, preferForeground?: boolean }} [options]
 * @returns {number}
 */
export function resolveDocumentOcclusionElevation(document, { fallback = Infinity, preferForeground = false } = {}) {
  const scene = document?.parent ?? canvas?.scene ?? null;

  let elevation = resolveOcclusionElevationFromWindow(getDocumentElevationWindow(document));

  if (!Number.isFinite(elevation)) {
    const currentLevel = getCanvasLevel();
    const levels = getDocumentLevelsSet(document);
    let levelDoc = null;

    if (levels?.size) {
      if (currentLevel?.id && levels.has(currentLevel.id)) levelDoc = currentLevel;
      if (!levelDoc) {
        for (const candidate of getSceneLevels(scene)) {
          if (!candidate?.id || !levels.has(candidate.id)) continue;
          levelDoc = candidate;
          break;
        }
      }
    }

    if (!levelDoc && document) {
      const representativeElevation = Number(
        document?.elevation?.top ??
          fxmReadDocumentSnapshotValue(document, ["elevation", "top"]) ??
          document?.elevation?.bottom ??
          fxmReadDocumentSnapshotValue(document, ["elevation", "bottom"]) ??
          document?.elevation ??
          fxmReadDocumentSnapshotValue(document, "elevation") ??
          Number.NaN,
      );
      levelDoc = inferVisibleLevelForDocument(document, representativeElevation) ?? null;
    }

    elevation = resolveOcclusionElevationFromWindow(getDocumentElevationWindow(levelDoc));
  }

  const finiteFallback = Number(fallback);
  if (!Number.isFinite(elevation)) elevation = finiteFallback;

  if (preferForeground) {
    const foregroundElevation = Number(getSceneForegroundElevation(scene));
    if (Number.isFinite(foregroundElevation)) {
      const foregroundBound = foregroundElevation - OCCLUSION_EPSILON;
      return Number.isFinite(elevation) ? Math.min(elevation, foregroundBound) : foregroundBound;
    }
  }

  return Number.isFinite(elevation) ? elevation : Infinity;
}

/**
 * Return whether two elevations should be treated as the same surface.
 *
 * @param {number} a
 * @param {number} b
 * @returns {boolean}
 * @private
 */
function sameSurfaceElevation(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= 0.01;
}

/**
 * Return Foundry's active primary hover-fade elevation without triggering the deprecated V14 PrimaryCanvasGroup#hoverFadeElevation compatibility path. V14 returns the current Level base elevation from that getter, so this helper reads the same public Level value directly.
 *
 * @returns {number}
 */
export function getCanvasPrimaryHoverFadeElevation() {
  const primary = canvas?.primary ?? null;
  if (!primary) return Number.NaN;

  const releaseGeneration = Number(globalThis.game?.release?.generation ?? 0);
  if (releaseGeneration >= 14) {
    const base = Number(
      canvas?.level?.elevation?.base ?? canvas?.level?.elevation?.bottom ?? canvas?.level?.bottom ?? 0,
    );
    return Number.isFinite(base) ? base : Number.NaN;
  }

  const hoverFade = fxmGetPublicHoverFadeState(primary);
  const hoverFadeLevel = primary.hoverFadeLevel ?? primary.hoverFade?.level ?? null;
  const candidates = [
    primary.hoverFadeElevation,
    hoverFade?.elevation,
    primary.hoverFade?.elevation,
    primary.hoverFadeState?.elevation,
    hoverFadeLevel?.elevation?.bottom,
    hoverFadeLevel?.bottom,
  ];

  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value)) return value;
  }

  return Number.NaN;
}

/**
 * Return the token center point used for live surface reveal checks.
 *
 * @param {Token|null|undefined} token
 * @returns {PIXI.Point|{x:number, y:number}|null}
 * @private
 */
function getTokenCenterPointForLevelSurfaceReveal(token) {
  const boundsCenter = token?.bounds?.center ?? null;
  if (Number.isFinite(boundsCenter?.x) && Number.isFinite(boundsCenter?.y)) return boundsCenter;

  const tokenCenter = token?.center ?? null;
  if (Number.isFinite(tokenCenter?.x) && Number.isFinite(tokenCenter?.y)) return tokenCenter;

  return null;
}

/**
 * Resolve a Tile placeable from a live primary-canvas surface candidate.
 *
 * @param {unknown} candidate
 * @returns {Tile|null}
 * @private
 */
function resolveTilePlaceableFromLevelSurfaceCandidate(candidate) {
  if (!candidate) return null;

  if (candidate?.constructor?.name === "Tile") return candidate;

  const linked = fxmLinkedPlaceableFromDisplayObject(candidate);
  if (linked?.constructor?.name === "Tile") return linked;

  const directDocName = candidate?.constructor?.documentName ?? candidate?.documentName ?? null;
  if (directDocName === "Tile") return candidate;

  const linkedDocName = linked?.constructor?.documentName ?? linked?.documentName ?? null;
  if (linkedDocName === "Tile") return linked;

  return null;
}

/**
 * Return whether a live native-level surface should use simple mouse-hit hover detection. Full-scene Level texture meshes contain almost every mouse point, so hit-testing them directly makes all upper level images look permanently revealed. Placeable tiles can still use direct hit-tests, while level images need an explicit V14 hover/fade signal.
 *
 * @param {object|null|undefined} linkedObject
 * @param {foundry.abstract.Document|null|undefined} document
 * @param {object|null|undefined} hoverFadeState
 * @returns {boolean}
 * @private
 */
function liveLevelSurfaceAllowsMouseHoverReveal(linkedObject, document, hoverFadeState) {
  void hoverFadeState;
  if (resolveTilePlaceableFromLevelSurfaceCandidate(linkedObject)) return true;
  if (document?.constructor?.documentName === "Tile" || document?.documentName === "Tile") return true;

  /**
   * Non-tile level images are handled by the stricter hoverFadeElevation path in getCanvasLiveLevelSurfaceRevealState.
   */
  return false;
}

/**
 * Return whether a live surface contains a specific canvas point.
 *
 * @param {PIXI.DisplayObject|null|undefined} mesh
 * @param {{x:number, y:number}|PIXI.Point|null|undefined} point
 * @param {{ useTextureThreshold?: boolean }} [options]
 * @returns {boolean}
 * @private
 */
function liveSurfaceContainsPoint(mesh, point, { useTextureThreshold = false } = {}) {
  if (!mesh || mesh.destroyed || mesh.visible === false || mesh.renderable === false) return false;
  if (!point || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return false;

  const baseThreshold = Number(mesh?.textureAlphaThreshold ?? 0) || 0;
  const threshold = useTextureThreshold ? Math.max(baseThreshold, 0.05) : baseThreshold;

  try {
    return !!mesh.containsCanvasPoint?.(point, threshold);
  } catch (err) {
    logger.debug("FXMaster:", err);
    return false;
  }
}

/**
 * Return whether the current mouse position is meaningfully inside a live surface.
 *
 * Edge-triggered native hover checks can report a hit a few pixels before the underlying surface is visibly revealed. Sampling a small cross of nearby points delays reveal handling until the cursor is actually within the surface area.
 *
 * @param {PIXI.DisplayObject|null|undefined} mesh
 * @param {{ useTextureThreshold?: boolean, inset?: number, requiredHits?: number }} [options]
 * @returns {boolean}
 * @private
 */
function liveSurfaceContainsRevealMousePoint(
  mesh,
  { useTextureThreshold = false, inset = 2.5, requiredHits = 3 } = {},
) {
  if (!mesh || mesh.destroyed || mesh.visible === false || mesh.renderable === false) return false;

  const mousePosition = canvas?.mousePosition ?? null;
  if (!mousePosition) return false;

  const samplePoints = [
    mousePosition,
    { x: mousePosition.x + inset, y: mousePosition.y },
    { x: mousePosition.x - inset, y: mousePosition.y },
    { x: mousePosition.x, y: mousePosition.y + inset },
    { x: mousePosition.x, y: mousePosition.y - inset },
  ];

  let hits = 0;
  for (const point of samplePoints) {
    if (!liveSurfaceContainsPoint(mesh, point, { useTextureThreshold })) continue;
    hits += 1;
  }

  return hits >= requiredHits;
}

/**
 * Return whether the mouse position falls within a live surface's world-space bounds.
 *
 * Cached native-Level textures do not always expose a reliable `containsCanvasPoint` reveal hit test during hover-fade. A bounds fallback anchored to the hovered surface elevation keeps suppression refresh in sync with the actual roof reveal state.
 *
 * @param {PIXI.DisplayObject|null|undefined} mesh
 * @param {{ inset?: number }} [options]
 * @returns {boolean}
 * @private
 */
function liveSurfaceBoundsContainMousePoint(mesh, { inset = 2.5 } = {}) {
  if (!mesh || mesh.destroyed || mesh.visible === false || mesh.renderable === false) return false;

  const mousePosition = canvas?.mousePosition ?? null;
  if (!mousePosition) return false;

  try {
    const bounds = mesh.getBounds?.(false);
    if (!bounds) return false;
    return (
      mousePosition.x >= bounds.x - inset &&
      mousePosition.x <= bounds.x + bounds.width + inset &&
      mousePosition.y >= bounds.y - inset &&
      mousePosition.y <= bounds.y + bounds.height + inset
    );
  } catch (err) {
    logger.debug("FXMaster:", err);
    return false;
  }
}

/**
 * Return whether a controlled token should explicitly reveal a live upper-Level surface.
 *
 * @param {PIXI.DisplayObject|null|undefined} mesh
 * @param {{ tileObject?: Tile|null, elevation?: number }} [options]
 * @returns {boolean}
 * @private
 */
function liveSurfaceIsExplicitlyRevealedByControlledToken(mesh, { tileObject = null, elevation = Number.NaN } = {}) {
  if (!mesh || mesh.destroyed || mesh.visible === false || mesh.renderable === false) return false;

  const surfaceElevation = Number.isFinite(Number(elevation))
    ? Number(elevation)
    : Number(mesh?.elevation ?? tileObject?.document?.elevation ?? tileObject?.elevation ?? Number.NaN);

  for (const token of canvas?.tokens?.controlled ?? []) {
    if (!token || token.destroyed || token?.document?.hidden) continue;

    const tokenCenter = getTokenCenterPointForLevelSurfaceReveal(token);
    if (!tokenCenter) continue;

    const tokenElevation = Number(token?.elevation ?? token?.document?.elevation ?? Number.NaN);
    if (Number.isFinite(surfaceElevation) && Number.isFinite(tokenElevation)) {
      if (surfaceElevation < tokenElevation || sameSurfaceElevation(surfaceElevation, tokenElevation)) continue;
    }

    if (!liveSurfaceContainsPoint(mesh, tokenCenter, { useTextureThreshold: !!tileObject })) continue;
    return true;
  }

  return false;
}

/**
 * Inspect whether a live native-Level surface should currently be treated as revealed.
 *
 * Hover-revealed surfaces need to stop participating in suppression-preservation even before every live PIXI alpha or shader uniform has fully settled. This helper combines direct fade state with geometric hover and controlled-token reveal checks.
 *
 * @param {PIXI.DisplayObject|null|undefined} surface
 * @param {{ mesh?: PIXI.DisplayObject|null, object?: object|null, document?: foundry.abstract.Document|null, level?: object|null, elevation?: number }} [options]
 * @returns {{ revealed: boolean, hovered: boolean, explicit: boolean, faded: boolean, fading: boolean, occluded: boolean, fadeOcclusion: number, alpha: number }}
 */
export function getCanvasLiveLevelSurfaceRevealState(
  surface,
  { mesh = null, object = null, document = null, level = null, elevation = Number.NaN } = {},
) {
  const liveMesh = mesh ?? surface?.mesh ?? surface ?? null;
  if (!liveMesh || liveMesh.destroyed) {
    return {
      revealed: false,
      hovered: false,
      explicit: false,
      faded: false,
      fading: false,
      occluded: false,
      fadeOcclusion: 0,
      alpha: 0,
    };
  }

  const tileObject = object ?? resolveTilePlaceableFromLevelSurfaceCandidate(liveMesh);
  const tileMesh = tileObject?.mesh ?? null;
  const testMeshes = [liveMesh];
  if (tileMesh && tileMesh !== liveMesh && !tileMesh.destroyed) testMeshes.push(tileMesh);

  const surfaceElevation = Number.isFinite(Number(elevation))
    ? Number(elevation)
    : Number(
        liveMesh?.elevation ??
          tileMesh?.elevation ??
          level?.elevation?.bottom ??
          level?.bottom ??
          document?.elevation?.bottom ??
          document?.elevation ??
          tileObject?.document?.elevation?.bottom ??
          tileObject?.document?.elevation ??
          tileObject?.elevation ??
          Number.NaN,
      );
  const hoverFadeState =
    testMeshes.map((candidate) => fxmGetPublicHoverFadeState(candidate)).find((state) => !!state) ??
    tileObject?.hoverFadeState ??
    null;
  const fadeOcclusion = Number(
    liveMesh?.fadeOcclusion ??
      liveMesh?.shader?.uniforms?.fadeOcclusion ??
      tileMesh?.fadeOcclusion ??
      tileMesh?.shader?.uniforms?.fadeOcclusion ??
      hoverFadeState?.occlusion ??
      0,
  );
  const alpha = Number(
    liveMesh?.worldAlpha ??
      liveMesh?.alpha ??
      tileMesh?.worldAlpha ??
      tileMesh?.alpha ??
      tileObject?.alpha ??
      tileObject?.document?.alpha ??
      1,
  );
  const hoverFadeElevation = getCanvasPrimaryHoverFadeElevation();
  const allowMouseHoverReveal = liveLevelSurfaceAllowsMouseHoverReveal(
    tileObject ?? object ?? null,
    document ?? tileObject?.document ?? null,
    hoverFadeState,
  );
  const hoveredByHitTest =
    allowMouseHoverReveal &&
    testMeshes.some((candidate) =>
      liveSurfaceContainsRevealMousePoint(candidate, { useTextureThreshold: candidate === tileMesh || !!tileObject }),
    );
  const hoveredByElevation =
    Number.isFinite(hoverFadeElevation) &&
    Number.isFinite(surfaceElevation) &&
    sameSurfaceElevation(surfaceElevation, hoverFadeElevation) &&
    (hoverFadeState?.hovered === true || !!tileObject) &&
    testMeshes.some((candidate) => liveSurfaceBoundsContainMousePoint(candidate));
  const hoveredByState =
    hoverFadeState?.hovered === true && testMeshes.some((candidate) => liveSurfaceBoundsContainMousePoint(candidate));
  const hovered = hoveredByHitTest || hoveredByElevation || hoveredByState;
  const explicit = testMeshes.some((candidate) =>
    liveSurfaceIsExplicitlyRevealedByControlledToken(candidate, { tileObject, elevation: surfaceElevation }),
  );
  const faded = hoverFadeState?.faded === true;
  const fading = hoverFadeState?.fading === true;
  const occluded =
    testMeshes.some((candidate) => candidate?.occluded === true) ||
    tileObject?.occluded === true ||
    object?.occluded === true ||
    document?.occluded === true ||
    level?.occluded === true;
  const revealed =
    hovered || explicit || faded || occluded || (Number.isFinite(fadeOcclusion) && fadeOcclusion > 0.001);

  return {
    revealed,
    hovered,
    explicit,
    faded,
    fading,
    occluded,
    fadeOcclusion: Number.isFinite(fadeOcclusion) ? fadeOcclusion : 0,
    alpha: Number.isFinite(alpha) ? alpha : 1,
  };
}

/**
 * Flush pending perception and primary surface updates before sampling live native-Level overlays.
 *
 * Suppression masks rely on the currently rendered upper-level surfaces. Hover-fade and controlled-token reveals are driven by live primary state and can lag one frame behind document state unless pending render flags are applied first.
 *
 * @returns {void}
 */
export function syncCanvasLiveLevelSurfaceState() {
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
 * Resolve the live display object and linked placeable/document for a native Level surface.
 *
 * @param {{ mesh?: object|null, object?: object|null }} [surface]
 * @returns {{ mesh: PIXI.DisplayObject|null, linkedObject: object|null }}
 * @private
 */
function resolveLiveLevelSurfaceMembers({ mesh = null, object = null } = {}) {
  const linkedObject = object ?? fxmLinkedPlaceableFromDisplayObject(mesh);
  const linkedMesh = linkedObject?.mesh ?? linkedObject?.primaryMesh ?? linkedObject?.sprite ?? null;
  const displayObject = linkedMesh ?? mesh ?? linkedObject ?? null;
  return { mesh: displayObject, linkedObject };
}

/**
 * Return the center point used for live controlled-token reveal checks.
 *
 * @param {Token|null|undefined} token
 * @returns {{x:number,y:number}|PIXI.Point|null}
 * @private
 */
function getLiveLevelSurfaceTokenCenter(token) {
  const boundsCenter = token?.bounds?.center ?? null;
  if (Number.isFinite(boundsCenter?.x) && Number.isFinite(boundsCenter?.y)) return boundsCenter;

  const tokenCenter = token?.center ?? null;
  if (Number.isFinite(tokenCenter?.x) && Number.isFinite(tokenCenter?.y)) return tokenCenter;
  return null;
}

/**
 * Return whether a live surface contains a canvas point.
 *
 * @param {PIXI.DisplayObject|null|undefined} mesh
 * @param {{x:number,y:number}|PIXI.Point|null|undefined} point
 * @param {{ useTextureThreshold?: boolean }} [options]
 * @returns {boolean}
 * @private
 */
function liveLevelSurfaceContainsPoint(mesh, point, { useTextureThreshold = false } = {}) {
  if (!mesh || mesh.destroyed || mesh.visible === false || mesh.renderable === false) return false;
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return false;
  if (typeof mesh?.containsCanvasPoint !== "function") return false;

  const baseThreshold = Number(mesh?.textureAlphaThreshold ?? 0) || 0;
  const threshold = useTextureThreshold ? Math.max(baseThreshold, 0.05) : baseThreshold;

  try {
    return !!mesh.containsCanvasPoint(point, threshold);
  } catch (err) {
    logger.debug("FXMaster:", err);
    return false;
  }
}

/**
 * Return whether the current mouse position is meaningfully inside a live surface.
 *
 * Edge-triggered hover checks can report a hit before the roof has visibly revealed. A small cross-sample keeps suppression refresh aligned with the actually visible reveal.
 *
 * @param {PIXI.DisplayObject|null|undefined} mesh
 * @param {{ useTextureThreshold?: boolean, inset?: number, requiredHits?: number }} [options]
 * @returns {boolean}
 * @private
 */
function liveLevelSurfaceContainsRevealMousePoint(
  mesh,
  { useTextureThreshold = false, inset = 2.5, requiredHits = 3 } = {},
) {
  const mousePosition = canvas?.mousePosition ?? null;
  if (!mousePosition) return false;

  const samplePoints = [
    mousePosition,
    { x: mousePosition.x + inset, y: mousePosition.y },
    { x: mousePosition.x - inset, y: mousePosition.y },
    { x: mousePosition.x, y: mousePosition.y + inset },
    { x: mousePosition.x, y: mousePosition.y - inset },
  ];

  let hits = 0;
  for (const point of samplePoints) {
    if (!liveLevelSurfaceContainsPoint(mesh, point, { useTextureThreshold })) continue;
    hits += 1;
  }

  return hits >= requiredHits;
}

/**
 * Resolve the live hover-fade state object for a native Level surface.
 *
 * @param {PIXI.DisplayObject|null|undefined} mesh
 * @param {object|null|undefined} linkedObject
 * @returns {object|null}
 * @private
 */
function getLiveLevelSurfaceHoverFadeState(mesh, linkedObject) {
  return fxmGetPublicHoverFadeState(mesh, linkedObject, linkedObject?.mesh);
}

/**
 * Resolve the current fade/occlusion amount for a native Level surface.
 *
 * @param {PIXI.DisplayObject|null|undefined} mesh
 * @param {object|null|undefined} linkedObject
 * @returns {number}
 * @private
 */
function getLiveLevelSurfaceFadeOcclusion(mesh, linkedObject) {
  const hoverFadeState = getLiveLevelSurfaceHoverFadeState(mesh, linkedObject);
  return Number(
    mesh?.fadeOcclusion ??
      mesh?.shader?.uniforms?.fadeOcclusion ??
      linkedObject?.mesh?.fadeOcclusion ??
      linkedObject?.mesh?.shader?.uniforms?.fadeOcclusion ??
      linkedObject?.fadeOcclusion ??
      hoverFadeState?.occlusion ??
      0,
  );
}

/**
 * Resolve the effective elevation for a live native-Level surface.
 *
 * @param {{ mesh?: object|null, object?: object|null, document?: foundry.abstract.Document|null, level?: object|null, elevation?: number }} [surface]
 * @returns {number}
 * @private
 */
function getLiveLevelSurfaceElevation({
  mesh = null,
  object = null,
  document = null,
  level = null,
  elevation = Number.NaN,
} = {}) {
  const linkedObject = object ?? fxmLinkedPlaceableFromDisplayObject(mesh);
  return Number(
    elevation ??
      mesh?.elevation ??
      level?.elevation?.bottom ??
      level?.bottom ??
      document?.elevation?.bottom ??
      document?.elevation ??
      linkedObject?.document?.elevation?.bottom ??
      linkedObject?.document?.elevation ??
      linkedObject?.elevation ??
      Number.NaN,
  );
}

/**
 * Return whether a live upper-Level surface is currently revealed by hover or a controlled token.
 *
 * Native scene-level suppression preserves visible higher-level roofs by restoring their live surfaces on top of lower-level suppression regions. When that roof is hovered or explicitly revealed for a controlled token, the restore pass must stand down so the lower-level suppression can show through immediately.
 *
 * @param {{ mesh?: object|null, object?: object|null, document?: foundry.abstract.Document|null, level?: object|null, elevation?: number }} [surface]
 * @returns {boolean}
 */
export function isLiveLevelSurfaceRevealActive({
  mesh = null,
  object = null,
  document = null,
  level = null,
  elevation = Number.NaN,
} = {}) {
  const { mesh: displayObject, linkedObject } = resolveLiveLevelSurfaceMembers({ mesh, object });
  if (!displayObject || displayObject.destroyed) return false;
  if (displayObject.visible === false || displayObject.renderable === false) return false;

  const hoverFadeState = getLiveLevelSurfaceHoverFadeState(displayObject, linkedObject);
  if (hoverFadeState?.faded) return true;

  const surfaceDocument = linkedObject?.document ?? object?.document ?? document ?? null;
  const allowMouseHoverReveal = liveLevelSurfaceAllowsMouseHoverReveal(linkedObject, surfaceDocument, hoverFadeState);
  const fadeOcclusion = getLiveLevelSurfaceFadeOcclusion(displayObject, linkedObject);
  if (Number.isFinite(fadeOcclusion) && fadeOcclusion > 0) {
    if (allowMouseHoverReveal && liveLevelSurfaceContainsRevealMousePoint(displayObject, { useTextureThreshold: true }))
      return true;
    if (linkedObject?.occluded === true || displayObject?.occluded === true) return true;
  }

  if (allowMouseHoverReveal && liveLevelSurfaceContainsRevealMousePoint(displayObject, { useTextureThreshold: true }))
    return true;

  const surfaceElevation = getLiveLevelSurfaceElevation({
    mesh: displayObject,
    object: linkedObject,
    document: surfaceDocument,
    level: level ?? displayObject?.level ?? linkedObject?.level ?? linkedObject?.document?.level ?? null,
    elevation,
  });
  const surfaceLevelIds = getDocumentLevelsSet(surfaceDocument ?? linkedObject ?? null);

  for (const token of canvas?.tokens?.controlled ?? []) {
    if (!token || token.destroyed || token?.document?.hidden) continue;

    const tokenCenter = getLiveLevelSurfaceTokenCenter(token);
    if (!tokenCenter) continue;
    if (!liveLevelSurfaceContainsPoint(displayObject, tokenCenter, { useTextureThreshold: true })) continue;

    const tokenElevation = Number(token?.elevation ?? token?.document?.elevation ?? Number.NaN);
    if (
      Number.isFinite(surfaceElevation) &&
      Number.isFinite(tokenElevation) &&
      surfaceElevation <= tokenElevation + 0.01
    )
      continue;

    const tokenLevels = getDocumentLevelsSet(token?.document ?? null);
    if (surfaceLevelIds?.size && tokenLevels?.size) {
      let sharesLevel = false;
      for (const levelId of tokenLevels) {
        if (!surfaceLevelIds.has(levelId)) continue;
        sharesLevel = true;
        break;
      }
      if (sharesLevel) continue;
    }

    return true;
  }

  return false;
}

/**
 * Inspect the current live native-Level surface state.
 *
 * In addition to a stable signature string, this reports whether any sampled surface is still in a transient hover-fade state so callers can keep refreshing suppression masks until the fade settles. Hover-driven native Level reveal also follows the live mouse position, so the signature includes the current canvas mouse point while upper visible Levels exist.
 *
 * @param {Scene|null|undefined} [scene=canvas?.scene ?? null]
 * @param {{ presynced?: boolean }} [options]
 * @returns {{ key: string, forceRefresh: boolean }}
 */
export function getCanvasLiveLevelSurfaceState(scene = canvas?.scene ?? null, { presynced = false } = {}) {
  if (!presynced) syncCanvasLiveLevelSurfaceState();

  const parts = [];
  let forceRefresh = false;
  const currentLevel = getCanvasLevel();
  const hoverFadeElevation = getCanvasPrimaryHoverFadeElevation();
  const hoverKey = Number.isFinite(hoverFadeElevation) ? hoverFadeElevation.toFixed(3) : "NaN";
  parts.push(`scene:${scene?.id ?? ""}`);
  parts.push(`current:${currentLevel?.id ?? ""}`);
  parts.push(`hover:${hoverKey}`);

  const currentBottom = Number(currentLevel?.elevation?.bottom ?? currentLevel?.bottom ?? Number.NaN);
  const currentTop = Number(currentLevel?.elevation?.top ?? currentLevel?.top ?? Number.NaN);
  const hasVisibleUpperLevels =
    !!currentLevel &&
    getSceneLevels(scene).some((level) => {
      if (!level?.id || level.id === currentLevel.id) return false;
      if (!(level?.isVisible || level?.isView)) return false;

      const bottom = Number(level?.elevation?.bottom ?? level?.bottom ?? Number.NaN);
      const top = Number(level?.elevation?.top ?? level?.top ?? Number.NaN);

      if (Number.isFinite(bottom) && Number.isFinite(currentBottom)) return bottom > currentBottom + 1e-4;
      if (Number.isFinite(top) && Number.isFinite(currentTop)) return top > currentTop + 1e-4;
      if (Number.isFinite(bottom) && !Number.isFinite(currentBottom)) return true;
      if (!Number.isFinite(bottom) && Number.isFinite(top) && !Number.isFinite(currentTop)) return true;
      return false;
    });

  const mousePosition = canvas?.mousePosition ?? null;
  if (hasVisibleUpperLevels && mousePosition) {
    const mx = Number(mousePosition.x ?? Number.NaN);
    const my = Number(mousePosition.y ?? Number.NaN);
    if (Number.isFinite(mx) && Number.isFinite(my)) {
      parts.push(`mouse:${Math.round(mx)}:${Math.round(my)}`);
    }
  }

  for (const token of canvas?.tokens?.controlled ?? []) {
    if (!token || token.destroyed || token?.document?.hidden) continue;
    const tokenId = token?.id ?? token?.document?.id ?? "";
    if (!tokenId) continue;
    const center = token?.center ?? token?.bounds?.center ?? null;
    const cx = Number(center?.x ?? token?.x ?? 0) || 0;
    const cy = Number(center?.y ?? token?.y ?? 0) || 0;
    const elevation = Number(token?.elevation ?? token?.document?.elevation ?? Number.NaN);
    const elevKey = Number.isFinite(elevation) ? elevation.toFixed(3) : "NaN";
    parts.push(`ctl:${tokenId}:${cx.toFixed(2)}:${cy.toFixed(2)}:${elevKey}`);
  }

  for (const level of getSceneLevels(scene)) {
    const levelId = level?.id ?? "";
    if (!levelId) continue;
    const bottom = Number(level?.elevation?.bottom ?? level?.bottom ?? Number.NaN);
    const top = Number(level?.elevation?.top ?? level?.top ?? Number.NaN);
    const bottomKey = Number.isFinite(bottom) ? bottom.toFixed(3) : "NaN";
    const topKey = Number.isFinite(top) ? top.toFixed(3) : "NaN";
    parts.push(`lvl:${levelId}:${level?.isView ? 1 : 0}:${level?.isVisible ? 1 : 0}:${bottomKey}:${topKey}`);
  }

  for (const [index, mesh] of Array.from(canvas?.primary?.levelTextures ?? []).entries()) {
    if (!mesh) continue;
    const object = mesh?.object ?? null;
    const liveMesh = object?.mesh ?? object?.primaryMesh ?? object?.sprite ?? mesh;
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
    const revealState = getCanvasLiveLevelSurfaceRevealState(liveMesh, {
      mesh: liveMesh,
      object,
      document,
      level,
      elevation,
    });
    const levelId =
      mesh?.level?.id ??
      mesh?.level?.document?.id ??
      mesh?.object?.level?.id ??
      mesh?.object?.document?.level?.id ??
      "";
    const alpha = Number(liveMesh?.worldAlpha ?? liveMesh?.alpha ?? mesh?.worldAlpha ?? mesh?.alpha ?? 1);
    const fadeOcclusion = Number(
      liveMesh?.fadeOcclusion ??
        liveMesh?.shader?.uniforms?.fadeOcclusion ??
        mesh?.fadeOcclusion ??
        mesh?.shader?.uniforms?.fadeOcclusion ??
        revealState.fadeOcclusion ??
        0,
    );
    const textureId =
      liveMesh?.texture?.baseTexture?.cacheId ??
      liveMesh?.texture?.baseTexture?.resource?.url ??
      liveMesh?.texture?.baseTexture?.resource?.src ??
      liveMesh?.texture?.baseTexture?.uid ??
      mesh?.texture?.baseTexture?.cacheId ??
      mesh?.texture?.baseTexture?.resource?.url ??
      mesh?.texture?.baseTexture?.resource?.src ??
      mesh?.texture?.baseTexture?.uid ??
      index;
    const visible = liveMesh?.visible === false ? 0 : 1;
    const renderable = liveMesh?.renderable === false ? 0 : 1;
    const alphaKey = Number.isFinite(alpha) ? alpha.toFixed(3) : "NaN";
    const fadeKey = Number.isFinite(fadeOcclusion) ? fadeOcclusion.toFixed(3) : "NaN";
    parts.push(
      `lt:${levelId}:${textureId}:${visible}:${renderable}:${alphaKey}:${fadeKey}:${revealState.revealed ? 1 : 0}:${
        revealState.hovered ? 1 : 0
      }:${revealState.explicit ? 1 : 0}:${revealState.faded ? 1 : 0}`,
    );
  }

  const tileMeshes =
    typeof canvas?.primary?.tiles?.values === "function"
      ? Array.from(canvas.primary.tiles.values())
      : Array.from(canvas?.primary?.tiles ?? []);
  for (const [index, mesh] of tileMeshes.entries()) {
    if (!mesh) continue;
    const tileObject = fxmLinkedPlaceableFromDisplayObject(mesh);
    const liveMesh = tileObject?.mesh ?? mesh;
    const document = tileObject?.document ?? tileObject ?? null;
    const elevation = Number(mesh?.elevation ?? document?.elevation ?? tileObject?.elevation ?? Number.NaN);
    const level = mesh?.level ?? tileObject?.level ?? document?.level ?? null;
    const revealState = getCanvasLiveLevelSurfaceRevealState(liveMesh, {
      mesh: liveMesh,
      object: tileObject,
      document,
      level,
      elevation,
    });
    const tileId = tileObject?.document?.id ?? tileObject?.id ?? index;
    const levelId = mesh?.level?.id ?? tileObject?.level?.id ?? tileObject?.document?.level?.id ?? "";
    const alpha = Number(
      liveMesh?.worldAlpha ??
        liveMesh?.alpha ??
        mesh?.worldAlpha ??
        mesh?.alpha ??
        tileObject?.alpha ??
        tileObject?.document?.alpha ??
        0,
    );
    const fadeOcclusion = Number(
      liveMesh?.fadeOcclusion ??
        liveMesh?.shader?.uniforms?.fadeOcclusion ??
        mesh?.fadeOcclusion ??
        mesh?.shader?.uniforms?.fadeOcclusion ??
        revealState.fadeOcclusion ??
        0,
    );
    const visible = liveMesh?.visible === false ? 0 : 1;
    const renderable = liveMesh?.renderable === false ? 0 : 1;
    const alphaKey = Number.isFinite(alpha) ? alpha.toFixed(3) : "NaN";
    const fadeKey = Number.isFinite(fadeOcclusion) ? fadeOcclusion.toFixed(3) : "NaN";
    parts.push(
      `tile:${tileId}:${levelId}:${visible}:${renderable}:${alphaKey}:${fadeKey}:${revealState.revealed ? 1 : 0}:${
        revealState.hovered ? 1 : 0
      }:${revealState.explicit ? 1 : 0}:${revealState.faded ? 1 : 0}`,
    );
  }

  return { key: parts.join("|"), forceRefresh };
}

/**
 * Build a lightweight signature describing the current live native-Level surface state.
 *
 * Scene suppression masks need to refresh when visible level overlays change without a camera move, such as hover-fade reveals or controlled-token transparency on upper levels.
 *
 * @param {Scene|null|undefined} [scene=canvas?.scene ?? null]
 * @param {{ presynced?: boolean }} [options]
 * @returns {string}
 */
export function buildCanvasLiveLevelSurfaceSignature(scene = canvas?.scene ?? null, options = {}) {
  return getCanvasLiveLevelSurfaceState(scene, options).key;
}
