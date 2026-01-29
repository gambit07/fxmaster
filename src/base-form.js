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

    const wire = (inp) => {
      if (!inp) return;
      ["input", "change", "colorchange"].forEach((evt) => {
        try {
          inp.addEventListener(evt, (e) => updateFn.call(this, e, inp));
        } catch {}
      });
    };

    element.querySelectorAll('.fxmaster-input-color input[type="color"]').forEach(wire);
    element.querySelectorAll('.fxmaster-input-color input[type="text"]').forEach(wire);
    element.querySelectorAll(".fxmaster-input-color color-picker").forEach(wire);
  }

  /**
   * Wire multi-select widgets so selection changes reliably trigger updateParam.
   *
   * Depending on Foundry version and interaction method, the <multi-select>
   * component may dispatch events from internal elements. This helper listens
   * at the form level and forwards the nearest named multi-select control to
   * the provided update function.
   *
   * @param {HTMLElement} element  The root element to listen on. Defaults to the form element.
   * @param {Function} updateFn    The update function to call.
   */
  wireMultiSelectInputs(element = this.element, updateFn = this.constructor.actions?.updateParam) {
    if (!element || !updateFn) return;

    try {
      this._fxmMultiSelectAbort?.abort?.();
    } catch {}

    const ac = new AbortController();
    this._fxmMultiSelectAbort = ac;

    const invoke = (e, control) => {
      try {
        updateFn.call(this, e, control);
      } catch {}
    };

    const findControl = (target) => {
      if (!target) return null;
      const ms = target.closest?.("multi-select[name]");
      if (ms) return ms;
      const sel = target.closest?.("select[multiple][name]");
      return sel ?? null;
    };

    element.addEventListener(
      "change",
      (e) => {
        const ctrl = findControl(e.target);
        if (ctrl) invoke(e, ctrl);
      },
      { capture: true, signal: ac.signal },
    );

    element.addEventListener(
      "input",
      (e) => {
        const t = e.target;
        if (!t?.matches?.("multi-select, select[multiple]")) return;
        const ctrl = findControl(t);
        if (ctrl) invoke(e, ctrl);
      },
      { capture: true, signal: ac.signal },
    );

    element.addEventListener(
      "click",
      (e) => {
        const t = e.target;
        if (t?.matches?.("input, textarea")) return;
        const ctrl = findControl(t);
        if (ctrl) invoke(e, ctrl);
      },
      { capture: true, signal: ac.signal },
    );
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
          value: input.value ?? input.getAttribute?.("value") ?? param.value?.value ?? "#000000",
        };
        continue;
      }

      if (param.type === "multi-select") {
        const multi =
          form.querySelector(`multi-select[name="${base}"]`) ||
          form.querySelector(`multi-select[data-name="${base}"]`) ||
          null;

        /** @type {string[]} */
        let values = [];

        if (multi) {
          try {
            const mv = multi.value ?? multi.getAttribute?.("value");
            if (mv instanceof Set) values = Array.from(mv);
            else if (Array.isArray(mv)) values = mv;
            else if (typeof mv === "string" && mv.trim()) {
              const s = mv.trim();
              try {
                const parsed = JSON.parse(s);
                if (Array.isArray(parsed)) values = parsed;
                else values = s.split(",");
              } catch {
                values = s.split(",");
              }
            }
          } catch {}

          if (!values.length) {
            try {
              const tags = Array.from(
                multi.querySelectorAll(
                  ".tag[data-key], .tag[data-value], .tag[data-id], .tag[data-tag], .tag[data-option]",
                ),
              );
              values = tags
                .map((t) => t.dataset.key ?? t.dataset.value ?? t.dataset.id ?? t.dataset.tag ?? t.dataset.option)
                .filter(Boolean);
            } catch {}
          }

          if (!values.length) {
            try {
              const innerSelect =
                multi.querySelector(`select[name="${base}"]`) || multi.querySelector("select[multiple]") || null;
              if (innerSelect?.multiple) {
                values = Array.from(innerSelect.selectedOptions)
                  .map((o) => o.value)
                  .filter(Boolean);
              }
            } catch {}
          }

          if (!values.length) {
            try {
              const hidden =
                multi.querySelector(`input[type="hidden"][name="${base}"]`) ||
                multi.querySelector('input[type="hidden"]') ||
                null;
              const hv = hidden?.value;
              if (typeof hv === "string" && hv.trim()) {
                const s = hv.trim();
                try {
                  const parsed = JSON.parse(s);
                  if (Array.isArray(parsed)) values = parsed;
                  else values = s.split(",");
                } catch {
                  values = s.split(",");
                }
              }
            } catch {}
          }
        }

        if (!values.length) {
          const sel = form.querySelector(`select[name="${base}"]`);
          if (sel?.multiple)
            values = Array.from(sel.selectedOptions)
              .map((o) => o.value)
              .filter(Boolean);
        }

        if (!values.length) {
          values = Array.isArray(param.value)
            ? param.value
            : param.value != null && param.value !== ""
            ? [param.value]
            : [];
        }

        values = Array.from(new Set(values.map(String).filter((v) => v != null && v !== "")));
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
    try {
      this._fxmWireConditionalVisibility?.();
    } catch {}
  }

  _onClose(...args) {
    try {
      this._fxmUnwireConditionalVisibility?.();
    } catch {}
    try {
      this._fxmMultiSelectAbort?.abort?.();
    } catch {}
    return super._onClose?.(...args);
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

  /* -------------------------------------------- */
  /* Conditional parameter visibility (shared UI) */
  /* -------------------------------------------- */

  /**
   * Remove any previously-attached conditional visibility listeners.
   */
  _fxmUnwireConditionalVisibility() {
    try {
      this._fxmConditionalVisibilityAbort?.abort();
    } catch {}
    this._fxmConditionalVisibilityAbort = null;
    this._fxmConditionalVisibilityRules = null;
  }

  /**
   * Wire a lightweight, extendable system for hiding/showing parameters based
   * on other parameter values.
   *
   * To opt-in, a parameter config can declare:
   *   - showWhen: { otherParamName: expectedValue, ... }
   *   - hideWhen: { otherParamName: expectedValue, ... }
   */
  _fxmWireConditionalVisibility() {
    this._fxmUnwireConditionalVisibility();

    const root = this.element;
    if (!root) return;

    const sources = [];
    try {
      const cfg = CONFIG?.fxmaster;
      if (cfg?.particleEffects) sources.push(cfg.particleEffects);
      if (cfg?.filterEffects) sources.push(cfg.filterEffects);
    } catch {}

    if (!sources.length) return;

    const ac = new AbortController();
    this._fxmConditionalVisibilityAbort = ac;

    const rules = [];

    for (const defs of sources) {
      for (const cls of Object.values(defs ?? {})) {
        const label = cls?.label;
        const params = cls?.parameters;
        if (!label || !params) continue;

        for (const [paramName, paramCfg] of Object.entries(params)) {
          const showWhen = paramCfg?.showWhen;
          const hideWhen = paramCfg?.hideWhen;
          if (!showWhen && !hideWhen) continue;

          const inputName = `${label}_${paramName}`;
          const input =
            root.querySelector(`[name="${inputName}"]`) || root.querySelector(`[name="${inputName}_apply"]`) || null;
          if (!input) continue;

          const row = this.constructor._fxmFindFieldRow(input, root);
          if (!row) continue;

          rules.push({ label, paramName, showWhen, hideWhen, row });
        }
      }
    }

    if (!rules.length) return;

    this._fxmConditionalVisibilityRules = rules;

    const getValue = (effectLabel, dep) => {
      const nm = `${effectLabel}_${dep}`;
      const el = root.querySelector(`[name="${nm}"]`) || root.querySelector(`[name="${nm}_apply"]`) || null;
      return this.constructor._fxmReadInputValue(el);
    };

    const evalCond = (cond, effectLabel) => {
      if (!cond) return true;
      if (typeof cond === "function") {
        try {
          return !!cond({ get: (k) => getValue(effectLabel, k) });
        } catch {
          return true;
        }
      }
      if (typeof cond === "object") {
        return Object.entries(cond).every(([k, expected]) => {
          const actual = getValue(effectLabel, k);
          return this.constructor._fxmLooseEquals(actual, expected);
        });
      }
      return true;
    };

    const applyAll = () => {
      for (const r of rules) {
        const showOk = evalCond(r.showWhen, r.label);
        const hideOk = r.hideWhen ? evalCond(r.hideWhen, r.label) : false;
        const visible = showOk && !hideOk;
        r.row.style.display = visible ? "" : "none";
      }
    };

    applyAll();

    let raf = null;
    const schedule = () => {
      if (raf != null) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        applyAll();
      });
    };

    root.addEventListener("change", schedule, { signal: ac.signal, capture: true });
    root.addEventListener("input", schedule, { signal: ac.signal, capture: true });
  }

  /**
   * Best-effort read of an input's current value.
   * @param {HTMLElement|null} el
   */
  static _fxmReadInputValue(el) {
    if (!el) return undefined;

    if (el instanceof HTMLSelectElement) {
      if (el.multiple) return Array.from(el.selectedOptions).map((o) => o.value);
      return el.value;
    }

    if (el instanceof HTMLInputElement) {
      if (el.type === "checkbox") return !!el.checked;
      if (el.type === "range" || el.type === "number") {
        const n = Number(el.value);
        return Number.isFinite(n) ? n : undefined;
      }
      return el.value;
    }

    const tag = (el.tagName ?? "").toLowerCase();
    if (tag === "color-picker") {
      const v = el.value ?? el.getAttribute?.("value");
      return v;
    }

    return el.value ?? el.getAttribute?.("value");
  }

  /**
   * Loose equality that handles common HTML coercions (e.g., "true" vs true).
   */
  static _fxmLooseEquals(actual, expected) {
    if (typeof expected === "boolean") {
      if (typeof actual === "string") return (actual === "true") === expected;
      return !!actual === expected;
    }

    if (typeof expected === "number") {
      const n = Number(actual);
      if (!Number.isFinite(n)) return false;
      return n === expected;
    }

    if (Array.isArray(expected)) {
      if (!Array.isArray(actual)) return false;
      return expected.length === actual.length && expected.every((v) => actual.includes(v));
    }

    return actual === expected;
  }

  /**
   * Attempt to find the container element that represents a single "row" for
   * a given parameter control.
   */
  static _fxmFindFieldRow(el, root) {
    if (!el) return null;

    const selectors = [
      ".form-group",
      ".fxmaster-setting",
      ".fxmaster-param",
      ".fxmaster-parameter",
      ".fxmaster-filter-param",
      ".fxmaster-particle-param",
      ".fxmaster-particles-param",
      ".fxmaster-filters-param",
      ".setting",
    ];

    for (const sel of selectors) {
      const row = el.closest(sel);
      if (row && row !== root && root.contains(row)) return row;
    }

    const wrapper = el.closest(
      ".fxmaster-input-range, .fxmaster-input-checkbox, .fxmaster-input-color, .fxmaster-input-multi",
    );
    if (wrapper) {
      const parent = wrapper.parentElement;
      if (parent && parent !== root) return parent;
      if (wrapper !== root) return wrapper;
    }

    const parent = el.parentElement;
    if (parent && parent !== root) return parent;
    return null;
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
