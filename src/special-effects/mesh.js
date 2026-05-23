const SpriteMeshBase = CONFIG.fxmaster?.SpriteMeshNS ?? foundry.canvas?.containers?.SpriteMesh ?? PIXI.Sprite;

/**
 * Sprite mesh used to render one-shot special-effect video assets in the PrimaryCanvasGroup.
 */
export class SpecialEffectMesh extends SpriteMeshBase {
  #elevation = 0;

  /**
   * Render elevation used by the PrimaryCanvasGroup sorting pipeline.
   *
   * @type {number}
   */
  get elevation() {
    return this.#elevation;
  }

  set elevation(value) {
    const n = Number(value);
    this.#elevation = Number.isFinite(n) ? n : 0;
  }
}
