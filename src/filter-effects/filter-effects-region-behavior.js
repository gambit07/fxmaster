import { resetFlag } from "../utils.js";
import { packageId } from "../constants.js";

/** Region-only parameters applied to filter options */
const REGION_ONLY = {
  fadePercent: {
    label: "FXMASTER.Params.FadePercent",
    type: "range",
    max: 1.0,
    min: 0.0,
    step: 0.01,
    value: 0.0,
    skipInitialAnimation: true,
  },
};

export class FilterRegionBehaviorType extends foundry.data.regionBehaviors.RegionBehaviorType {
  static LOCALIZATION_PREFIXES = ["FXMASTER.Regions.Filter"];

  /**
   * Build the editable schema for this region behavior, including:
   * - Region event gating controls
   * - Elevation visibility controls
   * - Per-filter parameters plus region-only options (e.g., fadePercent)
   * @returns {object} Schema definition object for Foundry VTT forms.
   */
  static defineSchema() {
    const schema = {};

    schema.events = this._createEventsField({
      events: [CONST.REGION_EVENTS.TOKEN_ENTER, CONST.REGION_EVENTS.TOKEN_EXIT],
    });

    schema._elev_gateMode = new foundry.data.fields.StringField({
      required: false,
      nullable: true,
      initial: "none",
      choices: {
        none: "FXMASTER.Regions.ElevationVisibility.None",
        pov: "FXMASTER.Regions.ElevationVisibility.POV",
        targets: "FXMASTER.Regions.ElevationVisibility.Targets",
      },
      label: "FXMASTER.Regions.ElevationVisibility.Label",
      localize: true,
    });

    const tokenIdField = new foundry.data.fields.StringField({
      required: false,
      nullable: true,
    });
    schema._elev_tokenTargets = new foundry.data.fields.SetField(tokenIdField, {
      required: false,
      nullable: true,
      label: "FXMASTER.Regions.ElevationVisibility.TokenTargets",
      localize: true,
    });

    schema._elev_gmAlwaysVisible = new foundry.data.fields.BooleanField({
      required: false,
      nullable: false,
      initial: false,
      label: "FXMASTER.Regions.ElevationVisibility.AlwaysVisibleForGM",
      localize: true,
    });

    for (const [type, cls] of Object.entries(CONFIG.fxmaster.filterEffects).sort(([, a], [, b]) => {
      const labelA = game.i18n.localize(a.label);
      const labelB = game.i18n.localize(b.label);
      return labelA.localeCompare(labelB);
    })) {
      schema[`${type}_enabled`] = new foundry.data.fields.BooleanField({
        required: true,
        initial: false,
        label: `${game.i18n.localize("FXMASTER.Common.Enable")} ${game.i18n.localize(cls.label)}`,
      });

      for (const [param, cfg] of Object.entries(cls.parameters)) {
        let FieldClass = foundry.data.fields.StringField;
        const opts = {
          required: false,
          nullable: true,
          initial: cfg.value,
          label: cfg.label,
        };

        if (cfg.type === "range" || cfg.type === "number") {
          FieldClass = foundry.data.fields.NumberField;
          if (cfg.min !== undefined) opts.min = cfg.min;
          if (cfg.max !== undefined) opts.max = cfg.max;
          if (cfg.step !== undefined) opts.step = cfg.step;
        } else if (cfg.type === "color") {
          FieldClass = foundry.data.fields.ColorField;
          Object.assign(opts, { initial: cfg.value.value });
        }

        if (cfg.type === "color") {
          schema[`${type}_${param}_apply`] = new foundry.data.fields.BooleanField({
            required: false,
            initial: Boolean(cfg.value?.apply),
            label: "FXMASTER.Params.Tint",
            localize: true,
          });

          schema[`${type}_${param}`] = new foundry.data.fields.ColorField({
            required: false,
            nullable: true,
            initial: cfg.value?.value ?? "#ffffff",
            label: cfg.label,
          });
          continue;
        } else if (cfg.type === "boolean" || cfg.type === "checkbox") {
          FieldClass = foundry.data.fields.BooleanField;
          opts.nullable = false;
          opts.initial = !!cfg.value;
        } else if (cfg.type === "multi-select") {
          const elementField = new foundry.data.fields.StringField({
            required: false,
            choices: cfg.options ?? {},
            label: cfg.label,
            localize: true,
          });
          schema[`${type}_${param}`] = new foundry.data.fields.SetField(elementField, {
            required: false,
            nullable: true,
            initial: cfg.value,
            label: cfg.label,
            localize: true,
          });
          continue;
        }

        schema[`${type}_${param}`] = new FieldClass(opts);
      }

      for (const [pName, cfg] of Object.entries(REGION_ONLY)) {
        schema[`${type}_${pName}`] = new foundry.data.fields.NumberField({
          required: false,
          nullable: true,
          initial: cfg.value,
          min: cfg.min,
          max: cfg.max,
          step: cfg.step,
          label: cfg.label,
          localize: true,
        });
      }
    }

    return schema;
  }

  /**
   * Handle updates to the behavior, re-applying filters and syncing gate state.
   * @param {object} changed - Changed data.
   * @param {object} options - Update options.
   * @param {string} userId - The user performing the update.
   */
  async _onUpdate(changed, options, userId) {
    if (this.__fxmUpdating) return;
    this.__fxmUpdating = true;
    try {
      await super._onUpdate(changed, options, userId);

      await this._applyFilters();

      const mode = this._getEventModeFromSelection();
      const prevEG = this.parent.getFlag(packageId, "eventGate") || {};
      let latched = false;

      if (!this.disabled && (mode === "enter" || mode === "enterExit")) {
        if (prevEG?.mode === mode) latched = !!prevEG.latched;
      }
      if (prevEG.mode !== mode || !!prevEG.latched !== !!latched) {
        await this.parent.setFlag(packageId, "eventGate", { mode, latched });
      }
    } finally {
      this.__fxmUpdating = false;
    }
  }

  /**
   * Handle deletion of the behavior and refresh the region's filter visuals.
   * @param {object} options - Deletion options.
   * @param {string} userId - The user performing the deletion.
   */
  async _onDelete(options, userId) {
    await super._onDelete(options, userId);
    const placeable = canvas.regions.get(this.parent?.parent?.id);
    if (placeable) canvas.filtereffects?.drawRegionFilterEffects(placeable, { soft: false });
  }

  /**
   * Collect enabled filters for this region, merge base filter parameters with
   * region-only options, persist flags, and request redraw.
   */
  async _applyFilters() {
    const system = this.toObject();

    const nextFilters = Object.entries(CONFIG.fxmaster.filterEffects)
      .filter(([type]) => system[`${type}_enabled`])
      .reduce((map, [type, cls]) => {
        const opts = {};
        const paramKeys = [...Object.keys(cls.parameters), ...Object.keys(REGION_ONLY)];
        for (const param of paramKeys) {
          const cfg = cls.parameters[param];
          if (cfg?.type === "color") {
            opts[param] = {
              apply: system[`${type}_${param}_apply`],
              value: system[`${type}_${param}`],
            };
          } else if (cfg?.type === "multi-select") {
            const val = system[`${type}_${param}`];
            opts[param] = val ? Array.from(val) : [];
          } else {
            opts[param] = system[`${type}_${param}`];
          }
        }
        for (const [k, v] of Object.entries(opts)) {
          if (v === undefined || v === null) delete opts[k];
        }
        map[type] = { type, options: opts };
        return map;
      }, {});

    let changedAny = false;

    const prevFilters = this.parent.getFlag(packageId, "filters") ?? {};
    const diff1 = foundry.utils.diffObject(prevFilters, nextFilters);
    const diff2 = foundry.utils.diffObject(nextFilters, prevFilters);
    if (!foundry.utils.isEmpty(diff1) || !foundry.utils.isEmpty(diff2)) {
      if (Object.keys(nextFilters).length) await resetFlag(this.parent, "filters", nextFilters);
      else await this.parent.unsetFlag(packageId, "filters");
      changedAny = true;
    }

    const gmAlwaysVisible = !!system._elev_gmAlwaysVisible;
    const prevGM = !!this.parent.getFlag(packageId, "gmAlwaysVisible");
    if (gmAlwaysVisible !== prevGM) {
      if (gmAlwaysVisible) await this.parent.setFlag(packageId, "gmAlwaysVisible", true);
      else await this.parent.unsetFlag(packageId, "gmAlwaysVisible");
      changedAny = true;
    }

    const gateMode = system._elev_gateMode ?? "none";
    const prevGate = this.parent.getFlag(packageId, "gateMode") ?? "none";
    if (gateMode !== prevGate) {
      if (gateMode && gateMode !== "none") await this.parent.setFlag(packageId, "gateMode", gateMode);
      else await this.parent.unsetFlag(packageId, "gateMode");
      changedAny = true;
    }

    if (gateMode === "targets") {
      const targetsSet = system._elev_tokenTargets ?? new Set();
      const nextTargets = Array.from(targetsSet ?? []);
      const prevTargets = this.parent.getFlag(packageId, "tokenTargets");
      const prevArr = Array.isArray(prevTargets) ? prevTargets : prevTargets ? [prevTargets] : [];
      const eq = prevArr.length === nextTargets.length && nextTargets.every((t) => prevArr.includes(t));
      if (!eq) {
        await resetFlag(this.parent, "tokenTargets", nextTargets);
        changedAny = true;
      }
    } else {
      if (this.parent.getFlag(packageId, "tokenTargets") != null) {
        await this.parent.unsetFlag(packageId, "tokenTargets");
        changedAny = true;
      }
    }

    return changedAny;
  }

  /**
   * Derive the current event gate mode from the selected events.
   * @returns {"enterExit"|"enter"|"exitOnly"|"none"} The gate mode.
   */
  _getEventModeFromSelection() {
    const evs = this.events instanceof Set ? this.events : new Set();
    const hasEnter = evs.has(CONST.REGION_EVENTS.TOKEN_ENTER);
    const hasExit = evs.has(CONST.REGION_EVENTS.TOKEN_EXIT);
    if (hasEnter && hasExit) return "enterExit";
    if (hasEnter) return "enter";
    if (hasExit) return "exitOnly";
    return "none";
  }

  /**
   * Persist event gate mode and latched state on the region document.
   * @param {"enterExit"|"enter"|"exitOnly"|"none"} mode - Gate mode.
   * @param {boolean} latched - Whether visibility is currently latched on.
   */
  async _writeEventGate(mode, latched) {
    await this.parent.setFlag(packageId, "eventGate", { mode, latched: !!latched });
  }

  /**
   * Handle region token enter/exit events and update visibility gating.
   * @param {object} event - Foundry region event payload.
   */
  async _handleRegionEvent(event) {
    if (!this.events?.size) return;
    const evt = event.name;
    const mode = this._getEventModeFromSelection();
    if (mode === "none" || mode === "exitOnly") return;

    const prev = this.parent.getFlag(packageId, "eventGate") || { mode, latched: false };
    let latched = !!prev.latched;

    const fxGateMode = this.parent.getFlag(packageId, "gateMode");
    const rawTargets = this.parent.getFlag(packageId, "tokenTargets");
    const targetIds = new Set(Array.isArray(rawTargets) ? rawTargets : rawTargets ? [rawTargets] : []);
    const tokensInRegion = Array.from(event.region?.tokens ?? []);
    const isTargetToken = (t) => targetIds.has(t.id) || targetIds.has(t.document?.uuid) || targetIds.has(t.uuid);

    const countTargets = () => {
      if (fxGateMode !== "targets" || targetIds.size === 0) return null;
      let n = 0;
      for (const t of tokensInRegion) if (isTargetToken(t)) n++;
      return n;
    };

    if (mode === "enterExit") {
      latched =
        fxGateMode === "targets" && targetIds.size > 0 ? (countTargets() ?? 0) > 0 : (tokensInRegion.length ?? 0) > 0;
    } else if (mode === "enter") {
      if (evt !== CONST.REGION_EVENTS.TOKEN_ENTER) return;
      latched =
        fxGateMode === "targets" && targetIds.size > 0 ? (countTargets() ?? 0) > 0 : (tokensInRegion.length ?? 0) > 0;
    }

    if (prev.mode !== mode || !!prev.latched !== !!latched) {
      await this.parent.setFlag(packageId, "eventGate", { mode, latched });
    }
  }
}
