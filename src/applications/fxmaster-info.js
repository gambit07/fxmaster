import { ApiEffectsManagement } from "../api-effects/applications/api-effects-management.js";
import { FXMasterBaseFormV2 } from "../base-form.js";
import { FilterEffectsManagement } from "../filter-effects/applications/filter-effects-management.js";
import { ParticleEffectsManagement } from "../particle-effects/applications/particle-effects-management.js";
import { FxLayersManagement } from "../stack/fx-layers-management.js";
import { hasFxmasterPlus } from "../api.js";

const README_URL = "https://github.com/gambit07/fxmaster#readme";
const FXMASTER_PLUS_SOUND_EFFECTS_MODULE = "modules/fxmaster-plus/scripts/soundfx/soundfx-management.js";
const FXMASTER_PLUS_USER_PARTICLES_MODULE = "modules/fxmaster-plus/scripts/user-particle-effects-management.js";
const PREVIEW_MAX_WIDTH = "min(92vw, 1100px)";
const PREVIEW_MAX_HEIGHT = "min(76vh, 760px)";
const PREVIEW_MEDIA = {
  regions: "modules/fxmaster/assets/media/region-controls-preview.mp4",
  placementLevels: "modules/fxmaster/assets/media/levels-placement.mp4",
  layers: "modules/fxmaster/assets/media/manage-layers.mp4",
  apiEffects: "modules/fxmaster/assets/media/api-effects.mp4",
  soundEffects: "https://www.youtube.com/watch?v=8Xc6ivKkuLI",
  performance: "modules/fxmaster/assets/media/performance-mode.mp4",
  userparticles: "modules/fxmaster/assets/media/user-particle-effects-preview.mp4",
};

/**
 * High-level informational overview for GMs using the FXMaster scene controls.
 */
export class FxMasterInfo extends FXMasterBaseFormV2 {
  /** @type {FxMasterInfo|undefined} */
  static #instance;

  /** @type {AbortController|undefined} */
  #listenerAbort;

  /**
   * Open the overview window, reusing the existing instance when possible.
   *
   * @returns {Promise<FxMasterInfo>|FxMasterInfo}
   */
  static show() {
    const element = this.#instance?.element?.[0] ?? this.#instance?.element ?? null;
    if (element?.isConnected) {
      this.#instance.bringToFront?.();
      return this.#instance;
    }

    const app = new this();
    this.#instance = app;
    return app.render(true);
  }

  constructor(options = {}) {
    super(options);
    FxMasterInfo.#instance = this;
  }

  static DEFAULT_OPTIONS = {
    id: "fxmaster-info",
    tag: "section",
    classes: ["fxmaster", "form-v2", "fxmaster-info"],
    window: {
      title: "FXMASTER.Info.Title",
      resizable: true,
      minimizable: true,
    },
    position: {
      width: 1200,
      height: "auto",
    },
  };

  static PARTS = [
    {
      template: "modules/fxmaster/templates/fxmaster-info.hbs",
    },
  ];

  /** @inheritdoc */
  async _prepareContext() {
    const fxmasterPlusActive = hasFxmasterPlus();

    const sections = [
      {
        icon: "fas fa-cloud-rain",
        title: "FXMASTER.Info.Sections.Particles.Title",
        text: "FXMASTER.Info.Sections.Particles.Text",
        action: {
          label: "FXMASTER.Info.Actions.OpenParticleEffects",
          id: "particleEffects",
        },
      },
      {
        icon: "fas fa-filter",
        title: "FXMASTER.Info.Sections.Filters.Title",
        text: "FXMASTER.Info.Sections.Filters.Text",
        action: {
          label: "FXMASTER.Info.Actions.OpenFilterEffects",
          id: "filterEffects",
        },
      },
      {
        icon: "fas fa-draw-polygon",
        title: "FXMASTER.Info.Sections.Regions.Title",
        text: "FXMASTER.Info.Sections.Regions.Text",
        preview: this.#createPreviewConfig(PREVIEW_MEDIA.regions),
        action: {
          label: "FXMASTER.Info.Actions.OpenRegionControls",
          id: "regionControls",
        },
      },
      {
        icon: "fas fa-clone",
        title: "FXMASTER.Info.Sections.PlacementLevels.Title",
        text: "FXMASTER.Info.Sections.PlacementLevels.Text",
        preview: this.#createPreviewConfig(PREVIEW_MEDIA.placementLevels),
      },
      {
        icon: "fas fa-layer-group",
        title: "FXMASTER.Info.Sections.Layers.Title",
        text: "FXMASTER.Info.Sections.Layers.Text",
        preview: this.#createPreviewConfig(PREVIEW_MEDIA.layers),
        action: {
          label: "FXMASTER.Info.Actions.OpenLayers",
          id: "layers",
        },
      },
      {
        icon: "fas fa-plug",
        title: "FXMASTER.Info.Sections.ApiEffects.Title",
        text: "FXMASTER.Info.Sections.ApiEffects.Text",
        preview: this.#createPreviewConfig(PREVIEW_MEDIA.apiEffects),
        action: {
          label: "FXMASTER.Info.Actions.OpenApiEffects",
          id: "apiEffects",
        },
      },
      {
        icon: "fas fa-volume-up",
        title: "FXMASTER.Info.Sections.SoundEffects.Title",
        text: "FXMASTER.Info.Sections.SoundEffects.Text",
        preview: this.#createPreviewConfig(PREVIEW_MEDIA.soundEffects, "youtube"),
        action: fxmasterPlusActive
          ? {
              label: "FXMASTER.Info.Actions.OpenSoundEffects",
              id: "soundEffects",
            }
          : null,
      },
      {
        icon: "fas fa-plus",
        title: "FXMASTER.Info.Sections.UserParticles.Title",
        text: "FXMASTER.Info.Sections.UserParticles.Text",
        preview: this.#createPreviewConfig(PREVIEW_MEDIA.userparticles),
        action: fxmasterPlusActive
          ? {
              label: "FXMASTER.Info.Actions.OpenUserParticleEffects",
              id: "userParticleEffects",
            }
          : null,
      },
      {
        icon: "fas fa-floppy-disk",
        title: "FXMASTER.Info.Sections.Macros.Title",
        text: "FXMASTER.Info.Sections.Macros.Text",
      },
      {
        icon: "fas fa-trash",
        title: "FXMASTER.Info.Sections.Cleanup.Title",
        text: "FXMASTER.Info.Sections.Cleanup.Text",
      },
      {
        icon: "fas fa-gauge-high",
        title: "FXMASTER.Info.Sections.Performance.Title",
        text: "FXMASTER.Info.Sections.Performance.Text",
        preview: this.#createPreviewConfig(PREVIEW_MEDIA.performance),
      },
    ];

    return {
      readmeUrl: README_URL,
      sections,
    };
  }

  /** @inheritdoc */
  async _onRender(...args) {
    await super._onRender(...args);

    const element = this.element?.[0] ?? this.element ?? null;
    if (!element) return;

    this.#listenerAbort?.abort?.();
    this.#listenerAbort = new AbortController();

    element.addEventListener("click", (event) => this.#onClick(event), {
      signal: this.#listenerAbort.signal,
    });
  }

  /**
   * Create preview metadata shared by overview cards with media examples.
   *
   * @returns {{type: string, src: string, maxWidth: string, maxHeight: string}}
   */
  #createPreviewConfig(src = "", type = "video") {
    return {
      type,
      src,
      maxWidth: PREVIEW_MAX_WIDTH,
      maxHeight: PREVIEW_MAX_HEIGHT,
    };
  }

  /**
   * Handle overview-local button clicks.
   *
   * @param {PointerEvent} event
   * @returns {void}
   */
  #onClick(event) {
    const element = this.element?.[0] ?? this.element ?? null;

    const preview = event.target?.closest?.("[data-fxmaster-preview]");
    if (preview && element?.contains?.(preview)) {
      event.preventDefault();
      event.stopPropagation();

      void this.#openPreview(preview);
      return;
    }

    const button = event.target?.closest?.("[data-fxmaster-action]");
    if (!button || !element?.contains?.(button)) return;

    event.preventDefault();
    event.stopPropagation();

    void this.#performAction(button.dataset.fxmasterAction);
  }

  /**
   * Perform an overview shortcut action without changing active button-tool state.
   *
   * @param {string|undefined} action
   * @returns {Promise<void>}
   */
  async #performAction(action) {
    switch (action) {
      case "particleEffects":
        new ParticleEffectsManagement().render(true);
        return;
      case "filterEffects":
        new FilterEffectsManagement().render(true);
        return;
      case "regionControls":
        await this.#activateSceneControl({ control: "regions" });
        return;
      case "layers":
        new FxLayersManagement().render(true);
        return;
      case "apiEffects":
        new ApiEffectsManagement().render(true);
        return;
      case "soundEffects":
        await this.#openFxMasterPlusSoundEffects();
        return;
      case "userParticleEffects":
        await this.#openFxMasterPlusUserParticles();
        return;
      default:
        return;
    }
  }

  /**
   * Activate a Scene Controls control or tool.
   *
   * @param {{control: string, tool?: string}} options
   * @returns {Promise<void>}
   */
  async #activateSceneControl(options) {
    try {
      await ui.controls?.activate?.(options);
    } catch (err) {
      console.warn("FXMaster | Unable to navigate to scene control", { ...options, err });
    }
  }

  /**
   * Open the FXMaster+ Sound Effects manager.
   *
   * @returns {Promise<void>}
   */
  async #openFxMasterPlusSoundEffects() {
    if (!this.#canOpenFxMasterPlusManager()) return;

    try {
      const module = await import(this.#getModuleRoute(FXMASTER_PLUS_SOUND_EFFECTS_MODULE));
      module.openSoundFxManager?.();
    } catch (err) {
      console.warn("FXMaster | Unable to open FXMaster+ Sound Effects manager", err);
    }
  }

  /**
   * Open the FXMaster+ User Particle Effects manager.
   *
   * @returns {Promise<void>}
   */
  async #openFxMasterPlusUserParticles() {
    if (!this.#canOpenFxMasterPlusManager()) return;

    try {
      const module = await import(this.#getModuleRoute(FXMASTER_PLUS_USER_PARTICLES_MODULE));
      new module.UserParticleEffectsManagement().render(true);
    } catch (err) {
      console.warn("FXMaster | Unable to open FXMaster+ User Particle Effects manager", err);
    }
  }

  /**
   * Gate FXMaster+ manager windows behind the world-active FXMaster+ module.
   *
   * @returns {boolean}
   */
  #canOpenFxMasterPlusManager() {
    if (hasFxmasterPlus()) return true;

    ui.notifications?.warn?.("FXMaster+ must be installed and active in this world to open this manager.");
    return false;
  }

  /**
   * Convert a module path to a route-safe browser URL.
   *
   * @param {string} path
   * @returns {string}
   */
  #getModuleRoute(path) {
    const normalized = String(path ?? "").replace(/^\/+/, "");
    const route = foundry.utils.getRoute?.(normalized) ?? `/${normalized}`;
    const externalRoutePattern = new RegExp("^(?:[a-z]+:)?/{2}", "i");
    if (externalRoutePattern.test(route) || route.startsWith("/")) return route;
    return `/${route}`;
  }

  /**
   * Open preview media from an overview card.
   *
   * @param {HTMLElement} preview
   * @returns {Promise<void>}
   */
  async #openPreview(preview) {
    const src = preview.dataset.fxmasterPreviewSrc ?? "";
    if (!src) {
      ui.notifications?.info?.(game.i18n.localize("FXMASTER.Info.PreviewPlaceholder"));
      return;
    }

    const type = preview.dataset.fxmasterPreviewType ?? "";
    if (this.#isYouTubePreview(src, type)) {
      this.#openExternalPreview(src);
      return;
    }

    await this.#openPreviewPopout(preview, src);
  }

  /**
   * Open a preview media file in Foundry's ImagePopout.
   *
   * @param {HTMLElement} preview
   * @param {string} src
   * @returns {Promise<void>}
   */
  async #openPreviewPopout(preview, src) {
    const title = preview.dataset.fxmasterPreviewLabel || game.i18n.localize("FXMASTER.Info.Title");
    const ImagePopoutClass = globalThis.foundry?.applications?.apps?.ImagePopout ?? globalThis.ImagePopout;
    if (!ImagePopoutClass) {
      ui.notifications?.warn?.("FXMaster | Unable to open preview: Foundry ImagePopout is not available.");
      return;
    }

    try {
      const popout = this.#createImagePopout(ImagePopoutClass, { src, title });
      await popout.render(true);
      this.#enableImagePopoutControls(popout, preview);
    } catch (err) {
      console.warn("FXMaster | Unable to open preview media", { src, err });
      ui.notifications?.warn?.("FXMaster | Unable to open preview media.");
    }
  }

  /**
   * Whether the preview source should open externally as a YouTube link.
   *
   * @param {string} src
   * @param {string} type
   * @returns {boolean}
   */
  #isYouTubePreview(src, type = "") {
    if (String(type ?? "").toLowerCase() === "youtube") return true;
    return Boolean(this.#normalizeYouTubeUrl(src));
  }

  /**
   * Normalize and validate a YouTube preview URL.
   *
   * @param {string} src
   * @returns {string|null}
   */
  #normalizeYouTubeUrl(src) {
    try {
      const url = new URL(String(src ?? "").trim(), globalThis.location?.href);
      if (!["http:", "https:"].includes(url.protocol)) return null;

      const host = url.hostname.toLowerCase();
      const isYouTubeHost =
        host === "youtu.be" ||
        host === "youtube.com" ||
        host.endsWith(".youtube.com") ||
        host === "youtube-nocookie.com" ||
        host.endsWith(".youtube-nocookie.com");

      return isYouTubeHost ? url.href : null;
    } catch (err) {
      return null;
    }
  }

  /**
   * Open a trusted external preview URL in a new browser tab/window.
   *
   * @param {string} src
   * @returns {void}
   */
  #openExternalPreview(src) {
    const url = this.#normalizeYouTubeUrl(src);
    if (!url) {
      ui.notifications?.warn?.("FXMaster | Unable to open preview link.");
      return;
    }

    const document = globalThis.document;
    if (document?.createElement) {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.style.display = "none";
      document.body?.appendChild?.(anchor);
      anchor.click();
      anchor.remove?.();
      return;
    }

    const opened = globalThis.open?.(url, "_blank");
    if (opened) opened.opener = null;
    else return;
  }

  /**
   * Create an ImagePopout using the v13 ApplicationV2 signature, with a legacy fallback.
   *
   * @param {Function} ImagePopoutClass
   * @param {{src: string, title: string}} options
   * @returns {object}
   */
  #createImagePopout(ImagePopoutClass, { src, title }) {
    try {
      return new ImagePopoutClass({
        src,
        caption: title,
        window: {
          title,
          resizable: true,
        },
      });
    } catch (err) {
      return new ImagePopoutClass(src, {
        title,
        caption: title,
        resizable: true,
      });
    }
  }

  /**
   * Ensure video previews expose native playback controls, including the seek bar.
   *
   * @param {object} popout
   * @param {HTMLElement} preview
   * @returns {void}
   */
  #enableImagePopoutControls(popout, preview) {
    const element = popout?.element?.[0] ?? popout?.element ?? null;
    element?.classList?.add?.("fxmaster-info-media-popout");
    element?.style?.setProperty?.(
      "--fxmaster-info-preview-max-width",
      preview.dataset.fxmasterPreviewMaxWidth || PREVIEW_MAX_WIDTH,
    );
    element?.style?.setProperty?.(
      "--fxmaster-info-preview-max-height",
      preview.dataset.fxmasterPreviewMaxHeight || PREVIEW_MAX_HEIGHT,
    );

    for (const video of element?.querySelectorAll?.("video") ?? []) {
      video.controls = true;
      video.autoplay = false;
      video.loop = false;
      video.muted = false;
      video.playsInline = true;
      video.preload = "metadata";
      video.pause?.();
    }
  }

  /** @inheritdoc */
  async _onClose(...args) {
    this.#listenerAbort?.abort?.();
    this.#listenerAbort = undefined;

    await super._onClose(...args);
    if (FxMasterInfo.#instance === this) FxMasterInfo.#instance = undefined;
  }
}
