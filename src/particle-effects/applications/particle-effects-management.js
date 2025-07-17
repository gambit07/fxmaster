import { FXMasterBaseFormV2 } from "../../base-form.js";
import { packageId } from "../../constants.js";
import { resetFlag } from "../../utils.js";
import { logger } from "../../logger.js";

export class ParticleEffectsManagement extends FXMasterBaseFormV2 {
  constructor(scene, options = {}) {
    super(options);
    this.scene = scene;
  }

  static DEFAULT_OPTIONS = {
    id: "particle-effects-config",
    tag: "section",
    classes: ["fxmaster", "form-v2", "particle-effects", "ui-control"],
    actions: {
      updateParam: ParticleEffectsManagement.updateParam,
    },
    window: {
      title: "FXMASTER.ParticleEffectsManagementTitle",
      resizable: true,
      minimizable: true,
    },
    position: {
      width: 1000,
      height: "auto",
    },
  };

  static PARTS = [
    {
      template: "modules/fxmaster/templates/particle-effects-management.hbs",
    },
  ];

  async _prepareContext() {
    const currentParticleEffects = canvas.scene?.getFlag(packageId, "effects") ?? {};
    const activeEffects = Object.fromEntries(Object.values(currentParticleEffects).map((ef) => [ef.type, ef.options]));
    const passiveEffects = game.settings.get(packageId, "passiveParticleConfig") ?? {};
    const { particleEffects } = CONFIG.fxmaster;

    const initialGroups = {};
    const particleEffectGroups = Object.entries(particleEffects)
      .sort(([, clsA], [, clsB]) => clsA.group.localeCompare(clsB.group) || clsA.label.localeCompare(clsB.label))
      .reduce((groups, [type, cls]) => {
        const grp = cls.group;
        const isExpanded = groups[grp]?.expanded || Object.keys(activeEffects).includes(type);
        return {
          ...groups,
          [grp]: {
            label: `FXMASTER.ParticleEffectsGroup${grp.titleCase()}`,
            expanded: isExpanded,
            effects: {
              ...(groups[grp]?.effects ?? {}),
              [type]: cls,
            },
          },
        };
      }, initialGroups);

    const desired = ["weather", "ambient", "animals"];
    const ordered = {};

    for (const key of desired) {
      if (key in particleEffectGroups) {
        ordered[key] = particleEffectGroups[key];
      }
    }
    for (const [key, val] of Object.entries(particleEffectGroups)) {
      if (!desired.includes(key)) {
        ordered[key] = val;
      }
    }

    return {
      particleEffectGroups: ordered,
      activeEffects,
      passiveEffects,
    };
  }

  async _onRender(...args) {
    super._onRender(...args);
    let windowPosition = game.user.getFlag(packageId, "dialog-position-particleeffects");
    if (windowPosition) {
      this.setPosition({ top: windowPosition.top, left: windowPosition.left, width: windowPosition.width });
    }

    const content = this.element.querySelector(".window-content");

    this.element.querySelectorAll("input[type=range]").forEach((slider) => {
      slider.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          e.stopImmediatePropagation();

          let wrapper = slider.closest(".fxmaster-particles-group-wrapper");
          if (!wrapper) wrapper = content;

          wrapper.scrollTop += e.deltaY;
        },
        { passive: false, capture: true },
      );
    });

    const win = this.element.closest("#particle-effects-config");
    if (win) {
      const onFirstHover = () => {
        win.classList.add("hovered");
        win.removeEventListener("mouseenter", onFirstHover);
      };
      win.addEventListener("mouseenter", onFirstHover);
    }
  }

  async updateEnabledState(type, enabled) {
    const effectsDB = CONFIG.fxmaster.particleEffects[type];
    if (!effectsDB) {
      logger.warn(game.i18n.format("FXMASTER.ParticleEffectTypeNotFound", { type: type }));
      return;
    }

    const scene = canvas.scene;
    if (!scene) return;
    const current = foundry.utils.duplicate(scene.getFlag(packageId, "effects") ?? {});

    if (enabled) {
      const options = FXMasterBaseFormV2.gatherFilterOptions(effectsDB, this.element);
      current[`core_${type}`] = { type, options };
    } else {
      delete current[`core_${type}`];

      for (const [id, effect] of Object.entries(current)) {
        if (id.startsWith("core_")) continue;
        if (effect.type === type) {
          delete current[id];
        }
      }
    }

    await resetFlag(scene, "effects", current);

    //--toggle-active-bg-color is the toggles active bg color, here it is for the history books since I looked for it for a while and decided to go with highlight instead
    const hasParticles = Object.keys(current).some((key) => !key.startsWith("-="));
    const btn = document.querySelector(`[data-tool="particle-effects"]`);
    if (hasParticles) {
      btn?.style?.setProperty("background-color", "var(--color-warm-2)");
      btn?.style?.setProperty("border-color", "var(--color-warm-3)");
    } else {
      btn?.style?.removeProperty("background-color");
      btn?.style?.removeProperty("border-color");
    }
  }

  static updateParam(event, input) {
    if (!input?.name) return;

    if (input.type === "range") {
      const container = input.closest(".fxmaster-input-range");
      const output = container?.querySelector(".range-value");
      if (output) output.textContent = input.value;
    }

    const type = input.closest(".fxmaster-particle-expand")?.previousElementSibling?.dataset?.type;
    if (!type) return;

    const scene = canvas.scene;
    const current = foundry.utils.duplicate(scene.getFlag(packageId, "effects") ?? {});
    const isActive = !!current[`core_${type}`];
    if (!isActive) return;

    const effectDef = CONFIG.fxmaster.particleEffects[type];
    if (!effectDef) return;

    const options = FXMasterBaseFormV2.gatherFilterOptions(effectDef, this.element);

    current[`core_${type}`].options = options;
    resetFlag(scene, "effects", current);
  }

  async close(options) {
    const passiveEffects = {};

    for (const [type, effectDB] of Object.entries(CONFIG.fxmaster.particleEffects)) {
      passiveEffects[type] = FXMasterBaseFormV2.gatherFilterOptions(effectDB, this.element);
    }

    await game.settings.set(packageId, "passiveParticleConfig", passiveEffects);
    return super.close(options);
  }

  async _onClose(...args) {
    super._onClose(...args);
    const { top, left, width } = this.position;
    game.user.setFlag(packageId, "dialog-position-particleeffects", { top, left, width });
  }
}
