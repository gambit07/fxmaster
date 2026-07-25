/**
 * FXMaster: Native Level Surface Helpers
 *
 * Selection helpers around Foundry's public Scene#getSurfaces API identify Region-defined visual footprints for a Scene Level without recreating surface occlusion or token and hover selection logic.
 */

import { documentIncludedInLevel, getCanvasLevel, getSceneLevels, getSceneSurfaces } from "./compat.js";
import { fxmDocumentId, fxmLevelBottom, fxmLevelTop } from "./foundry-public.js";

/**
 * Return whether a public RegionSurface describes visual Level coverage.
 *
 * @param {object|null|undefined} surface
 * @param {{ requireOcclusion?: boolean, allowExposure?: boolean }} [options]
 * @returns {boolean}
 */
export function surfaceDefinesVisualLevelFootprint(surface, { requireOcclusion = false, allowExposure = true } = {}) {
  if (!surface) return false;
  if (requireOcclusion) return surface.occlusion === true;
  return surface.occlusion === true || (allowExposure && surface.exposure === true);
}

/**
 * Return whether a RegionSurface elevation belongs to a Level's visual footprint. Foundry scenes conventionally place a floor footprint at the Level's bottom boundary. A wider in-window fallback is opt-in only.
 *
 * @param {object|null|undefined} surface
 * @param {foundry.documents.Level|object|null|undefined} level
 * @param {{ allowWindowFallback?: boolean, tolerance?: number }} [options]
 * @returns {boolean}
 */
export function surfaceElevationMatchesLevelFootprint(
  surface,
  level,
  { allowWindowFallback = false, tolerance = 0.01 } = {},
) {
  if (!surface || !level) return false;

  const elevation = Number(surface?.elevation);
  if (!Number.isFinite(elevation)) return false;

  const epsilon = Math.max(0, Number(tolerance) || 0);
  const bottom = fxmLevelBottom(level);
  if (Number.isFinite(bottom) && Math.abs(elevation - bottom) <= epsilon) return true;
  if (!allowWindowFallback) return false;

  const top = fxmLevelTop(level);
  const min = Number.isFinite(bottom) ? bottom : Number.NEGATIVE_INFINITY;
  const max = Number.isFinite(top) ? top : Number.POSITIVE_INFINITY;
  return elevation >= min - epsilon && elevation <= max + epsilon;
}

/**
 * Collect Region documents whose public Define Surface entries describe one Level's visual footprint.
 *
 * Passing `includedLevel` delegates inclusion filtering to Scene#getSurfaces({level}), which is the same public ownership decision used by Foundry's CanvasOcclusionMask. `requireOcclusion` limits the result to surfaces which can actually reveal/occlude Level artwork.
 *
 * @param {foundry.documents.Level|string|object|null|undefined} levelOrId
 * @param {{
 *   scene?: foundry.documents.Scene|null,
 *   includedLevel?: foundry.documents.Level|string|null,
 *   requireOcclusion?: boolean,
 *   allowExposure?: boolean,
 *   allowWindowFallback?: boolean,
 *   tolerance?: number
 * }} [options]
 * @returns {Array<foundry.documents.Region|object>}
 */
export function getDefinedSurfaceFootprintRegionsForLevel(
  levelOrId,
  {
    scene = canvas?.scene ?? null,
    includedLevel = null,
    requireOcclusion = false,
    allowExposure = true,
    allowWindowFallback = false,
    tolerance = 0.01,
  } = {},
) {
  if (!scene || !levelOrId) return [];

  const levelId = typeof levelOrId === "string" ? levelOrId : fxmDocumentId(levelOrId);
  const levels = getSceneLevels(scene);
  const level =
    typeof levelOrId === "object" && levelOrId !== null && !Array.isArray(levelOrId)
      ? levelOrId
      : levels.find((candidate) => fxmDocumentId(candidate) === levelId) ?? null;
  if (!level) return [];

  const surfaceOptions = {};
  const includedLevelId =
    typeof includedLevel === "string" ? includedLevel : fxmDocumentId(includedLevel ?? getCanvasLevel());
  if (includedLevel !== null && includedLevelId) surfaceOptions.level = includedLevelId;
  if (requireOcclusion) surfaceOptions.occlusion = true;

  let surfaces = [];
  try {
    surfaces = getSceneSurfaces(scene, surfaceOptions);
  } catch (_err) {
    surfaces = [];
  }
  if (!surfaces.length) return [];

  const exact = [];
  const fallback = [];
  const exactKeys = new Set();
  const fallbackKeys = new Set();

  const pushUnique = (list, keys, region) => {
    const document = region?.document ?? region ?? null;
    if (!document) return;
    const shapes = Array.from(document?.shapes ?? []);
    if (!shapes.length) return;

    const id = fxmDocumentId(document);
    const key = id || document;
    if (keys.has(key)) return;
    keys.add(key);
    list.push(document);
  };

  for (const surface of surfaces) {
    if (!surfaceDefinesVisualLevelFootprint(surface, { requireOcclusion, allowExposure })) continue;
    const region = surface?.region ?? null;
    if (!region) continue;

    /**
     * Scene#getSurfaces({level}) establishes participation in the viewed Level. A second public inclusion check identifies the artwork Level and prevents a Level 1 top surface from being mistaken for Level 2 when both share elevation 20.
     */
    if (documentIncludedInLevel(region, level) === false) continue;

    if (surfaceElevationMatchesLevelFootprint(surface, level, { tolerance })) {
      pushUnique(exact, exactKeys, region);
      continue;
    }

    if (
      allowWindowFallback &&
      surfaceElevationMatchesLevelFootprint(surface, level, { allowWindowFallback: true, tolerance })
    ) {
      pushUnique(fallback, fallbackKeys, region);
    }
  }

  return exact.length ? exact : allowWindowFallback ? fallback : [];
}
