/**
 * FilterEffectsSceneManager
 * -------------
 * Manages scene-wide post-processing filters for FXMaster.
 * - Attaches scene filters to canvas.environment
 * - Clamps filter effect to the scene rectangle via an allow-mask render texture.
 * - Handles create/update/delete with fade-out, and keeps masks in sync with camera.
 */

import { packageId } from "../constants.js";
import { logger } from "../logger.js";
import {
  resetFlag,
  deletionUpdate,
  applyMaskUniformsToFilters,
  coalesceNextFrame,
  getCssViewportMetrics,
  getSnappedCameraCss,
  snappedStageMatrix,
  cameraMatrixChanged,
} from "../utils.js";

import { SceneMaskManager } from "../common/base-effects-scene-manager.js";

function isBelowTokensFilter(f) {
  const v = f?.__fxmBelowTokens ?? f?.options?.belowTokens;
  if (v === true) return true;
  if (v && typeof v === "object" && "value" in v) return !!v.value;
  return !!v;
}

export class FilterEffectsSceneManager {
  constructor() {
    this.filters = {};
    this._dyingFilters = new Set();
    this._ticker = false;
    this._lastRegionsMatrix = null;
    this._lastCamFrac = undefined;

    /** @type {Function|null} */
    this._coalescedBindSceneMask = null;
  }

  static get instance() {
    if (!this.#instance) this.#instance = new this();
    return this.#instance;
  }
  static #instance;

  static get container() {
    return canvas.environment;
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
    this._dyingFilters.clear();

    try {
      canvas?.app?.ticker?.remove?.(this.#animate, this);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    this._ticker = false;

    try {
      SceneMaskManager.instance.setBelowTokensNeeded?.("filters", false);
      SceneMaskManager.instance.setKindActive?.("filters", false);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  async update({ skipFading = false } = {}) {
    if (!canvas.scene) return;

    const filterInfos = Object.fromEntries(
      Object.entries(canvas.scene.getFlag(packageId, "filters") ?? {}).filter(([id, info]) => {
        if (!(info.type in CONFIG.fxmaster.filterEffects)) {
          logger.warn(game.i18n.format("FXMASTER.Filters.TypeErrors.TypeUnknown", { id, type: info.type }));
          return false;
        }
        return true;
      }),
    );

    const createKeys = Object.keys(filterInfos).filter((k) => !(k in this.filters));
    const updateKeys = Object.keys(filterInfos).filter((k) => k in this.filters);
    const deleteKeys = Object.keys(this.filters).filter((k) => !(k in filterInfos));

    for (const key of createKeys) {
      const { type, options } = filterInfos[key];
      this.filters[key] = new CONFIG.fxmaster.filterEffects[type](options, key);
      this.filters[key].play?.({ skipFading });
    }

    for (const key of updateKeys) {
      const { options } = filterInfos[key];
      const f = this.filters[key];
      f.configure?.(options);
      f.play?.({ skipFading });
    }

    for (const key of deleteKeys) {
      const f = this.filters[key];
      delete this.filters[key];
      if (!f) continue;
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
        });
    }

    this.#applyFilters();

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
    const forceSync = hasSuppression || (this.#anyBelowTokens() && hiDpi);
    this.#refreshSceneFilterSuppressionMasks(forceSync);
  }

  async addFilter(name, type, options) {
    name = name ?? foundry.utils.randomID();
    await canvas.scene?.setFlag(packageId, "filters", { [name]: { type, options } });
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
    const infos = Object.fromEntries(arr.map((fi) => [foundry.utils.randomID(), fi]));
    await resetFlag(canvas.scene, "filters", infos);
  }

  /**
   * Bind the current scene suppression masks into uniforms for all active and fading filters.
   * If the base mask is missing or destroyed, a synchronous refresh is attempted before binding.
   * @private
   */
  #bindSuppressMaskUniforms() {
    const filtersArr = [...Object.values(this.filters), ...this._dyingFilters];
    if (!filtersArr.length) return;

    const anyBelow = filtersArr.some((f) => isBelowTokensFilter(f));

    let { base, cutout, tokens, soft } = SceneMaskManager.instance.getMasks("filters");

    if (!base || base.destroyed) {
      try {
        SceneMaskManager.instance.refreshSync("filters");
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      ({ base, cutout, tokens, soft } = SceneMaskManager.instance.getMasks("filters"));
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
      cutoutRT: anyBelow ? cutout : null,
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

    try {
      SceneMaskManager.instance.setKindActive?.("filters", hasAny);
      SceneMaskManager.instance.setBelowTokensNeeded?.("filters", anyBelow);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    if (!hasAny) return;

    try {
      const r = canvas?.app?.renderer;
      const hiDpi = (r?.resolution ?? window.devicePixelRatio ?? 1) !== 1;

      if (sync || (anyBelow && hiDpi)) {
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
        SceneMaskManager.instance.setKindActive?.("filters", false);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }

    const M = snappedStageMatrix();
    if (!M) return;
    this._lastRegionsMatrix = { a: M.a, b: M.b, c: M.c, d: M.d, tx: M.tx, ty: M.ty };
  }

  #applyFilters() {
    const env = this.constructor.container;
    if (!env) return;

    const managedActive = Object.values(this.filters);
    const managedDying = [...this._dyingFilters];
    const managedAll = [...managedActive, ...managedDying];

    const existing = env.filters ?? [];
    const others = existing.filter((f) => !managedAll.includes(f));

    const nonBelow = managedAll.filter((f) => !isBelowTokensFilter(f));
    const below = managedAll.filter((f) => isBelowTokensFilter(f));

    env.filters = [...nonBelow, ...others, ...below];
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

    const M = snappedStageMatrix();
    if (!M) return;

    const L = this._lastRegionsMatrix;
    const changed = cameraMatrixChanged(M, L);

    if (changed) {
      this.#refreshSceneFilterSuppressionMasks(true);
    }

    try {
      const anyBelowTokens = this.#anyBelowTokens();
      if (!anyBelowTokens) return;

      const r = canvas?.app?.renderer;
      const res = r?.resolution || window.devicePixelRatio || 1;
      const { txCss, tyCss } = getSnappedCameraCss();

      const fxFrac = (((txCss * res) % 1) + 1) % 1;
      const fyFrac = (((tyCss * res) % 1) + 1) % 1;

      if (!this._lastCamFrac) this._lastCamFrac = { x: fxFrac, y: fyFrac };

      /**
       * Sub-pixel threshold: skip token mask repaints for camera movements smaller than ~1% of a device pixel. This avoids eggspensive per-frame sprite allocation churn during smooth panning.
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
