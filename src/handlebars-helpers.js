import { ALL_LEVELS_SELECTION, packageId } from "./constants.js";
import { getSceneLevels } from "./utils/compat.js";
import { resolveDarknessActivationEnabled } from "./utils/darkness.js";
import { logger } from "./logger.js";

const FXMASTER_PLUS_ID = "fxmaster-plus";
const PLACEMENT_ICON_CLASS_MAP = {
  belowTokens: "fa-user",
  belowTiles: "fa-table-cells-large",
  belowForeground: "fa-image",
};

const PLACEMENT_SHORT_LABEL_MAP = {
  belowTokens: "Tokens",
  belowTiles: "Tiles",
  belowForeground: "Foreground",
};

const VALID_TOOLTIP_DIRECTIONS = new Set(["UP", "DOWN", "LEFT", "RIGHT"]);
const loggedSoundFxDebugKeys = new Set();

function debugSoundFxOnce(key, err) {
  if (loggedSoundFxDebugKeys.has(key)) return;
  loggedSoundFxDebugKeys.add(key);
  logger.debug("FXMaster:", key, err);
}

/**
 * Determine whether a parameter uses the compact placement-toggle presentation.
 *
 * @param {string} paramName
 * @returns {boolean}
 */
function isPlacementParameter(paramName) {
  return Object.prototype.hasOwnProperty.call(PLACEMENT_ICON_CLASS_MAP, String(paramName));
}

/**
 * Resolve the configured FXMaster tooltip direction.
 *
 * @param {string|null|undefined} [fallbackDirection="UP"]
 * @returns {"UP"|"DOWN"|"LEFT"|"RIGHT"}
 */
export function getFxmasterTooltipDirection(fallbackDirection = "UP") {
  const configuredDirection = String(game?.settings?.get?.(packageId, "tooltipDirection") ?? "")
    .trim()
    .toUpperCase();
  if (VALID_TOOLTIP_DIRECTIONS.has(configuredDirection)) return configuredDirection;

  const fallback = String(fallbackDirection ?? "UP")
    .trim()
    .toUpperCase();
  if (VALID_TOOLTIP_DIRECTIONS.has(fallback)) return fallback;

  return "UP";
}

/**
 * Resolve the localized tooltip text for a parameter definition.
 *
 * @param {Record<string, any>|null|undefined} parameterConfig
 * @returns {string}
 */
function getParameterTooltipText(parameterConfig) {
  const explicitKey = typeof parameterConfig?.tooltip === "string" ? parameterConfig.tooltip.trim() : "";
  if (explicitKey && game.i18n.has(explicitKey)) {
    return game.i18n.localize(explicitKey);
  }

  const labelKey = typeof parameterConfig?.label === "string" ? parameterConfig.label : null;
  const leaf = labelKey?.replace(/^FXMASTER\.Params\./, "");
  const hintKey = leaf ? `FXMASTER.ParamTooltips.${leaf}` : "";
  return hintKey && game.i18n.has(hintKey) ? game.i18n.localize(hintKey) : "";
}

/**
 * Build escaped tooltip attributes for a tooltip-enabled element.
 *
 * @param {string} tipText
 * @param {string} tipDirection
 * @returns {string}
 */
function buildTooltipAttributeString(tipText, tipDirection) {
  if (!tipText) return "";
  const escapedText = Handlebars.escapeExpression(String(tipText));
  const escapedDirection = Handlebars.escapeExpression(String(tipDirection || "UP"));
  return ` data-tooltip="${escapedText}" data-tooltip-direction="${escapedDirection}"`;
}

/**
 * Resolve tooltip metadata for a parameter definition.
 *
 * @param {Record<string, any>|null|undefined} parameterConfig
 * @returns {{ text: string, direction: string, attrs: string }}
 */
function getParameterTooltipMeta(parameterConfig) {
  const text = getParameterTooltipText(parameterConfig);
  const direction = getFxmasterTooltipDirection(parameterConfig?.tooltipDirection ?? "UP");
  return {
    text,
    direction,
    attrs: buildTooltipAttributeString(text, direction),
  };
}

/**
 * Resolve the compact placement-toggle label for a parameter.
 *
 * @param {string} paramName
 * @param {string} localizedLabel
 * @returns {string}
 */
function getPlacementShortLabel(paramName, localizedLabel) {
  const configured = PLACEMENT_SHORT_LABEL_MAP[String(paramName)] ?? "";
  if (configured) return configured;

  if (typeof localizedLabel === "string" && localizedLabel.length) {
    return localizedLabel.replace(/^below\s+/i, "").trim() || localizedLabel;
  }

  return String(paramName ?? "").trim();
}

/**
 * Resolve a localized label for a single-select or multi-select choice entry.
 *
 * @param {string} label
 * @returns {string}
 */
function localizeChoiceLabel(label) {
  if (typeof label !== "string") return String(label ?? "");
  const trimmed = label.trim();
  if (trimmed && game?.i18n?.has?.(trimmed)) return game.i18n.localize(trimmed);
  return trimmed;
}

/**
 * Return the active scene level documents as a plain array.
 *
 * @param {Scene|null|undefined} [scene=canvas?.scene ?? null]
 * @returns {Array<any>}
 */
function getSceneLevelDocuments(scene = canvas?.scene ?? null) {
  return getSceneLevels(scene);
}

/**
 * Resolve a display label for a Level document.
 *
 * @param {any} level
 * @returns {string}
 */
function getSceneLevelLabel(level) {
  const candidates = [level?.name, level?.label, level?._source?.name, level?._source?.label, level?.title, level?.id];

  for (const candidate of candidates) {
    if (candidate == null) continue;
    const text = String(candidate).trim();
    if (text) return text;
  }

  return String(level?.id ?? game.i18n.localize("FXMASTER.Common.Unknown"));
}

/**
 * Build the management-app multi-select option list for scene levels.
 *
 * @param {Scene|null|undefined} [scene=canvas?.scene ?? null]
 * @returns {Array<{value:string,label:string}>}
 */
function getSceneLevelMultiSelectChoices(scene = canvas?.scene ?? null) {
  const choices = [
    {
      value: ALL_LEVELS_SELECTION,
      label: game.i18n.localize("FXMASTER.Params.AllLevels"),
    },
  ];

  for (const level of getSceneLevelDocuments(scene)) {
    const id = String(level?.id ?? "").trim();
    if (!id) continue;
    choices.push({ value: id, label: getSceneLevelLabel(level) });
  }

  return choices;
}

/**
 * Return whether the active scene exposes more than one native Level.
 *
 * The scene-level selector is only useful when there is an actual choice to make.
 *
 * @param {Scene|null|undefined} [scene=canvas?.scene ?? null]
 * @returns {boolean}
 */
function sceneHasMultipleLevels(scene = canvas?.scene ?? null) {
  return getSceneLevelDocuments(scene).length > 1;
}

/**
 * Normalize the UI selection for a scene-level multi-select.
 *
 * Empty or invalid selections collapse back to the synthetic "all levels" choice.
 *
 * @param {*} rawValue
 * @param {Scene|null|undefined} [scene=canvas?.scene ?? null]
 * @returns {string[]}
 */
function normalizeSceneLevelUiSelection(rawValue, scene = canvas?.scene ?? null) {
  const raw =
    rawValue instanceof Set
      ? Array.from(rawValue)
      : Array.isArray(rawValue)
      ? rawValue
      : rawValue == null || rawValue === ""
      ? []
      : [rawValue];
  const levelIds = new Set(
    getSceneLevelDocuments(scene)
      .map((level) => String(level?.id ?? ""))
      .filter(Boolean),
  );
  const ids = Array.from(new Set(raw.map(String).filter((value) => value && value !== ALL_LEVELS_SELECTION)));
  if (!levelIds.size) return [ALL_LEVELS_SELECTION];
  const filtered = ids.filter((id) => levelIds.has(id));
  if (!filtered.length) return [ALL_LEVELS_SELECTION];
  if (filtered.length >= levelIds.size) return [ALL_LEVELS_SELECTION];
  return filtered;
}

/**
 * Cache for computed SoundFX-eligible effect types. This prevents repeatedly parsing the Sound FX rules for every parameter row.
 */
let _soundFxEligibleCache = {
  sig: "",
  particles: /** @type {Record<string, true>} */ ({}),
  filters: /** @type {Record<string, true>} */ ({}),
};

function soundFxRulesSignature(raw) {
  const rules = Array.isArray(raw?.rules) ? raw.rules : [];
  return rules
    .map((r) => {
      const effects = Array.isArray(r?.effects) ? r.effects.join(",") : "";
      const mode = r?.mode === "sequential" ? "sequential" : "parallel";
      const fade = Number.isFinite(Number(r?.fade)) ? String(Number(r.fade)) : "";
      const sounds = Array.isArray(r?.sounds)
        ? r.sounds
            .map((s) => `${String(s?.src ?? "").trim()}|${Number.isFinite(Number(s?.level)) ? Number(s.level) : ""}`)
            .join(";")
        : "";
      return `${mode}::${fade}::${effects}::${sounds}`;
    })
    .join("||");
}

function computeSoundFxEligibleTypes() {
  const out = {
    particles: /** @type {Record<string, true>} */ ({}),
    filters: /** @type {Record<string, true>} */ ({}),
  };

  const plusActive = !!game?.modules?.get?.(FXMASTER_PLUS_ID)?.active;
  if (!plusActive) return out;

  /** @type {any} */
  let raw;
  try {
    raw = game.settings.get(FXMASTER_PLUS_ID, "soundFxRules");
  } catch (err) {
    debugSoundFxOnce("Failed to read FXMaster+ sound FX rules.", err);
    raw = null;
  }

  const rules = Array.isArray(raw?.rules) ? raw.rules : [];
  for (const r of rules) {
    if (!r || typeof r !== "object") continue;

    const hasSound = Array.isArray(r.sounds) && r.sounds.some((s) => typeof s?.src === "string" && s.src.trim());
    if (!hasSound) continue;

    const effects = Array.isArray(r.effects) ? r.effects : [];
    for (const key of effects) {
      if (typeof key !== "string" || !key.includes(":")) continue;
      const [kind, type] = key.split(":");
      if (!type) continue;
      if (kind === "particle") out.particles[type] = true;
      else if (kind === "filter") out.filters[type] = true;
    }
  }

  return out;
}

function getSoundFxEligibleTypesCached() {
  const plusActive = !!game?.modules?.get?.(FXMASTER_PLUS_ID)?.active;
  if (!plusActive) return { particles: {}, filters: {} };

  /** @type {any} */
  let raw;
  try {
    raw = game.settings.get(FXMASTER_PLUS_ID, "soundFxRules");
  } catch (err) {
    debugSoundFxOnce("Failed to read FXMaster+ sound FX rules.", err);
    raw = null;
  }

  const sig = soundFxRulesSignature(raw);
  if (sig !== _soundFxEligibleCache.sig) {
    const computed = computeSoundFxEligibleTypes();
    _soundFxEligibleCache = {
      sig,
      particles: computed.particles,
      filters: computed.filters,
    };
  }

  return _soundFxEligibleCache;
}

/**
 * Determine whether the Sound FX toggle should be displayed for a given effect.
 *
 * The toggle is shown only when FXMaster+ is active and the Sound FX Manager has at least one usable rule that references the requested effect type. requested effect type.
 *
 * @param {"particle"|"filter"} kind
 * @param {string} type
 * @param {string} paramName
 * @returns {boolean}
 */
export function isSoundFxParameterVisible(kind, type, paramName) {
  if (paramName !== "soundFxEnabled") return true;

  try {
    const plusActive = !!game?.modules?.get?.(FXMASTER_PLUS_ID)?.active;
    if (!plusActive) return false;

    const eligible = getSoundFxEligibleTypesCached();
    if (kind === "particle") return !!eligible?.particles?.[type];
    if (kind === "filter") return !!eligible?.filters?.[type];
    return false;
  } catch (err) {
    debugSoundFxOnce(`Failed to resolve Sound FX parameter visibility for ${kind}:${type}.`, err);
    return false;
  }
}

function isManagementParameterVisible(kind, type, paramName) {
  if (paramName === "levels") return sceneHasMultipleLevels();
  return isSoundFxParameterVisible(kind, type, paramName);
}

/**
 * Determine whether a management-app parameter should render its standalone title row.
 *
 * Scene level selection omits the redundant title because the multi-select already exposes the current selection directly.
 *
 * @param {Record<string, any>|null|undefined} parameterConfig
 * @param {string} paramName
 * @returns {boolean}
 */
function shouldRenderManagementParameterTitle(parameterConfig, paramName) {
  return parameterConfig?.type !== "scene-levels" && paramName !== "levels";
}

export function registerHandlebarsHelpers() {
  Handlebars.registerHelper("fxmasterParameter", (effectCls, parameterConfig, parameterName, options = {}) => {
    const defaultValue = effectCls.default?.[parameterName] ?? parameterConfig.value ?? "";
    const raw = options?.[parameterName];

    let _default = raw == null || raw === "" ? defaultValue : raw;
    if (parameterName === "darknessActivationEnabled") {
      _default = resolveDarknessActivationEnabled({
        darknessActivationEnabled: raw,
        darknessActivationRange: options?.darknessActivationRange,
      });
    }
    const nameBase = `${effectCls.label}_${parameterName}`;
    const safeId = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "-");
    const localizedLabel =
      typeof parameterConfig.label === "string"
        ? game.i18n?.localize?.(parameterConfig.label) ?? parameterConfig.label
        : parameterName;
    const ariaLabel = Handlebars.escapeExpression(String(localizedLabel ?? parameterName));
    const tooltipsEnabled = game.settings.get(packageId, "enableTooltips") ?? true;
    const tooltipMeta = tooltipsEnabled
      ? getParameterTooltipMeta(parameterConfig)
      : { text: "", direction: "UP", attrs: "" };
    const tipText = tooltipMeta.text;
    const tipDir = tooltipMeta.direction;
    const tipAttrs = tooltipMeta.attrs;

    switch (parameterConfig.type) {
      case "color": {
        let colorValue = typeof _default === "object" ? _default.value : _default;
        if (typeof colorValue !== "string") colorValue = "#000000";
        if (/^[0-9a-f]{6,8}$/i.test(colorValue)) colorValue = `#${colorValue}`;
        if (!/^#[0-9a-f]{6,8}$/i.test(colorValue)) colorValue = "#000000";

        const applyChecked = _default?.apply ? "checked" : "";
        const applyName = `${nameBase}_apply`;
        const applyId = `${safeId(applyName)}_switch`;
        const colorInputId = `${safeId(nameBase)}_color`;

        const hasColorPickerEl = !!globalThis.customElements?.get?.("color-picker");
        const pickerHTML = hasColorPickerEl
          ? `<color-picker id="${colorInputId}" name="${nameBase}" value="${colorValue}" data-action="updateParam" aria-label="${ariaLabel}"></color-picker>`
          : `<input id="${colorInputId}" type="color" name="${nameBase}" value="${colorValue}" data-action="updateParam" aria-label="${ariaLabel}" />`;

        return `
          <div class="fxmaster-input-color"${tipAttrs}>
            <label class="fxm-switch">
              <input id="${applyId}" type="checkbox"
                    name="${applyName}" ${applyChecked} data-action="updateParam"
                    aria-label="${ariaLabel}" />
              <span class="fxm-slider" aria-hidden="true"></span>
            </label>
            ${pickerHTML}
          </div>
        `;
      }

      case "checkbox": {
        const checked = _default ? "checked" : "";
        const inputId = `${safeId(nameBase)}_switch`;

        if (isPlacementParameter(parameterName)) {
          const iconClass = Handlebars.escapeExpression(
            `fa-solid ${PLACEMENT_ICON_CLASS_MAP[String(parameterName)] ?? "fa-sliders"}`,
          );
          const shortLabel = Handlebars.escapeExpression(getPlacementShortLabel(parameterName, localizedLabel));
          return `
            <div class="fxmaster-input-checkbox fxmaster-input-checkbox--placement"${tipAttrs}>
              <label class="fxmaster-placement-toggle"${tipAttrs}>
                <input id="${inputId}" type="checkbox"
                       name="${nameBase}" ${checked} data-action="updateParam"
                       aria-label="${ariaLabel}" />
                <span class="fxmaster-placement-toggle-slider" aria-hidden="true"${tipAttrs}>
                  <span class="fxmaster-placement-toggle-content">
                    <span class="fxmaster-placement-toggle-label fxmaster-placement-toggle-label--full">${ariaLabel}</span>
                    <span class="fxmaster-placement-toggle-label fxmaster-placement-toggle-label--short">
                      <span class="fxmaster-placement-toggle-arrow">↓</span>
                      <span class="fxmaster-placement-toggle-short-text">${shortLabel}</span>
                    </span>
                    <span class="fxmaster-placement-toggle-compact">
                      <span class="fxmaster-placement-toggle-arrow fxmaster-placement-toggle-arrow--compact">↓</span>
                      <i class="${iconClass} fxmaster-placement-toggle-icon fxmaster-placement-toggle-icon--compact"></i>
                    </span>
                  </span>
                </span>
              </label>
            </div>
          `;
        }

        return `
          <div class="fxmaster-input-checkbox"${tipAttrs}>
            <label class="fxm-switch">
              <input id="${inputId}" type="checkbox"
                     name="${nameBase}" ${checked} data-action="updateParam"
                     aria-label="${ariaLabel}" />
              <span class="fxm-slider" aria-hidden="true"></span>
            </label>
          </div>
        `;
      }

      case "range": {
        const val = Number(_default);
        const inputId = `${safeId(nameBase)}_range`;

        return `
          <div class="fxmaster-input-range"${tipAttrs}>
            <input id="${inputId}" type="range" name="${nameBase}" value="${val}" min="${parameterConfig.min}" max="${parameterConfig.max}" step="${parameterConfig.step}" data-action="updateParam" aria-label="${ariaLabel}" />
            <output class="range-value" for="${inputId}">${val}</output>
          </div>
        `;
      }

      case "range-dual": {
        const range = _default && typeof _default === "object" ? _default : {};
        const minVal = Number.isFinite(Number(range.min))
          ? Number(range.min)
          : Number(parameterConfig.value?.min ?? parameterConfig.min ?? 0);
        const maxVal = Number.isFinite(Number(range.max))
          ? Number(range.max)
          : Number(parameterConfig.value?.max ?? parameterConfig.max ?? 1);
        const inputMinId = `${safeId(nameBase)}_range_min`;
        const inputMaxId = `${safeId(nameBase)}_range_max`;
        const formatValue = (value) => {
          const decimals = Number.isFinite(Number(parameterConfig.decimals)) ? Number(parameterConfig.decimals) : 2;
          return decimals > 0 ? Number(value).toFixed(decimals) : String(Math.round(Number(value)));
        };

        return `
          <div class="fxmaster-input-range-dual" data-decimals="${
            Number.isFinite(Number(parameterConfig.decimals)) ? Number(parameterConfig.decimals) : 2
          }"${tipAttrs} style="--range-start-pct: ${
          ((minVal - Number(parameterConfig.min ?? 0)) /
            Math.max(1e-9, Number(parameterConfig.max ?? 1) - Number(parameterConfig.min ?? 0))) *
          100
        }; --range-end-pct: ${
          ((maxVal - Number(parameterConfig.min ?? 0)) /
            Math.max(1e-9, Number(parameterConfig.max ?? 1) - Number(parameterConfig.min ?? 0))) *
          100
        };">
            <div class="fxmaster-input-range-dual-track">
              <input id="${inputMinId}" type="range" name="${nameBase}_min" value="${minVal}" min="${
          parameterConfig.min
        }" max="${parameterConfig.max}" step="${
          parameterConfig.step
        }" data-action="updateParam" data-range-role="min" data-decimals="${
          Number.isFinite(Number(parameterConfig.decimals)) ? Number(parameterConfig.decimals) : 2
        }" aria-label="${ariaLabel} minimum" />
              <input id="${inputMaxId}" type="range" name="${nameBase}_max" value="${maxVal}" min="${
          parameterConfig.min
        }" max="${parameterConfig.max}" step="${
          parameterConfig.step
        }" data-action="updateParam" data-range-role="max" data-decimals="${
          Number.isFinite(Number(parameterConfig.decimals)) ? Number(parameterConfig.decimals) : 2
        }" aria-label="${ariaLabel} maximum" />
            </div>
            <div class="fxmaster-input-range-dual-values">
              <output class="range-value range-value-min" for="${inputMinId}">${formatValue(minVal)}</output>
              <span class="range-value-separator" aria-hidden="true">–</span>
              <output class="range-value range-value-max" for="${inputMaxId}">${formatValue(maxVal)}</output>
            </div>
          </div>
        `;
      }

      case "select": {
        const normalizedValue = _default == null ? "" : String(_default);
        const inputId = `${safeId(nameBase)}_select`;
        const choices = Object.entries(parameterConfig.options || {}).map(([value, label]) => ({
          value,
          label: localizeChoiceLabel(label),
          selected: String(value) === normalizedValue,
        }));
        const optionMarkup = choices
          .map(({ value, label, selected }) => {
            const escapedValue = Handlebars.escapeExpression(String(value));
            const escapedLabel = Handlebars.escapeExpression(String(label));
            return `<option value="${escapedValue}"${selected ? " selected" : ""}>${escapedLabel}</option>`;
          })
          .join("");

        return `
          <div class="fxmaster-input-select"${tipAttrs}>
            <select id="${inputId}" name="${nameBase}" aria-label="${ariaLabel}">
              ${optionMarkup}
            </select>
          </div>
        `;
      }

      case "number":
        return `<input id="${safeId(nameBase)}_number" type="number" name="${nameBase}" value="${_default}" step="${
          parameterConfig.step ?? 1
        }" data-action="updateParam"${tipAttrs} aria-label="${ariaLabel}" />`;

      case "multi-select": {
        const config = {
          name: nameBase,
          value: Array.isArray(_default) ? _default : [_default],
          options: Object.entries(parameterConfig.options || {}).map((i) => ({ value: i[0], label: i[1] })),
          dataset: { action: "updateParam", tooltip: tipText, tooltipDirection: tipDir },
          localize: true,
        };
        const select = foundry.applications.fields.createMultiSelectInput(config);
        return `<div class="fxmaster-input-multi"${tipAttrs}>${select.outerHTML}</div>`;
      }

      case "scene-levels": {
        const config = {
          name: nameBase,
          value: normalizeSceneLevelUiSelection(_default),
          options: getSceneLevelMultiSelectChoices(),
          dataset: { action: "updateParam", tooltip: tipText, tooltipDirection: tipDir },
          localize: false,
        };
        const select = foundry.applications.fields.createMultiSelectInput(config);
        return `<div class="fxmaster-input-multi"${tipAttrs}>${select.outerHTML}</div>`;
      }

      default:
        return `<input id="${safeId(
          nameBase,
        )}_text" type="text" name="${nameBase}" value="${_default}" data-action="updateParam"${tipAttrs} aria-label="${ariaLabel}">`;
    }
  });

  /**
   * Determine whether a parameter should be displayed in the UI.
   *
   * @param {"particle"|"filter"} kind
   * @param {string} type
   * @param {string} paramName
   * @returns {boolean}
   */
  Handlebars.registerHelper("fxmasterShouldRenderParam", (kind, type, paramName) =>
    isManagementParameterVisible(kind, type, paramName),
  );

  /**
   * Determine whether a management-app parameter should render a separate title.
   *
   * @param {Record<string, any>} parameterConfig
   * @param {string} paramName
   * @returns {boolean}
   */
  Handlebars.registerHelper("fxmasterShouldRenderParamTitle", (parameterConfig, paramName) =>
    shouldRenderManagementParameterTitle(parameterConfig, paramName),
  );

  /**
   * Return tooltip attributes for a parameter label or summary.
   *
   * @param {Record<string, any>} parameterConfig
   * @returns {Handlebars.SafeString}
   */
  Handlebars.registerHelper("fxmasterParamTooltipAttrs", (parameterConfig) => {
    const tooltipsEnabled = game.settings.get(packageId, "enableTooltips") ?? true;
    if (!tooltipsEnabled) return new Handlebars.SafeString("");
    return new Handlebars.SafeString(getParameterTooltipMeta(parameterConfig).attrs);
  });

  /**
   * Determine whether a parameter should use the compact placement-toggle layout.
   *
   * @param {string} paramName
   * @returns {boolean}
   */
  Handlebars.registerHelper("fxmasterIsPlacementParam", (paramName) => isPlacementParameter(paramName));

  /**
   * Render a hidden version of a parameter input so its value is preserved (and gathered by gatherFilterOptions) even when not shown.
   *
   * Intended primarily for soundFxEnabled.
   */
  Handlebars.registerHelper("fxmasterHiddenParameter", (effectCls, parameterConfig, parameterName, options = {}) => {
    const defaultValue = effectCls.default?.[parameterName] ?? parameterConfig.value ?? "";
    const raw = options?.[parameterName];
    const _default = raw == null || raw === "" ? defaultValue : raw;

    const nameBase = `${effectCls.label}_${parameterName}`;
    const safeId = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "-");

    if (parameterConfig.type === "checkbox") {
      const checked = _default ? "checked" : "";
      const inputId = `${safeId(nameBase)}_switch_hidden`;
      return `<input id="${inputId}" type="checkbox" name="${nameBase}" ${checked} data-action="updateParam" style="display:none" aria-hidden="true" tabindex="-1" />`;
    }

    if (parameterConfig.type === "range-dual") {
      const range = _default && typeof _default === "object" ? _default : {};
      const minVal = Number.isFinite(Number(range.min))
        ? Number(range.min)
        : Number(parameterConfig.value?.min ?? parameterConfig.min ?? 0);
      const maxVal = Number.isFinite(Number(range.max))
        ? Number(range.max)
        : Number(parameterConfig.value?.max ?? parameterConfig.max ?? 1);
      const minId = `${safeId(nameBase)}_range_hidden_min`;
      const maxId = `${safeId(nameBase)}_range_hidden_max`;
      return `<input id="${minId}" type="hidden" name="${nameBase}_min" value="${minVal}" aria-hidden="true" tabindex="-1" /><input id="${maxId}" type="hidden" name="${nameBase}_max" value="${maxVal}" aria-hidden="true" tabindex="-1" />`;
    }

    return "";
  });
}

Handlebars.registerHelper("getEffectParams", function (active, passive, type) {
  return active?.[type] ?? passive?.[type] ?? {};
});
