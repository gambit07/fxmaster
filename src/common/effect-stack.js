import { packageId } from "../constants.js";
import { logger } from "../logger.js";
import { compositeGridInFxStack } from "../settings-access.js";
import { getSceneRegionDocuments } from "../utils/compat.js";
import { fxmGetRegionBehaviorEffectDefinitions } from "../utils/foundry-public.js";

const STACK_FLAG = "stack";
const SUPPRESS_WEATHER = "suppressWeather";
const SUPPRESS_SCENE_PARTICLES = `${packageId}.suppressSceneParticles`;
const SUPPRESS_SCENE_FILTERS = `${packageId}.suppressSceneFilters`;
const SUPPRESSION_LEGACY_ORDER = 2000;
export const FOUNDRY_GRID_STACK_UID = "scene:grid:foundry";
const LEGACY_SOURCE_ORDER = {
  "particle:belowDarkness": 100,
  "particle:aboveDarkness": 200,
  filter: 300,
};

const API_PRESET_EFFECT_ID_PREFIX = "apiPreset_";
const API_MACRO_EFFECT_ID_PREFIX = "apiMacro_";

let _effectStackCacheGeneration = 0;
const _orderedEffectRowsCache = new Map();
const _orderedEffectRenderRowsCache = new Map();

/**
 * Invalidate cached ordered stack rows. Rendering asks for the same static row list every compositor tick, while the data only changes on scene flag or Region/behavior document updates. Hooks call this when those documents change.
 *
 * @returns {void}
 */
export function invalidateEffectStackCache() {
  _effectStackCacheGeneration = (_effectStackCacheGeneration + 1) & 0x7fffffff;
  _orderedEffectRowsCache.clear();
  _orderedEffectRenderRowsCache.clear();
}

function _effectStackCacheKey(scene, purpose) {
  if (!scene?.id) return null;
  return `${purpose}:${scene.id}:${_effectStackCacheGeneration}`;
}

function _cloneRowsForConsumer(rows) {
  return Array.isArray(rows) ? rows.map((row) => ({ ...row })) : [];
}

/**
 * Return the scene flag path used to persist the ordered FX stack.
 *
 * @returns {string}
 */
export function getEffectStackFlagName() {
  return STACK_FLAG;
}

/**
 * Return whether a scene-scoped effect id belongs to the built-in management windows.
 *
 * @param {string} effectId
 * @returns {boolean}
 */
export function isCoreSceneEffectId(effectId) {
  return typeof effectId === "string" && effectId.startsWith("core_");
}

/**
 * Resolve a scene-scoped effect id into the source bucket used by stack/API management UIs.
 *
 * @param {string} effectId
 * @returns {{source: "scene"|"api", apiSource: "preset"|"macro"|"generic"|null, sourceLabel: string}}
 */
export function getSceneEffectSourceInfo(effectId) {
  const id = String(effectId ?? "");
  if (isCoreSceneEffectId(id)) {
    return {
      source: "scene",
      apiSource: null,
      sourceLabel: game.i18n.localize("FXMASTER.Layers.SourceScene"),
    };
  }

  if (id.startsWith(API_PRESET_EFFECT_ID_PREFIX)) {
    return {
      source: "api",
      apiSource: "preset",
      sourceLabel: game.i18n.localize("FXMASTER.Layers.SourceApiPreset"),
    };
  }

  if (id.startsWith(API_MACRO_EFFECT_ID_PREFIX)) {
    return {
      source: "api",
      apiSource: "macro",
      sourceLabel: game.i18n.localize("FXMASTER.Layers.SourceApiMacro"),
    };
  }

  return {
    source: "api",
    apiSource: "generic",
    sourceLabel: game.i18n.localize("FXMASTER.Layers.SourceApi"),
  };
}

/**
 * Build a stable UID for a scene-scoped effect entry.
 *
 * @param {"particle"|"filter"} kind
 * @param {string} effectId
 * @returns {string}
 */
export function buildSceneEffectUid(kind, effectId) {
  return `scene:${kind}:${effectId}`;
}

/**
 * Build a stable UID for a region-behavior-scoped effect entry.
 *
 * @param {"particle"|"filter"} kind
 * @param {string} regionId
 * @param {string} behaviorId
 * @param {string} effectId
 * @returns {string}
 */
export function buildRegionEffectUid(kind, regionId, behaviorId, effectId) {
  return `region:${kind}:${regionId}:${behaviorId}:${effectId}`;
}

/**
 * Build a stable UID for a Region suppression behavior stack operator.
 *
 * @param {"particles"|"filters"|"all"} suppressionKind
 * @param {string} regionId
 * @param {string} behaviorId
 * @returns {string}
 */
export function buildSuppressionEffectUid(suppressionKind, regionId, behaviorId) {
  return `region:suppression:${suppressionKind}:${regionId}:${behaviorId}`;
}

/**
 * Return a display/render row for the native Foundry grid stack position.
 *
 * @param {Scene|null|undefined} scene
 * @param {boolean} [full=true]
 * @returns {object}
 */
function buildFoundryGridStackRow(scene, full = true) {
  const label = game.i18n.localize("FXMASTER.Layers.FoundryGrid");
  const row = {
    uid: FOUNDRY_GRID_STACK_UID,
    kind: "grid",
    scope: "scene",
    source: "scene",
    sourceLabel: game.i18n.localize("FXMASTER.Layers.SourceScene"),
    ownerId: scene?.id ?? null,
    effectId: "foundry-grid",
    effectType: "grid",
    legacyOrder: -10000,
    discoveryIndex: Number.MAX_SAFE_INTEGER,
    layerLevel: null,
    options: {},
  };

  if (!full) return row;

  return {
    ...row,
    ownerName: scene?.name ?? "",
    ownerLabel: scene?.name ?? game.i18n.localize("FXMASTER.Common.Unknown"),
    label,
    icon: "fas fa-border-all",
    kindLabel: game.i18n.localize("FXMASTER.Layers.KindGrid"),
    effectTypeLabel: label,
  };
}

/**
 * Return whether a suppression stack kind affects a scene-effect pipeline.
 *
 * @param {string|null|undefined} suppressionKind
 * @param {"particles"|"filters"} pipelineKind
 * @returns {boolean}
 */
export function suppressionKindAffectsPipeline(suppressionKind, pipelineKind) {
  const kind = String(suppressionKind ?? "");
  if (kind === "all") return true;
  return pipelineKind === "filters" ? kind === "filters" : kind === "particles";
}

/**
 * Parse a stored FX stack UID.
 *
 * @param {string} uid
 * @returns {object|null}
 */
export function parseEffectUid(uid) {
  if (typeof uid !== "string") return null;
  const parts = uid.split(":");
  if (parts[0] === "scene" && parts.length >= 3) {
    const [, kind, ...rest] = parts;
    return { scope: "scene", kind, effectId: rest.join(":") };
  }
  if (parts[0] === "region" && parts[1] === "suppression" && parts.length >= 5) {
    const [, , suppressionKind, regionId, behaviorId] = parts;
    return { scope: "region", kind: "suppression", suppressionKind, regionId, behaviorId };
  }
  if (parts[0] === "region" && parts.length >= 5) {
    const [, kind, regionId, behaviorId, ...rest] = parts;
    return { scope: "region", kind, regionId, behaviorId, effectId: rest.join(":") };
  }
  return null;
}

/**
 * Normalize a behavior collection into a plain array.
 *
 * @param {Iterable<object>|{contents?: object[]}|null|undefined} behaviorDocs
 * @returns {object[]}
 */
export function normalizeBehaviorDocs(behaviorDocs) {
  if (!behaviorDocs) return [];
  if (Array.isArray(behaviorDocs)) return behaviorDocs;
  if (Array.isArray(behaviorDocs.contents)) return behaviorDocs.contents;
  if (typeof behaviorDocs.toArray === "function") return behaviorDocs.toArray();
  if (typeof behaviorDocs.values === "function") return Array.from(behaviorDocs.values());
  return Array.from(behaviorDocs);
}

/**
 * Read the persisted ordered stack list for a scene.
 *
 * @param {Scene|null|undefined} scene
 * @returns {Array<{uid: string}>}
 */
export function getStoredEffectStack(scene = canvas?.scene ?? null) {
  const raw = scene?.getFlag?.(packageId, STACK_FLAG);
  return Array.isArray(raw) ? raw.filter((entry) => entry && typeof entry.uid === "string") : [];
}

/**
 * Persist a reordered FX stack to the active scene.
 *
 * @param {string[]} orderedUids
 * @param {Scene|null|undefined} scene
 * @returns {Promise<void>}
 */
export async function setStoredEffectStack(orderedUids, scene = canvas?.scene ?? null) {
  if (!scene) return;
  const next = Array.from(new Set((orderedUids ?? []).filter((uid) => typeof uid === "string"))).map((uid) => ({
    uid,
  }));
  await scene.setFlag(packageId, STACK_FLAG, next);
  invalidateEffectStackCache();
}

/**
 * Promote the supplied effect rows to the top of the persisted scene stack.
 *
 * The first uid in the provided list becomes the highest layer. Missing or stale uids are ignored automatically against the current enabled-row snapshot.
 *
 * @param {string[]} uids
 * @param {Scene|null|undefined} scene
 * @returns {Promise<void>}
 */
export async function promoteEffectStackUids(uids, scene = canvas?.scene ?? null) {
  if (!scene) return;

  const requested = Array.from(new Set((uids ?? []).filter((uid) => typeof uid === "string")));
  if (!requested.length) return;

  const currentRows = getOrderedEnabledEffectRows(scene);
  const current = currentRows.map((row) => row.uid).filter((uid) => typeof uid === "string");
  if (!current.length) return;

  const rowByUid = new Map(currentRows.map((row) => [row.uid, row]));
  const available = new Set(current);
  const promoted = requested.filter((uid) => available.has(uid));
  if (!promoted.length) return;

  const promotedSet = new Set(promoted);
  const promotedSuppression = promoted.filter((uid) => rowByUid.get(uid)?.kind === "suppression");
  const promotedEffects = promoted.filter((uid) => rowByUid.get(uid)?.kind !== "suppression");
  const remaining = current.filter((uid) => !promotedSet.has(uid));
  const leadingSuppression = [];
  while (remaining.length && rowByUid.get(remaining[0])?.kind === "suppression")
    leadingSuppression.push(remaining.shift());
  const next = [...promotedSuppression, ...leadingSuppression, ...promotedEffects, ...remaining];

  if (next.length === current.length && next.every((uid, index) => uid === current[index])) return;
  await setStoredEffectStack(next, scene);
}

/**
 * Remove the persisted FX stack flag from the active scene.
 *
 * @param {Scene|null|undefined} scene
 * @returns {Promise<void>}
 */
export async function clearStoredEffectStack(scene = canvas?.scene ?? null) {
  if (!scene) return;
  await scene.unsetFlag(packageId, STACK_FLAG);
  invalidateEffectStackCache();
}

/**
 * Return metadata for a Region behavior that acts as a scene suppression stack operator.
 *
 * @param {object|null|undefined} behavior
 * @returns {{ suppressionKind: "particles"|"filters"|"all", labelKey: string, icon: string, behaviorType: string }|null}
 */
function getSuppressionBehaviorRowInfo(behavior) {
  const type = String(behavior?.type ?? "");
  if (type === SUPPRESS_SCENE_PARTICLES) {
    return {
      suppressionKind: "particles",
      labelKey: "FXMASTER.Layers.SuppressSceneParticles",
      icon: "fas fa-cloud-slash",
      behaviorType: SUPPRESS_SCENE_PARTICLES,
    };
  }
  if (type === SUPPRESS_SCENE_FILTERS) {
    return {
      suppressionKind: "filters",
      labelKey: "FXMASTER.Layers.SuppressSceneFilters",
      icon: "fas fa-ban",
      behaviorType: SUPPRESS_SCENE_FILTERS,
    };
  }
  if (type === SUPPRESS_WEATHER) {
    return {
      suppressionKind: "all",
      labelKey: "FXMASTER.Layers.SuppressWeather",
      icon: "fas fa-cloud-slash",
      behaviorType: SUPPRESS_WEATHER,
    };
  }
  return null;
}

/**
 * Localize a suppression behavior label.
 *
 * @param {string} labelKey
 * @returns {string}
 */
function localizeSuppressionLabel(labelKey) {
  try {
    return game.i18n.localize(labelKey);
  } catch (err) {
    logger.debug("FXMaster: failed to localize suppression label", err);
    return String(labelKey ?? "Suppression");
  }
}

/**
 * Collect every enabled scene-level and region-level FX stack row for the supplied scene.
 *
 * @param {Scene|null|undefined} scene
 * @returns {Array<object>}
 */
export function collectEnabledEffectRows(scene = canvas?.scene ?? null) {
  if (!scene) return [];

  const rows = [];
  const pushRow = (row) => {
    if (!row?.uid) return;
    rows.push(row);
  };

  const getEffectLabel = (kind, type) => {
    const db = kind === "particle" ? CONFIG?.fxmaster?.particleEffects : CONFIG?.fxmaster?.filterEffects;
    const def = type && db ? db[type] : null;
    const raw = def?.label ?? type ?? game.i18n.localize("FXMASTER.Common.Unknown");
    try {
      return game.i18n.localize(raw);
    } catch (err) {
      logger.debug("FXMaster: failed to localize effect label", err);
      return String(raw ?? type ?? "Unknown");
    }
  };

  const getLayerLevel = (type) => {
    const db = CONFIG?.fxmaster?.particleEffects ?? {};
    return db?.[type]?.defaultConfig?.layerLevel ?? "belowDarkness";
  };

  const sceneEffects = scene.getFlag(packageId, "effects") ?? {};
  let discoveryIndex = 0;
  for (const [effectId, info] of Object.entries(sceneEffects)) {
    if (!info || typeof info !== "object" || !info.type) continue;
    const type = String(info.type);
    const uid = buildSceneEffectUid("particle", effectId);
    const sourceInfo = getSceneEffectSourceInfo(effectId);
    const layerLevel = getLayerLevel(type);
    pushRow({
      uid,
      kind: "particle",
      scope: "scene",
      source: sourceInfo.source,
      apiSource: sourceInfo.apiSource,
      sourceLabel: sourceInfo.sourceLabel,
      ownerId: scene.id,
      ownerName: scene.name,
      ownerLabel: scene.name,
      effectId,
      effectType: type,
      label: getEffectLabel("particle", type),
      icon: "fas fa-cloud-rain",
      kindLabel: game.i18n.localize("FXMASTER.Layers.KindParticle"),
      effectTypeLabel: getEffectLabel("particle", type),
      legacyOrder: LEGACY_SOURCE_ORDER[`particle:${layerLevel}`] ?? LEGACY_SOURCE_ORDER["particle:belowDarkness"],
      discoveryIndex: discoveryIndex++,
      layerLevel,
      options: info?.options ?? {},
    });
  }

  const sceneFilters = scene.getFlag(packageId, "filters") ?? {};
  for (const [effectId, info] of Object.entries(sceneFilters)) {
    if (!info || typeof info !== "object" || !info.type) continue;
    const type = String(info.type);
    const uid = buildSceneEffectUid("filter", effectId);
    const sourceInfo = getSceneEffectSourceInfo(effectId);
    pushRow({
      uid,
      kind: "filter",
      scope: "scene",
      source: sourceInfo.source,
      apiSource: sourceInfo.apiSource,
      sourceLabel: sourceInfo.sourceLabel,
      ownerId: scene.id,
      ownerName: scene.name,
      ownerLabel: scene.name,
      effectId,
      effectType: type,
      label: getEffectLabel("filter", type),
      icon: "fas fa-filter",
      kindLabel: game.i18n.localize("FXMASTER.Layers.KindFilter"),
      effectTypeLabel: getEffectLabel("filter", type),
      legacyOrder: LEGACY_SOURCE_ORDER.filter,
      discoveryIndex: discoveryIndex++,
      layerLevel: null,
      options: info?.options ?? {},
    });
  }

  const regions = getSceneRegionDocuments(scene);
  for (const regionDoc of regions) {
    const behaviorDocs = normalizeBehaviorDocs(regionDoc.behaviors);
    for (const behavior of behaviorDocs) {
      if (!behavior || behavior.disabled) continue;

      const suppressionInfo = getSuppressionBehaviorRowInfo(behavior);
      if (suppressionInfo) {
        const label = localizeSuppressionLabel(suppressionInfo.labelKey);
        pushRow({
          uid: buildSuppressionEffectUid(suppressionInfo.suppressionKind, regionDoc.id, behavior.id),
          kind: "suppression",
          suppressionKind: suppressionInfo.suppressionKind,
          behaviorType: suppressionInfo.behaviorType,
          scope: "region",
          source: "region",
          sourceLabel: game.i18n.localize("FXMASTER.Layers.SourceRegion"),
          ownerId: regionDoc.id,
          ownerName: regionDoc.name,
          ownerLabel: regionDoc.name,
          behaviorId: behavior.id,
          behaviorUuid: behavior.uuid,
          effectId: behavior.id,
          effectType: suppressionInfo.suppressionKind,
          label,
          icon: suppressionInfo.icon,
          kindLabel: game.i18n.localize("FXMASTER.Layers.KindSuppression"),
          effectTypeLabel: label,
          legacyOrder: SUPPRESSION_LEGACY_ORDER,
          discoveryIndex: discoveryIndex++,
          layerLevel: null,
          options: {},
        });
      }

      const particleDefs = fxmGetRegionBehaviorEffectDefinitions(behavior, "particle");
      for (const [effectId, info] of Object.entries(particleDefs)) {
        const type = String(effectId);
        const uid = buildRegionEffectUid("particle", regionDoc.id, behavior.id, effectId);
        const layerLevel = getLayerLevel(type);
        pushRow({
          uid,
          kind: "particle",
          scope: "region",
          source: "region",
          sourceLabel: game.i18n.localize("FXMASTER.Layers.SourceRegion"),
          ownerId: regionDoc.id,
          ownerName: regionDoc.name,
          ownerLabel: regionDoc.name,
          behaviorId: behavior.id,
          behaviorUuid: behavior.uuid,
          effectId,
          effectType: type,
          label: getEffectLabel("particle", type),
          icon: "fas fa-cloud-rain",
          kindLabel: game.i18n.localize("FXMASTER.Layers.KindParticle"),
          effectTypeLabel: getEffectLabel("particle", type),
          legacyOrder: LEGACY_SOURCE_ORDER[`particle:${layerLevel}`] ?? LEGACY_SOURCE_ORDER["particle:belowDarkness"],
          discoveryIndex: discoveryIndex++,
          layerLevel,
          options: info?.options ?? {},
        });
      }

      const filterDefs = fxmGetRegionBehaviorEffectDefinitions(behavior, "filter");
      for (const [effectId, info] of Object.entries(filterDefs)) {
        const type = String(info?.type ?? effectId);
        const uid = buildRegionEffectUid("filter", regionDoc.id, behavior.id, effectId);
        pushRow({
          uid,
          kind: "filter",
          scope: "region",
          source: "region",
          sourceLabel: game.i18n.localize("FXMASTER.Layers.SourceRegion"),
          ownerId: regionDoc.id,
          ownerName: regionDoc.name,
          ownerLabel: regionDoc.name,
          behaviorId: behavior.id,
          behaviorUuid: behavior.uuid,
          effectId,
          effectType: type,
          label: getEffectLabel("filter", type),
          icon: "fas fa-filter",
          kindLabel: game.i18n.localize("FXMASTER.Layers.KindFilter"),
          effectTypeLabel: getEffectLabel("filter", type),
          legacyOrder: LEGACY_SOURCE_ORDER.filter,
          discoveryIndex: discoveryIndex++,
          layerLevel: null,
          options: info?.options ?? {},
        });
      }
    }
  }

  if (compositeGridInFxStack()) pushRow(buildFoundryGridStackRow(scene, true));

  return rows;
}

/**
 * Collect every enabled scene-level and region-level render stack row needed by render-time consumers.
 *
 * @param {Scene|null|undefined} scene
 * @returns {Array<object>}
 */
export function collectEnabledEffectRenderRows(scene = canvas?.scene ?? null) {
  if (!scene) return [];

  const rows = [];
  const pushRow = (row) => {
    if (row?.uid) rows.push(row);
  };
  const getLayerLevel = (type) => {
    const db = CONFIG?.fxmaster?.particleEffects ?? {};
    return db?.[type]?.defaultConfig?.layerLevel ?? "belowDarkness";
  };

  const sceneEffects = scene.getFlag(packageId, "effects") ?? {};
  let discoveryIndex = 0;
  for (const [effectId, info] of Object.entries(sceneEffects)) {
    if (!info || typeof info !== "object" || !info.type) continue;
    const type = String(info.type);
    const layerLevel = getLayerLevel(type);
    pushRow({
      uid: buildSceneEffectUid("particle", effectId),
      kind: "particle",
      scope: "scene",
      ownerId: scene.id,
      effectId,
      effectType: type,
      legacyOrder: LEGACY_SOURCE_ORDER[`particle:${layerLevel}`] ?? LEGACY_SOURCE_ORDER["particle:belowDarkness"],
      discoveryIndex: discoveryIndex++,
      layerLevel,
      options: info?.options ?? {},
    });
  }

  const sceneFilters = scene.getFlag(packageId, "filters") ?? {};
  for (const [effectId, info] of Object.entries(sceneFilters)) {
    if (!info || typeof info !== "object" || !info.type) continue;
    const type = String(info.type);
    pushRow({
      uid: buildSceneEffectUid("filter", effectId),
      kind: "filter",
      scope: "scene",
      ownerId: scene.id,
      effectId,
      effectType: type,
      legacyOrder: LEGACY_SOURCE_ORDER.filter,
      discoveryIndex: discoveryIndex++,
      layerLevel: null,
      options: info?.options ?? {},
    });
  }

  const regions = getSceneRegionDocuments(scene);
  for (const regionDoc of regions) {
    const behaviorDocs = normalizeBehaviorDocs(regionDoc.behaviors);
    for (const behavior of behaviorDocs) {
      if (!behavior || behavior.disabled) continue;

      const suppressionInfo = getSuppressionBehaviorRowInfo(behavior);
      if (suppressionInfo) {
        const label = localizeSuppressionLabel(suppressionInfo.labelKey);
        pushRow({
          uid: buildSuppressionEffectUid(suppressionInfo.suppressionKind, regionDoc.id, behavior.id),
          kind: "suppression",
          suppressionKind: suppressionInfo.suppressionKind,
          behaviorType: suppressionInfo.behaviorType,
          scope: "region",
          source: "region",
          sourceLabel: game.i18n.localize("FXMASTER.Layers.SourceRegion"),
          ownerId: regionDoc.id,
          ownerName: regionDoc.name,
          ownerLabel: regionDoc.name,
          behaviorId: behavior.id,
          behaviorUuid: behavior.uuid,
          effectId: behavior.id,
          effectType: suppressionInfo.suppressionKind,
          label,
          icon: suppressionInfo.icon,
          kindLabel: game.i18n.localize("FXMASTER.Layers.KindSuppression"),
          effectTypeLabel: label,
          legacyOrder: SUPPRESSION_LEGACY_ORDER,
          discoveryIndex: discoveryIndex++,
          layerLevel: null,
          options: {},
        });
      }

      const particleDefs = fxmGetRegionBehaviorEffectDefinitions(behavior, "particle");
      for (const [effectId, info] of Object.entries(particleDefs)) {
        const type = String(effectId);
        const layerLevel = getLayerLevel(type);
        pushRow({
          uid: buildRegionEffectUid("particle", regionDoc.id, behavior.id, effectId),
          kind: "particle",
          scope: "region",
          ownerId: regionDoc.id,
          behaviorId: behavior.id,
          behaviorUuid: behavior.uuid,
          effectId,
          effectType: type,
          legacyOrder: LEGACY_SOURCE_ORDER[`particle:${layerLevel}`] ?? LEGACY_SOURCE_ORDER["particle:belowDarkness"],
          discoveryIndex: discoveryIndex++,
          layerLevel,
          options: info?.options ?? {},
        });
      }

      const filterDefs = fxmGetRegionBehaviorEffectDefinitions(behavior, "filter");
      for (const [effectId, info] of Object.entries(filterDefs)) {
        const type = String(info?.type ?? effectId);
        pushRow({
          uid: buildRegionEffectUid("filter", regionDoc.id, behavior.id, effectId),
          kind: "filter",
          scope: "region",
          ownerId: regionDoc.id,
          behaviorId: behavior.id,
          behaviorUuid: behavior.uuid,
          effectId,
          effectType: type,
          legacyOrder: LEGACY_SOURCE_ORDER.filter,
          discoveryIndex: discoveryIndex++,
          layerLevel: null,
          options: info?.options ?? {},
        });
      }
    }
  }

  if (compositeGridInFxStack()) pushRow(buildFoundryGridStackRow(scene, false));

  return rows;
}

/**
 * Sort effect rows according to persisted stack order and legacy fallback order.
 *
 * @param {Array<object>} rows
 * @param {Scene|null|undefined} scene
 * @returns {Array<object>}
 */
function sortEffectRowsInStackOrder(rows, scene = canvas?.scene ?? null) {
  if (!rows.length) return rows;

  const stored = getStoredEffectStack(scene);
  const storedIndex = new Map();
  for (let index = 0; index < stored.length; index++) {
    const uid = stored[index]?.uid;
    if (uid && !storedIndex.has(uid)) storedIndex.set(uid, index);
  }
  const maxStored = stored.length;

  const defaultIndex = (row) => {
    if (storedIndex.has(row.uid)) return storedIndex.get(row.uid);
    if (row?.kind === "suppression") return -1000 + (row.discoveryIndex ?? 0) / 1000;
    return maxStored + (1000 - (row.legacyOrder ?? 0)) + (row.discoveryIndex ?? 0) / 1000;
  };

  return rows.sort((a, b) => {
    const ai = defaultIndex(a);
    const bi = defaultIndex(b);
    if (ai !== bi) return ai - bi;
    const ownerCmp = String(a.ownerLabel ?? "").localeCompare(String(b.ownerLabel ?? ""), undefined, {
      sensitivity: "base",
      numeric: true,
    });
    if (ownerCmp) return ownerCmp;
    return String(a.label ?? a.uid).localeCompare(String(b.label ?? b.uid), undefined, {
      sensitivity: "base",
      numeric: true,
    });
  });
}

/**
 * Return lightweight currently enabled rows in top-to-bottom stack order.
 *
 * @param {Scene|null|undefined} scene
 * @returns {Array<object>}
 */
export function getOrderedEnabledEffectRenderRows(scene = canvas?.scene ?? null) {
  const cacheKey = _effectStackCacheKey(scene, "render");
  if (cacheKey && _orderedEffectRenderRowsCache.has(cacheKey)) {
    return _cloneRowsForConsumer(_orderedEffectRenderRowsCache.get(cacheKey));
  }

  const rows = sortEffectRowsInStackOrder(collectEnabledEffectRenderRows(scene), scene);
  if (cacheKey) _orderedEffectRenderRowsCache.set(cacheKey, _cloneRowsForConsumer(rows));
  return rows;
}

/**
 * Return the currently enabled rows in top-to-bottom stack order.
 *
 * Stored scene stack order is applied first. Newly enabled rows that do not yet exist in the persisted stack are appended using the legacy fallback ordering.
 *
 * @param {Scene|null|undefined} scene
 * @returns {Array<object>}
 */
export function getOrderedEnabledEffectRows(scene = canvas?.scene ?? null) {
  const cacheKey = _effectStackCacheKey(scene, "full");
  if (cacheKey && _orderedEffectRowsCache.has(cacheKey)) {
    return _cloneRowsForConsumer(_orderedEffectRowsCache.get(cacheKey));
  }

  const rows = sortEffectRowsInStackOrder(collectEnabledEffectRows(scene), scene);
  if (cacheKey) _orderedEffectRowsCache.set(cacheKey, _cloneRowsForConsumer(rows));
  return rows;
}

/**
 * Return whether at least one suppression operator is stacked above a compatible scene row.
 *
 * Suppression operators affect only scene-level particles and filters. Region-scoped particle/filter rows are ignored so suppress-scene behaviors do not suppress Region-local effects.
 *
 * @param {Scene|null|undefined} scene
 * @param {"particles"|"filters"} pipelineKind
 * @returns {boolean}
 */
export function hasStackedSuppressionAffectingSceneRows(scene = canvas?.scene ?? null, pipelineKind = "particles") {
  const normalizedKind = pipelineKind === "filters" ? "filters" : "particles";
  let activeSuppressionAbove = false;

  for (const row of getOrderedEnabledEffectRenderRows(scene)) {
    if (!row?.uid) continue;
    if (row.kind === "suppression") {
      if (suppressionKindAffectsPipeline(row.suppressionKind, normalizedKind)) activeSuppressionAbove = true;
      continue;
    }

    if (!activeSuppressionAbove || row.scope !== "scene") continue;
    if (normalizedKind === "filters" && row.kind === "filter") return true;
    if (normalizedKind === "particles" && row.kind === "particle") return true;
  }

  return false;
}

/**
 * Return the persisted stack order normalized against the currently enabled rows.
 *
 * @param {Scene|null|undefined} scene
 * @returns {string[]}
 */
export function getNormalizedEffectStackOrder(scene = canvas?.scene ?? null) {
  return getOrderedEnabledEffectRows(scene).map((row) => row.uid);
}
