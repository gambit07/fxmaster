import { FXMasterBaseFormV2 } from "../../base-form.js";
import { packageId } from "../../constants.js";

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

function isDeletionKey(id) {
  return typeof id === "string" && id.startsWith("-=");
}

/**
 * ApiEffectsManagement
 * --------------------
 * Lists scene-wide particle/filter effects that were added via the API (i.e. not
 * created by the built-in managers). Provides quick removal per effect and an
 * expandable view of the stored API parameters.
 */
export class ApiEffectsManagement extends FXMasterBaseFormV2 {
  constructor(options = {}) {
    super(options);
    ApiEffectsManagement.instance = this;
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
    },
    window: {
      title: "FXMASTER.Common.ApiEffectsManagementTitle",
      resizable: true,
      minimizable: true,
    },
    position: {
      width: 650,
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

    const addRow = ({ kind, id, info }) => {
      const uid = `${kind}:${id}`;
      const name = String(info?.type ?? info?.name ?? "").trim() || "Unknown";
      const kindKey =
        kind === "particle" ? "FXMASTER.Common.ApiEffectsKindParticle" : "FXMASTER.Common.ApiEffectsKindFilter";

      const detailsObj = { uid, kind, id, ...info };

      apiEffects.push({
        uid,
        kind,
        kindLabel: game.i18n.localize(kindKey),
        icon: kind === "particle" ? "fas fa-cloud-rain" : "fas fa-filter",
        id,
        name,
        details: safeJSONStringify(detailsObj),
        expanded: this._expandedUids?.has?.(uid) ?? false,
      });
    };

    for (const [id, info] of Object.entries(sceneParticles ?? {})) {
      if (isDeletionKey(id) || isCoreKey(id)) continue;
      if (!info || typeof info !== "object") continue;
      addRow({ kind: "particle", id, info });
    }

    for (const [id, info] of Object.entries(sceneFilters ?? {})) {
      if (isDeletionKey(id) || isCoreKey(id)) continue;
      if (!info || typeof info !== "object") continue;
      addRow({ kind: "filter", id, info });
    }

    apiEffects.sort((a, b) => {
      const k = a.kind.localeCompare(b.kind, undefined, { sensitivity: "base" });
      if (k) return k;
      const n = a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
      if (n) return n;
      return a.id.localeCompare(b.id, undefined, { sensitivity: "base", numeric: true });
    });

    return { apiEffects };
  }

  async _onRender(...args) {
    await super._onRender(...args);

    const pos = game.user.getFlag(packageId, "dialog-position-apieffects");
    if (!pos) return;

    await new Promise((r) => requestAnimationFrame(r));

    const next = { top: pos.top, left: pos.left };
    if (Number.isFinite(pos.width)) next.width = pos.width;

    try {
      this.setPosition(next);
    } catch {}
  }

  async _onClose(...args) {
    super._onClose(...args);
    const { top, left, width } = this.position;
    game.user.setFlag(packageId, "dialog-position-apieffects", { top, left, width });
  }

  static toggleApiCollapse(event, row) {
    if (event.target?.closest?.('[data-action="deleteApiEffect"]')) return;

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
    } catch {}

    try {
      if (kind === "particle") await scene.setFlag(packageId, "effects", { [`-=${id}`]: null });
      else if (kind === "filter") await scene.setFlag(packageId, "filters", { [`-=${id}`]: null });
    } catch {}

    try {
      this.render(false);
    } catch {}
  }
}
