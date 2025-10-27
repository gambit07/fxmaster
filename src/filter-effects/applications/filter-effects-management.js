import { FXMasterBaseFormV2 } from "../../base-form.js";
import { packageId } from "../../constants.js";
import { resetFlag } from "../../utils.js";
import { logger } from "../../logger.js";

export class FilterEffectsManagement extends FXMasterBaseFormV2 {
  constructor(scene, options = {}) {
    super(options);
    this.scene = scene;
  }

  static DEFAULT_OPTIONS = {
    id: "filters-config",
    tag: "section",
    classes: ["fxmaster", "form-v2", "ui-control"],
    actions: {
      updateParam: FilterEffectsManagement.updateParam,
    },
    window: {
      title: "FXMASTER.Common.FilterEffectsManagementTitle",
    },
    position: {
      width: 325,
      height: "auto",
    },
  };

  static PARTS = [
    {
      template: "modules/fxmaster/templates/filter-effects-management.hbs",
    },
  ];

  async _prepareContext() {
    const currentFilters = canvas.scene?.getFlag(packageId, "filters") ?? {};
    const activeFilters = Object.fromEntries(
      Object.values(currentFilters).map((filter) => [filter.type, filter.options]),
    );

    const passiveFilters = game.settings.get(packageId, "passiveFilterConfig") ?? {};

    const filters = Object.fromEntries(
      Object.entries(CONFIG.fxmaster.filterEffects).sort(([, a], [, b]) => a.label.localeCompare(b.label)),
    );

    return {
      filters,
      activeFilters,
      passiveFilters,
    };
  }

  async _onRender(...args) {
    await super._onRender(...args);

    let windowPosition = game.user.getFlag(packageId, "dialog-position-filtereffects");
    if (windowPosition) {
      this.setPosition({ top: windowPosition.top, left: windowPosition.left });
    }

    const content = this.element.querySelector(".window-content");

    this.element.querySelectorAll("input[type=range]").forEach((slider) => {
      slider.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          e.stopImmediatePropagation();

          let wrapper = slider.closest(".fxmaster-filters-container");
          if (!wrapper) wrapper = content;

          wrapper.scrollTop += e.deltaY;
        },
        { passive: false, capture: true },
      );

      const output = slider.closest(".fxmaster-input-range")?.querySelector("output");
      if (output) {
        slider.addEventListener("input", (event) => {
          output.textContent = slider.value;
          FilterEffectsManagement.updateParam.call(this, event, slider);
        });
      }
    });

    this.element.querySelectorAll(".fxmaster-input-color input[type=checkbox]").forEach((cb) => {
      cb.addEventListener("change", (e) => FilterEffectsManagement.updateParam.call(this, e, cb));
    });
    this.element.querySelectorAll(".fxmaster-input-color input[type=color]").forEach((inp) => {
      inp.addEventListener("input", (e) => FilterEffectsManagement.updateParam.call(this, e, inp));
      inp.addEventListener("change", (e) => FilterEffectsManagement.updateParam.call(this, e, inp));
    });
  }

  async close(options) {
    const passive = {};

    for (const [type, filterDB] of Object.entries(CONFIG.fxmaster.filterEffects)) {
      const optionsObj = FilterEffectsManagement.gatherFilterOptions(filterDB, this.element);
      passive[type] = optionsObj;
    }

    game.settings.set(packageId, "passiveFilterConfig", passive);
    return super.close(options);
  }

  updateEnabledState(type, enabled) {
    const filtersDB = CONFIG.fxmaster.filterEffects[type];
    if (!filtersDB) {
      logger.warn(game.i18n.format("FXMASTER.Filters.TypeErrors.TypeNotFound", { type: type }));
      return;
    }

    const scene = canvas.scene;
    if (!scene) return;
    const current = foundry.utils.duplicate(scene.getFlag(packageId, "filters") ?? {});

    if (enabled) {
      const options = FilterEffectsManagement.gatherFilterOptions(filtersDB, this.element);
      current[`core_${type}`] = { type, options };
    } else {
      delete current[`core_${type}`];
    }

    resetFlag(scene, "filters", current);

    const hasFilters = Object.keys(current).some((key) => !key.startsWith("-="));
    const btn = document.querySelector(`[data-tool="filters"]`);
    if (hasFilters) {
      btn?.style?.setProperty("background-color", "var(--color-warm-2)");
      btn?.style?.setProperty("border-color", "var(--color-warm-3)");
    } else {
      btn?.style?.removeProperty("background-color");
      btn?.style?.removeProperty("border-color");
    }
  }

  static updateParam(event, input) {
    if (!input?.name) return;

    if (input.type === "range") {
      const container = input.closest(".fxmaster-input-range");
      const output = container?.querySelector(".range-value");
      if (output) output.textContent = input.value;
    }

    const type = input.closest(".fxmaster-filter-expand")?.previousElementSibling?.dataset?.type;
    if (!type) return;

    const scene = canvas.scene;
    const current = foundry.utils.duplicate(scene.getFlag(packageId, "filters") ?? {});
    const isActive = !!current[`core_${type}`];
    if (!isActive) return;

    const filterDB = CONFIG.fxmaster.filterEffects[type];
    if (!filterDB) return;

    const options = FilterEffectsManagement.gatherFilterOptions(filterDB, this.element);

    current[`core_${type}`].options = options;
    resetFlag(scene, "filters", current);
  }

  async _onClose(...args) {
    super._onClose(...args);
    const { top, left } = this.position;
    game.user.setFlag(packageId, "dialog-position-filtereffects", { top, left });
  }
}
