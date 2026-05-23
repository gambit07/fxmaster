import { getOrderedEnabledEffectRenderRows } from "../common/effect-stack.js";
import { FilterEffectsSceneManager } from "../filter-effects/filter-effects-scene-manager.js";
import { SceneMaskManager } from "../common/base-effects-scene-manager.js";
import { applyRegionBehaviorsToOverheadLevels, compositeGridInFxStack, isEnabled } from "../settings-access.js";
import { logger } from "../logger.js";
import { packageId } from "../constants.js";
import {
  computeRegionGatePass,
  currentWorldMatrix,
  getCanvasLevel,
  getCssViewportMetrics,
  getDocumentLevelsSet,
  getDocumentAssignedLevelIds,
  getRegionBehaviorEdgeFadePercent,
  getRegionBehaviorRuntimeSignature,
  getSelectedSceneLevelIds,
  getSceneLevels as getSceneLevelDocuments,
  getRegionElevationWindow,
  getRegionEffectPlaceablesForCurrentView,
  getRegionPlaceableOrDocumentAdapter,
  getSceneRegionDocumentById,
  getSceneSurfaces,
  regionDocumentCanApplyInCurrentView,
  getTileOcclusionModes,
  regionWorldBounds,
  inferVisibleLevelForDocument,
  getCanvasLiveLevelSurfaceRevealState,
  getCanvasLiveLevelSurfaceState,
  getCanvasPrimaryHoverFadeElevation,
  buildCanvasLiveLevelSurfaceSignature,
  snappedStageMatrix,
  isDocumentOnCurrentCanvasLevel,
  tokenUpperLevelRevealAllowsBelowTokenMask,
  collectBelowTokenMaskTokens,
  resolveDocumentOcclusionElevation,
  safeResolutionForCssArea,
  syncCanvasLiveLevelSurfaceState,
  tileDocumentRestrictsParticles,
  tileDocumentRestrictsFilters,
  repaintTilesMaskInto,
  applyMaskUniformsToFilters,
  buildRegionMaskRT,
  documentIncludedInLevel,
  fxmGetDocumentElevationWindow,
  fxmGetLevelImageCandidates,
  fxmGetLevelImagePaths,
  fxmGetSceneForegroundSourcePath,
  fxmLevelBottom,
  fxmLevelIsAbove,
  fxmLevelTop,
  fxmResolveLevelIdsForComparableSourcePaths,
  fxmCollectComparableSourcePaths,
  fxmReadDocumentSnapshotCompat,
  fxmReadDocumentSnapshotValue,
  fxmDocumentId,
  fxmLinkedPlaceableFromDisplayObject,
  fxmGetPublicHoverFadeState,
  fxmUpdateDisplayObjectWorldTransform,
  fxmDisplayObjectTransformSignature,
  fxmReadDocumentShapes,
} from "../utils.js";

const SUPPRESS_WEATHER = "suppressWeather";
const SUPPRESS_SCENE_PARTICLES = `${packageId}.suppressSceneParticles`;
const SUPPRESS_SCENE_FILTERS = `${packageId}.suppressSceneFilters`;

/**
 * Return whether native weather occlusion filters can be used for compositor stack passes.
 *
 * @returns {boolean}
 */
function canUseNativeWeatherOcclusionStackPass() {
  return Number(globalThis.game?.release?.generation ?? 0) >= 14;
}

/**
 * Return whether a tile currently contributes a live visible surface on the canvas.
 *
 * Native Levels can render upper-level tile surfaces while the tile does not belong to the currently viewed Level. Those surfaces must still participate in tile masking and weather-occlusion logic whenever their live primary mesh is active.
 *
 * @param {Tile|null|undefined} tile
 * @param {PIXI.DisplayObject[]} [primaryMeshes]
 * @returns {boolean}
 */
function tileIsActiveOnCanvasForCompositor(tile, primaryMeshes = null) {
  if (!tile || tile.document?.hidden) return false;
  if (!canvas?.level) return true;
  if (isDocumentOnCurrentCanvasLevel(tile.document ?? null, tile.document?.elevation ?? tile?.elevation ?? Number.NaN))
    return true;

  const meshes =
    primaryMeshes ??
    (typeof canvas?.primary?.tiles?.values === "function"
      ? Array.from(canvas.primary.tiles.values())
      : [tile?.mesh ?? null]);

  for (const mesh of meshes) {
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
 * Return the center point of a token for live scene-mask visibility checks.
 *
 * @param {Token|null|undefined} token
 * @returns {PIXI.Point|{x:number, y:number}|null}
 */
function getTokenCenterPointForCompositor(token) {
  const boundsCenter = token?.bounds?.center ?? null;
  if (Number.isFinite(boundsCenter?.x) && Number.isFinite(boundsCenter?.y)) return boundsCenter;

  const tokenCenter = token?.center ?? null;
  if (Number.isFinite(tokenCenter?.x) && Number.isFinite(tokenCenter?.y)) return tokenCenter;

  return null;
}

/**
 * Return whether the live native scene mask currently includes the token center.
 *
 * @param {Token|null|undefined} token
 * @returns {boolean|null}
 */
function sceneMaskContainsTokenCenterForCompositor(token) {
  const sceneMask = canvas?.masks?.scene ?? null;
  if (!sceneMask || sceneMask.destroyed) return null;

  const point = getTokenCenterPointForCompositor(token);
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
 * Normalize a texture path for stable equality comparisons.
 *
 * @param {string|null|undefined} sourcePath
 * @returns {string}
 */
function normalizeComparableSourcePath(sourcePath) {
  if (typeof sourcePath !== "string") return "";
  const trimmed = sourcePath.trim();
  if (!trimmed) return "";

  const originPattern = new RegExp("^https?:\\/\\/[^/]+", "i");
  const filePattern = new RegExp("^file:\\/\\/", "i");

  try {
    const decoded = decodeURI(trimmed);
    return decoded
      .replace(originPattern, "")
      .replace(filePattern, "")
      .replace(/^\/+/, "")
      .replace(/\?.*$/, "")
      .replace(/#.*$/, "");
  } catch {
    return trimmed
      .replace(originPattern, "")
      .replace(filePattern, "")
      .replace(/^\/+/, "")
      .replace(/\?.*$/, "")
      .replace(/#.*$/, "");
  }
}

/**
 * Recursively collect image or texture source paths from an arbitrary value.
 *
 * @param {*} value
 * @param {Set<string>} output
 * @param {Set<object>} [seen]
 * @returns {void}
 */
function collectComparableSourcePaths(value, output) {
  fxmCollectComparableSourcePaths(value, output);
}

/**
 * Return the configured foreground image path for the active scene or viewed level.
 *
 * @returns {string}
 */
function getActiveForegroundImagePath() {
  return fxmGetSceneForegroundSourcePath(canvas?.scene ?? null);
}

/**
 * Return whether a foreground image is currently configured for the viewed scene state.
 *
 * @returns {boolean}
 */
function hasActiveForegroundImage() {
  return !!getActiveForegroundImagePath();
}

/**
 * Render the ordered FXMaster stack into a single post-scene output texture.
 */
export class GlobalEffectsCompositor {
  /** @type {GlobalEffectsCompositor|undefined} */
  static #instance;

  /**
   * Return the shared compositor singleton.
   *
   * @returns {GlobalEffectsCompositor}
   */
  static get instance() {
    if (!this.#instance) this.#instance = new this();
    return this.#instance;
  }

  constructor() {
    this.layer = null;
    this._baseRT = null;
    this._rtA = null;
    this._rtB = null;
    this._foregroundMaskRT = null;
    this._foregroundVisibleMaskRT = null;
    this._foregroundUpperVisibleRT = null;
    this._regionLocalEnvRT = null;
    this._regionUpperVisibleRT = null;
    this._regionUpperVisibleRTCache = new Map();
    this._levelSegmentMaskRTCache = new Map();
    this._levelBlockerRT = null;
    this._selectedLevelSurfaceRT = null;
    this._selectedLevelForegroundRT = null;
    this._particleSelectedLevelMaskRT = null;
    this._selectedLevelSurfaceScratchRT = null;
    this._rowSourceRT = null;
    this._weatherRestrictTilesParticleRT = null;
    this._weatherRestrictTilesFilterRT = null;
    this._particleMaskScratchRT = null;
    this._surfaceMaskScratchRT = null;
    this._maskIntersectionRT = null;
    this._feedbackCopyRT = null;
    this._surfaceMaskRenderList = null;
    this._surfaceMaskThresholdSprite = null;
    this._sceneFilterSuppressionRegionRT = null;
    this._sceneSuppressionRegionMaskRTCache = new Map();
    this._sceneSuppressionRegionMaskDynamicRTCache = new Map();
    this._sceneSuppressionCombinedMaskRTCache = new Map();
    this._sceneSuppressionCombinedMaskDynamicRTCache = new Map();
    this._sceneSuppressionMaskStats = {
      regionStableHits: 0,
      regionStableMisses: 0,
      regionDynamicHits: 0,
      regionDynamicMisses: 0,
      combinedStableHits: 0,
      combinedStableMisses: 0,
      combinedDynamicHits: 0,
      combinedDynamicMisses: 0,
    };
    this._maskIntersectionSprite = null;
    this._maskIntersectionFilter = null;
    this._displayContainer = null;
    this._displaySprite = null;
    this._gridMeshVisibilityState = null;
    this._blitSprite = null;
    this._filterSprite = null;
    this._filterPassContainer = null;
    this._filterPassSprite = null;
    this._filterPassSceneClipMask = null;
    this._tileRestoreContainer = null;
    this._tileRestoreSprite = null;
    this._tileRestoreMask = null;
    this._foregroundMaskSprite = null;
    this._sceneClipMask = null;
    this._weatherOcclusionFilter = null;
    this._dynamicCoverageSignature = null;
    this._renderFrameSerial = 0;
    this._sceneLevelsFrameSerial = -1;
    this._sceneLevelsFrameValue = null;
    this._sceneLevelByIdFrameSerial = -1;
    this._sceneLevelByIdFrameMap = null;
    this._upperSurfaceObjectsFrameCache = null;
    this._visibleOverlayLevelIdsFrameCache = null;
    this._visibleOverlayLevelsFrameCache = null;
    this._rowAllowedLevelIdsFrameCache = null;
    this._rowFlagsFrameCache = null;
    this._regionGatePassFrameCache = null;
    this._stackRowsFrame = [];
    this._stackRowsIndexFrameCache = new Map();
    this._rowActiveSuppressionRegionsFrameCache = new Map();
    this._regionShapeKeyFrameCache = null;
    this._displayObjectViewportHitFrameCache = null;
    this._worldViewportBoundsFrameSerial = -1;
    this._worldViewportBoundsFrameValue = null;
    this._tileActiveFrameCache = null;
    this._primaryLevelTexturesFrameCache = null;
    this._primaryTileMeshesFrameCache = null;
    this._primaryTileMeshesByTileIdFrameCache = null;
    this._rowVisualBlockerLevelIdsFrameCache = null;
    this._suppressionRegionsFrameCache = null;
    this._directSuppressionFallbackTokenCandidatesFrameCache = null;
    this._visibleSceneLevelIdsFrameSerial = -1;
    this._visibleSceneLevelIdsFrameValue = null;
    this._selectedLevelViewportMatrixKeyFrameSerial = -1;
    this._selectedLevelViewportMatrixKeyFrameValue = null;
    this._surfaceSourcePathsFrameCache = null;
    this._surfaceConfiguredLevelIdsFrameCache = null;
    this._levelConfiguredImagePathsFrameCache = null;
    this._levelForegroundImagePathsFrameCache = null;
    this._protectedLevelImagePathsFrameCache = null;
    this._visibleSurfaceObjectsFrameCache = null;
    this._visibleForegroundSurfaceObjectsFrameCache = null;
    this._visualBlockerSurfaceObjectsFrameCache = null;
    this._selectedLevelCompositeSegmentsFrameCache = null;
    this._foregroundSurfaceCandidatesFrameCache = null;
    this._selectedLevelNonTileCoverageFrameCache = null;
    this._levelDefinedSurfaceFootprintRegionsFrameCache = null;
    this._configuredLevelTextureObjectsFrameCache = null;
    this._hasSelectedLevelParticleRowsFrame = false;
    this._hasSceneFilterRowsFrame = false;
    this._forceGeneratedSceneClipFrame = false;
    this._foregroundMaskFrameSerial = -1;
    this._foregroundMaskFrameTexture = null;
    this._foregroundVisibleMaskFrameSerial = -1;
    this._foregroundVisibleMaskFrameTexture = null;
    this._hasVisibleForegroundCoverageFrameSerial = -1;
    this._hasVisibleForegroundCoverageFrameValue = false;
    this._hasVisibleLevelSurfacesForBelowForegroundFrameSerial = -1;
    this._hasVisibleLevelSurfacesForBelowForegroundFrameValue = false;
    this._levelBlockerFrameSerial = -1;
    this._levelBlockerFrameKey = null;
    this._selectedLevelSurfaceFrameSerial = -1;
    this._selectedLevelSurfaceFrameKey = null;
    this._selectedLevelSurfaceFrameTexture = null;
    this._selectedLevelSurfacePersistentKey = null;
    this._selectedLevelForegroundFrameSerial = -1;
    this._selectedLevelForegroundFrameKey = null;
    this._selectedLevelForegroundFrameTexture = null;
    this._selectedLevelForegroundPersistentKey = null;
    this._particleSelectedLevelMaskFrameSerial = -1;
    this._particleSelectedLevelMaskFrameKey = null;
    this._particleSelectedLevelMaskFrameTexture = null;
    this._particleSelectedLevelMaskPersistentKey = null;
    this._weatherRestrictTilesParticleFrameSerial = -1;
    this._weatherRestrictTilesParticleFrameTexture = null;
    this._weatherRestrictTilesFilterFrameSerial = -1;
    this._weatherRestrictTilesFilterFrameTexture = null;
    this._selectedLevelViewportMatrixKey = null;
    this._selectedLevelViewportMovingFrameSerial = -1;
    this._selectedLevelViewportMovingFrame = false;
    this._levelSurfaceSignatureFrameSerial = -1;
    this._levelSurfaceSignatureFrameValue = null;
    void this.#suppressionRegionAffectsRow;
    void this.#tokenRevealApertureIntersectsSuppressionRegionBounds;
    void this.#surfaceTargetsLevelIds;
    void this.#getSelectedLevelSurfaceMaskTextureForRow;
    void this.#getSelectedLevelForegroundMaskTextureForRow;
    void this.#captureSelectedLevelSurfaceMask;
    void this.#captureSelectedLevelRestoreMask;
    void this.#captureSelectedLevelForegroundMask;
    void this.#withTemporarilyHiddenObjects;
    void this.#captureUpperSurfaceTexture;
    void this.#getHighestLevelForIds;
  }

  /**
   * Attach the compositor to the active canvas layer.
   *
   * @param {CanvasLayer|null} layer
   * @returns {void}
   */
  attachLayer(layer) {
    this.layer = layer ?? null;
    this.#ensureSprites();
    this.#attachDisplayContainer();
    this.#resetOutputSpriteTransform();
  }

  /**
   * Detach the compositor from the active layer and release render textures.
   *
   * @param {CanvasLayer|null} layer
   * @returns {void}
   */
  detachLayer(layer) {
    if (layer && this.layer && layer !== this.layer) return;

    this.#syncCompositedSceneParticleSources([], false);

    try {
      if (this._displaySprite) this._displaySprite.mask = null;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    try {
      this._sceneClipMask?.parent?.removeChild?.(this._sceneClipMask);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    try {
      this._displaySprite?.parent?.removeChild?.(this._displaySprite);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    try {
      this._displayContainer?.parent?.removeChild?.(this._displayContainer);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    this.layer = null;
    this.#restoreLiveGridMeshVisibility();
    this.#destroyRenderTextures();

    try {
      this._weatherOcclusionFilter?.destroy?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    this._weatherOcclusionFilter = null;
    this._dynamicCoverageSignature = null;
    this._sceneLevelsFrameSerial = -1;
    this._sceneLevelsFrameValue = null;
    this._sceneLevelByIdFrameSerial = -1;
    this._sceneLevelByIdFrameMap = null;
    this._upperSurfaceObjectsFrameCache = null;
    this._visibleOverlayLevelIdsFrameCache = null;
    this._visibleOverlayLevelsFrameCache = null;
    this._rowAllowedLevelIdsFrameCache = null;
    this._rowFlagsFrameCache = null;
    this._regionGatePassFrameCache = null;
    this._stackRowsFrame = [];
    this._stackRowsIndexFrameCache = new Map();
    this._rowActiveSuppressionRegionsFrameCache = new Map();
    this._regionShapeKeyFrameCache = null;
    this._displayObjectViewportHitFrameCache = null;
    this._worldViewportBoundsFrameSerial = -1;
    this._worldViewportBoundsFrameValue = null;
    this._tileActiveFrameCache = null;
    this._primaryLevelTexturesFrameCache = null;
    this._primaryTileMeshesFrameCache = null;
    this._primaryTileMeshesByTileIdFrameCache = null;
    this._rowVisualBlockerLevelIdsFrameCache = null;
    this._suppressionRegionsFrameCache = null;
    this._directSuppressionFallbackTokenCandidatesFrameCache = null;
    this._visibleSceneLevelIdsFrameSerial = -1;
    this._visibleSceneLevelIdsFrameValue = null;
    this._selectedLevelViewportMatrixKeyFrameSerial = -1;
    this._selectedLevelViewportMatrixKeyFrameValue = null;
    this._surfaceSourcePathsFrameCache = null;
    this._surfaceConfiguredLevelIdsFrameCache = null;
    this._levelConfiguredImagePathsFrameCache = null;
    this._levelForegroundImagePathsFrameCache = null;
    this._protectedLevelImagePathsFrameCache = null;
    this._visibleSurfaceObjectsFrameCache = null;
    this._visibleForegroundSurfaceObjectsFrameCache = null;
    this._visualBlockerSurfaceObjectsFrameCache = null;
    this._selectedLevelCompositeSegmentsFrameCache = null;
    this._foregroundSurfaceCandidatesFrameCache = null;
    this._selectedLevelNonTileCoverageFrameCache = null;
    this._levelDefinedSurfaceFootprintRegionsFrameCache = null;
    this._configuredLevelTextureObjectsFrameCache = null;
    this._hasSelectedLevelParticleRowsFrame = false;
    this._hasSceneFilterRowsFrame = false;
    this._forceGeneratedSceneClipFrame = false;
    this._foregroundMaskFrameSerial = -1;
    this._foregroundMaskFrameTexture = null;
    this._foregroundVisibleMaskFrameSerial = -1;
    this._foregroundVisibleMaskFrameTexture = null;
    this._hasVisibleForegroundCoverageFrameSerial = -1;
    this._hasVisibleForegroundCoverageFrameValue = false;
    this._hasVisibleLevelSurfacesForBelowForegroundFrameSerial = -1;
    this._hasVisibleLevelSurfacesForBelowForegroundFrameValue = false;
    this._levelBlockerFrameSerial = -1;
    this._levelBlockerFrameKey = null;
    this._selectedLevelSurfaceFrameSerial = -1;
    this._selectedLevelSurfaceFrameKey = null;
    this._selectedLevelSurfaceFrameTexture = null;
    this._selectedLevelSurfacePersistentKey = null;
    this._selectedLevelForegroundFrameSerial = -1;
    this._selectedLevelForegroundFrameKey = null;
    this._selectedLevelForegroundFrameTexture = null;
    this._selectedLevelForegroundPersistentKey = null;
    this._particleSelectedLevelMaskFrameSerial = -1;
    this._particleSelectedLevelMaskFrameKey = null;
    this._particleSelectedLevelMaskFrameTexture = null;
    this._particleSelectedLevelMaskPersistentKey = null;
    this._weatherRestrictTilesParticleFrameSerial = -1;
    this._weatherRestrictTilesParticleFrameTexture = null;
    this._weatherRestrictTilesFilterFrameSerial = -1;
    this._weatherRestrictTilesFilterFrameTexture = null;
    this._selectedLevelViewportMatrixKey = null;
    this._selectedLevelViewportMovingFrameSerial = -1;
    this._selectedLevelViewportMovingFrame = false;
    this._levelSurfaceSignatureFrameSerial = -1;
    this._levelSurfaceSignatureFrameValue = null;
    void this.#suppressionRegionAffectsRow;
    void this.#tokenRevealApertureIntersectsSuppressionRegionBounds;
    void this.#surfaceTargetsLevelIds;
    void this.#getSelectedLevelSurfaceMaskTextureForRow;
    void this.#getSelectedLevelForegroundMaskTextureForRow;
    void this.#captureSelectedLevelSurfaceMask;
    void this.#captureSelectedLevelRestoreMask;
    void this.#captureSelectedLevelForegroundMask;
    void this.#withTemporarilyHiddenObjects;
    void this.#captureUpperSurfaceTexture;
    void this.#getHighestLevelForIds;
  }

  /**
   * Render the current ordered FX stack into the visible output sprite.
   *
   * @returns {void}
   */
  renderFrame() {
    if (!this.layer || !isEnabled() || !canvas?.scene || canvas?.loading || !canvas?.ready) {
      this.#hideOutput();
      return;
    }

    this._regionGatePassFrameCache = new Map();

    const rows = this.#collectRenderableRows(canvas.scene);
    if (!rows.length) {
      this.#hideOutput();
      return;
    }

    const renderer = canvas?.app?.renderer;
    if (!renderer) {
      this.#hideOutput();
      return;
    }

    try {
      this.#syncStageTransforms();
      this.#ensureSprites();
      this.#ensureRenderTextures();
      this._renderFrameSerial = (this._renderFrameSerial || 0) + 1;
      this.#syncSelectedLevelViewportState();
      this._sceneLevelsFrameSerial = -1;
      this._sceneLevelsFrameValue = null;
      this._sceneLevelByIdFrameSerial = -1;
      this._sceneLevelByIdFrameMap = null;
      this._upperSurfaceObjectsFrameCache = new Map();
      this._visibleOverlayLevelIdsFrameCache = new Map();
      this._visibleOverlayLevelsFrameCache = new Map();
      this._rowAllowedLevelIdsFrameCache = new Map();
      this._rowFlagsFrameCache = new Map();
      this._stackRowsFrame = rows;
      this._stackRowsIndexFrameCache = new Map();
      for (let i = 0; i < rows.length; i++) if (rows[i]?.uid) this._stackRowsIndexFrameCache.set(rows[i].uid, i);
      this._rowActiveSuppressionRegionsFrameCache = new Map();
      if (!(this._regionGatePassFrameCache instanceof Map)) this._regionGatePassFrameCache = new Map();
      this._regionShapeKeyFrameCache = new WeakMap();
      this._displayObjectViewportHitFrameCache = new WeakMap();
      this._tileActiveFrameCache = new WeakMap();
      this._primaryLevelTexturesFrameCache = null;
      this._primaryTileMeshesFrameCache = null;
      this._primaryTileMeshesByTileIdFrameCache = null;
      this._rowVisualBlockerLevelIdsFrameCache = new Map();
      this._suppressionRegionsFrameCache = new Map();
      this._directSuppressionFallbackTokenCandidatesFrameCache = null;
      this._visibleSceneLevelIdsFrameSerial = -1;
      this._visibleSceneLevelIdsFrameValue = null;
      this._selectedLevelViewportMatrixKeyFrameSerial = -1;
      this._selectedLevelViewportMatrixKeyFrameValue = null;
      this._surfaceSourcePathsFrameCache = new WeakMap();
      this._surfaceConfiguredLevelIdsFrameCache = new WeakMap();
      this._levelConfiguredImagePathsFrameCache = new Map();
      this._levelForegroundImagePathsFrameCache = new Map();
      this._protectedLevelImagePathsFrameCache = new Map();
      this._visibleSurfaceObjectsFrameCache = new Map();
      this._visibleForegroundSurfaceObjectsFrameCache = new Map();
      this._visualBlockerSurfaceObjectsFrameCache = new Map();
      this._selectedLevelCompositeSegmentsFrameCache = new Map();
      this._foregroundSurfaceCandidatesFrameCache = new Map();
      this._selectedLevelNonTileCoverageFrameCache = new Map();
      this._levelDefinedSurfaceFootprintRegionsFrameCache = new Map();
      this._configuredLevelTextureObjectsFrameCache = new Map();
      this._sceneSuppressionMaskStats = {
        regionStableHits: 0,
        regionStableMisses: 0,
        regionDynamicHits: 0,
        regionDynamicMisses: 0,
        combinedStableHits: 0,
        combinedStableMisses: 0,
        combinedDynamicHits: 0,
        combinedDynamicMisses: 0,
      };
      const frameInfo = this.#analyzeRowsForFrame(rows);
      this._hasSelectedLevelParticleRowsFrame = frameInfo.hasSelectedLevelParticleRows;
      this._hasSceneFilterRowsFrame = frameInfo.hasSceneFilterRows;
      this._forceGeneratedSceneClipFrame =
        !!canvas?.level && this._hasSelectedLevelParticleRowsFrame && this._hasSceneFilterRowsFrame;
      frameInfo.needsOutputSceneMask = rows.some((row) => this.#rowNeedsOutputSceneMask(row));
      this._foregroundMaskFrameSerial = -1;
      this._foregroundMaskFrameTexture = null;
      this._foregroundVisibleMaskFrameSerial = -1;
      this._foregroundVisibleMaskFrameTexture = null;
      this._levelBlockerFrameSerial = -1;
      this._levelBlockerFrameKey = null;
      this._selectedLevelSurfaceFrameSerial = -1;
      this._selectedLevelSurfaceFrameKey = null;
      this._selectedLevelSurfaceFrameTexture = null;
      this._selectedLevelForegroundFrameSerial = -1;
      this._selectedLevelForegroundFrameKey = null;
      this._selectedLevelForegroundFrameTexture = null;
      this._particleSelectedLevelMaskFrameSerial = -1;
      this._particleSelectedLevelMaskFrameKey = null;
      this._particleSelectedLevelMaskFrameTexture = null;
      this._weatherRestrictTilesParticleFrameSerial = -1;
      this._weatherRestrictTilesParticleFrameTexture = null;
      this._weatherRestrictTilesFilterFrameSerial = -1;
      this._weatherRestrictTilesFilterFrameTexture = null;
      this._levelSurfaceSignatureFrameSerial = -1;
      this._levelSurfaceSignatureFrameValue = null;
      this.#attachDisplayContainer();
      if (this.#shouldSyncLevelSurfaceStateForFrame(frameInfo)) {
        syncCanvasLiveLevelSurfaceState();
      }
      this.#syncDynamicSceneState(rows, frameInfo);
      this.#syncCompositedSceneParticleSources(rows, true);

      const useTransparentParticleOnlyPass =
        !this.#gridCompositingEnabled() && this.#canUseTransparentParticleOnlyPass(rows);
      let current = this._rtA;
      let next = this._rtB;
      if (useTransparentParticleOnlyPass) {
        this.#restoreLiveGridMeshVisibility();
        if (!this.#clearRenderTexture(this._rtA)) {
          this.#hideOutput();
          return;
        }
      } else {
        const previousDisplayState = this.#suspendDisplayOutput();
        try {
          if (!this.#captureEnvironment(this._baseRT)) {
            this.#hideOutput();
            return;
          }
          this.#captureGridIntoBaseFrame(this._baseRT);
        } finally {
          this.#restoreDisplayOutput(previousDisplayState);
        }

        if (this.#canUseCapturedBaseAsInitialFrame(rows)) {
          current = this._baseRT;
          next = this._rtA;
        } else {
          this.#blit(this._baseRT, this._rtA, { clear: true });
        }
      }

      const needsOutputSceneMask = frameInfo.needsOutputSceneMask;
      const regionLocalPassCache = new Map();

      for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex--) {
        const row = rows[rowIndex];
        if (this.#rowIsSuppressionOperator(row)) continue;
        let applied = false;
        let outputInCurrent = false;
        const rowScope = this.#getRowScope(row);
        if (!this.#rowLevelSelectionCanRenderInCurrentView(row)) continue;
        const rowUsesSelectedSurfaceMask = this.#rowUsesSelectedLevelSurfaceMask(row);
        const useRegionLevelDrawOrderComposite = this.#rowNeedsRegionLevelDrawOrderComposite(row);
        const restoreLevelBlockers =
          !rowUsesSelectedSurfaceMask && rowScope !== "region" && this.#rowHasLevelLimitedOutput(row);
        const regionParticleCanUseInputForDrawOrderComposite =
          row.kind === "particle" && rowScope === "region" && useRegionLevelDrawOrderComposite;
        const needsRegionCompositeSource =
          useRegionLevelDrawOrderComposite && !regionParticleCanUseInputForDrawOrderComposite && !!this._rowSourceRT;
        const regionLocalPass =
          rowScope === "region" && !useRegionLevelDrawOrderComposite
            ? this.#prepareRegionLevelLocalPass(row, regionLocalPassCache)
            : null;
        const rowOverlayMaskTexture = regionLocalPass?.overlayMaskTexture ?? regionLocalPass?.overlayTexture ?? null;
        const needsRegionOverlayRestoreSource = !!rowOverlayMaskTexture && !!this._rowSourceRT;
        const rowRestoreSource =
          restoreLevelBlockers || needsRegionCompositeSource || needsRegionOverlayRestoreSource
            ? this._rowSourceRT
            : null;
        if (rowRestoreSource) this.#blit(current, rowRestoreSource, { clear: true });
        let selectedSurfaceMaskTexture = null;
        const rowInput = current;
        const rowCompositeInput =
          needsRegionCompositeSource || needsRegionOverlayRestoreSource ? rowRestoreSource : rowInput;
        const useRegionManagedOcclusion = rowScope === "region";
        const rowBaseForRestore = rowCompositeInput ?? current;

        let explicitRowOutput = null;

        if (row.kind === "filter") {
          const filter = this.#resolveFilter(row.uid);
          if (!this.#filterRuntimeCanRender(filter)) continue;

          selectedSurfaceMaskTexture = rowUsesSelectedSurfaceMask
            ? this.#rowHasVisibleSelectedLevelSurfaces(row)
              ? true
              : null
            : null;
          if (rowUsesSelectedSurfaceMask && !selectedSurfaceMaskTexture) continue;

          const wantsBelowTiles = this.#rowWantsBelowTiles(row);
          const wantsBelowForeground = this.#rowWantsBelowForeground(row);
          const wantsForegroundImageMask =
            !useRegionLevelDrawOrderComposite &&
            !selectedSurfaceMaskTexture &&
            wantsBelowForeground &&
            this.#hasVisibleForegroundCoverage();
          const useCompositorSceneFilterSuppression = this.#rowUsesCompositorSceneFilterSuppression(row);
          const useDirectSceneFilterClip =
            this.#rowUsesDirectSceneFilterClip(row) || useCompositorSceneFilterSuppression;
          const weatherMaskTexture = this.#getRestrictWeatherTilesMaskTexture("filters");
          const useNativeWeatherOcclusion =
            canUseNativeWeatherOcclusionStackPass() &&
            (!wantsBelowTiles || wantsBelowForeground) &&
            (!useRegionManagedOcclusion || wantsBelowForeground) &&
            !weatherMaskTexture;
          const cleanupStackMask = this.#prepareSceneFilterStackMaskForRow(row, filter);
          const cleanupFilterPass = this.#prepareFilterForStackPass(filter, {
            forceSoftMask: wantsBelowTiles && !useDirectSceneFilterClip,
            disableMask: useDirectSceneFilterClip || useCompositorSceneFilterSuppression,
          });

          try {
            if (useDirectSceneFilterClip) this.#applyDirectSceneFilterPass(filter, rowInput, next);
            else this.#applyFilterPass(filter, rowInput, next);
            applied = true;
          } finally {
            cleanupFilterPass?.();
            cleanupStackMask?.();
          }

          if (applied && selectedSurfaceMaskTexture) {
            if (useNativeWeatherOcclusion) {
              this.#blit(rowInput, this._baseRT, { clear: true });
              const weatherApplied = this.#overlayTextureWithWeatherOcclusion(next, this._baseRT, {
                clipToScene: useDirectSceneFilterClip,
                occlusionElevation: this.#resolveOcclusionElevationForRow(row),
              });
              if (!weatherApplied) this.#blit(next, this._baseRT, { clear: true });
            } else {
              this.#blit(next, this._baseRT, { clear: true });
            }
            this.#compositeSelectedLevelRowOutput(row, this._baseRT, rowInput, next, {
              belowForeground: wantsBelowForeground,
            });
            if (useCompositorSceneFilterSuppression) {
              this.#applyCompositorSceneFilterSuppression(row, rowInput, next);
            }
            const weatherMaskTexture = this.#getRestrictWeatherTilesMaskTexture("filters");
            if (weatherMaskTexture) this.#eraseTextureFromRenderTexture(weatherMaskTexture, next);
          } else if (applied && wantsForegroundImageMask && !useRegionLevelDrawOrderComposite) {
            this.#blit(next, this._baseRT, { clear: true });
            this.#blit(rowInput, next, { clear: true });

            if (useNativeWeatherOcclusion) {
              this.#overlayTextureWithWeatherOcclusion(this._baseRT, next, {
                clipToScene: useDirectSceneFilterClip,
                occlusionElevation: this.#resolveOcclusionElevationForRow(row),
              });
            } else {
              this.#blit(this._baseRT, next, { clear: false });
            }

            if (canvas?.level && this.#hasVisibleLevelSurfacesForBelowForeground()) {
              this.#blit(next, this._baseRT, { clear: true });
              this.#compositeVisibleLevelBelowForegroundRowOutput(this._baseRT, rowBaseForRestore, next);
            } else {
              this.#restoreFromTextureMask(this.#getForegroundVisibleMaskTexture(), rowBaseForRestore, next);
            }
            const weatherMaskTexture = this.#getRestrictWeatherTilesMaskTexture("filters");
            if (weatherMaskTexture) this.#eraseTextureFromRenderTexture(weatherMaskTexture, next);
          } else if (applied && useNativeWeatherOcclusion) {
            const weatherMaskTexture = this.#getRestrictWeatherTilesMaskTexture("filters");

            outputInCurrent = this.#overlayTextureWithWeatherOcclusion(next, current, {
              clipToScene: useDirectSceneFilterClip,
              occlusionElevation: this.#resolveOcclusionElevationForRow(row),
            });

            if (weatherMaskTexture) {
              /**
               * Erasing the FX contribution avoids drawing stale captured roof pixels over V14 hover-transparent Restricts Weather tiles.
               */
              this.#eraseTextureFromRenderTexture(weatherMaskTexture, outputInCurrent ? current : next);
            }
          } else if (applied && weatherMaskTexture) {
            this.#eraseTextureFromRenderTexture(weatherMaskTexture, next);
          }
        } else {
          const runtime = this.#resolveParticleRuntime(row.uid);
          if (!this.#particleRuntimeCanRender(runtime)) continue;

          let selectedParticleMaskOverride = null;
          if (rowUsesSelectedSurfaceMask) {
            selectedParticleMaskOverride = this.#rowCanUseParticleSelectedLevelMaskOverride(row)
              ? this.#getParticleSelectedLevelMaskTextureForRow(row)
              : null;
            selectedSurfaceMaskTexture =
              selectedParticleMaskOverride ?? (this.#rowHasVisibleSelectedLevelSurfaces(row) ? true : null);
          } else {
            selectedSurfaceMaskTexture = null;
          }
          if (rowUsesSelectedSurfaceMask && !selectedSurfaceMaskTexture) continue;

          const particleBase = rowInput ?? current;
          const useParticleTileRestore = this.#rowUsesParticleTileRestore(row);
          const wantsBelowForeground = this.#rowWantsBelowForeground(row);
          const wantsForegroundImageMask =
            !useRegionLevelDrawOrderComposite &&
            !selectedSurfaceMaskTexture &&
            wantsBelowForeground &&
            this.#hasVisibleForegroundCoverage();
          const useCompositorSceneParticleSuppression = this.#rowUsesCompositorSceneParticleSuppression(row);
          const weatherMaskTexture = this.#getRestrictWeatherTilesMaskTexture("particles");
          const useNativeWeatherOcclusion =
            canUseNativeWeatherOcclusionStackPass() &&
            (!useRegionManagedOcclusion || wantsBelowForeground) &&
            !weatherMaskTexture;
          const useTransparentSelectedParticleContribution = this.#canUseTransparentSelectedParticleContribution(row, {
            selectedParticleMaskOverride,
            weatherMaskTexture,
            wantsBelowForeground,
            useParticleTileRestore,
          });
          const useTransparentRegionLevelParticleContribution = this.#canUseTransparentRegionLevelParticleContribution(
            row,
            {
              useRegionLevelDrawOrderComposite,
              useParticleTileRestore,
              weatherMaskTexture,
            },
          );
          const needsIsolatedParticleOutput = !!selectedSurfaceMaskTexture || !!weatherMaskTexture;
          const useScratchRegionParticleComposite =
            useTransparentRegionLevelParticleContribution &&
            this._particleMaskScratchRT &&
            CONFIG?.fxmaster?.overheadPerformance?.regionParticleScratchComposite !== false;
          const particleRowOutput = useScratchRegionParticleComposite
            ? this._particleMaskScratchRT
            : useTransparentRegionLevelParticleContribution
            ? next
            : (needsIsolatedParticleOutput || useTransparentSelectedParticleContribution) && this._particleMaskScratchRT
            ? this._particleMaskScratchRT
            : next;

          if (useTransparentSelectedParticleContribution) {
            this.#blit(particleBase, next, { clear: true });
            if (!this.#clearRenderTexture(particleRowOutput)) continue;
          } else if (useTransparentRegionLevelParticleContribution) {
            if (!this.#clearRenderTexture(particleRowOutput)) continue;
          } else {
            this.#blit(particleBase, particleRowOutput, { clear: true });
          }

          const stackSceneParticleMaskOverride = this.#getSceneParticleStackMaskOverride(row, {
            selectedMaskTexture: selectedParticleMaskOverride,
            useCompositorSuppression: useCompositorSceneParticleSuppression,
          });

          applied =
            canvas.particleeffects?.renderStackParticle?.(row.uid, particleRowOutput, {
              clear: false,
              respectBelowTilesMask: !useParticleTileRestore,
              respectNativeOcclusion: useNativeWeatherOcclusion,
              maskTextureOverride: selectedParticleMaskOverride ?? stackSceneParticleMaskOverride,
            }) ?? false;
          if (applied) explicitRowOutput = particleRowOutput;

          if (applied && useTransparentSelectedParticleContribution) {
            this.#blit(particleRowOutput, next, { clear: false });
            this.#restoreUnselectedLevelsAboveSelectedLevelOutput(
              this.#getRowAllowedLevelIds(row),
              particleBase,
              next,
              {
                includeTiles: this.#rowIncludesTileSurfacesInLevelMasks(row),
              },
            );
          } else if (applied && needsIsolatedParticleOutput) {
            if (weatherMaskTexture) this.#eraseTextureFromRenderTexture(weatherMaskTexture, particleRowOutput);
            if (selectedSurfaceMaskTexture) {
              this.#compositeSelectedLevelRowOutput(row, particleRowOutput, particleBase, next, {
                belowForeground: wantsBelowForeground,
                selectedMaskTexture: selectedParticleMaskOverride,
              });
            } else {
              this.#blit(particleBase, next, { clear: true });
              this.#blit(particleRowOutput, next, { clear: false });
            }
          }

          if (applied && useCompositorSceneParticleSuppression) {
            this.#applyCompositorSceneParticleSuppression(row, particleBase, outputInCurrent ? current : next);
          }

          if (applied && useParticleTileRestore) {
            this.#restoreTilesFromTexture(row.kind, particleBase, next);
          }

          if (applied && wantsForegroundImageMask && !useRegionLevelDrawOrderComposite) {
            if (canvas?.level && this.#hasVisibleLevelSurfacesForBelowForeground()) {
              this.#blit(next, this._baseRT, { clear: true });
              this.#compositeVisibleLevelBelowForegroundRowOutput(this._baseRT, particleBase, next);
            } else {
              this.#restoreFromTextureMask(this.#getForegroundVisibleMaskTexture(), particleBase, next);
            }
          }
        }

        let regionLevelCompositeApplied = false;
        if (applied && useRegionLevelDrawOrderComposite && rowCompositeInput) {
          const rowOutput = explicitRowOutput ?? (outputInCurrent ? current : next);
          const compositeTarget = outputInCurrent ? next : rowOutput === next ? this._baseRT : next;
          if (compositeTarget) {
            regionLevelCompositeApplied = this.#compositeRegionLevelRowOutput(
              row,
              rowOutput,
              rowCompositeInput,
              compositeTarget,
              {
                belowForeground: this.#rowWantsBelowForeground(row),
              },
            );
            if (regionLevelCompositeApplied) {
              if (outputInCurrent) {
                outputInCurrent = false;
              } else if (compositeTarget !== next) {
                this.#blit(compositeTarget, next, { clear: true });
              }
            } else if (row.kind === "particle") {
              /**
               * Region particles are rendered as independent sprites. If a Level-constrained Region row cannot capture an assigned-Level surface mask this frame, preserve the input instead of allowing unconstrained particles to leak onto higher overlays.
               */
              this.#blit(rowCompositeInput, next, { clear: true });
            }
          }
        }

        if (applied && rowOverlayMaskTexture && !regionLevelCompositeApplied) {
          const rowOutput = outputInCurrent ? current : next;
          this.#restoreFromTextureMask(rowOverlayMaskTexture, rowBaseForRestore, rowOutput);
        }

        if (applied && restoreLevelBlockers && !rowOverlayMaskTexture) {
          const rowOutput = outputInCurrent ? current : next;
          this.#restoreRowLevelBlockers(row, rowRestoreSource ?? current, rowOutput);
        }

        if (!applied) continue;

        if (!outputInCurrent) {
          const swap = current;
          current = next;
          next = swap;
        }
      }

      this.#pruneRegionUpperVisibleRTCache(regionLocalPassCache);
      this.#pruneLevelSegmentMaskRTCache();
      this.#pruneSceneSuppressionMaskRTCaches();
      this.#present(current, { maskOutput: needsOutputSceneMask });
    } catch (err) {
      logger.debug("FXMaster:", err);
      this.#hideOutput();
    }
  }

  /**
   * Force the live stage transform chain to current world state before the compositor captures the environment or renders attached FX subtrees into off-screen textures.
   *
   * FX rows are rendered while still attached to the canvas graph. Updating only the subtree root can leave ancestor world transforms one pan-step behind, which shows up most clearly on plain scene particles as a moving hard edge at the scene bounds.
   *
   * @returns {void}
   */
  #syncStageTransforms() {
    const stage = canvas?.stage ?? null;
    if (!stage) return;

    if (!fxmUpdateDisplayObjectWorldTransform(stage)) {
      try {
        stage.updateTransform?.();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
  }

  /**
   * Return whether the captured environment frame can be used as the initial stack input.
   *
   * @param {Array<object>} rows
   * @returns {boolean}
   */
  #canUseCapturedBaseAsInitialFrame(rows) {
    if (CONFIG?.fxmaster?.overheadPerformance?.skipInitialStackBlitForSimpleHiDpiFrames === false) return false;
    const { resolution } = this.#getViewportMetrics();
    if (!(Number(resolution) > 1)) return false;
    if (!this.#canBindRenderTexture(this._baseRT) || !this.#canBindRenderTexture(this._rtA)) return false;

    let renderableRows = 0;
    for (const row of rows ?? []) {
      if (!row || this.#rowIsSuppressionOperator(row)) continue;
      if (row.kind !== "filter" && row.kind !== "particle") return false;
      if (this.#getRowScope(row) !== "scene") return false;
      if (this.#rowUsesSelectedLevelSurfaceMask(row)) return false;
      if (this.#rowNeedsRegionLevelDrawOrderComposite(row)) return false;
      if (this.#rowWantsBelowForeground(row)) return false;
      if (this.#rowHasLevelLimitedOutput(row)) return false;
      renderableRows += 1;
    }

    return renderableRows > 0;
  }

  /**
   * Resolve a live filter runtime by stack uid.
   *
   * @param {string} uid
   * @returns {PIXI.Filter|null}
   */
  #resolveFilter(uid) {
    return (
      FilterEffectsSceneManager.instance.getStackFilter(uid) ?? canvas?.filtereffects?.getStackFilter?.(uid) ?? null
    );
  }

  /**
   * Return whether a filter runtime is currently allowed to contribute to the stack pass.
   *
   * Region elevation/POV gates disable their live filter instances. The stack compositor renders from the stored stack rows, so it must explicitly honor that live disabled state instead of re-applying the filter from the row alone.
   *
   * @param {PIXI.Filter|null|undefined} filter
   * @returns {boolean}
   */
  #filterRuntimeCanRender(filter) {
    if (!filter || filter.destroyed) return false;
    return filter.enabled !== false;
  }

  /**
   * Return whether a particle runtime is currently allowed to contribute to the stack pass.
   *
   * Scene-particle source slots can be render-suppressed between compositor frames, so renderable/visible state is only treated as authoritative for region runtimes. Region elevation/POV gates hide the region container and disable the effect instance, both of which must suppress compositor rendering.
   *
   * @param {object|null|undefined} runtime
   * @returns {boolean}
   */
  #particleRuntimeCanRender(runtime) {
    if (!runtime) return false;

    const fx = runtime?.fx ?? null;
    if (fx?.destroyed) return false;

    const isRegionRuntime = !!runtime?.regionId;
    if (!isRegionRuntime) return true;

    if (fx && "enabled" in fx && fx.enabled === false) return false;

    const container = runtime?.container ?? null;
    const slot = runtime?.slot ?? null;
    const compositorSuppressed = !!(
      container?.__fxmCompositorSourceSuppressed || slot?.__fxmCompositorSourceSuppressed
    );
    if (container?.destroyed || slot?.destroyed) return false;
    if (container?.visible === false || slot?.visible === false) return false;
    if (!compositorSuppressed && (container?.renderable === false || slot?.renderable === false)) return false;

    return true;
  }

  /**
   * Return whether a region stack row passes the current token/elevation gate.
   *
   * @param {object|null|undefined} row
   * @returns {boolean}
   */
  #rowPassesRegionGate(row) {
    if (this.#getRowScope(row) !== "region") return true;

    const placeable = this.#getRegionPlaceableForRow(row);
    if (!placeable) return false;
    const doc = placeable?.document ?? this.#getRegionDocumentForRow(row);
    if (doc && !regionDocumentCanApplyInCurrentView(doc, doc?.parent ?? canvas?.scene ?? null)) return false;

    const behaviorType =
      row?.kind === "particle"
        ? `${packageId}.particleEffectsRegion`
        : row?.kind === "filter"
        ? `${packageId}.filterEffectsRegion`
        : null;
    if (!behaviorType) return true;

    return this.#computeRegionGatePassForFrame(placeable, behaviorType);
  }

  /**
   * Return a cached token/elevation gate decision for one Region behavior type during this compositor frame.
   *
   * @param {PlaceableObject|null|undefined} region
   * @param {string|null|undefined} behaviorType
   * @returns {boolean}
   */
  #computeRegionGatePassForFrame(region, behaviorType) {
    if (!region || !behaviorType) return true;

    const doc = region?.document ?? region ?? null;
    const regionId = String(doc?.uuid ?? doc?.id ?? region?.id ?? "");
    if (!regionId) {
      try {
        return computeRegionGatePass(region, { behaviorType }) !== false;
      } catch (err) {
        logger.debug("FXMaster:", err);
        return true;
      }
    }

    const cacheKey = `${regionId}:${behaviorType}`;
    const cache = this._regionGatePassFrameCache;
    if (cache?.has(cacheKey)) return cache.get(cacheKey) === true;

    let passes = true;
    try {
      passes = computeRegionGatePass(region, { behaviorType }) !== false;
    } catch (err) {
      logger.debug("FXMaster:", err);
      passes = true;
    }

    cache?.set(cacheKey, passes);
    return passes;
  }

  /**
   * Return whether a stored stack row has a live runtime that should render this frame.
   *
   * @param {object|null|undefined} row
   * @returns {boolean}
   */
  #rowHasRenderableRuntime(row) {
    if (!row?.uid) return false;
    if (this.#rowIsSuppressionOperator(row)) return true;
    if (!this.#rowPassesRegionGate(row)) return false;

    if (row.kind === "filter") return this.#filterRuntimeCanRender(this.#resolveFilter(row.uid));
    if (row.kind === "particle") return this.#particleRuntimeCanRender(this.#resolveParticleRuntime(row.uid));
    return true;
  }

  /**
   * Coerce a stored option value into a strict boolean.
   *
   * @param {unknown} value
   * @returns {boolean}
   */
  #resolveBooleanOption(value) {
    if (value === true) return true;
    if (value && typeof value === "object" && "value" in value) return !!value.value;
    return !!value;
  }

  /**
   * Return whether a rendered stack row requests below-tiles composition.
   *
   * @param {{ kind?: string, uid?: string }|null|undefined} row
   * @returns {boolean}
   */
  #rowWantsBelowTiles(row) {
    if (!row?.uid) return false;

    const cacheKey = `belowTiles:${row.kind ?? "kind"}:${row.uid}`;
    const frameCache = this._rowFlagsFrameCache;
    if (frameCache?.has(cacheKey)) return frameCache.get(cacheKey) === true;
    const remember = (value) => {
      const resolved = value === true;
      frameCache?.set(cacheKey, resolved);
      return resolved;
    };

    if (row.kind === "filter") {
      const filter = this.#resolveFilter(row.uid);
      return remember(this.#resolveBooleanOption(filter?.__fxmBelowTiles ?? filter?.options?.belowTiles));
    }

    const runtime = this.#resolveParticleRuntime(row.uid);
    return remember(
      this.#resolveBooleanOption(
        runtime?.belowTiles ?? runtime?.fx?.__fxmBelowTiles ?? runtime?.fx?.options?.belowTiles,
      ),
    );
  }

  /**
   * Return whether a rendered stack row requests below-tokens composition.
   *
   * @param {{ kind?: string, uid?: string }|null|undefined} row
   * @returns {boolean}
   */
  #rowWantsBelowTokens(row) {
    if (!row?.uid) return false;

    const cacheKey = `belowTokens:${row.kind ?? "kind"}:${row.uid}`;
    const frameCache = this._rowFlagsFrameCache;
    if (frameCache?.has(cacheKey)) return frameCache.get(cacheKey) === true;
    const remember = (value) => {
      const resolved = value === true;
      frameCache?.set(cacheKey, resolved);
      return resolved;
    };

    if (row.kind === "filter") {
      const filter = this.#resolveFilter(row.uid);
      return remember(this.#filterWantsBelowTokens(filter));
    }

    const runtime = this.#resolveParticleRuntime(row.uid);
    return remember(
      this.#resolveBooleanOption(
        runtime?.belowTokens ?? runtime?.fx?.__fxmBelowTokens ?? runtime?.fx?.options?.belowTokens,
      ),
    );
  }

  /**
   * Return whether a rendered stack row requests below-foreground composition.
   *
   * @param {{ kind?: string, uid?: string }|null|undefined} row
   * @returns {boolean}
   */
  #rowWantsBelowForeground(row) {
    if (!row?.uid) return false;

    const cacheKey = `belowForeground:${row.kind ?? "kind"}:${row.uid}`;
    const frameCache = this._rowFlagsFrameCache;
    if (frameCache?.has(cacheKey)) return frameCache.get(cacheKey) === true;
    const remember = (value) => {
      const resolved = value === true;
      frameCache?.set(cacheKey, resolved);
      return resolved;
    };

    if (row.kind === "filter") {
      const filter = this.#resolveFilter(row.uid);
      return remember(this.#resolveBooleanOption(filter?.__fxmBelowForeground ?? filter?.options?.belowForeground));
    }

    const runtime = this.#resolveParticleRuntime(row.uid);
    return remember(
      this.#resolveBooleanOption(
        runtime?.belowForeground ?? runtime?.fx?.__fxmBelowForeground ?? runtime?.fx?.options?.belowForeground,
      ),
    );
  }

  /**
   * Return whether the current visible scene stack has foreground coverage that can protect a Below Foreground row.
   *
   * Native V14 Levels can show foreground surfaces from overlays/underlays that are not the currently viewed Level. Checking only the active scene foreground causes all-level Below Foreground rows to ignore those visible Level foregrounds.
   *
   * @returns {boolean}
   */
  #hasVisibleForegroundCoverage() {
    if (this._hasVisibleForegroundCoverageFrameSerial === this._renderFrameSerial) {
      return this._hasVisibleForegroundCoverageFrameValue === true;
    }

    const remember = (value) => {
      const resolved = value === true;
      this._hasVisibleForegroundCoverageFrameSerial = this._renderFrameSerial;
      this._hasVisibleForegroundCoverageFrameValue = resolved;
      return resolved;
    };

    if (!canvas?.level) return remember(hasActiveForegroundImage());

    const visibleLevelIds = this.#getVisibleSceneLevelIdsInDrawOrder();
    if (!visibleLevelIds.length) return remember(hasActiveForegroundImage());

    for (const levelId of visibleLevelIds) {
      if (this.#getConfiguredLevelImageSources(levelId, { foregroundOnly: true }).length) return remember(true);
    }

    return remember(
      this.#collectVisibleForegroundSurfaceObjectsForLevelIds(new Set(visibleLevelIds)).length > 0 ||
        hasActiveForegroundImage(),
    );
  }

  /**
   * Return whether active suppression regions exist for a mask kind during the current compositor frame.
   *
   * @param {"particles"|"filters"} kind
   * @returns {boolean}
   */
  #hasSuppressionRegionsForFrame(kind) {
    const normalizedKind = kind === "filters" ? "filters" : "particles";
    const cache = this._suppressionRegionsFrameCache;
    if (cache?.has(normalizedKind)) return cache.get(normalizedKind) === true;

    let value = false;
    try {
      value = SceneMaskManager.instance.hasSuppressionRegions?.(normalizedKind) === true;
    } catch (err) {
      logger.debug("FXMaster:", err);
      value = true;
    }

    cache?.set(normalizedKind, value);
    return value;
  }

  /**
   * Return a cached world-space bounding box for the current viewport.
   *
   * Suppression-region fast paths only need the heavy shared scene-mask route when an active suppression region can affect pixels visible in this frame. This lets unrelated off-screen suppression regions avoid invalidating direct scene filter / selected-Level particle paths during steady-state renders.
   *
   * @returns {{minX:number,minY:number,maxX:number,maxY:number}|null}
   */
  #getWorldViewportBoundsForFrame() {
    if (this._worldViewportBoundsFrameSerial === this._renderFrameSerial) {
      return this._worldViewportBoundsFrameValue ?? null;
    }

    let value = null;
    try {
      const { width, height } = this.#getViewportMetrics();
      const matrix = this.#currentLiveStageMatrix();
      const inverse = matrix?.clone
        ? matrix.clone()
        : new PIXI.Matrix(
            matrix?.a ?? 1,
            matrix?.b ?? 0,
            matrix?.c ?? 0,
            matrix?.d ?? 1,
            matrix?.tx ?? 0,
            matrix?.ty ?? 0,
          );
      inverse.invert();
      const points = [
        inverse.apply(new PIXI.Point(0, 0), new PIXI.Point()),
        inverse.apply(new PIXI.Point(width, 0), new PIXI.Point()),
        inverse.apply(new PIXI.Point(0, height), new PIXI.Point()),
        inverse.apply(new PIXI.Point(width, height), new PIXI.Point()),
      ];
      const xs = points.map((p) => Number(p?.x)).filter(Number.isFinite);
      const ys = points.map((p) => Number(p?.y)).filter(Number.isFinite);
      if (xs.length && ys.length) {
        value = {
          minX: Math.min(...xs),
          minY: Math.min(...ys),
          maxX: Math.max(...xs),
          maxY: Math.max(...ys),
        };
      }
    } catch (err) {
      logger.debug("FXMaster:", err);
      value = null;
    }

    this._worldViewportBoundsFrameSerial = this._renderFrameSerial;
    this._worldViewportBoundsFrameValue = value;
    return value;
  }

  /**
   * Return whether a world-space Region bounds intersects the current viewport.
   *
   * @param {PlaceableObject|null|undefined} region
   * @returns {boolean}
   */
  #suppressionRegionIntersectsCurrentViewport(region) {
    const viewport = this.#getWorldViewportBoundsForFrame();
    if (!viewport) return true;

    let bounds = null;
    try {
      bounds = regionWorldBounds(region);
    } catch (err) {
      logger.debug("FXMaster:", err);
      bounds = null;
    }
    if (!bounds) return true;

    const minX = Number(bounds.minX ?? bounds.x ?? Number.NaN);
    const minY = Number(bounds.minY ?? bounds.y ?? Number.NaN);
    const maxX = Number(
      bounds.maxX ??
        (Number.isFinite(bounds.x) && Number.isFinite(bounds.width) ? bounds.x + bounds.width : Number.NaN),
    );
    const maxY = Number(
      bounds.maxY ??
        (Number.isFinite(bounds.y) && Number.isFinite(bounds.height) ? bounds.y + bounds.height : Number.NaN),
    );
    if (![minX, minY, maxX, maxY].every(Number.isFinite)) return true;

    return maxX >= viewport.minX && minX <= viewport.maxX && maxY >= viewport.minY && minY <= viewport.maxY;
  }

  /**
   * Return whether a token/tile placeable intersects the current world-space viewport.
   *
   * Dynamic below-object coverage is rendered into the viewport only. Including far off-screen tokens or tiles in the dirty signature can force unnecessary shared mask repaints when unrelated actors or overhead tiles update elsewhere on a large map.
   *
   * @param {PlaceableObject|null|undefined} placeable
   * @param {number} [padding=0]
   * @returns {boolean}
   */
  #placeableIntersectsWorldViewport(placeable, padding = 0) {
    if (!placeable || placeable.destroyed) return false;
    const viewport = this.#getWorldViewportBoundsForFrame();
    if (!viewport) return true;

    const pad = Math.max(0, Number(padding) || 0);
    const bounds = placeable?.bounds ?? null;
    const x = Number(bounds?.x ?? placeable?.x ?? placeable?.document?.x ?? Number.NaN);
    const y = Number(bounds?.y ?? placeable?.y ?? placeable?.document?.y ?? Number.NaN);
    const width = Number(
      bounds?.width ??
        placeable?.w ??
        placeable?.width ??
        placeable?.document?.width ??
        placeable?.texture?.width ??
        Number.NaN,
    );
    const height = Number(
      bounds?.height ??
        placeable?.h ??
        placeable?.height ??
        placeable?.document?.height ??
        placeable?.texture?.height ??
        Number.NaN,
    );

    if (![x, y, width, height].every(Number.isFinite)) return true;
    const minX = x - pad;
    const minY = y - pad;
    const maxX = x + Math.max(0, width) + pad;
    const maxY = y + Math.max(0, height) + pad;

    return maxX >= viewport.minX && minX <= viewport.maxX && maxY >= viewport.minY && minY <= viewport.maxY;
  }

  /**
   * Return whether a suppression behavior type is active for the Region.
   *
   * @param {PlaceableObject|null|undefined} region
   * @param {string} behaviorType
   * @returns {boolean}
   */
  #suppressionBehaviorPassesGate(region, behaviorType) {
    const behaviors = Array.from(region?.document?.behaviors ?? []).filter(
      (behavior) => behavior && !behavior.disabled && behavior.type === behaviorType,
    );
    if (!behaviors.length) return false;

    return this.#computeRegionGatePassForFrame(region, behaviorType);
  }

  /**
   * Return whether a Region has active suppression for a specific compositor kind.
   *
   * @param {PlaceableObject|null|undefined} region
   * @param {"particles"|"filters"} kind
   * @returns {boolean}
   */
  #suppressionRegionPassesKindGate(region, kind) {
    if (!region?.document) return false;
    const specificType = kind === "filters" ? SUPPRESS_SCENE_FILTERS : SUPPRESS_SCENE_PARTICLES;
    return (
      this.#suppressionBehaviorPassesGate(region, specificType) ||
      this.#suppressionBehaviorPassesGate(region, SUPPRESS_WEATHER)
    );
  }

  /**
   * Return whether a row is a non-rendering scene-suppression stack operator.
   *
   * @param {object|null|undefined} row
   * @returns {boolean}
   */
  #rowIsSuppressionOperator(row) {
    return row?.kind === "suppression";
  }

  /**
   * Return whether a suppression operator can affect the requested scene-effect kind.
   *
   * @param {object|null|undefined} operatorRow
   * @param {"particles"|"filters"} kind
   * @returns {boolean}
   */
  #suppressionOperatorMatchesKind(operatorRow, kind) {
    if (!this.#rowIsSuppressionOperator(operatorRow)) return false;
    const suppressionKind = String(operatorRow?.suppressionKind ?? "");
    if (suppressionKind === "all") return true;
    if (kind === "filters") return suppressionKind === "filters";
    return suppressionKind === "particles";
  }

  /**
   * Return a live Region placeable or adapter for a suppression operator row.
   *
   * @param {object|null|undefined} operatorRow
   * @returns {PlaceableObject|{id:string, document: foundry.documents.Region, _fxmDocumentRegionAdapter: true}|null}
   */
  #getSuppressionOperatorRegion(operatorRow) {
    return this.#getRegionPlaceableForRow(operatorRow);
  }

  /**
   * Return whether a suppression operator passes Region view and behavior gates.
   *
   * @param {object|null|undefined} operatorRow
   * @param {PlaceableObject|null|undefined} region
   * @returns {boolean}
   */
  #suppressionOperatorPassesGate(operatorRow, region) {
    const doc = region?.document ?? this.#getRegionDocumentForRow(operatorRow) ?? null;
    if (!doc) return false;
    if (!regionDocumentCanApplyInCurrentView(doc, doc?.parent ?? canvas?.scene ?? null)) return false;

    const behaviorType = String(operatorRow?.behaviorType ?? "");
    if (!behaviorType) return false;

    return this.#computeRegionGatePassForFrame(region, behaviorType);
  }

  /**
   * Return enabled suppression operators above a scene row in top-to-bottom stack order.
   *
   * @param {object|null|undefined} row
   * @param {"particles"|"filters"} kind
   * @returns {Array<{row: object, region: PlaceableObject|object}>}
   */
  #activeSuppressionOperatorsForRow(row, kind) {
    if (!row?.uid || this.#getRowScope(row) !== "scene") return [];
    const normalizedKind = kind === "filters" ? "filters" : "particles";
    const rowIndex = this._stackRowsIndexFrameCache?.get(row.uid);
    if (!Number.isInteger(rowIndex) || rowIndex <= 0) return [];

    const cacheKey = `${row.uid}:${normalizedKind}:${rowIndex}`;
    const cache = this._rowActiveSuppressionRegionsFrameCache;
    if (cache?.has(cacheKey)) return cache.get(cacheKey) ?? [];

    const operators = [];
    const rows = Array.isArray(this._stackRowsFrame) ? this._stackRowsFrame : [];
    const seen = new Set();
    for (let i = 0; i < rowIndex; i++) {
      const operatorRow = rows[i];
      if (!this.#suppressionOperatorMatchesKind(operatorRow, normalizedKind)) continue;
      const region = this.#getSuppressionOperatorRegion(operatorRow);
      if (!region) continue;
      if (!this.#suppressionOperatorPassesGate(operatorRow, region)) continue;
      if (!this.#suppressionRegionIntersectsCurrentViewport(region)) continue;
      if (!this.#suppressionRegionLevelOverlapsRow(region, row)) continue;
      const key = `${operatorRow.uid}:${region?.document?.id ?? region?.id ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      operators.push({ row: operatorRow, region });
    }

    cache?.set(cacheKey, operators);
    return operators;
  }

  /**
   * Return whether a stack row has at least one active suppression operator above it.
   *
   * @param {object|null|undefined} row
   * @param {"particles"|"filters"} kind
   * @returns {boolean}
   */
  #rowHasActiveSuppressionOperators(row, kind) {
    return this.#activeSuppressionOperatorsForRow(row, kind).length > 0;
  }

  /**
   * Return a row-specific edge fade percentage for one suppression operator.
   *
   * @param {object|null|undefined} operatorRow
   * @returns {number}
   */
  #suppressionOperatorEdgeFadePercent(operatorRow) {
    if (!operatorRow || operatorRow?.behaviorType === SUPPRESS_WEATHER) return 0;
    const doc = this.#getRegionDocumentForRow(operatorRow);
    const behaviorId = String(operatorRow?.behaviorId ?? "");
    const behavior = [...(doc?.behaviors ?? [])].find((candidate) => String(candidate?.id ?? "") === behaviorId);
    return getRegionBehaviorEdgeFadePercent(behavior);
  }

  /**
   * Return whether a suppression Region's elevation/Level assignment can affect a row.
   *
   * @param {PlaceableObject|null|undefined} region
   * @param {object|null|undefined} row
   * @returns {boolean}
   */
  #suppressionRegionLevelOverlapsRow(region, row) {
    if (!canvas?.level) return true;

    const allowedLevelIds = this.#getRowAllowedLevelIds(row);
    if (allowedLevelIds instanceof Set && allowedLevelIds.size === 0) return false;
    if (!(allowedLevelIds?.size > 0)) return true;

    const doc = region?.document ?? null;
    if (!doc) return true;
    if (!regionDocumentCanApplyInCurrentView(doc, doc?.parent ?? canvas?.scene ?? null)) return false;

    const regionLevels = getDocumentAssignedLevelIds(doc, doc?.parent ?? canvas?.scene ?? null);
    if (regionLevels?.size) {
      for (const levelId of regionLevels) {
        if (allowedLevelIds.has(levelId)) return true;
      }
      return false;
    }

    const window = getRegionElevationWindow(doc);
    if (!window) return true;

    for (const levelId of allowedLevelIds) {
      const level = this.#getSceneLevelById(levelId);
      if (!level) continue;
      const bottom = this.#getLevelBottom(level);
      const top = this.#getLevelTop(level);
      const overlaps =
        (!Number.isFinite(window.min) || !Number.isFinite(top) || top >= window.min - 1e-4) &&
        (!Number.isFinite(window.max) || !Number.isFinite(bottom) || bottom <= window.max + 1e-4);
      if (overlaps) return true;
    }

    return false;
  }

  /**
   * Return whether a suppression Region actually affects a specific stack row.
   *
   * @param {PlaceableObject|null|undefined} region
   * @param {object|null|undefined} row
   * @param {"particles"|"filters"} kind
   * @returns {boolean}
   */
  #suppressionRegionAffectsRow(region, row, kind) {
    if (!this.#suppressionRegionPassesKindGate(region, kind)) return false;
    if (!this.#suppressionRegionIntersectsCurrentViewport(region)) return false;
    if (!this.#suppressionRegionLevelOverlapsRow(region, row)) return false;
    return true;
  }

  /**
   * Return whether active suppression Regions affect a specific compositor row.
   *
   * @param {object|null|undefined} row
   * @param {"particles"|"filters"} kind
   * @returns {boolean}
   */
  #rowHasRelevantSuppressionRegions(row, kind) {
    const normalizedKind = kind === "filters" ? "filters" : "particles";
    if (!this.#hasSuppressionRegionsForFrame(normalizedKind)) return false;
    return this.#rowHasActiveSuppressionOperators(row, normalizedKind);
  }

  /**
   * Return whether a scene-level filter can bypass the shared scene-mask texture and rely on a live local scene clip instead.
   *
   * This path applies only to plain scene filters with no suppression regions and no below-object masking.
   *
   * @param {{ kind?: string, scope?: string, uid?: string }|null|undefined} row
   * @returns {boolean}
   */
  #rowUsesDirectSceneFilterClip(row) {
    if (row?.kind !== "filter" || this.#getRowScope(row) !== "scene") return false;
    if (this._forceGeneratedSceneClipFrame) return false;
    if (this.#rowWantsBelowTiles(row)) return false;

    const filter = row?.uid ? this.#resolveFilter(row.uid) : null;
    if (!filter || this.#filterWantsBelowTokens(filter)) return false;

    return !this.#rowHasRelevantSuppressionRegions(row, "filters");
  }

  /**
   * Return whether scene-filter suppression can be applied by the compositor instead of by the shared scene allow-mask uniform.
   *
   * The path is limited to explicit selected-Level scene filters with no below-token or below-tile cutouts. The compositor renders those rows through selected Level masks already, so suppress Regions can be represented by restoring the pre-filter frame through Region ∩ Level masks.
   *
   * @param {object|null|undefined} row
   * @returns {boolean}
   */
  #rowUsesCompositorSceneFilterSuppression(row) {
    if (CONFIG?.fxmaster?.overheadPerformance?.compositorSceneFilterSuppression === false) return false;
    if (!applyRegionBehaviorsToOverheadLevels()) return false;
    if (row?.kind !== "filter" || this.#getRowScope(row) !== "scene") return false;
    if (this.#rowWantsBelowTiles(row)) return false;

    const filter = row?.uid ? this.#resolveFilter(row.uid) : null;
    if (!filter || this.#filterWantsBelowTokens(filter)) return false;

    const selectedLevelIds = this.#getRowAllowedLevelIds(row);
    if (!(selectedLevelIds?.size > 0)) return false;
    if (!this.#rowUsesSelectedLevelSurfaceMask(row)) return false;

    return this.#canHandleCompositorSceneSuppressionForLevelSelection("filters", selectedLevelIds, row);
  }

  /**
   * Return whether compositor-side scene-particle suppression is enabled.
   *
   * V22 disables the V21 adaptive handoff because rebinding the shared scene-particle mask during/around compositor rendering can trigger WebGL feedback-loop warnings. The stable path is either always compositor-side or fully disabled by setting compositorSceneParticleSuppressionMode to "off".
   *
   * @returns {boolean}
   */
  #sceneParticleSuppressionCompositorInteractionActive() {
    if (CONFIG?.fxmaster?.overheadPerformance?.compositorSceneParticleSuppression === false) return false;
    const raw = String(
      CONFIG?.fxmaster?.overheadPerformance?.compositorSceneParticleSuppressionMode ?? "always",
    ).toLowerCase();
    if (["off", "never", "false", "0"].includes(raw)) return false;
    return true;
  }

  /**
   * Return whether scene-particle suppression can be applied by the compositor instead of by the shared scene allow-mask.
   *
   * This mirrors the scene-filter suppression path and is limited to explicit selected-Level scene particles with no below-token or below-tile cutouts. The compositor already composites those rows through Level contribution masks, so overlapping suppress Regions can be represented by restoring the pre-particle frame through Region ∩ selected-Level masks.
   *
   * @param {object|null|undefined} row
   * @returns {boolean}
   */
  #rowUsesCompositorSceneParticleSuppression(row) {
    if (CONFIG?.fxmaster?.overheadPerformance?.compositorSceneParticleSuppression === false) return false;
    if (!this.#sceneParticleSuppressionCompositorInteractionActive()) return false;
    if (!applyRegionBehaviorsToOverheadLevels()) return false;
    if (row?.kind !== "particle" || this.#getRowScope(row) !== "scene") return false;
    if (this.#rowWantsBelowTokens(row) || this.#rowWantsBelowTiles(row)) return false;

    const runtime = row?.uid ? this.#resolveParticleRuntime(row.uid) : null;
    if (!runtime) return false;

    const selectedLevelIds = this.#getRowAllowedLevelIds(row);
    if (!(selectedLevelIds?.size > 0)) return false;
    if (!this.#rowUsesSelectedLevelSurfaceMask(row)) return false;

    return this.#canHandleCompositorSceneSuppressionForLevelSelection("particles", selectedLevelIds, row);
  }

  /**
   * Public bundle-safe capability check used by the scene-filter manager before it bypasses the shared scene suppression mask. The compositor path is only safe when every currently relevant suppress-scene-filters Region overlaps a single selected Level; multi-Level or all-Level Regions keep the V16/V17 shared-mask path because they need broader overlay preservation semantics.
   *
   * @param {Set<string>|string[]|null|undefined} selectedLevelIds
   * @returns {boolean}
   */
  canHandleSceneFilterSuppressionForSelectedLevelIds(selectedLevelIds) {
    const selected = selectedLevelIds instanceof Set ? selectedLevelIds : new Set(selectedLevelIds ?? []);
    return this.#canHandleCompositorSceneSuppressionForLevelSelection("filters", selected);
  }

  /**
   * Public bundle-safe capability check used by the scene-particle manager before it bypasses the shared scene suppression mask.
   *
   * @param {Set<string>|string[]|null|undefined} selectedLevelIds
   * @returns {boolean}
   */
  canHandleSceneParticleSuppressionForSelectedLevelIds(selectedLevelIds) {
    const selected = selectedLevelIds instanceof Set ? selectedLevelIds : new Set(selectedLevelIds ?? []);
    return this.#canHandleCompositorSceneSuppressionForLevelSelection("particles", selected);
  }

  /**
   * Return the world-space center point for a token-like placeable.
   *
   * @param {Token|null|undefined} token
   * @returns {{x:number,y:number}|null}
   */
  #tokenCenterForSuppressionFallback(token) {
    const center = token?.center ?? token?.bounds?.center ?? null;
    if (Number.isFinite(Number(center?.x)) && Number.isFinite(Number(center?.y))) {
      return { x: Number(center.x), y: Number(center.y) };
    }

    const x = Number(token?.document?.x ?? token?.x ?? Number.NaN);
    const y = Number(token?.document?.y ?? token?.y ?? Number.NaN);
    const width = Number(token?.document?.width ?? token?.w ?? token?.width ?? Number.NaN);
    const height = Number(token?.document?.height ?? token?.h ?? token?.height ?? Number.NaN);
    const gridSize = Number(canvas?.grid?.size ?? canvas?.dimensions?.size ?? 1);
    if (![x, y, width, height, gridSize].every(Number.isFinite)) return null;
    return { x: x + (width * gridSize) / 2, y: y + (height * gridSize) / 2 };
  }

  /**
   * Return authored/inferred Level ids for a token without trusting transient current-view inclusion during native Level hover reveal.
   *
   * @param {Token|null|undefined} token
   * @returns {Set<string>}
   */
  #tokenAuthoredLevelIdsForSuppressionFallback(token) {
    const document = token?.document ?? token ?? null;
    if (!document) return new Set();

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

    const elevation = Number(token?.document?.elevation ?? token?.elevation ?? Number.NaN);

    const directLevel = document?.level ?? null;
    const directLevelId = typeof directLevel === "string" ? directLevel : fxmDocumentId(directLevel) || null;
    if (directLevelId) {
      const level = this.#getSceneLevelById(directLevelId);
      if (!level || !Number.isFinite(elevation)) return new Set([String(directLevelId)]);

      const bottom = this.#getLevelBottom(level);
      const top = this.#getLevelTop(level);
      const withinBottom = !Number.isFinite(bottom) || elevation >= bottom - 1e-4;
      const withinTop = !Number.isFinite(top) || elevation <= top + 1e-4;
      if (withinBottom && withinTop) return new Set([String(directLevelId)]);
    }

    if (Number.isFinite(elevation)) {
      const ids = new Set();
      for (const level of this.#getSceneLevels()) {
        const levelId = String(fxmDocumentId(level)).trim();
        if (!levelId) continue;
        const bottom = this.#getLevelBottom(level);
        const top = this.#getLevelTop(level);
        const withinBottom = !Number.isFinite(bottom) || elevation >= bottom - 1e-4;
        const withinTop = !Number.isFinite(top) || elevation <= top + 1e-4;
        if (withinBottom && withinTop) ids.add(levelId);
      }
      if (ids.size) return ids;

      /**
       * Foundry's public inference falls back to the viewed Level when no visible Level contains the elevation. For suppression ownership that fallback is too broad, so only trust the inferred Level if its elevation range actually contains the token.
       */
      const inferred = inferVisibleLevelForDocument(document, elevation);
      if (inferred?.id) {
        const bottom = this.#getLevelBottom(inferred);
        const top = this.#getLevelTop(inferred);
        const withinBottom = !Number.isFinite(bottom) || elevation >= bottom - 1e-4;
        const withinTop = !Number.isFinite(top) || elevation <= top + 1e-4;
        if (withinBottom && withinTop) return new Set([String(inferred.id)]);
      }
    }

    return new Set();
  }

  /**
   * Return whether a token belongs outside the selected Level ids for a compositor-side suppression row.
   *
   * @param {Token|null|undefined} token
   * @param {Set<string>} selectedLevelIds
   * @returns {boolean}
   */
  #tokenIsOutsideSuppressionSelectedLevels(token, selectedLevelIds) {
    if (!(selectedLevelIds?.size > 0)) return false;

    const tokenLevelIds = this.#tokenAuthoredLevelIdsForSuppressionFallback(token);
    if (tokenLevelIds.size) {
      for (const levelId of tokenLevelIds) if (selectedLevelIds.has(String(levelId))) return false;
      return true;
    }

    const elevation = Number(token?.document?.elevation ?? token?.elevation ?? Number.NaN);
    if (!Number.isFinite(elevation)) return false;

    for (const levelId of selectedLevelIds) {
      const level = this.#getSceneLevelById(levelId);
      if (!level) continue;
      const bottom = this.#getLevelBottom(level);
      const top = this.#getLevelTop(level);
      const withinBottom = !Number.isFinite(bottom) || elevation >= bottom - 1e-4;
      const withinTop = !Number.isFinite(top) || elevation <= top + 1e-4;
      if (withinBottom && withinTop) return false;
    }

    return true;
  }

  /**
   * Return whether Foundry currently considers this token directly hovered. Direct lower-Level token reveal is the only suppression fallback trigger.
   *
   * @param {Token|null|undefined} token
   * @returns {boolean}
   */
  #tokenIsDirectlyHoveredForSuppressionFallback(token) {
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
   * Return the only tokens that can trigger the direct lower-Level suppression fallback. Keeping this to the live hover/control set avoids scanning every token from the compositor hot path while preserving the intended v39 case.
   *
   * @returns {Token[]}
   */
  #directLowerLevelRevealCandidateTokensForSuppressionFallback() {
    if (Array.isArray(this._directSuppressionFallbackTokenCandidatesFrameCache)) {
      return this._directSuppressionFallbackTokenCandidatesFrameCache;
    }

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

    this._directSuppressionFallbackTokenCandidatesFrameCache = candidates;
    return candidates;
  }

  /**
   * Return the approximate native-Level reveal radius for a token.
   *
   * Foundry's occlusion mask uses max(token.externalRadius, token.getLightRadius(token.document.occludable.radius)) for token-driven radial occlusion. Mirror that scale and keep a token-size fallback for systems where occludable data is absent.
   *
   * @param {Token|null|undefined} token
   * @returns {number}
   */
  #tokenRevealApertureRadiusForSuppressionFallback(token) {
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
    return Math.max(1, radius);
  }

  /**
   * Return whether a lower-Level token reveal aperture overlaps a Region's broad world bounds.
   *
   * The check intentionally uses bounds rather than RegionDocument#testPoint: the Region is assigned to the target Level, while the token is authored on a different Level. Use the whole native reveal aperture rather than only the token center; the token can be near the edge of a suppression Region while the revealed lower-Level aperture still overlaps the Region.
   *
   * @param {Token|null|undefined} token
   * @param {PlaceableObject|null|undefined} region
   * @returns {boolean}
   */
  #tokenRevealApertureIntersectsSuppressionRegionBounds(token, region) {
    const point = this.#tokenCenterForSuppressionFallback(token);
    if (!point || !region) return false;

    try {
      const bounds = regionWorldBounds(region) ?? null;
      if (!bounds) return true;
      const minX = Number(bounds.minX ?? bounds.x ?? Number.NaN);
      const minY = Number(bounds.minY ?? bounds.y ?? Number.NaN);
      const maxX = Number(bounds.maxX ?? (bounds.x ?? 0) + (bounds.width ?? 0));
      const maxY = Number(bounds.maxY ?? (bounds.y ?? 0) + (bounds.height ?? 0));
      if (![minX, minY, maxX, maxY].every(Number.isFinite)) return true;

      const radius = this.#tokenRevealApertureRadiusForSuppressionFallback(token);
      const nearestX = Math.max(minX, Math.min(point.x, maxX));
      const nearestY = Math.max(minY, Math.min(point.y, maxY));
      const dx = point.x - nearestX;
      const dy = point.y - nearestY;
      return dx * dx + dy * dy <= radius * radius + 1e-4;
    } catch (err) {
      logger.debug("FXMaster:", err);
      return true;
    }
  }

  /**
   * Return whether compositor-side scene suppression should fall back to the shared scene allow-mask because an off-target lower-Level token is directly revealed while current-Level suppression Regions are active.
   *
   * The compositor-side optimization only knows how to restore the pre-effect frame through Region ∩ selected-Level masks. It cannot represent Foundry's current-Level surface reveal state when a lower Level is exposed. The token aperture does not have to overlap the Region bounds: once the current Level is in this reveal state, any same-Level broad 2D suppression hole can leak into lower-Level pixels. Fall back to SceneMaskManager, which can clip current-Level suppression to live Level surface objects.
   *
   * @param {"particles"|"filters"} kind
   * @param {Set<string>} selectedLevelIds
   * @returns {boolean}
   */
  #hasOffTargetRevealedTokenApertureForSuppressionSelection(kind, selectedLevelIds, activeOperators = null) {
    if (!canvas?.level || !(selectedLevelIds?.size > 0) || !canvas?.tokens) return false;

    const candidateTokens = this.#directLowerLevelRevealCandidateTokensForSuppressionFallback();
    if (!candidateTokens.length) return false;

    const normalizedKind = kind === "filters" ? "filters" : "particles";
    const relevantOperators = Array.isArray(activeOperators)
      ? activeOperators
      : getRegionEffectPlaceablesForCurrentView(canvas?.scene ?? null)
          .filter((region) => this.#suppressionRegionPassesKindGate(region, normalizedKind))
          .map((region) => ({ region }));
    const relevantRegions = [];
    for (const entry of relevantOperators) {
      const region = entry?.region ?? null;
      if (!region) continue;
      if (!this.#suppressionRegionIntersectsCurrentViewport(region)) continue;
      const overlap = this.#getSuppressionRegionSelectedLevelOverlapIds(region, selectedLevelIds);
      if (!(overlap?.size > 0)) continue;
      relevantRegions.push(region);
    }
    if (!relevantRegions.length) return false;

    for (const token of candidateTokens) {
      if (!token || token.destroyed || token?.document?.hidden) continue;
      if (!this.#tokenIsOutsideSuppressionSelectedLevels(token, selectedLevelIds)) continue;

      let revealed =
        token?.controlled === true ||
        this.#tokenIsDirectlyHoveredForSuppressionFallback(token) === true ||
        sceneMaskContainsTokenCenterForCompositor(token) === true;

      if (!revealed) {
        try {
          /**
           * Scene-mask / upper-surface reveal is still useful when available. Do not require direct token hover here: when Foundry has already opened a lower-Level aperture, compositor-side Level suppression cannot safely represent that aperture and must fall back to the shared scene allow-mask path.
           */
          revealed =
            tokenUpperLevelRevealAllowsBelowTokenMask(token, { requireDirectHoverForSceneMask: false }) === true;
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }
      if (!revealed) continue;

      return true;
    }

    return false;
  }

  /**
   * @param {"particles"|"filters"} kind
   * @param {Set<string>|string[]|null|undefined} selectedLevelIds
   * @returns {boolean}
   */
  #canHandleCompositorSceneSuppressionForLevelSelection(kind, selectedLevelIds, row = null) {
    const normalizedKind = kind === "filters" ? "filters" : "particles";
    const selected = selectedLevelIds instanceof Set ? selectedLevelIds : new Set(selectedLevelIds ?? []);
    if (!(selected?.size > 0)) return false;
    if (!this.#hasSuppressionRegionsForFrame(normalizedKind)) return false;

    const activeOperators = row ? this.#activeSuppressionOperatorsForRow(row, normalizedKind) : null;
    if (row && !activeOperators.length) return false;

    if (this.#hasOffTargetRevealedTokenApertureForSuppressionSelection(normalizedKind, selected, activeOperators))
      return false;

    let found = false;
    const entries =
      activeOperators ??
      getRegionEffectPlaceablesForCurrentView(canvas?.scene ?? null)
        .filter((region) => this.#suppressionRegionPassesKindGate(region, normalizedKind))
        .map((region) => ({ region }));
    for (const entry of entries) {
      const region = entry?.region ?? null;
      if (!region) continue;
      if (!this.#suppressionRegionIntersectsCurrentViewport(region)) continue;

      const overlap = this.#getSuppressionRegionSelectedLevelOverlapIds(region, selected);
      if (!(overlap?.size > 0)) continue;
      if (overlap.size !== 1) return false;
      found = true;
    }

    return found;
  }

  /**
   * Return the maximum edge-fade percentage for an active suppression Region. Weather suppression is hard-edged; FXMaster suppress-scene-filters behaviors may define an inward fade.
   *
   * @param {PlaceableObject|null|undefined} region
   * @param {"filters"|"particles"} [kind="filters"]
   * @returns {number}
   */
  #suppressionRegionEdgeFadePercent(region, kind = "filters") {
    const specificType = kind === "filters" ? SUPPRESS_SCENE_FILTERS : SUPPRESS_SCENE_PARTICLES;
    let edgeFadePercent = 0;
    for (const behavior of region?.document?.behaviors ?? []) {
      if (!behavior || behavior.disabled || behavior.type !== specificType) continue;
      if (!this.#computeRegionGatePassForFrame(region, specificType)) continue;
      const pct = getRegionBehaviorEdgeFadePercent(behavior);
      edgeFadePercent = Math.max(edgeFadePercent, pct);
    }
    return edgeFadePercent;
  }

  /**
   * Return selected Level ids that overlap a suppression Region.
   *
   * @param {PlaceableObject|null|undefined} region
   * @param {Set<string>|string[]|null|undefined} selectedLevelIds
   * @returns {Set<string>}
   */
  #getSuppressionRegionSelectedLevelOverlapIds(region, selectedLevelIds) {
    const selected = selectedLevelIds instanceof Set ? selectedLevelIds : new Set(selectedLevelIds ?? []);
    if (!(selected?.size > 0)) return new Set();

    const doc = region?.document ?? null;
    if (!doc) return new Set(selected);

    const regionLevels = getDocumentAssignedLevelIds(doc, doc?.parent ?? canvas?.scene ?? null);
    if (regionLevels?.size) {
      const out = new Set();
      for (const levelId of regionLevels) if (selected.has(String(levelId))) out.add(String(levelId));
      return out;
    }

    const window = getRegionElevationWindow(doc);
    if (!window) return new Set(selected);

    const out = new Set();
    for (const levelId of selected) {
      const level = this.#getSceneLevelById(levelId);
      if (!level) continue;
      const bottom = this.#getLevelBottom(level);
      const top = this.#getLevelTop(level);
      const overlaps =
        (!Number.isFinite(window.min) || !Number.isFinite(top) || top >= window.min - 1e-4) &&
        (!Number.isFinite(window.max) || !Number.isFinite(bottom) || bottom <= window.max + 1e-4);
      if (overlaps) out.add(String(levelId));
    }
    return out;
  }

  /**
   * Return selected row Level ids that overlap a suppression Region.
   *
   * @param {PlaceableObject|null|undefined} region
   * @param {object|null|undefined} row
   * @returns {Set<string>}
   */
  #getSuppressionRegionRowOverlapLevelIds(region, row) {
    return this.#getSuppressionRegionSelectedLevelOverlapIds(region, this.#getRowAllowedLevelIds(row));
  }

  /**
   * Return a reusable CSS-space Region mask texture for compositor-side scene filter suppression.
   *
   * @param {PlaceableObject|null|undefined} region
   * @param {number} [edgeFadePercent=0]
   * @returns {PIXI.RenderTexture|null}
   */
  #getCompositorSuppressionRegionMaskTexture(region, edgeFadePercent = 0) {
    if (!region) return null;

    if (CONFIG?.fxmaster?.overheadPerformance?.compositorSuppressionMaskCaching === false) {
      return this.#buildUncachedCompositorSuppressionRegionMaskTexture(region, edgeFadePercent);
    }

    const baseKey = this.#compositorSuppressionRegionMaskBaseKey(region, edgeFadePercent);
    if (!baseKey) return null;

    const moving = this.#selectedLevelViewportMovedThisFrame();
    const stableKey = `${baseKey}:matrix:${this.#selectedLevelViewportMatrixKey()}`;
    const dynamicKey = baseKey;

    const stableCache = this._sceneSuppressionRegionMaskRTCache;
    const dynamicCache = this._sceneSuppressionRegionMaskDynamicRTCache;

    if (!moving && stableCache instanceof Map) {
      const entry = stableCache.get(stableKey) ?? null;
      if (this.#canBindRenderTexture(entry?.rt)) {
        entry.lastUsedFrame = this._renderFrameSerial;
        this._sceneSuppressionMaskStats.regionStableHits += 1;
        return entry.rt;
      }
      if (entry?.rt) {
        try {
          entry.rt.destroy?.(true);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }
      stableCache.delete(stableKey);
    }

    if (moving && dynamicCache instanceof Map) {
      const entry = dynamicCache.get(dynamicKey) ?? null;
      if (this.#canBindRenderTexture(entry?.rt) && entry.frameSerial === this._renderFrameSerial) {
        this._sceneSuppressionMaskStats.regionDynamicHits += 1;
        return entry.rt;
      }
    }

    if (moving) this._sceneSuppressionMaskStats.regionDynamicMisses += 1;
    else this._sceneSuppressionMaskStats.regionStableMisses += 1;

    let renderTexture = null;
    const cache = moving ? dynamicCache : stableCache;
    const cacheKey = moving ? dynamicKey : stableKey;
    const existing = cache instanceof Map ? cache.get(cacheKey) ?? null : null;

    const pool = {
      acquire: (width, height, resolution) => {
        const needsNew =
          !this.#canBindRenderTexture(existing?.rt) ||
          Math.abs(Number(existing.rt.width ?? 0) - Math.max(1, Number(width) || 1)) > 0.001 ||
          Math.abs(Number(existing.rt.height ?? 0) - Math.max(1, Number(height) || 1)) > 0.001 ||
          Math.abs(Number(existing.rt.resolution || 1) - Number(resolution || 1)) > 0.0001;

        if (!needsNew) {
          renderTexture = existing.rt;
          return existing.rt;
        }

        try {
          existing?.rt?.destroy?.(true);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }

        renderTexture = PIXI.RenderTexture.create({
          width: Math.max(1, Number(width) || 1),
          height: Math.max(1, Number(height) || 1),
          resolution: resolution || 1,
          multisample: 0,
        });
        this.#configureRenderTexture(renderTexture);
        return renderTexture;
      },
    };

    try {
      renderTexture = buildRegionMaskRT(region, { rtPool: pool, edgeFadePercent });
    } catch (err) {
      logger.debug("FXMaster:", err);
      renderTexture = null;
    }

    if (!this.#canBindRenderTexture(renderTexture)) return null;

    if (cache instanceof Map) {
      const entry = moving
        ? { rt: renderTexture, frameSerial: this._renderFrameSerial, lastUsedFrame: this._renderFrameSerial }
        : { rt: renderTexture, lastUsedFrame: this._renderFrameSerial };
      cache.set(cacheKey, entry);
    }

    return renderTexture;
  }

  /**
   * Build a compositor-side suppression Region mask without persistent caching.
   *
   * @param {PlaceableObject|null|undefined} region
   * @param {number} [edgeFadePercent=0]
   * @returns {PIXI.RenderTexture|null}
   */
  #buildUncachedCompositorSuppressionRegionMaskTexture(region, edgeFadePercent = 0) {
    const pool = {
      acquire: (width, height, resolution) => {
        const needsNew =
          !this._sceneFilterSuppressionRegionRT ||
          this._sceneFilterSuppressionRegionRT.destroyed ||
          Math.abs(Number(this._sceneFilterSuppressionRegionRT.width ?? 0) - Math.max(1, Number(width) || 1)) > 0.001 ||
          Math.abs(Number(this._sceneFilterSuppressionRegionRT.height ?? 0) - Math.max(1, Number(height) || 1)) >
            0.001 ||
          Math.abs(Number(this._sceneFilterSuppressionRegionRT.resolution || 1) - Number(resolution || 1)) > 0.0001;

        if (needsNew) {
          try {
            this._sceneFilterSuppressionRegionRT?.destroy?.(true);
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
          this._sceneFilterSuppressionRegionRT = PIXI.RenderTexture.create({
            width: Math.max(1, Number(width) || 1),
            height: Math.max(1, Number(height) || 1),
            resolution: resolution || 1,
            multisample: 0,
          });
          this.#configureRenderTexture(this._sceneFilterSuppressionRegionRT);
        }

        return this._sceneFilterSuppressionRegionRT;
      },
    };

    try {
      return buildRegionMaskRT(region, { rtPool: pool, edgeFadePercent });
    } catch (err) {
      logger.debug("FXMaster:", err);
      return null;
    }
  }

  /**
   * Return a stable base key for a compositor-side suppression Region mask.
   *
   * @param {PlaceableObject|null|undefined} region
   * @param {number} edgeFadePercent
   * @returns {string}
   */
  #compositorSuppressionRegionMaskBaseKey(region, edgeFadePercent = 0) {
    const doc = region?.document ?? region ?? null;
    const regionId = String(doc?.uuid ?? doc?.id ?? region?.id ?? "");
    if (!regionId) return "";

    const { width, height, resolution } = this.#getViewportMetrics();
    return [
      canvas?.scene?.id ?? "scene",
      "suppression-region-mask",
      regionId,
      this.#compositorSuppressionRegionGeometryKey(region),
      Number(edgeFadePercent || 0).toFixed(4),
      width,
      height,
      Number(resolution || 1).toFixed(3),
    ].join(":");
  }

  /**
   * Return a per-frame cached serialization for Region shapes.
   *
   * @param {object[]|object|null|undefined} shapes
   * @returns {string}
   */
  #regionShapeKeyForFrame(shapes) {
    if (!shapes || typeof shapes !== "object") return "";

    const cache = this._regionShapeKeyFrameCache;
    if (cache?.has(shapes)) return cache.get(shapes) ?? "";

    let key = "";
    try {
      key = JSON.stringify(shapes) || "";
    } catch (err) {
      logger.debug("FXMaster:", err);
      key = "";
    }

    cache?.set(shapes, key);
    return key;
  }

  /**
   * Return a compact geometry signature for a Region mask cache key.
   *
   * @param {PlaceableObject|null|undefined} region
   * @returns {string}
   */
  #compositorSuppressionRegionGeometryKey(region) {
    const doc = region?.document ?? region ?? null;
    let boundsKey = "bounds:unknown";
    try {
      const bounds = regionWorldBounds(region);
      boundsKey = [bounds?.x, bounds?.y, bounds?.width, bounds?.height]
        .map((value) => (Number.isFinite(Number(value)) ? Number(value).toFixed(2) : ""))
        .join(",");
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    const shapes = fxmReadDocumentShapes(doc);
    const shapeKey = this.#regionShapeKeyForFrame(shapes);

    const elevationKey = (() => {
      try {
        const win = getRegionElevationWindow(doc);
        return [win?.min, win?.max]
          .map((value) => (Number.isFinite(Number(value)) ? Number(value).toFixed(3) : ""))
          .join(",");
      } catch (err) {
        logger.debug("FXMaster:", err);
        return "";
      }
    })();

    return `${boundsKey}|${elevationKey}|${shapeKey}`;
  }

  /**
   * Return a cached Region ∩ selected-Level contribution mask for compositor-side scene suppression.
   *
   * @param {object|null|undefined} row
   * @param {PlaceableObject|null|undefined} region
   * @param {"particles"|"filters"} kind
   * @param {Set<string>|string[]|null|undefined} levelIds
   * @returns {PIXI.RenderTexture|null}
   */
  #getCompositorSceneSuppressionCombinedMaskTexture(row, region, kind, levelIds, edgeFadePercentOverride = null) {
    const ids = Array.from(levelIds ?? []).filter(Boolean);
    if (ids.length !== 1) return null;

    const normalizedKind = kind === "filters" ? "filters" : "particles";
    const belowForeground = this.#rowWantsBelowForeground(row);
    const includeTiles = this.#rowIncludesTileSurfacesInLevelMasks(row);
    const includeTilesOnlyWithoutLevelSurface = this.#rowLimitsSelectedLevelTilesToFallbackSurfaces(row);
    const strictLevelIdentity = true;
    const restoreStrictLevelIdentity = false;
    const edgeFadePercent =
      edgeFadePercentOverride == null
        ? this.#suppressionRegionEdgeFadePercent(region, normalizedKind)
        : Math.max(0, Math.min(Number(edgeFadePercentOverride) || 0, 1));
    const regionBaseKey = this.#compositorSuppressionRegionMaskBaseKey(region, edgeFadePercent);
    if (!regionBaseKey) return null;

    if (CONFIG?.fxmaster?.overheadPerformance?.compositorSuppressionMaskCaching === false) {
      const levelMask = this.#captureSingleSelectedLevelContributionMaskForLevelIds(ids, {
        belowForeground,
        includeTiles,
        strictLevelIdentity,
        restoreStrictLevelIdentity,
        includeTilesOnlyWithoutLevelSurface,
      });
      if (!levelMask) return null;
      const regionMask = this.#getCompositorSuppressionRegionMaskTexture(region, edgeFadePercent);
      if (!regionMask) return null;
      return this.#intersectMasksInto(levelMask, regionMask, this._surfaceMaskScratchRT);
    }

    const selectedSet = new Set(ids);
    const blockerIds = new Set();
    for (const segment of this.#buildSelectedLevelCompositeSegments(selectedSet)) {
      if (segment?.type !== "restore") continue;
      for (const levelId of segment.levelIds ?? []) if (levelId) blockerIds.add(levelId);
    }

    const { width, height, resolution } = this.#getViewportMetrics();
    const baseKey = [
      canvas?.scene?.id ?? "scene",
      "compositor-scene-suppression-combined",
      regionBaseKey,
      this.#levelIdsCacheKey(ids),
      this.#levelIdsCacheKey(blockerIds),
      belowForeground ? "below-foreground" : "all-surfaces",
      includeTiles ? "tiles" : "no-tiles",
      includeTilesOnlyWithoutLevelSurface ? "fallback-tiles" : "full-tiles",
      strictLevelIdentity ? "strict" : "visual",
      restoreStrictLevelIdentity ? "restore-strict" : "restore-visual",
      width,
      height,
      Number(resolution || 1).toFixed(3),
      this.#getLevelSurfaceSignatureForFrame(),
    ].join(":");

    const moving = this.#selectedLevelViewportMovedThisFrame();
    const stableKey = `${baseKey}:matrix:${this.#selectedLevelViewportMatrixKey()}`;
    const dynamicKey = baseKey;
    const cache = moving ? this._sceneSuppressionCombinedMaskDynamicRTCache : this._sceneSuppressionCombinedMaskRTCache;
    const cacheKey = moving ? dynamicKey : stableKey;

    if (cache instanceof Map) {
      const entry = cache.get(cacheKey) ?? null;
      if (this.#canBindRenderTexture(entry?.rt) && (!moving || entry.frameSerial === this._renderFrameSerial)) {
        entry.lastUsedFrame = this._renderFrameSerial;
        if (moving) this._sceneSuppressionMaskStats.combinedDynamicHits += 1;
        else this._sceneSuppressionMaskStats.combinedStableHits += 1;
        return entry.rt;
      }
      if (entry?.rt && !this.#canBindRenderTexture(entry.rt)) {
        try {
          entry.rt.destroy?.(true);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        cache.delete(cacheKey);
      }
    }

    if (moving) this._sceneSuppressionMaskStats.combinedDynamicMisses += 1;
    else this._sceneSuppressionMaskStats.combinedStableMisses += 1;

    const levelMask = this.#captureSingleSelectedLevelContributionMaskForLevelIds(ids, {
      belowForeground,
      includeTiles,
      strictLevelIdentity,
      restoreStrictLevelIdentity,
      includeTilesOnlyWithoutLevelSurface,
    });
    if (!levelMask) return null;

    const regionMask = this.#getCompositorSuppressionRegionMaskTexture(region, edgeFadePercent);
    if (!regionMask) return null;

    let renderTexture = cache instanceof Map ? cache.get(cacheKey)?.rt ?? null : null;
    if (!this.#canBindRenderTexture(renderTexture)) {
      try {
        renderTexture?.destroy?.(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      renderTexture = null;
      try {
        renderTexture = PIXI.RenderTexture.create({ width, height, resolution });
        this.#configureRenderTexture(renderTexture);
      } catch (err) {
        logger.debug("FXMaster:", err);
        return null;
      }
    }

    const combined = this.#intersectMasksInto(levelMask, regionMask, renderTexture);
    if (!combined || combined !== renderTexture) return combined;

    if (cache instanceof Map) {
      cache.set(
        cacheKey,
        moving
          ? { rt: renderTexture, frameSerial: this._renderFrameSerial, lastUsedFrame: this._renderFrameSerial }
          : { rt: renderTexture, lastUsedFrame: this._renderFrameSerial },
      );
    }

    return renderTexture;
  }

  /**
   * Drop stale compositor scene-suppression mask cache entries.
   *
   * @returns {void}
   */
  #pruneSceneSuppressionMaskRTCaches() {
    this.#pruneRenderTextureEntryCache(this._sceneSuppressionRegionMaskRTCache, { maxEntries: 16, maxAgeFrames: 180 });
    this.#pruneRenderTextureEntryCache(this._sceneSuppressionCombinedMaskRTCache, {
      maxEntries: 24,
      maxAgeFrames: 180,
    });
    this.#pruneRenderTextureEntryCache(this._sceneSuppressionRegionMaskDynamicRTCache, {
      maxEntries: 8,
      maxAgeFrames: 2,
    });
    this.#pruneRenderTextureEntryCache(this._sceneSuppressionCombinedMaskDynamicRTCache, {
      maxEntries: 8,
      maxAgeFrames: 2,
    });
  }

  /**
   * Prune a cache whose values are {rt,lastUsedFrame} entries.
   *
   * @param {Map<string,{rt?: PIXI.RenderTexture, lastUsedFrame?: number}>|null|undefined} cache
   * @param {{maxEntries?: number, maxAgeFrames?: number}} [options]
   * @returns {void}
   */
  #pruneRenderTextureEntryCache(cache, { maxEntries = 16, maxAgeFrames = 120 } = {}) {
    if (!(cache instanceof Map) || !cache.size) return;

    const entries = Array.from(cache.entries());
    for (const [key, entry] of entries) {
      const lastUsedFrame = Number(entry?.lastUsedFrame ?? entry?.frameSerial ?? -Infinity);
      const tooOld = this._renderFrameSerial - lastUsedFrame > maxAgeFrames;
      if (!tooOld && this.#canBindRenderTexture(entry?.rt)) continue;
      try {
        entry?.rt?.destroy?.(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      cache.delete(key);
    }

    if (cache.size <= maxEntries) return;

    const sorted = Array.from(cache.entries()).sort(
      (a, b) =>
        Number(a[1]?.lastUsedFrame ?? a[1]?.frameSerial ?? 0) - Number(b[1]?.lastUsedFrame ?? b[1]?.frameSerial ?? 0),
    );
    for (const [key, entry] of sorted.slice(0, Math.max(0, cache.size - maxEntries))) {
      try {
        entry?.rt?.destroy?.(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      cache.delete(key);
    }
  }

  /**
   * Destroy every render texture in a {rt} entry cache.
   *
   * @param {Map<string,{rt?: PIXI.RenderTexture}>|null|undefined} cache
   * @returns {void}
   */
  #destroyRenderTextureEntryCache(cache) {
    if (!(cache instanceof Map)) return;
    for (const entry of cache.values()) {
      try {
        entry?.rt?.destroy?.(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
    cache.clear();
  }

  /**
   * Return the filter used to multiply two mask textures into one mask.
   *
   * @returns {PIXI.Filter|null}
   */
  #getMaskIntersectionFilter() {
    if (this._maskIntersectionFilter && !this._maskIntersectionFilter.destroyed) return this._maskIntersectionFilter;

    try {
      this._maskIntersectionFilter = new PIXI.Filter(
        undefined,
        `
        varying vec2 vTextureCoord;
        uniform sampler2D uSampler;
        uniform sampler2D clipSampler;
        void main() {
          float a = texture2D(uSampler, vTextureCoord).r;
          float b = texture2D(clipSampler, vTextureCoord).r;
          float m = a * b;
          gl_FragColor = vec4(m, m, m, m);
        }
      `,
        { clipSampler: PIXI.Texture.EMPTY },
      );
      return this._maskIntersectionFilter;
    } catch (err) {
      logger.debug("FXMaster:", err);
      return null;
    }
  }

  /**
   * Multiply two CSS-space masks into a reusable scratch texture.
   *
   * @param {PIXI.Texture|PIXI.RenderTexture|null|undefined} baseMask
   * @param {PIXI.Texture|PIXI.RenderTexture|null|undefined} clipMask
   * @param {PIXI.RenderTexture|null|undefined} output
   * @returns {PIXI.RenderTexture|null}
   */
  #intersectMasksInto(baseMask, clipMask, output) {
    const renderer = canvas?.app?.renderer;
    const filter = this.#getMaskIntersectionFilter();
    if (!renderer || !baseMask || !clipMask || !output || !filter) return null;

    let target = output;
    if (this.#texturesShareBaseTexture(baseMask, target) || this.#texturesShareBaseTexture(clipMask, target)) {
      target = this._maskIntersectionRT;
    }
    if (
      !target ||
      this.#texturesShareBaseTexture(baseMask, target) ||
      this.#texturesShareBaseTexture(clipMask, target)
    ) {
      return null;
    }

    if (!this.#clearRenderTexture(target)) return null;

    if (!this._maskIntersectionSprite || this._maskIntersectionSprite.destroyed) {
      this._maskIntersectionSprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
      this._maskIntersectionSprite.name = "fxmasterMaskIntersectionSprite";
      this._maskIntersectionSprite.eventMode = "none";
      this._maskIntersectionSprite.anchor.set(0, 0);
    }

    const { width, height } = this.#getViewportMetrics();
    const sprite = this._maskIntersectionSprite;
    sprite.texture = baseMask;
    sprite.position.set(0, 0);
    sprite.scale.set(1, 1);
    sprite.width = width;
    sprite.height = height;
    sprite.visible = true;
    sprite.renderable = true;
    filter.uniforms.clipSampler = clipMask;
    sprite.filters = [filter];

    try {
      renderer.render(sprite, {
        renderTexture: target,
        clear: false,
        skipUpdateTransform: false,
      });
      return target;
    } catch (err) {
      logger.debug("FXMaster:", err);
      return null;
    } finally {
      sprite.filters = null;
      sprite.texture = PIXI.Texture.EMPTY;
      filter.uniforms.clipSampler = PIXI.Texture.EMPTY;
    }
  }

  /**
   * Apply suppress-scene-filters Regions to a scene filter row by restoring the pre-filter frame through Region ∩ selected-Level masks. This replaces the expensive shared scene allow-mask rebuild for explicit-Level scene filters.
   *
   * @param {object|null|undefined} row
   * @param {PIXI.RenderTexture|null|undefined} rowInput
   * @param {PIXI.RenderTexture|null|undefined} rowOutput
   * @returns {boolean}
   */
  #applyCompositorSceneFilterSuppression(row, rowInput, rowOutput) {
    if (!this.#rowUsesCompositorSceneFilterSuppression(row)) return false;
    return this.#applyCompositorSceneSuppression(row, rowInput, rowOutput, "filters");
  }

  /**
   * Apply suppress-scene-particles Regions to a scene particle row by restoring the pre-particle frame through Region ∩ selected-Level masks. This mirrors the scene-filter compositor suppression path and avoids rebuilding the broad shared scene allow-mask when explicit-Level scene particles overlap a single suppress-scene-particles Region Level.
   *
   * @param {object|null|undefined} row
   * @param {PIXI.RenderTexture|null|undefined} rowInput
   * @param {PIXI.RenderTexture|null|undefined} rowOutput
   * @returns {boolean}
   */
  #applyCompositorSceneParticleSuppression(row, rowInput, rowOutput) {
    if (!this.#rowUsesCompositorSceneParticleSuppression(row)) return false;
    return this.#applyCompositorSceneSuppression(row, rowInput, rowOutput, "particles");
  }

  /**
   * Apply a compositor-side scene suppression restore for a scene row.
   *
   * The mask is a single selected-Level contribution mask intersected with the suppression Region mask, then applied after the selected-Level row has been composited. Applying the restore after Level compositing prevents a lower Level suppression shape from contaminating a higher overhead overlay.
   *
   * @param {object|null|undefined} row
   * @param {PIXI.RenderTexture|null|undefined} rowInput
   * @param {PIXI.RenderTexture|null|undefined} rowOutput
   * @param {"particles"|"filters"} kind
   * @returns {boolean}
   */
  #applyCompositorSceneSuppression(row, rowInput, rowOutput, kind) {
    if (!rowInput || !rowOutput || !this._surfaceMaskScratchRT) return false;

    const normalizedKind = kind === "filters" ? "filters" : "particles";
    let applied = false;
    for (const entry of this.#activeSuppressionOperatorsForRow(row, normalizedKind)) {
      const region = entry?.region ?? null;
      if (!region) continue;

      const levelIds = this.#getSuppressionRegionRowOverlapLevelIds(region, row);
      if (levelIds?.size !== 1) continue;

      const combinedMask = this.#getCompositorSceneSuppressionCombinedMaskTexture(
        row,
        region,
        normalizedKind,
        levelIds,
        this.#suppressionOperatorEdgeFadePercent(entry.row),
      );
      if (!combinedMask) continue;

      this.#restoreFromTextureMask(combinedMask, rowInput, rowOutput);
      applied = true;
    }

    return applied;
  }

  /**
   * Analyze stack rows once for frame-wide compositor decisions.
   *
   * @param {Array<object>} rows
   * @returns {object}
   */
  #analyzeRowsForFrame(rows = []) {
    const state = {
      hasSelectedLevelParticleRows: false,
      hasSceneFilterRows: false,
      hasLevelAwareRows: false,
      needsOutputSceneMask: false,
      needsDynamicTokenCoverage: false,
      needsDynamicTileCoverage: false,
      needsRegionFilterCoverageRefresh: false,
      needsRegionParticleCoverageRefresh: false,
    };

    for (const row of rows) {
      if (this.#rowIsSuppressionOperator(row)) continue;
      const rowScope = this.#getRowScope(row);
      const usesSelectedLevelSurfaceMask = this.#rowUsesSelectedLevelSurfaceMask(row);
      const hasLevelLimitedOutput = this.#rowHasLevelLimitedOutput(row);

      if (row?.kind === "particle" && usesSelectedLevelSurfaceMask) state.hasSelectedLevelParticleRows = true;
      if (row?.kind === "filter" && rowScope === "scene") state.hasSceneFilterRows = true;
      if (usesSelectedLevelSurfaceMask || hasLevelLimitedOutput) state.hasLevelAwareRows = true;
      const wantsBelowTokens = this.#rowWantsBelowTokens(row);
      const wantsBelowTiles = this.#rowWantsBelowTiles(row);
      if (wantsBelowTokens) state.needsDynamicTokenCoverage = true;
      if (wantsBelowTiles) state.needsDynamicTileCoverage = true;
      if (rowScope === "region" && (wantsBelowTokens || wantsBelowTiles)) {
        if (row?.kind === "filter") state.needsRegionFilterCoverageRefresh = true;
        if (row?.kind === "particle") state.needsRegionParticleCoverageRefresh = true;
      }
    }

    return state;
  }

  /**
   * Return whether live native-Level state needs a primary refresh before mask sampling.
   *
   * @param {object|null|undefined} frameInfo
   * @returns {boolean}
   */
  #shouldSyncLevelSurfaceStateForFrame(frameInfo) {
    if (!canvas?.level || !frameInfo?.hasLevelAwareRows) return false;
    if (frameInfo.needsDynamicTokenCoverage || frameInfo.needsDynamicTileCoverage) return false;
    if (!this.#selectedLevelViewportMovedThisFrame()) return true;
    if (Number.isFinite(getCanvasPrimaryHoverFadeElevation())) return true;

    for (const token of canvas?.tokens?.controlled ?? []) {
      if (token && !token.destroyed && !token?.document?.hidden) return true;
    }

    const inspect = (mesh) => {
      if (!mesh || mesh.destroyed) return false;
      const object = fxmLinkedPlaceableFromDisplayObject(mesh);
      const liveMesh = object?.mesh ?? object?.primaryMesh ?? object?.sprite ?? mesh;
      const hoverState = fxmGetPublicHoverFadeState(liveMesh, mesh);
      if (hoverState?.faded || hoverState?.hovered) return true;

      const fadeOcclusion = Number(
        liveMesh?.fadeOcclusion ??
          liveMesh?.shader?.uniforms?.fadeOcclusion ??
          mesh?.fadeOcclusion ??
          mesh?.shader?.uniforms?.fadeOcclusion ??
          0,
      );
      return Number.isFinite(fadeOcclusion) && fadeOcclusion > 0.001;
    };

    for (const mesh of this.#getPrimaryLevelTexturesForFrame()) {
      if (inspect(mesh)) return true;
    }

    for (const mesh of this.#getPrimaryTileMeshesForFrame()) {
      if (inspect(mesh)) return true;
    }

    return false;
  }

  /**
   * Return whether the visible compositor output still needs the shared scene clip.
   *
   * Scene-level filters using the direct local clip path already apply their own live scene rectangle during the stack pass, so the final output does not need another scene-bound mask for those rows. Particle rows can still rely on the final output clip when no shared scene-mask bundle is active, which is the ordinary plain-scene case with no suppression or below-object masking.
   *
   * @param {{ kind?: string }|null|undefined} row
   * @returns {boolean}
   */
  #rowNeedsOutputSceneMask(row) {
    if (row?.kind === "particle") return true;
    if (row?.kind === "filter") return !this.#rowUsesDirectSceneFilterClip(row);
    return false;
  }

  /**
   * Resolve a row scope, including transient rows that predate explicit scope fields.
   *
   * @param {object|null|undefined} row
   * @returns {"scene"|"region"|string|null}
   */
  #getRowScope(row) {
    if (row?.scope) return row.scope;
    const uid = typeof row?.uid === "string" ? row.uid : "";
    if (uid.startsWith("scene:")) return "scene";
    if (uid.startsWith("region:")) return "region";
    return null;
  }

  /**
   * Return whether a numeric or string blend mode is the PIXI normal blend mode.
   *
   * Particle emitter behavior configs use strings such as "screen" while the live display tree uses PIXI blend-mode constants. The transparent particle-only paths are only equivalent for rows that remain normal-blended all the way through the emitter.
   *
   * @param {number|string|null|undefined} value
   * @returns {boolean}
   */
  #isNormalBlendMode(value) {
    if (value === undefined || value === null || value === "") return true;
    if (typeof value === "string") {
      const text = value.trim().toLowerCase();
      if (!text) return true;
      if (text === "normal") return true;
      const numeric = Number(text);
      return Number.isFinite(numeric) && numeric === PIXI.BLEND_MODES.NORMAL;
    }

    return Number(value) === PIXI.BLEND_MODES.NORMAL;
  }

  /**
   * Return whether a particle runtime can safely use transparent contribution rendering.
   *
   * @param {object|null|undefined} runtime
   * @returns {boolean}
   */
  #particleRuntimeUsesOnlyNormalBlend(runtime) {
    if (!runtime) return false;

    const fx = runtime?.fx ?? runtime?.slot ?? null;
    if (!fx || !this.#isNormalBlendMode(fx?.blendMode)) return false;

    const defaultConfig = fx?.constructor?.defaultConfig ?? null;
    if (defaultConfig && !this.#isNormalBlendMode(defaultConfig?.blendMode)) return false;

    const behaviors = Array.isArray(defaultConfig?.behaviors) ? defaultConfig.behaviors : [];
    for (const behavior of behaviors) {
      if (behavior?.type !== "blendMode") continue;
      if (!this.#isNormalBlendMode(behavior?.config?.blendMode)) return false;
    }

    return true;
  }

  /**
   * Return whether the current stack can skip the full environment capture and render as a transparent particle overlay.
   *
   * This is intentionally limited to scene-scoped normal-blend particle rows. Rendering normal particles into a transparent texture and presenting that texture over the live scene is equivalent to baking them into a captured scene frame, while avoiding a full scene capture every particle tick. Additive/screen/custom blend particles keep the full-frame path so their blend math remains baked against the scene behind them.
   *
   * @param {Array<object>} rows
   * @returns {boolean}
   */
  #canUseTransparentParticleOnlyPass(rows = []) {
    if (!Array.isArray(rows) || !rows.length) return false;
    if (this.#selectedLevelViewportMovedThisFrame()) return false;

    let hasParticleRow = false;

    for (const row of rows) {
      if (this.#rowIsSuppressionOperator(row)) continue;
      if (row?.kind !== "particle" || this.#getRowScope(row) !== "scene") return false;
      if (this.#rowUsesSelectedLevelSurfaceMask(row) || this.#rowHasLevelLimitedOutput(row)) return false;

      const runtime = row?.uid ? this.#resolveParticleRuntime(row.uid) : null;
      if (!runtime) return false;

      if (!this.#particleRuntimeUsesOnlyNormalBlend(runtime)) return false;
      hasParticleRow = true;
    }

    return hasParticleRow;
  }

  /**
   * Return whether a selected-Level scene particle can be rendered as transparent contribution pixels.
   *
   * @param {object|null|undefined} row
   * @param {{ selectedParticleMaskOverride?: PIXI.Texture|PIXI.RenderTexture|null, weatherMaskTexture?: PIXI.Texture|PIXI.RenderTexture|null, wantsBelowForeground?: boolean, useParticleTileRestore?: boolean }} [options]
   * @returns {boolean}
   */
  #canUseTransparentSelectedParticleContribution(
    row,
    {
      selectedParticleMaskOverride = null,
      weatherMaskTexture = null,
      wantsBelowForeground = false,
      useParticleTileRestore = false,
    } = {},
  ) {
    if (row?.kind !== "particle" || this.#getRowScope(row) !== "scene") return false;
    if (!this._particleMaskScratchRT || !selectedParticleMaskOverride || selectedParticleMaskOverride.destroyed)
      return false;
    if (weatherMaskTexture || wantsBelowForeground || useParticleTileRestore) return false;

    const runtime = row?.uid ? this.#resolveParticleRuntime(row.uid) : null;
    return this.#particleRuntimeUsesOnlyNormalBlend(runtime);
  }

  /**
   * Return whether a Region particle row can render only its transparent contribution before Level draw-order compositing.
   *
   * Region particles normally render into a full copied scene frame, then that full frame is composited back through Level masks. For normal-blend particles, rendering only transparent particle pixels is equivalent once the Level compositor applies the assigned-Level and foreground masks. This saves a full-screen copy for the Region row and avoids baking unchanged scene pixels into the row output.
   *
   * The path is intentionally limited to Region rows that already use the Level draw-order compositor. Non-normal blend modes keep the existing baked full-frame path because their blend math depends on the captured scene behind them.
   *
   * @param {object|null|undefined} row
   * @param {{ useRegionLevelDrawOrderComposite?: boolean, useParticleTileRestore?: boolean, weatherMaskTexture?: PIXI.Texture|PIXI.RenderTexture|null }} [options]
   * @returns {boolean}
   */
  #canUseTransparentRegionLevelParticleContribution(
    row,
    { useRegionLevelDrawOrderComposite = false, useParticleTileRestore = false, weatherMaskTexture = null } = {},
  ) {
    if (row?.kind !== "particle" || this.#getRowScope(row) !== "region") return false;
    if (!useRegionLevelDrawOrderComposite || !this._particleMaskScratchRT) return false;
    if (useParticleTileRestore || weatherMaskTexture) return false;

    const runtime = row?.uid ? this.#resolveParticleRuntime(row.uid) : null;
    return this.#particleRuntimeUsesOnlyNormalBlend(runtime);
  }

  /**
   * Return whether a scene particle row can receive the selected-Level mask directly while rendering.
   *
   * Applying the Level mask at the particle container prevents full-scene particle shading for ordinary selected-Level weather. Rows that need token/tile/suppression masks keep the existing compositor-only path because those cutouts must be combined with the Level mask instead of replaced by it.
   *
   * @param {object|null|undefined} row
   * @returns {boolean}
   */
  #rowCanUseParticleSelectedLevelMaskOverride(row) {
    if (row?.kind !== "particle" || this.#getRowScope(row) !== "scene") return false;
    if (!this.#rowUsesSelectedLevelSurfaceMask(row)) return false;
    if (this.#rowWantsBelowTokens(row) || this.#rowWantsBelowTiles(row)) return false;

    const allowedLevelIds = this.#getRowAllowedLevelIds(row);
    if (!(allowedLevelIds?.size > 0)) return false;

    /**
     * Keep the direct particle-container mask only for the simple "current Level only" case. Multi-Level selections and visible non-current overlays need the screen-space selected-Level compositor so the rendered particle contribution is applied back through native Level draw order. This avoids stale or mis-projected particle masks on overhead Level surfaces after switching viewed Levels.
     */
    if (allowedLevelIds.size !== 1) return false;
    const [levelId] = Array.from(allowedLevelIds);
    if (!this.#levelIsCurrentCanvasView(levelId)) return false;

    return !this.#rowHasRelevantSuppressionRegions(row, "particles");
  }

  /**
   * Return whether a filter requests below-tokens composition.
   *
   * @param {PIXI.Filter|null|undefined} filter
   * @returns {boolean}
   */
  #filterWantsBelowTokens(filter) {
    return this.#resolveBooleanOption(filter?.__fxmBelowTokens ?? filter?.options?.belowTokens);
  }

  /**
   * Return the live particle runtime for a stack uid.
   *
   * @param {string} uid
   * @returns {object|null}
   */
  #resolveParticleRuntime(uid) {
    return canvas?.particleeffects?.getStackParticleRuntime?.(uid) ?? null;
  }

  /**
   * Return image source paths configured directly on a native Scene Level.
   *
   * @param {string|null|undefined} levelId
   * @param {{ foregroundOnly?: boolean }} [options]
   * @returns {string[]}
   */
  #getConfiguredLevelImageSources(levelId, { foregroundOnly = false } = {}) {
    const level = this.#getSceneLevelById(levelId);
    if (!level) return [];

    const sources = [];
    const seen = new Set();
    for (const entry of fxmGetLevelImagePaths(level, {
      foregroundOnly,
      scene: level?.parent ?? canvas?.scene ?? null,
    })) {
      const key = normalizeComparableSourcePath(entry);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      sources.push(entry);
    }

    return sources;
  }
  /**
   * Render configured Level image sources into a viewport mask.
   *
   * Current-view Level backgrounds/foregrounds are not always exposed as live overlay meshes in V14. This fallback lets a selected current Level still receive FX on its authored artwork without broadening non-current overlay masks away from the live meshes that carry reveal/cutout state.
   *
   * @param {string|null|undefined} levelId
   * @param {PIXI.RenderTexture|null|undefined} renderTexture
   * @param {{ foregroundOnly?: boolean, clear?: boolean, binary?: boolean, allowSceneRectFallback?: boolean }} [options]
   * @returns {boolean}
   */
  #renderConfiguredLevelImageMask(
    levelId,
    renderTexture,
    { foregroundOnly = false, clear = true, binary = true, allowSceneRectFallback = false } = {},
  ) {
    const renderer = canvas?.app?.renderer;
    const sprite = this._foregroundMaskSprite;
    if (!renderer || !renderTexture || !sprite) return false;

    if (clear && !this.#clearRenderTexture(renderTexture)) return false;

    const sources = this.#getConfiguredLevelImageSources(levelId, { foregroundOnly });
    if (!sources.length) return false;

    const previousFilters = sprite.filters ?? null;
    const previousTexture = sprite.texture ?? null;
    const maskFilter = binary ? this.#getBinaryMaskFilter() : null;
    let rendered = false;

    try {
      sprite.alpha = 1;
      sprite.tint = 0xffffff;
      sprite.visible = true;
      sprite.renderable = true;
      sprite.filters = maskFilter ? [maskFilter] : null;

      for (const src of sources) {
        const texture = PIXI.Texture.from(src);
        const baseTexture = texture?.baseTexture ?? null;
        const isReady =
          !!texture && !texture.destroyed && !!baseTexture && !baseTexture.destroyed && baseTexture.valid !== false;
        if (!isReady) continue;

        const rect = this.#getConfiguredLevelImageScreenRect(levelId, {
          foregroundOnly,
          texture,
          allowSceneRectFallback,
        });
        if (!rect) continue;

        sprite.texture = texture;
        sprite.position.set(rect.left, rect.top);
        sprite.scale.set(1, 1);
        sprite.width = rect.width;
        sprite.height = rect.height;
        renderer.render(sprite, {
          renderTexture,
          clear: false,
          skipUpdateTransform: false,
        });
        rendered = true;
      }
    } catch (err) {
      logger.debug("FXMaster:", err);
    } finally {
      try {
        sprite.filters = previousFilters;
        sprite.texture = previousTexture ?? PIXI.Texture.EMPTY;
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    return rendered;
  }

  /**
   * Coerce a value into a finite number, returning null for absent or invalid values.
   *
   * @param {*} value
   * @returns {number|null}
   */
  #finiteNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  /**
   * Return the first finite numeric candidate.
   *
   * @param {...*} values
   * @returns {number|null}
   */
  #firstFiniteNumber(...values) {
    for (const value of values) {
      const number = this.#finiteNumber(value);
      if (number !== null) return number;
    }
    return null;
  }

  /**
   * Resolve a rectangle-like value from common Foundry/PIXI shape fields.
   *
   * @param {*} value
   * @param {Set<object>} [visited]
   * @returns {{x:number,y:number,width:number,height:number}|null}
   */
  #extractRectLike(value, visited = new Set()) {
    if (!value || (typeof value !== "object" && typeof value !== "function")) return null;
    if (visited.has(value)) return null;
    visited.add(value);

    const x = this.#firstFiniteNumber(value.x, value.left, value.minX);
    const y = this.#firstFiniteNumber(value.y, value.top, value.minY);
    let width = this.#firstFiniteNumber(value.width, value.w);
    let height = this.#firstFiniteNumber(value.height, value.h);

    const right = this.#firstFiniteNumber(value.right, value.maxX);
    const bottom = this.#firstFiniteNumber(value.bottom, value.maxY);
    if (width === null && x !== null && right !== null) width = right - x;
    if (height === null && y !== null && bottom !== null) height = bottom - y;

    if (x !== null && y !== null && width !== null && height !== null && width > 0 && height > 0) {
      return { x, y, width, height };
    }

    for (const key of [
      "bounds",
      "localBounds",
      "worldBounds",
      "sceneRect",
      "rect",
      "rectangle",
      "dimensions",
      "frame",
    ]) {
      const nested = value?.[key];
      if (nested && nested !== value) {
        const rect = this.#extractRectLike(nested, visited);
        if (rect) return rect;
      }
    }

    return null;
  }

  /**
   * Return probable Level texture placement data objects.
   *
   * @param {foundry.documents.Level|null|undefined} level
   * @param {{ foregroundOnly?: boolean }} [options]
   * @returns {object[]}
   */
  #getConfiguredLevelTexturePlacementCandidates(level, { foregroundOnly = false } = {}) {
    if (!level) return [];
    return fxmGetLevelImageCandidates(level, { foregroundOnly }).filter(
      (candidate) => candidate && (typeof candidate === "object" || typeof candidate === "function"),
    );
  }
  /**
   * Resolve configured Level artwork bounds in scene/world coordinates without assuming the artwork spans the whole scene.
   *
   * @param {string|null|undefined} levelId
   * @param {PIXI.Texture|null|undefined} texture
   * @param {{ foregroundOnly?: boolean }} [options]
   * @returns {{x:number,y:number,width:number,height:number}|null}
   */
  #resolveConfiguredLevelImageWorldRect(levelId, texture = null, { foregroundOnly = false } = {}) {
    const level = this.#getSceneLevelById(levelId);
    if (!level) return null;

    const candidates = this.#getConfiguredLevelTexturePlacementCandidates(level, { foregroundOnly });
    for (const candidate of candidates) {
      const rect = this.#extractRectLike(candidate);
      if (rect) return rect;
    }

    const baseTexture = texture?.baseTexture ?? null;
    const textureWidth = this.#firstFiniteNumber(
      texture?.orig?.width,
      texture?.frame?.width,
      texture?.width,
      baseTexture?.realWidth,
      baseTexture?.width,
    );
    const textureHeight = this.#firstFiniteNumber(
      texture?.orig?.height,
      texture?.frame?.height,
      texture?.height,
      baseTexture?.realHeight,
      baseTexture?.height,
    );

    for (const candidate of candidates) {
      const position =
        candidate?.position ?? candidate?.offset ?? candidate?.translation ?? candidate?.translate ?? null;
      const size = candidate?.size ?? candidate?.dimensions ?? candidate?.scale ?? null;
      const x = this.#firstFiniteNumber(
        candidate?.x,
        candidate?.offsetX,
        candidate?.left,
        candidate?.minX,
        position?.x,
        position?.left,
        level?.x,
      );
      const y = this.#firstFiniteNumber(
        candidate?.y,
        candidate?.offsetY,
        candidate?.top,
        candidate?.minY,
        position?.y,
        position?.top,
        level?.y,
      );
      let width = this.#firstFiniteNumber(
        candidate?.width,
        candidate?.w,
        candidate?.sizeX,
        candidate?.scaleWidth,
        size?.width,
        size?.w,
      );
      let height = this.#firstFiniteNumber(
        candidate?.height,
        candidate?.h,
        candidate?.sizeY,
        candidate?.scaleHeight,
        size?.height,
        size?.h,
      );
      const scaleX = this.#firstFiniteNumber(candidate?.scaleX, candidate?.scale?.x, size?.x, candidate?.scale);
      const scaleY = this.#firstFiniteNumber(candidate?.scaleY, candidate?.scale?.y, size?.y, candidate?.scale);

      if (width === null && textureWidth !== null && scaleX !== null) width = Math.abs(textureWidth * scaleX);
      if (height === null && textureHeight !== null && scaleY !== null) height = Math.abs(textureHeight * scaleY);

      if (width !== null && height !== null && width > 0 && height > 0) {
        const sceneRect = canvas?.dimensions?.sceneRect ?? null;
        return {
          x: x ?? (Number(sceneRect?.x) || 0),
          y: y ?? (Number(sceneRect?.y) || 0),
          width,
          height,
        };
      }
    }

    return null;
  }

  /**
   * Convert scene/world artwork bounds into viewport-space render bounds.
   *
   * @param {string|null|undefined} levelId
   * @param {{ texture?: PIXI.Texture|null, foregroundOnly?: boolean, allowSceneRectFallback?: boolean }} [options]
   * @returns {{left:number,top:number,width:number,height:number}|null}
   */
  #getConfiguredLevelImageScreenRect(
    levelId,
    { texture = null, foregroundOnly = false, allowSceneRectFallback = false } = {},
  ) {
    let worldRect = this.#resolveConfiguredLevelImageWorldRect(levelId, texture, { foregroundOnly });
    if (!worldRect && allowSceneRectFallback && this.#allowConfiguredLevelImageSceneRectFallback(texture)) {
      const sceneRect = canvas?.dimensions?.sceneRect ?? null;
      worldRect = this.#extractRectLike(sceneRect);
    }
    if (!worldRect) return null;

    const stageMatrix = this.#currentLiveStageMatrix();
    const p0 = stageMatrix.apply(new PIXI.Point(worldRect.x, worldRect.y), new PIXI.Point());
    const p1 = stageMatrix.apply(
      new PIXI.Point(worldRect.x + worldRect.width, worldRect.y + worldRect.height),
      new PIXI.Point(),
    );
    const left = Math.min(p0.x, p1.x);
    const top = Math.min(p0.y, p1.y);
    const right = Math.max(p0.x, p1.x);
    const bottom = Math.max(p0.y, p1.y);
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);
    return width > 0 && height > 0 ? { left, top, width, height } : null;
  }

  /**
   * Return whether FXMaster may use the scene rectangle as the placement for a configured Level background/foreground image when Foundry does not expose a live mesh or public placement metadata. Native V14 Level artwork is commonly authored as a scene-sized transparent image; using its alpha channel is still much narrower than allowing same-Level Tile silhouettes to define coverage.
   *
   * @param {PIXI.Texture|null|undefined} [texture=null]
   * @returns {boolean}
   */
  #allowConfiguredLevelImageSceneRectFallback(texture = null) {
    if (CONFIG?.fxmaster?.overheadPerformance?.configuredLevelImageSceneRectFallback === false) return false;

    const sceneRect = canvas?.dimensions?.sceneRect ?? null;
    const width = Number(sceneRect?.width ?? canvas?.dimensions?.sceneWidth ?? canvas?.scene?.width ?? Number.NaN);
    const height = Number(sceneRect?.height ?? canvas?.dimensions?.sceneHeight ?? canvas?.scene?.height ?? Number.NaN);
    if (!(Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0)) return false;

    if (!texture) return true;
    const baseTexture = texture?.baseTexture ?? null;
    if (!baseTexture || baseTexture.destroyed || baseTexture.valid === false) return false;

    const textureWidth = this.#firstFiniteNumber(
      texture?.orig?.width,
      texture?.frame?.width,
      texture?.width,
      baseTexture?.realWidth,
      baseTexture?.width,
    );
    const textureHeight = this.#firstFiniteNumber(
      texture?.orig?.height,
      texture?.frame?.height,
      texture?.height,
      baseTexture?.realHeight,
      baseTexture?.height,
    );
    if (!(textureWidth > 0 && textureHeight > 0)) return true;

    const sceneAspect = width / height;
    const textureAspect = textureWidth / textureHeight;
    if (!(Number.isFinite(sceneAspect) && sceneAspect > 0 && Number.isFinite(textureAspect) && textureAspect > 0))
      return true;

    /**
     * Exact dimensions can differ slightly because of WebP metadata, canvas padding, or device-pixel scaling. Aspect-ratio matching is enough to avoid obviously unrelated portrait/sprite assets being stretched into a Level coverage mask.
     */
    return Math.abs(sceneAspect - textureAspect) <= 0.02;
  }

  /**
   * Return whether configured Level artwork can be rendered into a mask.
   *
   * @param {string|null|undefined} levelId
   * @param {{ foregroundOnly?: boolean, allowSceneRectFallback?: boolean }} [options]
   * @returns {boolean}
   */
  #configuredLevelImageMaskBoundsAvailable(levelId, { foregroundOnly = false, allowSceneRectFallback = false } = {}) {
    if (!levelId || !this.#getConfiguredLevelImageSources(levelId, { foregroundOnly }).length) return false;
    const levelIds = new Set([levelId]);
    if (this.#collectConfiguredLevelTextureObjectsForLevelIds(levelIds, { foregroundOnly }).length) return true;
    if (this.#resolveConfiguredLevelImageWorldRect(levelId, null, { foregroundOnly })) return true;

    for (const src of this.#getConfiguredLevelImageSources(levelId, { foregroundOnly })) {
      try {
        const texture = PIXI.Texture.from(src);
        const baseTexture = texture?.baseTexture ?? null;
        if (!texture || texture.destroyed || !baseTexture || baseTexture.destroyed || baseTexture.valid === false)
          continue;
        if (this.#resolveConfiguredLevelImageWorldRect(levelId, texture, { foregroundOnly })) return true;
        if (allowSceneRectFallback && this.#allowConfiguredLevelImageSceneRectFallback(texture)) return true;
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    return false;
  }

  /**
   * Render the active scene or level foreground image into a viewport-sized alpha mask texture.
   *
   * @returns {PIXI.RenderTexture|null}
   */
  #getForegroundMaskTexture() {
    if (this._foregroundMaskFrameSerial === this._renderFrameSerial) return this._foregroundMaskFrameTexture ?? null;

    const remember = (value) => {
      this._foregroundMaskFrameSerial = this._renderFrameSerial;
      this._foregroundMaskFrameTexture = value ?? null;
      return value ?? null;
    };

    const renderer = canvas?.app?.renderer;
    const renderTexture = this._foregroundMaskRT;
    const sprite = this._foregroundMaskSprite;
    const dimensions = canvas?.dimensions;
    const sceneRect = dimensions?.sceneRect ?? null;
    const src = getActiveForegroundImagePath();
    if (!renderer || !renderTexture || !sprite || !sceneRect || !src) return remember(null);

    const texture =
      canvas?.foreground?.bg?.texture ?? canvas?.foreground?.background?.texture ?? PIXI.Texture.from(src);
    const baseTexture = texture?.baseTexture ?? null;
    const isReady =
      !!texture && !texture.destroyed && !!baseTexture && !baseTexture.destroyed && baseTexture.valid !== false;

    if (!this.#clearRenderTexture(renderTexture)) return remember(null);

    if (!isReady) return remember(renderTexture);

    const stageMatrix = this.#currentLiveStageMatrix();
    const x0 = Number(sceneRect.x) || 0;
    const y0 = Number(sceneRect.y) || 0;
    const x1 = x0 + (Number(sceneRect.width) || 0);
    const y1 = y0 + (Number(sceneRect.height) || 0);

    const p0 = stageMatrix.apply(new PIXI.Point(x0, y0), new PIXI.Point());
    const p1 = stageMatrix.apply(new PIXI.Point(x1, y1), new PIXI.Point());

    const left = Math.min(p0.x, p1.x);
    const top = Math.min(p0.y, p1.y);
    const right = Math.max(p0.x, p1.x);
    const bottom = Math.max(p0.y, p1.y);
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);
    if (width <= 0 || height <= 0) return remember(renderTexture);

    const previousFilters = sprite.filters ?? null;
    const maskFilter = this.#getBinaryMaskFilter();

    sprite.texture = texture;
    sprite.position.set(left, top);
    sprite.scale.set(1, 1);
    sprite.width = width;
    sprite.height = height;
    sprite.alpha = 1;
    sprite.tint = 0xffffff;
    sprite.visible = true;
    sprite.renderable = true;
    sprite.filters = maskFilter ? [maskFilter] : null;

    try {
      renderer.render(sprite, {
        renderTexture,
        clear: false,
        skipUpdateTransform: false,
      });
      return remember(renderTexture);
    } catch (err) {
      logger.debug("FXMaster:", err);
      return remember(null);
    } finally {
      try {
        sprite.filters = previousFilters;
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
  }

  /**
   * Return a binary foreground coverage mask for the visible V14 Level stack.
   *
   * Below Foreground should protect the foregrounds that are actually visible on any active Level, not only the foreground image for the currently viewed Level. For each visible Level, the compositor captures that Level's foreground coverage, removes unrevealed higher-Level surfaces from that Level-local mask, then unions the result into one restore mask. The mask is intentionally binary so filtered pixels are fully restored anywhere foreground coverage exists.
   *
   * @returns {PIXI.RenderTexture|null}
   */
  #getForegroundVisibleMaskTexture() {
    if (this._foregroundVisibleMaskFrameSerial === this._renderFrameSerial) {
      return this._foregroundVisibleMaskFrameTexture ?? null;
    }

    const remember = (value) => {
      this._foregroundVisibleMaskFrameSerial = this._renderFrameSerial;
      this._foregroundVisibleMaskFrameTexture = value ?? null;
      return value ?? null;
    };

    if (!canvas?.level) return remember(this.#getForegroundMaskTexture());

    const foregroundMaskRT = this._foregroundMaskRT;
    const levelForegroundScratchRT = this._foregroundVisibleMaskRT;
    const upperSurfaceMaskRT = this._foregroundUpperVisibleRT;
    if (!foregroundMaskRT || !levelForegroundScratchRT || !upperSurfaceMaskRT) {
      return remember(this.#getForegroundMaskTexture());
    }

    if (!this.#clearRenderTexture(foregroundMaskRT)) return remember(null);

    let rendered = false;
    for (const levelId of this.#getVisibleSceneLevelIdsInDrawOrder()) {
      const level = this.#getSceneLevelById(levelId);
      if (!(level?.isVisible || level?.isView)) continue;

      const capturedForeground = this.#captureLevelSurfaceMask(levelId, levelForegroundScratchRT, {
        foregroundOnly: true,
        binary: true,
        clear: true,
      });
      if (!capturedForeground) continue;

      const protectedLevelIds = new Set([levelId]);
      const upperObjects = this.#collectUpperSurfaceObjectsForTargetLevel(level, { protectedLevelIds });
      if (upperObjects.length) {
        const capturedUpper = this.#captureSurfaceMaskTexture(upperObjects, upperSurfaceMaskRT, { clear: true });
        if (capturedUpper) this.#eraseTextureFromRenderTexture(upperSurfaceMaskRT, levelForegroundScratchRT);
      }

      this.#blit(levelForegroundScratchRT, foregroundMaskRT, { clear: false });
      rendered = true;
    }

    if (rendered) return remember(foregroundMaskRT);
    return remember(this.#getForegroundMaskTexture());
  }

  /**
   * Erase the alpha of one texture from an existing render texture in-place.
   *
   * @param {PIXI.Texture|PIXI.RenderTexture|null} eraseTexture
   * @param {PIXI.RenderTexture|null} output
   * @returns {void}
   */
  #eraseTextureFromRenderTexture(eraseTexture, output) {
    if (!eraseTexture || !output || !this._blitSprite || !canvas?.app?.renderer) return;

    let eraseSourceTexture = eraseTexture;
    if (this.#texturesShareBaseTexture(eraseSourceTexture, output)) {
      if (!this._maskIntersectionRT || this.#texturesShareBaseTexture(this._maskIntersectionRT, output)) return;
      this.#blit(eraseSourceTexture, this._maskIntersectionRT, { clear: true });
      eraseSourceTexture = this._maskIntersectionRT;
    }

    const sprite = this._blitSprite;
    const { width, height } = this.#getViewportMetrics();
    const previousBlendMode = sprite.blendMode;
    const previousAlpha = sprite.alpha;
    sprite.texture = eraseSourceTexture;
    sprite.position.set(0, 0);
    sprite.scale.set(1, 1);
    sprite.width = width;
    sprite.height = height;
    sprite.filters = null;
    sprite.alpha = 1;
    sprite.blendMode = PIXI.BLEND_MODES.ERASE;

    try {
      canvas.app.renderer.render(sprite, {
        renderTexture: output,
        clear: false,
        skipUpdateTransform: false,
      });
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
   * Resolve the native depth-occlusion elevation for a compositor row.
   *
   * @param {{ kind?: string, uid?: string }|null|undefined} row
   * @returns {number}
   */
  #resolveOcclusionElevationForRow(row) {
    const fallbackElevation = Number(canvas?.particleeffects?.elevation);
    const fallback = Number.isFinite(fallbackElevation) ? fallbackElevation : Infinity;

    const regionDocument = this.#getRowScope(row) === "region" ? this.#getRegionDocumentForRow(row) : null;

    return resolveDocumentOcclusionElevation(regionDocument, {
      fallback,
      preferForeground: this.#rowWantsBelowForeground(row),
    });
  }

  /**
   * Resolve the Region document owned by a compositor row.
   *
   * @param {{ ownerId?: string, regionId?: string }|null|undefined} row
   * @returns {foundry.documents.Region|null}
   */
  #getRegionDocumentForRow(row) {
    const regionId = row?.ownerId ?? row?.regionId ?? null;
    if (!regionId) return null;

    const live = canvas?.regions?.get?.(regionId) ?? null;
    if (live?.document) return live.document;

    return getSceneRegionDocumentById(regionId, canvas?.scene ?? null);
  }

  /**
   * Resolve the Region placeable or document-backed adapter owned by a compositor row.
   *
   * Region rows assigned only to a non-current visible upper Level may not have a live Region placeable in Foundry's current canvas view, but they still need to pass behavior gates and resolve their assigned Level ids.
   *
   * @param {{ ownerId?: string, regionId?: string }|null|undefined} row
   * @returns {PlaceableObject|{id:string, document: foundry.documents.Region, _fxmDocumentRegionAdapter: true}|null}
   */
  #getRegionPlaceableForRow(row) {
    const regionId = row?.ownerId ?? row?.regionId ?? null;
    if (!regionId) return null;

    const live = canvas?.regions?.get?.(regionId) ?? null;
    if (live) return live;

    return getRegionPlaceableOrDocumentAdapter(this.#getRegionDocumentForRow(row));
  }

  /**
   * Return the bottom elevation for a Level document.
   *
   * @param {foundry.documents.Level|null|undefined} level
   * @returns {number}
   */
  #getLevelBottom(level) {
    return fxmLevelBottom(level);
  }

  /**
   * Return the top elevation for a Level document.
   *
   * @param {foundry.documents.Level|null|undefined} level
   * @returns {number}
   */
  #getLevelTop(level) {
    return fxmLevelTop(level);
  }

  /**
   * Return whether one level should be treated as above another.
   *
   * @param {foundry.documents.Level|null|undefined} candidate
   * @param {foundry.documents.Level|null|undefined} target
   * @returns {boolean}
   */
  #levelIsAboveTargetLevel(candidate, target) {
    return fxmLevelIsAbove(candidate, target);
  }

  /**
   * Return whether a selected native Scene Level can legitimately be rendered in the current Level view.
   *
   * V14 can expose lower and upper Level surfaces at the same time. Scene rows with explicit Level ids should keep rendering for any selected Level that is still visibly present. The compositor handles draw-order restoration so non-selected Levels between selected segments remain excluded.
   *
   * @param {foundry.documents.Level|null|undefined} level
   * @returns {boolean}
   */
  #levelCanRenderInCurrentViewForSceneRow(level) {
    if (!level) return false;

    const currentLevel = getCanvasLevel();
    if (!currentLevel?.id) return true;
    if (level.id && level.id === currentLevel.id) return true;
    return this.#levelIsVisibleForCompositing(level, { includeTiles: true, strictLevelIdentity: true });
  }

  /**
   * Return whether the row's explicit Scene Level selection is eligible to render in the current view.
   *
   * @param {object|null|undefined} row
   * @returns {boolean}
   */
  #rowLevelSelectionCanRenderInCurrentView(row) {
    const rowScope = this.#getRowScope(row);
    if (rowScope !== "scene" && rowScope !== "region") return true;

    const allowedLevelIds = this.#getRowAllowedLevelIds(row);
    if (rowScope === "region" && allowedLevelIds instanceof Set && allowedLevelIds.size === 0) return false;
    if (!(allowedLevelIds?.size > 0)) return true;

    const currentLevel = getCanvasLevel();
    if (!currentLevel?.id) return true;
    if (allowedLevelIds.has(currentLevel.id)) return true;

    if (rowScope === "region") {
      return (
        this.#collectVisibleSurfaceObjectsForLevelIds(allowedLevelIds, {
          includeTiles: true,
          strictLevelIdentity: true,
        }).length > 0
      );
    }

    for (const levelId of allowedLevelIds) {
      const level = this.#getSceneLevelById(levelId);
      if (this.#levelCanRenderInCurrentViewForSceneRow(level)) return true;
    }

    return false;
  }

  /**
   * Resolve the level-local target used for Region-scoped compositor rows.
   *
   * Region rows should sample their source frame from the Region's assigned/viewed level, while any visible Scene Levels above that level are composited back on top afterward.
   *
   * @param {object|null|undefined} row
   * @returns {foundry.documents.Level|null}
   */
  #resolveRegionLocalTargetLevel(row) {
    const currentLevel = getCanvasLevel();
    if (!currentLevel) return null;

    const regionDoc = this.#getRegionDocumentForRow(row);
    if (!regionDoc) return currentLevel;

    const sceneLevels = getSceneLevelDocuments(canvas?.scene ?? null);
    const regionLevels = getDocumentAssignedLevelIds(regionDoc, regionDoc?.parent ?? canvas?.scene ?? null);
    if (regionLevels?.size) {
      if (currentLevel?.id && regionLevels.has(currentLevel.id)) return currentLevel;

      const preferred = sceneLevels.find((level) => regionLevels.has(level?.id) && (level?.isView || level?.isVisible));
      if (preferred) return preferred;

      const assigned = sceneLevels.find((level) => regionLevels.has(level?.id));
      if (assigned) return assigned;
    }

    const window = getRegionElevationWindow(regionDoc);
    if (window) {
      const currentBottom = this.#getLevelBottom(currentLevel);
      const currentTop = this.#getLevelTop(currentLevel);
      const overlapsCurrent =
        (!Number.isFinite(window.min) || !Number.isFinite(currentTop) || currentTop >= window.min - 1e-4) &&
        (!Number.isFinite(window.max) || !Number.isFinite(currentBottom) || currentBottom <= window.max + 1e-4);
      if (overlapsCurrent) return currentLevel;
    }

    const inferredElevation = Number.isFinite(Number(window?.min))
      ? Number(window.min)
      : Number(regionDoc?.elevation?.bottom ?? regionDoc?.elevation ?? Number.NaN);
    return inferVisibleLevelForDocument(regionDoc, inferredElevation) ?? currentLevel;
  }

  /**
   * Normalize the scene level collection to an array.
   *
   * @returns {foundry.documents.Level[]}
   */
  #getSceneLevels() {
    if (this._sceneLevelsFrameSerial === this._renderFrameSerial && Array.isArray(this._sceneLevelsFrameValue)) {
      return this._sceneLevelsFrameValue;
    }

    const levels = getSceneLevelDocuments(canvas?.scene ?? null);
    this._sceneLevelsFrameSerial = this._renderFrameSerial;
    this._sceneLevelsFrameValue = levels;
    this._sceneLevelByIdFrameSerial = -1;
    this._sceneLevelByIdFrameMap = null;
    return levels;
  }

  /**
   * Resolve a scene Level document by id.
   *
   * @param {string|null|undefined} levelId
   * @returns {foundry.documents.Level|null}
   */
  #getSceneLevelById(levelId) {
    if (!levelId) return null;

    if (this._sceneLevelByIdFrameSerial !== this._renderFrameSerial || !this._sceneLevelByIdFrameMap) {
      const map = new Map();
      for (const level of this.#getSceneLevels()) {
        if (level?.id) map.set(level.id, level);
      }
      this._sceneLevelByIdFrameSerial = this._renderFrameSerial;
      this._sceneLevelByIdFrameMap = map;
    }

    return this._sceneLevelByIdFrameMap.get(levelId) ?? null;
  }

  /**
   * Return whether a native Scene Level has visible live surface pixels in the current view, even when Foundry has not marked the Level document as visible.
   *
   * Hover-revealed overhead Levels can expose primary surface meshes without updating Level#isVisible/Level#isView. Region rows and selected-Level rows must treat those meshes as visible so lower-Level particles/suppression do not bleed onto the revealed overlay.
   *
   * @param {foundry.documents.Level|null|undefined} level
   * @param {{ includeTiles?: boolean, strictLevelIdentity?: boolean }} [options]
   * @returns {boolean}
   */
  #levelHasVisibleSurfacePixels(level, { includeTiles = true, strictLevelIdentity = true } = {}) {
    const levelId = level?.id ?? null;
    if (!levelId || !canvas?.primary) return false;

    try {
      return (
        this.#collectVisibleSurfaceObjectsForLevelIds(new Set([levelId]), {
          includeTiles,
          strictLevelIdentity,
        }).length > 0
      );
    } catch (err) {
      logger.debug("FXMaster:", err);
      return false;
    }
  }

  /**
   * Return whether a native Scene Level should participate in draw-order compositing for this frame.
   *
   * @param {foundry.documents.Level|null|undefined} level
   * @param {{ includeTiles?: boolean, strictLevelIdentity?: boolean }} [options]
   * @returns {boolean}
   */
  #levelIsVisibleForCompositing(level, { includeTiles = true, strictLevelIdentity = true } = {}) {
    if (!level?.id) return false;
    if (level?.isVisible || level?.isView) return true;
    return this.#levelHasVisibleSurfacePixels(level, { includeTiles, strictLevelIdentity });
  }

  /**
   * Return ids for currently visible upper-level Scene Levels above a target level.
   *
   * This is a coarse fast path for Region-row restore masks. When no upper overlay surfaces are visible, it avoids the heavier per-Level surface collector and returns an empty set after a single frame-cached surface scan.
   *
   * @param {foundry.documents.Level|null|undefined} targetLevel
   * @param {{ protectedLevelIds?: Set<string>|null }} [options]
   * @returns {Set<string>}
   */
  #getVisibleOverlayLevelIdsAboveTarget(targetLevel, { protectedLevelIds = null } = {}) {
    if (!targetLevel) return new Set();

    const cacheKey = `${targetLevel?.id ?? ""}:${this.#levelIdsCacheKey(protectedLevelIds)}:visible-overlays`;
    const cache = this._visibleOverlayLevelIdsFrameCache;
    if (cache?.has(cacheKey)) return cache.get(cacheKey) ?? new Set();

    const remember = (ids) => {
      const value = ids instanceof Set ? ids : new Set();
      cache?.set(cacheKey, value);
      return value;
    };

    const candidateLevels = [];
    const visibleLevelIds = new Set();
    for (const level of this.#getSceneLevels()) {
      const levelId = level?.id ?? null;
      if (!levelId) continue;
      if (protectedLevelIds?.has(levelId)) continue;
      if (!this.#levelIsAboveTargetLevel(level, targetLevel)) continue;

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

    const allCandidatesVisible = () => visibleLevelIds.size >= candidateLevels.length;

    for (const mesh of this.#getPrimaryLevelTexturesForFrame()) {
      if (allCandidatesVisible()) break;

      const object = mesh?.object ?? null;
      const liveRenderObject = this.#resolveLiveSurfaceDisplayObject(mesh, object);
      const captureObject = this.#displayObjectContributesVisiblePixels(mesh)
        ? mesh
        : this.#displayObjectContributesVisiblePixels(liveRenderObject)
        ? liveRenderObject
        : null;
      if (!captureObject) continue;
      if (!this.#displayObjectIntersectsViewport(captureObject)) continue;

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
      this.#addStrictSurfaceLevelMatches(
        visibleLevelIds,
        { mesh, object, document, level, elevation },
        candidateLevelIds,
      );
    }

    for (const mesh of this.#getPrimaryTileMeshesForFrame()) {
      if (allCandidatesVisible()) break;

      const tileObject = fxmLinkedPlaceableFromDisplayObject(mesh);
      const liveRenderObject = this.#resolveLiveSurfaceDisplayObject(mesh, tileObject);
      const captureObject = this.#displayObjectContributesVisiblePixels(mesh)
        ? mesh
        : this.#displayObjectContributesVisiblePixels(liveRenderObject)
        ? liveRenderObject
        : null;
      if (!captureObject) continue;
      if (!this.#displayObjectIntersectsViewport(captureObject)) continue;
      if (tileObject && !this.#tileIsActiveOnCanvas(tileObject)) continue;

      const document = tileObject?.document ?? null;
      const elevation = Number(mesh?.elevation ?? document?.elevation ?? tileObject?.elevation ?? Number.NaN);
      const level = mesh?.level ?? tileObject?.level ?? document?.level ?? null;
      this.#addStrictSurfaceLevelMatches(
        visibleLevelIds,
        { mesh, object: tileObject, document: document ?? tileObject ?? null, level, elevation },
        candidateLevelIds,
      );
    }

    for (const object of this.#collectConfiguredLevelTextureObjectsForLevelIds(candidateLevelIds)) {
      if (allCandidatesVisible()) break;
      this.#addStrictSurfaceLevelMatches(visibleLevelIds, { mesh: object, object }, candidateLevelIds);
    }

    return remember(visibleLevelIds);
  }

  /**
   * Return all currently visible upper-level Scene Levels above a target level.
   *
   * Only live visible non-target levels can actually paint over a region row, so the overlay restoration path should key off that set instead of a generic elevation test.
   *
   * @param {foundry.documents.Level|null|undefined} targetLevel
   * @param {{ protectedLevelIds?: Set<string>|null }} [options]
   * @returns {foundry.documents.Level[]}
   */
  #getVisibleOverlayLevelsAboveTarget(targetLevel, { protectedLevelIds = null } = {}) {
    if (!targetLevel) return [];

    const cacheKey = `${targetLevel?.id ?? ""}:${this.#levelIdsCacheKey(protectedLevelIds)}:visible-overlay-levels`;
    const cache = this._visibleOverlayLevelsFrameCache;
    if (cache?.has(cacheKey)) return cache.get(cacheKey) ?? [];

    const visibleLevelIds = this.#getVisibleOverlayLevelIdsAboveTarget(targetLevel, { protectedLevelIds });
    const value = visibleLevelIds.size
      ? this.#getSceneLevels().filter((level) => visibleLevelIds.has(level?.id ?? null))
      : [];
    cache?.set(cacheKey, value);
    return value;
  }

  /**
   * Return a stable cache key for an unordered set of Level ids.
   *
   * @param {Set<string>|string[]|null|undefined} levelIds
   * @returns {string}
   */
  #levelIdsCacheKey(levelIds) {
    return Array.from(levelIds ?? [])
      .filter(Boolean)
      .sort()
      .join("|");
  }

  /**
   * Build a short per-frame key for visible upper surface queries.
   *
   * @param {foundry.documents.Level|null|undefined} targetLevel
   * @param {Set<string>|null|undefined} protectedLevelIds
   * @returns {string}
   */
  #upperSurfaceObjectsCacheKey(targetLevel, protectedLevelIds = null) {
    const protectedKey = Array.from(protectedLevelIds ?? [])
      .sort()
      .join("|");
    return `${targetLevel?.id ?? "none"}:${protectedKey}`;
  }

  /**
   * Return whether a live object intersects the current CSS viewport.
   *
   * Avoid rendering off-screen upper tiles into every overlay restoration texture during pan/hover frames.
   *
   * @param {PIXI.DisplayObject|null|undefined} object
   * @returns {boolean}
   */
  #displayObjectIntersectsViewport(object) {
    if (!object || object.destroyed) return false;

    const cache = this._displayObjectViewportHitFrameCache;
    if (cache?.has(object)) return cache.get(object) === true;

    const remember = (value) => {
      try {
        cache?.set(object, value === true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      return value === true;
    };

    const { width, height } = this.#getViewportMetrics();
    const padding = 8;

    try {
      const bounds = object.getBounds?.(false) ?? null;
      if (!bounds) return remember(true);
      if (bounds.x > width + padding) return remember(false);
      if (bounds.y > height + padding) return remember(false);
      if (bounds.x + bounds.width < -padding) return remember(false);
      if (bounds.y + bounds.height < -padding) return remember(false);
      return remember(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
      return remember(true);
    }
  }

  /**
   * Return whether a value is a Foundry document-like source whose elevation field should be trusted over a live mesh fallback. V14 level texture meshes expose their PrimaryCanvasGroup as object/document, and that group carries the viewed canvas elevation rather than the individual stacked level texture elevation. In those cases the mesh elevation is the authoritative stack slot.
   *
   * @param {*} value
   * @returns {boolean}
   */
  #isDocumentBackedSurface(value) {
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
   * Return a normalized elevation window for a document-backed surface.
   *
   * @param {foundry.abstract.Document|object|null|undefined} document
   * @param {number} [fallbackElevation=Number.NaN]
   * @returns {{min:number,max:number}|null}
   */
  #getSurfaceElevationWindow(document, fallbackElevation = Number.NaN) {
    const publicWindow = fxmGetDocumentElevationWindow(document, fallbackElevation);
    if (publicWindow) return publicWindow;

    const fallback = Number(fallbackElevation);
    const trustDocumentElevation = this.#isDocumentBackedSurface(document) || !Number.isFinite(fallback);
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
   * @param {foundry.documents.Level|null|undefined} level
   * @returns {boolean}
   */
  #surfaceWindowOverlapsLevel(window, level) {
    if (!window || !level) return false;

    const levelBottom = this.#getLevelBottom(level);
    const levelTop = this.#getLevelTop(level);
    const windowMin = Number(window.min);
    const windowMax = Number(window.max);

    const reachesLevelBottom =
      !Number.isFinite(windowMax) || !Number.isFinite(levelBottom) || windowMax >= levelBottom - 1e-4;
    const reachesLevelTop = !Number.isFinite(windowMin) || !Number.isFinite(levelTop) || windowMin <= levelTop + 1e-4;
    return reachesLevelBottom && reachesLevelTop;
  }

  /**
   * Add any scene Level ids represented by an arbitrary value into an output set.
   *
   * @param {*} value
   * @param {Set<string>} output
   * @param {Set<object>} [seen]
   * @returns {void}
   */
  #addSceneLevelIdsFromValue(value, output, seen = new Set()) {
    if (!value || !output) return;

    if (typeof value === "string") {
      if (this.#getSceneLevelById(value)) output.add(value);
      return;
    }

    if ((typeof value === "object" || typeof value === "function") && seen.has(value)) return;
    if (typeof value === "object" || typeof value === "function") seen.add(value);

    if (Array.isArray(value)) {
      for (const entry of value) this.#addSceneLevelIdsFromValue(entry, output, seen);
      return;
    }

    if (value instanceof Set || (typeof value?.[Symbol.iterator] === "function" && typeof value !== "string")) {
      try {
        for (const entry of value) this.#addSceneLevelIdsFromValue(entry, output, seen);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    const candidateId = fxmDocumentId(value) || fxmDocumentId(value?.document) || null;
    if (candidateId && this.#getSceneLevelById(candidateId)) output.add(candidateId);

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
      this.#addSceneLevelIdsFromValue(entry, output, seen);
    }
  }

  /**
   * Resolve the scene Level ids a live surface explicitly targets.
   *
   * @param {{ mesh?: object|null, object?: object|null, document?: foundry.abstract.Document|null, level?: object|null }} options
   * @returns {Set<string>}
   */
  #resolveSurfaceLevelIds({ mesh = null, object = null, document = null, level = null } = {}) {
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
    for (const candidate of candidates) this.#addSceneLevelIdsFromValue(candidate, ids);

    const directLevels = getDocumentLevelsSet(document ?? object ?? null);
    if (directLevels?.size) {
      for (const levelId of directLevels) {
        if (this.#getSceneLevelById(levelId)) ids.add(levelId);
      }
    }

    return ids;
  }

  /**
   * Return whether two Level id sets intersect.
   *
   * @param {Set<string>} surfaceLevelIds
   * @param {Set<string>} candidateLevelIds
   * @returns {boolean}
   */
  #surfaceLevelIdsIntersect(surfaceLevelIds, candidateLevelIds) {
    if (!(surfaceLevelIds?.size > 0) || !(candidateLevelIds?.size > 0)) return false;

    for (const levelId of surfaceLevelIds) {
      if (candidateLevelIds.has(levelId)) return true;
    }
    return false;
  }

  /**
   * Return whether a tile-like surface has an explicit multi-Level assignment that intersects the supplied Level ids.
   *
   * Most overhead-protection paths intentionally use visual/elevation identity for broad multi-Level tiles so a Level 2 Region cannot draw over a Level 3 canopy. Scene rows are different: if a user explicitly assigns a tile to Levels 1, 2, and 3 and assigns a scene effect to Level 1, that tile should still receive the Level 1 scene effect rather than behaving as if Below Tiles were enabled. This helper lets scene-row selected masks honor that explicit assignment without weakening Region overlay protection.
   *
   * @param {{ mesh?: object|null, object?: object|null, document?: foundry.abstract.Document|null, level?: object|null }} options
   * @param {Set<string>|null|undefined} levelIds
   * @returns {boolean}
   */
  #surfaceHasExplicitMultiLevelTileAssignmentToLevelIds(
    { mesh = null, object = null, document = null, level = null } = {},
    levelIds,
  ) {
    if (!(levelIds?.size > 0)) return false;

    const documentName = String(
      document?.documentName ?? object?.document?.documentName ?? object?.constructor?.name ?? "",
    );
    const isTileSurface =
      documentName === "Tile" || documentName === "TileDocument" || object?.document?.documentName === "Tile";
    if (!isTileSurface) return false;

    const explicitIds = this.#resolveSurfaceLevelIds({ mesh, object, document, level });
    return explicitIds.size > 1 && this.#surfaceLevelIdsIntersect(explicitIds, levelIds);
  }

  /**
   * Resolve Level ids by matching a live surface's texture source against configured V14 Level background/foreground images. This is authoritative for native level textures because their live mesh elevation sits on shared boundaries between levels while the image path still identifies the actual Level that owns it.
   *
   * @param {{ mesh?: object|null, object?: object|null, document?: foundry.abstract.Document|null, level?: object|null }} options
   * @returns {Set<string>}
   */
  #resolveSurfaceConfiguredLevelIds({ mesh = null, object = null, document = null, level = null } = {}) {
    const cacheObject =
      [mesh, object, document, level].find(
        (value) => value && (typeof value === "object" || typeof value === "function"),
      ) ?? null;
    const cache = this._surfaceConfiguredLevelIdsFrameCache;
    if (cacheObject && cache?.has(cacheObject)) return cache.get(cacheObject) ?? new Set();

    const remember = (value) => {
      if (cacheObject) {
        try {
          cache?.set(cacheObject, value);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }
      return value;
    };

    const surfacePaths = this.#collectSurfaceComparableSourcePaths({ mesh, object, document, level });
    if (!surfacePaths.size) return remember(new Set());

    return remember(
      fxmResolveLevelIdsForComparableSourcePaths(
        surfacePaths,
        canvas?.scene ?? document?.parent ?? object?.document?.parent ?? level?.parent ?? null,
      ),
    );
  }
  /**
   * Resolve directly-owned Level ids from live surface fields that identify a single owner Level rather than a broad document visibility list.
   *
   * @param {{ mesh?: object|null, object?: object|null, document?: foundry.abstract.Document|null, level?: object|null }} options
   * @returns {Set<string>}
   */
  #resolveSurfaceOwnerLevelIds({ mesh = null, object = null, document = null, level = null } = {}) {
    const ids = new Set();
    const candidates = [
      level,
      mesh?.level ?? null,
      mesh?.object?.level ?? null,
      object?.level ?? null,
      document?.level ?? null,
    ];

    for (const candidate of candidates) this.#addSceneLevelIdsFromValue(candidate, ids);
    return ids;
  }

  /**
   * Resolve Level ids through Foundry's public document ownership API.
   *
   * @param {{ mesh?: object|null, object?: object|null, document?: foundry.abstract.Document|null, level?: object|null }} options
   * @returns {Set<string>}
   */
  #resolveSurfaceIncludedLevelIds({ mesh = null, object = null, document = null, level = null } = {}) {
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

    const levels = this.#getSceneLevels(scene);
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
   * Return whether a surface explicitly or implicitly belongs to one of the supplied Level ids.
   *
   * @param {{ mesh?: object|null, object?: object|null, document?: foundry.abstract.Document|null, level?: object|null, elevation?: number, window?: {min:number,max:number}|null }} options
   * @param {Set<string>|null|undefined} levelIds
   * @returns {boolean}
   */
  #surfaceTargetsLevelIds(
    { mesh = null, object = null, document = null, level = null, elevation = Number.NaN, window = null } = {},
    levelIds,
  ) {
    if (!(levelIds?.size > 0)) return false;

    const configuredIds = this.#resolveSurfaceConfiguredLevelIds({ mesh, object, document, level });
    if (configuredIds.size) return this.#surfaceLevelIdsIntersect(configuredIds, levelIds);

    const ownerIds = this.#resolveSurfaceOwnerLevelIds({ mesh, object, document, level });
    if (ownerIds.size) return this.#surfaceLevelIdsIntersect(ownerIds, levelIds);

    const includedIds = this.#resolveSurfaceIncludedLevelIds({ mesh, object, document, level });
    if (includedIds.size) return this.#surfaceLevelIdsIntersect(includedIds, levelIds);

    const explicitIds = this.#resolveSurfaceLevelIds({ mesh, object, document, level });
    if (explicitIds.size) return this.#surfaceLevelIdsIntersect(explicitIds, levelIds);

    const inferredLevel = inferVisibleLevelForDocument(document ?? object ?? level ?? null, elevation);
    if (inferredLevel?.id) return levelIds.has(inferredLevel.id);

    const effectiveWindow = window ?? this.#getSurfaceElevationWindow(document ?? object ?? level ?? null, elevation);
    if (effectiveWindow) {
      for (const levelId of levelIds) {
        const sceneLevel = this.#getSceneLevelById(levelId);
        if (sceneLevel && this.#surfaceWindowOverlapsLevel(effectiveWindow, sceneLevel)) return true;
      }
    }

    return false;
  }

  /**
   * Return whether a live surface resolves directly to one of the supplied Level ids without using broad elevation-window overlap. Region-behavior masks use this stricter identity so an intermediate Level cannot accidentally select a higher overlay surface.
   *
   * @param {{ mesh?: object|null, object?: object|null, document?: foundry.abstract.Document|null, level?: object|null, elevation?: number }} options
   * @param {Set<string>|null|undefined} levelIds
   * @returns {boolean}
   */
  #surfaceStrictlyTargetsLevelIds(
    { mesh = null, object = null, document = null, level = null, elevation = Number.NaN } = {},
    levelIds,
  ) {
    if (!(levelIds?.size > 0)) return false;

    const configuredIds = this.#resolveSurfaceConfiguredLevelIds({ mesh, object, document, level });
    if (configuredIds.size === 1) return this.#surfaceLevelIdsIntersect(configuredIds, levelIds);

    const ownerIds = this.#resolveSurfaceOwnerLevelIds({ mesh, object, document, level });
    if (ownerIds.size === 1) return this.#surfaceLevelIdsIntersect(ownerIds, levelIds);

    const includedIds = this.#resolveSurfaceIncludedLevelIds({ mesh, object, document, level });
    if (includedIds.size === 1) return this.#surfaceLevelIdsIntersect(includedIds, levelIds);

    const explicitIds = this.#resolveSurfaceLevelIds({ mesh, object, document, level });
    if (explicitIds.size === 1) return this.#surfaceLevelIdsIntersect(explicitIds, levelIds);

    const inferredLevel = inferVisibleLevelForDocument(document ?? object ?? level ?? null, elevation);
    if (inferredLevel?.id) return levelIds.has(inferredLevel.id);

    const directLevelId = level?.id ?? document?.level?.id ?? object?.level?.id ?? object?.document?.level?.id ?? null;
    return directLevelId ? levelIds.has(directLevelId) : false;
  }

  /**
   * Return the strict, single-Level identity for a live surface using the same precedence as {@link #surfaceStrictlyTargetsLevelIds}.
   *
   * @param {{ mesh?: object|null, object?: object|null, document?: foundry.abstract.Document|null, level?: object|null, elevation?: number }} options
   * @returns {Set<string>}
   */
  #getStrictSurfaceLevelMatchIds({
    mesh = null,
    object = null,
    document = null,
    level = null,
    elevation = Number.NaN,
  } = {}) {
    const configuredIds = this.#resolveSurfaceConfiguredLevelIds({ mesh, object, document, level });
    if (configuredIds.size === 1) return configuredIds;

    const ownerIds = this.#resolveSurfaceOwnerLevelIds({ mesh, object, document, level });
    if (ownerIds.size === 1) return ownerIds;

    const includedIds = this.#resolveSurfaceIncludedLevelIds({ mesh, object, document, level });
    if (includedIds.size === 1) return includedIds;

    const explicitIds = this.#resolveSurfaceLevelIds({ mesh, object, document, level });
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
   */
  #addStrictSurfaceLevelMatches(output, surface, candidateLevelIds) {
    if (!(output instanceof Set) || !(candidateLevelIds?.size > 0)) return;
    for (const levelId of this.#getStrictSurfaceLevelMatchIds(surface)) {
      if (candidateLevelIds.has(levelId)) output.add(levelId);
    }
  }

  /**
   * Return whether a surface is visually rendered on one of the supplied Level ids.
   *
   * @param {{ mesh?: object|null, object?: object|null, document?: foundry.abstract.Document|null, level?: object|null, elevation?: number, window?: {min:number,max:number}|null }} options
   * @param {Set<string>|null|undefined} levelIds
   * @returns {boolean}
   */
  #surfaceVisuallyTargetsLevelIds(
    { mesh = null, object = null, document = null, level = null, elevation = Number.NaN, window = null } = {},
    levelIds,
  ) {
    if (!(levelIds?.size > 0)) return false;

    const configuredIds = this.#resolveSurfaceConfiguredLevelIds({ mesh, object, document, level });
    if (configuredIds.size) return this.#surfaceLevelIdsIntersect(configuredIds, levelIds);

    const includedIds = this.#resolveSurfaceIncludedLevelIds({ mesh, object, document, level });
    if (includedIds.size) return this.#surfaceLevelIdsIntersect(includedIds, levelIds);

    const inferredLevel = inferVisibleLevelForDocument(document ?? object ?? level ?? null, elevation);
    if (inferredLevel?.id) return levelIds.has(inferredLevel.id);

    const effectiveWindow = window ?? this.#getSurfaceElevationWindow(document ?? object ?? level ?? null, elevation);
    if (effectiveWindow) {
      for (const levelId of levelIds) {
        const sceneLevel = this.#getSceneLevelById(levelId);
        if (sceneLevel && this.#surfaceWindowOverlapsLevel(effectiveWindow, sceneLevel)) return true;
      }
    }

    const levelId = level?.id ?? document?.level?.id ?? object?.level?.id ?? null;
    return levelId ? levelIds.has(levelId) : false;
  }

  /**
   * Return whether a surface should receive an effect assigned to the supplied Level ids.
   *
   * Configured Level image ownership is preferred for native Level textures so foreground images do not inherit the visual elevation of the Level above them. Tile-like surfaces use visual Level identity to avoid broad multi-Level tile assignments leaking effects through intermediate overlays.
   *
   * @param {{ mesh?: object|null, object?: object|null, document?: foundry.abstract.Document|null, level?: object|null, elevation?: number, window?: {min:number,max:number}|null }} options
   * @param {Set<string>|null|undefined} levelIds
   * @returns {boolean}
   */
  #surfaceEffectTargetsLevelIds(
    { mesh = null, object = null, document = null, level = null, elevation = Number.NaN, window = null } = {},
    levelIds,
  ) {
    if (!(levelIds?.size > 0)) return false;

    const documentName = String(
      document?.documentName ?? object?.document?.documentName ?? object?.constructor?.name ?? "",
    );
    const isTileSurface =
      documentName === "Tile" || documentName === "TileDocument" || object?.document?.documentName === "Tile";
    if (isTileSurface) {
      const explicitIds = this.#resolveSurfaceLevelIds({ mesh, object, document, level });
      if (explicitIds.size === 1) return this.#surfaceLevelIdsIntersect(explicitIds, levelIds);
      return this.#surfaceVisuallyTargetsLevelIds({ mesh, object, document, level, elevation, window }, levelIds);
    }

    const configuredIds = this.#resolveSurfaceConfiguredLevelIds({ mesh, object, document, level });
    if (configuredIds.size) return this.#surfaceLevelIdsIntersect(configuredIds, levelIds);

    return this.#surfaceVisuallyTargetsLevelIds({ mesh, object, document, level, elevation, window }, levelIds);
  }

  /**
   * Return whether tile and overlay surfaces should contribute to Level-local row masks.
   *
   * Explicit Level selections should prefer the Level's background/foreground or Define Surface footprint. Tile silhouettes are used for normal scene rows only as a fallback for tile-only Levels, or when Below Tiles needs those silhouettes for cutout composition.
   *
   * @param {object|null|undefined} row
   * @returns {boolean}
   */
  #rowIncludesTileSurfacesInLevelMasks(row) {
    if (this.#rowWantsBelowTiles(row)) return true;
    if (!canvas?.level || !row?.uid) return false;
    if (this.#getRowScope(row) !== "scene") return false;

    const allowedLevelIds = this.#getRowAllowedLevelIds(row);
    if (!(allowedLevelIds?.size > 0)) return false;
    if (CONFIG?.fxmaster?.overheadPerformance?.sceneRowSelectedLevelTilesExpandCoverage === true) return true;

    for (const levelId of allowedLevelIds) {
      if (!this.#levelHasSelectedNonTileSurfaceCoverage(levelId)) return true;
    }
    return false;
  }

  /**
   * Return whether a scene row should treat explicitly multi-Level-assigned tiles as selected surfaces for Level masks.
   *
   * This is intentionally scene-row-only. Region rows continue to use visual tile identity so a Level 2 Region cannot render over a visually Level 3 tile just because that tile is broadly assigned to Levels 1/2/3.
   *
   * @param {object|null|undefined} row
   * @returns {boolean}
   */
  #rowHonorsExplicitMultiLevelTileAssignments(row) {
    if (!canvas?.level || !row?.uid) return false;
    if (this.#getRowScope(row) !== "scene") return false;
    if (this.#rowWantsBelowTiles(row)) return false;
    const allowedLevelIds = this.#getRowAllowedLevelIds(row);
    if (!(allowedLevelIds?.size > 0)) return false;
    if (CONFIG?.fxmaster?.overheadPerformance?.sceneRowSelectedLevelTilesExpandCoverage === true) return true;

    for (const levelId of allowedLevelIds) {
      if (!this.#levelHasSelectedNonTileSurfaceCoverage(levelId)) return true;
    }
    return false;
  }

  /**
   * Return the set of Level ids a region row should be allowed to render through.
   *
   * A region assigned to multiple levels should continue to appear on those levels even when some of them are visible above the currently viewed level.
   *
   * @param {object|null|undefined} row
   * @param {foundry.documents.Level|null|undefined} fallbackLevel
   * @returns {Set<string>}
   */
  #getRegionAllowedLevelIds(row, fallbackLevel = null) {
    const ids = new Set();
    const regionDoc = this.#getRegionDocumentForRow(row);
    const currentLevel = getCanvasLevel();

    if (!regionDoc) return ids;

    const levels = getDocumentAssignedLevelIds(regionDoc, regionDoc?.parent ?? canvas?.scene ?? null);
    if (levels?.size) {
      const allowOverhead = applyRegionBehaviorsToOverheadLevels();
      for (const levelId of levels) {
        const level = this.#getSceneLevelById(levelId);
        if (!level) continue;
        if (currentLevel?.id && levelId === currentLevel.id) {
          ids.add(levelId);
          continue;
        }
        if (allowOverhead && currentLevel && this.#levelIsAboveTargetLevel(level, currentLevel)) ids.add(levelId);
      }
      return ids;
    }

    if (fallbackLevel?.id) {
      if (!currentLevel?.id || fallbackLevel.id === currentLevel.id) ids.add(fallbackLevel.id);
      else if (applyRegionBehaviorsToOverheadLevels() && this.#levelIsAboveTargetLevel(fallbackLevel, currentLevel)) {
        ids.add(fallbackLevel.id);
      }
    } else if (currentLevel?.id) ids.add(currentLevel.id);

    return ids;
  }

  /**
   * Add configured background and foreground image paths for a Level document.
   *
   * @param {foundry.documents.Level|null|undefined} level
   * @param {Set<string>} output
   * @returns {void}
   */
  #addLevelConfiguredImagePaths(level, output) {
    if (!level || !(output instanceof Set)) return;
    for (const pathValue of fxmGetLevelImagePaths(level, { scene: level?.parent ?? canvas?.scene ?? null })) {
      output.add(pathValue);
    }
  }

  /**
   * Add configured foreground image paths for a Level document.
   *
   * @param {foundry.documents.Level|null|undefined} level
   * @param {Set<string>} output
   * @returns {void}
   */
  #addLevelConfiguredForegroundImagePaths(level, output) {
    if (!level || !(output instanceof Set)) return;
    for (const pathValue of fxmGetLevelImagePaths(level, {
      foregroundOnly: true,
      scene: level?.parent ?? canvas?.scene ?? null,
    })) {
      output.add(pathValue);
    }
  }

  /**
   * Return a stable key for per-frame Level image-path caches.
   *
   * @param {foundry.documents.Level|null|undefined} level
   * @param {string} suffix
   * @returns {string}
   */
  #levelImagePathCacheKey(level, suffix) {
    return `${suffix}:${fxmDocumentId(level) || this.#getSceneLevels().indexOf(level)}`;
  }

  /**
   * Return configured background and foreground image paths for a Level document.
   *
   * @param {foundry.documents.Level|null|undefined} level
   * @returns {Set<string>}
   */
  #getCachedLevelConfiguredImagePaths(level) {
    const key = this.#levelImagePathCacheKey(level, "configured");
    const cache = this._levelConfiguredImagePathsFrameCache;
    if (cache?.has(key)) return cache.get(key) ?? new Set();

    const paths = new Set();
    this.#addLevelConfiguredImagePaths(level, paths);
    cache?.set(key, paths);
    return paths;
  }

  /**
   * Return configured foreground image paths for a Level document.
   *
   * @param {foundry.documents.Level|null|undefined} level
   * @returns {Set<string>}
   */
  #getCachedLevelConfiguredForegroundImagePaths(level) {
    const key = this.#levelImagePathCacheKey(level, "foreground");
    const cache = this._levelForegroundImagePathsFrameCache;
    if (cache?.has(key)) return cache.get(key) ?? new Set();

    const paths = new Set();
    this.#addLevelConfiguredForegroundImagePaths(level, paths);
    cache?.set(key, paths);
    return paths;
  }

  /**
   * Return cached comparable source paths for one arbitrary value.
   *
   * @param {*} value
   * @returns {Set<string>}
   */
  #getComparableSourcePathsForValue(value) {
    const paths = new Set();
    if (!value) return paths;

    if (typeof value === "object" || typeof value === "function") {
      const cache = this._surfaceSourcePathsFrameCache;
      if (cache?.has(value)) return cache.get(value) ?? paths;
      collectComparableSourcePaths(value, paths);
      try {
        cache?.set(value, paths);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      return paths;
    }

    collectComparableSourcePaths(value, paths);
    return paths;
  }

  /**
   * Return comparable source paths for a live surface tuple.
   *
   * @param {{ mesh?: object|null, object?: object|null, document?: foundry.abstract.Document|null, level?: object|null }} options
   * @returns {Set<string>}
   */
  #collectSurfaceComparableSourcePaths({ mesh = null, object = null, document = null, level = null } = {}) {
    const output = new Set();
    for (const value of [mesh, object, document, level]) {
      const paths = this.#getComparableSourcePathsForValue(value);
      for (const pathValue of paths) output.add(pathValue);
    }
    return output;
  }

  /**
   * Return configured foreground image paths for the supplied Level ids.
   *
   * @param {Set<string>|null|undefined} levelIds
   * @returns {Set<string>}
   */
  #getLevelForegroundImagePaths(levelIds) {
    const paths = new Set();
    if (!(levelIds?.size > 0)) return paths;

    const cacheKey = this.#levelIdsCacheKey(levelIds);
    const cache = this._levelForegroundImagePathsFrameCache;
    if (cache?.has(cacheKey)) return cache.get(cacheKey) ?? paths;

    for (const levelId of levelIds) {
      for (const pathValue of this.#getCachedLevelConfiguredForegroundImagePaths(this.#getSceneLevelById(levelId))) {
        paths.add(pathValue);
      }
    }

    cache?.set(cacheKey, paths);
    return paths;
  }

  /**
   * Return configured Level image paths for the supplied Level ids.
   *
   * @param {Set<string>|null|undefined} levelIds
   * @param {{ foregroundOnly?: boolean }} [options]
   * @returns {Set<string>}
   */
  #getLevelConfiguredImagePaths(levelIds, { foregroundOnly = false } = {}) {
    const paths = new Set();
    if (!(levelIds?.size > 0)) return paths;

    for (const levelId of levelIds) {
      const level = this.#getSceneLevelById(levelId);
      const sourcePaths = foregroundOnly
        ? this.#getCachedLevelConfiguredForegroundImagePaths(level)
        : this.#getCachedLevelConfiguredImagePaths(level);
      for (const pathValue of sourcePaths) paths.add(pathValue);
    }

    return paths;
  }

  /**
   * Return roots likely to contain live native Level texture display objects.
   *
   * @returns {PIXI.DisplayObject[]}
   */
  #getConfiguredLevelTextureSearchRoots() {
    const roots = [];
    const seen = new Set();
    const add = (object) => {
      if (!object || seen.has(object)) return;
      if (typeof object !== "object" && typeof object !== "function") return;
      seen.add(object);
      roots.push(object);
    };

    add(canvas?.primary);
    add(canvas?.primary?.background);
    add(canvas?.primary?.foreground);
    add(canvas?.primary?.levelTextures);
    add(canvas?.background);
    add(canvas?.foreground);
    add(canvas?.environment);
    add(canvas?.effects);

    for (const child of canvas?.primary?.children ?? []) add(child);
    for (const mesh of this.#getPrimaryLevelTexturesForFrame()) add(mesh);

    return roots;
  }

  /**
   * Return whether a live object belongs to FXMaster output rather than native Level artwork.
   *
   * @param {object|null|undefined} object
   * @returns {boolean}
   */
  #objectIsExcludedFromConfiguredLevelTextureSearch(object) {
    const seen = new Set();
    for (let current = object; current && !seen.has(current); current = current?.parent ?? null) {
      seen.add(current);
      if (
        current === this._displayContainer ||
        current === this._displaySprite ||
        current === this._blitSprite ||
        current === this._filterPassContainer ||
        current === this._tileRestoreContainer
      )
        return true;
      if (current === canvas?.particleeffects || current === canvas?.filtereffects) return true;
      const name = String(current?.name ?? current?.label ?? current?.constructor?.name ?? "").toLowerCase();
      if (name.includes("fxmaster")) return true;
    }
    return false;
  }

  /**
   * Return child display objects for traversal.
   *
   * @param {object|null|undefined} object
   * @returns {object[]}
   */
  #getDisplayObjectChildren(object) {
    if (!object) return [];
    const children = object?.children;
    if (Array.isArray(children)) return children;
    if (children && typeof children.values === "function") return Array.from(children.values());
    return [];
  }

  /**
   * Collect live display objects whose texture source matches configured Level artwork.
   *
   * @param {Set<string>|null|undefined} levelIds
   * @param {{ foregroundOnly?: boolean }} [options]
   * @returns {PIXI.DisplayObject[]}
   */
  #collectConfiguredLevelTextureObjectsForLevelIds(levelIds, { foregroundOnly = false } = {}) {
    if (!(levelIds?.size > 0) || !canvas?.primary) return [];

    const cacheKey = (foregroundOnly ? "foreground" : "all") + ":" + this.#levelIdsCacheKey(levelIds);
    const frameCache = this._configuredLevelTextureObjectsFrameCache;
    if (frameCache?.has(cacheKey)) return frameCache.get(cacheKey) ?? [];
    const remember = (value) => {
      frameCache?.set(cacheKey, value ?? []);
      return value ?? [];
    };

    const imagePaths = this.#getLevelConfiguredImagePaths(levelIds, { foregroundOnly });
    if (!imagePaths.size) return remember([]);

    const objects = [];
    const seenObjects = new Set();
    const push = (object) => {
      if (!object || seenObjects.has(object)) return;
      seenObjects.add(object);
      objects.push(object);
    };

    const visited = new Set();
    const visit = (object, depth = 0) => {
      if (!object || visited.has(object) || depth > 24) return;
      if (typeof object !== "object" && typeof object !== "function") return;
      visited.add(object);
      if (this.#objectIsExcludedFromConfiguredLevelTextureSearch(object)) return;

      const linkedObject = fxmLinkedPlaceableFromDisplayObject(object);
      const liveRenderObject = this.#resolveLiveSurfaceDisplayObject(object, linkedObject);
      const document = linkedObject?.document ?? object?.document ?? null;

      if (
        this.#surfaceUsesImagePaths(
          { mesh: object, object: linkedObject ?? object, document: document ?? linkedObject ?? object, level: null },
          imagePaths,
        )
      ) {
        const captureObject = this.#displayObjectContributesVisiblePixels(object)
          ? object
          : this.#displayObjectContributesVisiblePixels(liveRenderObject)
          ? liveRenderObject
          : null;
        if (captureObject && this.#displayObjectIntersectsViewport(captureObject)) push(captureObject);
      }

      for (const child of this.#getDisplayObjectChildren(object)) visit(child, depth + 1);
    };

    for (const root of this.#getConfiguredLevelTextureSearchRoots()) visit(root, 0);
    return remember(objects);
  }

  /**
   * Return whether a live display object resolves to one of the supplied image paths.
   *
   * @param {{ mesh?: object|null, object?: object|null, document?: foundry.abstract.Document|null, level?: object|null }} options
   * @param {Set<string>|null|undefined} imagePaths
   * @returns {boolean}
   */
  #surfaceUsesImagePaths({ mesh = null, object = null, document = null, level = null } = {}, imagePaths) {
    if (!(imagePaths?.size > 0)) return false;

    const paths = this.#collectSurfaceComparableSourcePaths({ mesh, object, document, level });
    for (const pathValue of paths) {
      if (imagePaths.has(pathValue)) return true;
    }

    return false;
  }

  /**
   * Return a normalized set of configured image paths for protected levels.
   *
   * Cached level textures do not always expose their owning Level document directly. Matching them against the configured background or foreground image path for allowed levels prevents the same-level foreground from being mistaken for an upper overlay surface.
   *
   * @param {Set<string>|null|undefined} protectedLevelIds
   * @returns {Set<string>}
   */
  #getProtectedLevelImagePaths(protectedLevelIds) {
    const paths = new Set();
    if (!(protectedLevelIds?.size > 0)) return paths;

    const cacheKey = this.#levelIdsCacheKey(protectedLevelIds);
    const cache = this._protectedLevelImagePathsFrameCache;
    if (cache?.has(cacheKey)) return cache.get(cacheKey) ?? paths;

    for (const levelId of protectedLevelIds) {
      for (const pathValue of this.#getCachedLevelConfiguredImagePaths(this.#getSceneLevelById(levelId))) {
        paths.add(pathValue);
      }
    }

    cache?.set(cacheKey, paths);
    return paths;
  }

  /**
   * Return whether a live display object resolves to one of the protected level image paths.
   *
   * @param {{ mesh?: object|null, object?: object|null, document?: foundry.abstract.Document|null, level?: object|null }} options
   * @param {Set<string>|null|undefined} protectedImagePaths
   * @returns {boolean}
   */
  #surfaceUsesProtectedLevelImagePaths(
    { mesh = null, object = null, document = null, level = null } = {},
    protectedImagePaths,
  ) {
    return this.#surfaceUsesImagePaths({ mesh, object, document, level }, protectedImagePaths);
  }

  /**
   * Return whether a live surface belongs to one of the currently visible overlay levels.
   *
   * @param {{ mesh?: object|null, object?: object|null, document?: foundry.abstract.Document|null, level?: object|null, elevation?: number }} options
   * @param {foundry.documents.Level|null|undefined} targetLevel
   * @param {{ protectedLevelIds?: Set<string>|null, overlayLevels?: foundry.documents.Level[]|null }} [options]
   * @returns {boolean}
   */
  #surfaceBelongsToVisibleOverlayLevels(
    { mesh = null, object = null, document = null, level = null, elevation = Number.NaN } = {},
    targetLevel,
    { protectedLevelIds = null, overlayLevels = null } = {},
  ) {
    if (!targetLevel) return false;

    const activeOverlayLevels = Array.isArray(overlayLevels)
      ? overlayLevels
      : this.#getVisibleOverlayLevelsAboveTarget(targetLevel, { protectedLevelIds });
    if (!activeOverlayLevels.length) return false;

    const overlayLevelIds = new Set(
      activeOverlayLevels.map((candidate) => candidate?.id).filter((id) => typeof id === "string" && id.length),
    );
    if (!overlayLevelIds.size) return false;

    const surfaceContext = { mesh, object, document, level, elevation };
    if (this.#surfaceStrictlyTargetsLevelIds(surfaceContext, protectedLevelIds)) return false;

    /**
     * Upper-overlay protection must follow visual surface identity rather than only strict Level ownership. Overhead tiles can report broad multi-Level membership while visually occupying a higher overlay. A strict-only test omits those tiles from the restore mask and lets a lower-Level Region particle row draw over them after Level changes.
     */
    const visuallyTargetsOverlay = this.#surfaceVisuallyTargetsLevelIds(surfaceContext, overlayLevelIds);
    if (!visuallyTargetsOverlay) return false;

    /**
     * If a broad/elevation-window fallback says the surface is also protected, prefer the actual overlay match. This preserves visually upper surfaces that also carry broad multi-Level document assignments while still excluding surfaces that strictly belong to the Region's target Level.
     */
    return true;
  }

  /**
   * Return whether a live display object currently contributes visible pixels.
   *
   * @param {PIXI.DisplayObject|null|undefined} object
   * @returns {boolean}
   */
  #displayObjectContributesVisiblePixels(object) {
    if (!object || object.destroyed) return false;
    if (object.visible === false || object.renderable === false) return false;

    const alpha = Number(object.worldAlpha ?? object.alpha ?? 1);
    return !(Number.isFinite(alpha) && alpha <= 0.001);
  }

  /**
   * Return live primary Level texture meshes for the current compositor frame.
   *
   * @returns {PIXI.DisplayObject[]}
   */
  #getPrimaryLevelTexturesForFrame() {
    if (Array.isArray(this._primaryLevelTexturesFrameCache)) return this._primaryLevelTexturesFrameCache;

    const collection = canvas?.primary?.levelTextures ?? [];
    const textures =
      typeof collection?.values === "function" ? Array.from(collection.values()) : Array.from(collection);
    this._primaryLevelTexturesFrameCache = textures;
    return textures;
  }

  /**
   * Return live primary tile meshes for the current compositor frame.
   *
   * @returns {PIXI.DisplayObject[]}
   */
  #getPrimaryTileMeshesForFrame() {
    if (Array.isArray(this._primaryTileMeshesFrameCache)) return this._primaryTileMeshesFrameCache;

    const collection = canvas?.primary?.tiles ?? [];
    const meshes = typeof collection?.values === "function" ? Array.from(collection.values()) : Array.from(collection);
    this._primaryTileMeshesFrameCache = meshes;
    return meshes;
  }

  /**
   * Return live primary tile meshes indexed by tile id for the current compositor frame.
   *
   * @returns {Map<string, PIXI.DisplayObject[]>}
   */
  #getPrimaryTileMeshesByTileId() {
    if (this._primaryTileMeshesByTileIdFrameCache) return this._primaryTileMeshesByTileIdFrameCache;

    const map = new Map();
    const add = (id, mesh) => {
      if (!id || !mesh) return;
      const key = String(id);
      const list = map.get(key);
      if (list) list.push(mesh);
      else map.set(key, [mesh]);
    };

    for (const mesh of this.#getPrimaryTileMeshesForFrame()) {
      const linked = fxmLinkedPlaceableFromDisplayObject(mesh);
      add(linked?.document?.id ?? linked?.id ?? mesh?.document?.id ?? mesh?.id, mesh);
    }

    this._primaryTileMeshesByTileIdFrameCache = map;
    return map;
  }

  /**
   * Return live primary meshes associated with a tile for the current compositor frame.
   *
   * @param {Tile|null|undefined} tile
   * @returns {PIXI.DisplayObject[]}
   */
  #getPrimaryTileMeshesForTile(tile) {
    if (!tile) return [];
    const tileId = tile?.document?.id ?? tile?.id ?? null;
    if (tileId) return this.#getPrimaryTileMeshesByTileId().get(String(tileId)) ?? [tile?.mesh ?? null];
    return [tile?.mesh ?? null];
  }

  /**
   * Return whether a tile contributes active canvas coverage, cached for the current compositor frame.
   *
   * @param {Tile|null|undefined} tile
   * @returns {boolean}
   */
  #tileIsActiveOnCanvas(tile) {
    if (!tile) return false;

    const cache = this._tileActiveFrameCache;
    if (cache?.has(tile)) return cache.get(tile) === true;

    const active = tileIsActiveOnCanvasForCompositor(tile, this.#getPrimaryTileMeshesForTile(tile));
    try {
      cache?.set(tile, active);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    return active;
  }

  /**
   * Prefer the live placeable-backed display object for a native Level surface when available.
   *
   * @param {PIXI.DisplayObject|null|undefined} primaryObject
   * @param {object|null|undefined} linkedObject
   * @returns {PIXI.DisplayObject|null}
   */
  #resolveLiveSurfaceDisplayObject(primaryObject, linkedObject) {
    const liveObject = linkedObject?.mesh ?? linkedObject?.primaryMesh ?? linkedObject?.sprite ?? null;
    return liveObject ?? primaryObject ?? linkedObject ?? null;
  }

  /**
   * Collect currently rendered upper-level surfaces above a target level.
   *
   * @param {foundry.documents.Level|null|undefined} targetLevel
   * @param {{ protectedLevelIds?: Set<string>|null, includeRevealed?: boolean }} [options]
   * @returns {PIXI.DisplayObject[]}
   */
  #collectUpperSurfaceObjectsForTargetLevel(targetLevel, { protectedLevelIds = null, includeRevealed = false } = {}) {
    if (!targetLevel || !canvas?.primary) return [];

    const cacheKey = `${this.#upperSurfaceObjectsCacheKey(targetLevel, protectedLevelIds)}:revealed:${
      includeRevealed ? 1 : 0
    }`;
    const frameCache = this._upperSurfaceObjectsFrameCache;
    if (frameCache?.has(cacheKey)) return frameCache.get(cacheKey) ?? [];

    const remember = (value) => {
      frameCache?.set(cacheKey, value ?? []);
      return value ?? [];
    };

    const overlayLevels = this.#getVisibleOverlayLevelsAboveTarget(targetLevel, { protectedLevelIds });
    if (!overlayLevels.length) return remember([]);

    const protectedImagePaths = this.#getProtectedLevelImagePaths(protectedLevelIds);
    const objects = [];
    const seen = new Set();
    const push = (object) => {
      if (!object || seen.has(object)) return;
      seen.add(object);
      objects.push(object);
    };

    for (const mesh of this.#getPrimaryLevelTexturesForFrame()) {
      const object = mesh?.object ?? null;
      const liveRenderObject = this.#resolveLiveSurfaceDisplayObject(mesh, object);
      const captureObject = this.#displayObjectContributesVisiblePixels(mesh)
        ? mesh
        : this.#displayObjectContributesVisiblePixels(liveRenderObject)
        ? liveRenderObject
        : null;
      if (!captureObject) continue;
      if (!this.#displayObjectIntersectsViewport(captureObject)) continue;

      const document = mesh?.level?.document ?? mesh?.level ?? object?.document ?? object ?? null;
      const level = mesh?.level ?? object?.level ?? document?.level ?? null;
      if (this.#surfaceUsesProtectedLevelImagePaths({ mesh, object, document, level }, protectedImagePaths)) continue;
      const elevation = Number(
        mesh?.elevation ??
          document?.elevation?.bottom ??
          document?.elevation ??
          object?.document?.elevation?.bottom ??
          object?.document?.elevation ??
          Number.NaN,
      );
      if (
        !this.#surfaceBelongsToVisibleOverlayLevels({ mesh, object, document, level, elevation }, targetLevel, {
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

    for (const mesh of this.#getPrimaryTileMeshesForFrame()) {
      const tileObject = fxmLinkedPlaceableFromDisplayObject(mesh);
      const liveRenderObject = this.#resolveLiveSurfaceDisplayObject(mesh, tileObject);
      const captureObject = this.#displayObjectContributesVisiblePixels(mesh)
        ? mesh
        : this.#displayObjectContributesVisiblePixels(liveRenderObject)
        ? liveRenderObject
        : null;
      if (!captureObject) continue;
      if (!this.#displayObjectIntersectsViewport(captureObject)) continue;

      const document = tileObject?.document ?? null;
      if (tileObject && !this.#tileIsActiveOnCanvas(tileObject)) continue;

      const elevation = Number(mesh?.elevation ?? document?.elevation ?? tileObject?.elevation ?? Number.NaN);
      const level = mesh?.level ?? tileObject?.level ?? document?.level ?? null;
      if (
        !this.#surfaceBelongsToVisibleOverlayLevels(
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

    if (includeRevealed) {
      const overlayLevelIds = new Set(overlayLevels.map((level) => level?.id).filter(Boolean));
      for (const object of this.#collectConfiguredLevelTextureObjectsForLevelIds(overlayLevelIds)) push(object);
    }

    return remember(objects);
  }

  /**
   * Return whether a level-limited scene row must stay constrained to its selected native Level surfaces.
   *
   * Hidden selected Levels intentionally still return true here. The row is skipped later when no selected surface can be captured, preventing a stale particle/filter runtime from falling back to an unmasked full-scene render after the user changes the viewed Level.
   *
   * @param {object|null|undefined} row
   * @returns {boolean}
   */
  #rowUsesSelectedLevelSurfaceMask(row) {
    if (!canvas?.level || this.#getRowScope(row) !== "scene" || !row?.uid) return false;

    const allowedLevelIds = this.#getRowAllowedLevelIds(row);
    return allowedLevelIds?.size > 0;
  }

  /**
   * Return whether a Region row needs native Level-surface draw-order compositing.
   *
   * Non-current single-Level Regions use this path when that Level has a visible overlay surface, so Region particles/filters assigned only to an upper hoverable Level affect that overlay without leaking onto the current Level. Multi-Level Regions use it when assigned Levels are interleaved with visible unassigned Levels.
   *
   * A Region assigned to Level 1 and Level 3, with Level 2 visible between them, cannot safely use the simple upper-overlay restore path: restoring Level 2 after the row output places Level 2 above Level 3. The selected-Level compositor preserves the correct sequence: selected lower Level, restored intermediate Level, selected upper Level.
   *
   * @param {object|null|undefined} row
   * @returns {boolean}
   */
  #rowNeedsRegionLevelDrawOrderComposite(row) {
    if (!canvas?.level || this.#getRowScope(row) !== "region" || !row?.uid) return false;

    const allowedLevelIds = this.#getRowAllowedLevelIds(row);
    if (!(allowedLevelIds?.size > 0)) return false;

    if (allowedLevelIds.size === 1) {
      const [levelId] = Array.from(allowedLevelIds);
      if (!levelId) return false;
      if (this.#levelIsCurrentCanvasView(levelId)) {
        let sawSelectedCurrentLevel = false;
        for (const segment of this.#buildSelectedLevelCompositeSegments(allowedLevelIds)) {
          if (segment?.type === "selected") {
            sawSelectedCurrentLevel = true;
            continue;
          }
          if (sawSelectedCurrentLevel && segment?.type === "restore") return true;
        }
        return false;
      }
      return (
        this.#collectVisibleSurfaceObjectsForLevelIds(allowedLevelIds, {
          includeTiles: true,
          strictLevelIdentity: true,
        }).length > 0
      );
    }

    let sawRestoreBetweenSelectedLevels = false;
    for (const segment of this.#buildSelectedLevelCompositeSegments(allowedLevelIds)) {
      if (segment?.type === "restore") {
        sawRestoreBetweenSelectedLevels = true;
        continue;
      }
      if (segment?.type === "selected" && sawRestoreBetweenSelectedLevels) return true;
    }

    return false;
  }

  /**
   * Collect live canvas surfaces that belong to one of the selected native Scene Levels.
   *
   * The collected objects are rendered into a mask so rows assigned to a visible non-current Level affect only that Level's visible overlay surfaces while the current Level remains unchanged.
   *
   * @param {Set<string>|null|undefined} levelIds
   * @returns {PIXI.DisplayObject[]}
   */
  #collectVisibleSurfaceObjectsForLevelIds(
    levelIds,
    { includeTiles = true, strictLevelIdentity = false, includeExplicitMultiLevelTiles = false } = {},
  ) {
    if (!(levelIds?.size > 0) || !canvas?.primary) return [];

    const cacheKey = `${this.#levelIdsCacheKey(levelIds)}::tiles:${includeTiles ? 1 : 0}:strict:${
      strictLevelIdentity ? 1 : 0
    }:explicitMultiTiles:${includeExplicitMultiLevelTiles ? 1 : 0}`;
    const frameCache = this._visibleSurfaceObjectsFrameCache;
    if (frameCache?.has(cacheKey)) return frameCache.get(cacheKey) ?? [];
    const remember = (value) => {
      frameCache?.set(cacheKey, value ?? []);
      return value ?? [];
    };

    const objects = [];
    const seen = new Set();
    const push = (object) => {
      if (!object || seen.has(object)) return;
      seen.add(object);
      objects.push(object);
    };

    for (const mesh of this.#getPrimaryLevelTexturesForFrame()) {
      const object = mesh?.object ?? null;
      const liveRenderObject = this.#resolveLiveSurfaceDisplayObject(mesh, object);
      const captureObject = this.#displayObjectContributesVisiblePixels(mesh)
        ? mesh
        : this.#displayObjectContributesVisiblePixels(liveRenderObject)
        ? liveRenderObject
        : null;
      if (!captureObject) continue;
      if (!this.#displayObjectIntersectsViewport(captureObject)) continue;

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
      const surfaceTargets = strictLevelIdentity
        ? this.#surfaceStrictlyTargetsLevelIds({ mesh, object, document, level, elevation }, levelIds)
        : this.#surfaceEffectTargetsLevelIds({ mesh, object, document, level, elevation }, levelIds);
      if (!surfaceTargets) continue;

      push(captureObject);
    }

    if (!includeTiles) return remember(objects);

    for (const mesh of this.#getPrimaryTileMeshesForFrame()) {
      const tileObject = fxmLinkedPlaceableFromDisplayObject(mesh);
      const liveRenderObject = this.#resolveLiveSurfaceDisplayObject(mesh, tileObject);
      const captureObject = this.#displayObjectContributesVisiblePixels(mesh)
        ? mesh
        : this.#displayObjectContributesVisiblePixels(liveRenderObject)
        ? liveRenderObject
        : null;
      if (!captureObject) continue;
      if (!this.#displayObjectIntersectsViewport(captureObject)) continue;
      if (tileObject && !this.#tileIsActiveOnCanvas(tileObject)) continue;

      const document = tileObject?.document ?? null;
      const elevation = Number(mesh?.elevation ?? document?.elevation ?? tileObject?.elevation ?? Number.NaN);
      const level = mesh?.level ?? tileObject?.level ?? document?.level ?? null;
      const surfaceTargets = strictLevelIdentity
        ? this.#surfaceStrictlyTargetsLevelIds(
            { mesh, object: tileObject, document: document ?? tileObject ?? null, level, elevation },
            levelIds,
          )
        : (includeExplicitMultiLevelTiles &&
            this.#surfaceHasExplicitMultiLevelTileAssignmentToLevelIds(
              { mesh, object: tileObject, document: document ?? tileObject ?? null, level },
              levelIds,
            )) ||
          this.#surfaceEffectTargetsLevelIds(
            { mesh, object: tileObject, document: document ?? tileObject ?? null, level, elevation },
            levelIds,
          );
      if (!surfaceTargets) continue;

      push(captureObject);
    }

    for (const object of this.#collectConfiguredLevelTextureObjectsForLevelIds(levelIds)) push(object);

    return remember(objects);
  }

  /**
   * Return whether live foreground display objects exist for the supplied Scene Levels, regardless of current hover alpha.
   *
   * Configured foreground-image fallbacks are useful for the viewed Level when Foundry does not expose a separate foreground mesh, but they are too broad when a V14 overlay foreground mesh exists and is currently hover-faded or transparent. In that case the live mesh is authoritative, even when it contributes no pixels this frame.
   *
   * @param {Set<string>|null|undefined} levelIds
   * @returns {boolean}
   */
  #hasForegroundSurfaceCandidatesForLevelIds(levelIds) {
    if (!(levelIds?.size > 0) || !canvas?.primary) return false;

    const cacheKey = this.#levelIdsCacheKey(levelIds);
    const frameCache = this._foregroundSurfaceCandidatesFrameCache;
    if (frameCache?.has(cacheKey)) return frameCache.get(cacheKey) === true;

    const foregroundPaths = this.#getLevelForegroundImagePaths(levelIds);
    if (!foregroundPaths.size) {
      frameCache?.set(cacheKey, false);
      return false;
    }

    let found = false;
    for (const mesh of this.#getPrimaryLevelTexturesForFrame()) {
      if (!mesh || mesh.destroyed) continue;
      const object = mesh?.object ?? null;
      const document = mesh?.level?.document ?? mesh?.level ?? object?.document ?? object ?? null;
      const level = mesh?.level ?? object?.level ?? document?.level ?? null;
      if (!this.#surfaceUsesImagePaths({ mesh, object, document, level }, foregroundPaths)) continue;
      found = true;
      break;
    }

    frameCache?.set(cacheKey, found);
    return found;
  }

  /**
   * Collect visible foreground image surfaces for the selected Scene Levels.
   *
   * @param {Set<string>|null|undefined} levelIds
   * @returns {PIXI.DisplayObject[]}
   */
  #collectVisibleForegroundSurfaceObjectsForLevelIds(levelIds) {
    if (!(levelIds?.size > 0) || !canvas?.primary) return [];

    const cacheKey = this.#levelIdsCacheKey(levelIds);
    const frameCache = this._visibleForegroundSurfaceObjectsFrameCache;
    if (frameCache?.has(cacheKey)) return frameCache.get(cacheKey) ?? [];
    const remember = (value) => {
      frameCache?.set(cacheKey, value ?? []);
      return value ?? [];
    };

    const foregroundPaths = this.#getLevelForegroundImagePaths(levelIds);
    if (!foregroundPaths.size) return remember([]);

    const objects = [];
    const seen = new Set();
    const push = (object) => {
      if (!object || seen.has(object)) return;
      seen.add(object);
      objects.push(object);
    };

    for (const mesh of this.#getPrimaryLevelTexturesForFrame()) {
      const object = mesh?.object ?? null;
      const liveRenderObject = this.#resolveLiveSurfaceDisplayObject(mesh, object);
      const captureObject = this.#displayObjectContributesVisiblePixels(mesh)
        ? mesh
        : this.#displayObjectContributesVisiblePixels(liveRenderObject)
        ? liveRenderObject
        : null;
      if (!captureObject) continue;
      if (!this.#displayObjectIntersectsViewport(captureObject)) continue;

      const document = mesh?.level?.document ?? mesh?.level ?? object?.document ?? object ?? null;
      const level = mesh?.level ?? object?.level ?? document?.level ?? null;
      if (!this.#surfaceUsesImagePaths({ mesh, object, document, level }, foregroundPaths)) continue;

      /**
       * Configured foreground image paths are authoritative for foreground ownership because V14 overlay foreground meshes can sit on shared Level boundaries.
       */
      push(captureObject);
    }

    for (const object of this.#collectConfiguredLevelTextureObjectsForLevelIds(levelIds, { foregroundOnly: true }))
      push(object);

    return remember(objects);
  }

  /**
   * Return a stable key for the current screen-space stage matrix.
   *
   * @returns {string}
   */
  #selectedLevelViewportMatrixKey() {
    if (
      this._selectedLevelViewportMatrixKeyFrameSerial === this._renderFrameSerial &&
      typeof this._selectedLevelViewportMatrixKeyFrameValue === "string"
    ) {
      return this._selectedLevelViewportMatrixKeyFrameValue;
    }

    const matrix = currentWorldMatrix(canvas?.stage, { snapStage: false });
    const key = [matrix?.a, matrix?.b, matrix?.c, matrix?.d, matrix?.tx, matrix?.ty]
      .map((value) => (Number.isFinite(Number(value)) ? Number(value).toFixed(3) : ""))
      .join(",");
    this._selectedLevelViewportMatrixKeyFrameSerial = this._renderFrameSerial;
    this._selectedLevelViewportMatrixKeyFrameValue = key;
    return key;
  }

  /**
   * Synchronize the screen-space viewport key for selected-Level mask caching.
   *
   * @returns {void}
   */
  #syncSelectedLevelViewportState() {
    const key = this.#selectedLevelViewportMatrixKey();
    this._selectedLevelViewportMovingFrame =
      !!this._selectedLevelViewportMatrixKey && this._selectedLevelViewportMatrixKey !== key;
    this._selectedLevelViewportMatrixKey = key;
    this._selectedLevelViewportMovingFrameSerial = this._renderFrameSerial;
  }

  /**
   * Return whether selected-Level mask contents are moving in screen space this frame.
   *
   * @returns {boolean}
   */
  #selectedLevelViewportMovedThisFrame() {
    if (this._selectedLevelViewportMovingFrameSerial !== this._renderFrameSerial)
      this.#syncSelectedLevelViewportState();
    return this._selectedLevelViewportMovingFrame === true;
  }

  /**
   * Return the live Level surface signature for the current compositor frame.
   *
   * @returns {string}
   */
  #getLevelSurfaceSignatureForFrame() {
    if (
      this._levelSurfaceSignatureFrameSerial === this._renderFrameSerial &&
      typeof this._levelSurfaceSignatureFrameValue === "string"
    ) {
      return this._levelSurfaceSignatureFrameValue;
    }

    let signature = "surface-state-unavailable";
    try {
      signature = buildCanvasLiveLevelSurfaceSignature(canvas?.scene ?? null, { presynced: true });
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    this._levelSurfaceSignatureFrameSerial = this._renderFrameSerial;
    this._levelSurfaceSignatureFrameValue = signature;
    return signature;
  }

  /**
   * Return a cache key for selected Level surface masks.
   *
   * @param {Set<string>|null|undefined} levelIds
   * @param {string} [suffix]
   * @returns {string}
   */
  #selectedLevelSurfaceMaskKey(levelIds, suffix = "surface") {
    const idsKey = Array.from(levelIds ?? [])
      .sort()
      .join("|");
    const { width, height, resolution } = this.#getViewportMetrics();
    const matrixKey = this.#selectedLevelViewportMatrixKey();
    const surfaceKey = this.#selectedLevelViewportMovedThisFrame()
      ? "viewport-moving"
      : this.#getLevelSurfaceSignatureForFrame();
    return [
      canvas?.scene?.id ?? "scene",
      suffix,
      idsKey,
      width,
      height,
      Number(resolution || 1).toFixed(3),
      matrixKey,
      surfaceKey,
    ].join(":");
  }

  /**
   * Return whether a selected Level id is the currently viewed native Level.
   *
   * @param {string|null|undefined} levelId
   * @returns {boolean}
   */
  #levelIsCurrentCanvasView(levelId) {
    if (!levelId) return false;

    const currentLevel = getCanvasLevel();
    if (currentLevel?.id) return currentLevel.id === levelId;

    const level = this.#getSceneLevelById(levelId);
    return !!level?.isView;
  }

  /**
   * Return whether selected-Level masks should only use tile surfaces when the selected Level has no live/configured non-tile artwork coverage.
   *
   * Scene rows with an explicit Level selection should be bounded by the selected Level's actual background/foreground footprint. A Tile document assigned to Levels 1/2/3 can exist outside a partial upper-Level castle footprint; using that Tile silhouette as selected-Level coverage broadens Level 3 weather or filters into pixels that are not part of Level 3 artwork. Keep tile-only Levels working by allowing tiles as a fallback when no non-tile Level surface exists for that Level.
   *
   * @param {object|null|undefined} row
   * @returns {boolean}
   */
  #rowLimitsSelectedLevelTilesToFallbackSurfaces(row) {
    if (!canvas?.level || !row?.uid) return false;
    if (this.#getRowScope(row) !== "scene") return false;
    const allowedLevelIds = this.#getRowAllowedLevelIds(row);
    if (!(allowedLevelIds?.size > 0)) return false;
    return CONFIG?.fxmaster?.overheadPerformance?.sceneRowSelectedLevelTilesExpandCoverage !== true;
  }

  /**
   * Return whether a Level has live/configured non-tile artwork coverage that can define the Level-limited scene-effect area.
   *
   * @param {string|null|undefined} levelId
   * @returns {boolean}
   */
  #levelHasSelectedNonTileSurfaceCoverage(levelId) {
    if (!levelId) return false;

    const cache = this._selectedLevelNonTileCoverageFrameCache;
    if (cache?.has(levelId)) return cache.get(levelId) === true;

    const remember = (value) => {
      cache?.set(levelId, value === true);
      return value === true;
    };

    const levelIds = new Set([levelId]);
    if (this.#collectVisibleSurfaceObjectsForLevelIds(levelIds, { includeTiles: false }).length) return remember(true);

    return remember(
      this.#levelCanUseConfiguredImageFallbackForMask(levelId, {
        includeTiles: false,
        strictLevelIdentity: true,
      }),
    );
  }

  /**
   * Return whether a public Region-defined surface can be used as visual Level footprint coverage. Movement-only surfaces are intentionally ignored so scene FX are not clipped by non-visual traversal helpers.
   *
   * @param {object|null|undefined} surface
   * @returns {boolean}
   */
  #surfaceDefinesVisualLevelFootprint(surface) {
    return !!(surface && (surface.occlusion === true || surface.exposure === true));
  }

  /**
   * Return whether a Region-defined surface elevation belongs to the supplied Level's visual footprint. Prefer the Level bottom boundary, which is how Foundry's Define Surface regions commonly mark the walkable/visible plane for that Level. A wider in-window fallback is used only when no exact bottom surface exists for the Level.
   *
   * @param {object|null|undefined} surface
   * @param {foundry.documents.Level|null|undefined} level
   * @param {boolean} [allowWindowFallback=false]
   * @returns {boolean}
   */
  #surfaceElevationMatchesLevelFootprint(surface, level, allowWindowFallback = false) {
    if (!surface || !level) return false;
    const elevation = Number(surface?.elevation);
    if (!Number.isFinite(elevation)) return false;

    const bottom = this.#getLevelBottom(level);
    if (Number.isFinite(bottom) && Math.abs(elevation - bottom) <= 0.01) return true;
    if (!allowWindowFallback) return false;

    const top = this.#getLevelTop(level);
    const min = Number.isFinite(bottom) ? bottom : Number.NEGATIVE_INFINITY;
    const max = Number.isFinite(top) ? top : Number.POSITIVE_INFINITY;
    return elevation >= min - 0.01 && elevation <= max + 0.01;
  }

  /**
   * Collect public Region documents whose Define Surface behavior describes the selected Level footprint. These regions are used only as an additional clip for Level-selected scene rows, preventing broad multi-Level tiles or tokens outside the actual upper-Level area from receiving that Level's scene FX.
   *
   * @param {string|null|undefined} levelId
   * @returns {Array<object>}
   */
  #getDefinedSurfaceFootprintRegionsForLevel(levelId) {
    const id = String(levelId ?? "").trim();
    if (!id || CONFIG?.fxmaster?.overheadPerformance?.sceneRowUseDefinedSurfaceFootprints === false) return [];

    const cache = this._levelDefinedSurfaceFootprintRegionsFrameCache;
    if (cache?.has(id)) return cache.get(id) ?? [];

    const remember = (value) => {
      const out = Array.isArray(value) ? value : [];
      cache?.set(id, out);
      return out;
    };

    const level = this.#getSceneLevelById(id);
    if (!level) return remember([]);

    let surfaces = [];
    try {
      surfaces = getSceneSurfaces(canvas?.scene ?? null, {});
    } catch (err) {
      logger.debug("FXMaster:", err);
      surfaces = [];
    }
    if (!surfaces.length) return remember([]);

    const exact = [];
    const fallback = [];
    const allowWindowFallback =
      CONFIG?.fxmaster?.overheadPerformance?.sceneRowDefinedSurfaceFootprintWindowFallback === true;
    const pushUnique = (list, region) => {
      const doc = region?.document ?? region ?? null;
      const regionId = String(fxmDocumentId(doc)).trim();
      if (!doc || !doc.shapes?.length) return;
      if (regionId && list.some((candidate) => String((candidate?.document ?? candidate)?.id ?? "") === regionId))
        return;
      list.push(doc);
    };

    for (const surface of surfaces) {
      if (!this.#surfaceDefinesVisualLevelFootprint(surface)) continue;
      const region = surface?.region ?? null;
      if (!region) continue;
      if (this.#surfaceElevationMatchesLevelFootprint(surface, level, false)) {
        pushUnique(exact, region);
        continue;
      }
      if (allowWindowFallback && this.#surfaceElevationMatchesLevelFootprint(surface, level, true))
        pushUnique(fallback, region);
    }

    /**
     * Do not use in-window fallback surfaces by default. On maps where a lower Level covers the whole scene and upper Levels are partial structures, an upper-Level footprint can sit inside the lower Level's elevation window and would incorrectly shrink effects assigned to the lower Level.
     */
    return remember(exact.length ? exact : allowWindowFallback ? fallback : []);
  }

  /**
   * Build a stable per-frame signature for Define Surface footprint regions.
   *
   * @param {Array<object>} regions
   * @returns {string}
   */
  #definedSurfaceFootprintRegionsSignature(regions) {
    const parts = [];
    for (const region of regions ?? []) {
      const doc = region?.document ?? region ?? null;
      if (!doc) continue;
      const id = String(fxmDocumentId(doc)).trim();
      const shapes = doc?.shapes ?? null;
      const win = getRegionElevationWindow(doc);
      parts.push(
        [
          id,
          Number.isFinite(Number(win?.min)) ? Number(win.min).toFixed(3) : "",
          Number.isFinite(Number(win?.max)) ? Number(win.max).toFixed(3) : "",
          this.#regionShapeKeyForFrame(shapes),
        ].join("~"),
      );
    }
    return parts.sort().join(";");
  }

  /**
   * Build a stable signature for public Define Surface footprint clips associated with selected Level ids. Including this in selected-Level mask keys prevents stale broad masks after surface Region edits or after public surfaces become available during canvas initialization.
   *
   * @param {Set<string>|string[]|null|undefined} levelIds
   * @returns {string}
   */
  #definedSurfaceFootprintSignatureForLevelIds(levelIds) {
    const ids = Array.from(levelIds ?? [])
      .filter(Boolean)
      .sort();
    if (!ids.length || CONFIG?.fxmaster?.overheadPerformance?.sceneRowUseDefinedSurfaceFootprints === false)
      return "footprint:off";

    const parts = [];
    for (const levelId of ids) {
      const regions = this.#getDefinedSurfaceFootprintRegionsForLevel(levelId);
      if (!regions.length) {
        parts.push(`${levelId}=none`);
        continue;
      }
      parts.push(`${levelId}=${this.#definedSurfaceFootprintRegionsSignature(regions) || "empty"}`);
    }
    return parts.join("|") || "footprint:none";
  }

  /**
   * Capture the union of public Define Surface Region shapes for selected Level ids. The returned mask is in CSS viewport space and cached with the same Level segment cache as other selected-Level masks.
   *
   * @param {Set<string>|string[]|null|undefined} levelIds
   * @returns {PIXI.RenderTexture|null}
   */
  #captureDefinedSurfaceFootprintMaskForLevelIds(levelIds) {
    const ids = Array.from(levelIds ?? []).filter(Boolean);
    if (!ids.length || !this._surfaceMaskScratchRT) return null;

    const regionsByLevel = new Map();
    const allRegions = [];
    for (const levelId of ids) {
      const regions = this.#getDefinedSurfaceFootprintRegionsForLevel(levelId);
      if (!regions.length) continue;
      regionsByLevel.set(levelId, regions);
      for (const region of regions) allRegions.push(region);
    }
    if (!allRegions.length) return null;

    const cacheKey = this.#levelSegmentMaskCacheKey("defined-surface-footprint", ids, {
      objectSignature: this.#definedSurfaceFootprintRegionsSignature(allRegions),
    });
    const cached = this.#getCachedLevelSegmentMaskTexture(cacheKey);
    if (cached) return cached;

    const renderTexture = this.#createLevelSegmentMaskTexture(cacheKey);
    if (!renderTexture) return null;
    if (!this.#clearRenderTexture(renderTexture)) {
      try {
        renderTexture.destroy?.(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      return null;
    }

    let temporaryScratchRT = null;
    const pool = {
      acquire: (width, height, resolution) => {
        const w = Math.max(1, Number(width) || 1);
        const h = Math.max(1, Number(height) || 1);
        const res = Number(resolution) || 1;
        if (
          this.#canBindRenderTexture(this._surfaceMaskScratchRT) &&
          Math.abs(Number(this._surfaceMaskScratchRT.width ?? 0) - w) <= 0.001 &&
          Math.abs(Number(this._surfaceMaskScratchRT.height ?? 0) - h) <= 0.001 &&
          Math.abs(Number(this._surfaceMaskScratchRT.resolution || 1) - res) <= 0.0001
        ) {
          return this._surfaceMaskScratchRT;
        }
        if (
          this.#canBindRenderTexture(temporaryScratchRT) &&
          Math.abs(Number(temporaryScratchRT.width ?? 0) - w) <= 0.001 &&
          Math.abs(Number(temporaryScratchRT.height ?? 0) - h) <= 0.001 &&
          Math.abs(Number(temporaryScratchRT.resolution || 1) - res) <= 0.0001
        ) {
          return temporaryScratchRT;
        }
        try {
          temporaryScratchRT?.destroy?.(true);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        temporaryScratchRT = PIXI.RenderTexture.create({ width: w, height: h, resolution: res });
        this.#configureRenderTexture(temporaryScratchRT);
        return temporaryScratchRT;
      },
    };

    let rendered = false;
    try {
      for (const regions of regionsByLevel.values()) {
        for (const regionDoc of regions) {
          const adapter = { document: regionDoc };
          let regionMask = null;
          try {
            regionMask = buildRegionMaskRT(adapter, { rtPool: pool, edgeFadePercent: 0 });
          } catch (err) {
            logger.debug("FXMaster:", err);
            regionMask = null;
          }
          if (!regionMask) continue;
          this.#blit(regionMask, renderTexture, { clear: false });
          rendered = true;
        }
      }
    } finally {
      try {
        temporaryScratchRT?.destroy?.(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    if (rendered) return this.#rememberLevelSegmentMaskTexture(cacheKey, renderTexture);
    try {
      renderTexture.destroy?.(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    return null;
  }

  /**
   * Intersect a selected-Level coverage mask with public Define Surface footprints, when such footprints exist for the Level. This is deliberately tied to `includeTilesOnlyWithoutLevelSurface`, the scene-row path that prevents tiles from expanding selected Level masks.
   *
   * @param {string|null|undefined} levelId
   * @param {PIXI.RenderTexture|null|undefined} renderTexture
   * @param {boolean} enabled
   * @returns {boolean}
   */
  #clipLevelMaskToDefinedSurfaceFootprint(levelId, renderTexture, enabled) {
    if (!enabled || !levelId || !renderTexture) return true;
    const footprintMask = this.#captureDefinedSurfaceFootprintMaskForLevelIds([levelId]);
    if (!footprintMask) return true;

    const clipped = this.#intersectMasksInto(renderTexture, footprintMask, this._maskIntersectionRT);
    if (!clipped) return false;
    if (clipped !== renderTexture) this.#blit(clipped, renderTexture, { clear: true });
    return true;
  }

  /**
   * Return whether configured Level artwork may be used as a selected-Level mask fallback.
   *
   * Live native overlay meshes remain preferred because they carry hover/reveal alpha, but Foundry does not always expose a directly identifiable surface for the viewed Level or for an overhead Level after a view switch. The fallback is limited to Levels that are current, marked visible, or still have a live visible canvas surface so hidden Levels do not receive full-scene particles.
   *
   * @param {string|null|undefined} levelId
   * @param {{ foregroundOnly?: boolean, includeTiles?: boolean, strictLevelIdentity?: boolean, allowSceneRectFallback?: boolean }} [options]
   * @returns {boolean}
   */
  #levelCanUseConfiguredImageFallbackForMask(
    levelId,
    { foregroundOnly = false, includeTiles = true, strictLevelIdentity = false, allowSceneRectFallback = false } = {},
  ) {
    if (!levelId) return false;
    if (!this.#configuredLevelImageMaskBoundsAvailable(levelId, { foregroundOnly, allowSceneRectFallback }))
      return false;
    if (this.#levelIsCurrentCanvasView(levelId)) return true;

    const level = this.#getSceneLevelById(levelId);
    if (!level) return false;
    if (level?.isVisible || level?.isView) return true;

    return this.#levelHasVisibleSurfacePixels(level, { includeTiles, strictLevelIdentity });
  }

  /**
   * Capture one Level's selected surface into a supplied render texture.
   *
   * Non-current Levels are captured from their live primary overlay/tile meshes. The current viewed Level first tries live configured artwork meshes and only uses authored-image placement metadata when it can be resolved without falling back to the full scene rectangle.
   *
   * @param {string|null|undefined} levelId
   * @param {PIXI.RenderTexture|null|undefined} renderTexture
   * @param {{ foregroundOnly?: boolean, binary?: boolean, clear?: boolean, includeTiles?: boolean, strictLevelIdentity?: boolean, includeExplicitMultiLevelTiles?: boolean, includeTilesOnlyWithoutLevelSurface?: boolean }} [options]
   * @returns {boolean}
   */
  #captureLevelSurfaceMask(
    levelId,
    renderTexture,
    {
      foregroundOnly = false,
      binary = true,
      clear = true,
      includeTiles = true,
      strictLevelIdentity = false,
      includeExplicitMultiLevelTiles = false,
      includeTilesOnlyWithoutLevelSurface = false,
    } = {},
  ) {
    if (!levelId || !renderTexture) return false;
    const level = this.#getSceneLevelById(levelId);
    const levelVisible = !!(level?.isVisible || level?.isView || this.#levelIsCurrentCanvasView(levelId));

    let rendered = false;
    const levelIds = new Set([levelId]);
    const effectiveIncludeTiles =
      !foregroundOnly &&
      includeTiles &&
      !(includeTilesOnlyWithoutLevelSurface && this.#levelHasSelectedNonTileSurfaceCoverage(levelId));
    const objects = foregroundOnly
      ? this.#collectVisibleForegroundSurfaceObjectsForLevelIds(levelIds)
      : this.#collectVisibleSurfaceObjectsForLevelIds(levelIds, {
          includeTiles: effectiveIncludeTiles,
          strictLevelIdentity,
          includeExplicitMultiLevelTiles,
        });
    const allowSceneRectConfiguredFallback = false;
    const canUseConfiguredImageFallback = this.#levelCanUseConfiguredImageFallbackForMask(levelId, {
      foregroundOnly,
      includeTiles: effectiveIncludeTiles,
      strictLevelIdentity,
      allowSceneRectFallback: allowSceneRectConfiguredFallback,
    });

    if (!levelVisible && !objects.length && !canUseConfiguredImageFallback) return false;
    if (clear && !this.#clearRenderTexture(renderTexture)) return false;

    const hasLiveForegroundCandidate = foregroundOnly
      ? this.#hasForegroundSurfaceCandidatesForLevelIds(levelIds)
      : false;
    const useConfiguredImageFallback = foregroundOnly
      ? canUseConfiguredImageFallback && !hasLiveForegroundCandidate
      : canUseConfiguredImageFallback && !objects.length;

    if (useConfiguredImageFallback) {
      rendered =
        this.#renderConfiguredLevelImageMask(levelId, renderTexture, {
          foregroundOnly,
          clear: false,
          binary,
          allowSceneRectFallback: allowSceneRectConfiguredFallback,
        }) || rendered;
    }

    if (objects.length) {
      rendered =
        (binary
          ? this.#captureSurfaceMaskTexture(objects, renderTexture, { clear: false })
          : this.#captureSurfaceAlphaMaskTexture(objects, renderTexture, { clear: false })) || rendered;
    }

    if (rendered && includeTilesOnlyWithoutLevelSurface) {
      rendered = this.#clipLevelMaskToDefinedSurfaceFootprint(levelId, renderTexture, true) && rendered;
    }

    return rendered;
  }

  /**
   * Capture one selected Level contribution into a union mask without allowing footprint clipping for that Level to erase coverage that was already added by another selected Level.
   *
   * v41 clipped the shared selected-Level render texture in-place after every Level capture. For rows assigned to Levels 1 and 3, the later Level 3 footprint could trim away already-rendered full Level 1 coverage. Isolate each footprint-clipped Level in a scratch texture first, then add that per-Level result to the union.
   *
   * @param {string|null|undefined} levelId
   * @param {PIXI.RenderTexture|null|undefined} renderTexture
   * @param {{ foregroundOnly?: boolean, binary?: boolean, clear?: boolean, includeTiles?: boolean, strictLevelIdentity?: boolean, includeExplicitMultiLevelTiles?: boolean, includeTilesOnlyWithoutLevelSurface?: boolean }} [options]
   * @returns {boolean}
   */
  #captureLevelSurfaceMaskIntoUnion(levelId, renderTexture, options = {}) {
    if (!levelId || !renderTexture) return false;

    const clear = options?.clear !== false;
    const needsIsolatedFootprintClip =
      !clear &&
      options?.includeTilesOnlyWithoutLevelSurface === true &&
      this.#getDefinedSurfaceFootprintRegionsForLevel(levelId).length > 0;

    if (!needsIsolatedFootprintClip) return this.#captureLevelSurfaceMask(levelId, renderTexture, options);

    const scratch = this._selectedLevelSurfaceScratchRT;
    if (!this.#canBindRenderTexture(scratch) || this.#texturesShareBaseTexture(scratch, renderTexture)) {
      /**
       * Safe fallback: do not run the in-place footprint clip against the shared union mask. This may allow a broad tile-only contribution for this frame, but it avoids removing unrelated selected Levels from the same row. The scratch RT should normally be available after compositor texture setup.
       */
      return this.#captureLevelSurfaceMask(levelId, renderTexture, {
        ...options,
        includeTilesOnlyWithoutLevelSurface: false,
      });
    }

    const captured = this.#captureLevelSurfaceMask(levelId, scratch, {
      ...options,
      clear: true,
    });
    if (!captured) return false;

    this.#blit(scratch, renderTexture, { clear: false });
    return true;
  }

  /**
   * Return whether a selected-Level row has any visible target surface this frame.
   *
   * This intentionally avoids rendering the combined selected-Level mask up front. The draw-order compositor renders the required masks later, and the object collection is frame-cached.
   *
   * @param {object|null|undefined} row
   * @returns {boolean}
   */
  #rowHasVisibleSelectedLevelSurfaces(row) {
    if (!this.#rowUsesSelectedLevelSurfaceMask(row)) return false;

    const allowedLevelIds = this.#getRowAllowedLevelIds(row);
    if (!(allowedLevelIds?.size > 0)) return false;
    const includeTiles = this.#rowIncludesTileSurfacesInLevelMasks(row);
    const includeExplicitMultiLevelTiles = this.#rowHonorsExplicitMultiLevelTileAssignments(row);
    const includeTilesOnlyWithoutLevelSurface = this.#rowLimitsSelectedLevelTilesToFallbackSurfaces(row);
    for (const levelId of allowedLevelIds) {
      const effectiveIncludeTiles =
        includeTiles && !(includeTilesOnlyWithoutLevelSurface && this.#levelHasSelectedNonTileSurfaceCoverage(levelId));
      const levelIds = new Set([levelId]);
      if (
        this.#collectVisibleSurfaceObjectsForLevelIds(levelIds, {
          includeTiles: effectiveIncludeTiles,
          includeExplicitMultiLevelTiles,
        }).length
      )
        return true;
      if (
        this.#levelCanUseConfiguredImageFallbackForMask(levelId, {
          includeTiles: effectiveIncludeTiles,
          strictLevelIdentity: false,
          allowSceneRectFallback: true,
        })
      )
        return true;
    }

    return false;
  }

  /**
   * Return a per-frame binary mask of selected Scene Level surfaces for a row.
   *
   * @param {object|null|undefined} row
   * @returns {PIXI.RenderTexture|null}
   */
  #getSelectedLevelSurfaceMaskTextureForRow(row) {
    if (!this.#rowUsesSelectedLevelSurfaceMask(row)) return null;

    const allowedLevelIds = this.#getRowAllowedLevelIds(row);
    if (!(allowedLevelIds?.size > 0)) return null;

    const includeTiles = this.#rowIncludesTileSurfacesInLevelMasks(row);
    const includeExplicitMultiLevelTiles = this.#rowHonorsExplicitMultiLevelTileAssignments(row);
    const includeTilesOnlyWithoutLevelSurface = this.#rowLimitsSelectedLevelTilesToFallbackSurfaces(row);
    const footprintKey = includeTilesOnlyWithoutLevelSurface
      ? this.#definedSurfaceFootprintSignatureForLevelIds(allowedLevelIds)
      : "footprint:unused";
    const key = this.#selectedLevelSurfaceMaskKey(
      allowedLevelIds,
      `${includeTiles ? "surface:tiles" : "surface:no-tiles"}:explicitMultiTiles:${
        includeExplicitMultiLevelTiles ? 1 : 0
      }:fallbackTiles:${includeTilesOnlyWithoutLevelSurface ? 1 : 0}:footprint:${footprintKey}`,
    );
    if (
      this._selectedLevelSurfaceFrameSerial === this._renderFrameSerial &&
      this._selectedLevelSurfaceFrameKey === key
    ) {
      return this._selectedLevelSurfaceFrameTexture ?? null;
    }
    if (
      this._selectedLevelSurfacePersistentKey === key &&
      this._selectedLevelSurfaceRT &&
      !this._selectedLevelSurfaceRT.destroyed
    ) {
      this._selectedLevelSurfaceFrameSerial = this._renderFrameSerial;
      this._selectedLevelSurfaceFrameKey = key;
      this._selectedLevelSurfaceFrameTexture = this._selectedLevelSurfaceRT;
      return this._selectedLevelSurfaceRT;
    }

    const remember = (value) => {
      this._selectedLevelSurfaceFrameSerial = this._renderFrameSerial;
      this._selectedLevelSurfaceFrameKey = key;
      this._selectedLevelSurfaceFrameTexture = value ?? null;
      this._selectedLevelSurfacePersistentKey = value ? key : null;
      return value ?? null;
    };

    if (!this._selectedLevelSurfaceRT) return remember(null);
    if (!this.#clearRenderTexture(this._selectedLevelSurfaceRT)) return remember(null);

    let rendered = false;
    for (const levelId of allowedLevelIds) {
      rendered =
        this.#captureLevelSurfaceMaskIntoUnion(levelId, this._selectedLevelSurfaceRT, {
          binary: true,
          clear: false,
          includeTiles,
          includeExplicitMultiLevelTiles,
          includeTilesOnlyWithoutLevelSurface,
        }) || rendered;
    }

    return remember(rendered ? this._selectedLevelSurfaceRT : null);
  }

  /**
   * Return a per-frame binary selected-Level mask for direct scene-particle rendering.
   *
   * This uses a dedicated render texture because selected-Level compositing reuses _selectedLevelSurfaceRT for segment masks later in the same row. Keeping the particle override separate prevents that later compositor work from mutating the live container mask while the particle layer is rendering.
   *
   * @param {object|null|undefined} row
   * @returns {PIXI.RenderTexture|null}
   */
  #getParticleSelectedLevelMaskTextureForRow(row) {
    if (!this.#rowUsesSelectedLevelSurfaceMask(row)) return null;

    const allowedLevelIds = this.#getRowAllowedLevelIds(row);
    if (!(allowedLevelIds?.size > 0)) return null;

    const includeTiles = this.#rowIncludesTileSurfacesInLevelMasks(row);
    const includeExplicitMultiLevelTiles = this.#rowHonorsExplicitMultiLevelTileAssignments(row);
    const includeTilesOnlyWithoutLevelSurface = this.#rowLimitsSelectedLevelTilesToFallbackSurfaces(row);
    const footprintKey = includeTilesOnlyWithoutLevelSurface
      ? this.#definedSurfaceFootprintSignatureForLevelIds(allowedLevelIds)
      : "footprint:unused";
    const key = this.#selectedLevelSurfaceMaskKey(
      allowedLevelIds,
      `${includeTiles ? "particle-surface:tiles" : "particle-surface:no-tiles"}:explicitMultiTiles:${
        includeExplicitMultiLevelTiles ? 1 : 0
      }:fallbackTiles:${includeTilesOnlyWithoutLevelSurface ? 1 : 0}:footprint:${footprintKey}`,
    );
    if (
      this._particleSelectedLevelMaskFrameSerial === this._renderFrameSerial &&
      this._particleSelectedLevelMaskFrameKey === key
    ) {
      return this._particleSelectedLevelMaskFrameTexture ?? null;
    }
    if (
      this._particleSelectedLevelMaskPersistentKey === key &&
      this._particleSelectedLevelMaskRT &&
      !this._particleSelectedLevelMaskRT.destroyed
    ) {
      this._particleSelectedLevelMaskFrameSerial = this._renderFrameSerial;
      this._particleSelectedLevelMaskFrameKey = key;
      this._particleSelectedLevelMaskFrameTexture = this._particleSelectedLevelMaskRT;
      return this._particleSelectedLevelMaskRT;
    }

    const remember = (value) => {
      this._particleSelectedLevelMaskFrameSerial = this._renderFrameSerial;
      this._particleSelectedLevelMaskFrameKey = key;
      this._particleSelectedLevelMaskFrameTexture = value ?? null;
      this._particleSelectedLevelMaskPersistentKey = value ? key : null;
      return value ?? null;
    };

    if (!this._particleSelectedLevelMaskRT) return remember(null);
    if (!this.#clearRenderTexture(this._particleSelectedLevelMaskRT)) return remember(null);

    let rendered = false;
    for (const levelId of allowedLevelIds) {
      rendered =
        this.#captureLevelSurfaceMaskIntoUnion(levelId, this._particleSelectedLevelMaskRT, {
          binary: true,
          clear: false,
          includeTiles,
          includeExplicitMultiLevelTiles,
          includeTilesOnlyWithoutLevelSurface,
        }) || rendered;
    }

    return remember(rendered ? this._particleSelectedLevelMaskRT : null);
  }

  /**
   * Return a cached binary mask for selected Scene Level foreground surfaces.
   *
   * Foreground restoration must be coverage-based rather than alpha-weighted; otherwise hover-faded/native translucent foregrounds only restore part of the pre-filter frame and leave a visible color-filter residue.
   *
   * @param {object|null|undefined} row
   * @returns {PIXI.RenderTexture|null}
   */
  #getSelectedLevelForegroundMaskTextureForRow(row) {
    if (!this.#rowUsesSelectedLevelSurfaceMask(row)) return null;

    const allowedLevelIds = this.#getRowAllowedLevelIds(row);
    if (!(allowedLevelIds?.size > 0)) return null;

    const key = this.#selectedLevelSurfaceMaskKey(allowedLevelIds, "foreground");
    if (
      this._selectedLevelForegroundFrameSerial === this._renderFrameSerial &&
      this._selectedLevelForegroundFrameKey === key
    ) {
      return this._selectedLevelForegroundFrameTexture ?? null;
    }
    if (
      this._selectedLevelForegroundPersistentKey === key &&
      this._selectedLevelForegroundRT &&
      !this._selectedLevelForegroundRT.destroyed
    ) {
      this._selectedLevelForegroundFrameSerial = this._renderFrameSerial;
      this._selectedLevelForegroundFrameKey = key;
      this._selectedLevelForegroundFrameTexture = this._selectedLevelForegroundRT;
      return this._selectedLevelForegroundRT;
    }

    const remember = (value) => {
      this._selectedLevelForegroundFrameSerial = this._renderFrameSerial;
      this._selectedLevelForegroundFrameKey = key;
      this._selectedLevelForegroundFrameTexture = value ?? null;
      this._selectedLevelForegroundPersistentKey = value ? key : null;
      return value ?? null;
    };

    if (!this._selectedLevelForegroundRT) return remember(null);
    if (!this.#clearRenderTexture(this._selectedLevelForegroundRT)) return remember(null);

    let rendered = false;
    for (const levelId of allowedLevelIds) {
      rendered =
        this.#captureLevelSurfaceMask(levelId, this._selectedLevelForegroundRT, {
          foregroundOnly: true,
          binary: true,
          clear: false,
        }) || rendered;
    }

    return remember(rendered ? this._selectedLevelForegroundRT : null);
  }

  /**
   * Return visible Scene Level ids in draw order for selected-row compositing.
   *
   * @returns {string[]}
   */
  #getVisibleSceneLevelIdsInDrawOrder() {
    if (
      this._visibleSceneLevelIdsFrameSerial === this._renderFrameSerial &&
      Array.isArray(this._visibleSceneLevelIdsFrameValue)
    ) {
      return this._visibleSceneLevelIdsFrameValue;
    }

    const ids = this.#getSceneLevels()
      .filter(
        (level) =>
          level?.id && this.#levelIsVisibleForCompositing(level, { includeTiles: true, strictLevelIdentity: true }),
      )
      .sort((a, b) => {
        const bottomA = Number(a?.elevation?.bottom ?? a?.bottom ?? 0);
        const bottomB = Number(b?.elevation?.bottom ?? b?.bottom ?? 0);
        const topA = Number(a?.elevation?.top ?? a?.top ?? bottomA);
        const topB = Number(b?.elevation?.top ?? b?.top ?? bottomB);
        return bottomA - bottomB || topA - topB;
      })
      .map((level) => level.id);

    this._visibleSceneLevelIdsFrameSerial = this._renderFrameSerial;
    this._visibleSceneLevelIdsFrameValue = ids;
    return ids;
  }

  /**
   * Build contiguous selected/restore segments for selected-Level compositing.
   *
   * @param {Set<string>|null|undefined} selectedLevelIds
   * @returns {Array<{ type: "selected"|"restore", levelIds: string[] }>}
   */
  #buildSelectedLevelCompositeSegments(selectedLevelIds) {
    if (!(selectedLevelIds?.size > 0)) return [];

    const cacheKey = this.#levelIdsCacheKey(selectedLevelIds);
    const frameCache = this._selectedLevelCompositeSegmentsFrameCache;
    if (frameCache?.has(cacheKey)) return frameCache.get(cacheKey) ?? [];

    const segments = [];
    let hasSelectedBelow = false;
    let current = null;

    for (const levelId of this.#getVisibleSceneLevelIdsInDrawOrder()) {
      const selected = selectedLevelIds.has(levelId);
      if (!selected && !hasSelectedBelow) continue;
      if (selected) hasSelectedBelow = true;

      const type = selected ? "selected" : "restore";
      if (current?.type === type) {
        current.levelIds.push(levelId);
      } else {
        current = { type, levelIds: [levelId] };
        segments.push(current);
      }
    }

    frameCache?.set(cacheKey, segments);
    return segments;
  }

  /**
   * Return whether a selected segment covers exactly the row's selected Level set.
   *
   * A direct scene-particle mask override is a union of every selected Level. Reusing that union for each selected segment breaks non-contiguous selections. The union override is only safe when the active selected segment contains the entire selected set.
   *
   * @param {string[]|Set<string>|null|undefined} segmentLevelIds
   * @param {Set<string>|null|undefined} selectedLevelIds
   * @returns {boolean}
   */
  #selectedSegmentCoversAllSelectedLevels(segmentLevelIds, selectedLevelIds) {
    if (!(selectedLevelIds?.size > 0)) return false;
    const segmentIds = new Set(Array.from(segmentLevelIds ?? []).filter(Boolean));
    if (segmentIds.size !== selectedLevelIds.size) return false;
    for (const levelId of selectedLevelIds) {
      if (!segmentIds.has(levelId)) return false;
    }
    return true;
  }

  /**
   * Capture a binary mask for a group of visible Scene Level effect surfaces.
   *
   * @param {string[]|Set<string>|null|undefined} levelIds
   * @param {{ includeTiles?: boolean, strictLevelIdentity?: boolean, includeExplicitMultiLevelTiles?: boolean, includeTilesOnlyWithoutLevelSurface?: boolean }} [options]
   * @returns {PIXI.RenderTexture|null}
   */
  #captureSelectedLevelSurfaceMaskForLevelIds(
    levelIds,
    {
      includeTiles = true,
      strictLevelIdentity = false,
      includeExplicitMultiLevelTiles = false,
      includeTilesOnlyWithoutLevelSurface = false,
    } = {},
  ) {
    const ids = Array.from(levelIds ?? []).filter(Boolean);
    if (!ids.length) return null;

    const cacheKey = this.#levelSegmentMaskCacheKey("selected-surface", ids, {
      includeTiles,
      strictLevelIdentity,
      includeExplicitMultiLevelTiles,
      includeTilesOnlyWithoutLevelSurface,
    });
    const cached = this.#getCachedLevelSegmentMaskTexture(cacheKey);
    if (cached) return cached;

    const renderTexture = this.#createLevelSegmentMaskTexture(cacheKey);
    if (!renderTexture) return null;
    if (!this.#clearRenderTexture(renderTexture)) {
      try {
        renderTexture.destroy?.(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      return null;
    }

    let rendered = false;
    for (const levelId of ids) {
      rendered =
        this.#captureLevelSurfaceMaskIntoUnion(levelId, renderTexture, {
          binary: true,
          clear: false,
          includeTiles,
          strictLevelIdentity,
          includeExplicitMultiLevelTiles,
          includeTilesOnlyWithoutLevelSurface,
        }) || rendered;
    }

    if (rendered) return this.#rememberLevelSegmentMaskTexture(cacheKey, renderTexture);
    try {
      renderTexture.destroy?.(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    return null;
  }

  /**
   * Capture a binary coverage mask for a group of visible Scene Level restore surfaces.
   *
   * @param {string[]|Set<string>|null|undefined} levelIds
   * @param {Set<string>|null} [protectedLevelIds]
   * @param {{ includeTiles?: boolean }} [options]
   * @returns {PIXI.RenderTexture|null}
   */
  #captureSelectedLevelRestoreMaskForLevelIds(
    levelIds,
    protectedLevelIds = null,
    { includeTiles = true, strictLevelIdentity = false, protectExplicitMultiLevelTiles = false } = {},
  ) {
    const ids = new Set(Array.from(levelIds ?? []).filter(Boolean));
    if (!ids.size) return null;

    const objects = this.#collectVisualBlockerSurfaceObjectsForLevelIds(ids, {
      protectedLevelIds,
      includeTiles,
      strictLevelIdentity,
      protectExplicitMultiLevelTiles,
    });
    if (!objects.length) return null;

    const cacheKey = this.#levelSegmentMaskCacheKey("restore-surface", ids, {
      protectedLevelIds,
      includeTiles,
      strictLevelIdentity,
      protectExplicitMultiLevelTiles,
      objectSignature: this.#displayObjectMaskSignature(objects),
    });
    const cached = this.#getCachedLevelSegmentMaskTexture(cacheKey);
    if (cached) return cached;

    const renderTexture = this.#createLevelSegmentMaskTexture(cacheKey);
    if (!renderTexture) return null;
    const captured = this.#captureSurfaceMaskTexture(objects, renderTexture, { clear: true });
    if (captured) return this.#rememberLevelSegmentMaskTexture(cacheKey, renderTexture);

    try {
      renderTexture.destroy?.(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    return null;
  }

  /**
   * Capture a binary coverage mask for a group of visible Scene Level foreground surfaces.
   *
   * @param {string[]|Set<string>|null|undefined} levelIds
   * @returns {PIXI.RenderTexture|null}
   */
  #captureSelectedLevelForegroundMaskForLevelIds(levelIds) {
    const ids = Array.from(levelIds ?? []).filter(Boolean);
    if (!ids.length) return null;

    const cacheKey = this.#levelSegmentMaskCacheKey("selected-foreground", ids, {
      includeTiles: false,
      foregroundOnly: true,
    });
    const cached = this.#getCachedLevelSegmentMaskTexture(cacheKey);
    if (cached) return cached;

    const renderTexture = this.#createLevelSegmentMaskTexture(cacheKey);
    if (!renderTexture) return null;
    if (!this.#clearRenderTexture(renderTexture)) {
      try {
        renderTexture.destroy?.(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      return null;
    }

    let rendered = false;
    for (const levelId of ids) {
      rendered =
        this.#captureLevelSurfaceMask(levelId, renderTexture, {
          foregroundOnly: true,
          binary: true,
          clear: false,
        }) || rendered;
    }

    if (rendered) return this.#rememberLevelSegmentMaskTexture(cacheKey, renderTexture);
    try {
      renderTexture.destroy?.(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    return null;
  }

  /**
   * Capture a flattened binary mask for scene rows with multiple selected Levels.
   *
   * The normal draw-order path restores row output for each selected segment and restores row input for every visible unselected segment above a lower selected Level. For scene rows with non-contiguous selections, such as Levels 1 and 3 with Level 2 visible between them, the same result can be represented as one contribution mask: lower selected surfaces minus the intervening restore surfaces, then higher selected surfaces added back. This preserves the Level 2 blocker while reducing per-row masked restore passes from selected/restore/selected to a single masked restore.
   *
   * The optimization is intentionally not used for Below Foreground rows. Those rows restore foreground pixels after each selected segment, and flattening that path can change draw order around translucent or hover-faded foregrounds.
   *
   * @param {Set<string>|string[]|null|undefined} selectedLevelIds
   * @param {{ belowForeground?: boolean, restoreUnselectedAbove?: boolean, includeTiles?: boolean, strictLevelIdentity?: boolean, restoreStrictLevelIdentity?: boolean, includeExplicitMultiLevelTiles?: boolean, includeTilesOnlyWithoutLevelSurface?: boolean, protectExplicitMultiLevelTiles?: boolean }} [options]
   * @returns {PIXI.RenderTexture|null}
   */
  #captureFlattenedLevelCompositeMaskForLevelIds(
    selectedLevelIds,
    {
      belowForeground = false,
      restoreUnselectedAbove = true,
      includeTiles = true,
      strictLevelIdentity = false,
      restoreStrictLevelIdentity = strictLevelIdentity,
      includeExplicitMultiLevelTiles = false,
      includeTilesOnlyWithoutLevelSurface = false,
      protectExplicitMultiLevelTiles = false,
    } = {},
  ) {
    if (!(selectedLevelIds?.size > 1)) return null;
    if (belowForeground || !restoreUnselectedAbove) return null;

    const cacheKey = this.#levelSegmentMaskCacheKey(
      `flattened-level-composite:restoreStrict:${restoreStrictLevelIdentity ? 1 : 0}`,
      selectedLevelIds,
      {
        includeTiles,
        strictLevelIdentity,
        includeExplicitMultiLevelTiles,
        includeTilesOnlyWithoutLevelSurface,
        protectExplicitMultiLevelTiles,
      },
    );
    const cached = this.#getCachedLevelSegmentMaskTexture(cacheKey);
    if (cached) return cached;

    const renderTexture = this.#createLevelSegmentMaskTexture(cacheKey);
    if (!renderTexture) return null;
    if (!this.#clearRenderTexture(renderTexture)) {
      try {
        renderTexture.destroy?.(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      return null;
    }

    let rendered = false;
    for (const segment of this.#buildSelectedLevelCompositeSegments(selectedLevelIds)) {
      if (!segment?.levelIds?.length) continue;

      if (segment.type === "selected") {
        const selectedMask = this.#captureSelectedLevelSurfaceMaskForLevelIds(segment.levelIds, {
          includeTiles,
          strictLevelIdentity,
          includeExplicitMultiLevelTiles,
          includeTilesOnlyWithoutLevelSurface,
        });
        if (!selectedMask) continue;

        this.#blit(selectedMask, renderTexture, { clear: false });
        rendered = true;
        continue;
      }

      if (!rendered) continue;
      const restoreMask = this.#captureSelectedLevelRestoreMaskForLevelIds(segment.levelIds, selectedLevelIds, {
        includeTiles,
        strictLevelIdentity: restoreStrictLevelIdentity,
        protectExplicitMultiLevelTiles,
      });
      if (restoreMask) this.#eraseTextureFromRenderTexture(restoreMask, renderTexture);
    }

    if (rendered) return this.#rememberLevelSegmentMaskTexture(cacheKey, renderTexture);

    try {
      renderTexture.destroy?.(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    return null;
  }

  /**
   * Capture a persistent contribution mask for a single selected Level row.
   *
   * A single-Level row starts from the row input and only needs to copy row output into pixels that may actually receive the effect. Encoding foreground and upper-Level exclusions into one cached mask avoids per-frame restore passes for the common Region-on-one-Level case while preserving the same final pixels as selected-then-restore compositing.
   *
   * @param {Set<string>|string[]|null|undefined} selectedLevelIds
   * @param {{ belowForeground?: boolean, includeTiles?: boolean, strictLevelIdentity?: boolean, restoreStrictLevelIdentity?: boolean, includeExplicitMultiLevelTiles?: boolean, includeTilesOnlyWithoutLevelSurface?: boolean, protectExplicitMultiLevelTiles?: boolean }} [options]
   * @returns {PIXI.RenderTexture|null}
   */
  #captureSingleSelectedLevelContributionMaskForLevelIds(
    selectedLevelIds,
    {
      belowForeground = false,
      includeTiles = true,
      strictLevelIdentity = false,
      restoreStrictLevelIdentity = strictLevelIdentity,
      includeExplicitMultiLevelTiles = false,
      includeTilesOnlyWithoutLevelSurface = false,
      protectExplicitMultiLevelTiles = false,
    } = {},
  ) {
    const ids = Array.from(selectedLevelIds ?? []).filter(Boolean);
    if (ids.length !== 1) return null;

    const selectedSet = new Set(ids);
    const blockerIds = new Set();
    for (const segment of this.#buildSelectedLevelCompositeSegments(selectedSet)) {
      if (segment?.type !== "restore") continue;
      for (const levelId of segment.levelIds ?? []) {
        if (levelId) blockerIds.add(levelId);
      }
    }

    const cacheKey = this.#levelSegmentMaskCacheKey(
      `single-selected-contribution:belowForeground:${belowForeground ? 1 : 0}:restoreStrict:${
        restoreStrictLevelIdentity ? 1 : 0
      }`,
      ids,
      {
        protectedLevelIds: blockerIds,
        includeTiles,
        strictLevelIdentity,
        includeExplicitMultiLevelTiles,
        includeTilesOnlyWithoutLevelSurface,
        protectExplicitMultiLevelTiles,
        foregroundOnly: belowForeground,
      },
    );
    const cached = this.#getCachedLevelSegmentMaskTexture(cacheKey);
    if (cached) return cached;

    const selectedMask = this.#captureSelectedLevelSurfaceMaskForLevelIds(ids, {
      includeTiles,
      strictLevelIdentity,
      includeExplicitMultiLevelTiles,
      includeTilesOnlyWithoutLevelSurface,
    });
    if (!selectedMask) return null;

    const renderTexture = this.#createLevelSegmentMaskTexture(cacheKey);
    if (!renderTexture) return null;

    this.#blit(selectedMask, renderTexture, { clear: true });

    if (belowForeground) {
      const foregroundMask = this.#captureSelectedLevelForegroundMaskForLevelIds(ids);
      if (foregroundMask) this.#eraseTextureFromRenderTexture(foregroundMask, renderTexture);
    }

    if (blockerIds.size) {
      const blockerMask = this.#captureSelectedLevelRestoreMaskForLevelIds(blockerIds, selectedSet, {
        includeTiles,
        strictLevelIdentity: restoreStrictLevelIdentity,
        protectExplicitMultiLevelTiles,
      });
      if (blockerMask) this.#eraseTextureFromRenderTexture(blockerMask, renderTexture);
    }

    return this.#rememberLevelSegmentMaskTexture(cacheKey, renderTexture);
  }

  /**
   * Capture a binary mask for one visible Scene Level's effect surfaces.
   *
   * @param {string|null|undefined} levelId
   * @returns {PIXI.RenderTexture|null}
   */
  #captureSelectedLevelSurfaceMask(levelId) {
    if (!levelId || !this._selectedLevelSurfaceRT) return null;
    return this.#captureLevelSurfaceMask(levelId, this._selectedLevelSurfaceRT, { binary: true, clear: true })
      ? this._selectedLevelSurfaceRT
      : null;
  }

  /**
   * Capture a binary coverage mask for one visible Scene Level's restore surfaces.
   *
   * This is intentionally not alpha-weighted. Selected lower-Level filters are rendered underneath translucent upper overlays; restoring with the overlay's live alpha would blend the filtered lower frame back through the overlay and visually effect the unselected Level. A binary coverage restore preserves the original pre-pass composite wherever that Level surface contributes pixels, while fully hidden/transparent objects are still omitted by collection.
   *
   * @param {string|null|undefined} levelId
   * @returns {PIXI.RenderTexture|null}
   */
  #captureSelectedLevelRestoreMask(levelId, protectedLevelIds = null) {
    if (!levelId || !this._selectedLevelSurfaceRT) return null;
    return this.#captureSelectedLevelRestoreMaskForLevelIds([levelId], protectedLevelIds);
  }

  /**
   * Capture a binary coverage mask for one visible Scene Level's foreground surfaces.
   *
   * Below Foreground is expected to fully restore foreground pixels to the pre-effect frame. Using live alpha here can leave residual filtered pixels on hover-faded upper foregrounds.
   *
   * @param {string|null|undefined} levelId
   * @returns {PIXI.RenderTexture|null}
   */
  #captureSelectedLevelForegroundMask(levelId) {
    if (!levelId || !this._selectedLevelForegroundRT) return null;
    return this.#captureLevelSurfaceMask(levelId, this._selectedLevelForegroundRT, {
      foregroundOnly: true,
      binary: true,
      clear: true,
    })
      ? this._selectedLevelForegroundRT
      : null;
  }

  /**
   * Restore input pixels for unselected Levels above selected Level output.
   *
   * @param {Set<string>|null|undefined} selectedLevelIds
   * @param {PIXI.RenderTexture|null|undefined} rowInput
   * @param {PIXI.RenderTexture|null|undefined} output
   * @returns {void}
   */
  #restoreUnselectedLevelsAboveSelectedLevelOutput(selectedLevelIds, rowInput, output, { includeTiles = true } = {}) {
    if (!(selectedLevelIds?.size > 0) || !rowInput || !output) return;

    for (const segment of this.#buildSelectedLevelCompositeSegments(selectedLevelIds)) {
      if (segment?.type !== "restore") continue;
      const maskTexture = this.#captureSelectedLevelRestoreMaskForLevelIds(segment.levelIds, selectedLevelIds, {
        includeTiles,
      });
      if (maskTexture) this.#restoreFromTextureMask(maskTexture, rowInput, output);
    }
  }

  /**
   * Composite a selected-Level row in native Level draw order.
   *
   * Selected levels receive the row output, while unselected levels above a lower selected level restore the row input. A higher selected level is then composited afterward, preventing intermediate overlays from permanently erasing selected upper-level output.
   *
   * @param {object|null|undefined} row
   * @param {PIXI.RenderTexture|null|undefined} rowOutput
   * @param {PIXI.RenderTexture|null|undefined} rowInput
   * @param {PIXI.RenderTexture|null|undefined} output
   * @param {{ belowForeground?: boolean }} [options]
   * @returns {boolean}
   */
  #compositeSelectedLevelRowOutput(
    row,
    rowOutput,
    rowInput,
    output,
    { belowForeground = false, selectedMaskTexture = null } = {},
  ) {
    const selectedLevelIds = this.#getRowAllowedLevelIds(row);
    const flattenSceneLevelMasks =
      CONFIG?.fxmaster?.overheadPerformance?.flattenSceneLevelMasks !== false &&
      this.#getRowScope(row) === "scene" &&
      selectedLevelIds?.size > 1 &&
      !belowForeground &&
      !selectedMaskTexture;
    const honorExplicitMultiLevelTiles = this.#rowHonorsExplicitMultiLevelTileAssignments(row);
    const includeTilesOnlyWithoutLevelSurface = this.#rowLimitsSelectedLevelTilesToFallbackSurfaces(row);

    return this.#compositeLevelRowOutputForLevelIds(selectedLevelIds, rowOutput, rowInput, output, {
      belowForeground,
      restoreUnselectedAbove: true,
      selectedMaskTexture,
      includeTiles: this.#rowIncludesTileSurfacesInLevelMasks(row),
      flattenCompositeMask: flattenSceneLevelMasks,
      includeExplicitMultiLevelTiles: honorExplicitMultiLevelTiles,
      includeTilesOnlyWithoutLevelSurface,
      protectExplicitMultiLevelTiles: honorExplicitMultiLevelTiles,
    });
  }

  /**
   * Composite a Region row through its assigned Scene Levels in native draw order.
   *
   * Region rows already carry their own Region mask, but when a Region is assigned to non-contiguous Levels the simple upper-overlay restore path can draw an intermediate unassigned overlay above a higher assigned overlay. This path uses Level masks to restore interleaved unassigned Levels and then reapplies higher assigned Levels from the row output.
   *
   * @param {object|null|undefined} row
   * @param {PIXI.RenderTexture|null|undefined} rowOutput
   * @param {PIXI.RenderTexture|null|undefined} rowInput
   * @param {PIXI.RenderTexture|null|undefined} output
   * @param {{ belowForeground?: boolean }} [options]
   * @returns {boolean}
   */
  #compositeRegionLevelRowOutput(row, rowOutput, rowInput, output, { belowForeground = false } = {}) {
    const selectedLevelIds = this.#getRowAllowedLevelIds(row);
    return this.#compositeLevelRowOutputForLevelIds(selectedLevelIds, rowOutput, rowInput, output, {
      belowForeground,
      restoreUnselectedAbove: true,
      includeTiles: true,
      strictLevelIdentity: true,
      restoreStrictLevelIdentity: false,
    });
  }

  /**
   * Composite a row output through every currently visible Level surface while applying Below Foreground per Level.
   *
   * This is used for all-level rows. Restoring one unioned foreground mask after the full filter pass lets a higher Level foreground punch a hole through lower Levels. Processing visible Levels in draw order keeps each foreground cutout scoped to the Level surface that owns it.
   *
   * @param {PIXI.RenderTexture|null|undefined} rowOutput
   * @param {PIXI.RenderTexture|null|undefined} rowInput
   * @param {PIXI.RenderTexture|null|undefined} output
   * @returns {boolean}
   */
  #compositeVisibleLevelBelowForegroundRowOutput(rowOutput, rowInput, output) {
    const visibleLevelIds = new Set(this.#getVisibleSceneLevelIdsInDrawOrder());
    return this.#compositeLevelRowOutputForLevelIds(visibleLevelIds, rowOutput, rowInput, output, {
      belowForeground: true,
      restoreUnselectedAbove: false,
    });
  }

  /**
   * Return whether the visible V14 Level stack has enough live/configured coverage for Level-local Below Foreground compositing.
   *
   * @returns {boolean}
   */
  #hasVisibleLevelSurfacesForBelowForeground() {
    if (this._hasVisibleLevelSurfacesForBelowForegroundFrameSerial === this._renderFrameSerial) {
      return this._hasVisibleLevelSurfacesForBelowForegroundFrameValue === true;
    }

    const remember = (value) => {
      const resolved = value === true;
      this._hasVisibleLevelSurfacesForBelowForegroundFrameSerial = this._renderFrameSerial;
      this._hasVisibleLevelSurfacesForBelowForegroundFrameValue = resolved;
      return resolved;
    };

    if (!canvas?.level) return remember(false);
    const ids = new Set(this.#getVisibleSceneLevelIdsInDrawOrder());
    if (!ids.size) return remember(false);

    for (const levelId of ids) {
      const levelIds = new Set([levelId]);
      if (this.#collectVisibleSurfaceObjectsForLevelIds(levelIds).length) return remember(true);
      if (this.#configuredLevelImageMaskBoundsAvailable(levelId, { allowSceneRectFallback: true }))
        return remember(true);
    }

    return remember(false);
  }

  /**
   * Composite a row output through selected Scene Levels in native draw order.
   *
   * @param {Set<string>|null|undefined} selectedLevelIds
   * @param {PIXI.RenderTexture|null|undefined} rowOutput
   * @param {PIXI.RenderTexture|null|undefined} rowInput
   * @param {PIXI.RenderTexture|null|undefined} output
   * @param {{ belowForeground?: boolean, restoreUnselectedAbove?: boolean, selectedMaskTexture?: PIXI.RenderTexture|null, includeTiles?: boolean, strictLevelIdentity?: boolean, restoreStrictLevelIdentity?: boolean, includeExplicitMultiLevelTiles?: boolean, includeTilesOnlyWithoutLevelSurface?: boolean, protectExplicitMultiLevelTiles?: boolean, flattenCompositeMask?: boolean }} [options]
   * @returns {boolean}
   */
  #compositeLevelRowOutputForLevelIds(
    selectedLevelIds,
    rowOutput,
    rowInput,
    output,
    {
      belowForeground = false,
      restoreUnselectedAbove = true,
      selectedMaskTexture = null,
      includeTiles = true,
      strictLevelIdentity = false,
      restoreStrictLevelIdentity = strictLevelIdentity,
      includeExplicitMultiLevelTiles = false,
      includeTilesOnlyWithoutLevelSurface = false,
      protectExplicitMultiLevelTiles = false,
      flattenCompositeMask = false,
    } = {},
  ) {
    if (!rowOutput || !rowInput || !output) return false;
    if (!(selectedLevelIds?.size > 0)) return false;

    if (flattenCompositeMask && !selectedMaskTexture) {
      const flattenedMask = this.#captureFlattenedLevelCompositeMaskForLevelIds(selectedLevelIds, {
        belowForeground,
        restoreUnselectedAbove,
        includeTiles,
        strictLevelIdentity,
        restoreStrictLevelIdentity,
        includeExplicitMultiLevelTiles,
        includeTilesOnlyWithoutLevelSurface,
        protectExplicitMultiLevelTiles,
      });
      if (flattenedMask) {
        this.#blit(rowInput, output, { clear: true });
        this.#restoreFromTextureMask(flattenedMask, rowOutput, output);
        return true;
      }
    }

    const canUseSingleSelectedContributionMask =
      restoreUnselectedAbove && selectedLevelIds.size === 1 && !selectedMaskTexture;
    if (canUseSingleSelectedContributionMask) {
      const contributionMask = this.#captureSingleSelectedLevelContributionMaskForLevelIds(selectedLevelIds, {
        belowForeground,
        includeTiles,
        strictLevelIdentity,
        restoreStrictLevelIdentity,
        includeExplicitMultiLevelTiles,
        includeTilesOnlyWithoutLevelSurface,
        protectExplicitMultiLevelTiles,
      });
      if (contributionMask) {
        this.#blit(rowInput, output, { clear: true });
        this.#restoreFromTextureMask(contributionMask, rowOutput, output);
        return true;
      }
    }

    this.#blit(rowInput, output, { clear: true });

    const segments = restoreUnselectedAbove
      ? this.#buildSelectedLevelCompositeSegments(selectedLevelIds)
      : [
          {
            type: "selected",
            levelIds: this.#getVisibleSceneLevelIdsInDrawOrder().filter((levelId) => selectedLevelIds.has(levelId)),
          },
        ];

    let rendered = false;
    for (const segment of segments) {
      const selected = segment.type === "selected";

      if (selected && belowForeground) {
        for (const levelId of segment.levelIds ?? []) {
          const maskTexture = this.#captureSelectedLevelSurfaceMaskForLevelIds([levelId], {
            includeTiles,
            strictLevelIdentity,
            includeExplicitMultiLevelTiles,
            includeTilesOnlyWithoutLevelSurface,
          });
          if (!maskTexture) continue;

          this.#restoreFromTextureMask(maskTexture, rowOutput, output);
          const foregroundMaskTexture = this.#captureSelectedLevelForegroundMaskForLevelIds([levelId]);
          if (foregroundMaskTexture) this.#restoreFromTextureMask(foregroundMaskTexture, rowInput, output);
          rendered = true;
        }
        continue;
      }

      const canUseProvidedSelectedMask =
        selected &&
        selectedMaskTexture &&
        !belowForeground &&
        this.#selectedSegmentCoversAllSelectedLevels(segment.levelIds, selectedLevelIds);
      const maskTexture = selected
        ? canUseProvidedSelectedMask
          ? selectedMaskTexture
          : this.#captureSelectedLevelSurfaceMaskForLevelIds(segment.levelIds, {
              includeTiles,
              strictLevelIdentity,
              includeExplicitMultiLevelTiles,
              includeTilesOnlyWithoutLevelSurface,
            })
        : this.#captureSelectedLevelRestoreMaskForLevelIds(segment.levelIds, selectedLevelIds, {
            includeTiles,
            strictLevelIdentity: restoreStrictLevelIdentity,
            protectExplicitMultiLevelTiles,
          });
      if (!maskTexture) continue;

      if (selected) {
        this.#restoreFromTextureMask(maskTexture, rowOutput, output);
        rendered = true;
      } else {
        this.#restoreFromTextureMask(maskTexture, rowInput, output);
      }
    }

    return rendered;
  }

  /**
   * Temporarily hide a set of display objects while executing a callback.
   *
   * @template T
   * @param {PIXI.DisplayObject[]} objects
   * @param {() => T} callback
   * @returns {T}
   */
  #withTemporarilyHiddenObjects(objects, callback) {
    const states = [];

    try {
      for (const object of objects) {
        if (!object || object.destroyed) continue;
        states.push([object, object.visible, object.renderable]);
        object.visible = false;
        object.renderable = false;
      }

      return callback();
    } finally {
      for (let i = states.length - 1; i >= 0; i--) {
        const [object, visible, renderable] = states[i];
        try {
          if (!object || object.destroyed) continue;
          object.visible = visible;
          object.renderable = renderable;
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }
    }
  }

  /**
   * Determine whether a render texture can be safely bound by Pixi.
   *
   * @param {PIXI.RenderTexture|null|undefined} renderTexture
   * @returns {boolean}
   */
  #canBindRenderTexture(renderTexture) {
    const baseTexture = renderTexture?.baseTexture ?? null;
    if (!renderTexture || renderTexture.destroyed || !baseTexture || baseTexture.destroyed) return false;
    const resolution = Number(baseTexture.resolution ?? renderTexture.resolution ?? 1);
    return Number.isFinite(resolution) && resolution > 0;
  }

  /**
   * Return whether two texture-like values resolve to the same WebGL texture. Drawing a sprite that samples the active framebuffer texture triggers GL_INVALID_OPERATION feedback-loop errors in WebGL.
   *
   * @param {PIXI.Texture|PIXI.RenderTexture|null|undefined} a
   * @param {PIXI.Texture|PIXI.RenderTexture|null|undefined} b
   * @returns {boolean}
   */
  #texturesShareBaseTexture(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const baseA = a.baseTexture ?? a.texture?.baseTexture ?? null;
    const baseB = b.baseTexture ?? b.texture?.baseTexture ?? null;
    return !!baseA && !!baseB && baseA === baseB;
  }

  /**
   * Clear a render texture with an explicit transparent color.
   *
   * V13 can inherit the renderer's default clear color when a transparent particle-only stack pass blits an empty input with clear=true. If that default is opaque white, API-created particle rows leave a persistent white compositor texture behind the particles. Clearing through the render-texture/framebuffer systems avoids that renderer-default fallback.
   *
   * @param {PIXI.RenderTexture|null|undefined} renderTexture
   * @returns {boolean}
   */
  #clearRenderTextureTransparent(renderTexture) {
    const renderer = canvas?.app?.renderer;
    const renderTextureSystem = renderer?.renderTexture ?? null;
    if (!renderer || !renderTextureSystem?.bind || !this.#canBindRenderTexture(renderTexture)) return false;

    const previousTarget = renderTextureSystem.current ?? null;
    let bound = false;

    try {
      renderTextureSystem.bind(renderTexture);
      bound = true;

      if (typeof renderer.framebuffer?.clear === "function") {
        renderer.framebuffer.clear(0, 0, 0, 0);
        return true;
      }

      if (typeof renderTextureSystem.clear === "function") {
        try {
          renderTextureSystem.clear([0, 0, 0, 0]);
        } catch (_err) {
          renderTextureSystem.clear(0x000000, 0);
        }
        return true;
      }
    } catch (err) {
      logger.debug("FXMaster:", err);
    } finally {
      if (bound && this.#canBindRenderTexture(previousTarget)) {
        try {
          renderTextureSystem.bind(previousTarget);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }
    }

    return false;
  }

  /**
   * Clear a render texture to transparent.
   *
   * @param {PIXI.RenderTexture|null|undefined} renderTexture
   * @returns {boolean}
   */
  #clearRenderTexture(renderTexture) {
    const renderer = canvas?.app?.renderer;
    if (!renderer || !this.#canBindRenderTexture(renderTexture)) return false;

    if (this.#clearRenderTextureTransparent(renderTexture)) return true;

    const sprite = this._blitSprite;
    if (!sprite) return false;

    sprite.texture = PIXI.Texture.EMPTY;
    sprite.position.set(0, 0);
    sprite.scale.set(1, 1);
    sprite.width = 1;
    sprite.height = 1;
    sprite.filters = null;

    try {
      renderer.render(sprite, {
        renderTexture,
        clear: true,
        clearColor: [0, 0, 0, 0],
        skipUpdateTransform: false,
      });
      return true;
    } catch (err) {
      logger.debug("FXMaster:", err);
      return false;
    }
  }

  /**
   * Capture a transparent texture containing the currently visible upper-level surfaces.
   *
   * @param {PIXI.DisplayObject[]} objects
   * @param {PIXI.RenderTexture|null|undefined} renderTexture
   * @returns {boolean}
   */
  #captureUpperSurfaceTexture(objects, renderTexture) {
    const renderer = canvas?.app?.renderer;
    if (!renderer || !renderTexture) return false;
    if (!this.#clearRenderTexture(renderTexture)) return false;

    let rendered = false;
    for (const object of objects ?? []) {
      if (!object || object.destroyed) continue;
      try {
        renderer.render(object, {
          renderTexture,
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
   * Return the filter used to convert rendered artwork alpha into an opaque mask silhouette.
   *
   * @returns {PIXI.Filter|null}
   */
  #getBinaryMaskFilter() {
    if (this._binaryMaskFilter && !this._binaryMaskFilter.destroyed) return this._binaryMaskFilter;

    try {
      this._binaryMaskFilter = new PIXI.Filter(
        undefined,
        `
        varying vec2 vTextureCoord;
        uniform sampler2D uSampler;
        uniform float threshold;
        void main() {
          float alpha = texture2D(uSampler, vTextureCoord).a;
          float mask = step(threshold, alpha);
          gl_FragColor = vec4(mask, mask, mask, mask);
        }
      `,
        { threshold: 0.003 },
      );
      return this._binaryMaskFilter;
    } catch (err) {
      logger.debug("FXMaster:", err);
      return null;
    }
  }

  /**
   * Normalize a surface object iterable into renderable display objects.
   *
   * @param {PIXI.DisplayObject[]|Iterable<PIXI.DisplayObject>|null|undefined} objects
   * @returns {PIXI.DisplayObject[]}
   */
  #getRenderableSurfaceMaskObjects(objects) {
    const list = [];
    for (const object of objects ?? []) {
      if (!object || object.destroyed || object.visible === false || object.renderable === false) continue;
      list.push(object);
    }
    return list;
  }

  /**
   * Return whether surface mask batching is enabled.
   *
   * @returns {boolean}
   */
  #surfaceMaskBatchingEnabled() {
    return CONFIG?.fxmaster?.overheadPerformance?.batchedSurfaceMasks !== false;
  }

  /**
   * Render several existing display objects into one render texture pass.
   *
   * The objects remain parented in the Foundry/Levels display tree. The temporary list object forwards render calls through their existing world transforms, masks, and object-local filters, avoiding one top-level renderer.render call per tile/Level surface.
   *
   * @param {PIXI.DisplayObject[]} objects
   * @param {PIXI.RenderTexture|null|undefined} renderTexture
   * @returns {boolean}
   */
  #renderSurfaceMaskBatch(objects, renderTexture) {
    const renderer = canvas?.app?.renderer;
    const renderList = this._surfaceMaskRenderList;
    if (!renderer || !renderTexture || !renderList || renderList.destroyed) return false;
    if (!objects?.length) return false;

    renderList.__fxmObjects = objects;
    try {
      renderer.render(renderList, {
        renderTexture,
        clear: false,
        skipUpdateTransform: true,
      });
      return true;
    } catch (err) {
      logger.debug("FXMaster:", err);
      return false;
    } finally {
      renderList.__fxmObjects = [];
    }
  }

  /**
   * Threshold the grouped alpha scratch texture into a binary white coverage mask.
   *
   * @param {PIXI.RenderTexture|null|undefined} renderTexture
   * @param {{ clear?: boolean }} [options]
   * @returns {boolean}
   */
  #thresholdSurfaceMaskScratchInto(renderTexture, { clear = false } = {}) {
    const renderer = canvas?.app?.renderer;
    const sprite = this._surfaceMaskThresholdSprite;
    const scratch = this._surfaceMaskScratchRT;
    const maskFilter = this.#getBinaryMaskFilter();
    if (!renderer || !sprite || !scratch || !renderTexture || !maskFilter) return false;
    if (this.#texturesShareBaseTexture(scratch, renderTexture)) return false;
    if (clear && !this.#clearRenderTexture(renderTexture)) return false;

    const { width, height } = this.#getViewportMetrics();
    sprite.texture = scratch;
    sprite.position.set(0, 0);
    sprite.scale.set(1, 1);
    sprite.width = width;
    sprite.height = height;
    sprite.filters = [maskFilter];

    try {
      renderer.render(sprite, {
        renderTexture,
        clear: false,
        skipUpdateTransform: false,
      });
      return true;
    } catch (err) {
      logger.debug("FXMaster:", err);
      return false;
    } finally {
      sprite.filters = null;
      sprite.texture = PIXI.Texture.EMPTY;
    }
  }

  /**
   * Capture display objects into a binary alpha mask texture.
   *
   * @param {PIXI.DisplayObject[]} objects
   * @param {PIXI.RenderTexture|null|undefined} renderTexture
   * @param {{ clear?: boolean }} [options]
   * @returns {boolean}
   */
  #captureSurfaceMaskTexture(objects, renderTexture, { clear = true } = {}) {
    const renderer = canvas?.app?.renderer;
    const maskFilter = this.#getBinaryMaskFilter();
    if (!renderer || !renderTexture) return false;
    if (!maskFilter) return this.#captureSurfaceAlphaMaskTexture(objects, renderTexture, { clear });

    const candidates = this.#getRenderableSurfaceMaskObjects(objects);
    if (!candidates.length) {
      if (clear) this.#clearRenderTexture(renderTexture);
      return false;
    }

    if (
      this.#surfaceMaskBatchingEnabled() &&
      candidates.length > 1 &&
      this._surfaceMaskScratchRT &&
      !this._surfaceMaskScratchRT.destroyed &&
      this._surfaceMaskRenderList &&
      !this._surfaceMaskRenderList.destroyed &&
      this._surfaceMaskThresholdSprite &&
      !this._surfaceMaskThresholdSprite.destroyed
    ) {
      if (clear && !this.#clearRenderTexture(renderTexture)) return false;
      if (!this.#clearRenderTexture(this._surfaceMaskScratchRT)) return false;
      if (!this.#renderSurfaceMaskBatch(candidates, this._surfaceMaskScratchRT)) return false;
      return this.#thresholdSurfaceMaskScratchInto(renderTexture, { clear: false });
    }

    if (clear && !this.#clearRenderTexture(renderTexture)) return false;

    let rendered = false;
    for (const object of candidates) {
      const previousFilters = object.filters ?? null;
      try {
        object.filters =
          Array.isArray(previousFilters) && previousFilters.length ? [...previousFilters, maskFilter] : [maskFilter];
        renderer.render(object, {
          renderTexture,
          clear: false,
          skipUpdateTransform: true,
        });
        rendered = true;
      } catch (err) {
        logger.debug("FXMaster:", err);
      } finally {
        try {
          object.filters = previousFilters;
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }
    }

    return rendered;
  }

  /**
   * Capture display objects into an alpha mask texture using their live alpha.
   *
   * This remains available for masks that truly need proportional live alpha. Selected-Level isolation and Below Foreground restoration use binary coverage masks instead, because alpha-weighted restore lets filtered pixels remain visible underneath hover-faded overlay/foreground surfaces.
   *
   * @param {PIXI.DisplayObject[]} objects
   * @param {PIXI.RenderTexture|null|undefined} renderTexture
   * @param {{ clear?: boolean }} [options]
   * @returns {boolean}
   */
  #captureSurfaceAlphaMaskTexture(objects, renderTexture, { clear = true } = {}) {
    const renderer = canvas?.app?.renderer;
    if (!renderer || !renderTexture) return false;

    const candidates = this.#getRenderableSurfaceMaskObjects(objects);
    if (!candidates.length) {
      if (clear) this.#clearRenderTexture(renderTexture);
      return false;
    }

    if (
      this.#surfaceMaskBatchingEnabled() &&
      candidates.length > 1 &&
      this._surfaceMaskRenderList &&
      !this._surfaceMaskRenderList.destroyed &&
      this.#renderSurfaceMaskBatch(candidates, renderTexture)
    ) {
      return true;
    }

    if (clear && !this.#clearRenderTexture(renderTexture)) return false;

    let rendered = false;
    for (const object of candidates) {
      try {
        renderer.render(object, {
          renderTexture,
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
   * Ensure a per-key Region upper-surface mask RT exists for this viewport.
   *
   * A Map cache needs a distinct RT per active key; otherwise rendering one Region/Level key would overwrite the texture cached for another key later in the same compositor frame.
   *
   * @param {string} cacheKey
   * @returns {PIXI.RenderTexture|null}
   */
  #ensureRegionUpperVisibleRTForCacheKey(cacheKey) {
    const key = cacheKey || "default";
    if (!(this._regionUpperVisibleRTCache instanceof Map)) this._regionUpperVisibleRTCache = new Map();

    const { width, height, resolution } = this.#getViewportMetrics();
    const needsResize = (rt) => {
      if (!this.#canBindRenderTexture(rt)) return true;
      return rt.width !== width || rt.height !== height || (rt.resolution ?? 1) !== resolution;
    };

    let rt = this._regionUpperVisibleRTCache.get(key) ?? null;
    if (!needsResize(rt)) return rt;

    try {
      rt?.destroy?.(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    try {
      rt = PIXI.RenderTexture.create({ width, height, resolution });
      this.#configureRenderTexture(rt);
      this._regionUpperVisibleRTCache.set(key, rt);
      return rt;
    } catch (err) {
      logger.debug("FXMaster:", err);
      this._regionUpperVisibleRTCache.delete(key);
      return null;
    }
  }

  /**
   * Drop Region upper-surface overlay RTs that were not used this compositor frame.
   *
   * @param {Map<string, unknown>|Set<string>|null} activeKeys
   * @returns {void}
   */
  #pruneRegionUpperVisibleRTCache(activeKeys = null) {
    const cache = this._regionUpperVisibleRTCache;
    if (!(cache instanceof Map) || !cache.size) return;

    const keep =
      activeKeys instanceof Map
        ? new Set(
            Array.from(activeKeys.entries())
              .filter(([, value]) => !!(value?.overlayTexture || value?.overlayMaskTexture))
              .map(([key]) => key),
          )
        : activeKeys instanceof Set
        ? activeKeys
        : null;
    if (!keep) return;

    for (const [key, rt] of cache.entries()) {
      if (keep.has(key)) continue;
      try {
        rt?.destroy?.(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      cache.delete(key);
    }
  }

  /**
   * Return a stable signature for display objects rendered into a binary surface mask.
   *
   * The persistent mask cache is keyed by actual screen transform and texture/update state so static native Level surfaces can reuse their mask across frames while moved, faded, animated, or replaced surfaces recapture immediately.
   *
   * @param {PIXI.DisplayObject[]} objects
   * @returns {string}
   */
  #displayObjectMaskSignature(objects = []) {
    const parts = [];
    let index = 0;

    for (const object of objects ?? []) {
      if (!object || object.destroyed) continue;
      const matrix = object?.worldTransform ?? null;
      const matrixKey = [matrix?.a, matrix?.b, matrix?.c, matrix?.d, matrix?.tx, matrix?.ty]
        .map((value) => (Number.isFinite(Number(value)) ? Number(value).toFixed(3) : "NaN"))
        .join(",");
      const texture = object?.texture ?? object?.sprite?.texture ?? object?.mesh?.texture ?? null;
      const baseTexture = texture?.baseTexture ?? null;
      const textureKey = [
        baseTexture?.cacheId ?? baseTexture?.resource?.url ?? baseTexture?.resource?.src ?? baseTexture?.uid ?? "",
        texture?.uid ?? "",
        baseTexture?.dirtyId ?? baseTexture?.touched ?? "",
      ].join("/");
      const alpha = Number(object?.worldAlpha ?? object?.alpha ?? 1);
      const alphaKey = Number.isFinite(alpha) ? Math.round(alpha * 1000) : "NaN";
      const width = Number(object?.width ?? object?.bounds?.width ?? 0);
      const height = Number(object?.height ?? object?.bounds?.height ?? 0);
      const id = object?.id ?? object?.name ?? object?.label ?? object?.constructor?.name ?? index;
      parts.push(
        [
          id,
          textureKey,
          matrixKey,
          Number.isFinite(width) ? width.toFixed(2) : "NaN",
          Number.isFinite(height) ? height.toFixed(2) : "NaN",
          object?.visible === false ? 0 : 1,
          object?.renderable === false ? 0 : 1,
          alphaKey,
        ].join("~"),
      );
      index += 1;
    }

    return parts.sort().join(";");
  }

  /**
   * Build a persistent binary Level mask cache key.
   *
   * @param {string} prefix
   * @param {Set<string>|string[]|null|undefined} levelIds
   * @param {{ protectedLevelIds?: Set<string>|string[]|null, includeTiles?: boolean, strictLevelIdentity?: boolean, includeExplicitMultiLevelTiles?: boolean, includeTilesOnlyWithoutLevelSurface?: boolean, protectExplicitMultiLevelTiles?: boolean, foregroundOnly?: boolean, objectSignature?: string }} [options]
   * @returns {string}
   */
  #levelSegmentMaskCacheKey(
    prefix,
    levelIds,
    {
      protectedLevelIds = null,
      includeTiles = true,
      strictLevelIdentity = false,
      includeExplicitMultiLevelTiles = false,
      includeTilesOnlyWithoutLevelSurface = false,
      protectExplicitMultiLevelTiles = false,
      foregroundOnly = false,
      objectSignature = "",
    } = {},
  ) {
    const { width, height, resolution } = this.#getViewportMetrics();
    return [
      canvas?.scene?.id ?? "scene",
      prefix || "mask",
      this.#levelIdsCacheKey(levelIds),
      this.#levelIdsCacheKey(protectedLevelIds),
      includeTiles ? "tiles" : "no-tiles",
      strictLevelIdentity ? "strict" : "visual",
      includeExplicitMultiLevelTiles ? "explicit-multi-tiles" : "visual-multi-tiles",
      includeTilesOnlyWithoutLevelSurface ? "fallback-tiles" : "full-tiles",
      protectExplicitMultiLevelTiles ? "protect-explicit-multi-tiles" : "protect-visual-multi-tiles",
      foregroundOnly ? "foreground" : "surface",
      width,
      height,
      Number(resolution || 1).toFixed(3),
      this.#selectedLevelViewportMatrixKey(),
      this.#getLevelSurfaceSignatureForFrame(),
      objectSignature,
    ].join(":");
  }

  /**
   * Return a reusable cached Level segment mask when its contents are still valid.
   *
   * @param {string} cacheKey
   * @returns {PIXI.RenderTexture|null}
   */
  #getCachedLevelSegmentMaskTexture(cacheKey) {
    const cache = this._levelSegmentMaskRTCache;
    if (!(cache instanceof Map) || !cacheKey) return null;

    const renderTexture = cache.get(cacheKey) ?? null;
    if (!this.#canBindRenderTexture(renderTexture)) {
      if (renderTexture) {
        try {
          renderTexture?.destroy?.(true);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }
      cache.delete(cacheKey);
      return null;
    }

    renderTexture.__fxmLastUsedFrame = this._renderFrameSerial;
    return renderTexture;
  }

  /**
   * Create a new binary Level segment mask render texture for a cache key.
   *
   * @param {string} cacheKey
   * @returns {PIXI.RenderTexture|null}
   */
  #createLevelSegmentMaskTexture(cacheKey) {
    if (!cacheKey) return null;

    try {
      const { width, height, resolution } = this.#getViewportMetrics();
      const renderTexture = PIXI.RenderTexture.create({ width, height, resolution });
      this.#configureRenderTexture(renderTexture);
      renderTexture.__fxmLastUsedFrame = this._renderFrameSerial;
      renderTexture.__fxmLevelSegmentMaskKey = cacheKey;
      return renderTexture;
    } catch (err) {
      logger.debug("FXMaster:", err);
      return null;
    }
  }

  /**
   * Store a rendered Level segment mask for reuse on later frames.
   *
   * @param {string} cacheKey
   * @param {PIXI.RenderTexture|null|undefined} renderTexture
   * @returns {PIXI.RenderTexture|null}
   */
  #rememberLevelSegmentMaskTexture(cacheKey, renderTexture) {
    if (!cacheKey || !renderTexture) return null;
    if (!(this._levelSegmentMaskRTCache instanceof Map)) this._levelSegmentMaskRTCache = new Map();

    renderTexture.__fxmLastUsedFrame = this._renderFrameSerial;
    renderTexture.__fxmLevelSegmentMaskKey = cacheKey;
    this._levelSegmentMaskRTCache.set(cacheKey, renderTexture);
    return renderTexture;
  }

  /**
   * Drop persistent Level segment masks that were not used this frame.
   *
   * Keeping only currently reused masks gives steady-state frames the win while avoiding unbounded RT growth during mouse movement, level switches, and hover-fade transitions.
   *
   * @returns {void}
   */
  #pruneLevelSegmentMaskRTCache() {
    const cache = this._levelSegmentMaskRTCache;
    if (!(cache instanceof Map) || !cache.size) return;

    for (const [key, renderTexture] of cache.entries()) {
      if (renderTexture?.__fxmLastUsedFrame === this._renderFrameSerial) continue;
      try {
        renderTexture?.destroy?.(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      cache.delete(key);
    }
  }

  /**
   * Prepare a level-local restore mask for a Region-scoped compositor row.
   *
   * The mask identifies visible upper-level surfaces above the Region's assigned level. Those pixels are restored from the row input after the Region row renders, preserving any scene-level FX that have already been composited onto upper Levels instead of overwriting them with raw live canvas surfaces.
   *
   * @param {object|null|undefined} row
   * @param {Map<string, ({ overlayMaskTexture: PIXI.RenderTexture }|null)>|null} [cache=null]
   * @returns {{ overlayMaskTexture: PIXI.RenderTexture }|null}
   */
  #prepareRegionLevelLocalPass(row, cache = null) {
    if (this.#getRowScope(row) !== "region") return null;

    const targetLevel = this.#resolveRegionLocalTargetLevel(row);
    if (!targetLevel) return null;

    const protectedLevelIds = this.#getRegionAllowedLevelIds(row, targetLevel);
    const protectedKey = Array.from(protectedLevelIds ?? [])
      .sort()
      .join("|");
    const cacheKey = `${targetLevel?.id ?? "target"}:${protectedKey}`;
    if (cache instanceof Map && cache.has(cacheKey)) return cache.get(cacheKey) ?? null;

    const remember = (value) => {
      if (cache instanceof Map) cache.set(cacheKey, value ?? null);
      return value ?? null;
    };

    const upperObjects = this.#collectUpperSurfaceObjectsForTargetLevel(targetLevel, {
      protectedLevelIds,
      includeRevealed: true,
    });
    if (!upperObjects.length) return remember(null);

    const overlayMaskTexture = this.#ensureRegionUpperVisibleRTForCacheKey(cacheKey);
    if (!overlayMaskTexture) return remember(null);

    const contentKey = this.#levelSegmentMaskCacheKey("region-upper-surface", [targetLevel?.id].filter(Boolean), {
      protectedLevelIds,
      includeTiles: true,
      strictLevelIdentity: false,
      objectSignature: this.#displayObjectMaskSignature(upperObjects),
    });
    if (overlayMaskTexture.__fxmRegionUpperMaskContentKey === contentKey) {
      overlayMaskTexture.__fxmLastUsedFrame = this._renderFrameSerial;
      return remember({ overlayMaskTexture });
    }

    const capturedUpper = this.#captureSurfaceMaskTexture(upperObjects, overlayMaskTexture);
    if (!capturedUpper) return remember(null);
    overlayMaskTexture.__fxmRegionUpperMaskContentKey = contentKey;
    overlayMaskTexture.__fxmLastUsedFrame = this._renderFrameSerial;

    return remember({
      overlayMaskTexture,
    });
  }

  /**
   * Resolve scene Level ids a compositor row is intentionally allowed to affect.
   *
   * A null result means the row is not level-limited, usually because a scene effect applies to all levels.
   *
   * @param {object|null|undefined} row
   * @returns {Set<string>|null}
   */
  #getRowAllowedLevelIds(row) {
    if (!canvas?.level || !row?.uid) return null;

    const rowScope = this.#getRowScope(row);
    const cacheKey = `${rowScope ?? "scope"}:${row.kind ?? "kind"}:${row.uid}`;
    const frameCache = this._rowAllowedLevelIdsFrameCache;
    if (frameCache?.has(cacheKey)) return frameCache.get(cacheKey) ?? null;
    const remember = (value) => {
      frameCache?.set(cacheKey, value ?? null);
      return value ?? null;
    };

    if (rowScope === "region") {
      const targetLevel = this.#resolveRegionLocalTargetLevel(row);
      const ids = this.#getRegionAllowedLevelIds(row, targetLevel);
      return remember(ids instanceof Set ? ids : null);
    }

    if (rowScope !== "scene") return remember(null);

    const rowLevelContainers = [row?.options, row];
    for (const container of rowLevelContainers) {
      if (!container || typeof container !== "object" || !Object.hasOwn(container, "levels")) continue;
      const selected = getSelectedSceneLevelIds(container.levels?.value ?? container.levels, canvas?.scene ?? null);
      return remember(selected?.size ? selected : null);
    }

    const runtime = row.kind === "particle" ? this.#resolveParticleRuntime(row.uid) : null;
    const filter = row.kind === "filter" ? this.#resolveFilter(row.uid) : null;
    const candidates = [
      runtime?.options?.levels?.value,
      runtime?.options?.levels,
      runtime?.levels?.value,
      runtime?.levels,
      runtime?.fx?.__fxmLevels?.value,
      runtime?.fx?.__fxmLevels,
      runtime?.fx?.__fxmOptions?.levels?.value,
      runtime?.fx?.__fxmOptions?.levels,
      runtime?.fx?.options?.levels?.value,
      runtime?.fx?.options?.levels,
      filter?.__fxmLevels?.value,
      filter?.__fxmLevels,
      filter?.__fxmOptions?.levels?.value,
      filter?.__fxmOptions?.levels,
      filter?.options?.levels?.value,
      filter?.options?.levels,
    ];

    for (const candidate of candidates) {
      const selected = getSelectedSceneLevelIds(candidate, canvas?.scene ?? null);
      if (selected?.size) return remember(selected);
    }

    return remember(null);
  }

  /**
   * Return the highest native Scene Level represented by a set of ids.
   *
   * @param {Set<string>|null|undefined} levelIds
   * @returns {foundry.documents.Level|null}
   */
  #getHighestLevelForIds(levelIds) {
    if (!(levelIds?.size > 0)) return null;

    let highest = null;
    for (const levelId of levelIds) {
      const level = this.#getSceneLevelById(levelId);
      if (!level) continue;
      if (!highest || this.#levelIsAboveTargetLevel(level, highest)) highest = level;
    }
    return highest;
  }

  /**
   * Return whether a row needs V14 native-level surface restoration.
   *
   * @param {object|null|undefined} row
   * @returns {boolean}
   */
  #rowHasLevelLimitedOutput(row) {
    if (!canvas?.level || !row?.uid) return false;
    return this.#getRowVisualBlockerLevelIds(row)?.size > 0;
  }

  /**
   * Return visible unselected Level ids that should be restored above a selected-Level row.
   *
   * @param {object|null|undefined} row
   * @returns {Set<string>|null}
   */
  #getRowVisualBlockerLevelIds(row) {
    const allowedLevelIds = this.#getRowAllowedLevelIds(row);
    if (!(allowedLevelIds?.size > 0)) return null;

    const cacheKey = `${this.#getRowScope(row) ?? "scope"}:${row?.kind ?? "kind"}:${
      row?.uid ?? "uid"
    }:${this.#levelIdsCacheKey(allowedLevelIds)}`;
    const frameCache = this._rowVisualBlockerLevelIdsFrameCache;
    if (frameCache?.has(cacheKey)) return frameCache.get(cacheKey) ?? null;
    const remember = (value) => {
      frameCache?.set(cacheKey, value ?? null);
      return value ?? null;
    };

    const blockers = new Set();
    const selectedLevels = Array.from(allowedLevelIds)
      .map((levelId) => this.#getSceneLevelById(levelId))
      .filter(Boolean);
    if (!selectedLevels.length) return remember(null);

    for (const level of this.#getSceneLevels()) {
      if (!level?.id || allowedLevelIds.has(level.id)) continue;
      if (!this.#levelIsVisibleForCompositing(level, { includeTiles: true, strictLevelIdentity: true })) continue;
      if (selectedLevels.some((targetLevel) => this.#levelIsAboveTargetLevel(level, targetLevel)))
        blockers.add(level.id);
    }

    return remember(blockers.size ? blockers : null);
  }

  /**
   * Collect visible surfaces whose visual Level id belongs to the supplied blocker Level ids.
   *
   * @param {Set<string>|null|undefined} blockerLevelIds
   * @param {{ protectedLevelIds?: Set<string>|null, includeTiles?: boolean }} [options]
   * @returns {PIXI.DisplayObject[]}
   */
  #collectVisualBlockerSurfaceObjectsForLevelIds(
    blockerLevelIds,
    {
      protectedLevelIds = null,
      includeTiles = true,
      strictLevelIdentity = false,
      protectExplicitMultiLevelTiles = false,
    } = {},
  ) {
    if (!(blockerLevelIds?.size > 0) || !canvas?.primary) return [];

    const protectedKey = this.#levelIdsCacheKey(protectedLevelIds);
    const cacheKey = `${this.#levelIdsCacheKey(blockerLevelIds)}::protected:${protectedKey}:tiles:${
      includeTiles ? 1 : 0
    }:strict:${strictLevelIdentity ? 1 : 0}:protectExplicitMultiTiles:${protectExplicitMultiLevelTiles ? 1 : 0}`;
    const frameCache = this._visualBlockerSurfaceObjectsFrameCache;
    if (frameCache?.has(cacheKey)) return frameCache.get(cacheKey) ?? [];
    const remember = (value) => {
      frameCache?.set(cacheKey, value ?? []);
      return value ?? [];
    };

    const objects = [];
    const seen = new Set();
    const push = (object) => {
      if (!object || seen.has(object)) return;
      seen.add(object);
      objects.push(object);
    };

    for (const mesh of this.#getPrimaryLevelTexturesForFrame()) {
      const object = mesh?.object ?? null;
      const liveRenderObject = this.#resolveLiveSurfaceDisplayObject(mesh, object);
      const captureObject = this.#displayObjectContributesVisiblePixels(mesh)
        ? mesh
        : this.#displayObjectContributesVisiblePixels(liveRenderObject)
        ? liveRenderObject
        : null;
      if (!captureObject) continue;
      if (!this.#displayObjectIntersectsViewport(captureObject)) continue;

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
      const surfaceContext = { mesh, object, document, level, elevation };
      const targetsBlocker = strictLevelIdentity
        ? this.#surfaceStrictlyTargetsLevelIds(surfaceContext, blockerLevelIds)
        : this.#surfaceVisuallyTargetsLevelIds(surfaceContext, blockerLevelIds);
      if (!targetsBlocker) continue;
      const targetsProtected = strictLevelIdentity
        ? this.#surfaceStrictlyTargetsLevelIds(surfaceContext, protectedLevelIds)
        : this.#surfaceVisuallyTargetsLevelIds(surfaceContext, protectedLevelIds);
      if (protectedLevelIds?.size && targetsProtected) continue;
      push(captureObject);
    }

    if (!includeTiles) return remember(objects);

    for (const mesh of this.#getPrimaryTileMeshesForFrame()) {
      const tileObject = fxmLinkedPlaceableFromDisplayObject(mesh);
      const liveRenderObject = this.#resolveLiveSurfaceDisplayObject(mesh, tileObject);
      const captureObject = this.#displayObjectContributesVisiblePixels(mesh)
        ? mesh
        : this.#displayObjectContributesVisiblePixels(liveRenderObject)
        ? liveRenderObject
        : null;
      if (!captureObject) continue;
      if (!this.#displayObjectIntersectsViewport(captureObject)) continue;
      if (tileObject && !this.#tileIsActiveOnCanvas(tileObject)) continue;

      const document = tileObject?.document ?? null;
      const elevation = Number(mesh?.elevation ?? document?.elevation ?? tileObject?.elevation ?? Number.NaN);
      const level = mesh?.level ?? tileObject?.level ?? document?.level ?? null;
      const surfaceContext = { mesh, object: tileObject, document: document ?? tileObject ?? null, level, elevation };
      const targetsBlocker = strictLevelIdentity
        ? this.#surfaceStrictlyTargetsLevelIds(surfaceContext, blockerLevelIds)
        : this.#surfaceVisuallyTargetsLevelIds(surfaceContext, blockerLevelIds);
      if (!targetsBlocker) continue;
      const targetsProtected = strictLevelIdentity
        ? this.#surfaceStrictlyTargetsLevelIds(surfaceContext, protectedLevelIds)
        : this.#surfaceVisuallyTargetsLevelIds(surfaceContext, protectedLevelIds) ||
          (protectExplicitMultiLevelTiles &&
            this.#surfaceHasExplicitMultiLevelTileAssignmentToLevelIds(surfaceContext, protectedLevelIds));
      if (protectedLevelIds?.size && targetsProtected) continue;
      push(captureObject);
    }

    return remember(objects);
  }

  /**
   * Build a mask from visible native Level surfaces that should restore above a row's output.
   *
   * @param {object|null|undefined} row
   * @returns {PIXI.RenderTexture|null}
   */
  #getRowLevelBlockerMaskTexture(row) {
    const blockerLevelIds = this.#getRowVisualBlockerLevelIds(row);
    if (!(blockerLevelIds?.size > 0)) return null;

    const includeTiles = this.#rowIncludesTileSurfacesInLevelMasks(row);
    const cacheKey = `visual-blockers:${Array.from(blockerLevelIds).sort().join("|")}:tiles:${includeTiles ? 1 : 0}`;
    if (this._levelBlockerFrameSerial === this._renderFrameSerial && this._levelBlockerFrameKey === cacheKey) {
      return this._levelBlockerRT;
    }

    const blockerObjects = this.#collectVisualBlockerSurfaceObjectsForLevelIds(blockerLevelIds, { includeTiles });
    if (!blockerObjects.length) return null;

    const captured = this.#captureSurfaceMaskTexture(blockerObjects, this._levelBlockerRT);
    if (!captured) return null;

    this._levelBlockerFrameSerial = this._renderFrameSerial;
    this._levelBlockerFrameKey = cacheKey;
    return this._levelBlockerRT;
  }

  /**
   * Restore the row input over visible higher-level surfaces not included in the row's target level set.
   *
   * @param {object|null|undefined} row
   * @param {PIXI.RenderTexture|null|undefined} source
   * @param {PIXI.RenderTexture|null|undefined} output
   * @returns {void}
   */
  #restoreRowLevelBlockers(row, source, output) {
    if (!source || !output) return;
    const maskTexture = this.#getRowLevelBlockerMaskTexture(row);
    if (!maskTexture) return;
    this.#restoreFromTextureMask(maskTexture, source, output);
  }

  /**
   * Return whether a below-tiles particle row should use compositor tile restoration.
   *
   * Particle rows rely on their local mask pipeline for below-tiles rendering.
   *
   * @param {{ kind?: string, uid?: string }|null|undefined} row
   * @returns {boolean}
   */
  #rowUsesParticleTileRestore(row) {
    void row;
    return false;
  }

  /**
   * Select the effective scene mask texture for a row from a mask bundle.
   *
   * @param {object|null|undefined} bundle
   * @param {boolean} belowTokens
   * @param {boolean} belowTiles
   * @returns {PIXI.RenderTexture|PIXI.Texture|null}
   */
  #chooseSceneMaskTexture(bundle, belowTokens, belowTiles) {
    if (!bundle) return null;
    if (belowTokens && belowTiles)
      return bundle.cutoutCombined ?? bundle.cutoutTokens ?? bundle.cutoutTiles ?? bundle.base ?? null;
    if (belowTokens) return bundle.cutoutTokens ?? bundle.base ?? null;
    if (belowTiles) return bundle.cutoutTiles ?? bundle.base ?? null;
    return bundle.base ?? null;
  }

  /**
   * Return a row-specific scene mask bundle using stack-ordered suppression operators.
   *
   * @param {object|null|undefined} row
   * @param {"particles"|"filters"} kind
   * @param {{ belowTokens?: boolean, belowTiles?: boolean }} [options]
   * @returns {object|null}
   */
  #getSceneStackMaskBundleForRow(row, kind, { belowTokens = false, belowTiles = false } = {}) {
    if (this.#getRowScope(row) !== "scene") return null;
    const normalizedKind = kind === "filters" ? "filters" : "particles";
    const operators = this.#activeSuppressionOperatorsForRow(row, normalizedKind);
    if (!operators.length && !belowTokens && !belowTiles) return null;

    try {
      return (
        SceneMaskManager.instance.getMasksForSuppressionOperators?.(normalizedKind, operators, {
          belowTokens,
          belowTiles,
        }) ?? null
      );
    } catch (err) {
      logger.debug("FXMaster:", err);
      return null;
    }
  }

  /**
   * Snapshot scene-mask-related filter uniforms.
   *
   * @param {PIXI.Filter|null|undefined} filter
   * @returns {object|null}
   */
  #snapshotFilterMaskUniforms(filter) {
    const uniforms = filter?.uniforms ?? null;
    if (!uniforms || typeof uniforms !== "object") return null;
    const keys = [
      "maskSampler",
      "hasMask",
      "maskReady",
      "maskSoft",
      "maskUvMin",
      "maskUvMax",
      "maskTextureSize",
      "viewSize",
      "deviceToCss",
      "tokenSampler",
      "hasTokenMask",
      "tokenMaskSampler",
      "invertMask",
    ];
    const snapshot = { __fxmMaskVariants: filter.__fxmMaskVariants };
    for (const key of keys) if (Object.hasOwn(uniforms, key)) snapshot[key] = uniforms[key];
    return snapshot;
  }

  /**
   * Restore scene-mask-related filter uniforms.
   *
   * @param {PIXI.Filter|null|undefined} filter
   * @param {object|null} snapshot
   * @returns {void}
   */
  #restoreFilterMaskUniforms(filter, snapshot) {
    const uniforms = filter?.uniforms ?? null;
    if (!uniforms || !snapshot) return;
    try {
      for (const [key, value] of Object.entries(snapshot)) {
        if (key === "__fxmMaskVariants") continue;
        uniforms[key] = value;
      }
      filter.__fxmMaskVariants = snapshot.__fxmMaskVariants;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  /**
   * Temporarily bind stack-row-specific scene masks to a scene filter.
   *
   * @param {object|null|undefined} row
   * @param {PIXI.Filter|null|undefined} filter
   * @returns {(() => void)|null}
   */
  #prepareSceneFilterStackMaskForRow(row, filter) {
    if (row?.kind !== "filter" || this.#getRowScope(row) !== "scene" || !filter) return null;

    const belowTokens = this.#filterWantsBelowTokens(filter) || this.#rowWantsBelowTokens(row);
    const belowTiles = this.#rowWantsBelowTiles(row);
    if (!belowTokens && !belowTiles && this.#rowUsesCompositorSceneFilterSuppression(row)) return null;

    const bundle = this.#getSceneStackMaskBundleForRow(row, "filters", { belowTokens, belowTiles });
    if (!bundle) return null;

    const snapshot = this.#snapshotFilterMaskUniforms(filter);
    if (!snapshot) return null;

    const { cssW, cssH, deviceToCss, rect: cssFA } = getCssViewportMetrics();
    try {
      applyMaskUniformsToFilters([filter], {
        baseMaskRT: bundle.base,
        cutoutTokensRT: belowTokens ? bundle.cutoutTokens : null,
        cutoutTilesRT: belowTiles ? bundle.cutoutTiles : null,
        cutoutCombinedRT: belowTokens && belowTiles ? bundle.cutoutCombined : null,
        tokensMaskRT: belowTokens ? bundle.tokens : null,
        cssW,
        cssH,
        deviceToCss,
        maskSoft: !!bundle.soft,
        filterAreaRect: cssFA,
      });
    } catch (err) {
      logger.debug("FXMaster:", err);
      this.#restoreFilterMaskUniforms(filter, snapshot);
      return null;
    }

    return () => this.#restoreFilterMaskUniforms(filter, snapshot);
  }

  /**
   * Return a stack-row-specific scene particle mask override.
   *
   * @param {object|null|undefined} row
   * @param {{ selectedMaskTexture?: PIXI.RenderTexture|PIXI.Texture|null, useCompositorSuppression?: boolean }} [options]
   * @returns {PIXI.RenderTexture|PIXI.Texture|false|null}
   */
  #getSceneParticleStackMaskOverride(row, { selectedMaskTexture = null, useCompositorSuppression = false } = {}) {
    if (row?.kind !== "particle" || this.#getRowScope(row) !== "scene") return null;
    if (selectedMaskTexture) return null;

    const belowTokens = this.#rowWantsBelowTokens(row);
    const belowTiles = this.#rowWantsBelowTiles(row);
    const operators = useCompositorSuppression ? [] : this.#activeSuppressionOperatorsForRow(row, "particles");
    if (!operators.length && !belowTokens && !belowTiles) return false;

    let bundle = null;
    try {
      bundle =
        SceneMaskManager.instance.getMasksForSuppressionOperators?.("particles", operators, {
          belowTokens,
          belowTiles,
        }) ?? null;
    } catch (err) {
      logger.debug("FXMaster:", err);
      return false;
    }

    return this.#chooseSceneMaskTexture(bundle, belowTokens, belowTiles) ?? false;
  }

  /**
   * Return whether a filter currently has a usable suppression mask texture bound.
   *
   * Below-tiles filter compatibility depends on the filter reading its live tile cutout mask directly so hover fade can reveal filtered content smoothly without restoring captured tile pixels from the compositor.
   *
   * @param {PIXI.Filter|null|undefined} filter
   * @returns {boolean}
   */
  #filterHasUsableMask(filter) {
    const uniforms = filter?.uniforms ?? null;
    if (!uniforms || typeof uniforms !== "object") return false;
    if (!Object.hasOwn(uniforms, "maskSampler")) return false;
    if (Object.hasOwn(uniforms, "hasMask") && !(Number(uniforms.hasMask) > 0.5)) return false;

    const maskTexture = uniforms.maskSampler;
    return !!maskTexture && maskTexture !== PIXI.Texture.EMPTY && !maskTexture.destroyed;
  }

  /**
   * Temporarily prepare a filter for compositor rendering.
   *
   * Below-tiles rows should keep their live tile cutout mask bound, but they need that scene mask sampled with continuous alpha rather than a hard scene-level step so a fading tile reveals the filter behind it when Restricts Weather is disabled.
   *
   * Plain scene filters using the direct local clip path should not sample the shared scene mask at all during the compositor pass.
   *
   * @param {PIXI.Filter|null|undefined} filter
   * @param {{ forceSoftMask?: boolean, disableMask?: boolean }} [options]
   * @returns {(() => void)|null}
   */
  #prepareFilterForStackPass(filter, { forceSoftMask = false, disableMask = false } = {}) {
    const uniforms = filter?.uniforms ?? null;
    if (!uniforms || typeof uniforms !== "object") return null;

    const cleanups = [];

    if (disableMask) {
      const previous = {
        maskSampler: uniforms.maskSampler,
        hasMask: uniforms.hasMask,
        maskReady: uniforms.maskReady,
        maskSoft: uniforms.maskSoft,
        invertMask: uniforms.invertMask,
      };

      try {
        if ("maskSampler" in uniforms) uniforms.maskSampler = PIXI.Texture.EMPTY;
        if ("hasMask" in uniforms) uniforms.hasMask = 0.0;
        if ("maskReady" in uniforms) uniforms.maskReady = 0.0;
        if ("maskSoft" in uniforms) uniforms.maskSoft = 0.0;
        if ("invertMask" in uniforms) uniforms.invertMask = 0.0;
      } catch (err) {
        logger.debug("FXMaster:", err);
      }

      cleanups.push(() => {
        try {
          if ("maskSampler" in uniforms) uniforms.maskSampler = previous.maskSampler;
          if ("hasMask" in uniforms) uniforms.hasMask = previous.hasMask;
          if ("maskReady" in uniforms) uniforms.maskReady = previous.maskReady;
          if ("maskSoft" in uniforms) uniforms.maskSoft = previous.maskSoft;
          if ("invertMask" in uniforms) uniforms.invertMask = previous.invertMask;
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      });
    }

    const shouldForceSoftMask =
      !disableMask && !!forceSoftMask && this.#filterHasUsableMask(filter) && Object.hasOwn(uniforms, "maskSoft");
    if (shouldForceSoftMask) {
      const previousMaskSoft = uniforms.maskSoft;
      uniforms.maskSoft = 1.0;

      cleanups.push(() => {
        try {
          if ("maskSoft" in uniforms) uniforms.maskSoft = previousMaskSoft;
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      });
    }

    if (!cleanups.length) return null;
    return () => {
      for (let i = cleanups.length - 1; i >= 0; i--) cleanups[i]?.();
    };
  }

  /**
   * Return the shared native weather occlusion filter used for compositor-owned filter passes.
   *
   * @returns {PIXI.Filter|null}
   */
  #getWeatherOcclusionFilter(occlusionElevation = null) {
    if (!canUseNativeWeatherOcclusionStackPass()) return null;

    const factory = CONFIG?.fxmaster?.WeatherOcclusionMaskFilterNS;
    const occlusionTexture = canvas?.masks?.depth?.renderTexture ?? null;
    if (!factory?.create || !occlusionTexture) return null;

    let filter = this._weatherOcclusionFilter;
    if (!filter || filter.destroyed) {
      filter = factory.create({ occlusionTexture });
      filter.blendMode = PIXI.BLEND_MODES.NORMAL;
      this._weatherOcclusionFilter = filter;
    }

    try {
      filter.enabled = true;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      filter.occlusionTexture = occlusionTexture;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      if (filter.uniforms && "occlusionTexture" in filter.uniforms) filter.uniforms.occlusionTexture = occlusionTexture;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      const elevation = Number.isFinite(Number(occlusionElevation))
        ? Number(occlusionElevation)
        : Number(canvas?.particleeffects?.elevation);
      filter.elevation = Number.isFinite(elevation) ? elevation : Infinity;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    return filter;
  }

  /**
   * Composite a rendered filter result back over the current source frame while delegating Restricts Weather suppression to Foundry's native WeatherOcclusionMaskFilter.
   *
   * The source frame is left intact underneath the occluded tile footprint, so hovered or token-revealed Restricts Weather roofs reveal the unfiltered scene below instead of the filtered result.
   *
   * @param {PIXI.Texture|PIXI.RenderTexture|null} texture
   * @param {PIXI.RenderTexture|null} output
   * @param {{ clipToScene?: boolean }} [options]
   * @returns {boolean}
   */
  #overlayTextureWithWeatherOcclusion(texture, output, { clipToScene = false, occlusionElevation = null } = {}) {
    const renderer = canvas?.app?.renderer;
    const container = this._filterPassContainer;
    const sprite = this._filterPassSprite;
    const filter = this.#getWeatherOcclusionFilter(occlusionElevation);
    if (!renderer || !container || !sprite || !texture || !output || !filter) return false;

    const sceneClip = clipToScene ? this.#updateFilterPassSceneClipMask() : null;
    const { width, height } = this.#getViewportMetrics();

    sprite.texture = texture;
    sprite.position.set(0, 0);
    sprite.scale.set(1, 1);
    sprite.width = width;
    sprite.height = height;
    sprite.filters = [filter];

    container.position.set(0, 0);
    container.scale.set(1, 1);
    container.rotation = 0;
    container.skew?.set?.(0, 0);
    container.pivot?.set?.(0, 0);
    container.visible = true;
    container.renderable = true;

    const priorMask = sprite.mask ?? null;
    try {
      sprite.mask = sceneClip && !sceneClip.destroyed ? sceneClip : null;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    try {
      renderer.render(container, {
        renderTexture: output,
        clear: false,
        skipUpdateTransform: false,
      });
      return true;
    } catch (err) {
      logger.debug("FXMaster:", err);
      return false;
    } finally {
      sprite.filters = null;
      try {
        sprite.mask = priorMask ?? null;
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
  }

  /**
   * Return whether a tile restricts the requested FX pipeline.
   *
   * @param {Tile|null|undefined} tile
   * @param {"particles"|"filters"} [kind="particles"]
   * @returns {boolean}
   */
  #tileRestrictsWeatherForKind(tile, kind = "particles") {
    return kind === "filters" ? tileDocumentRestrictsFilters(tile) : tileDocumentRestrictsParticles(tile);
  }

  /**
   * Return whether at least one active tile restricts the requested FX pipeline.
   *
   * @param {"particles"|"filters"} [kind="particles"]
   * @returns {boolean}
   */
  #hasActiveRestrictWeatherTiles(kind = "particles") {
    const normalizedKind = kind === "filters" ? "filters" : "particles";
    for (const tile of canvas?.tiles?.placeables ?? []) {
      if (!this.#tileRestrictsWeatherForKind(tile, normalizedKind)) continue;
      if (this.#tileIsActiveOnCanvas(tile)) return true;
    }
    return false;
  }

  /**
   * Return a frame-local mask containing only the currently revealed portions of active Restricts Weather / FXMaster-restricting tiles.
   *
   * Core Restricts Weather is an under-tile suppressor for both particles and filters. FXMaster's per-pipeline tile flags feed the same restoration path independently so transparent portions of a restricting tile keep suppressing only the requested effect type.
   *
   * @param {"particles"|"filters"} [kind="particles"]
   * @returns {PIXI.RenderTexture|null}
   */
  #getRestrictWeatherTilesMaskTexture(kind = "particles") {
    const normalizedKind = kind === "filters" ? "filters" : "particles";
    const frameSerialKey =
      normalizedKind === "filters"
        ? "_weatherRestrictTilesFilterFrameSerial"
        : "_weatherRestrictTilesParticleFrameSerial";
    const frameTextureKey =
      normalizedKind === "filters"
        ? "_weatherRestrictTilesFilterFrameTexture"
        : "_weatherRestrictTilesParticleFrameTexture";
    const rtKey = normalizedKind === "filters" ? "_weatherRestrictTilesFilterRT" : "_weatherRestrictTilesParticleRT";

    if (this[frameSerialKey] === this._renderFrameSerial) {
      return this[frameTextureKey] ?? null;
    }

    const remember = (value) => {
      this[frameSerialKey] = this._renderFrameSerial;
      this[frameTextureKey] = value ?? null;
      return value ?? null;
    };

    const rt = this[rtKey] ?? null;
    if (!rt || !this.#hasActiveRestrictWeatherTiles(normalizedKind)) return remember(null);

    try {
      repaintTilesMaskInto(rt, {
        mode: "weatherReveal",
        eraseUpperCoverage: false,
        restrictionKind: normalizedKind,
        shouldIncludeTile: (tile) =>
          this.#tileRestrictsWeatherForKind(tile, normalizedKind) && this.#tileIsActiveOnCanvas(tile),
      });
      return remember(rt);
    } catch (err) {
      logger.debug("FXMaster:", err);
      return remember(null);
    }
  }

  /**
   * Return a shared tile coverage texture for the requested mask mode.
   *
   * @param {"filter"|"particle"} kind
   * @param {{ mode?: "visible"|"suppression" }} [options]
   * @returns {PIXI.RenderTexture|null}
   */
  #getTilesMaskTexture(kind, { mode = "visible" } = {}) {
    const managerKind = kind === "filter" ? "filters" : "particles";
    const primaryKey = mode === "suppression" ? "tiles" : "visibleTiles";
    const fallbackKey = mode === "suppression" ? "visibleTiles" : "tiles";

    let masks = null;
    try {
      masks = SceneMaskManager.instance.getMasks(managerKind);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    const valid = (rt) => !!rt && !rt.destroyed && !!rt.orig && !rt.baseTexture?.destroyed;
    let tilesRT = masks?.[primaryKey] ?? masks?.[fallbackKey] ?? null;
    if (valid(tilesRT)) return tilesRT;

    try {
      SceneMaskManager.instance.refreshSync?.(managerKind);
      masks = SceneMaskManager.instance.getMasks(managerKind);
      tilesRT = masks?.[primaryKey] ?? masks?.[fallbackKey] ?? null;
      if (valid(tilesRT)) return tilesRT;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    if (mode !== "suppression") {
      const fallbackKind = managerKind === "filters" ? "particles" : "filters";
      try {
        const fallbackMasks = SceneMaskManager.instance.getMasks(fallbackKind) ?? null;
        const fallback = fallbackMasks?.[primaryKey] ?? fallbackMasks?.[fallbackKey] ?? null;
        if (valid(fallback)) return fallback;
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    return null;
  }

  /**
   * Restore pre-pass pixels through a supplied mask texture.
   *
   * @param {PIXI.Texture|PIXI.RenderTexture|null} maskTexture
   * @param {PIXI.RenderTexture} source
   * @param {PIXI.RenderTexture} output
   * @returns {void}
   */
  #restoreFromTextureMask(maskTexture, source, output) {
    if (!maskTexture || !source || !output) return;

    let sourceTexture = source;
    let maskSourceTexture = maskTexture;
    if (this.#texturesShareBaseTexture(sourceTexture, output)) {
      if (!this._feedbackCopyRT || this.#texturesShareBaseTexture(this._feedbackCopyRT, output)) return;
      this.#blit(sourceTexture, this._feedbackCopyRT, { clear: true });
      sourceTexture = this._feedbackCopyRT;
    }
    if (this.#texturesShareBaseTexture(maskSourceTexture, output)) {
      if (!this._maskIntersectionRT || this.#texturesShareBaseTexture(this._maskIntersectionRT, output)) return;
      this.#blit(maskSourceTexture, this._maskIntersectionRT, { clear: true });
      maskSourceTexture = this._maskIntersectionRT;
    }

    const container = this._tileRestoreContainer;
    const sprite = this._tileRestoreSprite;
    const mask = this._tileRestoreMask;
    if (!container || !sprite || !mask) return;

    const { width, height } = this.#getViewportMetrics();

    container.visible = true;
    container.renderable = true;
    container.position.set(0, 0);
    container.scale.set(1, 1);
    container.rotation = 0;
    container.skew?.set?.(0, 0);
    container.pivot?.set?.(0, 0);

    mask.texture = maskSourceTexture;
    mask.position.set(0, 0);
    mask.scale.set(1, 1);
    mask.width = width;
    mask.height = height;
    mask.visible = true;
    mask.renderable = false;

    sprite.texture = sourceTexture;
    sprite.position.set(0, 0);
    sprite.scale.set(1, 1);
    sprite.width = width;
    sprite.height = height;
    sprite.visible = true;
    sprite.renderable = true;

    try {
      canvas.app.renderer.render(container, {
        renderTexture: output,
        clear: false,
        skipUpdateTransform: false,
      });
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  /**
   * Restore pre-pass tile pixels using a shared tile coverage texture.
   *
   * @param {"filter"|"particle"} kind
   * @param {PIXI.RenderTexture} source
   * @param {PIXI.RenderTexture} output
   * @param {{ mode?: "visible"|"suppression" }} [options]
   * @returns {void}
   */
  #restoreTilesFromTexture(kind, source, output, { mode = "visible" } = {}) {
    const tilesRT = this.#getTilesMaskTexture(kind, { mode });
    if (!tilesRT) return;
    this.#restoreFromTextureMask(tilesRT, source, output);
  }

  /**
   * Return whether any visible token uses dynamic rings.
   *
   * Dynamic ring visuals may animate independently of document or transform changes, so below-token coverage must keep repainting while any visible token uses that feature.
   *
   * @returns {boolean}
   */
  #hasVisibleDynamicRings() {
    const padding = Math.max(16, Number(canvas?.dimensions?.size) || 100);
    for (const token of collectBelowTokenMaskTokens()) {
      if (!token?.visible || token?.document?.hidden) continue;
      if (!this.#placeableIntersectsWorldViewport(token, padding)) continue;
      if (token?.hasDynamicRing) return true;
    }
    return false;
  }

  /**
   * Build a compact signature for Region behavior state that can affect dynamic coverage masks or region-level cutout refreshes.
   *
   * @returns {string}
   */
  #buildRegionBehaviorSignature() {
    const parts = [`overhead:${applyRegionBehaviorsToOverheadLevels() ? 1 : 0}`];
    for (const region of getRegionEffectPlaceablesForCurrentView(canvas?.scene ?? null)) {
      const doc = region?.document ?? null;
      if (!doc) continue;

      const behaviorParts = [];
      for (const behavior of doc.behaviors ?? []) {
        if (!behavior) continue;
        const type = behavior.type ?? "";
        if (type !== SUPPRESS_WEATHER && !String(type).startsWith(`${packageId}.`)) continue;

        const gatePass = this.#computeRegionGatePassForFrame(region, type) ? "1" : "0";
        behaviorParts.push(`${gatePass}:${getRegionBehaviorRuntimeSignature(behavior)}`);
      }

      if (!behaviorParts.length) continue;

      let boundsKey = "bounds-unavailable";
      try {
        const bounds = regionWorldBounds(region);
        if (bounds) {
          boundsKey = [
            Number(bounds.minX ?? bounds.x ?? 0).toFixed(2),
            Number(bounds.minY ?? bounds.y ?? 0).toFixed(2),
            Number(bounds.maxX ?? (bounds.x ?? 0) + (bounds.width ?? 0)).toFixed(2),
            Number(bounds.maxY ?? (bounds.y ?? 0) + (bounds.height ?? 0)).toFixed(2),
          ].join(",");
        }
      } catch (err) {
        logger.debug("FXMaster:", err);
      }

      const regionLevels = Array.from(getDocumentAssignedLevelIds(doc, doc?.parent ?? canvas?.scene ?? null) ?? [])
        .sort()
        .join(",");
      const window = getRegionElevationWindow(doc);
      parts.push(
        [
          doc.id ?? region?.id ?? "",
          doc.uuid ?? "",
          regionLevels,
          window?.min ?? "",
          window?.max ?? "",
          boundsKey,
          behaviorParts.sort().join(";"),
        ].join("|"),
      );
    }

    return parts.sort().join("#");
  }

  /**
   * Return a lightweight signature describing the current viewport and visible token/tile state that affects dynamic mask coverage.
   *
   * @param {{ includeTokens?: boolean, includeTiles?: boolean }} [options]
   * @returns {{ key: string|null, forceRefresh: boolean }}
   */
  #buildDynamicCoverageSignature({ includeTokens = false, includeTiles = false } = {}) {
    const stage = canvas?.stage ?? null;
    const metrics = getCssViewportMetrics();
    const pivotX = Number(stage?.pivot?.x ?? 0) || 0;
    const pivotY = Number(stage?.pivot?.y ?? 0) || 0;
    const scaleX = Number(stage?.scale?.x ?? 1) || 1;
    const scaleY = Number(stage?.scale?.y ?? 1) || 1;
    const cameraMatrix = snappedStageMatrix();
    const cameraTx = Number(cameraMatrix?.tx ?? stage?.worldTransform?.tx ?? 0) || 0;
    const cameraTy = Number(cameraMatrix?.ty ?? stage?.worldTransform?.ty ?? 0) || 0;
    const cameraA = Number(cameraMatrix?.a ?? scaleX) || 1;
    const cameraD = Number(cameraMatrix?.d ?? scaleY) || 1;
    const parts = [
      `vp:${metrics.cssW}:${metrics.cssH}:${pivotX.toFixed(3)}:${pivotY.toFixed(3)}:${scaleX.toFixed(
        6,
      )}:${scaleY.toFixed(6)}:${cameraA.toFixed(6)}:${cameraD.toFixed(6)}:${cameraTx.toFixed(3)}:${cameraTy.toFixed(
        3,
      )}`,
    ];

    if (canvas?.level) {
      try {
        const surfaceState = getCanvasLiveLevelSurfaceState(canvas?.scene ?? null, { presynced: true });
        parts.push(`surface:${surfaceState?.key ?? ""}`);
        if (surfaceState?.forceRefresh) return { key: null, forceRefresh: true };
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    parts.push(`regions:${this.#buildRegionBehaviorSignature()}`);

    if (includeTokens) {
      if (this.#hasVisibleDynamicRings()) return { key: null, forceRefresh: true };

      if (canvas?.level) {
        const levelDocs = this.#getSceneLevels();
        for (const level of levelDocs) {
          if (!level?.id) continue;
          parts.push(`lvl:${level.id}:${level.isView ? 1 : 0}:${level.isVisible ? 1 : 0}`);
        }
      }

      const tokenViewportPadding = Math.max(16, Number(canvas?.dimensions?.size) || 100);
      for (const token of collectBelowTokenMaskTokens()) {
        if (token?.document?.hidden) continue;
        if (!this.#placeableIntersectsWorldViewport(token, tokenViewportPadding)) continue;
        const sceneMaskVisible = canvas?.level ? sceneMaskContainsTokenCenterForCompositor(token) : null;
        const explicitlyRevealed = token?.controlled === true;
        const tokenElevation = token?.elevation ?? token?.document?.elevation ?? Number.NaN;
        const onCurrentLevel = canvas?.level
          ? isDocumentOnCurrentCanvasLevel(token?.document ?? null, tokenElevation)
          : false;
        const directlyHovered = canvas?.level ? this.#tokenIsDirectlyHoveredForSuppressionFallback(token) : false;
        const revealedByHoveredUpperLevel = canvas?.level
          ? tokenUpperLevelRevealAllowsBelowTokenMask(token, { requireDirectHoverForSceneMask: !onCurrentLevel })
          : false;
        const tokenIsVisible =
          token?.visible === true ||
          token?.isVisible === true ||
          token?.worldVisible === true ||
          token?.mesh?.worldVisible === true;
        if (
          !tokenIsVisible &&
          !(
            revealedByHoveredUpperLevel ||
            explicitlyRevealed ||
            directlyHovered ||
            (onCurrentLevel && sceneMaskVisible === true)
          )
        )
          continue;

        const tokenId = token?.id ?? token?.document?.id ?? "";
        const mesh = token?.mesh ?? null;
        const transformId = fxmDisplayObjectTransformSignature(mesh);
        const worldAlpha = Math.round((Number(mesh?.worldAlpha ?? token?.alpha ?? 1) || 0) * 1000);
        const bounds = token?.bounds ?? null;
        const bx = Number(bounds?.x ?? token?.x ?? 0) || 0;
        const by = Number(bounds?.y ?? token?.y ?? 0) || 0;
        const bw = Number(bounds?.width ?? token?.w ?? 0) || 0;
        const bh = Number(bounds?.height ?? token?.h ?? 0) || 0;
        const maskFlag = sceneMaskVisible === true ? 1 : sceneMaskVisible === false ? 0 : 2;
        const hoveredUpperLevelReveal = revealedByHoveredUpperLevel ? 1 : 0;
        const explicitlyVisible = explicitlyRevealed ? 1 : 0;
        const directlyHoveredFlag = directlyHovered ? 1 : 0;
        parts.push(
          `tok:${tokenId}:${transformId}:${worldAlpha}:${bx.toFixed(2)}:${by.toFixed(2)}:${bw.toFixed(2)}:${bh.toFixed(
            2,
          )}:${token?.occluded ? 1 : 0}:${
            onCurrentLevel ? 1 : 0
          }:${maskFlag}:${hoveredUpperLevelReveal}:${explicitlyVisible}:${directlyHoveredFlag}`,
        );
      }
    }

    if (includeTiles) {
      const tileViewportPadding = 16;
      for (const tile of canvas?.tiles?.placeables ?? []) {
        if (!this.#tileIsActiveOnCanvas(tile)) continue;
        if (!this.#placeableIntersectsWorldViewport(tile, tileViewportPadding)) continue;
        const tileId = tile?.id ?? tile?.document?.id ?? "";
        const mesh = tile?.mesh ?? null;
        const transformId = fxmDisplayObjectTransformSignature(mesh);
        const hoverFade = fxmGetPublicHoverFadeState(mesh);
        const visibleAlpha = Math.round((Number(mesh?.worldAlpha ?? tile?.alpha ?? 1) || 0) * 1000);
        const fadeOcclusion = Math.round((Number(mesh?.fadeOcclusion ?? hoverFade?.occlusion ?? 0) || 0) * 1000);
        const bounds = tile?.bounds ?? null;
        const bx = Number(bounds?.x ?? tile?.x ?? 0) || 0;
        const by = Number(bounds?.y ?? tile?.y ?? 0) || 0;
        const bw = Number(bounds?.width ?? tile?.width ?? 0) || 0;
        const bh = Number(bounds?.height ?? tile?.height ?? 0) || 0;
        const occlusionMode = getTileOcclusionModes(tile?.document ?? tile ?? null);
        const restrictsParticles = tileDocumentRestrictsParticles(tile) ? 1 : 0;
        const restrictsFilters = tileDocumentRestrictsFilters(tile) ? 1 : 0;
        parts.push(
          `tile:${tileId}:${transformId}:${visibleAlpha}:${fadeOcclusion}:${bx.toFixed(2)}:${by.toFixed(
            2,
          )}:${bw.toFixed(2)}:${bh.toFixed(2)}:${tile?.occluded ? 1 : 0}:${
            hoverFade?.faded ? 1 : 0
          }:${restrictsParticles}:${restrictsFilters}:1:${String(occlusionMode)}`,
        );
      }
    }

    return { key: parts.join("|"), forceRefresh: false };
  }

  /**
   * Hide live scene-particle source containers while the compositor presents their masked stack output.
   *
   * Registered particle slots are temporarily made renderable during renderStackParticle, so keeping the source hidden between compositor frames prevents the uncomposited full-scene emitter from leaking on V14 Levels.
   *
   * @param {Array<object>} rows
   * @param {boolean} enabled
   * @returns {void}
   */
  #syncCompositedSceneParticleSources(rows = [], enabled = true) {
    const uids = [];
    if (enabled && Array.isArray(rows)) {
      for (const row of rows) {
        const scope = this.#getRowScope(row);
        if (row?.kind === "particle" && (scope === "scene" || scope === "region") && row?.uid) uids.push(row.uid);
      }
    }

    try {
      canvas?.particleeffects?.setCompositedSceneParticleSources?.(uids);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  /**
   * Flush pending perception / primary updates once before dynamic mask sampling.
   *
   * @returns {void}
   */
  #syncLivePrimaryStateForDynamicCoverage() {
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
   * Synchronize dynamic scene state before capturing the environment for compositor work.
   *
   * Dynamic token/tile coverage is now dirty-state driven: native V14 Level presync happens only after the coverage signature changes or a transient fade/ring state explicitly requests a refresh.
   *
   * @param {Array<object>} rows
   * @param {object|null} [frameInfo]
   * @returns {void}
   */
  #syncDynamicSceneState(rows = [], frameInfo = null) {
    const safeRows = Array.isArray(rows) ? rows : [];
    const info = frameInfo ?? this.#analyzeRowsForFrame(safeRows);
    const needsDynamicTokenCoverage = !!info.needsDynamicTokenCoverage;
    const needsDynamicTileCoverage = !!info.needsDynamicTileCoverage;
    const needsDynamicSuppressionPreservation =
      !!SceneMaskManager.instance.needsDynamicLevelSuppressionPreservation?.();
    const needsDynamicCoverage =
      needsDynamicTokenCoverage || needsDynamicTileCoverage || needsDynamicSuppressionPreservation;
    const needsRegionFilterCoverageRefresh = !!info.needsRegionFilterCoverageRefresh;
    const needsRegionParticleCoverageRefresh = !!info.needsRegionParticleCoverageRefresh;

    if (!needsDynamicCoverage) {
      this._dynamicCoverageSignature = null;
      return;
    }

    const buildDynamicState = () =>
      this.#buildDynamicCoverageSignature({
        includeTokens: needsDynamicTokenCoverage || needsDynamicTileCoverage || needsDynamicSuppressionPreservation,
        includeTiles: needsDynamicTokenCoverage || needsDynamicTileCoverage,
      });

    let dynamicState = buildDynamicState();
    let dynamicCoverageChanged = dynamicState.forceRefresh || dynamicState.key !== this._dynamicCoverageSignature;

    if (
      canvas?.level &&
      CONFIG?.fxmaster?.overheadPerformance?.nativeLevelDynamicCoveragePresyncOnlyWhenMoving === false
    ) {
      dynamicCoverageChanged = true;
    }

    let presyncedDynamicCoverage = false;
    if (dynamicCoverageChanged) {
      this.#syncLivePrimaryStateForDynamicCoverage();
      presyncedDynamicCoverage = true;

      /**
       * Native V14 Levels may materialize hover-reveal and upper-surface state during the primary refresh. Re-key after the one allowed sync so steady frames reuse the settled signature instead of treating canvas.level as a perpetual dirty bit.
       */
      if (canvas?.level && !dynamicState.forceRefresh) {
        const syncedState = buildDynamicState();
        if (syncedState.forceRefresh || syncedState.key !== dynamicState.key) dynamicState = syncedState;
      }
    }

    if (dynamicCoverageChanged) {
      try {
        SceneMaskManager.instance.refreshTokensSync?.({ presyncedDynamicCoverage });
      } catch (err) {
        logger.debug("FXMaster:", err);
      }

      if (needsRegionFilterCoverageRefresh) {
        try {
          canvas?.filtereffects?.refreshCoverageCutoutsSync?.({ refreshSharedMasks: false });
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }

      if (needsRegionParticleCoverageRefresh) {
        try {
          canvas?.particleeffects?.refreshCoverageCutoutsSync?.({ refreshSharedMasks: false });
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }

      this._dynamicCoverageSignature = dynamicState.forceRefresh ? null : dynamicState.key;
    } else if (needsDynamicSuppressionPreservation) {
      /**
       * Below-token/tile coverage may be stable while a Level-scoped suppression aperture changes due to direct lower-token hover. Re-check the compact suppression-preservation signature even when the generic coverage key is unchanged. The manager only rebuilds the base masks when that signature actually changes.
       */
      try {
        SceneMaskManager.instance.refreshDynamicSuppressionPreservationIfNeeded?.();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
  }

  /**
   * Collect ordered rows for the current compositor pass, including transient rows that remain visible during fade-out.
   *
   * @param {Scene|null|undefined} scene
   * @returns {Array<object>}
   */
  #collectRenderableRows(scene) {
    const rows = getOrderedEnabledEffectRenderRows(scene).filter((row) => this.#rowHasRenderableRuntime(row));
    const known = new Set();
    for (const row of rows) {
      if (row?.uid) known.add(row.uid);
    }

    const transientRows = [];
    const collectTransientRows = (sourceRows) => {
      for (const row of sourceRows ?? []) {
        if (row?.uid && !known.has(row.uid) && this.#rowHasRenderableRuntime(row)) transientRows.push(row);
      }
    };

    try {
      collectTransientRows(FilterEffectsSceneManager.instance.getTransientStackRows?.());
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      collectTransientRows(canvas?.filtereffects?.getTransientStackRows?.());
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      collectTransientRows(canvas?.particleeffects?.getTransientStackRows?.());
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    if (!transientRows.length)
      return rows.some((row) => row?.kind === "particle" || row?.kind === "filter") ? rows : [];
    transientRows.sort(
      (a, b) => (a.renderIndex ?? Number.MAX_SAFE_INTEGER) - (b.renderIndex ?? Number.MAX_SAFE_INTEGER),
    );
    for (const row of transientRows) {
      if (known.has(row.uid)) continue;
      const index = Math.max(0, Math.min(rows.length, row.renderIndex ?? rows.length));
      rows.splice(index, 0, row);
      known.add(row.uid);
    }

    return rows;
  }

  /**
   * Render a full-screen copy pass.
   *
   * @param {PIXI.RenderTexture} input
   * @param {PIXI.RenderTexture} output
   * @param {{ clear?: boolean }} [options]
   * @returns {void}
   */
  #blit(input, output, { clear = true } = {}) {
    const renderer = canvas?.app?.renderer;
    const sprite = this._blitSprite;
    if (!renderer || !sprite || !input || !output) return;
    if (this.#texturesShareBaseTexture(input, output)) return;

    if (clear && !this.#clearRenderTexture(output)) return;

    const { width, height } = this.#getViewportMetrics();
    sprite.texture = input;
    sprite.position.set(0, 0);
    sprite.scale.set(1, 1);
    sprite.width = width;
    sprite.height = height;
    sprite.filters = null;

    renderer.render(sprite, {
      renderTexture: output,
      clear: false,
      skipUpdateTransform: false,
    });
  }

  /**
   * Apply a filter to the supplied intermediate texture.
   *
   * @param {PIXI.Filter} filter
   * @param {PIXI.RenderTexture} input
   * @param {PIXI.RenderTexture} output
   * @returns {void}
   */
  #applyFilterPass(filter, input, output) {
    const renderer = canvas?.app?.renderer;
    const sprite = this._filterSprite;
    if (!renderer || !sprite || !output) return;
    if (!this.#clearRenderTexture(output)) return;

    const { width, height } = this.#getViewportMetrics();
    sprite.texture = input;
    sprite.position.set(0, 0);
    sprite.scale.set(1, 1);
    sprite.width = width;
    sprite.height = height;
    sprite.filters = [filter];

    const targetMatrix = currentWorldMatrix(canvas.environment);
    filter.__fxmTargetWorldTransform = targetMatrix;

    try {
      renderer.render(sprite, {
        renderTexture: output,
        clear: false,
        skipUpdateTransform: false,
      });
    } finally {
      sprite.filters = null;
      try {
        delete filter.__fxmTargetWorldTransform;
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
  }

  /**
   * Apply a plain scene-level filter using a live local scene clip instead of the shared scene-mask texture.
   *
   * The source frame is copied into the output first so pixels outside the current scene bounds remain unchanged. The filtered pass is then rendered back only inside the current scene rect.
   *
   * @param {PIXI.Filter} filter
   * @param {PIXI.RenderTexture} input
   * @param {PIXI.RenderTexture} output
   * @returns {void}
   */
  #applyDirectSceneFilterPass(filter, input, output) {
    const renderer = canvas?.app?.renderer;
    const container = this._filterPassContainer;
    const sprite = this._filterPassSprite;
    const sceneClip = this.#updateFilterPassSceneClipMask();
    if (!renderer || !container || !sprite || !sceneClip) {
      this.#applyFilterPass(filter, input, output);
      return;
    }

    this.#blit(input, output, { clear: true });

    const { width, height } = this.#getViewportMetrics();
    sprite.texture = input;
    sprite.position.set(0, 0);
    sprite.scale.set(1, 1);
    sprite.width = width;
    sprite.height = height;
    sprite.filters = [filter];

    container.position.set(0, 0);
    container.scale.set(1, 1);
    container.rotation = 0;
    container.skew?.set?.(0, 0);
    container.pivot?.set?.(0, 0);
    container.visible = true;
    container.renderable = true;

    const priorMask = sprite.mask ?? null;
    sprite.mask = sceneClip;

    const targetMatrix = currentWorldMatrix(canvas.environment);
    filter.__fxmTargetWorldTransform = targetMatrix;

    try {
      renderer.render(container, {
        renderTexture: output,
        clear: false,
        skipUpdateTransform: false,
      });
    } finally {
      sprite.filters = null;
      try {
        sprite.mask = priorMask ?? null;
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      try {
        delete filter.__fxmTargetWorldTransform;
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
  }

  /**
   * Present the final compositor output on the visible stack sprite.
   *
   * @param {PIXI.RenderTexture} texture
   * @returns {void}
   */
  #present(texture, { maskOutput = true } = {}) {
    const sprite = this._displaySprite;
    if (!sprite) return;

    this.#attachDisplayContainer();

    const { width, height } = this.#getViewportMetrics();
    sprite.texture = texture ?? PIXI.Texture.EMPTY;
    sprite.position.set(0, 0);
    sprite.scale.set(1, 1);
    sprite.width = width;
    sprite.height = height;
    this.#syncOutputSpriteTransform();

    if (maskOutput) {
      this.#updateSceneClipMask();
    } else {
      try {
        sprite.mask = null;
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      if (this._sceneClipMask) {
        try {
          this._sceneClipMask.visible = false;
          this._sceneClipMask.renderable = false;
          this._sceneClipMask.clear();
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }
    }

    sprite.visible = true;
    sprite.renderable = true;

    if (this._displayContainer) {
      this._displayContainer.visible = true;
      this._displayContainer.renderable = true;
    }
  }

  /**
   * Hide the visible output sprite.
   *
   * @returns {void}
   */
  #hideOutput() {
    this.#syncCompositedSceneParticleSources([], false);
    this.#restoreLiveGridMeshVisibility();

    if (this._displaySprite) {
      this._displaySprite.texture = PIXI.Texture.EMPTY;
      this._displaySprite.visible = false;
      this._displaySprite.renderable = false;
    }

    if (this._sceneClipMask) {
      this._sceneClipMask.visible = false;
      this._sceneClipMask.renderable = false;
      this._sceneClipMask.clear();
    }

    if (this._displayContainer) {
      this._displayContainer.visible = false;
      this._displayContainer.renderable = false;
    }
  }

  /**
   * Return whether the normal Foundry grid should participate in FX compositing.
   *
   * @returns {boolean}
   */
  #gridCompositingEnabled() {
    return compositeGridInFxStack() === true;
  }

  /**
   * Return the normal Foundry grid mesh, excluding highlight layers.
   *
   * @returns {PIXI.DisplayObject|null}
   */
  #getGridMeshForCompositing() {
    const gridLayer = canvas?.interface?.grid ?? canvas?.gridLayer ?? null;
    const mesh = gridLayer?.mesh ?? null;
    if (!mesh || mesh.destroyed) return null;
    return mesh;
  }

  /**
   * Restore the live grid mesh to the visibility state captured before FXMaster hid it.
   *
   * @returns {void}
   */
  #restoreLiveGridMeshVisibility() {
    const state = this._gridMeshVisibilityState ?? null;
    if (!state?.mesh) {
      this._gridMeshVisibilityState = null;
      return;
    }

    try {
      if (!state.mesh.destroyed) {
        state.mesh.visible = state.visible;
        state.mesh.renderable = state.renderable;
      }
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    this._gridMeshVisibilityState = null;
  }

  /**
   * Hide or restore Foundry's live grid mesh while the grid is captured into the FX input.
   *
   * @param {boolean} hidden
   * @returns {void}
   */
  #setLiveGridMeshHidden(hidden) {
    const mesh = this.#getGridMeshForCompositing();
    if (!hidden || !mesh) {
      this.#restoreLiveGridMeshVisibility();
      return;
    }

    if (this._gridMeshVisibilityState?.mesh !== mesh) this.#restoreLiveGridMeshVisibility();

    if (!this._gridMeshVisibilityState) {
      this._gridMeshVisibilityState = {
        mesh,
        visible: mesh.visible !== false,
        renderable: mesh.renderable !== false,
      };
    }

    try {
      mesh.visible = false;
      mesh.renderable = false;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  /**
   * Apply the current grid-compositing setting after settings or canvas state change.
   *
   * @returns {void}
   */
  syncGridCompositingSetting() {
    if (!this.#gridCompositingEnabled()) this.#restoreLiveGridMeshVisibility();
  }

  /**
   * Render the normal Foundry grid mesh into the compositor base frame.
   *
   * @param {PIXI.RenderTexture|null|undefined} renderTexture
   * @returns {boolean}
   */
  #captureGridIntoBaseFrame(renderTexture) {
    if (!this.#gridCompositingEnabled()) {
      this.#restoreLiveGridMeshVisibility();
      return false;
    }

    const renderer = canvas?.app?.renderer ?? null;
    const mesh = this.#getGridMeshForCompositing();
    if (!renderer || !mesh || !renderTexture) {
      this.#restoreLiveGridMeshVisibility();
      return false;
    }

    const previousVisible = mesh.visible;
    const previousRenderable = mesh.renderable;
    const previousFilterArea = mesh.filterArea ?? null;
    const { width, height } = this.#getViewportMetrics();

    try {
      mesh.visible = true;
      mesh.renderable = true;
      mesh.filterArea = new PIXI.Rectangle(0, 0, width, height);
      mesh.updateTransform?.();
      renderer.render(mesh, {
        renderTexture,
        clear: false,
        skipUpdateTransform: true,
      });
      this.#setLiveGridMeshHidden(true);
      return true;
    } catch (err) {
      logger.debug("FXMaster:", err);
      this.#restoreLiveGridMeshVisibility();
      return false;
    } finally {
      try {
        mesh.filterArea = previousFilterArea;
        if (!this._gridMeshVisibilityState || this._gridMeshVisibilityState.mesh !== mesh) {
          mesh.visible = previousVisible;
          mesh.renderable = previousRenderable;
        }
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
  }

  /**
   * Temporarily suppress the visible compositor output so the environment capture does not sample the previous frame.
   *
   * @returns {{ containerVisible: boolean, containerRenderable: boolean, spriteVisible: boolean, spriteRenderable: boolean }}
   */
  #suspendDisplayOutput() {
    const state = {
      containerVisible: !!this._displayContainer?.visible,
      containerRenderable: !!this._displayContainer?.renderable,
      spriteVisible: !!this._displaySprite?.visible,
      spriteRenderable: !!this._displaySprite?.renderable,
    };

    if (this._displaySprite) {
      this._displaySprite.visible = false;
      this._displaySprite.renderable = false;
    }

    if (this._displayContainer) {
      this._displayContainer.visible = false;
      this._displayContainer.renderable = false;
    }

    return state;
  }

  /**
   * Restore the compositor output visibility after an off-screen environment capture.
   *
   * @param {{ containerVisible: boolean, containerRenderable: boolean, spriteVisible: boolean, spriteRenderable: boolean }|null|undefined} state
   * @returns {void}
   */
  #restoreDisplayOutput(state) {
    if (!state) return;

    if (this._displayContainer) {
      this._displayContainer.visible = state.containerVisible;
      this._displayContainer.renderable = state.containerRenderable;
    }

    if (this._displaySprite) {
      this._displaySprite.visible = state.spriteVisible;
      this._displaySprite.renderable = state.spriteRenderable;
    }
  }

  /**
   * Capture the current environment output into the supplied render texture using live world transforms.
   *
   * @param {PIXI.RenderTexture} renderTexture
   * @returns {boolean}
   */
  #captureEnvironment(renderTexture) {
    const renderer = canvas?.app?.renderer;
    const environment = canvas?.environment;
    if (!renderer || !environment || !renderTexture) return false;

    const { width, height } = this.#getViewportMetrics();
    const previousFilterArea = environment.filterArea ?? null;
    const viewportArea = new PIXI.Rectangle(0, 0, width, height);

    try {
      environment.filterArea = viewportArea;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    try {
      fxmUpdateDisplayObjectWorldTransform(environment);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    try {
      environment.updateTransform?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    if (!this.#clearRenderTexture(renderTexture)) return false;

    try {
      renderer.render(environment, {
        renderTexture,
        clear: false,
        skipUpdateTransform: true,
      });
      return true;
    } catch (err) {
      logger.debug("FXMaster:", err);
      return false;
    } finally {
      try {
        environment.filterArea = previousFilterArea;
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
  }

  /**
   * Ensure the compositor sprites exist.
   *
   * @returns {void}
   */
  #ensureSprites() {
    if (!this._displayContainer || this._displayContainer.destroyed) {
      this._displayContainer = this.#createDisplayContainer();
      this._displayContainer.name = "fxmasterGlobalEffectsOutputContainer";
      this._displayContainer.eventMode = "none";
      this._displayContainer.sortableChildren = false;
      this._displayContainer.visible = false;
      this._displayContainer.renderable = false;
    }

    if (!this._displaySprite || this._displaySprite.destroyed) {
      this._displaySprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
      this._displaySprite.name = "fxmasterGlobalEffectsOutput";
      this._displaySprite.eventMode = "none";
      this._displaySprite.visible = false;
      this._displaySprite.renderable = false;
      this._displaySprite.anchor.set(0, 0);
      this._displayContainer.addChild(this._displaySprite);
    } else if (this._displaySprite.parent !== this._displayContainer) {
      this._displayContainer.addChild(this._displaySprite);
    }

    if (!this._sceneClipMask || this._sceneClipMask.destroyed) {
      this._sceneClipMask = new PIXI.Graphics();
      this._sceneClipMask.name = "fxmasterGlobalEffectsSceneClip";
      this._sceneClipMask.eventMode = "none";
      this._sceneClipMask.visible = true;
      this._sceneClipMask.renderable = false;
      this._sceneClipMask.alpha = 1;
      this._displayContainer.addChildAt(this._sceneClipMask, 0);
    } else if (this._sceneClipMask.parent !== this._displayContainer) {
      this._displayContainer.addChildAt(this._sceneClipMask, 0);
    }

    this.#bindPreferredSceneMask();

    if (!this._blitSprite || this._blitSprite.destroyed) {
      this._blitSprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
      this._blitSprite.name = "fxmasterBlitSprite";
      this._blitSprite.eventMode = "none";
      this._blitSprite.anchor.set(0, 0);
    }

    if (!this._filterSprite || this._filterSprite.destroyed) {
      this._filterSprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
      this._filterSprite.name = "fxmasterFilterSprite";
      this._filterSprite.eventMode = "none";
      this._filterSprite.anchor.set(0, 0);
    }

    if (!this._surfaceMaskThresholdSprite || this._surfaceMaskThresholdSprite.destroyed) {
      this._surfaceMaskThresholdSprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
      this._surfaceMaskThresholdSprite.name = "fxmasterSurfaceMaskThresholdSprite";
      this._surfaceMaskThresholdSprite.eventMode = "none";
      this._surfaceMaskThresholdSprite.anchor.set(0, 0);
    }

    if (!this._surfaceMaskRenderList || this._surfaceMaskRenderList.destroyed) {
      const renderList = new PIXI.Container();
      renderList.name = "fxmasterSurfaceMaskBatchRenderer";
      renderList.eventMode = "none";
      renderList.sortableChildren = false;
      renderList.__fxmObjects = [];
      renderList.render = function fxmRenderSurfaceMaskBatch(renderer) {
        for (const object of this.__fxmObjects ?? []) {
          if (!object || object.destroyed || object.visible === false || object.renderable === false) continue;
          try {
            object.render?.(renderer);
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
        }
      };
      renderList.updateTransform = function fxmNoopSurfaceMaskBatchTransform() {};
      this._surfaceMaskRenderList = renderList;
    }

    if (!this._filterPassContainer || this._filterPassContainer.destroyed) {
      this._filterPassContainer = new PIXI.Container();
      this._filterPassContainer.name = "fxmasterFilterPassContainer";
      this._filterPassContainer.eventMode = "none";
      this._filterPassContainer.sortableChildren = false;
    }

    if (!this._filterPassSceneClipMask || this._filterPassSceneClipMask.destroyed) {
      this._filterPassSceneClipMask = new PIXI.Graphics();
      this._filterPassSceneClipMask.name = "fxmasterFilterPassSceneClip";
      this._filterPassSceneClipMask.eventMode = "none";
      this._filterPassSceneClipMask.visible = false;
      this._filterPassSceneClipMask.renderable = true;
      this._filterPassContainer.addChildAt(this._filterPassSceneClipMask, 0);
    } else if (this._filterPassSceneClipMask.parent !== this._filterPassContainer) {
      this._filterPassContainer.addChildAt(this._filterPassSceneClipMask, 0);
    }

    if (!this._filterPassSprite || this._filterPassSprite.destroyed) {
      this._filterPassSprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
      this._filterPassSprite.name = "fxmasterFilterPassSprite";
      this._filterPassSprite.eventMode = "none";
      this._filterPassSprite.anchor.set(0, 0);
      this._filterPassContainer.addChild(this._filterPassSprite);
    } else if (this._filterPassSprite.parent !== this._filterPassContainer) {
      this._filterPassContainer.addChild(this._filterPassSprite);
    }

    if (!this._tileRestoreContainer || this._tileRestoreContainer.destroyed) {
      this._tileRestoreContainer = new PIXI.Container();
      this._tileRestoreContainer.name = "fxmasterTileRestoreContainer";
      this._tileRestoreContainer.eventMode = "none";
      this._tileRestoreContainer.sortableChildren = false;
    }

    if (!this._tileRestoreMask || this._tileRestoreMask.destroyed) {
      this._tileRestoreMask = new PIXI.Sprite(PIXI.Texture.EMPTY);
      this._tileRestoreMask.name = "fxmasterTileRestoreMask";
      this._tileRestoreMask.eventMode = "none";
      this._tileRestoreMask.anchor.set(0, 0);
      this._tileRestoreContainer.addChild(this._tileRestoreMask);
    } else if (this._tileRestoreMask.parent !== this._tileRestoreContainer) {
      this._tileRestoreContainer.addChild(this._tileRestoreMask);
    }

    if (!this._tileRestoreSprite || this._tileRestoreSprite.destroyed) {
      this._tileRestoreSprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
      this._tileRestoreSprite.name = "fxmasterTileRestoreSprite";
      this._tileRestoreSprite.eventMode = "none";
      this._tileRestoreSprite.anchor.set(0, 0);
      this._tileRestoreContainer.addChild(this._tileRestoreSprite);
    } else if (this._tileRestoreSprite.parent !== this._tileRestoreContainer) {
      this._tileRestoreContainer.addChild(this._tileRestoreSprite);
    }

    if (this._tileRestoreSprite?.mask !== this._tileRestoreMask) {
      this._tileRestoreSprite.mask = this._tileRestoreMask;
    }

    if (!this._foregroundMaskSprite || this._foregroundMaskSprite.destroyed) {
      this._foregroundMaskSprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
      this._foregroundMaskSprite.name = "fxmasterForegroundMaskSprite";
      this._foregroundMaskSprite.eventMode = "none";
      this._foregroundMaskSprite.anchor.set(0, 0);
      this._foregroundMaskSprite.visible = false;
      this._foregroundMaskSprite.renderable = true;
    }
  }

  /**
   * Create a display container for the compositor output.
   *
   * @returns {PIXI.Container}
   */
  #createDisplayContainer() {
    const UnboundContainer = foundry?.canvas?.containers?.UnboundContainer;
    return UnboundContainer ? new UnboundContainer() : new PIXI.Container();
  }

  /**
   * Return the preferred live scene mask for compositor output.
   *
   * Plain scene particles already lock correctly in world space. The remaining moving hard edge at scene bounds comes from the compositor using its own reconstructed screen-space clip rectangle instead of the same live scene mask Foundry applies to native scene-bound layers. Prefer the native scene mask directly whenever it exists, and keep the generated graphics clip only as a fallback.
   *
   * @returns {PIXI.DisplayObject|null}
   */
  #getPreferredSceneMask() {
    if (!this._forceGeneratedSceneClipFrame) {
      const nativeMask = canvas?.masks?.scene ?? null;
      if (nativeMask && !nativeMask.destroyed) return nativeMask;
    }
    return this._sceneClipMask && !this._sceneClipMask.destroyed ? this._sceneClipMask : null;
  }

  /**
   * Bind the best available scene mask to the visible compositor output sprite.
   *
   * @returns {boolean} True when the native Foundry scene mask is active.
   */
  #bindPreferredSceneMask() {
    const sprite = this._displaySprite;
    if (!sprite) return false;

    const mask = this.#getPreferredSceneMask();
    if (sprite.mask !== mask) sprite.mask = mask ?? null;

    const usingNativeMask = !!mask && mask !== this._sceneClipMask;
    if (usingNativeMask && this._sceneClipMask && !this._sceneClipMask.destroyed) {
      try {
        this._sceneClipMask.visible = false;
        this._sceneClipMask.renderable = false;
        this._sceneClipMask.clear();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    return usingNativeMask;
  }

  /**
   * Return the rendered-group sibling the compositor output should follow.
   *
   * The composited result replaces the environment output while preserving later visibility and interface passes.
   *
   * @param {PIXI.Container|null} parent
   * @returns {PIXI.DisplayObject|null}
   */
  #getInsertionTarget(parent) {
    if (!parent) return null;
    const environment = canvas?.environment ?? null;
    if (environment?.parent === parent) return environment;
    return null;
  }

  /**
   * Return the preferred visible parent for the compositor output container.
   *
   * The container is inserted into the rendered group as a screen-space sibling immediately after the environment pass.
   *
   * @returns {PIXI.Container|null}
   */
  #getDisplayParent() {
    return canvas?.rendered ?? this.layer ?? null;
  }

  /**
   * Attach the visible output container to the rendered canvas group at the correct draw position.
   *
   * @returns {void}
   */
  #attachDisplayContainer() {
    const container = this._displayContainer;
    const parent = this.#getDisplayParent();
    if (!container || !parent) return;

    const insertionTarget = this.#getInsertionTarget(parent);
    const hasTarget = insertionTarget && insertionTarget.parent === parent;

    if (container.parent !== parent) {
      try {
        container.parent?.removeChild?.(container);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }

      if (hasTarget && typeof parent.getChildIndex === "function" && typeof parent.addChildAt === "function") {
        const index = Math.max(0, parent.getChildIndex(insertionTarget) + 1);
        parent.addChildAt(container, Math.min(index, parent.children.length));
      } else {
        parent.addChild(container);
      }
      return;
    }

    if (typeof parent.getChildIndex !== "function" || typeof parent.setChildIndex !== "function") return;

    const desiredIndex = hasTarget
      ? Math.max(0, parent.getChildIndex(insertionTarget) + 1)
      : Math.max(0, parent.children.length - 1);
    const currentIndex = parent.getChildIndex(container);
    const boundedIndex = Math.min(desiredIndex, Math.max(0, parent.children.length - 1));
    if (currentIndex === boundedIndex) return;

    try {
      parent.setChildIndex(container, boundedIndex);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  /**
   * Reset the visible compositor container transform.
   *
   * @returns {void}
   */
  #resetOutputSpriteTransform() {
    const container = this._displayContainer;
    if (!container) return;

    container.position.set(0, 0);
    container.scale.set(1, 1);
    container.rotation = 0;
    container.skew?.set?.(0, 0);
    container.pivot?.set?.(0, 0);
    container.roundPixels = false;
    this.#syncOutputSpriteTransform();
  }

  /**
   * Reset the visible output sprite transform.
   *
   * @returns {void}
   */
  #syncOutputSpriteTransform() {
    const sprite = this._displaySprite;
    if (!sprite) return;

    sprite.roundPixels = false;
    sprite.transform.setFromMatrix(PIXI.Matrix.IDENTITY);
  }

  /**
   * Read the current live stage matrix without camera snapping.
   *
   * @returns {PIXI.Matrix}
   */
  #currentLiveStageMatrix() {
    const stage = canvas?.stage ?? null;
    const tr = stage?.transform ?? null;

    try {
      tr?.updateLocalTransform?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    const src = tr?.localTransform ?? stage?.localTransform ?? stage?.worldTransform ?? PIXI.Matrix.IDENTITY;
    if (src?.clone) return src.clone();
    return new PIXI.Matrix(src?.a ?? 1, src?.b ?? 0, src?.c ?? 0, src?.d ?? 1, src?.tx ?? 0, src?.ty ?? 0);
  }

  /**
   * Update the live scene clip used for plain scene-filter stack passes.
   *
   * @returns {PIXI.Graphics|null}
   */
  #updateFilterPassSceneClipMask() {
    const mask = this._filterPassSceneClipMask;
    const dimensions = canvas?.dimensions;
    if (!mask || !dimensions?.sceneRect) return null;

    const sceneRect = dimensions.sceneRect;
    const stageMatrix = this.#currentLiveStageMatrix();

    const x0 = Number(sceneRect.x) || 0;
    const y0 = Number(sceneRect.y) || 0;
    const x1 = x0 + (Number(sceneRect.width) || 0);
    const y1 = y0 + (Number(sceneRect.height) || 0);

    const p0 = stageMatrix.apply(new PIXI.Point(x0, y0), new PIXI.Point());
    const p1 = stageMatrix.apply(new PIXI.Point(x1, y1), new PIXI.Point());

    const left = Math.min(p0.x, p1.x);
    const top = Math.min(p0.y, p1.y);
    const right = Math.max(p0.x, p1.x);
    const bottom = Math.max(p0.y, p1.y);
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);

    mask.clear();
    if (width <= 0 || height <= 0) {
      mask.visible = false;
      return mask;
    }

    mask.beginFill(0xffffff, 1);
    mask.drawRect(left, top, width, height);
    mask.endFill();
    mask.visible = false;
    mask.renderable = true;
    return mask;
  }

  /**
   * Update the screen-space scene clip mask used to bound compositor output to the visible scene area.
   *
   * @returns {void}
   */
  #updateSceneClipMask() {
    const mask = this._sceneClipMask;
    const sprite = this._displaySprite;
    const dimensions = canvas?.dimensions;
    if (!mask || !sprite || !dimensions?.sceneRect) return;

    if (this.#bindPreferredSceneMask()) return;

    const { cssW, cssH } = getCssViewportMetrics();
    /**
     * Match the clip bounds to the same live camera transform used by the environment capture. Using a snapped stage matrix here makes the final compositor output clip one transform behind the captured scene during pan, which shows up most obviously as particles appearing to slide at the scene edges even when the particle render itself is correct.
     */
    const stageMatrix = currentWorldMatrix(canvas?.stage, { snapStage: false });
    const sceneRect = dimensions.sceneRect;

    const x0 = Number(sceneRect.x) || 0;
    const y0 = Number(sceneRect.y) || 0;
    const x1 = x0 + (Number(sceneRect.width) || 0);
    const y1 = y0 + (Number(sceneRect.height) || 0);

    const p0 = stageMatrix.apply(new PIXI.Point(x0, y0), new PIXI.Point());
    const p1 = stageMatrix.apply(new PIXI.Point(x1, y1), new PIXI.Point());

    const left = Math.floor(Math.min(p0.x, p1.x));
    const top = Math.floor(Math.min(p0.y, p1.y));
    const right = Math.ceil(Math.max(p0.x, p1.x));
    const bottom = Math.ceil(Math.max(p0.y, p1.y));

    const x = Math.max(0, Math.min(cssW, left));
    const y = Math.max(0, Math.min(cssH, top));
    const width = Math.max(0, Math.min(cssW, right) - x);
    const height = Math.max(0, Math.min(cssH, bottom) - y);

    mask.clear();
    mask.alpha = 1;
    mask.renderable = false;
    if (width <= 0 || height <= 0) {
      mask.visible = false;
      return;
    }

    mask.beginFill(0xffffff, 1);
    mask.drawRect(x, y, width, height);
    mask.endFill();
    /**
     * The fallback clip must remain visible to PIXI's mask system, but it must not participate in the normal display pass. Foundry V13 can otherwise draw the white scene-rect Graphics as an overlay when no native canvas scene mask exists.
     */
    mask.visible = true;
    mask.renderable = false;
  }

  /**
   * Return the viewport dimensions used for compositor render textures.
   *
   * @returns {{width:number, height:number, resolution:number}}
   */
  #getViewportMetrics() {
    const { cssW, cssH } = getCssViewportMetrics();
    const width = Math.max(1, Number(cssW) || 1);
    const height = Math.max(1, Number(cssH) || 1);
    const resolution = safeResolutionForCssArea(width, height);
    return { width, height, resolution };
  }

  /**
   * Ensure the compositor render textures match the current viewport size.
   *
   * @returns {void}
   */
  #ensureRenderTextures() {
    const { width, height, resolution } = this.#getViewportMetrics();
    const needsResize = (rt) => {
      if (!this.#canBindRenderTexture(rt)) return true;
      return rt.width !== width || rt.height !== height || (rt.resolution ?? 1) !== resolution;
    };

    if (needsResize(this._baseRT)) {
      try {
        this._baseRT?.destroy?.(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this._baseRT = PIXI.RenderTexture.create({ width, height, resolution });
      this.#configureRenderTexture(this._baseRT);
    }

    if (needsResize(this._rtA)) {
      try {
        this._rtA?.destroy?.(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this._rtA = PIXI.RenderTexture.create({ width, height, resolution });
      this.#configureRenderTexture(this._rtA);
    }

    if (needsResize(this._rtB)) {
      try {
        this._rtB?.destroy?.(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this._rtB = PIXI.RenderTexture.create({ width, height, resolution });
      this.#configureRenderTexture(this._rtB);
    }

    if (needsResize(this._foregroundMaskRT)) {
      try {
        this._foregroundMaskRT?.destroy?.(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this._foregroundMaskRT = PIXI.RenderTexture.create({ width, height, resolution });
      this.#configureRenderTexture(this._foregroundMaskRT);
    }

    if (needsResize(this._foregroundVisibleMaskRT)) {
      try {
        this._foregroundVisibleMaskRT?.destroy?.(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this._foregroundVisibleMaskRT = PIXI.RenderTexture.create({ width, height, resolution });
      this.#configureRenderTexture(this._foregroundVisibleMaskRT);
    }

    if (needsResize(this._foregroundUpperVisibleRT)) {
      try {
        this._foregroundUpperVisibleRT?.destroy?.(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this._foregroundUpperVisibleRT = PIXI.RenderTexture.create({ width, height, resolution });
      this.#configureRenderTexture(this._foregroundUpperVisibleRT);
    }

    if (needsResize(this._regionUpperVisibleRT)) {
      try {
        this._regionUpperVisibleRT?.destroy?.(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this._regionUpperVisibleRT = null;
    }

    if (this._regionUpperVisibleRTCache instanceof Map) {
      for (const [key, rt] of this._regionUpperVisibleRTCache.entries()) {
        if (!needsResize(rt)) continue;
        try {
          rt?.destroy?.(true);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        this._regionUpperVisibleRTCache.delete(key);
      }
    }

    if (this._levelSegmentMaskRTCache instanceof Map) {
      for (const [key, rt] of this._levelSegmentMaskRTCache.entries()) {
        if (!needsResize(rt)) continue;
        try {
          rt?.destroy?.(true);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        this._levelSegmentMaskRTCache.delete(key);
      }
    }

    const pruneEntryCacheForResize = (cache) => {
      if (!(cache instanceof Map)) return;
      for (const [key, entry] of cache.entries()) {
        if (!needsResize(entry?.rt)) continue;
        try {
          entry?.rt?.destroy?.(true);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        cache.delete(key);
      }
    };
    pruneEntryCacheForResize(this._sceneSuppressionRegionMaskRTCache);
    pruneEntryCacheForResize(this._sceneSuppressionRegionMaskDynamicRTCache);
    pruneEntryCacheForResize(this._sceneSuppressionCombinedMaskRTCache);
    pruneEntryCacheForResize(this._sceneSuppressionCombinedMaskDynamicRTCache);

    if (needsResize(this._levelBlockerRT)) {
      try {
        this._levelBlockerRT?.destroy?.(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this._levelBlockerRT = PIXI.RenderTexture.create({ width, height, resolution });
      this.#configureRenderTexture(this._levelBlockerRT);
    }

    if (needsResize(this._selectedLevelSurfaceRT)) {
      try {
        this._selectedLevelSurfaceRT?.destroy?.(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this._selectedLevelSurfaceRT = PIXI.RenderTexture.create({ width, height, resolution });
      this.#configureRenderTexture(this._selectedLevelSurfaceRT);
      this._selectedLevelSurfacePersistentKey = null;
    }

    if (needsResize(this._selectedLevelForegroundRT)) {
      try {
        this._selectedLevelForegroundRT?.destroy?.(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this._selectedLevelForegroundRT = PIXI.RenderTexture.create({ width, height, resolution });
      this.#configureRenderTexture(this._selectedLevelForegroundRT);
      this._selectedLevelForegroundPersistentKey = null;
    }

    if (needsResize(this._particleSelectedLevelMaskRT)) {
      try {
        this._particleSelectedLevelMaskRT?.destroy?.(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this._particleSelectedLevelMaskRT = PIXI.RenderTexture.create({ width, height, resolution });
      this.#configureRenderTexture(this._particleSelectedLevelMaskRT);
      this._particleSelectedLevelMaskFrameSerial = -1;
      this._particleSelectedLevelMaskFrameKey = null;
      this._particleSelectedLevelMaskFrameTexture = null;
      this._particleSelectedLevelMaskPersistentKey = null;
    }

    if (needsResize(this._selectedLevelSurfaceScratchRT)) {
      try {
        this._selectedLevelSurfaceScratchRT?.destroy?.(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this._selectedLevelSurfaceScratchRT = PIXI.RenderTexture.create({ width, height, resolution });
      this.#configureRenderTexture(this._selectedLevelSurfaceScratchRT);
    }

    if (needsResize(this._rowSourceRT)) {
      try {
        this._rowSourceRT?.destroy?.(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this._rowSourceRT = PIXI.RenderTexture.create({ width, height, resolution });
      this.#configureRenderTexture(this._rowSourceRT);
    }

    for (const key of ["_weatherRestrictTilesParticleRT", "_weatherRestrictTilesFilterRT"]) {
      if (!needsResize(this[key])) continue;
      try {
        this[key]?.destroy?.(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this[key] = PIXI.RenderTexture.create({ width, height, resolution });
      this.#configureRenderTexture(this[key]);
    }

    if (needsResize(this._particleMaskScratchRT)) {
      try {
        this._particleMaskScratchRT?.destroy?.(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this._particleMaskScratchRT = PIXI.RenderTexture.create({ width, height, resolution });
      this.#configureRenderTexture(this._particleMaskScratchRT);
    }

    if (needsResize(this._surfaceMaskScratchRT)) {
      try {
        this._surfaceMaskScratchRT?.destroy?.(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this._surfaceMaskScratchRT = PIXI.RenderTexture.create({ width, height, resolution });
      this.#configureRenderTexture(this._surfaceMaskScratchRT);
    }

    if (needsResize(this._maskIntersectionRT)) {
      try {
        this._maskIntersectionRT?.destroy?.(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this._maskIntersectionRT = PIXI.RenderTexture.create({ width, height, resolution });
      this.#configureRenderTexture(this._maskIntersectionRT);
    }

    if (needsResize(this._feedbackCopyRT)) {
      try {
        this._feedbackCopyRT?.destroy?.(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this._feedbackCopyRT = PIXI.RenderTexture.create({ width, height, resolution });
      this.#configureRenderTexture(this._feedbackCopyRT);
    }
  }

  /**
   * Apply common sampler settings to a compositor render texture.
   *
   * @param {PIXI.RenderTexture|null} texture
   * @returns {void}
   */
  #configureRenderTexture(texture) {
    try {
      if (!texture?.baseTexture) return;
      texture.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
      texture.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
      texture.baseTexture.alphaMode = PIXI.ALPHA_MODES.PREMULTIPLIED_ALPHA;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  /**
   * Destroy compositor render textures.
   *
   * @returns {void}
   */
  #destroyRenderTextures() {
    try {
      this._baseRT?.destroy?.(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      this._rtA?.destroy?.(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      this._rtB?.destroy?.(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      this._foregroundMaskRT?.destroy?.(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      this._foregroundVisibleMaskRT?.destroy?.(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      this._foregroundUpperVisibleRT?.destroy?.(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      this._regionLocalEnvRT?.destroy?.(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      this._regionUpperVisibleRT?.destroy?.(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    if (this._regionUpperVisibleRTCache instanceof Map) {
      for (const rt of this._regionUpperVisibleRTCache.values()) {
        try {
          rt?.destroy?.(true);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }
      this._regionUpperVisibleRTCache.clear();
    }
    if (this._levelSegmentMaskRTCache instanceof Map) {
      for (const rt of this._levelSegmentMaskRTCache.values()) {
        try {
          rt?.destroy?.(true);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }
      this._levelSegmentMaskRTCache.clear();
    }
    try {
      this._levelBlockerRT?.destroy?.(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      this._selectedLevelSurfaceRT?.destroy?.(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      this._selectedLevelForegroundRT?.destroy?.(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      this._particleSelectedLevelMaskRT?.destroy?.(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      this._selectedLevelSurfaceScratchRT?.destroy?.(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      this._rowSourceRT?.destroy?.(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    for (const key of ["_weatherRestrictTilesParticleRT", "_weatherRestrictTilesFilterRT"]) {
      try {
        this[key]?.destroy?.(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
    try {
      this._particleMaskScratchRT?.destroy?.(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      this._surfaceMaskScratchRT?.destroy?.(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      this._maskIntersectionRT?.destroy?.(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      this._feedbackCopyRT?.destroy?.(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      this._sceneFilterSuppressionRegionRT?.destroy?.(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    this.#destroyRenderTextureEntryCache(this._sceneSuppressionRegionMaskRTCache);
    this.#destroyRenderTextureEntryCache(this._sceneSuppressionRegionMaskDynamicRTCache);
    this.#destroyRenderTextureEntryCache(this._sceneSuppressionCombinedMaskRTCache);
    this.#destroyRenderTextureEntryCache(this._sceneSuppressionCombinedMaskDynamicRTCache);
    try {
      this._maskIntersectionFilter?.destroy?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      this._maskIntersectionSprite?.destroy?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    this._baseRT = null;
    this._rtA = null;
    this._rtB = null;
    this._foregroundMaskRT = null;
    this._foregroundVisibleMaskRT = null;
    this._foregroundUpperVisibleRT = null;
    this._regionLocalEnvRT = null;
    this._regionUpperVisibleRT = null;
    this._regionUpperVisibleRTCache = new Map();
    this._levelSegmentMaskRTCache = new Map();
    this._levelBlockerRT = null;
    this._selectedLevelSurfaceRT = null;
    this._selectedLevelForegroundRT = null;
    this._particleSelectedLevelMaskRT = null;
    this._selectedLevelSurfaceScratchRT = null;
    this._rowSourceRT = null;
    this._weatherRestrictTilesParticleRT = null;
    this._weatherRestrictTilesFilterRT = null;
    this._particleMaskScratchRT = null;
    this._surfaceMaskScratchRT = null;
    this._maskIntersectionRT = null;
    this._feedbackCopyRT = null;
    this._sceneFilterSuppressionRegionRT = null;
    this._sceneSuppressionRegionMaskRTCache = new Map();
    this._sceneSuppressionRegionMaskDynamicRTCache = new Map();
    this._sceneSuppressionCombinedMaskRTCache = new Map();
    this._sceneSuppressionCombinedMaskDynamicRTCache = new Map();
    this._maskIntersectionSprite = null;
    this._maskIntersectionFilter = null;
    this._particleSelectedLevelMaskFrameSerial = -1;
    this._particleSelectedLevelMaskFrameKey = null;
    this._particleSelectedLevelMaskFrameTexture = null;
    this._particleSelectedLevelMaskPersistentKey = null;
  }

  /**
   * Return a bundle-safe performance snapshot for diagnostics macros.
   *
   * @returns {object}
   */
  getDebugPerformanceSnapshot() {
    const cacheSize = (cache) => (cache instanceof Map ? cache.size : 0);
    return {
      renderFrameSerial: this._renderFrameSerial ?? 0,
      sceneSuppressionMaskStats: { ...(this._sceneSuppressionMaskStats ?? {}) },
      sceneSuppressionRegionMaskCacheSize: cacheSize(this._sceneSuppressionRegionMaskRTCache),
      sceneSuppressionRegionMaskDynamicCacheSize: cacheSize(this._sceneSuppressionRegionMaskDynamicRTCache),
      sceneSuppressionCombinedMaskCacheSize: cacheSize(this._sceneSuppressionCombinedMaskRTCache),
      sceneSuppressionCombinedMaskDynamicCacheSize: cacheSize(this._sceneSuppressionCombinedMaskDynamicRTCache),
      levelSegmentMaskCacheSize: cacheSize(this._levelSegmentMaskRTCache),
      regionUpperVisibleCacheSize: cacheSize(this._regionUpperVisibleRTCache),
    };
  }

  /**
   * Compatibility alias for older diagnostics macros.
   *
   * @returns {object}
   */
  getPerformanceDebugState() {
    return this.getDebugPerformanceSnapshot();
  }
}
