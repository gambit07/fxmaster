/**
 * FilterEffectsSceneManager
 * -------------
 * Manages scene-wide post-processing filters for FXMaster.
 * - Attaches scene filters to canvas.environment
 * - Clamps filter effect to the scene rectangle via an allow-mask render texture
 * - Honors suppression regions: core "suppressWeather" and `${packageId}.suppressSceneFilters`
 *   Builds a device-pixel allow-mask RT and provides common uniforms
 *   (`maskSampler`, `hasMask`, `viewSize` in CSS px, `maskReady`, `deviceToCss`).
 * - Handles create/update/delete with fade-out, and keeps masks in sync with camera.
 */

import { packageId } from "../constants.js";
import { logger } from "../logger.js";
import {
  resetFlag,
  ensureBelowTokensArtifacts,
  applyMaskUniformsToFilters,
  getCssViewportMetrics,
  buildSceneAllowMaskRT,
  snappedStageMatrix,
} from "../utils.js";

export class FilterEffectsSceneManager {
  constructor() {
    this.filters = {};
    this._dyingFilters = new Set();
    this._ticker = false;
    this._suppressMaskRT = null;
    this._suppressMaskCutoutRT = null;
    this._tokensMaskRT = null;
    this._lastRegionsMatrix = null;
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
    this.#refreshSceneFilterSuppressionMask();
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
    this.#destroySuppressMask();

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
          if (!Object.keys(this.filters).length && this._dyingFilters.size === 0) {
            this.#destroySuppressMask();
          }
        });
    }

    this.#applyFilters();
    this.#applySuppressMaskToFilters();
  }

  refreshViewMaskGeometry() {
    this.#refreshSceneFilterSuppressionMask();
  }

  refreshSceneFilterSuppressionMask() {
    this.#refreshSceneFilterSuppressionMask();
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

  #destroySuppressMask() {
    try {
      this._suppressMaskRT?.destroy(true);
    } catch {}
    this._suppressMaskRT = null;
    try {
      this._suppressMaskCutoutRT?.destroy(true);
    } catch {}
    this._suppressMaskCutoutRT = null;
    try {
      this._tokensMaskRT?.destroy(true);
    } catch {}
    this._tokensMaskRT = null;
  }

  #getSuppressRegions() {
    const SUPPRESS_TYPES = new Set(["suppressWeather", `${packageId}.suppressSceneFilters`]);
    const placeables = canvas.regions?.placeables ?? [];
    return placeables.filter((region) =>
      region.document.behaviors?.some((b) => SUPPRESS_TYPES.has(b.type) && !b.disabled),
    );
  }

  /** Build/refresh scene allow-mask RT(s) and wire uniforms to active + fading filters. */
  #applySuppressMaskToFilters() {
    const r = canvas?.app?.renderer;
    if (!r) return;

    const filtersArr = [...Object.values(this.filters), ...this._dyingFilters];
    if (!filtersArr.length) return;

    const { cssW, cssH, deviceToCss, rect: cssFA } = getCssViewportMetrics();

    const regions = this.#getSuppressRegions();
    this._suppressMaskRT = buildSceneAllowMaskRT({
      regions,
      reuseRT: this._suppressMaskRT,
    });

    const anyBelow = filtersArr.some((f) => !!(f?.__fxmBelowTokens ?? f?.options?.belowTokens));
    if (anyBelow) {
      const updated = ensureBelowTokensArtifacts(this._suppressMaskRT, {
        cutoutRT: this._suppressMaskCutoutRT,
        tokensMaskRT: this._tokensMaskRT,
      });
      this._suppressMaskCutoutRT = updated.cutoutRT;
      this._tokensMaskRT = updated.tokensMaskRT;
    } else {
      if (this._suppressMaskCutoutRT) {
        try {
          this._suppressMaskCutoutRT.destroy(true);
        } catch {}
        this._suppressMaskCutoutRT = null;
      }
      if (this._tokensMaskRT) {
        try {
          this._tokensMaskRT.destroy(true);
        } catch {}
        this._tokensMaskRT = null;
      }
    }

    applyMaskUniformsToFilters(filtersArr, {
      baseMaskRT: this._suppressMaskRT,
      cutoutRT: this._suppressMaskCutoutRT,
      tokensMaskRT: this._tokensMaskRT,
      cssW,
      cssH,
      deviceToCss,
      filterAreaRect: cssFA,
    });
  }

  #refreshSceneFilterSuppressionMask() {
    const hasAny = Object.keys(this.filters).length > 0 || this._dyingFilters.size > 0;

    if (hasAny) this.#applySuppressMaskToFilters();

    const M = snappedStageMatrix();
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

    const nonBelow = oursAll.filter((f) => !f?.options?.belowTokens);
    const below = oursAll.filter((f) => f?.options?.belowTokens);

    env.filters = [...nonBelow, ...others, ...below];
  }

  #removeFromEnvFilters(filtersToRemove = []) {
    const env = this.constructor.container;
    if (!env?.filters?.length) return;
    const set = new Set(filtersToRemove);
    env.filters = env.filters.filter((f) => !set.has(f));
  }

  #animate() {
    for (const f of Object.values(this.filters)) f.step?.();
    const r = canvas.app.renderer;
    const res = r?.resolution || window.devicePixelRatio || 1;
    const Msrc = canvas.stage.worldTransform;
    const fxFrac = Msrc ? (Msrc.tx * res - Math.round(Msrc.tx * res)) / res : 0;
    const fyFrac = Msrc ? (Msrc.ty * res - Math.round(Msrc.ty * res)) / res : 0;

    this._lastCamFrac ??= { x: fxFrac, y: fyFrac };

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
      this.#refreshSceneFilterSuppressionMask();
    }

    const anyBelowTokens = this._sceneFilters?.some?.((f) => !!(f.__fxmBelowTokens ?? f.options?.belowTokens));
    const fracMoved = Math.abs(fxFrac - this._lastCamFrac.x) > 1e-4 || Math.abs(fyFrac - this._lastCamFrac.y) > 1e-4;
    if (anyBelowTokens && fracMoved) {
      this.#applySuppressMaskToFilters();
      this._lastCamFrac.x = fxFrac;
      this._lastCamFrac.y = fyFrac;
    }

    this._lastRegionsMatrix = { a: M.a, b: M.b, c: M.c, d: M.d, tx: M.tx, ty: M.ty };
  }
}
