import { isSoundFxParameterVisible } from "../handlebars-helpers.js";
import { logger } from "../logger.js";
import { resolveDarknessActivationEnabled } from "../utils.js";
export class CommonRegionBehaviorConfig extends foundry.applications.sheets.RegionBehaviorConfig {
  static PARTS = foundry.utils.mergeObject(super.PARTS, { form: { scrollable: [""] } }, { inplace: false });

  /**
   * Localization key for the primary fieldset legend. Override in subclasses when grouping is required.
   *
   * @type {string|null}
   */
  static FIELDSET_LEGEND_I18N = null;

  async _renderHTML(context, options) {
    const rendered = await super._renderHTML(context, options);
    rendered.form.classList.add("scrollable");
    this._configureDarknessActivationInputs(rendered.form);
    this._primeDarknessActivationToggles(rendered.form);

    this._wireElevationGateVisibility(rendered.form);
    this._wireFxmasterConditionalVisibility(rendered.form);

    const legendKey = this.constructor.FIELDSET_LEGEND_I18N;
    if (!legendKey) return rendered;

    const wantLegend = game.i18n.localize(legendKey);
    const fieldset = Array.from(rendered.form.querySelectorAll("fieldset")).find(
      (fs) => fs.querySelector("legend")?.textContent.trim() === wantLegend,
    );
    if (!fieldset) return rendered;

    this._groupByEnabled(fieldset);
    return rendered;
  }

  _configureDarknessActivationInputs(form) {
    if (!form) return;

    const clampField = (input) => {
      const current = Number.parseFloat(String(input?.value ?? ""));
      if (!Number.isFinite(current)) return;
      const clamped = Math.min(1, Math.max(0, current));
      input.value = `${clamped}`;
    };

    const selectors =
      'input[name^="system."][name$="_darknessActivationRange_min"], input[name^="system."][name$="_darknessActivationRange_max"]';

    for (const input of form.querySelectorAll(selectors)) {
      try {
        input.type = "text";
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      input.removeAttribute("min");
      input.removeAttribute("max");
      input.removeAttribute("step");
      input.inputMode = "decimal";
      input.autocomplete = "off";
      input.size = 3;
      input.classList.add("fxmaster-darkness-activation-input");

      const group = input.closest(".form-group");
      group?.classList.add("fxmaster-darkness-activation-group");
      const label = group?.querySelector("label");
      if (label) {
        const isMin = input.name.endsWith("_darknessActivationRange_min");
        label.textContent = game.i18n.localize(
          isMin ? "FXMASTER.Params.DarknessActivationMin" : "FXMASTER.Params.DarknessActivationMax",
        );
      }

      input.addEventListener("change", () => clampField(input));
      input.addEventListener("blur", () => clampField(input));
    }
  }

  _primeDarknessActivationToggles(form) {
    if (!form) return;

    const sourceSystem =
      this.document?._source?.system ?? this.object?._source?.system ?? this.object?.toObject?.()?.system ?? {};

    for (const checkbox of form.querySelectorAll(
      'input[type="checkbox"][name^="system."][name$="_darknessActivationEnabled"]',
    )) {
      const fullName = String(checkbox.name ?? "");
      const base = fullName.replace(/^system\./, "").replace(/_darknessActivationEnabled$/, "");
      const storedExplicit = sourceSystem?.[`${base}_darknessActivationEnabled`];
      if (typeof storedExplicit === "boolean") continue;

      const minInput = form.querySelector(`[name="system.${base}_darknessActivationRange_min"]`);
      const maxInput = form.querySelector(`[name="system.${base}_darknessActivationRange_max"]`);
      if (!minInput && !maxInput) continue;

      checkbox.checked = resolveDarknessActivationEnabled({
        darknessActivationRange: {
          min: minInput?.value,
          max: maxInput?.value,
        },
      });
    }
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
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    const ac = new AbortController();
    this._fxmConditionalVisibilityAbort = ac;

    const sources = [];
    try {
      const cfg = CONFIG?.fxmaster;
      if (cfg?.particleEffects) sources.push({ kind: "particle", defs: cfg.particleEffects });
      if (cfg?.filterEffects) sources.push({ kind: "filter", defs: cfg.filterEffects });
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    const rules = [];

    const findGroupByName = (name) => {
      let el = form.querySelector(`.form-group [name="system.${name}"]`);
      if (el) return el.closest(".form-group");
      el = form.querySelector(`.form-group [name="system.${name}_min"], .form-group [name="system.${name}_max"]`);
      if (el) return el.closest(".form-group");
      el = form.querySelector(`.form-group [data-edit="system.${name}"], .form-group [name^="system.${name}["]`);
      return el ? el.closest(".form-group") : null;
    };

    const findControl = (name) =>
      form.querySelector(`[name="system.${name}"]`) ||
      form.querySelector(`[data-edit="system.${name}"]`) ||
      form.querySelector(`[name^="system.${name}["]`);

    const readMultiSelect = (el) => {
      const mv = el?.value;
      if (mv instanceof Set) return Array.from(mv);
      if (Array.isArray(mv)) return mv;

      const tags = el?.querySelectorAll?.("tag") ?? [];
      if (tags.length) {
        const vals = Array.from(tags)
          .map((t) => t.value)
          .filter((v) => v != null && v !== "");
        if (vals.length) return vals;
      }

      const inner = el?.querySelector?.("select[multiple]");
      if (inner instanceof HTMLSelectElement) {
        return Array.from(inner.selectedOptions).map((o) => o.value);
      }

      const hidden = el?.querySelectorAll?.('input[type="hidden"][name$="[]"]') ?? [];
      if (hidden.length) {
        const vals = Array.from(hidden)
          .map((h) => h.value)
          .filter((v) => v != null && v !== "");
        if (vals.length) return vals;
      }

      if (typeof mv === "string" && mv.length) {
        try {
          const parsed = JSON.parse(mv);
          if (Array.isArray(parsed)) return parsed;
        } catch (err) {
          logger.debug("FXMaster:", err);
        }
      }

      return [];
    };

    const readValue = (el) => {
      if (!el) return undefined;

      const tag = (el.tagName ?? "").toLowerCase();
      if (tag === "multi-select") return readMultiSelect(el);

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
      if (tag === "color-picker") return el.value ?? el.getAttribute?.("value");
      if (el?.value instanceof Set) return Array.from(el.value);
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

    for (const source of sources) {
      for (const [type, cls] of Object.entries(source?.defs ?? {})) {
        const params = cls?.parameters;
        if (!params) continue;

        for (const [paramName, paramCfg] of Object.entries(params)) {
          const showWhen = paramCfg?.showWhen;
          const hideWhen = paramCfg?.hideWhen;
          const regionOnly = !!paramCfg?.regionOnly;
          const sceneOnly = !!paramCfg?.sceneOnly;
          const soundFxParam = paramName === "soundFxEnabled";
          if (!showWhen && !hideWhen && !regionOnly && !sceneOnly && !soundFxParam) continue;

          const groups =
            paramCfg?.type === "range-dual"
              ? [findGroupByName(`${type}_${paramName}_min`), findGroupByName(`${type}_${paramName}_max`)].filter(
                  Boolean,
                )
              : [findGroupByName(`${type}_${paramName}`)].filter(Boolean);
          if (!groups.length) continue;

          rules.push({ kind: source.kind, type, paramName, showWhen, hideWhen, regionOnly, sceneOnly, groups });
        }
      }
    }

    if (!rules.length) return;

    const applyAll = () => {
      const isRegionContext = true;
      for (const r of rules) {
        const showOk = evalCond(r.showWhen, r.type);
        const hideOk = r.hideWhen ? evalCond(r.hideWhen, r.type) : false;
        const regionOk = !r.regionOnly || isRegionContext;
        const sceneOk = !r.sceneOnly || !isRegionContext;
        const soundFxOk = isSoundFxParameterVisible(r.kind, r.type, r.paramName);
        const visible = showOk && !hideOk && regionOk && sceneOk && soundFxOk;
        for (const group of r.groups ?? []) group.style.display = visible ? "" : "none";
      }
    };

    applyAll();
    try {
      requestAnimationFrame(() => applyAll());
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

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
