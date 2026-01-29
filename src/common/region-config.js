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
    this._wireFxmasterConditionalVisibility(rendered.form);

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

  _wireFxmasterConditionalVisibility(form) {
    if (!form) return;

    try {
      this._fxmConditionalVisibilityAbort?.abort();
    } catch {}
    const ac = new AbortController();
    this._fxmConditionalVisibilityAbort = ac;

    const sources = [];
    try {
      const cfg = CONFIG?.fxmaster;
      if (cfg?.particleEffects) sources.push(cfg.particleEffects);
      if (cfg?.filterEffects) sources.push(cfg.filterEffects);
    } catch {}

    const rules = [];

    const findGroupByName = (name) => {
      let el = form.querySelector(`.form-group [name="system.${name}"]`);
      if (el) return el.closest(".form-group");
      el = form.querySelector(`.form-group [data-edit="system.${name}"], .form-group [name^="system.${name}["]`);
      return el ? el.closest(".form-group") : null;
    };

    const findControl = (name) =>
      form.querySelector(`[name="system.${name}"]`) ||
      form.querySelector(`[data-edit="system.${name}"]`) ||
      form.querySelector(`[name^="system.${name}["]`);

    const readValue = (el) => {
      if (!el) return undefined;
      if (el instanceof HTMLSelectElement) {
        if (el.multiple) return Array.from(el.selectedOptions).map((o) => o.value);
        return el.value;
      }
      if (el instanceof HTMLInputElement) {
        if (el.type === "checkbox") return !!el.checked;
        if (el.type === "range" || el.type === "number") {
          const n = Number(el.value);
          return Number.isFinite(n) ? n : undefined;
        }
        return el.value;
      }
      const tag = (el.tagName ?? "").toLowerCase();
      if (tag === "color-picker") return el.value ?? el.getAttribute?.("value");
      return el.value ?? el.getAttribute?.("value");
    };

    const looseEquals = (actual, expected) => {
      if (typeof expected === "boolean") {
        if (typeof actual === "string") return (actual === "true") === expected;
        return !!actual === expected;
      }
      if (typeof expected === "number") {
        const n = Number(actual);
        if (!Number.isFinite(n)) return false;
        return n === expected;
      }
      if (Array.isArray(expected)) {
        if (!Array.isArray(actual)) return false;
        return expected.length === actual.length && expected.every((v) => actual.includes(v));
      }
      return actual === expected;
    };

    const evalCond = (cond, type) => {
      if (!cond) return true;
      if (typeof cond === "function") {
        try {
          return !!cond({ get: (k) => readValue(findControl(`${type}_${k}`)) });
        } catch {
          return true;
        }
      }
      if (typeof cond === "object") {
        return Object.entries(cond).every(([k, expected]) => {
          const actual = readValue(findControl(`${type}_${k}`));
          return looseEquals(actual, expected);
        });
      }
      return true;
    };

    for (const defs of sources) {
      for (const [type, cls] of Object.entries(defs ?? {})) {
        const params = cls?.parameters;
        if (!params) continue;

        for (const [paramName, paramCfg] of Object.entries(params)) {
          const showWhen = paramCfg?.showWhen;
          const hideWhen = paramCfg?.hideWhen;
          if (!showWhen && !hideWhen) continue;

          const group = findGroupByName(`${type}_${paramName}`);
          if (!group) continue;

          rules.push({ type, paramName, showWhen, hideWhen, group });
        }
      }
    }

    if (!rules.length) return;

    const applyAll = () => {
      for (const r of rules) {
        const showOk = evalCond(r.showWhen, r.type);
        const hideOk = r.hideWhen ? evalCond(r.hideWhen, r.type) : false;
        const visible = showOk && !hideOk;
        r.group.style.display = visible ? "" : "none";
      }
    };

    applyAll();

    let raf = null;
    const schedule = () => {
      if (raf != null) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        applyAll();
      });
    };

    form.addEventListener("change", schedule, { signal: ac.signal, capture: true });
    form.addEventListener("input", schedule, { signal: ac.signal, capture: true });
  }
}
