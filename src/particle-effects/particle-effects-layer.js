/**
 * FXMaster: Particle Effects Layer - manages scene-level and region-level particle effects.
 */

import { packageId } from "../constants.js";
import { isEnabled } from "../settings.js";
import {
  safeMaskTexture,
  buildRegionMaskRT,
  applyMaskSpriteTransform,
  computeRegionGatePass,
  coalesceNextFrame,
  getCssViewportMetrics,
  snappedStageMatrix,
  cameraMatrixChanged,
  composeMaskMinusTokens,
  composeMaskMinusTokensRT,
  estimateRegionInradius,
  regionWorldBounds,
} from "../utils.js";
import { refreshSceneParticlesSuppressionMasks } from "./particle-effects-scene-manager.js";
import { BaseEffectsLayer } from "../common/base-effects-layer.js";
import { logger } from "../logger.js";
import { SceneMaskManager } from "../common/base-effects-scene-manager.js";
import { fxmForEachEmitterParticle } from "./effects/effect.js";

const TYPE = `${packageId}.particleEffectsRegion`;

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
    this._regionMaskRTs = new Map();
    this._regionBelowTokensNeeded = false;

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

    this._lastSceneMaskMatrix = null;
    this._currentCameraMatrix = null;

    this._lastRegionMaskMatrix = null;

    this._tokensDirty = false;

    this._coalescedSceneSuppressionRefresh = null;
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
    this._lastRegionMaskMatrix = null;

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
    }
    this._dyingSceneEffects.clear();

    /** Destroy all region-level particle effects and associated mask sprites. */
    for (const entries of this.regionEffects.values()) {
      for (const entry of entries) {
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
        try {
          if (maskSprite && !maskSprite.destroyed) maskSprite.texture = safeMaskTexture(null);
        } catch (err) {
          logger.debug("FXMaster:", err);
        }

        try {
          container?.destroy?.({ children: true });
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        try {
          maskSprite?.destroy?.({ texture: false, baseTexture: false });
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
          this._releaseRT(rtPair.cutout);
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
   * Recompute whether any REGION particle effects require below-tokens cutouts, and inform the shared {@link SceneMaskManager} so it can maintain the tokens RT.
   * @private
   */
  _updateRegionBelowTokensNeeded() {
    let any = false;
    try {
      for (const entries of this.regionEffects.values()) {
        if ((entries ?? []).some((e) => !!e?.fx?.__fxmBelowTokens)) {
          any = true;
          break;
        }
      }
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    if (this._regionBelowTokensNeeded === any) return;
    this._regionBelowTokensNeeded = any;

    try {
      SceneMaskManager.instance.setBelowTokensNeeded?.("particles", any, "regions");
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }
  /**
   * Scene manager calls this after it refreshes SceneMaskManager RTs for particles.
   * @param {{ base: PIXI.RenderTexture|null, cutout: PIXI.RenderTexture|null }} masks
   */
  setSceneMaskTextures({ base = null, cutout = null } = {}) {
    const baseValid = !!base && !base.destroyed && !!base.orig && !base.baseTexture?.destroyed;
    const cutoutValid = !!cutout && !cutout.destroyed && !!cutout.orig && !cutout.baseTexture?.destroyed;

    const apply = (spr, tex, enabled) => {
      if (!spr || spr.destroyed) return;
      spr.texture = tex ?? PIXI.Texture.EMPTY;
      spr._fxmMaskEnabled = !!enabled;
    };

    apply(this._sceneBelowBaseMask, baseValid ? base : PIXI.Texture.EMPTY, baseValid);
    apply(this._sceneAboveBaseMask, baseValid ? base : PIXI.Texture.EMPTY, baseValid);
    apply(this._sceneBelowCutoutMask, cutoutValid ? cutout : PIXI.Texture.EMPTY, cutoutValid);
    apply(this._sceneAboveCutoutMask, cutoutValid ? cutout : PIXI.Texture.EMPTY, cutoutValid);
  }

  #updateSceneParticlesSuppressionForCamera(M = this._currentCameraMatrix ?? snappedStageMatrix()) {
    if (!cameraMatrixChanged(M, this._lastSceneMaskMatrix)) return;

    this._lastSceneMaskMatrix = { a: M.a, b: M.b, c: M.c, d: M.d, tx: M.tx, ty: M.ty };

    this._coalescedSceneSuppressionRefresh ??= coalesceNextFrame(
      () => {
        try {
          refreshSceneParticlesSuppressionMasks();
        } catch (err) {
          logger?.error?.(err);
        }
      },
      { key: "fxm:sceneParticlesSuppressionRefresh" },
    );
    this._coalescedSceneSuppressionRefresh();
  }

  async drawParticleEffects({ soft = false } = {}) {
    if (!canvas.scene) return;

    this._ensureSceneContainers();

    const cur = this.particleEffects;
    let flags = canvas.scene.getFlag(packageId, "effects") ?? {};

    const removalPromises = [];
    for (const [id, fx] of cur) {
      if (!(id in flags)) {
        this._dyingSceneEffects.add(fx);
        cur.delete(id);

        removalPromises.push(
          (async () => {
            try {
              if (soft && fx.fadeOut) await fx.fadeOut({ timeout: 5000 });
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
            this._dyingSceneEffects.delete(fx);
          })(),
        );
      }
    }

    flags = canvas.scene?.getFlag(packageId, "effects") ?? {};

    let zIndex = 0;
    for (const [id, { type, options: flagOptions }] of Object.entries(flags)) {
      if (!(type in CONFIG.fxmaster.particleEffects)) {
        logger.warn(game.i18n.format("FXMASTER.Particles.TypeErrors.TypeUnknown", { id, type: flags[id]?.type }));
        continue;
      }

      const options = Object.fromEntries(Object.entries(flagOptions ?? {}).map(([k, v]) => [k, { value: v }]));
      const EffectClass = CONFIG.fxmaster.particleEffects[type];
      const defaultBlend = EffectClass?.defaultConfig?.blendMode ?? PIXI.BLEND_MODES.NORMAL;
      const existing = cur.get(id);

      const belowTokens = !!options?.belowTokens?.value;

      const addToLayer = (fx) => {
        const { layerLevel = "belowDarkness" } = EffectClass.defaultConfig || {};
        fx.__fxmBelowTokens = belowTokens;

        if (layerLevel === "aboveDarkness") {
          if (belowTokens) this._sceneAboveCutout.addChild(fx);
          else this._sceneAboveBase.addChild(fx);
        } else {
          if (belowTokens) this._sceneBelowCutout.addChild(fx);
          else this._sceneBelowBase.addChild(fx);
        }
      };

      if (existing) {
        const XFADE_MS = 2500;
        try {
          existing.zIndex = zIndex++;
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        try {
          existing.blendMode = PIXI.BLEND_MODES.NORMAL;
        } catch (err) {
          logger.debug("FXMaster:", err);
        }

        const prev = existing._fxmOptsCache ?? {};
        const diff = foundry.utils.diffObject(prev, options);
        const changed = !foundry.utils.isEmpty(diff);

        if (!changed) {
          try {
            existing.play?.({ skipFading: soft });
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
          continue;
        }

        if (soft) {
          const ec = new EffectClass(options);
          ec.zIndex = existing.zIndex ?? zIndex - 1;
          ec.blendMode = PIXI.BLEND_MODES.NORMAL;
          ec._fxmOptsCache = foundry.utils.deepClone(options);
          ec.alpha = 0;
          addToLayer(ec);
          cur.set(id, ec);
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
        cur.delete(id);

        const ec = new EffectClass(options);
        ec.zIndex = existing.zIndex ?? zIndex - 1;
        ec.blendMode = PIXI.BLEND_MODES.NORMAL;
        ec._fxmOptsCache = foundry.utils.deepClone(options);
        addToLayer(ec);
        cur.set(id, ec);
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
      ec.play({ prewarm: !soft });
    }

    this._updateOcclusionGates();
    this._updateRegionBelowTokensNeeded();

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
        try {
          entry?.container?.destroy?.({ children: true });
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        try {
          entry?.maskSprite?.destroy?.({ texture: false, baseTexture: false });
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

    const edgeFadePercent = this._getRegionEdgeFadePercent(placeable, behaviors);
    const edgeFadeCtx = this._buildPerParticleEdgeFadeContext(placeable, edgeFadePercent);
    const regionParticleContext = buildRegionParticleContext(placeable);

    let shared = this._regionMaskRTs.get(regionId);
    if (!shared) {
      shared = { base: null, cutout: null };
      this._regionMaskRTs.set(regionId, shared);
    }

    const oldBase = shared.base;
    const oldCutout = shared.cutout;

    shared.base = buildRegionMaskRT(placeable, { rtPool: this._rtPool });
    shared.cutout = null;

    if (oldBase && oldBase !== shared.base) {
      try {
        this._releaseRT(oldBase);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
    if (oldCutout) {
      try {
        this._releaseRT(oldCutout);
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
        const EffectClass = CONFIG.fxmaster.particleEffects[type];
        if (!EffectClass) continue;

        const { layerLevel = "belowDarkness" } = EffectClass?.defaultConfig || {};
        const defaultBM = EffectClass?.defaultConfig?.blendMode ?? PIXI.BLEND_MODES.NORMAL;

        const effectOptions = Object.fromEntries(
          Object.entries(params?.options ?? {}).map(([k, v]) => [k, { value: v }]),
        );
        if (regionParticleContext) effectOptions.__fxmParticleContext = regionParticleContext;
        const belowTokens = !!params?.belowTokens;

        const container = new PIXI.Container();
        container.sortableChildren = true;
        container.eventMode = "none";

        const spr = new PIXI.Sprite(safeMaskTexture(null));
        spr.name = "fxmRegionMaskSprite";
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

        if (layerLevel === "aboveDarkness") this._aboveContent.addChild(container);
        else this.addChild(container);

        if (!shared.base) shared.base = buildRegionMaskRT(placeable, { rtPool: this._rtPool });

        if (belowTokens && !shared.cutout) {
          try {
            SceneMaskManager.instance.setBelowTokensNeeded?.("particles", true, "regions");
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
          try {
            SceneMaskManager.instance.refreshTokensSync?.();
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
          const tokensRT = SceneMaskManager.instance.getMasks?.("particles")?.tokens ?? null;
          const outRT = this._acquireRT(shared.base.width | 0, shared.base.height | 0, shared.base.resolution || 1);
          shared.cutout = tokensRT
            ? composeMaskMinusTokensRT(shared.base, tokensRT, { outRT })
            : composeMaskMinusTokens(shared.base, { outRT });
        }

        const maskTex = belowTokens && shared.cutout ? shared.cutout : shared.base;
        spr.texture = safeMaskTexture(maskTex);
        container.mask = spr;

        applyMaskSpriteTransform(container, spr);

        this.regionEffects.get(regionId).push({ fx, container, maskSprite: spr });
        fx.play({ prewarm: !soft });

        fx.__fxmBelowTokens = belowTokens;
      }
    }

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
   * Schedule a mask refresh for one or more regions on the next animation frame.
   * Multiple calls within the same frame are batched so that no region ID is lost.
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

  destroyRegionParticleEffects(regionId) {
    const entries = this.regionEffects.get(regionId) || [];
    for (const entry of entries) {
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
      try {
        if (maskSprite && !maskSprite.destroyed) maskSprite.texture = safeMaskTexture(null);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      try {
        if (container?.parent) container.parent.removeChild(container);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      try {
        container?.destroy?.({ children: true });
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      try {
        maskSprite?.destroy?.({ texture: false, baseTexture: false });
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
    this.regionEffects.delete(regionId);
    this._updateRegionBelowTokensNeeded();

    const rt = this._regionMaskRTs.get(regionId);
    if (rt) {
      try {
        this._releaseRT(rt.base);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      try {
        this._releaseRT(rt.cutout);
      } catch (err) {
        logger.debug("FXMaster:", err);
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
    let shared = this._regionMaskRTs.get(regionId) || { base: null, cutout: null };
    const oldBase = shared.base;
    shared.base = newBase;

    const anyBelow = entries.some((e) => !!e?.fx?.__fxmBelowTokens);
    if (anyBelow) {
      try {
        SceneMaskManager.instance.setBelowTokensNeeded?.("particles", true, "regions");
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      const reuse =
        !!shared.cutout &&
        shared.cutout.width === newBase.width &&
        shared.cutout.height === newBase.height &&
        (shared.cutout.resolution || 1) === (newBase.resolution || 1);
      try {
        SceneMaskManager.instance.refreshTokensSync?.();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      const tokensRT = SceneMaskManager.instance.getMasks?.("particles")?.tokens ?? null;

      const outRT = reuse
        ? shared.cutout
        : this._acquireRT(newBase.width | 0, newBase.height | 0, newBase.resolution || 1);

      shared.cutout = tokensRT
        ? composeMaskMinusTokensRT(newBase, tokensRT, { outRT })
        : composeMaskMinusTokens(newBase, { outRT });
    } else {
      if (shared.cutout) {
        this._releaseRT(shared.cutout);
        shared.cutout = null;
      }
    }
    this._regionMaskRTs.set(regionId, shared);

    for (const entry of entries) {
      const spr = entry?.maskSprite;
      const cont = entry?.container;
      if (!spr || spr.destroyed || !cont || cont.destroyed) continue;

      const want = entry?.fx?.__fxmBelowTokens && shared.cutout ? shared.cutout : shared.base;
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
   * Compute the region-edge fade percent for particle effects (0..1).
   * If multiple particle behaviors exist on the region, the maximum is used.
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

      /* Tight AABB for fast rejection and hole-distance lower bounds. */
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

      /*
       * Precompute per-edge data for fast point-to-segment distance.
       * Layout per edge: [ax, ay, bx, by, abx, aby, invDenom]
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

        /* Tight AABB for a rotated rectangle. */
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

        /* Tight AABB for a rotated ellipse. */
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

      /* Fallback for unusual shapes: if it has a points array, treat it as a polygon. */
      if (Array.isArray(s?.points) && s.points.length) {
        addPoly(s.points, hole, rotRad);
      }
    }

    if (!solids.length) return null;

    const sdRect = (px, py, r) => {
      /* Rotate by -rot using c=cos(rot), s=sin(rot). */
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
        //const bx = edges[o + 2];
        const by = edges[o + 3];
        const abx = edges[o + 4];
        const aby = edges[o + 5];
        const inv = edges[o + 6];

        /* Even-odd rule (ray cast on +X). */
        const intersect = ay > py !== by > py && px < (abx * (py - ay)) / (by - ay + 1e-12) + ax;
        if (intersect) inside = !inside;

        /* Point-to-segment distance squared (one sqrt at the end). */
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
      /* Union of solids: inside-distance is max of per-shape inside distances. */
      let insideSolid = 0;

      for (const sh of solids) {
        /* Fast AABB reject: if point is outside, it cannot be inside the shape. */
        if (x < sh.minX || x > sh.maxX || y < sh.minY || y > sh.maxY) continue;

        const sd = shapeSd(x, y, sh);
        if (sd < 0) {
          const d = -sd;
          if (d > insideSolid) insideSolid = d;

          /* Once at or beyond the fade band, additional precision is unnecessary. */
          if (insideSolid >= bandWorld) {
            insideSolid = bandWorld;
            break;
          }
        }
      }

      if (!(insideSolid > 0)) return 0;

      /* No holes: return directly (including early-out at full opacity). */
      if (!holes.length) return insideSolid >= bandWorld ? 1 : smooth01(insideSolid / bandWorld);

      /* Holes: nearest boundary can also be a hole boundary. */
      let holeMin = Infinity;
      let holeMin2 = Infinity;

      for (const sh of holes) {
        /*
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

          /* Cannot do better than zero; allow a small epsilon to stop scanning. */
          if (holeMin <= 1e-6) break;
        }
      }

      if (Number.isFinite(holeMin)) insideSolid = Math.min(insideSolid, holeMin);

      /* Early-out: fully inside the fade band even after accounting for holes. */
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
        /* Restore unfaded alpha from the previous frame to prevent compounding. */
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

            /* PIXI particles expose numeric x/y values in world space. */
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
      this._sanitizeSceneMasks();
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
        this._updateRegionBelowTokensNeeded();

        if (this._regionBelowTokensNeeded) {
          try {
            SceneMaskManager.instance.refreshTokensSync?.();
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
          const tokensRT = SceneMaskManager.instance.getMasks?.("particles")?.tokens ?? null;

          for (const [regionId, shared] of this._regionMaskRTs.entries()) {
            if (!shared?.base || !shared?.cutout) continue;
            const entries = this.regionEffects.get(regionId) ?? [];
            const anyBelow = entries.some((e) => !!e?.fx?.__fxmBelowTokens);
            if (!anyBelow) continue;

            if (tokensRT) composeMaskMinusTokensRT(shared.base, tokensRT, { outRT: shared.cutout });
            else composeMaskMinusTokens(shared.base, { outRT: shared.cutout });
          }
        }
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
      const hasUnderLayer = hasBelowScene || this._hasRegionDefaultFX();
      this.occlusionFilter.enabled = !!hasUnderLayer;
      this.occlusionFilter.elevation = this.#elevation;
    }

    if (this._belowOccl) {
      this._belowOccl.enabled = !!hasBelowScene;
      this._belowOccl.elevation = this.#elevation;
    }
    if (this._aboveOccl) {
      this._aboveOccl.enabled = !!hasAboveScene;
      this._aboveOccl.elevation = this.#elevation;
    }
  }

  _hasRegionDefaultFX() {
    for (const entries of this.regionEffects.values()) {
      for (const e of entries) if (e?.container?.parent === this) return true;
    }
    return false;
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

        const want = entry?.fx?.__fxmBelowTokens ? shared?.cutout || shared?.base || null : shared?.base || null;

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
       * Skip updates when the sprite points at an invalid texture.
       * PIXI's Sprite width/height setters read texture.orig dimensions and may throw.
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
  }

  _onCameraChange() {
    if (!canvas?.scene) return;

    const M = this._currentCameraMatrix ?? snappedStageMatrix();
    this.#updateSceneParticlesSuppressionForCamera(M);

    if (!this.regionEffects?.size) return;

    if (!cameraMatrixChanged(M, this._lastRegionMaskMatrix)) return;

    this._lastRegionMaskMatrix = { a: M.a, b: M.b, c: M.c, d: M.d, tx: M.tx, ty: M.ty };

    this.requestRegionMaskRefreshAll();
  }
}
