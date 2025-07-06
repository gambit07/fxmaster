import { getDialogColors } from "./utils.js";
/**
 * An abstract FormApplication that handles functionality common to multiple FXMaster forms.
 * In particular, it provides the following functionality:
 * * Handling of collapsible elements
 * * Making slider changes for range inputs update the accompanying text box immediately
 * * Handling the disabled state of the submission button
 *
 * @extends FormApplication
 * @abstract
 * @interface
 *
 * @param {Object} object                     Some object which is the target data structure to be be updated by the form.
 * @param {FormApplicationOptions} [options]  Additional options which modify the rendering of the sheet.
 */

const Base = foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2);

export class FXMasterBaseFormV2 extends Base {
  static DEFAULT_OPTIONS = {
    actions: {
      toggleFilter: FXMasterBaseFormV2.toggleFilter,
      toggleCollapse: FXMasterBaseFormV2.toggleCollapse,
      updateParam: FXMasterBaseFormV2.updateParam,
    },
  };
  static toggleFilter(event, button) {
    event.stopPropagation();
    const type = button.dataset.filter;
    const isEnabled = button.classList.toggle("enabled");
    this.updateEnabledState(type, isEnabled);
  }

  static toggleCollapse(event, element) {
    if (event.target.closest("[data-action='toggleFilter']")) return;
    element.classList.toggle("open");
  }

  static gatherFilterOptions(filterDB, form) {
    const label = filterDB.label;
    const options = {};

    for (const [key, param] of Object.entries(filterDB.parameters)) {
      const base = `${label}_${key}`;
      const input = form.querySelector(`[name="${base}"]`);
      const apply = form.querySelector(`[name="${base}_apply"]`);

      if (!input) continue;

      if (param.type === "color") {
        options[key] = {
          apply: Boolean(apply?.checked),
          value: input.value || (param.value?.value ?? "#000000"),
        };
        continue;
      } else if (param.type === "multi-select") {
        const select = input.querySelector("select");
        options[key] = select ? Array.from(select.selectedOptions, (o) => o.value) : [];
      } else if (input.type === "number" || param.type === "range") {
        options[key] = parseFloat(input.value);
        continue;
      }

      options[key] = input.value;
    }

    return options;
  }

  _onRender(options) {
    super._onRender?.(options);
    this.animateTitleBar(this);
  }

  animateTitleBar(app) {
    const titleBackground = app?.element?.querySelector(".window-header");
    if (!titleBackground) return;

    const duration = 20000;
    let startTime = null;

    titleBackground.style.border = "2px solid";
    titleBackground.style.borderImageSlice = 1;

    const { baseColor, highlightColor } = getDialogColors();

    function step(timestamp) {
      if (!startTime) startTime = timestamp;
      const elapsed = timestamp - startTime;
      const progress = (elapsed % duration) / duration;
      const angle = 360 * progress;

      titleBackground.style.borderImage = `linear-gradient(${angle}deg, ${baseColor}, ${highlightColor}, ${baseColor}) 1`;
      requestAnimationFrame(step);
    }

    requestAnimationFrame(step);
  }
}
