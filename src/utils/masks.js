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
import { getCssViewportMetrics, safeMaskResolutionForCssArea, snappedStageMatrix } from "./viewport.js";
import {
  getCanvasLevel,
  getCanvasLiveLevelSurfaceRevealState,
  getDocumentLevelsSet,
  getSceneLevels,
  getTileOcclusionModes,
  inferVisibleLevelForDocument,
  isDocumentOnCurrentCanvasLevel,
} from "./compat.js";

let _tmpRTCopySprite = null;
let _tmpTokensEraseSprite = null;
let _tmpUpperLevelCoverageRT = null;
let _tmpUpperLevelCoverageEraseSprite = null;
let _tmpUpperLevelCoverageCacheKey = null;
let _tmpUpperLevelCoverageCacheValue = undefined;

/** Region-mask softening scratch objects. */
let _tmpRegionCanvasSprite = null;

let _tmpSceneSuppressionSprite = null;
let _tmpSceneSuppressionHardMaskRT = null;
let _sceneSuppressionSoftCache = new Map();
let _sceneSuppressionSoftCacheTick = 0;

let _sceneAllowOverlayObjectRT = null;
let _sceneAllowOverlayRegionRT = null;
let _sceneAllowOverlaySprite = null;
let _sceneAllowOverlayFilter = null;
let _sceneAllowOverlayClearGfx = null;

/** Maximum device-independent pixel density used for cached world-space suppression masks. */
const SCENE_SUPPRESSION_SOFT_MAX_PIXELS_PER_WORLD = 1;
/** Maximum texture span for a cached world-space suppression mask. */
const SCENE_SUPPRESSION_SOFT_MAX_TEXTURE_SPAN = 3072;
/** Maximum texel budget for a cached world-space suppression mask. */
const SCENE_SUPPRESSION_SOFT_MAX_TEXTURE_AREA = 2_000_000;

/**
 * Normalize a texture/source path for cross-object comparisons.
 *
 * @param {unknown} path
 * @returns {string}
 * @private
 */
function _normalizeComparableSourcePath(path) {
  if (typeof path !== "string") return "";
  const trimmed = path.trim();
  if (!trimmed) return "";

  let decoded = trimmed;
  try {
    decoded = decodeURI(trimmed);
  } catch (_err) {
    decoded = trimmed;
  }

  const originPattern = new RegExp("^https?:\\/\\/[^/]+", "i");
  const filePattern = new RegExp("^file:\\/\\/", "i");

  return decoded
    .replace(originPattern, "")
    .replace(filePattern, "")
    .replace(/^\/+/, "")
    .replace(/\?.*$/, "")
    .replace(/#.*$/, "");
}

/**
 * Add a normalized comparable path to a set.
 *
 * @param {Set<string>} output
 * @param {unknown} value
 * @returns {void}
 * @private
 */
function _addComparableSourcePath(output, value) {
  const normalized = _normalizeComparableSourcePath(value);
  if (normalized) output.add(normalized);
}

/**
 * Collect likely texture source paths from a PIXI/Foundry object graph.
 *
 * @param {unknown} value
 * @param {Set<string>} [output]
 * @param {Set<unknown>} [seen]
 * @returns {Set<string>}
 * @private
 */
function _collectComparableSourcePaths(value, output = new Set(), seen = new Set()) {
  if (!value) return output;
  if (typeof value === "string") {
    _addComparableSourcePath(output, value);
    return output;
  }
  if (typeof value !== "object" && typeof value !== "function") return output;
  if (seen.has(value)) return output;
  seen.add(value);

  const direct = [
    value.src,
    value.currentSrc,
    value.url,
    value.href,
    value.path,
    value.img,
    value.cacheId,
    value.texture?.src,
    value.texture?.baseTexture?.resource?.src,
    value.baseTexture?.resource?.src,
    value.resource?.src,
    value._source?.src,
    value._source?.img,
    value._source?.texture?.src,
    value.document?.texture?.src,
    value.document?.src,
    value.document?.img,
  ];

  for (const candidate of direct) _addComparableSourcePath(output, candidate);
  if (Array.isArray(value.textureCacheIds)) {
    for (const candidate of value.textureCacheIds) _addComparableSourcePath(output, candidate);
  }

  const nested = [
    value.texture,
    value.baseTexture,
    value.resource,
    value.source,
    value.object,
    value.placeable,
    value.document,
    value._source,
    value.level,
  ];
  for (const candidate of nested) {
    if (candidate && candidate !== value) _collectComparableSourcePaths(candidate, output, seen);
  }

  return output;
}

/**
 * Add configured background/foreground image paths for a Level document.
 *
 * @param {foundry.documents.Level|null|undefined} level
 * @param {Set<string>} output
 * @returns {void}
 * @private
 */
function _addLevelConfiguredImagePaths(level, output) {
  if (!level || !(output instanceof Set)) return;
  const candidates = [level.background, level.foreground, level._source?.background, level._source?.foreground];
  for (const candidate of candidates) _collectComparableSourcePaths(candidate, output);
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

  const ids = new Set();
  for (const level of levels ?? []) {
    const id = level?.id ?? null;
    if (!id) continue;
    const levelPaths = new Set();
    _addLevelConfiguredImagePaths(level, levelPaths);
    for (const pathValue of paths) {
      if (!levelPaths.has(pathValue)) continue;
      ids.add(id);
      break;
    }
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
  const currentLevelId = context?.currentLevel?.id ?? null;
  if (!currentLevelId) return false;
  return _resolveSurfaceExplicitLevelIds(surface).has(currentLevelId);
}

function _levelBottom(level) {
  const n = Number(level?.elevation?.bottom ?? level?.bottom ?? Number.NaN);
  return Number.isFinite(n) ? n : Number.NaN;
}

function _levelTop(level) {
  const n = Number(level?.elevation?.top ?? level?.top ?? Number.NaN);
  return Number.isFinite(n) ? n : Number.NaN;
}

function _levelIsAbove(candidate, target) {
  if (!candidate || !target) return false;
  const cb = _levelBottom(candidate);
  const tb = _levelBottom(target);
  if (Number.isFinite(cb) && Number.isFinite(tb)) return cb > tb + 1e-4;
  const ct = _levelTop(candidate);
  const tt = _levelTop(target);
  if (Number.isFinite(ct) && Number.isFinite(tt)) return ct > tt + 1e-4;
  return false;
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
  const hoverFadeElevation = Number(canvas?.primary?.hoverFadeElevation ?? Number.NaN);
  const hoverKey = Number.isFinite(hoverFadeElevation) ? hoverFadeElevation.toFixed(3) : "none";
  const tickerTime = Number(canvas?.app?.ticker?.lastTime ?? 0).toFixed(3);
  const width = likeRT?.width | 0;
  const height = likeRT?.height | 0;
  const resolution = Number(likeRT?.resolution ?? 1).toFixed(3);
  return [
    canvas?.scene?.id ?? "scene",
    getCanvasLevel()?.id ?? "level",
    width,
    height,
    resolution,
    tickerTime,
    transformKey,
    hoverKey,
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
  const width = outRT.width | 0;
  const height = outRT.height | 0;
  const resolution = outRT.resolution || 1;
  const bad =
    !_tmpUpperLevelCoverageRT ||
    _tmpUpperLevelCoverageRT.destroyed ||
    (_tmpUpperLevelCoverageRT.width | 0) !== width ||
    (_tmpUpperLevelCoverageRT.height | 0) !== height ||
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
    if (reveal?.revealed) continue;

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
    if (reveal?.revealed) continue;

    push(captureObject);
  }

  return objects;
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
 * Erase unrevealed upper-level coverage from a tile mask so lower tiles do not
 * punch visible holes through an opaque higher level surface.
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
function _captureDisplayObjectsIntoSceneAllowRT(rt, objects) {
  const renderer = canvas?.app?.renderer;
  if (!renderer || !rt) return false;
  if (!_clearSceneAllowOverlayRT(rt)) return false;

  let rendered = false;
  for (const object of objects ?? []) {
    if (!object || object.destroyed) continue;
    try {
      renderer.render(object, {
        renderTexture: rt,
        clear: false,
        skipUpdateTransform: true,
      });
      rendered = true;
    } catch (err) {
      logger.debug("FXMaster:", err);
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
  sprite.width = Math.max(1, width | 0);
  sprite.height = Math.max(1, height | 0);
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
    return `${w | 0}x${h | 0}@${res || 1}`;
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
    return PIXI.RenderTexture.create({ width: w | 0, height: h | 0, resolution: res || 1 });
  }

  /**
   * Release a RenderTexture back to the pool.
   * @param {PIXI.RenderTexture} rt
   */
  release(rt) {
    if (!rt) return;
    try {
      const key = this._key(rt.width | 0, rt.height | 0, rt.resolution || 1);
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
  for (const t of canvas.tokens?.placeables ?? []) {
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

  const hoverFadeState = mesh?._hoverFadeState ?? mesh?.hoverFadeState ?? tile?.hoverFadeState ?? null;
  if (hoverFadeState?.faded || hoverFadeState?.fading) return true;

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
 * Return whether a tile restricts weather effects for FXMaster masking.
 *
 * @param {{ tile?: Tile|null, mesh?: PIXI.DisplayObject|null }|Tile|null|undefined} candidate
 * @returns {boolean}
 */
export function tileRestrictsWeatherForMask(candidate) {
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

  let alpha = null;
  try {
    if (typeof tile?._getTargetAlpha === "function") alpha = Number(tile._getTargetAlpha());
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  if (!Number.isFinite(alpha)) {
    alpha = Number(tile?.document?.alpha ?? tile?.alpha ?? mesh?.alpha ?? mesh?.worldAlpha ?? 1);
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
function getTileSuppressionMaskAlpha(candidate) {
  if (!tileIsEligibleForMask(candidate)) return 0;
  if (tileRestrictsWeatherForMask(candidate)) return 1;
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
function getTileWeatherRevealMaskAlpha(candidate) {
  if (!tileIsEligibleForMask(candidate)) return 0;
  if (!tileRestrictsWeatherForMask(candidate)) return 0;

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
  return candidates.filter((candidate) =>
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
  const cont = new PIXI.Container();
  try {
    r.render(cont, { renderTexture: outRT, clear: true, skipUpdateTransform: false });
  } catch (err) {
    logger.debug("FXMaster:", err);
  } finally {
    try {
      cont.destroy({ children: false, texture: false, baseTexture: false });
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }
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

  const cont = new PIXI.Container();
  cont.transform.setFromMatrix(snappedStageMatrix());
  cont.roundPixels = false;

  for (const s of sprites ?? []) {
    if (!s) continue;
    s.blendMode = blendMode;
    s.roundPixels = false;
    cont.addChild(s);
  }

  if (!cont.children.length) {
    if (clear) clearTileMaskRenderTexture(outRT);
    try {
      cont.destroy({ children: false, texture: false, baseTexture: false });
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    return false;
  }

  try {
    r.render(cont, { renderTexture: outRT, clear, skipUpdateTransform: false });
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  const poolable = [];
  for (const child of cont.children) poolable.push(child);
  try {
    cont.removeChildren();
    releaseTileSprites(poolable);
    cont.destroy({ children: false, texture: false, baseTexture: false });
  } catch (err) {
    logger.debug("FXMaster:", err);
  }
  return true;
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
 * @param {{ includeBackground?: boolean, shouldIncludeTile?: (t: Tile) => boolean, candidates?: Array<{ tile: Tile, mesh: PIXI.DisplayObject|null }>, restrictWeather?: boolean|null, clear?: boolean, blendMode?: number }} [opts]
 * @returns {boolean}
 */
function renderLiveTileMeshesIntoRT(
  outRT,
  {
    includeBackground = false,
    shouldIncludeTile = null,
    candidates = null,
    restrictWeather = null,
    clear = true,
    blendMode = PIXI.BLEND_MODES.NORMAL,
  } = {},
) {
  const r = canvas?.app?.renderer;
  if (!r || !outRT) return false;

  const tileCandidates = Array.isArray(candidates)
    ? candidates
    : getTileMaskCandidates({ includeBackground, shouldIncludeTile });
  const stageTransform = snappedStageMatrix();
  let rendered = false;

  for (const candidate of tileCandidates) {
    const mesh = _getTileMaskCandidateMesh(candidate);
    if (typeof restrictWeather === "boolean" && tileRestrictsWeatherForMask(candidate) !== restrictWeather) continue;
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
function collectTileAlphaSpritesFromCandidates(candidates, { mode = "suppression" } = {}) {
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
        ? getTileWeatherRevealMaskAlpha(candidate)
        : resolvedMode === "solid"
        ? 1
        : getTileSuppressionMaskAlpha(candidate);
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
 * @param {{ includeBackground?: boolean, shouldIncludeTile?: (t: Tile) => boolean, mode?: "suppression"|"visible"|"weatherReveal"|"solid" }} [opts]
 * @returns {PIXI.Sprite[]}
 */
export function collectTileAlphaSprites(opts = {}) {
  const includeBackground = !!opts.includeBackground;
  const shouldInclude = typeof opts.shouldIncludeTile === "function" ? opts.shouldIncludeTile : null;
  const mode =
    opts.mode === "visible"
      ? "visible"
      : opts.mode === "weatherReveal"
      ? "weatherReveal"
      : opts.mode === "solid"
      ? "solid"
      : "suppression";

  const candidates = getTileMaskCandidates({ includeBackground, shouldIncludeTile: shouldInclude });
  return collectTileAlphaSpritesFromCandidates(candidates, { mode });
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
  if (!isDocumentOnCurrentCanvasLevel(token?.document ?? null, tokenElevation)) return false;

  const explicitlyRevealed = token?.controlled === true;
  const revealedByHoveredUpperLevel = isTokenRevealedByHoveredUpperLevel(token);
  if (explicitlyRevealed) return true;
  if (_isTokenCoveredByUpperLevelSurface(token) && !revealedByHoveredUpperLevel) return false;
  if (_isTokenCurrentlyVisible(token)) return true;
  if (revealedByHoveredUpperLevel) return true;

  return _sceneMaskContainsTokenCenter(token) === true;
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
 * Return whether a token is currently revealed through the hovered or explicitly revealed native Levels surface that actually covers it.
 *
 * Native Levels hover reveal does not currently expose a public state flag that changes on the underlying Level document or shared scene mask. The reveal check therefore tracks the nearest upper level surface above the token and treats that specific covering surface as revealed when either the mouse is over that surface or a controlled token is already covered by the same surface.
 *
 * @param {Token|null|undefined} token
 * @returns {boolean}
 */
export function isTokenRevealedByHoveredUpperLevel(token) {
  const directUpperLevelSurface = _getNearestUpperLevelSurfaceCoveringToken(token);
  if (!Array.isArray(directUpperLevelSurface?.meshes) || directUpperLevelSurface.meshes.length === 0) return false;
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
function _getNearestUpperLevelSurfaceCoveringToken(token) {
  const tileSurface = _getNearestUpperLevelTileMeshesCoveringToken(token);
  if (tileSurface.meshes.length > 0) return tileSurface;
  return _getNearestUpperLevelLevelTexturesCoveringToken(token);
}

/**
 * Return the highest qualifying upper native Levels tile meshes that cover the token center.
 *
 * @param {Token|null|undefined} token
 * @returns {{meshes: PIXI.DisplayObject[], tokenCenter: PIXI.Point|{x:number, y:number}|null, elevation: number|null}}
 * @private
 */
function _getNearestUpperLevelTileMeshesCoveringToken(token) {
  const tokenCenter = _getTokenCenterPoint(token);
  if (!canvas?.level || !canvas?.primary || !tokenCenter) return { meshes: [], tokenCenter, elevation: null };

  const tokenElevation = Number(token?.elevation ?? token?.document?.elevation ?? Number.NaN);
  if (!isDocumentOnCurrentCanvasLevel(token?.document ?? null, tokenElevation))
    return { meshes: [], tokenCenter, elevation: null };

  const hoverFadeElevation = Number(canvas.primary?.hoverFadeElevation ?? Number.NaN);
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
function _getNearestUpperLevelLevelTexturesCoveringToken(token) {
  const tokenCenter = _getTokenCenterPoint(token);
  if (!canvas?.level || !canvas?.primary || !tokenCenter) return { meshes: [], tokenCenter, elevation: null };

  const tokenElevation = Number(token?.elevation ?? token?.document?.elevation ?? Number.NaN);
  if (!isDocumentOnCurrentCanvasLevel(token?.document ?? null, tokenElevation))
    return { meshes: [], tokenCenter, elevation: null };

  const hoverFadeElevation = Number(canvas.primary?.hoverFadeElevation ?? Number.NaN);
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
function _surfaceIsHovered(surface) {
  if (!_surfaceHasMeshes(surface)) return false;

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
  if (isTokenRevealedByHoveredUpperLevel(token)) return false;

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
  const revealedByHoveredUpperLevel = isTokenRevealedByHoveredUpperLevel(token);
  const coveredByUpperLevelTexture = _isTokenCoveredByUpperLevelSurface(token);

  if (!onCurrentLevel) {
    if (_isTokenCurrentlyVisible(token) || visibleThroughSceneMask === true || revealedByHoveredUpperLevel)
      return false;
    return true;
  }

  if (token.controlled) return false;
  if (coveredByUpperLevelTexture && !revealedByHoveredUpperLevel) return true;
  if (visibleThroughSceneMask === true || revealedByHoveredUpperLevel) return false;
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

  const linked = candidate?.object ?? candidate?.placeable ?? candidate?._object ?? candidate?.sourceElement ?? null;
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

  const hoverFadeState =
    candidate?._hoverFadeState ??
    candidate?.hoverFadeState ??
    candidate?.mesh?._hoverFadeState ??
    candidate?.mesh?.hoverFadeState ??
    null;
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
  const hoverFadeState =
    tileObj?.mesh?._hoverFadeState ?? tileObj?.mesh?.hoverFadeState ?? tileObj?.hoverFadeState ?? null;
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

  const found = canvas?.tokens?.quadtree?.getObjects?.(tileObj.bounds);
  if (!found) return [];
  return Array.from(found).filter((token) => !!token?.document && isTokenUnderTile(token, tileObj));
}

/**
 * Collect tokens that are currently hidden beneath non-faded occluding tiles.
 *
 * @returns {Set<Token>}
 * @private
 */
function getTileOccludedTokens() {
  const excluded = new Set();
  for (const tile of canvas?.tiles?.placeables ?? []) {
    for (const token of tokensUnderTile(tile)) excluded.add(token);
  }
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
      width: baseRT.width | 0,
      height: baseRT.height | 0,
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
  const c = new PIXI.Container();
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
    c.destroy({ children: false, texture: false, baseTexture: false });
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

/**
 * Compose a cutout mask by subtracting tile silhouettes from a base mask.
 *
 * @param {PIXI.RenderTexture} baseRT
 * @param {{outRT?: PIXI.RenderTexture, mode?: "suppression"|"visible"}} [opts]
 * @returns {PIXI.RenderTexture}
 */
export function composeMaskMinusTiles(baseRT, { outRT, mode = "suppression" } = {}) {
  const r = canvas?.app?.renderer;
  if (!r || !baseRT) return baseRT;

  const coverageRT = PIXI.RenderTexture.create({
    width: baseRT.width | 0,
    height: baseRT.height | 0,
    resolution: baseRT.resolution || 1,
  });

  try {
    repaintTilesMaskInto(coverageRT, { mode });
    return composeMaskMinusCoverageRT(baseRT, coverageRT, { outRT });
  } finally {
    try {
      coverageRT.destroy(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }
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
      width: baseRT.width | 0,
      height: baseRT.height | 0,
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
      r.render(eraseSprite, { renderTexture: out, clear: false });
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
  return composeMaskMinusCoverageRT(baseRT, tilesRT, { outRT });
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
  const cont = new PIXI.Container();
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
    cont.destroy({ children: false, texture: false, baseTexture: false });
  } catch (err) {
    logger.debug("FXMaster:", err);
  }
}

/**
 * Render a tiles-only silhouette into a given RT.
 *
 * @param {PIXI.RenderTexture} outRT
 * @param {{ mode?: "suppression"|"visible"|"weatherReveal", eraseUpperCoverage?: boolean }} [opts]
 */
export function repaintTilesMaskInto(
  outRT,
  { mode = "suppression", includeBackground = false, shouldIncludeTile = null, eraseUpperCoverage = true } = {},
) {
  const r = canvas?.app?.renderer;
  if (!r || !outRT) return;

  const combineTilePredicate = (...predicates) => {
    const list = predicates.filter((predicate) => typeof predicate === "function");
    if (!list.length) return null;
    return (tile) => list.every((predicate) => predicate(tile));
  };

  const renderVisibleTileCoverageIntoRT = (renderTexture, predicate, { clear = true } = {}) => {
    const renderedLive = renderLiveTileMeshesIntoRT(renderTexture, {
      includeBackground,
      shouldIncludeTile: predicate,
      clear,
    });

    if (renderedLive) return true;

    return renderTileSpritesIntoRT(
      renderTexture,
      collectTileAlphaSprites({
        mode: "visible",
        includeBackground,
        shouldIncludeTile: predicate,
      }),
      { clear },
    );
  };

  const weatherRestrictedOnly = (tile) => tileRestrictsWeatherForMask(tile);
  const weatherAllowedOnly = (tile) => !tileRestrictsWeatherForMask(tile);

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

    renderTileSpritesIntoRT(
      outRT,
      collectTileAlphaSprites({
        mode: "solid",
        includeBackground,
        shouldIncludeTile: combineTilePredicate(shouldIncludeTile, weatherRestrictedOnly),
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

    renderTileSpritesIntoRT(outRT, collectTileAlphaSpritesFromCandidates(revealCandidates, { mode: "solid" }), {
      clear: true,
    });

    if (liveRevealCandidates.length) {
      renderLiveTileMeshesIntoRT(outRT, {
        candidates: liveRevealCandidates,
        clear: false,
        blendMode: PIXI.BLEND_MODES.ERASE,
      });
    }

    if (fallbackRevealCandidates.length) {
      renderTileSpritesIntoRT(
        outRT,
        collectTileAlphaSpritesFromCandidates(fallbackRevealCandidates, { mode: "visible" }),
        {
          clear: false,
          blendMode: PIXI.BLEND_MODES.ERASE,
        },
      );
    }
    return;
  }

  renderTileSpritesIntoRT(outRT, collectTileAlphaSprites({ mode, includeBackground, shouldIncludeTile }), {
    clear: true,
  });
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
  const shapesRef = region?.document?._source?.shapes ?? region?.document?.shapes ?? null;
  const boundsSig = `${worldBounds.x}|${worldBounds.y}|${boundsWorld.width}|${boundsWorld.height}`;

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

  const width = Math.max(1, sceneAllowRT.width | 0);
  const height = Math.max(1, sceneAllowRT.height | 0);
  const resolution = sceneAllowRT.resolution || 1;
  const bad =
    !_tmpSceneSuppressionHardMaskRT ||
    _tmpSceneSuppressionHardMaskRT.destroyed ||
    (_tmpSceneSuppressionHardMaskRT.width | 0) !== width ||
    (_tmpSceneSuppressionHardMaskRT.height | 0) !== height ||
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
  spr.blendMode = PIXI.BLEND_MODES.ERASE;
  spr.alpha = 1;
  spr.roundPixels = false;
  spr.filters = null;
  spr.transform.setFromMatrix(matrix);

  r.render(spr, { renderTexture: rt, clear: false });
  spr.texture = PIXI.Texture.EMPTY;
  return true;
}

/**
 * Render a hard-edged suppression region into a scene allow-mask render texture.
 *
 * The region is first composed into an isolated binary mask, then erased from
 * the scene allow mask. Shape holes remain transparent in the local mask instead
 * of restoring pixels suppressed by another region.
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
  spr.width = Math.max(1, rt.width | 0);
  spr.height = Math.max(1, rt.height | 0);

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
 * @param {number} [opts.resolution]
 * @param {number} [opts.edgeFadePercent=0] - Inward edge fade percentage in [0..1].
 * @param {number} [opts.featherPx=0] - Inward edge feather width in CSS pixels.
 * @returns {PIXI.RenderTexture|null}
 */
export function buildRegionMaskRT(region, { rtPool, resolution, edgeFadePercent = 0, featherPx = 0 } = {}) {
  const r = canvas?.app?.renderer;
  if (!r) return null;

  const { cssW, cssH } = getCssViewportMetrics();
  const VW = Math.max(1, cssW | 0);
  const VH = Math.max(1, cssH | 0);

  const res = resolution ?? safeMaskResolutionForCssArea(VW, VH, 1);

  const rt = rtPool
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

  const gmAlways = !!fxBeh.getFlag?.(packageId, "gmAlwaysVisible");
  if (gmAlways && game.user?.isGM) return true;

  const { mode, latched } = getEventGate(placeable, behaviorType);
  if (mode === "enterExit") return !!latched;
  if (mode === "enter" && !latched) return false;

  const win = getRegionElevationWindow(doc);
  const gateMode = fxBeh.getFlag?.(packageId, "gateMode");

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
    const targets = fxBeh.getFlag?.(packageId, "tokenTargets");
    const ids = Array.isArray(targets) ? targets : targets ? [targets] : [];
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
 * Build a scene-wide allow-mask render texture.
 *
 * Supports two per-region suppression inputs:
 * - `weatherRegions`: hard-edged suppression without customization.
 * - `suppressionRegions`: suppression with optional inward edge fade.
 *
 * The legacy `regions` option is retained as an alias for `weatherRegions`.
 *
 * @param {{ regions?: Region[]|null, weatherRegions?: Array<Region|{ region: Region, preserveObjects?: PIXI.DisplayObject[] }>|null, suppressionRegions?: Array<{ region: Region, edgeFadePercent?: number, preserveObjects?: PIXI.DisplayObject[] }>, reuseRT?: PIXI.RenderTexture|null }} [opts]
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
  const res = safeMaskResolutionForCssArea(cssW, cssH);
  const hardRegionEntries = (Array.isArray(weatherRegions) ? weatherRegions : Array.isArray(regions) ? regions : [])
    .map((entry) => (entry?.region ? entry : { region: entry }))
    .filter((entry) => !!entry?.region)
    .map((entry) => ({ ...entry, edgeFadePercent: 0 }));
  const suppressionEntries = [...hardRegionEntries, ...(Array.isArray(suppressionRegions) ? suppressionRegions : [])];

  let rt = reuseRT ?? null;
  const needsNew =
    !rt || (rt.width | 0) !== (cssW | 0) || (rt.height | 0) !== (cssH | 0) || (rt.resolution || 1) !== res;

  if (needsNew) {
    const oldRT = reuseRT ?? null;
    rt = PIXI.RenderTexture.create({
      width: cssW | 0,
      height: cssH | 0,
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
  const M = snappedStageMatrix();
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
      let renderedSoft = false;
      if (edgeFadePercent > 0) renderedSoft = _renderSceneSuppressionSoftMask(rt, region, M, edgeFadePercent);
      if (!renderedSoft) _renderSceneSuppressionHardRegion(rt, region, M);

      const preserveObjects = Array.isArray(entry?.preserveObjects) ? entry.preserveObjects.filter(Boolean) : [];
      if (!preserveObjects.length) continue;

      _restorePreservedOverlayObjectsIntoSceneAllowMask(rt, region, M, preserveObjects, {
        width: cssW | 0,
        height: cssH | 0,
        resolution: res,
      });
    }
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

  const W = Math.max(1, baseRT.width | 0);
  const H = Math.max(1, baseRT.height | 0);
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
  const rtCssW = baseMaskRT ? Math.max(1, baseMaskRT.width | 0) : Math.max(1, cssW | 0);
  const rtCssH = baseMaskRT ? Math.max(1, baseMaskRT.height | 0) : Math.max(1, cssH | 0);

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
  for (const t of canvas.tokens?.placeables ?? []) {
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
  for (const t of canvas.tokens?.placeables ?? []) {
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
