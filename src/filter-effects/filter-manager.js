import { packageId } from "../constants.js";
import { logger } from "../logger.js";
import { isEnabled } from "../settings.js";
import { resetFlag } from "../utils.js";

export class FilterManager {
  /** @private */
  constructor() {
    this.filters = {};
    this._ticker = false;
    this.#registerHooks();
  }

  /**
   * A private reference for the global {@link FilterManager} instance.
   * @type {FilterManager | undefined}
   */
  static #instance;

  /**
   * The container effects should be a pplied to.
   * @type {PIXI.Container}
   */
  static get container() {
    return canvas.environment;
  }

  /**
   * The singleton {@link FilterManager} instance.
   * @type {FilterManager}
   */
  static get instance() {
    if (!this.#instance) {
      this.#instance = new this();
    }
    return this.#instance;
  }

  /**
   * Activate this {@link FilterManager}. This includes creating all the necessary filters, attaching them to the
   * configured layers, starting their animations.
   * @returns {Promise<void>} A promise that resolves as soon as filters are activated
   */
  async #activate() {
    await this.#update({ skipFading: true });

    if (!this._ticker) {
      canvas.app.ticker.add(this.#animate, this);
      this._ticker = true;
    }
  }

  /**
   * Update the filters to the state that is configured for the active scene.
   * @param {{skipFading?: boolean}} [options]            Additional options to configure this update
   * @param {boolean}                [options.skipFading] Whether or not newly created filters should skip their fading
   * @returns {Promise<void>}                             A promise that resolves as soon as the filters have been updated
   */
  async #update({ skipFading = false } = {}) {
    if (!canvas.scene) {
      return;
    }
    const filterInfos = Object.fromEntries(
      Object.entries(canvas.scene.getFlag(packageId, "filters") ?? {}).filter(([id, filterInfo]) => {
        if (!(filterInfo.type in CONFIG.fxmaster.filterEffects)) {
          logger.warn(game.i18n.format("FXMASTER.FilterEffectTypeUnknown", { id: id, type: filterInfo.type }));
          return false;
        }
        return true;
      }),
    );

    const filtersToCreate = Object.keys(filterInfos).filter((key) => !(key in this.filters));
    const filtersToUpdate = Object.keys(filterInfos).filter((key) => key in this.filters);
    const filtersToDelete = Object.keys(this.filters).filter((key) => !(key in filterInfos));

    for (const key of filtersToCreate) {
      const { type, options } = filterInfos[key];
      this.filters[key] = new CONFIG.fxmaster.filterEffects[type](options, key);
      this.filters[key].play({ skipFading });
    }

    for (const key of filtersToUpdate) {
      const { options } = filterInfos[key];
      const filter = this.filters[key];
      filter.configure(options);
      filter.play({ skipFading });
    }

    const deletePromises = filtersToDelete.map(async (key) => {
      const filter = this.filters[key];
      const completed = await filter.stop({ skipFading });
      if (completed) {
        delete this.filters[key];
        FilterManager.#removeFilterFromContainer(this.constructor.container, filter);
      }
    });
    await Promise.all(deletePromises);

    this.#applyFilters();
  }

  /**
   * Apply the filters to the configured canvas layers. Prevent un-wanted re-application of filters on scene switch.
   */
  #applyFilters() {
    const container = this.constructor.container;
    const fxFilters = Object.values(this.filters);
    const fxClasses = fxFilters.map((f) => f.constructor);
    const otherFilters = container.filters?.filter((f) => !fxClasses.includes(f.constructor)) ?? [];
    container.filters = otherFilters.concat(fxFilters);
  }

  /**
   * Remove a filter from a container.
   * @param {PIXI.container} container A container
   * @param {PIXI.Filter} filter A filter
   */
  static #removeFilterFromContainer(container, filter) {
    container.filters = container.filters?.filter((f) => f !== filter) ?? null;
  }

  /**
   * Stop all filters and remove them from the manager.
   * @remarks This does _not_ remove the filters from the canvas layers.
   * @returns {Promise<void>} A promise that resolves as soon as all filters have been stopped and removed from the
   *                          manager
   */
  async #clear() {
    const promises = Object.values(this.filters).map((filter) => filter.stop());
    this.filters = {};
    await Promise.all(promises);
  }

  /**
   * Add a named filter.
   * @param {string | undefined} name The name of the filter
   * @param {string} type             The type of the filter
   * @param {object} options          The options for the filter
   * @returns {Prmise<void>} A promise that resolves as soon as the filter has been added to the scene's fxmaster flags
   */
  async addFilter(name, type, options) {
    name = name ?? foundry.utils.randomID();
    await canvas.scene?.setFlag(packageId, "filters", { [name]: { type, options } });
  }

  /**
   * Remove a named filter.
   * @param {string} name     The name of the filter to remove
   * @returns {Promise<void>} A promise that resolves when the filter has been removed from the scene's fxmaster flags
   */
  async removeFilter(name) {
    await canvas.scene?.setFlag(packageId, "filters", { [`-=${name}`]: null });
  }

  /**
   * Remove all filters.
   * @returns {Promise<void>} A promise that resolves as soon as all filters have been removed from the scene's fxmaster
   *                          flags
   */
  async removeAll() {
    await canvas.scene?.unsetFlag(packageId, "filters");
  }

  /**
   * Toggle a named filter on or off.
   * @param {string} name     The name of the filter
   * @param {string} type     The type of the filter
   * @param {object} options  The options for the filter
   * @returns {Promise<void>} A promise that resolves as soon as the filter has been toggled
   */
  async switch(name, type, options) {
    if (!canvas.scene) {
      return;
    }
    const filterInfos = canvas.scene.getFlag(packageId, "filters") ?? {};
    if (filterInfos[name]) {
      return this.removeFilter(name);
    } else {
      return this.addFilter(name, type, options);
    }
  }

  async setFilters(filterInfoArray) {
    const filterInfos = Object.fromEntries(filterInfoArray.map((filterInfo) => [foundry.utils.randomID(), filterInfo]));
    await resetFlag(canvas.scene, "filters", filterInfos);
  }

  #animate() {
    for (const key in this.filters) {
      this.filters[key].step();
    }
  }

  #registerHooks() {
    Hooks.on("canvasInit", () => {
      if (isEnabled()) {
        this.#clear();
      }
    });

    Hooks.on("canvasReady", async () => {
      if (isEnabled()) {
        await this.#activate();
      }
    });

    Hooks.on("updateScene", (scene, data) => {
      if (!isEnabled() || scene !== canvas.scene) {
        return;
      }
      if (
        foundry.utils.hasProperty(data, "flags.fxmaster.filters") ||
        foundry.utils.hasProperty(data, "flags.fxmaster.-=filters")
      ) {
        this.#update();
      }
    });
  }
}
