import { getDialogColors } from "./utils.js";
import { ALL_LEVELS_SELECTION, packageId } from "./constants.js";
import { logger } from "./logger.js";
/**
 * An abstract FormApplication that handles functionality common to multiple FXMaster forms. In particular, it provides the following functionality: * Handling of collapsible elements * Making slider changes for range inputs update the accompanying text box immediately * Handling the disabled state of the submission button
 *
 * @extends FormApplication
 * @abstract
 * @interface
 *
 * @param {Object} object                     Some object which is the target data structure to be updated by the form.
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
   * Foundry can finish an async ApplicationV2 render after a scene switch has already detached the window element. In that race, the core position update tries to read element.offsetWidth from null. Treat that case as a no-op instead of surfacing an unhandled render rejection.
   *
   * @param {object} [position]
   * @returns {object}
   */
  setPosition(position = {}) {
    const getElement = () => this.element?.[0] ?? this.element ?? null;
    const isDetached = () => {
      const element = getElement();
      return !element || element.isConnected === false;
    };
    const persistPosition = (value) => {
      this._persistPositionFlag(value ?? this.position ?? null);
      return value;
    };
    const handlePositionError = (err) => {
      const message = String(err?.message ?? "");
      if (message.includes("offsetWidth") && isDetached()) {
        logger.debug("FXMaster:", err);
        return this.position ?? {};
      }
      throw err;
    };

    try {
      if (isDetached()) return this.position ?? {};
      const result = super.setPosition(position);
      if (result && typeof result.then === "function") return result.then(persistPosition).catch(handlePositionError);
      return persistPosition(result ?? this.position ?? {});
    } catch (err) {
      return handlePositionError(err);
    }
  }

  /**
   * Return the user flag key used to persist this window's position.
   *
   * @returns {string|null}
   */
  _getPositionFlagKey() {
    return this.constructor.FXMASTER_POSITION_FLAG ?? null;
  }

  /**
   * Persist a finite ApplicationV2 position to the current user's FXMaster flags.
   *
   * @param {object|null|undefined} position
   * @returns {void}
   */
  _persistPositionFlag(position) {
    const key = this._getPositionFlagKey();
    if (!key || !position) return;

    const next = {};
    if (Number.isFinite(position.top)) next.top = position.top;
    if (Number.isFinite(position.left)) next.left = position.left;
    if (Number.isFinite(position.width)) next.width = position.width;
    if (!Object.keys(next).length) return;

    try {
      game.user.setFlag(packageId, key, next);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  /**
   * @param {HTMLElement} element  The root element to search for color inputs. Defaults to the form element.
   * @param {Function} updateFn    The function to call when a color input changes. The update function receives the event and the changed input as arguments. It will be bound to the current instance automatically.
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
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      });
    };

    element.querySelectorAll('.fxmaster-input-color input[type="color"]').forEach(wire);
    element.querySelectorAll('.fxmaster-input-color input[type="text"]').forEach(wire);
    element.querySelectorAll(".fxmaster-input-color color-picker").forEach(wire);
  }

  /**
   * Wire multi-select widgets so selection changes reliably trigger updateParam.
   *
   * @param {HTMLElement} element  The root element to listen on. Defaults to the form element.
   * @param {Function} updateFn    The update function to call.
   */
  wireMultiSelectInputs(element = this.element, updateFn = this.constructor.actions?.updateParam) {
    if (!element || !updateFn) return;

    try {
      this._fxmMultiSelectAbort?.abort?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    const ac = new AbortController();
    this._fxmMultiSelectAbort = ac;

    const invoke = (e, control) => {
      try {
        updateFn.call(this, e, control);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
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
   * Wire single-select widgets so selection changes trigger updateParam immediately.
   *
   * @param {HTMLElement} element  The root element to listen on. Defaults to the form element.
   * @param {Function} updateFn    The update function to call.
   */
  wireSelectInputs(element = this.element, updateFn = this.constructor.actions?.updateParam) {
    if (!element || !updateFn) return;

    try {
      this._fxmSelectAbort?.abort?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    const ac = new AbortController();
    this._fxmSelectAbort = ac;

    const invoke = (event, control) => {
      try {
        updateFn.call(this, event, control);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    };

    const resolveControl = (target) => {
      const control = target?.closest?.("select[name]:not([multiple])") ?? null;
      if (!control || control.closest?.("multi-select")) return null;
      return control;
    };

    for (const eventName of ["change", "input"]) {
      element.addEventListener(
        eventName,
        (event) => {
          const control = resolveControl(event.target);
          if (!control || !element.contains(control)) return;
          invoke(event, control);
        },
        { capture: true, signal: ac.signal },
      );
    }
  }

  /**
   * Update the textual output next to a range input.  Many parameter update handlers repeat the same code to update the <code>.range-value</code> element whenever a range slider is adjusted. This static helper encapsulates that behavior so it can be reused by management classes.
   *
   * @param {HTMLInputElement} input  The range input element that changed.
   */
  static updateRangeOutput(input) {
    if (!input || input.type !== "range") return;

    const dual = input.closest(".fxmaster-input-range-dual");
    if (dual) {
      const formatValue = (slider, rawValue) => {
        const decimalsAttr = Number(
          slider?.dataset?.decimals ?? slider?.closest?.(".fxmaster-input-range-dual")?.dataset?.decimals,
        );
        const stepText = String(slider?.step ?? "");
        const stepDecimals = stepText.includes(".") ? Math.max(0, stepText.length - stepText.indexOf(".") - 1) : 0;
        const decimals = Number.isFinite(decimalsAttr) ? decimalsAttr : stepDecimals;
        const value = Number(rawValue);
        if (!Number.isFinite(value)) return String(rawValue ?? "");
        return decimals > 0 ? value.toFixed(decimals) : String(Math.round(value));
      };

      const sliders = Array.from(dual.querySelectorAll('input[type="range"]'));
      const minSlider = dual.querySelector('input[type="range"][data-range-role="min"]') ?? sliders[0] ?? null;
      const maxSlider = dual.querySelector('input[type="range"][data-range-role="max"]') ?? sliders[1] ?? null;
      const minOutput = dual.querySelector(".range-value-min");
      const maxOutput = dual.querySelector(".range-value-max");
      if (minSlider && minOutput) minOutput.textContent = formatValue(minSlider, minSlider.value);
      if (maxSlider && maxOutput) maxOutput.textContent = formatValue(maxSlider, maxSlider.value);

      const min = Number(minSlider?.min ?? input.min ?? 0);
      const max = Number(maxSlider?.max ?? input.max ?? 1);
      const span = Math.max(1e-9, max - min);
      const minVal = Number(minSlider?.value ?? min);
      const maxVal = Number(maxSlider?.value ?? max);
      dual.style.setProperty("--range-start-pct", String(((minVal - min) / span) * 100));
      dual.style.setProperty("--range-end-pct", String(((maxVal - min) / span) * 100));
      return;
    }

    const container = input.closest(".fxmaster-input-range");
    const output = container?.querySelector(".range-value");
    if (output) output.textContent = input.value;
  }

  /**
   * Apply or remove the FXMaster highlight styling on a single control element.
   *
   * @param {HTMLElement|null|undefined} element
   * @param {boolean} isHighlighted
   * @returns {void}
   */
  static setControlHighlight(element, isHighlighted) {
    if (!element) return;
    if (isHighlighted) {
      element.style?.setProperty("background-color", "var(--color-warm-2)");
      element.style?.setProperty("border-color", "var(--color-warm-3)");
      return;
    }
    element.style?.removeProperty("background-color");
    element.style?.removeProperty("border-color");
  }

  /**
   * Set or remove the visual highlight on every matching tool button in the UI.
   *
   * @param {string} toolName
   * @param {boolean} isHighlighted
   * @returns {void}
   */
  static setToolButtonHighlight(toolName, isHighlighted) {
    for (const button of document.querySelectorAll(`[data-tool="${toolName}"]`)) {
      this.setControlHighlight(button, isHighlighted);
    }
  }

  /**
   * Set or remove the visual highlight on the parent Effects scene-control button.
   *
   * @param {boolean} isHighlighted
   * @returns {void}
   */
  static setSceneEffectsControlHighlight(isHighlighted) {
    const selectors = [
      '#scene-controls-layers button.control[data-control="effects"]',
      '#scene-controls-layers button[data-action="control"][data-control="effects"]',
      'button[data-action="control"][data-control="effects"]',
      'li.scene-control[data-control="effects"] button',
      'li.scene-control[data-control="effects"]',
    ];

    const seen = new Set();

    for (const selector of selectors) {
      for (const match of document.querySelectorAll(selector)) {
        const element = match?.matches?.("li") ? match.querySelector?.("button") ?? match : match;
        if (!element || seen.has(element)) continue;
        seen.add(element);
        this.setControlHighlight(element, isHighlighted);
      }
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

      if (param.type === "range-dual") {
        const minInput = form.querySelector(`[name="${base}_min"]`);
        const maxInput = form.querySelector(`[name="${base}_max"]`);
        if (!minInput && !maxInput) continue;

        const fallbackMin = Number(param.value?.min ?? param.min ?? 0);
        const fallbackMax = Number(param.value?.max ?? param.max ?? 1);
        let minValue = Number.parseFloat(minInput?.value ?? `${fallbackMin}`);
        let maxValue = Number.parseFloat(maxInput?.value ?? `${fallbackMax}`);

        if (!Number.isFinite(minValue)) minValue = fallbackMin;
        if (!Number.isFinite(maxValue)) maxValue = fallbackMax;
        if (minValue > maxValue) [minValue, maxValue] = [maxValue, minValue];

        options[key] = { min: minValue, max: maxValue };
        continue;
      }

      if (!input) continue;

      if (param.type === "color") {
        options[key] = {
          apply: Boolean(apply?.checked),
          value: input.value ?? input.getAttribute?.("value") ?? param.value?.value ?? "#000000",
        };
        continue;
      }

      if (param.type === "multi-select" || param.type === "scene-levels") {
        const multi =
          form.querySelector(`multi-select[name="${base}"]`) ||
          form.querySelector(`multi-select[data-name="${base}"]`) ||
          null;

        /** @type {string[]} */
        let values = [];

        if (multi) {
          if (param.type !== "scene-levels") {
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
            } catch (err) {
              logger.debug("FXMaster:", err);
            }
          }

          if (!values.length) {
            try {
              const tags = Array.from(multi.querySelectorAll(".tag"));
              const allLevelsLabel = String(game?.i18n?.localize?.("FXMASTER.Params.AllLevels") ?? "All Levels");
              const hasAllLevelsTag = tags.some((tag) => tag.textContent?.trim() === allLevelsLabel);
              if (hasAllLevelsTag) values = [ALL_LEVELS_SELECTION];
              else {
                values = tags
                  .map((t) => t.dataset.key ?? t.dataset.value ?? t.dataset.id ?? t.dataset.tag ?? t.dataset.option)
                  .filter(Boolean);
                if (
                  !values.length &&
                  param.type === "scene-levels" &&
                  multi.querySelector(".tags, .tag-list, .selected, .selected-tags")
                ) {
                  values = [ALL_LEVELS_SELECTION];
                }
              }
            } catch (err) {
              logger.debug("FXMaster:", err);
            }
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
            } catch (err) {
              logger.debug("FXMaster:", err);
            }
          }

          if (!values.length && param.type !== "scene-levels") {
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
            } catch (err) {
              logger.debug("FXMaster:", err);
            }
          }
        }

        if (!values.length) {
          const sel = form.querySelector(`select[name="${base}"]`);
          if (sel?.multiple)
            values = Array.from(sel.selectedOptions)
              .map((o) => o.value)
              .filter(Boolean);
        }

        if (!values.length && param.type !== "scene-levels") {
          values = Array.isArray(param.value)
            ? param.value
            : param.value != null && param.value !== ""
            ? [param.value]
            : [];
        }

        values = Array.from(new Set(values.map(String).filter((v) => v != null && v !== "")));
        if (param.type === "scene-levels") {
          let allLevelsSelected = values.includes(ALL_LEVELS_SELECTION);
          if (!allLevelsSelected && multi) {
            try {
              const allLevelsLabel = String(game?.i18n?.localize?.("FXMASTER.Params.AllLevels") ?? "All Levels");
              allLevelsSelected = !!multi.querySelector(`option[value="${ALL_LEVELS_SELECTION}"]:checked`);
              if (!allLevelsSelected) {
                allLevelsSelected = Array.from(
                  multi.querySelectorAll(
                    ".tag[data-key], .tag[data-value], .tag[data-id], .tag[data-tag], .tag[data-option], .tag",
                  ),
                ).some((tag) => {
                  const value =
                    tag.dataset.key ??
                    tag.dataset.value ??
                    tag.dataset.id ??
                    tag.dataset.tag ??
                    tag.dataset.option ??
                    tag.textContent?.trim();
                  return value === ALL_LEVELS_SELECTION || value === allLevelsLabel;
                });
              }
            } catch (err) {
              logger.debug("FXMaster:", err);
            }
          }
          options[key] = allLevelsSelected ? [] : values.filter((value) => value !== ALL_LEVELS_SELECTION);
        } else {
          options[key] = values;
        }
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

  /**
   * Keep paired dual-range slider values ordered and clamped.
   *
   * @param {HTMLInputElement|null|undefined} input
   * @returns {void}
   */
  static syncDualRangeInput(input) {
    if (!input || input.type !== "range") return;

    const container = input.closest(".fxmaster-input-range-dual");
    if (!container) return;

    const minSlider = container.querySelector('input[type="range"][data-range-role="min"]');
    const maxSlider = container.querySelector('input[type="range"][data-range-role="max"]');
    if (!minSlider || !maxSlider) return;

    let minValue = Number.parseFloat(minSlider.value || "0");
    let maxValue = Number.parseFloat(maxSlider.value || "0");
    if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) return;

    if (input === minSlider && minValue > maxValue) {
      maxValue = minValue;
      maxSlider.value = String(maxValue);
    } else if (input === maxSlider && maxValue < minValue) {
      minValue = maxValue;
      minSlider.value = String(minValue);
    }
  }

  _onRender(options) {
    super._onRender?.(options);
    this.animateTitleBar(this);
    try {
      this._fxmWireConditionalVisibility?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      this.applyTooltipDirection(this.element);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  /**
   * Apply the configured FXMaster tooltip direction to every tooltip element in a rendered application.
   *
   * @param {HTMLElement|null|undefined} root
   * @returns {void}
   */
  applyTooltipDirection(root = this.element) {
    if (!root) return;

    const configuredDirection = String(game?.settings?.get?.(packageId, "tooltipDirection") ?? "UP")
      .trim()
      .toUpperCase();
    const direction = ["UP", "DOWN", "LEFT", "RIGHT"].includes(configuredDirection) ? configuredDirection : "UP";

    for (const element of root.querySelectorAll?.("[data-tooltip]") ?? []) {
      element.dataset.tooltipDirection = direction;
    }
  }

  _onClose(...args) {
    try {
      this._fxmUnwireConditionalVisibility?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      this._fxmMultiSelectAbort?.abort?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      this._fxmSelectAbort?.abort?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      this._fxmRangeBehaviorAbort?.abort?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    this._fxmRangeBehaviorAbort = null;
    return super._onClose?.(...args);
  }

  /**
   * Prevent wheel and keyboard adjustments on unfocused sliders, while keeping focused slider changes synchronized with the rendered output and backing data model.
   */
  _wireRangeWheelBehavior({ getScrollWrapper, onInput } = {}) {
    try {
      this._fxmRangeBehaviorAbort?.abort();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    this._fxmRangeBehaviorAbort = null;

    const root = this.element;
    if (!root) return;

    const content = root.querySelector(".window-content") ?? root;
    const getWrapper = getScrollWrapper ?? ((slider) => slider.closest(".window-content") ?? content);
    const ac = new AbortController();
    this._fxmRangeBehaviorAbort = ac;

    const isFocusedSlider = (slider) => slider && (document.activeElement === slider || slider.matches?.(":focus"));
    const clampToStep = (slider, rawValue) => {
      const min = Number.parseFloat(slider.min);
      const max = Number.parseFloat(slider.max);
      const stepAttr = Number.parseFloat(slider.step);
      const hasMin = Number.isFinite(min);
      const hasMax = Number.isFinite(max);
      const step = Number.isFinite(stepAttr) && stepAttr > 0 ? stepAttr : 1;
      const base = hasMin ? min : 0;
      let next = Number.isFinite(rawValue) ? rawValue : Number.parseFloat(slider.value || "0") || 0;
      if (hasMin) next = Math.max(min, next);
      if (hasMax) next = Math.min(max, next);
      next = base + Math.round((next - base) / step) * step;
      if (hasMin) next = Math.max(min, next);
      if (hasMax) next = Math.min(max, next);
      const decimals = (() => {
        const source = slider.step && slider.step !== "any" ? slider.step : `${step}`;
        const idx = source.indexOf(".");
        return idx >= 0 ? Math.max(0, source.length - idx - 1) : 0;
      })();
      return decimals > 0 ? Number(next.toFixed(decimals)) : next;
    };
    const syncSlider = (slider, event = null) => {
      if (!slider) return;
      this.constructor.syncDualRangeInput(slider);
      this.constructor.updateRangeOutput(slider);
      onInput?.(event, slider);
    };
    const resolveScrollWrapper = (slider) => {
      const preferred = getWrapper(slider) ?? content;
      const isScrollable = (element) => {
        if (!element) return false;
        const { scrollHeight, clientHeight } = element;
        return scrollHeight > clientHeight + 1;
      };

      if (isScrollable(preferred)) return preferred;

      let current = preferred?.parentElement ?? null;
      while (current && current !== root) {
        if (isScrollable(current)) return current;
        current = current.parentElement;
      }

      return isScrollable(content) ? content : preferred;
    };
    const applySliderValue = (slider, nextValue, { dispatchChange = true } = {}) => {
      const next = clampToStep(slider, nextValue);
      const cur = Number.parseFloat(slider.value || "0");
      if (Number.isFinite(cur) && Math.abs(cur - next) <= 1e-9) {
        this.constructor.syncDualRangeInput(slider);
        this.constructor.updateRangeOutput(slider);
        return;
      }

      slider.value = String(next);
      this.constructor.syncDualRangeInput(slider);
      this.constructor.updateRangeOutput(slider);
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      if (dispatchChange) slider.dispatchEvent(new Event("change", { bubbles: true }));
    };

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
        { passive: true, signal: ac.signal },
      );
    });

    root.addEventListener(
      "wheel",
      (event) => {
        const slider = event.target?.closest?.('input[type="range"]');
        if (!slider || !root.contains(slider)) return;

        event.preventDefault();
        event.stopImmediatePropagation();

        if (isFocusedSlider(slider)) {
          const step = Number.parseFloat(slider.step || "1") || 1;
          const cur = Number.parseFloat(slider.value || "0") || 0;
          const dir = event.deltaY < 0 ? 1 : -1;
          applySliderValue(slider, cur + dir * step);
          return;
        }

        try {
          slider.blur?.();
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
        const wrapper = resolveScrollWrapper(slider);
        wrapper.scrollTop += event.deltaY;
      },
      { passive: false, capture: true, signal: ac.signal },
    );

    root.addEventListener(
      "keydown",
      (event) => {
        const slider = event.target?.closest?.('input[type="range"]');
        if (!slider || !root.contains(slider) || !isFocusedSlider(slider)) return;

        const key = String(event.key || "");
        const cur = Number.parseFloat(slider.value || "0") || 0;
        const step = Number.parseFloat(slider.step || "1") || 1;
        const pageStep = step * 10;
        const min = Number.parseFloat(slider.min);
        const max = Number.parseFloat(slider.max);

        let next = null;
        switch (key) {
          case "ArrowLeft":
          case "ArrowDown":
            next = cur - step;
            break;
          case "ArrowRight":
          case "ArrowUp":
            next = cur + step;
            break;
          case "PageDown":
            next = cur - pageStep;
            break;
          case "PageUp":
            next = cur + pageStep;
            break;
          case "Home":
            next = Number.isFinite(min) ? min : cur;
            break;
          case "End":
            next = Number.isFinite(max) ? max : cur;
            break;
          default:
            return;
        }

        event.preventDefault();
        event.stopImmediatePropagation();
        applySliderValue(slider, next);
      },
      { capture: true, signal: ac.signal },
    );

    root.addEventListener(
      "input",
      (event) => {
        const slider = event.target?.closest?.('input[type="range"]');
        if (!slider || !root.contains(slider)) return;
        syncSlider(slider, event);
      },
      { capture: true, signal: ac.signal },
    );

    root.addEventListener(
      "change",
      (event) => {
        const slider = event.target?.closest?.('input[type="range"]');
        if (!slider || !root.contains(slider)) return;
        this.constructor.syncDualRangeInput(slider);
        this.constructor.updateRangeOutput(slider);
      },
      { capture: true, signal: ac.signal },
    );
  }

  /**
   * Remove any previously-attached conditional visibility listeners.
   */
  _fxmUnwireConditionalVisibility() {
    try {
      this._fxmConditionalVisibilityAbort?.abort();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    this._fxmConditionalVisibilityAbort = null;
    this._fxmConditionalVisibilityRules = null;
  }

  /**
   * Wire a lightweight, extendable system for hiding/showing parameters based on other parameter values.
   *
   * To opt-in, a parameter config can declare:
   * - showWhen: { otherParamName: expectedValue, ... }
   * - hideWhen: { otherParamName: expectedValue, ... }
   * - regionOnly: true
   * - sceneOnly: true
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
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

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
          const regionOnly = !!paramCfg?.regionOnly;
          const sceneOnly = !!paramCfg?.sceneOnly;
          if (!showWhen && !hideWhen && !regionOnly && !sceneOnly) continue;

          const inputName = `${label}_${paramName}`;
          const input =
            root.querySelector(`[name="${inputName}"]`) ||
            root.querySelector(`[name="${inputName}_apply"]`) ||
            root.querySelector(`[name="${inputName}_min"]`) ||
            root.querySelector(`[name="${inputName}_max"]`) ||
            null;
          if (!input) continue;

          const row = this.constructor._fxmFindFieldRow(input, root);
          if (!row) continue;

          rules.push({ label, paramName, showWhen, hideWhen, regionOnly, sceneOnly, row });
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
      const isRegionContext = false;
      for (const r of rules) {
        const showOk = evalCond(r.showWhen, r.label);
        const hideOk = r.hideWhen ? evalCond(r.hideWhen, r.label) : false;
        const regionOk = !r.regionOnly || isRegionContext;
        const sceneOk = !r.sceneOnly || !isRegionContext;
        const visible = showOk && !hideOk && regionOk && sceneOk;
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

    const tag = (el.tagName ?? "").toLowerCase();
    if (tag === "multi-select") {
      const mv = el?.value;
      if (mv instanceof Set) return Array.from(mv);
      if (Array.isArray(mv)) return mv;

      const tags = el?.querySelectorAll?.("tag") ?? [];
      if (tags.length) {
        const vals = Array.from(tags)
          .map((t) => t.value)
          .filter((v) => v != null && v !== "");
        if (vals.length) return vals;
      }

      const inner = el?.querySelector?.("select[multiple]");
      if (inner instanceof HTMLSelectElement) {
        return Array.from(inner.selectedOptions).map((o) => o.value);
      }

      const hidden = el?.querySelectorAll?.('input[type="hidden"][name$="[]"]') ?? [];
      if (hidden.length) {
        const vals = Array.from(hidden)
          .map((h) => h.value)
          .filter((v) => v != null && v !== "");
        if (vals.length) return vals;
      }

      if (typeof mv === "string" && mv.length) {
        try {
          const parsed = JSON.parse(mv);
          if (Array.isArray(parsed)) return parsed;
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }

      return [];
    }

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

    if (tag === "color-picker") {
      const v = el.value ?? el.getAttribute?.("value");
      return v;
    }
    if (el?.value instanceof Set) return Array.from(el.value);
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
   * Attempt to find the container element that represents a single "row" for a given parameter control.
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
      ".fxmaster-input-range, .fxmaster-input-range-dual, .fxmaster-input-checkbox, .fxmaster-input-color, .fxmaster-input-multi, .fxmaster-input-select",
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
