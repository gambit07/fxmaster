export class CommonRegionBehaviorConfig extends foundry.applications.sheets.RegionBehaviorConfig {
  static PARTS = foundry.utils.mergeObject(super.PARTS, { form: { scrollable: [""] } }, { inplace: false });

  /** Override in subclasses */
  static FIELDSET_LEGEND_I18N = null;

  async _renderHTML(context, options) {
    const rendered = await super._renderHTML(context, options);
    rendered.form.classList.add("scrollable");

    const legendKey = this.constructor.FIELDSET_LEGEND_I18N;
    if (!legendKey) return rendered;

    const wantLegend = game.i18n.localize(legendKey);
    const fieldset = Array.from(rendered.form.querySelectorAll("fieldset")).find(
      (fs) => fs.querySelector("legend")?.textContent.trim() === wantLegend,
    );
    if (!fieldset) return rendered;

    this._groupByEnabled(fieldset);

    this._wireElevationGateVisibility(rendered.form);

    return rendered;
  }

  _groupByEnabled(fieldset) {
    const rows = Array.from(fieldset.querySelectorAll(".form-group"));
    let i = 0;

    while (i < rows.length) {
      const row = rows[i];
      if (row.querySelector('input[type="checkbox"][name$="_enabled"]')) {
        row.classList.add("behavior-header");

        const wrapper = document.createElement("div");
        wrapper.classList.add("behavior-group");
        fieldset.insertBefore(wrapper, row);
        wrapper.appendChild(row);
        i++;

        while (i < rows.length && !rows[i].querySelector('input[type="checkbox"][name$="_enabled"]')) {
          const setting = rows[i];
          setting.classList.add("behavior-settings");
          wrapper.appendChild(setting);
          i++;
        }
      } else {
        i++;
      }
    }
  }

  _wireElevationGateVisibility(form) {
    const findGroupByName = (name) => {
      let el = form.querySelector(`.form-group [name="system.${name}"]`);
      if (el) return el.closest(".form-group");

      el = form.querySelector(`.form-group [data-edit="system.${name}"], .form-group [name^="system.${name}["]`);
      return el ? el.closest(".form-group") : null;
    };

    const gateModeInput =
      form.querySelector('select[name="system._elev_gateMode"]') ||
      form.querySelector('[name="system._elev_gateMode"]');

    const targetsGroup = findGroupByName("_elev_tokenTargets");
    const gmAlwaysGroup = findGroupByName("_elev_gmAlwaysVisible");

    if (!gateModeInput) return;

    const applyVisibility = () => {
      const mode = gateModeInput.value;
      if (targetsGroup) targetsGroup.style.display = mode === "targets" ? "" : "none";
      if (gmAlwaysGroup) gmAlwaysGroup.style.display = mode === "targets" || mode === "pov" ? "" : "none";
    };

    applyVisibility();
    gateModeInput.addEventListener("change", applyVisibility);
    gateModeInput.addEventListener("input", applyVisibility);
  }
}
