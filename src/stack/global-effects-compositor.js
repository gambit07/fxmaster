import { getOrderedEnabledEffectRenderRows } from "../common/effect-stack.js";
import { FilterEffectsSceneManager } from "../filter-effects/filter-effects-scene-manager.js";
import { SceneMaskManager } from "../common/base-effects-scene-manager.js";
import { isEnabled } from "../settings.js";
import { logger } from "../logger.js";
import {
  currentWorldMatrix,
  getCanvasLevel,
  getCssViewportMetrics,
  getDocumentLevelsSet,
  getSelectedSceneLevelIds,
  getSceneLevels as getSceneLevelDocuments,
  getRegionElevationWindow,
  getTileOcclusionModes,
  inferVisibleLevelForDocument,
  getCanvasLiveLevelSurfaceRevealState,
  buildCanvasLiveLevelSurfaceSignature,
  isDocumentOnCurrentCanvasLevel,
  isTokenRevealedByHoveredUpperLevel,
  resolveDocumentOcclusionElevation,
  safeResolutionForCssArea,
  syncCanvasLiveLevelSurfaceState,
  tileDocumentRestrictsWeather,
  repaintTilesMaskInto,
} from "../utils.js";

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
 * Resolve a foreground image path from source-backed scene or level data.
 *
 * @param {*} sourceForeground
 * @returns {string}
 */
function resolveForegroundSourcePath(sourceForeground) {
  if (typeof sourceForeground === "string") return sourceForeground;
  if (sourceForeground && typeof sourceForeground === "object" && typeof sourceForeground.src === "string") {
    return sourceForeground.src;
  }
  return "";
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
    return decoded.replace(originPattern, "").replace(filePattern, "");
  } catch {
    return trimmed.replace(originPattern, "").replace(filePattern, "");
  }
}

/**
 * Add a source path into a comparison set when it is usable.
 *
 * @param {Set<string>} output
 * @param {string|null|undefined} sourcePath
 * @returns {void}
 */
function addComparableSourcePath(output, sourcePath) {
  if (!(output instanceof Set)) return;
  const normalized = normalizeComparableSourcePath(sourcePath);
  if (normalized) output.add(normalized);
}

/**
 * Recursively collect image or texture source paths from an arbitrary value.
 *
 * @param {*} value
 * @param {Set<string>} output
 * @param {Set<object>} [seen]
 * @returns {void}
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
 * Return the configured foreground image path for the active scene or viewed level.
 *
 * @returns {string}
 */
function getActiveForegroundImagePath() {
  const currentLevel = getCanvasLevel();
  const levelSrc = resolveForegroundSourcePath(currentLevel?._source?.foreground ?? null);
  if (levelSrc) return levelSrc;

  const scene = canvas?.scene ?? null;
  const sceneSrc = resolveForegroundSourcePath(scene?._source?.foreground ?? null);
  if (sceneSrc) return sceneSrc;

  return "";
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
    this._levelBlockerRT = null;
    this._selectedLevelSurfaceRT = null;
    this._selectedLevelForegroundRT = null;
    this._particleSelectedLevelMaskRT = null;
    this._rowSourceRT = null;
    this._weatherRestrictTilesRT = null;
    this._particleMaskScratchRT = null;
    this._displayContainer = null;
    this._displaySprite = null;
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
    this._rowAllowedLevelIdsFrameCache = null;
    this._rowFlagsFrameCache = null;
    this._displayObjectViewportHitFrameCache = null;
    this._tileActiveFrameCache = null;
    this._primaryLevelTexturesFrameCache = null;
    this._primaryTileMeshesFrameCache = null;
    this._primaryTileMeshesByTileIdFrameCache = null;
    this._rowVisualBlockerLevelIdsFrameCache = null;
    this._suppressionRegionsFrameCache = null;
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
    this._configuredLevelTextureObjectsFrameCache = null;
    this._hasSelectedLevelParticleRowsFrame = false;
    this._hasSceneFilterRowsFrame = false;
    this._forceGeneratedSceneClipFrame = false;
    this._foregroundMaskFrameSerial = -1;
    this._foregroundMaskFrameTexture = null;
    this._foregroundVisibleMaskFrameSerial = -1;
    this._foregroundVisibleMaskFrameTexture = null;
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
    this._weatherRestrictTilesFrameSerial = -1;
    this._weatherRestrictTilesFrameTexture = null;
    this._selectedLevelViewportMatrixKey = null;
    this._selectedLevelViewportMovingFrameSerial = -1;
    this._selectedLevelViewportMovingFrame = false;
    this._levelSurfaceSignatureFrameSerial = -1;
    this._levelSurfaceSignatureFrameValue = null;
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
    this._rowAllowedLevelIdsFrameCache = null;
    this._rowFlagsFrameCache = null;
    this._displayObjectViewportHitFrameCache = null;
    this._tileActiveFrameCache = null;
    this._primaryLevelTexturesFrameCache = null;
    this._primaryTileMeshesFrameCache = null;
    this._primaryTileMeshesByTileIdFrameCache = null;
    this._rowVisualBlockerLevelIdsFrameCache = null;
    this._suppressionRegionsFrameCache = null;
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
    this._configuredLevelTextureObjectsFrameCache = null;
    this._hasSelectedLevelParticleRowsFrame = false;
    this._hasSceneFilterRowsFrame = false;
    this._forceGeneratedSceneClipFrame = false;
    this._foregroundMaskFrameSerial = -1;
    this._foregroundMaskFrameTexture = null;
    this._foregroundVisibleMaskFrameSerial = -1;
    this._foregroundVisibleMaskFrameTexture = null;
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
    this._weatherRestrictTilesFrameSerial = -1;
    this._weatherRestrictTilesFrameTexture = null;
    this._selectedLevelViewportMatrixKey = null;
    this._selectedLevelViewportMovingFrameSerial = -1;
    this._selectedLevelViewportMovingFrame = false;
    this._levelSurfaceSignatureFrameSerial = -1;
    this._levelSurfaceSignatureFrameValue = null;
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
      this._rowAllowedLevelIdsFrameCache = new Map();
      this._rowFlagsFrameCache = new Map();
      this._displayObjectViewportHitFrameCache = new WeakMap();
      this._tileActiveFrameCache = new WeakMap();
      this._primaryLevelTexturesFrameCache = null;
      this._primaryTileMeshesFrameCache = null;
      this._primaryTileMeshesByTileIdFrameCache = null;
      this._rowVisualBlockerLevelIdsFrameCache = new Map();
      this._suppressionRegionsFrameCache = new Map();
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
      this._configuredLevelTextureObjectsFrameCache = new Map();
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
      this._weatherRestrictTilesFrameSerial = -1;
      this._weatherRestrictTilesFrameTexture = null;
      this._levelSurfaceSignatureFrameSerial = -1;
      this._levelSurfaceSignatureFrameValue = null;
      this.#attachDisplayContainer();
      if (this.#shouldSyncLevelSurfaceStateForFrame(frameInfo)) {
        syncCanvasLiveLevelSurfaceState();
      }
      this.#syncDynamicSceneState(rows, frameInfo);
      this.#syncCompositedSceneParticleSources(rows, true);

      const useTransparentParticleOnlyPass = this.#canUseTransparentParticleOnlyPass(rows);
      if (useTransparentParticleOnlyPass) {
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
        } finally {
          this.#restoreDisplayOutput(previousDisplayState);
        }

        this.#blit(this._baseRT, this._rtA, { clear: true });
      }

      let current = this._rtA;
      let next = this._rtB;
      const needsOutputSceneMask = frameInfo.needsOutputSceneMask;
      const regionLocalPassCache = { key: null, value: null };

      for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex--) {
        const row = rows[rowIndex];
        let applied = false;
        let outputInCurrent = false;
        const rowScope = this.#getRowScope(row);
        if (!this.#rowLevelSelectionCanRenderInCurrentView(row)) continue;
        const rowUsesSelectedSurfaceMask = this.#rowUsesSelectedLevelSurfaceMask(row);
        const restoreLevelBlockers =
          !rowUsesSelectedSurfaceMask && rowScope !== "region" && this.#rowHasLevelLimitedOutput(row);
        const rowRestoreSource = restoreLevelBlockers ? this._rowSourceRT : null;
        if (rowRestoreSource) this.#blit(current, rowRestoreSource, { clear: true });
        const regionLocalPass =
          rowScope === "region" ? this.#prepareRegionLevelLocalPass(row, regionLocalPassCache) : null;
        let selectedSurfaceMaskTexture = null;
        const rowInput = current;
        const rowOverlayTexture = regionLocalPass?.overlayTexture ?? null;
        const useRegionManagedOcclusion = rowScope === "region";
        const rowBaseForRestore = current;

        if (row.kind === "filter") {
          const filter = this.#resolveFilter(row.uid);
          if (!filter) continue;

          selectedSurfaceMaskTexture = rowUsesSelectedSurfaceMask
            ? this.#rowHasVisibleSelectedLevelSurfaces(row)
              ? true
              : null
            : null;
          if (rowUsesSelectedSurfaceMask && !selectedSurfaceMaskTexture) continue;

          const wantsBelowTiles = this.#rowWantsBelowTiles(row);
          const wantsBelowForeground = this.#rowWantsBelowForeground(row);
          const wantsForegroundImageMask =
            !selectedSurfaceMaskTexture && wantsBelowForeground && this.#hasVisibleForegroundCoverage();
          const useDirectSceneFilterClip = this.#rowUsesDirectSceneFilterClip(row);
          const weatherMaskTexture = this.#getRestrictWeatherTilesMaskTexture();
          const useNativeWeatherOcclusion =
            canUseNativeWeatherOcclusionStackPass() &&
            (!wantsBelowTiles || wantsBelowForeground) &&
            (!useRegionManagedOcclusion || wantsBelowForeground) &&
            !weatherMaskTexture;
          const cleanupFilterPass = this.#prepareFilterForStackPass(filter, {
            forceSoftMask: wantsBelowTiles && !useDirectSceneFilterClip,
            disableMask: useDirectSceneFilterClip,
          });

          try {
            if (useDirectSceneFilterClip) this.#applyDirectSceneFilterPass(filter, rowInput, next);
            else this.#applyFilterPass(filter, rowInput, next);
            applied = true;
          } finally {
            cleanupFilterPass?.();
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
            const weatherMaskTexture = this.#getRestrictWeatherTilesMaskTexture();
            if (weatherMaskTexture) this.#eraseTextureFromRenderTexture(weatherMaskTexture, next);
          } else if (applied && wantsForegroundImageMask) {
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
            const weatherMaskTexture = this.#getRestrictWeatherTilesMaskTexture();
            if (weatherMaskTexture) this.#eraseTextureFromRenderTexture(weatherMaskTexture, next);
          } else if (applied && useNativeWeatherOcclusion) {
            const weatherMaskTexture = this.#getRestrictWeatherTilesMaskTexture();

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
          if (!runtime) continue;

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
            !selectedSurfaceMaskTexture && wantsBelowForeground && this.#hasVisibleForegroundCoverage();
          const weatherMaskTexture = this.#getRestrictWeatherTilesMaskTexture();
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
          const needsIsolatedParticleOutput = !!selectedSurfaceMaskTexture || !!weatherMaskTexture;
          const particleRowOutput =
            (needsIsolatedParticleOutput || useTransparentSelectedParticleContribution) && this._particleMaskScratchRT
              ? this._particleMaskScratchRT
              : next;

          if (useTransparentSelectedParticleContribution) {
            this.#blit(particleBase, next, { clear: true });
            if (!this.#clearRenderTexture(particleRowOutput)) continue;
          } else {
            this.#blit(particleBase, particleRowOutput, { clear: true });
          }

          applied =
            canvas.particleeffects?.renderStackParticle?.(row.uid, particleRowOutput, {
              clear: false,
              respectBelowTilesMask: !useParticleTileRestore,
              respectNativeOcclusion: useNativeWeatherOcclusion,
              maskTextureOverride: selectedParticleMaskOverride,
            }) ?? false;

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

          if (applied && useParticleTileRestore) {
            this.#restoreTilesFromTexture(row.kind, particleBase, next);
          }

          if (applied && wantsForegroundImageMask) {
            if (canvas?.level && this.#hasVisibleLevelSurfacesForBelowForeground()) {
              this.#blit(next, this._baseRT, { clear: true });
              this.#compositeVisibleLevelBelowForegroundRowOutput(this._baseRT, particleBase, next);
            } else {
              this.#restoreFromTextureMask(this.#getForegroundVisibleMaskTexture(), particleBase, next);
            }
          }
        }

        if (applied && rowOverlayTexture) {
          const rowOutput = outputInCurrent ? current : next;
          this.#blit(rowOverlayTexture, rowOutput, { clear: false });
        }

        if (applied && restoreLevelBlockers && !rowOverlayTexture) {
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

    try {
      stage._recursivePostUpdateTransform?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    try {
      if (stage.parent?.transform) {
        stage.updateTransform?.();
        return;
      }

      if (typeof stage.enableTempParent === "function" && typeof stage.disableTempParent === "function") {
        const cacheParent = stage.enableTempParent();
        try {
          stage.updateTransform?.();
        } finally {
          stage.disableTempParent(cacheParent);
        }
      }
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
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
    if (!canvas?.level) return hasActiveForegroundImage();

    const visibleLevelIds = this.#getVisibleSceneLevelIdsInDrawOrder();
    if (!visibleLevelIds.length) return hasActiveForegroundImage();

    for (const levelId of visibleLevelIds) {
      if (this.#getConfiguredLevelImageSources(levelId, { foregroundOnly: true }).length) return true;
    }

    return (
      this.#collectVisibleForegroundSurfaceObjectsForLevelIds(new Set(visibleLevelIds)).length > 0 ||
      hasActiveForegroundImage()
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

    return !this.#hasSuppressionRegionsForFrame("filters");
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
    if (Number.isFinite(Number(canvas?.primary?.hoverFadeElevation))) return true;

    for (const token of canvas?.tokens?.controlled ?? []) {
      if (token && !token.destroyed && !token?.document?.hidden) return true;
    }

    const inspect = (mesh) => {
      if (!mesh || mesh.destroyed) return false;
      const object = mesh?.object ?? mesh?.placeable ?? mesh?._object ?? mesh?.sourceElement ?? null;
      const liveMesh = object?.mesh ?? object?.primaryMesh ?? object?.sprite ?? mesh;
      const hoverState =
        liveMesh?._hoverFadeState ?? liveMesh?.hoverFadeState ?? mesh?._hoverFadeState ?? mesh?.hoverFadeState ?? null;
      if (hoverState?.fading || hoverState?.faded || hoverState?.hovered) return true;

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

    for (const row of rows) {
      if (row?.kind !== "particle" || this.#getRowScope(row) !== "scene") return false;
      if (this.#rowUsesSelectedLevelSurfaceMask(row) || this.#rowHasLevelLimitedOutput(row)) return false;

      const runtime = row?.uid ? this.#resolveParticleRuntime(row.uid) : null;
      if (!runtime) return false;

      const fx = runtime?.fx ?? runtime?.slot ?? null;
      const blendMode = Number(fx?.blendMode ?? PIXI.BLEND_MODES.NORMAL);
      if (blendMode !== PIXI.BLEND_MODES.NORMAL) return false;
    }

    return true;
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
    const fx = runtime?.fx ?? runtime?.slot ?? null;
    const blendMode = Number(fx?.blendMode ?? PIXI.BLEND_MODES.NORMAL);
    return blendMode === PIXI.BLEND_MODES.NORMAL;
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

    return !this.#hasSuppressionRegionsForFrame("particles");
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

    const candidates = foregroundOnly
      ? [level?.foreground, level?._source?.foreground]
      : [level?.background, level?.foreground, level?._source?.background, level?._source?.foreground];
    const sources = [];
    const seen = new Set();

    for (const candidate of candidates) {
      const src = resolveForegroundSourcePath(candidate);
      const key = normalizeComparableSourcePath(src);
      if (!src || !key || seen.has(key)) continue;
      seen.add(key);
      sources.push(src);
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
      "_bounds",
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
    const candidates = [
      level?.textures,
      level?._source?.textures,
      level?.texture,
      level?._source?.texture,
      level?.bounds,
      level?._bounds,
      level?.rect,
      level?.rectangle,
      level?.dimensions,
    ];

    if (foregroundOnly) {
      candidates.push(
        level?.foreground,
        level?._source?.foreground,
        level?.foreground?.textures,
        level?._source?.foreground?.textures,
        level?.foreground?.texture,
        level?._source?.foreground?.texture,
      );
    } else {
      candidates.push(
        level?.background,
        level?._source?.background,
        level?.foreground,
        level?._source?.foreground,
        level?.background?.textures,
        level?._source?.background?.textures,
        level?.foreground?.textures,
        level?._source?.foreground?.textures,
        level?.background?.texture,
        level?._source?.background?.texture,
        level?.foreground?.texture,
        level?._source?.foreground?.texture,
      );
    }

    return candidates.filter(
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
        level?._source?.x,
      );
      const y = this.#firstFiniteNumber(
        candidate?.y,
        candidate?.offsetY,
        candidate?.top,
        candidate?.minY,
        position?.y,
        position?.top,
        level?.y,
        level?._source?.y,
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
    if (!worldRect && allowSceneRectFallback) {
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
   * Return whether configured Level artwork can be rendered into a non-scene-wide mask.
   *
   * @param {string|null|undefined} levelId
   * @param {{ foregroundOnly?: boolean }} [options]
   * @returns {boolean}
   */
  #configuredLevelImageMaskBoundsAvailable(levelId, { foregroundOnly = false } = {}) {
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

    const sprite = this._blitSprite;
    const { width, height } = this.#getViewportMetrics();
    const previousBlendMode = sprite.blendMode;
    const previousAlpha = sprite.alpha;
    sprite.texture = eraseTexture;
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

    const regionDocument =
      this.#getRowScope(row) === "region" && row?.ownerId ? canvas?.regions?.get(row.ownerId)?.document ?? null : null;

    return resolveDocumentOcclusionElevation(regionDocument, {
      fallback,
      preferForeground: this.#rowWantsBelowForeground(row),
    });
  }

  /**
   * Resolve the Region document owned by a compositor row.
   *
   * @param {{ ownerId?: string }|null|undefined} row
   * @returns {foundry.documents.Region|null}
   */
  #getRegionDocumentForRow(row) {
    const regionId = row?.ownerId ?? null;
    const region = regionId ? canvas?.regions?.get?.(regionId) ?? null : null;
    return region?.document ?? null;
  }

  /**
   * Return the bottom elevation for a Level document.
   *
   * @param {foundry.documents.Level|null|undefined} level
   * @returns {number}
   */
  #getLevelBottom(level) {
    return Number(level?.elevation?.bottom ?? level?.bottom ?? Number.NaN);
  }

  /**
   * Return the top elevation for a Level document.
   *
   * @param {foundry.documents.Level|null|undefined} level
   * @returns {number}
   */
  #getLevelTop(level) {
    return Number(level?.elevation?.top ?? level?.top ?? Number.NaN);
  }

  /**
   * Return whether one level should be treated as above another.
   *
   * @param {foundry.documents.Level|null|undefined} candidate
   * @param {foundry.documents.Level|null|undefined} target
   * @returns {boolean}
   */
  #levelIsAboveTargetLevel(candidate, target) {
    if (!candidate || !target) return false;

    const candidateBottom = this.#getLevelBottom(candidate);
    const targetBottom = this.#getLevelBottom(target);
    if (Number.isFinite(candidateBottom) && Number.isFinite(targetBottom)) return candidateBottom > targetBottom + 1e-4;

    const candidateTop = this.#getLevelTop(candidate);
    const targetTop = this.#getLevelTop(target);
    if (Number.isFinite(candidateTop) && Number.isFinite(targetTop)) return candidateTop > targetTop + 1e-4;

    return false;
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
    return !!(level.isVisible || level.isView);
  }

  /**
   * Return whether the row's explicit Scene Level selection is eligible to render in the current view.
   *
   * @param {object|null|undefined} row
   * @returns {boolean}
   */
  #rowLevelSelectionCanRenderInCurrentView(row) {
    if (this.#getRowScope(row) !== "scene") return true;

    const allowedLevelIds = this.#getRowAllowedLevelIds(row);
    if (!(allowedLevelIds?.size > 0)) return true;

    const currentLevel = getCanvasLevel();
    if (!currentLevel?.id) return true;
    if (allowedLevelIds.has(currentLevel.id)) return true;

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
    const regionLevels = getDocumentLevelsSet(regionDoc);
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

    return this.#getSceneLevels().filter((level) => {
      const levelId = level?.id ?? null;
      if (!levelId) return false;
      if (protectedLevelIds?.has(levelId)) return false;
      if (!(level?.isVisible || level?.isView)) return false;
      return this.#levelIsAboveTargetLevel(level, targetLevel);
    });
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
   * Return a normalized elevation window for a document-backed surface.
   *
   * @param {foundry.abstract.Document|object|null|undefined} document
   * @param {number} [fallbackElevation=Number.NaN]
   * @returns {{min:number,max:number}|null}
   */
  #getSurfaceElevationWindow(document, fallbackElevation = Number.NaN) {
    const fallback = Number(fallbackElevation);
    const trustDocumentElevation = this.#isDocumentBackedSurface(document) || !Number.isFinite(fallback);
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

    const candidateId = value?.id ?? value?._id ?? value?.document?.id ?? value?.document?._id ?? null;
    if (candidateId && this.#getSceneLevelById(candidateId)) output.add(candidateId);

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
      document?._source?.level ?? null,
      document?._source?.levels ?? null,
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

    const ids = new Set();
    for (const sceneLevel of this.#getSceneLevels()) {
      const levelId = sceneLevel?.id ?? null;
      if (!levelId) continue;

      const levelPaths = this.#getCachedLevelConfiguredImagePaths(sceneLevel);
      for (const pathValue of surfacePaths) {
        if (!levelPaths.has(pathValue)) continue;
        ids.add(levelId);
        break;
      }
    }

    return remember(ids);
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
   * Return whether tile surfaces should contribute to Level-local row masks.
   *
   * @param {object|null|undefined} row
   * @returns {boolean}
   */
  #rowIncludesTileSurfacesInLevelMasks(row) {
    return this.#rowWantsBelowTiles(row);
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
    const levels = getDocumentLevelsSet(regionDoc);

    if (levels?.size) {
      for (const levelId of levels) {
        if (this.#getSceneLevelById(levelId)) ids.add(levelId);
      }
      return ids;
    }

    if (fallbackLevel?.id) ids.add(fallbackLevel.id);

    const currentLevel = getCanvasLevel();
    if (currentLevel?.id) ids.add(currentLevel.id);

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

    const candidates = [level?.background, level?.foreground, level?._source?.background, level?._source?.foreground];

    for (const candidate of candidates) {
      const direct = resolveForegroundSourcePath(candidate);
      if (direct) addComparableSourcePath(output, direct);
      collectComparableSourcePaths(candidate, output);
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

    const candidates = [level?.foreground, level?._source?.foreground];
    for (const candidate of candidates) {
      const direct = resolveForegroundSourcePath(candidate);
      if (direct) addComparableSourcePath(output, direct);
      collectComparableSourcePaths(candidate, output);
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
    return `${suffix}:${level?.id ?? level?._id ?? this.#getSceneLevels().indexOf(level)}`;
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

      const linkedObject = object?.object ?? object?.placeable ?? object?._object ?? object?.sourceElement ?? null;
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

    const window = this.#getSurfaceElevationWindow(document ?? object ?? level ?? null, elevation);
    if (this.#surfaceTargetsLevelIds({ mesh, object, document, level, elevation, window }, protectedLevelIds))
      return false;
    return this.#surfaceTargetsLevelIds({ mesh, object, document, level, elevation, window }, overlayLevelIds);
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
      const linked = mesh?.object ?? mesh?.placeable ?? mesh?._object ?? mesh?.sourceElement ?? null;
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
   * @param {{ protectedLevelIds?: Set<string>|null }} [options]
   * @returns {PIXI.DisplayObject[]}
   */
  #collectUpperSurfaceObjectsForTargetLevel(targetLevel, { protectedLevelIds = null } = {}) {
    if (!targetLevel || !canvas?.primary) return [];

    const cacheKey = this.#upperSurfaceObjectsCacheKey(targetLevel, protectedLevelIds);
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
      if (revealState.revealed) continue;

      push(captureObject);
    }

    for (const mesh of this.#getPrimaryTileMeshesForFrame()) {
      const tileObject = mesh?.object ?? mesh?.placeable ?? mesh?._object ?? mesh?.sourceElement ?? null;
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
          { protectedLevelIds: null, overlayLevels },
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
   * Collect live canvas surfaces that belong to one of the selected native Scene Levels.
   *
   * The collected objects are rendered into a mask so rows assigned to a visible non-current Level affect only that Level's visible overlay surfaces while the current Level remains unchanged.
   *
   * @param {Set<string>|null|undefined} levelIds
   * @returns {PIXI.DisplayObject[]}
   */
  #collectVisibleSurfaceObjectsForLevelIds(levelIds, { includeTiles = true } = {}) {
    if (!(levelIds?.size > 0) || !canvas?.primary) return [];

    const cacheKey = `${this.#levelIdsCacheKey(levelIds)}::tiles:${includeTiles ? 1 : 0}`;
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
      if (!this.#surfaceEffectTargetsLevelIds({ mesh, object, document, level, elevation }, levelIds)) continue;

      push(captureObject);
    }

    if (!includeTiles) return remember(objects);

    for (const mesh of this.#getPrimaryTileMeshesForFrame()) {
      const tileObject = mesh?.object ?? mesh?.placeable ?? mesh?._object ?? mesh?.sourceElement ?? null;
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
      if (
        !this.#surfaceEffectTargetsLevelIds(
          { mesh, object: tileObject, document: document ?? tileObject ?? null, level, elevation },
          levelIds,
        )
      )
        continue;

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
   * Capture one Level's selected surface into a supplied render texture.
   *
   * Non-current Levels are captured from their live primary overlay/tile meshes. The current viewed Level first tries live configured artwork meshes and only uses authored-image placement metadata when it can be resolved without falling back to the full scene rectangle.
   *
   * @param {string|null|undefined} levelId
   * @param {PIXI.RenderTexture|null|undefined} renderTexture
   * @param {{ foregroundOnly?: boolean, binary?: boolean, clear?: boolean, includeTiles?: boolean }} [options]
   * @returns {boolean}
   */
  #captureLevelSurfaceMask(
    levelId,
    renderTexture,
    { foregroundOnly = false, binary = true, clear = true, includeTiles = true } = {},
  ) {
    if (!levelId || !renderTexture) return false;
    const level = this.#getSceneLevelById(levelId);
    if (!(level?.isVisible || level?.isView)) return false;

    if (clear && !this.#clearRenderTexture(renderTexture)) return false;

    let rendered = false;
    const levelIds = new Set([levelId]);
    const objects = foregroundOnly
      ? this.#collectVisibleForegroundSurfaceObjectsForLevelIds(levelIds)
      : this.#collectVisibleSurfaceObjectsForLevelIds(levelIds, { includeTiles });

    const hasLiveForegroundCandidate = foregroundOnly
      ? this.#hasForegroundSurfaceCandidatesForLevelIds(levelIds)
      : false;
    const useConfiguredImageFallback = foregroundOnly
      ? !hasLiveForegroundCandidate
      : this.#levelIsCurrentCanvasView(levelId) && !objects.length;

    if (useConfiguredImageFallback) {
      rendered =
        this.#renderConfiguredLevelImageMask(levelId, renderTexture, {
          foregroundOnly,
          clear: false,
          binary,
          allowSceneRectFallback: false,
        }) || rendered;
    }

    if (objects.length) {
      rendered =
        (binary
          ? this.#captureSurfaceMaskTexture(objects, renderTexture, { clear: false })
          : this.#captureSurfaceAlphaMaskTexture(objects, renderTexture, { clear: false })) || rendered;
    }

    return rendered;
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
    if (this.#collectVisibleSurfaceObjectsForLevelIds(allowedLevelIds, { includeTiles }).length) return true;

    for (const levelId of allowedLevelIds) {
      if (this.#levelIsCurrentCanvasView(levelId) && this.#configuredLevelImageMaskBoundsAvailable(levelId))
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
    const key = this.#selectedLevelSurfaceMaskKey(allowedLevelIds, includeTiles ? "surface:tiles" : "surface:no-tiles");
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
        this.#captureLevelSurfaceMask(levelId, this._selectedLevelSurfaceRT, {
          binary: true,
          clear: false,
          includeTiles,
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
    const key = this.#selectedLevelSurfaceMaskKey(
      allowedLevelIds,
      includeTiles ? "particle-surface:tiles" : "particle-surface:no-tiles",
    );
    if (
      this._particleSelectedLevelMaskFrameSerial === this._renderFrameSerial &&
      this._particleSelectedLevelMaskFrameKey === key
    ) {
      return this._particleSelectedLevelMaskFrameTexture ?? null;
    }

    const remember = (value) => {
      this._particleSelectedLevelMaskFrameSerial = this._renderFrameSerial;
      this._particleSelectedLevelMaskFrameKey = key;
      this._particleSelectedLevelMaskFrameTexture = value ?? null;
      return value ?? null;
    };

    if (!this._particleSelectedLevelMaskRT) return remember(null);
    if (!this.#clearRenderTexture(this._particleSelectedLevelMaskRT)) return remember(null);

    let rendered = false;
    for (const levelId of allowedLevelIds) {
      rendered =
        this.#captureLevelSurfaceMask(levelId, this._particleSelectedLevelMaskRT, {
          binary: true,
          clear: false,
          includeTiles,
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
      .filter((level) => level?.id && (level.isVisible || level.isView))
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
   * @param {{ includeTiles?: boolean }} [options]
   * @returns {PIXI.RenderTexture|null}
   */
  #captureSelectedLevelSurfaceMaskForLevelIds(levelIds, { includeTiles = true } = {}) {
    if (!this._selectedLevelSurfaceRT) return null;
    const ids = Array.from(levelIds ?? []).filter(Boolean);
    if (!ids.length) return null;
    if (!this.#clearRenderTexture(this._selectedLevelSurfaceRT)) return null;

    let rendered = false;
    for (const levelId of ids) {
      rendered =
        this.#captureLevelSurfaceMask(levelId, this._selectedLevelSurfaceRT, {
          binary: true,
          clear: false,
          includeTiles,
        }) || rendered;
    }
    return rendered ? this._selectedLevelSurfaceRT : null;
  }

  /**
   * Capture a binary coverage mask for a group of visible Scene Level restore surfaces.
   *
   * @param {string[]|Set<string>|null|undefined} levelIds
   * @param {Set<string>|null} [protectedLevelIds]
   * @param {{ includeTiles?: boolean }} [options]
   * @returns {PIXI.RenderTexture|null}
   */
  #captureSelectedLevelRestoreMaskForLevelIds(levelIds, protectedLevelIds = null, { includeTiles = true } = {}) {
    if (!this._selectedLevelSurfaceRT) return null;
    const ids = new Set(Array.from(levelIds ?? []).filter(Boolean));
    if (!ids.size) return null;
    if (!this.#clearRenderTexture(this._selectedLevelSurfaceRT)) return null;

    const objects = this.#collectVisualBlockerSurfaceObjectsForLevelIds(ids, { protectedLevelIds, includeTiles });
    if (!objects.length) return null;

    return this.#captureSurfaceMaskTexture(objects, this._selectedLevelSurfaceRT, { clear: false })
      ? this._selectedLevelSurfaceRT
      : null;
  }

  /**
   * Capture a binary coverage mask for a group of visible Scene Level foreground surfaces.
   *
   * @param {string[]|Set<string>|null|undefined} levelIds
   * @returns {PIXI.RenderTexture|null}
   */
  #captureSelectedLevelForegroundMaskForLevelIds(levelIds) {
    if (!this._selectedLevelForegroundRT) return null;
    const ids = Array.from(levelIds ?? []).filter(Boolean);
    if (!ids.length) return null;
    if (!this.#clearRenderTexture(this._selectedLevelForegroundRT)) return null;

    let rendered = false;
    for (const levelId of ids) {
      rendered =
        this.#captureLevelSurfaceMask(levelId, this._selectedLevelForegroundRT, {
          foregroundOnly: true,
          binary: true,
          clear: false,
        }) || rendered;
    }
    return rendered ? this._selectedLevelForegroundRT : null;
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
    return this.#compositeLevelRowOutputForLevelIds(selectedLevelIds, rowOutput, rowInput, output, {
      belowForeground,
      restoreUnselectedAbove: true,
      selectedMaskTexture,
      includeTiles: this.#rowIncludesTileSurfacesInLevelMasks(row),
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
    if (!canvas?.level) return false;
    const ids = new Set(this.#getVisibleSceneLevelIdsInDrawOrder());
    if (!ids.size) return false;

    for (const levelId of ids) {
      const levelIds = new Set([levelId]);
      if (this.#collectVisibleSurfaceObjectsForLevelIds(levelIds).length) return true;
      if (this.#levelIsCurrentCanvasView(levelId) && this.#configuredLevelImageMaskBoundsAvailable(levelId))
        return true;
    }

    return false;
  }

  /**
   * Composite a row output through selected Scene Levels in native draw order.
   *
   * @param {Set<string>|null|undefined} selectedLevelIds
   * @param {PIXI.RenderTexture|null|undefined} rowOutput
   * @param {PIXI.RenderTexture|null|undefined} rowInput
   * @param {PIXI.RenderTexture|null|undefined} output
   * @param {{ belowForeground?: boolean, restoreUnselectedAbove?: boolean, includeTiles?: boolean }} [options]
   * @returns {boolean}
   */
  #compositeLevelRowOutputForLevelIds(
    selectedLevelIds,
    rowOutput,
    rowInput,
    output,
    { belowForeground = false, restoreUnselectedAbove = true, selectedMaskTexture = null, includeTiles = true } = {},
  ) {
    if (!rowOutput || !rowInput || !output) return false;
    if (!(selectedLevelIds?.size > 0)) return false;

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
          const maskTexture = this.#captureSelectedLevelSurfaceMaskForLevelIds([levelId], { includeTiles });
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
          : this.#captureSelectedLevelSurfaceMaskForLevelIds(segment.levelIds, { includeTiles })
        : this.#captureSelectedLevelRestoreMaskForLevelIds(segment.levelIds, selectedLevelIds, { includeTiles });
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
    if (clear && !this.#clearRenderTexture(renderTexture)) return false;

    let rendered = false;
    for (const object of objects ?? []) {
      if (!object || object.destroyed) continue;
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
    if (clear && !this.#clearRenderTexture(renderTexture)) return false;

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
   * Prepare a level-local source frame for a Region-scoped compositor row.
   *
   * The returned input texture excludes visible upper-level surfaces from the Region's assigned level so Region filters and particles sample the underlying room instead of the covering roof. The live visible upper-level surfaces are then composited back over the row output so the roof retains its own appearance and alpha while the Region effect stays on the level beneath it.
   *
   * @param {object|null|undefined} row
   * @param {{ key: string|null, value: ({ input: PIXI.RenderTexture, overlayTexture: PIXI.RenderTexture }|null) }|null} [cache=null]
   * @returns {{ input: PIXI.RenderTexture, overlayTexture: PIXI.RenderTexture }|null}
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
    if (cache?.key === cacheKey) return cache.value ?? null;

    const remember = (value) => {
      if (cache) {
        cache.key = cacheKey;
        cache.value = value;
      }
      return value;
    };

    const upperObjects = this.#collectUpperSurfaceObjectsForTargetLevel(targetLevel, { protectedLevelIds });
    if (!upperObjects.length) return remember(null);

    const capturedUpper = this.#captureUpperSurfaceTexture(upperObjects, this._regionUpperVisibleRT);
    if (!capturedUpper) return remember(null);

    return remember({
      overlayTexture: this._regionUpperVisibleRT,
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
      return remember(ids?.size ? ids : null);
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
      if (!(level?.isVisible || level?.isView)) continue;
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
    { protectedLevelIds = null, includeTiles = true } = {},
  ) {
    if (!(blockerLevelIds?.size > 0) || !canvas?.primary) return [];

    const protectedKey = this.#levelIdsCacheKey(protectedLevelIds);
    const cacheKey = `${this.#levelIdsCacheKey(blockerLevelIds)}::protected:${protectedKey}:tiles:${
      includeTiles ? 1 : 0
    }`;
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
      if (!this.#surfaceVisuallyTargetsLevelIds(surfaceContext, blockerLevelIds)) continue;
      if (protectedLevelIds?.size && this.#surfaceVisuallyTargetsLevelIds(surfaceContext, protectedLevelIds)) continue;
      push(captureObject);
    }

    if (!includeTiles) return remember(objects);

    for (const mesh of this.#getPrimaryTileMeshesForFrame()) {
      const tileObject = mesh?.object ?? mesh?.placeable ?? mesh?._object ?? mesh?.sourceElement ?? null;
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
      if (!this.#surfaceVisuallyTargetsLevelIds(surfaceContext, blockerLevelIds)) continue;
      if (protectedLevelIds?.size && this.#surfaceVisuallyTargetsLevelIds(surfaceContext, protectedLevelIds)) continue;
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
   * Return whether at least one active tile explicitly restricts weather.
   *
   * @returns {boolean}
   */
  #hasActiveRestrictWeatherTiles() {
    for (const tile of canvas?.tiles?.placeables ?? []) {
      if (!tileDocumentRestrictsWeather(tile)) continue;
      if (this.#tileIsActiveOnCanvas(tile)) return true;
    }
    return false;
  }

  /**
   * Return a frame-local mask containing only the currently revealed portions of active Restricts Weather tiles.
   *
   * Core Restricts Weather is an under-tile suppressor, not a general above-tile FX blocker. Fully opaque tiles should behave like ordinary tiles for the current FX layer order. When a Restricts Weather tile is hover-faded, token-revealed, or otherwise transparent, this texture covers only the revealed pixels so particles and filters do not show through from underneath overhead overlays.
   *
   * @returns {PIXI.RenderTexture|null}
   */
  #getRestrictWeatherTilesMaskTexture() {
    if (this._weatherRestrictTilesFrameSerial === this._renderFrameSerial) {
      return this._weatherRestrictTilesFrameTexture ?? null;
    }

    const remember = (value) => {
      this._weatherRestrictTilesFrameSerial = this._renderFrameSerial;
      this._weatherRestrictTilesFrameTexture = value ?? null;
      return value ?? null;
    };

    if (!this._weatherRestrictTilesRT || !this.#hasActiveRestrictWeatherTiles()) return remember(null);

    try {
      repaintTilesMaskInto(this._weatherRestrictTilesRT, {
        mode: "weatherReveal",
        eraseUpperCoverage: false,
        shouldIncludeTile: (tile) => tileDocumentRestrictsWeather(tile) && this.#tileIsActiveOnCanvas(tile),
      });
      return remember(this._weatherRestrictTilesRT);
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

    const fallbackKind = managerKind === "filters" ? "particles" : "filters";
    try {
      const fallbackMasks = SceneMaskManager.instance.getMasks(fallbackKind) ?? null;
      const fallback = fallbackMasks?.[primaryKey] ?? fallbackMasks?.[fallbackKey] ?? null;
      if (valid(fallback)) return fallback;
    } catch (err) {
      logger.debug("FXMaster:", err);
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

    mask.texture = maskTexture;
    mask.position.set(0, 0);
    mask.scale.set(1, 1);
    mask.width = width;
    mask.height = height;
    mask.visible = true;
    mask.renderable = false;

    sprite.texture = source;
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
    for (const token of canvas?.tokens?.placeables ?? []) {
      if (!token?.visible || token?.document?.hidden) continue;
      if (token?.hasDynamicRing) return true;
    }
    return false;
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
    const parts = [
      `vp:${metrics.cssW}:${metrics.cssH}:${pivotX.toFixed(3)}:${pivotY.toFixed(3)}:${scaleX.toFixed(
        6,
      )}:${scaleY.toFixed(6)}`,
    ];

    if (includeTokens) {
      if (this.#hasVisibleDynamicRings()) return { key: null, forceRefresh: true };

      if (canvas?.level) {
        const levelDocs = this.#getSceneLevels();
        for (const level of levelDocs) {
          if (!level?.id) continue;
          parts.push(`lvl:${level.id}:${level.isView ? 1 : 0}:${level.isVisible ? 1 : 0}`);
        }
      }

      for (const token of canvas?.tokens?.placeables ?? []) {
        if (token?.document?.hidden) continue;
        const sceneMaskVisible = canvas?.level ? sceneMaskContainsTokenCenterForCompositor(token) : null;
        const revealedByHoveredUpperLevel = canvas?.level ? isTokenRevealedByHoveredUpperLevel(token) : false;
        const explicitlyRevealed = token?.controlled === true;
        const tokenElevation = token?.elevation ?? token?.document?.elevation ?? Number.NaN;
        const onCurrentLevel = canvas?.level
          ? isDocumentOnCurrentCanvasLevel(token?.document ?? null, tokenElevation)
          : false;
        const tokenIsVisible =
          token?.visible === true ||
          token?.isVisible === true ||
          token?.worldVisible === true ||
          token?.mesh?.worldVisible === true;
        if (
          !tokenIsVisible &&
          !(onCurrentLevel && (sceneMaskVisible === true || revealedByHoveredUpperLevel || explicitlyRevealed))
        )
          continue;

        const tokenId = token?.id ?? token?.document?.id ?? "";
        const mesh = token?.mesh ?? null;
        const transformId = mesh?.transform?._worldID ?? mesh?.worldTransform?._worldID ?? 0;
        const worldAlpha = Math.round((Number(mesh?.worldAlpha ?? token?.alpha ?? 1) || 0) * 1000);
        const bounds = token?.bounds ?? null;
        const bx = Number(bounds?.x ?? token?.x ?? 0) || 0;
        const by = Number(bounds?.y ?? token?.y ?? 0) || 0;
        const bw = Number(bounds?.width ?? token?.w ?? 0) || 0;
        const bh = Number(bounds?.height ?? token?.h ?? 0) || 0;
        const maskFlag = sceneMaskVisible === true ? 1 : sceneMaskVisible === false ? 0 : 2;
        const hoveredUpperLevelReveal = revealedByHoveredUpperLevel ? 1 : 0;
        const explicitlyVisible = explicitlyRevealed ? 1 : 0;
        parts.push(
          `tok:${tokenId}:${transformId}:${worldAlpha}:${bx.toFixed(2)}:${by.toFixed(2)}:${bw.toFixed(2)}:${bh.toFixed(
            2,
          )}:${token?.occluded ? 1 : 0}:${
            onCurrentLevel ? 1 : 0
          }:${maskFlag}:${hoveredUpperLevelReveal}:${explicitlyVisible}`,
        );
      }
    }

    if (includeTiles) {
      for (const tile of canvas?.tiles?.placeables ?? []) {
        if (!this.#tileIsActiveOnCanvas(tile)) continue;
        const tileId = tile?.id ?? tile?.document?.id ?? "";
        const mesh = tile?.mesh ?? null;
        const transformId = mesh?.transform?._worldID ?? mesh?.worldTransform?._worldID ?? 0;
        const hoverFade = mesh?._hoverFadeState ?? null;
        if (hoverFade?.fading) return { key: null, forceRefresh: true };
        const visibleAlpha = Math.round((Number(mesh?.worldAlpha ?? tile?.alpha ?? 1) || 0) * 1000);
        const fadeOcclusion = Math.round((Number(mesh?.fadeOcclusion ?? hoverFade?.occlusion ?? 0) || 0) * 1000);
        const bounds = tile?.bounds ?? null;
        const bx = Number(bounds?.x ?? tile?.x ?? 0) || 0;
        const by = Number(bounds?.y ?? tile?.y ?? 0) || 0;
        const bw = Number(bounds?.width ?? tile?.width ?? 0) || 0;
        const bh = Number(bounds?.height ?? tile?.height ?? 0) || 0;
        const occlusionMode = getTileOcclusionModes(tile?.document ?? tile ?? null);
        const restrictsWeather = tileDocumentRestrictsWeather(tile) ? 1 : 0;
        parts.push(
          `tile:${tileId}:${transformId}:${visibleAlpha}:${fadeOcclusion}:${bx.toFixed(2)}:${by.toFixed(
            2,
          )}:${bw.toFixed(2)}:${bh.toFixed(2)}:${tile?.occluded ? 1 : 0}:${
            hoverFade?.faded ? 1 : 0
          }:${restrictsWeather}:1:${String(occlusionMode)}`,
        );
      }
    }

    return { key: parts.join("|"), forceRefresh: false };
  }

  /**
   * Hide live scene-particle source containers while the compositor presents their
   * masked stack output.
   *
   * Registered particle slots are temporarily made renderable during
   * renderStackParticle, so keeping the source hidden between compositor frames
   * prevents the uncomposited full-scene emitter from leaking on V14 Levels.
   *
   * @param {Array<object>} rows
   * @param {boolean} enabled
   * @returns {void}
   */
  #syncCompositedSceneParticleSources(rows = [], enabled = true) {
    const uids = [];
    if (enabled && Array.isArray(rows)) {
      for (const row of rows) {
        if (row?.kind === "particle" && this.#getRowScope(row) === "scene" && row?.uid) uids.push(row.uid);
      }
    }

    try {
      canvas?.particleeffects?.setCompositedSceneParticleSources?.(uids);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  /**
   * Synchronize dynamic scene state before capturing the environment for compositor work.
   *
   * Hover-faded overhead tiles are driven by live primary-mesh state rather than document updates, so pending primary and perception refreshes are flushed and shared below-tile coverage masks are repainted on compositor frames that rely on them.
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
    const needsDynamicCoverage = needsDynamicTokenCoverage || needsDynamicTileCoverage;
    const needsRegionFilterCoverageRefresh = !!info.needsRegionFilterCoverageRefresh;
    const needsRegionParticleCoverageRefresh = !!info.needsRegionParticleCoverageRefresh;

    if (!needsDynamicCoverage) this._dynamicCoverageSignature = null;

    const requiresNativeLevelsPresync = !!canvas?.level && (needsDynamicTokenCoverage || needsDynamicTileCoverage);
    if (requiresNativeLevelsPresync) {
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

    const dynamicState = needsDynamicCoverage
      ? this.#buildDynamicCoverageSignature({
          includeTokens: needsDynamicTokenCoverage || needsDynamicTileCoverage,
          includeTiles: needsDynamicTokenCoverage || needsDynamicTileCoverage,
        })
      : { key: null, forceRefresh: false };

    const dynamicCoverageChanged = needsDynamicCoverage
      ? requiresNativeLevelsPresync || dynamicState.forceRefresh || dynamicState.key !== this._dynamicCoverageSignature
      : false;
    const needsLivePrimaryState = !requiresNativeLevelsPresync && dynamicCoverageChanged;

    if (needsLivePrimaryState) {
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

    if (dynamicCoverageChanged) {
      try {
        SceneMaskManager.instance.refreshTokensSync?.();
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

      this._dynamicCoverageSignature = dynamicState.key;
    }
  }

  /**
   * Collect ordered rows for the current compositor pass, including transient rows that remain visible during fade-out.
   *
   * @param {Scene|null|undefined} scene
   * @returns {Array<object>}
   */
  #collectRenderableRows(scene) {
    const rows = getOrderedEnabledEffectRenderRows(scene);
    const known = new Set();
    for (const row of rows) {
      if (row?.uid) known.add(row.uid);
    }

    const transientRows = [];
    const collectTransientRows = (sourceRows) => {
      for (const row of sourceRows ?? []) {
        if (row?.uid && !known.has(row.uid)) transientRows.push(row);
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

    if (!transientRows.length) return rows;
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
    if (!renderer || !sprite || !output) return;

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
      environment._recursivePostUpdateTransform?.();
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
      this._blitSprite.eventMode = "none";
      this._blitSprite.anchor.set(0, 0);
    }

    if (!this._filterSprite || this._filterSprite.destroyed) {
      this._filterSprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
      this._filterSprite.eventMode = "none";
      this._filterSprite.anchor.set(0, 0);
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
    const width = Math.max(1, cssW | 0);
    const height = Math.max(1, cssH | 0);
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
      this._regionUpperVisibleRT = PIXI.RenderTexture.create({ width, height, resolution });
      this.#configureRenderTexture(this._regionUpperVisibleRT);
    }

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

    if (needsResize(this._weatherRestrictTilesRT)) {
      try {
        this._weatherRestrictTilesRT?.destroy?.(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this._weatherRestrictTilesRT = PIXI.RenderTexture.create({ width, height, resolution });
      this.#configureRenderTexture(this._weatherRestrictTilesRT);
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
      this._rowSourceRT?.destroy?.(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      this._weatherRestrictTilesRT?.destroy?.(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      this._particleMaskScratchRT?.destroy?.(true);
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
    this._levelBlockerRT = null;
    this._selectedLevelSurfaceRT = null;
    this._selectedLevelForegroundRT = null;
    this._particleSelectedLevelMaskRT = null;
    this._rowSourceRT = null;
    this._weatherRestrictTilesRT = null;
    this._particleMaskScratchRT = null;
    this._particleSelectedLevelMaskFrameSerial = -1;
    this._particleSelectedLevelMaskFrameKey = null;
    this._particleSelectedLevelMaskFrameTexture = null;
  }
}
