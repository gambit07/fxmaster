import { FXMasterBaseFormV2 } from "../../base-form.js";
import { packageId } from "../../constants.js";
import { ensureSingleSceneLevelSelection, resetFlag } from "../../utils.js";
import { logger } from "../../logger.js";
import { FilterEffectsSceneManager } from "../../filter-effects/filter-effects-scene-manager.js";

function sanitizeIdPart(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function getUpdatedParamKeys(effectDef, controlName) {
  const label = String(effectDef?.label ?? "");
  if (!label || !controlName) return null;

  const name = String(controlName);
  const keys = [];

  for (const key of Object.keys(effectDef?.parameters ?? {})) {
    const base = `${label}_${key}`;
    if (name === base || name === `${base}_apply` || name === `${base}_min` || name === `${base}_max`) keys.push(key);
  }

  return keys.length ? keys : null;
}

function pickOptions(options, keys) {
  if (!Array.isArray(keys) || !keys.length) return options;

  const picked = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(options, key)) picked[key] = options[key];
  }

  return Object.keys(picked).length ? picked : options;
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
  /**
   * Return the user flag key for the current API effect editor kind.
   *
   * @returns {string}
   */
  _getPositionFlagKey() {
    return `dialog-position-apieffect-${this.kind ?? "unknown"}`;
  }

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

  _storeCurrentPosition() {
    this._persistPositionFlag(this.position);
  }

  async _onRender(...args) {
    await super._onRender(...args);

    const pos = game.user.getFlag(packageId, this._getPositionFlagKey());
    if (pos) {
      await new Promise((r) => requestAnimationFrame(r));

      const element = this.element?.[0] ?? this.element ?? null;
      if (!element || element.isConnected === false) return;

      const next = {};
      if (Number.isFinite(pos.top)) next.top = pos.top;
      if (Number.isFinite(pos.left)) next.left = pos.left;
      if (Number.isFinite(pos.width)) next.width = pos.width;

      try {
        const liveElement = this.element?.[0] ?? this.element ?? null;
        if (!liveElement || liveElement.isConnected === false) return;
        if (Object.keys(next).length) await this.setPosition(next);
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
    this.wireSelectInputs?.(this.element, ApiEffectEditor.updateParam);
  }

  async _onClose(...args) {
    super._onClose(...args);

    this._storeCurrentPosition();

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
      const current = foundry.utils.duplicate(scene.getFlag(packageId, flagKey) ?? {});
      delete current[id];
      await resetFlag(scene, flagKey, current);
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
    const sceneId = scene.id ?? null;

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
    const changedKeys = getUpdatedParamKeys(effectDef, control.name);
    const changedOptions = pickOptions(gathered, changedKeys);
    const prevOptions = info?.options && typeof info.options === "object" ? info.options : {};

    const options = ensureSingleSceneLevelSelection(
      foundry.utils.mergeObject(foundry.utils.deepClone(prevOptions), changedOptions, {
        inplace: false,
        insertKeys: true,
        insertValues: true,
        overwrite: true,
      }),
      scene,
    );

    const writeOptions = async ({ sceneId, effectId, options, refresh = false }) => {
      try {
        const scene = sceneId ? game.scenes?.get?.(sceneId) ?? null : this.scene ?? canvas?.scene ?? null;
        if (!scene) return;

        const flagKey = this.kind === "particle" ? "effects" : "filters";
        const infos = scene.getFlag(packageId, flagKey) ?? {};
        const cur = infos?.[effectId];
        if (!cur) return;

        const prev = cur?.options && typeof cur.options === "object" ? cur.options : {};
        const a = foundry.utils.diffObject(prev, options);
        const b = foundry.utils.diffObject(options, prev);
        const shouldRefresh = refresh && canvas?.scene?.id === scene.id;
        if (foundry.utils.isEmpty(a) && foundry.utils.isEmpty(b)) {
          if (shouldRefresh && this.kind === "particle")
            await canvas?.particleeffects?.drawParticleEffects?.({ soft: true });
          if (shouldRefresh && this.kind === "filter")
            await FilterEffectsSceneManager.instance.update({ skipFading: true });
          return;
        }

        const next = { ...cur, options };
        const updated = foundry.utils.duplicate(infos);
        updated[effectId] = next;
        await resetFlag(scene, flagKey, updated);
        if (shouldRefresh && this.kind === "particle")
          await canvas?.particleeffects?.drawParticleEffects?.({ soft: true });
        if (shouldRefresh && this.kind === "filter")
          await FilterEffectsSceneManager.instance.update({ skipFading: true });
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    };

    if (String(control.name).endsWith("_levels")) {
      await writeOptions({ sceneId, effectId, options: foundry.utils.deepClone(options), refresh: true });
      return;
    }

    this._debouncedApiEffectWrite ||= foundry.utils.debounce(writeOptions, 500);

    this._debouncedApiEffectWrite({ sceneId, effectId, options: foundry.utils.deepClone(options) });
  }
}
