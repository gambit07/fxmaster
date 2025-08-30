export function registerHandlebarsHelpers() {
  Handlebars.registerHelper("fxmasterParameter", (effectCls, parameterConfig, parameterName, options = {}) => {
    const defaultValue = effectCls.default?.[parameterName] ?? parameterConfig.value ?? "";
    const raw = options?.[parameterName];

    const _default = raw == null || raw === "" ? defaultValue : raw;
    const nameBase = `${effectCls.label}_${parameterName}`;

    switch (parameterConfig.type) {
      case "color": {
        const colorValue = typeof _default === "object" ? _default.value : "#000000";
        const applyChecked = _default?.apply ? "checked" : "";

        return `
          <div class="fxmaster-input-color">
            <input type="checkbox" name="${nameBase}_apply" ${applyChecked} data-action="updateParam" />
            <input type="color" name="${nameBase}" value="${colorValue}" data-action="updateParam" />
          </div>
        `;
      }

      case "checkbox": {
        const applyChecked = _default?.apply ? "checked" : "";

        return `
          <div class="fxmaster-input-color">
            <input type="checkbox" name="${nameBase}_apply" ${applyChecked} data-action="updateParam" />
          </div>
        `;
      }

      case "range": {
        const val = Number(_default);

        return `
          <div class="fxmaster-input-range">
            <input type="range" name="${nameBase}" value="${val}" min="${parameterConfig.min}" max="${parameterConfig.max}" step="${parameterConfig.step}" data-action="updateParam" />
            <output class="range-value" for="${nameBase}">${val}</output>
          </div>
        `;
      }

      case "number":
        return `<input type="number" name="${nameBase}" value="${_default}" step="${
          parameterConfig.step ?? 1
        }" data-action="updateParam" />`;

      case "multi-select": {
        const config = {
          name: nameBase,
          value: Array.isArray(_default) ? _default : [_default],
          options: Object.entries(parameterConfig.options || {}).map((i) => ({ value: i[0], label: i[1] })),
          dataset: { action: "updateParam" },
          localize: true,
        };
        const select = foundry.applications.fields.createMultiSelectInput(config);
        return select.outerHTML;
      }

      default:
        return `<input type="text" name="${nameBase}" value="${_default}" data-action="updateParam">`;
    }
  });
}
