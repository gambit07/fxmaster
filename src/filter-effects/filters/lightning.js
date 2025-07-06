import { packageId } from "../../constants.js";
import { easeFunctions } from "../../ease.js";
import { FXMasterFilterEffectMixin } from "./mixins/filter.js";

export class LightningFilter extends FXMasterFilterEffectMixin(PIXI.filters.AdjustmentFilter) {
  constructor(options, id) {
    super(options, id);
    this.nextLigthningTime = canvas.app.ticker.lastTime / 10;
  }

  /**
   * The time when the next lightning flash should appear.
   * @type {number}
   */
  nextLigthningTime;

  /** @override */
  static label = "FXMASTER.FilterEffectLightning";

  /** @override */
  static icon = "fas fa-bolt-lightning";

  /** @override */
  static get parameters() {
    return {
      frequency: {
        label: "FXMASTER.Period",
        type: "range",
        max: 2000,
        min: 100,
        step: 5,
        value: 500,
      },
      spark_duration: {
        label: "FXMASTER.Duration",
        type: "range",
        max: 2000,
        min: 100,
        step: 5,
        value: 300,
      },
      brightness: {
        label: "FXMASTER.Brightness",
        type: "range",
        max: 4.0,
        min: 0.0,
        step: 0.1,
        value: 1.3,
      },
    };
  }

  /** @override */
  static get neutral() {
    return {
      frequency: 0.0,
      spark_duration: 0.0,
      brightness: 1.0,
    };
  }

  /** @override */
  play(_options = {}) {
    // explicitly not applying the options, since it would change the brightness immediately
    this.enabled = true;
  }

  /** @override */
  async step() {
    if (canvas.app.ticker.lastTime / 10 > this.nextLigthningTime) {
      this.nextLigthningTime = canvas.app.ticker.lastTime / 10 + 40 + this.options.frequency * Math.random();

      const animate = (value) => {
        const attributes = [
          {
            parent: this,
            attribute: "brightness",
            to: value,
          },
        ];
        return CONFIG.fxmaster.CanvasAnimationNS.animate(attributes, {
          name: `${packageId}.${this.constructor.name}.${this.id}.${foundry.utils.randomID()}`,
          context: this,
          duration: 100 + this.options.spark_duration * Math.random(),
          easing: easeFunctions.InOutBack,
        });
      };

      await animate(this.options.brightness);
      await animate(1);
      await super.step();
    }
  }
}
