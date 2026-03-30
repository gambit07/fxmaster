import { packageId } from "./constants.js";

const FXMASTER_PLUS_ID = "fxmaster-plus";

function isV13Plus() {
  return (game?.release?.generation ?? 0) >= 13;
}

/**
 * Cache for computed SoundFX-eligible effect types.
 * This prevents repeatedly parsing the Sound FX rules for every parameter row.
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
  if (!plusActive || !isV13Plus()) return out;

  /** @type {any} */
  let raw;
  try {
    raw = game.settings.get(FXMASTER_PLUS_ID, "soundFxRules");
  } catch {
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
  if (!plusActive || !isV13Plus()) return { particles: {}, filters: {} };

  /** @type {any} */
  let raw;
  try {
    raw = game.settings.get(FXMASTER_PLUS_ID, "soundFxRules");
  } catch {
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

export function registerHandlebarsHelpers() {
  Handlebars.registerHelper("fxmasterParameter", (effectCls, parameterConfig, parameterName, options = {}) => {
    const defaultValue = effectCls.default?.[parameterName] ?? parameterConfig.value ?? "";
    const raw = options?.[parameterName];

    const _default = raw == null || raw === "" ? defaultValue : raw;
    const nameBase = `${effectCls.label}_${parameterName}`;
    const safeId = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "-");
    let tooltipsEnabled = game.settings.get(packageId, "enableTooltips") ?? true;
    let tipText = "";
    let tipDir = "UP";
    let tipAttrs = "";
    if (tooltipsEnabled) {
      const labelKey = typeof parameterConfig.label === "string" ? parameterConfig.label : null;
      const leaf = labelKey?.replace(/^FXMASTER\.Params\./, "");
      const hintKey = leaf ? `FXMASTER.ParamTooltips.${leaf}` : "";
      tipText = hintKey && game.i18n.has(hintKey) ? game.i18n.localize(hintKey) : "";
      tipDir = (parameterConfig.tooltipDirection ?? "UP").toUpperCase();
      tipAttrs = tipText ? ` data-tooltip="${tipText}" data-tooltip-direction="${tipDir}"` : "";
    }

    switch (parameterConfig.type) {
      case "color": {
        let colorValue = typeof _default === "object" ? _default.value : _default;
        if (typeof colorValue !== "string") colorValue = "#000000";
        if (/^[0-9a-f]{6,8}$/i.test(colorValue)) colorValue = `#${colorValue}`;
        if (!/^#[0-9a-f]{6,8}$/i.test(colorValue)) colorValue = "#000000";

        const applyChecked = _default?.apply ? "checked" : "";
        const applyName = `${nameBase}_apply`;
        const applyId = `${safeId(applyName)}_switch`;

        const hasColorPickerEl = !!globalThis.customElements?.get?.("color-picker");
        const pickerHTML = hasColorPickerEl
          ? `<color-picker name="${nameBase}" value="${colorValue}" data-action="updateParam"></color-picker>`
          : `<input type="color" name="${nameBase}" value="${colorValue}" data-action="updateParam" />`;

        return `
          <div class="fxmaster-input-color"${tipAttrs}>
            <label class="fxm-switch">
              <input id="${applyId}" type="checkbox"
                    name="${applyName}" ${applyChecked} data-action="updateParam"
                    aria-label="${parameterConfig.label ?? "Apply"}" />
              <span class="fxm-slider" aria-hidden="true"></span>
            </label>
            ${pickerHTML}
          </div>
        `;
      }

      case "checkbox": {
        const checked = _default ? "checked" : "";
        const inputId = `${safeId(nameBase)}_switch`;

        return `
          <div class="fxmaster-input-checkbox"${tipAttrs}>
            <label class="fxm-switch">
              <input id="${inputId}" type="checkbox"
                     name="${nameBase}" ${checked} data-action="updateParam"
                     aria-label="${parameterConfig.label ?? parameterName}" />
              <span class="fxm-slider" aria-hidden="true"></span>
            </label>
          </div>
        `;
      }

      case "range": {
        const val = Number(_default);

        return `
          <div class="fxmaster-input-range"${tipAttrs}>
            <input type="range" name="${nameBase}" value="${val}" min="${parameterConfig.min}" max="${parameterConfig.max}" step="${parameterConfig.step}" data-action="updateParam" />
            <output class="range-value" for="${nameBase}">${val}</output>
          </div>
        `;
      }

      case "number":
        return `<input type="number" name="${nameBase}" value="${_default}" step="${
          parameterConfig.step ?? 1
        }" data-action="updateParam"${tipAttrs} />`;

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

      default:
        return `<input type="text" name="${nameBase}" value="${_default}" data-action="updateParam"${tipAttrs}>`;
    }
  });

  /**
   * Determine whether a parameter should be displayed in the UI.
   *
   * Currently used to hide the per-effect Sound FX toggle unless:
   *  - FXMaster+ is active
   *  - Foundry V13+
   *  - The Sound FX Manager has at least one usable rule that references the effect
   *
   * @param {"particle"|"filter"} kind
   * @param {string} type
   * @param {string} paramName
   */
  Handlebars.registerHelper("fxmasterShouldRenderParam", (kind, type, paramName) => {
    if (paramName !== "soundFxEnabled") return true;

    try {
      const plusActive = !!game?.modules?.get?.(FXMASTER_PLUS_ID)?.active;
      if (!plusActive || !isV13Plus()) return false;

      const eligible = getSoundFxEligibleTypesCached();
      if (kind === "particle") return !!eligible?.particles?.[type];
      if (kind === "filter") return !!eligible?.filters?.[type];
      return false;
    } catch {
      return false;
    }
  });

  /**
   * Render a hidden version of a parameter input so its value is preserved
   * (and gathered by gatherFilterOptions) even when not shown.
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

    return "";
  });
}

Handlebars.registerHelper("getEffectParams", function (active, passive, type) {
  return active?.[type] ?? passive?.[type] ?? {};
});
