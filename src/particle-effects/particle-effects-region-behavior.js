import { resetFlag } from "../utils.js";
import { packageId } from "../constants.js";

export class ParticleRegionBehaviorType extends foundry.data.regionBehaviors.RegionBehaviorType {
  static LOCALIZATION_PREFIXES = ["FXMASTER.Regions.Particle"];

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

    const tokenIdField = new foundry.data.fields.StringField({ required: false, nullable: true });
    schema._elev_tokenTargets = new foundry.data.fields.SetField(tokenIdField, {
      required: false,
      nullable: true,
      label: "FXMASTER.Regions.ElevationVisibility.TokenTargets",
      localize: true,
    });

    schema._elev_gmAlwaysVisible = new foundry.data.fields.BooleanField({
      required: false,
      initial: false,
      label: "FXMASTER.Regions.ElevationVisibility.AlwaysVisibleForGM",
      localize: true,
    });

    for (const [type, cls] of Object.entries(CONFIG.fxmaster.particleEffects).sort(([, a], [, b]) => {
      const labelA = game.i18n.localize(a.label);
      const labelB = game.i18n.localize(b.label);
      return labelA.localeCompare(labelB);
    })) {
      schema[`${type}_enabled`] = new foundry.data.fields.BooleanField({
        required: true,
        initial: false,
        label: `${game.i18n.localize("FXMASTER.Common.Enable")} ${game.i18n.localize(cls.label)}`,
      });

      schema[`${type}_belowTokens`] = new foundry.data.fields.BooleanField({
        required: false,
        initial: false,
        label: "FXMASTER.RenderOrder.BelowTokens",
        localize: true,
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
    }

    return schema;
  }

  /**
   * Derive the current event gate mode from the selected events.
   * @returns {"enterExit"|"enter"|"exitOnly"|"none"}
   */
  _getEventModeFromSelection() {
    const evs = this.events instanceof Set ? this.events : new Set();
    const ENTER = CONST.REGION_EVENTS.TOKEN_ENTER;
    const EXIT = CONST.REGION_EVENTS.TOKEN_EXIT;
    const hasEnter = evs.has(ENTER);
    const hasExit = evs.has(EXIT);
    if (hasEnter && hasExit) return "enterExit";
    if (hasEnter) return "enter";
    if (hasExit) return "exitOnly";
    return "none";
  }

  /**
   * Persist event gate state.
   */
  async _writeEventGate(mode, latched) {
    await this.parent.setFlag(packageId, "eventGate", { mode, latched: !!latched });
  }

  /**
   * Collect enabled particle effects + options, persist flags, and sync elevation gate flags.
   * Mirrors FilterRegionBehaviorType._applyFilters(). (No teardown here.)
   * @returns {Promise<boolean>} true if any region flag changed
   */
  async _applyParticles() {
    const system = this.toObject();

    const nextFX = Object.entries(CONFIG.fxmaster.particleEffects)
      .filter(([type]) => system[`${type}_enabled`])
      .reduce((map, [type, cls]) => {
        const opts = {};
        for (const param of Object.keys(cls.parameters)) {
          const cfg = cls.parameters[param];
          if (cfg.type === "color") {
            opts[param] = {
              apply: system[`${type}_${param}_apply`],
              value: system[`${type}_${param}`],
            };
          } else if (cfg.type === "multi-select") {
            const raw = system[`${type}_${param}`];
            opts[param] = raw ? Array.from(raw) : [];
          } else {
            opts[param] = system[`${type}_${param}`];
          }
        }
        const belowTokens = !!system[`${type}_belowTokens`];
        map[type] = { options: opts, belowTokens };
        return map;
      }, {});

    let changedAny = false;

    const prevFX = this.parent.getFlag(packageId, "particleEffects") ?? {};
    const diff1 = foundry.utils.diffObject(prevFX, nextFX);
    const diff2 = foundry.utils.diffObject(nextFX, prevFX);
    if (!foundry.utils.isEmpty(diff1) || !foundry.utils.isEmpty(diff2)) {
      if (Object.keys(nextFX).length) await resetFlag(this.parent, "particleEffects", nextFX);
      else await this.parent.unsetFlag(packageId, "particleEffects");
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
   * Region token enter/exit events → update only the event gate (no flag churn for particles).
   */
  async _handleRegionEvent(event) {
    if (!this.events?.size) return;

    const evs = this.events instanceof Set ? this.events : new Set();
    const evt = event.name;
    if (!evs.has(evt)) return;

    const ENTER = CONST.REGION_EVENTS.TOKEN_ENTER;

    const mode = this._getEventModeFromSelection();
    if (mode === "none" || mode === "exitOnly") return;

    const prev = this.parent.getFlag(packageId, "eventGate") || { mode, latched: false };

    const fxGateMode = this.parent.getFlag(packageId, "gateMode");
    const rawTargets = this.parent.getFlag(packageId, "tokenTargets");
    const targetIds = new Set(Array.isArray(rawTargets) ? rawTargets : rawTargets ? [rawTargets] : []);
    const tokensInRegion = Array.from(event.region?.tokens ?? []);

    const isTargetToken = (t) => targetIds.has(t.document.id) || targetIds.has(t.document?.uuid);

    const countTargets = () => {
      if (fxGateMode !== "targets" || targetIds.size === 0) return null;
      let n = 0;
      for (const t of tokensInRegion) if (isTargetToken(t)) n++;
      return n;
    };

    let latched = !!prev.latched;
    if (mode === "enterExit") {
      latched =
        fxGateMode === "targets" && targetIds.size > 0 ? (countTargets() ?? 0) > 0 : (tokensInRegion.length ?? 0) > 0;
    } else if (mode === "enter") {
      if (evt !== ENTER) return;
      latched =
        fxGateMode === "targets" && targetIds.size > 0 ? (countTargets() ?? 0) > 0 : (tokensInRegion.length ?? 0) > 0;
    }

    if (prev.mode !== mode || !!prev.latched !== !!latched) {
      await this.parent.setFlag(packageId, "eventGate", { mode, latched });
    }
  }

  /**
   * Handle updates to the behavior. No hard teardown; just (re)apply particle flags and sync gate.
   */
  async _onUpdate(changed, options, userId) {
    if (this.__fxmUpdating) return;
    this.__fxmUpdating = true;
    try {
      await super._onUpdate(changed, options, userId);

      await this._applyParticles();

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
   * On delete, request a rebuild of region particle effects.
   */
  async _onDelete(options, userId) {
    await super._onDelete(options, userId);
    const placeable = options.parent?.object;
    if (placeable) {
      canvas.particleeffects.drawRegionParticleEffects(placeable, { soft: false });
    }
  }
}
