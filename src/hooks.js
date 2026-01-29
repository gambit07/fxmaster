import { packageId } from "./constants.js";
import { onSwitchParticleEffects, onUpdateParticleEffects, parseSpecialEffects } from "./utils.js";
import { isEnabled } from "./settings.js";
import { SpecialEffectsManagement } from "./special-effects/applications/special-effects-management.js";
import { SpecialEffectsLayer } from "./special-effects/special-effects-layer.js";
import { refreshSceneParticlesSuppressionMasks } from "./particle-effects/particle-effects-scene-manager.js";
import {
  ParticleEffectsRegionBehaviorConfig,
  SuppressSceneParticlesRegionBehaviorConfig,
} from "./particle-effects/particle-effects-region-config.js";
import {
  FilterEffectsRegionBehaviorConfig,
  SuppressSceneFiltersRegionBehaviorConfig,
} from "./filter-effects/filter-effects-region-config.js";
import { FilterEffectsSceneManager } from "./filter-effects/filter-effects-scene-manager.js";
import { coalesceNextFrame, getCssViewportMetrics, updateSceneControlHighlights } from "./utils.js";
import { SceneMaskManager } from "./common/base-effects-scene-manager.js";

/**
 * FXMaster Hooks
 * Registers Foundry VTT hooks and utilities to synchronize scene/region particle effects,
 * filter effects, suppression masks, and management UIs with canvas and scene lifecycle.
 */
const PARTICLE_TYPE = `${packageId}.particleEffectsRegion`;
const FILTER_TYPE = `${packageId}.filterEffectsRegion`;
const SUPPRESS_SCENE_FILTERS = `${packageId}.suppressSceneFilters`;
const SUPPRESS_SCENE_PARTICLES = `${packageId}.suppressSceneParticles`;

const _openPFx = new Set();
const _openFFx = new Set();
const _openAFx = new Set();

export const registerHooks = function () {
  let _fmResizeHandler = null;
  let _flResizeHandler = null;
  let _fxResizeHandler = null;

  const _sceneHasAnySceneFilters = () => {
    try {
      const f = canvas?.scene?.getFlag?.(packageId, "filters") ?? {};
      return !!f && Object.keys(f).length > 0;
    } catch {
      return false;
    }
  };

  const _sceneHasAnySceneParticles = () => {
    try {
      const e = canvas?.scene?.getFlag?.(packageId, "effects") ?? {};
      return !!e && Object.keys(e).length > 0;
    } catch {
      return false;
    }
  };

  const _sceneWantsBelowTokensFilters = () => {
    try {
      const infos = canvas?.scene?.getFlag?.(packageId, "filters") ?? {};
      for (const v of Object.values(infos)) {
        const bt = v?.options?.belowTokens;
        if (bt === true) return true;
        if (bt && typeof bt === "object" && "value" in bt && !!bt.value) return true;
      }
      return false;
    } catch {
      return false;
    }
  };

  const _sceneWantsBelowTokensParticles = () => {
    try {
      const infos = canvas?.scene?.getFlag?.(packageId, "effects") ?? {};
      for (const v of Object.values(infos)) {
        const bt = v?.options?.belowTokens;
        if (bt === true) return true;
        if (bt && typeof bt === "object" && "value" in bt && !!bt.value) return true;
      }
      return false;
    } catch {
      return false;
    }
  };

  const _regionWantsBelowTokensFilters = () => {
    try {
      const rm = canvas?.filtereffects?.regionMasks;
      if (!rm || !rm.size) return false;
      for (const entry of rm.values()) {
        for (const f of entry?.filters ?? []) {
          if (f?.__fxmBelowTokens) return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  };

  const _regionWantsBelowTokensParticles = () => {
    try {
      const re = canvas?.particleeffects?.regionEffects;
      if (!re || !re.size) return false;
      for (const entries of re.values()) {
        for (const e of entries ?? []) {
          const fx = e?.fx ?? e;
          if (fx?.__fxmBelowTokens) return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  };

  const requestFilterSuppressionRefresh = () => {
    if (isEnabled()) FilterEffectsSceneManager.instance.refreshSceneFilterSuppressionMasks();
  };

  const requestRegionMaskRefreshAll = () => {
    if (!isEnabled()) return;
    try {
      canvas.filtereffects?.forceRegionMaskRefreshAll?.();
    } catch {}
  };

  const requestSceneParticlesSuppressionRefresh = () => {
    try {
      refreshSceneParticlesSuppressionMasks?.();
    } catch {}
  };

  const requestTokenMaskRefresh = coalesceNextFrame(
    function requestTokenMaskRefresh() {
      if (!isEnabled()) return;

      const needFilterTokens = _sceneWantsBelowTokensFilters() || _regionWantsBelowTokensFilters();
      const needParticleTokens = _sceneWantsBelowTokensParticles() || _regionWantsBelowTokensParticles();

      if (needFilterTokens) {
        try {
          FilterEffectsSceneManager.instance.refreshSceneFilterSuppressionMasks();
        } catch {}

        try {
          canvas.filtereffects?.notifyTokensChanged?.();
        } catch {}
      }

      if (needParticleTokens) {
        try {
          refreshSceneParticlesSuppressionMasks?.();
        } catch {}

        try {
          canvas.particleeffects?.notifyTokensChanged?.();
        } catch {}
      }
    },
    { key: "fxm:token:maskRefresh" },
  );

  const pinEnvFilterArea = () => {
    const env = canvas?.environment;
    if (!env) return;

    const { rect: cssRect } = getCssViewportMetrics();
    const fa = env.filterArea instanceof PIXI.Rectangle ? env.filterArea : new PIXI.Rectangle();
    fa.copyFrom(cssRect);

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

  Hooks.on("renderParticleEffectsManagement", (app) => {
    _openPFx.add(app);
  });

  Hooks.on("closeParticleEffectsManagement", (app) => {
    _openPFx.delete(app);
  });

  Hooks.on("renderFilterEffectsManagement", (app) => {
    _openFFx.add(app);
  });

  Hooks.on("closeFilterEffectsManagement", (app) => {
    _openFFx.delete(app);
  });

  Hooks.on("renderApiEffectsManagement", (app) => {
    _openAFx.add(app);
  });

  Hooks.on("closeApiEffectsManagement", (app) => {
    _openAFx.delete(app);
  });

  const refreshOpenFxMasterWindows = ({ hard = true } = {}) => {
    for (const app of [..._openPFx, ..._openFFx, ..._openAFx]) {
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

  const scheduleOpenWindowsRefresh = coalesceNextFrame(
    function scheduleOpenWindowsRefresh(hard = true) {
      refreshOpenFxMasterWindows({ hard });
    },
    { key: "fxm:openWindowsRefresh" },
  );

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

  Hooks.on(`${packageId}.switchParticleEffect`, onSwitchParticleEffects);
  Hooks.on(`${packageId}.updateParticleEffects`, onUpdateParticleEffects);

  Hooks.on("preDeleteRegion", (regionDoc) => {
    try {
      canvas.particleeffects?.destroyRegionParticleEffects?.(regionDoc.id);
    } catch {}
    try {
      canvas.filtereffects?.destroyRegionFilterEffects?.(regionDoc.id);
    } catch {}
  });

  Hooks.on("createRegion", (regionDoc) => {
    if (regionDoc?.parent !== canvas.scene) return;

    const placeable = canvas.regions.get(regionDoc.id);
    if (placeable) {
      if (isEnabled() && regionDoc?.behaviors?.some((b) => b.type === PARTICLE_TYPE && !b.disabled)) {
        canvas.particleeffects?.drawRegionParticleEffects?.(placeable);
      }
      const hasRegionFilterBehavior = regionDoc?.behaviors?.some((b) => b.type === FILTER_TYPE && !b.disabled);
      if (isEnabled() && hasRegionFilterBehavior) {
        canvas.filtereffects?.drawRegionFilterEffects?.(placeable);
      }
    }

    requestSceneParticlesSuppressionRefresh();
    requestFilterSuppressionRefresh();

    const hasSuppression = regionDoc?.behaviors?.some(
      (b) => (b.type === "suppressWeather" || b.type === SUPPRESS_SCENE_PARTICLES) && !b.disabled,
    );
    if (hasSuppression) requestRedrawAllRegionParticles();
  });

  Hooks.on("deleteRegion", (regionDoc) => {
    if (regionDoc?.parent !== canvas.scene) return;

    try {
      canvas.particleeffects?.destroyRegionParticleEffects?.(regionDoc.id);
    } catch {}
    try {
      canvas.filtereffects?.destroyRegionFilterEffects?.(regionDoc.id);
    } catch {}

    requestSceneParticlesSuppressionRefresh();
    requestFilterSuppressionRefresh();
    if (isEnabled()) {
      try {
        canvas.filtereffects?.forceRegionMaskRefreshAll?.();
      } catch {}
    }

    const hadSuppression = regionDoc?.behaviors?.some(
      (b) => (b.type === "suppressWeather" || b.type === SUPPRESS_SCENE_PARTICLES) && !b.disabled,
    );
    if (hadSuppression) requestRedrawAllRegionParticles();
  });

  Hooks.on("updateRegion", (regionDoc) => {
    if (regionDoc?.parent !== canvas.scene) return;

    const hasFxmasterBehavior = regionDoc?.behaviors?.some(
      (b) =>
        (b.type === PARTICLE_TYPE || b.type === "suppressWeather" || b?.type === SUPPRESS_SCENE_PARTICLES) &&
        !b.disabled,
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

    requestSceneParticlesSuppressionRefresh();
    requestFilterSuppressionRefresh();

    const hasSuppression = regionDoc?.behaviors?.some(
      (b) => (b.type === "suppressWeather" || b.type === SUPPRESS_SCENE_PARTICLES) && !b.disabled,
    );
    if (hasSuppression) requestRedrawAllRegionParticles();
  });

  Hooks.on("refreshRegion", (placeable) => {
    if (placeable?.document?.parent !== canvas.scene) return;
    if (isEnabled()) {
      canvas.filtereffects?.forceRegionMaskRefresh?.(placeable.id);
      canvas.particleeffects?.forceRegionMaskRefresh?.(placeable.id);
    }
  });

  Hooks.on("createRegionBehavior", (behaviorDoc) => {
    const t = behaviorDoc?.type;
    const regionDoc = behaviorDoc?.parent;
    if (!t || regionDoc?.parent !== canvas.scene) return;
    const placeable = canvas.regions.get(regionDoc.id);
    if (!placeable) return;

    if (t === "suppressWeather" || t === SUPPRESS_SCENE_PARTICLES) {
      requestSceneParticlesSuppressionRefresh();
      try {
        canvas.particleeffects?.forceRegionMaskRefreshAll?.();
      } catch {}
    }
    if (isEnabled() && (t === "suppressWeather" || t === SUPPRESS_SCENE_FILTERS)) {
      requestFilterSuppressionRefresh();
    }

    if (isEnabled() && t === PARTICLE_TYPE) {
      canvas.particleeffects?.drawRegionParticleEffects?.(placeable, { soft: false });
    } else if (isEnabled() && t === FILTER_TYPE) {
      canvas.filtereffects?.drawRegionFilterEffects?.(placeable, { soft: false });
    }
  });

  Hooks.on("updateRegionBehavior", (behaviorDoc) => {
    const t = behaviorDoc?.type;
    const regionDoc = behaviorDoc?.parent;
    if (!t || regionDoc?.parent !== canvas.scene) return;
    const placeable = canvas.regions.get(regionDoc.id);
    if (!placeable) return;

    if (t === "suppressWeather" || t === SUPPRESS_SCENE_PARTICLES) {
      requestSceneParticlesSuppressionRefresh();
      try {
        canvas.particleeffects?.forceRegionMaskRefreshAll?.();
      } catch {}
    }
    if (isEnabled() && (t === "suppressWeather" || t === SUPPRESS_SCENE_FILTERS)) {
      requestFilterSuppressionRefresh();
    }

    if (isEnabled() && t === PARTICLE_TYPE) {
      canvas.particleeffects?.drawRegionParticleEffects?.(placeable, { soft: false });
    } else if (isEnabled() && t === FILTER_TYPE) {
      canvas.filtereffects?.drawRegionFilterEffects?.(placeable, { soft: false });
    }
  });

  Hooks.on("deleteRegionBehavior", (behaviorDoc) => {
    const t = behaviorDoc?.type;
    const regionDoc = behaviorDoc?.parent;
    if (!t || regionDoc?.parent !== canvas.scene) return;
    const placeable = canvas.regions.get(regionDoc.id);
    if (!placeable) return;

    if (t === "suppressWeather" || t === SUPPRESS_SCENE_PARTICLES) {
      requestSceneParticlesSuppressionRefresh();
      try {
        canvas.particleeffects?.forceRegionMaskRefreshAll?.();
      } catch {}
    }
    if (isEnabled() && (t === "suppressWeather" || t === SUPPRESS_SCENE_FILTERS)) {
      requestFilterSuppressionRefresh();
    }

    if (isEnabled() && t === PARTICLE_TYPE) {
      canvas.particleeffects?.drawRegionParticleEffects?.(placeable, { soft: false });
    } else if (isEnabled() && t === FILTER_TYPE) {
      canvas.filtereffects?.drawRegionFilterEffects?.(placeable, { soft: false });
    }
  });

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
      if (_fxResizeHandler && globalThis.canvas?.app?.renderer) {
        globalThis.canvas.app.renderer.off("resize", _fxResizeHandler);
      }
    } catch {}
    _fmResizeHandler = null;
    _flResizeHandler = null;
    _fxResizeHandler = null;

    try {
      unbind();
    } catch {}
  });

  Hooks.on("activateScene", () => {
    scheduleOpenWindowsRefresh(true);
    if (isEnabled()) {
      requestSceneParticlesSuppressionRefresh();
      requestRegionMaskRefreshAll();
      try {
        canvas.particleeffects?.refreshAboveSceneMask?.();
      } catch {}
    }
  });

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
            if (_sceneHasAnySceneParticles()) requestSceneParticlesSuppressionRefresh();
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
        if (_sceneHasAnySceneParticles()) requestSceneParticlesSuppressionRefresh();
      } catch {}
      try {
        canvas.particleeffects?.forceRegionMaskRefreshAll?.();
      } catch {}
    }

    if (isEnabled()) {
      requestSceneParticlesSuppressionRefresh();
      requestRegionMaskRefreshAll();
      try {
        canvas.particleeffects?.refreshAboveSceneMask?.();
      } catch {}
    }

    try {
      const needFilterTokens = _sceneWantsBelowTokensFilters() || _regionWantsBelowTokensFilters();
      const needParticleTokens = _sceneWantsBelowTokensParticles() || _regionWantsBelowTokensParticles();
      if (needFilterTokens) SceneMaskManager.instance.refreshSync?.("filters");
      if (needParticleTokens) SceneMaskManager.instance.refreshSync?.("particles");
    } catch {}

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

  Hooks.once("ready", async () => {
    const version = game.modules.get(packageId).version;
    if (game.settings.get(packageId, "releaseMessage") !== version) {
      const content = `
        <div class="fxmaster-announcement" style="border:4px solid #4A90E2; border-radius:6px; padding:12px;">
          <h3 style="margin:0;">🎉Welcome to Gambit's FXMaster V7.3!</h3>
            <p style="font-size: 1em;">This is a major release that brings some fun and functional usability enhancements! The major features are new Top Down modes for various particle effects, Directional Movement options for Animal particle effects, a new API Effects UI Manager, the ability to hide specific effects, and much more! Please check out the <a href= "https://github.com/gambit07/fxmaster/releases/latest" target="_blank" style="color: #dd6b20; text-decoration: none; font-weight: bold;">Release Notes</a> for more detail. </p>
            <p style="font-size: 1em;">If you'd like to support my development time and get access to the <a href="https://foundryvtt.com/packages/fxmaster-plus" target="_blank" style="color: #CC66CC; text-decoration: none; font-weight: bold;">Gambit's FXMaster+</a>, <a href="https://foundryvtt.com/packages/gambitsAssetPreviewer" target="_blank" style="color: #CC66CC; text-decoration: none; font-weight: bold;">Gambit's Asset Previewer</a>, and <a href="https://foundryvtt.com/packages/gambitsImageViewer" target="_blank" style="color: #CC66CC; text-decoration: none; font-weight: bold;">Gambit's Image Viewer</a> modules, please consider supporting the project on <a href="https://patreon.com/GambitsLounge" target="_blank" style="color: #dd6b20; text-decoration: none; font-weight: bold;">Patreon</a>.</p><p>FXMaster+ Effects: <ul><li><span style="color: #0ada64; text-decoration: none; font-weight: bold;">Glitch</span></li><li><span style="color: #017371; text-decoration: none; font-weight: bold;">Fish</span></li><li><span style="color: #3bd1ffff; text-decoration: none; font-weight: bold;">Ice</span></li><li><span style="color: #a08332ff; text-decoration: none; font-weight: bold;">Sandstorm</span></li><li><span style="color: #74653fff; text-decoration: none; font-weight: bold;">Duststorm</span></li><li><span style="color: #53c57e; text-decoration: none; font-weight: bold;">Ghosts</span></li><li><span style="color: rgb(211, 176, 0); text-decoration: none; font-weight: bold;">Sunlight</span></li><li><span style="color: #7f00ff; text-decoration: none; font-weight: bold;">Magic Crystals</span></li><li><span style="color: #d5b60a; text-decoration: none; font-weight: bold;">Fireflies</span></li><li><span style="color: #ffb7c5; text-decoration: none; font-weight: bold;">Sakura Bloom</span></li><li><span style="color: #ffb7c5; text-decoration: none; font-weight: bold;">Sakura Blossoms</span></li><li><span style="text-decoration: none; font-weight: bold;">And add your own Particle Effects!</span></li></ul></p><p>If you have any questions about the module feel free to join the <a href= "https://discord.gg/YvxHrJ4tVu" target="_blank" style="color: #4e5d94; text-decoration: none; font-weight: bold;">Discord</a>!
          </div>
      `;
      ChatMessage.create({ content });
      game.settings.set(packageId, "releaseMessage", version);
    }

    CONFIG.RegionBehavior.sheetClasses[PARTICLE_TYPE]["core.RegionBehaviorConfig"].cls =
      ParticleEffectsRegionBehaviorConfig;
    CONFIG.RegionBehavior.sheetClasses[SUPPRESS_SCENE_PARTICLES]["core.RegionBehaviorConfig"].cls =
      SuppressSceneParticlesRegionBehaviorConfig;
    CONFIG.RegionBehavior.sheetClasses[FILTER_TYPE]["core.RegionBehaviorConfig"].cls =
      FilterEffectsRegionBehaviorConfig;
    CONFIG.RegionBehavior.sheetClasses[SUPPRESS_SCENE_FILTERS]["core.RegionBehaviorConfig"].cls =
      SuppressSceneFiltersRegionBehaviorConfig;

    if (isEnabled()) await parseSpecialEffects();
  });

  Hooks.on("updateScene", async (scene, data) => {
    if (scene !== canvas.scene) return;

    const flat = foundry.utils.flattenObject(data ?? {});

    const effectsChanged = Object.keys(flat).some(
      (k) => k.startsWith(`flags.${packageId}.effects`) || k.startsWith(`flags.${packageId}.-=effects`),
    );

    const filtersChanged = Object.keys(flat).some(
      (k) => k.startsWith(`flags.${packageId}.filters`) || k.startsWith(`flags.${packageId}.-=filters`),
    );

    if (effectsChanged) {
      if (isEnabled()) canvas.particleeffects?.drawParticleEffects?.({ soft: true });
      requestSceneParticlesSuppressionRefresh();
    }

    if (filtersChanged) {
      if (isEnabled()) {
        FilterEffectsSceneManager.instance.update();
        ensurePinned();
      }
    }

    if (effectsChanged || filtersChanged || data.active === true) updateSceneControlHighlights();

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
        requestSceneParticlesSuppressionRefresh();
        requestFilterSuppressionRefresh();
      }
    }
  });

  const requestViewMaskRefresh = coalesceNextFrame(
    function requestViewMaskRefresh() {
      if (!isEnabled()) return;

      if (_sceneHasAnySceneFilters()) requestFilterSuppressionRefresh();
      if (_sceneHasAnySceneParticles()) requestSceneParticlesSuppressionRefresh();
    },
    { key: "fxm:view:maskRefresh" },
  );

  Hooks.on("canvasPan", () => requestViewMaskRefresh());
  Hooks.on("canvasZoom", () => requestViewMaskRefresh());

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

  const scheduleSceneControlHighlights = coalesceNextFrame(
    function scheduleSceneControlHighlights() {
      updateSceneControlHighlights();
    },
    { key: "fxm:sceneControls:highlights" },
  );

  Hooks.on("renderSceneControls", () => {
    scheduleSceneControlHighlights();
  });

  Hooks.on("updateScene", (scene, change) => {
    if (scene !== canvas?.scene) return;

    const f = change?.flags?.[packageId];
    if (!f) return;

    if (!("effects" in f) && !("filters" in f)) return;

    scheduleSceneControlHighlights();
  });

  Hooks.on("canvasReady", () => scheduleSceneControlHighlights());
  Hooks.on("activateScene", () => scheduleSceneControlHighlights());
};
