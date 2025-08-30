import { packageId } from "../constants.js";
import { logger } from "../logger.js";
import { isEnabled } from "../settings.js";

const TYPE = `${packageId}.particleEffectsRegion`;

export class ParticleEffectsLayer extends CONFIG.fxmaster.FullCanvasObjectMixinNS(CONFIG.fxmaster.CanvasLayerNS) {
  constructor() {
    super();
    this.#initializeInverseOcclusionFilter();
    this.mask = canvas.masks.scene;
    this.sortableChildren = true;
    this.eventMode = "none";
    this.regionEffects = new Map();
  }

  /**
   * Initialize the inverse occlusion filter.
   */
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

  /** @override */
  static get layerOptions() {
    return foundry.utils.mergeObject(super.layerOptions, { name: "particle-effects" });
  }

  /**
   * The currently active particle effects.
   * @type {Map<string, import('./effects/effect.js').FXMasterParticleEffect>}
   */
  particleEffects = new Map();

  /**
   * The inverse occlusion mask filter bound to this container.
   * @type {WeatherOcclusionMaskFilter}
   */
  occlusionFilter;

  /**
   * Define an elevation property on the ParticleEffectsLayer layer.
   * For now, it simply referenes the elevation property of the {@link WeatherEffects} provided by
   * foundry.
   * @type {number}
   */
  get elevation() {
    return canvas.weather?.elevation ?? Infinity;
  }

  set elevation(value) {
    const weatherEffects = canvas.weather;
    if (weatherEffects) {
      weatherEffects.elevation = value;
    }
  }

  /** @override */
  async _draw() {
    if (!isEnabled()) return;
    await this.#draw();
  }

  /** @override */
  async _tearDown() {
    this.#destroyEffects();
    return super._tearDown();
  }

  #destroyEffects() {
    if (this.particleEffects.size === 0) return;
    for (const ec of this.particleEffects.values()) {
      ec.destroy();
    }
    this.particleEffects.clear();
  }

  /**
   * Actual implementation of drawing the layer.
   */
  async #draw() {
    await this.drawParticleEffects();
  }

  async drawParticleEffects({ soft = false } = {}) {
    if (!canvas.scene) {
      return;
    }

    let zIndex = 0;

    const stopPromise = Promise.all(
      [...this.particleEffects.entries()].map(async ([id, effect]) => {
        if (soft) {
          await effect.fadeOut({ timeout: 20000 });
        } else {
          effect.stop();
        }
        effect.destroy();
        // The check is needed because a new effect might have been set already.
        if (this.particleEffects.get(id) === effect) {
          this.particleEffects.delete(id);
        }
      }),
    );

    const belowDarknessLayer = new PIXI.Container();
    const aboveDarknessLayer = new PIXI.Container();

    this.addChild(belowDarknessLayer);
    if (canvas.lighting) canvas.lighting.addChild(aboveDarknessLayer);
    else this.addChild(aboveDarknessLayer);

    aboveDarknessLayer.mask = canvas.masks.scene;

    const flags = canvas.scene.getFlag(packageId, "effects") ?? {};
    if (Object.keys(flags).length > 0) {
      this.occlusionFilter.enabled = true;
    }
    for (const [id, { type, options: flagOptions }] of Object.entries(flags)) {
      if (!(type in CONFIG.fxmaster.particleEffects)) {
        logger.warn(game.i18n.format("FXMASTER.ParticleEffectTypeUnknown", { id: id, type: flags[id].type }));
        continue;
      }
      const options = Object.fromEntries(
        Object.entries(flagOptions).map(([optionName, value]) => [optionName, { value }]),
      );

      const ec = new CONFIG.fxmaster.particleEffects[type](options);
      ec.zIndex = zIndex++;
      ec.blendMode = PIXI.BLEND_MODES.NORMAL;

      if (type === "fireflies") {
        aboveDarknessLayer.addChild(ec);
      } else {
        belowDarknessLayer.addChild(ec);
      }
      this.particleEffects.set(id, ec);
      ec.play({ prewarm: !soft });
    }

    await stopPromise;

    if (this.particleEffects.size === 0) {
      this.occlusionFilter.enabled = false;
    }
  }

  /**
   * Draw FX for a single region placeable, reading its RegionBehavior flags.
   * @param {RegionPlaceable} placeable Our region object
   * @param {object} options   { soft: boolean } – if true, fade out old effects
   */

  async drawRegionParticleEffects(placeable, { soft = false } = {}) {
    const regionId = placeable.id;

    const old = this.regionEffects.get(regionId) || [];
    await Promise.all(
      old.map(async (fx) => {
        if (soft) await fx.fadeOut({ timeout: 2000 });
        else fx.stop();
        fx.destroy();
      }),
    );
    this.regionEffects.set(regionId, []);

    const shapes = placeable.document.shapes ?? [];
    let rect;
    if (shapes.length) {
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const s of shapes) {
        if (s.hole) continue;
        switch (s.type) {
          case "rectangle": {
            const x1 = s.x,
              y1 = s.y,
              x2 = s.x + s.width,
              y2 = s.y + s.height;
            minX = Math.min(minX, x1);
            minY = Math.min(minY, y1);
            maxX = Math.max(maxX, x2);
            maxY = Math.max(maxY, y2);
            break;
          }
          case "ellipse": {
            const x1 = s.x - s.radiusX,
              y1 = s.y - s.radiusY;
            const x2 = s.x + s.radiusX,
              y2 = s.y + s.radiusY;
            minX = Math.min(minX, x1);
            minY = Math.min(minY, y1);
            maxX = Math.max(maxX, x2);
            maxY = Math.max(maxY, y2);
            break;
          }
          case "polygon": {
            const pts = s.points || [];
            for (let i = 0; i < pts.length; i += 2) {
              const px = pts[i],
                py = pts[i + 1];
              minX = Math.min(minX, px);
              minY = Math.min(minY, py);
              maxX = Math.max(maxX, px);
              maxY = Math.max(maxY, py);
            }
            break;
          }
          default: {
            const pts = s.points || [];
            for (let i = 0; i < pts.length; i += 2) {
              const px = pts[i],
                py = pts[i + 1];
              minX = Math.min(minX, px);
              minY = Math.min(minY, py);
              maxX = Math.max(maxX, px);
              maxY = Math.max(maxY, py);
            }
            break;
          }
        }
      }
      if (minX !== Infinity) {
        rect = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
      }
    }
    if (!rect) {
      const b = placeable.bounds ?? placeable.shape?.getBounds?.() ?? canvas.dimensions.sceneRect;
      rect = { x: b.x, y: b.y, w: b.width ?? b.w, h: b.height ?? b.h };
    }

    const behaviors = placeable.document.behaviors.filter((b) => b.type === TYPE && !b.disabled);

    // If there are no region behaviors, disable occlusion if nothing else is active
    if (!behaviors.length) {
      const hasAnyRegion = Array.from(this.regionEffects.values()).some((arr) => arr && arr.length);
      const hasAnyScene = (this.particleEffects && this.particleEffects.size > 0) || false;
      if (!hasAnyRegion && !hasAnyScene && this.occlusionFilter) this.occlusionFilter.enabled = false;
      return;
    }

    for (const behavior of behaviors) {
      const flags = behavior.getFlag(packageId, "particleEffects") || {};

      for (const [type, params] of Object.entries(flags)) {
        const EffectClass = CONFIG.fxmaster.particleEffects[type];
        if (!EffectClass) continue;
        const { layerLevel = "belowDarkness" } = EffectClass.defaultConfig || {};

        const container = new PIXI.Container();
        container.alpha = 1;

        const mask = new PIXI.Graphics().beginFill(0xffffff);
        for (const s of placeable.document.shapes) {
          const drawShape = () => {
            switch (s.type) {
              case "polygon":
                mask.drawShape(new PIXI.Polygon(s.points));
                break;
              case "ellipse":
                mask.drawEllipse(s.x, s.y, s.radiusX, s.radiusY);
                break;
              case "rectangle":
                mask.drawRect(s.x, s.y, s.width, s.height);
                break;
              default:
                mask.drawShape(new PIXI.Polygon(s.points));
            }
          };
          if (s.hole) {
            mask.beginHole();
            drawShape();
            mask.endHole();
          } else drawShape();
        }
        mask.endFill();
        mask.alpha = 1;

        container.mask = mask;
        container.addChild(mask);

        const options = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, { value: v }]));
        options.rect = rect;

        const fx = new EffectClass(options);
        fx.alpha = 1;
        fx.blendMode = PIXI.BLEND_MODES.NORMAL;

        container.addChild(fx);

        if (layerLevel === "aboveDarkness") {
          const regionWrapper = new PIXI.Container();
          regionWrapper.alpha = 1;
          if (canvas.lighting) canvas.lighting.addChild(regionWrapper);
          regionWrapper.addChild(container);
        } else {
          this.addChild(container);
          // Ensure belowDarkness content isn’t dimmed by darkness overlay
          if (this.occlusionFilter) this.occlusionFilter.enabled = true;
        }

        fx.play({ prewarm: false });

        this.regionEffects.get(regionId).push(fx);
      }
    }
  }
}
