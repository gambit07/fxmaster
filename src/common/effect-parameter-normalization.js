import { logger } from "../logger.js";
import { clampRange } from "../utils/math.js";
import { hasOwn, isPlainObject } from "../utils/object.js";

/**
 * Normalize effect parameter definitions so core and extension effects expose consistent render-order controls and public scalar ranges.
 */

const NORMALIZED_RANGE_KEYS = new Set([
  "branches",
  "density",
  "dimensions",
  "glyphSpeed",
  "glow",
  "height",
  "intensity",
  "lacunarity",
  "length",
  "lifetime",
  "noiseSize",
  "pathInfluence",
  "reflectionFresnel",
  "ribbonWidth",
  "scale",
  "scrollSpeed",
  "spin",
  "speed",
  "backgroundLeafSize",
  "backgroundParticleSize",
  "splashDensity",
  "splashScale",
  "wobbleFrequency",
]);

const NORMALIZED_RANGE_SUFFIXES = ["Intensity", "Scale", "Speed", "Strength"];

/**
 * Return whether a value is a finite number.
 *
 * @param {unknown} value
 * @returns {value is number}
 */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Round a number to a fixed display precision while preserving numeric type.
 *
 * @param {number} value
 * @param {number} decimals
 * @returns {number}
 */
function round(value, decimals = 3) {
  if (!Number.isFinite(value)) return value;
  const d = Math.max(0, Math.min(6, Number(decimals) || 0));
  return Number(value.toFixed(d));
}

/**
 * Return the normalized UI minimum that best communicates the internal range precision.
 *
 * @param {number} internalMin
 * @returns {0|0.001|0.01|0.1}
 */
function normalizedUiMinForInternalMin(internalMin) {
  if (!(internalMin > 0)) return 0;
  if (internalMin < 0.01) return 0.001;
  if (internalMin < 0.1) return 0.01;
  return 0.1;
}

/**
 * Return the step and precision for a normalized UI range.
 *
 * @param {number} uiMin
 * @returns {{step:number, decimals:number}}
 */
function normalizedUiStep(uiMin) {
  if (uiMin === 0.001) return { step: 0.001, decimals: 3 };
  return { step: 0.01, decimals: 2 };
}

/**
 * Determine whether a range parameter should use a normalized public scale.
 *
 * @param {string} key
 * @param {object|null|undefined} parameter
 * @returns {boolean}
 */
function shouldNormalizeRangeParameter(key, parameter) {
  if (!parameter || parameter.type !== "range") return false;
  if (!NORMALIZED_RANGE_KEYS.has(key) && !NORMALIZED_RANGE_SUFFIXES.some((suffix) => key.endsWith(suffix)))
    return false;

  const min = Number(parameter.min);
  const max = Number(parameter.max);
  const value = Number(parameter.value);
  if (![min, max, value].every(Number.isFinite)) return false;
  if (!(max > min)) return false;

  return Math.abs(max - 1) > 1e-9;
}

/**
 * Convert an internal effect value to its normalized UI value.
 *
 * @param {object|null|undefined} parameter
 * @param {number} value
 * @returns {number}
 */
export function compressNormalizedRangeValue(parameter, value) {
  const range = parameter?.__fxmInternalRange;
  const raw = Number(value);
  if (!range || !Number.isFinite(raw)) return raw;

  const uiMin = Number(parameter.min ?? 0);
  const uiMax = Number(parameter.max ?? 1);
  const internalMin = Number(range.min);
  const internalMax = Number(range.max);
  if (![uiMin, uiMax, internalMin, internalMax].every(Number.isFinite) || internalMax <= internalMin) return raw;

  if (raw === 0 && internalMin > 0 && uiMin === 0) return 0;

  const t = (clampRange(raw, internalMin, internalMax, internalMin) - internalMin) / (internalMax - internalMin);
  const decimals = Number(parameter.decimals ?? 3);
  return round(uiMin + t * (uiMax - uiMin), decimals);
}

/**
 * Convert a normalized UI value to the internal effect value.
 *
 * @param {object|null|undefined} parameter
 * @param {number} value
 * @returns {number}
 */
export function expandNormalizedRangeValue(parameter, value) {
  const range = parameter?.__fxmInternalRange;
  const raw = Number(value);
  if (!range || !Number.isFinite(raw)) return raw;

  const uiMin = Number(parameter.min ?? 0);
  const uiMax = Number(parameter.max ?? 1);
  const internalMin = Number(range.min);
  const internalMax = Number(range.max);
  if (![uiMin, uiMax, internalMin, internalMax].every(Number.isFinite) || internalMax <= internalMin) return raw;

  if (raw === 0 && internalMin > 0 && uiMin === 0) return 0;
  if (raw > uiMax && raw <= internalMax) return raw;

  const t = (clampRange(raw, uiMin, uiMax, uiMin) - uiMin) / (uiMax - uiMin || 1);
  return internalMin + t * (internalMax - internalMin);
}

/**
 * Clone and normalize a range parameter for public UI display.
 *
 * @param {string} key
 * @param {object} parameter
 * @returns {object}
 */
function normalizeRangeParameter(key, parameter) {
  if (!shouldNormalizeRangeParameter(key, parameter)) return parameter;

  const internalMin = Number(parameter.min);
  const internalMax = Number(parameter.max);
  const internalValue = Number(parameter.value);
  const isGroundParticleSize = key === "backgroundLeafSize" || key === "backgroundParticleSize";
  const uiMin = isGroundParticleSize ? 0.01 : normalizedUiMinForInternalMin(internalMin);
  const uiMax = 1;
  const { step, decimals } = normalizedUiStep(uiMin);

  const normalized = {
    ...parameter,
    min: uiMin,
    max: uiMax,
    step,
    decimals,
    __fxmInternalRange: {
      min: internalMin,
      max: internalMax,
      value: internalValue,
      step: Number(parameter.step),
      decimals: Number(parameter.decimals),
    },
    ...(isGroundParticleSize ? { __fxmAcceptLegacyZero: true } : {}),
  };

  normalized.value = compressNormalizedRangeValue(normalized, internalValue);
  return normalized;
}

/**
 * Read a parameter's authored value from either a raw option or a wrapped option.
 *
 * @param {unknown} value
 * @returns {{wrapped:boolean, value:any, source:any}}
 */
function unwrapOptionValue(value) {
  if (!isPlainObject(value) || !hasOwn(value, "value")) return { wrapped: false, value, source: value };
  let source = value;
  let current = value.value;
  let wrapped = true;
  while (isPlainObject(current) && hasOwn(current, "value") && typeof current.apply !== "boolean") {
    source = current;
    current = current.value;
  }
  return { wrapped, value: current, source };
}

/**
 * Return the parameter map for an effect definition.
 *
 * @param {object|null|undefined} effectDefinition
 * @returns {object}
 */
function getEffectParameters(effectDefinition) {
  try {
    return effectDefinition?.parameters ?? {};
  } catch (err) {
    logger.debug("FXMaster: failed to read effect parameters", err);
    return {};
  }
}

/**
 * Convert normalized stored options to runtime values expected by effect code.
 *
 * @param {object|null|undefined} effectDefinition
 * @param {object|null|undefined} options
 * @returns {object}
 */
export function normalizeEffectOptionsForRuntime(effectDefinition, options) {
  if (!isPlainObject(options)) return options ?? {};
  if (options.__fxmNormalizedRangesExpanded === true) return options;

  const parameters = getEffectParameters(effectDefinition);
  const out = { ...options };

  for (const [key, parameter] of Object.entries(parameters)) {
    if (!parameter?.__fxmInternalRange || !hasOwn(out, key)) continue;

    const entry = unwrapOptionValue(out[key]);
    if (!isFiniteNumber(Number(entry.value))) continue;

    const expanded = expandNormalizedRangeValue(parameter, Number(entry.value));
    if (entry.wrapped) out[key] = { ...entry.source, value: expanded };
    else out[key] = expanded;
  }

  out.__fxmNormalizedRangesExpanded = true;
  return out;
}

/**
 * Convert legacy internal options to normalized stored options.
 *
 * @param {object|null|undefined} effectDefinition
 * @param {object|null|undefined} options
 * @returns {object}
 */
export function normalizeEffectOptionsForStorageFromLegacy(effectDefinition, options) {
  if (!isPlainObject(options)) return options ?? {};
  const parameters = getEffectParameters(effectDefinition);
  const out = { ...options };

  for (const [key, parameter] of Object.entries(parameters)) {
    if (!parameter?.__fxmInternalRange || !hasOwn(out, key)) continue;

    const entry = unwrapOptionValue(out[key]);
    if (!isFiniteNumber(Number(entry.value))) continue;

    const compressed = compressNormalizedRangeValue(parameter, Number(entry.value));
    out[key] = compressed;
  }

  delete out.__fxmNormalizedRangesExpanded;
  return out;
}

/**
 * Scale a normalized stored option by multiplying its internal value, then return a normalized stored value.
 *
 * @param {object|null|undefined} effectDefinition
 * @param {string} key
 * @param {number} value
 * @param {number} multiplier
 * @returns {number}
 */
export function scaleNormalizedStoredRangeValue(effectDefinition, key, value, multiplier) {
  const parameter = getEffectParameters(effectDefinition)?.[key];
  const numeric = Number(value);
  const scale = Number(multiplier);
  if (!Number.isFinite(numeric) || !Number.isFinite(scale)) return value;
  if (!parameter?.__fxmInternalRange) return numeric * scale;
  if (numeric === 0 && Number(parameter.__fxmInternalRange.min) > 0 && Number(parameter.min ?? 0) === 0) return 0;

  const internal = expandNormalizedRangeValue(parameter, numeric);
  const range = parameter.__fxmInternalRange;
  const nextInternal = clampRange(internal * scale, Number(range.min), Number(range.max), Number(range.min));
  return compressNormalizedRangeValue(parameter, nextInternal);
}

/**
 * Build the standard render-order parameters for a given effect kind.
 *
 * @param {"particle"|"filter"} kind
 * @returns {{belowTokens: object, belowTiles: object, belowForeground: object, levels: object, darknessActivationEnabled: object, darknessActivationRange: object}}
 */
function getRenderOrderParameters(_kind) {
  return {
    belowTokens: {
      label: "FXMASTER.Params.BelowTokens",
      type: "checkbox",
      value: false,
      tooltip: "FXMASTER.ParamTooltips.BelowTokens",
    },
    belowTiles: {
      label: "FXMASTER.Params.BelowTiles",
      type: "checkbox",
      value: false,
      tooltip: "FXMASTER.ParamTooltips.BelowTiles",
    },
    belowForeground: {
      label: "FXMASTER.Params.BelowForeground",
      type: "checkbox",
      value: false,
      tooltip: "FXMASTER.ParamTooltips.BelowForeground",
    },
    levels: {
      label: "FXMASTER.Params.Levels",
      type: "scene-levels",
      value: [],
      tooltip: "FXMASTER.ParamTooltips.Levels",
      sceneOnly: true,
    },
    darknessActivationEnabled: {
      label: "FXMASTER.Params.DarknessActivationEnabled",
      type: "checkbox",
      value: false,
      tooltip: "FXMASTER.ParamTooltips.DarknessActivationEnabled",
    },
    darknessActivationRange: {
      label: "FXMASTER.Params.DarknessActivationRange",
      type: "range-dual",
      min: 0,
      max: 1,
      step: 0.01,
      decimals: 2,
      value: { min: 0, max: 1 },
      tooltip: "FXMASTER.ParamTooltips.DarknessActivationRange",
      minLabel: "FXMASTER.Params.DarknessActivationMin",
      maxLabel: "FXMASTER.Params.DarknessActivationMax",
      showWhen: { darknessActivationEnabled: true },
    },
  };
}

/**
 * Return a property descriptor for a static class member, resolving inherited descriptors when the member is defined on a superclass.
 *
 * @param {object} target
 * @param {string} key
 * @returns {{owner: object, descriptor: PropertyDescriptor}|null}
 */
function resolveStaticDescriptor(target, key) {
  let current = target;
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return { owner: current, descriptor };
    current = Object.getPrototypeOf(current);
  }
  return null;
}

/**
 * Insert missing render-order parameters in a consistent order.
 *
 * @param {"particle"|"filter"} kind
 * @param {object|null|undefined} source
 * @returns {object}
 */
function normalizeParameterMap(kind, source) {
  const parameters = source && typeof source === "object" ? source : {};
  const defaults = getRenderOrderParameters(kind);
  const leadingOrder = ["belowTokens", "belowTiles", "belowForeground", "levels"];
  const trailingOrder = ["darknessActivationEnabled", "darknessActivationRange"];
  const hasBackgroundToggle = Object.hasOwn(parameters, "backgroundEnabled");
  const backgroundOrder = hasBackgroundToggle
    ? [
        "backgroundEnabled",
        ...Object.keys(parameters).filter((key) => key !== "backgroundEnabled" && key.startsWith("background")),
      ]
    : [];
  const hasSoundFxToggle = Object.hasOwn(parameters, "soundFxEnabled");
  const soundFxOrder = hasSoundFxToggle ? ["soundFxEnabled", "soundFxManualSoundIds"] : [];
  const hasTokenTrailsToggle = Object.hasOwn(parameters, "tokenTrailsEnabled");
  const tokenTrailsOrder = hasTokenTrailsToggle
    ? [
        "tokenTrailsEnabled",
        ...Object.keys(parameters).filter((key) => key !== "tokenTrailsEnabled" && key.startsWith("tokenTrail")),
      ]
    : [];
  const hasTokenAvoidanceToggle = Object.hasOwn(parameters, "tokenAvoidance");
  const hasTokenAvoidanceDispositions = Object.hasOwn(parameters, "tokenAvoidanceDispositions");
  const tokenAvoidanceOrder = hasTokenAvoidanceToggle
    ? [
        "tokenAvoidance",
        "tokenAvoidanceDispositions",
        ...Object.keys(parameters).filter(
          (key) => key !== "tokenAvoidance" && key !== "tokenAvoidanceDispositions" && key.startsWith("tokenAvoidance"),
        ),
      ]
    : [];
  const hasBurnTokensToggle = Object.hasOwn(parameters, "burnTokens");
  const burnTokensOrder = hasBurnTokensToggle
    ? ["burnTokens", ...Object.keys(parameters).filter((key) => key !== "burnTokens" && key.startsWith("burnToken"))]
    : [];
  const directionOrder = ["directionalMovement", "direction", "synchronizedDirection", "spread", "spawnMode"].filter(
    (key) => Object.hasOwn(parameters, key),
  );
  const specialOrder = new Set([
    ...leadingOrder,
    ...soundFxOrder,
    ...directionOrder,
    ...backgroundOrder,
    ...tokenTrailsOrder,
    ...tokenAvoidanceOrder,
    ...burnTokensOrder,
    ...trailingOrder,
  ]);

  const normalized = {};
  const hasTintParameter = Object.hasOwn(parameters, "tint") || Object.hasOwn(parameters, "color");
  let insertedSoundFx = false;
  let insertedDirection = false;
  const insertSoundFx = () => {
    if (insertedSoundFx) return;
    insertedSoundFx = true;
    for (const key of soundFxOrder) {
      if (Object.hasOwn(parameters, key)) normalized[key] = normalizeRangeParameter(key, parameters[key]);
      else {
        normalized[key] = {
          label: "FXMASTER.Params.SoundFxManualSoundIds",
          tooltip: "FXMASTER.ParamTooltips.SoundFxManualSoundIds",
          type: "multi-select",
          value: [],
          allowEmpty: true,
          showWhen: { soundFxEnabled: true },
        };
      }
    }
  };

  const insertDirection = () => {
    if (insertedDirection) return;
    insertedDirection = true;
    for (const key of directionOrder) normalized[key] = normalizeRangeParameter(key, parameters[key]);
  };

  for (const key of leadingOrder) {
    if (Object.hasOwn(parameters, key)) normalized[key] = normalizeRangeParameter(key, parameters[key]);
    else normalized[key] = defaults[key];
  }

  for (const [key, value] of Object.entries(parameters)) {
    if (specialOrder.has(key)) continue;
    if (key === "scale") insertDirection();
    if (!hasTintParameter && value?.type === "checkbox") insertSoundFx();
    normalized[key] = normalizeRangeParameter(key, value);
    if (key === "tint" || key === "color") insertSoundFx();
  }

  insertSoundFx();
  insertDirection();

  for (const key of backgroundOrder) {
    normalized[key] = normalizeRangeParameter(key, parameters[key]);
  }

  for (const key of tokenTrailsOrder) {
    normalized[key] = normalizeRangeParameter(key, parameters[key]);
  }

  for (const key of tokenAvoidanceOrder) {
    if (key === "tokenAvoidanceDispositions" && !hasTokenAvoidanceDispositions) {
      normalized[key] = {
        label: "FXMASTER.Params.TokenAvoidanceDispositions",
        tooltip: "FXMASTER.ParamTooltips.TokenAvoidanceDispositions",
        type: "multi-select",
        options: {
          friendly: "TOKEN.DISPOSITION.FRIENDLY",
          neutral: "TOKEN.DISPOSITION.NEUTRAL",
          hostile: "TOKEN.DISPOSITION.HOSTILE",
          secret: "TOKEN.DISPOSITION.SECRET",
        },
        value: ["friendly", "neutral", "hostile", "secret"],
        allowEmpty: false,
        showWhen: { tokenAvoidance: true },
        ...(parameters.tokenAvoidance?.hideWhen ? { hideWhen: parameters.tokenAvoidance.hideWhen } : {}),
      };
      continue;
    }
    normalized[key] = normalizeRangeParameter(key, parameters[key]);
  }

  for (const key of burnTokensOrder) {
    normalized[key] = normalizeRangeParameter(key, parameters[key]);
  }

  for (const key of trailingOrder) {
    if (Object.hasOwn(parameters, key)) normalized[key] = normalizeRangeParameter(key, parameters[key]);
    else normalized[key] = defaults[key];
  }

  return normalized;
}

/**
 * Normalize a single effect definition so future reads of `parameters` include the standard render-order controls.
 *
 * @param {object} effectDefinition
 * @param {"particle"|"filter"} kind
 * @returns {void}
 */
function normalizeEffectDefinition(effectDefinition, kind) {
  if (!effectDefinition || hasOwn(effectDefinition, "__fxmRenderOrderParametersNormalized")) return;

  const ownDescriptor = Object.getOwnPropertyDescriptor(effectDefinition, "parameters");
  const descriptorInfo = resolveStaticDescriptor(effectDefinition, "parameters");
  const descriptor = ownDescriptor ?? descriptorInfo?.descriptor ?? null;

  if (!ownDescriptor && descriptorInfo?.owner && hasOwn(descriptorInfo.owner, "__fxmRenderOrderParametersNormalized")) {
    markEffectParametersNormalized(effectDefinition);
    return;
  }

  const originalGetter = typeof descriptor?.get === "function" ? descriptor.get : null;
  const originalValue = originalGetter ? null : effectDefinition.parameters;

  const readParameters = (receiver) => {
    try {
      return originalGetter ? originalGetter.call(receiver ?? effectDefinition) : originalValue;
    } catch (err) {
      logger.debug("FXMaster: failed to read effect parameters", err);
      return originalValue ?? {};
    }
  };

  function getNormalizedParameters() {
    return normalizeParameterMap(kind, readParameters(this));
  }

  try {
    Object.defineProperty(effectDefinition, "parameters", {
      configurable: true,
      enumerable: true,
      get: getNormalizedParameters,
    });
  } catch (err) {
    logger.debug("FXMaster: failed to define normalized effect parameters", err);
    try {
      effectDefinition.parameters = getNormalizedParameters.call(effectDefinition);
    } catch (assignmentErr) {
      logger.debug("FXMaster: failed to assign normalized effect parameters", assignmentErr);
      return;
    }
  }

  markEffectParametersNormalized(effectDefinition);
}

/**
 * Mark an effect definition as normalized without inheriting a superclass marker.
 *
 * @param {object} effectDefinition
 * @returns {void}
 */
function markEffectParametersNormalized(effectDefinition) {
  try {
    Object.defineProperty(effectDefinition, "__fxmRenderOrderParametersNormalized", {
      value: true,
      configurable: true,
      enumerable: false,
      writable: false,
    });
  } catch (err) {
    logger.debug("FXMaster: failed to mark effect parameters as normalized", err);
    try {
      effectDefinition.__fxmRenderOrderParametersNormalized = true;
    } catch (assignmentErr) {
      logger.debug("FXMaster: failed to assign effect parameter normalization marker", assignmentErr);
    }
  }
}

/**
 * Normalize every registered FXMaster particle and filter definition.
 *
 * This pass runs after module extension hooks have registered any additional effects so premium or third-party effect packs inherit the same controls.
 *
 * @param {object} fxmasterConfig
 * @returns {void}
 */
export function normalizeRegisteredEffectParameters(fxmasterConfig) {
  const particleEffects = fxmasterConfig?.particleEffects ?? {};
  for (const effectDefinition of Object.values(particleEffects)) {
    normalizeEffectDefinition(effectDefinition, "particle");
  }

  const filterEffects = fxmasterConfig?.filterEffects ?? {};
  for (const effectDefinition of Object.values(filterEffects)) {
    normalizeEffectDefinition(effectDefinition, "filter");
  }
}
