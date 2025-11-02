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
      title: "FXMASTER.Common.ParticleEffectsManagementTitle",
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
            label: `FXMASTER.Particles.Groups.${grp.titleCase()}`,
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
    await super._onRender(...args);

    let windowPosition = game.user.getFlag(packageId, "dialog-position-particleeffects");
    if (windowPosition) {
      this.setPosition({ top: windowPosition.top, left: windowPosition.left, width: windowPosition.width });
    }

    this._autosizeInit();

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

      const output = slider.closest(".fxmaster-input-range")?.querySelector("output");
      if (output) {
        slider.addEventListener("input", (event) => {
          output.textContent = slider.value;
          ParticleEffectsManagement.updateParam.call(this, event, slider);
        });
      }
    });

    this.element.querySelectorAll(".fxmaster-input-color input[type=checkbox]").forEach((cb) => {
      cb.addEventListener("change", (e) => ParticleEffectsManagement.updateParam.call(this, e, cb));
    });
    this.element.querySelectorAll(".fxmaster-input-color input[type=color]").forEach((inp) => {
      inp.addEventListener("input", (e) => ParticleEffectsManagement.updateParam.call(this, e, inp));
      inp.addEventListener("change", (e) => ParticleEffectsManagement.updateParam.call(this, e, inp));
    });
  }

  async updateEnabledState(type, enabled) {
    const effectsDB = CONFIG.fxmaster.particleEffects[type];
    if (!effectsDB) {
      logger.warn(game.i18n.format("FXMASTER.Particles.TypeErrors.TypeNotFound", { type: type }));
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

    // --- NEW: coalesce rapid slider updates to ~12/sec ---
    this._debouncedEffectsWrite ||= foundry.utils.debounce((payload) => resetFlag(scene, "effects", payload), 1000);
    this._debouncedEffectsWrite(current);
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

    try {
      this._autosizeCleanup?.();
    } catch {}
    this._autosizeCleanup = null;
  }

  _autosizeSetMaxClamp() {
    const winEl = this.element;
    if (!winEl) return;
    const vh = Math.max(window.innerHeight, document.documentElement.clientHeight || 0);
    winEl.style.setProperty("--fxmaster-max-height", Math.round(vh * 0.9) + "px");
  }

  _autosizeRestoreAuto() {
    const winEl = this.element;
    if (!winEl) return;
    const wc = winEl.querySelector(".window-content");

    [winEl, wc].forEach((el) => {
      if (!el) return;
      el.style.height = "";
      el.style.minHeight = "";
      if (el.style.maxHeight) el.style.maxHeight = "";
    });

    winEl.classList.add("fxm-autosize");
    this._autosizeSetMaxClamp();
  }

  /** While user is drag-resizing, allow manual size (drop autosize class). */
  _autosizeWireResizeAutoToggle() {
    const winEl = this.element;
    if (!winEl) return () => {};
    const handles = winEl.querySelectorAll(".window-resizable-handle, .ui-resizable-handle");
    const onDown = () => winEl.classList.remove("fxm-autosize");
    handles.forEach((h) => h.addEventListener("pointerdown", onDown, { passive: true }));
    return () => handles.forEach((h) => h.removeEventListener("pointerdown", onDown));
  }

  /** Observe expand/collapse rows; when anything opens, restore autosize and set fallback class. */
  _autosizeObserveRows() {
    const winEl = this.element;
    if (!winEl) return () => {};
    const wrappers = Array.from(winEl.querySelectorAll(".fxmaster-particles-group-wrapper"));
    const rows = Array.from(winEl.querySelectorAll(".fxmaster-particles-row"));

    const updateWrappers = () => {
      for (const w of wrappers) {
        const anyOpen = !!w.querySelector(".fxmaster-particles-row.open");
        w.classList.toggle("fxm-column-open", anyOpen);
      }
      this._autosizeRestoreAuto();
    };

    updateWrappers();

    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "attributes" && m.attributeName === "class") {
          updateWrappers();
          break;
        }
      }
    });

    rows.forEach((r) => mo.observe(r, { attributes: true, attributeFilter: ["class"] }));
    return () => mo.disconnect();
  }

  /** One-call init that wires everything and returns a single cleanup fn. */
  _autosizeInit() {
    this._autosizeCleanup?.();
    this._autosizeRestoreAuto();

    const stopRows = this._autosizeObserveRows();
    const stopResize = this._autosizeWireResizeAutoToggle();

    const onWinResize = () => this._autosizeSetMaxClamp();
    window.addEventListener("resize", onWinResize, { passive: true });

    this._autosizeCleanup = () => {
      try {
        stopRows?.();
      } catch {}
      try {
        stopResize?.();
      } catch {}
      window.removeEventListener("resize", onWinResize);
    };
  }
}
