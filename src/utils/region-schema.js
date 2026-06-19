import { isPlainObject } from "./object.js";

/**
 * Expand a Region behavior numeric field range enough to accept legacy stored values before world migrations run.
 *
 * @param {object} options
 * @param {object|null|undefined} parameterConfig
 * @returns {object}
 */
export function applyLegacyRangeTolerance(options, parameterConfig) {
  if (!isPlainObject(options) || !parameterConfig?.__fxmInternalRange) return options;

  const internal = parameterConfig.__fxmInternalRange;
  const internalMin = Number(internal.min);
  const internalMax = Number(internal.max);
  const internalStep = Number(internal.step);
  const internalDecimals = Number(internal.decimals);
  const optionMin = Number(options.min);
  const optionMax = Number(options.max);
  const optionStep = Number(options.step);
  const optionDecimals = Number(options.decimals);

  if (Number.isFinite(internalMin)) {
    options.min = Number.isFinite(optionMin) ? Math.min(optionMin, internalMin) : internalMin;
  }
  if (Number.isFinite(internalMax)) {
    options.max = Number.isFinite(optionMax) ? Math.max(optionMax, internalMax) : internalMax;
  }
  if (Number.isFinite(internalStep) && internalStep > 0) {
    options.step = Number.isFinite(optionStep) && optionStep > 0 ? Math.min(optionStep, internalStep) : internalStep;
  }
  if (Number.isFinite(internalDecimals) && internalDecimals >= 0) {
    options.decimals = Number.isFinite(optionDecimals) ? Math.max(optionDecimals, internalDecimals) : internalDecimals;
  }

  return options;
}

/**
 * Apply normalized public range attributes to Region behavior form inputs.
 *
 * @param {HTMLFormElement|HTMLElement|null} form
 * @param {object|null|undefined} effectDatabase
 * @returns {void}
 */
export function configureNormalizedRegionRangeInputs(form, effectDatabase) {
  if (!form || !effectDatabase) return;

  for (const [type, effectClass] of Object.entries(effectDatabase)) {
    const parameters = effectClass?.parameters ?? {};
    for (const [parameter, config] of Object.entries(parameters)) {
      if (!config?.__fxmInternalRange) continue;

      const input =
        form.elements?.namedItem?.(`system.${type}_${parameter}`) ??
        form.querySelector?.(`[name="system.${type}_${parameter}"]`);
      if (!input || typeof input.setAttribute !== "function") continue;

      if (config.min !== undefined) input.setAttribute("min", String(config.min));
      if (config.max !== undefined) input.setAttribute("max", String(config.max));
      if (config.step !== undefined) input.setAttribute("step", String(config.step));
    }
  }
}
