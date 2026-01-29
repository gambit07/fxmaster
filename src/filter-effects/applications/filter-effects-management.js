import { FXMasterBaseFormV2 } from "../../base-form.js";
import { packageId } from "../../constants.js";
import { resetFlag } from "../../utils.js";
import { logger } from "../../logger.js";
import { getHiddenEffectsCount, openEffectsVisibilityManager } from "../../common/effects-visibility-manager.js";

export class FilterEffectsManagement extends FXMasterBaseFormV2 {
  constructor(scene, options = {}) {
    super(options);
    FilterEffectsManagement.instance = this;
    this.scene = scene;
  }

  static DEFAULT_OPTIONS = {
    id: "filters-config",
    tag: "section",
    classes: ["fxmaster", "form-v2", "ui-control"],
    actions: {
      updateParam: FilterEffectsManagement.updateParam,
      openHideEffects: FilterEffectsManagement.openHideEffects,
    },
    window: {
      title: "FXMASTER.Common.FilterEffectsManagementTitle",
      controls: [
        {
          icon: "fas fa-eye-slash",
          label: "FXMASTER.Common.HideEffects",
          action: "openHideEffects",
          visible: () => true,
        },
      ],
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

    const currentCoreFilters = Object.entries(currentFilters)
      .filter(([id, filter]) => id?.startsWith?.("core_") && filter?.type)
      .map(([, filter]) => filter);

    const activeFilters = Object.fromEntries(currentCoreFilters.map((filter) => [filter.type, filter.options]));

    const activeFilterTypes = new Set(currentCoreFilters.map((filter) => filter.type));

    const hidden = game.user.getFlag(packageId, "hiddenFilterEffects");
    const hiddenFilterEffects = new Set(Array.isArray(hidden) ? hidden : []);

    const passiveFilters = game.settings.get(packageId, "passiveFilterConfig") ?? {};

    const filters = Object.fromEntries(
      Object.entries(CONFIG.fxmaster.filterEffects)
        .filter(([type]) => !hiddenFilterEffects.has(type) || activeFilterTypes.has(type))
        .sort(([, a], [, b]) => a.label.localeCompare(b.label)),
    );

    return {
      filters,
      activeFilters,
      passiveFilters,
    };
  }

  /**
   * Open the per-user filter visibility manager.
   * @returns {void}
   */
  static openHideEffects() {
    openEffectsVisibilityManager({
      kind: "filter",
      onChange: async () => FilterEffectsManagement.instance?.render(true),
    });
  }

  /**
   * Update the Hide Effects header control tooltip with the current hidden count.
   * @returns {void}
   */
  _updateHideEffectsTooltip() {
    const count = getHiddenEffectsCount("filter");
    const tooltip = game.i18n.format("FXMASTER.Common.HideEffectsTooltip", { count });

    const control =
      this.element?.querySelector?.('.window-header [data-action="openHideEffects"]') ??
      this.element?.querySelector?.('[data-action="openHideEffects"]') ??
      null;

    if (control) control.dataset.tooltip = tooltip;
  }

  async _onRender(...args) {
    await super._onRender(...args);

    this._updateHideEffectsTooltip();

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
    this.wireMultiSelectInputs?.(this.element, FilterEffectsManagement.updateParam);
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

    const hasFilters = Object.keys(current).some((key) => key.startsWith("core_"));
    FXMasterBaseFormV2.setToolButtonHighlight("filters", hasFilters);
  }

  static updateParam(event, input) {
    const control =
      (input?.name ? input : null) || input?.closest?.("[name]") || event?.target?.closest?.("[name]") || null;

    if (!control?.name) return;
    FXMasterBaseFormV2.updateRangeOutput(control);

    const type = control.closest(".fxmaster-filter-expand")?.previousElementSibling?.dataset?.type;
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
