import { FXMasterBaseFormV2 } from "../../base-form.js";
import { packageId } from "../../constants.js";
import { deletionUpdate } from "../../utils.js";
import { ApiEffectEditor } from "./api-effect-editor.js";
import { logger } from "../../logger.js";
import { getSceneEffectSourceInfo } from "../../common/effect-stack.js";

function safeJSONStringify(value) {
  try {
    const seen = new WeakSet();
    return JSON.stringify(
      value,
      (_k, v) => {
        if (typeof v === "function") return `[Function ${v.name || "anonymous"}]`;
        if (typeof v === "bigint") return v.toString();
        if (v && typeof v === "object") {
          if (seen.has(v)) return "[Circular]";
          seen.add(v);
        }
        return v;
      },
      2,
    );
  } catch {
    try {
      return String(value);
    } catch {
      return "";
    }
  }
}

function isCoreKey(id) {
  return typeof id === "string" && id.startsWith("core_");
}

function isLegacyOperatorKey(id) {
  return typeof id === "string" && (id.startsWith("-=") || id.startsWith("=="));
}

/**
 * ApiEffectsManagement
 * --------------------
 * Lists scene-wide particle/filter effects that were added via the API. Provides quick removal per effect, an expandable view of the stored API parameters, and an editor for a single instance.
 */
export class ApiEffectsManagement extends FXMasterBaseFormV2 {
  static FXMASTER_POSITION_FLAG = "dialog-position-apieffects";
  /** @type {ApiEffectsManagement|undefined} */
  static #instance;

  /** @returns {ApiEffectsManagement|undefined} */
  static get instance() {
    return this.#instance;
  }

  constructor(options = {}) {
    super(options);
    ApiEffectsManagement.#instance = this;
    this.scene = null;
    this._expandedUids = new Set();
  }

  static DEFAULT_OPTIONS = {
    id: "api-effects-config",
    tag: "section",
    classes: ["fxmaster", "form-v2", "api-effects", "ui-control"],
    actions: {
      toggleApiCollapse: ApiEffectsManagement.toggleApiCollapse,
      deleteApiEffect: ApiEffectsManagement.deleteApiEffect,
      editApiEffect: ApiEffectsManagement.editApiEffect,
    },
    window: {
      title: "FXMASTER.Common.ApiEffectsManagementTitle",
      resizable: true,
      minimizable: true,
    },
    position: {
      width: 780,
      height: "auto",
    },
  };

  static PARTS = [
    {
      template: "modules/fxmaster/templates/api-effects-management.hbs",
    },
  ];

  async _prepareContext() {
    const scene = this.scene ?? canvas.scene;

    const sceneParticles = scene?.getFlag?.(packageId, "effects") ?? {};
    const sceneFilters = scene?.getFlag?.(packageId, "filters") ?? {};

    /** @type {Array<object>} */
    const apiEffects = [];

    const getDisplayName = (kind, typeFallback) => {
      try {
        const db = kind === "particle" ? CONFIG?.fxmaster?.particleEffects : CONFIG?.fxmaster?.filterEffects;
        const def = typeFallback && db ? db[typeFallback] : null;
        if (!def?.label) return typeFallback;
        return game.i18n.localize(def.label);
      } catch {
        return typeFallback;
      }
    };

    const canEditType = (kind, type) => {
      try {
        const db = kind === "particle" ? CONFIG?.fxmaster?.particleEffects : CONFIG?.fxmaster?.filterEffects;
        return !!(type && db && type in db);
      } catch {
        return false;
      }
    };

    const addRow = ({ kind, id, info }) => {
      const uid = `${kind}:${id}`;
      const type = String(info?.type ?? "").trim();
      const nameFallback = String(info?.type ?? info?.name ?? "").trim() || "Unknown";
      const sourceName = typeof info?.sourceName === "string" ? info.sourceName.trim() : "";

      const kindKey = kind === "particle" ? "FXMASTER.Layers.KindParticle" : "FXMASTER.Layers.KindFilter";

      const canEdit = canEditType(kind, type);
      const displayName = canEdit ? getDisplayName(kind, type) : nameFallback;

      const sourceInfo = getSceneEffectSourceInfo(id);
      const detailsObj = { uid, kind, id, source: sourceInfo.sourceLabel, ...info };

      apiEffects.push({
        uid,
        kind,
        kindLabel: game.i18n.localize(kindKey),
        icon: kind === "particle" ? "fas fa-cloud-rain" : "fas fa-filter",
        id,
        label: displayName,
        effectType: type || nameFallback,
        sourceLabel: sourceInfo.sourceLabel,
        sourceName,
        apiSource: sourceInfo.apiSource,
        details: safeJSONStringify(detailsObj),
        expanded: this._expandedUids?.has?.(uid) ?? false,
        canEdit,
        editTooltip: canEdit
          ? game.i18n.localize("FXMASTER.Common.ApiEffectsEdit")
          : game.i18n.localize("FXMASTER.Common.ApiEffectsEditUnavailable"),
      });
    };

    for (const [id, info] of Object.entries(sceneParticles ?? {})) {
      if (isLegacyOperatorKey(id) || isCoreKey(id)) continue;
      if (!info || typeof info !== "object") continue;
      addRow({ kind: "particle", id, info });
    }

    for (const [id, info] of Object.entries(sceneFilters ?? {})) {
      if (isLegacyOperatorKey(id) || isCoreKey(id)) continue;
      if (!info || typeof info !== "object") continue;
      addRow({ kind: "filter", id, info });
    }

    apiEffects.sort((a, b) => {
      const effect = a.label.localeCompare(b.label, undefined, { sensitivity: "base", numeric: true });
      if (effect) return effect;
      const kind = a.kind.localeCompare(b.kind, undefined, { sensitivity: "base" });
      if (kind) return kind;
      const source = a.sourceLabel.localeCompare(b.sourceLabel, undefined, { sensitivity: "base", numeric: true });
      if (source) return source;
      const name = (a.sourceName ?? "").localeCompare(b.sourceName ?? "", undefined, {
        sensitivity: "base",
        numeric: true,
      });
      if (name) return name;
      return a.id.localeCompare(b.id, undefined, { sensitivity: "base", numeric: true });
    });

    return { apiEffects };
  }

  async _onRender(...args) {
    await super._onRender(...args);

    const pos = game.user.getFlag(packageId, "dialog-position-apieffects");
    if (!pos) return;

    await new Promise((r) => requestAnimationFrame(r));

    const element = this.element?.[0] ?? this.element ?? null;
    if (!element || element.isConnected === false) return;

    const next = {};
    if (Number.isFinite(pos.top)) next.top = pos.top;
    if (Number.isFinite(pos.left)) next.left = pos.left;
    if (Number.isFinite(pos.width)) next.width = pos.width;
    if (!Object.keys(next).length) return;

    try {
      const liveElement = this.element?.[0] ?? this.element ?? null;
      if (!liveElement || liveElement.isConnected === false) return;
      await this.setPosition(next);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  _storeCurrentPosition() {
    this._persistPositionFlag(this.position);
  }

  async _onClose(...args) {
    super._onClose(...args);
    this._storeCurrentPosition();
    try {
      if (ApiEffectsManagement.instance === this) ApiEffectsManagement.#instance = undefined;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  static toggleApiCollapse(event, row) {
    if (event.target?.closest?.('[data-action="deleteApiEffect"]')) return;
    if (event.target?.closest?.('[data-action="editApiEffect"]')) return;

    const uid = row?.dataset?.uid;
    if (!uid) return;

    const isOpen = row.classList.toggle("open");
    this._expandedUids ??= new Set();
    if (isOpen) this._expandedUids.add(uid);
    else this._expandedUids.delete(uid);
  }

  static async deleteApiEffect(event, button) {
    event.stopPropagation();

    const kind = button?.dataset?.kind;
    const id = button?.dataset?.id;
    const uid = button?.dataset?.uid;

    if (!kind || !id) return;
    const scene = canvas.scene;
    if (!scene) return;

    try {
      this._expandedUids?.delete?.(uid);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    try {
      if (kind === "particle") await scene.setFlag(packageId, "effects", deletionUpdate(id));
      else if (kind === "filter") await scene.setFlag(packageId, "filters", deletionUpdate(id));
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    try {
      this.render(false);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  static editApiEffect(event, button) {
    event?.stopPropagation?.();

    if (button?.disabled) return;

    const kind = button?.dataset?.kind;
    const id = button?.dataset?.id;

    if (!kind || !id) return;

    try {
      ApiEffectEditor.open({ kind, id, scene: canvas?.scene ?? null });
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }
}
