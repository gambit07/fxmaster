/**
 * FilterEffectsSceneManager
 * -------------------------
 * Manages scene-scoped filter runtimes for FXMaster.
 * - Creates, updates, and destroys scene filter instances from scene flags.
 * - Maintains suppression masks and viewport uniforms.
 * - Exposes live runtime lookups for the global compositor stack.
 */
import { packageId } from "../constants.js";
import { logger } from "../logger.js";
import {
  resetFlag,
  deletionUpdate,
  _belowTokensEnabled,
  _belowTilesEnabled,
  _belowForegroundEnabled,
  applyMaskUniformsToFilters,
  coalesceNextFrame,
  getCssViewportMetrics,
  getSnappedCameraCss,
  snappedStageMatrix,
  cameraMatrixChanged,
  getSceneDarknessLevel,
  isEffectActiveForSceneDarkness,
  isEffectActiveForCurrentOrVisibleCanvasLevel,
  getCanvasLiveLevelSurfaceState,
  normalizeSceneLevelSelection,
  ensureSingleSceneLevelSelection,
} from "../utils.js";

import { SceneMaskManager } from "../common/base-effects-scene-manager.js";
import {
  buildSceneEffectUid,
  getOrderedEnabledEffectRenderRows,
  promoteEffectStackUids,
} from "../common/effect-stack.js";

function isBelowTokensFilter(f) {
  return _belowTokensEnabled(f?.__fxmBelowTokens ?? f?.options?.belowTokens);
}

function isBelowTilesFilter(f) {
  return _belowTilesEnabled(f?.__fxmBelowTiles ?? f?.options?.belowTiles);
}

export class FilterEffectsSceneManager {
  constructor() {
    this.filters = {};
    this._dyingFilters = new Set();
    this._ticker = false;
    this._lastRegionsMatrix = null;
    this._lastCamFrac = undefined;
    this.stackEntries = new Map();
    this._transientStackRows = new Map();
    this._lastKnownOrder = new Map();
    this._lastSceneDarknessSignature = "";
    this._lastSuppressionOverlaySignature = "";
    this._lastDarknessLevel = getSceneDarknessLevel();

    /** @type {Function|null} */
    this._coalescedBindSceneMask = null;
  }

  static get instance() {
    if (!this.#instance) this.#instance = new this();
    return this.#instance;
  }
  static #instance;

  static get container() {
    return globalThis.canvas?.environment ?? null;
  }

  /**
   * Build a signature describing which scene-scoped filters are currently active at the supplied darkness level.
   *
   * @param {number} darknessLevel
   * @returns {string}
   */
  #buildSceneDarknessActivationSignature(darknessLevel = getSceneDarknessLevel()) {
    const infos = canvas?.scene?.getFlag(packageId, "filters") ?? {};
    return Object.entries(infos)
      .filter(([, info]) => !!info && typeof info === "object")
      .map(([id, info]) => {
        const options = normalizeSceneLevelSelection(
          info?.options && typeof info.options === "object" ? { ...info.options } : {},
          canvas?.scene,
        );
        const levelsKey = Array.isArray(options?.levels) ? options.levels.map(String).sort().join(",") : "*";
        const active =
          isEffectActiveForSceneDarkness(options, darknessLevel) &&
          isEffectActiveForCurrentOrVisibleCanvasLevel(options, canvas?.scene);
        return `${id}:${active ? 1 : 0}:${levelsKey}`;
      })
      .sort()
      .join("|");
  }

  async activate() {
    await this.update({ skipFading: true });
    if (!this._ticker) {
      const PRIO = PIXI.UPDATE_PRIORITY?.HIGH ?? 25;
      try {
        canvas.app.ticker.add(this.#animate, this, PRIO);
      } catch {
        canvas.app.ticker.add(this.#animate, this);
      }
      this._ticker = true;
    }

    this.#refreshSceneFilterSuppressionMasks(true);
  }

  async clear() {
    const env = this.constructor.container;
    const managed = Object.values(this.filters);
    const dying = [...this._dyingFilters];

    const promises = [...managed, ...dying].map((f) => f.stop?.({ skipFading: true }));
    await Promise.all(promises);

    try {
      if (env?.filters?.length) {
        const set = new Set([...managed, ...dying]);
        env.filters = env.filters.filter((f) => !set.has(f));
      }
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    this.filters = {};
    this.stackEntries.clear();
    this._transientStackRows.clear();
    this._lastKnownOrder.clear();
    this._dyingFilters.clear();
    this._lastSuppressionOverlaySignature = "";

    try {
      canvas?.app?.ticker?.remove?.(this.#animate, this);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    this._ticker = false;

    try {
      SceneMaskManager.instance.setBelowTokensNeeded?.("filters", false);
      SceneMaskManager.instance.setBelowTilesNeeded?.("filters", false);
      SceneMaskManager.instance.setKindActive?.("filters", false);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  async update({ skipFading = false } = {}) {
    if (!canvas.scene) return;

    const darknessLevel = getSceneDarknessLevel();
    const filterInfos = Object.fromEntries(
      Object.entries(canvas.scene.getFlag(packageId, "filters") ?? {}).flatMap(([id, info]) => {
        if (!info || typeof info !== "object") return [];
        if (!(info.type in CONFIG.fxmaster.filterEffects)) {
          logger.warn(game.i18n.format("FXMASTER.Filters.TypeErrors.TypeUnknown", { id, type: info.type }));
          return [];
        }
        const options = normalizeSceneLevelSelection(
          info.options && typeof info.options === "object" ? { ...info.options } : {},
          canvas?.scene,
        );
        if (!isEffectActiveForSceneDarkness(options, darknessLevel)) return [];
        if (!isEffectActiveForCurrentOrVisibleCanvasLevel(options, canvas?.scene)) return [];
        return [[id, { ...info, options }]];
      }),
    );

    const createKeys = Object.keys(filterInfos).filter((k) => !(k in this.filters));
    const updateKeys = Object.keys(filterInfos).filter((k) => k in this.filters);
    const deleteKeys = Object.keys(this.filters).filter((k) => !(k in filterInfos));

    for (const key of createKeys) {
      const { type, options } = filterInfos[key];
      const filter = new CONFIG.fxmaster.filterEffects[type](options, key);
      filter.__fxmBelowTokens = _belowTokensEnabled(options?.belowTokens);
      filter.__fxmBelowTiles = _belowTilesEnabled(options?.belowTiles);
      filter.__fxmBelowForeground = _belowForegroundEnabled(options?.belowForeground);
      filter.__fxmLevels = options?.levels;
      filter.__fxmOptions = options;
      this.filters[key] = filter;
      filter.play?.({ ...(options ?? {}), skipFading: true });

      try {
        const strength = filter?.uniforms?.strength;
        if (!skipFading && typeof strength === "number") {
          filter.fadeUniformTo?.("strength", strength, { from: 0, durationMs: 3000 });
        }
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    for (const key of updateKeys) {
      const { options } = filterInfos[key];
      const f = this.filters[key];
      f.configure?.(options);
      f.__fxmBelowTokens = _belowTokensEnabled(options?.belowTokens);
      f.__fxmBelowTiles = _belowTilesEnabled(options?.belowTiles);
      f.__fxmBelowForeground = _belowForegroundEnabled(options?.belowForeground);
      f.__fxmLevels = options?.levels;
      f.__fxmOptions = options;
    }

    for (const key of deleteKeys) {
      const f = this.filters[key];
      delete this.filters[key];
      if (!f) continue;

      const uid = buildSceneEffectUid("filter", key);
      const renderIndex = this._lastKnownOrder.get(uid) ?? Number.MAX_SAFE_INTEGER;
      this._transientStackRows.set(uid, {
        uid,
        kind: "filter",
        scope: "scene",
        renderIndex,
        filter: f,
        options: f?.__fxmOptions ?? f?.options ?? null,
        levels: f?.__fxmLevels ?? f?.__fxmOptions?.levels ?? f?.options?.levels ?? null,
      });

      this._dyingFilters.add(f);
      Promise.resolve(f.stop?.({ skipFading }))
        .catch(() => {})
        .finally(() => {
          this.#removeFromEnvFilters([f]);
          try {
            f.destroy?.();
          } catch (err) {
            logger.debug("FXMaster:", err);
          }
          this._dyingFilters.delete(f);
          this._transientStackRows.delete(uid);
        });
    }

    this._lastSceneDarknessSignature = this.#buildSceneDarknessActivationSignature(darknessLevel);
    this.#syncStackEntries();
    this.#refreshSceneFilterSuppressionMasks(true);
  }

  refreshViewMaskGeometry() {
    this.#refreshSceneFilterSuppressionMasks(true);
  }

  /**
   * Refresh scene-filter suppression masks.
   *
   * Suppression-active scenes use the synchronous path so the scene allow-mask and region masks stay aligned while the camera moves.
   *
   * @returns {void}
   */
  refreshSceneFilterSuppressionMasks() {
    const r = canvas?.app?.renderer;
    const hiDpi = (r?.resolution ?? window.devicePixelRatio ?? 1) !== 1;
    const hasSuppression = !!SceneMaskManager.instance.hasSuppressionRegions?.("filters");
    const forceSync = hasSuppression || ((this.#anyBelowTokens() || this.#anyBelowTiles()) && hiDpi);
    this.#refreshSceneFilterSuppressionMasks(forceSync);
  }

  async addFilter(name, type, options) {
    const scene = canvas.scene;
    if (!scene) return;

    name = name ?? foundry.utils.randomID();
    const normalizedOptions = ensureSingleSceneLevelSelection(
      options && typeof options === "object" ? { ...options } : {},
      scene,
    );

    await scene.setFlag(packageId, "filters", { [name]: { type, options: normalizedOptions } });
    await promoteEffectStackUids([buildSceneEffectUid("filter", name)], scene);
  }

  async removeFilter(name) {
    await canvas.scene?.setFlag(packageId, "filters", deletionUpdate(name));
  }

  async removeAll() {
    await canvas.scene?.unsetFlag(packageId, "filters");
  }

  async switch(name, type, options) {
    if (!canvas.scene) return;
    const infos = canvas.scene.getFlag(packageId, "filters") ?? {};
    if (infos[name]) return this.removeFilter(name);
    return this.addFilter(name, type, options);
  }

  async setFilters(arr) {
    const scene = canvas.scene;
    if (!scene) return;

    const infos = Object.fromEntries(
      arr.map((fi) => {
        const info = fi && typeof fi === "object" ? { ...fi } : {};
        info.options = ensureSingleSceneLevelSelection(
          info.options && typeof info.options === "object" ? { ...info.options } : {},
          scene,
        );
        return [foundry.utils.randomID(), info];
      }),
    );

    await resetFlag(scene, "filters", infos);
    await promoteEffectStackUids(
      Object.keys(infos).map((id) => buildSceneEffectUid("filter", id)),
      scene,
    );
  }

  /**
   * Return the live filter runtime for a stored stack uid.
   *
   * @param {string} uid
   * @returns {PIXI.Filter|null}
   */
  getStackFilter(uid) {
    return this.stackEntries.get(uid)?.filter ?? this._transientStackRows.get(uid)?.filter ?? null;
  }

  /**
   * Return transient stack rows that should continue rendering while a filter fades out.
   *
   * @returns {Array<{ uid: string, kind: "filter", scope: "scene", renderIndex: number, options?: object|null, levels?: unknown }>}
   */
  getTransientStackRows() {
    return Array.from(this._transientStackRows.values(), ({ uid, kind, scope, renderIndex, options, levels }) => ({
      uid,
      kind,
      scope: scope ?? "scene",
      renderIndex,
      options,
      levels,
    }));
  }

  /**
   * Rebuild the runtime uid lookup for scene filters.
   *
   * @returns {void}
   */
  #syncStackEntries() {
    this.stackEntries.clear();
    for (const [effectId, filter] of Object.entries(this.filters)) {
      const uid = buildSceneEffectUid("filter", effectId);
      this.stackEntries.set(uid, {
        uid,
        filter,
        options: filter?.__fxmOptions ?? filter?.options ?? null,
        levels: filter?.__fxmLevels ?? filter?.__fxmOptions?.levels ?? filter?.options?.levels ?? null,
      });
    }

    const orderedRows = getOrderedEnabledEffectRenderRows(canvas.scene);
    for (let index = 0; index < orderedRows.length; index++) {
      const uid = orderedRows[index]?.uid;
      if (!this.stackEntries.has(uid)) continue;
      this._lastKnownOrder.set(uid, index);
    }
  }

  /**
   * Bind the current scene suppression masks into uniforms for all active and fading filters. If the base mask is missing or destroyed, a synchronous refresh is attempted before binding.
   * @private
   */
  #bindSuppressMaskUniforms() {
    const filtersArr = [...Object.values(this.filters), ...this._dyingFilters];
    if (!filtersArr.length) return;

    const anyBelow = filtersArr.some((f) => isBelowTokensFilter(f));
    const anyBelowTiles = filtersArr.some((f) => isBelowTilesFilter(f));

    let { base, cutoutTokens, cutoutTiles, cutoutCombined, tokens, soft } =
      SceneMaskManager.instance.getMasks("filters");

    if (!base || base.destroyed) {
      try {
        SceneMaskManager.instance.refreshSync("filters");
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      ({ base, cutoutTokens, cutoutTiles, cutoutCombined, tokens, soft } =
        SceneMaskManager.instance.getMasks("filters"));
    }

    if (!base || base.destroyed) {
      for (const f of filtersArr) {
        const u = f?.uniforms || {};
        if ("maskSampler" in u) u.maskSampler = PIXI.Texture.EMPTY;
        if ("hasMask" in u) u.hasMask = 0.0;
        if ("maskReady" in u) u.maskReady = 0.0;
        if ("maskSoft" in u) u.maskSoft = 0.0;
        if ("tokenSampler" in u) u.tokenSampler = PIXI.Texture.EMPTY;
        if ("hasTokenMask" in u) u.hasTokenMask = 0.0;
      }
      return;
    }

    const { cssW, cssH, deviceToCss, rect: cssFA } = getCssViewportMetrics();

    applyMaskUniformsToFilters(filtersArr, {
      baseMaskRT: base,
      cutoutTokensRT: anyBelow ? cutoutTokens : null,
      cutoutTilesRT: anyBelowTiles ? cutoutTiles : null,
      cutoutCombinedRT: anyBelow && anyBelowTiles ? cutoutCombined : null,
      tokensMaskRT: anyBelow ? tokens : null,
      cssW,
      cssH,
      deviceToCss,
      maskSoft: !!soft,
      filterAreaRect: cssFA,
    });
  }

  /**
   * Refresh and bind scene suppression masks for scene-wide filter effects.
   *
   * {@link SceneMaskManager.refresh} is animation-frame coalesced and may destroy and recreate render textures when it runs. For asynchronous refreshes, uniform binding is deferred until the next animation frame to avoid referencing textures that are replaced during refresh.
   *
   * @param {boolean} [sync=false]
   * @private
   */
  #applySuppressMaskToFilters(sync = false) {
    const filtersArr = [...Object.values(this.filters), ...this._dyingFilters];
    const hasAny = filtersArr.length > 0;
    const anyBelow = hasAny ? filtersArr.some((f) => isBelowTokensFilter(f)) : false;
    const anyBelowTiles = hasAny ? filtersArr.some((f) => isBelowTilesFilter(f)) : false;

    try {
      SceneMaskManager.instance.setKindActive?.("filters", hasAny);
      SceneMaskManager.instance.setBelowTokensNeeded?.("filters", anyBelow);
      SceneMaskManager.instance.setBelowTilesNeeded?.("filters", anyBelowTiles);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    if (!hasAny) return;

    try {
      const r = canvas?.app?.renderer;
      const hiDpi = (r?.resolution ?? window.devicePixelRatio ?? 1) !== 1;

      if (sync || ((anyBelow || anyBelowTiles) && hiDpi)) {
        SceneMaskManager.instance.refreshSync("filters");
        this.#bindSuppressMaskUniforms();
      } else {
        SceneMaskManager.instance.refresh("filters");
        this._coalescedBindSceneMask ??= coalesceNextFrame(
          () => {
            try {
              this.#bindSuppressMaskUniforms();
            } catch (err) {
              logger?.error?.(err);
            }
          },
          { key: "fxm:bindFilterSceneMasks" },
        );
        this._coalescedBindSceneMask();
      }
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  #refreshSceneFilterSuppressionMasks(sync = false) {
    const hasAny = Object.keys(this.filters).length > 0 || this._dyingFilters.size > 0;
    if (hasAny) this.#applySuppressMaskToFilters(sync);
    else {
      try {
        SceneMaskManager.instance.setBelowTokensNeeded?.("filters", false);
        SceneMaskManager.instance.setBelowTilesNeeded?.("filters", false);
        SceneMaskManager.instance.setKindActive?.("filters", false);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    const M = snappedStageMatrix();
    if (!M) return;
    this._lastRegionsMatrix = { a: M.a, b: M.b, c: M.c, d: M.d, tx: M.tx, ty: M.ty };
  }

  #removeFromEnvFilters(filtersToRemove = []) {
    const env = this.constructor.container;
    if (!env?.filters?.length) return;
    const set = new Set(filtersToRemove);
    env.filters = env.filters.filter((f) => !set.has(f));
  }

  #anyBelowTokens() {
    return [...Object.values(this.filters), ...this._dyingFilters].some((f) => isBelowTokensFilter(f));
  }

  #anyBelowTiles() {
    return [...Object.values(this.filters), ...this._dyingFilters].some((f) => isBelowTilesFilter(f));
  }

  #animate() {
    for (const f of Object.values(this.filters)) f.step?.();

    try {
      const all = [...Object.values(this.filters), ...this._dyingFilters];
      for (const f of all) {
        if (typeof f?.lockViewport === "function") {
          f.lockViewport({ setDeviceToCss: false, setCamFrac: true });
        }
      }
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    try {
      const darknessLevel = getSceneDarknessLevel();
      this._lastDarknessLevel = darknessLevel;
      const sceneSignature = this.#buildSceneDarknessActivationSignature(darknessLevel);
      if (sceneSignature !== this._lastSceneDarknessSignature) {
        this._lastSceneDarknessSignature = sceneSignature;
        void this.update();
      }
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    const M = snappedStageMatrix();
    if (!M) return;

    const L = this._lastRegionsMatrix;
    const changed = cameraMatrixChanged(M, L);
    const hasSuppression = !!SceneMaskManager.instance.hasSuppressionRegions?.("filters");
    const overlayState = hasSuppression ? getCanvasLiveLevelSurfaceState() : null;
    const overlaySignature = overlayState?.key ?? "";
    const overlayChanged =
      hasSuppression && (overlayState?.forceRefresh || overlaySignature !== this._lastSuppressionOverlaySignature);

    if (changed || overlayChanged) {
      this.#refreshSceneFilterSuppressionMasks(true);
    }

    this._lastSuppressionOverlaySignature = overlaySignature;

    try {
      const anyBelowTokens = this.#anyBelowTokens();
      const anyBelowTiles = this.#anyBelowTiles();
      if (!anyBelowTokens && !anyBelowTiles) return;

      const r = canvas?.app?.renderer;
      const res = r?.resolution || window.devicePixelRatio || 1;
      const { txCss, tyCss } = getSnappedCameraCss();

      const fxFrac = (((txCss * res) % 1) + 1) % 1;
      const fyFrac = (((tyCss * res) % 1) + 1) % 1;

      if (!this._lastCamFrac) this._lastCamFrac = { x: fxFrac, y: fyFrac };

      /**
       * Sub-pixel threshold for token-mask repaints.
       *
       * Camera movements smaller than roughly one percent of a device pixel do not trigger a repaint. This avoids unnecessary sprite allocation churn during smooth panning.
       */
      const SUB_PIXEL_THRESHOLD = 0.01;
      const fracMoved =
        Math.abs(fxFrac - this._lastCamFrac.x) > SUB_PIXEL_THRESHOLD ||
        Math.abs(fyFrac - this._lastCamFrac.y) > SUB_PIXEL_THRESHOLD;

      if (!changed && fracMoved) {
        SceneMaskManager.instance.refreshTokensSync?.();
      }

      this._lastCamFrac.x = fxFrac;
      this._lastCamFrac.y = fyFrac;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }
}
