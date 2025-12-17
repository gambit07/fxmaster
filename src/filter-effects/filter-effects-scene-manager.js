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
import { resetFlag, applyMaskUniformsToFilters, getCssViewportMetrics, snappedStageMatrix } from "../utils.js";

import { SceneMaskManager } from "../common/base-effects-scene-manager.js";

export class FilterEffectsSceneManager {
  constructor() {
    this.filters = {};
    this._dyingFilters = new Set();
    this._ticker = false;
    this._lastRegionsMatrix = null;
    this._lastCamFrac = undefined;
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
    const ours = Object.values(this.filters);
    const dying = [...this._dyingFilters];

    const promises = [...ours, ...dying].map((f) => f.stop?.({ skipFading: true }));
    await Promise.all(promises);

    try {
      if (env?.filters?.length) {
        const set = new Set([...ours, ...dying]);
        env.filters = env.filters.filter((f) => !set.has(f));
      }
    } catch {}

    this.filters = {};
    this._dyingFilters.clear();

    try {
      canvas?.app?.ticker?.remove?.(this.#animate, this);
    } catch {}
    this._ticker = false;
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
          } catch {}
          this._dyingFilters.delete(f);
        });
    }

    this.#applyFilters();

    this.#refreshSceneFilterSuppressionMasks(true);
  }

  refreshViewMaskGeometry() {
    this.#refreshSceneFilterSuppressionMasks(true);
  }

  refreshSceneFilterSuppressionMasks() {
    const r = canvas?.app?.renderer;
    const hiDpi = (r?.resolution ?? window.devicePixelRatio ?? 1) !== 1;
    const forceSync = this.#anyBelowTokens() && hiDpi;
    this.#refreshSceneFilterSuppressionMasks(forceSync);
  }

  async addFilter(name, type, options) {
    name = name ?? foundry.utils.randomID();
    await canvas.scene?.setFlag(packageId, "filters", { [name]: { type, options } });
  }

  async removeFilter(name) {
    await canvas.scene?.setFlag(packageId, "filters", { [`-=${name}`]: null });
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

  #applySuppressMaskToFilters(sync = false) {
    const filtersArr = [...Object.values(this.filters), ...this._dyingFilters];
    if (!filtersArr.length) return;

    try {
      const r = canvas?.app?.renderer;
      const hiDpi = (r?.resolution ?? window.devicePixelRatio ?? 1) !== 1;
      const anyBelow = this.#anyBelowTokens();
      if (sync || (anyBelow && hiDpi)) SceneMaskManager.instance.refreshSync("filters");
      else SceneMaskManager.instance.refresh("filters");
    } catch {}

    const { base, cutout, tokens } = SceneMaskManager.instance.getMasks("filters");
    const anyBelow = filtersArr.some((f) => !!(f?.__fxmBelowTokens ?? f?.options?.belowTokens));

    if (!base) {
      for (const f of filtersArr) {
        const u = f?.uniforms || {};
        if ("maskSampler" in u) u.maskSampler = PIXI.Texture.EMPTY;
        if ("hasMask" in u) u.hasMask = 0.0;
        if ("maskReady" in u) u.maskReady = 0.0;
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
      filterAreaRect: cssFA,
    });
  }

  #refreshSceneFilterSuppressionMasks(sync = false) {
    const hasAny = Object.keys(this.filters).length > 0 || this._dyingFilters.size > 0;
    if (hasAny) this.#applySuppressMaskToFilters(sync);

    const M = snappedStageMatrix();
    if (!M) return;
    this._lastRegionsMatrix = { a: M.a, b: M.b, c: M.c, d: M.d, tx: M.tx, ty: M.ty };
  }

  #applyFilters() {
    const env = this.constructor.container;
    if (!env) return;

    const oursActive = Object.values(this.filters);
    const oursDying = [...this._dyingFilters];
    const oursAll = [...oursActive, ...oursDying];

    const existing = env.filters ?? [];
    const others = existing.filter((f) => !oursAll.includes(f));

    const isBelow = (f) => !!(f?.__fxmBelowTokens ?? f?.options?.belowTokens);
    const nonBelow = oursAll.filter((f) => !isBelow(f));
    const below = oursAll.filter((f) => isBelow(f));

    env.filters = [...nonBelow, ...others, ...below];
  }

  #removeFromEnvFilters(filtersToRemove = []) {
    const env = this.constructor.container;
    if (!env?.filters?.length) return;
    const set = new Set(filtersToRemove);
    env.filters = env.filters.filter((f) => !set.has(f));
  }

  #anyBelowTokens() {
    return [...Object.values(this.filters), ...this._dyingFilters].some(
      (f) => !!(f?.__fxmBelowTokens ?? f?.options?.belowTokens),
    );
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
    } catch {}

    const M = snappedStageMatrix();
    if (!M) return;

    const L = this._lastRegionsMatrix;
    const eps = 1e-4;
    const changed =
      !L ||
      Math.abs(L.a - M.a) > eps ||
      Math.abs(L.b - M.b) > eps ||
      Math.abs(L.c - M.c) > eps ||
      Math.abs(L.d - M.d) > eps ||
      Math.abs(L.tx - M.tx) > eps ||
      Math.abs(L.ty - M.ty) > eps;

    if (changed) {
      this.#refreshSceneFilterSuppressionMasks(true);
    }

    try {
      const r = canvas?.app?.renderer;
      const res = r?.resolution || window.devicePixelRatio || 1;
      const stageM = canvas?.stage?.worldTransform;
      const fxFrac = stageM ? (stageM.tx * res - Math.round(stageM.tx * res)) / res : 0;
      const fyFrac = stageM ? (stageM.ty * res - Math.round(stageM.ty * res)) / res : 0;
      if (!this._lastCamFrac) this._lastCamFrac = { x: fxFrac, y: fyFrac };
      const anyBelowTokens = [...Object.values(this.filters), ...this._dyingFilters].some((f) => {
        return !!(f?.__fxmBelowTokens ?? f?.options?.belowTokens);
      });
      const fracMoved = Math.abs(fxFrac - this._lastCamFrac.x) > 1e-4 || Math.abs(fyFrac - this._lastCamFrac.y) > 1e-4;
      if (anyBelowTokens && fracMoved) {
        this.#applySuppressMaskToFilters(true);
        this._lastCamFrac.x = fxFrac;
        this._lastCamFrac.y = fyFrac;
      }
    } catch {}
  }
}
