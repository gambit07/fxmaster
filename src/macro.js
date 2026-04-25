import { FXMasterBaseFormV2 } from "./base-form.js";
import { logger } from "./logger.js";
import { API_EFFECT_ID_PREFIX, packageId } from "./constants.js";
import { getOrderedEnabledEffectRows } from "./common/effect-stack.js";

const defaultMacroImg = "icons/svg/windmill.svg";
const DEFAULT_MACRO_ACTION = "play";

export async function saveParticleAndFilterEffectsAsMacro() {
  const scene = canvas.scene;
  const particleEffectFlags = scene?.getFlag(packageId, "effects") ?? {};
  const filterFlags = scene?.getFlag(packageId, "filters") ?? {};
  const macroEffects = getMacroEffectEntries(scene, particleEffectFlags, filterFlags);

  const particleEffects = macroEffects.filter((effect) => effect.kind === "particle").map(stripMacroEffectKind);
  const filterEffects = macroEffects.filter((effect) => effect.kind === "filter").map(stripMacroEffectKind);

  const { name: defaultName, img } = getMacroNameAndImg(particleEffects, filterEffects);
  const macroOptions = await promptForMacroOptions(defaultName);
  if (macroOptions === null) return;

  const { name, action = DEFAULT_MACRO_ACTION, skipFading = false } = macroOptions;
  const command = macroEffects.length ? buildApiMacroCommand(macroEffects, { name, action, skipFading }) : "";

  await Macro.create({ type: "script", name, command, img });
  ui.notifications.info(game.i18n.format("FXMASTER.Macro.Saved", { name }));
}

/**
 * Return whether a scene flag update key is an operator/deletion entry rather than an actual effect id.
 *
 * @param {string} id
 * @returns {boolean}
 */
function isLegacyOperatorKey(id) {
  return typeof id === "string" && (id.startsWith("-=") || id.startsWith("=="));
}

/**
 * Return whether a stored scene flag value looks like an effect info object.
 *
 * @param {unknown} info
 * @returns {boolean}
 */
function isMacroEffectInfo(info) {
  return !!(info && typeof info === "object" && typeof info.type === "string" && info.type.trim());
}

/**
 * Clone an effect info object into the compact macro payload shape.
 *
 * @param {"particle"|"filter"} kind
 * @param {object} info
 * @returns {object}
 */
function toMacroEffectEntry(kind, info) {
  return { kind, ...cloneMacroEffectInfo(info) };
}

/**
 * Clone a macro effect payload object.
 *
 * @param {object} info
 * @returns {object}
 */
function cloneMacroEffectInfo(info) {
  return foundry?.utils?.deepClone ? foundry.utils.deepClone(info) : JSON.parse(JSON.stringify(info));
}

/**
 * Strip the macro-only kind discriminator before passing effect infos to name generation.
 *
 * @param {object} effect
 * @returns {object}
 */
function stripMacroEffectKind(effect) {
  const { kind: _kind, ...info } = effect ?? {};
  return info;
}

/**
 * Clone saved macro effect payloads and attach the assigned macro name as a source label.
 *
 * @param {Array<object>} macroEffects
 * @param {string} sourceName
 * @returns {Array<object>}
 */
function applyMacroEffectSourceName(macroEffects, sourceName) {
  const normalizedSourceName = String(sourceName ?? "").trim();
  return (macroEffects ?? []).map((effect) => {
    const clonedEffect = cloneMacroEffectInfo(effect);
    if (normalizedSourceName) clonedEffect.sourceName = normalizedSourceName;
    return clonedEffect;
  });
}

/**
 * Snapshot scene-scoped effects in the current FX stack order while keeping the replay payload API-scoped.
 *
 * @param {Scene|null|undefined} scene
 * @param {object} particleEffectFlags
 * @param {object} filterFlags
 * @returns {Array<object>}
 */
function getMacroEffectEntries(scene, particleEffectFlags, filterFlags) {
  const entries = [];
  const consumed = new Set();

  const append = (kind, id, info) => {
    if (!id || isLegacyOperatorKey(id) || !isMacroEffectInfo(info)) return;
    const key = `${kind}:${id}`;
    if (consumed.has(key)) return;
    consumed.add(key);
    entries.push(toMacroEffectEntry(kind, info));
  };

  try {
    for (const row of getOrderedEnabledEffectRows(scene)) {
      if (row?.scope !== "scene") continue;
      if (row.kind === "particle") append("particle", row.effectId, particleEffectFlags?.[row.effectId]);
      else if (row.kind === "filter") append("filter", row.effectId, filterFlags?.[row.effectId]);
    }
  } catch (err) {
    logger.debug("FXMaster:", err);
  }

  for (const [id, info] of Object.entries(particleEffectFlags ?? {})) append("particle", id, info);
  for (const [id, info] of Object.entries(filterFlags ?? {})) append("filter", id, info);

  return entries;
}

/**
 * Build a macro command that replays the saved effects through the API-effect path.
 *
 * The `effects` array is saved in the current FX stack order, top-to-bottom.
 * `play` remains the default macro action and includes a commented stop example using static ids assigned to the saved macro payload.
 * `toggle` receives a stable key so the saved macro can address the same effect group on later runs.
 *
 * @param {Array<object>} macroEffects
 * @param {{name?: string, action?: "play"|"toggle", skipFading?: boolean}} [options]
 * @returns {string}
 */
function buildApiMacroCommand(macroEffects, { name = "", action = DEFAULT_MACRO_ACTION, skipFading = false } = {}) {
  const macroAction = action === "toggle" ? "toggle" : "play";
  const preparedEffects = applyMacroEffectSourceName(macroEffects, name);
  const commandData =
    macroAction === "play" ? buildPlayMacroCommandData(preparedEffects) : { effects: preparedEffects };
  const payload = JSON.stringify(commandData.effects);
  const callOptions = ["effects: __fxmEffects"];

  if (macroAction === "toggle") callOptions.push(`toggleKey: ${JSON.stringify(`macro-${randomId()}`)}`);
  if (skipFading) callOptions.push("skipFading: true");

  if (macroAction === "play") {
    return [
      `const __fxmEffects = ${payload};`,
      `await FXMASTER.api.effects.play({ ${callOptions.join(", ")} });`,
      "",
      ...buildPlayMacroStopCommentLines(commandData.ids, skipFading),
    ].join("\n");
  }

  return [
    `const __fxmEffects = ${payload};`,
    `await FXMASTER.api.effects.${macroAction}({ ${callOptions.join(", ")} });`,
  ].join("\n");
}

/**
 * Clone the saved effect payload and assign static API-managed ids for generated play macros.
 *
 * @param {Array<object>} macroEffects
 * @returns {{effects: Array<object>, ids: {particles: string[], filters: string[]}}}
 */
function buildPlayMacroCommandData(macroEffects) {
  const effects = [];
  const ids = { particles: [], filters: [] };

  for (const effect of macroEffects ?? []) {
    const kind = effect?.kind === "filter" ? "filter" : effect?.kind === "particle" ? "particle" : null;
    if (!kind) continue;

    const id = createMacroCommandEffectId(kind);
    const clonedEffect = cloneMacroEffectInfo(effect);
    clonedEffect.id = id;
    effects.push(clonedEffect);

    if (kind === "particle") ids.particles.push(id);
    else ids.filters.push(id);
  }

  return { effects, ids };
}

/**
 * Build the commented stop example lines for a generated play macro.
 *
 * @param {{particles?: string[], filters?: string[]}} ids
 * @param {boolean} [skipFading=false]
 * @returns {string[]}
 */
function buildPlayMacroStopCommentLines(ids, skipFading = false) {
  const stopArgs = [
    ids?.particles?.length ? `particles: ${JSON.stringify(ids.particles)}` : null,
    ids?.filters?.length ? `filters: ${JSON.stringify(ids.filters)}` : null,
    skipFading ? "skipFading: true" : null,
  ]
    .filter(Boolean)
    .join(", ");

  return ["// Macro to stop this effect:", `// await FXMASTER.api.effects.stop({ ${stopArgs} });`];
}

/**
 * Return a static API-managed effect id for a generated macro command.
 *
 * @param {"particle"|"filter"} kind
 * @returns {string}
 */
function createMacroCommandEffectId(kind) {
  return `${API_EFFECT_ID_PREFIX}${randomId()}_${kind === "filter" ? "f" : "p"}`;
}

function getMacroNameAndImg(particleEffects, filterEffects) {
  const particleEffectLabelsAndIcons = particleEffects.flatMap(({ type }) => {
    const particleEffectCls = CONFIG.fxmaster.particleEffects[type];
    if (!particleEffectCls) {
      logger.warn(game.i18n.format("FXMASTER.Macro.UnknownParticleType", { type }));
      return [];
    }
    return [{ label: game.i18n.localize(particleEffectCls.label), icon: particleEffectCls.icon }];
  });
  const filterLabels = filterEffects.flatMap(({ type }) => {
    const filterEffectCls = CONFIG.fxmaster.filterEffects[type];
    if (!filterEffectCls) {
      logger.warn(game.i18n.format("FXMASTER.Macro.UnknownFilterType", { type }));
      return [];
    }
    return [{ label: game.i18n.localize(filterEffectCls.label) }];
  });

  if (filterLabels.length === 0) {
    return particleEffectLabelsAndIcons.length === 1
      ? {
          name: game.i18n.format("FXMASTER.Macro.ParticleEffectName", { label: particleEffectLabelsAndIcons[0].label }),
          img: particleEffectLabelsAndIcons[0].icon,
        }
      : { name: game.i18n.localize("FXMASTER.Macro.ParticleEffectsName"), img: defaultMacroImg };
  } else if (particleEffectLabelsAndIcons.length === 0) {
    return filterLabels.length === 1
      ? {
          name: game.i18n.format("FXMASTER.Macro.FilterEffectName", { label: filterLabels[0].label }),
          img: defaultMacroImg,
        }
      : { name: game.i18n.localize("FXMASTER.Macro.FilterEffectsName"), img: defaultMacroImg };
  } else {
    return { name: game.i18n.localize("FXMASTER.Macro.ParticleAndFilterEffectsName"), img: defaultMacroImg };
  }
}

/**
 * Return a localized macro-string value, falling back to English for newly-added keys not present in older translations.
 *
 * @param {string} leafKey
 * @param {string} fallback
 * @returns {string}
 */
function localizeMacroText(leafKey, fallback) {
  const key = `FXMASTER.Macro.${leafKey}`;
  try {
    if (game?.i18n?.has?.(key)) return game.i18n.localize(key);
  } catch (err) {
    logger.debug("FXMaster:", err);
  }
  return fallback;
}

/**
 * Prompt for the saved macro options.
 *
 * @param {string} defaultName - Generated macro name.
 * @returns {Promise<{name: string, action: "play"|"toggle", skipFading: boolean}|null>} Selected macro options or null when cancelled.
 */
function promptForMacroOptions(defaultName) {
  const fallbackName =
    String(defaultName ?? game.i18n.localize("FXMASTER.Macro.ParticleAndFilterEffectsName")).trim() ||
    game.i18n.localize("FXMASTER.Macro.ParticleAndFilterEffectsName");

  return new Promise((resolve) => {
    const app = new SaveMacroDialog({ defaultName: fallbackName, resolve });
    Promise.resolve(app.render(true)).catch((err) => {
      logger.debug("FXMaster:", err);
      resolve({ name: fallbackName, action: DEFAULT_MACRO_ACTION, skipFading: false });
    });
  });
}

class SaveMacroDialog extends FXMasterBaseFormV2 {
  constructor({ defaultName, resolve } = {}, options = {}) {
    super({ ...options, id: options.id ?? `fxmaster-save-macro-dialog-${randomId()}` });
    this.defaultName =
      String(defaultName ?? game.i18n.localize("FXMASTER.Macro.ParticleAndFilterEffectsName")).trim() ||
      game.i18n.localize("FXMASTER.Macro.ParticleAndFilterEffectsName");
    this._resolveMacroOptions = typeof resolve === "function" ? resolve : null;
    this._macroOptionsSettled = false;
  }

  static DEFAULT_OPTIONS = {
    id: "fxmaster-save-macro-dialog",
    tag: "section",
    classes: ["fxmaster", "form-v2", "fxmaster-save-macro-app", "ui-control"],
    actions: {
      ...FXMasterBaseFormV2.DEFAULT_OPTIONS.actions,
      save: SaveMacroDialog.save,
      cancel: SaveMacroDialog.cancel,
    },
    window: {
      title: "FXMASTER.Macro.NameDialogTitle",
      resizable: false,
      minimizable: false,
    },
    position: {
      width: 520,
      height: "auto",
    },
  };

  static PARTS = [
    {
      template: `modules/${packageId}/templates/save-macro-dialog.hbs`,
    },
  ];

  async _prepareContext() {
    return {
      defaultName: this.defaultName,
      labels: {
        name: localizeMacroText("NameLabel", "Macro Name"),
        hint: localizeMacroText("NameDialogHint", "Enter the name to use for the saved macro."),
        action: localizeMacroText("ActionLabel", "Macro Action"),
        actionPlay: localizeMacroText("ActionPlay", "Play"),
        actionToggle: localizeMacroText("ActionToggle", "Toggle"),
        actionHint: localizeMacroText(
          "ActionHint",
          "Play creates a new API-effect instance. Toggle turns the saved effect group on or off.",
        ),
        skipFading: localizeMacroText("SkipFadingLabel", "Skip Fading"),
        skipFadingHint: localizeMacroText(
          "SkipFadingHint",
          "Apply and remove these API effects immediately, without fade in or fade out.",
        ),
        save: localizeMacroText("Save", "Save"),
        cancel: localizeMacroText("Cancel", "Cancel"),
      },
    };
  }

  async _onRender(...args) {
    await super._onRender(...args);

    const form = this.element?.querySelector?.("form") ?? this.element;
    form?.addEventListener?.("submit", (event) => {
      event.preventDefault();
      this._submitSelectedOptions();
    });

    window.requestAnimationFrame(() => {
      const input = form?.querySelector?.('input[name="macroName"]');
      input?.focus?.();
      input?.select?.();
    });
  }

  /**
   * @returns {{name: string, action: "play"|"toggle", skipFading: boolean}}
   */
  _getSelectedOptions() {
    const element = this.element;
    const nameInput = element?.querySelector?.('input[name="macroName"]');
    const actionInput = element?.querySelector?.('input[name="macroActionToggle"]');
    const skipFadingInput = element?.querySelector?.('input[name="skipFading"]');

    return {
      name: nameInput?.value?.trim() || this.defaultName,
      action: actionInput?.checked ? "toggle" : DEFAULT_MACRO_ACTION,
      skipFading: Boolean(skipFadingInput?.checked),
    };
  }

  _settle(value) {
    if (this._macroOptionsSettled) return;
    this._macroOptionsSettled = true;
    this._resolveMacroOptions?.(value);
  }

  _submitSelectedOptions() {
    this._settle(this._getSelectedOptions());
    this._closeSafely();
  }

  _closeSafely() {
    try {
      const result = this.close();
      if (result && typeof result.catch === "function") result.catch((err) => logger.debug("FXMaster:", err));
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  static save(event, _button) {
    event?.preventDefault?.();
    this._submitSelectedOptions();
  }

  static cancel(event, _button) {
    event?.preventDefault?.();
    this._settle(null);
    this._closeSafely();
  }

  async _onClose(...args) {
    this._settle(null);
    return super._onClose?.(...args);
  }
}

/**
 * Generate a short identifier.
 *
 * @returns {string} Random id.
 */
function randomId() {
  return foundry?.utils?.randomID?.() ?? `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
}
