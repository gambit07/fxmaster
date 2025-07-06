import { FXMasterBaseFormV2 } from "../../base-form.js";
import { SpecialEffectsManagement } from "./special-effects-management.js";
import { packageId } from "../../constants.js";

export class SpecialEffectConfig extends FXMasterBaseFormV2 {
  static DEFAULT_OPTIONS = {
    id: "add-effect",
    tag: "form",
    classes: ["fxmaster", "form-v2", "specials-config"],
    popOut: true,
    actions: {
      updateParam: SpecialEffectConfig.updateParam,
      copyElement: SpecialEffectConfig.copyElement,
      save: SpecialEffectConfig._onSave,
    },
    window: {
      title: "FXMASTER.AnimationEffect.Update",
    },
    position: {
      width: 500,
      height: "auto",
    },
  };

  static PARTS = [
    {
      template: "modules/fxmaster/templates/special-effect-config.hbs",
      footer: {
        template: "templates/generic/form-footer.hbs",
      },
    },
  ];

  /* -------------------------------------------- */

  setDefault(object) {
    this.default = object;
  }

  /**
   * Obtain module metadata and merge it with game settings which track current module visibility
   * @return {Object}   The data provided to the template when rendering the form
   */
  async _prepareContext() {
    const values = foundry.utils.mergeObject(
      {
        folder: "Custom",
        position: {
          x: 0,
          y: 0,
        },
        anchor: {
          x: 0.5,
          y: 0.5,
        },
        scale: {
          x: 1.0,
          y: 1.0,
        },
        author: "",
        preset: false,
      },
      this.default,
    );

    return {
      default: values,
    };
  }

  async _onRender(...args) {
    super._onRender(...args);
    let windowPosition = game.user.getFlag(packageId, "dialog-position-specialeffectsconfig");
    if (windowPosition) {
      this.setPosition({ top: windowPosition.top, left: windowPosition.left });
    }
  }

  static copyElement(event, button) {
    const input = button.closest(".form-fields")?.querySelector("input");
    if (!input) return;

    input.select();
    input.setSelectionRange(0, input.value.length);

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(input.value).catch(() => {
        document.execCommand("copy");
      });
    } else {
      document.execCommand("copy");
    }

    ui.notifications.info(game.i18n.format("FXMASTER.AnimationEffect.Copied", { value: input.value }));
  }

  static updateParam(_event, input) {
    if (input.type === "range") {
      const container = input.closest(".fxmaster-input-range");
      const output = container?.querySelector(".range-value");
      if (output) output.textContent = input.value;
    }
  }

  static async _onSave(_event, _button) {
    const form = this.element.querySelector("form");
    if (!form) return;

    const formData = Object.fromEntries(new FormData(form).entries());

    formData.scaleX = parseFloat(formData.scaleX);
    formData.scaleY = parseFloat(formData.scaleY);
    formData.anchorX = parseFloat(formData.anchorX);
    formData.anchorY = parseFloat(formData.anchorY);
    formData.favorite = formData.favorite === "true";

    const overrides = game.settings.get(packageId, "customSpecialEffects") || {};

    const newData = {
      folder: formData.folder,
      label: formData.label,
      file: formData.file,
      scale: { x: formData.scaleX, y: formData.scaleY },
      anchor: { x: formData.anchorX, y: formData.anchorY },
      preset: false,
      author: formData.author || "",
      type: "SpecialEffect",
      favorite: formData.favorite,
    };
    overrides[newData.file] = newData;
    await game.settings.set(packageId, "customSpecialEffects", overrides);

    const mgr = SpecialEffectsManagement.instance;
    if (mgr) mgr.render(false);

    this.close();
  }

  async _onClose(...args) {
    super._onClose(...args);
    const { top, left } = this.position;
    game.user.setFlag(packageId, "dialog-position-specialeffectsconfig", { top, left });
  }
}
