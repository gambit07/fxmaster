import { packageId } from "./constants.js";
import { onSwitchParticleEffects, onUpdateParticleEffects, parseSpecialEffects } from "./utils.js";
import { isEnabled } from "./settings.js";
import { SpecialEffectsManagement } from "./special-effects/applications/special-effects-management.js";
import { SpecialEffectsLayer } from "./special-effects/special-effects-layer.js";
import { refreshSceneParticlesSuppressionMasks } from "./particle-effects/particle-effects-scene-manager.js";
import { ParticleEffectsRegionBehaviorConfig } from "./particle-effects/particle-effects-region-config.js";
import { FilterRegionBehaviorConfig } from "./filter-effects/filter-effects-region-config.js";
import { FilterEffectsSceneManager } from "./filter-effects/filter-effects-scene-manager.js";
import { coalesceNextFrame, getCssViewportMetrics } from "./utils.js";

/**
 * FXMaster Hooks
 * Registers Foundry VTT hooks and utilities to synchronize scene/region particle effects,
 * filter effects, suppression masks, and management UIs with canvas and scene lifecycle.
 */
const TYPE = `${packageId}.particleEffectsRegion`;
const FILTER_TYPE = `${packageId}.filterEffectsRegion`;
const SUPPRESS_SCENE_FILTERS = `${packageId}.suppressSceneFilters`;
const SUPPRESS_SCENE_PARTICLES = `${packageId}.suppressSceneParticles`;

/** Open Particle/Filter management windows tracked for live refresh. */
const _openPFx = new Set();
const _openFFx = new Set();

/**
 * Register all FXMaster hooks.
 */
export const registerHooks = function () {
  let _fmResizeHandler = null;
  let _flResizeHandler = null;
  let _fxResizeHandler = null;

  /** Coalesced rebuild of the scene filter suppression mask. */
  const requestFilterSuppressionRefresh = coalesceNextFrame(
    function requestFilterSuppressionRefresh() {
      if (isEnabled()) FilterEffectsSceneManager.instance.refreshSceneFilterSuppressionMask();
    },
    { key: "fxm:filter:suppression" },
  );

  /** Coalesced *region* filter-mask refresh (all). */
  const requestRegionMaskRefreshAllDebounced = coalesceNextFrame(
    function requestRegionMaskRefreshAllDebounced() {
      if (!isEnabled()) return;
      try {
        canvas.filtereffects?.requestRegionMaskRefreshAll?.();
      } catch {}
    },
    { key: "fxm:filter:regionMasksAll" },
  );

  /** Coalesced *particle* suppression mask refresh. */
  const requestSceneParticlesSuppressionRefresh = coalesceNextFrame(
    function requestSceneParticlesSuppressionRefresh() {
      try {
        refreshSceneParticlesSuppressionMasks?.();
      } catch {}
    },
    { key: "fxm:particles:suppression" },
  );

  /**
   * Batched token-related mask updates:
   *  - scene allow-masks (filter suppression)
   *  - region filter masks (all)
   *  - particle suppression masks
   */
  const requestTokenMaskRefresh = coalesceNextFrame(
    function requestTokenMaskRefresh() {
      if (!isEnabled()) return;
      try {
        FilterEffectsSceneManager.instance.refreshSceneFilterSuppressionMask();
      } catch {}
      try {
        canvas.filtereffects?.forceRegionMaskRefreshAll?.();
      } catch {}
      try {
        refreshSceneParticlesSuppressionMasks?.();
      } catch {}
    },
    { key: "fxm:token:maskRefresh" },
  );

  const pinEnvFilterArea = () => {
    const env = canvas?.environment;
    if (!env) return;
    const { deviceRect } = getCssViewportMetrics();
    const fa = env.filterArea instanceof PIXI.Rectangle ? env.filterArea : new PIXI.Rectangle();
    fa.copyFrom(deviceRect);
    try {
      env.filterArea = fa;
    } catch {}
  };

  const clearEnvFilterArea = () => {
    try {
      if (canvas?.environment) canvas.environment.filterArea = null;
    } catch {}
  };

  const ensurePinned = () => {
    const hasFilters = Array.isArray(canvas?.environment?.filters) && canvas.environment.filters.length > 0;
    if (isEnabled() && hasFilters) pinEnvFilterArea();
    else clearEnvFilterArea();
  };

  let _resize;
  const bind = () => {
    if (_resize && canvas?.app?.renderer) canvas.app.renderer.off("resize", _resize);
    _resize = () => ensurePinned();
    canvas?.app?.renderer?.on?.("resize", _resize);
    ensurePinned();
  };
  const unbind = () => {
    try {
      if (_resize && canvas?.app?.renderer) canvas.app.renderer.off("resize", _resize);
    } catch {}
    _resize = null;
  };

  Hooks.on("createToken", (tokenDoc) => {
    if (tokenDoc?.parent !== canvas.scene) return;
    if (!isEnabled()) return;
    requestTokenMaskRefresh();
  });
  Hooks.on("updateToken", (tokenDoc) => {
    if (tokenDoc?.parent !== canvas.scene) return;
    if (!isEnabled()) return;
    requestTokenMaskRefresh();
  });
  Hooks.on("deleteToken", (tokenDoc) => {
    if (tokenDoc?.parent !== canvas.scene) return;
    if (!isEnabled()) return;
    requestTokenMaskRefresh();
  });

  Hooks.on("refreshToken", (placeable) => {
    if (placeable?.document?.parent !== canvas.scene) return;
    if (!isEnabled()) return;
    requestTokenMaskRefresh();
  });

  Hooks.on("createTile", () => requestTokenMaskRefresh());
  Hooks.on("updateTile", () => requestTokenMaskRefresh());
  Hooks.on("deleteTile", () => requestTokenMaskRefresh());

  /** Track opening of Particle Effects Management windows. */
  Hooks.on("renderParticleEffectsManagement", (app) => {
    _openPFx.add(app);
  });

  /** Track closing of Particle Effects Management windows. */
  Hooks.on("closeParticleEffectsManagement", (app) => {
    _openPFx.delete(app);
  });

  /** Track opening of Filter Effects Management windows. */
  Hooks.on("renderFilterEffectsManagement", (app) => {
    _openFFx.add(app);
  });

  /** Track closing of Filter Effects Management windows. */
  Hooks.on("closeFilterEffectsManagement", (app) => {
    _openFFx.delete(app);
  });

  /**
   * Refresh all open FXMaster windows, optionally re-rendering from scratch.
   */
  const refreshOpenFxMasterWindows = ({ hard = true } = {}) => {
    for (const app of [..._openPFx, ..._openFFx]) {
      if (hard) {
        const Cls = app.constructor;
        const opts = foundry.utils.deepClone(app.options ?? {});
        const pos = { ...app.position };
        try {
          app.close({ navigate: false });
        } catch {}
        const nw = new Cls(opts);
        try {
          nw.render(true);
        } catch {}
        try {
          if (pos) nw.setPosition(pos);
        } catch {}
      } else {
        try {
          app.render(false);
        } catch {}
      }
    }
  };

  /**
   * Schedule a one-shot refresh of any open FXMaster windows (coalesced to a frame).
   */
  const scheduleOpenWindowsRefresh = coalesceNextFrame(
    function scheduleOpenWindowsRefresh(hard = true) {
      refreshOpenFxMasterWindows({ hard });
    },
    { key: "fxm:openWindowsRefresh" },
  );

  /**
   * Request a one-per-frame redraw of all region particle effects.
   */
  const requestRedrawAllRegionParticles = coalesceNextFrame(
    function requestRedrawAllRegionParticles() {
      if (!isEnabled()) return;
      try {
        for (const reg of canvas.regions.placeables) {
          canvas.particleeffects?.drawRegionParticleEffects?.(reg, { soft: false });
        }
      } catch {}
    },
    { key: "fxm:redrawAllRegionParticles" },
  );

  /** Handle custom event: toggle scene particle effects. */
  Hooks.on(`${packageId}.switchParticleEffect`, onSwitchParticleEffects);

  /** Handle custom event: update scene particle effects. */
  Hooks.on(`${packageId}.updateParticleEffects`, onUpdateParticleEffects);

  /** Before a Region is deleted: remove its particle and filter entries. */
  Hooks.on("preDeleteRegion", (regionDoc) => {
    try {
      canvas.particleeffects?.destroyRegionParticleEffects?.(regionDoc.id);
    } catch {}
    try {
      canvas.filtereffects?.destroyRegionFilterEffects?.(regionDoc.id);
    } catch {}
  });

  /** When a Region is created: draw any region particles/filters and refresh masks. */
  Hooks.on("createRegion", (regionDoc) => {
    if (regionDoc?.parent !== canvas.scene) return;

    const placeable = canvas.regions.get(regionDoc.id);
    if (placeable) {
      if (isEnabled() && regionDoc?.behaviors?.some((b) => b.type === TYPE && !b.disabled)) {
        canvas.particleeffects?.drawRegionParticleEffects?.(placeable);
      }
      const hasRegionFilterBehavior = regionDoc?.behaviors?.some((b) => b.type === FILTER_TYPE && !b.disabled);
      if (isEnabled() && hasRegionFilterBehavior) {
        canvas.filtereffects?.drawRegionFilterEffects?.(placeable);
      }
    }

    refreshSceneParticlesSuppressionMasks?.();
    requestFilterSuppressionRefresh();

    const hasSuppression = regionDoc?.behaviors?.some(
      (b) => (b.type === "suppressWeather" || b.type === SUPPRESS_SCENE_PARTICLES) && !b.disabled,
    );
    if (hasSuppression) requestRedrawAllRegionParticles();
  });

  /** When a Region is deleted: destroy entries and refresh masks. */
  Hooks.on("deleteRegion", (regionDoc) => {
    if (regionDoc?.parent !== canvas.scene) return;

    try {
      canvas.particleeffects?.destroyRegionParticleEffects?.(regionDoc.id);
    } catch {}
    try {
      canvas.filtereffects?.destroyRegionFilterEffects?.(regionDoc.id);
    } catch {}

    refreshSceneParticlesSuppressionMasks?.();
    requestFilterSuppressionRefresh();
    if (isEnabled()) {
      try {
        canvas.filtereffects?.requestRegionMaskRefreshAll?.();
      } catch {}
    }

    const hadSuppression = regionDoc?.behaviors?.some(
      (b) => (b.type === "suppressWeather" || b.type === SUPPRESS_SCENE_PARTICLES) && !b.disabled,
    );
    if (hadSuppression) requestRedrawAllRegionParticles();
  });

  /** When a Region is updated: rebuild particle/filter entries and refresh masks. */
  Hooks.on("updateRegion", (regionDoc) => {
    if (regionDoc?.parent !== canvas.scene) return;

    const hasFxmasterBehavior = regionDoc?.behaviors?.some(
      (b) => (b.type === TYPE || b.type === "suppressWeather" || b?.type === SUPPRESS_SCENE_PARTICLES) && !b.disabled,
    );

    const placeable = canvas.regions.get(regionDoc.id);
    if (placeable) {
      if (isEnabled() && hasFxmasterBehavior) {
        canvas.particleeffects?.drawRegionParticleEffects?.(placeable);
      } else {
        try {
          if (!isEnabled()) canvas.particleeffects?.destroyRegionParticleEffects?.(regionDoc.id);
        } catch {}
      }
      const hasRegionFilterBehavior = regionDoc?.behaviors?.some((b) => b.type === FILTER_TYPE && !b.disabled);
      if (isEnabled() && hasRegionFilterBehavior) {
        canvas.filtereffects?.drawRegionFilterEffects?.(placeable);
      } else {
        canvas.filtereffects?.destroyRegionFilterEffects?.(regionDoc.id);
      }
    }

    refreshSceneParticlesSuppressionMasks?.();
    requestFilterSuppressionRefresh();

    const hasSuppression = regionDoc?.behaviors?.some(
      (b) => (b.type === "suppressWeather" || b.type === SUPPRESS_SCENE_PARTICLES) && !b.disabled,
    );
    if (hasSuppression) requestRedrawAllRegionParticles();
  });

  /** While a Region placeable is refreshed soft-refresh its mask. */
  Hooks.on("refreshRegion", (placeable) => {
    if (placeable?.document?.parent !== canvas.scene) return;
    if (isEnabled()) {
      canvas.filtereffects?.requestRegionMaskRefresh?.(placeable.id);
      canvas.particleeffects?.requestRegionMaskRefresh?.(placeable.id);
    }
  });

  /** When a RegionBehavior is created apply suppression and draw region effects. */
  Hooks.on("createRegionBehavior", (behaviorDoc) => {
    const t = behaviorDoc?.type;
    const regionDoc = behaviorDoc?.parent;
    if (!t || regionDoc?.parent !== canvas.scene) return;
    const placeable = canvas.regions.get(regionDoc.id);
    if (!placeable) return;

    if (t === "suppressWeather" || t === SUPPRESS_SCENE_PARTICLES) {
      refreshSceneParticlesSuppressionMasks?.();
      try {
        canvas.particleeffects?.forceRegionMaskRefreshAll?.();
      } catch {}
    }
    if (isEnabled() && (t === "suppressWeather" || t === SUPPRESS_SCENE_FILTERS)) {
      requestFilterSuppressionRefresh();
    }

    if (isEnabled() && t === TYPE) {
      canvas.particleeffects?.drawRegionParticleEffects?.(placeable, { soft: false });
    } else if (isEnabled() && t === FILTER_TYPE) {
      canvas.filtereffects?.drawRegionFilterEffects?.(placeable, { soft: false });
    }
  });

  /** When a RegionBehavior is updated reapply suppression and redraw region effects. */
  Hooks.on("updateRegionBehavior", (behaviorDoc) => {
    const t = behaviorDoc?.type;
    const regionDoc = behaviorDoc?.parent;
    if (!t || regionDoc?.parent !== canvas.scene) return;
    const placeable = canvas.regions.get(regionDoc.id);
    if (!placeable) return;

    if (t === "suppressWeather" || t === SUPPRESS_SCENE_PARTICLES) {
      refreshSceneParticlesSuppressionMasks?.();
      try {
        canvas.particleeffects?.forceRegionMaskRefreshAll?.();
      } catch {}
    }
    if (isEnabled() && (t === "suppressWeather" || t === SUPPRESS_SCENE_FILTERS)) {
      requestFilterSuppressionRefresh();
    }

    if (isEnabled() && t === TYPE) {
      canvas.particleeffects?.drawRegionParticleEffects?.(placeable, { soft: false });
    } else if (isEnabled() && t === FILTER_TYPE) {
      canvas.filtereffects?.drawRegionFilterEffects?.(placeable, { soft: false });
    }
  });

  /** When a RegionBehavior is deleted reapply suppression and rebuild remaining effects. */
  Hooks.on("deleteRegionBehavior", (behaviorDoc) => {
    const t = behaviorDoc?.type;
    const regionDoc = behaviorDoc?.parent;
    if (!t || regionDoc?.parent !== canvas.scene) return;
    const placeable = canvas.regions.get(regionDoc.id);
    if (!placeable) return;

    if (t === "suppressWeather" || t === SUPPRESS_SCENE_PARTICLES) {
      refreshSceneParticlesSuppressionMasks?.();
      try {
        canvas.particleeffects?.forceRegionMaskRefreshAll?.();
      } catch {}
    }
    if (isEnabled() && (t === "suppressWeather" || t === SUPPRESS_SCENE_FILTERS)) {
      requestFilterSuppressionRefresh();
    }

    if (isEnabled() && t === TYPE) {
      canvas.particleeffects?.drawRegionParticleEffects?.(placeable, { soft: false });
    } else if (isEnabled() && t === FILTER_TYPE) {
      canvas.filtereffects?.drawRegionFilterEffects?.(placeable, { soft: false });
    }
  });

  /** On canvas init: clear manager state and unbind previous resize handlers. */
  Hooks.on("canvasInit", async () => {
    if (isEnabled()) {
      try {
        await FilterEffectsSceneManager.instance.clear();
      } catch {}
    }
    try {
      if (_fmResizeHandler && globalThis.canvas?.app?.renderer) {
        globalThis.canvas.app.renderer.off("resize", _fmResizeHandler);
      }
      if (_flResizeHandler && globalThis.canvas?.app?.renderer) {
        globalThis.canvas.app.renderer.off("resize", _flResizeHandler);
      }
    } catch {}
    _fmResizeHandler = null;
    _flResizeHandler = null;
    _fxResizeHandler = null;

    try {
      unbind();
    } catch {}
  });

  /** On scene activation: refresh open windows and request mask updates. */
  Hooks.on("activateScene", () => {
    scheduleOpenWindowsRefresh(true);
    if (isEnabled()) {
      requestSceneParticlesSuppressionRefresh();
      requestRegionMaskRefreshAllDebounced();
      try {
        canvas.particleeffects?.refreshAboveSceneMask?.();
      } catch {}
    }
  });

  /** On canvas ready: activate managers, bind resize handlers, and prime masks. */
  Hooks.on("canvasReady", async () => {
    if (isEnabled()) {
      await FilterEffectsSceneManager.instance.activate();
      try {
        if (_fmResizeHandler && canvas?.app?.renderer) canvas.app.renderer.off("resize", _fmResizeHandler);
        _fmResizeHandler = () => {
          try {
            FilterEffectsSceneManager.instance.refreshViewMaskGeometry();
          } catch {}
          requestFilterSuppressionRefresh();
        };
        canvas?.app?.renderer?.on?.("resize", _fmResizeHandler);

        if (_flResizeHandler && canvas?.app?.renderer) canvas.app.renderer.off("resize", _flResizeHandler);
        _flResizeHandler = () => {
          try {
            canvas.filtereffects?.forceRegionMaskRefreshAll?.();
          } catch {}
        };
        canvas?.app?.renderer?.on?.("resize", _flResizeHandler);

        if (_fxResizeHandler && canvas?.app?.renderer) canvas.app.renderer.off("resize", _fxResizeHandler);
        _fxResizeHandler = () => {
          try {
            refreshSceneParticlesSuppressionMasks?.();
          } catch {}
          try {
            canvas.particleeffects?.forceRegionMaskRefreshAll?.();
          } catch {}
          try {
            canvas.particleeffects?.refreshAboveSceneMask?.();
          } catch {}
        };
        canvas?.app?.renderer?.on?.("resize", _fxResizeHandler);
      } catch {}
    }

    try {
      canvas.stage?.updateTransform();
    } catch {}

    if (isEnabled()) {
      for (const region of canvas.regions.placeables) {
        try {
          canvas.particleeffects?.drawRegionParticleEffects?.(region, { soft: false });
        } catch {}
        try {
          canvas.filtereffects?.drawRegionFilterEffects?.(region, { soft: false });
        } catch {}
      }
    }

    if (isEnabled()) {
      try {
        FilterEffectsSceneManager.instance.refreshViewMaskGeometry();
      } catch {}
      try {
        canvas.filtereffects?.forceRegionMaskRefreshAll?.();
      } catch {}
      try {
        refreshSceneParticlesSuppressionMasks?.();
      } catch {}
      try {
        canvas.particleeffects?.forceRegionMaskRefreshAll?.();
      } catch {}
    }

    if (isEnabled()) {
      try {
        canvas.stage?.updateTransform();
      } catch {}
      requestSceneParticlesSuppressionRefresh();
      requestRegionMaskRefreshAllDebounced();
      try {
        canvas.particleeffects?.refreshAboveSceneMask?.();
      } catch {}
    }

    if (isEnabled()) {
      try {
        bind();
      } catch {}
    } else {
      try {
        unbind();
      } catch {}
    }

    scheduleOpenWindowsRefresh(true);
  });

  /** On first ready: show release note, register behavior sheets, and parse specials. */
  Hooks.once("ready", async () => {
    const version = game.modules.get(packageId).version;
    if (game.settings.get(packageId, "releaseMessage") !== version) {
      const content = `
        <div class="fxmaster-announcement" style="border:4px solid #4A90E2; border-radius:6px; padding:12px;">
          <h3 style="margin:0;">🎉Welcome to Gambit's FXMaster V7!</h3>
            <p style="font-size: 1em;">This release addresses some additional bugfixes. Please check out the <a href= "https://github.com/gambit07/fxmaster/releases/latest" target="_blank" style="color: #dd6b20; text-decoration: none; font-weight: bold;">Release Notes</a> for more detail. </p>
            <p style="font-size: 1em;">If you'd like to support my development time and get access to new Effects: <ul><li><span style="color: #a08332ff; text-decoration: none; font-weight: bold;">Sandstorm</span></li><li><span style="color: #74653fff; text-decoration: none; font-weight: bold;">Duststorm</span></li><li><span style="color: #73ffa9">Ghosts</span></li><li><span style="color: #ffd500ff">Sunlight</span></li><li><span style="color: #7f00ff">Magic Crystals</span></li><li><span style="color: #d5b60a">Fireflies</span></li><li><span style="color: #ffb7c5">Sakura Bloom</span></li><li><span style="color: #ffb7c5">Sakura Blossoms</span></li></ul><br/>Please consider supporting the project on <a href="https://patreon.com/GambitsLounge" target="_blank" style="color: #dd6b20; text-decoration: none; font-weight: bold;">Patreon</a>. This will give you access to the FXMaster+ module, now directly integrated with Foundry!</p>
          </div>
      `;
      ChatMessage.create({ content });
      game.settings.set(packageId, "releaseMessage", version);
    }

    CONFIG.RegionBehavior.sheetClasses[TYPE]["core.RegionBehaviorConfig"].cls = ParticleEffectsRegionBehaviorConfig;
    CONFIG.RegionBehavior.sheetClasses[FILTER_TYPE] = {
      "core.RegionBehaviorConfig": { cls: FilterRegionBehaviorConfig },
    };

    if (isEnabled()) await parseSpecialEffects();
  });

  /** On scene update: reconcile flags and refresh particles/filters/masks. */
  Hooks.on("updateScene", async (scene, data) => {
    if (scene !== canvas.scene) return;

    try {
      refreshSceneParticlesSuppressionMasks?.();
    } catch {}

    if (
      foundry.utils.hasProperty(data, `flags.${packageId}.effects`) ||
      foundry.utils.hasProperty(data, `flags.${packageId}.-=effects`)
    ) {
      if (isEnabled()) canvas.particleeffects?.drawParticleEffects?.({ soft: true });
      refreshSceneParticlesSuppressionMasks?.();
    }

    if (
      foundry.utils.hasProperty(data, `flags.${packageId}.filters`) ||
      foundry.utils.hasProperty(data, `flags.${packageId}.-=filters`)
    ) {
      if (isEnabled()) FilterEffectsSceneManager.instance.update();
    }

    if (data.active === true) scheduleOpenWindowsRefresh(true);

    if (data.width !== undefined || data.height !== undefined) {
      if (isEnabled()) {
        FilterEffectsSceneManager.instance.refreshViewMaskGeometry();
        try {
          canvas.filtereffects?.forceRegionMaskRefreshAll?.();
        } catch {}
        try {
          canvas.particleeffects?.refreshAboveSceneMask?.();
        } catch {}
        try {
          canvas.particleeffects?.refreshBelowTokensSceneMask?.();
        } catch {}
      }
    }
  });

  /** On camera pan: keep suppression and region masks aligned. */
  Hooks.on("canvasPan", () => {
    if (!isEnabled()) return;
    requestFilterSuppressionRefresh();
    requestRegionMaskRefreshAllDebounced();
    requestSceneParticlesSuppressionRefresh();
  });

  /** On camera zoom: keep suppression and region masks aligned. */
  Hooks.on("canvasZoom", () => {
    if (isEnabled()) {
      requestFilterSuppressionRefresh();
      requestRegionMaskRefreshAllDebounced();
      requestSceneParticlesSuppressionRefresh();
    }
  });

  /** On canvas drop of a SpecialEffect: create a looping video Tile at drop location. */
  Hooks.on("dropCanvasData", async (canvas, data) => {
    if (data.type !== "SpecialEffect") return;

    await new Promise((resolve) => {
      const vid = document.createElement("video");
      vid.addEventListener(
        "loadedmetadata",
        () => {
          data.width = vid.videoWidth * data.scale.x;
          data.height = vid.videoHeight * data.scale.y;
          resolve();
        },
        false,
      );
      vid.src = data.file;
    });

    const tileData = {
      alpha: 1,
      flags: {},
      height: data.height,
      hidden: false,
      texture: { src: data.file },
      locked: false,
      occlusion: { mode: 1, alpha: 0 },
      overHead: false,
      rotation: 0,
      tileSize: 100,
      video: { loop: true, autoplay: true, volume: 0 },
      width: data.width,
      x: data.x - 0.5 * data.width,
      y: data.y - 0.5 * data.height,
      z: 100,
    };
    ui.notifications.info(game.i18n.format("FXMASTER.Common.TileCreated", { effect: data.label }));
    canvas.scene.createEmbeddedDocuments("Tile", [tileData]).then(() => {});
  });

  /** On hotbar drop of a SpecialEffect: create a macro that spawns the effect. */
  Hooks.on("hotbarDrop", (hotbar, data) => {
    if (data.type !== "SpecialEffect") return;
    const macroCommand = SpecialEffectsLayer._createMacro(data);
    data.type = "Macro";
    data.data = {
      command: macroCommand,
      name: data.label,
      type: "script",
      author: game.user.id,
    };
  });

  /** When the Special Effects setting changes: reload data and refresh UIs. */
  Hooks.on("updateSetting", (setting) => {
    if (setting.key === "fxmaster.specialEffects") {
      parseSpecialEffects();
      Object.values(ui.windows).forEach((w) => {
        if (w instanceof SpecialEffectsManagement) {
          w.render(false);
        }
      });
    }
  });

  /** After rendering Scene Controls: visually mark active Effect tools. */
  Hooks.on("renderSceneControls", (controls) => {
    if (controls.control.name !== "effects") return;

    const hasParticles = !!Object.keys(canvas.scene.getFlag(packageId, "effects") || {}).length;
    const hasFilters = !!Object.keys(canvas.scene.getFlag(packageId, "filters") || {}).length;
    if (!hasParticles && !hasFilters) return;

    const particlesBtn = document.querySelector(`[data-tool="particle-effects"]`);
    const filtersBtn = document.querySelector(`[data-tool="filters"]`);

    if (hasParticles && particlesBtn) {
      particlesBtn.style.setProperty("background-color", "var(--color-warm-2)");
      particlesBtn.style.setProperty("border-color", "var(--color-warm-3)");
    }
    if (hasFilters && filtersBtn) {
      filtersBtn.style.setProperty("background-color", "var(--color-warm-2)");
      filtersBtn.style.setProperty("border-color", "var(--color-warm-3)");
    }
  });
};
