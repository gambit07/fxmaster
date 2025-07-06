/**
 * A SpriteMesh which visualizes a special effect object in the PrimaryCanvasGroup.
 */
export class SpecialEffectMesh extends CONFIG.fxmaster.SpriteMeshNS {
  /** @type {number} */
  get elevation() {
    return this.#elevation;
  }

  set elevation(value) {
    this.#elevation = value;
  }

  #elevation = 0;
}
