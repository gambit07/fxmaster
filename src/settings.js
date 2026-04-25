import { packageId } from "./constants.js";
import { logger } from "./logger.js";

const LEGACY_CLEANUP_VERSION = 1;

const LEGACY_WORLD_SETTING_KEYS = Object.freeze([
  "customEffectsDirectory",
  "refreshDb",
  "specialEffects",
  "customSpecialEffects",
  "dbSpecialEffects",
  "permission-create",
]);

const LEGACY_USER_FLAG_KEYS = Object.freeze([
  "dialog-position-specialeffects",
  "dialog-position-specialeffectsconfig",
  "specialEffectsNoticeCollapsed",
]);

/**
 * Register module settings.
 */
export function registerSettings() {
  game.settings.register(packageId, "enable", {
    name: "FXMASTER.Common.EnableEffects",
    default: true,
    scope: "client",
    type: Boolean,
    config: true,
    requiresReload: true,
  });

  game.settings.register(packageId, "enableTooltips", {
    name: "FXMASTER.Common.EnableTooltips",
    hint: "FXMASTER.Common.EnableTooltipsHint",
    default: true,
    scope: "world",
    type: Boolean,
    config: true,
    requiresReload: false,
  });

  game.settings.register(packageId, "tooltipDirection", {
    name: "FXMASTER.Settings.TooltipDirection",
    hint: "FXMASTER.Settings.TooltipDirectionHint",
    default: "UP",
    scope: "client",
    type: String,
    config: true,
    choices: {
      UP: game.i18n.localize("FXMASTER.Settings.TooltipDirectionChoices.Top"),
      DOWN: game.i18n.localize("FXMASTER.Settings.TooltipDirectionChoices.Bottom"),
      LEFT: game.i18n.localize("FXMASTER.Settings.TooltipDirectionChoices.Left"),
      RIGHT: game.i18n.localize("FXMASTER.Settings.TooltipDirectionChoices.Right"),
    },
    requiresReload: false,
  });

  game.settings.register(packageId, "resetPassives", {
    name: "FXMASTER.Common.ResetPassiveParameters",
    hint: "FXMASTER.Common.ResetPassiveParametersHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: async (value) => {
      if (!value) return;

      game.settings.set(packageId, "passiveParticleConfig", {});
      game.settings.set(packageId, "passiveFilterConfig", {});
      await game.settings.set(packageId, "resetPassives", false);
      ui.notifications.info(game.i18n.localize("FXMASTER.Common.ResetPassiveSuccess"));
    },
  });

  game.settings.register(packageId, "enableLogger", {
    name: "FXMASTER.Settings.EnableLogger",
    hint: "FXMASTER.Settings.EnableLoggerHint",
    default: false,
    scope: "world",
    type: Boolean,
    config: true,
    requiresReload: false,
  });

  game.settings.register(packageId, "passiveFilterConfig", {
    name: "passiveFilterConfig",
    default: [],
    scope: "world",
    type: Object,
    config: false,
  });

  game.settings.register(packageId, "passiveParticleConfig", {
    name: "passiveParticleConfig",
    default: [],
    scope: "world",
    type: Object,
    config: false,
  });

  game.settings.register(packageId, "disableAll", {
    name: "FXMASTER.Common.DisableAll",
    hint: "FXMASTER.Common.DisableAllHint",
    default: false,
    scope: "world",
    type: Boolean,
    config: true,
  });

  game.settings.register(packageId, "releaseMessage", {
    default: "",
    scope: "world",
    type: String,
    config: false,
  });

  game.settings.register(packageId, "legacyCleanupVersion", {
    default: 0,
    scope: "world",
    type: Number,
    config: false,
  });

  game.settings.registerMenu(packageId, "patreonSupport", {
    name: "Patreon Support",
    label: "Gambit's Lounge",
    hint: "FXMASTER.Settings.PatreonSupportHint",
    icon: "fas fa-card-spade",
    scope: "world",
    config: true,
    type: PatreonSupportMenu,
    restricted: true,
  });
}

/**
 * Determine whether FXMaster effects are globally enabled.
 *
 * @returns {boolean} Whether the module is enabled for the current world and client.
 */
export function isEnabled() {
  return game.settings.get(packageId, "enable") && !game.settings.get(packageId, "disableAll");
}

/**
 * Delete an unregistered legacy world setting document when it exists.
 *
 * @param {string} key - The bare setting key without the module namespace.
 * @returns {Promise<boolean>} Whether a stored setting document was removed.
 */
async function deleteLegacyWorldSetting(key) {
  const fullKey = `${packageId}.${key}`;
  const worldStorage = game.settings.storage?.get?.("world") ?? null;
  const stored = worldStorage?.get?.(fullKey) ?? worldStorage?.find?.((entry) => entry?.key === fullKey) ?? null;
  if (!stored) return false;

  if (typeof stored.delete === "function") {
    await stored.delete();
    return true;
  }

  const documentId = stored.id ?? stored._id ?? null;
  const SettingDocument = CONFIG?.Setting?.documentClass ?? globalThis.Setting;
  if (documentId && typeof SettingDocument?.deleteDocuments === "function") {
    await SettingDocument.deleteDocuments([documentId]);
    return true;
  }

  return false;
}

/**
 * Remove obsolete user flags left by the retired animation-effects management UI.
 *
 * @returns {Promise<number>} The number of user documents updated.
 */
async function deleteLegacyAnimationUserFlags() {
  const updates = [];
  for (const user of game.users ?? []) {
    const data = {};
    for (const key of LEGACY_USER_FLAG_KEYS) {
      if (foundry.utils.hasProperty(user, `flags.${packageId}.${key}`)) {
        data[`flags.${packageId}.-=${key}`] = null;
      }
    }
    if (Object.keys(data).length) updates.push(user.update(data));
  }

  if (!updates.length) return 0;
  await Promise.allSettled(updates);
  return updates.length;
}

/**
 * Delete legacy world data from the removed animation-effects feature set.
 *
 * The cleanup is performed once per world by a GM and removes unregistered world settings plus stale user flags that were only used by the retired management interface.
 *
 * @returns {Promise<void>}
 */
export async function cleanupLegacyAnimationData() {
  if (!game.user?.isGM) return;

  const completedVersion = Number(game.settings.get(packageId, "legacyCleanupVersion") ?? 0);
  if (completedVersion >= LEGACY_CLEANUP_VERSION) return;

  let removedSettings = 0;
  for (const key of LEGACY_WORLD_SETTING_KEYS) {
    try {
      if (await deleteLegacyWorldSetting(key)) removedSettings += 1;
    } catch (error) {
      logger.warn(`Failed to delete legacy setting ${packageId}.${key}`, error);
    }
  }

  let updatedUsers = 0;
  try {
    updatedUsers = await deleteLegacyAnimationUserFlags();
  } catch (error) {
    logger.warn("Failed to delete legacy animation user flags", error);
  }

  await game.settings.set(packageId, "legacyCleanupVersion", LEGACY_CLEANUP_VERSION);

  if (removedSettings || updatedUsers) {
    logger.info(
      `Removed ${removedSettings} legacy world setting record(s) and cleaned ${updatedUsers} legacy user flag record(s).`,
    );
  }
}

class PatreonSupportMenu extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2,
) {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "gambits-patreon-support",
      title: "Patreon Support",
      template: "templates/blank.hbs",
      width: 1,
      height: 1,
      popOut: false,
    });
  }

  render() {
    window.open("https://www.patreon.com/GambitsLounge/membership", "_blank", "noopener,noreferrer");
    return this;
  }
}
