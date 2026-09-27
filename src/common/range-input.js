/**
 * Preserve native scrolling over unfocused range inputs and adjust focused sliders with wheel and keyboard input.
 *
 * @param {HTMLElement|null|undefined} root
 * @param {object} [options]
 * @param {Function} [options.onInput] Handle a slider input event.
 * @param {Function} [options.onSync] Synchronize paired values and labels.
 * @returns {AbortController|null}
 */
export function wireRangeInputBehavior(root, { onInput, onSync } = {}) {
  if (!root) return null;
  const win = root.ownerDocument?.defaultView ?? globalThis.window;
  const ac = new win.AbortController();
  const isFocusedSlider = (slider) => slider?.ownerDocument?.activeElement === slider || slider?.matches?.(":focus");
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
    onSync?.(slider);
    onInput?.(event, slider);
  };
  const applySliderValue = (slider, nextValue, { dispatchChange = true } = {}) => {
    const next = clampToStep(slider, nextValue);
    const cur = Number.parseFloat(slider.value || "0");
    if (Number.isFinite(cur) && Math.abs(cur - next) <= 1e-9) {
      onSync?.(slider);
      return;
    }

    slider.value = String(next);
    onSync?.(slider);
    const InputEvent = slider.ownerDocument.defaultView.Event;
    slider.dispatchEvent(new InputEvent("input", { bubbles: true }));
    if (dispatchChange) slider.dispatchEvent(new InputEvent("change", { bubbles: true }));
  };

  root.addEventListener(
    "pointerdown",
    (event) => {
      const slider = event.target?.closest?.('input[type="range"]');
      if (!slider || !root.contains(slider) || slider.disabled) return;
      slider.focus({ preventScroll: true });
    },
    { passive: true, capture: true, signal: ac.signal },
  );

  root.addEventListener(
    "wheel",
    (event) => {
      const slider = event.target?.closest?.('input[type="range"]');
      if (!slider || !root.contains(slider)) return;

      event.stopImmediatePropagation();
      if (!isFocusedSlider(slider) || slider.disabled || slider.readOnly || event.deltaY === 0) return;

      event.preventDefault();
      const step = Number.parseFloat(slider.step || "1") || 1;
      const cur = Number.parseFloat(slider.value || "0") || 0;
      const dir = event.deltaY < 0 ? 1 : -1;
      applySliderValue(slider, cur + dir * step);
    },
    { passive: false, capture: true, signal: ac.signal },
  );

  root.addEventListener(
    "keydown",
    (event) => {
      const slider = event.target?.closest?.('input[type="range"]');
      if (!slider || !root.contains(slider) || !isFocusedSlider(slider)) return;
      if (slider.disabled || slider.readOnly) return;

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
      onSync?.(slider);
    },
    { capture: true, signal: ac.signal },
  );
  return ac;
}
