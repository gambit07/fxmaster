/**
 * Foundry integration helpers for Level, Region, Token, Tile, and Scene APIs.
 */

import { packageId } from "../constants.js";
import { normalizeDarknessActivationRange } from "./darkness.js";

let _snapshotFrameKey = null;
let _snapshotCache = new WeakMap();
let _levelTexturePlanCache = new Map();
const LEVEL_TEXTURE_PLAN_CACHE_MAX = 16;

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

/** @param {*} value @returns {Array} */
export function fxmCollectionValues(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  if (Array.isArray(value?.contents)) return value.contents.filter(Boolean);
  if (typeof value?.toArray === "function") {
    try {
      return value.toArray().filter(Boolean);
    } catch (_err) {
      return [];
    }
  }
  if (typeof value?.values === "function") {
    try {
      return Array.from(value.values()).filter(Boolean);
    } catch (_err) {
      return [];
    }
  }
  try {
    return Array.from(value).filter(Boolean);
  } catch (_err) {
    return value ? [value] : [];
  }
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
 * Resolve hover-fade state for Foundry primary occludable objects.
 *
 * Foundry V13/V14 expose hover-fade behavior but not a public state accessor. The internal state fallback is intentionally centralized here.
 *
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
 * Resolve protected PlaceableObject target alpha when public alpha values are insufficient.
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

export function fxmUpdateDisplayObjectWorldTransform(object) {
  if (!object || typeof object !== "object") return false;
  try {
    if (object.parent?.transform) {
      object.updateTransform?.();
      return true;
    }
    if (typeof object.enableTempParent === "function" && typeof object.disableTempParent === "function") {
      const cacheParent = object.enableTempParent();
      try {
        object.updateTransform?.();
      } finally {
        object.disableTempParent(cacheParent);
      }
      return true;
    }
    object.updateTransform?.();
    return true;
  } catch (_err) {
    return false;
  }
}

/** @param {*} object @returns {string} */
export function fxmDisplayObjectTransformSignature(object) {
  const m = object?.worldTransform ?? object?.transform?.worldTransform ?? null;
  if (!m) return "";
  return [m.a, m.b, m.c, m.d, m.tx, m.ty].map((value) => Number(value || 0).toFixed(4)).join(",");
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

/** @param {*} level @returns {{min:number,max:number}|null} */
export function fxmGetLevelElevationWindow(level) {
  if (!level) return null;
  const elevation = level?.elevation ?? null;
  const scalar = Number(elevation);
  if (Number.isFinite(scalar)) return { min: scalar, max: scalar };

  const bottom = elevation?.bottom ?? level?.bottom;
  const top = elevation?.top ?? level?.top;
  const hasBottom = bottom !== undefined && bottom !== null && String(bottom).trim() !== "";
  const hasTop = top !== undefined && top !== null && String(top).trim() !== "";
  if (hasBottom || hasTop) {
    return {
      min: hasBottom ? Number(bottom) : Number.NEGATIVE_INFINITY,
      max: hasTop ? Number(top) : Number.POSITIVE_INFINITY,
    };
  }

  const fallback = fxmReadDocumentSnapshotValue(level, "elevation");
  if (fallback !== undefined) {
    const fallbackScalar = Number(fallback);
    if (Number.isFinite(fallbackScalar)) return { min: fallbackScalar, max: fallbackScalar };
    const fallbackBottom = fallback?.bottom;
    const fallbackTop = fallback?.top;
    const hasFallbackBottom =
      fallbackBottom !== undefined && fallbackBottom !== null && String(fallbackBottom).trim() !== "";
    const hasFallbackTop = fallbackTop !== undefined && fallbackTop !== null && String(fallbackTop).trim() !== "";
    if (hasFallbackBottom || hasFallbackTop) {
      return {
        min: hasFallbackBottom ? Number(fallbackBottom) : Number.NEGATIVE_INFINITY,
        max: hasFallbackTop ? Number(fallbackTop) : Number.POSITIVE_INFINITY,
      };
    }
  }
  return null;
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

  pushAll(scene?.levels?.sorted ?? null);
  pushAll(scene?.levels?.contents ?? scene?.levels ?? null);
  try {
    pushAll(scene?.getEmbeddedCollection?.("Level"));
  } catch (_err) {}
  try {
    push(scene?.initialLevel);
  } catch (_err) {}
  try {
    push(scene?.firstLevel);
  } catch (_err) {}
  try {
    if (!scene?.id || fxmCanvas()?.scene?.id === scene.id) push(fxmCanvas()?.level);
  } catch (_err) {}
  try {
    pushAll(scene?.availableLevels);
  } catch (_err) {}
  return levels;
}

/** @param {string} levelId @param {*} [scene] @returns {*} */
export function fxmGetSceneLevelById(levelId, scene = fxmCanvas()?.scene ?? null) {
  const id = String(levelId ?? "").trim();
  if (!id) return null;
  return fxmGetSceneLevels(scene).find((level) => fxmDocumentId(level) === id) ?? null;
}

/** @param {string|null|undefined} sourcePath @returns {string} */
export function fxmNormalizeComparableSourcePath(sourcePath) {
  if (typeof sourcePath !== "string") return "";
  const trimmed = sourcePath.trim();
  if (!trimmed) return "";
  const originPattern = new RegExp("^https?:\\/\\/[^/]+", "i");
  const filePattern = new RegExp("^file:\\/\\/", "i");
  const normalize = (value) =>
    value
      .replace(originPattern, "")
      .replace(filePattern, "")
      .replace(/^\/+/, "")
      .replace(/\?.*$/, "")
      .replace(/#.*$/, "");
  try {
    return normalize(decodeURI(trimmed));
  } catch (_err) {
    return normalize(trimmed);
  }
}

/** @param {Set<string>} output @param {*} candidate @returns {void} */
export function fxmAddComparableSourcePath(output, candidate) {
  if (!(output instanceof Set) || typeof candidate !== "string") return;
  const normalized = fxmNormalizeComparableSourcePath(candidate);
  if (normalized) output.add(normalized);
}

/** @param {*} value @param {Set<string>} [output] @param {Set<object>} [seen] @returns {Set<string>} */
export function fxmCollectComparableSourcePaths(value, output = new Set(), seen = new Set()) {
  if (!value || !(output instanceof Set)) return output;
  if (typeof value === "string") {
    fxmAddComparableSourcePath(output, value);
    return output;
  }
  if (typeof value !== "object" && typeof value !== "function") return output;
  if (seen.has(value)) return output;
  seen.add(value);

  const directCandidates = [
    value?.src,
    value?.currentSrc,
    value?.url,
    value?.href,
    value?.path,
    value?.img,
    value?.cacheId,
    value?.texture?.src,
    value?.texture?.url,
    value?.texture?.path,
    value?.texture?.baseTexture?.resource?.src,
    value?.texture?.baseTexture?.resource?.url,
    value?.texture?.baseTexture?.cacheId,
    value?.baseTexture?.resource?.src,
    value?.baseTexture?.resource?.url,
    value?.baseTexture?.cacheId,
    value?.resource?.src,
    value?.resource?.url,
    value?.document?.texture?.src,
    value?.document?.src,
    value?.document?.img,
  ];
  for (const candidate of directCandidates) fxmAddComparableSourcePath(output, candidate);

  if (Array.isArray(value?.textureCacheIds)) {
    for (const candidate of value.textureCacheIds) fxmAddComparableSourcePath(output, candidate);
  }

  for (const nested of [
    value?.texture,
    value?.baseTexture,
    value?.resource,
    value?.source,
    value?.parentTextureArray,
    value?.object,
    value?.placeable,
    value?.level,
    value?.levels,
    value?.document,
  ]) {
    if (!nested || nested === value) continue;
    fxmCollectComparableSourcePaths(nested, output, seen);
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
    const textures = fxmCollectComparableSourcePaths(fxmGetLevelTextures(level), new Set());
    parts.push(
      [
        fxmDocumentId(level),
        fxmLevelIsView(level) ? 1 : 0,
        fxmLevelIsVisible(level) ? 1 : 0,
        Number.isFinite(elevation?.min) ? Number(elevation.min).toFixed(3) : "NaN",
        Number.isFinite(elevation?.max) ? Number(elevation.max).toFixed(3) : "NaN",
        fxmNormalizeComparableSourcePath(bg),
        fxmNormalizeComparableSourcePath(fg),
        Array.from(textures).sort().join(","),
      ].join("~"),
    );
  }
  return parts.join("|");
}

/**
 * Build a cached Level texture plan from public Level fields. This mirrors the useful public-field semantics of Foundry's internal Level texture setup while avoiding private/internal calls.
 *
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

    const extraPaths = fxmCollectComparableSourcePaths(fxmGetLevelTextures(level), new Set());
    if (extraPaths.size) {
      const entry = {
        level,
        levelId,
        name: "textures",
        config: fxmGetLevelTextures(level),
        src: "",
        normalizedSrc: "",
        elevation: top,
        sort: 0,
        zIndex: 0,
        isBackground: false,
        isForeground: false,
        isView,
        isVisible,
        isUpper: !isView && Number.isFinite(top) && Number.isFinite(viewedBottom) && top > viewedBottom + 1e-4,
        paths: extraPaths,
      };
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
    : [fxmGetLevelBackground(level), fxmGetLevelForeground(level), fxmGetLevelTextures(level)];
  for (const config of configs) {
    const direct = fxmResolveConfiguredImageSourcePath(config);
    if (direct) fxmAddComparableSourcePath(paths, direct);
    fxmCollectComparableSourcePaths(config, paths);
  }
  return paths;
}

/** @param {Set<string>} sourcePaths @param {{foregroundOnly?:boolean,scene?:*}} [options] @returns {Set<string>} */
export function fxmResolveLevelIdsFromConfiguredSources(
  sourcePaths,
  { foregroundOnly = false, scene = fxmCanvas()?.scene ?? null } = {},
) {
  const ids = new Set();
  if (!(sourcePaths?.size > 0)) return ids;
  const plan = fxmGetLevelTexturePlan(scene);
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
  if (raw instanceof Set) return new Set(Array.from(raw).map(String).filter(Boolean));
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

/** @param {*} document @param {number} [fallbackElevation] @returns {{min:number,max:number}|null} */
export function fxmGetDocumentElevationWindow(document, fallbackElevation = Number.NaN) {
  const doc = document?.document ?? document ?? null;
  const snapshot = fxmReadDocumentSnapshotCompat(doc) ?? fxmReadDocumentSnapshotCompat(document);
  const elevation = doc?.elevation ?? document?.elevation ?? snapshot?.elevation ?? null;
  const scalar = Number(elevation);
  if (Number.isFinite(scalar)) return { min: scalar, max: scalar };
  const bottom = elevation?.bottom ?? doc?.bottom ?? snapshot?.elevation?.bottom ?? snapshot?.bottom;
  const top = elevation?.top ?? doc?.top ?? snapshot?.elevation?.top ?? snapshot?.top;
  const hasBottom = bottom !== undefined && bottom !== null && String(bottom).trim() !== "";
  const hasTop = top !== undefined && top !== null && String(top).trim() !== "";
  if (hasBottom || hasTop) {
    return {
      min: hasBottom ? Number(bottom) : Number.NEGATIVE_INFINITY,
      max: hasTop ? Number(top) : Number.POSITIVE_INFINITY,
    };
  }
  const fallback = Number(fallbackElevation);
  return Number.isFinite(fallback) ? { min: fallback, max: fallback } : null;
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

/** @param {*} behavior @returns {object} */
export function fxmGetRegionBehaviorSystem(behavior) {
  if (!behavior) return {};
  const system = behavior.system ?? behavior.typeData ?? null;
  if (system && typeof system === "object") {
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
  const system = fxmGetRegionBehaviorSystem(behavior);
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

/** @param {*} behavior @returns {{mode:string,latched:boolean}} */
export function fxmGetRegionBehaviorEventGate(behavior) {
  const system = fxmGetRegionBehaviorSystem(behavior);
  const flagGate = behavior?.getFlag?.(packageId, "eventGate") ?? null;
  const systemGate = system?.eventGate ?? system?._eventGate ?? null;
  const selectedMode = eventModeFromBehaviorEvents(behavior, system);
  const mode = selectedMode ?? systemGate?.mode ?? flagGate?.mode ?? "none";
  const latched = flagGate?.mode === mode || selectedMode == null ? !!flagGate?.latched : !!systemGate?.latched;
  return { mode, latched };
}

/** @param {*} behavior @param {string} [packageIdOverride] @returns {object} */
export function fxmReadRegionBehaviorRuntimeState(behavior, packageIdOverride = packageId) {
  const flag = (key) => behavior?.getFlag?.(packageIdOverride, key);
  const system = fxmGetRegionBehaviorSystem(behavior);
  const gateMode = String(system?._elev_gateMode ?? flag("gateMode") ?? "none");
  const tokenTargets = normalizeStringArray(system?._elev_tokenTargets ?? flag("tokenTargets") ?? []);
  const edgeFade = Number(system?._edgeFadePercent ?? flag("edgeFadePercent") ?? 0);
  const eventGate = fxmGetRegionBehaviorEventGate(behavior);
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
  const state = fxmReadRegionBehaviorRuntimeState(behavior);
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
    kind === "filter" ? globalThis.CONFIG?.fxmaster?.filterEffects : globalThis.CONFIG?.fxmaster?.particleEffects;
  if (!db || !system || typeof system !== "object") return null;
  const out = {};
  const regionOnly = kind === "filter" ? { fadePercent: { type: "range" } } : {};
  const preview = behavior?.__fxmLivePreview === true;

  for (const [type, cls] of Object.entries(db)) {
    if (!system?.[`${type}_enabled`]) continue;
    const options = {};
    const paramEntries = [
      ...Object.entries(cls?.parameters ?? {}).filter(([, cfg]) => !cfg?.sceneOnly),
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
  if (fromSystem) return fromSystem;
  const flagName = kind === "filter" ? "filters" : "particleEffects";
  return behavior?.getFlag?.(packageId, flagName) ?? {};
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
