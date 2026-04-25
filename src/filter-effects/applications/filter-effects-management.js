import { FXMasterBaseFormV2 } from "../../base-form.js";
import { packageId } from "../../constants.js";
import { resetFlag, updateSceneControlHighlights } from "../../utils.js";
import { logger } from "../../logger.js";
import { getHiddenEffectsCount, openEffectsVisibilityManager } from "../../common/effects-visibility-manager.js";
import { buildSceneEffectUid, promoteEffectStackUids } from "../../common/effect-stack.js";
import { FilterEffectsSceneManager } from "../filter-effects-scene-manager.js";

export class FilterEffectsManagement extends FXMasterBaseFormV2 {
  static FXMASTER_POSITION_FLAG = "dialog-position-filtereffects";
  /** @type {FilterEffectsManagement|undefined} */
  static #instance;

  /** @returns {FilterEffectsManagement|undefined} */
  static get instance() {
    return this.#instance;
  }

  constructor(scene, options = {}) {
    super(options);
    FilterEffectsManagement.#instance = this;
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
      resizable: true,
      minimizable: true,
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

    const passiveFilters = foundry.utils.deepClone(game.settings.get(packageId, "passiveFilterConfig") ?? {});
    for (const options of Object.values(passiveFilters)) {
      if (options && typeof options === "object") delete options.levels;
    }

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

    const element = this.element;
    if (!element?.isConnected) return;

    this._updateHideEffectsTooltip();

    const pos = game.user.getFlag(packageId, "dialog-position-filtereffects");
    if (pos) {
      await new Promise((r) => requestAnimationFrame(r));

      const liveElement = this.element;
      if (!liveElement?.isConnected) return;

      const next = { top: pos.top, left: pos.left };
      if (Number.isFinite(pos.width)) next.width = pos.width;

      try {
        this.setPosition(next);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    const liveElement = this.element;
    if (!liveElement?.isConnected) return;

    const content = liveElement.querySelector(".window-content") ?? liveElement;

    this._wireRangeWheelBehavior({
      getScrollWrapper: (slider) => slider.closest(".fxmaster-filters-container") ?? content,
      onInput: (event, slider) => FilterEffectsManagement.updateParam.call(this, event, slider),
    });

    this.wireColorInputs(liveElement, FilterEffectsManagement.updateParam);
    this.wireMultiSelectInputs?.(liveElement, FilterEffectsManagement.updateParam);
    this.wireSelectInputs?.(liveElement, FilterEffectsManagement.updateParam);
    this.applyTooltipDirection(liveElement);
  }

  async close(options) {
    const passive = {};

    for (const [type, filterDB] of Object.entries(CONFIG.fxmaster.filterEffects)) {
      const optionsObj = FilterEffectsManagement.gatherFilterOptions(filterDB, this.element);
      if (optionsObj && typeof optionsObj === "object") delete optionsObj.levels;
      passive[type] = optionsObj;
    }

    game.settings.set(packageId, "passiveFilterConfig", passive);
    return super.close(options);
  }

  async updateEnabledState(type, enabled) {
    const filtersDB = CONFIG.fxmaster.filterEffects[type];
    if (!filtersDB) {
      logger.warn(game.i18n.format("FXMASTER.Filters.TypeErrors.TypeNotFound", { type: type }));
      return;
    }

    const scene = canvas.scene;
    if (!scene) return;
    const current = foundry.utils.duplicate(scene.getFlag(packageId, "filters") ?? {});

    const effectId = `core_${type}`;

    if (enabled) {
      const options = FilterEffectsManagement.gatherFilterOptions(filtersDB, this.element);
      current[effectId] = { type, options };
    } else {
      delete current[effectId];
    }

    await resetFlag(scene, "filters", current);

    if (enabled) {
      await promoteEffectStackUids([buildSceneEffectUid("filter", effectId)], scene);
    }

    updateSceneControlHighlights();
  }

  static async updateParam(event, input) {
    const control =
      (input?.name ? input : null) || input?.closest?.("[name]") || event?.target?.closest?.("[name]") || null;

    if (!control?.name) return;
    FXMasterBaseFormV2.updateRangeOutput(control);

    const type = control.closest(".fxmaster-filter-expand")?.previousElementSibling?.dataset?.type;
    if (!type) return;

    const scene = canvas.scene;
    if (!scene) return;
    const sceneId = scene.id ?? null;
    const current = foundry.utils.duplicate(scene.getFlag(packageId, "filters") ?? {});
    const isActive = !!current[`core_${type}`];
    if (!isActive) return;

    const filterDB = CONFIG.fxmaster.filterEffects[type];
    if (!filterDB) return;

    const isMultiSelect =
      control?.matches?.("multi-select, select[multiple]") ||
      !!control?.closest?.("multi-select") ||
      (event?.target && !!event.target.closest?.("multi-select"));

    if (isMultiSelect) {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    } else {
      await new Promise(requestAnimationFrame);
    }

    const options = FilterEffectsManagement.gatherFilterOptions(filterDB, this.element);

    const writeOptions = async ({ sceneId, type, options, refresh = false }) => {
      try {
        const scene = sceneId ? game.scenes?.get?.(sceneId) ?? null : null;
        if (!scene) return;
        const cur = foundry.utils.duplicate(scene.getFlag(packageId, "filters") ?? {});
        if (!cur[`core_${type}`]) return;

        const prev = cur[`core_${type}`]?.options ?? {};
        const a = foundry.utils.diffObject(prev, options);
        const b = foundry.utils.diffObject(options, prev);
        const shouldRefresh = refresh && canvas?.scene?.id === sceneId;
        if (foundry.utils.isEmpty(a) && foundry.utils.isEmpty(b)) {
          if (shouldRefresh) await FilterEffectsSceneManager.instance.update({ skipFading: true });
          return;
        }

        cur[`core_${type}`].options = options;
        await resetFlag(scene, "filters", cur);
        if (shouldRefresh) await FilterEffectsSceneManager.instance.update({ skipFading: true });
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    };

    if (String(control.name).endsWith("_levels")) {
      await writeOptions({ sceneId, type, options: foundry.utils.deepClone(options), refresh: true });
      return;
    }

    this._debouncedFiltersWrites ??= new Map();
    const debounceKey = `${sceneId ?? "scene"}:${type}`;
    let debouncedWrite = this._debouncedFiltersWrites.get(debounceKey);
    if (!debouncedWrite) {
      debouncedWrite = foundry.utils.debounce(writeOptions, 150);
      this._debouncedFiltersWrites.set(debounceKey, debouncedWrite);
    }

    debouncedWrite({ sceneId, type, options: foundry.utils.deepClone(options) });
  }

  _storeCurrentPosition() {
    this._persistPositionFlag(this.position);
  }

  async _onClose(...args) {
    super._onClose(...args);
    this._storeCurrentPosition();
    try {
      if (FilterEffectsManagement.instance === this) FilterEffectsManagement.#instance = undefined;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }
}
