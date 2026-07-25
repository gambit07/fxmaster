import { compressNormalizedRangeValue } from "../common/effect-parameter-normalization.js";
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
  if (parameterConfig.__fxmAcceptLegacyZero === true) options.min = Math.min(Number(options.min) || 0, 0);
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
 * Convert an out-of-band legacy internal value for display in a normalized Region slider.
 * Values already inside the public UI range are left untouched because they are valid normalized values.
 *
 * @param {object|null|undefined} parameterConfig
 * @param {unknown} value
 * @returns {unknown}
 */
export function normalizeRegionRangeInputValue(parameterConfig, value) {
  if (!parameterConfig?.__fxmInternalRange || value === null || value === undefined || value === "") {
    return value;
  }
  const raw = Number(value);
  if (!Number.isFinite(raw)) return value;

  const uiMin = Number(parameterConfig.min ?? 0);
  const uiMax = Number(parameterConfig.max ?? 1);
  const internalMin = Number(parameterConfig.__fxmInternalRange.min);
  const internalMax = Number(parameterConfig.__fxmInternalRange.max);
  if (![uiMin, uiMax, internalMin, internalMax].every(Number.isFinite)) return raw;

  const epsilon = 1e-9;
  const outsideUiRange = raw < uiMin - epsilon || raw > uiMax + epsilon;
  const insideInternalRange =
    raw >= Math.min(internalMin, internalMax) - epsilon && raw <= Math.max(internalMin, internalMax) + epsilon;
  return outsideUiRange && insideInternalRange ? compressNormalizedRangeValue(parameterConfig, raw) : raw;
}

/**
 * NumberField which keeps a legacy-tolerant validation range while presenting the public normalized range to
 * Foundry's range-picker. The range-picker captures min/max/step in its constructor, so changing attributes after
 * render is too late on Foundry V14.
 */
export class NormalizedRegionNumberField extends foundry.data.fields.NumberField {
  /**
   * @param {object} [options]
   * @param {object} [context]
   * @param {object|null} [parameterConfig]
   */
  constructor(options = {}, context = {}, parameterConfig = null) {
    super(options, context);
    this.fxmParameterConfig = parameterConfig;
  }

  /** @override */
  _toInput(config = {}) {
    const parameter = this.fxmParameterConfig;
    if (!parameter?.__fxmInternalRange) return super._toInput(config);

    const normalizedConfig = { ...config };
    if (parameter.min !== undefined) normalizedConfig.min = parameter.min;
    if (parameter.max !== undefined) normalizedConfig.max = parameter.max;
    if (parameter.step !== undefined) normalizedConfig.step = parameter.step;
    if (normalizedConfig.value === undefined) normalizedConfig.value = this.getInitialValue({});
    normalizedConfig.value = normalizeRegionRangeInputValue(parameter, normalizedConfig.value);
    return super._toInput(normalizedConfig);
  }
}

/**
 * Create a Region behavior NumberField. Normalized effect parameters receive a specialized input renderer while the
 * field's validation constraints remain legacy tolerant.
 *
 * @param {object} options
 * @param {object|null|undefined} parameterConfig
 * @returns {foundry.data.fields.NumberField}
 */
export function createRegionNumberField(options, parameterConfig = null) {
  if (!parameterConfig?.__fxmInternalRange) return new foundry.data.fields.NumberField(options);
  return new NormalizedRegionNumberField(options, {}, parameterConfig);
}

/**
 * Apply normalized public range attributes to Region behavior form inputs.
 *
 * This remains as a compatibility fallback for Foundry versions which render native inputs. On V14 the authoritative
 * range is supplied by NormalizedRegionNumberField before the range-picker custom element is constructed.
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
      if (!input) continue;

      const targets = [input, ...(input.querySelectorAll?.("input") ?? [])];
      for (const target of targets) {
        if (typeof target?.setAttribute !== "function") continue;
        if (config.min !== undefined) target.setAttribute("min", String(config.min));
        if (config.max !== undefined) target.setAttribute("max", String(config.max));
        if (config.step !== undefined) target.setAttribute("step", String(config.step));
      }
    }
  }
}
