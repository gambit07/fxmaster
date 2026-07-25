const COMPASS_DIRECTIONS = ["E", "NE", "N", "NW", "W", "SW", "S", "SE"];

/**
 * Determine whether an effect parameter represents a compass-compatible direction angle.
 *
 * Parameters can explicitly opt in or out with `compassDirection`. Otherwise numeric parameters whose names end in "direction" are treated as geometric direction angles.
 *
 * @param {string|null|undefined} parameterName
 * @param {Record<string, any>|null|undefined} parameterConfig
 * @returns {boolean}
 */
export function isCompassDirectionParameter(parameterName, parameterConfig) {
  if (parameterConfig?.compassDirection === false) return false;
  if (parameterConfig?.compassDirection === true) return true;

  const type = String(parameterConfig?.type ?? "").toLowerCase();
  if (type && type !== "range" && type !== "number") return false;

  return /direction$/i.test(String(parameterName ?? "").trim());
}

/**
 * Mark form controls that use compass-compatible direction values.
 * @param {HTMLFormElement|HTMLElement|null|undefined} root
 * @param {Record<string, any>|null|undefined} effectDatabase
 * @returns {void}
 */
export function configureCompassDirectionInputs(root, effectDatabase) {
  if (!root?.querySelectorAll || !effectDatabase) return;

  const namedControls = Array.from(root.querySelectorAll("[name]"));
  for (const [effectType, effectClass] of Object.entries(effectDatabase)) {
    for (const [parameterName, parameterConfig] of Object.entries(effectClass?.parameters ?? {})) {
      if (!isCompassDirectionParameter(parameterName, parameterConfig)) continue;
      const fieldName = `system.${effectType}_${parameterName}`;
      const controls = namedControls.filter((control) => {
        const name = String(control?.name ?? control?.getAttribute?.("name") ?? "");
        return name === fieldName;
      });
      const named = root.elements?.namedItem?.(fieldName);
      if (named && !controls.includes(named)) controls.push(named);

      for (const control of controls) {
        const nested = control?.querySelectorAll?.('input[type="range"], input[type="number"], range-picker') ?? [];
        const targets = [control, ...nested];
        for (const target of targets) {
          target?.setAttribute?.("data-fxm-compass-direction", "true");
          if (target?.dataset) target.dataset.fxmCompassDirection = "true";
        }
      }
    }
  }
}

/**
 * Convert FXMaster's geometric direction convention into an eight-point compass abbreviation.
 *
 * FXMaster uses 0° = east/right, 90° = north/up, with angles increasing counterclockwise.
 *
 * @param {number|string|null|undefined} value
 * @returns {"E"|"NE"|"N"|"NW"|"W"|"SW"|"S"|"SE"|""}
 */
export function directionDegreesToCompass(value) {
  const degrees = Number(value);
  if (!Number.isFinite(degrees)) return "";

  const normalized = ((degrees % 360) + 360) % 360;
  const index = Math.round(normalized / 45) % COMPASS_DIRECTIONS.length;
  return COMPASS_DIRECTIONS[index];
}

/**
 * Identify a rendered input that should expose a compass suffix.
 *
 * Management inputs are explicitly annotated by the Handlebars parameter helper. Region behavior forms are inferred from their schema field names so registered FXMaster+ effects receive the same behavior without Plus-side changes.
 *
 * @param {Element|null|undefined} input
 * @returns {boolean}
 */
export function isCompassDirectionInput(input) {
  if (!input) return false;
  if (String(input?.dataset?.fxmCompassDirection ?? "") === "true") return true;

  const tag = String(input?.tagName ?? "").toLowerCase();
  const name = String(input?.getAttribute?.("name") ?? input?.name ?? "").replace(/\[\]$/, "");
  const type = String(input?.getAttribute?.("type") ?? input?.type ?? "").toLowerCase();
  if (type && type !== "range" && type !== "number") return false;
  if (tag && !["input", "range-picker"].includes(tag)) return false;

  return /(?:^|[._-])[^.[\]-]*direction$/i.test(name);
}

/**
 * Locate the visible title/label associated with a direction control.
 *
 * @param {Element} input
 * @param {ParentNode|null|undefined} root
 * @returns {Element|null}
 */
function findDirectionLabel(input, root) {
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
    const explicitLabel = root.querySelector(`label[for="${escapedId}"]`);
    if (explicitLabel) return explicitLabel;
  }

  return null;
}

/**
 * Update the compass suffix beside one rendered direction parameter.
 *
 * @param {Element|null|undefined} input
 * @param {ParentNode|null|undefined} [root]
 * @returns {string}
 */
export function updateCompassDirectionOutput(input, root = input?.closest?.("form") ?? input?.ownerDocument ?? null) {
  if (!isCompassDirectionInput(input)) return "";

  const compass = directionDegreesToCompass(input?.value);
  if (!compass) return "";

  input.dataset.fxmCompassDirection = "true";
  input.setAttribute?.("aria-valuetext", `${input.value}°, ${compass}`);

  const label = findDirectionLabel(input, root);
  if (!label) return compass;

  let suffix = label.querySelector?.(":scope > .fxmaster-direction-compass");
  if (!suffix) {
    suffix = input.ownerDocument?.createElement?.("span") ?? globalThis.document?.createElement?.("span") ?? null;
    if (!suffix) return compass;
    suffix.className = "fxmaster-direction-compass";
    suffix.setAttribute("aria-hidden", "true");
    label.appendChild(suffix);
  }

  let icon = suffix.querySelector?.(":scope > .fxmaster-direction-compass-icon");
  let value = suffix.querySelector?.(":scope > .fxmaster-direction-compass-value");
  if (!icon || !value) {
    const document = input.ownerDocument ?? globalThis.document ?? null;
    icon = document?.createElement?.("i") ?? null;
    value = document?.createElement?.("span") ?? null;
    if (!icon || !value) return compass;

    icon.className = "fa-solid fa-compass fxmaster-direction-compass-icon";
    value.className = "fxmaster-direction-compass-value";
    suffix.replaceChildren(icon, value);
  }

  value.textContent = compass;
  return compass;
}

/**
 * Initialize every rendered compass-compatible direction input beneath a root node.
 *
 * @param {ParentNode|null|undefined} root
 * @returns {void}
 */
export function initializeCompassDirectionOutputs(root) {
  if (!root?.querySelectorAll) return;

  for (const input of root.querySelectorAll('input[type="range"], input[type="number"], range-picker')) {
    updateCompassDirectionOutput(input, root);
  }
}

/**
 * Wire live compass suffix updates for a form that is not managed by FXMasterBaseFormV2.
 *
 * @param {HTMLElement|null|undefined} root
 * @param {{signal?: AbortSignal}} [options]
 * @returns {void}
 */
export function wireCompassDirectionOutputs(root, { signal } = {}) {
  if (!root?.addEventListener) return;
  initializeCompassDirectionOutputs(root);

  const update = (event) => {
    let target = event?.target;
    if (!target?.matches?.('input[type="range"], input[type="number"], range-picker')) {
      target = target?.closest?.("range-picker[name]") ?? null;
    }
    if (!target?.matches?.('input[type="range"], input[type="number"], range-picker')) return;
    updateCompassDirectionOutput(target, root);
  };

  root.addEventListener("input", update, { capture: true, signal });
  root.addEventListener("change", update, { capture: true, signal });
}
