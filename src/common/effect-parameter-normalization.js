import { logger } from "../logger.js";

/**
 * Normalize effect parameter definitions so core and extension effects expose a consistent render-order control set.
 */

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
 * Placement controls always lead, followed by scene-only level selection, then the effect's own authored parameters, with darkness activation controls anchored at the bottom of the parameter list.
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
  const specialOrder = [...leadingOrder, ...trailingOrder];

  const normalized = {};

  for (const key of leadingOrder) {
    if (Object.hasOwn(parameters, key)) normalized[key] = parameters[key];
    else normalized[key] = defaults[key];
  }

  for (const [key, value] of Object.entries(parameters)) {
    if (specialOrder.includes(key)) continue;
    normalized[key] = value;
  }

  for (const key of trailingOrder) {
    if (Object.hasOwn(parameters, key)) normalized[key] = parameters[key];
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
  if (!effectDefinition || effectDefinition.__fxmRenderOrderParametersNormalized) return;

  const descriptorInfo = resolveStaticDescriptor(effectDefinition, "parameters");
  const descriptor = descriptorInfo?.descriptor ?? null;
  const originalGetter = typeof descriptor?.get === "function" ? descriptor.get.bind(effectDefinition) : null;
  const originalValue = originalGetter ? null : effectDefinition.parameters;

  const readParameters = () => {
    try {
      return originalGetter ? originalGetter() : originalValue;
    } catch (err) {
      logger.debug("FXMaster: failed to read effect parameters", err);
      return originalValue ?? {};
    }
  };

  const getNormalizedParameters = () => normalizeParameterMap(kind, readParameters());

  try {
    Object.defineProperty(effectDefinition, "parameters", {
      configurable: true,
      enumerable: true,
      get: getNormalizedParameters,
    });
  } catch (err) {
    logger.debug("FXMaster: failed to define normalized effect parameters", err);
    try {
      effectDefinition.parameters = getNormalizedParameters();
    } catch (assignmentErr) {
      logger.debug("FXMaster: failed to assign normalized effect parameters", assignmentErr);
      return;
    }
  }

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
