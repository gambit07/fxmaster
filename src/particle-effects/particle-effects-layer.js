/**
 * ParticleEffectsLayer
 * --------------------
 * Builds and maintains scene-scoped and region-scoped particle runtimes for FXMaster.
 * - Preserves suppression masks, token cutouts, and region mask state.
 * - Registers renderable particle slots for the global compositor stack.
 */
import { packageId } from "../constants.js";
import { isEnabled } from "../settings.js";
import {
  safeMaskTexture,
  buildRegionMaskRT,
  _belowTokensEnabled,
  _belowTilesEnabled,
  _belowForegroundEnabled,
  applyMaskSpriteTransform,
  computeRegionGatePass,
  coalesceNextFrame,
  getCssViewportMetrics,
  getSnappedCameraCss,
  snappedStageMatrix,
  currentRenderParentMatrix,
  cameraMatrixChanged,
  composeMaskMinusTokens,
  composeMaskMinusTokensRT,
  composeMaskMinusTiles,
  composeMaskMinusTilesRT,
  composeMaskMinusCoverageRT,
  estimateRegionInradius,
  regionWorldBounds,
  getSceneDarknessLevel,
  isEffectActiveForSceneDarkness,
  isEffectActiveForCurrentOrVisibleCanvasLevel,
  normalizeSceneLevelSelection,
  resolveDocumentOcclusionElevation,
  getCanvasLiveLevelSurfaceState,
  getDocumentLevelsSet,
  isTileOverhead,
  tileHasActiveOcclusion,
  tileDocumentRestrictsWeather,
} from "../utils.js";
import { refreshSceneParticlesSuppressionMasks } from "./particle-effects-scene-manager.js";
import { BaseEffectsLayer } from "../common/base-effects-layer.js";
import { logger } from "../logger.js";
import {
  buildSceneEffectUid,
  buildRegionEffectUid,
  getOrderedEnabledEffectRenderRows,
} from "../common/effect-stack.js";
import { SceneMaskManager } from "../common/base-effects-scene-manager.js";
import { fxmForEachEmitterParticle } from "./effects/effect.js";

const TYPE = `${packageId}.particleEffectsRegion`;

/**
 * Return whether native weather occlusion filters can be used for stack-pass particle rendering.
 *
 * @returns {boolean}
 */
function canUseNativeWeatherOcclusionStackPass() {
  return Number(globalThis.game?.release?.generation ?? 0) >= 14;
}

/**
 * Foundry V13's stack pass can expose the local white scene-clip mask when a bare scene slot is rendered directly. V14 does not exhibit that leak and can keep the direct path that avoids simple-scene pan drift.
 */
function canUseDirectSceneParticleSlotRender() {
  return Number(globalThis.game?.release?.generation ?? 0) >= 14;
}

/**
 * Build a region-scoped particle context so region effects use region bounds rather than scene bounds.
 *
 * @param {PlaceableObject} placeable
 * @returns {{dimensions: object, renderer: PIXI.Renderer|null, ticker: PIXI.Ticker|null}|null}
 */
function buildRegionParticleContext(placeable) {
  const bounds = regionWorldBounds(placeable);
  if (!bounds) return null;

  const minX = Number(bounds.minX);
  const minY = Number(bounds.minY);
  const maxX = Number(bounds.maxX);
  const maxY = Number(bounds.maxY);
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;

  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const size = Number(canvas?.dimensions?.size) || 100;

  return {
    dimensions: {
      width,
      height,
      size,
      sceneX: minX,
      sceneY: minY,
      sceneWidth: width,
      sceneHeight: height,
      sceneRect: new PIXI.Rectangle(minX, minY, width, height),
    },
    renderer: canvas?.app?.renderer ?? null,
    ticker: canvas?.app?.ticker ?? PIXI?.Ticker?.shared ?? null,
  };
}

/**
 * Normalize a region behavior collection or array into an array of behavior documents.
 *
 * @param {Iterable<foundry.documents.RegionBehavior>|foundry.documents.RegionBehavior[]|null|undefined} behaviorDocs
 * @returns {foundry.documents.RegionBehavior[]}
 * @private
 */
function normalizeRegionBehaviorDocs(behaviorDocs) {
  if (!behaviorDocs) return [];
  if (Array.isArray(behaviorDocs)) return behaviorDocs;
  if (Array.isArray(behaviorDocs.contents)) return behaviorDocs.contents;
  if (typeof behaviorDocs.toArray === "function") return behaviorDocs.toArray();
  if (typeof behaviorDocs.values === "function") return Array.from(behaviorDocs.values());
  return Array.from(behaviorDocs);
}

/**
 * Interpret a below-tokens flag or parameter consistently.
 *
 * @param {*} value
 * @returns {boolean}
 */
function particleBelowTokensEnabled(value) {
  return _belowTokensEnabled(value);
}

/**
 * Interpret a below-tiles flag or parameter consistently.
 *
 * @param {*} value
 * @returns {boolean}
 */
function particleBelowTilesEnabled(value) {
  return _belowTilesEnabled(value);
}

/**
 * Determine whether a particle requests below-foreground rendering.
 *
 * @param {*} value
 * @returns {boolean}
 */
function particleBelowForegroundEnabled(value) {
  return _belowForegroundEnabled(value);
}

/**
 * Resolve the occlusion elevation used for a particle runtime.
 *
 * @param {{ belowForeground?: boolean }|null|undefined} entry
 * @param {number} fallbackElevation
 * @returns {number}
 */
function resolveParticleOcclusionElevation(entry, fallbackElevation) {
  const fallback = Number.isFinite(fallbackElevation) ? fallbackElevation : Infinity;
  const regionDocument = entry?.regionId ? canvas?.regions?.get(entry.regionId)?.document ?? null : null;
  return resolveDocumentOcclusionElevation(regionDocument, {
    fallback,
    preferForeground: particleBelowForegroundEnabled(entry?.belowForeground),
  });
}

/**
 * Select the appropriate mask texture from a shared mask bundle.
 *
 * @param {{base?: PIXI.RenderTexture|null, cutoutTokens?: PIXI.RenderTexture|null, cutoutTiles?: PIXI.RenderTexture|null, cutoutCombined?: PIXI.RenderTexture|null}|null|undefined} bundle
 * @param {boolean} belowTokens
 * @param {boolean} belowTiles
 * @returns {PIXI.RenderTexture|null}
 */
function chooseParticleMaskTexture(bundle, belowTokens, belowTiles) {
  if (!bundle) return null;
  if (belowTokens && belowTiles)
    return bundle.cutoutCombined || bundle.cutoutTokens || bundle.cutoutTiles || bundle.base || null;
  if (belowTokens) return bundle.cutoutTokens || bundle.cutoutCombined || bundle.base || null;
  if (belowTiles) return bundle.cutoutTiles || bundle.cutoutCombined || bundle.base || null;
  return bundle.base || null;
}

/**
 * Keep a DisplayObject usable as a PIXI mask without letting its white mask texture render as normal scene content.
 *
 * In V13 the scene-particle soft transition can temporarily render the wrapper container directly while a belowTokens mask has just been attached. If the mask sprite remains renderable, its full-scene white allow-mask is drawn before the particle fade completes. PIXI masks should remain visible for mask evaluation, but non-renderable so they never contribute color.
 *
 * @param {PIXI.DisplayObject|null|undefined} maskObject
 * @returns {void}
 */
function suppressVisibleMaskPaint(maskObject) {
  if (!maskObject || maskObject.destroyed) return;
  try {
    maskObject.visible = true;
    maskObject.renderable = false;
    maskObject.alpha = 1;
  } catch (err) {
    logger.debug("FXMaster:", err);
  }
}

/**
 * Destroy a particle mask sprite after removing it from any wrapper container.
 *
 * @param {PIXI.Sprite|null|undefined} maskSprite
 * @param {PIXI.Container|null|undefined} [container]
 * @returns {void}
 */
function destroyParticleMaskSprite(maskSprite, container = null) {
  try {
    if (container && container.mask === maskSprite) container.mask = null;
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  if (!maskSprite || maskSprite.destroyed) return;

  try {
    maskSprite.parent?.removeChild?.(maskSprite);
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  try {
    maskSprite.mask = null;
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  try {
    maskSprite.texture = safeMaskTexture(maskSprite.texture);
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  try {
    const texture = maskSprite.texture ?? maskSprite._texture ?? null;
    if (!texture || typeof texture.off !== "function") return;
    maskSprite.destroy({ texture: false, baseTexture: false });
  } catch (err) {
    logger.debug("FXMaster:", err);
  }
}

const PARTICLE_RUNTIME_ROUTING_OPTION_KEYS = new Set(["belowTokens", "belowTiles", "belowForeground", "levels"]);

function particleRoutingComparableValue(value) {
  const raw =
    value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "value") ? value.value : value;
  if (Array.isArray(raw)) return raw.map((v) => String(v)).sort();
  if (raw && typeof raw === "object") {
    const out = {};
    for (const key of Object.keys(raw).sort()) out[key] = particleRoutingComparableValue(raw[key]);
    return out;
  }
  return raw;
}

function particleRoutingStableString(value) {
  try {
    return JSON.stringify(particleRoutingComparableValue(value));
  } catch (_err) {
    return String(value);
  }
}

/**
 * Return true when a scene-particle config edit only changes FXMaster's
 * compositor routing/masking options. These options do not require replacing
 * the particle emitter. Rebuilding and crossfading the runtime for a pure
 * belowTokens/belowTiles/belowForeground/levels edit can expose the V13
 * full-scene allow-mask for one or more frames while mask refresh is catching
 * up. Moving the existing runtime in-place is both cheaper and avoids that
 * white-mask transition.
 *
 * @param {object|null|undefined} previous
 * @param {object|null|undefined} next
 * @returns {boolean}
 */
function particleOptionsChangedOnlyRuntimeRouting(previous, next) {
  const prev = previous && typeof previous === "object" ? previous : {};
  const cur = next && typeof next === "object" ? next : {};
  const keys = new Set([...Object.keys(prev), ...Object.keys(cur)]);
  let sawRoutingChange = false;

  for (const key of keys) {
    const before = particleRoutingStableString(prev[key]);
    const after = particleRoutingStableString(cur[key]);
    if (before === after) continue;
    if (!PARTICLE_RUNTIME_ROUTING_OPTION_KEYS.has(key)) return false;
    sawRoutingChange = true;
  }

  return sawRoutingChange;
}

export class ParticleEffectsLayer extends BaseEffectsLayer {
  static get layerOptions() {
    return foundry.utils.mergeObject(super.layerOptions, { name: "particle-effects" });
  }

  constructor() {
    super();
    this.#initializeInverseOcclusionFilter();
    this.mask = canvas.masks.scene;

    this.particleEffects = new Map();
    this.regionEffects = new Map();
    this.stackEntries = new Map();
    this._stackRoots = new Map();
    this._transientStackRows = new Map();
    this._lastKnownOrder = new Map();
    this._regionMaskRTs = new Map();
    this._regionBelowTokensNeeded = false;
    this._regionBelowTilesNeeded = false;
    this._sceneMaskBundle = { base: null, cutoutTokens: null, cutoutTiles: null, cutoutCombined: null };

    this._belowContainer = null;
    this._aboveContent = null;

    this._sceneBelowBase = null;
    this._sceneBelowCutout = null;
    this._sceneAboveBase = null;
    this._sceneAboveCutout = null;

    this._sceneBelowBaseMask = null;
    this._sceneBelowCutoutMask = null;
    this._sceneAboveBaseMask = null;
    this._sceneAboveCutoutMask = null;

    this._scratchGfx = null;
    this._aboveMaskGfx = null;
    this._dyingSceneEffects = new Set();
    this._lastViewSize = { w: canvas.app.renderer.view?.width | 0, h: canvas.app.renderer.view?.height | 0 };
    this._gatePassCache = new Map();
    this._weatherOcclusionTilePresence = { key: null, value: false };

    this._lastSceneMaskMatrix = null;
    this._currentCameraMatrix = null;
    this._lastSceneSuppressionOverlaySignature = "";
    this._compositedSceneParticleSourceUidsKey = null;

    this._lastRegionMaskMatrix = null;

    this._tokensDirty = false;
    this._lastCutoutCamFrac = null;

    this._coalescedSceneSuppressionRefresh = null;
    this._lastSceneDarknessSignature = "";
    this._lastRegionDarknessSignatures = new Map();
    this._lastDarknessLevel = getSceneDarknessLevel();
    this.renderable = false;
  }

  /**
   * Register a renderable particle slot for the global compositor.
   *
   * @param {string} uid
   * @param {PIXI.Container} root
   * @param {PIXI.DisplayObject} slot
   * @param {object} [data]
   * @returns {void}
   */
  _registerStackSlot(uid, root, slot, data = {}) {
    if (!uid || !root || !slot) return;
    this._unregisterStackSlot(uid);

    let slots = this._stackRoots.get(root);
    if (!slots) {
      slots = new Set();
      this._stackRoots.set(root, slots);
    }
    slots.add(slot);

    this.stackEntries.set(uid, { uid, root, slot, ...data });
    this._compositedSceneParticleSourceUidsKey = null;
  }

  /**
   * Toggle whether a scene-particle source container should be hidden from the
   * live canvas because it is being presented by the global stack compositor.
   *
   * The compositor temporarily restores renderability while rendering the
   * registered slot into an off-screen texture, then restores this suppressed
   * state. Keeping the source slot hidden between compositor frames prevents the
   * uncomposited scene-wide emitter from leaking through native V14 Level views.
   *
   * @param {PIXI.DisplayObject|null|undefined} slot
   * @param {boolean} suppressed
   * @returns {void}
   */
  _setSceneParticleSourceSuppressed(slot, suppressed) {
    if (!slot || slot.destroyed) return;

    try {
      slot.__fxmCompositorSourceSuppressed = !!suppressed;
      slot.visible = true;
      slot.renderable = !suppressed;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  /**
   * Hide or reveal scene-particle source slots that are currently rendered
   * through the global FX stack compositor.
   *
   * @param {string[]|Set<string>} [uids=[]]
   * @returns {void}
   */
  setCompositedSceneParticleSources(uids = []) {
    const wanted = uids instanceof Set ? uids : new Set(Array.isArray(uids) ? uids.filter(Boolean) : []);
    const key = Array.from(wanted).sort().join("|");
    if (key === this._compositedSceneParticleSourceUidsKey) return;
    this._compositedSceneParticleSourceUidsKey = key;

    for (const entry of this.stackEntries.values()) {
      if (entry?.scope !== "scene") continue;
      const slot = entry?.slot ?? entry?.container ?? null;
      this._setSceneParticleSourceSuppressed(slot, wanted.has(entry.uid));
    }
  }

  /**
   * Remove a compositor slot registration.
   *
   * @param {string} uid
   * @returns {void}
   */
  _unregisterStackSlot(uid) {
    const entry = this.stackEntries.get(uid);
    if (!entry) return;

    if (entry?.scope === "scene") {
      this._setSceneParticleSourceSuppressed(entry?.slot ?? entry?.container ?? null, false);
    }

    const slots = this._stackRoots.get(entry.root);
    if (slots) {
      slots.delete(entry.slot);
      if (!slots.size) this._stackRoots.delete(entry.root);
    }

    this.stackEntries.delete(uid);
    this._compositedSceneParticleSourceUidsKey = null;
  }

  /**
   * Return the runtime particle registration for a stored stack uid.
   *
   * @param {string} uid
   * @returns {object|null}
   */
  getStackParticleRuntime(uid) {
    return this.stackEntries.get(uid) ?? null;
  }

  /**
   * Return transient scene-particle stack rows that should continue rendering while a prior runtime fades out.
   *
   * @returns {Array<{ uid: string, kind: "particle", scope: "scene", renderIndex: number, options?: object|null, levels?: unknown }>}
   */
  getTransientStackRows() {
    return Array.from(this._transientStackRows.values(), ({ uid, kind, scope, renderIndex, options, levels }) => ({
      uid,
      kind,
      scope: scope ?? "scene",
      renderIndex,
      options,
      levels,
    }));
  }

  /**
   * Cache the current scene particle ordering so transient fade-out rows can be reinserted at the correct compositor index.
   *
   * @returns {void}
   */
  _syncSceneStackOrderCache() {
    this._lastKnownOrder.clear();
    const orderedRows = getOrderedEnabledEffectRenderRows(canvas.scene);
    for (let index = 0; index < orderedRows.length; index++) {
      const uid = orderedRows[index]?.uid;
      if (!uid.startsWith("scene:particle:")) continue;
      this._lastKnownOrder.set(uid, index);
    }
  }

  /**
   * Re-register a scene runtime under a transient UID so it can continue rendering during fade-out.
   *
   * @param {string} runtimeUid
   * @returns {string|null}
   */
  _promoteSceneRuntimeToTransient(runtimeUid) {
    const entry = this.stackEntries.get(runtimeUid);
    if (!entry?.root || !entry?.slot) {
      this._unregisterStackSlot(runtimeUid);
      return null;
    }

    const renderIndex = this._lastKnownOrder.get(runtimeUid) ?? Number.MAX_SAFE_INTEGER;
    const transientUid = `${runtimeUid}::transient:${foundry.utils.randomID()}`;
    const { uid: _ignored, root, slot, ...data } = entry;
    this._unregisterStackSlot(runtimeUid);
    this._registerStackSlot(transientUid, root, slot, data);
    this._transientStackRows.set(transientUid, {
      uid: transientUid,
      kind: "particle",
      scope: "scene",
      renderIndex,
      options: data?.options ?? null,
      levels: data?.levels ?? data?.options?.levels ?? null,
    });
    return transientUid;
  }

  /**
   * Remove a transient scene-particle row once fade-out has completed.
   *
   * @param {string|null|undefined} uid
   * @returns {void}
   */
  _clearTransientSceneRow(uid) {
    if (!uid) return;
    this._transientStackRows.delete(uid);
    this._unregisterStackSlot(uid);
  }

  /**
   * Render a single particle stack slot into the supplied render texture.
   *
   * @param {string} uid
   * @param {PIXI.RenderTexture} renderTexture
   * @param {{ clear?: boolean, respectBelowTilesMask?: boolean, respectNativeOcclusion?: boolean, maskTextureOverride?: PIXI.Texture|PIXI.RenderTexture|null }} [options]
   * @returns {boolean}
   */
  renderStackParticle(
    uid,
    renderTexture,
    { clear = false, respectBelowTilesMask = true, respectNativeOcclusion = true, maskTextureOverride = null } = {},
  ) {
    const entry = this.stackEntries.get(uid);
    const renderer = canvas?.app?.renderer;
    if (!entry || !renderer || !renderTexture) return false;

    const { root, slot } = entry;
    if (!root || root.destroyed || !slot || slot.destroyed) return false;

    if (entry?.regionId) {
      const fx = entry?.fx ?? null;
      const container = entry?.container ?? slot;
      if (fx?.destroyed || fx?._destroyed) return false;
      if (fx && "enabled" in fx && fx.enabled === false) return false;
      if (container?.visible === false || container?.renderable === false) return false;
    }

    const slots = this._stackRoots.get(root);
    if (!slots?.size) return false;

    if (entry?.regionId) {
      this._applyRegionMaskForEntry(entry);
    } else {
      const sceneMaskEntry = respectBelowTilesMask || !entry?.belowTiles ? entry : { ...entry, belowTiles: false };
      this._applySceneMaskForEntry(root, { ...sceneMaskEntry, maskTextureOverride });
    }

    const previous = [];
    for (const candidate of slots) {
      if (!candidate || candidate.destroyed) continue;
      previous.push([candidate, candidate.visible, candidate.renderable]);
      const show = candidate === slot;
      candidate.visible = show;
      candidate.renderable = show;
    }

    const rootOcclusionFilter =
      root === this._belowContainer ? this._belowOccl : root === this._aboveContent ? this._aboveOccl : null;
    const priorRootOcclusionEnabled = rootOcclusionFilter ? !!rootOcclusionFilter.enabled : null;
    const canUseNativeWeatherOcclusion = canUseNativeWeatherOcclusionStackPass();
    const needsSceneWeatherTileCheck =
      canUseNativeWeatherOcclusion &&
      !entry?.regionId &&
      !!respectNativeOcclusion &&
      !entry?.belowForeground &&
      !entry?.belowTiles;
    const sceneHasWeatherOcclusionTiles = needsSceneWeatherTileCheck ? this._sceneHasWeatherOcclusionTiles() : false;

    /**
     * Plain scene particles can render directly from their dedicated scene slot when no native weather-occluding roof surfaces are involved. In V13 that direct slot path can leak its local scene clip, so only V14+ keeps the optimization.
     */
    const wantsNativeWeatherOcclusion =
      canUseNativeWeatherOcclusion &&
      !!respectNativeOcclusion &&
      (entry?.regionId
        ? !entry?.belowTiles || !!entry?.belowForeground
        : !!entry?.belowForeground || (!entry?.belowTiles && sceneHasWeatherOcclusionTiles));
    const hasMaskTextureOverride =
      !!maskTextureOverride && maskTextureOverride !== PIXI.Texture.EMPTY && !maskTextureOverride.destroyed;
    const useDirectSceneSlotRender =
      canUseDirectSceneParticleSlotRender() &&
      !hasMaskTextureOverride &&
      !entry?.regionId &&
      !entry?.belowTokens &&
      !entry?.belowTiles &&
      !entry?.belowForeground &&
      !wantsNativeWeatherOcclusion;

    let hasNativeCanvasLevel = false;
    try {
      hasNativeCanvasLevel = !!canvas?.level?.id;
    } catch (_err) {
      hasNativeCanvasLevel = false;
    }
    const useLocalSceneClip = useDirectSceneSlotRender && !hasNativeCanvasLevel;

    const stackSceneClipMask = slot instanceof PIXI.Container ? slot.__fxmStackSceneClipMask ?? null : null;
    if (stackSceneClipMask && !stackSceneClipMask.destroyed) {
      try {
        stackSceneClipMask.visible = true;
        stackSceneClipMask.renderable = false;
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    if (rootOcclusionFilter) {
      try {
        rootOcclusionFilter.enabled = wantsNativeWeatherOcclusion;
        rootOcclusionFilter.elevation = resolveParticleOcclusionElevation(entry, this.#elevation);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    const activeMaskSprite = entry?.maskSprite ?? null;
    if (activeMaskSprite && !activeMaskSprite.destroyed) suppressVisibleMaskPaint(activeMaskSprite);
    let priorLocalSceneMask = null;
    let appliedLocalSceneClip = false;

    if (useLocalSceneClip && slot instanceof PIXI.Container) {
      const sceneClip = this._ensureSceneStackClipMask(slot);
      if (sceneClip && !sceneClip.destroyed) {
        priorLocalSceneMask = slot.mask ?? null;
        if (!priorLocalSceneMask) {
          try {
            slot.mask = sceneClip;
            appliedLocalSceneClip = true;
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
        }
      }
    }

    const renderSubject = useDirectSceneSlotRender ? slot : root;

    const priorRootVisible = root.visible;
    const priorRootRenderable = root.renderable;
    root.visible = true;
    root.renderable = true;

    let renderWithLiveWorldTransform = false;
    try {
      renderSubject._recursivePostUpdateTransform?.();
      renderSubject.updateTransform?.();
      renderWithLiveWorldTransform = true;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    let parentTransform = null;
    if (!renderWithLiveWorldTransform) {
      try {
        parentTransform = currentRenderParentMatrix(renderSubject);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    try {
      renderer.render(renderSubject, {
        renderTexture,
        clear,
        ...(renderWithLiveWorldTransform ? {} : { transform: parentTransform }),
        skipUpdateTransform: !renderWithLiveWorldTransform ? false : true,
      });
      return true;
    } finally {
      if (rootOcclusionFilter) {
        try {
          rootOcclusionFilter.enabled = !!priorRootOcclusionEnabled;
          rootOcclusionFilter.elevation = this.#elevation;
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }
      const maskSprite = entry?.maskSprite ?? null;
      if (maskSprite && !maskSprite.destroyed) suppressVisibleMaskPaint(maskSprite);
      if (stackSceneClipMask && !stackSceneClipMask.destroyed) {
        try {
          stackSceneClipMask.visible = true;
          stackSceneClipMask.renderable = false;
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }
      if (appliedLocalSceneClip && slot instanceof PIXI.Container && !slot.destroyed) {
        try {
          slot.mask = priorLocalSceneMask ?? null;
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }
      root.visible = priorRootVisible;
      root.renderable = priorRootRenderable;
      for (const [candidate, visible, renderable] of previous) {
        if (!candidate || candidate.destroyed) continue;
        candidate.visible = visible;
        candidate.renderable = renderable;
      }
    }
  }

  occlusionFilter;

  get elevation() {
    return this.#elevation;
  }
  set elevation(value) {
    if (typeof value !== "number" || Number.isNaN(value))
      throw new Error("ParticleEffectsLayer#elevation must be numeric.");
    if (value === this.#elevation) return;
    this.#elevation = value;
    try {
      if (this.occlusionFilter) this.occlusionFilter.elevation = value;
      if (this._belowOccl) this._belowOccl.elevation = value;
      if (this._aboveOccl) this._aboveOccl.elevation = value;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    if (this.parent) this.parent.sortDirty = true;
  }
  #elevation = Infinity;

  async _draw() {
    if (!isEnabled()) return;
    await this.drawParticleEffects();
    if (!this._ticker) {
      const PRIO = PIXI.UPDATE_PRIORITY?.HIGH ?? 25;
      try {
        canvas.app.ticker.add(this._animate, this, PRIO);
      } catch {
        canvas.app.ticker.add(this._animate, this);
      }
      this._ticker = true;
    }
  }

  async _tearDown() {
    if (this.requestRegionMaskRefreshAll?.cancel) this.requestRegionMaskRefreshAll.cancel();
    if (this.requestRegionMaskRefresh?.cancel) this.requestRegionMaskRefresh.cancel();
    if (this._coalescedSceneSuppressionRefresh?.cancel) this._coalescedSceneSuppressionRefresh.cancel();

    this.#destroyEffects();

    try {
      this._scratchGfx?.destroy(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    this._scratchGfx = null;

    /** Cleanup of above-band scene container and mask bindings. */
    try {
      if (this._aboveContent?.mask) this._aboveContent.mask = null;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      this._aboveContent?.destroy({ children: true });
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    this._aboveContent = null;

    /** Cleanup of below-band scene container. */
    try {
      this._belowContainer?.destroy({ children: true });
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    this._belowContainer = null;

    /** Clear strong references to scene buckets and their mask sprites. */
    this._sceneBelowBase = null;
    this._sceneBelowCutout = null;
    this._sceneAboveBase = null;
    this._sceneAboveCutout = null;
    this._sceneBelowBaseMask = null;
    this._sceneBelowCutoutMask = null;
    this._sceneAboveBaseMask = null;
    this._sceneAboveCutoutMask = null;

    try {
      this._aboveMaskGfx?.destroy(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    this._aboveMaskGfx = null;

    try {
      this.filters = [];
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    this._belowOccl = null;
    this._aboveOccl = null;

    this._tokensDirty = false;
    this._lastSceneMaskMatrix = null;
    this._currentCameraMatrix = null;
    this._lastSceneSuppressionOverlaySignature = "";
    this._lastRegionMaskMatrix = null;
    this._weatherOcclusionTilePresence = { key: null, value: false };

    return super._tearDown();
  }

  #destroyEffects() {
    /** Destroy all scene-level particle effects. */
    for (const fx of this.particleEffects.values()) {
      try {
        fx.stop?.();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      try {
        fx.destroy?.();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      try {
        this._destroySceneParticleContainer(fx);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
    this.particleEffects.clear();

    for (const fx of this._dyingSceneEffects) {
      try {
        fx.stop?.();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      try {
        fx.destroy?.();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      try {
        this._destroySceneParticleContainer(fx);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
    this._dyingSceneEffects.clear();
    this.setCompositedSceneParticleSources([]);
    this.stackEntries.clear();
    this._stackRoots.clear();
    this._transientStackRows.clear();
    this._lastKnownOrder.clear();

    /** Destroy all region-level particle effects and associated mask sprites. */
    for (const entries of this.regionEffects.values()) {
      for (const entry of entries) {
        if (entry?.uid) this._unregisterStackSlot(entry.uid);
        const fx = entry?.fx ?? null;
        const container = entry?.container ?? null;
        const maskSprite = entry?.maskSprite ?? null;

        try {
          fx?.stop?.();
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        try {
          fx?.destroy?.();
        } catch (err) {
          logger.debug("FXMaster:", err);
        }

        try {
          if (container && maskSprite && container.mask === maskSprite) container.mask = null;
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        destroyParticleMaskSprite(maskSprite, container);

        try {
          container?.destroy?.({ children: true, texture: false, baseTexture: false });
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }
    }
    this.regionEffects.clear();

    try {
      for (const rtPair of this._regionMaskRTs.values()) {
        try {
          this._releaseRT(rtPair.base);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        try {
          this._releaseRT(rtPair.cutoutTokens);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        try {
          this._releaseRT(rtPair.cutoutTiles);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        try {
          this._releaseRT(rtPair.cutoutCombined);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    this._regionMaskRTs.clear?.();
  }

  /**
   * Notify the layer that token silhouettes changed (movement, resize, visibility, etc).
   * - For scene FX: scene manager can use this to refresh cutout RT.
   * - For region FX: cheaply recompose cutout (base - tokens) without rebuilding base.
   */
  notifyTokensChanged() {
    this._tokensDirty = true;
  }

  /**
   * Determine whether any active particle runtime requires shared below-object coverage masks.
   *
   * @returns {{ anyBelowTokens: boolean, anyBelowTiles: boolean }}
   */
  _collectBelowObjectCoverageNeeds() {
    let anyBelowTokens = false;
    let anyBelowTiles = false;

    const inspect = (fx) => {
      if (!fx) return false;
      if (fx.__fxmBelowTokens) anyBelowTokens = true;
      if (fx.__fxmBelowTiles) anyBelowTiles = true;
      return anyBelowTokens && anyBelowTiles;
    };

    try {
      for (const fx of this.particleEffects.values()) {
        if (inspect(fx)) break;
      }

      if (!(anyBelowTokens && anyBelowTiles)) {
        for (const fx of this._dyingSceneEffects) {
          if (inspect(fx)) break;
        }
      }

      if (!(anyBelowTokens && anyBelowTiles)) {
        for (const entries of this.regionEffects.values()) {
          for (const entry of entries ?? []) {
            if (inspect(entry?.fx ?? entry)) break;
          }
          if (anyBelowTokens && anyBelowTiles) break;
        }
      }
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    return { anyBelowTokens, anyBelowTiles };
  }

  /**
   * Refresh shared token and tile coverage masks when camera motion changes their screen-space projection.
   *
   * @returns {void}
   */
  _refreshBelowObjectCoverageForCamera() {
    const { anyBelowTokens, anyBelowTiles } = this._collectBelowObjectCoverageNeeds();
    if (!anyBelowTokens && !anyBelowTiles) {
      this._lastCutoutCamFrac = null;
      return;
    }

    const renderer = canvas?.app?.renderer;
    const resolution = renderer?.resolution || 1;
    const { txCss, tyCss } = getSnappedCameraCss();
    const fx = (((txCss * resolution) % 1) + 1) % 1;
    const fy = (((tyCss * resolution) % 1) + 1) % 1;

    const previous = this._lastCutoutCamFrac;
    const SUB_PIXEL_THRESHOLD = 0.01;
    const fracMoved =
      !previous || Math.abs(previous.x - fx) > SUB_PIXEL_THRESHOLD || Math.abs(previous.y - fy) > SUB_PIXEL_THRESHOLD;

    if (!fracMoved) return;

    try {
      SceneMaskManager.instance.refreshTokensSync?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    this._tokensDirty = true;
    this._lastCutoutCamFrac = { x: fx, y: fy };
  }

  /**
   * Recompute whether any region-scoped particle effects require below-tokens or below-tiles cutouts.
   *
   * @private
   */
  _updateRegionBelowTokensNeeded() {
    let anyBelowTokens = false;
    let anyBelowTiles = false;
    try {
      for (const entries of this.regionEffects.values()) {
        for (const entry of entries ?? []) {
          const fx = entry?.fx ?? entry;
          if (fx?.__fxmBelowTokens) anyBelowTokens = true;
          if (fx?.__fxmBelowTiles) anyBelowTiles = true;
          if (anyBelowTokens && anyBelowTiles) break;
        }
        if (anyBelowTokens && anyBelowTiles) break;
      }
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    const changedTokens = this._regionBelowTokensNeeded !== anyBelowTokens;
    const changedTiles = this._regionBelowTilesNeeded !== anyBelowTiles;
    this._regionBelowTokensNeeded = anyBelowTokens;
    this._regionBelowTilesNeeded = anyBelowTiles;

    if (!changedTokens && !changedTiles) return;

    try {
      SceneMaskManager.instance.setBelowTokensNeeded?.("particles", anyBelowTokens, "regions");
      SceneMaskManager.instance.setBelowTilesNeeded?.("particles", anyBelowTiles, "regions");
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }
  /**
   * Return the scene particle bucket that should own a scene runtime container.
   *
   * @param {string} layerLevel
   * @param {boolean} belowTokens
   * @returns {PIXI.Container|null}
   */
  _getSceneParticleBucket(layerLevel = "belowDarkness", belowTokens = false) {
    if (layerLevel === "aboveDarkness") return belowTokens ? this._sceneAboveCutout : this._sceneAboveBase;
    return belowTokens ? this._sceneBelowCutout : this._sceneBelowBase;
  }

  /**
   * Apply the current scene mask bundle to a dedicated scene runtime container.
   *
   * @param {PIXI.Container|null} container
   * @param {PIXI.Sprite|null} sprite
   * @param {{ belowTokens?: boolean, belowTiles?: boolean, maskTextureOverride?: PIXI.Texture|PIXI.RenderTexture|null }} [entry]
   * @returns {void}
   */
  _applySceneMaskToContainer(container, sprite, entry = {}) {
    if (!container || container.destroyed || !sprite || sprite.destroyed) return;
    suppressVisibleMaskPaint(sprite);

    const belowTokens = !!entry?.belowTokens;
    const belowTiles = !!entry?.belowTiles;
    const texture =
      entry?.maskTextureOverride ?? chooseParticleMaskTexture(this._sceneMaskBundle, belowTokens, belowTiles);

    sprite.texture = texture ? safeMaskTexture(texture) : PIXI.Texture.EMPTY;
    sprite._fxmMaskEnabled = !!texture;

    if (!texture) {
      if (container.mask === sprite) {
        try {
          container.mask = null;
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }
      return;
    }

    const { cssW, cssH } = getCssViewportMetrics();
    try {
      sprite.width = cssW;
      sprite.height = cssH;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    try {
      applyMaskSpriteTransform(container, sprite);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    if (container.mask !== sprite) {
      try {
        container.mask = sprite;
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
  }

  /**
   * Ensure a reusable world-space scene clip mask exists for plain scene-particle stack rendering.
   *
   * This avoids relying on the compositor's screen-space base scene mask for the simplest scene-particle case, which can visibly drift against live camera motion while panning.
   *
   * @param {PIXI.Container|null} container
   * @returns {PIXI.Graphics|null}
   */
  _ensureSceneStackClipMask(container) {
    if (!container || container.destroyed) return null;

    let gfx = container.__fxmStackSceneClipMask ?? null;
    if (!gfx || gfx.destroyed) {
      gfx = new PIXI.Graphics();
      gfx.name = "fxmSceneParticleStackClipMask";
      gfx.eventMode = "none";
      /**
       * Keep the graphics visible so PIXI can evaluate them as a mask target when the direct scene-particle clip path is active, but leave them non-renderable outside that render call so the scene-rect fill cannot leak into parent-band renders during soft transitions.
       */
      gfx.visible = true;
      gfx.renderable = false;
      container.__fxmStackSceneClipMask = gfx;
    }

    const host = !container.parent?.destroyed ? container.parent : this;
    if (!host || host.destroyed) return null;

    if (gfx.parent !== host) {
      try {
        gfx.parent?.removeChild?.(gfx);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      try {
        host.addChildAt(gfx, 0);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    const rect = canvas?.dimensions?.sceneRect ?? null;
    if (!rect) return gfx;

    const x = Number(rect.x) || 0;
    const y = Number(rect.y) || 0;
    const w = Math.max(0, Number(rect.width) || 0);
    const h = Math.max(0, Number(rect.height) || 0);
    const key = `${x}:${y}:${w}:${h}`;

    if (gfx.__fxmSceneRectKey !== key) {
      try {
        gfx.clear();
        gfx.beginFill(0xffffff, 1);
        gfx.drawRect(x, y, w, h);
        gfx.endFill();
        gfx.__fxmSceneRectKey = key;
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    return gfx;
  }

  /**
   * Ensure a dedicated wrapper container exists for a scene-level particle runtime.
   *
   * @param {PIXI.DisplayObject|null} fx
   * @param {{ layerLevel?: string, belowTokens?: boolean, belowTiles?: boolean, zIndex?: number }} [options]
   * @returns {{ container: PIXI.Container|null, maskSprite: PIXI.Sprite|null }}
   */
  _ensureSceneParticleContainer(
    fx,
    { layerLevel = "belowDarkness", belowTokens = false, belowTiles = false, zIndex = 0 } = {},
  ) {
    if (!fx || fx.destroyed) return { container: null, maskSprite: null };

    this._ensureSceneContainers();
    const bucket = this._getSceneParticleBucket(layerLevel, belowTokens);
    if (!bucket || bucket.destroyed) return { container: null, maskSprite: null };

    let container = fx.__fxmSceneContainer ?? null;
    if (!container || container.destroyed) {
      container = new PIXI.Container();
      container.name = "fxmSceneParticleRuntime";
      container.eventMode = "none";
      container.sortableChildren = false;
      fx.__fxmSceneContainer = container;
    }

    let maskSprite = fx.__fxmSceneMaskSprite ?? null;
    if (!maskSprite || maskSprite.destroyed) {
      maskSprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
      maskSprite.name = "fxmSceneParticleMaskSprite";
      maskSprite.eventMode = "none";
      maskSprite.renderable = false;
      maskSprite._fxmMaskEnabled = false;
      fx.__fxmSceneMaskSprite = maskSprite;
    }

    suppressVisibleMaskPaint(maskSprite);

    if (maskSprite.parent !== container) {
      try {
        maskSprite.parent?.removeChild?.(maskSprite);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      try {
        container.addChildAt(maskSprite, 0);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    } else {
      try {
        if (container.getChildIndex(maskSprite) !== 0) container.setChildIndex(maskSprite, 0);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    if (fx.parent !== container) {
      try {
        fx.parent?.removeChild?.(fx);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      try {
        container.addChild(fx);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    if (container.parent !== bucket) {
      try {
        container.parent?.removeChild?.(container);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      try {
        bucket.addChild(container);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    try {
      container.zIndex = Number.isFinite(zIndex) ? zIndex : 0;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    this._applySceneMaskToContainer(container, maskSprite, { belowTokens, belowTiles });
    return { container, maskSprite };
  }

  /**
   * Destroy the wrapper container used by a scene-level particle runtime.
   *
   * @param {PIXI.DisplayObject|null} fx
   * @param {{ destroyFx?: boolean }} [options]
   * @returns {void}
   */
  _destroySceneParticleContainer(fx, { destroyFx = false } = {}) {
    if (!fx) return;

    const container = fx.__fxmSceneContainer ?? null;
    const maskSprite = fx.__fxmSceneMaskSprite ?? null;

    try {
      if (container && maskSprite && container.mask === maskSprite) container.mask = null;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    if (!destroyFx) {
      try {
        if (fx.parent === container) container.removeChild(fx);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    const stackSceneClipMask = container?.__fxmStackSceneClipMask ?? null;

    try {
      maskSprite?.parent?.removeChild?.(maskSprite);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    try {
      stackSceneClipMask?.parent?.removeChild?.(stackSceneClipMask);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    try {
      container?.parent?.removeChild?.(container);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    destroyParticleMaskSprite(maskSprite, container);

    try {
      if (stackSceneClipMask && !stackSceneClipMask.destroyed) stackSceneClipMask.destroy({ children: true });
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    try {
      if (container && !container.destroyed)
        container.destroy({ children: destroyFx, texture: false, baseTexture: false });
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    try {
      delete fx.__fxmSceneMaskSprite;
      delete fx.__fxmSceneContainer;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  /**
   * Scene manager calls this after it refreshes SceneMaskManager RTs for particles.
   *
   * @param {{ base?: PIXI.RenderTexture|null, cutoutTokens?: PIXI.RenderTexture|null, cutoutTiles?: PIXI.RenderTexture|null, cutoutCombined?: PIXI.RenderTexture|null }} masks
   */
  setSceneMaskTextures({ base = null, cutoutTokens = null, cutoutTiles = null, cutoutCombined = null } = {}) {
    const baseValid = !!base && !base.destroyed && !!base.orig && !base.baseTexture?.destroyed;
    const cutoutTokensValid =
      !!cutoutTokens && !cutoutTokens.destroyed && !!cutoutTokens.orig && !cutoutTokens.baseTexture?.destroyed;
    const cutoutTilesValid =
      !!cutoutTiles && !cutoutTiles.destroyed && !!cutoutTiles.orig && !cutoutTiles.baseTexture?.destroyed;
    const cutoutCombinedValid =
      !!cutoutCombined && !cutoutCombined.destroyed && !!cutoutCombined.orig && !cutoutCombined.baseTexture?.destroyed;

    this._sceneMaskBundle = {
      base: baseValid ? base : null,
      cutoutTokens: cutoutTokensValid ? cutoutTokens : null,
      cutoutTiles: cutoutTilesValid ? cutoutTiles : null,
      cutoutCombined: cutoutCombinedValid ? cutoutCombined : null,
    };

    const apply = (spr, tex, enabled) => {
      if (!spr || spr.destroyed) return;
      suppressVisibleMaskPaint(spr);
      spr.texture = tex ?? PIXI.Texture.EMPTY;
      spr._fxmMaskEnabled = !!enabled;
    };

    apply(this._sceneBelowBaseMask, baseValid ? base : PIXI.Texture.EMPTY, baseValid);
    apply(this._sceneAboveBaseMask, baseValid ? base : PIXI.Texture.EMPTY, baseValid);
    apply(this._sceneBelowCutoutMask, cutoutTokensValid ? cutoutTokens : PIXI.Texture.EMPTY, cutoutTokensValid);
    apply(this._sceneAboveCutoutMask, cutoutTokensValid ? cutoutTokens : PIXI.Texture.EMPTY, cutoutTokensValid);
  }

  /**
   * Apply the appropriate scene mask texture to a compositor bucket for one particle runtime.
   *
   * @param {PIXI.Container|null} root
   * @param {{ belowTokens?: boolean, belowTiles?: boolean, maskTextureOverride?: PIXI.Texture|PIXI.RenderTexture|null }} [entry]
   * @returns {void}
   */
  _applySceneMaskForEntry(root, entry = {}) {
    const container = entry?.container ?? null;
    const sprite = entry?.maskSprite ?? null;
    if (container && sprite) {
      this._applySceneMaskToContainer(container, sprite, entry);
      return;
    }

    const belowTokens = !!entry?.belowTokens;
    const belowTiles = !!entry?.belowTiles;
    const texture =
      entry?.maskTextureOverride ?? chooseParticleMaskTexture(this._sceneMaskBundle, belowTokens, belowTiles);
    const bucketSprite =
      root === this._sceneBelowBase
        ? this._sceneBelowBaseMask
        : root === this._sceneBelowCutout
        ? this._sceneBelowCutoutMask
        : root === this._sceneAboveBase
        ? this._sceneAboveBaseMask
        : root === this._sceneAboveCutout
        ? this._sceneAboveCutoutMask
        : null;
    if (!bucketSprite || bucketSprite.destroyed) return;
    suppressVisibleMaskPaint(bucketSprite);
    bucketSprite.texture = texture ? safeMaskTexture(texture) : PIXI.Texture.EMPTY;
    bucketSprite._fxmMaskEnabled = !!texture;
  }

  /**
   * Apply the appropriate region mask texture to a compositor entry.
   *
   * @param {object|null} entry
   * @returns {void}
   */
  _applyRegionMaskForEntry(entry) {
    const sprite = entry?.maskSprite;
    if (!sprite || sprite.destroyed) return;
    const texture = chooseParticleMaskTexture(entry?.maskBundle, !!entry?.belowTokens, !!entry?.belowTiles);
    sprite.texture = safeMaskTexture(texture);
  }

  #updateSceneParticlesSuppressionForCamera(M = this._currentCameraMatrix ?? snappedStageMatrix()) {
    const cameraChanged = cameraMatrixChanged(M, this._lastSceneMaskMatrix);
    const hasSuppression = !!SceneMaskManager.instance.hasSuppressionRegions?.("particles");
    const overlayState = hasSuppression ? getCanvasLiveLevelSurfaceState() : null;
    const overlaySignature = overlayState?.key ?? "";
    const overlayChanged =
      hasSuppression && (overlayState?.forceRefresh || overlaySignature !== this._lastSceneSuppressionOverlaySignature);
    if (!hasSuppression) this._lastSceneSuppressionOverlaySignature = "";
    if (!cameraChanged && !overlayChanged) return;

    this._lastSceneSuppressionOverlaySignature = overlaySignature;
    if (cameraChanged) {
      this._lastSceneMaskMatrix = { a: M.a, b: M.b, c: M.c, d: M.d, tx: M.tx, ty: M.ty };
    }

    try {
      this._coalescedSceneSuppressionRefresh?.cancel?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    try {
      refreshSceneParticlesSuppressionMasks({ sync: true });
    } catch (err) {
      logger?.error?.(err);
    }
  }

  /**
   * Build a signature describing which scene-scoped particle effects are currently active at the supplied darkness level.
   *
   * @param {number} darknessLevel
   * @returns {string}
   */
  _buildSceneDarknessActivationSignature(darknessLevel = getSceneDarknessLevel()) {
    const flags = canvas?.scene?.getFlag(packageId, "effects") ?? {};
    return Object.entries(flags)
      .filter(([, info]) => !!info && typeof info === "object")
      .map(([id, info]) => {
        const options = normalizeSceneLevelSelection(
          info?.options && typeof info.options === "object" ? { ...info.options } : {},
          canvas?.scene,
        );
        const levelsKey = Array.isArray(options?.levels) ? options.levels.map(String).sort().join(",") : "*";
        const active =
          isEffectActiveForSceneDarkness(options, darknessLevel) &&
          isEffectActiveForCurrentOrVisibleCanvasLevel(options, canvas?.scene);
        return `${id}:${active ? 1 : 0}:${levelsKey}`;
      })
      .sort()
      .join("|");
  }

  /**
   * Build a signature describing which region-scoped particle effects for a single region are active at the supplied darkness level.
   *
   * @param {PlaceableObject} placeable
   * @param {number} darknessLevel
   * @returns {string}
   */
  _buildRegionDarknessActivationSignature(placeable, darknessLevel = getSceneDarknessLevel()) {
    const regionId = placeable?.id ?? "";
    const behaviors = normalizeRegionBehaviorDocs(placeable?.document?.behaviors).filter(
      (behavior) => behavior.type === TYPE && !behavior.disabled,
    );

    const parts = [];
    for (const behavior of behaviors) {
      const defs = behavior.getFlag(packageId, "particleEffects") || {};
      for (const [type, params] of Object.entries(defs)) {
        if (!isEffectActiveForSceneDarkness(params?.options, darknessLevel)) continue;
        parts.push(`${regionId}:${behavior.id}:${type}:1`);
      }
    }

    return parts.sort().join("|");
  }

  async drawParticleEffects({ soft = false } = {}) {
    if (!canvas.scene) return;

    this._ensureSceneContainers();

    const cur = this.particleEffects;
    const darknessLevel = getSceneDarknessLevel();
    let flags = canvas.scene.getFlag(packageId, "effects") ?? {};
    const activeFlags = Object.fromEntries(
      Object.entries(flags).flatMap(([id, info]) => {
        if (!info || typeof info !== "object") return [];
        const options = normalizeSceneLevelSelection(
          info.options && typeof info.options === "object" ? { ...info.options } : {},
          canvas?.scene,
        );
        if (!isEffectActiveForSceneDarkness(options, darknessLevel)) return [];
        if (!isEffectActiveForCurrentOrVisibleCanvasLevel(options, canvas?.scene)) return [];
        return [[id, { ...info, options }]];
      }),
    );

    const removalPromises = [];
    for (const [id, fx] of cur) {
      if (!(id in activeFlags)) {
        const runtimeUid = buildSceneEffectUid("particle", id);
        const transientUid = soft && fx?.fadeOut ? this._promoteSceneRuntimeToTransient(runtimeUid) : null;
        if (!transientUid) this._unregisterStackSlot(runtimeUid);

        this._dyingSceneEffects.add(fx);
        cur.delete(id);

        removalPromises.push(
          (async () => {
            try {
              if (soft && fx.fadeOut) await fx.fadeOut({ timeout: 3000 });
              else fx.stop?.();
            } catch (err) {
              logger.debug("FXMaster:", err);
            }
            try {
              fx.parent?.removeChild?.(fx);
            } catch (err) {
              logger.debug("FXMaster:", err);
            }
            try {
              fx.destroy?.();
            } catch (err) {
              logger.debug("FXMaster:", err);
            }
            try {
              this._destroySceneParticleContainer(fx);
            } catch (err) {
              logger.debug("FXMaster:", err);
            }
            this._clearTransientSceneRow(transientUid);
            this._dyingSceneEffects.delete(fx);
          })(),
        );
      }
    }

    flags = canvas.scene?.getFlag(packageId, "effects") ?? {};

    let zIndex = 0;
    for (const [id, { type, options: flagOptions }] of Object.entries(activeFlags)) {
      if (!(type in CONFIG.fxmaster.particleEffects)) {
        logger.warn(game.i18n.format("FXMASTER.Particles.TypeErrors.TypeUnknown", { id, type: flags[id]?.type }));
        continue;
      }

      const options = Object.fromEntries(Object.entries(flagOptions ?? {}).map(([k, v]) => [k, { value: v }]));
      const EffectClass = CONFIG.fxmaster.particleEffects[type];
      const defaultBlend = EffectClass?.defaultConfig?.blendMode ?? PIXI.BLEND_MODES.NORMAL;
      const existing = cur.get(id);

      const belowTokens = particleBelowTokensEnabled(options?.belowTokens);
      const belowTiles = particleBelowTilesEnabled(options?.belowTiles);
      const belowForeground = particleBelowForegroundEnabled(options?.belowForeground);
      const runtimeUid = buildSceneEffectUid("particle", id);

      const addToLayer = (fx) => {
        const { layerLevel = "belowDarkness" } = EffectClass.defaultConfig || {};
        fx.__fxmBelowTokens = belowTokens;
        fx.__fxmBelowTiles = belowTiles;
        fx.__fxmBelowForeground = belowForeground;
        fx.__fxmLevels = options?.levels;
        fx.__fxmOptions = options;
        this._ensureSceneParticleContainer(fx, { layerLevel, belowTokens, belowTiles, zIndex: fx.zIndex ?? zIndex });
      };

      const registerRuntime = (fx) => {
        const { layerLevel = "belowDarkness" } = EffectClass.defaultConfig || {};
        const { container, maskSprite } = this._ensureSceneParticleContainer(fx, {
          layerLevel,
          belowTokens,
          belowTiles,
          zIndex: fx.zIndex ?? zIndex,
        });
        const root = layerLevel === "aboveDarkness" ? this._aboveContent : this._belowContainer;
        const slot = container ?? fx;
        this._registerStackSlot(runtimeUid, root ?? slot, slot, {
          effectId: id,
          scope: "scene",
          fx,
          layerLevel,
          belowTokens,
          belowTiles,
          belowForeground,
          options,
          levels: options?.levels,
          container,
          maskSprite,
        });
      };

      if (existing) {
        const XFADE_MS = 3000;
        try {
          existing.zIndex = zIndex++;
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        try {
          existing.blendMode = defaultBlend;
        } catch (err) {
          logger.debug("FXMaster:", err);
        }

        existing.__fxmBelowTokens = belowTokens;
        existing.__fxmBelowTiles = belowTiles;
        existing.__fxmBelowForeground = belowForeground;
        existing.__fxmLevels = options?.levels;
        existing.__fxmOptions = options;

        const prev = existing._fxmOptsCache ?? {};
        const diff = foundry.utils.diffObject(prev, options);
        const changed = !foundry.utils.isEmpty(diff);

        if (!changed) {
          try {
            existing.play?.({ skipFading: soft });
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
          registerRuntime(existing);
          continue;
        }

        if (particleOptionsChangedOnlyRuntimeRouting(prev, options)) {
          try {
            existing._fxmOptsCache = foundry.utils.deepClone(options);
          } catch (_err) {
            existing._fxmOptsCache = options;
          }
          try {
            existing.play?.({ skipFading: true });
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
          registerRuntime(existing);
          continue;
        }

        if (soft) {
          const transientUid = this._promoteSceneRuntimeToTransient(runtimeUid);
          const ec = new EffectClass(options);
          ec.zIndex = existing.zIndex ?? zIndex - 1;
          ec.blendMode = defaultBlend;
          ec._fxmOptsCache = foundry.utils.deepClone(options);
          ec.alpha = 0;
          addToLayer(ec);
          cur.set(id, ec);
          registerRuntime(ec);
          ec.play({ prewarm: true });

          this._dyingSceneEffects.add(existing);

          removalPromises.push(
            (async () => {
              try {
                await Promise.all([existing?.fadeOut?.({ timeout: XFADE_MS }), ec?.fadeIn?.({ timeout: XFADE_MS })]);
              } catch (err) {
                logger.debug("FXMaster:", err);
              }
              try {
                existing.parent?.removeChild?.(existing);
              } catch (err) {
                logger.debug("FXMaster:", err);
              }
              try {
                existing.destroy?.();
              } catch (err) {
                logger.debug("FXMaster:", err);
              }
              try {
                this._destroySceneParticleContainer(existing);
              } catch (err) {
                logger.debug("FXMaster:", err);
              }
              this._clearTransientSceneRow(transientUid);
              this._dyingSceneEffects.delete(existing);
            })(),
          );
          continue;
        }

        try {
          existing.stop?.();
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        try {
          existing.parent?.removeChild?.(existing);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        try {
          existing.destroy?.();
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        try {
          this._destroySceneParticleContainer(existing);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        cur.delete(id);

        const ec = new EffectClass(options);
        ec.zIndex = existing.zIndex ?? zIndex - 1;
        ec.blendMode = defaultBlend;
        ec._fxmOptsCache = foundry.utils.deepClone(options);
        addToLayer(ec);
        cur.set(id, ec);
        registerRuntime(ec);
        ec.play({ prewarm: !soft });
        continue;
      }

      const ec = new EffectClass(options);
      ec.zIndex = zIndex++;
      try {
        ec.blendMode = defaultBlend;
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      ec._fxmOptsCache = foundry.utils.deepClone(options);
      addToLayer(ec);
      cur.set(id, ec);
      registerRuntime(ec);
      ec.play({ prewarm: !soft });
    }

    try {
      refreshSceneParticlesSuppressionMasks({ sync: true });
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    this._lastSceneDarknessSignature = this._buildSceneDarknessActivationSignature(darknessLevel);
    this._updateOcclusionGates();
    this._updateRegionBelowTokensNeeded();
    this._syncSceneStackOrderCache();

    if (removalPromises.length) {
      try {
        await Promise.all(removalPromises);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
  }

  /**
   * Draw region-scoped particle effects for a region placeable.
   *
   * An authoritative behavior snapshot may be supplied during behavior CRUD so effect selection does not depend on a stale placeable behavior collection.
   *
   * @param {PlaceableObject} placeable
   * @param {{ soft?: boolean, behaviorDocs?: Iterable<foundry.documents.RegionBehavior>|foundry.documents.RegionBehavior[]|null }} [options]
   * @returns {Promise<void>}
   */
  async drawRegionParticleEffects(placeable, { soft = false, behaviorDocs = null } = {}) {
    const regionId = placeable.id;
    this._ensureSceneContainers();

    const old = this.regionEffects.get(regionId) || [];
    await Promise.all(
      old.map(async (entry) => {
        if (entry?.uid) this._unregisterStackSlot(entry.uid);
        const fx = entry?.fx ?? entry;
        try {
          fx?.stop?.();
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        try {
          fx?.destroy?.();
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        destroyParticleMaskSprite(entry?.maskSprite, entry?.container);

        try {
          entry?.container?.destroy?.({ children: true, texture: false, baseTexture: false });
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }),
    );
    this.regionEffects.set(regionId, []);

    const behaviors = normalizeRegionBehaviorDocs(behaviorDocs ?? placeable?.document?.behaviors).filter(
      (behavior) => behavior.type === TYPE && !behavior.disabled,
    );
    if (!behaviors.length) {
      this.destroyRegionParticleEffects(regionId);
      return;
    }

    const darknessLevel = getSceneDarknessLevel();
    const edgeFadePercent = this._getRegionEdgeFadePercent(placeable, behaviors);
    const edgeFadeCtx = this._buildPerParticleEdgeFadeContext(placeable, edgeFadePercent);
    const regionParticleContext = buildRegionParticleContext(placeable);

    let shared = this._regionMaskRTs.get(regionId);
    if (!shared) {
      shared = { base: null, cutoutTokens: null, cutoutTiles: null, cutoutCombined: null };
      this._regionMaskRTs.set(regionId, shared);
    }

    const oldBase = shared.base;
    const oldCutoutTokens = shared.cutoutTokens;
    const oldCutoutTiles = shared.cutoutTiles;
    const oldCutoutCombined = shared.cutoutCombined;

    shared.base = buildRegionMaskRT(placeable, { rtPool: this._rtPool });
    shared.cutoutTokens = null;
    shared.cutoutTiles = null;
    shared.cutoutCombined = null;

    if (oldBase && oldBase !== shared.base) {
      try {
        this._releaseRT(oldBase);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
    for (const rt of [oldCutoutTokens, oldCutoutTiles, oldCutoutCombined]) {
      if (!rt) continue;
      try {
        this._releaseRT(rt);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    const { cssW, cssH } = getCssViewportMetrics();
    const VW = cssW | 0;
    const VH = cssH | 0;

    for (const behavior of behaviors) {
      const defs = behavior.getFlag(packageId, "particleEffects") || {};
      for (const [type, params] of Object.entries(defs)) {
        if (!isEffectActiveForSceneDarkness(params?.options, darknessLevel)) continue;
        const EffectClass = CONFIG.fxmaster.particleEffects[type];
        if (!EffectClass) continue;

        const { layerLevel = "belowDarkness" } = EffectClass?.defaultConfig || {};
        const defaultBM = EffectClass?.defaultConfig?.blendMode ?? PIXI.BLEND_MODES.NORMAL;

        const effectOptions = Object.fromEntries(
          Object.entries(params?.options ?? {}).map(([k, v]) => [k, { value: v }]),
        );
        if (regionParticleContext) effectOptions.__fxmParticleContext = regionParticleContext;
        const belowTokens = particleBelowTokensEnabled(params?.belowTokens ?? params?.options?.belowTokens);
        const belowTiles = particleBelowTilesEnabled(params?.belowTiles ?? params?.options?.belowTiles);
        const belowForeground = particleBelowForegroundEnabled(
          params?.belowForeground ?? params?.options?.belowForeground,
        );

        const container = new PIXI.Container();
        container.sortableChildren = true;
        container.eventMode = "none";

        const spr = new PIXI.Sprite(safeMaskTexture(null));
        spr.name = "fxmRegionMaskSprite";
        spr.renderable = false;
        spr.width = VW;
        spr.height = VH;
        container.addChild(spr);

        const fx = new EffectClass(effectOptions);
        if (regionParticleContext) fx.__fxmParticleContext = regionParticleContext;
        try {
          fx.blendMode = defaultBM;
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        container.addChild(fx);

        if (edgeFadeCtx) this._applyPerParticleEdgeFadeToEffect(fx, edgeFadeCtx);

        const uid = buildRegionEffectUid("particle", regionId, behavior.id, type);
        if (layerLevel === "aboveDarkness") this._aboveContent.addChild(container);
        else this._belowContainer.addChild(container);

        if (!shared.base) shared.base = buildRegionMaskRT(placeable, { rtPool: this._rtPool });

        if (belowTokens || belowTiles) {
          try {
            if (belowTokens) SceneMaskManager.instance.setBelowTokensNeeded?.("particles", true, "regions");
            if (belowTiles) SceneMaskManager.instance.setBelowTilesNeeded?.("particles", true, "regions");
            SceneMaskManager.instance.refreshTokensSync?.();
          } catch (err) {
            logger.debug("FXMaster:", err);
          }

          const masks = SceneMaskManager.instance.getMasks?.("particles") ?? {};
          const tokensRT = masks.tokens ?? null;
          const tilesRT = masks.tiles ?? null;

          if (belowTokens && !shared.cutoutTokens) {
            const outRT = this._acquireRT(shared.base.width | 0, shared.base.height | 0, shared.base.resolution || 1);
            shared.cutoutTokens = tokensRT
              ? composeMaskMinusTokensRT(shared.base, tokensRT, { outRT })
              : composeMaskMinusTokens(shared.base, { outRT });
          }
          if (belowTiles && !shared.cutoutTiles) {
            const outRT = this._acquireRT(shared.base.width | 0, shared.base.height | 0, shared.base.resolution || 1);
            shared.cutoutTiles = tilesRT
              ? composeMaskMinusTilesRT(shared.base, tilesRT, { outRT })
              : composeMaskMinusTiles(shared.base, { outRT });
          }
          if (belowTokens && belowTiles && !shared.cutoutCombined) {
            const outRT = this._acquireRT(shared.base.width | 0, shared.base.height | 0, shared.base.resolution || 1);
            shared.cutoutCombined = composeMaskMinusCoverageRT(shared.base, [tokensRT, tilesRT], { outRT });
          }
        }

        const maskTex = chooseParticleMaskTexture(shared, belowTokens, belowTiles);
        suppressVisibleMaskPaint(spr);
        spr.texture = safeMaskTexture(maskTex);
        container.mask = spr;

        applyMaskSpriteTransform(container, spr);

        this.regionEffects
          .get(regionId)
          .push({ uid, fx, container, maskSprite: spr, maskBundle: shared, belowTokens, belowTiles, belowForeground });
        const root = layerLevel === "aboveDarkness" ? this._aboveContent : this._belowContainer;
        const regionLevels = getDocumentLevelsSet(placeable?.document ?? null);
        const regionLevelList = regionLevels?.size ? Array.from(regionLevels) : null;
        this._registerStackSlot(uid, root ?? container, container, {
          regionId,
          behaviorId: behavior.id,
          effectId: type,
          fx,
          container,
          layerLevel,
          belowTokens,
          belowTiles,
          belowForeground,
          levels: regionLevelList,
          options: regionLevelList ? { levels: regionLevelList } : undefined,
          maskSprite: spr,
          maskBundle: shared,
        });
        fx.play({ prewarm: !soft });

        fx.__fxmBelowTokens = belowTokens;
        fx.__fxmBelowTiles = belowTiles;
        fx.__fxmBelowForeground = belowForeground;
      }
    }

    if (!(this.regionEffects.get(regionId)?.length > 0)) {
      this.destroyRegionParticleEffects(regionId);
      return;
    }

    this._lastRegionDarknessSignatures.set(
      regionId,
      this._buildRegionDarknessActivationSignature(placeable, darknessLevel),
    );
    this._applyElevationGate(placeable, { force: true });
    this._updateOcclusionGates();
    this._updateRegionBelowTokensNeeded();
  }

  forceRegionMaskRefreshAll() {
    if (!this.regionEffects.size) return;
    for (const [regionId] of this.regionEffects.entries()) {
      const placeable = canvas.regions?.get(regionId);
      if (placeable) this._rebuildRegionMaskFor(placeable);
    }
  }

  forceRegionMaskRefresh(regionId) {
    const placeable = canvas.regions?.get(regionId);
    if (!placeable) return;
    this._rebuildRegionMaskFor(placeable);
  }

  /**
   * Schedule a mask refresh for one or more regions on the next animation frame. Multiple calls within the same frame are batched so that no region ID is lost.
   * @param {string} regionId
   */
  requestRegionMaskRefresh(regionId) {
    this._pendingRegionRefreshIds ??= new Set();
    this._pendingRegionRefreshIds.add(regionId);
    this._coalescedRegionRefresh ??= coalesceNextFrame(
      () => {
        const ids = this._pendingRegionRefreshIds;
        this._pendingRegionRefreshIds = new Set();
        for (const rid of ids) this.forceRegionMaskRefresh(rid);
      },
      { key: this },
    );
    this._coalescedRegionRefresh();
  }

  requestRegionMaskRefreshAll() {
    this._coalescedRefreshAll ??= coalesceNextFrame(() => this.forceRegionMaskRefreshAll(), { key: this });
    this._coalescedRefreshAll();
  }

  /**
   * Recompose live region below-object cutout masks against the current shared scene coverage textures.
   *
   * @param {{ refreshSharedMasks?: boolean }} [options]
   * @returns {void}
   */
  refreshCoverageCutoutsSync({ refreshSharedMasks = false } = {}) {
    if (!this.regionEffects.size) return;

    try {
      this._updateRegionBelowTokensNeeded();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    if (!this._regionBelowTokensNeeded && !this._regionBelowTilesNeeded) {
      this._tokensDirty = false;
      return;
    }

    try {
      SceneMaskManager.instance.setBelowTokensNeeded?.("particles", this._regionBelowTokensNeeded, "regions");
      SceneMaskManager.instance.setBelowTilesNeeded?.("particles", this._regionBelowTilesNeeded, "regions");
      if (refreshSharedMasks) SceneMaskManager.instance.refreshTokensSync?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    const masks = SceneMaskManager.instance.getMasks?.("particles") ?? {};
    const tokensRT = masks.tokens ?? null;
    const tilesRT = masks.tiles ?? null;

    for (const [regionId, shared] of this._regionMaskRTs.entries()) {
      if (!shared?.base) continue;
      const entries = this.regionEffects.get(regionId) ?? [];
      const anyBelowTokens = entries.some((entry) => !!entry?.fx?.__fxmBelowTokens);
      const anyBelowTiles = entries.some((entry) => !!entry?.fx?.__fxmBelowTiles);

      try {
        if (anyBelowTokens && shared.cutoutTokens) {
          if (tokensRT) composeMaskMinusTokensRT(shared.base, tokensRT, { outRT: shared.cutoutTokens });
          else composeMaskMinusTokens(shared.base, { outRT: shared.cutoutTokens });
        }
        if (anyBelowTiles && shared.cutoutTiles) {
          if (tilesRT) composeMaskMinusTilesRT(shared.base, tilesRT, { outRT: shared.cutoutTiles });
          else composeMaskMinusTiles(shared.base, { outRT: shared.cutoutTiles });
        }
        if (anyBelowTokens && anyBelowTiles && shared.cutoutCombined) {
          composeMaskMinusCoverageRT(shared.base, [tokensRT, tilesRT], { outRT: shared.cutoutCombined });
        }
      } catch (err) {
        logger?.error?.("FXMaster: error recomposing particle region coverage cutout mask", err);
      }
    }

    this._tokensDirty = false;
  }

  destroyRegionParticleEffects(regionId) {
    const entries = this.regionEffects.get(regionId) || [];
    for (const entry of entries) {
      if (entry?.uid) this._unregisterStackSlot(entry.uid);
      const fx = entry?.fx ?? entry;
      const container = entry?.container;
      const maskSprite = entry?.maskSprite;

      try {
        fx?.stop?.();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      try {
        fx?.destroy?.();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      try {
        if (container && container.mask === maskSprite) container.mask = null;
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      destroyParticleMaskSprite(maskSprite, container);

      try {
        if (container?.parent) container.parent.removeChild(container);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      try {
        container?.destroy?.({ children: true, texture: false, baseTexture: false });
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
    this.regionEffects.delete(regionId);
    this._lastRegionDarknessSignatures.delete(regionId);
    this._updateRegionBelowTokensNeeded();

    const rt = this._regionMaskRTs.get(regionId);
    if (rt) {
      try {
        this._releaseRT(rt.base);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      for (const maskRT of [rt.cutoutTokens, rt.cutoutTiles, rt.cutoutCombined]) {
        try {
          this._releaseRT(maskRT);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }
      this._regionMaskRTs.delete(regionId);
    }
  }

  #initializeInverseOcclusionFilter() {
    this.occlusionFilter = CONFIG.fxmaster.WeatherOcclusionMaskFilterNS.create({
      occlusionTexture: canvas.masks.depth.renderTexture,
    });
    this.occlusionFilter.enabled = false;
    this.occlusionFilter.elevation = this.#elevation;
    this.occlusionFilter.blendMode = PIXI.BLEND_MODES.NORMAL;
    this.filterArea = canvas.app.renderer.screen;
    this.filters = [this.occlusionFilter];
  }

  refreshAboveSceneMask() {
    if (!this._aboveContent) return;
    const sceneMask = canvas?.masks?.scene || null;
    try {
      this._aboveContent.mask = sceneMask;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    if (this._aboveMaskGfx && !this._aboveMaskGfx.destroyed) {
      try {
        this._aboveMaskGfx.destroy(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
    this._aboveMaskGfx = null;
  }

  _ensureSceneContainers() {
    if (!this._belowContainer || this._belowContainer.destroyed) {
      this._belowContainer = new PIXI.Container();
      this._belowContainer.name = "fxmSceneBelowBand";
      this._belowContainer.sortableChildren = true;
      this._belowContainer.eventMode = "none";
      this.addChild(this._belowContainer);

      this._belowOccl = CONFIG.fxmaster.WeatherOcclusionMaskFilterNS.create({
        occlusionTexture: canvas.masks.depth.renderTexture,
      });
      this._belowOccl.enabled = false;
      this._belowOccl.elevation = this.#elevation;
      this._belowOccl.blendMode = PIXI.BLEND_MODES.NORMAL;
      this._belowContainer.filters = [this._belowOccl];
      this._belowContainer.filterArea = canvas.app.renderer.screen;
    }

    if (!this._sceneBelowCutout || this._sceneBelowCutout.destroyed) {
      this._sceneBelowCutout = new PIXI.Container();
      this._sceneBelowCutout.name = "fxmSceneBelowCutout";
      this._sceneBelowCutout.sortableChildren = true;
      this._sceneBelowCutout.eventMode = "none";
      this._belowContainer.addChild(this._sceneBelowCutout);
    } else if (this._sceneBelowCutout.parent !== this._belowContainer) {
      try {
        this._sceneBelowCutout.parent?.removeChild?.(this._sceneBelowCutout);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this._belowContainer.addChild(this._sceneBelowCutout);
    }

    if (!this._sceneBelowBase || this._sceneBelowBase.destroyed) {
      this._sceneBelowBase = new PIXI.Container();
      this._sceneBelowBase.name = "fxmSceneBelowBase";
      this._sceneBelowBase.sortableChildren = true;
      this._sceneBelowBase.eventMode = "none";
      this._belowContainer.addChild(this._sceneBelowBase);
    } else if (this._sceneBelowBase.parent !== this._belowContainer) {
      try {
        this._sceneBelowBase.parent?.removeChild?.(this._sceneBelowBase);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this._belowContainer.addChild(this._sceneBelowBase);
    }

    const expectParent = canvas.effects ?? canvas.rendered ?? this;
    if (!this._aboveContent || this._aboveContent.destroyed) {
      this._aboveContent = new PIXI.Container();
      this._aboveContent.name = "fxmSceneAboveBand";
      this._aboveContent.sortableChildren = true;
      this._aboveContent.eventMode = "none";
      this._aboveContent.renderable = false;
      expectParent.addChild(this._aboveContent);
      this.refreshAboveSceneMask();

      this._aboveOccl = CONFIG.fxmaster.WeatherOcclusionMaskFilterNS.create({
        occlusionTexture: canvas.masks.depth.renderTexture,
      });
      this._aboveOccl.enabled = false;
      this._aboveOccl.elevation = this.#elevation;
      this._aboveOccl.blendMode = PIXI.BLEND_MODES.NORMAL;
      this._aboveContent.filters = [this._aboveOccl];
      this._aboveContent.filterArea = canvas.app.renderer.screen;
    } else if (this._aboveContent.parent !== expectParent) {
      try {
        this._aboveContent.parent?.removeChild?.(this._aboveContent);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      expectParent.addChild(this._aboveContent);
    }
    this._aboveContent.renderable = false;

    if (!this._sceneAboveCutout || this._sceneAboveCutout.destroyed) {
      this._sceneAboveCutout = new PIXI.Container();
      this._sceneAboveCutout.name = "fxmSceneAboveCutout";
      this._sceneAboveCutout.sortableChildren = true;
      this._sceneAboveCutout.eventMode = "none";
      this._aboveContent.addChild(this._sceneAboveCutout);
    } else if (this._sceneAboveCutout.parent !== this._aboveContent) {
      try {
        this._sceneAboveCutout.parent?.removeChild?.(this._sceneAboveCutout);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this._aboveContent.addChild(this._sceneAboveCutout);
    }

    if (!this._sceneAboveBase || this._sceneAboveBase.destroyed) {
      this._sceneAboveBase = new PIXI.Container();
      this._sceneAboveBase.name = "fxmSceneAboveBase";
      this._sceneAboveBase.sortableChildren = true;
      this._sceneAboveBase.eventMode = "none";
      this._aboveContent.addChild(this._sceneAboveBase);
    } else if (this._sceneAboveBase.parent !== this._aboveContent) {
      try {
        this._sceneAboveBase.parent?.removeChild?.(this._sceneAboveBase);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this._aboveContent.addChild(this._sceneAboveBase);
    }

    const { cssW, cssH } = getCssViewportMetrics();

    const ensureBucketMask = (bucket, prop, name) => {
      if (!bucket || bucket.destroyed) return null;

      let spr = this[prop];
      if (!spr || spr.destroyed) {
        spr = new PIXI.Sprite(PIXI.Texture.EMPTY);
        spr.name = name;
        spr.eventMode = "none";
        spr.renderable = false;
        spr._fxmMaskEnabled = false;
        this[prop] = spr;
        try {
          bucket.addChild(spr);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      } else if (spr.parent !== bucket) {
        try {
          spr.parent?.removeChild?.(spr);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        try {
          bucket.addChild(spr);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }

      /** Guard against transient invalid textures during scene transitions. */
      try {
        if (spr._texture?.orig) {
          spr.width = cssW;
          spr.height = cssH;
        }
      } catch (err) {
        logger.debug("FXMaster:", err);
      }

      return spr;
    };

    ensureBucketMask(this._sceneBelowCutout, "_sceneBelowCutoutMask", "fxmSceneParticlesMask:belowCutout");
    ensureBucketMask(this._sceneBelowBase, "_sceneBelowBaseMask", "fxmSceneParticlesMask:belowBase");
    ensureBucketMask(this._sceneAboveCutout, "_sceneAboveCutoutMask", "fxmSceneParticlesMask:aboveCutout");
    ensureBucketMask(this._sceneAboveBase, "_sceneAboveBaseMask", "fxmSceneParticlesMask:aboveBase");

    this._updateOcclusionGates();
    this._updateRegionBelowTokensNeeded();
  }

  _rebuildRegionMaskFor(placeable) {
    const regionId = placeable.id;
    const entries = this.regionEffects.get(regionId);
    if (!entries?.length) return;

    const { cssW, cssH } = getCssViewportMetrics();
    const VW = cssW | 0;
    const VH = cssH | 0;

    const newBase = buildRegionMaskRT(placeable, { rtPool: this._rtPool });
    let shared = this._regionMaskRTs.get(regionId) || {
      base: null,
      cutoutTokens: null,
      cutoutTiles: null,
      cutoutCombined: null,
    };
    const oldBase = shared.base;
    shared.base = newBase;

    const anyBelowTokens = entries.some((e) => !!e?.fx?.__fxmBelowTokens);
    const anyBelowTiles = entries.some((e) => !!e?.fx?.__fxmBelowTiles);
    if (anyBelowTokens || anyBelowTiles) {
      try {
        SceneMaskManager.instance.setBelowTokensNeeded?.("particles", anyBelowTokens, "regions");
        SceneMaskManager.instance.setBelowTilesNeeded?.("particles", anyBelowTiles, "regions");
        SceneMaskManager.instance.refreshTokensSync?.();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      const masks = SceneMaskManager.instance.getMasks?.("particles") ?? {};
      const tokensRT = masks.tokens ?? null;
      const tilesRT = masks.tiles ?? null;

      const reuseTokens =
        !!shared.cutoutTokens &&
        shared.cutoutTokens.width === newBase.width &&
        shared.cutoutTokens.height === newBase.height &&
        (shared.cutoutTokens.resolution || 1) === (newBase.resolution || 1);
      const reuseTiles =
        !!shared.cutoutTiles &&
        shared.cutoutTiles.width === newBase.width &&
        shared.cutoutTiles.height === newBase.height &&
        (shared.cutoutTiles.resolution || 1) === (newBase.resolution || 1);
      const reuseCombined =
        !!shared.cutoutCombined &&
        shared.cutoutCombined.width === newBase.width &&
        shared.cutoutCombined.height === newBase.height &&
        (shared.cutoutCombined.resolution || 1) === (newBase.resolution || 1);

      if (anyBelowTokens) {
        const outRT = reuseTokens
          ? shared.cutoutTokens
          : this._acquireRT(newBase.width | 0, newBase.height | 0, newBase.resolution || 1);
        shared.cutoutTokens = tokensRT
          ? composeMaskMinusTokensRT(newBase, tokensRT, { outRT })
          : composeMaskMinusTokens(newBase, { outRT });
      } else if (shared.cutoutTokens) {
        this._releaseRT(shared.cutoutTokens);
        shared.cutoutTokens = null;
      }

      if (anyBelowTiles) {
        const outRT = reuseTiles
          ? shared.cutoutTiles
          : this._acquireRT(newBase.width | 0, newBase.height | 0, newBase.resolution || 1);
        shared.cutoutTiles = tilesRT
          ? composeMaskMinusTilesRT(newBase, tilesRT, { outRT })
          : composeMaskMinusTiles(newBase, { outRT });
      } else if (shared.cutoutTiles) {
        this._releaseRT(shared.cutoutTiles);
        shared.cutoutTiles = null;
      }

      if (anyBelowTokens && anyBelowTiles) {
        const outRT = reuseCombined
          ? shared.cutoutCombined
          : this._acquireRT(newBase.width | 0, newBase.height | 0, newBase.resolution || 1);
        shared.cutoutCombined = composeMaskMinusCoverageRT(newBase, [tokensRT, tilesRT], { outRT });
      } else if (shared.cutoutCombined) {
        this._releaseRT(shared.cutoutCombined);
        shared.cutoutCombined = null;
      }
    } else {
      for (const key of ["cutoutTokens", "cutoutTiles", "cutoutCombined"]) {
        if (shared[key]) this._releaseRT(shared[key]);
        shared[key] = null;
      }
    }
    this._regionMaskRTs.set(regionId, shared);

    for (const entry of entries) {
      const spr = entry?.maskSprite;
      const cont = entry?.container;
      if (!spr || spr.destroyed || !cont || cont.destroyed) continue;

      const want = chooseParticleMaskTexture(shared, !!entry?.fx?.__fxmBelowTokens, !!entry?.fx?.__fxmBelowTiles);
      spr.texture = safeMaskTexture(want);

      if (!spr._texture) continue;
      try {
        spr.width = VW;
        spr.height = VH;
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      try {
        applyMaskSpriteTransform(cont, spr);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      if (cont.mask !== spr) {
        try {
          cont.mask = spr;
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }
    }

    if (oldBase && oldBase !== newBase) this._releaseRT(oldBase);
  }

  /**
   * Compute the region-edge fade percent for particle effects (0..1). If multiple particle behaviors exist on the region, the maximum is used.
   *
   * @param {PlaceableObject} placeable
   * @param {foundry.documents.RegionBehavior[]} [behaviors]
   * @returns {number}
   * @private
   */
  _getRegionEdgeFadePercent(placeable, behaviors = null) {
    const list = behaviors ?? (placeable?.document?.behaviors || []).filter((b) => b?.type === TYPE && !b?.disabled);

    let max = 0;
    for (const b of list) {
      const raw = b?.getFlag?.(packageId, "edgeFadePercent");
      const n = Number(raw);
      if (Number.isFinite(n)) max = Math.max(max, n);
    }
    return Math.min(Math.max(max, 0), 1);
  }

  /**
   * Build a per-particle edge fade context for a region.
   *
   * This returns a context which keeps the region mask binary and applies an additional per-particle alpha multiplier derived from world-space distance to the nearest region boundary. This avoids visible banding artifacts that can occur when generating a soft region mask on 8-bit render targets.
   *
   * @param {PlaceableObject} placeable
   * @param {number} edgeFadePercent - [0..1]
   * @returns {{bandWorld:number, computeFade:(x:number,y:number)=>number}|null}
   * @private
   */
  _buildPerParticleEdgeFadeContext(placeable, edgeFadePercent) {
    const pct = Math.min(Math.max(Number(edgeFadePercent) || 0, 0), 1);
    if (!(pct > 0)) return null;

    const inrad = estimateRegionInradius(placeable);
    const bandWorld = Math.max(1e-6, pct * (Number.isFinite(inrad) && inrad > 0 ? inrad : 0));
    if (!(bandWorld > 0)) return null;

    const shapes = placeable?.document?.shapes ?? [];
    if (!Array.isArray(shapes) || shapes.length === 0) return null;

    /** @type {Array<any>} */
    const solids = [];
    /** @type {Array<any>} */
    const holes = [];

    const toFlat = (pts) => {
      if (!pts) return null;
      if (Array.isArray(pts) && typeof pts[0] === "number") return pts.slice();
      if (Array.isArray(pts) && typeof pts[0] === "object") {
        const out = [];
        for (const p of pts) {
          if (!p) continue;
          out.push(Number(p.x) || 0, Number(p.y) || 0);
        }
        return out;
      }
      return null;
    };

    const normalizeFlat = (flat) => {
      if (!Array.isArray(flat) || flat.length < 6) return null;
      const n = (flat.length / 2) | 0;
      if (n < 3) return null;
      const lx = flat[2 * (n - 1)];
      const ly = flat[2 * (n - 1) + 1];
      const closed = lx === flat[0] && ly === flat[1];
      const m = closed ? n - 1 : n;
      if (m < 3) return null;
      return flat.slice(0, m * 2);
    };

    const centroidFlat = (flat) => {
      const n = (flat.length / 2) | 0;
      let sx = 0;
      let sy = 0;
      for (let i = 0; i < n; i++) {
        sx += flat[2 * i];
        sy += flat[2 * i + 1];
      }
      return { x: sx / n, y: sy / n };
    };

    const rotateFlat = (flat, cx, cy, rotRad) => {
      if (!rotRad) return flat;
      const c = Math.cos(rotRad);
      const s = Math.sin(rotRad);
      const out = flat.slice();
      const n = (flat.length / 2) | 0;
      for (let i = 0; i < n; i++) {
        const x = out[2 * i] - cx;
        const y = out[2 * i + 1] - cy;
        out[2 * i] = cx + x * c - y * s;
        out[2 * i + 1] = cy + x * s + y * c;
      }
      return out;
    };

    const buildPoly = (flat) => {
      const pts = new Float32Array(flat);
      const n = (pts.length / 2) | 0;
      if (n < 3) return null;

      /** Tight AABB for fast rejection and hole-distance lower bounds. */
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (let i = 0; i < n; i++) {
        const x = pts[2 * i];
        const y = pts[2 * i + 1];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }

      /**
       * Precompute per-edge data for fast point-to-segment distance. Layout per edge: [ax, ay, bx, by, abx, aby, invDenom]
       */
      const edges = new Float32Array(n * 7);
      for (let i = 0; i < n; i++) {
        const j = (i + n - 1) % n;
        const ax = pts[2 * j];
        const ay = pts[2 * j + 1];
        const bx = pts[2 * i];
        const by = pts[2 * i + 1];
        const abx = bx - ax;
        const aby = by - ay;
        const denom = abx * abx + aby * aby;
        const inv = denom > 1e-6 ? 1 / denom : 0;

        const o = i * 7;
        edges[o] = ax;
        edges[o + 1] = ay;
        edges[o + 2] = bx;
        edges[o + 3] = by;
        edges[o + 4] = abx;
        edges[o + 5] = aby;
        edges[o + 6] = inv;
      }

      return { kind: "poly", pts, edges, minX, minY, maxX, maxY };
    };

    const addPoly = (pts, hole, rotRad = 0) => {
      let flat = normalizeFlat(toFlat(pts));
      if (!flat) return;
      if (rotRad) {
        const c = centroidFlat(flat);
        flat = rotateFlat(flat, c.x, c.y, rotRad);
      }
      const poly = buildPoly(flat);
      if (!poly) return;
      (hole ? holes : solids).push(poly);
    };

    const isEmptyShape = (s) => {
      try {
        if (typeof s?.isEmpty === "function") return !!s.isEmpty();
        return !!s?.isEmpty;
      } catch {
        return false;
      }
    };

    for (const s of shapes) {
      if (!s) continue;
      if (isEmptyShape(s)) continue;
      const hole = !!s.hole;

      if (Array.isArray(s?.polygons) && s.polygons.length) {
        for (const poly of s.polygons) {
          if (!poly) continue;
          addPoly(poly?.points ?? poly, hole, 0);
        }
        continue;
      }

      const type = s?.type;
      const rotRad = ((Number(s?.rotation) || 0) * Math.PI) / 180;

      if (type === "rectangle") {
        const x = Number(s.x) || 0;
        const y = Number(s.y) || 0;
        const w = Math.max(0, Number(s.width) || 0);
        const h = Math.max(0, Number(s.height) || 0);
        const cx = x + w / 2;
        const cy = y + h / 2;
        const c = Math.cos(rotRad);
        const sn = Math.sin(rotRad);

        /** Tight AABB for a rotated rectangle. */
        const ex = Math.abs(c) * (w / 2) + Math.abs(sn) * (h / 2);
        const ey = Math.abs(sn) * (w / 2) + Math.abs(c) * (h / 2);

        (hole ? holes : solids).push({
          kind: "rect",
          cx,
          cy,
          hx: w / 2,
          hy: h / 2,
          c,
          s: sn,
          minX: cx - ex,
          minY: cy - ey,
          maxX: cx + ex,
          maxY: cy + ey,
        });
        continue;
      }

      if (type === "ellipse" || type === "circle") {
        const cx = Number(s.x) || 0;
        const cy = Number(s.y) || 0;
        const rx = Math.max(0, type === "circle" ? Number(s.radius) || 0 : Number(s.radiusX) || 0);
        const ry = Math.max(0, type === "circle" ? Number(s.radius) || 0 : Number(s.radiusY) || 0);
        const c = Math.cos(rotRad);
        const sn = Math.sin(rotRad);

        /** Tight AABB for a rotated ellipse. */
        const ex = Math.sqrt(rx * c * (rx * c) + ry * sn * (ry * sn));
        const ey = Math.sqrt(rx * sn * (rx * sn) + ry * c * (ry * c));

        (hole ? holes : solids).push({
          kind: "ellipse",
          cx,
          cy,
          hx: rx,
          hy: ry,
          c,
          s: sn,
          minX: cx - ex,
          minY: cy - ey,
          maxX: cx + ex,
          maxY: cy + ey,
        });
        continue;
      }

      if (type === "polygon") {
        addPoly(s.points ?? [], hole, rotRad);
        continue;
      }

      /** Fallback for unusual shapes: if it has a points array, treat it as a polygon. */
      if (Array.isArray(s?.points) && s.points.length) {
        addPoly(s.points, hole, rotRad);
      }
    }

    if (!solids.length) return null;

    const sdRect = (px, py, r) => {
      /** Rotate by -rot using c=cos(rot), s=sin(rot). */
      const dx = px - r.cx;
      const dy = py - r.cy;
      const x = r.c * dx + r.s * dy;
      const y = -r.s * dx + r.c * dy;
      const qx = Math.abs(x) - r.hx;
      const qy = Math.abs(y) - r.hy;
      const ox = Math.max(qx, 0);
      const oy = Math.max(qy, 0);
      const outside = Math.hypot(ox, oy);
      const inside = Math.min(Math.max(qx, qy), 0);
      return outside + inside;
    };

    const sdEllipse = (px, py, e) => {
      const dx = px - e.cx;
      const dy = py - e.cy;
      const x = e.c * dx + e.s * dy;
      const y = -e.s * dx + e.c * dy;
      const hx = Math.max(1e-6, e.hx);
      const hy = Math.max(1e-6, e.hy);
      const nx = x / hx;
      const ny = y / hy;
      const r = Math.hypot(nx, ny);
      const R = Math.max(hx, hy);
      return (r - 1) * R;
    };

    const sdPoly = (px, py, poly) => {
      const edges = poly.edges;
      const n = (edges.length / 7) | 0;
      if (n < 3) return 1e20;

      let inside = false;
      let dMin2 = 1e40;

      for (let i = 0; i < n; i++) {
        const o = i * 7;
        const ax = edges[o];
        const ay = edges[o + 1];
        const by = edges[o + 3];
        const abx = edges[o + 4];
        const aby = edges[o + 5];
        const inv = edges[o + 6];

        /** Even-odd rule (ray cast on +X). */
        const intersect = ay > py !== by > py && px < (abx * (py - ay)) / (by - ay + 1e-12) + ax;
        if (intersect) inside = !inside;

        /** Point-to-segment distance squared (one sqrt at the end). */
        const dx = px - ax;
        const dy = py - ay;
        let t = inv > 0 ? (dx * abx + dy * aby) * inv : 0;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
        const cx = dx - abx * t;
        const cy = dy - aby * t;
        const d2 = cx * cx + cy * cy;
        if (d2 < dMin2) dMin2 = d2;
      }

      const d = Math.sqrt(dMin2);
      return inside ? -d : d;
    };

    const shapeSd = (px, py, sh) => {
      if (!sh) return 1e20;
      if (sh.kind === "rect") return sdRect(px, py, sh);
      if (sh.kind === "ellipse") return sdEllipse(px, py, sh);
      if (sh.kind === "poly") return sdPoly(px, py, sh);
      return 1e20;
    };

    const smooth01 = (t) => {
      t = Math.min(1, Math.max(0, t));
      return t * t * (3 - 2 * t);
    };

    const computeFade = (x, y) => {
      /** Union of solids: inside-distance is max of per-shape inside distances. */
      let insideSolid = 0;

      for (const sh of solids) {
        /** Fast AABB reject: if point is outside, it cannot be inside the shape. */
        if (x < sh.minX || x > sh.maxX || y < sh.minY || y > sh.maxY) continue;

        const sd = shapeSd(x, y, sh);
        if (sd < 0) {
          const d = -sd;
          if (d > insideSolid) insideSolid = d;

          /** Once at or beyond the fade band, additional precision is unnecessary. */
          if (insideSolid >= bandWorld) {
            insideSolid = bandWorld;
            break;
          }
        }
      }

      if (!(insideSolid > 0)) return 0;

      /** No holes: return directly (including early-out at full opacity). */
      if (!holes.length) return insideSolid >= bandWorld ? 1 : smooth01(insideSolid / bandWorld);

      /** Holes: nearest boundary can also be a hole boundary. */
      let holeMin = Infinity;
      let holeMin2 = Infinity;

      for (const sh of holes) {
        /**
         * Lower-bound prune using AABB distance: if the AABB is already farther than the current best known hole distance, this hole cannot affect the result.
         */
        if (holeMin2 !== Infinity) {
          let dx = 0;
          if (x < sh.minX) dx = sh.minX - x;
          else if (x > sh.maxX) dx = x - sh.maxX;

          let dy = 0;
          if (y < sh.minY) dy = sh.minY - y;
          else if (y > sh.maxY) dy = y - sh.maxY;

          const d2 = dx * dx + dy * dy;
          if (d2 >= holeMin2) continue;
        }

        const sd = shapeSd(x, y, sh);
        if (sd < 0) return 0;
        if (sd < holeMin) {
          holeMin = sd;
          holeMin2 = sd * sd;

          /** Cannot do better than zero; allow a small epsilon to stop scanning. */
          if (holeMin <= 1e-6) break;
        }
      }

      if (Number.isFinite(holeMin)) insideSolid = Math.min(insideSolid, holeMin);

      /** Early-out: fully inside the fade band even after accounting for holes. */
      if (insideSolid >= bandWorld) return 1;

      return smooth01(insideSolid / bandWorld);
    };

    return { bandWorld, computeFade };
  }

  /**
   * Wrap emitter updates to apply per-particle edge fade.
   * @param {any} fx
   * @param {{computeFade:(x:number,y:number)=>number}} ctx
   * @private
   */
  _applyPerParticleEdgeFadeToEffect(fx, ctx) {
    if (!fx || !ctx?.computeFade) return;

    const emitters = fx.emitters ?? [];
    for (const emitter of emitters) {
      if (!emitter || emitter._fxmEdgeFadeWrapped) continue;

      const origUpdate = emitter.update?.bind(emitter);
      if (typeof origUpdate !== "function") continue;

      emitter.update = (delta) => {
        /** Restore unfaded alpha from the previous frame to prevent compounding. */
        try {
          fxmForEachEmitterParticle(emitter, (p) => {
            const last = Number(p?._fxmEdgeFadeMul);
            if (!Number.isFinite(last) || last === 1) return;

            const base = p?._fxmEdgeFadeBaseAlpha;
            if (typeof base === "number" && Number.isFinite(base)) {
              p.alpha = base;
            }
          });
        } catch (err) {
          logger.debug("FXMaster:", err);
        }

        origUpdate(delta);

        try {
          fxmForEachEmitterParticle(emitter, (p) => {
            const a = Number(p?.alpha) || 0;
            p._fxmEdgeFadeBaseAlpha = a;

            /** PIXI particles expose numeric x/y values in world space. */
            const x = typeof p?.x === "number" ? p.x : Number(p?.x) || 0;
            const y = typeof p?.y === "number" ? p.y : Number(p?.y) || 0;

            const f = ctx.computeFade(x, y);
            p._fxmEdgeFadeMul = f;
            p.alpha = a * f;
          });
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      };

      emitter._fxmEdgeFadeWrapped = true;
    }
  }

  _animate() {
    super._animate();

    try {
      this._refreshBelowObjectCoverageForCamera();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    try {
      this._sanitizeSceneMasks();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    try {
      const darknessLevel = getSceneDarknessLevel();
      this._lastDarknessLevel = darknessLevel;

      const sceneSignature = this._buildSceneDarknessActivationSignature(darknessLevel);
      if (sceneSignature !== this._lastSceneDarknessSignature) {
        this._lastSceneDarknessSignature = sceneSignature;
        void this.drawParticleEffects({ soft: true });
      }

      for (const region of canvas.regions?.placeables ?? []) {
        const signature = this._buildRegionDarknessActivationSignature(region, darknessLevel);
        if (signature !== (this._lastRegionDarknessSignatures.get(region.id) ?? "")) {
          this._lastRegionDarknessSignatures.set(region.id, signature);
          void this.drawRegionParticleEffects(region, { soft: true });
        }
      }
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    try {
      this.#updateSceneParticlesSuppressionForCamera(this._currentCameraMatrix ?? snappedStageMatrix());
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    if (this.regionEffects.size === 0) return;

    const { deviceRect } = getCssViewportMetrics();
    const w = deviceRect.width | 0;
    const h = deviceRect.height | 0;
    if (w !== this._lastViewSize.w || h !== this._lastViewSize.h) {
      this._lastViewSize = { w, h };
      this.forceRegionMaskRefreshAll();
    }

    this._sanitizeRegionMasks();

    if (this._tokensDirty) {
      try {
        this.refreshCoverageCutoutsSync({ refreshSharedMasks: true });
      } catch (err) {
        logger?.error?.("FXMaster: error recomposing particle token cutout masks", err);
      }
      this._tokensDirty = false;
    }

    try {
      for (const [regionId] of this.regionEffects) {
        const reg = canvas.regions?.get(regionId);
        if (reg) this._applyElevationGate(reg);
      }
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  applyElevationGateForAll() {
    try {
      for (const [regionId] of this.regionEffects) {
        const reg = canvas.regions?.get(regionId);
        if (reg) this._applyElevationGate(reg);
      }
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  _applyElevationGate(placeable, { force = false } = {}) {
    const entries = this.regionEffects.get(placeable.id) || [];
    if (!entries.length) return;

    const pass = computeRegionGatePass(placeable, { behaviorType: `${packageId}.particleEffectsRegion` });
    const prev = this._gatePassCache.get(placeable.id);

    if (!force && prev === pass) {
      let allMatch = true;
      for (const entry of entries) {
        const vis = !!entry?.container?.visible;
        const en = entry?.fx && "enabled" in entry.fx ? !!entry.fx.enabled : vis;
        if (vis !== !!pass || en !== !!pass) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) return;
    }

    for (const entry of entries) {
      try {
        if (entry?.container && entry.container.visible !== !!pass) entry.container.visible = !!pass;
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      try {
        if (entry?.fx && "enabled" in entry.fx && entry.fx.enabled !== !!pass) entry.fx.enabled = !!pass;
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    this._gatePassCache.set(placeable.id, pass);
  }

  _updateOcclusionGates() {
    const hasChildrenExceptMask = (container, maskSprite) => {
      if (!container || container.destroyed) return false;
      const kids = container.children ?? [];
      if (!kids.length) return false;
      if (kids.length === 1 && maskSprite && kids[0] === maskSprite) return false;
      if (maskSprite && kids.length > 0) {
        return kids.some((c) => c !== maskSprite);
      }
      return kids.length > 0;
    };

    const hasBelowScene =
      hasChildrenExceptMask(this._sceneBelowBase, this._sceneBelowBaseMask) ||
      hasChildrenExceptMask(this._sceneBelowCutout, this._sceneBelowCutoutMask);

    const hasAboveScene =
      hasChildrenExceptMask(this._sceneAboveBase, this._sceneAboveBaseMask) ||
      hasChildrenExceptMask(this._sceneAboveCutout, this._sceneAboveCutoutMask);

    if (this.occlusionFilter) {
      this.occlusionFilter.enabled = false;
      this.occlusionFilter.elevation = this.#elevation;
    }

    const canUseNativeWeatherOcclusion = canUseNativeWeatherOcclusionStackPass();
    const hasWeatherOcclusionTiles = canUseNativeWeatherOcclusion ? this._sceneHasWeatherOcclusionTiles() : false;

    if (this._belowOccl) {
      this._belowOccl.enabled =
        hasWeatherOcclusionTiles && (!!hasBelowScene || this._hasRegionFXInRoot(this._belowContainer));
      this._belowOccl.elevation = this.#elevation;
    }
    if (this._aboveOccl) {
      this._aboveOccl.enabled =
        hasWeatherOcclusionTiles && (!!hasAboveScene || this._hasRegionFXInRoot(this._aboveContent));
      this._aboveOccl.elevation = this.#elevation;
    }
  }

  _hasRegionFXInRoot(root) {
    if (!root) return false;
    for (const entries of this.regionEffects.values()) {
      for (const e of entries) {
        if (e?.container?.parent === root) return true;
      }
    }
    return false;
  }

  /**
   * Return whether the current scene contains any visible overhead tiles that both expose native occlusion and explicitly restrict weather.
   *
   * Plain scene particles do not need to route through the parent weather-occlusion filter when no such tiles exist. Skipping that filter in the simple case keeps compositor rendering aligned with the live scene during camera pan instead of sampling an unnecessary screen-space occlusion pass.
   *
   * @returns {boolean}
   */
  _sceneHasWeatherOcclusionTiles() {
    const cache = this._weatherOcclusionTilePresence ?? { key: null, value: false, time: 0 };
    const tiles = canvas?.tiles?.placeables ?? [];
    const now = Number(canvas?.app?.ticker?.lastTime ?? globalThis.performance?.now?.() ?? Date.now()) || 0;
    const sceneId = canvas?.scene?.id ?? "";
    const key = `${sceneId}|${tiles.length}`;

    if (cache.key === key && now - Number(cache.time ?? 0) < 250) return cache.value;

    let value = false;
    for (const tile of tiles) {
      if (!tile || tile.document?.hidden) continue;
      if (tile.visible === false || tile?.mesh?.visible === false || tile?.mesh?.renderable === false) continue;

      if (!isTileOverhead(tile)) continue;
      if (!tileHasActiveOcclusion(tile)) continue;
      if (!tileDocumentRestrictsWeather(tile)) continue;

      value = true;
      break;
    }

    this._weatherOcclusionTilePresence = { key, value, time: now };
    return value;
  }

  _sanitizeRegionMasks() {
    if (!this.regionEffects.size) return;

    const { cssW, cssH } = getCssViewportMetrics();

    for (const [regionId, entries] of this.regionEffects.entries()) {
      const shared = this._regionMaskRTs.get(regionId);
      for (const entry of entries) {
        const spr = entry?.maskSprite;
        const cont = entry?.container;
        if (!spr || spr.destroyed || !cont || cont.destroyed) continue;

        const want = chooseParticleMaskTexture(shared, !!entry?.fx?.__fxmBelowTokens, !!entry?.fx?.__fxmBelowTiles);

        suppressVisibleMaskPaint(spr);
        spr.texture = safeMaskTexture(want);
        if (!spr._texture || !spr._texture.orig) {
          try {
            spr.texture = safeMaskTexture(null);
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
        }
        if (!spr._texture || !spr._texture.orig) continue;
        try {
          spr.width = cssW;
          spr.height = cssH;
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        try {
          applyMaskSpriteTransform(cont, spr);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        if (cont.mask !== spr) {
          try {
            cont.mask = spr;
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
        }
      }
    }
  }

  /**
   * Keep Scene particle bucket masks in sync with viewport size and camera transforms.
   */
  _sanitizeSceneMasks() {
    const hasSceneBuckets =
      (!!this._sceneBelowBase && !this._sceneBelowBase.destroyed) ||
      (!!this._sceneBelowCutout && !this._sceneBelowCutout.destroyed) ||
      (!!this._sceneAboveBase && !this._sceneAboveBase.destroyed) ||
      (!!this._sceneAboveCutout && !this._sceneAboveCutout.destroyed);

    if (!hasSceneBuckets) return;

    const { cssW, cssH } = getCssViewportMetrics();

    const updateBucketMask = (bucket, spr) => {
      if (!bucket || bucket.destroyed || !spr || spr.destroyed) return;
      suppressVisibleMaskPaint(spr);

      if (!spr._fxmMaskEnabled) {
        if (bucket.mask === spr) {
          try {
            bucket.mask = null;
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
        }
        return;
      }

      /**
       * Skip updates when the sprite points at an invalid texture. PIXI's Sprite width/height setters read texture.orig dimensions and may throw.
       */
      if (!spr._texture || !spr._texture.orig) {
        if (bucket.mask === spr) {
          try {
            bucket.mask = null;
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
        }
        return;
      }

      try {
        spr.width = cssW;
        spr.height = cssH;
      } catch {
        if (bucket.mask === spr) {
          try {
            bucket.mask = null;
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
        }
        return;
      }

      try {
        applyMaskSpriteTransform(bucket, spr);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }

      if (bucket.mask !== spr) {
        try {
          bucket.mask = spr;
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }
    };

    updateBucketMask(this._sceneBelowBase, this._sceneBelowBaseMask);
    updateBucketMask(this._sceneBelowCutout, this._sceneBelowCutoutMask);
    updateBucketMask(this._sceneAboveBase, this._sceneAboveBaseMask);
    updateBucketMask(this._sceneAboveCutout, this._sceneAboveCutoutMask);

    const updateSceneRuntimeMask = (fx) => {
      if (!fx || fx.destroyed) return;
      const container = fx.__fxmSceneContainer ?? null;
      const maskSprite = fx.__fxmSceneMaskSprite ?? null;
      if (!container || container.destroyed || !maskSprite || maskSprite.destroyed) return;
      this._applySceneMaskToContainer(container, maskSprite, {
        belowTokens: !!fx.__fxmBelowTokens,
        belowTiles: !!fx.__fxmBelowTiles,
        belowForeground: !!fx.__fxmBelowForeground,
      });
    };

    for (const fx of this.particleEffects.values()) updateSceneRuntimeMask(fx);
    for (const fx of this._dyingSceneEffects) updateSceneRuntimeMask(fx);
  }

  _onCameraChange() {
    if (!canvas?.scene) return;

    const M = this._currentCameraMatrix ?? snappedStageMatrix();
    this.#updateSceneParticlesSuppressionForCamera(M);

    try {
      const { anyBelowTokens, anyBelowTiles } = this._collectBelowObjectCoverageNeeds();
      if (anyBelowTokens || anyBelowTiles) {
        SceneMaskManager.instance.refreshTokensSync?.();
        this._tokensDirty = true;
      } else {
        this._lastCutoutCamFrac = null;
      }
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    if (!this.regionEffects?.size) return;

    if (!cameraMatrixChanged(M, this._lastRegionMaskMatrix)) return;

    this._lastRegionMaskMatrix = { a: M.a, b: M.b, c: M.c, d: M.d, tx: M.tx, ty: M.ty };

    this.requestRegionMaskRefreshAll();
  }
}
