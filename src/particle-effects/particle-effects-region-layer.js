/**
 * FXMaster: Particle Effects Region Layer
 * Manages scene-level and region-level particle effects, occlusion, and region masks.
 */

import { packageId } from "../constants.js";
import { logger } from "../logger.js";
import { isEnabled } from "../settings.js";
import {
  RTPool,
  composeMaskMinusTokens,
  safeMaskTexture,
  buildRegionMaskRT,
  applyMaskSpriteTransform,
  computeRegionGatePass,
  coalesceNextFrame,
  getCssViewportMetrics,
  snappedStageMatrix,
} from "../utils.js";
import { refreshSceneParticlesSuppressionMasks } from "./particle-effects-scene-manager.js";

const TYPE = `${packageId}.particleEffectsRegion`;

export class ParticleEffectsRegionLayer extends CONFIG.fxmaster.FullCanvasObjectMixinNS(CONFIG.fxmaster.CanvasLayerNS) {
  /**
   * Layer configuration for the canvas stack.
   * @returns {object}
   */
  static get layerOptions() {
    return foundry.utils.mergeObject(super.layerOptions, { name: "particle-effects" });
  }

  /**
   * Construct a new layer for particle effects.
   */
  constructor() {
    super();
    this.#initializeInverseOcclusionFilter();
    this.mask = canvas.masks.scene;
    this.sortableChildren = true;
    this.eventMode = "none";

    this.particleEffects = new Map();
    this.regionEffects = new Map();
    this._regionMaskRTs = new Map();
    this._rtPool = new RTPool();

    this._belowContainer = null;
    this._aboveContent = null;
    this._ticker = false;
    this._lastRegionsMatrix = null;
    this._scratchGfx = null;
    this._aboveMaskGfx = null;
    this._dyingSceneEffects = new Set();
    this._tearingDown = false;
    this._lastViewSize = { w: canvas.app.renderer.view?.width | 0, h: canvas.app.renderer.view?.height | 0 };

    this._gatePassCache = new Map();
    this._lastSceneMaskMatrix = null;
  }

  /** @type {WeatherOcclusionMaskFilter} */
  occlusionFilter;

  /**
   * Elevation key used by occlusion filters.
   * @type {number}
   */
  get elevation() {
    return this.#elevation;
  }
  set elevation(value) {
    if (typeof value !== "number" || Number.isNaN(value))
      throw new Error("ParticleEffectsRegionLayer#elevation must be numeric.");
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

  /**
   * Draw the layer and start the frame ticker.
   * @override
   * @returns {Promise<void>}
   */
  async _draw() {
    if (!isEnabled()) return;
    await this.#draw();
    if (!this._ticker) {
      const PRIO = PIXI.UPDATE_PRIORITY?.HIGH ?? 25;
      try {
        canvas.app.ticker.add(this.#tick, this, PRIO);
      } catch {
        canvas.app.ticker.add(this.#tick, this);
      }
      this._ticker = true;
    }
  }

  /**
   * Tear down the layer.
   * @returns {Promise<void>}
   * @protected
   */
  async _tearDown() {
    this._tearingDown = true;

    try {
      if (this.requestRegionMaskRefreshAll?.cancel) this.requestRegionMaskRefreshAll.cancel();
      if (this.requestRegionMaskRefresh?.cancel) this.requestRegionMaskRefresh.cancel();
    } catch {}

    if (this._ticker) {
      try {
        canvas.app.ticker.remove(this.#tick, this);
      } catch {}
      this._ticker = false;
    }

    this._lastRegionsMatrix = null;

    this.#destroyEffects();

    try {
      this._scratchGfx?.destroy(true);
    } catch {}
    this._scratchGfx = null;

    try {
      if (this._aboveContent?.mask) this._aboveContent.mask = null;
    } catch {}
    try {
      this._aboveContent?.destroy({ children: true });
    } catch {}
    this._aboveContent = null;

    try {
      this._belowContainer?.destroy({ children: true });
    } catch {}
    this._belowContainer = null;

    try {
      this._aboveMaskGfx?.destroy(true);
    } catch {}
    this._aboveMaskGfx = null;

    try {
      this.filters = [];
    } catch {}
    try {
      if (this._belowContainer) this._belowContainer.filters = [];
    } catch {}
    try {
      if (this._aboveContent) this._aboveContent.filters = [];
    } catch {}
    this._belowOccl = null;
    this._aboveOccl = null;

    this._drainRtPool();

    const res = await super._tearDown();
    this._tearingDown = false;
    return res;
  }

  /**
   * Destroy all live effects, sprites, and render textures.
   * @private
   */
  #destroyEffects() {
    for (const fx of this.particleEffects.values()) {
      try {
        fx.stop?.();
      } catch {}
      try {
        const spr = fx?._fxmSceneParticlesMaskSprite;
        if (spr && !spr.destroyed) {
          try {
            if (fx.mask === spr) fx.mask = null;
          } catch {}
          try {
            spr.texture = safeMaskTexture(null);
          } catch {}
          try {
            fx.removeChild(spr);
          } catch {}
          try {
            spr.destroy({ texture: false, baseTexture: false });
          } catch {}
        }
      } catch {}
      try {
        fx.destroy?.();
      } catch {}
    }
    this.particleEffects.clear();

    for (const fx of this._dyingSceneEffects) {
      try {
        const spr = fx?._fxmSceneParticlesMaskSprite;
        if (spr && !spr.destroyed) {
          try {
            if (fx.mask === spr) fx.mask = null;
          } catch {}
          try {
            spr.texture = safeMaskTexture(null);
          } catch {}
          try {
            fx.removeChild(spr);
          } catch {}
          try {
            spr.destroy({ texture: false, baseTexture: false });
          } catch {}
        }
      } catch {}
      try {
        fx.stop?.();
      } catch {}
      try {
        fx.destroy?.();
      } catch {}
    }
    this._dyingSceneEffects.clear();

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

    try {
      this._drainRtPool();
    } catch {}
  }

  /**
   * Internal draw entry for scene effects.
   * @private
   * @returns {Promise<void>}
   */
  async #draw() {
    await this.drawParticleEffects();
  }

  #updateSceneParticlesSuppressionForCamera() {
    if (!canvas?.scene) return;

    const hasSceneFx = (this.particleEffects && this.particleEffects.size > 0) || canvas.weather?.children?.length > 0;

    if (!hasSceneFx) return;

    const M = snappedStageMatrix(canvas.regions ?? canvas.stage);
    const last = this._lastSceneMaskMatrix;

    const eps = 1e-4;
    if (
      last &&
      Math.abs(M.a - last.a) < eps &&
      Math.abs(M.b - last.b) < eps &&
      Math.abs(M.c - last.c) < eps &&
      Math.abs(M.d - last.d) < eps &&
      Math.abs(M.tx - last.tx) < eps &&
      Math.abs(M.ty - last.ty) < eps
    ) {
      return;
    }

    this._lastSceneMaskMatrix = { a: M.a, b: M.b, c: M.c, d: M.d, tx: M.tx, ty: M.ty };

    try {
      refreshSceneParticlesSuppressionMasks?.();
    } catch {}
  }

  /**
   * Reconcile scene flags with live scene-level particle effects.
   * @param {{soft?: boolean}} [opts]
   * @returns {Promise<void>}
   */
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
              const spr = fx._fxmSceneParticlesMaskSprite;
              if (spr && !spr.destroyed) {
                try {
                  if (fx.mask === spr) fx.mask = null;
                } catch {}
                try {
                  spr.texture = safeMaskTexture(null);
                } catch {}
                try {
                  fx.removeChild(spr);
                } catch {}
                try {
                  spr.destroy({ texture: false, baseTexture: false });
                } catch {}
              }
              fx._fxmSceneParticlesMaskSprite = null;
            } catch {}
            try {
              fx.destroy?.();
            } catch {}
            try {
              fx.parent?.removeChild?.(fx);
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

      const addToLayer = (fx) => {
        const { layerLevel = "belowDarkness" } = EffectClass.defaultConfig || {};
        if (layerLevel === "aboveDarkness") this._aboveContent.addChild(fx);
        else this._belowContainer.addChild(fx);
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
                const spr = existing._fxmSceneParticlesMaskSprite;
                if (spr && !spr.destroyed) {
                  try {
                    if (existing.mask === spr) existing.mask = null;
                  } catch {}
                  try {
                    spr.texture = safeMaskTexture(null);
                  } catch {}
                  try {
                    existing.removeChild(spr);
                  } catch {}
                  try {
                    spr.destroy({ texture: false, baseTexture: false });
                  } catch {}
                }
                existing._fxmSceneParticlesMaskSprite = null;
              } catch {}
              try {
                existing.destroy?.();
              } catch {}
              try {
                existing.parent?.removeChild?.(existing);
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
          existing.destroy?.();
        } catch {}
        try {
          existing.parent?.removeChild?.(existing);
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

    if (removalPromises.length) {
      try {
        await Promise.all(removalPromises);
      } catch {}
    }
  }

  /**
   * Draw all particle effects for a region and establish a mask per entry.
   * @param {PlaceableObject} placeable
   * @param {{soft?: boolean}} [opts]
   * @returns {Promise<void>}
   */
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

    const { deviceRect } = getCssViewportMetrics();
    const VW = deviceRect.width | 0;
    const VH = deviceRect.height | 0;

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
          const outRT = this._acquireRT(shared.base.width | 0, shared.base.height | 0, shared.base.resolution || 1);
          shared.cutout = composeMaskMinusTokens(shared.base, { outRT });
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
  }

  /**
   * Rebuild region masks for all active regions.
   */
  forceRegionMaskRefreshAll() {
    if (!this.regionEffects.size) return;
    for (const [regionId] of this.regionEffects.entries()) {
      const placeable = canvas.regions?.get(regionId);
      if (placeable) this._rebuildRegionMaskFor(placeable);
    }
  }

  /**
   * Rebuild region mask for a specific region.
   * @param {string} regionId
   */
  forceRegionMaskRefresh(regionId) {
    const placeable = canvas.regions?.get(regionId);
    if (!placeable) return;
    this._rebuildRegionMaskFor(placeable);
  }

  /**
   * Schedule a single-region mask refresh on the next animation frame.
   * @param {string} regionId
   */
  requestRegionMaskRefresh(regionId) {
    this._coalescedRegionRefresh ??= coalesceNextFrame(
      function (rid) {
        this.forceRegionMaskRefresh(rid);
      },
      { key: this },
    );
    this._coalescedRegionRefresh(regionId);
  }

  /**
   * Schedule a full mask refresh on the next animation frame.
   */
  requestRegionMaskRefreshAll() {
    this._coalescedRefreshAll ??= coalesceNextFrame(
      function () {
        this.forceRegionMaskRefreshAll();
      },
      { key: this },
    );
    this._coalescedRefreshAll();
  }

  /**
   * Destroy all particle-effect entries for a region and release its RTs.
   * @param {string} regionId
   */
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

  /**
   * Initialize the layer-level inverse occlusion filter.
   * @private
   */
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

  /**
   * Apply the scene mask to the above-darkness host.
   */
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

  /**
   * Ensure scene-level host containers exist and carry occlusion filters.
   * @private
   */
  _ensureSceneContainers() {
    if (!this._belowContainer || this._belowContainer.destroyed) {
      this._belowContainer = new PIXI.Container();
      this._belowContainer.name = "fxmSceneBelowDarkness";
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
    } else if (this._belowContainer.parent !== this) {
      try {
        this._belowContainer.parent?.removeChild?.(this._belowContainer);
      } catch {}
      this.addChild(this._belowContainer);
      if (!this._belowOccl) {
        this._belowOccl = CONFIG.fxmaster.WeatherOcclusionMaskFilterNS.create({
          occlusionTexture: canvas.masks.depth.renderTexture,
        });
        this._belowOccl.enabled = false;
        this._belowOccl.elevation = this.#elevation;
        this._belowOccl.blendMode = PIXI.BLEND_MODES.NORMAL;
      }
      this._belowContainer.filters = [this._belowOccl];
      this._belowContainer.filterArea = canvas.app.renderer.screen;
    }

    const expectParent = canvas.effects ?? canvas.rendered ?? this;
    if (!this._aboveContent || this._aboveContent.destroyed) {
      this._aboveContent = new PIXI.Container();
      this._aboveContent.name = "fxmSceneAboveDarknessContent";
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
    } else {
      if (this._aboveContent.parent !== expectParent) {
        try {
          this._aboveContent.parent?.removeChild?.(this._aboveContent);
        } catch {}
        expectParent.addChild(this._aboveContent);
        this.refreshAboveSceneMask();
      }
      if (!this._aboveOccl) {
        this._aboveOccl = CONFIG.fxmaster.WeatherOcclusionMaskFilterNS.create({
          occlusionTexture: canvas.masks.depth.renderTexture,
        });
        this._aboveOccl.enabled = false;
        this._aboveOccl.elevation = this.#elevation;
        this._aboveOccl.blendMode = PIXI.BLEND_MODES.NORMAL;
      }
      this._aboveContent.filters = [this._aboveOccl];
      this._aboveContent.filterArea = canvas.app.renderer.screen;
    }

    this._updateOcclusionGates();
  }

  /**
   * Rebuild the mask RT and sprite for a single region to match the current view.
   * @param {PlaceableObject} placeable
   * @private
   */
  _rebuildRegionMaskFor(placeable) {
    const regionId = placeable.id;
    const entries = this.regionEffects.get(regionId);
    if (!entries?.length) return;

    const { deviceRect } = getCssViewportMetrics();
    const VW = deviceRect.width | 0;
    const VH = deviceRect.height | 0;

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
      const outRT = reuse
        ? shared.cutout
        : this._acquireRT(newBase.width | 0, newBase.height | 0, newBase.resolution || 1);
      shared.cutout = composeMaskMinusTokens(newBase, { outRT });
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

      spr.width = VW;
      spr.height = VH;
      applyMaskSpriteTransform(cont, spr);
      if (cont.mask !== spr) {
        try {
          cont.mask = spr;
        } catch {}
      }
    }

    if (oldBase && oldBase !== newBase) this._releaseRT(oldBase);
  }

  /**
   * Per-frame watcher driving mask rebuilds and elevation gating.
   * @private
   */
  #tick() {
    if (this._tearingDown) return;

    this.#updateSceneParticlesSuppressionForCamera();

    if (this.regionEffects.size === 0) return;

    const r = canvas?.app?.renderer;
    if (r) {
      const w = r.view?.width | 0 || r.screen?.width | 0 || 1;
      const h = r.view?.height | 0 || r.screen?.height | 0 || 1;
      if (w !== this._lastViewSize.w || h !== this._lastViewSize.h) {
        this._lastViewSize = { w, h };
        this.forceRegionMaskRefreshAll();
      }
    }

    const Msnap = snappedStageMatrix();
    if (Msnap) {
      const M = { a: Msnap.a, b: Msnap.b, c: Msnap.c, d: Msnap.d, tx: Msnap.tx, ty: Msnap.ty };
      const L = this._lastRegionsMatrix;
      const eps = 1e-4;
      const changed =
        !L ||
        Math.abs(L.a - M.a) > eps ||
        Math.abs(L.b - M.b) > eps ||
        Math.abs(L.c - M.c) > eps ||
        Math.abs(L.d - M.d) > eps ||
        Math.abs(L.tx - M.tx) > eps ||
        Math.abs(L.ty - M.ty) > eps;
      if (changed) {
        this.forceRegionMaskRefreshAll();
        this._lastRegionsMatrix = M;
      }
    }

    this._sanitizeRegionMasks();

    try {
      for (const [regionId] of this.regionEffects) {
        const reg = canvas.regions?.get(regionId);
        if (reg) this._applyElevationGate(reg);
      }
    } catch {}
  }

  /**
   * Re-apply the elevation gate for all active regions.
   */
  applyElevationGateForAll() {
    try {
      for (const [regionId] of this.regionEffects) {
        const reg = canvas.regions?.get(regionId);
        if (reg) this._applyElevationGate(reg);
      }
    } catch {}
  }

  /**
   * Apply elevation/visibility gate to region entries.
   * @param {PlaceableObject} placeable
   * @param {{force?: boolean}} [opts]
   * @private
   */
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

  /**
   * Enable or disable occlusion filters based on current content.
   * @private
   */
  _updateOcclusionGates() {
    const hasBelow =
      !!this._belowContainer && !this._belowContainer.destroyed && this._belowContainer.children?.length > 0;
    const hasAbove = !!this._aboveContent && !this._aboveContent.destroyed && this._aboveContent.children?.length > 0;

    if (this.occlusionFilter) {
      const hasUnderLayer = hasBelow || this._hasRegionDefaultFX();
      this.occlusionFilter.enabled = !!hasUnderLayer;
      this.occlusionFilter.elevation = this.#elevation;
    }

    if (this._belowOccl) {
      this._belowOccl.enabled = !!hasBelow;
      this._belowOccl.elevation = this.#elevation;
    }
    if (this._aboveOccl) {
      this._aboveOccl.enabled = !!hasAbove;
      this._aboveOccl.elevation = this.#elevation;
    }
  }

  /**
   * Detect if any region FX container is mounted directly under this layer.
   * @returns {boolean}
   * @private
   */
  _hasRegionDefaultFX() {
    for (const entries of this.regionEffects.values()) {
      for (const e of entries) if (e?.container?.parent === this) return true;
    }
    return false;
  }

  /**
   * Sanitize all region mask sprites to ensure valid textures and transforms.
   * @private
   */
  _sanitizeRegionMasks() {
    if (!this.regionEffects.size) return;
    const { deviceRect } = getCssViewportMetrics();
    const VW = deviceRect.width | 0;
    const VH = deviceRect.height | 0;

    for (const [regionId, entries] of this.regionEffects.entries()) {
      const shared = this._regionMaskRTs.get(regionId);
      for (const entry of entries) {
        const spr = entry?.maskSprite;
        const cont = entry?.container;
        if (!spr || spr.destroyed || !cont || cont.destroyed) continue;

        const want = entry?.fx?.__fxmBelowTokens ? shared?.cutout || shared?.base || null : shared?.base || null;
        spr.texture = safeMaskTexture(want);
        spr.width = VW;
        spr.height = VH;
        applyMaskSpriteTransform(cont, spr);
        if (cont.mask !== spr) cont.mask = spr;
      }
    }
  }

  /**
   * Acquire a pooled RenderTexture.
   * @param {number} w
   * @param {number} h
   * @param {number} res
   * @returns {PIXI.RenderTexture}
   * @private
   */
  _acquireRT(w, h, res) {
    return this._rtPool.acquire(w, h, res);
  }

  /**
   * Release a RenderTexture back to the pool.
   * @param {PIXI.RenderTexture} rt
   * @private
   */
  _releaseRT(rt) {
    return this._rtPool.release(rt);
  }

  /**
   * Drain the RT pool.
   * @private
   */
  _drainRtPool() {
    return this._rtPool.drain();
  }
}
