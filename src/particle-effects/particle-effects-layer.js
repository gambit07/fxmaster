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

    const behaviors = placeable.document.behaviors.filter((b) => b.type === TYPE && !b.disabled);
    for (const behavior of behaviors) {
      const flags = behavior.getFlag(packageId, "particleEffects") || {};

      for (const [type, params] of Object.entries(flags)) {
        const EffectClass = CONFIG.fxmaster.particleEffects[type];
        if (!EffectClass) continue;
        const { layerLevel = "belowDarkness" } = EffectClass.defaultConfig || {};

        const container = new PIXI.Container();

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
          } else {
            drawShape();
          }
        }
        mask.endFill();

        container.mask = mask;
        container.addChild(mask);

        const options = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, { value: v }]));
        const fx = new EffectClass(options);
        fx.blendMode = PIXI.BLEND_MODES.NORMAL;

        container.addChild(fx);
        if (layerLevel === "aboveDarkness") {
          const regionWrapper = new PIXI.Container();
          if (canvas.lighting) canvas.lighting.addChild(regionWrapper);
          regionWrapper.addChild(container);
        } else {
          this.addChild(container);
        }

        fx.play({ prewarm: !soft });
        this.regionEffects.get(regionId).push(fx);
      }
    }
  }
}
