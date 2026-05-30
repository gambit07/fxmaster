/**
 * FXMaster: Mask & Render-Texture Utilities
 *
 * Token sprite pooling, scene allow-mask construction, below-tokens cutout compositing, region mask building, and dynamic-ring handling.
 *
 * These utilities are the backbone of FXMaster's per-frame masking pipeline that gates which screen regions show effects.
 */

import { packageId } from "../constants.js";
import { logger } from "../logger.js";
import {
  traceRegionShapePIXI,
  traceRegionShapePath2D,
  estimateRegionInradius,
  getEventGate,
  getRegionElevationWindow,
  inRangeElev,
  regionWorldBounds,
  regionWorldBoundsAligned,
} from "./geometry.js";
import {
  getCssViewportMetrics,
  rawStageMatrix,
  safeMaskResolutionForCssArea,
  safeResolutionForCssArea,
  snappedStageMatrix,
} from "./viewport.js";
import {
  fxmDocumentIncludedInLevel,
  fxmLevelBottom,
  fxmLevelIsAbove,
  fxmLevelTop,
  fxmReadRegionBehaviorRuntimeState,
  fxmResolveLevelIdsFromConfiguredSources,
  fxmCollectComparableSourcePaths,
  fxmLinkedPlaceableFromDisplayObject,
  fxmGetPublicHoverFadeState,
  fxmGetPlaceableTargetAlphaCompat,
  fxmUpdateDisplayObjectWorldTransform,
  fxmDisplayObjectTransformSignature,
  fxmReadDocumentShapes,
} from "./foundry-public.js";
import {
  getCanvasLevel,
  getCanvasPrimaryHoverFadeElevation,
  getCanvasLiveLevelSurfaceRevealState,
  getCanvasLiveLevelSurfaceState,
  getDocumentLevelsSet,
  getSceneLevels,
  getTileOcclusionModes,
  inferVisibleLevelForDocument,
  isDocumentOnCurrentCanvasLevel,
} from "./compat.js";

let _tmpRTCopySprite = null;
let _tmpTokensEraseSprite = null;
let _tmpTileMaskClearContainer = null;
let _tmpTileMaskSpriteContainer = null;
let _tmpTokenMaskContainer = null;
let _tmpComposeTilesCoverageRT = null;
let _tmpUpperLevelCoverageRT = null;
let _tmpUpperLevelCoverageEraseSprite = null;
let _tmpUpperLevelCoverageProxySprite = null;
let _tmpUpperLevelCoverageCacheKey = null;
let _tmpUpperLevelCoverageCacheValue = undefined;

let _tileOccludedTokensFrameKey = null;
let _tileOccludedTokensFrameValue = null;

/** Region-mask softening scratch objects. */
let _tmpRegionCanvasSprite = null;

let _tmpSceneSuppressionSprite = null;
let _tmpSceneSuppressionHardMaskRT = null;
let _sceneSuppressionSoftCache = new Map();
let _sceneSuppressionSoftCacheTick = 0;

let _sceneAllowOverlayObjectRT = null;
let _sceneAllowOverlayRegionRT = null;
let _sceneAllowOverlayCompositeRT = null;
let _sceneAllowOverlaySprite = null;
let _sceneAllowOverlayFilter = null;
let _sceneAllowOverlayClearGfx = null;
let _sceneAllowOverlayShapeGfx = null;

/** Maximum device-independent pixel density used for cached world-space suppression masks. */
const SCENE_SUPPRESSION_SOFT_MAX_PIXELS_PER_WORLD = 1;
/** Maximum texture span for a cached world-space suppression mask. */
const SCENE_SUPPRESSION_SOFT_MAX_TEXTURE_SPAN = 3072;
/** Maximum texel budget for a cached world-space suppression mask. */
const SCENE_SUPPRESSION_SOFT_MAX_TEXTURE_AREA = 2_000_000;

/**
 * Collect likely texture source paths from a PIXI/Foundry object graph.
 *
 * @param {unknown} value
 * @param {Set<string>} [output]
 * @param {Set<unknown>} [seen]
 * @returns {Set<string>}
 * @private
 */
function _collectComparableSourcePaths(value, output = new Set()) {
  return fxmCollectComparableSourcePaths(value, output);
}

/**
 * Return configured Level ids matched by a live surface texture path.
 *
 * @param {{mesh?: unknown, object?: unknown, document?: unknown, level?: unknown}} surface
 * @param {foundry.documents.Level[]} levels
 * @returns {Set<string>}
 * @private
 */
function _resolveSurfaceConfiguredLevelIds(surface, levels) {
  const paths = new Set();
  _collectComparableSourcePaths(surface?.mesh, paths);
  _collectComparableSourcePaths(surface?.object, paths);
  _collectComparableSourcePaths(surface?.document, paths);
  _collectComparableSourcePaths(surface?.level, paths);
  if (!paths.size) return new Set();

  const scene =
    surface?.document?.parent ?? surface?.object?.document?.parent ?? surface?.level?.parent ?? canvas?.scene ?? null;
  const ids = fxmResolveLevelIdsFromConfiguredSources(paths, { scene });
  if (ids.size && Array.isArray(levels) && levels.length) {
    const allowed = new Set(levels.map((level) => level?.id).filter(Boolean));
    return new Set(Array.from(ids).filter((id) => allowed.has(id)));
  }
  return ids;
}

function _setsIntersect(a, b) {
  if (!(a?.size > 0) || !(b?.size > 0)) return false;
  for (const value of a) if (b.has(value)) return true;
  return false;
}

/**
 * Resolve authored Level ids from a surface document or linked placeable.
 *
 * @param {{mesh?: unknown, object?: unknown, document?: unknown, level?: unknown}} surface
 * @returns {Set<string>}
 * @private
 */
function _resolveSurfaceExplicitLevelIds(surface) {
  const ids = new Set();
  const candidates = [
    surface?.document,
    surface?.object?.document,
    surface?.object,
    surface?.mesh?.document,
    surface?.mesh?.object?.document,
    surface?.mesh?.object,
    surface?.level,
  ];

  for (const candidate of candidates) {
    const levels = getDocumentLevelsSet(candidate);
    if (!(levels?.size > 0)) continue;
    for (const levelId of levels) ids.add(levelId);
  }

  return ids;
}

/**
 * Return whether a surface is authored for the currently viewed Level.
 *
 * @param {{mesh?: unknown, object?: unknown, document?: unknown, level?: unknown}} surface
 * @param {{currentLevel?: foundry.documents.Level|null}} context
 * @returns {boolean}
 * @private
 */
function _surfaceHasCurrentLevelMembership(surface, context) {
  const currentLevel = context?.currentLevel ?? null;
  const currentLevelId = currentLevel?.id ?? null;
  if (!currentLevelId) return false;

  for (const candidate of [
    surface?.document,
    surface?.object?.document,
    surface?.object,
    surface?.mesh?.document,
    surface?.mesh?.object?.document,
    surface?.mesh?.object,
    surface?.level,
  ]) {
    const included = fxmDocumentIncludedInLevel(candidate, currentLevel);
    if (included === true) return true;
  }

  return _resolveSurfaceExplicitLevelIds(surface).has(currentLevelId);
}

function _levelIsAbove(candidate, target) {
  return fxmLevelIsAbove(candidate, target);
}

function _hasCanvasMousePositionForReveal() {
  const point = canvas?.mousePosition ?? null;
  return Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y));
}

function _levelSurfaceRevealExposesBelowObjectMask(reveal) {
  if (!reveal?.revealed) return false;
  if (reveal?.explicit) return true;
  if (!_hasCanvasMousePositionForReveal()) return false;
  if (reveal?.hovered || reveal?.faded || reveal?.fading || reveal?.occluded) return true;
  const fadeOcclusion = Number(reveal?.fadeOcclusion ?? 0);
  return Number.isFinite(fadeOcclusion) && fadeOcclusion > 0.001;
}

function _displayObjectHasVisiblePixels(object) {
  if (!object || object.destroyed) return false;
  if (object.visible === false || object.renderable === false) return false;
  const alpha = Number(object.worldAlpha ?? object.alpha ?? 1);
  return !(Number.isFinite(alpha) && alpha <= 0.001);
}

function _resolveLiveSurfaceObject(primaryObject, linkedObject) {
  const liveObject = linkedObject?.mesh ?? linkedObject?.primaryMesh ?? linkedObject?.sprite ?? null;
  return liveObject ?? primaryObject ?? linkedObject ?? null;
}

function _displayObjectIntersectsCssViewport(object) {
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

function _upperLevelCoverageFrameKey(likeRT) {
  const stageMatrix = canvas?.stage?.worldTransform ?? null;
  const transformKey = [
    stageMatrix?.a,
    stageMatrix?.b,
    stageMatrix?.c,
    stageMatrix?.d,
    stageMatrix?.tx,
    stageMatrix?.ty,
  ]
    .map((value) => (Number.isFinite(Number(value)) ? Number(value).toFixed(3) : ""))
    .join(",");
  const hoverFadeElevation = getCanvasPrimaryHoverFadeElevation();
  const hoverKey = Number.isFinite(hoverFadeElevation) ? hoverFadeElevation.toFixed(3) : "none";
  let surfaceStateKey = "surface-state-unavailable";
  try {
    surfaceStateKey =
      getCanvasLiveLevelSurfaceState(canvas?.scene ?? null, { presynced: true })?.key ?? surfaceStateKey;
  } catch (err) {
    logger.debug("FXMaster:", err);
  }
  const width = Number.isFinite(Number(likeRT?.width)) ? Number(likeRT.width).toFixed(3) : "";
  const height = Number.isFinite(Number(likeRT?.height)) ? Number(likeRT.height).toFixed(3) : "";
  const resolution = Number(likeRT?.resolution ?? 1).toFixed(3);
  return [
    canvas?.scene?.id ?? "scene",
    getCanvasLevel()?.id ?? "level",
    width,
    height,
    resolution,
    transformKey,
    hoverKey,
    surfaceStateKey,
  ].join(":");
}

/**
 * Return whether a live primary surface belongs to unrevealed visible Levels above the current view.
 *
 * @param {{mesh?: unknown, object?: unknown, document?: unknown, level?: unknown, elevation?: number}} surface
 * @param {{levels: foundry.documents.Level[], currentLevel: foundry.documents.Level, overlayLevelIds: Set<string>}} context
 * @returns {boolean}
 * @private
 */
function _surfaceBelongsToUpperVisibleLevels(surface, context) {
  if (!(context?.overlayLevelIds?.size > 0)) return false;

  const configuredIds = _resolveSurfaceConfiguredLevelIds(surface, context.levels);
  if (configuredIds.size)
    return _setsIntersect(configuredIds, context.overlayLevelIds) && !configuredIds.has(context.currentLevel?.id);

  if (_surfaceHasCurrentLevelMembership(surface, context)) return false;

  const inferred = inferVisibleLevelForDocument(
    surface.document ?? surface.object ?? surface.level ?? null,
    surface.elevation,
  );
  if (inferred?.id) return context.overlayLevelIds.has(inferred.id);

  return false;
}

/**
 * Ensure a scratch upper-level coverage RT matches another RT.
 *
 * @param {PIXI.RenderTexture} outRT
 * @returns {PIXI.RenderTexture|null}
 * @private
 */
function _ensureUpperLevelCoverageRT(outRT) {
  if (!outRT) return null;
  const width = Math.max(1, Number(outRT.width) || 1);
  const height = Math.max(1, Number(outRT.height) || 1);
  const resolution = outRT.resolution || 1;
  const bad =
    !_tmpUpperLevelCoverageRT ||
    _tmpUpperLevelCoverageRT.destroyed ||
    Math.abs(Number(_tmpUpperLevelCoverageRT.width ?? 0) - width) > 0.001 ||
    Math.abs(Number(_tmpUpperLevelCoverageRT.height ?? 0) - height) > 0.001 ||
    (_tmpUpperLevelCoverageRT.resolution || 1) !== resolution;

  if (!bad) return _tmpUpperLevelCoverageRT;

  const oldRT = _tmpUpperLevelCoverageRT;
  _tmpUpperLevelCoverageRT = PIXI.RenderTexture.create({ width, height, resolution, multisample: 0 });
  try {
    _tmpUpperLevelCoverageRT.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
    _tmpUpperLevelCoverageRT.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
  } catch (err) {
    logger.debug("FXMaster:", err);
  }
  _destroyTextureDeferred(oldRT);
  return _tmpUpperLevelCoverageRT;
}

/**
 * Ensure a module-level scratch RT matches a reference render texture.
 *
 * @param {PIXI.RenderTexture|null} scratchRT
 * @param {PIXI.RenderTexture} likeRT
 * @returns {PIXI.RenderTexture|null}
 * @private
 */
function _ensureScratchRTLike(scratchRT, likeRT) {
  if (!likeRT) return null;
  const width = Math.max(1, Number(likeRT.width) || 1);
  const height = Math.max(1, Number(likeRT.height) || 1);
  const resolution = likeRT.resolution || 1;
  const bad =
    !scratchRT ||
    scratchRT.destroyed ||
    Math.abs(Number(scratchRT.width ?? 0) - width) > 0.001 ||
    Math.abs(Number(scratchRT.height ?? 0) - height) > 0.001 ||
    (scratchRT.resolution || 1) !== resolution;

  if (!bad) return scratchRT;

  const oldRT = scratchRT ?? null;
  const rt = PIXI.RenderTexture.create({ width, height, resolution, multisample: 0 });
  try {
    rt.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
    rt.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
  } catch (err) {
    logger.debug("FXMaster:", err);
  }
  _destroyTextureDeferred(oldRT);
  return rt;
}

/**
 * Collect live upper-level surfaces that should occlude lower-level tile masks.
 *
 * @returns {PIXI.DisplayObject[]}
 * @private
 */
function _collectUnrevealedUpperLevelSurfaceObjectsForCurrentView() {
  const currentLevel = getCanvasLevel();
  if (!canvas?.level || !currentLevel?.id || !canvas?.primary) return [];

  const levels = getSceneLevels(canvas?.scene ?? null);
  const overlayLevels = levels.filter((level) => {
    const id = level?.id ?? null;
    if (!id || id === currentLevel.id) return false;
    if (!(level?.isVisible || level?.isView)) return false;
    return _levelIsAbove(level, currentLevel);
  });
  const overlayLevelIds = new Set(overlayLevels.map((level) => level?.id).filter(Boolean));
  if (!overlayLevelIds.size) return [];

  const context = { levels, currentLevel, overlayLevelIds };
  const objects = [];
  const seen = new Set();
  const push = (object) => {
    if (!object || seen.has(object)) return;
    seen.add(object);
    objects.push(object);
  };

  for (const mesh of canvas.primary?.levelTextures ?? []) {
    const object = mesh?.object ?? null;
    const liveObject = _resolveLiveSurfaceObject(mesh, object);
    const captureObject = _displayObjectHasVisiblePixels(mesh)
      ? mesh
      : _displayObjectHasVisiblePixels(liveObject)
      ? liveObject
      : null;
    if (!captureObject) continue;
    if (!_displayObjectIntersectsCssViewport(captureObject)) continue;

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
    if (!_surfaceBelongsToUpperVisibleLevels({ mesh, object, document, level, elevation }, context)) continue;

    const revealObject = liveObject ?? captureObject;
    const reveal = getCanvasLiveLevelSurfaceRevealState(revealObject, {
      mesh: revealObject,
      object,
      document,
      level,
      elevation,
    });
    if (_levelSurfaceRevealExposesBelowObjectMask(reveal)) continue;

    push(captureObject);
  }

  const tileMeshes =
    typeof canvas.primary?.tiles?.values === "function"
      ? Array.from(canvas.primary.tiles.values())
      : Array.from(canvas.primary?.tiles ?? []);

  for (const mesh of tileMeshes) {
    const tileObject = _resolveTilePlaceable(mesh);
    if (!tileObject || tileObject.document?.hidden) continue;

    const liveObject = _resolveLiveSurfaceObject(mesh, tileObject);
    const captureObject = _displayObjectHasVisiblePixels(mesh)
      ? mesh
      : _displayObjectHasVisiblePixels(liveObject)
      ? liveObject
      : null;
    if (!captureObject) continue;
    if (!_displayObjectIntersectsCssViewport(captureObject)) continue;

    const document = tileObject.document ?? null;
    const level = mesh?.level ?? tileObject?.level ?? document?.level ?? null;
    const elevation = Number(mesh?.elevation ?? document?.elevation ?? tileObject?.elevation ?? Number.NaN);
    if (
      !_surfaceBelongsToUpperVisibleLevels(
        { mesh, object: tileObject, document: document ?? tileObject, level, elevation },
        context,
      )
    )
      continue;

    const revealObject = liveObject ?? captureObject;
    const reveal = getCanvasLiveLevelSurfaceRevealState(revealObject, {
      mesh: revealObject,
      object: tileObject,
      document: document ?? tileObject,
      level,
      elevation,
    });
    if (_levelSurfaceRevealExposesBelowObjectMask(reveal)) continue;

    push(captureObject);
  }

  return objects;
}

function _renderUpperLevelSurfaceProxyIntoRT(object, renderTexture) {
  const renderer = canvas?.app?.renderer;
  const texture = object?.texture ?? null;
  if (!renderer || !texture || !renderTexture || texture?.destroyed || texture?.baseTexture?.destroyed) return false;
  if (object?.constructor?.name !== "PrimarySpriteMesh" && !String(object?.name ?? "").startsWith("Level."))
    return false;

  let bounds = null;
  try {
    bounds = object.getBounds?.(false) ?? object.bounds ?? null;
  } catch (err) {
    logger.debug("FXMaster:", err);
  }
  if (!(Number(bounds?.width) > 0 && Number(bounds?.height) > 0)) return false;

  const sprite = (_tmpUpperLevelCoverageProxySprite ??= new PIXI.Sprite(PIXI.Texture.EMPTY));
  const previousTexture = sprite.texture;
  const previousBlendMode = sprite.blendMode;
  const previousAlpha = sprite.alpha;
  const previousFilters = sprite.filters;
  sprite.texture = texture;
  sprite.position.set(Number(bounds.x) || 0, Number(bounds.y) || 0);
  sprite.scale.set(1, 1);
  sprite.rotation = 0;
  sprite.width = Math.max(1, Number(bounds.width) || 1);
  sprite.height = Math.max(1, Number(bounds.height) || 1);
  sprite.alpha = Math.max(0, Math.min(1, Number(object?.worldAlpha ?? object?.alpha ?? 1) || 1));
  sprite.blendMode = PIXI.BLEND_MODES.NORMAL;
  sprite.roundPixels = false;
  sprite.filters = null;

  try {
    renderer.render(sprite, { renderTexture, clear: false, skipUpdateTransform: false });
    return true;
  } catch (err) {
    logger.debug("FXMaster:", err);
    return false;
  } finally {
    try {
      sprite.texture = previousTexture ?? PIXI.Texture.EMPTY;
      sprite.blendMode = previousBlendMode;
      sprite.alpha = previousAlpha;
      sprite.filters = previousFilters;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }
}

/**
 * Capture unrevealed upper-level surfaces into a scratch coverage texture.
 *
 * @param {PIXI.RenderTexture} likeRT
 * @returns {PIXI.RenderTexture|null}
 * @private
 */
function _captureUnrevealedUpperLevelCoverageRT(likeRT) {
  const renderer = canvas?.app?.renderer;
  const coverageRT = _ensureUpperLevelCoverageRT(likeRT);
  if (!renderer || !coverageRT) return null;

  const cacheKey = _upperLevelCoverageFrameKey(likeRT);
  if (_tmpUpperLevelCoverageCacheKey === cacheKey) {
    if (_tmpUpperLevelCoverageCacheValue === null) return null;
    if (_tmpUpperLevelCoverageCacheValue && !_tmpUpperLevelCoverageCacheValue.destroyed)
      return _tmpUpperLevelCoverageCacheValue;
  }

  const remember = (value) => {
    _tmpUpperLevelCoverageCacheKey = cacheKey;
    _tmpUpperLevelCoverageCacheValue = value ?? null;
    return value ?? null;
  };

  const objects = _collectUnrevealedUpperLevelSurfaceObjectsForCurrentView();
  if (!objects.length) return remember(null);

  clearTileMaskRenderTexture(coverageRT);

  let rendered = false;
  for (const object of objects) {
    if (!object || object.destroyed) continue;
    if (_renderUpperLevelSurfaceProxyIntoRT(object, coverageRT)) {
      rendered = true;
      continue;
    }
    try {
      renderer.render(object, {
        renderTexture: coverageRT,
        clear: false,
        skipUpdateTransform: true,
      });
      rendered = true;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  return remember(rendered ? coverageRT : null);
}
/**
 * Erase unrevealed upper-level coverage from a tile mask so lower tiles do not punch visible holes through an opaque higher level surface.
 *
 * @param {PIXI.RenderTexture} outRT
 * @returns {void}
 * @private
 */
function _eraseUnrevealedUpperLevelCoverageFromMask(outRT) {
  if (!canvas?.level || !outRT || !canvas?.app?.renderer) return;
  const coverageRT = _captureUnrevealedUpperLevelCoverageRT(outRT);
  if (!coverageRT) return;

  const sprite = (_tmpUpperLevelCoverageEraseSprite ??= new PIXI.Sprite(PIXI.Texture.EMPTY));
  const previousBlendMode = sprite.blendMode;
  const previousAlpha = sprite.alpha;
  sprite.texture = coverageRT;
  sprite.position.set(0, 0);
  sprite.scale.set(1, 1);
  sprite.width = outRT.width;
  sprite.height = outRT.height;
  sprite.alpha = 1;
  sprite.blendMode = PIXI.BLEND_MODES.ERASE;

  try {
    canvas.app.renderer.render(sprite, { renderTexture: outRT, clear: false, skipUpdateTransform: false });
  } catch (err) {
    logger.debug("FXMaster:", err);
  } finally {
    try {
      sprite.blendMode = previousBlendMode;
      sprite.alpha = previousAlpha;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }
}

/**
 * Ensure a reusable scene-allow overlay render texture matches the requested viewport spec.
 *
 * @param {PIXI.RenderTexture|null} reuseRT
 * @param {{width:number,height:number,resolution:number}} spec
 * @returns {PIXI.RenderTexture}
 * @private
 */
function _ensureSceneAllowOverlayRT(reuseRT, { width, height, resolution }) {
  const W = Math.max(1, Number(width) || 1);
  const H = Math.max(1, Number(height) || 1);
  const res = resolution || 1;

  const bad =
    !reuseRT ||
    reuseRT.destroyed ||
    Math.abs(Number(reuseRT.width ?? 0) - W) > 0.001 ||
    Math.abs(Number(reuseRT.height ?? 0) - H) > 0.001 ||
    (reuseRT.resolution || 1) !== res;

  if (!bad) return reuseRT;

  const oldRT = reuseRT ?? null;
  const rt = PIXI.RenderTexture.create({ width: W, height: H, resolution: res, multisample: 0 });
  try {
    rt.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
    rt.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  _destroyTextureDeferred(oldRT);
  return rt;
}

/**
 * Return the shared sprite/filter pair used to restore preserved overlay alpha into a scene allow mask.
 *
 * @returns {{ sprite: PIXI.Sprite, filter: PIXI.Filter }}
 * @private
 */
function _getSceneAllowOverlayRestoreSprite() {
  if (!_sceneAllowOverlaySprite) _sceneAllowOverlaySprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
  if (!_sceneAllowOverlayFilter) {
    _sceneAllowOverlayFilter = new PIXI.Filter(
      undefined,
      `
      varying vec2 vTextureCoord;
      uniform sampler2D uSampler;
      uniform sampler2D clipSampler;
      void main() {
        float srcA = texture2D(uSampler, vTextureCoord).a;
        float clipA = texture2D(clipSampler, vTextureCoord).r;
        float outA = srcA * clipA;
        gl_FragColor = vec4(outA, outA, outA, outA);
      }
    `,
      {
        clipSampler: PIXI.Texture.EMPTY,
      },
    );
  }

  return { sprite: _sceneAllowOverlaySprite, filter: _sceneAllowOverlayFilter };
}

/**
 * Clear a reusable scene-allow overlay render texture to transparent black.
 *
 * @param {PIXI.RenderTexture|null|undefined} rt
 * @returns {boolean}
 * @private
 */
function _clearSceneAllowOverlayRT(rt) {
  const renderer = canvas?.app?.renderer;
  if (!renderer || !rt) return false;
  if (!_sceneAllowOverlayClearGfx) _sceneAllowOverlayClearGfx = new PIXI.Graphics();

  try {
    _sceneAllowOverlayClearGfx.clear();
    renderer.render(_sceneAllowOverlayClearGfx, { renderTexture: rt, clear: true });
    return true;
  } catch (err) {
    logger.debug("FXMaster:", err);
    return false;
  }
}

/**
 * Capture a set of live display objects into a CSS-space render texture.
 *
 * @param {PIXI.RenderTexture} rt
 * @param {PIXI.DisplayObject[]|null|undefined} objects
 * @returns {boolean}
 * @private
 */
function _captureDisplayObjectsIntoSceneAllowRT(rt, objects, { forceAlpha = false } = {}) {
  const renderer = canvas?.app?.renderer;
  if (!renderer || !rt) return false;
  if (!_clearSceneAllowOverlayRT(rt)) return false;

  let rendered = false;
  for (const object of objects ?? []) {
    if (!object || object.destroyed) continue;

    let previousAlpha;
    let changedAlpha = false;
    if (forceAlpha && typeof object.alpha === "number") {
      previousAlpha = object.alpha;
      object.alpha = 1;
      changedAlpha = true;
    }

    try {
      renderer.render(object, {
        renderTexture: rt,
        clear: false,
        skipUpdateTransform: true,
      });
      rendered = true;
    } catch (err) {
      logger.debug("FXMaster:", err);
    } finally {
      if (changedAlpha) {
        try {
          object.alpha = previousAlpha;
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }
    }
  }

  return rendered;
}
/**
 * Restore preserved overlay objects into a scene allow mask inside a specific region clip.
 *
 * Preserved overlay surfaces should remain unsuppressed when a suppression region only applies to lower Levels beneath them. The object alpha is multiplied by the hard binary region clip so only pixels inside the suppression region are restored.
 *
 * @param {PIXI.RenderTexture} sceneAllowRT
 * @param {PlaceableObject} region
 * @param {PIXI.Matrix} stageMatrix
 * @param {PIXI.DisplayObject[]|null|undefined} objects
 * @param {{width:number,height:number,resolution:number}} spec
 * @returns {boolean}
 * @private
 */
function _restorePreservedOverlayObjectsIntoSceneAllowMask(
  sceneAllowRT,
  region,
  stageMatrix,
  objects,
  { width, height, resolution },
) {
  const renderer = canvas?.app?.renderer;
  if (!renderer || !sceneAllowRT || !region) return false;

  const preserveObjects = Array.isArray(objects) ? objects.filter(Boolean) : [];
  if (!preserveObjects.length) return false;

  _sceneAllowOverlayObjectRT = _ensureSceneAllowOverlayRT(_sceneAllowOverlayObjectRT, { width, height, resolution });
  _sceneAllowOverlayRegionRT = _ensureSceneAllowOverlayRT(_sceneAllowOverlayRegionRT, { width, height, resolution });

  const capturedObjects = _captureDisplayObjectsIntoSceneAllowRT(_sceneAllowOverlayObjectRT, preserveObjects);
  if (!capturedObjects) return false;

  _renderBinaryRegionMaskRT(_sceneAllowOverlayRegionRT, region, stageMatrix);

  const { sprite, filter } = _getSceneAllowOverlayRestoreSprite();
  sprite.texture = _sceneAllowOverlayObjectRT;
  sprite.position.set(0, 0);
  sprite.width = Math.max(1, Number(width) || 1);
  sprite.height = Math.max(1, Number(height) || 1);
  sprite.alpha = 1;
  sprite.blendMode = PIXI.BLEND_MODES.NORMAL;
  filter.uniforms.clipSampler = _sceneAllowOverlayRegionRT;
  sprite.filters = [filter];

  try {
    renderer.render(sprite, { renderTexture: sceneAllowRT, clear: false });
    return true;
  } catch (err) {
    logger.debug("FXMaster:", err);
    return false;
  } finally {
    sprite.filters = null;
  }
}

/**
 * Capture simple world-space preservation shapes into a CSS-space render texture.
 *
 * @param {PIXI.RenderTexture} rt
 * @param {Array<object>|null|undefined} shapes
 * @param {PIXI.Matrix} stageMatrix
 * @returns {boolean}
 * @private
 */
function _capturePreserveShapesIntoSceneAllowRT(rt, shapes, stageMatrix) {
  const renderer = canvas?.app?.renderer;
  if (!renderer || !rt) return false;

  const preserveShapes = Array.isArray(shapes) ? shapes.filter(Boolean) : [];
  if (!preserveShapes.length) return false;
  if (!_clearSceneAllowOverlayRT(rt)) return false;

  if (!_sceneAllowOverlayShapeGfx) _sceneAllowOverlayShapeGfx = new PIXI.Graphics();
  const gfx = _sceneAllowOverlayShapeGfx;
  let drew = false;

  try {
    gfx.clear();
    gfx.transform.setFromMatrix(stageMatrix ?? new PIXI.Matrix());
    gfx.blendMode = PIXI.BLEND_MODES.NORMAL;
    gfx.beginFill(0xffffff, 1);

    for (const shape of preserveShapes) {
      const type = String(shape?.type ?? "");
      if (type === "circle") {
        const x = Number(shape?.x);
        const y = Number(shape?.y);
        const radius = Number(shape?.radius);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(radius) || radius <= 0) continue;
        gfx.drawCircle(x, y, radius);
        drew = true;
      } else if (type === "rect") {
        const x = Number(shape?.x);
        const y = Number(shape?.y);
        const width = Number(shape?.width);
        const height = Number(shape?.height);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) continue;
        if (width <= 0 || height <= 0) continue;
        gfx.drawRect(x, y, width, height);
        drew = true;
      }
    }

    gfx.endFill();
    if (!drew) return false;

    renderer.render(gfx, { renderTexture: rt, clear: false, skipUpdateTransform: false });
    return true;
  } catch (err) {
    logger.debug("FXMaster:", err);
    return false;
  } finally {
    try {
      gfx.clear();
      gfx.transform.setFromMatrix(new PIXI.Matrix());
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }
}

/**
 * Restore preserved world-space shapes into a scene allow mask inside a Region clip. This protects a small lower-Level reveal aperture without restoring an entire lower-Level background/foreground surface.
 *
 * @param {PIXI.RenderTexture} sceneAllowRT
 * @param {PlaceableObject} region
 * @param {PIXI.Matrix} stageMatrix
 * @param {Array<object>|null|undefined} shapes
 * @param {{width:number,height:number,resolution:number}} spec
 * @returns {boolean}
 * @private
 */
function _restorePreservedShapesIntoSceneAllowMask(
  sceneAllowRT,
  region,
  stageMatrix,
  shapes,
  { width, height, resolution },
) {
  const renderer = canvas?.app?.renderer;
  if (!renderer || !sceneAllowRT || !region) return false;

  const preserveShapes = Array.isArray(shapes) ? shapes.filter(Boolean) : [];
  if (!preserveShapes.length) return false;

  _sceneAllowOverlayObjectRT = _ensureSceneAllowOverlayRT(_sceneAllowOverlayObjectRT, { width, height, resolution });
  _sceneAllowOverlayRegionRT = _ensureSceneAllowOverlayRT(_sceneAllowOverlayRegionRT, { width, height, resolution });

  const capturedShapes = _capturePreserveShapesIntoSceneAllowRT(
    _sceneAllowOverlayObjectRT,
    preserveShapes,
    stageMatrix,
  );
  if (!capturedShapes) return false;

  _renderBinaryRegionMaskRT(_sceneAllowOverlayRegionRT, region, stageMatrix);

  const { sprite, filter } = _getSceneAllowOverlayRestoreSprite();
  sprite.texture = _sceneAllowOverlayObjectRT;
  sprite.position.set(0, 0);
  sprite.width = Math.max(1, Number(width) || 1);
  sprite.height = Math.max(1, Number(height) || 1);
  sprite.alpha = 1;
  sprite.blendMode = PIXI.BLEND_MODES.NORMAL;
  filter.uniforms.clipSampler = _sceneAllowOverlayRegionRT;
  sprite.filters = [filter];

  try {
    renderer.render(sprite, { renderTexture: sceneAllowRT, clear: false });
    return true;
  } catch (err) {
    logger.debug("FXMaster:", err);
    return false;
  } finally {
    sprite.filters = null;
  }
}

/**
 * Erase protected overlay-object silhouettes from a scene allow mask inside a specific Region clip.
 *
 * This runs after unassigned upper-level overlays are restored. The object alpha is first clipped into a reusable intermediate render texture, then erased with a plain sprite pass. Keeping the final ERASE pass filter-free avoids a driver/PIXI edge case where filtered ERASE sprites can fail to punch the restored allow-mask pixels back out.
 *
 * @param {PIXI.RenderTexture} sceneAllowRT
 * @param {PlaceableObject} region
 * @param {PIXI.Matrix} stageMatrix
 * @param {PIXI.DisplayObject[]|null|undefined} objects
 * @param {{width:number,height:number,resolution:number,edgeFadePercent?:number}} spec
 * @returns {boolean}
 * @private
 */
function _eraseSuppressedOverlayObjectsFromSceneAllowMask(
  sceneAllowRT,
  region,
  stageMatrix,
  objects,
  { width, height, resolution, edgeFadePercent = 0 },
) {
  const renderer = canvas?.app?.renderer;
  if (!renderer || !sceneAllowRT || !region) return false;

  const suppressObjects = Array.isArray(objects) ? objects.filter(Boolean) : [];
  if (!suppressObjects.length) return false;

  _sceneAllowOverlayObjectRT = _ensureSceneAllowOverlayRT(_sceneAllowOverlayObjectRT, { width, height, resolution });
  _sceneAllowOverlayRegionRT = _ensureSceneAllowOverlayRT(_sceneAllowOverlayRegionRT, { width, height, resolution });
  _sceneAllowOverlayCompositeRT = _ensureSceneAllowOverlayRT(_sceneAllowOverlayCompositeRT, {
    width,
    height,
    resolution,
  });

  const capturedObjects = _captureDisplayObjectsIntoSceneAllowRT(_sceneAllowOverlayObjectRT, suppressObjects);
  if (!capturedObjects) return false;

  if (!_renderSceneSuppressionClipMaskRT(_sceneAllowOverlayRegionRT, region, stageMatrix, edgeFadePercent))
    return false;
  if (!_clearSceneAllowOverlayRT(_sceneAllowOverlayCompositeRT)) return false;

  const { sprite, filter } = _getSceneAllowOverlayRestoreSprite();

  try {
    sprite.texture = _sceneAllowOverlayObjectRT;
    sprite.position.set(0, 0);
    sprite.width = Math.max(1, Number(width) || 1);
    sprite.height = Math.max(1, Number(height) || 1);
    sprite.alpha = 1;
    sprite.blendMode = PIXI.BLEND_MODES.NORMAL;
    filter.uniforms.clipSampler = _sceneAllowOverlayRegionRT;
    sprite.filters = [filter];

    renderer.render(sprite, { renderTexture: _sceneAllowOverlayCompositeRT, clear: false });

    sprite.filters = null;
    sprite.texture = _sceneAllowOverlayCompositeRT;
    sprite.position.set(0, 0);
    sprite.width = Math.max(1, Number(width) || 1);
    sprite.height = Math.max(1, Number(height) || 1);
    sprite.alpha = 1;
    sprite.blendMode = PIXI.BLEND_MODES.ERASE;

    renderer.render(sprite, { renderTexture: sceneAllowRT, clear: false });
    return true;
  } catch (err) {
    logger.debug("FXMaster:", err);
    return false;
  } finally {
    sprite.filters = null;
    sprite.blendMode = PIXI.BLEND_MODES.NORMAL;
    sprite.texture = PIXI.Texture.EMPTY;
  }
}

/**
 * Destroy a texture after the current render cycle has finished.
 *
 * Resolution or viewport changes can force a new render texture allocation while sprites and shader uniforms still reference the previous texture for the current frame. Deferring destruction avoids transient null `texture.orig` access during Sprite vertex calculation.
 *
 * @param {PIXI.Texture|PIXI.RenderTexture|null} texture
 * @returns {void}
 * @private
 */
function _destroyTextureDeferred(texture) {
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

/** @type {{ solids: PIXI.Graphics, holes: PIXI.Graphics }|null} */
let _regionMaskGfx = null;

/** @returns {{ solids: PIXI.Graphics, holes: PIXI.Graphics }} */
export function _getRegionMaskGfx() {
  if (_regionMaskGfx?.solids && _regionMaskGfx?.holes) return _regionMaskGfx;
  _regionMaskGfx = { solids: new PIXI.Graphics(), holes: new PIXI.Graphics() };
  return _regionMaskGfx;
}

/** @type {PIXI.Point|null} */

/** @type {{ bg: PIXI.Graphics, scene: PIXI.Graphics, solids: PIXI.Graphics, holes: PIXI.Graphics }|null} */
let _sceneAllowMaskGfx = null;

/** @returns {{ bg: PIXI.Graphics, scene: PIXI.Graphics, solids: PIXI.Graphics, holes: PIXI.Graphics }} */
export function _getSceneAllowMaskGfx() {
  if (_sceneAllowMaskGfx?.bg && _sceneAllowMaskGfx?.scene && _sceneAllowMaskGfx?.solids && _sceneAllowMaskGfx?.holes)
    return _sceneAllowMaskGfx;
  _sceneAllowMaskGfx = {
    bg: new PIXI.Graphics(),
    scene: new PIXI.Graphics(),
    solids: new PIXI.Graphics(),
    holes: new PIXI.Graphics(),
  };
  return _sceneAllowMaskGfx;
}

/**
 * Interpret a `belowTokens` option consistently. Supports booleans, `{ value: boolean }`, and legacy truthy/falsy values.
 * @param {*} v
 * @returns {boolean}
 * @private
 */
export function _belowTokensEnabled(v) {
  if (v === true) return true;
  if (v && typeof v === "object" && "value" in v) return !!v.value;
  return !!v;
}

/**
 * Interpret a `belowTiles` option consistently. Supports booleans, `{ value: boolean }`, and legacy truthy/falsy values.
 * @param {*} v
 * @returns {boolean}
 * @private
 */
export function _belowTilesEnabled(v) {
  if (v === true) return true;
  if (v && typeof v === "object" && "value" in v) return !!v.value;
  return !!v;
}

/**
 * Interpret a `belowForeground` option consistently. Supports booleans, `{ value: boolean }`, and legacy truthy/falsy values.
 * @param {*} v
 * @returns {boolean}
 * @private
 */
export function _belowForegroundEnabled(v) {
  if (v === true) return true;
  if (v && typeof v === "object" && "value" in v) return !!v.value;
  return !!v;
}

/**
 * RenderTexture pool.
 */
export class RTPool {
  /**
   * @param {{maxPerKey?:number}} [opts]
   */
  constructor({ maxPerKey = 8 } = {}) {
    this._pool = new Map();
    this._maxPerKey = Math.max(1, maxPerKey | 0);
  }
  /**
   * @param {number} w
   * @param {number} h
   * @param {number} [res=1]
   * @returns {string}
   * @private
   */
  _key(w, h, res = 1) {
    const width = Math.max(1, Number(w) || 1);
    const height = Math.max(1, Number(h) || 1);
    return `${width.toFixed(3)}x${height.toFixed(3)}@${Number(res || 1).toFixed(4)}`;
  }

  /**
   * Acquire a RenderTexture.
   * @param {number} w
   * @param {number} h
   * @param {number} [res=1]
   * @returns {PIXI.RenderTexture}
   */
  acquire(w, h, res = 1) {
    const key = this._key(w, h, res);
    const list = this._pool.get(key);
    if (list && list.length) {
      const rt = list.pop();
      if (list.length) this._pool.set(key, list);
      else this._pool.delete(key);
      return rt;
    }
    return PIXI.RenderTexture.create({
      width: Math.max(1, Number(w) || 1),
      height: Math.max(1, Number(h) || 1),
      resolution: res || 1,
    });
  }

  /**
   * Release a RenderTexture back to the pool.
   * @param {PIXI.RenderTexture} rt
   */
  release(rt) {
    if (!rt) return;
    try {
      const key = this._key(rt.width, rt.height, rt.resolution || 1);
      const list = this._pool.get(key) || [];
      list.push(rt);
      this._pool.set(key, list);
      while (list.length > this._maxPerKey) {
        const old = list.shift();
        try {
          old.destroy(true);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }
    } catch {
      try {
        rt.destroy(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
  }

  /**
   * Destroy all pooled textures and clear the pool.
   */
  drain() {
    try {
      for (const list of this._pool.values())
        for (const rt of list)
          try {
            rt.destroy(true);
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
    } finally {
      this._pool.clear();
    }
  }
}

/** @type {PIXI.Sprite[]} */
const _tokenSpritePool = [];

/** @type {PIXI.Sprite[]} */
const _tileSpritePool = [];

/**
 * Return a stable key for viewport-dependent below-object calculations.
 *
 * @returns {string}
 * @private
 */
function _belowObjectViewportFrameKey() {
  const ticker = canvas?.app?.ticker ?? null;
  const frameTime = Number(ticker?.lastTime ?? 0) || 0;
  const matrix = snappedStageMatrix();
  const matrixKey = matrix
    ? [matrix.a, matrix.b, matrix.c, matrix.d, matrix.tx, matrix.ty]
        .map((value) => (Number.isFinite(Number(value)) ? Number(value).toFixed(3) : "NaN"))
        .join(",")
    : "no-matrix";
  return [canvas?.scene?.id ?? "scene", frameTime.toFixed(3), matrixKey].join("|");
}

/**
 * Return whether a screen-space bounds object intersects the CSS viewport.
 *
 * @param {{x:number,y:number,width:number,height:number}|null|undefined} bounds
 * @param {number} [padding=8]
 * @returns {boolean}
 * @private
 */
function _cssBoundsIntersectsViewport(bounds, padding = 8) {
  if (!bounds) return true;
  const x = Number(bounds.x);
  const y = Number(bounds.y);
  const width = Number(bounds.width);
  const height = Number(bounds.height);
  if (![x, y, width, height].every(Number.isFinite)) return true;
  if (width <= 0 || height <= 0) return false;

  const { cssW, cssH } = getCssViewportMetrics();
  if (x > cssW + padding) return false;
  if (y > cssH + padding) return false;
  if (x + width < -padding) return false;
  if (y + height < -padding) return false;
  return true;
}

/**
 * Return whether a live display object intersects the CSS viewport.
 *
 * @param {PIXI.DisplayObject|null|undefined} object
 * @param {number} [padding=8]
 * @returns {boolean}
 * @private
 */
function _displayObjectIntersectsViewportForMask(object, padding = 8) {
  if (!object || object.destroyed) return false;
  try {
    const bounds = object.getBounds?.(false) ?? null;
    return _cssBoundsIntersectsViewport(bounds, padding);
  } catch (err) {
    logger.debug("FXMaster:", err);
    return true;
  }
}

/**
 * Return whether world-space bounds intersect the current CSS viewport after camera transform.
 *
 * @param {{x?:number,y?:number,width?:number,height?:number,left?:number,right?:number,top?:number,bottom?:number}|null|undefined} bounds
 * @param {number} [padding=8]
 * @returns {boolean}
 * @private
 */
function _worldBoundsIntersectsViewportForMask(bounds, padding = 8) {
  if (!bounds) return true;

  const x0 = Number(bounds.x ?? bounds.left);
  const y0 = Number(bounds.y ?? bounds.top);
  const x1 = Number(bounds.right ?? (Number.isFinite(Number(bounds.width)) ? x0 + Number(bounds.width) : Number.NaN));
  const y1 = Number(
    bounds.bottom ?? (Number.isFinite(Number(bounds.height)) ? y0 + Number(bounds.height) : Number.NaN),
  );
  if (![x0, y0, x1, y1].every(Number.isFinite)) return true;

  const matrix = snappedStageMatrix();
  if (!matrix) return true;

  const points = [
    matrix.apply(new PIXI.Point(x0, y0), new PIXI.Point()),
    matrix.apply(new PIXI.Point(x1, y0), new PIXI.Point()),
    matrix.apply(new PIXI.Point(x1, y1), new PIXI.Point()),
    matrix.apply(new PIXI.Point(x0, y1), new PIXI.Point()),
  ];
  const xs = points.map((point) => Number(point.x)).filter(Number.isFinite);
  const ys = points.map((point) => Number(point.y)).filter(Number.isFinite);
  if (!xs.length || !ys.length) return true;

  return _cssBoundsIntersectsViewport(
    {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    },
    padding,
  );
}

/**
 * Return whether a token can affect a CSS-space below-token mask this frame.
 *
 * @param {Token|null|undefined} token
 * @returns {boolean}
 * @private
 */
function _tokenIntersectsViewportForMask(token) {
  if (!token || token.destroyed) return false;
  const object = token.mesh ?? token;
  if (_displayObjectIntersectsViewportForMask(object)) return true;
  return _worldBoundsIntersectsViewportForMask(token.bounds ?? token.document?.bounds ?? null);
}

/**
 * Return whether a tile candidate can affect a CSS-space below-tile mask this frame.
 *
 * @param {{ tile?: Tile|null, mesh?: PIXI.DisplayObject|null }|Tile|null|undefined} candidate
 * @returns {boolean}
 * @private
 */
function _tileCandidateIntersectsViewportForMask(candidate) {
  const tile = _getTileMaskCandidateTile(candidate);
  const mesh = _getTileMaskCandidateMesh(candidate);
  if (mesh && _displayObjectIntersectsViewportForMask(mesh)) return true;
  if (tile?.mesh && tile.mesh !== mesh && _displayObjectIntersectsViewportForMask(tile.mesh)) return true;
  return _worldBoundsIntersectsViewportForMask(tile?.bounds ?? tile?.document?.bounds ?? null);
}

/**
 * Return whether at least one active tile mask candidate has visible coverage in the current viewport.
 *
 * @param {{ mode?: "visible"|"suppression"|"weatherReveal", restrictionKind?: "particles"|"filters"|"weather", shouldIncludeTile?: ((tile: Tile) => boolean)|null }} [opts]
 * @returns {boolean}
 */
export function hasTileMaskCoverage({ mode = "visible", restrictionKind = "weather", shouldIncludeTile = null } = {}) {
  for (const candidate of getTileMaskCandidates({ shouldIncludeTile })) {
    if (mode === "weatherReveal") {
      if (getTileWeatherRevealMaskAlpha(candidate, { restrictionKind }) > 0.001) return true;
      continue;
    }

    if (mode === "suppression") {
      if (getTileSuppressionMaskAlpha(candidate, { restrictionKind }) > 0.001) return true;
      continue;
    }

    if (getTileVisibleMaskAlpha(candidate) > 0.001) return true;
  }
  return false;
}

/**
 * Return whether any active current-viewport tile needs a dedicated suppression mask for the requested pipeline.
 *
 * Without restrictive tiles, the suppression tile mask is identical to the visible tile mask, so callers can reuse visible coverage and avoid an extra full-viewport repaint.
 *
 * @param {"particles"|"filters"|"weather"} [restrictionKind="weather"]
 * @returns {boolean}
 */
export function hasActiveTileRestrictionsForMask(restrictionKind = "weather") {
  const kind = restrictionKind === "particles" || restrictionKind === "filters" ? restrictionKind : "weather";
  for (const candidate of getTileMaskCandidates()) {
    if (!tileRestrictsWeatherForMask(candidate, kind)) continue;
    const suppressionAlpha = getTileSuppressionMaskAlpha(candidate, { restrictionKind: kind });
    if (suppressionAlpha <= 0.001) continue;

    /**
     * Fully visible restrictive tiles produce the same coverage as the visible tile mask. A dedicated suppression repaint is only needed when the restrictive tile is partially faded/hover-revealed or otherwise less opaque than its suppressive contribution.
     */
    const visibleAlpha = getTileVisibleMaskAlpha(candidate);
    if (Math.abs(suppressionAlpha - visibleAlpha) > 0.001) return true;
  }
  return false;
}

/**
 * Return a sprite from the pool or create a new one.
 * @param {PIXI.Texture} tex
 * @returns {PIXI.Sprite}
 * @private
 */
function _acquireTokenSprite(tex) {
  const spr = _tokenSpritePool.pop() ?? new PIXI.Sprite();
  spr.texture = tex;
  return spr;
}

/**
 * Return a tile sprite from the pool or create a new one.
 * @param {PIXI.Texture} tex
 * @returns {PIXI.Sprite}
 * @private
 */
function _acquireTileSprite(tex) {
  const spr = _tileSpritePool.pop() ?? new PIXI.Sprite();
  spr.texture = tex;
  return spr;
}

/**
 * Flush pending token render state before token silhouette sampling.
 *
 * @param {Token|null|undefined} token
 * @returns {void}
 * @private
 */
function _syncTokenMaskTransform(token) {
  if (!token || token.destroyed) return;

  try {
    token.applyRenderFlags?.();
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  try {
    fxmUpdateDisplayObjectWorldTransform(token);
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  try {
    fxmUpdateDisplayObjectWorldTransform(token.mesh);
  } catch (err) {
    logger.debug("FXMaster:", err);
  }
}

/**
 * Return token drag previews that are currently rendered instead of the original placeable.
 *
 * @returns {Token[]}
 * @private
 */
function _collectDraggingTokenPreviewsForMask() {
  const previews = [];
  for (const token of canvas?.tokens?.preview?.children ?? []) {
    if (!token || token.destroyed) continue;
    if (token.visible === false || token.renderable === false) continue;
    if (token.isPreview !== true && token.previewType !== "dragging") continue;
    previews.push(token);
  }
  return previews;
}

/**
 * Return token objects that should contribute to below-token coverage.
 *
 * During drag, Foundry renders a preview token while the original token placeable can remain at the previous position. The visible preview replaces the original token in below-token coverage so silhouettes follow the rendered token during movement.
 *
 * @returns {Token[]}
 */
export function collectBelowTokenMaskTokens() {
  const previews = _collectDraggingTokenPreviewsForMask();
  const previewDocumentIds = new Set(
    previews.map((token) => token?.document?.id ?? token?.id ?? null).filter((id) => id !== null && id !== undefined),
  );
  const tokens = [];

  for (const token of canvas?.tokens?.placeables ?? []) {
    const tokenId = token?.document?.id ?? token?.id ?? null;
    if (tokenId && previewDocumentIds.has(tokenId)) continue;
    tokens.push(token);
  }

  tokens.push(...previews);
  for (const token of tokens) _syncTokenMaskTransform(token);
  return tokens;
}

/**
 * Build a compact signature for tokens that participate in below-token coverage.
 *
 * @returns {string}
 */
export function buildBelowTokenMaskCoverageSignature() {
  const parts = [];
  for (const token of collectBelowTokenMaskTokens()) {
    if (!token || token.destroyed) continue;
    if (!_tokenIntersectsViewportForMask(token)) continue;
    if (!_tokenParticipatesInBelowTokenMask(token)) continue;

    const tokenId = token?.document?.uuid ?? token?.document?.id ?? token?.id ?? "";
    const source = token.isPreview === true || token.previewType === "dragging" ? "preview" : "placeable";
    const mesh = token?.mesh ?? token;
    let transformKey = "";
    try {
      transformKey = fxmDisplayObjectTransformSignature(mesh);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    const bounds = token?.bounds ?? null;
    const boundsKey = bounds
      ? [bounds.x, bounds.y, bounds.width, bounds.height].map((value) => Number(value || 0).toFixed(3)).join(",")
      : "no-bounds";
    parts.push(
      [
        tokenId,
        source,
        token.visible === false ? 0 : 1,
        token.renderable === false ? 0 : 1,
        token?.document?.hidden ? 1 : 0,
        transformKey,
        boundsKey,
      ].join(":"),
    );
  }
  return parts.sort().join("|");
}

/**
 * Return sprites to the token pool for reuse, reducing allocation churn during frequent mask repaints.
 * @param {PIXI.Sprite[]} sprites
 */
export function releaseTokenSprites(sprites) {
  for (const spr of sprites) {
    if (!spr || spr.destroyed) continue;
    try {
      spr.texture = PIXI.Texture.EMPTY;
      if (spr.parent) spr.parent.removeChild(spr);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    _tokenSpritePool.push(spr);
  }
}

/**
 * Return sprites to the tile pool for reuse, reducing allocation churn during repeated tile-mask repaints.
 * @param {PIXI.Sprite[]} sprites
 */
export function releaseTileSprites(sprites) {
  for (const spr of sprites) {
    if (!spr || spr.destroyed) continue;
    try {
      spr.texture = PIXI.Texture.EMPTY;
      if (spr.parent) spr.parent.removeChild(spr);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    _tileSpritePool.push(spr);
  }
}

/**
 * Collect token sprites in world space for alpha masking.
 *
 * @param {{ respectOcclusion?: boolean, excludeOccludedByTiles?: boolean, excludedTokens?: Set<Token>|null, shouldIncludeToken?: (t: Token) => boolean }} [opts]
 * @returns {PIXI.Sprite[]}
 */
export function collectTokenAlphaSprites(opts = {}) {
  const respectOcc = !!opts.respectOcclusion;
  const excludeOccludedByTiles = !!opts.excludeOccludedByTiles;
  const shouldInclude = typeof opts.shouldIncludeToken === "function" ? opts.shouldIncludeToken : null;
  const excludedTokens =
    opts.excludedTokens instanceof Set ? opts.excludedTokens : excludeOccludedByTiles ? getTileOccludedTokens() : null;

  const out = [];
  for (const t of collectBelowTokenMaskTokens()) {
    if (!_tokenIntersectsViewportForMask(t)) continue;
    if (!_tokenParticipatesInBelowTokenMask(t)) continue;

    if (t.hasDynamicRing) continue;

    if (respectOcc && _isTokenOccludedByOverhead(t)) continue;
    if (excludedTokens?.has(t)) continue;
    if (shouldInclude && !shouldInclude(t)) continue;

    const icon = t.mesh ?? t;
    const tex = icon?.texture;
    if (!tex?.baseTexture?.valid) continue;

    const spr = _acquireTokenSprite(tex);
    try {
      spr.anchor.set(icon.anchor?.x ?? 0.5, icon.anchor?.y ?? 0.5);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      const stageLocal = stageLocalMatrixOf(icon);
      const vals = [stageLocal.a, stageLocal.b, stageLocal.c, stageLocal.d, stageLocal.tx, stageLocal.ty];
      if (!vals.every(Number.isFinite)) {
        spr.destroy(true);
        continue;
      }
      if (vals.some((v) => Math.abs(v) > 1e7)) {
        spr.destroy(true);
        continue;
      }
      spr.transform.setFromMatrix(stageLocal);
    } catch {
      try {
        spr.destroy(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      continue;
    }
    out.push(spr);
  }
  return out;
}

/**
 * Resolve the tile placeable represented by a tile-mask candidate.
 *
 * @param {{ tile?: Tile|null }|Tile|null|undefined} candidate
 * @returns {Tile|null}
 * @private
 */
function _getTileMaskCandidateTile(candidate) {
  return candidate?.tile ?? candidate ?? null;
}

/**
 * Resolve the live mesh represented by a tile-mask candidate.
 *
 * @param {{ tile?: Tile|null, mesh?: PIXI.DisplayObject|null }|Tile|null|undefined} candidate
 * @returns {PIXI.DisplayObject|null}
 * @private
 */
function _getTileMaskCandidateMesh(candidate) {
  return candidate?.mesh ?? candidate?.tile?.mesh ?? candidate?.mesh ?? null;
}

/**
 * Return the live primary-tile surfaces that currently participate in tile masking.
 *
 * Native Levels can render multiple live primary meshes for the same Tile document. Those meshes must be preserved individually so below-tiles masking follows every rendered surface instead of collapsing back to a single placeable mesh.
 *
 * @returns {Array<{ tile: Tile, mesh: PIXI.DisplayObject|null }>}
 * @private
 */
function _getPrimaryTileMaskCandidates() {
  const candidates = [];
  const seenMeshes = new Set();
  const primaryTileMeshes =
    typeof canvas?.primary?.tiles?.values === "function"
      ? Array.from(canvas.primary.tiles.values())
      : Array.from(canvas?.primary?.tiles ?? []);

  for (const mesh of primaryTileMeshes) {
    if (!mesh || seenMeshes.has(mesh)) continue;
    seenMeshes.add(mesh);

    const tile = _resolveTilePlaceable(mesh);
    if (!tile) continue;
    candidates.push({ tile, mesh });
  }

  if (candidates.length) return candidates;

  for (const tile of canvas?.tiles?.placeables ?? []) {
    const mesh = tile?.mesh ?? null;
    if (mesh && seenMeshes.has(mesh)) continue;
    if (mesh) seenMeshes.add(mesh);
    candidates.push({ tile, mesh });
  }

  return candidates;
}

/**
 * Return whether a tile candidate is currently rendered or otherwise active on the live canvas.
 *
 * Upper-level tiles can remain relevant for masking even when they do not belong to the currently viewed Level because their primary mesh is still rendered into the scene. Hover-revealed or occluded tiles also remain active so Restricts Weather handling continues to match the live canvas.
 *
 * @param {{ tile?: Tile|null, mesh?: PIXI.DisplayObject|null }|Tile|null|undefined} candidate
 * @returns {boolean}
 * @private
 */
function _tileCandidateIsActiveOnCanvas(candidate) {
  const tile = _getTileMaskCandidateTile(candidate);
  const mesh = _getTileMaskCandidateMesh(candidate);
  if (!tile) return false;

  const visible = typeof tile?.isVisible === "boolean" ? tile.isVisible : tile?.visible;
  const meshVisible = mesh?.visible;
  const renderable = mesh?.renderable;
  const worldAlpha = Number(mesh?.worldAlpha ?? mesh?.alpha ?? tile?.alpha ?? tile?.document?.alpha ?? 0);
  if ((mesh ? meshVisible !== false && renderable !== false : visible !== false) && worldAlpha > 0.001) return true;

  const hoverFadeState = fxmGetPublicHoverFadeState(mesh, tile);
  if (hoverFadeState?.faded) return true;

  const fadeOcclusion = getTileFadeOcclusionAmount(candidate);
  if (Number.isFinite(fadeOcclusion) && fadeOcclusion > 0) return true;

  if (tile?.occluded === true) return true;
  return false;
}

/**
 * Return whether a tile is eligible to participate in tile masking.
 *
 * Document-hidden tiles never contribute. Hover-revealed tiles remain eligible so suppression masks can preserve Restricts Weather semantics even while the tile is visually faded or temporarily not renderable.
 *
 * @param {{ tile?: Tile|null, mesh?: PIXI.DisplayObject|null }|Tile|null|undefined} candidate
 * @returns {boolean}
 */
function tileIsEligibleForMask(candidate) {
  const tile = _getTileMaskCandidateTile(candidate);
  if (!tile || tile.document?.hidden) return false;
  if (!canvas?.level) return true;
  if (isDocumentOnCurrentCanvasLevel(tile.document ?? null, tile.document?.elevation ?? tile?.elevation ?? Number.NaN))
    return true;
  return _tileCandidateIsActiveOnCanvas(candidate);
}

/**
 * Return whether a tile document explicitly Restricts Weather.
 *
 * FXMaster's transparent-tile weather masking and below-tiles suppression should follow the authored {@link TileDocument#restrictions}. Live placeable or mesh flags can remain truthy during native hover-fade and occlusion updates even after the author disables Restrict Weather, which would keep transparent tile coverage masked unexpectedly. Treat only an explicit document `weather === true` value as restrictive; undefined and other legacy fallbacks are handled as false for masking.
 *
 * @param {{ tile?: Tile|null, mesh?: PIXI.DisplayObject|null }|Tile|null|undefined} candidate
 * @returns {boolean}
 */
export function tileDocumentRestrictsWeather(candidate) {
  const tile = _getTileMaskCandidateTile(candidate);
  return tile?.document?.restrictions?.weather === true;
}

/**
 * Read an FXMaster tile restriction flag, accepting both booleans and migrated string/number values.
 *
 * @param {{ tile?: Tile|null, mesh?: PIXI.DisplayObject|null }|Tile|null|undefined} candidate
 * @param {string} key
 * @returns {boolean}
 */
function tileDocumentHasFxMasterRestrictionFlag(candidate, key) {
  const tile = _getTileMaskCandidateTile(candidate);
  const doc = tile?.document ?? null;
  const value = doc?.getFlag?.(packageId, key) ?? doc?.flags?.[packageId]?.[key];
  return value === true || value === "true" || value === 1 || value === "1";
}

/**
 * Return whether a tile restricts FXMaster particles. Core Restricts Weather remains broad and therefore also restricts particles.
 *
 * @param {{ tile?: Tile|null, mesh?: PIXI.DisplayObject|null }|Tile|null|undefined} candidate
 * @returns {boolean}
 */
export function tileDocumentRestrictsParticles(candidate) {
  return (
    tileDocumentRestrictsWeather(candidate) || tileDocumentHasFxMasterRestrictionFlag(candidate, "restrictsParticles")
  );
}

/**
 * Return whether a tile restricts FXMaster filters. Core Restricts Weather remains broad and therefore also restricts filters.
 *
 * @param {{ tile?: Tile|null, mesh?: PIXI.DisplayObject|null }|Tile|null|undefined} candidate
 * @returns {boolean}
 */
export function tileDocumentRestrictsFilters(candidate) {
  return (
    tileDocumentRestrictsWeather(candidate) || tileDocumentHasFxMasterRestrictionFlag(candidate, "restrictsFilters")
  );
}

/**
 * Return whether a tile restricts weather effects for FXMaster masking.
 *
 * @param {{ tile?: Tile|null, mesh?: PIXI.DisplayObject|null }|Tile|null|undefined} candidate
 * @param {"particles"|"filters"|"weather"|null} [kind="weather"]
 * @returns {boolean}
 */
export function tileRestrictsWeatherForMask(candidate, kind = "weather") {
  if (kind === "particles") return tileDocumentRestrictsParticles(candidate);
  if (kind === "filters") return tileDocumentRestrictsFilters(candidate);
  return tileDocumentRestrictsWeather(candidate);
}

/**
 * Resolve the configured alpha a tile should fade toward when occluded or hover-faded.
 *
 * Foundry stores this on the tile document, but active primary meshes may also carry the live uniform on their shader or filter stack. The live mesh is probed first so mask rebuilds track the currently rendered tile state as closely as possible.
 *
 * @param {{ tile?: Tile|null, mesh?: PIXI.DisplayObject|null }|Tile|null|undefined} candidate
 * @returns {number}
 */
function getTileOcclusionAlpha(candidate) {
  const tile = _getTileMaskCandidateTile(candidate);
  const mesh = _getTileMaskCandidateMesh(candidate);
  const candidates = [
    mesh?.occludedAlpha,
    mesh?.shader?.uniforms?.occludedAlpha,
    mesh?.occlusionFilter?.uniforms?.occludedAlpha,
    mesh?.filters?.find?.((f) => Number.isFinite(f?.uniforms?.occludedAlpha))?.uniforms?.occludedAlpha,
    mesh?.shader?.uniforms?.alphaOcclusion,
    mesh?.occlusionFilter?.uniforms?.alphaOcclusion,
    mesh?.filters?.find?.((f) => Number.isFinite(f?.uniforms?.alphaOcclusion))?.uniforms?.alphaOcclusion,
    tile?.document?.occlusion?.alpha,
    tile?.document?.occludedAlpha,
    tile?.occludedAlpha,
  ];

  for (const valueCandidate of candidates) {
    const value = Number(valueCandidate);
    if (Number.isFinite(value)) return Math.max(0, Math.min(1, value));
  }

  return 1;
}

/**
 * Resolve the unoccluded alpha a tile is currently rendered with.
 *
 * Modern Foundry overhead tiles are rendered by an occludable sampler which tracks both the unoccluded alpha and the current FADE occlusion amount independently. Scene mask generation needs the unoccluded alpha specifically so hover-fade math can reconstruct the live visible alpha instead of sampling the placeable's static target alpha.
 *
 * @param {{ tile?: Tile|null, mesh?: PIXI.DisplayObject|null }|Tile|null|undefined} candidate
 * @returns {number}
 */
function getTileUnoccludedAlpha(candidate) {
  const tile = _getTileMaskCandidateTile(candidate);
  const mesh = _getTileMaskCandidateMesh(candidate);
  const candidates = [
    mesh?.unoccludedAlpha,
    mesh?.shader?.uniforms?.unoccludedAlpha,
    mesh?.occlusionFilter?.uniforms?.unoccludedAlpha,
    mesh?.filters?.find?.((f) => Number.isFinite(f?.uniforms?.unoccludedAlpha))?.uniforms?.unoccludedAlpha,
  ];

  for (const valueCandidate of candidates) {
    const value = Number(valueCandidate);
    if (Number.isFinite(value)) return Math.max(0, Math.min(1, value));
  }

  let alpha = fxmGetPlaceableTargetAlphaCompat(tile);
  if (!Number.isFinite(alpha)) {
    alpha = Number(tile?.alpha ?? tile?.document?.alpha ?? mesh?.alpha ?? mesh?.worldAlpha ?? 1);
  }

  return Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 1));
}

/**
 * Resolve the current full-tile fade/hover occlusion amount.
 *
 * Foundry's occludable tile rendering tracks this as `fadeOcclusion`, while newer hover fade state also exposes a normalized `occlusion` amount. Either value represents the current blend factor between the unoccluded and occluded tile alpha states.
 *
 * @param {{ tile?: Tile|null, mesh?: PIXI.DisplayObject|null }|Tile|null|undefined} candidate
 * @returns {number|null}
 */
function getTileFadeOcclusionAmount(candidate) {
  const tile = _getTileMaskCandidateTile(candidate);
  const mesh = _getTileMaskCandidateMesh(candidate);
  const candidates = [
    mesh?.hoverFadeState?.occlusion,
    tile?.hoverFadeState?.occlusion,
    mesh?.fadeOcclusion,
    mesh?.shader?.uniforms?.fadeOcclusion,
    mesh?.occlusionFilter?.uniforms?.fadeOcclusion,
    mesh?.filters?.find?.((f) => Number.isFinite(f?.uniforms?.fadeOcclusion))?.uniforms?.fadeOcclusion,
  ];

  for (const valueCandidate of candidates) {
    const value = Number(valueCandidate);
    if (Number.isFinite(value)) return Math.max(0, Math.min(1, value));
  }

  return null;
}

/**
 * Apply live hover or occlusion fade state from the tile mesh to a mask alpha estimate.
 *
 * Hover fading in modern Foundry is tracked separately from the placeable's base alpha. When the mesh exposes a hover-fade occlusion amount, blend from the unoccluded alpha toward the tile's configured occlusion alpha so the mask tracks native fade behavior.
 *
 * @param {{ tile?: Tile|null, mesh?: PIXI.DisplayObject|null }|Tile|null|undefined} candidate
 * @param {number} alpha
 * @returns {number}
 */
function applyTileHoverFadeAlpha(candidate, alpha) {
  const occlusionAmount = getTileFadeOcclusionAmount(candidate);
  if (!Number.isFinite(occlusionAmount)) return alpha;

  const t = Math.max(0, Math.min(1, occlusionAmount));
  const occludedAlpha = getTileOcclusionAlpha(candidate);
  return alpha * (1 - t + t * occludedAlpha);
}

/**
 * Return the current visual alpha of a tile for mask composition.
 *
 * The result follows the live tile fade state so below-tiles effects can appear when a non-restricting overhead tile is hovered or otherwise revealed.
 *
 * @param {{ tile?: Tile|null, mesh?: PIXI.DisplayObject|null }|Tile|null|undefined} candidate
 * @returns {number}
 */
function getTileVisibleMaskAlpha(candidate) {
  if (!tileIsEligibleForMask(candidate)) return 0;

  const tile = _getTileMaskCandidateTile(candidate);
  const mesh = _getTileMaskCandidateMesh(candidate);
  let alpha = applyTileHoverFadeAlpha(candidate, getTileUnoccludedAlpha(candidate));

  const liveVisualAlpha = [mesh?.worldAlpha, mesh?.alpha, tile?.worldAlpha, tile?.alpha]
    .map((value) => Number(value))
    .filter(Number.isFinite)
    .map((value) => Math.max(0, Math.min(1, value)))
    .reduce((min, value) => Math.min(min, value), Number.POSITIVE_INFINITY);

  if (Number.isFinite(liveVisualAlpha)) {
    alpha = Number.isFinite(alpha) ? Math.min(alpha, liveVisualAlpha) : liveVisualAlpha;
  }

  if (!Number.isFinite(alpha)) {
    alpha = Number(mesh?.worldAlpha ?? mesh?.alpha ?? tile?.worldAlpha ?? tile?.alpha ?? tile?.document?.alpha ?? 1);
  }

  const visible = typeof tile?.isVisible === "boolean" ? tile.isVisible : tile?.visible;
  const renderable = mesh?.renderable;
  const meshVisible = mesh?.visible;
  alpha = Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 0));

  if (mesh) {
    if (meshVisible === false || renderable === false) return 0;
  } else if (visible === false) return 0;
  return alpha > 0.001 ? alpha : 0;
}

/**
 * Return the alpha contribution a tile should make to a tile-suppression mask.
 *
 * Restricts Weather tiles remain fully suppressive even while hovered or revealed. Non-restricting tiles follow their current visual alpha.
 *
 * @param {{ tile?: Tile|null, mesh?: PIXI.DisplayObject|null }|Tile|null|undefined} candidate
 * @returns {number}
 */
function getTileSuppressionMaskAlpha(candidate, { restrictionKind = "weather" } = {}) {
  if (!tileIsEligibleForMask(candidate)) return 0;
  if (tileRestrictsWeatherForMask(candidate, restrictionKind)) return 1;
  return getTileVisibleMaskAlpha(candidate);
}

/**
 * Return the alpha contribution a tile should make to a reveal mask for Restricts Weather handling.
 *
 * The returned alpha tracks the amount of the tile that has faded away. This is used when a filter normally renders on top of tiles, but transparent portions of a Restricts Weather tile must still suppress the filter from appearing behind it.
 *
 * @param {{ tile?: Tile|null, mesh?: PIXI.DisplayObject|null }|Tile|null|undefined} candidate
 * @returns {number}
 */
function getTileWeatherRevealMaskAlpha(candidate, { restrictionKind = "weather" } = {}) {
  if (!tileIsEligibleForMask(candidate)) return 0;
  if (!tileRestrictsWeatherForMask(candidate, restrictionKind)) return 0;

  const visibleAlpha = getTileVisibleMaskAlpha(candidate);
  const revealAlpha = Math.max(0, Math.min(1, 1 - visibleAlpha));
  return revealAlpha > 0.001 ? revealAlpha : 0;
}

/**
 * Determine whether a tile should contribute to the below-tiles mask.
 *
 * Below-tiles composition now treats every eligible scene tile as participating by default so effects can reliably render underneath all tiles on the scene. `includeBackground` is retained for API compatibility but no longer changes the default selection behavior.
 *
 * @param {{ tile?: Tile|null, mesh?: PIXI.DisplayObject|null }|Tile|null|undefined} candidate
 * @param {{ includeBackground?: boolean, shouldIncludeTile?: (t: Tile) => boolean }} [opts]
 * @returns {boolean}
 */
function shouldUseTileForMask(candidate, opts = {}) {
  const tile = _getTileMaskCandidateTile(candidate);
  if (!tileIsEligibleForMask(candidate)) return false;

  const shouldInclude = typeof opts.shouldIncludeTile === "function" ? opts.shouldIncludeTile : null;
  if (shouldInclude && !shouldInclude(tile)) return false;

  void opts?.includeBackground;
  return true;
}

/**
 * Return the current set of tile surfaces that participate in tile masking.
 *
 * @param {{ includeBackground?: boolean, shouldIncludeTile?: (t: Tile) => boolean }} [opts]
 * @returns {Array<{ tile: Tile, mesh: PIXI.DisplayObject|null }>}
 */
function getTileMaskCandidates(opts = {}) {
  const candidates = _getPrimaryTileMaskCandidates();
  const shouldInclude = typeof opts.shouldIncludeTile === "function" ? opts.shouldIncludeTile : null;
  const includeBackground = !!opts.includeBackground;
  return candidates.filter(
    (candidate) =>
      _tileCandidateIntersectsViewportForMask(candidate) &&
      shouldUseTileForMask(candidate, { includeBackground, shouldIncludeTile: shouldInclude }),
  );
}

/**
 * Render an empty clear pass into a tile mask render texture.
 *
 * @param {PIXI.RenderTexture} outRT
 * @returns {void}
 */
function clearTileMaskRenderTexture(outRT) {
  const r = canvas?.app?.renderer;
  if (!r || !outRT) return;
  const cont = (_tmpTileMaskClearContainer ??= new PIXI.Container());
  try {
    cont.removeChildren();
    r.render(cont, { renderTexture: outRT, clear: true, skipUpdateTransform: false });
  } catch (err) {
    logger.debug("FXMaster:", err);
  }
}

function _tileMaskStageMatrix() {
  return rawStageMatrix();
}

/**
 * Render pooled tile sprites into a mask render texture.
 *
 * @param {PIXI.RenderTexture} outRT
 * @param {PIXI.Sprite[]} sprites
 * @param {{ clear?: boolean, blendMode?: number }} [opts]
 * @returns {boolean}
 */
function renderTileSpritesIntoRT(outRT, sprites, { clear = true, blendMode = PIXI.BLEND_MODES.NORMAL } = {}) {
  const r = canvas?.app?.renderer;
  if (!r || !outRT) return false;

  const cont = (_tmpTileMaskSpriteContainer ??= new PIXI.Container());
  try {
    cont.removeChildren();
  } catch (err) {
    logger.debug("FXMaster:", err);
  }
  cont.transform.setFromMatrix(_tileMaskStageMatrix());
  cont.roundPixels = false;

  for (const s of sprites ?? []) {
    if (!s) continue;
    s.blendMode = blendMode;
    s.roundPixels = false;
    cont.addChild(s);
  }

  if (!cont.children.length) {
    if (clear) clearTileMaskRenderTexture(outRT);
    return false;
  }

  let rendered = false;
  try {
    r.render(cont, { renderTexture: outRT, clear, skipUpdateTransform: false });
    rendered = true;
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  const poolable = [];
  for (const child of cont.children) poolable.push(child);
  try {
    cont.removeChildren();
    releaseTileSprites(poolable);
  } catch (err) {
    logger.debug("FXMaster:", err);
  }
  return rendered;
}

/**
 * Return whether a tile candidate exposes a live mesh that can be rendered directly into a mask RT.
 *
 * @param {{ tile?: Tile|null, mesh?: PIXI.DisplayObject|null }|Tile|null|undefined} candidate
 * @returns {boolean}
 */
function tileCandidateHasRenderableLiveMesh(candidate) {
  const tile = _getTileMaskCandidateTile(candidate);
  const mesh = _getTileMaskCandidateMesh(candidate);
  const tex = mesh?.texture;
  if (!mesh || mesh.destroyed || !tex?.baseTexture?.valid) return false;

  const visible = typeof tile?.isVisible === "boolean" ? tile.isVisible : tile?.visible;
  const renderable = mesh?.renderable;
  const meshVisible = mesh?.visible;
  if (meshVisible === false || renderable === false) return false;
  if (!mesh && visible === false) return false;
  return true;
}

/**
 * Render live tile meshes into a mask render texture.
 *
 * This path samples the tile's currently rendered alpha directly from the live mesh, which keeps hover-fade and native occlusion behavior synchronized with the tile's currently visible image instead of trying to infer the fade amount from document state.
 *
 * @param {PIXI.RenderTexture} outRT
 * @param {{ includeBackground?: boolean, shouldIncludeTile?: (t: Tile) => boolean, candidates?: Array<{ tile: Tile, mesh: PIXI.DisplayObject|null }>, restrictWeather?: boolean|null, restrictionKind?: "particles"|"filters"|"weather", clear?: boolean, blendMode?: number }} [opts]
 * @returns {boolean}
 */
function renderLiveTileMeshesIntoRT(
  outRT,
  {
    includeBackground = false,
    shouldIncludeTile = null,
    candidates = null,
    restrictWeather = null,
    restrictionKind = "weather",
    clear = true,
    blendMode = PIXI.BLEND_MODES.NORMAL,
  } = {},
) {
  const r = canvas?.app?.renderer;
  if (!r || !outRT) return false;

  const tileCandidates = Array.isArray(candidates)
    ? candidates
    : getTileMaskCandidates({ includeBackground, shouldIncludeTile });
  const stageTransform = _tileMaskStageMatrix();
  let rendered = false;

  for (const candidate of tileCandidates) {
    const mesh = _getTileMaskCandidateMesh(candidate);
    if (
      typeof restrictWeather === "boolean" &&
      tileRestrictsWeatherForMask(candidate, restrictionKind) !== restrictWeather
    )
      continue;
    if (!tileCandidateHasRenderableLiveMesh(candidate)) continue;

    const prevBlendMode = mesh.blendMode;
    try {
      mesh.blendMode = blendMode;
      r.render(mesh, {
        renderTexture: outRT,
        clear: clear && !rendered,
        transform: stageTransform,
        skipUpdateTransform: false,
      });
      rendered = true;
    } catch (err) {
      logger.debug("FXMaster:", err);
    } finally {
      try {
        mesh.blendMode = prevBlendMode;
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
  }

  if (!rendered && clear) clearTileMaskRenderTexture(outRT);
  return rendered;
}

/**
 * Collect tile sprites in world space for alpha masking.
 *
 * All eligible scene tiles now participate by default. Four mask modes are supported:
 * - `suppression`: visible tiles contribute by their live alpha, while Restricts Weather tiles contribute fully even when hovered or revealed.
 * - `visible`: tiles contribute only by their current visual alpha.
 * - `weatherReveal`: Restricts Weather tiles contribute by their revealed amount, so only transparent portions suppress behind-tile filter rendering.
 * - `solid`: tiles contribute fully, ignoring live fade state while still respecting the source texture alpha.
 *
 * @param {Array<{ tile: Tile, mesh: PIXI.DisplayObject|null }>} candidates
 * @param {{ mode?: "suppression"|"visible"|"weatherReveal"|"solid" }} [opts]
 * @returns {PIXI.Sprite[]}
 */
function collectTileAlphaSpritesFromCandidates(candidates, { mode = "suppression", restrictionKind = "weather" } = {}) {
  const resolvedMode =
    mode === "visible"
      ? "visible"
      : mode === "weatherReveal"
      ? "weatherReveal"
      : mode === "solid"
      ? "solid"
      : "suppression";

  const out = [];
  for (const candidate of candidates ?? []) {
    const icon = _getTileMaskCandidateMesh(candidate) ?? _getTileMaskCandidateTile(candidate);
    const tex = icon?.texture;
    if (!tex?.baseTexture?.valid) continue;

    const alpha =
      resolvedMode === "visible"
        ? getTileVisibleMaskAlpha(candidate)
        : resolvedMode === "weatherReveal"
        ? getTileWeatherRevealMaskAlpha(candidate, { restrictionKind })
        : resolvedMode === "solid"
        ? 1
        : getTileSuppressionMaskAlpha(candidate, { restrictionKind });
    if (!(alpha > 0.001)) continue;

    const spr = _acquireTileSprite(tex);
    spr.alpha = Math.max(0, Math.min(1, alpha));
    try {
      spr.anchor.set(icon.anchor?.x ?? 0.5, icon.anchor?.y ?? 0.5);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      const stageLocal = stageLocalMatrixOf(icon);
      const vals = [stageLocal.a, stageLocal.b, stageLocal.c, stageLocal.d, stageLocal.tx, stageLocal.ty];
      if (!vals.every(Number.isFinite)) {
        releaseTileSprites([spr]);
        continue;
      }
      if (vals.some((v) => Math.abs(v) > 1e7)) {
        releaseTileSprites([spr]);
        continue;
      }
      spr.transform.setFromMatrix(stageLocal);
    } catch {
      releaseTileSprites([spr]);
      continue;
    }
    out.push(spr);
  }
  return out;
}

/**
 * Collect tile sprites in world space for alpha masking.
 *
 * All eligible scene tiles now participate by default. Four mask modes are supported:
 * - `suppression`: visible tiles contribute by their live alpha, while Restricts Weather tiles contribute fully even when hovered or revealed.
 * - `visible`: tiles contribute only by their current visual alpha.
 * - `weatherReveal`: Restricts Weather tiles contribute by their revealed amount, so only transparent portions suppress behind-tile filter rendering.
 * - `solid`: tiles contribute fully, ignoring live fade state while still respecting the source texture alpha.
 *
 * @param {{ includeBackground?: boolean, shouldIncludeTile?: (t: Tile) => boolean, mode?: "suppression"|"visible"|"weatherReveal"|"solid", restrictionKind?: "particles"|"filters"|"weather" }} [opts]
 * @returns {PIXI.Sprite[]}
 */
export function collectTileAlphaSprites(opts = {}) {
  const includeBackground = !!opts.includeBackground;
  const shouldInclude = typeof opts.shouldIncludeTile === "function" ? opts.shouldIncludeTile : null;
  const restrictionKind =
    opts.restrictionKind === "particles" || opts.restrictionKind === "filters" ? opts.restrictionKind : "weather";
  const mode =
    opts.mode === "visible"
      ? "visible"
      : opts.mode === "weatherReveal"
      ? "weatherReveal"
      : opts.mode === "solid"
      ? "solid"
      : "suppression";

  const candidates = getTileMaskCandidates({ includeBackground, shouldIncludeTile: shouldInclude });
  return collectTileAlphaSpritesFromCandidates(candidates, { mode, restrictionKind });
}

/**
 * Compute a display object's transform relative to `canvas.stage`.
 * @param {PIXI.DisplayObject} displayObject
 * @returns {PIXI.Matrix}
 */
export function stageLocalMatrixOf(displayObject) {
  const chain = [];
  let obj = displayObject;
  while (obj && obj !== canvas.stage) {
    chain.push(obj);
    obj = obj.parent;
  }
  const M = new PIXI.Matrix();
  for (let i = chain.length - 1; i >= 0; i--) {
    const tr = chain[i]?.transform;

    /**
     * PIXI updates `localTransform` during `updateTransform()`. Mask repaints can run before the next render tick. When available, `updateLocalTransform()` forces a recompute so that token cutouts stay synchronized with token motion.
     */
    try {
      if (tr && typeof tr.updateLocalTransform === "function") tr.updateLocalTransform();
    } catch {}

    const lt = tr?.localTransform || PIXI.Matrix.IDENTITY;
    M.append(lt);
  }
  return M;
}

/**
 * Return whether a token is currently being rendered on the canvas.
 *
 * Native Levels can hide tokens through live canvas masking even when the token still belongs to the viewed Level. The placeable and mesh visibility state is used as the authoritative check before excluding the token from below-token masking.
 *
 * @param {Token|null|undefined} token
 * @returns {boolean}
 * @private
 */
function _isTokenCurrentlyVisible(token) {
  if (!token || token.destroyed) return false;

  const tokenMesh = token.mesh ?? null;
  if (tokenMesh?.destroyed) return false;

  if (token.visible === true) return true;
  if (token.isVisible === true) return true;
  if (token.worldVisible === true) return true;
  if (tokenMesh?.worldVisible === true) return true;
  return false;
}

/**
 * Return whether a token should currently contribute a below-token silhouette.
 *
 * Native Levels hover reveals can expose a token through the live scene mask before the token placeable updates its own visibility flags. In that case, a token on the currently viewed Level is still treated as participating in below-token masking when its center is inside the live scene mask.
 *
 * @param {Token|null|undefined} token
 * @returns {boolean}
 * @private
 */
function _tokenParticipatesInBelowTokenMask(token) {
  if (!token || token.destroyed || token?.document?.hidden) return false;
  if (!canvas?.level) return _isTokenCurrentlyVisible(token);

  const tokenElevation = token?.elevation ?? token?.document?.elevation ?? Number.NaN;
  const onCurrentLevel = isDocumentOnCurrentCanvasLevel(token?.document ?? null, tokenElevation);
  const lowerThanViewedLevel = _tokenIsBelowViewedCanvasLevel(token);
  const explicitlyRevealed = token?.controlled === true;
  const directlyHovered = lowerThanViewedLevel ? _tokenIsDirectlyHoveredForBelowTokenMask(token) : false;

  /**
   * When the viewer is above the token's own Level, Foundry's broad upper-surface hover/scene-mask state can update before the lower token is actually revealed. In that case the below-token cutout should follow direct token hover/control only.
   */
  if (!onCurrentLevel) return lowerThanViewedLevel && (explicitlyRevealed || directlyHovered);
  if (lowerThanViewedLevel && _isTokenCoveredByUpperLevelSurface(token)) return explicitlyRevealed || directlyHovered;

  const visibleThroughSceneMask = _sceneMaskContainsTokenCenter(token);
  const revealAllowsBelowMask = tokenUpperLevelRevealAllowsBelowTokenMask(token);
  if (explicitlyRevealed) return true;

  /**
   * The live Foundry scene mask is the strongest signal that a same-Level token is actually visible. Off-Level/lower-Level tokens are handled by the stricter direct-hover path above.
   */
  if (visibleThroughSceneMask === true) return true;

  if (_isTokenCoveredByUpperLevelSurface(token) && !revealAllowsBelowMask) return false;
  if (_isTokenCurrentlyVisible(token)) return true;
  if (revealAllowsBelowMask) return true;

  return false;
}
/**
 * Return the token center point used for live scene-mask visibility checks.
 *
 * @param {Token|null|undefined} token
 * @returns {PIXI.Point|{x:number, y:number}|null}
 * @private
 */
function _getTokenCenterPoint(token) {
  const boundsCenter = token?.bounds?.center ?? null;
  if (Number.isFinite(boundsCenter?.x) && Number.isFinite(boundsCenter?.y)) return boundsCenter;

  const tokenCenter = token?.center ?? null;
  if (Number.isFinite(tokenCenter?.x) && Number.isFinite(tokenCenter?.y)) return tokenCenter;

  return null;
}

/**
 * Return whether a token is authored below the currently viewed native Level.
 *
 * Foundry can keep lower-Level tokens in the live scene graph during hover or reveal interactions, so this uses elevation/Level ordering rather than only `isDocumentOnCurrentCanvasLevel`.
 *
 * @param {Token|null|undefined} token
 * @returns {boolean}
 * @private
 */
function _tokenIsBelowViewedCanvasLevel(token) {
  const currentLevel = getCanvasLevel();
  if (!token || !currentLevel) return false;

  const tokenElevation = Number(token?.document?.elevation ?? token?.elevation ?? Number.NaN);
  const currentBottom = fxmLevelBottom(currentLevel);
  if (Number.isFinite(tokenElevation) && Number.isFinite(currentBottom) && tokenElevation < currentBottom - 1e-4)
    return true;

  let tokenLevel = null;
  try {
    tokenLevel = inferVisibleLevelForDocument(token?.document ?? null, tokenElevation);
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  if (!tokenLevel || (tokenLevel?.id && currentLevel?.id && tokenLevel.id === currentLevel.id)) return false;
  if (fxmLevelIsAbove(currentLevel, tokenLevel)) return true;

  const tokenTop = fxmLevelTop(tokenLevel);
  return Number.isFinite(tokenTop) && Number.isFinite(currentBottom) && tokenTop <= currentBottom + 1e-4;
}

/**
 * Return whether a token is currently revealed through the hovered or explicitly revealed native Levels surface that actually covers it.
 *
 * Native Levels hover reveal does not currently expose a public state flag that changes on the underlying Level document or shared scene mask. The reveal check therefore tracks the nearest upper level surface above the token and treats that specific covering surface as revealed when either the mouse is over that surface or a controlled token is already covered by the same surface.
 *
 * @param {Token|null|undefined} token
 * @returns {boolean}
 */
export function isTokenRevealedByHoveredUpperLevel(token) {
  /**
   * If a higher surface still covers the token after excluding the currently hover-faded elevation, that remaining blocker must be revealed too.
   */
  const remainingUpperLevelSurface = _getNearestUpperLevelSurfaceCoveringToken(token);
  if (_surfaceHasMeshes(remainingUpperLevelSurface)) return _isUpperLevelSurfaceRevealed(remainingUpperLevelSurface);

  /**
   * Otherwise, re-query without the hover-fade elevation floor. The direct surface over the token may be the one Foundry has already faded/revealed globally, even when the mouse is elsewhere on that overlay.
   */
  const directUpperLevelSurface = _getNearestUpperLevelSurfaceCoveringToken(token, {
    ignoreHoverFadeElevation: true,
  });
  if (!_surfaceHasMeshes(directUpperLevelSurface)) return false;

  if (_sceneMaskContainsTokenCenter(token) === true) return true;
  if (_surfaceHasActiveNativeRevealState(directUpperLevelSurface)) return true;
  return _isUpperLevelSurfaceRevealed(directUpperLevelSurface);
}

/**
 * Return whether a token center is currently covered by an upper native Levels surface.
 *
 * Native Levels hover reveal is represented by geometry rather than a public hover-state flag. Tile meshes are preferred because they represent the concrete occluding surface geometry. Cached level textures remain as a fallback for scenes that do not expose a matching upper tile mesh.
 *
 * @param {Token|null|undefined} token
 * @returns {boolean}
 * @private
 */
function _isTokenCoveredByUpperLevelSurface(token) {
  return _getNearestUpperLevelSurfaceCoveringToken(token).meshes.length > 0;
}

/**
 * Return the highest qualifying upper native Levels surfaces that cover the token center.
 *
 * Tile meshes are preferred because they give a tile-like per-surface reveal test. Cached level textures are only used as a fallback when no qualifying upper tile mesh covers the token center.
 *
 * @param {Token|null|undefined} token
 * @returns {{meshes: PIXI.DisplayObject[], tokenCenter: PIXI.Point|{x:number, y:number}|null, elevation: number|null}}
 * @private
 */
function _getNearestUpperLevelSurfaceCoveringToken(token, { ignoreHoverFadeElevation = false } = {}) {
  const tileSurface = _getNearestUpperLevelTileMeshesCoveringToken(token, { ignoreHoverFadeElevation });
  if (tileSurface.meshes.length > 0) return tileSurface;
  return _getNearestUpperLevelLevelTexturesCoveringToken(token, { ignoreHoverFadeElevation });
}

/**
 * Return the highest qualifying upper native Levels tile meshes that cover the token center.
 *
 * @param {Token|null|undefined} token
 * @returns {{meshes: PIXI.DisplayObject[], tokenCenter: PIXI.Point|{x:number, y:number}|null, elevation: number|null}}
 * @private
 */
function _getNearestUpperLevelTileMeshesCoveringToken(token, { ignoreHoverFadeElevation = false } = {}) {
  const tokenCenter = _getTokenCenterPoint(token);
  if (!canvas?.level || !canvas?.primary || !tokenCenter) return { meshes: [], tokenCenter, elevation: null };

  const tokenElevation = Number(token?.elevation ?? token?.document?.elevation ?? Number.NaN);
  if (!isDocumentOnCurrentCanvasLevel(token?.document ?? null, tokenElevation))
    return { meshes: [], tokenCenter, elevation: null };

  const hoverFadeElevation = ignoreHoverFadeElevation ? Number.NaN : getCanvasPrimaryHoverFadeElevation();
  const minimumElevation = Math.max(
    Number.isFinite(tokenElevation) ? tokenElevation : Number.NEGATIVE_INFINITY,
    Number.isFinite(hoverFadeElevation) ? hoverFadeElevation : Number.NEGATIVE_INFINITY,
  );

  let nearestElevation = Number.POSITIVE_INFINITY;
  const nearestMeshes = [];
  const tileMeshes =
    typeof canvas.primary?.tiles?.values === "function"
      ? Array.from(canvas.primary.tiles.values())
      : Array.from(canvas.primary?.tiles ?? []);

  for (const mesh of tileMeshes) {
    if (!mesh || mesh.destroyed || mesh.visible === false || mesh.renderable === false) continue;

    const tileObj = _resolveTilePlaceable(mesh);
    if (tileObj?.document?.hidden) continue;

    const meshElevation = Number(mesh?.elevation ?? tileObj?.document?.elevation ?? tileObj?.elevation ?? Number.NaN);
    if (!Number.isFinite(meshElevation) || meshElevation <= minimumElevation) continue;

    const threshold = Number(mesh?.textureAlphaThreshold ?? tileObj?.mesh?.textureAlphaThreshold ?? 0) || 0;
    try {
      if (!mesh.containsCanvasPoint?.(tokenCenter, threshold)) continue;
    } catch (err) {
      logger.debug("FXMaster:", err);
      continue;
    }

    if (meshElevation < nearestElevation) {
      nearestElevation = meshElevation;
      nearestMeshes.length = 0;
      nearestMeshes.push(mesh);
      continue;
    }

    if (_sameElevation(meshElevation, nearestElevation)) nearestMeshes.push(mesh);
  }

  return { meshes: nearestMeshes, tokenCenter, elevation: Number.isFinite(nearestElevation) ? nearestElevation : null };
}

/**
 * Return the highest qualifying upper native Levels cached textures that cover the token center.
 *
 * @param {Token|null|undefined} token
 * @returns {{meshes: PIXI.DisplayObject[], tokenCenter: PIXI.Point|{x:number, y:number}|null, elevation: number|null}}
 * @private
 */
function _getNearestUpperLevelLevelTexturesCoveringToken(token, { ignoreHoverFadeElevation = false } = {}) {
  const tokenCenter = _getTokenCenterPoint(token);
  if (!canvas?.level || !canvas?.primary || !tokenCenter) return { meshes: [], tokenCenter, elevation: null };

  const tokenElevation = Number(token?.elevation ?? token?.document?.elevation ?? Number.NaN);
  if (!isDocumentOnCurrentCanvasLevel(token?.document ?? null, tokenElevation))
    return { meshes: [], tokenCenter, elevation: null };

  const hoverFadeElevation = ignoreHoverFadeElevation ? Number.NaN : getCanvasPrimaryHoverFadeElevation();
  const minimumElevation = Math.max(
    Number.isFinite(tokenElevation) ? tokenElevation : Number.NEGATIVE_INFINITY,
    Number.isFinite(hoverFadeElevation) ? hoverFadeElevation : Number.NEGATIVE_INFINITY,
  );

  let nearestElevation = Number.POSITIVE_INFINITY;
  const nearestMeshes = [];

  for (const mesh of canvas.primary?.levelTextures ?? []) {
    if (!mesh || mesh.destroyed || mesh.visible === false || mesh.renderable === false) continue;

    const meshElevation = Number(
      mesh?.elevation ?? mesh?.object?.document?.elevation ?? mesh?.object?.elevation ?? Number.NaN,
    );
    if (!Number.isFinite(meshElevation) || meshElevation <= minimumElevation) continue;

    try {
      if (!mesh.containsCanvasPoint?.(tokenCenter)) continue;
    } catch (err) {
      logger.debug("FXMaster:", err);
      continue;
    }

    if (meshElevation < nearestElevation) {
      nearestElevation = meshElevation;
      nearestMeshes.length = 0;
      nearestMeshes.push(mesh);
      continue;
    }

    if (_sameElevation(meshElevation, nearestElevation)) nearestMeshes.push(mesh);
  }

  return { meshes: nearestMeshes, tokenCenter, elevation: Number.isFinite(nearestElevation) ? nearestElevation : null };
}

/**
 * Return whether two elevations should be treated as the same level surface.
 *
 * @param {number} a
 * @param {number} b
 * @returns {boolean}
 * @private
 */
function _sameElevation(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= 0.01;
}

/**
 * Return whether the mouse is meaningfully inside a surface before treating that surface as revealed.
 *
 * Edge-triggered native hover checks can report a hit a few pixels before the underlying tile or level is visibly revealed. Requiring a small cross of nearby points to stay inside the same surface delays below-token masking until the cursor is actually inside the reveal area.
 *
 * @param {PIXI.DisplayObject|null|undefined} mesh
 * @param {{ useTextureThreshold?: boolean, inset?: number, requiredHits?: number }} [options]
 * @returns {boolean}
 * @private
 */
function _surfaceContainsRevealMousePoint(mesh, { useTextureThreshold = false, inset = 2.5, requiredHits = 3 } = {}) {
  if (!mesh || mesh.destroyed || mesh.visible === false || mesh.renderable === false) return false;

  const mousePosition = canvas?.mousePosition ?? null;
  if (!mousePosition) return false;

  const baseThreshold = Number(mesh?.textureAlphaThreshold ?? 0) || 0;
  const threshold = useTextureThreshold ? Math.max(baseThreshold, 0.05) : Math.max(baseThreshold, 0.05);
  const samplePoints = [
    mousePosition,
    { x: mousePosition.x + inset, y: mousePosition.y },
    { x: mousePosition.x - inset, y: mousePosition.y },
    { x: mousePosition.x, y: mousePosition.y + inset },
    { x: mousePosition.x, y: mousePosition.y - inset },
  ];

  let hits = 0;
  for (const point of samplePoints) {
    try {
      if (!mesh.containsCanvasPoint?.(point, threshold)) continue;
      hits += 1;
    } catch (err) {
      logger.debug("FXMaster:", err);
      return false;
    }
  }

  return hits >= requiredHits;
}

/**
 * Return whether the provided upper native Levels surface is currently hovered or explicitly revealed by a controlled token.
 *
 * Native Levels reveal is modeled as revealing the nearest covering surface directly above the token. A hovered tile on that surface is treated as authoritative. Controlled tokens covered by the same surface also reveal it so every token under that same cover responds consistently.
 *
 * @param {{meshes: PIXI.DisplayObject[], tokenCenter: PIXI.Point|{x:number, y:number}|null, elevation: number|null}|null|undefined} surface
 * @returns {boolean}
 * @private
 */
function _isUpperLevelSurfaceRevealed(surface) {
  if (!_surfaceHasMeshes(surface)) return false;
  if (_isUpperLevelSurfaceExplicitlyRevealed(surface)) return true;
  return _surfaceIsHovered(surface);
}

/**
 * Return whether the provided upper native Levels surface is currently hovered.
 *
 * Tile-backed surfaces use the live tile-mesh reveal hit test directly. Cached level textures are coarser and can contain disconnected opaque regions, so the fallback path requires the mouse point to stay connected to the token center across the same cached surface.
 *
 * @param {{meshes: PIXI.DisplayObject[], tokenCenter: PIXI.Point|{x:number, y:number}|null, elevation: number|null}|null|undefined} surface
 * @returns {boolean}
 * @private
 */
function _surfaceHasActiveNativeRevealState(surface) {
  if (!_surfaceHasMeshes(surface)) return false;

  for (const mesh of surface.meshes) {
    if (!mesh || mesh.destroyed || mesh.visible === false || mesh.renderable === false) continue;

    const object = _resolveTilePlaceable(mesh) ?? fxmLinkedPlaceableFromDisplayObject(mesh);
    const document = object?.document ?? mesh?.document ?? mesh?.level?.document ?? mesh?.level ?? null;
    const level = mesh?.level ?? object?.level ?? document?.level ?? null;
    const elevation = Number(
      surface?.elevation ??
        mesh?.elevation ??
        document?.elevation?.top ??
        document?.elevation?.bottom ??
        document?.elevation ??
        Number.NaN,
    );

    const revealState = getCanvasLiveLevelSurfaceRevealState(mesh, {
      mesh,
      object,
      document,
      level,
      elevation,
    });

    if (revealState?.faded === true) return true;
    if (revealState?.explicit === true) return true;
    if (revealState?.occluded === true) return true;
    if (Number.isFinite(Number(revealState?.fadeOcclusion)) && Number(revealState.fadeOcclusion) > 0.001) return true;
  }

  return false;
}

function _surfaceIsHovered(surface) {
  if (!_surfaceHasMeshes(surface)) return false;
  if (_surfaceHasActiveNativeRevealState(surface)) return true;

  const tileMeshes = surface.meshes.filter((mesh) => !!_resolveTilePlaceable(mesh));
  if (tileMeshes.length > 0) {
    for (const mesh of tileMeshes) {
      if (!mesh || mesh.destroyed || mesh.visible === false || mesh.renderable === false) continue;

      try {
        if (_surfaceContainsRevealMousePoint(mesh, { useTextureThreshold: true })) return true;
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    return false;
  }

  return _anyConnectedSurfaceContainsPoint(surface.meshes, surface.tokenCenter, canvas?.mousePosition ?? null, false);
}

/**
 * Return whether a controlled token is already covered by the same nearest upper native Levels surface.
 *
 * A controlled token behaves as an explicit reveal source for the specific covering surface directly above it. This keeps sibling tokens under that same surface in sync even while the level itself is not hovered.
 *
 * @param {{meshes: PIXI.DisplayObject[], tokenCenter: PIXI.Point|{x:number, y:number}|null, elevation: number|null}|null|undefined} surface
 * @returns {boolean}
 * @private
 */
function _isUpperLevelSurfaceExplicitlyRevealed(surface) {
  if (!_surfaceHasMeshes(surface)) return false;

  for (const token of canvas?.tokens?.controlled ?? []) {
    if (!token || token.destroyed || token?.document?.hidden) continue;

    const upperLevelSurface = _getNearestUpperLevelSurfaceCoveringToken(token);
    if (_surfacesShareExplicitRevealRegion(surface, upperLevelSurface)) return true;
  }

  return false;
}

/**
 * Return whether two upper native Levels surfaces should share explicit reveal state.
 *
 * Tile-backed surfaces share explicit reveal only when they resolve to the same backing tile. Cached level textures are broader and can contain disconnected opaque regions, so they only share explicit reveal when the controlled-token center and target-token center stay connected across the same shared mesh.
 *
 * @param {{meshes?: PIXI.DisplayObject[], tokenCenter?: PIXI.Point|{x:number, y:number}|null, elevation?: number|null}|null|undefined} a
 * @param {{meshes?: PIXI.DisplayObject[], tokenCenter?: PIXI.Point|{x:number, y:number}|null, elevation?: number|null}|null|undefined} b
 * @returns {boolean}
 * @private
 */
function _surfacesShareExplicitRevealRegion(a, b) {
  if (!_surfaceHasMeshes(a) || !_surfaceHasMeshes(b)) return false;
  if (!_sameElevation(Number(a?.elevation), Number(b?.elevation))) return false;

  const aTileKeys = new Set(a.meshes.map(_tileSurfaceIdentityKey).filter(Boolean));
  const bTileKeys = new Set(b.meshes.map(_tileSurfaceIdentityKey).filter(Boolean));
  if (aTileKeys.size > 0 || bTileKeys.size > 0) {
    if (!(aTileKeys.size > 0 && bTileKeys.size > 0)) return false;
    for (const key of aTileKeys) {
      if (bTileKeys.has(key)) return true;
    }
    return false;
  }

  const sharedMeshes = a.meshes.filter((mesh) => b.meshes.includes(mesh));
  if (sharedMeshes.length === 0) return false;
  return _anyConnectedSurfaceContainsPoint(sharedMeshes, a.tokenCenter, b.tokenCenter, false);
}

/**
 * Return whether the provided surface descriptor contains at least one live mesh.
 *
 * @param {{meshes?: PIXI.DisplayObject[]}|null|undefined} surface
 * @returns {boolean}
 * @private
 */
function _surfaceHasMeshes(surface) {
  return Array.isArray(surface?.meshes) && surface.meshes.length > 0;
}

/**
 * Return a stable tile-only identity key for a covering surface mesh when one is available.
 *
 * @param {PIXI.DisplayObject|null|undefined} mesh
 * @returns {string|null}
 * @private
 */
function _tileSurfaceIdentityKey(mesh) {
  if (!mesh) return null;

  const tileObj = _resolveTilePlaceable(mesh);
  if (tileObj?.id) return `tile:${tileObj.id}`;
  if (tileObj?.document?.id) return `tile:${tileObj.document.id}`;

  return null;
}

/**
 * Return whether any provided surface contains the mouse point and stays connected to the token center along sampled points.
 *
 * Cached level textures can represent multiple disconnected opaque regions. Sampling the segment between the token center and the mouse point prevents hovering an unrelated region on the same cached texture from revealing the token.
 *
 * @param {PIXI.DisplayObject[]} meshes
 * @param {PIXI.Point|{x:number, y:number}|null|undefined} startPoint
 * @param {PIXI.Point|{x:number, y:number}|null|undefined} endPoint
 * @param {boolean} useTextureThreshold
 * @returns {boolean}
 * @private
 */
function _anyConnectedSurfaceContainsPoint(meshes, startPoint, endPoint, useTextureThreshold) {
  if (!startPoint || !endPoint || !Array.isArray(meshes) || meshes.length === 0) return false;

  for (const mesh of meshes) {
    const threshold = useTextureThreshold
      ? Number(mesh?.textureAlphaThreshold ?? 0) || 0
      : Math.max(Number(mesh?.textureAlphaThreshold ?? 0) || 0, 0.05);
    try {
      if (!mesh?.containsCanvasPoint?.(startPoint, threshold)) continue;
      if (!mesh?.containsCanvasPoint?.(endPoint, threshold)) continue;
    } catch (err) {
      logger.debug("FXMaster:", err);
      continue;
    }

    const dx = endPoint.x - startPoint.x;
    const dy = endPoint.y - startPoint.y;
    const distance = Math.hypot(dx, dy);
    const samples = Math.max(2, Math.min(12, Math.ceil(distance / 96)));
    let connected = true;

    for (let i = 1; i < samples; i += 1) {
      const t = i / samples;
      const samplePoint = { x: startPoint.x + dx * t, y: startPoint.y + dy * t };
      try {
        if (mesh?.containsCanvasPoint?.(samplePoint, threshold)) continue;
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      connected = false;
      break;
    }

    if (connected) return true;
  }

  return false;
}

/**
 * Return whether the native scene mask currently includes the token center point.
 *
 * This supplements token visibility flags for native Levels hover-reveal cases where the token mesh can remain on-canvas while the scene mask changes independently.
 *
 * @param {Token|null|undefined} token
 * @returns {boolean|null}
 * @private
 */
function _sceneMaskContainsTokenCenter(token) {
  const sceneMask = canvas?.masks?.scene ?? null;
  if (!sceneMask || sceneMask.destroyed) return null;

  const point = _getTokenCenterPoint(token);
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
 * Return whether Foundry currently considers the token itself hovered.
 *
 * This is intentionally stricter than "the mouse is inside a higher-Level overlay surface." It only trusts Foundry's token-hover state, not a manual pointer hit-test, so broad/native overlay hover cannot create lower-Level token cutouts before Foundry has actually hovered that token.
 *
 * @param {Token|null|undefined} token
 * @returns {boolean}
 * @private
 */
function _tokenIsDirectlyHoveredForBelowTokenMask(token) {
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
 * Return whether upper-Level reveal should allow this token to contribute a below-token cutout.
 *
 * Completed/active native reveal states and Foundry's live scene mask are accepted directly by default. When direct-hover gating is requested for a lower-Level token, every non-controlled reveal signal must also coincide with Foundry's own token-hover state.
 *
 * @param {Token|null|undefined} token
 * @param {{ requireDirectHoverForSceneMask?: boolean }} [options]
 * @returns {boolean}
 */
export function tokenUpperLevelRevealAllowsBelowTokenMask(token, { requireDirectHoverForSceneMask = false } = {}) {
  if (!token || token.destroyed || token?.document?.hidden) return false;
  if (token?.controlled === true) return true;

  const directlyHovered = _tokenIsDirectlyHoveredForBelowTokenMask(token);
  if (requireDirectHoverForSceneMask && !directlyHovered) return false;
  if (_sceneMaskContainsTokenCenter(token) === true) return true;

  const remainingUpperLevelSurface = _getNearestUpperLevelSurfaceCoveringToken(token);
  if (_surfaceHasMeshes(remainingUpperLevelSurface)) {
    if (_surfaceHasActiveNativeRevealState(remainingUpperLevelSurface)) return true;
    if (_isUpperLevelSurfaceExplicitlyRevealed(remainingUpperLevelSurface)) return true;
    return directlyHovered && _isUpperLevelSurfaceRevealed(remainingUpperLevelSurface);
  }

  const directUpperLevelSurface = _getNearestUpperLevelSurfaceCoveringToken(token, {
    ignoreHoverFadeElevation: true,
  });
  if (!_surfaceHasMeshes(directUpperLevelSurface)) return false;

  if (_surfaceHasActiveNativeRevealState(directUpperLevelSurface)) return true;
  if (_isUpperLevelSurfaceExplicitlyRevealed(directUpperLevelSurface)) return true;
  return directlyHovered && _isUpperLevelSurfaceRevealed(directUpperLevelSurface);
}

/**
 * Return whether a token should be treated as hidden by native Levels scene occlusion.
 *
 * The token must first belong to the currently viewed Level. Scene-mask based hiding is only applied when the token is not already rendered as visible on the live canvas, which prevents base-level tokens from being removed from below-token masking until they are controlled.
 *
 * @param {Token|null|undefined} token
 * @returns {boolean}
 * @private
 */
function _isTokenHiddenBySceneMask(token) {
  if (!canvas?.level) return false;
  if (_isTokenCurrentlyVisible(token)) return false;
  if (tokenUpperLevelRevealAllowsBelowTokenMask(token)) return false;

  const visibleThroughSceneMask = _sceneMaskContainsTokenCenter(token);
  if (visibleThroughSceneMask === true) return false;

  return isDocumentOnCurrentCanvasLevel(
    token?.document ?? null,
    token?.elevation ?? token?.document?.elevation ?? Number.NaN,
  );
}

/**
 * Return true if a higher-elevation occludable object currently hides the token.
 *
 * Tiles that are hover-fading, already occluded, hidden, or configured with occlusion mode `NONE` are ignored so below-token masks follow the same live reveal behavior as the tile.
 *
 * @param {Token|null|undefined} token
 * @returns {boolean}
 * @private
 */
function _isTokenOccludedByOverhead(token) {
  if (!token) return false;

  const onCurrentLevel = isDocumentOnCurrentCanvasLevel(
    token?.document ?? null,
    token?.elevation ?? token?.document?.elevation ?? Number.NaN,
  );
  const visibleThroughSceneMask = _sceneMaskContainsTokenCenter(token);
  const lowerThanViewedLevel = _tokenIsBelowViewedCanvasLevel(token);
  const revealAllowsBelowMask = tokenUpperLevelRevealAllowsBelowTokenMask(token, {
    requireDirectHoverForSceneMask: lowerThanViewedLevel && !onCurrentLevel,
  });
  const coveredByUpperLevelTexture = _isTokenCoveredByUpperLevelSurface(token);

  if (!onCurrentLevel) {
    if (_isTokenCurrentlyVisible(token) || revealAllowsBelowMask) return false;
    return true;
  }

  if (token.controlled) return false;
  if (visibleThroughSceneMask === true || revealAllowsBelowMask) return false;
  if (coveredByUpperLevelTexture && !revealAllowsBelowMask) return true;
  if (_isTokenHiddenBySceneMask(token)) return true;

  const candidates = canvas?.primary?.quadtree?.getObjects?.(token.bounds) ?? [];

  for (const candidate of candidates) {
    if (!candidate?.isOccludable) continue;

    const tileCandidate = _resolveTilePlaceable(candidate);
    if (tileCandidate) {
      if (!_tileCurrentlyHidesToken(tileCandidate)) continue;
      if (
        !isDocumentOnCurrentCanvasLevel(
          tileCandidate.document ?? null,
          tileCandidate.document?.elevation ?? tileCandidate?.elevation ?? Number.NaN,
        )
      )
        continue;
    } else if (_occludableCandidateIsRevealed(candidate)) {
      continue;
    }

    const tElev = Number(token.elevation ?? 0);
    const candElev = Number(candidate.elevation ?? tileCandidate?.elevation ?? 0);
    if (Number.isFinite(candElev) && Number.isFinite(tElev) && candElev <= tElev) continue;

    const corners = candidate.restrictsLight && candidate.restrictsWeather;
    if (!candidate.testOcclusion?.(token, { corners })) continue;
    return true;
  }

  return false;
}

/**
 * Resolve a tile placeable from a primary-canvas candidate without touching deprecated `PrimaryCanvasObject#document` accessors.
 *
 * @param {unknown} candidate
 * @returns {Tile|null}
 * @private
 */
function _resolveTilePlaceable(candidate) {
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
 * Return whether a non-tile occludable candidate is currently in a live reveal state.
 *
 * Native Levels surface occluders can expose lower levels through hover-driven occlusion without updating placeable visibility flags. When a higher-level surface reports active occlusion or a completed hover-fade state, it is not treated as hiding tokens for below-token masking.
 *
 * @param {unknown} candidate
 * @returns {boolean}
 * @private
 */
function _occludableCandidateIsRevealed(candidate) {
  if (!candidate) return false;
  if (candidate?.occluded === true) return true;

  const hoverFadeState = fxmGetPublicHoverFadeState(candidate, candidate?.mesh);
  if (hoverFadeState?.faded) return true;

  const occlusionAmount = Number(
    candidate?.mesh?.fadeOcclusion ??
      candidate?.fadeOcclusion ??
      candidate?.mesh?.shader?.uniforms?.fadeOcclusion ??
      hoverFadeState?.occlusion ??
      0,
  );
  return Number.isFinite(occlusionAmount) && occlusionAmount > 0;
}

/**
 * Return whether a tile occlusion mode explicitly disables occlusion handling.
 *
 * @param {unknown} mode
 * @returns {boolean}
 * @private
 */
function _tileModeDisablesOcclusion(mode) {
  const noneMode = CONST?.TILE_OCCLUSION_MODES?.NONE;
  if (noneMode === undefined) return false;
  if (mode === noneMode) return true;
  if (Array.isArray(mode) && mode.includes(noneMode)) return true;
  if (typeof mode?.has === "function" && mode.has(noneMode)) return true;
  return false;
}

/**
 * Return whether a tile is currently in a hover-fade reveal state.
 *
 * The private hover fade state is checked first for compatibility with current canvas tile meshes, then the public hover fade object and live fade-occlusion amount are used as fallbacks so below-token masking tracks the same reveal state used by tile rendering.
 *
 * @param {Tile|null|undefined} tileObj
 * @returns {boolean}
 * @private
 */
function _tileIsHoverRevealed(tileObj) {
  const hoverFadeState = fxmGetPublicHoverFadeState(tileObj?.mesh, tileObj);
  if (hoverFadeState?.faded) return true;

  const fadeOcclusion = getTileFadeOcclusionAmount(tileObj);
  if (!(Number.isFinite(fadeOcclusion) && fadeOcclusion > 0)) return false;
  return _surfaceContainsRevealMousePoint(tileObj?.mesh ?? null, { useTextureThreshold: true });
}

/**
 * Return whether a tile should still be treated as hiding tokens for below-token masking.
 *
 * Controlled tokens beneath the tile are treated as an explicit reveal source so sibling tokens under the same tile stay synchronized with the selected token.
 *
 * @param {Tile|null|undefined} tileObj
 * @returns {boolean}
 * @private
 */
function _tileCurrentlyHidesToken(tileObj) {
  if (!tileObj?.bounds) return false;
  if (tileObj?.document?.hidden) return false;
  if (
    !isDocumentOnCurrentCanvasLevel(
      tileObj.document ?? null,
      tileObj.document?.elevation ?? tileObj?.elevation ?? Number.NaN,
    )
  )
    return false;
  if (_tileIsHoverRevealed(tileObj)) return false;
  if (_tileIsExplicitlyRevealedByControlledToken(tileObj)) return false;

  const tileMode = getTileOcclusionModes(tileObj?.document ?? tileObj ?? null);
  if (_tileModeDisablesOcclusion(tileMode)) return false;
  if (tileObj?.occluded) return false;

  return true;
}

/**
 * Return whether a controlled token beneath the tile should reveal that tile for below-token masking.
 *
 * Controlled tokens are treated as an explicit reveal source for the covering tile so sibling tokens under the same tile remain synchronized with the selected token.
 *
 * @param {Tile|null|undefined} tileObj
 * @returns {boolean}
 * @private
 */
function _tileIsExplicitlyRevealedByControlledToken(tileObj) {
  if (!tileObj?.bounds) return false;

  for (const token of canvas?.tokens?.controlled ?? []) {
    if (!token || token.destroyed || token?.document?.hidden) continue;
    if (!isTokenUnderTile(token, tileObj)) continue;
    return true;
  }

  return false;
}

/**
 * Return whether the token center falls beneath the tile mesh.
 *
 * The token quadtree is used only to collect candidates. The center-point test requires the token to be meaningfully under the rendered tile shape before excluding its silhouette from below-token masking.
 *
 * @param {Token|null|undefined} token
 * @param {Tile|null|undefined} tileObj
 * @returns {boolean}
 * @private
 */
function isTokenUnderTile(token, tileObj) {
  const tokenBounds = token?.bounds ?? null;
  const tileMesh = tileObj?.mesh ?? null;
  if (!tokenBounds || !tileMesh || typeof tileMesh.containsCanvasPoint !== "function") return false;

  const tokenElevation = Number(token?.elevation ?? token?.document?.elevation ?? Number.NaN);
  const tileElevation = Number(tileMesh?.elevation ?? tileObj?.document?.elevation ?? tileObj?.elevation ?? Number.NaN);
  if (
    Number.isFinite(tokenElevation) &&
    Number.isFinite(tileElevation) &&
    (tileElevation <= tokenElevation || _sameElevation(tileElevation, tokenElevation))
  ) {
    return false;
  }

  const tokenCenter = tokenBounds.center ?? token?.center ?? null;
  if (!Number.isFinite(tokenCenter?.x) || !Number.isFinite(tokenCenter?.y)) return false;

  const threshold = Number(tileMesh.textureAlphaThreshold ?? 0) || 0;

  try {
    return !!tileMesh.containsCanvasPoint(tokenCenter, threshold);
  } catch (err) {
    logger.debug("FXMaster:", err);
    return false;
  }
}

/**
 * Return the tokens that should be treated as hidden beneath a tile for below-token masking.
 *
 * @param {Tile|null|undefined} tileObj
 * @returns {Token[]}
 * @private
 */
function tokensUnderTile(tileObj) {
  if (!_tileCurrentlyHidesToken(tileObj)) return [];

  const found = new Set(canvas?.tokens?.quadtree?.getObjects?.(tileObj.bounds) ?? []);
  for (const token of _collectDraggingTokenPreviewsForMask()) {
    _syncTokenMaskTransform(token);
    if (_cssBoundsIntersectsViewport(token?.bounds ?? null, 0) && isTokenUnderTile(token, tileObj)) found.add(token);
  }
  if (!found.size) return [];
  return Array.from(found).filter((token) => {
    if (!token?.document || !isTokenUnderTile(token, tileObj)) return false;

    /**
     * If Foundry's Level mask says the token center is visible, keep the token silhouette even when the tile-local pointer fallback has not classified the covering tile as hovered.
     */
    const lowerThanViewedLevel = _tokenIsBelowViewedCanvasLevel(token);
    if (!lowerThanViewedLevel && _sceneMaskContainsTokenCenter(token) === true) return false;
    if (tokenUpperLevelRevealAllowsBelowTokenMask(token, { requireDirectHoverForSceneMask: lowerThanViewedLevel }))
      return false;
    return true;
  });
}

/**
 * Collect tokens that are currently hidden beneath non-faded occluding tiles.
 *
 * @returns {Set<Token>}
 * @private
 */
function getTileOccludedTokens() {
  const frameKey = _belowObjectViewportFrameKey();
  if (_tileOccludedTokensFrameKey === frameKey && _tileOccludedTokensFrameValue instanceof Set) {
    return _tileOccludedTokensFrameValue;
  }

  const excluded = new Set();
  for (const tile of canvas?.tiles?.placeables ?? []) {
    if (!_tileCandidateIntersectsViewportForMask(tile)) continue;
    for (const token of tokensUnderTile(tile)) excluded.add(token);
  }

  _tileOccludedTokensFrameKey = frameKey;
  _tileOccludedTokensFrameValue = excluded;
  return excluded;
}

/**
 * Compose a cutout mask by subtracting token silhouettes from a base mask.
 * @param {PIXI.RenderTexture} baseRT
 * @param {{outRT?: PIXI.RenderTexture}} [opts]
 * @returns {PIXI.RenderTexture}
 */
export function composeMaskMinusTokens(baseRT, { outRT } = {}) {
  const r = canvas?.app?.renderer;
  if (!r || !baseRT) return baseRT;

  const out =
    outRT ??
    PIXI.RenderTexture.create({
      width: Math.max(1, Number(baseRT.width) || 1),
      height: Math.max(1, Number(baseRT.height) || 1),
      resolution: baseRT.resolution || 1,
    });

  const excludedTokens = getTileOccludedTokens();

  const spr = (_tmpRTCopySprite ??= new PIXI.Sprite());
  spr.texture = baseRT;
  spr.blendMode = PIXI.BLEND_MODES.NORMAL;
  spr.alpha = 1;
  spr.position.set(0, 0);
  spr.scale.set(1, 1);
  spr.rotation = 0;
  r.render(spr, { renderTexture: out, clear: true });

  const Msnap = snappedStageMatrix();
  const c = (_tmpTokenMaskContainer ??= new PIXI.Container());
  try {
    c.removeChildren();
  } catch (err) {
    logger.debug("FXMaster:", err);
  }
  c.transform.setFromMatrix(Msnap);
  c.roundPixels = false;
  for (const s of collectTokenAlphaSprites({ respectOcclusion: true, excludeOccludedByTiles: true, excludedTokens })) {
    s.blendMode = PIXI.BLEND_MODES.DST_OUT;
    s.roundPixels = false;
    c.addChild(s);
  }
  if (c.children.length) r.render(c, { renderTexture: out, clear: false, skipUpdateTransform: false });

  subtractDynamicRingsFromRT(out, { respectOcclusion: true, excludedTokens });
  const poolable = [];
  for (const child of c.children) poolable.push(child);
  try {
    c.removeChildren();
    releaseTokenSprites(poolable);
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  try {
    out.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
    out.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
  } catch (err) {
    logger.debug("FXMaster:", err);
  }
  return out;
}

function _markTileCoverageRT(rt) {
  if (!rt) return rt;
  try {
    rt.__fxmasterCoverageKind = "tiles";
  } catch (err) {
    logger.debug("FXMaster:", err);
  }
  return rt;
}

function _withCoverageSamplingMode(rt, scaleMode, fn) {
  const baseTexture = rt?.baseTexture ?? null;
  if (!baseTexture || scaleMode == null) return fn();

  const previousScaleMode = baseTexture.scaleMode;
  try {
    baseTexture.scaleMode = scaleMode;
    return fn();
  } finally {
    try {
      baseTexture.scaleMode = previousScaleMode;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }
}

function _coverageScaleModeForCompose(coverageRT) {
  if (coverageRT?.__fxmasterCoverageKind !== "tiles") return null;
  if (CONFIG?.fxmaster?.overheadPerformance?.tileCoverageNearestCompose === false) return null;
  return PIXI.SCALE_MODES.NEAREST;
}

/**
 * Compose a cutout mask by subtracting tile silhouettes from a base mask.
 *
 * @param {PIXI.RenderTexture} baseRT
 * @param {{outRT?: PIXI.RenderTexture, mode?: "suppression"|"visible", restrictionKind?: "particles"|"filters"|"weather"}} [opts]
 * @returns {PIXI.RenderTexture}
 */
export function composeMaskMinusTiles(baseRT, { outRT, mode = "suppression", restrictionKind = "weather" } = {}) {
  const r = canvas?.app?.renderer;
  if (!r || !baseRT) return baseRT;

  _tmpComposeTilesCoverageRT = _ensureScratchRTLike(_tmpComposeTilesCoverageRT, baseRT);
  const coverageRT = _tmpComposeTilesCoverageRT;
  if (!coverageRT) return baseRT;

  repaintTilesMaskInto(coverageRT, { mode, restrictionKind });
  _markTileCoverageRT(coverageRT);
  return composeMaskMinusCoverageRT(baseRT, coverageRT, { outRT });
}

/**
 * Compose a cutout mask by subtracting an existing tokens silhouette RT from a base mask.
 *
 * This is a cheaper alternative to {@link composeMaskMinusTokens} because it avoids re-collecting and re-rendering token sprites for each cutout. It assumes both RTs are in the same CSS-space viewport coordinates (e.g. produced by {@link buildSceneAllowMaskRT} and {@link repaintTokensMaskInto}).
 *
 * @param {PIXI.RenderTexture} baseRT
 * @param {PIXI.RenderTexture} tokensRT
 * @param {{outRT?: PIXI.RenderTexture}} [opts]
 * @returns {PIXI.RenderTexture|null}
 */
export function composeMaskMinusCoverageRT(baseRT, coverageRTs, { outRT } = {}) {
  const r = canvas?.app?.renderer;
  const list = Array.isArray(coverageRTs) ? coverageRTs.filter(Boolean) : coverageRTs ? [coverageRTs] : [];
  if (!r || !baseRT || !list.length) return baseRT;

  const out =
    outRT ??
    PIXI.RenderTexture.create({
      width: Math.max(1, Number(baseRT.width) || 1),
      height: Math.max(1, Number(baseRT.height) || 1),
      resolution: baseRT.resolution || 1,
    });

  try {
    const spr = (_tmpRTCopySprite ??= new PIXI.Sprite());
    spr.texture = baseRT;
    spr.blendMode = PIXI.BLEND_MODES.NORMAL;
    spr.alpha = 1;
    spr.position.set(0, 0);
    spr.scale.set(1, 1);
    spr.rotation = 0;
    r.render(spr, { renderTexture: out, clear: true });
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
      const scaleMode = _coverageScaleModeForCompose(coverageRT);
      _withCoverageSamplingMode(coverageRT, scaleMode, () =>
        r.render(eraseSprite, { renderTexture: out, clear: false }),
      );
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  return out;
}

/**
 * Compose a cutout mask by subtracting a tokens silhouette RT from a base mask.
 *
 * @param {PIXI.RenderTexture} baseRT
 * @param {PIXI.RenderTexture} tokensRT
 * @param {{outRT?: PIXI.RenderTexture}} [opts]
 * @returns {PIXI.RenderTexture|null}
 */
export function composeMaskMinusTokensRT(baseRT, tokensRT, { outRT } = {}) {
  return composeMaskMinusCoverageRT(baseRT, tokensRT, { outRT });
}

/**
 * Compose a cutout mask by subtracting a tiles silhouette RT from a base mask.
 *
 * @param {PIXI.RenderTexture} baseRT
 * @param {PIXI.RenderTexture} tilesRT
 * @param {{outRT?: PIXI.RenderTexture}} [opts]
 * @returns {PIXI.RenderTexture|null}
 */
export function composeMaskMinusTilesRT(baseRT, tilesRT, { outRT } = {}) {
  return composeMaskMinusCoverageRT(baseRT, _markTileCoverageRT(tilesRT), { outRT });
}

/**
 * Ensure a CSS-space sprite mask exists under a node and is projected locally.
 * @param {PIXI.Container} node
 * @param {PIXI.Texture|PIXI.RenderTexture|null} texture
 * @param {string} [name="fxmaster:css-mask"]
 * @returns {PIXI.Sprite|null}
 */
export function ensureCssSpaceMaskSprite(node, texture, name = "fxmaster:css-mask") {
  if (!node) return null;
  let spr = node.children?.find?.((c) => c?.name === name) || null;

  if (!spr || spr.destroyed) {
    spr = new PIXI.Sprite(safeMaskTexture(texture));
    spr.name = name;
    spr.renderable = true;
    spr.eventMode = "none";
    spr.interactive = false;
    spr.cursor = null;
    node.addChildAt(spr, 0);
  } else {
    spr.texture = safeMaskTexture(texture);
  }

  const { cssW, cssH } = getCssViewportMetrics();
  spr.x = 0;
  spr.y = 0;
  spr.width = cssW;
  spr.height = cssH;

  applyMaskSpriteTransform(node, spr);
  node.mask = spr;
  return spr;
}

/**
 * Render a tokens-only silhouette into a given RT.
 * @param {PIXI.RenderTexture} outRT
 */
export function repaintTokensMaskInto(outRT) {
  const r = canvas?.app?.renderer;
  if (!r || !outRT) return;
  const excludedTokens = getTileOccludedTokens();
  const Msnap = snappedStageMatrix();
  const cont = (_tmpTokenMaskContainer ??= new PIXI.Container());
  try {
    cont.removeChildren();
  } catch (err) {
    logger.debug("FXMaster:", err);
  }
  cont.transform.setFromMatrix(Msnap);
  cont.roundPixels = false;
  for (const s of collectTokenAlphaSprites({ respectOcclusion: true, excludeOccludedByTiles: true, excludedTokens })) {
    s.blendMode = PIXI.BLEND_MODES.NORMAL;
    s.roundPixels = false;
    cont.addChild(s);
  }
  r.render(cont, { renderTexture: outRT, clear: true, skipUpdateTransform: false });
  paintDynamicRingsInto(outRT, { respectOcclusion: true, excludedTokens });
  const poolable = [];
  for (const child of cont.children) poolable.push(child);
  try {
    cont.removeChildren();
    releaseTokenSprites(poolable);
  } catch (err) {
    logger.debug("FXMaster:", err);
  }
}

/**
 * Render a tiles-only silhouette into a given RT.
 *
 * @param {PIXI.RenderTexture} outRT
 * @param {{ mode?: "suppression"|"visible"|"weatherReveal", eraseUpperCoverage?: boolean, restrictionKind?: "particles"|"filters"|"weather" }} [opts]
 */
export function repaintTilesMaskInto(
  outRT,
  {
    mode = "suppression",
    includeBackground = false,
    shouldIncludeTile = null,
    eraseUpperCoverage = true,
    restrictionKind = "weather",
  } = {},
) {
  const r = canvas?.app?.renderer;
  if (!r || !outRT) return;

  const resolvedRestrictionKind =
    restrictionKind === "particles" || restrictionKind === "filters" ? restrictionKind : "weather";

  _markTileCoverageRT(outRT);

  const combineTilePredicate = (...predicates) => {
    const list = predicates.filter((predicate) => typeof predicate === "function");
    if (!list.length) return null;
    return (tile) => list.every((predicate) => predicate(tile));
  };

  const renderVisibleTileCoverageIntoRT = (renderTexture, predicate, { clear = true } = {}) => {
    const candidates = getTileMaskCandidates({ includeBackground, shouldIncludeTile: predicate });
    const renderedLive = renderLiveTileMeshesIntoRT(renderTexture, {
      candidates,
      clear,
      restrictionKind: resolvedRestrictionKind,
      mode: "visible",
    });
    const fallbackCandidates = candidates.filter((candidate) => !tileCandidateHasRenderableLiveMesh(candidate));
    if (!fallbackCandidates.length) return renderedLive;

    const renderedFallback = renderTileSpritesIntoRT(
      renderTexture,
      collectTileAlphaSpritesFromCandidates(fallbackCandidates, {
        mode: "visible",
        restrictionKind: resolvedRestrictionKind,
      }),
      { clear: clear && !renderedLive },
    );
    return renderedLive || renderedFallback;
  };

  const weatherRestrictedOnly = (tile) => tileRestrictsWeatherForMask(tile, resolvedRestrictionKind);
  const weatherAllowedOnly = (tile) => !tileRestrictsWeatherForMask(tile, resolvedRestrictionKind);

  if (mode === "visible") {
    renderVisibleTileCoverageIntoRT(outRT, shouldIncludeTile, { clear: true });
    if (eraseUpperCoverage) _eraseUnrevealedUpperLevelCoverageFromMask(outRT);
    return;
  }

  if (mode === "suppression") {
    const renderedVisible = renderVisibleTileCoverageIntoRT(
      outRT,
      combineTilePredicate(shouldIncludeTile, weatherAllowedOnly),
      { clear: true },
    );

    const restrictedCandidates = getTileMaskCandidates({
      includeBackground,
      shouldIncludeTile: combineTilePredicate(shouldIncludeTile, weatherRestrictedOnly),
    });
    renderTileSpritesIntoRT(
      outRT,
      collectTileAlphaSpritesFromCandidates(restrictedCandidates, {
        mode: "solid",
        restrictionKind: resolvedRestrictionKind,
      }),
      { clear: !renderedVisible },
    );
    if (eraseUpperCoverage) _eraseUnrevealedUpperLevelCoverageFromMask(outRT);
    return;
  }

  if (mode === "weatherReveal") {
    /**
     * Restricts Weather restoration must follow the tile's actual transparent pixels, including token-driven occlusion holes and full-tile hover fade. Build that mask as: solid tile silhouette
     * - live currently visible tile pixels
     *
     * This preserves source texture alpha while matching the live mesh reveal shape whenever a primary tile mesh is available. Candidates without a renderable live mesh fall back to the inferred visible-alpha sprite path.
     */
    const revealPredicate = combineTilePredicate(shouldIncludeTile, weatherRestrictedOnly);
    const revealCandidates = getTileMaskCandidates({ includeBackground, shouldIncludeTile: revealPredicate });
    const liveRevealCandidates = revealCandidates.filter((candidate) => tileCandidateHasRenderableLiveMesh(candidate));
    const fallbackRevealCandidates = revealCandidates.filter(
      (candidate) => !tileCandidateHasRenderableLiveMesh(candidate),
    );

    renderTileSpritesIntoRT(
      outRT,
      collectTileAlphaSpritesFromCandidates(revealCandidates, {
        mode: "solid",
        restrictionKind: resolvedRestrictionKind,
      }),
      {
        clear: true,
      },
    );

    if (liveRevealCandidates.length) {
      renderLiveTileMeshesIntoRT(outRT, {
        candidates: liveRevealCandidates,
        clear: false,
        blendMode: PIXI.BLEND_MODES.ERASE,
        mode: "visible",
      });
    }

    if (fallbackRevealCandidates.length) {
      renderTileSpritesIntoRT(
        outRT,
        collectTileAlphaSpritesFromCandidates(fallbackRevealCandidates, {
          mode: "visible",
          restrictionKind: resolvedRestrictionKind,
        }),
        {
          clear: false,
          blendMode: PIXI.BLEND_MODES.ERASE,
        },
      );
    }
    return;
  }

  const candidates = getTileMaskCandidates({ includeBackground, shouldIncludeTile });
  renderTileSpritesIntoRT(
    outRT,
    collectTileAlphaSpritesFromCandidates(candidates, { mode, restrictionKind: resolvedRestrictionKind }),
    { clear: true },
  );
  if (eraseUpperCoverage) _eraseUnrevealedUpperLevelCoverageFromMask(outRT);
}

/**
 * Return a non-null texture suitable for sprite masks. Falls back to {@link PIXI.Texture.WHITE} when the input is null, destroyed, or missing required metadata (for example, a missing {@code orig} after texture destruction).
 *
 * @param {PIXI.Texture|PIXI.RenderTexture|null} tex
 * @returns {PIXI.Texture|PIXI.RenderTexture}
 */
export function safeMaskTexture(tex) {
  try {
    if (!tex) return PIXI.Texture.WHITE;
    if (tex.destroyed) return PIXI.Texture.WHITE;
    if (tex.baseTexture?.destroyed) return PIXI.Texture.WHITE;
    if (!tex.orig) return PIXI.Texture.WHITE;
    return tex;
  } catch {
    return PIXI.Texture.WHITE;
  }
}

export function invalidateUpperLevelCoverageCache() {
  _tmpUpperLevelCoverageCacheKey = null;
  _tmpUpperLevelCoverageCacheValue = undefined;
}

/**
 * Render a hard-edged binary region mask into a render texture.
 *
 * @param {PIXI.RenderTexture} rt
 * @param {PlaceableObject} region
 * @param {PIXI.Matrix} stageMatrix
 * @returns {void}
 * @private
 */
function _renderBinaryRegionMaskRT(rt, region, stageMatrix) {
  const r = canvas?.app?.renderer;
  if (!r || !rt) return;

  const { solids: solidsGfx, holes: holesGfx } = _getRegionMaskGfx();
  solidsGfx.clear();
  holesGfx.clear();

  solidsGfx.transform.setFromMatrix(stageMatrix);
  holesGfx.transform.setFromMatrix(stageMatrix);

  const shapes = region?.document?.shapes ?? [];

  solidsGfx.beginFill(0xffffff, 1.0);
  for (const s of shapes) {
    if (!s?.hole) traceRegionShapePIXI(solidsGfx, s);
  }
  solidsGfx.endFill();

  holesGfx.beginFill(0xffffff, 1.0);
  for (const s of shapes) {
    if (s?.hole) traceRegionShapePIXI(holesGfx, s);
  }
  holesGfx.endFill();

  /**
   * These shared graphics objects are also used by scene-suppression rendering, which flips the solids pass to ERASE and the holes pass to NORMAL. Reset both blend modes here so hard scene suppression cannot leak into later region mask builds.
   */
  solidsGfx.blendMode = PIXI.BLEND_MODES.NORMAL;
  holesGfx.blendMode = PIXI.BLEND_MODES.ERASE;

  r.render(solidsGfx, { renderTexture: rt, clear: true });
  r.render(holesGfx, { renderTexture: rt, clear: false });
}

/**
 * Compute the inward edge fade width for a region in CSS pixels.
 *
 * @param {PlaceableObject} region
 * @param {PIXI.Matrix} stageMatrix
 * @param {number} edgeFadePercent
 * @param {number} featherPx
 * @returns {number}
 * @private
 */
function _computeRegionFadeCssPx(region, stageMatrix, edgeFadePercent, featherPx) {
  const pct = Math.min(Math.max(Number(edgeFadePercent) || 0, 0), 1);
  let fadeCssPx = Math.max(0, Number(featherPx) || 0);

  if (pct > 0) {
    const inradWorld = estimateRegionInradius(region);
    if (Number.isFinite(inradWorld) && inradWorld > 0) {
      let worldPerCss = 1;
      try {
        const cssToWorld = stageMatrix.clone().invert();
        worldPerCss = 0.5 * (Math.hypot(cssToWorld.a, cssToWorld.b) + Math.hypot(cssToWorld.c, cssToWorld.d));
        if (!Number.isFinite(worldPerCss) || worldPerCss <= 1e-6) worldPerCss = 1;
      } catch {
        worldPerCss = 1;
      }
      const inradCss = inradWorld / Math.max(worldPerCss, 1e-6);
      fadeCssPx = Math.max(fadeCssPx, pct * inradCss);
    }
  }

  return fadeCssPx;
}

/**
 * Compute the CSS-space bounds needed to bake a soft suppression mask.
 *
 * The bounds are expanded by the fade width so the inward ramp still has access to transparent pixels outside the region when the region boundary reaches the viewport edge.
 *
 * @param {PlaceableObject} region
 * @param {PIXI.Matrix} stageMatrix
 * @param {number} viewportWidth
 * @param {number} viewportHeight
 * @param {number} padCss
 * @returns {{ x:number, y:number, width:number, height:number }|null}
 * @private
 */
function _computeRegionSoftMaskBounds(region, stageMatrix, viewportWidth, viewportHeight, padCss) {
  const worldBounds = regionWorldBoundsAligned(region);
  if (!worldBounds) return null;

  const pts = [
    { x: worldBounds.minX, y: worldBounds.minY },
    { x: worldBounds.maxX, y: worldBounds.minY },
    { x: worldBounds.maxX, y: worldBounds.maxY },
    { x: worldBounds.minX, y: worldBounds.maxY },
  ];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const tmp = new PIXI.Point();
  for (const pt of pts) {
    stageMatrix.apply(pt, tmp);
    minX = Math.min(minX, tmp.x);
    minY = Math.min(minY, tmp.y);
    maxX = Math.max(maxX, tmp.x);
    maxY = Math.max(maxY, tmp.y);
  }

  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;

  const aaPad = 2;
  const grow = Math.max(aaPad, Math.ceil(padCss) + aaPad);

  const clipMinX = Math.floor(-grow);
  const clipMinY = Math.floor(-grow);
  const clipMaxX = Math.ceil(viewportWidth + grow);
  const clipMaxY = Math.ceil(viewportHeight + grow);

  const x0 = Math.max(clipMinX, Math.floor(minX - grow));
  const y0 = Math.max(clipMinY, Math.floor(minY - grow));
  const x1 = Math.min(clipMaxX, Math.ceil(maxX + grow));
  const y1 = Math.min(clipMaxY, Math.ceil(maxY + grow));

  if (!(x1 > x0 && y1 > y0)) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Create a canvas element for temporary region-mask rasterization.
 *
 * @param {number} width
 * @param {number} height
 * @returns {HTMLCanvasElement|null}
 * @private
 */
function _createRegionMaskCanvas(width, height) {
  const doc = globalThis.document;
  if (!doc?.createElement) return null;
  const canvasEl = doc.createElement("canvas");
  canvasEl.width = Math.max(1, Math.ceil(Number(width) || 1));
  canvasEl.height = Math.max(1, Math.ceil(Number(height) || 1));
  return canvasEl;
}

/**
 * Rasterize a region into a binary local-space canvas.
 *
 * @param {PlaceableObject} region
 * @param {{ x:number, y:number, width:number, height:number }} bounds
 * @param {PIXI.Matrix} stageMatrix
 * @param {number} resolution
 * @returns {HTMLCanvasElement|null}
 * @private
 */
function _rasterizeRegionBinaryCanvas(region, bounds, stageMatrix, resolution) {
  const res = Math.max(0.25, Number(resolution) || 1);
  const canvasEl = _createRegionMaskCanvas(bounds.width * res, bounds.height * res);
  if (!canvasEl) return null;

  const ctx = canvasEl.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  ctx.setTransform(
    stageMatrix.a * res,
    stageMatrix.b * res,
    stageMatrix.c * res,
    stageMatrix.d * res,
    (stageMatrix.tx - bounds.x) * res,
    (stageMatrix.ty - bounds.y) * res,
  );
  ctx.imageSmoothingEnabled = false;

  const shapes = region?.document?.shapes ?? [];

  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#ffffff";
  for (const s of shapes) {
    if (s?.hole) continue;
    ctx.beginPath();
    traceRegionShapePath2D(ctx, s);
    ctx.fill();
  }

  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = "#ffffff";
  for (const s of shapes) {
    if (!s?.hole) continue;
    ctx.beginPath();
    traceRegionShapePath2D(ctx, s);
    ctx.fill();
  }

  return canvasEl;
}

/**
 * Run an exact one-dimensional squared Euclidean distance transform.
 *
 * @param {Float32Array} f
 * @param {number} n
 * @param {Float32Array} d
 * @param {Int32Array} v
 * @param {Float32Array} z
 * @returns {void}
 * @private
 */
function _edt1dExact(f, n, d, v, z) {
  const INF = 1e20;
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;

  for (let q = 1; q < n; q++) {
    let p = v[k];
    let s = (f[q] + q * q - (f[p] + p * p)) / (2 * (q - p));

    while (k > 0 && s <= z[k]) {
      k--;
      p = v[k];
      s = (f[q] + q * q - (f[p] + p * p)) / (2 * (q - p));
    }

    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }

  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const p = v[k];
    const dx = q - p;
    d[q] = dx * dx + f[p];
  }
}

/**
 * Compute the exact squared distance from every pixel to the nearest matching feature pixel.
 *
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 * @param {number} featureValue
 * @returns {Float32Array}
 * @private
 */
function _edt2dFromBinaryMask(mask, width, height, featureValue) {
  const W = Math.max(1, width | 0);
  const H = Math.max(1, height | 0);
  const INF = 1e20;
  const n = W * H;

  const maxN = Math.max(W, H);
  const f = new Float32Array(maxN);
  const d = new Float32Array(maxN);
  const v = new Int32Array(maxN);
  const z = new Float32Array(maxN + 1);
  const tmp = new Float32Array(n);

  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) f[x] = mask[row + x] === featureValue ? 0 : INF;
    _edt1dExact(f, W, d, v, z);
    for (let x = 0; x < W; x++) tmp[row + x] = d[x];
  }

  const out = new Float32Array(n);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = tmp[y * W + x];
    _edt1dExact(f, H, d, v, z);
    for (let y = 0; y < H; y++) out[y * W + x] = d[y];
  }

  return out;
}

/**
 * Convert a binary region canvas into an inward-faded alpha mask.
 *
 * Alpha is derived from the exact distance to the nearest transparent pixel, so solids fade inward from their outer edge and holes apply the same fade along their boundary.
 *
 * @param {HTMLCanvasElement} binaryCanvas
 * @param {number} fadePx
 * @returns {HTMLCanvasElement|null}
 * @private
 */
function _bakeInwardFadeCanvas(binaryCanvas, fadePx) {
  const W = Math.max(1, binaryCanvas?.width | 0);
  const H = Math.max(1, binaryCanvas?.height | 0);
  if (!(W > 0 && H > 0)) return null;

  const ctx = binaryCanvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  const img = ctx.getImageData(0, 0, W, H);
  const src = img.data;
  const mask = new Uint8Array(W * H);

  let hasInside = false;
  for (let i = 0, p = 0; i < src.length; i += 4, p++) {
    const inside = src[i + 3] >= 128 ? 1 : 0;
    mask[p] = inside;
    hasInside ||= inside === 1;
  }

  if (!hasInside) {
    ctx.clearRect(0, 0, W, H);
    return binaryCanvas;
  }

  const fade = Math.max(1e-6, Number(fadePx) || 0);
  const distSq = _edt2dFromBinaryMask(mask, W, H, 0);
  const out = ctx.createImageData(W, H);

  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    if (!mask[p]) continue;
    const edgeDist = Math.max(0, Math.sqrt(distSq[p]) - 0.5);
    const alpha = Math.max(0, Math.min(1, edgeDist / fade));
    const v = Math.round(alpha * 255);
    out.data[i + 0] = v;
    out.data[i + 1] = v;
    out.data[i + 2] = v;
    out.data[i + 3] = v;
  }

  ctx.clearRect(0, 0, W, H);
  ctx.putImageData(out, 0, 0);
  return binaryCanvas;
}

/**
 * Render a soft region mask using a locally baked distance field instead of a viewport blur pass.
 *
 * @param {PIXI.RenderTexture} rt
 * @param {PlaceableObject} region
 * @param {PIXI.Matrix} stageMatrix
 * @param {{ viewportWidth:number, viewportHeight:number, resolution:number, fadeCssPx:number }} options
 * @returns {boolean}
 * @private
 */
function _renderSoftRegionMaskRT(rt, region, stageMatrix, { viewportWidth, viewportHeight, resolution, fadeCssPx }) {
  const r = canvas?.app?.renderer;
  if (!r || !rt || !(fadeCssPx > 0)) return false;

  const bounds = _computeRegionSoftMaskBounds(region, stageMatrix, viewportWidth, viewportHeight, fadeCssPx);
  if (!bounds) {
    r.render(new PIXI.Graphics(), { renderTexture: rt, clear: true });
    return true;
  }

  const softRes = safeMaskResolutionForCssArea(bounds.width, bounds.height, Number(resolution) || 1);
  const binaryCanvas = _rasterizeRegionBinaryCanvas(region, bounds, stageMatrix, softRes);
  if (!binaryCanvas) return false;

  const alphaCanvas = _bakeInwardFadeCanvas(binaryCanvas, fadeCssPx * softRes);
  if (!alphaCanvas) return false;

  let texture = null;
  try {
    const base = PIXI.BaseTexture.from(alphaCanvas, {
      scaleMode: PIXI.SCALE_MODES.LINEAR,
      mipmap: PIXI.MIPMAP_MODES.OFF,
      alphaMode: PIXI.ALPHA_MODES.NO_PREMULTIPLIED,
    });
    texture = new PIXI.Texture(base);

    const spr = (_tmpRegionCanvasSprite ??= new PIXI.Sprite());
    spr.texture = texture;
    spr.blendMode = PIXI.BLEND_MODES.NORMAL;
    spr.alpha = 1;
    spr.position.set(bounds.x, bounds.y);
    spr.scale.set(1, 1);
    spr.rotation = 0;
    spr.roundPixels = false;
    spr.width = bounds.width;
    spr.height = bounds.height;
    spr.filters = null;

    r.render(spr, { renderTexture: rt, clear: true });
    spr.texture = PIXI.Texture.EMPTY;
  } catch (err) {
    logger.debug("FXMaster:", err);
    if (texture) {
      try {
        texture.destroy(true);
      } catch (e) {
        logger.debug("FXMaster:", e);
      }
    }
    return false;
  }

  try {
    texture?.destroy(true);
  } catch (err) {
    logger.debug("FXMaster:", err);
  }
  return true;
}

/**
 * Estimate the average CSS-pixel scale of the current stage matrix.
 *
 * @param {PIXI.Matrix} stageMatrix
 * @returns {number}
 * @private
 */
function _averageStageCssScale(stageMatrix) {
  const sx = Math.hypot(stageMatrix?.a ?? 1, stageMatrix?.b ?? 0);
  const sy = Math.hypot(stageMatrix?.c ?? 0, stageMatrix?.d ?? 1);
  const scale = 0.5 * (sx + sy);
  return Number.isFinite(scale) && scale > 1e-6 ? scale : 1;
}

/**
 * Compute the inward fade width for a region in world units.
 *
 * @param {PlaceableObject} region
 * @param {PIXI.Matrix} stageMatrix
 * @param {number} edgeFadePercent
 * @param {number} featherPx
 * @returns {number}
 * @private
 */
function _computeRegionFadeWorld(region, stageMatrix, edgeFadePercent, featherPx = 0) {
  const pct = Math.min(Math.max(Number(edgeFadePercent) || 0, 0), 1);
  let fadeWorld = 0;

  if (pct > 0) {
    const inradWorld = estimateRegionInradius(region);
    if (Number.isFinite(inradWorld) && inradWorld > 0) fadeWorld = Math.max(fadeWorld, pct * inradWorld);
  }

  const featherCss = Math.max(0, Number(featherPx) || 0);
  if (featherCss > 0) {
    const cssPerWorld = _averageStageCssScale(stageMatrix);
    fadeWorld = Math.max(fadeWorld, featherCss / Math.max(cssPerWorld, 1e-6));
  }

  return fadeWorld;
}

/**
 * Rasterize a region into a binary world-space canvas at a chosen pixel density.
 *
 * @param {PlaceableObject} region
 * @param {{ x:number, y:number, width:number, height:number }} boundsWorld
 * @param {number} pixelsPerWorld
 * @returns {HTMLCanvasElement|null}
 * @private
 */
function _rasterizeRegionBinaryCanvasWorld(region, boundsWorld, pixelsPerWorld) {
  const ppw = Math.max(0.25, Number(pixelsPerWorld) || 1);
  const canvasEl = _createRegionMaskCanvas(boundsWorld.width * ppw, boundsWorld.height * ppw);
  if (!canvasEl) return null;

  const ctx = canvasEl.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  ctx.setTransform(ppw, 0, 0, ppw, -boundsWorld.x * ppw, -boundsWorld.y * ppw);
  ctx.imageSmoothingEnabled = false;

  const shapes = region?.document?.shapes ?? [];

  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#ffffff";
  for (const s of shapes) {
    if (s?.hole) continue;
    ctx.beginPath();
    traceRegionShapePath2D(ctx, s);
    ctx.fill();
  }

  ctx.globalCompositeOperation = "destination-out";
  for (const s of shapes) {
    if (!s?.hole) continue;
    ctx.beginPath();
    traceRegionShapePath2D(ctx, s);
    ctx.fill();
  }

  return canvasEl;
}

/**
 * Destroy a cached scene-suppression soft-mask entry.
 *
 * @param {{ texture?: PIXI.Texture|null }|null} entry
 * @returns {void}
 * @private
 */
function _destroySceneSuppressionSoftCacheEntry(entry) {
  if (!entry) return;
  try {
    entry.texture?.destroy(true);
  } catch (err) {
    logger.debug("FXMaster:", err);
  }
}

/**
 * Prune stale or excess scene-suppression soft-mask cache entries.
 *
 * @param {string|null} sceneId
 * @param {number} [maxEntries=48]
 * @returns {void}
 * @private
 */
function _trimSceneSuppressionSoftCache(sceneId, maxEntries = 48) {
  for (const [key, entry] of _sceneSuppressionSoftCache) {
    if (sceneId && entry?.sceneId === sceneId) continue;
    _destroySceneSuppressionSoftCacheEntry(entry);
    _sceneSuppressionSoftCache.delete(key);
  }

  if (_sceneSuppressionSoftCache.size <= maxEntries) return;

  const victims = [..._sceneSuppressionSoftCache.entries()]
    .sort((a, b) => (a[1]?.lastUsed ?? 0) - (b[1]?.lastUsed ?? 0))
    .slice(0, Math.max(0, _sceneSuppressionSoftCache.size - maxEntries));

  for (const [key, entry] of victims) {
    _destroySceneSuppressionSoftCacheEntry(entry);
    _sceneSuppressionSoftCache.delete(key);
  }
}

/**
 * Clear all cached scene-suppression soft masks.
 *
 * @returns {void}
 */
export function clearSceneSuppressionSoftMaskCache() {
  for (const entry of _sceneSuppressionSoftCache.values()) _destroySceneSuppressionSoftCacheEntry(entry);
  _sceneSuppressionSoftCache.clear();
  _sceneSuppressionSoftCacheTick = 0;
}

/**
 * Retrieve or build a cached world-space soft suppression mask for a region.
 *
 * The cache is camera-independent, so pan and zoom reuse the same baked mask and only re-render the sprite with the updated stage transform. Rebuilds occur when the region geometry or edge-fade setting changes.
 *
 * @param {PlaceableObject} region
 * @param {PIXI.Matrix} stageMatrix
 * @param {number} edgeFadePercent
 * @returns {{ texture: PIXI.Texture, boundsWorld: { x:number, y:number, width:number, height:number }, pixelsPerWorld: number }|null}
 * @private
 */
function _getSceneSuppressionSoftMaskEntry(region, stageMatrix, edgeFadePercent) {
  const sceneId = canvas?.scene?.id ?? null;
  const regionId = region?.document?.id ?? region?.id ?? null;
  if (!sceneId || !regionId) return null;

  /**
   * Use camera-independent world bounds for the cached soft mask. CSS-aligned bounds track the snapped viewport and would invalidate the cache on every pan or zoom, forcing a full distance-field rebake whenever the camera moves.
   */
  const worldBounds = regionWorldBounds(region);
  if (!worldBounds) return null;

  const fadeWorld = _computeRegionFadeWorld(region, stageMatrix, edgeFadePercent, 0);
  if (!(fadeWorld > 0)) return null;

  const roughWidth = worldBounds.maxX - worldBounds.minX + fadeWorld * 2;
  const roughHeight = worldBounds.maxY - worldBounds.minY + fadeWorld * 2;
  if (!(roughWidth > 0 && roughHeight > 0)) return null;

  /**
   * Keep the cached bake density stable in world space. Scene suppression masks are reused across both particles and filters, so camera movement must not raise the bake density or mutate the cache key.
   */
  let targetPixelsPerWorld = SCENE_SUPPRESSION_SOFT_MAX_PIXELS_PER_WORLD;
  {
    const maxDimWorld = Math.max(roughWidth, roughHeight, 1e-6);
    const worldArea = Math.max(roughWidth * roughHeight, 1e-6);
    const spanCap = SCENE_SUPPRESSION_SOFT_MAX_TEXTURE_SPAN / maxDimWorld;
    const areaCap = Math.sqrt(SCENE_SUPPRESSION_SOFT_MAX_TEXTURE_AREA / worldArea);
    targetPixelsPerWorld = Math.max(0.25, Math.min(targetPixelsPerWorld, spanCap, areaCap));
  }

  /**
   * Pad by the fade width plus a small texel margin so the inward ramp still sees transparent pixels outside the region. The margin is derived from the baked texture density, not the camera scale, so the cache remains pan/zoom invariant.
   */
  let aaPadWorld = 2 / Math.max(targetPixelsPerWorld, 1e-6);
  let boundsWorld = {
    x: worldBounds.minX - (fadeWorld + aaPadWorld),
    y: worldBounds.minY - (fadeWorld + aaPadWorld),
    width: worldBounds.maxX - worldBounds.minX + (fadeWorld + aaPadWorld) * 2,
    height: worldBounds.maxY - worldBounds.minY + (fadeWorld + aaPadWorld) * 2,
  };

  {
    const maxDimWorld = Math.max(boundsWorld.width, boundsWorld.height, 1e-6);
    const worldArea = Math.max(boundsWorld.width * boundsWorld.height, 1e-6);
    const spanCap = SCENE_SUPPRESSION_SOFT_MAX_TEXTURE_SPAN / maxDimWorld;
    const areaCap = Math.sqrt(SCENE_SUPPRESSION_SOFT_MAX_TEXTURE_AREA / worldArea);
    const cappedPixelsPerWorld = Math.max(0.25, Math.min(targetPixelsPerWorld, spanCap, areaCap));
    if (cappedPixelsPerWorld < targetPixelsPerWorld) {
      targetPixelsPerWorld = cappedPixelsPerWorld;
      aaPadWorld = 2 / Math.max(targetPixelsPerWorld, 1e-6);
      boundsWorld = {
        x: worldBounds.minX - (fadeWorld + aaPadWorld),
        y: worldBounds.minY - (fadeWorld + aaPadWorld),
        width: worldBounds.maxX - worldBounds.minX + (fadeWorld + aaPadWorld) * 2,
        height: worldBounds.maxY - worldBounds.minY + (fadeWorld + aaPadWorld) * 2,
      };
    }
  }

  if (!(boundsWorld.width > 0 && boundsWorld.height > 0)) return null;

  const key = `${sceneId}:${regionId}:${Math.round(edgeFadePercent * 1000000)}`;
  const shapesRef = fxmReadDocumentShapes(region?.document);
  const boundsSig = `${boundsWorld.x}|${boundsWorld.y}|${boundsWorld.width}|${boundsWorld.height}`;

  const cached = _sceneSuppressionSoftCache.get(key) ?? null;
  if (
    cached &&
    cached.shapesRef === shapesRef &&
    cached.boundsSig === boundsSig &&
    Math.abs((cached.fadeWorld ?? 0) - fadeWorld) <= 1e-6 &&
    Math.abs((cached.pixelsPerWorld ?? 0) - targetPixelsPerWorld) <= 1e-6
  ) {
    cached.lastUsed = ++_sceneSuppressionSoftCacheTick;
    return cached;
  }

  if (cached) {
    _destroySceneSuppressionSoftCacheEntry(cached);
    _sceneSuppressionSoftCache.delete(key);
  }

  const binaryCanvas = _rasterizeRegionBinaryCanvasWorld(region, boundsWorld, targetPixelsPerWorld);
  if (!binaryCanvas) return null;

  const alphaCanvas = _bakeInwardFadeCanvas(binaryCanvas, fadeWorld * targetPixelsPerWorld);
  if (!alphaCanvas) return null;

  let texture = null;
  try {
    const base = PIXI.BaseTexture.from(alphaCanvas, {
      scaleMode: PIXI.SCALE_MODES.LINEAR,
      mipmap: PIXI.MIPMAP_MODES.OFF,
      alphaMode: PIXI.ALPHA_MODES.NO_PREMULTIPLIED,
    });
    try {
      if (base?.resource && "autoUpdate" in base.resource) base.resource.autoUpdate = false;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    texture = new PIXI.Texture(base);
  } catch (err) {
    logger.debug("FXMaster:", err);
    try {
      texture?.destroy(true);
    } catch (e) {
      logger.debug("FXMaster:", e);
    }
    return null;
  }

  const entry = {
    sceneId,
    regionId,
    shapesRef,
    boundsSig,
    fadeWorld,
    boundsWorld,
    pixelsPerWorld: targetPixelsPerWorld,
    texture,
    lastUsed: ++_sceneSuppressionSoftCacheTick,
  };

  _sceneSuppressionSoftCache.set(key, entry);
  _trimSceneSuppressionSoftCache(sceneId);
  return entry;
}

/**
 * Ensure a reusable hard-suppression region mask matches the scene allow-mask render texture.
 *
 * @param {PIXI.RenderTexture} sceneAllowRT
 * @returns {PIXI.RenderTexture|null}
 * @private
 */
function _ensureSceneSuppressionHardMaskRT(sceneAllowRT) {
  if (!sceneAllowRT) return null;

  const width = Math.max(1, Number(sceneAllowRT.width) || 1);
  const height = Math.max(1, Number(sceneAllowRT.height) || 1);
  const resolution = sceneAllowRT.resolution || 1;
  const bad =
    !_tmpSceneSuppressionHardMaskRT ||
    _tmpSceneSuppressionHardMaskRT.destroyed ||
    Math.abs(Number(_tmpSceneSuppressionHardMaskRT.width ?? 0) - width) > 0.001 ||
    Math.abs(Number(_tmpSceneSuppressionHardMaskRT.height ?? 0) - height) > 0.001 ||
    (_tmpSceneSuppressionHardMaskRT.resolution || 1) !== resolution;

  if (!bad) return _tmpSceneSuppressionHardMaskRT;

  const oldRT = _tmpSceneSuppressionHardMaskRT ?? null;
  _tmpSceneSuppressionHardMaskRT = PIXI.RenderTexture.create({ width, height, resolution, multisample: 0 });
  try {
    _tmpSceneSuppressionHardMaskRT.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
    _tmpSceneSuppressionHardMaskRT.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
  } catch (err) {
    logger.debug("FXMaster:", err);
  }
  _destroyTextureDeferred(oldRT);
  return _tmpSceneSuppressionHardMaskRT;
}

/**
 * Render a cached world-space soft suppression mask directly into a scene allow-mask RT.
 *
 * @param {PIXI.RenderTexture} rt
 * @param {PlaceableObject} region
 * @param {PIXI.Matrix} stageMatrix
 * @param {number} edgeFadePercent
 * @returns {boolean}
 * @private
 */
function _renderSceneSuppressionSoftMask(rt, region, stageMatrix, edgeFadePercent) {
  return _renderSceneSuppressionSoftMaskSprite(rt, region, stageMatrix, edgeFadePercent, {
    blendMode: PIXI.BLEND_MODES.ERASE,
    clear: false,
  });
}

/**
 * Render a cached world-space soft suppression mask sprite into a render texture.
 *
 * The scene allow-mask uses this with ERASE blending. Overlay-object correction uses the same cached soft mask with NORMAL blending as a clip texture, which keeps non-contiguous upper-Level suppression edges visually identical to the base Region suppression edge.
 *
 * @param {PIXI.RenderTexture} rt
 * @param {PlaceableObject} region
 * @param {PIXI.Matrix} stageMatrix
 * @param {number} edgeFadePercent
 * @param {{ blendMode?: number, clear?: boolean }} [options]
 * @returns {boolean}
 * @private
 */
function _renderSceneSuppressionSoftMaskSprite(
  rt,
  region,
  stageMatrix,
  edgeFadePercent,
  { blendMode = PIXI.BLEND_MODES.NORMAL, clear = false } = {},
) {
  const r = canvas?.app?.renderer;
  if (!r || !rt) return false;

  const entry = _getSceneSuppressionSoftMaskEntry(region, stageMatrix, edgeFadePercent);
  if (!entry?.texture) return false;

  const bounds = entry.boundsWorld;
  const ppw = Math.max(1e-6, entry.pixelsPerWorld || 1);
  const matrix = new PIXI.Matrix(
    stageMatrix.a / ppw,
    stageMatrix.b / ppw,
    stageMatrix.c / ppw,
    stageMatrix.d / ppw,
    stageMatrix.a * bounds.x + stageMatrix.c * bounds.y + stageMatrix.tx,
    stageMatrix.b * bounds.x + stageMatrix.d * bounds.y + stageMatrix.ty,
  );

  const spr = (_tmpSceneSuppressionSprite ??= new PIXI.Sprite());
  spr.texture = entry.texture;
  spr.blendMode = blendMode;
  spr.alpha = 1;
  spr.roundPixels = false;
  spr.filters = null;
  spr.transform.setFromMatrix(matrix);

  try {
    r.render(spr, { renderTexture: rt, clear });
    return true;
  } catch (err) {
    logger.debug("FXMaster:", err);
    return false;
  } finally {
    spr.blendMode = PIXI.BLEND_MODES.NORMAL;
    spr.texture = PIXI.Texture.EMPTY;
  }
}

/**
 * Render a hard or soft Region clip into a reusable scene-allow overlay RT.
 *
 * @param {PIXI.RenderTexture} rt
 * @param {PlaceableObject} region
 * @param {PIXI.Matrix} stageMatrix
 * @param {number} [edgeFadePercent=0]
 * @returns {boolean}
 * @private
 */
function _renderSceneSuppressionClipMaskRT(rt, region, stageMatrix, edgeFadePercent = 0) {
  if (!rt || !region) return false;

  const fade = Math.min(Math.max(Number(edgeFadePercent) || 0, 0), 1);
  if (fade > 0) {
    if (!_clearSceneAllowOverlayRT(rt)) return false;
    if (
      _renderSceneSuppressionSoftMaskSprite(rt, region, stageMatrix, fade, {
        blendMode: PIXI.BLEND_MODES.NORMAL,
        clear: false,
      })
    )
      return true;
  }

  _renderBinaryRegionMaskRT(rt, region, stageMatrix);
  return true;
}

/**
 * Render a hard-edged suppression region into a scene allow-mask render texture.
 *
 * The region is first composed into an isolated binary mask, then erased from the scene allow mask. Shape holes remain transparent in the local mask instead of restoring pixels suppressed by another region.
 *
 * @param {PIXI.RenderTexture} rt
 * @param {PlaceableObject} region
 * @param {PIXI.Matrix} stageMatrix
 * @returns {void}
 * @private
 */
function _renderSceneSuppressionHardRegion(rt, region, stageMatrix) {
  const r = canvas?.app?.renderer;
  if (!r || !rt || !region) return;

  const maskRT = _ensureSceneSuppressionHardMaskRT(rt);
  if (!maskRT) return;

  _renderBinaryRegionMaskRT(maskRT, region, stageMatrix);

  const spr = (_tmpSceneSuppressionSprite ??= new PIXI.Sprite(PIXI.Texture.EMPTY));
  spr.texture = maskRT;
  spr.blendMode = PIXI.BLEND_MODES.ERASE;
  spr.alpha = 1;
  spr.roundPixels = false;
  spr.filters = null;
  spr.transform.setFromMatrix(new PIXI.Matrix());
  spr.position.set(0, 0);
  spr.scale.set(1, 1);
  spr.width = Math.max(1, Number(rt.width) || 1);
  spr.height = Math.max(1, Number(rt.height) || 1);

  try {
    r.render(spr, { renderTexture: rt, clear: false });
  } catch (err) {
    logger.debug("FXMaster:", err);
  } finally {
    spr.texture = PIXI.Texture.EMPTY;
  }
}

/**
 * Build a CSS-space alpha mask RenderTexture for a region. White = inside (allowed), transparent = outside (suppressed).
 * - Camera-aligned via `snappedStageMatrix()` to avoid seams.
 * - Renders solids first, then ERASEs holes.
 * - Uses the provided {@link RTPool} when available.
 *
 * @param {PlaceableObject} region
 * @param {object} [opts]
 * @param {RTPool} [opts.rtPool]
 * @param {PIXI.RenderTexture|null} [opts.reuseRT] - Existing render texture to repaint in-place when dimensions match.
 * @param {number} [opts.resolution]
 * @param {number} [opts.edgeFadePercent=0] - Inward edge fade percentage in [0..1].
 * @param {number} [opts.featherPx=0] - Inward edge feather width in CSS pixels.
 * @returns {PIXI.RenderTexture|null}
 */
export function buildRegionMaskRT(
  region,
  { rtPool, resolution, edgeFadePercent = 0, featherPx = 0, reuseRT = null } = {},
) {
  const r = canvas?.app?.renderer;
  if (!r) return null;

  const { cssW, cssH } = getCssViewportMetrics();
  const VW = Math.max(1, Number(cssW) || 1);
  const VH = Math.max(1, Number(cssH) || 1);

  const res = resolution ?? safeMaskResolutionForCssArea(VW, VH, 1);
  const canReuse =
    !!reuseRT &&
    !reuseRT.destroyed &&
    !reuseRT.baseTexture?.destroyed &&
    Math.abs(Number(reuseRT.width ?? 0) - VW) <= 0.001 &&
    Math.abs(Number(reuseRT.height ?? 0) - VH) <= 0.001 &&
    Math.abs(Number(reuseRT.resolution || 1) - Number(res || 1)) <= 0.0001;

  const rt = canReuse
    ? reuseRT
    : rtPool
    ? rtPool.acquire(VW, VH, res)
    : PIXI.RenderTexture.create({ width: VW, height: VH, resolution: res });

  try {
    rt.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
    rt.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  const stageMatrix = snappedStageMatrix();
  const fadeCssPx = _computeRegionFadeCssPx(region, stageMatrix, edgeFadePercent, featherPx);

  if (fadeCssPx > 0) {
    try {
      if (
        _renderSoftRegionMaskRT(rt, region, stageMatrix, {
          viewportWidth: VW,
          viewportHeight: VH,
          resolution: res,
          fadeCssPx,
        })
      ) {
        return rt;
      }
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  _renderBinaryRegionMaskRT(rt, region, stageMatrix);
  return rt;
}

/**
 * Project a CSS-space mask sprite into a container's local space (pixel-snapped). Keeps the existing "roundPixels" behavior mirrored from the particle layer.
 *
 * @param {PIXI.Container} container
 * @param {PIXI.Sprite} spr
 */
export function applyMaskSpriteTransform(container, spr) {
  const r = canvas?.app?.renderer;
  const res = r?.resolution || window.devicePixelRatio || 1;

  const stageMatrix = snappedStageMatrix();
  const localToStage = stageLocalMatrixOf(container);
  const localToCss = new PIXI.Matrix(
    stageMatrix.a * localToStage.a + stageMatrix.c * localToStage.b,
    stageMatrix.b * localToStage.a + stageMatrix.d * localToStage.b,
    stageMatrix.a * localToStage.c + stageMatrix.c * localToStage.d,
    stageMatrix.b * localToStage.c + stageMatrix.d * localToStage.d,
    stageMatrix.a * localToStage.tx + stageMatrix.c * localToStage.ty + stageMatrix.tx,
    stageMatrix.b * localToStage.tx + stageMatrix.d * localToStage.ty + stageMatrix.ty,
  );

  const cssToLocal = localToCss.invert();
  cssToLocal.tx = Math.round(cssToLocal.tx * res) / res;
  cssToLocal.ty = Math.round(cssToLocal.ty * res) / res;
  spr.transform.setFromMatrix(cssToLocal);
  spr.roundPixels = false;
  container.roundPixels = false;
}

/**
 * Compute whether a region should be "passed through" by elevation + viewer-gating.
 *
 * @param {PlaceableObject} placeable
 * @param {{behaviorType:string}} options - behaviorType: e.g. `${packageId}.particleEffectsRegion` or `${packageId}.filterEffectsRegion`
 * @returns {boolean}
 */
export function computeRegionGatePass(placeable, { behaviorType }) {
  const doc = placeable?.document;
  if (!doc) return true;

  const fxBeh = (doc.behaviors ?? []).find((b) => b.type === behaviorType && !b.disabled);
  if (!fxBeh) return true;

  const runtime = fxmReadRegionBehaviorRuntimeState(fxBeh, packageId);
  if (runtime.gmAlwaysVisible && game.user?.isGM) return true;

  const eventGate = runtime.eventGate ?? getEventGate(placeable, behaviorType);
  const { mode, latched } = eventGate;
  if (mode === "enterExit") return !!latched;
  if (mode === "enter" && !latched) return false;

  const win = getRegionElevationWindow(doc);
  const gateMode = runtime.gateMode;

  const tokenElevation = (t) => {
    const d = Number(t?.document?.elevation);
    if (Number.isFinite(d)) return d;
    const e = Number(t?.elevation);
    return Number.isFinite(e) ? e : NaN;
  };

  if (gateMode === "pov") {
    const selected = canvas.tokens?.controlled ?? [];
    if (!selected?.length) return false;
    if (!win) return true;
    for (const t of selected) {
      const elev = tokenElevation(t);
      if (Number.isFinite(elev) && inRangeElev(elev, win)) return true;
    }
    return false;
  }

  if (gateMode === "targets") {
    const ids = runtime.tokenTargets ?? [];
    if (!ids.length) return false;

    const selected = canvas.tokens?.controlled ?? [];
    if (!selected.length) return false;

    const inList = (t) => {
      const id = t?.document?.id;
      const uuid = t?.document?.uuid;
      return ids.includes(id) || ids.includes(uuid);
    };
    const pool = selected.filter(inList);
    if (!pool.length) return false;

    if (!win) return true;
    for (const t of pool) {
      const elev = tokenElevation(t);
      if (Number.isFinite(elev) && inRangeElev(elev, win)) return true;
    }
    return false;
  }

  return true;
}

/**
 * Return a stable numeric string for cache signatures.
 *
 * @param {number} value
 * @param {number} [digits=3]
 * @returns {string}
 * @private
 */
function _numberCacheKey(value, digits = 3) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : "NaN";
}

/**
 * Return a stable matrix key for scene allow-mask caching.
 *
 * @param {PIXI.Matrix|null|undefined} matrix
 * @returns {string}
 * @private
 */
function _matrixCacheKey(matrix) {
  return [matrix?.a, matrix?.b, matrix?.c, matrix?.d, matrix?.tx, matrix?.ty]
    .map((value) => _numberCacheKey(value, 4))
    .join(",");
}

/**
 * Safely stringify plain Region shape data for cache signatures.
 *
 * @param {unknown} value
 * @returns {string}
 * @private
 */
function _shapeDataCacheKey(value) {
  try {
    return JSON.stringify(value ?? null, (_key, entry) => (typeof entry === "function" ? undefined : entry));
  } catch (_err) {
    if (Array.isArray(value)) return `array:${value.length}`;
    return String(value ?? "");
  }
}

/**
 * Return a compact signature for a preserved overlay DisplayObject.
 *
 * @param {PIXI.DisplayObject|null|undefined} object
 * @param {number} index
 * @returns {string}
 * @private
 */
function _preserveObjectCacheKey(object, index) {
  if (!object) return `missing:${index}`;
  const linked = fxmLinkedPlaceableFromDisplayObject(object);
  const document = linked?.document ?? object?.document ?? object?.level?.document ?? object?.level ?? null;
  const texture = object?.texture ?? object?.mesh?.texture ?? linked?.mesh?.texture ?? linked?.texture ?? null;
  const base = texture?.baseTexture ?? null;
  const textureKey = base?.cacheId ?? base?.resource?.url ?? base?.resource?.src ?? base?.uid ?? texture?.uid ?? "";

  let boundsKey = "bounds";
  try {
    const bounds = object.getBounds?.(false) ?? object.bounds ?? null;
    if (bounds) {
      boundsKey = [
        _numberCacheKey(bounds.x, 2),
        _numberCacheKey(bounds.y, 2),
        _numberCacheKey(bounds.width, 2),
        _numberCacheKey(bounds.height, 2),
      ].join(",");
    }
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  const transformId = fxmDisplayObjectTransformSignature(object);
  const alpha = Number(object?.worldAlpha ?? object?.alpha ?? 1);
  return [
    document?.id ?? linked?.id ?? index,
    document?.uuid ?? "",
    object?.level?.id ?? linked?.level?.id ?? document?.level?.id ?? "",
    textureKey,
    transformId,
    object?.visible === false ? 0 : 1,
    object?.renderable === false ? 0 : 1,
    _numberCacheKey(alpha, 3),
    boundsKey,
  ].join("~");
}

/**
 * Return a compact signature for a preserved world-space shape.
 *
 * @param {object|null|undefined} shape
 * @param {number} index
 * @returns {string}
 * @private
 */
function _preserveShapeCacheKey(shape, index) {
  if (!shape) return `missing:${index}`;
  return [
    shape.type ?? "shape",
    shape.source ?? "",
    shape.tokenId ?? index,
    _numberCacheKey(shape.x ?? 0, 2),
    _numberCacheKey(shape.y ?? 0, 2),
    _numberCacheKey(shape.radius ?? 0, 2),
    _numberCacheKey(shape.width ?? 0, 2),
    _numberCacheKey(shape.height ?? 0, 2),
  ].join(",");
}

/**
 * Return a compact signature for a scene-suppression input entry.
 *
 * @param {{ region?: PlaceableObject, edgeFadePercent?: number, preserveObjects?: PIXI.DisplayObject[], preserveShapes?: object[], suppressObjects?: PIXI.DisplayObject[], suppressOnlyObjects?: boolean }|PlaceableObject} entry
 * @returns {string}
 * @private
 */
function _sceneSuppressionEntryCacheKey(entry) {
  const region = entry?.region ?? entry;
  if (!region) return "missing-region";

  let boundsKey = "bounds-unavailable";
  try {
    const bounds = regionWorldBounds(region) ?? regionWorldBoundsAligned(region);
    if (bounds) {
      boundsKey = [
        _numberCacheKey(bounds.minX ?? bounds.x, 2),
        _numberCacheKey(bounds.minY ?? bounds.y, 2),
        _numberCacheKey(bounds.maxX ?? (bounds.x ?? 0) + (bounds.width ?? 0), 2),
        _numberCacheKey(bounds.maxY ?? (bounds.y ?? 0) + (bounds.height ?? 0), 2),
      ].join(",");
    }
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  const shapes = fxmReadDocumentShapes(region?.document);
  const preserveObjects = Array.isArray(entry?.preserveObjects) ? entry.preserveObjects : [];
  const preserveShapes = Array.isArray(entry?.preserveShapes) ? entry.preserveShapes : [];
  const suppressObjects = Array.isArray(entry?.suppressObjects) ? entry.suppressObjects : [];
  return [
    region?.document?.id ?? region?.id ?? "",
    region?.document?.uuid ?? "",
    boundsKey,
    _shapeDataCacheKey(shapes),
    _numberCacheKey(entry?.edgeFadePercent ?? 0, 4),
    entry?.suppressOnlyObjects ? 1 : 0,
    preserveObjects.map((object, index) => _preserveObjectCacheKey(object, index)).join(";"),
    preserveShapes.map((shape, index) => _preserveShapeCacheKey(shape, index)).join(";"),
    suppressObjects.map((object, index) => _preserveObjectCacheKey(object, index)).join(";"),
  ].join("|");
}

/**
 * Return the render resolution for scene allow masks.
 *
 * Native Level overlay preservation needs the same device-density backing as the active renderer so preserved upper-Level pixels and filtered row output share one sampling grid. Plain alpha masks remain capped at one for performance.
 *
 * @param {number} cssW
 * @param {number} cssH
 * @param {Array<object>} suppressionEntries
 * @returns {number}
 * @private
 */
function _sceneAllowMaskResolution(cssW, cssH, suppressionEntries) {
  const hasPreservedSurfaces = (suppressionEntries ?? []).some((entry) => {
    return (
      (Array.isArray(entry?.preserveObjects) && entry.preserveObjects.length) ||
      (Array.isArray(entry?.preserveShapes) && entry.preserveShapes.length) ||
      (Array.isArray(entry?.suppressObjects) && entry.suppressObjects.length)
    );
  });

  if (canvas?.level && hasPreservedSurfaces) return safeResolutionForCssArea(cssW, cssH);
  return safeMaskResolutionForCssArea(cssW, cssH);
}

/**
 * Build a dirty-state cache key for the final scene allow mask.
 *
 * @param {{ cssW:number, cssH:number, res:number, stageMatrix:PIXI.Matrix, suppressionEntries:Array<object> }} options
 * @returns {string}
 * @private
 */
function _sceneAllowMaskCacheKey({ cssW, cssH, res, stageMatrix, suppressionEntries }) {
  const d = canvas?.dimensions;
  const sceneRect = d?.sceneRect ?? null;
  const hasPreservedObjects = suppressionEntries.some(
    (entry) =>
      (Array.isArray(entry?.preserveObjects) && entry.preserveObjects.length) ||
      (Array.isArray(entry?.preserveShapes) && entry.preserveShapes.length) ||
      (Array.isArray(entry?.suppressObjects) && entry.suppressObjects.length),
  );

  let surfaceKey = "";
  if (canvas?.level && hasPreservedObjects) {
    try {
      const surfaceState = getCanvasLiveLevelSurfaceState(canvas?.scene ?? null, { presynced: true });
      surfaceKey = surfaceState?.forceRefresh ? `force:${Date.now()}` : surfaceState?.key ?? "";
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  return [
    canvas?.scene?.id ?? "scene",
    _numberCacheKey(cssW, 3),
    _numberCacheKey(cssH, 3),
    _numberCacheKey(res, 3),
    _matrixCacheKey(stageMatrix),
    sceneRect
      ? [
          _numberCacheKey(sceneRect.x, 2),
          _numberCacheKey(sceneRect.y, 2),
          _numberCacheKey(sceneRect.width, 2),
          _numberCacheKey(sceneRect.height, 2),
        ].join(",")
      : "scene-rect-unavailable",
    surfaceKey,
    suppressionEntries.map((entry) => _sceneSuppressionEntryCacheKey(entry)).join("#"),
  ].join("::");
}

/**
 * Build a scene-wide allow-mask render texture.
 *
 * Supports two per-region suppression inputs:
 * - `weatherRegions`: hard-edged suppression without customization.
 * - `suppressionRegions`: suppression with optional inward edge fade.
 *
 * The legacy `regions` option is retained as an alias for `weatherRegions`.
 *
 * @param {{ regions?: Region[]|null, weatherRegions?: Array<Region|{ region: Region, preserveObjects?: PIXI.DisplayObject[], preserveShapes?: object[], suppressObjects?: PIXI.DisplayObject[], suppressOnlyObjects?: boolean }>|null, suppressionRegions?: Array<{ region: Region, edgeFadePercent?: number, preserveObjects?: PIXI.DisplayObject[], preserveShapes?: object[], suppressObjects?: PIXI.DisplayObject[], suppressOnlyObjects?: boolean }>, reuseRT?: PIXI.RenderTexture|null }} [opts]
 * @returns {PIXI.RenderTexture|null}
 */
export function buildSceneAllowMaskRT({
  regions = null,
  weatherRegions = null,
  suppressionRegions = [],
  reuseRT = null,
} = {}) {
  const r = canvas?.app?.renderer;
  if (!r) return null;

  const { cssW, cssH } = getCssViewportMetrics();
  const hardRegionEntries = (Array.isArray(weatherRegions) ? weatherRegions : Array.isArray(regions) ? regions : [])
    .map((entry) => (entry?.region ? entry : { region: entry }))
    .filter((entry) => !!entry?.region)
    .map((entry) => ({ ...entry, edgeFadePercent: 0 }));
  const suppressionEntries = [...hardRegionEntries, ...(Array.isArray(suppressionRegions) ? suppressionRegions : [])];
  const res = _sceneAllowMaskResolution(cssW, cssH, suppressionEntries);
  const M = snappedStageMatrix();
  const cacheKey = _sceneAllowMaskCacheKey({ cssW, cssH, res, stageMatrix: M, suppressionEntries });

  let rt = reuseRT ?? null;
  const needsNew =
    !rt ||
    Math.abs(Number(rt.width ?? 0) - cssW) > 0.001 ||
    Math.abs(Number(rt.height ?? 0) - cssH) > 0.001 ||
    Math.abs(Number(rt.resolution || 1) - res) > 0.0001;

  if (!needsNew && rt?.__fxmasterSceneAllowMaskCacheKey === cacheKey) return rt;

  if (needsNew) {
    const oldRT = reuseRT ?? null;
    rt = PIXI.RenderTexture.create({
      width: cssW,
      height: cssH,
      resolution: res,
      multisample: 0,
    });
    try {
      rt.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
      rt.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    _destroyTextureDeferred(oldRT);
  }

  /** Paint background black (suppressed by default). */
  {
    const { bg } = _getSceneAllowMaskGfx();
    bg.clear();
    bg.beginFill(0x000000, 1).drawRect(0, 0, cssW, cssH).endFill();
    r.render(bg, { renderTexture: rt, clear: true });
  }

  /** Paint scene area white (allowed inside scene dimensions). */
  const d = canvas.dimensions;
  if (d) {
    const { scene } = _getSceneAllowMaskGfx();
    scene.clear();

    scene.transform.setFromMatrix(new PIXI.Matrix());

    const x0w = d.sceneRect.x;
    const y0w = d.sceneRect.y;
    const x1w = x0w + d.sceneRect.width;
    const y1w = y0w + d.sceneRect.height;

    const p0 = new PIXI.Point();
    const p1 = new PIXI.Point();
    M.apply({ x: x0w, y: y0w }, p0);
    M.apply({ x: x1w, y: y1w }, p1);

    const minX = Math.min(p0.x, p1.x);
    const minY = Math.min(p0.y, p1.y);
    const maxX = Math.max(p0.x, p1.x);
    const maxY = Math.max(p0.y, p1.y);

    /**
     * Seam prevention: avoid rounding to the nearest pixel. Rounding can shrink the transformed scene rect by 1px depending on fractional camera alignment, producing a 1px transparent seam that appears to jump between edges at different zoom levels. Bounds are expanded to cover the transformed scene rect.
     */
    const left = Math.floor(minX);
    const top = Math.floor(minY);
    const right = Math.ceil(maxX);
    const bottom = Math.ceil(maxY);

    const x = Math.max(0, Math.min(cssW, left));
    const y = Math.max(0, Math.min(cssH, top));
    const w = Math.max(0, Math.min(cssW, right) - x);
    const h = Math.max(0, Math.min(cssH, bottom) - y);

    if (w > 0 && h > 0) {
      scene.beginFill(0xffffff, 1.0);
      scene.drawRect(x, y, w, h);
      scene.endFill();
      r.render(scene, { renderTexture: rt, clear: false });
    }
  }

  /** Apply each suppression region as an isolated mask so holes remain local to that region. */
  if (suppressionEntries.length) {
    _trimSceneSuppressionSoftCache(canvas?.scene?.id ?? null);

    for (const entry of suppressionEntries) {
      const region = entry?.region ?? entry;
      if (!region) continue;

      const edgeFadePercent = Math.min(Math.max(Number(entry?.edgeFadePercent) || 0, 0), 1);
      const suppressOnlyObjects = entry?.suppressOnlyObjects === true;

      if (!suppressOnlyObjects) {
        let renderedSoft = false;
        if (edgeFadePercent > 0) renderedSoft = _renderSceneSuppressionSoftMask(rt, region, M, edgeFadePercent);
        if (!renderedSoft) _renderSceneSuppressionHardRegion(rt, region, M);
      }

      const spec = { width: cssW, height: cssH, resolution: res, edgeFadePercent };

      const preserveObjects = Array.isArray(entry?.preserveObjects) ? entry.preserveObjects.filter(Boolean) : [];
      if (!suppressOnlyObjects && preserveObjects.length)
        _restorePreservedOverlayObjectsIntoSceneAllowMask(rt, region, M, preserveObjects, spec);

      const preserveShapes = Array.isArray(entry?.preserveShapes) ? entry.preserveShapes.filter(Boolean) : [];
      if (!suppressOnlyObjects && preserveShapes.length)
        _restorePreservedShapesIntoSceneAllowMask(rt, region, M, preserveShapes, spec);

      const suppressObjects = Array.isArray(entry?.suppressObjects) ? entry.suppressObjects.filter(Boolean) : [];
      if (suppressObjects.length)
        _eraseSuppressedOverlayObjectsFromSceneAllowMask(rt, region, M, suppressObjects, spec);

      /**
       * Object-only suppression starts from the already-allowed scene mask and erases the assigned lower-Level surface silhouettes. Restore higher overlay surfaces afterward so the lower-Level erase does not punch through the single screen-space allow mask and suppress an upper selected Level occupying the same pixels.
       */
      if (suppressOnlyObjects && preserveObjects.length)
        _restorePreservedOverlayObjectsIntoSceneAllowMask(rt, region, M, preserveObjects, spec);
    }
  }

  try {
    rt.__fxmasterSceneAllowMaskCacheKey = cacheKey;
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  return rt;
}

/**
 * Ensure (or rebuild) the below-tokens artifacts for a given base allow-mask RT:
 * - a "cutout" RT = base minus token silhouettes
 * - a tokens-only RT (alpha mask)
 *
 * Returns updated RTs (existing ones are destroyed/replaced if dimension/res changed).
 *
 * @param {PIXI.RenderTexture} baseRT
 * @param {{ cutoutRT?: PIXI.RenderTexture|null, tokensMaskRT?: PIXI.RenderTexture|null }} [state]
 * @returns {{ cutoutRT: PIXI.RenderTexture, tokensMaskRT: PIXI.RenderTexture }}
 */
export function ensureBelowTokensArtifacts(baseRT, state = {}) {
  const r = canvas?.app?.renderer;
  if (!r || !baseRT) return { cutoutRT: null, tokensMaskRT: null };

  const W = Math.max(1, Number(baseRT.width) || 1);
  const H = Math.max(1, Number(baseRT.height) || 1);
  const res = baseRT.resolution || 1;

  let cutoutRT = state.cutoutRT;
  const cutoutBad = !cutoutRT || cutoutRT.width !== W || cutoutRT.height !== H || (cutoutRT.resolution || 1) !== res;
  if (cutoutBad) {
    try {
      cutoutRT?.destroy(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    cutoutRT = PIXI.RenderTexture.create({ width: W, height: H, resolution: res, multisample: 0 });
  }
  composeMaskMinusTokens(baseRT, { outRT: cutoutRT });
  try {
    cutoutRT.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
    cutoutRT.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  let tokensMaskRT = state.tokensMaskRT;
  const tokensBad =
    !tokensMaskRT || tokensMaskRT.width !== W || tokensMaskRT.height !== H || (tokensMaskRT.resolution || 1) !== res;
  if (tokensBad) {
    try {
      tokensMaskRT?.destroy(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    tokensMaskRT = PIXI.RenderTexture.create({ width: W, height: H, resolution: res, multisample: 0 });
  }
  repaintTokensMaskInto(tokensMaskRT);
  try {
    tokensMaskRT.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
    tokensMaskRT.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  return { cutoutRT, tokensMaskRT };
}

/**
 * Apply scene-mask uniforms to a list of FXMaster filters. Honors per-filter "belowTokens" option by swapping the sampler and providing token silhouettes.
 * @param {PIXI.Filter[]} filters
 * @param {{ baseMaskRT: PIXI.RenderTexture, cutoutTokensRT?: PIXI.RenderTexture|null, cutoutTilesRT?: PIXI.RenderTexture|null, cutoutCombinedRT?: PIXI.RenderTexture|null, tokensMaskRT?: PIXI.RenderTexture|null, cssW: number, cssH: number, deviceToCss: number, maskSoft?: boolean }} cfg
 */
export function applyMaskUniformsToFilters(
  filters,
  {
    baseMaskRT,
    cutoutTokensRT = null,
    cutoutTilesRT = null,
    cutoutCombinedRT = null,
    tokensMaskRT = null,
    cssW,
    cssH,
    deviceToCss,
    maskSoft = false,
  },
) {
  const rtCssW = baseMaskRT ? Math.max(1, Number(baseMaskRT.width) || 1) : Math.max(1, Number(cssW) || 1);
  const rtCssH = baseMaskRT ? Math.max(1, Number(baseMaskRT.height) || 1) : Math.max(1, Number(cssH) || 1);

  for (const f of filters) {
    if (!f) continue;
    const u = f.uniforms || {};
    const wantBelowTokens = _belowTokensEnabled(f?.__fxmBelowTokens ?? f?.options?.belowTokens);
    const wantBelowTiles = _belowTilesEnabled(f?.__fxmBelowTiles ?? f?.options?.belowTiles);

    let rt = baseMaskRT;
    if (wantBelowTokens && wantBelowTiles) rt = cutoutCombinedRT || cutoutTokensRT || cutoutTilesRT || baseMaskRT;
    else if (wantBelowTokens) rt = cutoutTokensRT || cutoutCombinedRT || baseMaskRT;
    else if (wantBelowTiles) rt = cutoutTilesRT || cutoutCombinedRT || baseMaskRT;

    f.__fxmMaskVariants = {
      baseMaskRT: baseMaskRT ?? null,
      cutoutTokensRT: cutoutTokensRT ?? null,
      cutoutTilesRT: cutoutTilesRT ?? null,
      cutoutCombinedRT: cutoutCombinedRT ?? null,
      tokensMaskRT: tokensMaskRT ?? null,
      cssW: rtCssW,
      cssH: rtCssH,
      deviceToCss,
      maskSoft: !!maskSoft,
    };

    if ("maskSampler" in u) u.maskSampler = rt;
    if ("hasMask" in u) u.hasMask = rt ? 1.0 : 0.0;
    if ("maskReady" in u) u.maskReady = rt ? 1.0 : 0.0;
    if ("maskSoft" in u) u.maskSoft = maskSoft ? 1.0 : 0.0;

    if ("viewSize" in u) {
      const arr = u.viewSize instanceof Float32Array && u.viewSize.length >= 2 ? u.viewSize : new Float32Array(2);
      arr[0] = rtCssW;
      arr[1] = rtCssH;
      u.viewSize = arr;
    }

    if ("deviceToCss" in u) u.deviceToCss = deviceToCss;

    if (wantBelowTokens && tokensMaskRT) {
      if ("tokenSampler" in u) u.tokenSampler = tokensMaskRT;
      if ("hasTokenMask" in u) u.hasTokenMask = 1.0;
    } else {
      if ("tokenSampler" in u) u.tokenSampler = PIXI.Texture.EMPTY;
      if ("hasTokenMask" in u) u.hasTokenMask = 0.0;
    }
  }
}

/**
 * Subtract dynamic token rings from a render texture via DST_OUT. Safe: temporarily flips mesh.blendMode and restores it.
 * @param {PIXI.RenderTexture} outRT
 * @param {{ respectOcclusion?: boolean, excludedTokens?: Set<Token>|null, excludeOccludedByTiles?: boolean }} [opts]
 */
export function subtractDynamicRingsFromRT(outRT, opts = {}) {
  const r = canvas?.app?.renderer;
  if (!r || !outRT) return;
  const respectOcclusion = !!opts.respectOcclusion;
  const excludedTokens =
    opts.excludedTokens instanceof Set
      ? opts.excludedTokens
      : opts.excludeOccludedByTiles
      ? getTileOccludedTokens()
      : null;
  const M = snappedStageMatrix();
  for (const t of collectBelowTokenMaskTokens()) {
    if (!_tokenIntersectsViewportForMask(t)) continue;
    if (!_tokenParticipatesInBelowTokenMask(t)) continue;
    if (!t?.mesh || !t?.hasDynamicRing) continue;
    if (respectOcclusion && _isTokenOccludedByOverhead(t)) continue;
    if (excludedTokens?.has(t)) continue;
    const oldBM = t.mesh.blendMode;
    const oldAlph = t.mesh.worldAlpha;
    try {
      t.mesh.blendMode = PIXI.BLEND_MODES.DST_OUT;
      t.mesh.worldAlpha = 1;
      r.render(t.mesh, { renderTexture: outRT, clear: false, transform: M, skipUpdateTransform: false });
    } finally {
      t.mesh.blendMode = oldBM;
      t.mesh.worldAlpha = oldAlph;
    }
  }
}

/**
 * Paint dynamic token rings (normal blend) into a tokens-only RT.
 * @param {PIXI.RenderTexture} outRT
 * @param {{ respectOcclusion?: boolean, excludedTokens?: Set<Token>|null, excludeOccludedByTiles?: boolean }} [opts]
 */
export function paintDynamicRingsInto(outRT, opts = {}) {
  const r = canvas?.app?.renderer;
  if (!r || !outRT) return;
  const respectOcclusion = !!opts.respectOcclusion;
  const excludedTokens =
    opts.excludedTokens instanceof Set
      ? opts.excludedTokens
      : opts.excludeOccludedByTiles
      ? getTileOccludedTokens()
      : null;
  const M = snappedStageMatrix();
  for (const t of collectBelowTokenMaskTokens()) {
    if (!_tokenIntersectsViewportForMask(t)) continue;
    if (!_tokenParticipatesInBelowTokenMask(t)) continue;
    if (!t?.mesh || !t?.hasDynamicRing) continue;
    if (respectOcclusion && _isTokenOccludedByOverhead(t)) continue;
    if (excludedTokens?.has(t)) continue;
    const oldBM = t.mesh.blendMode;
    const oldAlph = t.mesh.worldAlpha;
    try {
      t.mesh.blendMode = PIXI.BLEND_MODES.NORMAL;
      t.mesh.worldAlpha = 1;
      r.render(t.mesh, { renderTexture: outRT, clear: false, transform: M, skipUpdateTransform: false });
    } finally {
      t.mesh.blendMode = oldBM;
      t.mesh.worldAlpha = oldAlph;
    }
  }
}
