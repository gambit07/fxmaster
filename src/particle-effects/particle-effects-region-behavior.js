import { resetFlag } from "../utils.js";
import { packageId } from "../constants.js";

export class ParticleRegionBehaviorType extends foundry.data.regionBehaviors.RegionBehaviorType {
  static LOCALIZATION_PREFIXES = ["FXMASTER.Regions.Particle"];

  static defineSchema() {
    const schema = {
      events: this._createEventsField({
        events:
          game?.release?.generation >= 13
            ? [CONST.REGION_EVENTS.TOKEN_ANIMATE_IN, CONST.REGION_EVENTS.TOKEN_ANIMATE_OUT]
            : [CONST.REGION_EVENTS.TOKEN_ENTER, CONST.REGION_EVENTS.TOKEN_EXIT],
      }),
    };

    for (const [type, cls] of Object.entries(CONFIG.fxmaster.particleEffects).sort(([, a], [, b]) => {
      const labelA = game.i18n.localize(a.label);
      const labelB = game.i18n.localize(b.label);
      return labelA.localeCompare(labelB);
    })) {
      schema[`${type}_enabled`] = new foundry.data.fields.BooleanField({
        required: true,
        initial: false,
        label: `${game.i18n.localize("FXMASTER.Enable")} ${game.i18n.localize(cls.label)}`,
      });

      for (const [p, cfg] of Object.entries(cls.parameters)) {
        let FieldClass = foundry.data.fields.StringField;
        const opts = {
          required: false,
          nullable: true,
          initial: cfg.initial,
          label: cfg.label,
        };

        if (cfg.type === "range" || cfg.type === "number") {
          FieldClass = foundry.data.fields.NumberField;
          Object.assign(opts, {
            min: cfg.min ?? 0,
            max: cfg.max ?? 1,
            step: cfg.step ?? 0.01,
            initial: cfg.value,
          });
        } else if (cfg.type === "color") {
          FieldClass = foundry.data.fields.ColorField;
          Object.assign(opts, {
            initial: cfg.value.value,
          });
        }

        if (cfg.type === "color") {
          schema[`${type}_${p}_apply`] = new foundry.data.fields.BooleanField({
            required: false,
            initial: Boolean(cfg.value?.apply),
            label: `FXMASTER.Tint`,
            localize: true,
          });
          schema[`${type}_${p}`] = new foundry.data.fields.ColorField({
            required: false,
            nullable: true,
            initial: cfg.value?.value ?? "#ffffff",
            label: cfg.label,
          });
          continue;
        } else if (cfg.type === "boolean") {
          FieldClass = foundry.data.fields.BooleanField;
        } else if (cfg.type === "multi-select") {
          const elementField = new foundry.data.fields.StringField({
            required: false,
            nullable: false,
            choices: cfg.options || {},
            label: cfg.label,
            localize: true,
          });
          schema[`${type}_${p}`] = new foundry.data.fields.SetField(elementField, {
            required: false,
            nullable: true,
            initial: cfg.value,
            label: cfg.label,
            localize: true,
          });
          continue;
        }

        schema[`${type}_${p}`] = new FieldClass(opts);
      }
    }

    return schema;
  }

  async _handleRegionEvent(event) {
    const evt = event.name;
    const enterEvents =
      game?.release?.generation >= 13 ? [CONST.REGION_EVENTS.TOKEN_ANIMATE_IN] : [CONST.REGION_EVENTS.TOKEN_ENTER];
    const exitEvents =
      game?.release?.generation >= 13 ? [CONST.REGION_EVENTS.TOKEN_ANIMATE_OUT] : [CONST.REGION_EVENTS.TOKEN_EXIT];
    if (this.events?.size === 0) return;

    const sys = this.toObject();
    const enabled = Object.entries(CONFIG.fxmaster.particleEffects)
      .filter(([type]) => !!sys[`${type}_enabled`])
      .reduce((map, [type, cls]) => {
        const opts = {};
        for (const param of Object.keys(cls.parameters)) {
          const cfg = cls.parameters[param];
          if (cfg.type === "color") {
            opts[param] = {
              apply: sys[`${type}_${param}_apply`],
              value: sys[`${type}_${param}`],
            };
          } else if (cfg.type === "multi-select") {
            const raw = sys[`${type}_${param}`];
            opts[param] = raw ? Array.from(raw) : [];
          } else {
            opts[param] = sys[`${type}_${param}`];
          }
        }
        map[type] = opts;
        return map;
      }, {});

    if (enterEvents.includes(evt)) {
      if (evt === CONST.REGION_EVENTS.TOKEN_ENTER && game?.release?.generation >= 13 && !event.data?.teleport) return;
      if (event.region.tokens?.size > 1) return;
      await resetFlag(this.parent, "particleEffects", enabled);
    } else if (exitEvents.includes(evt)) {
      if (evt === CONST.REGION_EVENTS.TOKEN_EXIT && game?.release?.generation >= 13 && !event.data?.teleport) return;
      if (event.region.tokens?.size > 0) return;
      await this.parent.unsetFlag(packageId, "particleEffects");
    }

    const placeable = canvas.regions.get(this.parent.parent.id);
    if (placeable) {
      canvas.fxmaster.drawRegionParticleEffects(placeable, { soft: false });
    }
  }

  async _onUpdate(changed, options, userId) {
    super._onUpdate(changed, options, userId);

    // Bail on region disabled or addition of a enter/exit event
    if (this.events?.size > 0 || changed.disabled) {
      const layer = canvas.fxmaster;
      if (!layer?.regionEffects) return;
      const particleEffects = layer.regionEffects.get(this.parent.parent.id) || [];

      for (const particleEffect of particleEffects) {
        particleEffect.stop();
        particleEffect.destroy();
      }

      layer.regionEffects.delete(this.parent.parent.id);
      return;
    }
    if (!changed.system && changed.disabled) return;

    const sys = this.toObject();
    const enabled = Object.entries(CONFIG.fxmaster.particleEffects)
      .filter(([type]) => !!sys[`${type}_enabled`])
      .reduce((map, [type, cls]) => {
        const opts = {};
        for (const param of Object.keys(cls.parameters)) {
          const cfg = cls.parameters[param];
          if (cfg.type === "color") {
            opts[param] = {
              apply: sys[`${type}_${param}_apply`],
              value: sys[`${type}_${param}`],
            };
          } else if (cfg.type === "multi-select") {
            const raw = sys[`${type}_${param}`];
            opts[param] = raw ? Array.from(raw) : [];
          } else {
            opts[param] = sys[`${type}_${param}`];
          }
        }
        map[type] = opts;
        return map;
      }, {});

    await resetFlag(this.parent, "particleEffects", enabled);

    const placeable = canvas.regions.get(this.parent.parent.id);
    if (placeable) canvas.fxmaster.drawRegionParticleEffects(placeable);
  }

  async _onDelete(options, userId) {
    await super._onDelete(options, userId);
    const placeable = options.parent?.object;

    if (placeable) {
      canvas.fxmaster.drawRegionParticleEffects(placeable, { soft: false });
    }
  }
}
