import { FXMasterBaseFormV2 } from "../../base-form.js";
import { packageId } from "../../constants.js";
import { deletionUpdate, replacementUpdate } from "../../utils.js";
import { logger } from "../../logger.js";

function sanitizeIdPart(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function getKindLabel(kind) {
  const key = kind === "particle" ? "FXMASTER.Common.ApiEffectsKindParticle" : "FXMASTER.Common.ApiEffectsKindFilter";
  try {
    return game.i18n.localize(key);
  } catch {
    return kind;
  }
}

/**
 * ApiEffectEditor
 * --------------
 * Edits a single API-created scene-wide particle or filter effect instance.
 *
 * - Renders only the specific instance.
 * - Parameter changes write back only to that instance's flag key.
 */
export class ApiEffectEditor extends FXMasterBaseFormV2 {
  /** @type {Map<string, ApiEffectEditor>} */
  static instances = new Map();

  /**
   * Open (or focus) an editor for a specific API effect instance.
   * @param {{kind:"particle"|"filter", id:string, scene?:any}} args
   */
  static open({ kind, id, scene = null } = {}) {
    const uid = `${kind}:${id}`;
    const existing = ApiEffectEditor.instances.get(uid);
    if (existing) {
      try {
        existing.render(true);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      return existing;
    }

    const inst = new ApiEffectEditor({ kind, id, scene });
    ApiEffectEditor.instances.set(uid, inst);
    try {
      inst.render(true);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    return inst;
  }

  /**
   * @param {{kind:"particle"|"filter", id:string, scene?:any}} config
   * @param {object} [options]
   */
  constructor({ kind, id, scene = null } = {}, options = {}) {
    const safeKind = sanitizeIdPart(kind || "api");
    const safeKey = sanitizeIdPart(id || "effect");
    const appId = `api-effect-editor-${safeKind}-${safeKey}`.slice(0, 120);

    super({ ...options, id: options.id ?? appId });

    this.kind = kind;
    this.effectId = id;
    this.scene = scene;

    this._effectType = null;
    this._effectDef = null;
  }

  static DEFAULT_OPTIONS = {
    id: "api-effect-editor",
    tag: "section",
    classes: ["fxmaster", "form-v2", "api-effect-editor", "ui-control"],
    actions: {
      updateParam: ApiEffectEditor.updateParam,
      deleteApiEffect: ApiEffectEditor.deleteApiEffect,
    },
    window: {
      title: "FXMASTER.Common.ApiEffectEditorTitle",
      resizable: true,
      minimizable: true,
    },
    position: {
      width: 460,
      height: "auto",
    },
  };

  static PARTS = [
    {
      template: "modules/fxmaster/templates/api-effect-editor.hbs",
    },
  ];

  /**
   * @returns {Promise<object>}
   */
  async _prepareContext() {
    const scene = this.scene ?? canvas?.scene ?? null;
    const kind = this.kind;
    const id = this.effectId;

    const isParticle = kind === "particle";
    const flagKey = isParticle ? "effects" : "filters";

    const infos = scene?.getFlag?.(packageId, flagKey) ?? {};
    const info = infos?.[id] ?? null;

    if (!scene || !kind || !id || !info || typeof info !== "object") {
      this._effectType = null;
      this._effectDef = null;
      return {
        missing: true,
        kind,
        id,
        kindLabel: getKindLabel(kind),
        isParticle,
      };
    }

    const type = String(info?.type ?? "").trim();

    const db = isParticle ? CONFIG?.fxmaster?.particleEffects : CONFIG?.fxmaster?.filterEffects;
    const effect = (type && db && db[type]) || null;

    const label = (() => {
      if (!effect) return type || id;
      try {
        return game.i18n.localize(effect.label);
      } catch {
        return effect.label || type || id;
      }
    })();

    const iconImg = isParticle ? effect?.icon ?? null : null;
    const iconClass = !isParticle ? effect?.icon ?? "fas fa-filter" : null;

    const options = info?.options && typeof info.options === "object" ? info.options : {};

    this._effectType = type;
    this._effectDef = effect;

    return {
      missing: false,
      isParticle,
      kind,
      kindLabel: getKindLabel(kind),
      id,
      type,
      label,
      iconImg,
      iconClass,
      effect,
      options,
    };
  }

  async _onRender(...args) {
    await super._onRender(...args);

    const posKey = `dialog-position-apieffect-${this.kind ?? "unknown"}`;
    const pos = game.user.getFlag(packageId, posKey);
    if (pos) {
      await new Promise((r) => requestAnimationFrame(r));
      const next = { top: pos.top, left: pos.left };
      if (Number.isFinite(pos.width)) next.width = pos.width;
      try {
        this.setPosition(next);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    const content = this.element?.querySelector?.(".window-content") ?? this.element;

    this._wireRangeWheelBehavior({
      getScrollWrapper: () => content,
      onInput: (event, slider) => ApiEffectEditor.updateParam.call(this, event, slider),
    });

    this.wireColorInputs(this.element, ApiEffectEditor.updateParam);
    this.wireMultiSelectInputs?.(this.element, ApiEffectEditor.updateParam);
  }

  async _onClose(...args) {
    super._onClose(...args);

    const posKey = `dialog-position-apieffect-${this.kind ?? "unknown"}`;
    const { top, left, width } = this.position;
    try {
      game.user.setFlag(packageId, posKey, { top, left, width });
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    try {
      ApiEffectEditor.instances.delete(`${this.kind}:${this.effectId}`);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  static async deleteApiEffect(event, _button) {
    event?.stopPropagation?.();

    const scene = this.scene ?? canvas?.scene;
    if (!scene) return;

    const kind = this.kind;
    const id = this.effectId;
    if (!kind || !id) return;

    const flagKey = kind === "particle" ? "effects" : "filters";

    try {
      await scene.setFlag(packageId, flagKey, deletionUpdate(id));
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    try {
      const mod = await import("./api-effects-management.js");
      mod?.ApiEffectsManagement?.instance?.render?.(false);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    try {
      this.close();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  static async updateParam(event, input) {
    const control =
      (input?.name ? input : null) || input?.closest?.("[name]") || event?.target?.closest?.("[name]") || null;

    if (!control?.name) return;
    FXMasterBaseFormV2.updateRangeOutput(control);

    const scene = this.scene ?? canvas?.scene;
    if (!scene) return;

    const kind = this.kind;
    const effectId = this.effectId;
    if (!kind || !effectId) return;

    const flagKey = kind === "particle" ? "effects" : "filters";
    const infos = scene.getFlag(packageId, flagKey) ?? {};
    const info = infos?.[effectId] ?? null;
    if (!info || typeof info !== "object") return;

    const type = String(info?.type ?? this._effectType ?? "").trim();
    if (!type) return;

    const db = kind === "particle" ? CONFIG?.fxmaster?.particleEffects : CONFIG?.fxmaster?.filterEffects;
    const effectDef = (db && db[type]) || this._effectDef || null;
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

    const gathered = FXMasterBaseFormV2.gatherFilterOptions(effectDef, this.element);
    const prevOptions = info?.options && typeof info.options === "object" ? info.options : {};

    const options = foundry.utils.mergeObject(foundry.utils.deepClone(prevOptions), gathered, {
      inplace: false,
      insertKeys: true,
      insertValues: true,
      overwrite: true,
    });

    const d1 = foundry.utils.diffObject(prevOptions, options);
    const d2 = foundry.utils.diffObject(options, prevOptions);
    if (foundry.utils.isEmpty(d1) && foundry.utils.isEmpty(d2)) return;

    this._debouncedApiEffectWrite ||= foundry.utils.debounce(async ({ effectId, options }) => {
      try {
        const scene = this.scene ?? canvas?.scene;
        if (!scene) return;

        const flagKey = this.kind === "particle" ? "effects" : "filters";
        const infos = scene.getFlag(packageId, flagKey) ?? {};
        const cur = infos?.[effectId];
        if (!cur) return;

        const prev = cur?.options && typeof cur.options === "object" ? cur.options : {};
        const a = foundry.utils.diffObject(prev, options);
        const b = foundry.utils.diffObject(options, prev);
        if (foundry.utils.isEmpty(a) && foundry.utils.isEmpty(b)) return;

        const next = { ...cur, options };
        await scene.setFlag(packageId, flagKey, replacementUpdate(effectId, next));
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }, 500);

    this._debouncedApiEffectWrite({ effectId, options: foundry.utils.deepClone(options) });
  }
}
