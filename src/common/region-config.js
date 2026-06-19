import { isSoundFxParameterVisible } from "../handlebars-helpers.js";
import { logger } from "../logger.js";
import { packageId } from "../constants.js";
import { invalidateEffectStackCache } from "./effect-stack.js";
import { FilterEffectsSceneManager } from "../filter-effects/filter-effects-scene-manager.js";
import { refreshSceneParticlesSuppressionMasks } from "../particle-effects/particle-effects-scene-manager.js";
import { getRegionPlaceableOrDocumentAdapter, resolveDarknessActivationEnabled } from "../utils.js";
import { configureNormalizedRegionRangeInputs } from "../utils/region-schema.js";
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
    this._configureNormalizedRangeInputs(rendered.form);
    this._configureDarknessActivationInputs(rendered.form);
    this._primeDarknessActivationToggles(rendered.form);
    this._configureParticleActionInputs(rendered.form);

    this._wireElevationGateVisibility(rendered.form);
    this._wireFxmasterConditionalVisibility(rendered.form);
    this._wireLivePreview(rendered.form);

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

  /**
   * Resolve the containing sheet form from a rendered form part.
   * @param {HTMLElement|HTMLFormElement|null} formPart
   * @returns {HTMLFormElement|null}
   */
  _resolveLivePreviewForm(formPart) {
    const isForm = (candidate) => {
      return (
        candidate instanceof HTMLFormElement &&
        candidate.elements &&
        typeof candidate.elements[Symbol.iterator] === "function"
      );
    };

    if (isForm(formPart)) return formPart;
    if (isForm(this.form)) return this.form;

    const closest = formPart?.closest?.("form");
    if (isForm(closest)) return closest;

    const nested = formPart?.querySelector?.("form");
    if (isForm(nested)) return nested;

    const applicationForm = this.element?.querySelector?.("form");
    if (isForm(applicationForm)) return applicationForm;

    return null;
  }

  /**
   * Collect form data using Foundry's ApplicationV2 form parser.
   * @param {HTMLElement|HTMLFormElement|null} formPart
   * @returns {object|null}
   */
  _readLivePreviewSubmitData(formPart) {
    const FormDataExtended = foundry?.applications?.ux?.FormDataExtended;
    const form = this._resolveLivePreviewForm(formPart);
    if (!form || !FormDataExtended) return null;

    try {
      const formData = new FormDataExtended(form);
      return this._prepareSubmitData(null, form, formData);
    } catch (err) {
      logger.debug("FXMaster:", err);
      return null;
    }
  }

  /**
   * Store the authoritative source data before temporary live-preview edits.
   * @returns {void}
   */
  _ensureLivePreviewSource() {
    if (this._fxmLivePreviewSource) return;
    const source = this.document?._source ?? this.document?.toObject?.(false) ?? {};
    this._fxmLivePreviewSource = foundry.utils.deepClone(source);
  }

  /**
   * Restore the original behavior source after an uncommitted live preview.
   * @param {{ refresh?: boolean }} [options]
   * @returns {void}
   */
  _restoreLivePreviewSource({ refresh = true } = {}) {
    if (!this._fxmLivePreviewSource || !this.document) return;
    try {
      this.document.__fxmLivePreview = false;
      this.document.updateSource(this._fxmLivePreviewSource);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    const snapshot = this._fxmLivePreviewSource;
    this._fxmLivePreviewSource = null;
    if (refresh) this._refreshLivePreviewRegion({ soft: false, reason: "restore", source: snapshot });
  }

  /**
   * Refresh affected Region, scene suppression, and stack visuals after a preview change.
   * @param {{ soft?: boolean, reason?: string, source?: object|null }} [options]
   * @returns {void}
   */
  _refreshLivePreviewRegion({ soft = true, reason = "preview", source = null } = {}) {
    const behavior = this.document;
    const regionDoc = behavior?.parent ?? null;
    if (!regionDoc || regionDoc?.parent !== canvas?.scene) return;

    const placeable = getRegionPlaceableOrDocumentAdapter(regionDoc);
    if (!placeable) return;

    const type = String(behavior.type ?? source?.type ?? "");
    const behaviors = Array.from(regionDoc.behaviors ?? []);

    try {
      invalidateEffectStackCache();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    if (type === `${packageId}.filterEffectsRegion`) {
      canvas.filtereffects?.drawRegionFilterEffects?.(placeable, { soft, behaviorDocs: behaviors });
    } else if (type === `${packageId}.particleEffectsRegion`) {
      canvas.particleeffects?.drawRegionParticleEffects?.(placeable, { soft, behaviorDocs: behaviors });
    }

    if (type === `${packageId}.suppressSceneFilters` || type === "suppressWeather") {
      try {
        FilterEffectsSceneManager.instance.refreshSceneFilterSuppressionMasks();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    if (type === `${packageId}.suppressSceneParticles` || type === "suppressWeather") {
      try {
        refreshSceneParticlesSuppressionMasks({ sync: true });
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    if (reason === "preview") {
      try {
        canvas.filtereffects?.forceRegionMaskRefresh?.(regionDoc.id);
        canvas.particleeffects?.forceRegionMaskRefresh?.(regionDoc.id);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
  }

  /**
   * Apply the current form state to the local behavior document without persisting it.
   * @param {HTMLFormElement} form
   * @returns {void}
   */
  _applyLivePreview(form) {
    const data = this._readLivePreviewSubmitData(form);
    if (!data) return;

    this._ensureLivePreviewSource();
    try {
      this.document.__fxmLivePreview = true;
      this.document.updateSource(data);
    } catch (err) {
      logger.debug("FXMaster:", err);
      return;
    }

    this._refreshLivePreviewRegion({ soft: true, reason: "preview" });
  }

  /**
   * Queue live-preview updates while the Region behavior form is edited.
   * @param {HTMLFormElement} form
   * @returns {void}
   */
  _scheduleLivePreview(form) {
    if (this._fxmLivePreviewTimer != null) return;
    this._fxmLivePreviewTimer = window.setTimeout(() => {
      this._fxmLivePreviewTimer = null;
      this._applyLivePreview(form);
    }, 60);
  }

  /**
   * Wire live-preview Region behavior updates.
   * @param {HTMLFormElement} form
   * @returns {void}
   */
  _wireLivePreview(form) {
    if (!form || !game.user?.isGM) return;
    this._fxmLivePreviewCommitted = false;

    try {
      this._fxmLivePreviewAbort?.abort?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    const ac = new AbortController();
    this._fxmLivePreviewAbort = ac;
    const schedule = () => this._scheduleLivePreview(form);

    form.addEventListener("input", schedule, { signal: ac.signal, capture: true });
    form.addEventListener("change", schedule, { signal: ac.signal, capture: true });
  }

  /** @inheritdoc */
  async _processSubmitData(event, form, submitData, options = {}) {
    this._fxmLivePreviewCommitted = true;
    try {
      this._fxmLivePreviewAbort?.abort?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      this._fxmParticleActionAbort?.abort?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    if (this._fxmLivePreviewTimer != null) {
      clearTimeout(this._fxmLivePreviewTimer);
      this._fxmLivePreviewTimer = null;
    }
    this._restoreLivePreviewSource({ refresh: false });
    await super._processSubmitData(event, form, submitData, options);
    this._refreshLivePreviewRegion({ soft: false, reason: "commit" });
  }

  /** @inheritdoc */
  _onClose(options) {
    try {
      this._fxmLivePreviewAbort?.abort?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      this._fxmParticleActionAbort?.abort?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      this._notifyRegionParticleActionClose();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    if (this._fxmLivePreviewTimer != null) {
      clearTimeout(this._fxmLivePreviewTimer);
      this._fxmLivePreviewTimer = null;
    }
    if (!this._fxmLivePreviewCommitted) this._restoreLivePreviewSource({ refresh: true });
    super._onClose(options);
  }

  _notifyRegionParticleActionClose() {
    if (String(this.document?.type ?? "") !== `${packageId}.particleEffectsRegion`) return;

    const context = {
      app: this,
      scene: canvas?.scene ?? null,
      region: this.document?.parent ?? null,
      behavior: this.document ?? null,
    };

    for (const [type, effectDef] of Object.entries(CONFIG?.fxmaster?.particleEffects ?? {})) {
      if (typeof effectDef?.handleRegionConfigClose !== "function") continue;
      try {
        effectDef.handleRegionConfigClose({ ...context, type });
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
  }

  _configureNormalizedRangeInputs(form) {
    const type = String(this.document?.type ?? "");
    if (type === `${packageId}.particleEffectsRegion`) {
      configureNormalizedRegionRangeInputs(form, CONFIG?.fxmaster?.particleEffects);
    } else if (type === `${packageId}.filterEffectsRegion`) {
      configureNormalizedRegionRangeInputs(form, CONFIG?.fxmaster?.filterEffects);
    }
  }

  _configureParticleActionInputs(form) {
    if (!form || String(this.document?.type ?? "") !== `${packageId}.particleEffectsRegion`) return;

    try {
      this._fxmParticleActionAbort?.abort?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    const ac = new AbortController();
    this._fxmParticleActionAbort = ac;

    for (const [type, effectDef] of Object.entries(CONFIG?.fxmaster?.particleEffects ?? {})) {
      for (const [paramName, paramCfg] of Object.entries(effectDef?.parameters ?? {})) {
        if (paramCfg?.type !== "particle-actions") continue;
        const name = `system.${type}_${paramName}`;
        const input = form.querySelector(`[name="${name}"]`);
        if (!input) continue;

        const group = input.closest?.(".form-group") ?? null;
        if (group) group.dataset.effectType = type;

        const fields = input.closest?.(".form-fields") ?? input.parentElement;
        const actions = this._renderParticleActionControls(type, paramCfg, name);
        if (fields) fields.replaceChildren(actions);
        else input.replaceWith(actions);
      }
    }

    form.addEventListener(
      "click",
      (event) => {
        const button = event.target?.closest?.(".fxmaster-particle-action[data-effect-action]");
        if (!button || !form.contains(button)) return;
        void this._handleRegionParticleAction(event, button, form);
      },
      { signal: ac.signal, capture: true },
    );
  }

  _renderParticleActionControls(type, parameterConfig, name) {
    const wrapper = document.createElement("div");
    wrapper.className = "fxmaster-particle-actions";
    wrapper.dataset.effectType = type;

    const hidden = document.createElement("input");
    hidden.type = "hidden";
    hidden.name = name;
    hidden.value = "";
    wrapper.appendChild(hidden);

    for (const action of Array.isArray(parameterConfig?.actions) ? parameterConfig.actions : []) {
      const actionId = String(action?.action ?? "");
      if (!actionId) continue;

      const button = document.createElement("button");
      button.type = "button";
      button.className = "fxmaster-particle-action";
      button.dataset.effectAction = actionId;
      button.dataset.effectType = type;

      const iconClass = String(action?.icon ?? "");
      if (iconClass) {
        const icon = document.createElement("i");
        icon.className = iconClass;
        icon.setAttribute("aria-hidden", "true");
        button.appendChild(icon);
      }

      const span = document.createElement("span");
      const labelKey = String(action?.label ?? actionId);
      span.textContent = game.i18n?.localize?.(labelKey) ?? labelKey;
      button.appendChild(span);

      const tooltipKey = String(action?.tooltip ?? "");
      if (tooltipKey) {
        button.dataset.tooltip = game.i18n?.localize?.(tooltipKey) ?? tooltipKey;
        button.dataset.tooltipDirection = String(game?.settings?.get?.(packageId, "tooltipDirection") ?? "UP");
      }

      wrapper.appendChild(button);
    }

    return wrapper;
  }

  async _handleRegionParticleAction(event, button, form) {
    event?.preventDefault?.();
    event?.stopPropagation?.();

    const type = button?.dataset?.effectType;
    const action = button?.dataset?.effectAction;
    if (!type || !action) return;

    const effectDef = CONFIG.fxmaster?.particleEffects?.[type];
    if (!effectDef) return;

    const parameterActions = Object.values(effectDef.parameters ?? {}).flatMap((parameter) =>
      Array.isArray(parameter?.actions) ? parameter.actions : [],
    );
    const actions = [
      ...(Array.isArray(effectDef.managementActions) ? effectDef.managementActions : []),
      ...(Array.isArray(effectDef.particleActions) ? effectDef.particleActions : []),
      ...parameterActions,
    ];
    const actionDef = actions.find((entry) => entry?.action === action);
    if (!actionDef) return;

    const getOptions = () => this._collectRegionParticleOptions(effectDef, type, form);

    if (action === "toggle-placement" || action === "toggle-delete-placement") {
      this._applyLivePreview(form);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }

    const context = {
      app: this,
      scene: canvas?.scene ?? null,
      region: this.document?.parent ?? null,
      behavior: this.document ?? null,
      type,
      action,
      actionDef,
      button,
      event,
      form,
      getOptions,
      options: getOptions(),
    };

    try {
      if (typeof actionDef.handler === "string" && typeof effectDef[actionDef.handler] === "function") {
        await effectDef[actionDef.handler](context);
      } else if (typeof effectDef.handleManagementAction === "function") {
        await effectDef.handleManagementAction(action, context);
      } else if (typeof actionDef.onClick === "function") {
        await actionDef.onClick(context);
      }
    } catch (err) {
      logger.error("FXMaster | Particle effect action failed", err);
    }
  }

  _collectRegionParticleOptions(effectDef, type, form) {
    const options = {};
    for (const [key, param] of Object.entries(effectDef?.parameters ?? {})) {
      const base = `system.${type}_${key}`;
      if (param.type === "range-dual") {
        const minInput = form.querySelector(`[name="${base}_min"]`);
        const maxInput = form.querySelector(`[name="${base}_max"]`);
        if (!minInput && !maxInput) continue;
        const fallbackMin = Number(param.value?.min ?? param.min ?? 0);
        const fallbackMax = Number(param.value?.max ?? param.max ?? 1);
        const min = Number.parseFloat(minInput?.value ?? `${fallbackMin}`);
        const max = Number.parseFloat(maxInput?.value ?? `${fallbackMax}`);
        options[key] = {
          min: Number.isFinite(min) ? min : fallbackMin,
          max: Number.isFinite(max) ? max : fallbackMax,
        };
        continue;
      }

      const control = form.querySelector(`[name="${base}"]`) ?? form.querySelector(`[data-edit="${base}"]`);
      if (!control) continue;

      if (param.type === "color") {
        const apply = form.querySelector(`[name="${base}_apply"]`);
        options[key] = {
          apply: Boolean(apply?.checked),
          value: control.value ?? control.getAttribute?.("value") ?? param.value?.value ?? "#000000",
        };
        continue;
      }

      if (param.type === "multi-select" || param.type === "scene-levels") {
        const values = this._readRegionMultiSelectValues(form, base, param);
        options[key] = values;
        continue;
      }

      if (param.type === "checkbox" || param.type === "boolean") {
        options[key] = Boolean(control.checked);
        continue;
      }

      if (control instanceof HTMLInputElement && (control.type === "number" || control.type === "range")) {
        const value = Number.parseFloat(control.value);
        options[key] = Number.isFinite(value) ? value : param.value;
        continue;
      }

      if (param.type === "range" || param.type === "number") {
        const value = Number.parseFloat(control.value);
        options[key] = Number.isFinite(value) ? value : param.value;
        continue;
      }

      options[key] = control.value ?? control.getAttribute?.("value") ?? param.value;
    }
    return options;
  }

  _readRegionMultiSelectValues(form, name, parameterConfig) {
    const values = [];
    const add = (value) => {
      const normalized = String(value ?? "").trim();
      if (normalized && !values.includes(normalized)) values.push(normalized);
    };

    const controls = [
      form.querySelector(`multi-select[name="${name}"]`),
      form.querySelector(`multi-select[data-name="${name}"]`),
      form.querySelector(`select[name="${name}"][multiple]`),
    ].filter(Boolean);

    for (const control of controls) {
      const select = control instanceof HTMLSelectElement ? control : control.querySelector?.("select[multiple]");
      if (select?.multiple) {
        for (const option of Array.from(select.selectedOptions ?? [])) add(option.value);
      }

      for (const option of Array.from(control.querySelectorAll?.("option:checked") ?? [])) add(option.value);
      for (const tag of Array.from(
        control.querySelectorAll?.(
          ".tag[data-key], .tag[data-value], .tag[data-id], .tag[data-tag], .tag[data-option]",
        ) ?? [],
      )) {
        add(tag.dataset.key ?? tag.dataset.value ?? tag.dataset.id ?? tag.dataset.tag ?? tag.dataset.option);
      }

      const rawValue = control.value ?? control.getAttribute?.("value");
      if (rawValue instanceof Set) for (const value of rawValue) add(value);
      else if (Array.isArray(rawValue)) for (const value of rawValue) add(value);
      else if (typeof rawValue === "string" && rawValue.trim()) {
        try {
          const parsed = JSON.parse(rawValue);
          if (Array.isArray(parsed)) for (const value of parsed) add(value);
          else for (const value of rawValue.split(",")) add(value);
        } catch {
          for (const value of rawValue.split(",")) add(value);
        }
      }
    }

    for (const input of Array.from(
      form.querySelectorAll(`input[type="hidden"][name="${name}"], input[type="hidden"][name="${name}[]"]`) ?? [],
    )) {
      const raw = input.value;
      if (typeof raw !== "string" || !raw.trim()) continue;
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) for (const value of parsed) add(value);
        else add(raw);
      } catch {
        for (const value of raw.split(",")) add(value);
      }
    }

    if (!values.length && parameterConfig?.allowEmpty !== true) {
      const fallback = Array.isArray(parameterConfig?.value) ? parameterConfig.value : [parameterConfig?.value];
      for (const value of fallback) add(value);
    }

    return values;
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

    const sourceSystem = this.document?.system ?? this.object?.system ?? this.object?.toObject?.()?.system ?? {};

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
