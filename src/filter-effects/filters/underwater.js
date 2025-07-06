import { FXMasterFilterEffectMixin } from "./mixins/filter.js";

export class UnderwaterFilter extends FXMasterFilterEffectMixin(PIXI.DisplacementFilter) {
  constructor(options, id) {
    const displacemenntMap = PIXI.Sprite.from(
      "modules/fxmaster/assets/filter-effects/effects/underwater/displacement-map.webp",
    );
    super(options, id, displacemenntMap);

    this.displacementMap = displacemenntMap;
    this.displacementMap.texture.baseTexture.wrapMode = PIXI.WRAP_MODES.REPEAT;
    this.displacementMap.anchor.set(0.5);
    this.displacementMap.x = canvas.scene.width / 2;
    this.displacementMap.y = canvas.scene.height / 2;
  }

  /** @override */
  static label = "FXMASTER.FilterEffectUnderwater";

  /** @override */
  static icon = "fas fa-water";

  static get parameters() {
    return {
      speed: {
        label: "FXMASTER.Speed",
        type: "range",
        max: 5.0,
        min: 0.0,
        step: 0.1,
        value: 0.3,
      },
      scale: {
        label: "FXMASTER.Scale",
        type: "number",
        value: 4.0,
      },
    };
  }

  /** @override */
  static get neutral() {
    return {
      speed: 0,
      scale: 1.0,
    };
  }

  /** @override */
  applyOptions() {
    // explicitly do nothing because setting scale / speed on this breaks the DisplacementFilter
  }

  /** @override */
  play(options = {}) {
    this.displacementMap.scale.x = this.options.scale;
    this.displacementMap.scale.y = this.options.scale;
    canvas.primary.addChild(this.displacementMap);
    super.play(options);
  }

  /** @override */
  async stop(options = {}) {
    await super.stop(options);
    canvas.primary.removeChild(this.displacementMap);
  }

  /** @override */
  async step() {
    this.maskSprite.x += this.options.speed;
    await super.step();
  }
}
