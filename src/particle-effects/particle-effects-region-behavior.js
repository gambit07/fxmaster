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

  async _writeEventGate(mode, latched) {
    await this.parent.setFlag(packageId, "eventGate", { mode, latched: !!latched });
  }

  async _handleRegionEvent(event) {
    if (this.events?.size === 0) return;

    const evt = event.name;
    const ENTER = CONST.REGION_EVENTS.TOKEN_ENTER;
    const EXIT = CONST.REGION_EVENTS.TOKEN_EXIT;

    const sys = this.toObject();

    const nextFX = Object.entries(CONFIG.fxmaster.particleEffects)
      .filter(([type]) => !!sys[`${type}_enabled`])
      .reduce((map, [type, cls]) => {
        const opts = {};
        for (const param of Object.keys(cls.parameters)) {
          const cfg = cls.parameters[param];
          if (cfg.type === "color") {
            opts[param] = { apply: sys[`${type}_${param}_apply`], value: sys[`${type}_${param}`] };
          } else if (cfg.type === "multi-select") {
            const raw = sys[`${type}_${param}`];
            opts[param] = raw ? Array.from(raw) : [];
          } else {
            opts[param] = sys[`${type}_${param}`];
          }
        }
        const belowTokens = !!sys[`${type}_belowTokens`];
        map[type] = { options: opts, belowTokens };
        return map;
      }, {});

    if (evt === ENTER) {
      if ((event.region.tokens?.size ?? 0) <= 1) {
        const prevFX = this.parent.getFlag(packageId, "particleEffects") ?? {};
        const diff1 = foundry.utils.diffObject(prevFX, nextFX);
        const diff2 = foundry.utils.diffObject(nextFX, prevFX);
        if (!foundry.utils.isEmpty(diff1) || !foundry.utils.isEmpty(diff2)) {
          await resetFlag(this.parent, "particleEffects", nextFX);
        }
      }
    } else if (evt === EXIT) {
      if ((event.region.tokens?.size ?? 0) === 0) {
        if (this.parent.getFlag(packageId, "particleEffects") != null) {
          await this.parent.unsetFlag(packageId, "particleEffects");
        }
      }
    }

    const prev = this.parent.getFlag(packageId, "eventGate") || {};
    const mode = this._getEventModeFromSelection();
    let latched = false;

    if (mode !== "none") {
      if (mode === "enter") {
        latched = evt === ENTER && (event.region.tokens?.size ?? 0) > 0;
      } else if (mode === "enterExit") {
        latched = (event.region.tokens?.size ?? 0) > 0;
      }
    }

    if (prev.mode !== mode || !!prev.latched !== !!latched) {
      await this.parent.setFlag(packageId, "eventGate", { mode, latched });
    }
  }

  async _onUpdate(changed, options, userId) {
    if (this.__fxmUpdating) return;
    this.__fxmUpdating = true;
    try {
      await super._onUpdate(changed, options, userId);

      if (this.events?.size > 0 || changed.disabled) {
        const layer = canvas.particleeffects;
        if (layer?.regionEffects) {
          const regionId = this.parent.parent.id;
          const entries = layer.regionEffects.get(regionId) || [];
          for (const entry of entries) {
            const fx = entry?.fx ?? entry;
            try {
              fx?.stop?.();
            } catch {}
            try {
              fx?.destroy?.();
            } catch {}
          }
          layer.regionEffects.delete(regionId);
        }
        const hadFX = !!this.parent.getFlag(packageId, "particleEffects");
        if (hadFX) await this.parent.unsetFlag(packageId, "particleEffects");
        return;
      }

      const sys = this.toObject();

      const nextFX = Object.entries(CONFIG.fxmaster.particleEffects)
        .filter(([type]) => !!sys[`${type}_enabled`])
        .reduce((map, [type, cls]) => {
          const opts = {};
          for (const param of Object.keys(cls.parameters)) {
            const cfg = cls.parameters[param];
            if (cfg.type === "color") {
              opts[param] = { apply: sys[`${type}_${param}_apply`], value: sys[`${type}_${param}`] };
            } else if (cfg.type === "multi-select") {
              const raw = sys[`${type}_${param}`];
              opts[param] = raw ? Array.from(raw) : [];
            } else {
              opts[param] = sys[`${type}_${param}`];
            }
          }
          const belowTokens = !!sys[`${type}_belowTokens`];
          map[type] = { options: opts, belowTokens };
          return map;
        }, {});

      const prevFX = this.parent.getFlag(packageId, "particleEffects") ?? {};
      const diff1 = foundry.utils.diffObject(prevFX, nextFX);
      const diff2 = foundry.utils.diffObject(nextFX, prevFX);
      if (!foundry.utils.isEmpty(diff1) || !foundry.utils.isEmpty(diff2)) {
        await resetFlag(this.parent, "particleEffects", nextFX);
      }

      const gmAlwaysVisible = !!sys._elev_gmAlwaysVisible;
      const prevGM = !!this.parent.getFlag(packageId, "gmAlwaysVisible");
      if (gmAlwaysVisible !== prevGM) {
        if (gmAlwaysVisible) await this.parent.setFlag(packageId, "gmAlwaysVisible", true);
        else await this.parent.unsetFlag(packageId, "gmAlwaysVisible");
      }

      const gateMode = sys._elev_gateMode ?? "none";
      const prevGate = this.parent.getFlag(packageId, "gateMode") ?? "none";
      if (gateMode !== prevGate) {
        if (gateMode && gateMode !== "none") await this.parent.setFlag(packageId, "gateMode", gateMode);
        else await this.parent.unsetFlag(packageId, "gateMode");
      }

      if (gateMode === "targets") {
        const targetsSet = sys._elev_tokenTargets ?? new Set();
        const nextTargets = Array.from(targetsSet ?? []);
        const prevTargets = this.parent.getFlag(packageId, "tokenTargets");
        const prevArr = Array.isArray(prevTargets) ? prevTargets : prevTargets ? [prevTargets] : [];
        const eq = prevArr.length === nextTargets.length && nextTargets.every((t) => prevArr.includes(t));
        if (!eq) {
          await resetFlag(this.parent, "tokenTargets", nextTargets);
        }
      } else {
        if (this.parent.getFlag(packageId, "tokenTargets") != null) {
          await this.parent.unsetFlag(packageId, "tokenTargets");
        }
      }

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

  async _onDelete(options, userId) {
    await super._onDelete(options, userId);
    const placeable = options.parent?.object;
    if (placeable) {
      canvas.particleeffects.drawRegionParticleEffects(placeable, { soft: false });
    }
  }
}
