const MINUTE_LABEL_PARAMETER_PATTERN = /(?:^|[._-])(?:backgroundDuration|backgroundTrailRefillDuration)$/i;

/**
 * Format a duration expressed in seconds as a compact minute label.
 *
 * @param {number|string|null|undefined} value
 * @returns {string}
 */
export function formatSecondsAsMinuteLabel(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return "";
  const minutes = Math.max(0, seconds) / 60;
  const rounded = minutes >= 10 ? Math.round(minutes * 10) / 10 : Math.round(minutes * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1).replace(/\.0$/, "");
  return `${text}m`;
}

/**
 * Determine whether a parameter should expose compact minute labels.
 *
 * @param {string|null|undefined} parameterName
 * @param {Record<string, any>|null|undefined} parameterConfig
 * @returns {boolean}
 */
export function isMinuteLabelParameter(parameterName, parameterConfig = null) {
  if (parameterConfig?.labelOutput === "minutes") return true;
  return MINUTE_LABEL_PARAMETER_PATTERN.test(String(parameterName ?? "").trim());
}

function isMinuteLabelInput(input) {
  if (!input) return false;
  if (String(input?.dataset?.fxmLabelOutput ?? "") === "minutes") return true;
  const tag = String(input?.tagName ?? "").toLowerCase();
  const type = String(input?.getAttribute?.("type") ?? input?.type ?? "").toLowerCase();
  if (tag && !["input", "range-picker"].includes(tag)) return false;
  if (type && type !== "range" && type !== "number") return false;
  const name = String(input?.getAttribute?.("name") ?? input?.name ?? "").replace(/\[\]$/, "");
  return MINUTE_LABEL_PARAMETER_PATTERN.test(name);
}

function findParameterLabel(input, root) {
  const managementField = input.closest?.(".fxmaster-param-field");
  const managementTitle = managementField?.querySelector?.(".fxmaster-param-title");
  if (managementTitle) return managementTitle;

  const labels = Array.from(input?.labels ?? []);
  if (labels.length) return labels[0];

  const formGroup = input.closest?.(".form-group");
  if (formGroup) {
    const directLabel = Array.from(formGroup.children ?? []).find((child) => child?.tagName === "LABEL");
    if (directLabel) return directLabel;
    const groupLabel = formGroup.querySelector?.("label");
    if (groupLabel) return groupLabel;
  }

  const id = String(input?.id ?? "");
  if (id && root?.querySelector) {
    const escapedId = globalThis.CSS?.escape ? globalThis.CSS.escape(id) : id.replace(/["\\]/g, "\\$&");
    return root.querySelector(`label[for="${escapedId}"]`);
  }

  return null;
}

/**
 * Format a rendered range value according to the control metadata.
 *
 * @param {HTMLInputElement|Element|null|undefined} input
 * @param {number|string|null|undefined} value
 * @returns {string}
 */
export function formatRangeOutputValue(_input, value) {
  return String(value ?? "");
}

/**
 * Update the compact label output for one duration control.
 *
 * @param {Element|null|undefined} input
 * @param {ParentNode|null|undefined} [root]
 * @returns {string}
 */
export function updateMinuteLabelOutput(input, root = input?.closest?.("form") ?? input?.ownerDocument ?? null) {
  if (!isMinuteLabelInput(input)) return "";
  const label = findParameterLabel(input, root);
  if (!label) return "";

  const value = input?.value ?? input?.getAttribute?.("value");
  const text = formatSecondsAsMinuteLabel(value);
  if (!text) return "";

  input.dataset.fxmLabelOutput = "minutes";
  let suffix = label.querySelector?.(":scope > .fxmaster-minute-label-output");
  if (!suffix) {
    suffix = input.ownerDocument?.createElement?.("span") ?? globalThis.document?.createElement?.("span") ?? null;
    if (!suffix) return text;
    suffix.className = "fxmaster-minute-label-output";
    suffix.setAttribute("aria-hidden", "true");
    label.appendChild(suffix);
  }
  suffix.textContent = text;
  return text;
}

/**
 * Initialize compact minute outputs beneath a root node.
 *
 * @param {ParentNode|null|undefined} root
 * @returns {void}
 */
export function initializeMinuteLabelOutputs(root) {
  if (!root?.querySelectorAll) return;
  for (const input of root.querySelectorAll('input[type="range"], input[type="number"], range-picker')) {
    updateMinuteLabelOutput(input, root);
  }
}

/**
 * Wire compact minute output updates for duration controls.
 *
 * @param {HTMLElement|null|undefined} root
 * @param {{signal?: AbortSignal}} [options]
 * @returns {void}
 */
export function wireMinuteLabelOutputs(root, { signal } = {}) {
  if (!root?.addEventListener) return;
  initializeMinuteLabelOutputs(root);

  const update = (event) => {
    let target = event?.target;
    if (!target?.matches?.('input[type="range"], input[type="number"], range-picker')) {
      target = target?.closest?.("range-picker[name]") ?? null;
    }
    if (!target?.matches?.('input[type="range"], input[type="number"], range-picker')) return;
    updateMinuteLabelOutput(target, root);
  };

  root.addEventListener("input", update, { capture: true, signal });
  root.addEventListener("change", update, { capture: true, signal });
}
