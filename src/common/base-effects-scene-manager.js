/**
 * FXMaster: Scene Mask Manager (Singleton)
 * ----------------------------------------
 * Computes and maintains shared "Scene Allow" masks for both particle and filter systems.
 *
 * Responsibilities:
 * - Builds separate base allow masks for particles and filters:
 *   - Particles: Scene Rect − (suppressWeather + fxmaster.suppressSceneParticles)
 *   - Filters:   Scene Rect − (suppressWeather + fxmaster.suppressSceneFilters)
 * - Optionally derives "below tokens" cutout masks (Base Mask − Token Silhouettes) per kind,
 *   only when needed by active consumers.
 * - Optionally maintains a shared tokens-only mask used by both systems, only when needed.
 * - Reacts to camera or viewport changes via a coalesced refresh.
 */

import { packageId } from "../constants.js";
import {
  buildSceneAllowMaskRT,
  coalesceNextFrame,
  computeRegionGatePass,
  getCssViewportMetrics,
  repaintTokensMaskInto,
  safeMaskResolutionForCssArea,
} from "../utils.js";

/** @type {PIXI.Sprite|null} */
let _tmpBaseCopySprite = null;
/** @type {PIXI.Sprite|null} */
let _tmpTokensEraseSprite = null;

const SUPPRESS_WEATHER = "suppressWeather";
const SUPPRESS_SCENE_PARTICLES = `${packageId}.suppressSceneParticles`;
const SUPPRESS_SCENE_FILTERS = `${packageId}.suppressSceneFilters`;

/**
 * Determine whether a region should contribute to a suppression mask for a given kind,
 * respecting elevation and viewer gating.
 *
 * @param {PlaceableObject} placeable - The Region placeable to inspect.
 * @param {"filters"|"particles"} kind - Which pipeline is querying ("filters" or "particles").
 * @returns {boolean} True if this region should be considered for suppression for the given kind.
 * @private
 */
function regionPassesSuppressionGate(placeable, kind) {
  const doc = placeable?.document;
  if (!doc) return false;

  const behaviors = doc.behaviors ?? [];

  const hasWeather = behaviors.some((b) => !b.disabled && b.type === SUPPRESS_WEATHER);
  const hasParticles = behaviors.some((b) => !b.disabled && b.type === SUPPRESS_SCENE_PARTICLES);
  const hasFilters = behaviors.some((b) => !b.disabled && b.type === SUPPRESS_SCENE_FILTERS);

  if (!hasWeather && !hasParticles && !hasFilters) return false;

  let pass = false;

  if (kind === "particles") {
    if (hasParticles && computeRegionGatePass(placeable, { behaviorType: SUPPRESS_SCENE_PARTICLES })) pass = true;
    if (hasWeather && computeRegionGatePass(placeable, { behaviorType: SUPPRESS_WEATHER })) pass = true;
  }

  if (kind === "filters") {
    if (hasFilters && computeRegionGatePass(placeable, { behaviorType: SUPPRESS_SCENE_FILTERS })) pass = true;
    if (hasWeather && computeRegionGatePass(placeable, { behaviorType: SUPPRESS_WEATHER })) pass = true;
  }

  return pass;
}

/**
 * Ensure a RenderTexture matches the provided logical dimensions and resolution.
 *
 * @param {PIXI.RenderTexture|null} reuseRT
 * @param {{width:number,height:number,resolution:number}} spec
 * @returns {PIXI.RenderTexture}
 * @private
 */
function ensureRenderTexture(reuseRT, { width, height, resolution }) {
  const W = Math.max(1, width | 0);
  const H = Math.max(1, height | 0);
  const res = resolution || 1;

  const bad =
    !reuseRT ||
    reuseRT.destroyed ||
    (reuseRT.width | 0) !== W ||
    (reuseRT.height | 0) !== H ||
    (reuseRT.resolution || 1) !== res;

  if (!bad) return reuseRT;

  try {
    reuseRT?.destroy(true);
  } catch {}

  const rt = PIXI.RenderTexture.create({
    width: W,
    height: H,
    resolution: res,
    multisample: 0,
  });

  try {
    rt.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
    rt.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
  } catch {}

  return rt;
}

/**
 * Rebuild (or reuse) a cutout render texture: baseRT minus token silhouettes.
 *
 * @param {PIXI.RenderTexture} baseRT
 * @param {PIXI.RenderTexture} tokensRT
 * @param {PIXI.RenderTexture|null} reuseCutoutRT
 * @returns {PIXI.RenderTexture|null}
 * @private
 */
function rebuildCutoutFromBase(baseRT, tokensRT, reuseCutoutRT) {
  const r = canvas?.app?.renderer;
  if (!r || !baseRT || !tokensRT) return null;

  const W = Math.max(1, baseRT.width | 0);
  const H = Math.max(1, baseRT.height | 0);
  const res = baseRT.resolution || 1;

  const cutoutRT = ensureRenderTexture(reuseCutoutRT, { width: W, height: H, resolution: res });

  try {
    const spr = (_tmpBaseCopySprite ??= new PIXI.Sprite());
    spr.texture = baseRT;
    spr.blendMode = PIXI.BLEND_MODES.NORMAL;
    spr.alpha = 1;
    spr.position.set(0, 0);
    spr.scale.set(1, 1);
    spr.rotation = 0;
    r.render(spr, { renderTexture: cutoutRT, clear: true });
  } catch {}

  try {
    const spr = (_tmpTokensEraseSprite ??= new PIXI.Sprite());
    spr.texture = tokensRT;
    spr.blendMode = PIXI.BLEND_MODES.ERASE;
    spr.alpha = 1;
    spr.position.set(0, 0);
    spr.scale.set(1, 1);
    spr.rotation = 0;
    r.render(spr, { renderTexture: cutoutRT, clear: false });
  } catch {}

  return cutoutRT;
}

/**
 * Manages shared scene-level allow / cutout / token masks for particles and filters.
 *
 * This is implemented as a lazy singleton; use {@link SceneMaskManager.instance}
 * to obtain the shared instance.
 */
export class SceneMaskManager {
  constructor() {
    /** @type {PIXI.RenderTexture|null} */
    this._baseParticlesRT = null;
    /** @type {PIXI.RenderTexture|null} */
    this._baseFiltersRT = null;

    /** @type {PIXI.RenderTexture|null} */
    this._cutoutParticlesRT = null;
    /** @type {PIXI.RenderTexture|null} */
    this._cutoutFiltersRT = null;

    /** @type {PIXI.RenderTexture|null} */
    this._tokensRT = null;

    /**
     * Whether each pipeline currently has any active consumers.
     * Defaults to true to preserve existing behavior until callers declare otherwise.
     * @type {{particles:boolean, filters:boolean}}
     * @private
     */
    this._kindActive = { particles: true, filters: true };

    /**
     * Whether each pipeline currently needs "below tokens" artifacts (cutout + tokens mask).
     * Defaults to true to preserve existing behavior until callers declare otherwise.
     * @type {{particles:boolean, filters:boolean}}
     * @private
     */
    this._belowTokensNeeded = { particles: true, filters: true };

    this._pendingKinds = new Set();

    /**
     * Coalesced refresh callback used to delay recomputation until next animation frame.
     * @type {Function}
     * @private
     */
    this._scheduleRefresh = coalesceNextFrame(
      () => {
        const kinds = this._pendingKinds.size ? [...this._pendingKinds] : ["particles", "filters"];
        this._pendingKinds.clear();
        this._refreshImpl(kinds);
      },
      { key: "fxm:sceneMaskManager" },
    );
  }

  /** @type {SceneMaskManager|undefined} */
  static #instance;

  /**
   * Singleton accessor.
   * @returns {SceneMaskManager}
   */
  static get instance() {
    if (!this.#instance) this.#instance = new this();
    return this.#instance;
  }

  /**
   * Backwards-compatible getter that returns the particle masks by default.
   * @returns {{base: PIXI.RenderTexture|null, cutout: PIXI.RenderTexture|null, tokens: PIXI.RenderTexture|null}}
   */
  get masks() {
    return this.getMasks("particles");
  }

  /**
   * Retrieve the precomputed mask bundle for a given system kind.
   * @param {"particles"|"filters"} [kind="particles"]
   * @returns {{base: PIXI.RenderTexture|null, cutout: PIXI.RenderTexture|null, tokens: PIXI.RenderTexture|null}}
   */
  getMasks(kind = "particles") {
    if (kind === "filters") {
      return { base: this._baseFiltersRT, cutout: this._cutoutFiltersRT, tokens: this._tokensRT };
    }
    return { base: this._baseParticlesRT, cutout: this._cutoutParticlesRT, tokens: this._tokensRT };
  }

  /**
   * Declare whether a pipeline currently has active consumers.
   * When inactive, its base and derived RTs are released to reduce VRAM pressure.
   *
   * @param {"particles"|"filters"} kind
   * @param {boolean} active
   */
  setKindActive(kind, active) {
    if (kind !== "particles" && kind !== "filters") return;

    const next = !!active;
    const prev = !!this._kindActive[kind];
    if (prev === next) return;

    this._kindActive[kind] = next;

    if (!next) {
      if (kind === "particles") {
        try {
          this._baseParticlesRT?.destroy(true);
        } catch {}
        this._baseParticlesRT = null;

        try {
          this._cutoutParticlesRT?.destroy(true);
        } catch {}
        this._cutoutParticlesRT = null;
      } else {
        try {
          this._baseFiltersRT?.destroy(true);
        } catch {}
        this._baseFiltersRT = null;

        try {
          this._cutoutFiltersRT?.destroy(true);
        } catch {}
        this._cutoutFiltersRT = null;
      }

      const needTokens =
        (this._kindActive.particles && this._belowTokensNeeded.particles) ||
        (this._kindActive.filters && this._belowTokensNeeded.filters);

      if (!needTokens && this._tokensRT) {
        try {
          this._tokensRT.destroy(true);
        } catch {}
        this._tokensRT = null;
      }

      return;
    }

    this.refresh(kind);
  }

  /**
   * Declare whether a pipeline needs "below tokens" artifacts (cutout + tokens-only).
   * @param {"particles"|"filters"} kind
   * @param {boolean} needed
   */
  setBelowTokensNeeded(kind, needed) {
    if (kind !== "particles" && kind !== "filters") return;

    const next = !!needed;
    const prev = !!this._belowTokensNeeded[kind];
    if (prev === next) return;

    this._belowTokensNeeded[kind] = next;

    if (!next) {
      if (kind === "particles") {
        try {
          this._cutoutParticlesRT?.destroy(true);
        } catch {}
        this._cutoutParticlesRT = null;
      } else {
        try {
          this._cutoutFiltersRT?.destroy(true);
        } catch {}
        this._cutoutFiltersRT = null;
      }

      const needTokens =
        (this._kindActive.particles && this._belowTokensNeeded.particles) ||
        (this._kindActive.filters && this._belowTokensNeeded.filters);

      if (!needTokens && this._tokensRT) {
        try {
          this._tokensRT.destroy(true);
        } catch {}
        this._tokensRT = null;
      }

      return;
    }

    if (this._kindActive[kind]) this.refresh(kind);
  }

  /**
   * Schedule a mask refresh on the next animation frame.
   * @param {"particles"|"filters"|"all"} [kind="all"]
   */
  refresh(kind = "all") {
    if (kind === "all") {
      this._pendingKinds.add("particles");
      this._pendingKinds.add("filters");
    } else if (kind === "particles" || kind === "filters") {
      this._pendingKinds.add(kind);
    } else {
      return;
    }
    this._scheduleRefresh();
  }

  /**
   * Force an immediate, synchronous refresh of masks.
   * @param {"particles"|"filters"|"all"} [kind="all"]
   */
  refreshSync(kind = "all") {
    try {
      this._scheduleRefresh?.cancel?.();
    } catch {}

    const kinds = kind === "all" ? ["particles", "filters"] : [kind];
    this._refreshImpl(kinds);
  }

  /**
   * Force an immediate, synchronous repaint of the shared tokens-only RT (and any derived cutouts),
   * without rebuilding base allow masks.
   *
   * This is intended for sub-pixel camera translation updates (camFrac) and token motion,
   * where rebuilding suppression geometry would be wasted work but stale token silhouettes would
   * cause visible "sliding" or jitter in below-tokens masks.
   */
  refreshTokensSync() {
    if (!canvas?.ready) return;

    const needTokens =
      (this._kindActive.particles && this._belowTokensNeeded.particles) ||
      (this._kindActive.filters && this._belowTokensNeeded.filters);

    if (!needTokens) return;

    const { cssW, cssH } = getCssViewportMetrics();
    const res = safeMaskResolutionForCssArea(cssW, cssH, 1);

    this._tokensRT = ensureRenderTexture(this._tokensRT, { width: cssW, height: cssH, resolution: res });

    repaintTokensMaskInto(this._tokensRT);

    if (this._kindActive.particles && this._belowTokensNeeded.particles && this._baseParticlesRT && this._tokensRT) {
      this._cutoutParticlesRT = rebuildCutoutFromBase(this._baseParticlesRT, this._tokensRT, this._cutoutParticlesRT);
    }
    if (this._kindActive.filters && this._belowTokensNeeded.filters && this._baseFiltersRT && this._tokensRT) {
      this._cutoutFiltersRT = rebuildCutoutFromBase(this._baseFiltersRT, this._tokensRT, this._cutoutFiltersRT);
    }
  }

  /**
   * Internal implementation of the mask refresh pipeline.
   * @param {Array<"particles"|"filters">} kinds
   * @private
   */
  _refreshImpl(kinds = ["particles", "filters"]) {
    if (!canvas?.ready) return;

    const regions = canvas.regions?.placeables ?? [];

    if (kinds.includes("particles")) {
      if (!this._kindActive.particles) {
        try {
          this._baseParticlesRT?.destroy(true);
        } catch {}
        this._baseParticlesRT = null;

        try {
          this._cutoutParticlesRT?.destroy(true);
        } catch {}
        this._cutoutParticlesRT = null;
      } else {
        const suppressParticleRegions = regions.filter((reg) => regionPassesSuppressionGate(reg, "particles"));
        this._baseParticlesRT = buildSceneAllowMaskRT({
          regions: suppressParticleRegions,
          reuseRT: this._baseParticlesRT,
        });
      }
    }

    if (kinds.includes("filters")) {
      if (!this._kindActive.filters) {
        try {
          this._baseFiltersRT?.destroy(true);
        } catch {}
        this._baseFiltersRT = null;

        try {
          this._cutoutFiltersRT?.destroy(true);
        } catch {}
        this._cutoutFiltersRT = null;
      } else {
        const suppressFilterRegions = regions.filter((reg) => regionPassesSuppressionGate(reg, "filters"));
        this._baseFiltersRT = buildSceneAllowMaskRT({
          regions: suppressFilterRegions,
          reuseRT: this._baseFiltersRT,
        });
      }
    }

    const needTokens =
      (this._kindActive.particles && this._belowTokensNeeded.particles) ||
      (this._kindActive.filters && this._belowTokensNeeded.filters);

    if (needTokens) {
      const { cssW, cssH } = getCssViewportMetrics();
      const res = safeMaskResolutionForCssArea(cssW, cssH, 1);

      this._tokensRT = ensureRenderTexture(this._tokensRT, { width: cssW, height: cssH, resolution: res });

      repaintTokensMaskInto(this._tokensRT);
    } else if (this._tokensRT) {
      try {
        this._tokensRT.destroy(true);
      } catch {}
      this._tokensRT = null;
    }

    if (kinds.includes("particles")) {
      if (this._kindActive.particles && this._belowTokensNeeded.particles && this._baseParticlesRT && this._tokensRT) {
        this._cutoutParticlesRT = rebuildCutoutFromBase(this._baseParticlesRT, this._tokensRT, this._cutoutParticlesRT);
      } else if (this._cutoutParticlesRT) {
        try {
          this._cutoutParticlesRT.destroy(true);
        } catch {}
        this._cutoutParticlesRT = null;
      }
    }

    if (kinds.includes("filters")) {
      if (this._kindActive.filters && this._belowTokensNeeded.filters && this._baseFiltersRT && this._tokensRT) {
        this._cutoutFiltersRT = rebuildCutoutFromBase(this._baseFiltersRT, this._tokensRT, this._cutoutFiltersRT);
      } else if (this._cutoutFiltersRT) {
        try {
          this._cutoutFiltersRT.destroy(true);
        } catch {}
        this._cutoutFiltersRT = null;
      }
    }
  }

  /**
   * Destroy and clear all derived masks (cutouts and tokens-only),
   * but leave base allow masks untouched.
   * @private
   */
  _cleanupArtifacts() {
    if (this._cutoutParticlesRT) {
      try {
        this._cutoutParticlesRT.destroy(true);
      } catch {}
      this._cutoutParticlesRT = null;
    }
    if (this._cutoutFiltersRT) {
      try {
        this._cutoutFiltersRT.destroy(true);
      } catch {}
      this._cutoutFiltersRT = null;
    }
    if (this._tokensRT) {
      try {
        this._tokensRT.destroy(true);
      } catch {}
      this._tokensRT = null;
    }
  }

  /**
   * Fully clear the manager:
   * - Cancels any pending refresh
   * - Destroys and nulls out base and derived render textures
   */
  clear() {
    try {
      this._scheduleRefresh?.cancel?.();
    } catch {}

    const destroyRT = (key) => {
      const rt = this[key];
      if (!rt) return;
      try {
        rt.destroy(true);
      } catch {}
      this[key] = null;
    };

    destroyRT("_baseParticlesRT");
    destroyRT("_baseFiltersRT");
    this._cleanupArtifacts();
  }
}
