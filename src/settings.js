import { packageId } from "./constants.js";

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

  game.settings.register(packageId, "customEffectsDirectory", {
    name: "FXMASTER.AnimationEffect.CustomDirectoryName",
    hint: "FXMASTER.AnimationEffect.CustomDirectoryHint",
    scope: "world",
    config: true,
    type: String,
    default: "",
  });

  game.settings.register(packageId, "refreshDb", {
    name: "FXMASTER.AnimationEffect.RefreshDbName",
    hint: "FXMASTER.AnimationEffect.RefreshDbHint",
    scope: "world",
    config: false,
    type: Boolean,
    default: false,
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

  game.settings.register(packageId, "specialEffects", {
    name: "specialEffects",
    default: [],
    scope: "world",
    type: Array,
    config: false,
  });

  game.settings.register(packageId, "customSpecialEffects", {
    name: "customSpecialEffects",
    scope: "world",
    config: false,
    type: Object,
    default: {},
  });

  game.settings.register(packageId, "dbSpecialEffects", {
    name: "dbSpecialEffects",
    scope: "world",
    config: false,
    type: Object,
    default: {},
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

  game.settings.register(packageId, "permission-create", {
    name: "FXMASTER.Common.PermissionCreate",
    hint: "FXMASTER.Common.PermissionCreateHint",
    scope: "world",
    config: true,
    default: foundry.CONST.USER_ROLES.ASSISTANT,
    type: Number,
    choices: {
      [foundry.CONST.USER_ROLES.PLAYER]: "USER.RolePlayer",
      [foundry.CONST.USER_ROLES.TRUSTED]: "USER.RoleTrusted",
      [foundry.CONST.USER_ROLES.ASSISTANT]: "USER.RoleAssistant",
      [foundry.CONST.USER_ROLES.GAMEMASTER]: "USER.RoleGamemaster",
    },
    requiresReload: true,
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
}

export function isEnabled() {
  return game.settings.get(packageId, "enable") && !game.settings.get(packageId, "disableAll");
}
