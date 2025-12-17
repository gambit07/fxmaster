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

    const pos = game.user.getFlag(packageId, "dialog-position-filtereffects");
    if (!pos) return;

    await new Promise((r) => requestAnimationFrame(r));

    const next = { top: pos.top, left: pos.left };
    if (Number.isFinite(pos.width)) next.width = pos.width;

    try {
      this.setPosition(next);
    } catch (err) {}

    const content = this.element.querySelector(".window-content");

    this._wireRangeWheelBehavior({
      getScrollWrapper: (slider) => slider.closest(".fxmaster-filters-container") ?? content,
      onInput: (event, slider) => FilterEffectsManagement.updateParam.call(this, event, slider),
    });

    this.wireColorInputs(this.element, FilterEffectsManagement.updateParam);
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
    FXMasterBaseFormV2.setToolButtonHighlight("filters", hasFilters);
  }

  static updateParam(event, input) {
    if (!input?.name) return;
    FXMasterBaseFormV2.updateRangeOutput(input);

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
