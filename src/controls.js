import { packageId } from "./constants.js";
import { FilterEffectsSceneManager } from "./filter-effects/filter-effects-scene-manager.js";
import { ParticleEffectsManagement } from "./particle-effects/applications/particle-effects-management.js";
import { SpecialEffectsManagement } from "./special-effects/applications/special-effects-management.js";
import { FilterEffectsManagement } from "./filter-effects/applications/filter-effects-management.js";
import { ApiEffectsManagement } from "./api-effects/applications/api-effects-management.js";
import { saveParticleAndFilterEffectsAsMacro } from "./macro.js";

export function registerGetSceneControlButtonsHook() {
  Hooks.on("getSceneControlButtons", getSceneControlButtons);
}

function getSceneControlButtons(t) {
  if (!canvas) return;

  const onEvent = foundry.utils.isNewerVersion(game.version, "13.0.0") ? "onChange" : "onClick";

  let tools = {
    activation: {
      name: "activation",
      title: "CONTROLS.ToolsActive",
      icon: "fas fa-power-off",
      toggle: true,
      [onEvent]: (_event, active) => {
        if (!active && foundry.utils.isNewerVersion(game.version, "13.0.0")) return;
        canvas.layers.find((l) => l.options.name === "specials")?.activate();
      },
      visible: true,
      order: 1,
    },
    filters: {
      name: "filters",
      title: "CONTROLS.Filters",
      icon: "fas fa-filter",
      order: 40,
      button: true,
      [onEvent]: () => new FilterEffectsManagement().render(true),
      visible: game.user.isGM,
    },
    "api-effects": {
      name: "api-effects",
      title: "FXMASTER.Common.ApiEffects",
      icon: "fas fa-plug",
      order: 47,
      button: true,
      [onEvent]: () => new ApiEffectsManagement().render(true),
      visible: game.user.isGM,
    },
    "particle-effects": {
      name: "particle-effects",
      title: "CONTROLS.ParticleEffects",
      icon: "fas fa-cloud-rain",
      order: 20,
      button: true,
      [onEvent]: (_event, _active) => new ParticleEffectsManagement().render(true),
      visible: game.user.isGM,
    },
    specials: {
      name: "specials",
      title: "CONTROLS.SpecialFX",
      icon: "fas fa-hat-wizard",
      order: 10,
      button: true,
      [onEvent]: (_event, active) => {
        if (!active && foundry.utils.isNewerVersion(game.version, "13.0.0")) return;
        new SpecialEffectsManagement().render(true);
      },
      visible: true,
    },
    save: {
      name: "save",
      title: "CONTROLS.SaveMacro",
      icon: "fas fa-floppy-disk",
      order: 50,
      button: true,
      [onEvent]: () => saveParticleAndFilterEffectsAsMacro(),
      visible: game.user.isGM,
    },
    clearfx: {
      name: "clearfx",
      title: "CONTROLS.ClearFX",
      icon: "fas fa-trash",
      order: 60,
      button: true,
      [onEvent]: () => {
        const clearFxDialog = new foundry.applications.api.DialogV2({
          window: {
            title: game.i18n.localize("FXMASTER.Common.ClearParticleAndFilterEffectsTitle"),
            id: "clearFx",
            minimizable: false,
          },
          content: game.i18n.localize("FXMASTER.Common.ClearParticleAndFilterEffectsContent"),
          buttons: [
            {
              action: "yes",
              label: game.i18n.localize("FXMASTER.Common.Yes"),
              icon: "fas fa-check",
              callback: () => {
                if (canvas.scene) {
                  FilterEffectsSceneManager.instance.removeAll();
                  canvas.scene.unsetFlag(packageId, "effects");

                  const btnParticles = document.querySelector(`[data-tool="particle-effects"]`);
                  btnParticles?.style?.removeProperty("background-color");
                  btnParticles?.style?.removeProperty("border-color");
                  const btnFilters = document.querySelector(`[data-tool="filters"]`);
                  btnFilters?.style?.removeProperty("background-color");
                  btnFilters?.style?.removeProperty("border-color");
                  const btnApi = document.querySelector(`[data-tool="api-effects"]`);
                  btnApi?.style?.removeProperty("background-color");
                  btnApi?.style?.removeProperty("border-color");
                  const btnControl =
                    document.querySelector(`#scene-controls-layers button.control[data-control="effects"]`) ||
                    document.querySelector(
                      `#scene-controls-layers button[data-action="control"][data-control="effects"]`,
                    ) ||
                    document.querySelector(`button[data-action="control"][data-control="effects"]`) ||
                    document.querySelector(`li.scene-control[data-control="effects"] button`) ||
                    document.querySelector(`li.scene-control[data-control="effects"]`);
                  const btnControlEl = btnControl?.matches?.("li")
                    ? btnControl.querySelector?.("button") ?? btnControl
                    : btnControl;
                  btnControlEl?.style?.removeProperty("background-color");
                  btnControlEl?.style?.removeProperty("border-color");
                }
              },
              default: true,
            },
            {
              action: "no",
              label: game.i18n.localize("FXMASTER.Common.No"),
              icon: "fas fa-times",
              callback: () => {
                return false;
              },
            },
          ],
          close: () => {},
          rejectClose: false,
        });

        return clearFxDialog.render(true);
      },
      visible: game.user.isGM,
    },
  };

  if (!foundry.utils.isNewerVersion(game.version, "13.0.0"))
    tools = Object.values(tools).sort((a, b) => a.order - b.order);

  const fxControl = {
    name: "effects",
    title: "CONTROLS.Effects",
    icon: "fas fa-wand-magic-sparkles",
    [onEvent]: (_event, _active) => {},
    visible: game.user.role >= game.settings.get(packageId, "permission-create"),
    order: 100,
    tools: tools,
    activeTool: "activation",
    layer: "specials",
  };

  if (foundry.utils.isNewerVersion(game.version, "13.0.0")) {
    t.effects = fxControl;
  } else {
    t.push(fxControl);
  }
}
