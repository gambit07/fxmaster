import { packageId } from "./constants.js";

export function registerHandlebarsHelpers() {
  Handlebars.registerHelper("fxmasterParameter", (effectCls, parameterConfig, parameterName, options = {}) => {
    const defaultValue = effectCls.default?.[parameterName] ?? parameterConfig.value ?? "";
    const raw = options?.[parameterName];

    const _default = raw == null || raw === "" ? defaultValue : raw;
    const nameBase = `${effectCls.label}_${parameterName}`;
    const safeId = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "-");
    let tooltipsEnabled = game.settings.get(packageId, "enableTooltips") ?? true;
    let tipText = "";
    let tipDir = "LEFT";
    let tipAttrs = "";
    if (tooltipsEnabled) {
      const labelKey = typeof parameterConfig.label === "string" ? parameterConfig.label : null;
      const leaf = labelKey?.replace(/^FXMASTER\.Params\./, "");
      const hintKey = leaf ? `FXMASTER.ParamTooltips.${leaf}` : "";
      tipText = hintKey && game.i18n.has(hintKey) ? game.i18n.localize(hintKey) : "";
      tipDir = (parameterConfig.tooltipDirection ?? "LEFT").toUpperCase();
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
}

Handlebars.registerHelper("getEffectParams", function (active, passive, type) {
  return active?.[type] ?? passive?.[type] ?? {};
});
