if (!CONFIG.fxmaster) CONFIG.fxmaster = {};

CONFIG.fxmaster.FilePickerNS = foundry.applications?.apps?.FilePicker?.implementation ?? FilePicker;
CONFIG.fxmaster.SearchFilterNS = foundry.applications?.ux?.SearchFilter ?? SearchFilter;
CONFIG.fxmaster.CanvasAnimationNS = foundry.canvas?.animation?.CanvasAnimation ?? CanvasAnimation;
CONFIG.fxmaster.FullCanvasObjectMixinNS = foundry.canvas?.containers?.FullCanvasObjectMixin ?? FullCanvasObjectMixin;
CONFIG.fxmaster.SpriteMeshNS = foundry.canvas?.containers?.SpriteMesh ?? SpriteMesh;
CONFIG.fxmaster.CanvasLayerNS = foundry.canvas?.layers?.CanvasLayer ?? CanvasLayer;
CONFIG.fxmaster.InteractionLayerNS = foundry.canvas?.layers?.InteractionLayer ?? InteractionLayer;
CONFIG.fxmaster.DrawingNS = foundry.canvas?.placeables?.Drawing ?? Drawing;
CONFIG.fxmaster.WeatherOcclusionMaskFilterNS = foundry.canvas?.rendering?.filters?.WeatherOcclusionMaskFilter ?? WeatherOcclusionMaskFilter;
CONFIG.fxmaster.PrimaryCanvasGroupNS = foundry.canvas?.groups?.PrimaryCanvasGroup ?? PrimaryCanvasGroup;
CONFIG.fxmaster.ImagePopoutNS = foundry.applications?.apps?.ImagePopout ?? ImagePopout;
CONFIG.fxmaster.PrimarySpriteMeshNS = foundry.canvas?.primary?.PrimarySpriteMesh ?? PrimarySpriteMesh;

const FXMFullCanvasObjectMixin = CONFIG.fxmaster.FullCanvasObjectMixinNS ?? ((Base) => Base);

/**
 * Lightweight particle effect container used by FXMaster.
 *
 * The class mirrors the deprecated Foundry particle container API closely enough for FXMaster's long-lived ambient emitters while remaining independent of Foundry's deprecated wrapper.
 */
class FXMasterParticleEmitterContainer extends FXMFullCanvasObjectMixin(PIXI.Container) {
  /**
   * @param {object} [options={}]
   */
  constructor(options = {}) {
    super();
    this.options = options;
    this.eventMode = "none";
    this.interactive = false;
    this.cursor = null;

    const emitters = this.getParticleEmitters(options);
    this.emitters = Array.isArray(emitters) ? emitters : [];
  }

  /**
   * Create an emitter instance that updates from PIXI's shared ticker.
   *
   * @param {PIXI.particles.EmitterConfigV3} config
   * @returns {PIXI.particles.Emitter}
   */
  createEmitter(config) {
    if (config && typeof config === "object") {
      config.autoUpdate = true;
      config.emit = false;
    }

    return new PIXI.particles.Emitter(this, config);
  }

  /**
   * Create the emitter list for this container.
   *
   * @param {object} [options={}]
   * @returns {PIXI.particles.Emitter[]}
   */
  getParticleEmitters(options = {}) {
    const isEmpty = foundry?.utils?.isEmpty
      ? foundry.utils.isEmpty(options)
      : !options || (typeof options === "object" && !Array.isArray(options) && !Object.keys(options).length);

    if (isEmpty) {
      throw new Error("The base particle effect container requires an explicit emitter configuration.");
    }

    return [this.createEmitter(options)];
  }

  /** @override */
  destroy(...args) {
    for (const emitter of this.emitters ?? []) {
      try {
        emitter?.destroy?.();
      } catch {}
    }

    this.emitters = [];
    return super.destroy(...args);
  }

  /**
   * Begin emission for all configured emitters.
   */
  play() {
    for (const emitter of this.emitters ?? []) {
      try {
        emitter.emit = true;
      } catch {}
    }
  }

  /**
   * Stop emission for all configured emitters.
   */
  stop() {
    for (const emitter of this.emitters ?? []) {
      try {
        emitter.emit = false;
      } catch {}
    }
  }
}

globalThis.FXMasterParticleEmitterContainer = FXMasterParticleEmitterContainer;
CONFIG.fxmaster.ParticleEffectNS = FXMasterParticleEmitterContainer;
