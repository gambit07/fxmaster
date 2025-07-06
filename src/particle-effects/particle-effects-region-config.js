export class ParticleEffectsRegionBehaviorConfig extends foundry.applications.sheets.RegionBehaviorConfig {
  static PARTS = foundry.utils.mergeObject(super.PARTS, { form: { scrollable: [""] } }, { inplace: false });

  async _renderHTML(context, options) {
    const rendered = await super._renderHTML(context, options);

    rendered.form.classList.add("scrollable");

    // This disgusts me
    const fieldset = Array.from(rendered.form.querySelectorAll("fieldset")).find(
      (fs) =>
        fs.querySelector("legend")?.textContent.trim() ===
        game.i18n.localize("FXMASTER.ParticleEffectRegionBehaviorName"),
    );
    if (!fieldset) return rendered;

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
      } else i++;
    }

    return rendered;
  }
}
