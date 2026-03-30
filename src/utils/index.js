/**
 * FXMaster: Utilities - Barrel Export
 *
 * Re-exports every public symbol from the focused utility modules.
 *
 * Module breakdown:
 * - {@link module:compat}        - V12/V13/V14 flag operator abstraction
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
  RTPool,
  releaseTokenSprites,
  collectTokenAlphaSprites,
  stageLocalMatrixOf,
  composeMaskMinusTokens,
  composeMaskMinusTokensRT,
  ensureCssSpaceMaskSprite,
  repaintTokensMaskInto,
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
  onSwitchParticleEffects,
  onUpdateParticleEffects,
  cleanupRegionFilterEffects,
  cleanupRegionParticleEffects,
  parseSpecialEffects,
  updateSceneControlHighlights,
} from "./scene-effects.js";
