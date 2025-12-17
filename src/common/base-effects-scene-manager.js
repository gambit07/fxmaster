/**
 * FXMaster: Scene Mask Manager (Singleton)
 * ----------------------------------------
 * Computes and maintains shared "Scene Allow" masks for both particle and filter systems.
 *
 * Responsibilities:
 * - Builds separate base allow masks for particles and filters:
 *   - Particles: Scene Rect − (suppressWeather + fxmaster.suppressSceneParticles)
 *   - Filters:   Scene Rect − (suppressWeather + fxmaster.suppressSceneFilters)
 * - Derives "below tokens" cutout masks (Base Mask − Token Silhouettes) per kind.
 * - Maintains a shared tokens-only mask used by both systems.
 * - Reacts to camera or viewport changes via a coalesced refresh.
 */

import { packageId } from "../constants.js";
import {
  buildSceneAllowMaskRT,
  ensureBelowTokensArtifacts,
  coalesceNextFrame,
  computeRegionGatePass,
} from "../utils.js";

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
    if (hasParticles && computeRegionGatePass(placeable, { behaviorType: SUPPRESS_SCENE_PARTICLES })) {
      pass = true;
    }
    if (hasWeather && computeRegionGatePass(placeable, { behaviorType: SUPPRESS_WEATHER })) {
      pass = true;
    }
  }

  if (kind === "filters") {
    if (hasFilters && computeRegionGatePass(placeable, { behaviorType: SUPPRESS_SCENE_FILTERS })) {
      pass = true;
    }
    if (hasWeather && computeRegionGatePass(placeable, { behaviorType: SUPPRESS_WEATHER })) {
      pass = true;
    }
  }

  return pass;
}

/**
 * Manages shared scene-level allow / cutout / token masks for particles and filters.
 *
 * This is implemented as a lazy singleton; use {@link SceneMaskManager.instance}
 * to obtain the shared instance.
 */
export class SceneMaskManager {
  constructor() {
    /**
     * Scene-level base allow mask for particles.
     *
     * @type {PIXI.RenderTexture|null}
     * @private
     */
    this._baseParticlesRT = null;

    /**
     * Scene-level base allow mask for filters.
     *
     * @type {PIXI.RenderTexture|null}
     * @private
     */
    this._baseFiltersRT = null;

    /**
     * Particles "below tokens" cutout mask.
     *
     * @type {PIXI.RenderTexture|null}
     * @private
     */
    this._cutoutParticlesRT = null;

    /**
     * Filters "below tokens" cutout mask.
     *
     * @type {PIXI.RenderTexture|null}
     * @private
     */
    this._cutoutFiltersRT = null;

    /**
     * Shared tokens-only mask for both particles and filters.
     *
     * @type {PIXI.RenderTexture|null}
     * @private
     */
    this._tokensRT = null;

    this._pendingKinds = new Set();

    /**
     * Coalesced refresh callback used to delay recomputation until the next animation frame.
     *
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

  /**
   * Singleton accessor.
   *
   * @returns {SceneMaskManager} The shared {@link SceneMaskManager} instance.
   */
  static get instance() {
    if (!this.#instance) this.#instance = new this();
    return this.#instance;
  }

  /**
   * Internal singleton backing field.
   *
   * @type {SceneMaskManager|undefined}
   * @private
   */
  static #instance;

  /**
   * Backwards-compatible getter that returns the particle masks by default.
   *
   * @returns {{base: PIXI.RenderTexture|null, cutout: PIXI.RenderTexture|null, tokens: PIXI.RenderTexture|null}}
   *          A mask bundle for the particle system.
   */
  get masks() {
    return this.getMasks("particles");
  }

  /**
   * Retrieve the precomputed mask bundle for a given system kind.
   *
   * @param {"particles"|"filters"} [kind="particles"] - Which mask set to retrieve.
   * @returns {{base: PIXI.RenderTexture|null, cutout: PIXI.RenderTexture|null, tokens: PIXI.RenderTexture|null}}
   *          An object containing the base allow mask, the "below tokens" cutout mask,
   *          and the shared tokens-only mask.
   */
  getMasks(kind = "particles") {
    if (kind === "filters") {
      return {
        base: this._baseFiltersRT,
        cutout: this._cutoutFiltersRT,
        tokens: this._tokensRT,
      };
    }

    return {
      base: this._baseParticlesRT,
      cutout: this._cutoutParticlesRT,
      tokens: this._tokensRT,
    };
  }

  /**
   * Schedule a mask refresh on the next animation frame.
   *
   * @returns {void}
   */
  refresh(kind = "all") {
    if (kind === "all") {
      this._pendingKinds.add("particles");
      this._pendingKinds.add("filters");
    } else {
      this._pendingKinds.add(kind);
    }
    this._scheduleRefresh();
  }

  /**
   * Force an immediate, synchronous refresh of all masks.
   *
   * @returns {void}
   */
  refreshSync(kind = "all") {
    this._scheduleRefresh.cancel();
    const kinds = kind === "all" ? ["particles", "filters"] : [kind];
    this._refreshImpl(kinds);
  }

  /**
   * Internal implementation of the mask refresh pipeline.
   *
   * @returns {void}
   * @private
   */

  _refreshImpl(kinds = ["particles", "filters"]) {
    if (!canvas?.ready) return;

    const regions = canvas.regions?.placeables ?? [];

    if (kinds.includes("particles")) {
      const suppressParticleRegions = regions.filter((reg) => regionPassesSuppressionGate(reg, "particles"));
      this._baseParticlesRT = buildSceneAllowMaskRT({
        regions: suppressParticleRegions,
        reuseRT: this._baseParticlesRT,
      });

      if (this._baseParticlesRT) {
        const updated = ensureBelowTokensArtifacts(this._baseParticlesRT, {
          cutoutRT: this._cutoutParticlesRT,
          tokensMaskRT: this._tokensRT,
        });
        this._cutoutParticlesRT = updated.cutoutRT;
        this._tokensRT = updated.tokensMaskRT;
      }
    }

    if (kinds.includes("filters")) {
      const suppressFilterRegions = regions.filter((reg) => regionPassesSuppressionGate(reg, "filters"));
      this._baseFiltersRT = buildSceneAllowMaskRT({ regions: suppressFilterRegions, reuseRT: this._baseFiltersRT });

      if (this._baseFiltersRT) {
        const updated = ensureBelowTokensArtifacts(this._baseFiltersRT, {
          cutoutRT: this._cutoutFiltersRT,
          tokensMaskRT: this._tokensRT,
        });
        this._cutoutFiltersRT = updated.cutoutRT;
        this._tokensRT = updated.tokensMaskRT;
      }
    }
  }

  /**
   * Destroy and clear all derived masks (cutouts and tokens-only),
   * but leave base allow masks untouched.
   *
   * @returns {void}
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
   * - Cancels any pending coalesced refresh.
   * - Destroys and nulls out base and derived render textures.
   *
   * Intended to be called when the scene is torn down or the canvas resets.
   *
   * @returns {void}
   */
  clear() {
    this._scheduleRefresh.cancel();

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
