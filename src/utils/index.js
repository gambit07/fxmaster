/**
 * FXMaster: Utilities - Barrel Export
 *
 * Re-exports every public symbol from the focused utility modules.
 *
 * Module breakdown:
 * - {@link module:compat}        - V13/V14+ flag operator abstraction
 * - {@link module:math}          - Numeric rounding, clamping, coercion
 * - {@link module:color}         - CSS variable resolution, color format conversion
 * - {@link module:viewport}      - Camera snapping, stage matrix, resolution safety
 * - {@link module:geometry}      - Region shape tracing, polygon edges, SDF helpers
 * - {@link module:masks}         - Render-texture masking pipeline
 * - {@link module:coalesce}      - Animation-frame call coalescing
 * - {@link module:scene-effects} - Scene-level effect toggling and UI highlights
 */

export {
  addDeletionKey,
  addReplacementKey,
  replacementUpdate,
  deletionUpdate,
  resetFlag,
  isLegacyOperatorKey,
  getForcedDeletionOperator,
  getForcedReplacementOperator,
  getCanvasLevel,
  getSceneLevels,
  resolveSingleSceneLevelSelection,
  normalizeSceneLevelSelection,
  ensureSingleSceneLevelSelection,
  getSceneForegroundElevation,
  getTileOcclusionModes,
  tileHasActiveOcclusion,
  isTileOverhead,
  getDocumentLevelsSet,
  inferVisibleLevelForDocument,
  isDocumentOnCurrentCanvasLevel,
  getSelectedSceneLevelIds,
  isEffectActiveForCurrentCanvasLevel,
  isEffectActiveForCurrentOrVisibleCanvasLevel,
  resolveDocumentOcclusionElevation,
  syncCanvasLiveLevelSurfaceState,
  getCanvasLiveLevelSurfaceRevealState,
  getCanvasLiveLevelSurfaceState,
  buildCanvasLiveLevelSurfaceSignature,
  isLiveLevelSurfaceRevealActive,
} from "./compat.js";

export {
  roundToDecimals,
  omit,
  pixelsArea,
  clampRange,
  clamp01,
  clampNonNeg,
  clampMin,
  num,
  asFloat3,
} from "./math.js";

export { getDialogColors, getCssVarValue, addAlphaToRgb } from "./color.js";

export {
  getSnappedCameraCss,
  snappedStageMatrix,
  currentWorldMatrix,
  currentRenderParentMatrix,
  cameraMatrixChanged,
  mat3FromPixi,
  ellipseSteps,
  getCssViewportMetrics,
  safeResolutionForCssArea,
  safeMaskResolutionForCssArea,
} from "./viewport.js";

export {
  TAU,
  rotatePoint,
  centroid,
  rectToPolygon,
  ellipseToPolygon,
  traceRegionShapePIXI,
  traceRegionShapePath2D,
  regionWorldBounds,
  regionWorldBoundsAligned,
  rectFromAligned,
  rectFromShapes,
  buildPolygonEdges,
  hasMultipleNonHoleShapes,
  edgeFadeWorldWidth,
  estimateShapeInradiusWorld,
  estimateRegionInradius,
  getEventGate,
  getRegionElevationWindow,
  inRangeElev,
} from "./geometry.js";

export {
  _belowTokensEnabled,
  _belowTilesEnabled,
  _belowForegroundEnabled,
  RTPool,
  releaseTokenSprites,
  releaseTileSprites,
  collectTokenAlphaSprites,
  collectTileAlphaSprites,
  stageLocalMatrixOf,
  tileDocumentRestrictsWeather,
  tileRestrictsWeatherForMask,
  isTokenRevealedByHoveredUpperLevel,
  composeMaskMinusTokens,
  composeMaskMinusTokensRT,
  composeMaskMinusTiles,
  composeMaskMinusTilesRT,
  composeMaskMinusCoverageRT,
  ensureCssSpaceMaskSprite,
  repaintTokensMaskInto,
  repaintTilesMaskInto,
  safeMaskTexture,
  buildRegionMaskRT,
  applyMaskSpriteTransform,
  computeRegionGatePass,
  buildSceneAllowMaskRT,
  clearSceneSuppressionSoftMaskCache,
  ensureBelowTokensArtifacts,
  applyMaskUniformsToFilters,
  subtractDynamicRingsFromRT,
  paintDynamicRingsInto,
} from "./masks.js";

export { clearCoalesceMap, coalesceNextFrame } from "./coalesce.js";

export {
  getSceneDarknessLevel,
  normalizeDarknessActivationRange,
  resolveDarknessActivationEnabled,
  isDarknessRangeActive,
  isEffectActiveForSceneDarkness,
} from "./darkness.js";

export {
  onSwitchParticleEffects,
  onUpdateParticleEffects,
  cleanupRegionFilterEffects,
  cleanupRegionParticleEffects,
  updateSceneControlHighlights,
} from "./scene-effects.js";
