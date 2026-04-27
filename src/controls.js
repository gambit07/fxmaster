import { packageId } from "./constants.js";
import { FilterEffectsSceneManager } from "./filter-effects/filter-effects-scene-manager.js";
import { ParticleEffectsManagement } from "./particle-effects/applications/particle-effects-management.js";
import { FilterEffectsManagement } from "./filter-effects/applications/filter-effects-management.js";
import { ApiEffectsManagement } from "./api-effects/applications/api-effects-management.js";
import { saveParticleAndFilterEffectsAsMacro } from "./macro.js";
import { FxLayersManagement } from "./stack/fx-layers-management.js";
import { FxMasterInfo } from "./applications/fxmaster-info.js";
import { clearStoredEffectStack } from "./common/effect-stack.js";
import { updateSceneControlHighlights } from "./utils.js";

let fxMasterInfoClickListenerRegistered = false;

/**
 * Determine whether a Scene Controls tool change should open an application or run an action.
 *
 * @param {boolean|undefined} active
 * @returns {boolean}
 */
function shouldHandleToolActivation(active) {
  return active !== false;
}

function getSceneControlsElement() {
  return ui.controls?.element?.[0] ?? ui.controls?.element ?? document.querySelector("#controls");
}

function registerFxMasterInfoClickListener() {
  if (fxMasterInfoClickListenerRegistered) return;
  fxMasterInfoClickListenerRegistered = true;

  document.addEventListener(
    "click",
    (event) => {
      if (!game.user?.isGM) return;

      const target = event?.target;
      const toolButton = target?.closest?.('[data-tool="activation"]');
      if (!toolButton) return;

      const controlsElement = getSceneControlsElement();
      if (controlsElement && !controlsElement.contains(toolButton)) return;

      event?.preventDefault?.();
      event?.stopPropagation?.();
      event?.stopImmediatePropagation?.();
      void FxMasterInfo.show();
    },
    true,
  );
}

export function registerGetSceneControlButtonsHook() {
  Hooks.on("getSceneControlButtons", getSceneControlButtons);
  registerFxMasterInfoClickListener();
}

function getSceneControlButtons(t) {
  if (!canvas) return;

  const onEvent = "onChange";

  const tools = {
    activation: {
      name: "activation",
      title: "FXMASTER.Info.ControlTitle",
      icon: "fas fa-circle-info",
      toggle: true,
      [onEvent]: (_event, _active) => {},
      visible: true,
      order: 1,
    },
    filters: {
      name: "filters",
      title: "CONTROLS.Filters",
      icon: "fas fa-filter",
      order: 40,
      button: true,
      [onEvent]: (_event, active) => {
        if (!shouldHandleToolActivation(active)) return;
        return new FilterEffectsManagement().render(true);
      },
      visible: game.user.isGM,
    },
    "api-effects": {
      name: "api-effects",
      title: "FXMASTER.Common.ApiEffects",
      icon: "fas fa-plug",
      order: 48,
      button: true,
      [onEvent]: (_event, active) => {
        if (!shouldHandleToolActivation(active)) return;
        return new ApiEffectsManagement().render(true);
      },
      visible: game.user.isGM,
    },
    layers: {
      name: "layers",
      title: "FXMASTER.Layers.Title",
      icon: "fas fa-layer-group",
      order: 47,
      button: true,
      [onEvent]: (_event, active) => {
        if (!shouldHandleToolActivation(active)) return;
        return new FxLayersManagement().render(true);
      },
      visible: game.user.isGM,
    },
    "particle-effects": {
      name: "particle-effects",
      title: "CONTROLS.ParticleEffects",
      icon: "fas fa-cloud-rain",
      order: 20,
      button: true,
      [onEvent]: (_event, active) => {
        if (!shouldHandleToolActivation(active)) return;
        return new ParticleEffectsManagement().render(true);
      },
      visible: game.user.isGM,
    },
    save: {
      name: "save",
      title: "CONTROLS.SaveMacro",
      icon: "fas fa-floppy-disk",
      order: 51,
      button: true,
      [onEvent]: (_event, active) => {
        if (!shouldHandleToolActivation(active)) return;
        return saveParticleAndFilterEffectsAsMacro();
      },
      visible: game.user.isGM,
    },
    clearfx: {
      name: "clearfx",
      title: "CONTROLS.ClearFX",
      icon: "fas fa-trash",
      order: 60,
      button: true,
      [onEvent]: (_event, active) => {
        if (!shouldHandleToolActivation(active)) return;

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
              callback: async () => {
                if (!canvas.scene) return;

                await FilterEffectsSceneManager.instance.removeAll();
                await canvas.scene.unsetFlag(packageId, "effects");
                await clearStoredEffectStack(canvas.scene);
                updateSceneControlHighlights();
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

  const fxControl = {
    name: "effects",
    title: "CONTROLS.Effects",
    icon: "fas fa-wand-magic-sparkles",
    [onEvent]: (_event, _active) => {},
    visible: game.user.isGM,
    order: 100,
    tools,
    activeTool: "activation",
    layer: "particleeffects",
  };

  t.effects = fxControl;
}
