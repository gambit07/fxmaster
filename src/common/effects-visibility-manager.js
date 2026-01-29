import { FXMasterBaseFormV2 } from "../base-form.js";
import { packageId } from "../constants.js";

/**
 * @typedef {"particle" | "filter"} EffectVisibilityKind
 */

/**
 * @typedef {object} EffectVisibilityItem
 * @property {string} type
 * @property {string} label
 * @property {string|null} iconImg
 * @property {string|null} iconClass
 * @property {boolean} isHidden
 * @property {boolean} isActive
 */

/**
 * @typedef {object} EffectVisibilityGroup
 * @property {string} id
 * @property {string} label
 * @property {EffectVisibilityItem[]} effects
 */

export class EffectsVisibilityManagerApp extends FXMasterBaseFormV2 {
  /**
   * @type {Map<EffectVisibilityKind, EffectsVisibilityManagerApp>}
   */
  static #instances = new Map();

  static DEFAULT_OPTIONS = {
    tag: "section",
    classes: ["fxmaster", "fxmaster-effects-visibility", "form-v2"],
    window: {
      minimizable: false,
      resizable: false,
    },
    position: { width: 520, height: getVisibilityManagerHeight(), zIndex: 103 },
    actions: {
      toggle: EffectsVisibilityManagerApp.toggle,
    },
  };

  static PARTS = [{ template: `modules/${packageId}/templates/effects-visibility-manager.hbs` }];

  /**
   * @param {object} [options={}]
   * @param {EffectVisibilityKind} [options.kind="particle"]
   * @param {Function|null} [options.onChange=null]
   */
  constructor(options = {}) {
    super(options);

    /** @type {EffectVisibilityKind} */
    this.kind = options.kind ?? "particle";

    /** @type {Function|null} */
    this.onChange = typeof options.onChange === "function" ? options.onChange : null;

    EffectsVisibilityManagerApp.#instances.set(this.kind, this);
  }

  /**
   * Open (or focus) the visibility manager for a given kind.
   * @param {object} options
   * @param {EffectVisibilityKind} options.kind
   * @param {Function|null} [options.onChange]
   * @returns {EffectsVisibilityManagerApp}
   */
  static open({ kind, onChange = null }) {
    const existing = EffectsVisibilityManagerApp.#instances.get(kind);
    if (existing) {
      if (typeof onChange === "function") existing.onChange = onChange;
      try {
        existing.setPosition({ height: getVisibilityManagerHeight() });
      } catch {}
      existing.render(true);
      return existing;
    }

    const cfg = getKindConfig(kind);

    const inst = new EffectsVisibilityManagerApp({
      id: cfg.dialogId,
      kind,
      onChange,
      window: { title: cfg.dialogTitle },
      position: { height: getVisibilityManagerHeight() },
    });

    inst.render(true);
    return inst;
  }

  /** @override */
  async _onRender(...args) {
    await super._onRender(...args);

    await new Promise((r) => requestAnimationFrame(r));

    try {
      this.setPosition({ height: getVisibilityManagerHeight() });
    } catch {}
  }

  /** @override */
  async close(options) {
    EffectsVisibilityManagerApp.#instances.delete(this.kind);
    return super.close(options);
  }

  /** @override */
  async _prepareContext() {
    const cfg = getKindConfig(this.kind);

    const hiddenRaw = game.user.getFlag(packageId, cfg.hiddenFlagKey);
    const hidden = new Set(Array.isArray(hiddenRaw) ? hiddenRaw : []);

    /** @type {Set<string>} */
    const active = new Set();

    if (this.kind === "particle") {
      const current = canvas.scene?.getFlag(packageId, "effects") ?? {};
      for (const ef of Object.values(current)) active.add(ef.type);
    } else {
      const current = canvas.scene?.getFlag(packageId, "filters") ?? {};
      for (const ef of Object.values(current)) active.add(ef.type);
    }

    /** @type {EffectVisibilityGroup[]} */
    const groups = buildGroups({ kind: this.kind, hidden, active });

    return {
      kind: this.kind,
      hintKey: "FXMASTER.Common.HiddenEffectsHint",
      groups,
    };
  }

  /**
   * Toggle the hidden state of a single effect.
   * @param {Event} event
   * @param {HTMLElement} button
   * @returns {Promise<void>}
   */
  static async toggle(event, button) {
    event?.preventDefault?.();
    event?.stopPropagation?.();

    const kind = button?.closest?.("[data-fxm-kind]")?.dataset?.fxmKind;
    const inst = kind ? EffectsVisibilityManagerApp.#instances.get(kind) : null;
    if (!inst) return;

    const cfg = getKindConfig(inst.kind);

    const type = button?.dataset?.type;
    if (!type) return;

    const wantsHide = button?.dataset?.mode === "hide";

    let hidden = game.user.getFlag(packageId, cfg.hiddenFlagKey) || [];
    hidden = Array.isArray(hidden) ? hidden.slice() : [];

    if (wantsHide) {
      if (!hidden.includes(type)) hidden.push(type);
    } else {
      hidden = hidden.filter((t) => t !== type);
    }

    await game.user.setFlag(packageId, cfg.hiddenFlagKey, hidden);

    if (typeof inst.onChange === "function") await inst.onChange();

    updateVisibilityRow(button, wantsHide);
  }
}

/**
 * Open the FXMaster effect visibility manager.
 * @param {object} options
 * @param {EffectVisibilityKind} options.kind
 * @param {Function|null} [options.onChange]
 * @returns {EffectsVisibilityManagerApp}
 */
export function openEffectsVisibilityManager({ kind, onChange = null }) {
  return EffectsVisibilityManagerApp.open({ kind, onChange });
}

/**
 * Update a single visibility row and its toggle button without re-rendering the window.
 * @param {HTMLElement} button
 * @param {boolean} isHidden
 * @returns {void}
 */
function updateVisibilityRow(button, isHidden) {
  const row = button?.closest?.(".fxmaster-visibility-row");
  if (row) {
    row.classList.toggle("fxmaster-visibility-row--inactive", isHidden);
    row.classList.toggle("fxmaster-visibility-row--active", !isHidden);
  }

  try {
    button.dataset.mode = isHidden ? "unhide" : "hide";
  } catch {}
}

/**
 * Get the number of effects currently hidden for the given manager kind.
 * @param {EffectVisibilityKind} kind
 * @returns {number}
 */
export function getHiddenEffectsCount(kind) {
  const cfg = getKindConfig(kind);
  const raw = game.user.getFlag(packageId, cfg.hiddenFlagKey);
  const list = Array.isArray(raw) ? raw : [];

  const available =
    kind === "filter"
      ? Object.keys(CONFIG.fxmaster.filterEffects ?? {})
      : Object.keys(CONFIG.fxmaster.particleEffects ?? {});

  const allowed = new Set(available);
  return new Set(list.filter((t) => allowed.has(t))).size;
}

/**
 * @param {EffectVisibilityKind} kind
 * @returns {{dialogId: string, dialogTitle: string, hiddenFlagKey: string}}
 */
function getKindConfig(kind) {
  if (kind === "filter") {
    return {
      dialogId: "fxmaster-hide-filter-effects",
      dialogTitle: "FXMASTER.Common.HideFilterEffectsTitle",
      hiddenFlagKey: "hiddenFilterEffects",
    };
  }

  return {
    dialogId: "fxmaster-hide-particle-effects",
    dialogTitle: "FXMASTER.Common.HideParticleEffectsTitle",
    hiddenFlagKey: "hiddenParticleEffects",
  };
}

/**
 * @param {object} options
 * @param {EffectVisibilityKind} options.kind
 * @param {Set<string>} options.hidden
 * @param {Set<string>} options.active
 * @returns {EffectVisibilityGroup[]}
 */
function buildGroups({ kind, hidden, active }) {
  if (kind === "filter") {
    const entries = Object.entries(CONFIG.fxmaster.filterEffects ?? {}).sort(([, a], [, b]) =>
      String(a?.label ?? "").localeCompare(String(b?.label ?? ""), undefined, { sensitivity: "base" }),
    );

    /** @type {EffectVisibilityItem[]} */
    const effects = entries.map(([type, cls]) => ({
      type,
      label: String(cls?.label ?? ""),
      iconImg: null,
      iconClass: String(cls?.icon ?? ""),
      isHidden: hidden.has(type),
      isActive: active.has(type),
    }));

    return [{ id: "filters", label: "CONTROLS.Filters", effects }];
  }

  const getSortLabel = (cls) => {
    const raw = String(cls?.label ?? "");
    try {
      return String(game.i18n?.localize?.(raw) ?? raw);
    } catch {
      return raw;
    }
  };

  const entries = Object.entries(CONFIG.fxmaster.particleEffects ?? {}).sort(([, clsA], [, clsB]) => {
    const gA = String(clsA?.group ?? "");
    const gB = String(clsB?.group ?? "");
    const gCmp = gA.localeCompare(gB, undefined, { sensitivity: "base", numeric: true });
    if (gCmp) return gCmp;

    const lA = getSortLabel(clsA);
    const lB = getSortLabel(clsB);
    return lA.localeCompare(lB, undefined, { sensitivity: "base", numeric: true });
  });

  /** @type {Map<string, EffectVisibilityGroup>} */
  const groupMap = new Map();

  for (const [type, cls] of entries) {
    const groupId = String(cls?.group ?? "misc");
    const group = groupMap.get(groupId) ?? {
      id: groupId,
      label: `FXMASTER.Particles.Groups.${groupId.titleCase()}`,
      effects: [],
    };

    group.effects.push({
      type,
      label: String(cls?.label ?? ""),
      iconImg: cls?.icon ? String(cls.icon) : null,
      iconClass: null,
      isHidden: hidden.has(type),
      isActive: active.has(type),
    });

    groupMap.set(groupId, group);
  }

  return Array.from(groupMap.values());
}

/**
 * Compute the target window height for the visibility manager.
 * @returns {number}
 */
function getVisibilityManagerHeight() {
  try {
    const h = Number(globalThis?.innerHeight ?? 0);
    if (!Number.isFinite(h) || h <= 0) return 650;
    return Math.max(320, Math.floor(h * 0.8));
  } catch {
    return 650;
  }
}
