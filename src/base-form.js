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

  /**
   * Attach event listeners for color inputs and accompanying checkboxes.  Many of
   * FXMaster's management forms contain identical boilerplate to attach change
   * handlers to <code>.fxmaster-input-color</code> checkboxes and color
   * inputs so that parameter updates propagate immediately.  This helper
   * centralizes that logic in the base class.  It accepts an update
   * function which will be invoked with the current event and input element.
   *
   * @param {HTMLElement} element  The root element to search for color inputs. Defaults to the form element.
   * @param {Function} updateFn    The function to call when a color input changes. The update function
   *                                receives the event and the changed input as arguments. It will be bound
   *                                to the current instance automatically.
   */
  wireColorInputs(element = this.element, updateFn = this.constructor.actions?.updateParam) {
    if (!element || !updateFn) return;
    element.querySelectorAll('.fxmaster-input-color input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener("change", (e) => updateFn.call(this, e, cb));
    });
    element.querySelectorAll('.fxmaster-input-color input[type="color"]').forEach((inp) => {
      inp.addEventListener("input", (e) => updateFn.call(this, e, inp));
      inp.addEventListener("change", (e) => updateFn.call(this, e, inp));
    });
  }

  /**
   * Update the textual output next to a range input.  Many parameter update
   * handlers repeat the same code to update the <code>.range-value</code>
   * element whenever a range slider is adjusted.  This static helper
   * encapsulates that behavior so it can be reused by management classes.
   *
   * @param {HTMLInputElement} input  The range input element that changed.
   */
  static updateRangeOutput(input) {
    if (!input || input.type !== "range") return;
    const container = input.closest(".fxmaster-input-range");
    const output = container?.querySelector(".range-value");
    if (output) output.textContent = input.value;
  }

  /**
   * Set or remove the visual highlight on a tool button in the UI.  Both
   * filter- and particle-effect managers share identical logic to update
   * their corresponding toolbar buttons based on whether any effects are
   * active.  This helper centralizes that styling so managers need only
   * specify the tool name and whether highlighting should be applied.
   *
   * @param {string} toolName        The value of the data-tool attribute for the button.
   * @param {boolean} isHighlighted  Whether the button should be highlighted.
   */
  static setToolButtonHighlight(toolName, isHighlighted) {
    const btn = document.querySelector(`[data-tool="${toolName}"]`);
    if (!btn) return;
    if (isHighlighted) {
      btn.style?.setProperty("background-color", "var(--color-warm-2)");
      btn.style?.setProperty("border-color", "var(--color-warm-3)");
    } else {
      btn.style?.removeProperty("background-color");
      btn.style?.removeProperty("border-color");
    }
  }
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
      }

      if (param.type === "multi-select") {
        let values = input?.value;
        if (!values.length) values = param.value;
        options[key] = values;
        continue;
      }

      if (param.type === "checkbox") {
        options[key] = Boolean(input.checked);
        continue;
      }

      if (input.type === "number" || param.type === "range") {
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

  /**
   * Prevent mousewheel changing unfocused sliders, but allow mousewheel stepping
   * for the focused slider (without scrolling the container).
   */
  _wireRangeWheelBehavior({ getScrollWrapper, onInput } = {}) {
    const root = this.element;
    if (!root) return;

    const content = root.querySelector(".window-content") ?? root;

    const getWrapper = getScrollWrapper ?? ((slider) => slider.closest(".window-content") ?? content);

    root.querySelectorAll('input[type="range"]').forEach((slider) => {
      slider.addEventListener(
        "pointerdown",
        () => {
          try {
            slider.focus({ preventScroll: true });
          } catch {
            slider.focus();
          }
        },
        { passive: true },
      );

      slider.addEventListener(
        "wheel",
        (e) => {
          const isFocused = document.activeElement === slider || slider.matches(":focus");

          if (isFocused) {
            e.preventDefault();
            e.stopImmediatePropagation();

            const step = Number.parseFloat(slider.step || "1") || 1;
            const min = Number.parseFloat(slider.min || "0");
            const max = Number.parseFloat(slider.max || "100");
            const cur = Number.parseFloat(slider.value || "0") || 0;

            const dir = e.deltaY < 0 ? 1 : -1;
            const next = Math.min(max, Math.max(min, cur + dir * step));

            slider.value = String(next);
            slider.dispatchEvent(new Event("input", { bubbles: true }));
            slider.dispatchEvent(new Event("change", { bubbles: true }));
            return;
          }

          e.preventDefault();
          e.stopImmediatePropagation();
          const wrapper = getWrapper(slider) ?? content;
          wrapper.scrollTop += e.deltaY;
        },
        { passive: false, capture: true },
      );

      const output = slider.closest(".fxmaster-input-range")?.querySelector("output, .range-value");
      if (output) {
        slider.addEventListener("input", (event) => {
          output.textContent = slider.value;
          onInput?.(event, slider);
        });
      } else if (onInput) {
        slider.addEventListener("input", (event) => onInput(event, slider));
      }
    });
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
