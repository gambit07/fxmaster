import { FXMasterBaseFormV2 } from "../../base-form.js";
import { packageId } from "../../constants.js";
import { resetFlag, updateSceneControlHighlights } from "../../utils.js";
import { logger } from "../../logger.js";
import { getHiddenEffectsCount, openEffectsVisibilityManager } from "../../common/effects-visibility-manager.js";
import { buildSceneEffectUid, promoteEffectStackUids } from "../../common/effect-stack.js";

export class ParticleEffectsManagement extends FXMasterBaseFormV2 {
  static FXMASTER_POSITION_FLAG = "dialog-position-particleeffects";
  /** @type {ParticleEffectsManagement|undefined} */
  static #instance;

  /** @returns {ParticleEffectsManagement|undefined} */
  static get instance() {
    return this.#instance;
  }

  constructor(scene, options = {}) {
    super(options);
    ParticleEffectsManagement.#instance = this;
    this.scene = scene;
  }

  static DEFAULT_OPTIONS = {
    id: "particle-effects-config",
    tag: "section",
    classes: ["fxmaster", "form-v2", "particle-effects", "ui-control"],
    actions: {
      updateParam: ParticleEffectsManagement.updateParam,
      openHideEffects: ParticleEffectsManagement.openHideEffects,
    },
    window: {
      title: "FXMASTER.Common.ParticleEffectsManagementTitle",
      resizable: true,
      minimizable: true,
      controls: [
        {
          icon: "fas fa-eye-slash",
          label: "FXMASTER.Common.HideEffects",
          action: "openHideEffects",
          visible: () => true,
        },
      ],
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

    const currentCoreParticleEffects = Object.entries(currentParticleEffects)
      .filter(([id, ef]) => id?.startsWith?.("core_") && ef?.type)
      .map(([, ef]) => ef);

    const activeEffects = Object.fromEntries(currentCoreParticleEffects.map((ef) => [ef.type, ef.options]));
    const activeEffectTypes = new Set(currentCoreParticleEffects.map((ef) => ef.type));

    const hidden = game.user.getFlag(packageId, "hiddenParticleEffects");
    const hiddenParticleEffects = new Set(Array.isArray(hidden) ? hidden : []);

    const passiveEffects = foundry.utils.deepClone(game.settings.get(packageId, "passiveParticleConfig") ?? {});
    for (const options of Object.values(passiveEffects)) {
      if (options && typeof options === "object") delete options.levels;
    }
    const { particleEffects } = CONFIG.fxmaster;

    const getSortLabel = (cls) => {
      const raw = String(cls?.label ?? "");
      try {
        return String(game.i18n?.localize?.(raw) ?? raw);
      } catch {
        return raw;
      }
    };

    const initialGroups = {};
    const particleEffectGroups = Object.entries(particleEffects)
      .filter(([type]) => !hiddenParticleEffects.has(type) || activeEffectTypes.has(type))
      .sort(([, clsA], [, clsB]) => {
        const gA = String(clsA?.group ?? "");
        const gB = String(clsB?.group ?? "");
        const gCmp = gA.localeCompare(gB, undefined, { sensitivity: "base", numeric: true });
        if (gCmp) return gCmp;

        const lA = getSortLabel(clsA);
        const lB = getSortLabel(clsB);
        return lA.localeCompare(lB, undefined, { sensitivity: "base", numeric: true });
      })
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

  /**
   * Open the per-user particle visibility manager.
   * @returns {void}
   */
  static openHideEffects() {
    openEffectsVisibilityManager({
      kind: "particle",
      onChange: async () => ParticleEffectsManagement.instance?.render(true),
    });
  }

  /**
   * Update the Hide Effects header control tooltip with the current hidden count.
   * @returns {void}
   */
  _updateHideEffectsTooltip() {
    const count = getHiddenEffectsCount("particle");
    const tooltip = game.i18n.format("FXMASTER.Common.HideEffectsTooltip", { count });

    const control =
      this.element?.querySelector?.('.window-header [data-action="openHideEffects"]') ??
      this.element?.querySelector?.('[data-action="openHideEffects"]') ??
      null;

    if (control) control.dataset.tooltip = tooltip;
  }

  async _onRender(...args) {
    await super._onRender(...args);

    this._updateHideEffectsTooltip();

    const pos = game.user.getFlag(packageId, "dialog-position-particleeffects");
    if (pos) {
      await new Promise((r) => requestAnimationFrame(r));

      const liveElement = this.element;
      if (!liveElement?.isConnected) return;

      const next = { top: pos.top, left: pos.left };
      if (Number.isFinite(pos.width)) next.width = pos.width;

      try {
        this.setPosition(next);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    const liveElement = this.element;
    if (!liveElement?.isConnected) return;

    this._autosizeInit();

    const content = liveElement.querySelector(".window-content") ?? liveElement;

    this._wireRangeWheelBehavior({
      getScrollWrapper: (slider) => slider.closest(".fxmaster-particles-group-wrapper") ?? content,
      onInput: (event, slider) => ParticleEffectsManagement.updateParam.call(this, event, slider),
    });
    this.wireColorInputs(liveElement, ParticleEffectsManagement.updateParam);
    this.wireMultiSelectInputs?.(liveElement, ParticleEffectsManagement.updateParam);
    this.wireSelectInputs?.(liveElement, ParticleEffectsManagement.updateParam);
    this.applyTooltipDirection(liveElement);
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

    const effectId = `core_${type}`;

    if (enabled) {
      const options = FXMasterBaseFormV2.gatherFilterOptions(effectsDB, this.element);
      current[effectId] = { type, options };
    } else {
      delete current[effectId];
    }

    await resetFlag(scene, "effects", current);

    if (enabled) {
      await promoteEffectStackUids([buildSceneEffectUid("particle", effectId)], scene);
    }

    updateSceneControlHighlights();
  }

  static async updateParam(event, input) {
    const control =
      (input?.name ? input : null) || input?.closest?.("[name]") || event?.target?.closest?.("[name]") || null;

    if (!control?.name) return;

    FXMasterBaseFormV2.updateRangeOutput(control);

    const type = control.closest(".fxmaster-particle-expand")?.previousElementSibling?.dataset?.type;
    if (!type) return;

    const scene = canvas.scene;
    if (!scene) return;
    const sceneId = scene.id ?? null;
    const current = foundry.utils.duplicate(scene.getFlag(packageId, "effects") ?? {});
    const isActive = !!current[`core_${type}`];
    if (!isActive) return;

    const effectDef = CONFIG.fxmaster.particleEffects[type];
    if (!effectDef) return;

    const isMultiSelect =
      control?.matches?.("multi-select, select[multiple]") ||
      !!control?.closest?.("multi-select") ||
      (event?.target && !!event.target.closest?.("multi-select"));

    if (isMultiSelect) {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    } else {
      await new Promise(requestAnimationFrame);
    }

    const options = FXMasterBaseFormV2.gatherFilterOptions(effectDef, this.element);

    const writeOptions = async ({ sceneId, type, options, refresh = false }) => {
      try {
        const scene = sceneId ? game.scenes?.get?.(sceneId) ?? null : null;
        if (!scene) return;
        const cur = foundry.utils.duplicate(scene.getFlag(packageId, "effects") ?? {});
        if (!cur[`core_${type}`]) return;

        const prev = cur[`core_${type}`]?.options ?? {};
        const a = foundry.utils.diffObject(prev, options);
        const b = foundry.utils.diffObject(options, prev);
        const shouldRefresh = refresh && canvas?.scene?.id === sceneId;
        if (foundry.utils.isEmpty(a) && foundry.utils.isEmpty(b)) {
          if (shouldRefresh) await canvas?.particleeffects?.drawParticleEffects?.({ soft: true });
          return;
        }

        cur[`core_${type}`].options = options;
        await resetFlag(scene, "effects", cur);
        if (shouldRefresh) await canvas?.particleeffects?.drawParticleEffects?.({ soft: true });
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    };

    if (String(control.name).endsWith("_levels")) {
      await writeOptions({ sceneId, type, options: foundry.utils.deepClone(options), refresh: true });
      return;
    }

    this._debouncedEffectsWrites ??= new Map();
    const debounceKey = `${sceneId ?? "scene"}:${type}`;
    let debouncedWrite = this._debouncedEffectsWrites.get(debounceKey);
    if (!debouncedWrite) {
      debouncedWrite = foundry.utils.debounce(writeOptions, 750);
      this._debouncedEffectsWrites.set(debounceKey, debouncedWrite);
    }

    debouncedWrite({ sceneId, type, options: foundry.utils.deepClone(options) });
  }

  async close(options) {
    const passiveEffects = {};

    for (const [type, effectDB] of Object.entries(CONFIG.fxmaster.particleEffects)) {
      passiveEffects[type] = FXMasterBaseFormV2.gatherFilterOptions(effectDB, this.element);
      if (passiveEffects[type] && typeof passiveEffects[type] === "object") delete passiveEffects[type].levels;
    }

    await game.settings.set(packageId, "passiveParticleConfig", passiveEffects);
    return super.close(options);
  }

  _storeCurrentPosition() {
    this._persistPositionFlag(this.position);
  }

  async _onClose(...args) {
    super._onClose(...args);

    this._storeCurrentPosition();

    try {
      if (ParticleEffectsManagement.instance === this) ParticleEffectsManagement.#instance = undefined;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    try {
      this._autosizeCleanup?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
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

  /**
   * Allow manual sizing while the window is actively being drag-resized.
   *
   * @returns {() => void}
   */
  _autosizeWireResizeAutoToggle() {
    const winEl = this.element;
    if (!winEl) return () => {};
    const handles = winEl.querySelectorAll(".window-resizable-handle, .ui-resizable-handle");
    let isPointerResizeActive = false;

    const restoreAuto = () => {
      if (!isPointerResizeActive) return;
      isPointerResizeActive = false;

      requestAnimationFrame(() => {
        if (!this.element?.isConnected) return;
        this._autosizeRestoreAuto();
      });
    };

    const onDown = () => {
      isPointerResizeActive = true;
      winEl.classList.remove("fxm-autosize");
    };

    handles.forEach((h) => h.addEventListener("pointerdown", onDown, { passive: true }));
    window.addEventListener("pointerup", restoreAuto, { passive: true });
    window.addEventListener("pointercancel", restoreAuto, { passive: true });

    return () => {
      handles.forEach((h) => h.removeEventListener("pointerdown", onDown));
      window.removeEventListener("pointerup", restoreAuto);
      window.removeEventListener("pointercancel", restoreAuto);
    };
  }

  /**
   * Observe expand and collapse state changes so automatic sizing can be restored after content changes.
   *
   * @returns {() => void}
   */
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

  /**
   * Initialize automatic sizing helpers and register a combined cleanup routine.
   *
   * @returns {void}
   */
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
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      try {
        stopResize?.();
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      window.removeEventListener("resize", onWinResize);
    };
  }
}
