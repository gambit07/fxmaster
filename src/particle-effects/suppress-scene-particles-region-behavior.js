import { resetFlag } from "../utils.js";
import { packageId } from "../constants.js";

/**
 * Region behavior that suppresses scene-level Particle Effects within its area.
 *
 */
export class SuppressSceneParticlesBehaviorType extends foundry.data.regionBehaviors.RegionBehaviorType {
  static LOCALIZATION_PREFIXES = ["FXMASTER.Regions.SuppressSceneParticles"];

  /**
   * Build the editable schema for this suppression behavior, including:
   * - Region event gating controls
   * - Elevation visibility controls (POV / Targets / GM always-visible)
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

    return schema;
  }

  /**
   * Handle updates to the suppression behavior:
   * - Sync gmAlwaysVisible / gateMode / tokenTargets flags
   * - Sync eventGate (mode + latched)
   */
  async _onUpdate(changed, options, userId) {
    if (this.__fxmUpdating) return;
    this.__fxmUpdating = true;
    try {
      await super._onUpdate(changed, options, userId);

      const system = this.toObject();
      let changedAny = false;

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

      const mode = this._getEventModeFromSelection();
      const prevEG = this.parent.getFlag(packageId, "eventGate") || {};
      let latched = false;

      if (!this.disabled && (mode === "enter" || mode === "enterExit")) {
        if (prevEG?.mode === mode) latched = !!prevEG.latched;
      }
      if (prevEG.mode !== mode || !!prevEG.latched !== !!latched) {
        await this.parent.setFlag(packageId, "eventGate", { mode, latched });
        changedAny = true;
      }

      return changedAny;
    } finally {
      this.__fxmUpdating = false;
    }
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
   * Handle region token enter/exit events and update visibility gating.
   * This updates the per-behavior eventGate flag that computeRegionGatePass uses.
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
    const isTargetToken = (t) => targetIds.has(t.document.id) || targetIds.has(t.document.uuid);

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
