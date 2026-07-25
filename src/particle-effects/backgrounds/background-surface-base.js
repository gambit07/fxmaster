import {
  PARTICLE_BACKGROUND_STATE_PROFILE,
  normalizeParticleBackgroundTimestamp,
  particleBackgroundDurationSeconds,
  particleBackgroundMode,
  particleBackgroundMonotonicNow,
  particleBackgroundNow,
  unwrapParticleBackgroundOption,
} from "./background-state.js";
import { logger } from "../../logger.js";
import { snappedStageMatrix } from "../../utils/viewport.js";

const VERTEX_SHADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
attribute vec2 aVertexPosition;
uniform mat3 projectionMatrix;
uniform vec4 outputFrame;
varying vec2 vCssCoord;
void main() {
  vec2 position = aVertexPosition * max(outputFrame.zw, vec2(0.0)) + outputFrame.xy;
  vCssCoord = position;
  gl_Position = vec4((projectionMatrix * vec3(position, 1.0)).xy, 0.0, 1.0);
}
`;

export function clamp(value, min, max, fallback = min) {
  const n = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : fallback));
}

function parseHexColor(value, fallback = [0.93, 0.96, 1.0]) {
  let hex = typeof value === "string" ? value.trim() : "";
  if (/^[0-9a-f]{6}$/i.test(hex)) hex = `#${hex}`;
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return new Float32Array(fallback);
  return new Float32Array([
    Number.parseInt(hex.slice(1, 3), 16) / 255,
    Number.parseInt(hex.slice(3, 5), 16) / 255,
    Number.parseInt(hex.slice(5, 7), 16) / 255,
  ]);
}

function stableSeed(value) {
  const text = String(value ?? "particle-background");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

/**
 * Resolve a synchronized procedural seed. Accumulating backgrounds receive a
 * persisted random seed whenever their timer is restarted. Older state falls
 * back to its activation epoch and revision, which is still stable for every
 * client and changes on the next restart.
 *
 * @param {string} uid
 * @param {object|null|undefined} state
 * @returns {number}
 */
function resolvePatternSeed(uid, state) {
  const background = state?.background ?? {};
  const hasStoredSeed =
    background.patternSeed !== null && background.patternSeed !== undefined && background.patternSeed !== "";
  const stored = hasStoredSeed ? Number(background.patternSeed) : Number.NaN;
  const material =
    Number.isFinite(stored) && stored >= 0
      ? `${uid}:seed:${Math.trunc(stored)}`
      : `${uid}:legacy:${background.startedAt ?? "none"}:${background.revision ?? 0}`;
  return stableSeed(material) * 97.0;
}

function resolveWindVector(options) {
  const value = Number(unwrapParticleBackgroundOption(options?.direction));
  const degrees = Number.isFinite(value) ? value : 315;
  const radians = (degrees * Math.PI) / 180;
  return new Float32Array([Math.cos(radians), -Math.sin(radians)]);
}

const CSS_TO_WORLD_IDENTITY = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
const EMPTY_TRAIL_BOUNDS = new Float32Array([0, 0, 1, 1]);
const EMPTY_TRAIL_TEXEL = new Float32Array([1, 1]);

/**
 * Keep a column-major inverse stage matrix in a reusable uniform array.
 *
 * @param {Float32Array|null|undefined} target
 * @returns {Float32Array}
 */
function writeMatrixUniform(out, matrix) {
  out[0] = Number(matrix?.a ?? 1) || 0;
  out[1] = Number(matrix?.b ?? 0) || 0;
  out[2] = 0;
  out[3] = Number(matrix?.c ?? 0) || 0;
  out[4] = Number(matrix?.d ?? 1) || 0;
  out[5] = 0;
  out[6] = Number(matrix?.tx ?? 0) || 0;
  out[7] = Number(matrix?.ty ?? 0) || 0;
  out[8] = 1;
  return out;
}

function updateCssToWorldMatrix(target, context = null) {
  const out = target instanceof Float32Array && target.length >= 9 ? target : new Float32Array(9);

  try {
    const scoped = context?.cssToWorld ?? null;
    if (scoped instanceof Float32Array && scoped.length >= 9) {
      out.set(scoped.subarray(0, 9));
      return out;
    }
    if (scoped) return writeMatrixUniform(out, scoped);

    const stage = globalThis.canvas?.stage ?? null;
    if (!stage) {
      out.set(CSS_TO_WORLD_IDENTITY);
      return out;
    }

    return writeMatrixUniform(out, snappedStageMatrix(stage).clone().invert());
  } catch (err) {
    logger.debug("FXMaster:", err);
    out.set(CSS_TO_WORLD_IDENTITY);
    return out;
  }
}

export function resolveDimensions(source) {
  const dimensions = source?.dimensions ?? source ?? canvas?.dimensions ?? {};
  const rect = dimensions.sceneRect ?? dimensions.rect ?? {};
  const x = Number(rect.x ?? dimensions.sceneX ?? 0) || 0;
  const y = Number(rect.y ?? dimensions.sceneY ?? 0) || 0;
  const width = Math.max(1, Number(rect.width ?? rect.w ?? dimensions.sceneWidth ?? dimensions.width ?? 1) || 1);
  const height = Math.max(1, Number(rect.height ?? rect.h ?? dimensions.sceneHeight ?? dimensions.height ?? 1) || 1);
  const gridSize = Math.max(1, Number(dimensions.size ?? canvas?.dimensions?.size ?? 100) || 100);
  return { x, y, width, height, gridSize };
}

function resolveFilterResolution(renderer) {
  const resolution = Number(renderer?.resolution ?? globalThis.canvas?.app?.renderer?.resolution ?? 1);
  return clamp(resolution, 1, 2, 1);
}

export class ParticleAccumulationBackgroundSurface {
  /** @returns {string} */
  static get surfaceType() {
    return "background";
  }

  /** @returns {string} */
  static get fragmentShader() {
    return `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
void main() {
  gl_FragColor = vec4(0.0);
}
`;
  }

  /** @returns {string} */
  static get defaultColorHex() {
    return "#edf5ff";
  }

  /** @returns {number[]} */
  static get defaultColorRgb() {
    return [0.93, 0.96, 1.0];
  }

  /** @returns {number} */
  static get maxOpacity() {
    return 1;
  }

  /** @returns {number} */
  static get trailRefillDurationMultiplier() {
    return 1;
  }

  /**
   * @param {{uid?:string, options?:object, state?:object, dimensions?:object, renderer?:object, trailStore?:object|null, owner?:object|null}} [config]
   */
  constructor({
    uid = "particle-background",
    options = {},
    state = {},
    dimensions = null,
    renderer = null,
    trailStore = null,
    owner = null,
  } = {}) {
    this.type = String(this.constructor.surfaceType ?? "snow");
    this.uid = uid;
    this.owner = owner ?? null;
    this._localStartedAtEpoch = null;
    this._progressClockSignature = null;
    this._progressBase = 0;
    this._progressBaseTick = particleBackgroundMonotonicNow();
    this._destroyed = false;
    this.trailStore = trailStore ?? null;
    this.trailsEnabled = false;
    this.trailRefillEnabled = false;
    this.trailWidth = 0.55;
    this.trailStrength = 0.82;
    this.trailRefillDurationSeconds = 180;

    this.filter = new PIXI.Filter(VERTEX_SHADER, this.constructor.fragmentShader, {
      uProgress: 1,
      uOpacity: 0.78,
      uRuntimeAlpha: 1,
      uSeed: stableSeed(uid) * 97.0,
      uGridSize: 100,
      uFillVariation: 0.75,
      uDriftStrength: 0.55,
      uDriftScale: 5,
      uRippleStrength: 0.45,
      uMigrationDistance: 0,
      uCoverage: 0.65,
      uPatchScale: 0.85,
      uReflectionStrength: 0.58,
      uShimmerStrength: 0.42,
      uShimmerSpeed: 0.7,
      uGroundMovementSpeed: 1,
      uTime: 0,
      uRainSheetTime: 0,
      uSnowstormSweepOpacity: 0,
      uSnowstormSweepScale: 0.55,
      uSnowstormSweepSpeed: 0.55,
      uSnowstormSweepStrength: 0.55,
      uRainDensity: 0.5,
      uRainScale: 1,
      uRainSpeed: 1,
      uRainTopDown: 0,
      uRainBackgroundQuality: 1,
      uRainInteractionStrength: 0,
      uRainInteractionLiftChance: 0.35,
      uRainInteractionSettleTime: 2.8,
      uWind: resolveWindVector(options),
      uRainSheetWind: resolveWindVector(options),
      uRainSheetBasis: resolveWindVector(options),
      uRainSheetPreviousBasis: resolveWindVector(options),
      uRainSheetBasisBlend: 1,
      uRainSheetTravel: new Float32Array([0, 0]),
      uRainSheetPreviousTravel: new Float32Array([0, 0]),
      uCssToWorld: new Float32Array(CSS_TO_WORLD_IDENTITY),
      uColor: new Float32Array([0.93, 0.96, 1.0]),
      uTrailTexture: PIXI.Texture.EMPTY,
      uTrailAgeTexture: PIXI.Texture.EMPTY,
      uTrailsEnabled: 0,
      uTrailStrength: 0.82,
      uTrailRefillEnabled: 0,
      uTrailRefillDuration: 180,
      uTrailClock: 0,
      uTrailBounds: new Float32Array(EMPTY_TRAIL_BOUNDS),
      uTrailTexel: new Float32Array(EMPTY_TRAIL_TEXEL),
    });
    this.filter.padding = 0;
    this.filter.autoFit = true;
    this.filter.resolution = resolveFilterResolution(renderer);

    this.displayObject = new PIXI.Sprite(PIXI.Texture.WHITE);
    this.displayObject.name = "fxmParticleBackgroundSurface";
    this.displayObject.eventMode = "none";
    this.displayObject.zIndex = -1000;
    this.displayObject.filters = [this.filter];
    this.displayObject.alpha = 1;
    this.displayObject.roundPixels = false;

    this.configure({ options, state, dimensions, renderer, trailStore, owner });
  }

  /**
   * @param {{options?:object, state?:object, dimensions?:object, renderer?:object, trailStore?:object|null, owner?:object|null}} [config]
   */
  configure({
    options = this.options ?? {},
    state = this.state ?? {},
    dimensions = null,
    renderer = null,
    trailStore = this.trailStore ?? null,
    owner = this.owner ?? null,
  } = {}) {
    if (this._destroyed) return;

    this.options = options ?? {};
    this.state = state ?? {};
    this.trailStore = trailStore ?? this.trailStore ?? null;
    this.owner = owner ?? this.owner ?? null;
    this.mode = particleBackgroundMode(this.options);
    this.durationSeconds = particleBackgroundDurationSeconds(this.options);
    const maxOpacity = clamp(this.constructor.maxOpacity, 0, 1, 1);
    this.opacity = clamp(unwrapParticleBackgroundOption(this.options?.backgroundOpacity), 0, 1, 0.78) * maxOpacity;
    this.fillVariation = clamp(unwrapParticleBackgroundOption(this.options?.backgroundFillVariation), 0, 1, 0.75);
    this.driftStrength = clamp(unwrapParticleBackgroundOption(this.options?.backgroundDriftStrength), 0, 1, 0.55);
    this.driftScale = clamp(unwrapParticleBackgroundOption(this.options?.backgroundDriftScale), 0.05, 20, 5);
    this.trailsEnabled = !!unwrapParticleBackgroundOption(this.options?.backgroundTrailsEnabled);
    this.trailRefillEnabled = !!unwrapParticleBackgroundOption(this.options?.backgroundTrailRefillEnabled);
    this.trailWidth = clamp(unwrapParticleBackgroundOption(this.options?.backgroundTrailWidth), 0, 2, 0.55);
    this.trailStrength = clamp(unwrapParticleBackgroundOption(this.options?.backgroundTrailStrength), 0, 1, 0.82);
    const trailRefillDuration = Number(unwrapParticleBackgroundOption(this.options?.backgroundTrailRefillDuration));
    const refillMultiplier = clamp(this.constructor.trailRefillDurationMultiplier, 0.05, 4, 1);
    this.trailRefillDurationSeconds = Number.isFinite(trailRefillDuration)
      ? clamp(trailRefillDuration, 1, 3600, 180)
      : Math.max(0.25, this.durationSeconds * refillMultiplier);

    const tint = unwrapParticleBackgroundOption(this.options?.tint);
    const tintEnabled = !!(tint && typeof tint === "object" && tint.apply);
    const tintValue = tintEnabled ? tint.value : this.constructor.defaultColorHex ?? "#edf5ff";
    this.filter.uniforms.uColor = parseHexColor(tintValue, this.constructor.defaultColorRgb ?? [0.93, 0.96, 1.0]);
    this.filter.uniforms.uSeed = resolvePatternSeed(this.uid, this.state);
    this.filter.uniforms.uFillVariation = this.fillVariation;
    this.filter.uniforms.uDriftStrength = this.driftStrength;
    this.filter.uniforms.uDriftScale = this.driftScale;
    this.filter.uniforms.uWind = resolveWindVector(this.options);
    this.filter.uniforms.uTrailStrength = this.trailStrength;
    this.filter.resolution = resolveFilterResolution(renderer);

    if (dimensions) this.setDimensions(dimensions);
    this._configureTrailStore();

    const now = particleBackgroundNow();
    const tick = particleBackgroundMonotonicNow();
    this._syncProgressClock(now, tick);
    this.update({ now, tick });
  }

  /**
   * @param {object} dimensions
   */
  setDimensions(dimensions) {
    if (this._destroyed) return;
    const bounds = resolveDimensions(dimensions);
    this.bounds = bounds;

    try {
      this.displayObject.position.set(bounds.x, bounds.y);
      this.displayObject.width = bounds.width;
      this.displayObject.height = bounds.height;
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    const uniforms = this.filter?.uniforms;
    if (uniforms) uniforms.uGridSize = bounds.gridSize;

    try {
      this.trailStore?.setBounds?.(bounds);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    this._syncTrailUniforms();
  }

  _trailResetSignature() {
    const background = this.state?.background ?? {};
    const movement = this.state?.backgroundMovement ?? {};
    return [
      this.uid,
      this.mode,
      background.profile ?? 0,
      background.revision ?? 0,
      background.startedAt ?? "",
      background.patternSeed ?? "",
      movement.profile ?? 0,
      movement.revision ?? 0,
      movement.startedAt ?? "",
    ].join(":");
  }

  _configureTrailStore() {
    const store = this.trailStore ?? null;
    if (!store) {
      this._syncTrailUniforms();
      return;
    }

    try {
      store.setEnabled?.(this.trailsEnabled);
      if (this.bounds) store.setBounds?.(this.bounds);
      store.resetForSignature?.(this._trailResetSignature());
      store.setRefillEnabled?.(this.trailsEnabled && this.trailRefillEnabled, particleBackgroundMonotonicNow());
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    this._syncTrailUniforms();
  }

  _trailActivityDurationSeconds() {
    if (!(this.trailsEnabled && this.trailRefillEnabled)) return Infinity;
    return Math.max(0.25, Number(this.trailRefillDurationSeconds) || 0.25) + 0.25;
  }

  _syncTrailUniforms(tick = particleBackgroundMonotonicNow()) {
    const uniforms = this.filter?.uniforms;
    if (!uniforms) return;
    const store = this.trailStore ?? null;
    const activeDurationSeconds = this._trailActivityDurationSeconds();
    const activeMask = !!(
      this.trailsEnabled &&
      store?.enabled &&
      (typeof store?.hasActiveMask === "function"
        ? store.hasActiveMask(tick, activeDurationSeconds)
        : store?.texture && store.texture !== PIXI.Texture.EMPTY)
    );
    if (!activeMask && this.trailRefillEnabled) {
      try {
        store?.clearExpiredRefillMask?.(tick, activeDurationSeconds);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
    const refillEnabled = activeMask && this.trailRefillEnabled && store?.hasRefillMask;
    uniforms.uTrailTexture = activeMask ? store?.texture ?? PIXI.Texture.EMPTY : PIXI.Texture.EMPTY;
    uniforms.uTrailAgeTexture = refillEnabled ? store?.ageTexture ?? PIXI.Texture.EMPTY : PIXI.Texture.EMPTY;
    uniforms.uTrailsEnabled = activeMask ? 1 : 0;
    uniforms.uTrailStrength = this.trailStrength;
    uniforms.uTrailRefillEnabled = refillEnabled ? 1 : 0;
    uniforms.uTrailRefillDuration = Math.max(0.25, this.trailRefillDurationSeconds);
    uniforms.uTrailClock = refillEnabled ? Number(store?.refillClockAt?.(tick) ?? 0) || 0 : 0;
    uniforms.uTrailBounds = store?.uniformBounds ?? EMPTY_TRAIL_BOUNDS;
    uniforms.uTrailTexel = activeMask ? store?.uniformTexel ?? EMPTY_TRAIL_TEXEL : EMPTY_TRAIL_TEXEL;
  }

  /**
   * Stamp token movement into the shared world-space trail mask.
   *
   * @param {{from:{x:number,y:number},to:{x:number,y:number},tokenWidth?:number,tokenHeight?:number,tick?:number,ageMs?:number}} movement
   * @returns {boolean}
   */
  stampTokenTrail({
    from,
    to,
    tokenWidth = 0,
    tokenHeight = 0,
    tick = particleBackgroundMonotonicNow(),
    ageMs = 0,
  } = {}) {
    if (!this.trailsEnabled || !this.trailStore?.enabled) return false;
    const grid = Math.max(1, Number(this.bounds?.gridSize ?? canvas?.dimensions?.size ?? 100) || 100);
    const width = Math.max(grid * 0.25, Math.min(Number(tokenWidth) || grid, Number(tokenHeight) || grid));
    if (this.trailRefillEnabled) {
      try {
        this.trailStore.clearExpiredRefillMask?.(tick, this._trailActivityDurationSeconds());
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
    return !!this.trailStore.stampSegment?.({ from, to, width: width * this.trailWidth, tick, ageMs });
  }

  flushTrails() {
    try {
      this.trailStore?.flush?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  clearTrails() {
    try {
      this.trailStore?.clear?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  /**
   * Resolve the stored start time. Timing profiles from earlier builds are
   * intentionally restarted locally once so a previously accelerated surface
   * does not remain complete after upgrading.
   *
   * @param {number} now
   * @returns {number}
   */
  _resolveStartedAt(now) {
    const profile = Number(this.state?.background?.profile);
    const storedStartedAt =
      profile === PARTICLE_BACKGROUND_STATE_PROFILE
        ? normalizeParticleBackgroundTimestamp(this.state?.background?.startedAt, now)
        : null;

    if (storedStartedAt !== null) {
      this._localStartedAtEpoch = null;
      return storedStartedAt;
    }

    this._localStartedAtEpoch ??= now;
    return this._localStartedAtEpoch;
  }

  /**
   * Seed the runtime timer from persistent epoch state, then advance it using a
   * monotonic millisecond clock. This prevents server clock units or wall-clock
   * corrections from changing the configured duration.
   *
   * @param {number} now
   * @param {number} tick
   */
  _syncProgressClock(now, tick) {
    const nowMs = normalizeParticleBackgroundTimestamp(now, Date.now()) ?? particleBackgroundNow();
    const monotonicTick = Number.isFinite(Number(tick)) ? Number(tick) : particleBackgroundMonotonicNow();

    if (this.mode !== "accumulate") {
      this._progressClockSignature = "full";
      this._progressBase = 1;
      this._progressBaseTick = monotonicTick;
      return;
    }

    const startedAt = this._resolveStartedAt(nowMs);
    const revision = Number(this.state?.background?.revision) || 0;
    const profile = Number(this.state?.background?.profile) || 0;
    const signature = `${startedAt}:${this.durationSeconds}:${revision}:${profile}`;
    if (signature === this._progressClockSignature) return;

    this._progressClockSignature = signature;
    this._progressBase = clamp((nowMs - startedAt) / (this.durationSeconds * 1000), 0, 1, 0);
    this._progressBaseTick = monotonicTick;
  }

  /**
   * @param {number} [now]
   * @param {number} [tick]
   * @returns {number}
   */
  progressAt(now = particleBackgroundNow(), tick = particleBackgroundMonotonicNow()) {
    if (this.mode !== "accumulate") return 1;

    this._syncProgressClock(now, tick);
    const elapsed = Math.max(0, Number(tick) - this._progressBaseTick);
    return clamp(this._progressBase + elapsed / (this.durationSeconds * 1000), 0, 1, 0);
  }

  /**
   * @param {{fx?:PIXI.DisplayObject|null, now?:number, tick?:number}} [config]
   */
  update({ fx = null, now = particleBackgroundNow(), tick = particleBackgroundMonotonicNow() } = {}) {
    if (this._destroyed || !this.displayObject || this.displayObject.destroyed) return;

    const uniforms = this.filter?.uniforms;
    if (uniforms) {
      const progress = this.progressAt(now, tick);
      uniforms.uProgress = progress;
      uniforms.uOpacity = this.opacity;
      uniforms.uRuntimeAlpha = clamp(fx?.alpha, 0, 1, 1);
      uniforms.uWind = resolveWindVector(this.options);
      const particleContext =
        CONFIG.fxmaster?.getParticleContext?.(this.owner ?? this.options) ?? this.options?.__fxmParticleContext ?? null;
      uniforms.uCssToWorld = updateCssToWorldMatrix(uniforms.uCssToWorld, particleContext);
      this._syncTrailUniforms(tick);
      this._updateSurfaceUniforms?.({ now, tick, progress, uniforms, fx });
    }

    this.displayObject.alpha = 1;
    this.displayObject.visible = fx?.visible !== false;
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    try {
      this.displayObject?.parent?.removeChild?.(this.displayObject);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      if (this.displayObject) this.displayObject.filters = [];
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      this.filter?.destroy?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
    try {
      this.displayObject?.destroy?.({ texture: false, baseTexture: false });
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    this.filter = null;
    this.displayObject = null;
    this.trailStore = null;
  }
}
