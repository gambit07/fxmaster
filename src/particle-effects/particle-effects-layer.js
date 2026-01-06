/**
 * FXMaster: Particle Effects Layer
 * Manages scene-level and region-level particle effects.
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
  composeMaskMinusTokensRT,
} from "../utils.js";
import { refreshSceneParticlesSuppressionMasks } from "./particle-effects-scene-manager.js";
import { BaseEffectsLayer } from "../common/base-effects-layer.js";
import { logger } from "../logger.js";
import { SceneMaskManager } from "../common/base-effects-scene-manager.js";

const TYPE = `${packageId}.particleEffectsRegion`;

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
    } catch {}
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
    } catch {}
    this._scratchGfx = null;

    // Above band
    try {
      if (this._aboveContent?.mask) this._aboveContent.mask = null;
    } catch {}
    try {
      this._aboveContent?.destroy({ children: true });
    } catch {}
    this._aboveContent = null;

    // Below band
    try {
      this._belowContainer?.destroy({ children: true });
    } catch {}
    this._belowContainer = null;

    // Bucket refs
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
    } catch {}
    this._aboveMaskGfx = null;

    try {
      this.filters = [];
    } catch {}
    this._belowOccl = null;
    this._aboveOccl = null;

    this._tokensDirty = false;
    this._lastSceneMaskMatrix = null;
    this._currentCameraMatrix = null;
    this._lastRegionMaskMatrix = null;

    return super._tearDown();
  }

  #destroyEffects() {
    // Scene FX
    for (const fx of this.particleEffects.values()) {
      try {
        fx.stop?.();
      } catch {}
      try {
        fx.destroy?.();
      } catch {}
    }
    this.particleEffects.clear();

    for (const fx of this._dyingSceneEffects) {
      try {
        fx.stop?.();
      } catch {}
      try {
        fx.destroy?.();
      } catch {}
    }
    this._dyingSceneEffects.clear();

    // Region FX
    for (const entries of this.regionEffects.values()) {
      for (const entry of entries) {
        const fx = entry?.fx ?? null;
        const container = entry?.container ?? null;
        const maskSprite = entry?.maskSprite ?? null;

        try {
          fx?.stop?.();
        } catch {}
        try {
          fx?.destroy?.();
        } catch {}

        try {
          if (container && maskSprite && container.mask === maskSprite) container.mask = null;
        } catch {}
        try {
          if (maskSprite && !maskSprite.destroyed) maskSprite.texture = safeMaskTexture(null);
        } catch {}

        try {
          container?.destroy?.({ children: true });
        } catch {}
        try {
          maskSprite?.destroy?.({ texture: false, baseTexture: false });
        } catch {}
      }
    }
    this.regionEffects.clear();

    try {
      for (const rtPair of this._regionMaskRTs.values()) {
        try {
          this._releaseRT(rtPair.base);
        } catch {}
        try {
          this._releaseRT(rtPair.cutout);
        } catch {}
      }
    } catch {}
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
   * Recompute whether any REGION particle effects require below-tokens cutouts,
   * and inform the shared {@link SceneMaskManager} so it can maintain the tokens RT.
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
    } catch {}

    if (this._regionBelowTokensNeeded === any) return;
    this._regionBelowTokensNeeded = any;

    try {
      SceneMaskManager.instance.setBelowTokensNeeded?.("particles", any, "regions");
    } catch {}
  }
  /**
   * Scene manager calls this after it refreshes SceneMaskManager RTs for particles.
   * @param {{ base: PIXI.RenderTexture|null, cutout: PIXI.RenderTexture|null }} masks
   */
  setSceneMaskTextures({ base = null, cutout = null } = {}) {
    const baseTex = base ?? PIXI.Texture.EMPTY;
    const cutoutTex = cutout ?? PIXI.Texture.EMPTY;

    const apply = (spr, tex, enabled) => {
      if (!spr || spr.destroyed) return;
      spr.texture = tex;
      spr._fxmMaskEnabled = !!enabled;
    };

    apply(this._sceneBelowBaseMask, baseTex, !!base);
    apply(this._sceneAboveBaseMask, baseTex, !!base);
    apply(this._sceneBelowCutoutMask, cutoutTex, !!cutout);
    apply(this._sceneAboveCutoutMask, cutoutTex, !!cutout);
  }

  #updateSceneParticlesSuppressionForCamera(M = this._currentCameraMatrix ?? snappedStageMatrix()) {
    const L = this._lastSceneMaskMatrix;
    const eps = 1e-4;
    const changed =
      !L ||
      Math.abs(L.a - M.a) > eps ||
      Math.abs(L.b - M.b) > eps ||
      Math.abs(L.c - M.c) > eps ||
      Math.abs(L.d - M.d) > eps ||
      Math.abs(L.tx - M.tx) > eps ||
      Math.abs(L.ty - M.ty) > eps;

    if (!changed) return;

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
            } catch {}
            try {
              fx.parent?.removeChild?.(fx);
            } catch {}
            try {
              fx.destroy?.();
            } catch {}
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
        } catch {}
        try {
          existing.blendMode = PIXI.BLEND_MODES.NORMAL;
        } catch {}

        const prev = existing._fxmOptsCache ?? {};
        const diff = foundry.utils.diffObject(prev, options);
        const changed = !foundry.utils.isEmpty(diff);

        if (!changed) {
          try {
            existing.play?.({ skipFading: soft });
          } catch {}
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
              } catch {}
              try {
                existing.parent?.removeChild?.(existing);
              } catch {}
              try {
                existing.destroy?.();
              } catch {}
              this._dyingSceneEffects.delete(existing);
            })(),
          );
          continue;
        }

        try {
          existing.stop?.();
        } catch {}
        try {
          existing.parent?.removeChild?.(existing);
        } catch {}
        try {
          existing.destroy?.();
        } catch {}
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
      } catch {}
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
      } catch {}
    }
  }

  async drawRegionParticleEffects(placeable, { soft = false } = {}) {
    const regionId = placeable.id;
    this._ensureSceneContainers();

    const old = this.regionEffects.get(regionId) || [];
    await Promise.all(
      old.map(async (entry) => {
        const fx = entry?.fx ?? entry;
        try {
          fx?.stop?.();
        } catch {}
        try {
          fx?.destroy?.();
        } catch {}
        try {
          entry?.container?.destroy?.({ children: true });
        } catch {}
        try {
          entry?.maskSprite?.destroy?.({ texture: false, baseTexture: false });
        } catch {}
      }),
    );
    this.regionEffects.set(regionId, []);

    let shared = this._regionMaskRTs.get(regionId);
    if (!shared) {
      shared = { base: buildRegionMaskRT(placeable, { rtPool: this._rtPool }), cutout: null };
      this._regionMaskRTs.set(regionId, shared);
    }

    const behaviors = (placeable?.document?.behaviors || []).filter((b) => b.type === TYPE && !b.disabled);
    if (!behaviors.length) return;

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
        try {
          fx.blendMode = defaultBM;
        } catch {}
        container.addChild(fx);

        if (layerLevel === "aboveDarkness") this._aboveContent.addChild(container);
        else this.addChild(container);

        if (!shared.base) shared.base = buildRegionMaskRT(placeable, { rtPool: this._rtPool });

        if (belowTokens && !shared.cutout) {
          try {
            SceneMaskManager.instance.setBelowTokensNeeded?.("particles", true, "regions");
          } catch {}
          try {
            SceneMaskManager.instance.refreshTokensSync?.();
          } catch {}
          const tokensRT = SceneMaskManager.instance.getMasks?.("particles")?.tokens ?? null;
          if (tokensRT) {
            const outRT = this._acquireRT(shared.base.width | 0, shared.base.height | 0, shared.base.resolution || 1);
            shared.cutout = composeMaskMinusTokensRT(shared.base, tokensRT, { outRT });
          }
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

  requestRegionMaskRefresh(regionId) {
    this._coalescedRegionRefresh ??= coalesceNextFrame((rid) => this.forceRegionMaskRefresh(rid), { key: this });
    this._coalescedRegionRefresh(regionId);
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
      } catch {}
      try {
        fx?.destroy?.();
      } catch {}
      try {
        if (container && container.mask === maskSprite) container.mask = null;
      } catch {}
      try {
        if (maskSprite && !maskSprite.destroyed) maskSprite.texture = safeMaskTexture(null);
      } catch {}
      try {
        if (container?.parent) container.parent.removeChild(container);
      } catch {}
      try {
        container?.destroy?.({ children: true });
      } catch {}
      try {
        maskSprite?.destroy?.({ texture: false, baseTexture: false });
      } catch {}
    }
    this.regionEffects.delete(regionId);
    this._updateRegionBelowTokensNeeded();

    const rt = this._regionMaskRTs.get(regionId);
    if (rt) {
      try {
        this._releaseRT(rt.base);
      } catch {}
      try {
        this._releaseRT(rt.cutout);
      } catch {}
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
    } catch {}
    if (this._aboveMaskGfx && !this._aboveMaskGfx.destroyed) {
      try {
        this._aboveMaskGfx.destroy(true);
      } catch {}
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
      } catch {}
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
      } catch {}
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
      } catch {}
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
      } catch {}
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
      } catch {}
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
        } catch {}
      } else if (spr.parent !== bucket) {
        try {
          spr.parent?.removeChild?.(spr);
        } catch {}
        try {
          bucket.addChild(spr);
        } catch {}
      }

      spr.width = cssW;
      spr.height = cssH;

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
      const reuse =
        !!shared.cutout &&
        shared.cutout.width === newBase.width &&
        shared.cutout.height === newBase.height &&
        (shared.cutout.resolution || 1) === (newBase.resolution || 1);
      try {
        SceneMaskManager.instance.refreshTokensSync?.();
      } catch {}
      const tokensRT = SceneMaskManager.instance.getMasks?.("particles")?.tokens ?? null;

      if (tokensRT) {
        const outRT = reuse
          ? shared.cutout
          : this._acquireRT(newBase.width | 0, newBase.height | 0, newBase.resolution || 1);
        shared.cutout = composeMaskMinusTokensRT(newBase, tokensRT, { outRT });
      } else if (shared.cutout && !reuse) {
        try {
          this._releaseRT(shared.cutout);
        } catch {}
        shared.cutout = null;
      }
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
      } catch {}
      try {
        applyMaskSpriteTransform(cont, spr);
      } catch {}
      if (cont.mask !== spr) {
        try {
          cont.mask = spr;
        } catch {}
      }
    }

    if (oldBase && oldBase !== newBase) this._releaseRT(oldBase);
  }

  _animate() {
    super._animate();

    this._sanitizeSceneMasks();

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
          } catch {}
          const tokensRT = SceneMaskManager.instance.getMasks?.("particles")?.tokens ?? null;

          if (tokensRT) {
            for (const [regionId, shared] of this._regionMaskRTs.entries()) {
              if (!shared?.base || !shared?.cutout) continue;
              const entries = this.regionEffects.get(regionId) ?? [];
              const anyBelow = entries.some((e) => !!e?.fx?.__fxmBelowTokens);
              if (!anyBelow) continue;
              composeMaskMinusTokensRT(shared.base, tokensRT, { outRT: shared.cutout });
            }
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
    } catch {}
  }

  applyElevationGateForAll() {
    try {
      for (const [regionId] of this.regionEffects) {
        const reg = canvas.regions?.get(regionId);
        if (reg) this._applyElevationGate(reg);
      }
    } catch {}
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
      } catch {}
      try {
        if (entry?.fx && "enabled" in entry.fx && entry.fx.enabled !== !!pass) entry.fx.enabled = !!pass;
      } catch {}
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
          } catch {}
        }
        if (!spr._texture || !spr._texture.orig) continue;
        try {
          spr.width = cssW;
          spr.height = cssH;
        } catch {}
        try {
          applyMaskSpriteTransform(cont, spr);
        } catch {}
        if (cont.mask !== spr) {
          try {
            cont.mask = spr;
          } catch {}
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
          } catch {}
        }
        return;
      }

      spr.width = cssW;
      spr.height = cssH;

      try {
        applyMaskSpriteTransform(bucket, spr);
      } catch {}

      if (bucket.mask !== spr) {
        try {
          bucket.mask = spr;
        } catch {}
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

    const L = this._lastRegionMaskMatrix;
    const eps = 1e-4;
    const changed =
      !L ||
      Math.abs(L.a - M.a) > eps ||
      Math.abs(L.b - M.b) > eps ||
      Math.abs(L.c - M.c) > eps ||
      Math.abs(L.d - M.d) > eps ||
      Math.abs(L.tx - M.tx) > eps ||
      Math.abs(L.ty - M.ty) > eps;

    if (!changed) return;

    this._lastRegionMaskMatrix = { a: M.a, b: M.b, c: M.c, d: M.d, tx: M.tx, ty: M.ty };

    this.requestRegionMaskRefreshAll();
  }
}
