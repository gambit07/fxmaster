/**
 * ParticleEffectsRegionLayer
 * --------------------
 * Manages scene-level and region-level particle effects in FXMaster.
 * - Maintains two host containers for draw order (below/above darkness).
 * - Applies an inverse occlusion mask so particles respect walls/lighting.
 * - For regions, builds and maintains screen-space render-texture masks that
 *   clip particle effects to region shapes, updating on camera changes.
 * - Exposes helpers to draw, refresh, and destroy scene/region effects.
 */

import { packageId } from "../constants.js";
import { logger } from "../logger.js";
import { isEnabled } from "../settings.js";

const TYPE = `${packageId}.particleEffectsRegion`;

function computeSortSlots() {
  const SORT = CONFIG.fxmaster.PrimaryCanvasGroupNS?.SORT_LAYERS || canvas.primary?.constructor?.SORT_LAYERS || {};
  const WEATHER = Number.isFinite(SORT.WEATHER) ? SORT.WEATHER : 800;
  const TOKENS = Number.isFinite(SORT.TOKENS) ? SORT.TOKENS : 600;

  return {
    BELOW_TOKENS: TOKENS - 1, // under tokens
    DEFAULT_BELOW_WEATHER: Math.min(WEATHER - 1, TOKENS + 1), // above tokens, below weather
    ABOVE_DARKNESS_EFFECTS: WEATHER + 120, // above darkness
  };
}

export class ParticleEffectsRegionLayer extends CONFIG.fxmaster.FullCanvasObjectMixinNS(CONFIG.fxmaster.CanvasLayerNS) {
  /** Layer configuration for Foundry's canvas stack. */
  static get layerOptions() {
    return foundry.utils.mergeObject(super.layerOptions, { name: "particle-effects" });
  }

  /** Initialize containers, masks, caches, and per-frame watcher state. */
  constructor() {
    super();
    this.#initializeInverseOcclusionFilter();
    this.mask = canvas.masks.scene;
    this.sortableChildren = true;
    this.eventMode = "none";

    this.particleEffects = new Map(); // Scene-level effects
    this.regionEffects = new Map(); // RegionId -> entries
    this._belowContainer = null; // Scene host (below darkness)
    this._aboveContainer = null; // Scene host (above darkness)
    this._ticker = false; // Per-frame watcher flag
    this._lastRegionsMatrix = null; // Camera transform cache
    this._trailing = null; // RAF coalescer for mask refresh
    this._scratchGfx = null; // Reused Graphics scratchpad
    this._aboveMaskGfx = null; // Scene mask above darkness
    this._dyingSceneEffects = new Set(); // Track fading-out scene FX
    this._tearingDown = false;

    this._belowTokensContainer = null; // Scene lane outer (suppression-masked)
    this._belowTokensContent = null; // Scene lane inner (gets scene-rect clamp)
    this._belowTokensOccl = null; // Scene lane occlusion

    this._belowTokensRegionContainer = null; // Region lane outer (not suppression-masked)
    this._belowTokensRegionContent = null; // Region lane inner (gets scene-rect clamp)
    this._belowTokensRegionOccl = null; // Region lane occlusion

    this._belowTokensSceneMaskSpriteScene = null;
    this._belowTokensSceneMaskSpriteRegion = null;

    this._gatePassCache = new Map();
  }

  /** Occlusion mask filter bound to this layer. */
  occlusionFilter;

  /** Proxy WeatherEffects elevation into this layer. */
  get elevation() {
    return canvas.weather?.elevation ?? Infinity;
  }
  set elevation(value) {
    const w = canvas.weather;
    if (w) w.elevation = value;
  }

  /** Draw layer contents and start the per-frame watcher. */
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

  /** Tear down the layer, stop watchers, and destroy all effects and hosts. */
  async _tearDown() {
    this._tearingDown = true;
    if (this._trailing) {
      try {
        cancelAnimationFrame(this._trailing);
      } catch {}
      this._trailing = null;
    }

    if (this._ticker) {
      try {
        canvas.app.ticker.remove(this.#tick, this);
      } catch {}
      this._ticker = false;
    }
    this._lastRegionsMatrix = null;

    try {
      if (this._belowTokensContent?.mask) this._belowTokensContent.mask = null;
    } catch {}
    try {
      if (this._belowTokensRegionContent?.mask) this._belowTokensRegionContent.mask = null;
    } catch {}

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
    try {
      this._aboveContainer?.destroy({ children: true });
    } catch {}
    this._belowContainer = null;
    this._aboveContainer = null;

    try {
      if (this._aboveContainer?.mask) this._aboveContainer.mask = null;
    } catch {}
    try {
      this._aboveMaskGfx?.destroy(true);
    } catch {}
    this._aboveMaskGfx = null;

    try {
      this._belowTokensContainer?.destroy({ children: true });
    } catch {}
    this._belowTokensContainer = null;
    this._belowTokensOccl = null;
    this._belowTokensContent = null;

    try {
      this._belowTokensRegionContainer?.destroy({ children: true });
    } catch {}
    this._belowTokensRegionContainer = null;
    this._belowTokensRegionOccl = null;
    this._belowTokensRegionContent = null;

    try {
      this._belowTokensSceneMaskSpriteScene?.destroy(true);
    } catch {}
    this._belowTokensSceneMaskSpriteScene = null;
    try {
      this._belowTokensSceneMaskSpriteRegion?.destroy(true);
    } catch {}
    this._belowTokensSceneMaskSpriteRegion = null;

    this._aboveContent = null;

    try {
      this.filters = [];
    } catch {}

    const res = await super._tearDown();
    this._tearingDown = false;
    return res;
  }

  /** Destroy all scene-level and region-level effects and related sprites/RTs. */
  #destroyEffects() {
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
        const spr = fx?._fxmSceneParticlesMaskSprite;
        if (spr && !spr.destroyed) {
          if (fx.mask === spr) fx.mask = null;
          fx.removeChild(spr);
          spr.destroy({ texture: false, baseTexture: false });
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
        try {
          entry.fx?.stop?.();
        } catch {}
        try {
          entry.fx?.destroy?.();
        } catch {}
        try {
          entry.container?.destroy?.({ children: true });
        } catch {}
        try {
          entry.wrapper?.destroy?.({ children: true });
        } catch {}
        try {
          entry.maskSprite?.destroy?.({ children: true });
        } catch {}
        try {
          entry.maskRT?.destroy?.(true);
        } catch {}
      }
    }
    this.regionEffects.clear();
  }

  /** Draw scene-level particle effects from scene flags. */
  async #draw() {
    await this.drawParticleEffects();
  }

  /**
   * Reconcile scene flags with live scene-level particle effects.
   * Creates, updates, prewarms, fades out, and destroys as needed.
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
                if (fx.mask === spr) {
                  try {
                    fx.mask = null;
                  } catch {}
                }
                try {
                  fx.removeChild(spr);
                } catch {}
                spr.destroy({ texture: false, baseTexture: false });
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

      const addToLayer = (fx, opts) => {
        const { layerLevel = "belowDarkness" } = EffectClass.defaultConfig || {};
        const belowTokens = !!opts?.belowTokens?.value;

        if (belowTokens) this._belowTokensContent.addChild(fx);
        else if (layerLevel === "aboveDarkness") this._aboveContent.addChild(fx);
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
          addToLayer(ec, options);
          cur.set(id, ec);
          ec.play({ prewarm: true });

          this._dyingSceneEffects.add(existing);

          removalPromises.push(
            (async () => {
              try {
                await Promise.all([existing.fadeOut?.({ timeout: XFADE_MS }), ec.fadeIn?.({ timeout: XFADE_MS })]);
              } catch {}

              try {
                const spr = existing._fxmSceneParticlesMaskSprite;
                if (spr && !spr.destroyed) {
                  if (existing.mask === spr) {
                    try {
                      existing.mask = null;
                    } catch {}
                  }
                  try {
                    existing.removeChild(spr);
                  } catch {}
                  spr.destroy({ texture: false, baseTexture: false });
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
        addToLayer(ec, options);
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

      addToLayer(ec, options);
      cur.set(id, ec);
      ec.play({ prewarm: !soft });
    }

    this.occlusionFilter.enabled = this.particleEffects.size > 0;
    const hasUnder = this._hasBelowTokensFX();
    if (this._belowTokensOccl) this._belowTokensOccl.enabled = hasUnder;
    if (this._belowTokensRegionOccl) this._belowTokensRegionOccl.enabled = hasUnder;

    this._updateBelowTokensClamp();

    if (removalPromises.length) {
      try {
        await Promise.all(removalPromises);
      } catch {}
    }
  }

  /**
   * Draw all particle effects for a Region placeable.
   * Builds a screen-space render-texture mask per effect and keeps the mask
   * projected into the container’s local space.
   */
  async drawRegionParticleEffects(placeable, { soft = false } = {}) {
    const regionId = placeable.id;

    this._ensureSceneContainers();

    const old = this.regionEffects.get(regionId) || [];
    await Promise.all(
      old.map(async (entry) => {
        const fx = entry?.fx ?? entry;
        const container = entry?.container;
        const wrapper = entry?.wrapper;
        const maskSprite = entry?.maskSprite;
        const maskRT = entry?.maskRT;
        try {
          fx?.stop?.();
        } catch {}
        try {
          fx?.destroy?.();
        } catch {}
        try {
          if (container?.parent) container.parent.removeChild(container);
          container?.destroy?.({ children: true });
        } catch {}
        try {
          if (wrapper?.parent) wrapper.parent.removeChild(wrapper);
          wrapper?.destroy?.({ children: true });
        } catch {}
        try {
          if (container?.mask === maskSprite) container.mask = null;
        } catch {}
        try {
          maskSprite?.destroy?.({ texture: false, baseTexture: false });
        } catch {}
        try {
          maskRT?.destroy?.(true);
        } catch {}
      }),
    );
    this.regionEffects.set(regionId, []);

    const behaviors = placeable.document.behaviors.filter((b) => b.type === TYPE && !b.disabled);
    if (!behaviors.length) return;

    for (const behavior of behaviors) {
      const defs = behavior.getFlag(packageId, "particleEffects") || {};

      for (const [type, params] of Object.entries(defs)) {
        const EffectClass = CONFIG.fxmaster.particleEffects[type];
        if (!EffectClass) continue;
        const { layerLevel = "belowDarkness" } = EffectClass.defaultConfig || {};
        const defaultBM = EffectClass?.defaultConfig?.blendMode ?? PIXI.BLEND_MODES.NORMAL;

        const container = new PIXI.Container();

        const rt = this._buildRegionMaskRT(placeable);
        const spr = new PIXI.Sprite(rt);
        spr.name = "fxmRegionMaskSprite";
        spr.eventMode = "none";
        spr.interactive = false;
        spr.cursor = null;

        const r = canvas.app.renderer;
        const VW = Math.max(1, r.view.width | 0);
        const VH = Math.max(1, r.view.height | 0);
        spr.width = VW;
        spr.height = VH;

        container.addChild(spr);
        container.mask = spr;

        const effectOptions = Object.fromEntries(
          Object.entries(params?.options ?? {}).map(([k, v]) => [k, { value: v }]),
        );
        const belowTokens = !!params?.belowTokens;

        const fx = new EffectClass(effectOptions);
        try {
          fx.blendMode = defaultBM;
        } catch {}
        container.addChild(fx);

        let wrapper = null;
        if (belowTokens) {
          this._belowTokensRegionContent.addChild(container);
          this._applyMaskSpriteTransform(container, spr);
          if (this._belowTokensRegionOccl) this._belowTokensRegionOccl.enabled = true;
        } else if (layerLevel === "aboveDarkness") {
          this._aboveContent.addChild(container);
          this._applyMaskSpriteTransform(container, spr);
        } else {
          this.addChild(container);
          this._applyMaskSpriteTransform(container, spr);
        }

        fx.play({ prewarm: !soft });

        const entry = { fx, container, wrapper, maskSprite: spr, maskRT: rt };
        this.regionEffects.get(regionId).push(entry);
      }
    }

    this._applyElevationGate(placeable, { force: true });

    this._updateBelowTokensClamp();
  }

  /** Rebuild all region mask RTs and sprites to match the current view. */
  forceRegionMaskRefreshAll() {
    if (!this.regionEffects.size) return;

    const r = canvas.app.renderer;
    const VW = Math.max(1, r.view.width | 0);
    const VH = Math.max(1, r.view.height | 0);
    const gl = r.gl,
      MAX_GL = gl?.getParameter?.(gl.MAX_TEXTURE_SIZE) || 8192;
    let rtRes = Math.min(r.resolution, MAX_GL / Math.max(VW, VH));
    rtRes = Math.max(1, Math.round(rtRes));

    for (const [regionId, entries] of this.regionEffects.entries()) {
      const placeable = canvas.regions?.get(regionId);
      if (!placeable) continue;

      for (const entry of entries) {
        const { container } = entry;

        const needNewRT =
          !entry.maskRT || entry.maskRT.width !== VW || entry.maskRT.height !== VH || entry.maskRT.resolution !== rtRes;

        if (needNewRT) {
          const newRT = PIXI.RenderTexture.create({ width: VW, height: VH, resolution: rtRes });

          if (!entry.maskSprite || entry.maskSprite.destroyed) {
            const spr = new PIXI.Sprite(newRT);
            spr.name = "fxmRegionMaskSprite";
            entry.maskSprite = spr;
            container.addChild(spr);
            container.mask = spr;
          } else {
            entry.maskSprite.texture = newRT;
          }

          try {
            entry.maskRT?.destroy(true);
          } catch {}
          entry.maskRT = newRT;
        }

        const gfx = this._buildRegionMaskGraphics(placeable);
        r.render(gfx, { renderTexture: entry.maskRT, clear: true });

        entry.maskSprite.width = VW;
        entry.maskSprite.height = VH;
        const Minv = container.worldTransform.clone().invert();
        Minv.tx = Math.round(Minv.tx);
        Minv.ty = Math.round(Minv.ty);
        entry.maskSprite.transform.setFromMatrix(Minv);
        entry.maskSprite.roundPixels = true;
        container.roundPixels = true;
      }

      this._applyElevationGate(placeable);
    }
  }

  /** Rebuild mask RT and sprite for a single region. */
  forceRegionMaskRefresh(regionId) {
    const placeable = canvas.regions?.get(regionId);
    if (!placeable) return;
    this._rebuildRegionMaskFor(placeable);
  }

  /** Request an immediate and a trailing full mask refresh via RAF. */
  requestRegionMaskRefreshAll() {
    if (this._trailing) return;
    this._trailing = requestAnimationFrame(() => {
      this._trailing = null;
      this.forceRegionMaskRefreshAll();
    });
  }

  requestRegionMaskRefresh(regionId) {
    if (this._trailing) return;
    this._trailing = requestAnimationFrame(() => {
      this._trailing = null;
      this.forceRegionMaskRefresh(regionId);
    });
  }

  /** Remove and destroy all particle-effect entries for a region. */
  destroyRegionParticleEffects(regionId) {
    const entries = this.regionEffects.get(regionId) || [];
    for (const entry of entries) {
      const fx = entry?.fx ?? entry;
      const container = entry?.container;
      const wrapper = entry?.wrapper;
      const maskSprite = entry?.maskSprite;
      const maskRT = entry?.maskRT;

      try {
        fx?.stop?.();
      } catch {}
      try {
        fx?.destroy?.();
      } catch {}
      try {
        if (container?.parent) container.parent.removeChild(container);
      } catch {}
      try {
        container?.destroy?.({ children: true });
      } catch {}
      try {
        if (wrapper?.parent) wrapper.parent.removeChild(wrapper);
      } catch {}
      try {
        wrapper?.destroy?.({ children: true });
      } catch {}
      try {
        if (container?.mask === maskSprite) container.mask = null;
      } catch {}
      try {
        maskSprite?.destroy?.({ texture: false, baseTexture: false });
      } catch {}
      try {
        maskRT?.destroy?.(true);
      } catch {}
    }
    this.regionEffects.delete(regionId);

    this._updateBelowTokensClamp();
    try {
      const hasAny = this._hasBelowTokensFX();
      if (this._belowTokensOccl) this._belowTokensOccl.enabled = hasAny;
      if (this._belowTokensRegionOccl) this._belowTokensRegionOccl.enabled = hasAny;
    } catch {}
  }

  refreshBelowTokensSceneMask() {
    const parent = canvas.tokens?.parent ?? canvas.primary;
    const dims = canvas.dimensions;
    if (!dims) return;
    const { x, y, width, height } = dims.sceneRect ?? { x: 0, y: 0, width: dims.width, height: dims.height };

    const ensure = (cur, name) => {
      let g = cur;
      if (!g || g.destroyed) {
        g = new PIXI.Graphics();
        g.name = name;
        g.eventMode = "none";
        parent.addChild(g);
      } else if (g.parent !== parent) {
        try {
          g.parent?.removeChild?.(g);
        } catch {}
        parent.addChild(g);
      }
      g.clear();
      g.beginFill(0xffffff, 1).drawRect(x, y, width, height).endFill();
      g.visible = true;
      return g;
    };

    this._belowTokensSceneMaskSpriteScene = ensure(
      this._belowTokensSceneMaskSpriteScene,
      "fxmBelowTokensSceneMask_SCENE",
    );
    this._belowTokensSceneMaskSpriteRegion = ensure(
      this._belowTokensSceneMaskSpriteRegion,
      "fxmBelowTokensSceneMask_REGION",
    );

    if (this._belowTokensContent && !this._belowTokensContent.destroyed) {
      if (this._belowTokensContent.mask !== this._belowTokensSceneMaskSpriteScene)
        this._belowTokensContent.mask = this._belowTokensSceneMaskSpriteScene;
    }
    if (this._belowTokensRegionContent && !this._belowTokensRegionContent.destroyed) {
      if (this._belowTokensRegionContent.mask !== this._belowTokensSceneMaskSpriteRegion)
        this._belowTokensRegionContent.mask = this._belowTokensSceneMaskSpriteRegion;
    }

    this._updateBelowTokensClamp();
  }

  /** Create and configure the inverse-occlusion filter for scene particles. */
  #initializeInverseOcclusionFilter() {
    this.occlusionFilter = CONFIG.fxmaster.WeatherOcclusionMaskFilterNS.create({
      occlusionTexture: canvas.masks.depth.renderTexture,
    });
    this.occlusionFilter.enabled = false;
    this.occlusionFilter.elevation = this.elevation;
    this.occlusionFilter.blendMode = PIXI.BLEND_MODES.NORMAL;
    this.filterArea = canvas.app.renderer.screen;
    this.filters = [this.occlusionFilter];
  }

  /** Build or refresh the rectangular mask used by the above-darkness container. */
  refreshAboveSceneMask() {
    if (!this._aboveContent) return;
    const r = canvas.dimensions?.sceneRect;
    if (!r) return;

    let g = this._aboveMaskGfx;
    if (!g || g.destroyed) {
      g = new PIXI.Graphics();
      g.name = "fxmSceneMaskAbove";
      g.eventMode = "none";
      this._aboveContent.addChild(g);
      this._aboveMaskGfx = g;
    } else if (g.parent !== this._aboveContent) {
      try {
        g.parent?.removeChild?.(g);
      } catch {}
      this._aboveContent.addChild(g);
    }

    g.clear();
    g.beginFill(0xffffff, 1).drawRect(r.x, r.y, r.width, r.height).endFill();
    if (this._aboveContent.mask !== g) this._aboveContent.mask = g;
  }

  /** Ensure scene-level host containers exist and are attached in draw order. */
  _ensureSceneContainers() {
    const SLOTS = computeSortSlots();
    const primaryElev = canvas.primary?.elevation ?? 0;
    const weatherElev = canvas.weather?.elevation ?? canvas.lighting?.elevation ?? 1000;

    const makePrimaryRoot = (cur, name, sortLayer, elev, needsOcclusion = false) => {
      let root = cur;
      const FullObject = CONFIG.fxmaster.FullCanvasObjectMixinNS(PIXI.Container);
      const parent = canvas.primary ?? canvas.stage;

      if (!root || root.destroyed) {
        root = new FullObject();
        root.name = name;
        root.sortableChildren = true;
        root.eventMode = "none";
        root.mask = canvas.masks.scene;
        root.filterArea = canvas.app.renderer.screen;
        parent.addChild(root);
      } else if (root.parent !== parent) {
        try {
          root.parent?.removeChild?.(root);
        } catch {}
        parent.addChild(root);
      }

      try {
        root.elevation = elev;
      } catch {}
      try {
        root.sortLayer = sortLayer;
      } catch {}

      if (needsOcclusion) {
        if (!this._belowTokensOccl) {
          this._belowTokensOccl =
            CONFIG.fxmaster?.WeatherOcclusionMaskFilterNS?.create?.({
              occlusionTexture: canvas.masks?.depth?.renderTexture,
            }) ?? null;
        }
        if (this._belowTokensOccl) {
          this._belowTokensOccl.enabled = false;
          this._belowTokensOccl.elevation = weatherElev;
          root.filters = [this._belowTokensOccl];
          root.filterArea = canvas.app.renderer.screen;
        }
      }
      return root;
    };

    const makeEffectsRoot = (cur, name, sortLayer, elev) => {
      let root = cur;
      const FullObject = CONFIG.fxmaster.FullCanvasObjectMixinNS(PIXI.Container);
      const parent = canvas.effects ?? canvas.rendered ?? canvas.stage;

      if (!root || root.destroyed) {
        root = new FullObject();
        root.name = name;
        root.sortableChildren = true;
        root.eventMode = "none";
        root.mask = canvas.masks.scene;
        root.filterArea = canvas.app.renderer.screen;
        parent.addChild(root);
      } else if (root.parent !== parent) {
        try {
          root.parent?.removeChild?.(root);
        } catch {}
        parent.addChild(root);
      }

      try {
        root.elevation = elev;
      } catch {}
      try {
        root.sortLayer = sortLayer;
      } catch {}
      return root;
    };

    this._laneRoots = this._laneRoots || {};

    // BELOW-TOKENS  (FoW-masked under primary)
    this._laneRoots.belowTokens = makePrimaryRoot(
      this._laneRoots.belowTokens,
      "fxmLane_BelowTokens",
      SLOTS.BELOW_TOKENS,
      primaryElev,
      true,
    );
    if (
      !this._belowTokensContent ||
      this._belowTokensContent.destroyed ||
      this._belowTokensContent.parent !== this._laneRoots.belowTokens
    ) {
      const c = (this._belowTokensContent = new PIXI.Container());
      c.name = "fxmBelowTokensContent_SCENE";
      c.sortableChildren = true;
      c.eventMode = "none";
      this._laneRoots.belowTokens.addChild(c);
      try {
        c.fxmMaskRedirect = this._laneRoots.belowTokens;
      } catch {}
    }
    if (
      !this._belowTokensRegionContent ||
      this._belowTokensRegionContent.destroyed ||
      this._belowTokensRegionContent.parent !== this._laneRoots.belowTokens
    ) {
      const c = (this._belowTokensRegionContent = new PIXI.Container());
      c.name = "fxmBelowTokensContent_REGION";
      c.sortableChildren = true;
      c.eventMode = "none";
      this._laneRoots.belowTokens.addChild(c);
    }

    // DEFAULT (FoW-masked above tokens, below weather in primary)
    this._laneRoots.def = makePrimaryRoot(
      this._laneRoots.def,
      "fxmLane_DefaultBelowWeather",
      SLOTS.DEFAULT_BELOW_WEATHER,
      primaryElev,
      false,
    );
    if (
      !this._belowContainer ||
      this._belowContainer.destroyed ||
      this._belowContainer.parent !== this._laneRoots.def
    ) {
      this._belowContainer = new PIXI.Container();
      this._belowContainer.name = "fxmSceneBelowWeather";
      this._belowContainer.sortableChildren = true;
      this._belowContainer.eventMode = "none";
      this._laneRoots.def.addChild(this._belowContainer);
      try {
        this._belowContainer.fxmMaskRedirect = this._laneRoots.def;
      } catch {}
    }

    // ABOVE-DARKNESS (FoW-masked in your build; EFFECTS is above lighting)
    this._laneRoots.above = makeEffectsRoot(
      this._laneRoots.above,
      "fxmLane_AboveDarkness_Effects",
      SLOTS.ABOVE_DARKNESS_EFFECTS,
      weatherElev,
    );
    if (!this._aboveContent || this._aboveContent.destroyed || this._aboveContent.parent !== this._laneRoots.above) {
      const inner = (this._aboveContent = new PIXI.Container());
      inner.name = "fxmSceneAboveDarknessContent";
      inner.sortableChildren = true;
      inner.eventMode = "none";
      this._laneRoots.above.addChild(inner);
      try {
        inner.fxmMaskRedirect = this._laneRoots.above;
      } catch {}
    }

    this.refreshBelowTokensSceneMask();
    this.refreshAboveSceneMask();
  }

  /** Project a mask sprite into a container’s local space. */
  _applyMaskSpriteTransform(container, spr) {
    try {
      container.updateTransform();
    } catch {}
    const Minv = container.worldTransform.clone().invert();
    Minv.tx = Math.round(Minv.tx);
    Minv.ty = Math.round(Minv.ty);
    spr.transform.setFromMatrix(Minv);
    spr.roundPixels = true;
    container.roundPixels = true;
  }

  /** Build a Graphics object that draws the region’s shapes in screen space. */
  _buildRegionMaskGraphics(region) {
    const g = this._getScratchGfx();
    g.clear();
    g.beginFill(0xffffff, 1.0);

    for (const s of region.document.shapes) {
      const draw = () => {
        switch (s.type) {
          case "polygon":
            g.drawShape(new PIXI.Polygon(s.points));
            break;
          case "ellipse":
            g.drawEllipse(s.x, s.y, s.radiusX, s.radiusY);
            break;
          case "rectangle":
            g.drawRect(s.x, s.y, s.width, s.height);
            break;
          default:
            g.drawShape(new PIXI.Polygon(s.points));
            break;
        }
      };
      if (s.hole) {
        g.beginHole();
        draw();
        g.endHole();
      } else draw();
    }

    g.endFill();

    const M = (canvas.regions?.worldTransform ?? canvas.stage.worldTransform).clone();
    M.tx = Math.round(M.tx);
    M.ty = Math.round(M.ty);
    g.transform.setFromMatrix(M);
    g.roundPixels = true;
    return g;
  }

  /** Create a render texture for a region mask sized to the current viewport. */
  _buildRegionMaskRT(region) {
    const r = canvas.app.renderer;
    const VW = Math.max(1, r.view.width | 0);
    const VH = Math.max(1, r.view.height | 0);
    const gl = r.gl,
      MAX_GL = gl?.getParameter?.(gl.MAX_TEXTURE_SIZE) || 8192;

    let rtRes = Math.min(r.resolution || 1, MAX_GL / Math.max(VW, VH));
    if (!Number.isFinite(rtRes) || rtRes <= 0) rtRes = 1;
    rtRes = Math.max(1, Math.round(rtRes));

    const gfx = this._buildRegionMaskGraphics(region);
    const rt = PIXI.RenderTexture.create({ width: VW, height: VH, resolution: rtRes });
    r.render(gfx, { renderTexture: rt, clear: true });
    return rt;
  }

  /** Rebuild the mask RT/sprite for a single region to match the current view. */
  _rebuildRegionMaskFor(placeable) {
    const entries = this.regionEffects.get(placeable.id);
    if (!entries?.length) return;

    for (const entry of entries) {
      const { container } = entry;

      const newRT = this._buildRegionMaskRT(placeable);
      try {
        entry.maskRT?.destroy(true);
      } catch {}
      entry.maskRT = newRT;

      if (!entry.maskSprite || entry.maskSprite.destroyed) {
        const spr = new PIXI.Sprite(newRT);
        spr.name = "fxmRegionMaskSprite";
        entry.maskSprite = spr;
        container.addChild(spr);
        container.mask = spr;
      } else {
        entry.maskSprite.texture = newRT;
      }

      const r = canvas.app.renderer;
      entry.maskSprite.width = Math.max(1, r.view.width | 0);
      entry.maskSprite.height = Math.max(1, r.view.height | 0);

      const Minv = container.worldTransform.clone().invert();
      Minv.tx = Math.round(Minv.tx);
      Minv.ty = Math.round(Minv.ty);
      entry.maskSprite.transform.setFromMatrix(Minv);
      entry.maskSprite.roundPixels = true;
      container.roundPixels = true;
    }

    this._applyElevationGate(placeable, { force: true });
  }

  /** Get or create a reusable Graphics scratchpad. */
  _getScratchGfx() {
    return this._scratchGfx ?? (this._scratchGfx = new PIXI.Graphics());
  }

  /**
   * Per-frame watcher.
   * - If the camera matrix changed: rebuild masks.
   * - Always re-apply elevation/event/targets gate
   */
  #tick() {
    if (this._tearingDown) return;
    if (this.regionEffects.size === 0) return;

    const Msrc = canvas?.regions?.worldTransform;
    if (!Msrc) return;

    const M = { a: Msrc.a, b: Msrc.b, c: Msrc.c, d: Msrc.d, tx: Math.round(Msrc.tx), ty: Math.round(Msrc.ty) };
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

    try {
      for (const [regionId] of this.regionEffects) {
        const reg = canvas.regions?.get(regionId);
        if (reg) this._applyElevationGate(reg);
      }
    } catch {}
  }

  /** Public helper: re-apply the elevation gate for all active regions. */
  applyElevationGateForAll() {
    try {
      for (const [regionId] of this.regionEffects) {
        const reg = canvas.regions?.get(regionId);
        if (reg) this._applyElevationGate(reg);
      }
    } catch {}
  }

  /** Read eventGate from the region behavior. */
  _getEventGate(placeable) {
    const fxBeh = placeable?.document?.behaviors?.find((b) => b.type === TYPE && !b.disabled);
    if (!fxBeh) return { mode: "none", latched: false };
    const eg = fxBeh.getFlag?.(packageId, "eventGate");
    return { mode: eg?.mode ?? "none", latched: !!eg?.latched };
  }

  /** Parse region elevation window; supports open-ended bounds. */
  _getRegionElevationWindow(doc) {
    const rawTop = doc?.elevation?.top;
    const rawBottom = doc?.elevation?.bottom;
    const hasTop = rawTop !== undefined && rawTop !== null && `${rawTop}`.trim() !== "";
    const hasBottom = rawBottom !== undefined && rawBottom !== null && `${rawBottom}`.trim() !== "";
    if (!hasTop && !hasBottom) return null;
    const top = hasTop ? Number(rawTop) : Number.POSITIVE_INFINITY;
    const bottom = hasBottom ? Number(rawBottom) : Number.NEGATIVE_INFINITY;
    return { min: bottom, max: top };
  }

  _inRangeElev(elev, win) {
    return elev >= win.min && elev <= win.max;
  }

  /**
   * Determine if *this viewer* should see region particles, considering:
   * - GM override
   * - Event gate (enter/enterExit latch)
   * - Gate mode: POV vs explicit Targets
   * - Region elevation window
   */
  _isRegionElevationPass(placeable) {
    const doc = placeable?.document;
    if (!doc) return true;
    const fxBeh = doc.behaviors?.find((b) => b.type === TYPE && !b.disabled);
    if (!fxBeh) return true;

    const gmAlways = !!fxBeh.getFlag?.(packageId, "gmAlwaysVisible");
    if (gmAlways && game.user?.isGM) return true;

    const { mode, latched } = this._getEventGate(placeable);
    if (mode === "enterExit") return !!latched;
    if (mode === "enter" && !latched) return false;

    const win = this._getRegionElevationWindow(doc);

    const gateMode = fxBeh.getFlag?.(packageId, "gateMode");
    if (gateMode === "pov") {
      const selected = canvas.tokens.controlled;
      if (!selected?.length) return false;
      if (!win) return true;
      for (const t of selected) {
        const elev = Number(t?.document?.elevation);
        if (Number.isFinite(elev) && this._inRangeElev(elev, win)) return true;
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
        const elev = Number(t?.document?.elevation);
        if (Number.isFinite(elev) && this._inRangeElev(elev, win)) return true;
      }
      return false;
    }

    return true;
  }

  /**
   * Toggle visibility/enabled on each entry for a region based on pass/fail.
   * - Uses a per-region cache to avoid uniform/flag churn each frame.
   * - But still corrects newly added entries even if the cached pass hasn't changed.
   * @param {PlaceableObject} placeable
   * @param {{force?: boolean}} [opts]
   */
  _applyElevationGate(placeable, { force = false } = {}) {
    const entries = this.regionEffects.get(placeable.id) || [];
    if (!entries.length) return;

    const pass = this._isRegionElevationPass(placeable);
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
        if (entry?.container && entry.container.visible !== !!pass) {
          entry.container.visible = !!pass;
        }
      } catch {}
      try {
        if (entry?.fx && "enabled" in entry.fx && entry.fx.enabled !== !!pass) {
          entry.fx.enabled = !!pass;
        }
      } catch {}
    }

    this._gatePassCache.set(placeable.id, pass);
  }

  _hasBelowTokensFX() {
    const cS = this._belowTokensContent;
    const cR = this._belowTokensRegionContent;
    const hasS = !!(cS && !cS.destroyed && cS.children && cS.children.length > 0);
    const hasR = !!(cR && !cR.destroyed && cR.children && cR.children.length > 0);
    return hasS || hasR;
  }

  /** Toggle visibility/attachment of the below-tokens scene clamp */
  _updateBelowTokensClamp() {
    const gS = this._belowTokensSceneMaskSpriteScene;
    const gR = this._belowTokensSceneMaskSpriteRegion;
    const cS = this._belowTokensContent;
    const cR = this._belowTokensRegionContent;
    if ((!gS || gS.destroyed) && (!gR || gR.destroyed)) return;

    const hasS = !!(cS && !cS.destroyed && cS.children && cS.children.length > 0);
    const hasR = !!(cR && !cR.destroyed && cR.children && cR.children.length > 0);
    const any = hasS || hasR;

    if (cS && !cS.destroyed && gS && !gS.destroyed) {
      if (hasS) {
        cS.mask = gS;
        gS.visible = true;
      } else {
        if (cS.mask === gS) cS.mask = null;
        gS.visible = false;
      }
    }
    if (cR && !cR.destroyed && gR && !gR.destroyed) {
      if (hasR) {
        cR.mask = gR;
        gR.visible = true;
      } else {
        if (cR.mask === gR) cR.mask = null;
        gR.visible = false;
      }
    }

    try {
      if (this._belowTokensOccl) this._belowTokensOccl.enabled = any;
      if (this._belowTokensRegionOccl) this._belowTokensRegionOccl.enabled = any;
    } catch {}
  }
}
