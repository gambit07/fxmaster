/**
 * Configuration sheet for region-scoped filter behaviors.
 * Groups per-filter controls, adds scrolling, and manages dynamic visibility
 * for elevation-based gating options.
 */
export class FilterRegionBehaviorConfig extends foundry.applications.sheets.RegionBehaviorConfig {
  static PARTS = foundry.utils.mergeObject(super.PARTS, { form: { scrollable: [""] } }, { inplace: false });

  /**
   * Customize the rendered HTML for the region behavior form.
   * - Adds a scrollable container class.
   * - Groups each filter's enable checkbox with its related settings.
   * - Toggles visibility of elevation gating fields based on the selected mode.
   * @param {object} context - Rendering context from Foundry.
   * @param {object} options - Render options from Foundry.
   * @returns {Promise<{form: HTMLFormElement}>} The rendered HTML wrapper.
   */
  async _renderHTML(context, options) {
    const rendered = await super._renderHTML(context, options);

    rendered.form.classList.add("scrollable");

    const fieldset = Array.from(rendered.form.querySelectorAll("fieldset")).find(
      (fs) =>
        fs.querySelector("legend")?.textContent.trim() ===
        game.i18n.localize("FXMASTER.Regions.BehaviorNames.FilterEffectRegionBehaviorName"),
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
      } else {
        i++;
      }
    }

    const findGroupByName = (name) => {
      let el = rendered.form.querySelector(`.form-group [name="system.${name}"]`);
      if (el) return el.closest(".form-group");

      el = rendered.form.querySelector(
        `.form-group [data-edit="system.${name}"], .form-group [name^="system.${name}["]`,
      );
      return el ? el.closest(".form-group") : null;
    };

    const gateModeInput =
      rendered.form.querySelector('select[name="system._elev_gateMode"]') ||
      rendered.form.querySelector('[name="system._elev_gateMode"]');

    const targetsGroup = findGroupByName("_elev_tokenTargets");
    const gmAlwaysGroup = findGroupByName("_elev_gmAlwaysVisible");

    if (gateModeInput) {
      const applyVisibility = () => {
        const mode = gateModeInput.value;
        if (targetsGroup) targetsGroup.style.display = mode === "targets" ? "" : "none";
        if (gmAlwaysGroup) gmAlwaysGroup.style.display = mode === "targets" || mode === "pov" ? "" : "none";
      };

      applyVisibility();
      gateModeInput.addEventListener("change", applyVisibility);
      gateModeInput.addEventListener("input", applyVisibility);
    }

    return rendered;
  }
}
