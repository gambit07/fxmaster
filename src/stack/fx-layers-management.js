import { FXMasterBaseFormV2 } from "../base-form.js";
import { packageId } from "../constants.js";
import {
  clearStoredEffectStack,
  getOrderedEnabledEffectRows,
  getNormalizedEffectStackOrder,
  setStoredEffectStack,
} from "../common/effect-stack.js";
import { getDocumentLevelsSet, getSceneLevels, getSelectedSceneLevelIds } from "../utils.js";
import { logger } from "../logger.js";

/**
 * Apply a relative move to a stored stack uid and refresh the current window.
 *
 * @param {FxLayersManagement} application
 * @param {string|undefined} uid
 * @param {number} delta
 * @returns {Promise<void>}
 */
async function moveStoredLayer(application, uid, delta) {
  if (!uid || !delta) return;

  const order = getNormalizedEffectStackOrder(canvas.scene);
  const index = order.indexOf(uid);
  if (index < 0) return;

  const nextIndex = Math.max(0, Math.min(order.length - 1, index + delta));
  if (nextIndex === index) return;

  const [entry] = order.splice(index, 1);
  order.splice(nextIndex, 0, entry);
  await setStoredEffectStack(order, canvas.scene);

  try {
    application?.render?.(false);
  } catch (err) {
    logger.debug("FXMaster:", err);
  }
}

/**
 * Return whether the active Foundry generation supports native scene Levels.
 *
 * @returns {boolean}
 */
function isV14Plus() {
  return (game?.release?.generation ?? 0) >= 14;
}

/**
 * Normalize the scene Level collection into an array.
 *
 * @param {Scene|null|undefined} [scene=canvas?.scene ?? null]
 * @returns {Array<any>}
 */
function getSceneLevelDocuments(scene = canvas?.scene ?? null) {
  return getSceneLevels(scene);
}

/**
 * Resolve a display label for a native scene Level document.
 *
 * @param {any} level
 * @returns {string}
 */
function getSceneLevelLabel(level) {
  const candidates = [level?.name, level?.label, level?._source?.name, level?._source?.label, level?.title, level?.id];

  for (const candidate of candidates) {
    if (candidate == null) continue;
    const text = String(candidate).trim();
    if (text) return text;
  }

  return String(level?.id ?? game.i18n.localize("FXMASTER.Common.Unknown"));
}

/**
 * Normalize a row-specific Level selection into a filtered array of scene Level ids.
 *
 * Scene-scoped rows use the saved scene-effect level selector. Region-scoped rows use the owning Region document's assigned levels.
 *
 * @param {object} row
 * @param {Scene|null|undefined} scene
 * @param {Set<string>} sceneLevelIds
 * @returns {string[]|null}
 */
function getRowLevelIds(row, scene, sceneLevelIds) {
  if (!(sceneLevelIds instanceof Set) || !sceneLevelIds.size) return null;

  let levelIds = null;

  if (row?.scope === "scene") {
    const selected = getSelectedSceneLevelIds(row?.options?.levels, scene);
    levelIds = selected?.size ? Array.from(selected) : null;
  } else if (row?.scope === "region") {
    const regionDocument = scene?.regions?.get?.(row?.ownerId) ?? null;
    const selected = getDocumentLevelsSet(regionDocument);
    levelIds = selected?.size ? Array.from(selected) : null;
  }

  if (!levelIds?.length) return null;

  const filtered = levelIds
    .map((levelId) => String(levelId ?? "").trim())
    .filter((levelId) => levelId && sceneLevelIds.has(levelId));

  return filtered.length ? Array.from(new Set(filtered)) : null;
}

/**
 * Build the display metadata for a row's associated Level selection.
 *
 * @param {object} row
 * @param {Scene|null|undefined} scene
 * @param {Map<string, string>} levelLabelMap
 * @param {Set<string>} sceneLevelIds
 * @returns {{summary: string, title: string, primary: string, hasAdditional: boolean, additionalTitle: string}}
 */
function describeRowLevels(row, scene, levelLabelMap, sceneLevelIds) {
  const allLevelsLabel = game.i18n.localize("FXMASTER.Params.AllLevels");

  if (!(sceneLevelIds instanceof Set) || !sceneLevelIds.size) {
    return {
      summary: allLevelsLabel,
      title: allLevelsLabel,
      primary: allLevelsLabel,
      hasAdditional: false,
      additionalTitle: "",
    };
  }

  const selectedIds = getRowLevelIds(row, scene, sceneLevelIds);
  if (!selectedIds?.length || selectedIds.length >= sceneLevelIds.size) {
    return {
      summary: allLevelsLabel,
      title: allLevelsLabel,
      primary: allLevelsLabel,
      hasAdditional: false,
      additionalTitle: "",
    };
  }

  const labels = selectedIds.map((levelId) => levelLabelMap.get(levelId) ?? levelId);
  if (labels.length <= 1) {
    const label = labels[0] ?? allLevelsLabel;
    return {
      summary: label,
      title: label,
      primary: label,
      hasAdditional: false,
      additionalTitle: "",
    };
  }

  return {
    summary: labels[0],
    title: labels.join(", "),
    primary: labels[0],
    hasAdditional: true,
    additionalTitle: labels.slice(1).join(", "),
  };
}

/**
 * Management window for the global FXMaster compositor stack.
 */
export class FxLayersManagement extends FXMasterBaseFormV2 {
  static FXMASTER_POSITION_FLAG = "dialog-position-effectlayers";
  /** @type {FxLayersManagement|undefined} */
  static #instance;

  /**
   * Return the active layers window instance.
   *
   * @returns {FxLayersManagement|undefined}
   */
  static get instance() {
    return this.#instance;
  }

  constructor(options = {}) {
    super(options);
    FxLayersManagement.#instance = this;
  }

  static DEFAULT_OPTIONS = {
    id: "fxmaster-layers-config",
    tag: "section",
    classes: ["fxmaster", "form-v2", "fx-layers", "ui-control"],
    actions: {
      moveLayerUp: FxLayersManagement.moveLayerUp,
      moveLayerDown: FxLayersManagement.moveLayerDown,
      resetLayerOrder: FxLayersManagement.resetLayerOrder,
    },
    window: {
      title: "FXMASTER.Layers.Title",
      resizable: true,
      minimizable: true,
      controls: [
        {
          icon: "fas fa-arrow-rotate-left",
          label: "FXMASTER.Layers.ResetOrder",
          action: "resetLayerOrder",
          visible: () => true,
        },
      ],
    },
    position: {
      width: 920,
      height: "auto",
    },
  };

  static PARTS = [
    {
      template: "modules/fxmaster/templates/fx-layers-management.hbs",
    },
  ];

  /**
   * Prepare the window context.
   *
   * @returns {Promise<object>}
   */
  async _prepareContext() {
    const scene = canvas.scene;
    const sceneLevels = getSceneLevelDocuments(scene);
    const showLevelsColumn = isV14Plus() && sceneLevels.length > 1;
    const sceneLevelIds = new Set(sceneLevels.map((level) => String(level?.id ?? "").trim()).filter(Boolean));
    const levelLabelMap = new Map(
      sceneLevels
        .map((level) => [String(level?.id ?? "").trim(), getSceneLevelLabel(level)])
        .filter(([levelId]) => levelId.length),
    );

    const rows = getOrderedEnabledEffectRows(scene).map((row, index, list) => {
      const levelInfo = showLevelsColumn
        ? describeRowLevels(row, scene, levelLabelMap, sceneLevelIds)
        : {
            summary: "",
            title: "",
            primary: "",
            hasAdditional: false,
            additionalTitle: "",
          };

      return {
        ...row,
        index,
        position: index + 1,
        canMoveUp: index > 0,
        canMoveDown: index < list.length - 1,
        scopeLabel: row.scope === "region" ? game.i18n.localize("FXMASTER.Layers.ScopeRegion") : row.sourceLabel,
        levelSummary: levelInfo.summary,
        levelTitle: levelInfo.title,
        levelPrimary: levelInfo.primary,
        levelHasAdditional: levelInfo.hasAdditional,
        levelAdditionalTitle: levelInfo.additionalTitle,
      };
    });

    return {
      rows,
      hasRows: rows.length > 0,
      showLevelsColumn,
    };
  }

  /**
   * Restore the last saved dialog position.
   *
   * @param {...any} args
   * @returns {Promise<void>}
   */
  async _onRender(...args) {
    await super._onRender(...args);

    const pos = game.user.getFlag(packageId, "dialog-position-effectlayers");
    if (!pos) return;

    await new Promise((resolve) => requestAnimationFrame(resolve));

    const next = { top: pos.top, left: pos.left };
    if (Number.isFinite(pos.width)) next.width = pos.width;

    try {
      this.setPosition(next);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  _storeCurrentPosition() {
    this._persistPositionFlag(this.position);
  }

  /**
   * Persist the dialog position when the window closes.
   *
   * @param {...any} args
   * @returns {void}
   */
  async _onClose(...args) {
    super._onClose(...args);
    this._storeCurrentPosition();
    try {
      if (FxLayersManagement.instance === this) FxLayersManagement.#instance = undefined;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  /**
   * Move the selected row one position earlier in the stored stack.
   *
   * @param {PointerEvent} event
   * @param {HTMLElement} button
   * @returns {Promise<void>}
   */
  static async moveLayerUp(event, button) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    await moveStoredLayer(this, button?.dataset?.uid, -1);
  }

  /**
   * Move the selected row one position later in the stored stack.
   *
   * @param {PointerEvent} event
   * @param {HTMLElement} button
   * @returns {Promise<void>}
   */
  static async moveLayerDown(event, button) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    await moveStoredLayer(this, button?.dataset?.uid, 1);
  }

  /**
   * Reset the stored scene stack order.
   *
   * @returns {Promise<void>}
   */
  static async resetLayerOrder() {
    await clearStoredEffectStack(canvas.scene);
    try {
      this.render(false);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }
}
