/**
 * Cross-version scene integration helpers.
 */

import { packageId } from "../constants.js";
import { normalizeDarknessActivationRange } from "./darkness.js";
import { matrixCacheKey } from "./render-state.js";

let _snapshotFrameKey = null;
let _snapshotCache = new WeakMap();
let _levelTexturePlanCache = new Map();
const LEVEL_TEXTURE_PLAN_CACHE_MAX = 16;
const _comparableSourcePathCache = new Map();
const COMPARABLE_SOURCE_PATH_CACHE_MAX = 1024;
const COMPARABLE_SOURCE_PATH_CACHE_MAX_LENGTH = 4096;
let _sourceNodeSnapshotScene = null;
let _sourceNodeSnapshotPrimary = null;
let _sourceNodeSnapshots = new WeakMap();
let _sourceRootSnapshots = new WeakMap();

function fxmCanvas() {
  return globalThis.canvas ?? null;
}

function fxmFrameKey() {
  const canvas = fxmCanvas();
  return `${canvas?.scene?.id ?? ""}:${canvas?.app?.ticker?.lastTime ?? 0}`;
}

function resetSnapshotCacheIfNeeded() {
  const key = fxmFrameKey();
  if (_snapshotFrameKey !== key) {
    _snapshotFrameKey = key;
    _snapshotCache = new WeakMap();
  }
}

/**
 * Filter a newly allocated collection snapshot, compacting small arrays in place.
 * @param {Array} values
 * @returns {Array}
 */
function compactCollectionSnapshot(values) {
  if (values.length > 32) return values.filter(Boolean);
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value) values[count++] = value;
  }
  values.length = count;
  return values;
}

/** @param {*} value @returns {Array} */
export function fxmCollectionValues(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  const contents = value?.contents;
  if (Array.isArray(contents)) return contents.filter(Boolean);
  if (typeof value?.toArray === "function") {
    try {
      return value.toArray().filter(Boolean);
    } catch (_err) {
      return [];
    }
  }
  if (typeof value?.values === "function") {
    try {
      return compactCollectionSnapshot(Array.from(value.values()));
    } catch (_err) {
      return [];
    }
  }
  try {
    return compactCollectionSnapshot(Array.from(value));
  } catch (_err) {
    return value ? [value] : [];
  }
}

/**
 * Return whether a tracked scene display object is active.
 * @param {*} object
 * @returns {boolean}
 */
export function fxmPrimaryCanvasObjectIsLive(object) {
  if (!object || typeof object !== "object" || object.destroyed === true) return false;
  if (!("inPrimary" in object)) return true;
  try {
    return object.inPrimary === true;
  } catch (_err) {
    return false;
  }
}

/**
 * Return active scene display objects from the preferred registry or fallback collections.
 * @param {{ fallbackCollections?: Iterable<*>[], predicate?: Function|null }} [options]
 * @returns {Array}
 */
export function fxmGetPrimaryCanvasObjects({ fallbackCollections = [], predicate = null } = {}) {
  const primary = fxmCanvas()?.primary ?? null;
  if (!primary || primary.destroyed) return [];

  const output = [];
  let seen = null;
  if ("objects" in primary && primary.objects != null) {
    const objects = fxmCollectionValues(primary.objects);
    if (typeof predicate === "function" && Array.isArray(objects) && objects.length <= 40) {
      for (const object of objects) {
        if (!fxmPrimaryCanvasObjectIsLive(object) || (seen ? seen.has(object) : output.includes(object))) continue;
        try {
          if (!predicate(object)) continue;
        } catch (_err) {
          continue;
        }
        output.push(object);
        if (seen) seen.add(object);
        else if (output.length === 32) seen = new Set(output);
      }
      return output;
    }
    seen = new Set();
    if (typeof predicate === "function") {
      for (const object of objects) {
        if (!fxmPrimaryCanvasObjectIsLive(object) || seen.has(object)) continue;
        try {
          if (!predicate(object)) continue;
        } catch (_err) {
          continue;
        }
        seen.add(object);
        output.push(object);
      }
    } else {
      for (const object of objects) {
        if (!fxmPrimaryCanvasObjectIsLive(object) || seen.has(object)) continue;
        seen.add(object);
        output.push(object);
      }
    }
    return output;
  }

  seen = new Set();
  const push = (object) => {
    if (!fxmPrimaryCanvasObjectIsLive(object) || seen.has(object)) return;
    if (typeof predicate === "function") {
      try {
        if (!predicate(object)) return;
      } catch (_err) {
        return;
      }
    }
    seen.add(object);
    output.push(object);
  };
  const collections = Array.isArray(fallbackCollections) ? fallbackCollections : [fallbackCollections];
  for (const collection of collections) {
    for (const object of fxmCollectionValues(collection)) push(object);
  }
  if (output.length) return output;

  const visit = (object) => {
    if (!object || seen.has(object)) return;
    push(object);
    for (const child of fxmCollectionValues(object?.children)) visit(child);
  };
  for (const child of fxmCollectionValues(primary.children)) visit(child);
  return output;
}

/**
 * Return active Tile display meshes.
 * @returns {Array}
 */
export function fxmGetPrimaryTileMeshes() {
  const primary = fxmCanvas()?.primary ?? null;
  if (!primary || primary.destroyed) return [];

  const collectionMeshes = fxmCollectionValues(primary.tiles);
  const useSmallArray =
    Array.isArray(collectionMeshes) &&
    collectionMeshes.length <= 32 &&
    Object.getPrototypeOf(collectionMeshes) === Array.prototype &&
    !Object.hasOwn(collectionMeshes, Symbol.iterator) &&
    !Object.hasOwn(collectionMeshes, "includes");
  const collectionSet = useSmallArray ? null : new Set(collectionMeshes);
  return fxmGetPrimaryCanvasObjects({
    fallbackCollections: [collectionMeshes],
    predicate: (object) => {
      if (collectionSet ? collectionSet.has(object) : collectionMeshes.length && collectionMeshes.includes(object))
        return true;
      const owner = fxmLinkedPlaceableFromDisplayObject(object) ?? object?.object ?? null;
      const document = owner?.documentName ? owner : owner?.document ?? null;
      const documentName = document?.documentName ?? document?.constructor?.documentName ?? "";
      return documentName === "Tile";
    },
  });
}

/**
 * Return active Level texture meshes in Level order.
 * @returns {Array}
 */
export function fxmGetPrimaryLevelTextureMeshes() {
  return fxmCollectionValues(fxmCanvas()?.primary?.levelTextures ?? []).filter((object) =>
    fxmPrimaryCanvasObjectIsLive(object),
  );
}

/** @param {*} document @returns {string} */
export function fxmDocumentId(document) {
  return String(document?.id ?? document?.["_id"] ?? "").trim();
}

/**
 * Resolve a public placeable owner from a rendered display object without forcing CanvasDocument object creation.
 * @param {*} value
 * @returns {*}
 */
export function fxmLinkedPlaceableFromDisplayObject(value) {
  if (!value || typeof value !== "object") return null;
  const looksLikeDisplayObject = !!(
    value.worldTransform ||
    value.transform ||
    value.texture ||
    value.parent ||
    value.render
  );
  if (looksLikeDisplayObject) return value.object ?? value.placeable ?? null;

  const doc = value.document ?? value;
  if (doc?.rendered === true) {
    try {
      return doc.object ?? null;
    } catch (_err) {
      return null;
    }
  }
  return null;
}

/**
 * Resolve hover-fade state from candidate surfaces.
 * @param {...*} candidates
 * @returns {object|null}
 */
export function fxmGetPublicHoverFadeState(...candidates) {
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const direct = candidate.hoverFadeState ?? candidate._hoverFadeState ?? null;
    if (direct && typeof direct === "object") return direct;
    const mesh = candidate.mesh ?? null;
    const meshState = mesh?.hoverFadeState ?? mesh?._hoverFadeState ?? null;
    if (meshState && typeof meshState === "object") return meshState;
  }
  return null;
}

/**
 * Return whether a display object represents a prepared full-scene Level texture.
 * @param {*} object
 * @returns {boolean}
 */
export function fxmIsCanvasLevelTexture(object) {
  if (!object) return false;
  const textures = fxmCanvas()?.primary?.levelTextures;
  if (
    Array.isArray(textures) &&
    Object.getPrototypeOf(textures) === Array.prototype &&
    !Object.hasOwn(textures, "includes") &&
    !Object.hasOwn(textures, "filter") &&
    !Object.hasOwn(textures, "constructor")
  ) {
    return textures.includes(object) && fxmPrimaryCanvasObjectIsLive(object);
  }
  return fxmCollectionValues(textures ?? [])
    .filter((entry) => fxmPrimaryCanvasObjectIsLive(entry))
    .includes(object);
}

/**
 * Resolve surface-visibility sampling data for a prepared Level texture.
 * @param {*} object
 * @returns {{ texture: object, elevation: number }|null}
 */
export function fxmGetCanvasLevelTextureSurfaceOcclusion(object) {
  if (!fxmIsCanvasLevelTexture(object)) return null;

  const canvas = fxmCanvas();
  const mask = canvas?.masks?.occlusion ?? null;
  const texture = mask?.renderTexture ?? null;
  if (!texture || typeof mask?.mapElevation !== "function") return null;
  if (!(Number(mask?.occludedSurfaces?.size ?? 0) > 0)) return null;

  const surfaceMode = Number(globalThis.CONST?.OCCLUSION_MODES?.SURFACE);
  const occlusionMode = Number(object?.occlusionMode ?? 0);
  const surfaceState = Number(object?._occlusionState?.surface ?? 0);
  if (Number.isFinite(surfaceMode)) {
    if (!(occlusionMode & surfaceMode)) return null;
  } else if (!(surfaceState > 0)) return null;

  const elevation = Number(object?.elevation);
  if (!Number.isFinite(elevation)) return null;

  const objectName = String(object?.name ?? "");
  const sameElevation =
    typeof object?._occludedBySameElevationSurfaces === "boolean"
      ? object._occludedBySameElevationSurfaces
      : !objectName.endsWith(".foreground");
  const effectiveElevation = sameElevation
    ? elevation
    : typeof Math.nextDown === "function"
    ? Math.nextDown(elevation)
    : elevation - 1e-4;
  const mappedElevation = Number(mask.mapElevation(effectiveElevation));
  if (!Number.isFinite(mappedElevation)) return null;

  return { texture, elevation: mappedElevation };
}

/**
 * Resolve target opacity when rendered values are unavailable.
 * @param {*} placeable
 * @returns {number|null}
 */
export function fxmGetPlaceableTargetAlphaCompat(placeable) {
  if (!placeable || typeof placeable !== "object") return null;
  if (typeof placeable._getTargetAlpha !== "function") return null;
  try {
    const alpha = Number(placeable._getTargetAlpha());
    return Number.isFinite(alpha) ? alpha : null;
  } catch (_err) {
    return null;
  }
}

/**
 * Update a display transform, optionally leaving child graphics to their normal render pass.
 * @param {PIXI.DisplayObject|null|undefined} object
 * @param {{ skipChildren?: boolean }} [options]
 * @returns {boolean}
 */
export function fxmUpdateDisplayObjectWorldTransform(object, { skipChildren = false } = {}) {
  if (!object || typeof object !== "object") return false;
  try {
    const update =
      skipChildren && typeof object.displayObjectUpdateTransform === "function"
        ? object.displayObjectUpdateTransform
        : object.updateTransform;
    if (object.parent?.transform) {
      update?.call(object);
      return true;
    }
    if (typeof object.enableTempParent === "function" && typeof object.disableTempParent === "function") {
      const cacheParent = object.enableTempParent();
      try {
        update?.call(object);
      } finally {
        object.disableTempParent(cacheParent);
      }
      return true;
    }
    update?.call(object);
    return true;
  } catch (_err) {
    return false;
  }
}

/** @param {*} object @returns {string} */
export function fxmDisplayObjectTransformSignature(object) {
  const m = object?.worldTransform ?? object?.transform?.worldTransform ?? null;
  return matrixCacheKey(m);
}

/** @param {*} document @returns {*} */
export function fxmReadDocumentShapes(document) {
  const doc = document?.document ?? document ?? null;
  return (
    doc?.shapes ??
    fxmReadDocumentSnapshotValue(doc, "shapes") ??
    fxmReadDocumentSnapshotValue(document, "shapes") ??
    null
  );
}

/** @param {*} document @returns {object|null} */
export function fxmReadDocumentSnapshotCompat(document) {
  if (!document || typeof document !== "object") return null;
  resetSnapshotCacheIfNeeded();
  if (_snapshotCache.has(document)) return _snapshotCache.get(document);

  const remember = (value) => {
    const out = value && typeof value === "object" ? value : null;
    _snapshotCache.set(document, out);
    return out;
  };

  if (document._source && typeof document._source === "object") return remember(document._source);

  if (typeof document.toObject === "function") {
    try {
      return remember(document.toObject(true));
    } catch (_err) {}
    try {
      return remember(document.toObject());
    } catch (_err) {}
    try {
      return remember(document.toObject(false));
    } catch (_err) {}
  }
  if (typeof document.toJSON === "function") {
    try {
      return remember(document.toJSON());
    } catch (_err) {}
  }
  const proto = Object.getPrototypeOf(document);
  return proto === Object.prototype || proto === null ? remember(document) : remember(null);
}

/** @param {*} document @param {string|string[]} path @returns {*} */
export function fxmReadDocumentSnapshotValue(document, path) {
  const snapshot = fxmReadDocumentSnapshotCompat(document);
  if (!snapshot) return undefined;
  const parts = Array.isArray(path) ? path : [path];
  let value = snapshot;
  for (const part of parts) {
    if (value == null) return undefined;
    value = value?.[part];
  }
  return value;
}

/** @param {*} level @returns {*} */
export function fxmGetLevelBackground(level) {
  return level?.background ?? null;
}

/** @param {*} level @returns {*} */
export function fxmGetLevelForeground(level) {
  return level?.foreground ?? null;
}

/** @param {*} level @returns {*} */
export function fxmGetLevelTextures(level) {
  return level?.textures ?? null;
}

/** Normalize an explicit elevation or range without treating missing values as zero. */
function elevationWindow(elevation, bottom, top) {
  const scalar = elevation == null || String(elevation).trim() === "" ? Number.NaN : Number(elevation);
  if (Number.isFinite(scalar)) return { min: scalar, max: scalar };
  bottom = elevation?.bottom ?? bottom;
  top = elevation?.top ?? top;
  const hasBottom = bottom !== undefined && bottom !== null && String(bottom).trim() !== "";
  const hasTop = top !== undefined && top !== null && String(top).trim() !== "";
  if (!hasBottom && !hasTop) return null;
  return {
    min: hasBottom ? Number(bottom) : Number.NEGATIVE_INFINITY,
    max: hasTop ? Number(top) : Number.POSITIVE_INFINITY,
  };
}

/** @param {*} level @returns {{min:number,max:number}|null} */
export function fxmGetLevelElevationWindow(level) {
  if (!level) return null;
  const ownBottom = Object.prototype.hasOwnProperty.call(level, "bottom") ? level.bottom : undefined;
  const ownTop = Object.prototype.hasOwnProperty.call(level, "top") ? level.top : undefined;
  return (
    elevationWindow(level.elevation, ownBottom, ownTop) ??
    elevationWindow(fxmReadDocumentSnapshotValue(level, "elevation"))
  );
}

/** @param {*} level @returns {number} */
export function fxmLevelBottom(level) {
  return Number(fxmGetLevelElevationWindow(level)?.min ?? Number.NaN);
}

/** @param {*} level @returns {number} */
export function fxmLevelTop(level) {
  return Number(fxmGetLevelElevationWindow(level)?.max ?? Number.NaN);
}

/** @param {*} candidate @param {*} target @returns {boolean} */
export function fxmLevelIsAbove(candidate, target) {
  if (!candidate || !target) return false;
  const candidateBottom = fxmLevelBottom(candidate);
  const targetBottom = fxmLevelBottom(target);
  if (Number.isFinite(candidateBottom) && Number.isFinite(targetBottom)) return candidateBottom > targetBottom + 1e-4;
  const candidateTop = fxmLevelTop(candidate);
  const targetTop = fxmLevelTop(target);
  if (Number.isFinite(candidateTop) && Number.isFinite(targetTop)) return candidateTop > targetTop + 1e-4;
  return false;
}

/** @param {*} level @returns {boolean} */
export function fxmLevelIsView(level) {
  if (!level) return false;
  if (typeof level.isView === "boolean") return level.isView;
  const current = fxmCanvas()?.level ?? null;
  return !!current?.id && current.id === level.id;
}

/** @param {*} level @returns {boolean} */
export function fxmLevelIsVisible(level) {
  if (!level) return false;
  if (typeof level.isVisible === "boolean") return level.isVisible;
  return fxmLevelIsView(level);
}

/** @param {*} scene @returns {Array} */
export function fxmGetSceneLevels(scene = fxmCanvas()?.scene ?? null) {
  const levels = [];
  const seen = new Set();
  const push = (level) => {
    if (!level) return;
    const id = fxmDocumentId(level);
    const looksLikeLevel =
      !!id || "elevation" in Object(level) || "isView" in Object(level) || "isVisible" in Object(level);
    if (!looksLikeLevel) return;
    const key = id || level;
    if (seen.has(key)) return;
    seen.add(key);
    levels.push(level);
  };
  const pushAll = (value) => fxmCollectionValues(value).forEach(push);

  /** Prefer the canonical embedded collection prepared by Scene#prepareEmbeddedDocuments without invoking the user-specific SceneManager availability pipeline. */
  const preparedLevels = scene?.levels?.sorted ?? scene?.levels?.contents ?? scene?.levels ?? null;
  pushAll(preparedLevels);

  if (!levels.length) {
    try {
      pushAll(scene?.getEmbeddedCollection?.("Level"));
    } catch (_err) {}
  }

  /** Retain accessor fallbacks for older or partially prepared scene-like values without touching each accessor on the common V14 path. */
  if (!levels.length) {
    try {
      push(scene?.initialLevel);
    } catch (_err) {}
    try {
      push(scene?.firstLevel);
    } catch (_err) {}
    try {
      pushAll(scene?.availableLevels);
    } catch (_err) {}
  }

  try {
    if (!scene?.id || fxmCanvas()?.scene?.id === scene.id) push(fxmCanvas()?.level);
  } catch (_err) {}
  return levels;
}

/** @param {string} levelId @param {*} [scene] @returns {*} */
export function fxmGetSceneLevelById(levelId, scene = fxmCanvas()?.scene ?? null) {
  const id = String(levelId ?? "").trim();
  if (!id) return null;

  try {
    const direct = scene?.levels?.get?.(id) ?? scene?.getEmbeddedCollection?.("Level")?.get?.(id) ?? null;
    if (direct) return direct;
  } catch (_err) {}

  const current = fxmCanvas()?.level ?? null;
  if ((!scene?.id || fxmCanvas()?.scene?.id === scene.id) && fxmDocumentId(current) === id) return current;
  return fxmGetSceneLevels(scene).find((level) => fxmDocumentId(level) === id) ?? null;
}

/**
 * Normalize source paths with bounded reuse keyed by the complete input string.
 * @param {string|null|undefined} sourcePath
 * @returns {string}
 */
export function fxmNormalizeComparableSourcePath(sourcePath) {
  if (typeof sourcePath !== "string") return "";
  const cacheable = sourcePath.length <= COMPARABLE_SOURCE_PATH_CACHE_MAX_LENGTH;
  if (cacheable) {
    const cached = _comparableSourcePathCache.get(sourcePath);
    if (cached !== undefined) return cached;
  }
  const trimmed = sourcePath.trim();
  if (!trimmed) return "";
  let decoded = trimmed;
  if (trimmed.includes("%")) {
    try {
      decoded = decodeURI(trimmed);
    } catch (_err) {}
  }
  const normalized = decoded
    .replace(/^(?:https?:\/\/[^/]+\/*|file:\/\/\/*|\/+)/i, "")
    .replace(/\?.*$/, "")
    .replace(/#.*$/, "");
  if (cacheable) {
    if (_comparableSourcePathCache.size >= COMPARABLE_SOURCE_PATH_CACHE_MAX) {
      _comparableSourcePathCache.delete(_comparableSourcePathCache.keys().next().value);
    }
    _comparableSourcePathCache.set(sourcePath, normalized);
  }
  return normalized;
}

/** @param {Set<string>} output @param {*} candidate @returns {void} */
export function fxmAddComparableSourcePath(output, candidate) {
  if (!(output instanceof Set) || typeof candidate !== "string") return;
  const normalized = fxmNormalizeComparableSourcePath(candidate);
  if (normalized) output.add(normalized);
}

/** Clear source snapshots when the active canvas is released. @returns {void} */
export function fxmClearSourcePathCache() {
  _sourceNodeSnapshotScene = null;
  _sourceNodeSnapshotPrimary = null;
  _sourceNodeSnapshots = new WeakMap();
  _sourceRootSnapshots = new WeakMap();
}

/**
 * Create request-local traversal state backed by validated source snapshots.
 * @returns {{nodes: WeakMap<object,object>, normalized: Map<string,string>, snapshots?: WeakMap<object,object>, roots?: WeakMap<object,object>}}
 */
export function fxmCreateSourcePathContext() {
  const canvas = fxmCanvas();
  const scene = canvas?.scene ?? null;
  const primary = canvas?.primary ?? null;
  if (scene !== _sourceNodeSnapshotScene || primary !== _sourceNodeSnapshotPrimary) {
    _sourceNodeSnapshotScene = scene;
    _sourceNodeSnapshotPrimary = primary;
    _sourceNodeSnapshots = new WeakMap();
    _sourceRootSnapshots = new WeakMap();
  }
  return { nodes: new WeakMap(), normalized: new Map(), snapshots: _sourceNodeSnapshots, roots: _sourceRootSnapshots };
}

/**
 * Reuse normalized paths only while every direct source input remains unchanged; linked objects are checked independently so changed descendants are revisited.
 * @param {object|Function} value
 * @param {object} context
 * @returns {object}
 */
function readComparableSourceSnapshot(value, context) {
  const texture = value.texture;
  const baseTexture = value.baseTexture;
  const resource = value.resource;
  const document = value.document;
  const textureBase = texture?.baseTexture;
  const textureResource = textureBase?.resource;
  const baseResource = baseTexture?.resource;
  const documentTexture = document?.texture;
  const textureCacheIds = value.textureCacheIds;
  const snapshot = context.snapshots.get(value);
  const candidate0 = value?.src;
  const candidate1 = value?.currentSrc;
  const candidate2 = value?.url;
  const candidate3 = value?.href;
  const candidate4 = value?.path;
  const candidate5 = value?.img;
  const candidate6 = value?.cacheId;
  const candidate7 = texture?.src;
  const candidate8 = texture?.url;
  const candidate9 = texture?.path;
  const candidate10 = textureResource?.src;
  const candidate11 = textureResource?.url;
  const candidate12 = textureBase?.cacheId;
  const candidate13 = baseResource?.src;
  const candidate14 = baseResource?.url;
  const candidate15 = baseTexture?.cacheId;
  const candidate16 = resource?.src;
  const candidate17 = resource?.url;
  const candidate18 = documentTexture?.src;
  const candidate19 = document?.src;
  const candidate20 = document?.img;
  const cacheIds = Array.isArray(textureCacheIds) ? Array.from(textureCacheIds) : null;
  let sameIds = (snapshot?.cacheIds?.length ?? 0) === (cacheIds?.length ?? 0);
  if (sameIds && cacheIds) {
    for (let i = 0; i < cacheIds.length; i++) {
      if (cacheIds[i] !== snapshot?.cacheIds?.[i]) {
        sameIds = false;
        break;
      }
    }
  }
  const unchanged =
    !!snapshot &&
    sameIds &&
    snapshot.candidates[0] === candidate0 &&
    snapshot.candidates[1] === candidate1 &&
    snapshot.candidates[2] === candidate2 &&
    snapshot.candidates[3] === candidate3 &&
    snapshot.candidates[4] === candidate4 &&
    snapshot.candidates[5] === candidate5 &&
    snapshot.candidates[6] === candidate6 &&
    snapshot.candidates[7] === candidate7 &&
    snapshot.candidates[8] === candidate8 &&
    snapshot.candidates[9] === candidate9 &&
    snapshot.candidates[10] === candidate10 &&
    snapshot.candidates[11] === candidate11 &&
    snapshot.candidates[12] === candidate12 &&
    snapshot.candidates[13] === candidate13 &&
    snapshot.candidates[14] === candidate14 &&
    snapshot.candidates[15] === candidate15 &&
    snapshot.candidates[16] === candidate16 &&
    snapshot.candidates[17] === candidate17 &&
    snapshot.candidates[18] === candidate18 &&
    snapshot.candidates[19] === candidate19 &&
    snapshot.candidates[20] === candidate20;
  let paths = unchanged ? snapshot.paths : null;
  let candidates = snapshot?.candidates;
  if (!unchanged) {
    candidates = [
      candidate0,
      candidate1,
      candidate2,
      candidate3,
      candidate4,
      candidate5,
      candidate6,
      candidate7,
      candidate8,
      candidate9,
      candidate10,
      candidate11,
      candidate12,
      candidate13,
      candidate14,
      candidate15,
      candidate16,
      candidate17,
      candidate18,
      candidate19,
      candidate20,
    ];
    for (const candidate of cacheIds ? candidates.concat(cacheIds) : candidates) {
      if (typeof candidate !== "string") continue;
      let normalized = context.normalized.get(candidate);
      if (normalized === undefined) {
        normalized = fxmNormalizeComparableSourcePath(candidate);
        context.normalized.set(candidate, normalized);
      }
      if (!normalized) continue;
      if (paths === null) paths = typeof normalized === "string" ? normalized : new Set([normalized]);
      else if (typeof paths === "string") {
        if (normalized !== paths) paths = new Set([paths, normalized]);
      } else paths.add(normalized);
    }
  }
  const nested0 = texture;
  const nested1 = baseTexture;
  const nested2 = resource;
  const nested3 = value?.source;
  const nested4 = value?.parentTextureArray;
  const nested5 = value?.object;
  const nested6 = value?.placeable;
  const nested7 = value?.level;
  const nested8 = value?.levels;
  const nested9 = document;
  if (
    unchanged &&
    snapshot.nested[0] === nested0 &&
    snapshot.nested[1] === nested1 &&
    snapshot.nested[2] === nested2 &&
    snapshot.nested[3] === nested3 &&
    snapshot.nested[4] === nested4 &&
    snapshot.nested[5] === nested5 &&
    snapshot.nested[6] === nested6 &&
    snapshot.nested[7] === nested7 &&
    snapshot.nested[8] === nested8 &&
    snapshot.nested[9] === nested9
  )
    return snapshot;
  const record = {
    paths,
    candidates,
    cacheIds,
    nested: [nested0, nested1, nested2, nested3, nested4, nested5, nested6, nested7, nested8, nested9],
  };
  context.snapshots.set(value, record);
  return record;
}

/**
 * Reuse an ordered root result after validating its reachable source nodes, stopping at the first changed node before following obsolete links.
 * @param {object|Function} value
 * @param {Set<string>|null} output
 * @param {Set<object>|null} seen
 * @param {object} context
 * @param {boolean} [reuseResult=false]
 * @returns {Set<string>|{paths:Set<string>,seen:Set<object>}}
 */
function collectValidatedSourceRoot(value, output, seen, context, reuseResult = false) {
  let root = context.roots.get(value);
  if (root) {
    for (let i = 0; i < root.dependencies.length; i++) {
      const [object, previous] = root.dependencies[i];
      let current = context.nodes.get(object);
      if (!current) {
        try {
          current = readComparableSourceSnapshot(object, context);
          context.nodes.set(object, current);
        } catch (error) {
          context.nodes.set(object, {
            get paths() {
              throw error;
            },
          });
          const traversal = { nodes: context.nodes, normalized: context.normalized, snapshots: context.snapshots };
          seen ??= new Set();
          try {
            fxmCollectComparableSourcePaths(value, output ?? new Set(), seen, traversal);
          } finally {
            context.nodes.delete(object);
          }
          throw error;
        }
      }
      if (current !== previous) {
        root = null;
        break;
      }
    }
  }
  if (root) {
    if (!reuseResult) for (const [object] of root.dependencies) seen.add(object);
  } else {
    seen ??= new Set();
    const paths = new Set();
    const traversal = { nodes: context.nodes, normalized: context.normalized, snapshots: context.snapshots };
    try {
      fxmCollectComparableSourcePaths(value, paths, seen, traversal);
    } catch (error) {
      if (output) for (const path of paths) output.add(path);
      throw error;
    }
    root = {
      paths: Array.from(paths),
      dependencies: Array.from(seen, (object) => [object, context.nodes.get(object)]),
    };
    if (reuseResult) root.result = { paths, seen };
    context.roots.set(value, root);
  }
  if (reuseResult) {
    return (root.result ??= { paths: new Set(root.paths), seen: new Set(root.dependencies.map(([object]) => object)) });
  }
  for (const path of root.paths) output.add(path);
  return output;
}

/**
 * Return validated source paths and reachability without copying unchanged results. The returned sets are borrowed and must remain read-only.
 * @param {*} value
 * @param {object|null} [context]
 * @returns {{paths:Set<string>,seen:Set<object>}}
 */
export function fxmGetComparableSourcePathResult(value, context = null) {
  if (value && (typeof value === "object" || typeof value === "function") && context?.roots) {
    return collectValidatedSourceRoot(value, null, null, context, true);
  }
  const paths = new Set();
  const seen = new Set();
  fxmCollectComparableSourcePaths(value, paths, seen, context);
  return { paths, seen };
}

/**
 * Collect reachable source paths with request-local traversal and optional validated snapshot reuse.
 * @param {*} value
 * @param {Set<string>} [output]
 * @param {Set<object>} [seen]
 * @param {{nodes: WeakMap<object,object>, normalized: Map<string,string>}|null} [context]
 * @returns {Set<string>}
 */
export function fxmCollectComparableSourcePaths(value, output = new Set(), seen = new Set(), context = null) {
  if (!value || !(output instanceof Set)) return output;
  if (typeof value === "string") {
    if (context) {
      let normalized = context.normalized.get(value);
      if (normalized === undefined) {
        normalized = fxmNormalizeComparableSourcePath(value);
        context.normalized.set(value, normalized);
      }
      if (normalized) output.add(normalized);
    } else fxmAddComparableSourcePath(output, value);
    return output;
  }
  if (typeof value !== "object" && typeof value !== "function") return output;
  if (context?.roots && seen.size === 0) return collectValidatedSourceRoot(value, output, seen, context);
  if (seen.has(value)) return output;
  seen.add(value);

  const cached = context?.nodes.get(value);
  if (cached) {
    if (cached.paths) {
      const paths = cached.paths;
      if (typeof paths === "string") output.add(paths);
      else for (const path of paths) output.add(path);
    }
    for (const nested of cached.nested) {
      if (!nested || nested === value) continue;
      fxmCollectComparableSourcePaths(nested, output, seen, context);
    }
    return output;
  }

  if (context?.snapshots) {
    const record = readComparableSourceSnapshot(value, context);
    context.nodes.set(value, record);
    if (typeof record.paths === "string") output.add(record.paths);
    else if (record.paths) for (const path of record.paths) output.add(path);
    for (const nested of record.nested) {
      if (!nested || nested === value) continue;
      fxmCollectComparableSourcePaths(nested, output, seen, context);
    }
    return output;
  }

  const texture = value.texture;
  const baseTexture = value.baseTexture;
  const resource = value.resource;
  const document = value.document;
  const textureBase = texture?.baseTexture;
  const textureResource = textureBase?.resource;
  const baseResource = baseTexture?.resource;
  const documentTexture = document?.texture;
  const textureCacheIds = value.textureCacheIds;
  const directCandidates = [
    value?.src,
    value?.currentSrc,
    value?.url,
    value?.href,
    value?.path,
    value?.img,
    value?.cacheId,
    texture?.src,
    texture?.url,
    texture?.path,
    textureResource?.src,
    textureResource?.url,
    textureBase?.cacheId,
    baseResource?.src,
    baseResource?.url,
    baseTexture?.cacheId,
    resource?.src,
    resource?.url,
    documentTexture?.src,
    document?.src,
    document?.img,
  ];
  if (Array.isArray(textureCacheIds)) {
    for (const candidate of textureCacheIds) directCandidates.push(candidate);
  }

  let directPaths = context ? null : output;
  for (const candidate of directCandidates) {
    if (context) {
      if (typeof candidate !== "string") continue;
      let normalized = context.normalized.get(candidate);
      if (normalized === undefined) {
        normalized = fxmNormalizeComparableSourcePath(candidate);
        context.normalized.set(candidate, normalized);
      }
      if (normalized) {
        if (directPaths === null) directPaths = typeof normalized === "string" ? normalized : new Set([normalized]);
        else if (typeof directPaths === "string") {
          if (normalized !== directPaths) directPaths = new Set([directPaths, normalized]);
        } else directPaths.add(normalized);
      }
    } else fxmAddComparableSourcePath(directPaths, candidate);
  }

  const nestedValues = [
    texture,
    baseTexture,
    resource,
    value?.source,
    value?.parentTextureArray,
    value?.object,
    value?.placeable,
    value?.level,
    value?.levels,
    document,
  ];
  if (context) {
    context.nodes.set(value, { paths: directPaths, nested: nestedValues });
    if (typeof directPaths === "string") output.add(directPaths);
    else if (directPaths) {
      for (const path of directPaths) output.add(path);
    }
  }
  for (const nested of nestedValues) {
    if (!nested || nested === value) continue;
    fxmCollectComparableSourcePaths(nested, output, seen, context);
  }
  return output;
}

/** @param {*} sourceValue @param {Set<object>} [seen] @returns {string} */
export function fxmResolveConfiguredImageSourcePath(sourceValue, seen = new Set()) {
  if (typeof sourceValue === "string") return sourceValue;
  if (!sourceValue || (typeof sourceValue !== "object" && typeof sourceValue !== "function")) return "";
  if (seen.has(sourceValue)) return "";
  seen.add(sourceValue);

  const directCandidates = [
    sourceValue?.src,
    sourceValue?.currentSrc,
    sourceValue?.url,
    sourceValue?.href,
    sourceValue?.path,
    sourceValue?.img,
    sourceValue?.texture?.src,
    sourceValue?.texture?.url,
    sourceValue?.texture?.path,
    sourceValue?.texture?.baseTexture?.resource?.src,
    sourceValue?.texture?.baseTexture?.resource?.url,
    sourceValue?.texture?.baseTexture?.cacheId,
    sourceValue?.baseTexture?.resource?.src,
    sourceValue?.baseTexture?.resource?.url,
    sourceValue?.baseTexture?.cacheId,
    sourceValue?.resource?.src,
    sourceValue?.resource?.url,
    sourceValue?.document?.texture?.src,
    sourceValue?.document?.src,
    sourceValue?.document?.img,
  ];
  for (const candidate of directCandidates) if (typeof candidate === "string" && candidate.trim()) return candidate;

  for (const nested of [
    sourceValue?.texture,
    sourceValue?.baseTexture,
    sourceValue?.resource,
    sourceValue?.source,
    sourceValue?.document,
  ]) {
    if (!nested || nested === sourceValue) continue;
    const resolved = fxmResolveConfiguredImageSourcePath(nested, seen);
    if (resolved) return resolved;
  }
  return "";
}

/**
 * Return the configured foreground image path without triggering v14 Scene#foreground compatibility warnings.
 *
 * @param {*} [scene]
 * @returns {string}
 */
export function fxmGetSceneForegroundSourcePath(scene = fxmCanvas()?.scene ?? null) {
  const canvas = fxmCanvas();
  const generation = Number(
    globalThis.game?.release?.generation ?? String(globalThis.game?.version ?? "").split(".")[0],
  );
  const viewedLevel = scene?.id && canvas?.scene?.id && scene.id !== canvas.scene.id ? null : canvas?.level ?? null;
  const hasNativeLevels = !!viewedLevel || !!scene?.levels || (Number.isFinite(generation) && generation >= 14);

  const directLevelSource = fxmResolveConfiguredImageSourcePath(fxmGetLevelForeground(viewedLevel));
  if (directLevelSource) return directLevelSource;

  if (viewedLevel) {
    for (const pathValue of fxmGetLevelConfiguredImagePaths(viewedLevel, { foregroundOnly: true, scene })) {
      if (pathValue) return pathValue;
    }
  }
  if (hasNativeLevels) return "";

  const snapshotSource = fxmResolveConfiguredImageSourcePath(fxmReadDocumentSnapshotValue(scene, "foreground"));
  if (snapshotSource) return snapshotSource;

  try {
    return fxmResolveConfiguredImageSourcePath(Reflect.get(scene, "foreground"));
  } catch (_err) {
    return "";
  }
}

function addEntryPaths(entry, config) {
  const direct = fxmResolveConfiguredImageSourcePath(config);
  if (direct) fxmAddComparableSourcePath(entry.paths, direct);
  fxmCollectComparableSourcePaths(config, entry.paths);
}

function levelTexturePlanSignature(scene, levels, viewedLevel) {
  const parts = [scene?.id ?? "", viewedLevel?.id ?? ""];
  for (const level of levels) {
    const elevation = fxmGetLevelElevationWindow(level);
    const bg = fxmResolveConfiguredImageSourcePath(fxmGetLevelBackground(level));
    const fg = fxmResolveConfiguredImageSourcePath(fxmGetLevelForeground(level));
    parts.push(
      [
        fxmDocumentId(level),
        fxmLevelIsView(level) ? 1 : 0,
        fxmLevelIsVisible(level) ? 1 : 0,
        Number.isFinite(elevation?.min) ? Number(elevation.min).toFixed(3) : "NaN",
        Number.isFinite(elevation?.max) ? Number(elevation.max).toFixed(3) : "NaN",
        fxmNormalizeComparableSourcePath(bg),
        fxmNormalizeComparableSourcePath(fg),
      ].join("~"),
    );
  }
  return parts.join("|");
}

/**
 * Build a cached Level texture plan from scene Level data.
 * @param {*} [scene]
 * @returns {{scene:*,viewedLevel:*,entries:Array,byLevelId:Map<string,Array>,byNormalizedSrc:Map<string,Array>,upperEntries:Array,upperLevelIds:Set<string>,currentLevelEntries:Array,hasAnyUpperArtwork:boolean,hasUpperForeground:boolean,hasUpperBackground:boolean}}
 */
export function fxmGetLevelTexturePlan(scene = fxmCanvas()?.scene ?? null) {
  const levels = fxmGetSceneLevels(scene);
  const viewedLevel =
    scene?.id && fxmCanvas()?.scene?.id && scene.id !== fxmCanvas().scene.id ? null : fxmCanvas()?.level ?? null;
  const signature = levelTexturePlanSignature(scene, levels, viewedLevel);
  const cached = _levelTexturePlanCache.get(signature);
  if (cached) return cached;

  const viewedBottom = fxmLevelBottom(viewedLevel);
  const plan = {
    scene,
    viewedLevel,
    entries: [],
    byLevelId: new Map(),
    byNormalizedSrc: new Map(),
    upperEntries: [],
    upperLevelIds: new Set(),
    currentLevelEntries: [],
    hasAnyUpperArtwork: false,
    hasUpperForeground: false,
    hasUpperBackground: false,
  };

  const remember = (entry) => {
    plan.entries.push(entry);
    if (!plan.byLevelId.has(entry.levelId)) plan.byLevelId.set(entry.levelId, []);
    plan.byLevelId.get(entry.levelId).push(entry);
    if (entry.isView) plan.currentLevelEntries.push(entry);
    if (entry.isUpper && entry.paths.size) {
      plan.upperEntries.push(entry);
      plan.upperLevelIds.add(entry.levelId);
      plan.hasAnyUpperArtwork = true;
      if (entry.isBackground) plan.hasUpperBackground = true;
      else plan.hasUpperForeground = true;
    }
    for (const pathValue of entry.paths) {
      if (!plan.byNormalizedSrc.has(pathValue)) plan.byNormalizedSrc.set(pathValue, []);
      plan.byNormalizedSrc.get(pathValue).push(entry);
    }
  };

  for (const level of levels) {
    const levelId = fxmDocumentId(level);
    if (!levelId) continue;
    const isView = fxmLevelIsView(level) || (!!viewedLevel?.id && viewedLevel.id === levelId);
    const isVisible = fxmLevelIsVisible(level) || isView;
    const bottom = fxmLevelBottom(level);
    const top = fxmLevelTop(level);

    for (const [name, config, isBackground] of [
      ["background", fxmGetLevelBackground(level) ?? {}, true],
      ["foreground", fxmGetLevelForeground(level) ?? {}, false],
    ]) {
      const source = fxmResolveConfiguredImageSourcePath(config);
      if (!isView && !(source && isVisible)) continue;
      const elevation = isBackground ? bottom : top;
      const isUpper =
        !isView && Number.isFinite(elevation) && Number.isFinite(viewedBottom) && elevation > viewedBottom + 1e-4;
      const entry = {
        level,
        levelId,
        name,
        config,
        src: source,
        normalizedSrc: fxmNormalizeComparableSourcePath(source),
        elevation,
        sort: 0,
        zIndex: 0,
        isBackground,
        isForeground: !isBackground,
        isView,
        isVisible,
        isUpper,
        paths: new Set(),
      };
      addEntryPaths(entry, config);
      remember(entry);
    }
  }

  _levelTexturePlanCache.set(signature, plan);
  if (_levelTexturePlanCache.size > LEVEL_TEXTURE_PLAN_CACHE_MAX) {
    const firstKey = _levelTexturePlanCache.keys().next().value;
    if (firstKey !== undefined) _levelTexturePlanCache.delete(firstKey);
  }
  return plan;
}

/** @returns {void} */
export function fxmClearLevelTexturePlanCache() {
  _levelTexturePlanCache.clear();
}

/** @param {*} level @param {{foregroundOnly?:boolean,scene?:*}} [options] @returns {Set<string>} */
export function fxmGetLevelConfiguredImagePaths(
  level,
  { foregroundOnly = false, scene = fxmCanvas()?.scene ?? null } = {},
) {
  const paths = new Set();
  const levelId = fxmDocumentId(level);
  const plan = fxmGetLevelTexturePlan(scene ?? level?.parent ?? fxmCanvas()?.scene ?? null);
  for (const entry of plan.byLevelId.get(levelId) ?? []) {
    if (foregroundOnly && !entry.isForeground) continue;
    for (const pathValue of entry.paths ?? []) paths.add(pathValue);
  }
  if (paths.size) return paths;

  const configs = foregroundOnly
    ? [fxmGetLevelForeground(level)]
    : [fxmGetLevelBackground(level), fxmGetLevelForeground(level)];
  for (const config of configs) {
    const direct = fxmResolveConfiguredImageSourcePath(config);
    if (direct) fxmAddComparableSourcePath(paths, direct);
    fxmCollectComparableSourcePaths(config, paths);
  }
  return paths;
}

/**
 * Resolve configured artwork ownership, optionally reusing a plan for one synchronous operation.
 * @param {Set<string>} sourcePaths
 * @param {{foregroundOnly?:boolean,scene?:*,plan?:object|null}} [options]
 * @returns {Set<string>}
 */
export function fxmResolveLevelIdsFromConfiguredSources(
  sourcePaths,
  { foregroundOnly = false, scene = fxmCanvas()?.scene ?? null, plan = null } = {},
) {
  const ids = new Set();
  if (!(sourcePaths?.size > 0)) return ids;
  plan ??= fxmGetLevelTexturePlan(scene);
  for (const sourcePath of sourcePaths) {
    const normalized = fxmNormalizeComparableSourcePath(sourcePath);
    if (!normalized) continue;
    for (const entry of plan.byNormalizedSrc.get(normalized) ?? []) {
      if (foregroundOnly && !entry.isForeground) continue;
      if (entry.levelId) ids.add(entry.levelId);
    }
  }
  return ids;
}

/** @param {*} document @returns {Set<string>|null} */
export function fxmGetDocumentLevelIds(document) {
  const doc = document?.document ?? document ?? null;
  if (!doc) return null;
  const raw = doc?.levels ?? document?.levels ?? null;
  if (raw instanceof Set) {
    const values = Array.from(raw);
    let normalized = true;
    for (const value of values) {
      if (typeof value !== "string" || !value) {
        normalized = false;
        break;
      }
    }
    return new Set(normalized ? values : values.map(String).filter(Boolean));
  }
  if (Array.isArray(raw)) return new Set(raw.map(String).filter(Boolean));
  if (typeof raw?.values === "function") {
    try {
      return new Set(Array.from(raw.values()).map(String).filter(Boolean));
    } catch (_err) {}
  }
  if (typeof raw?.[Symbol.iterator] === "function" && typeof raw !== "string") {
    try {
      return new Set(Array.from(raw).map(String).filter(Boolean));
    } catch (_err) {}
  }
  const directLevel = doc?.level ?? document?.level ?? null;
  if (typeof directLevel === "string" && directLevel.trim()) return new Set([directLevel.trim()]);
  const directLevelId = fxmDocumentId(directLevel);
  return directLevelId ? new Set([directLevelId]) : null;
}

/** @param {*} document @param {*} level @returns {boolean|null} */
export function fxmDocumentIncludedInLevel(document, level) {
  const doc = document?.document ?? document ?? null;
  if (!doc || !level) return null;
  try {
    if (typeof doc.includedInLevel === "function") return !!doc.includedInLevel(level);
  } catch (_err) {}

  const levelId = fxmDocumentId(level);
  if (!levelId) return null;
  const directLevel = doc?.level ?? document?.level ?? null;
  if (directLevel) {
    const directId = typeof directLevel === "string" ? directLevel : fxmDocumentId(directLevel);
    if (directId) return directId === levelId;
  }
  const ids = fxmGetDocumentLevelIds(doc) ?? fxmGetDocumentLevelIds(document);
  if (ids?.size) return ids.has(levelId);
  return null;
}

/**
 * Test whether a scene document belongs to a specific Level.
 * @param {*} document
 * @param {*} level
 * @returns {boolean|null}
 */
export function fxmDocumentLocatedInLevel(document, level) {
  const doc = document?.document ?? document ?? null;
  if (!doc || !level) return null;

  try {
    if (typeof doc.locatedInLevel === "function") return !!doc.locatedInLevel(level);
  } catch (_err) {}

  const levelId = fxmDocumentId(level);
  if (!levelId) return null;

  const directLevel = doc?.level ?? document?.level ?? null;
  if (directLevel) {
    const directId = typeof directLevel === "string" ? directLevel : fxmDocumentId(directLevel);
    if (directId) return directId === levelId;
  }

  const ids = fxmGetDocumentLevelIds(doc) ?? fxmGetDocumentLevelIds(document);
  if (ids?.size) return ids.has(levelId);
  return null;
}

/** @param {*} document @param {number} [fallbackElevation] @returns {{min:number,max:number}|null} */
export function fxmGetDocumentElevationWindow(document, fallbackElevation = Number.NaN) {
  const doc = document?.document ?? document ?? null;
  const ownBottom = Object.prototype.hasOwnProperty.call(doc ?? {}, "bottom") ? doc.bottom : undefined;
  const ownTop = Object.prototype.hasOwnProperty.call(doc ?? {}, "top") ? doc.top : undefined;
  const liveWindow = elevationWindow(doc?.elevation ?? document?.elevation, ownBottom, ownTop);
  if (liveWindow) return liveWindow;

  const snapshot = fxmReadDocumentSnapshotCompat(doc) ?? fxmReadDocumentSnapshotCompat(document);
  return elevationWindow(snapshot?.elevation, snapshot?.bottom, snapshot?.top) ?? elevationWindow(fallbackElevation);
}

/** @param {*} scene @param {object} [options] @returns {Array} */
export function fxmGetSceneSurfaces(scene = fxmCanvas()?.scene ?? null, options = {}) {
  if (!scene || typeof scene.getSurfaces !== "function") return [];
  try {
    return fxmCollectionValues(scene.getSurfaces(options));
  } catch (_err) {
    return [];
  }
}

/** @param {*} scene @param {object} [options] @returns {boolean} */
export function fxmSceneHasSurfaces(scene = fxmCanvas()?.scene ?? null, options = {}) {
  return fxmGetSceneSurfaces(scene, options).length > 0;
}

function normalizeStringArray(value) {
  if (value == null || value === "") return [];
  if (value instanceof Set) return Array.from(value).map(String).filter(Boolean);
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== "string" && typeof value?.[Symbol.iterator] === "function") {
    try {
      return Array.from(value).map(String).filter(Boolean);
    } catch (_err) {
      return [];
    }
  }
  return [String(value)].filter(Boolean);
}

/** @param {*} behavior @param {{snapshot?:boolean}} [options] @returns {object} */
export function fxmGetRegionBehaviorSystem(behavior, { snapshot = true } = {}) {
  if (!behavior) return {};
  const system = behavior.system ?? behavior.typeData ?? null;
  if (system && typeof system === "object") {
    if (!snapshot) return system;
    if (typeof system.toObject === "function") {
      try {
        const value = system.toObject(false);
        return value && typeof value === "object" ? value : system;
      } catch (_err) {
        try {
          const value = system.toObject();
          return value && typeof value === "object" ? value : system;
        } catch (_err2) {
          return system;
        }
      }
    }
    return system;
  }
  if (typeof behavior.toObject === "function") {
    try {
      const value = behavior.toObject() ?? {};
      if (value.system && typeof value.system === "object") return value.system;
      return value && typeof value === "object" ? value : {};
    } catch (_err) {
      return {};
    }
  }
  return {};
}

/** @param {*} behavior @param {string} flagName @param {string|string[]} systemNames @param {*} [fallback] @returns {*} */
export function fxmGetRegionBehaviorValue(behavior, flagName, systemNames, fallback = undefined) {
  const system = fxmGetRegionBehaviorSystem(behavior, { snapshot: false });
  const names = Array.isArray(systemNames) ? systemNames : [systemNames];
  for (const name of names) {
    if (!name) continue;
    const value = system?.[name] ?? behavior?.system?.[name];
    if (value !== undefined && value !== null) return value;
  }
  const flagValue = behavior?.getFlag?.(packageId, flagName);
  return flagValue !== undefined && flagValue !== null ? flagValue : fallback;
}

/** @param {*} behavior @returns {string} */
export function fxmGetRegionBehaviorGateMode(behavior) {
  return String(fxmGetRegionBehaviorValue(behavior, "gateMode", "_elev_gateMode", "none") ?? "none");
}

/** @param {*} behavior @returns {string[]} */
export function fxmGetRegionBehaviorTokenTargets(behavior) {
  return normalizeStringArray(fxmGetRegionBehaviorValue(behavior, "tokenTargets", "_elev_tokenTargets", []));
}

/** @param {*} behavior @returns {boolean} */
export function fxmGetRegionBehaviorGMAlwaysVisible(behavior) {
  return !!fxmGetRegionBehaviorValue(behavior, "gmAlwaysVisible", "_elev_gmAlwaysVisible", false);
}

/** @param {*} behavior @returns {number} */
export function fxmGetRegionBehaviorEdgeFadePercent(behavior) {
  const value = Number(fxmGetRegionBehaviorValue(behavior, "edgeFadePercent", "_edgeFadePercent", 0));
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0;
}

function eventModeFromBehaviorEvents(behavior, system) {
  const rawEvents = system?.events ?? behavior?.events ?? null;
  const events = rawEvents instanceof Set ? rawEvents : new Set(normalizeStringArray(rawEvents));
  const ENTER = globalThis.CONST?.REGION_EVENTS?.TOKEN_ENTER;
  const EXIT = globalThis.CONST?.REGION_EVENTS?.TOKEN_EXIT;
  const hasEnter =
    (ENTER !== undefined && events.has(String(ENTER))) ||
    events.has(ENTER) ||
    events.has("tokenEnter") ||
    events.has("TOKEN_ENTER");
  const hasExit =
    (EXIT !== undefined && events.has(String(EXIT))) ||
    events.has(EXIT) ||
    events.has("tokenExit") ||
    events.has("TOKEN_EXIT");
  if (hasEnter && hasExit) return "enterExit";
  if (hasEnter) return "enter";
  if (hasExit) return "exitOnly";
  return null;
}

/** @param {*} behavior @param {object} [system] @returns {{mode:string,latched:boolean}} */
export function fxmGetRegionBehaviorEventGate(
  behavior,
  system = fxmGetRegionBehaviorSystem(behavior, { snapshot: false }),
) {
  const flagGate = behavior?.getFlag?.(packageId, "eventGate") ?? null;
  const systemGate = system?.eventGate ?? system?._eventGate ?? null;
  const selectedMode = eventModeFromBehaviorEvents(behavior, system);
  const mode = selectedMode ?? systemGate?.mode ?? flagGate?.mode ?? "none";
  const latched = flagGate?.mode === mode || selectedMode == null ? !!flagGate?.latched : !!systemGate?.latched;
  return { mode, latched };
}

/** @param {*} behavior @param {string} [packageIdOverride] @param {{snapshot?:boolean}} [options] @returns {object} */
export function fxmReadRegionBehaviorRuntimeState(behavior, packageIdOverride = packageId, { snapshot = true } = {}) {
  const flag = (key) => behavior?.getFlag?.(packageIdOverride, key);
  const system = fxmGetRegionBehaviorSystem(behavior, { snapshot });
  const gateMode = String(system?._elev_gateMode ?? flag("gateMode") ?? "none");
  const tokenTargets = normalizeStringArray(system?._elev_tokenTargets ?? flag("tokenTargets") ?? []);
  const edgeFade = Number(system?._edgeFadePercent ?? flag("edgeFadePercent") ?? 0);
  const eventGate = fxmGetRegionBehaviorEventGate(behavior, system);
  return {
    gmAlwaysVisible: Boolean(system?._elev_gmAlwaysVisible ?? flag("gmAlwaysVisible") ?? false),
    gateMode,
    tokenTargets,
    edgeFadePercent: Number.isFinite(edgeFade) ? Math.min(Math.max(edgeFade, 0), 1) : 0,
    eventGate,
    system,
  };
}

/** @param {*} behavior @returns {string} */
export function fxmRegionBehaviorRuntimeSignature(behavior) {
  const state = fxmReadRegionBehaviorRuntimeState(behavior, packageId, { snapshot: false });
  return [
    fxmDocumentId(behavior),
    behavior?.type ?? "",
    behavior?.disabled ? 1 : 0,
    state.gmAlwaysVisible ? 1 : 0,
    state.gateMode,
    state.eventGate?.mode ?? "none",
    state.eventGate?.latched ? 1 : 0,
    state.tokenTargets.join(","),
    state.edgeFadePercent.toFixed(4),
  ].join("~");
}

function buildRegionEffectDefinitionsFromSystem(behavior, kind) {
  const system = fxmGetRegionBehaviorSystem(behavior);
  const db =
    kind === "filter"
      ? globalThis.CONFIG?.fxmaster?.filterEffects
      : { ...globalThis.CONFIG?.fxmaster?.legacyParticleEffects, ...globalThis.CONFIG?.fxmaster?.particleEffects };
  if (!db || !system || typeof system !== "object") return null;
  const out = {};
  const regionOnly = kind === "filter" ? { fadePercent: { type: "range" } } : {};
  const preview = behavior?.__fxmLivePreview === true;

  for (const [type, cls] of Object.entries(db)) {
    if (!system?.[`${type}_enabled`]) continue;
    const options = {};
    const paramEntries = [
      ...Object.entries(cls?.parameters ?? {}).filter(([, cfg]) => !cfg?.sceneOnly && cfg?.type !== "filter-actions"),
      ...Object.entries(regionOnly),
    ];
    for (const [param, cfg] of paramEntries) {
      if (cfg?.type === "color") {
        options[param] = { apply: system[`${type}_${param}_apply`], value: system[`${type}_${param}`] };
      } else if (cfg?.type === "multi-select") {
        options[param] = normalizeStringArray(system[`${type}_${param}`]);
      } else if (cfg?.type === "range-dual") {
        options[param] = normalizeDarknessActivationRange({
          min: system[`${type}_${param}_min`],
          max: system[`${type}_${param}_max`],
        });
      } else {
        options[param] = system[`${type}_${param}`];
      }
    }
    for (const [key, value] of Object.entries(options)) if (value === undefined || value === null) delete options[key];
    out[type] = kind === "filter" ? { type, options } : { options };
  }
  if (Object.keys(out).length) return out;
  return preview ? {} : null;
}

/** @param {*} behavior @param {"particle"|"filter"} kind @returns {object} */
export function fxmGetRegionBehaviorEffectDefinitions(behavior, kind) {
  const fromSystem = buildRegionEffectDefinitionsFromSystem(behavior, kind);
  const flagName = kind === "filter" ? "filters" : "particleEffects";
  const persisted = behavior?.getFlag?.(packageId, flagName) ?? {};

  if (fromSystem) {
    if (kind === "particle") {
      for (const [type, definition] of Object.entries(fromSystem)) {
        const state = persisted?.[type]?.state;
        if (!state || typeof state !== "object") continue;
        definition.state = foundry.utils.deepClone(state);
      }
    }
    return fromSystem;
  }

  return persisted;
}

/** Backwards-compatible unprefixed helpers for runtime imports. */
export const getRegionBehaviorEdgeFadePercent = fxmGetRegionBehaviorEdgeFadePercent;
export const getRegionBehaviorRuntimeSignature = fxmRegionBehaviorRuntimeSignature;
export const getRegionParticleEffectDefinitions = (behavior) =>
  fxmGetRegionBehaviorEffectDefinitions(behavior, "particle");
export const getRegionFilterEffectDefinitions = (behavior) => fxmGetRegionBehaviorEffectDefinitions(behavior, "filter");

/** Public-field configured image candidates used for fallback placement detection. */
export function fxmGetLevelImageCandidates(level, { foregroundOnly = false } = {}) {
  if (!level) return [];
  const base = [
    fxmGetLevelTextures(level),
    level?.texture,
    level?.bounds,
    level?.rect,
    level?.rectangle,
    level?.dimensions,
  ];
  if (foregroundOnly) {
    base.push(
      fxmGetLevelForeground(level),
      fxmGetLevelForeground(level)?.textures,
      fxmGetLevelForeground(level)?.texture,
    );
  } else {
    base.push(
      fxmGetLevelBackground(level),
      fxmGetLevelForeground(level),
      fxmGetLevelBackground(level)?.textures,
      fxmGetLevelForeground(level)?.textures,
      fxmGetLevelBackground(level)?.texture,
      fxmGetLevelForeground(level)?.texture,
    );
  }
  return base.filter((candidate) => candidate !== undefined && candidate !== null);
}

/** Backwards-compatible alias for configured public Level image paths. */
export const fxmGetLevelImagePaths = fxmGetLevelConfiguredImagePaths;

/** Backwards-compatible alias for configured-source Level id resolution. */
export function fxmResolveLevelIdsForComparableSourcePaths(
  sourcePaths,
  scene = fxmCanvas()?.scene ?? null,
  options = {},
) {
  return fxmResolveLevelIdsFromConfiguredSources(sourcePaths, { ...options, scene });
}
