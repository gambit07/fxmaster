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

function finiteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, min, max, fallback = min) {
  return Math.max(min, Math.min(max, finiteNumber(value, fallback)));
}

function smoothstep01(value) {
  const t = clamp(value, 0, 1, 0);
  return t * t * (3 - 2 * t);
}

function resolveDimensions(source) {
  const dimensions = source?.dimensions ?? source ?? canvas?.dimensions ?? {};
  const rect = dimensions.sceneRect ?? dimensions.rect ?? {};
  const x = Number(rect.x ?? dimensions.sceneX ?? 0) || 0;
  const y = Number(rect.y ?? dimensions.sceneY ?? 0) || 0;
  const width = Math.max(1, Number(rect.width ?? rect.w ?? dimensions.sceneWidth ?? dimensions.width ?? 1) || 1);
  const height = Math.max(1, Number(rect.height ?? rect.h ?? dimensions.sceneHeight ?? dimensions.height ?? 1) || 1);
  const gridSize = Math.max(1, Number(dimensions.size ?? canvas?.dimensions?.size ?? 100) || 100);
  return { x, y, width, height, gridSize };
}

function parseHexColorInt(value, fallback = 0xffffff) {
  let hex = typeof value === "string" ? value.trim() : "";
  if (/^[0-9a-f]{6}$/i.test(hex)) hex = `#${hex}`;
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return fallback;
  return Number.parseInt(hex.slice(1), 16) >>> 0;
}

function shadeColor(color, factor) {
  const safe = clamp(factor, 0, 1.25, 1);
  const red = Math.max(0, Math.min(255, Math.round(((color >>> 16) & 0xff) * safe)));
  const green = Math.max(0, Math.min(255, Math.round(((color >>> 8) & 0xff) * safe)));
  const blue = Math.max(0, Math.min(255, Math.round((color & 0xff) * safe)));
  return (red << 16) | (green << 8) | blue;
}

function textureIsRenderable(texture) {
  if (!texture || texture === PIXI.Texture.EMPTY) return false;
  if (typeof texture.valid === "boolean") return texture.valid;
  if (typeof texture.baseTexture?.valid === "boolean") return texture.baseTexture.valid;
  if (typeof texture.source?.valid === "boolean") return texture.source.valid;
  return true;
}

function textureLongestSide(texture) {
  const width = Number(texture?.orig?.width ?? texture?.frame?.width ?? texture?.width ?? 0);
  const height = Number(texture?.orig?.height ?? texture?.frame?.height ?? texture?.height ?? 0);
  const longest = Math.max(width, height);
  return Number.isFinite(longest) && longest > 0 ? longest : 1;
}

function resolveTexture(path) {
  if (!path) return PIXI.Texture.EMPTY;
  try {
    return PIXI.Texture.from(path);
  } catch (err) {
    logger.debug("FXMaster:", err);
    return PIXI.Texture.EMPTY;
  }
}

function createScatterGroundBatch(maxSize) {
  const ParticleContainer = PIXI.ParticleContainer;
  if (typeof ParticleContainer !== "function") return new PIXI.Container();
  const size = Math.max(1, Math.round(Number(maxSize) || 1));
  const batchSize = Math.max(64, Math.min(2048, size));
  try {
    const container = new ParticleContainer(
      size,
      { position: true, rotation: true, scale: true, tint: true, alpha: true },
      batchSize,
      true,
    );
    container.roundPixels = false;
    return container;
  } catch (err) {
    logger.debug("FXMaster:", err);
    return new PIXI.Container();
  }
}

function resolveDescriptorTextures(descriptor, options) {
  const source = descriptor ?? null;
  const selection = source?.textureSelection ?? null;
  const optionName = String(selection?.option ?? "").trim();
  const texturesByValue = selection?.texturesByValue ?? null;
  if (!optionName || !texturesByValue || typeof texturesByValue !== "object") return source;

  const raw = unwrapParticleBackgroundOption(options?.[optionName]);
  const values = raw instanceof Set ? Array.from(raw) : Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const selected = new Set(values.map((value) => String(value)));
  const defaultValuesRaw = selection?.defaultValues;
  const defaultValues =
    defaultValuesRaw instanceof Set
      ? Array.from(defaultValuesRaw)
      : Array.isArray(defaultValuesRaw)
      ? defaultValuesRaw
      : defaultValuesRaw == null
      ? []
      : [defaultValuesRaw];
  const defaults = new Set(defaultValues.map((value) => String(value)));
  const entries = Object.entries(texturesByValue);
  const texturePaths = (value) =>
    (Array.isArray(value) ? value : [value]).map((texture) => String(texture ?? "").trim()).filter(Boolean);
  const textures = Array.from(
    new Set(entries.filter(([value]) => selected.has(value)).flatMap(([, texture]) => texturePaths(texture))),
  );
  const defaultTextures = Array.from(
    new Set(entries.filter(([value]) => defaults.has(value)).flatMap(([, texture]) => texturePaths(texture))),
  );
  const fallback = Array.from(new Set(entries.flatMap(([, texture]) => texturePaths(texture))));

  return {
    ...source,
    textures: textures.length
      ? textures
      : defaultTextures.length
      ? defaultTextures
      : fallback.length
      ? fallback
      : Array.from(source?.textures ?? []),
  };
}

/**
 * Sprite-backed persistent background used by Autumn Leaves and future scatter
 * profiles. The shared store owns positions and physics while this class owns
 * only the PIXI display objects for one particle runtime.
 */
export class ScatterBackgroundSurface {
  constructor({
    descriptor = null,
    uid = "scatter-background",
    options = {},
    state = {},
    dimensions = null,
    trailStore = null,
  } = {}) {
    this.type = "scatter";
    this.uid = String(uid ?? "scatter-background");
    this.sourceDescriptor = descriptor ?? null;
    this.descriptor = descriptor ?? null;
    this.trailStore = trailStore ?? null;
    this.trailsEnabled = false;
    this._destroyed = false;
    this._sprites = [];
    this._textures = [];
    this._groundTextureContainers = [];
    this._storeGeneration = -1;
    this._spriteUpdateSignature = "";
    this._localStartedAtEpoch = null;
    this._progressClockSignature = null;
    this._progressBase = 0;
    this._progressBaseTick = particleBackgroundMonotonicNow();
    this._currentProgress = 1;

    this.displayObject = new PIXI.Container();
    this.displayObject.name = "fxmParticleScatterBackground";
    this.displayObject.eventMode = "none";
    this.displayObject.sortableChildren = false;
    this.displayObject.zIndex = -1000;
    this.displayObject.alpha = 1;

    this.groundContainer = new PIXI.Container();
    this.groundContainer.name = "fxmParticleScatterGround";
    this.groundContainer.eventMode = "none";
    this.groundContainer.sortableChildren = false;
    this.activeContainer = new PIXI.Container();
    this.activeContainer.name = "fxmParticleScatterActive";
    this.activeContainer.eventMode = "none";
    this.activeContainer.sortableChildren = false;
    this.displayObject.addChild(this.groundContainer);
    this.displayObject.addChild(this.activeContainer);

    this.configure({ descriptor, options, state, dimensions, trailStore });
  }

  configure({
    descriptor = this.descriptor,
    options = this.options ?? {},
    state = this.state ?? {},
    dimensions = null,
    trailStore = this.trailStore ?? null,
  } = {}) {
    if (this._destroyed) return;

    this.sourceDescriptor = descriptor ?? this.sourceDescriptor ?? this.descriptor ?? null;
    this.options = options ?? {};
    this.descriptor = resolveDescriptorTextures(this.sourceDescriptor, this.options);
    this.state = state ?? {};
    this.trailStore = trailStore ?? this.trailStore ?? null;
    this.mode = particleBackgroundMode(this.options);
    this.durationSeconds = particleBackgroundDurationSeconds(this.options);
    this.opacity = clamp(unwrapParticleBackgroundOption(this.options?.backgroundOpacity), 0, 1, 0.92);
    this.coverage = clamp(unwrapParticleBackgroundOption(this.options?.backgroundCoverage), 0.05, 1, 0.65);
    this.fillVariation = clamp(unwrapParticleBackgroundOption(this.options?.backgroundFillVariation), 0, 1, 0.7);
    this.pileStrength = clamp(unwrapParticleBackgroundOption(this.options?.backgroundPileStrength), 0, 1, 0.6);
    this.pileScale = clamp(unwrapParticleBackgroundOption(this.options?.backgroundPileSize), 0.5, 12, 3.5);
    const genericParticleSize = unwrapParticleBackgroundOption(this.options?.backgroundParticleSize);
    const legacyLeafSize = unwrapParticleBackgroundOption(this.options?.backgroundLeafSize);
    this.leafScale = clamp(genericParticleSize ?? legacyLeafSize, 0.05, 2.5, 1);
    this.interactionEnabled = !!unwrapParticleBackgroundOption(this.options?.backgroundInteractionEnabled);
    this.interactionRadius = clamp(
      unwrapParticleBackgroundOption(this.options?.backgroundInteractionRadius),
      0,
      2,
      0.9,
    );
    this.interactionStrength = clamp(
      unwrapParticleBackgroundOption(this.options?.backgroundInteractionStrength),
      0,
      1,
      0.7,
    );
    this.interactionSwirl = clamp(unwrapParticleBackgroundOption(this.options?.backgroundInteractionSwirl), 0, 1, 0.55);
    this.interactionLiftChance = clamp(
      unwrapParticleBackgroundOption(this.options?.backgroundInteractionLiftChance),
      0,
      1,
      0.25,
    );
    this.interactionSettleTime = clamp(
      unwrapParticleBackgroundOption(this.options?.backgroundInteractionSettleTime),
      0.4,
      12,
      3,
    );
    this.interactionSettleImpact = clamp(
      unwrapParticleBackgroundOption(this.options?.backgroundInteractionSettleImpact),
      0,
      1,
      1,
    );
    const rawDirection = unwrapParticleBackgroundOption(this.options?.direction);
    const numericDirection = Number(rawDirection);
    const hasExplicitDirection =
      rawDirection !== null && rawDirection !== undefined && rawDirection !== "" && Number.isFinite(numericDirection);
    const baseDirection = hasExplicitDirection
      ? numericDirection
      : this.descriptor?.seededDirection
      ? null
      : finiteNumber(this.descriptor?.defaultDirection, 270);
    this.direction = baseDirection;
    this.trailsEnabled = this.interactionEnabled;

    const tint = unwrapParticleBackgroundOption(this.options?.tint);
    const tintEnabled = !!(tint && typeof tint === "object" && tint.apply);
    this.tint = parseHexColorInt(tintEnabled ? tint.value : "#ffffff", 0xffffff);

    if (dimensions) this.setDimensions(dimensions);
    this._configureStore();
    this._spriteUpdateSignature = "";

    const now = particleBackgroundNow();
    const tick = particleBackgroundMonotonicNow();
    this._syncProgressClock(now, tick);
    this.update({ now, tick });
  }

  setDimensions(dimensions) {
    if (this._destroyed) return;
    this.bounds = resolveDimensions(dimensions);
    try {
      this.trailStore?.setBounds?.(this.bounds);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  _storeResetSignature() {
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

  _configureStore() {
    const store = this.trailStore ?? null;
    if (!store) return;

    try {
      store.setEnabled?.(true);
      if (this.bounds) store.setBounds?.(this.bounds);
      store.resetForSignature?.(this._storeResetSignature());
      store.configure?.({
        descriptor: this.descriptor,
        state: this.state,
        bounds: this.bounds,
        coverage: this.coverage,
        fillVariation: this.fillVariation,
        pileStrength: this.pileStrength,
        pileScale: this.pileScale,
        leafScale: this.leafScale,
        direction: this.direction,
      });
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    this._syncSprites();
  }

  _resolveTextures() {
    const paths = Array.isArray(this.descriptor?.textures) ? this.descriptor.textures : [];
    this._textures = paths.map(resolveTexture);
    if (!this._textures.length) this._textures = [PIXI.Texture.EMPTY];
  }

  _destroyGroundTextureContainers() {
    for (const container of this._groundTextureContainers) {
      try {
        container?.parent?.removeChild?.(container);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      try {
        container?.destroy?.({ children: false });
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
    this._groundTextureContainers = [];
  }

  _createGroundTextureContainers(leaves) {
    const counts = Array.from({ length: this._textures.length }, () => 0);
    for (const leaf of leaves ?? []) {
      const index = Math.max(0, Math.min(counts.length - 1, Number(leaf?.textureIndex) || 0));
      if (counts[index] !== undefined) counts[index] += 1;
    }
    this._groundTextureContainers = this._textures.map((_texture, index) => {
      const container = createScatterGroundBatch(counts[index] || 1);
      container.name = `fxmParticleScatterGroundTexture${index}`;
      container.eventMode = "none";
      container.interactive = false;
      container.interactiveChildren = false;
      container.sortableChildren = false;
      this.groundContainer.addChild(container);
      return container;
    });
  }

  _groundTextureContainer(leaf) {
    const count = this._groundTextureContainers.length;
    if (!count) return this.groundContainer;
    const index = Math.max(0, Math.min(count - 1, Number(leaf?.textureIndex) || 0));
    return this._groundTextureContainers[index] ?? this.groundContainer;
  }

  _destroySprites() {
    for (const sprite of this._sprites) {
      try {
        sprite?.parent?.removeChild?.(sprite);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      try {
        sprite?.destroy?.({ texture: false, baseTexture: false });
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
    }
    this._sprites = [];
  }

  _syncSprites() {
    const store = this.trailStore ?? null;
    if (!store || store.generation === this._storeGeneration) return;
    this._storeGeneration = store.generation;
    this._spriteUpdateSignature = "";
    this._destroySprites();
    this._destroyGroundTextureContainers();
    this._resolveTextures();
    this._createGroundTextureContainers(store.leaves);

    for (let index = 0; index < store.leaves.length; index++) {
      const leaf = store.leaves[index];
      const texture = this._textures[leaf.textureIndex % this._textures.length] ?? PIXI.Texture.EMPTY;
      const sprite = new PIXI.Sprite(texture);
      sprite.name = "fxmParticleScatterLeaf";
      sprite.eventMode = "none";
      sprite.anchor?.set?.(0.5);
      sprite.roundPixels = false;
      sprite.visible = false;
      sprite.alpha = 0;
      sprite.__fxmScatterLeafId = leaf.id;
      sprite.__fxmScatterTextureIndex = leaf.textureIndex;
      this._sprites.push(sprite);
    }
  }

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

  progressAt(now = particleBackgroundNow(), tick = particleBackgroundMonotonicNow()) {
    if (this.mode !== "accumulate") return 1;
    this._syncProgressClock(now, tick);
    const elapsed = Math.max(0, Number(tick) - this._progressBaseTick);
    return clamp(this._progressBase + elapsed / (this.durationSeconds * 1000), 0, 1, 0);
  }

  /**
   * Resolve how much of this field existed when a persisted disturbance was
   * created. Replaying against the historical progress prevents a reload from
   * moving leaves or petals which had not accumulated yet at that moment.
   *
   * @param {number} epochMs
   * @returns {number}
   */
  progressAtEpoch(epochMs) {
    if (this.mode !== "accumulate") return 1;
    const eventTime = Number(epochMs);
    if (!Number.isFinite(eventTime)) return this._currentProgress;
    const startedAt = normalizeParticleBackgroundTimestamp(
      this.state?.background?.startedAt,
      Math.max(Date.now(), eventTime),
    );
    if (startedAt === null) return this._currentProgress;
    return clamp((eventTime - startedAt) / (this.durationSeconds * 1000), 0, 1, 0);
  }

  stampTokenTrail({
    from,
    to,
    tokenWidth = 0,
    tokenHeight = 0,
    tick = particleBackgroundMonotonicNow(),
    disturbanceSeed = null,
  } = {}) {
    if (!this.interactionEnabled || !this.trailStore?.enabled) return false;
    const disturbed = this.trailStore.disturbSegment?.({
      from,
      to,
      tokenWidth,
      tokenHeight,
      tick,
      progress: this._currentProgress,
      radiusMultiplier: this.interactionRadius,
      strength: this.interactionStrength,
      swirl: this.interactionSwirl,
      liftChance: this.interactionLiftChance,
      settleSeconds: this.interactionSettleTime,
      settleImpact: this.interactionSettleImpact,
      disturbanceSeed,
    });
    return Number(disturbed) > 0;
  }

  flushTrails() {}

  /**
   * Reconstruct the deterministic resting field and replay persisted token
   * disturbances in chronological order.
   *
   * @param {Array<object>} events
   * @param {{now?:number,tick?:number}} [options]
   * @returns {number}
   */
  replayTokenTrailHistory(events, { now = particleBackgroundNow(), tick = particleBackgroundMonotonicNow() } = {}) {
    if (!this.interactionEnabled || !this.trailStore?.enabled) return 0;
    const replayEvents = (Array.isArray(events) ? events : []).map((event) => ({
      ...event,
      progress: this.progressAtEpoch(event?.occurredAt),
      radiusMultiplier: this.interactionRadius,
      strength: this.interactionStrength,
      swirl: this.interactionSwirl,
      liftChance: this.interactionLiftChance,
      settleSeconds: this.interactionSettleTime,
      settleImpact: this.interactionSettleImpact,
    }));
    return (
      Number(
        this.trailStore.replayDisturbanceHistory?.(replayEvents, {
          currentTime: now,
          currentTick: tick,
        }),
      ) || 0
    );
  }

  clearTrails() {
    try {
      this.trailStore?.resetMotion?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  }

  _updateSprite(sprite, leaf, progress) {
    const fadeWindow = this.mode === "accumulate" ? 0.055 : 0.001;
    const localAge = smoothstep01((progress - leaf.arrivalRank) / fadeWindow);
    if (!(localAge > 0.0001) || !textureIsRenderable(sprite.texture)) {
      sprite.parent?.removeChild?.(sprite);
      sprite.visible = false;
      sprite.alpha = 0;
      return;
    }

    sprite.visible = true;
    sprite.alpha = clamp(localAge * leaf.baseAlpha, 0, 1, 0);
    sprite.position.set(leaf.x, leaf.y - leaf.z * 0.62);
    sprite.rotation = leaf.rotation;
    sprite.tint = shadeColor(this.tint, leaf.brightness);

    const liftedScale = 1 + Math.min(0.16, (leaf.z / Math.max(1, this.bounds?.gridSize ?? 100)) * 0.11);
    const scale = (leaf.size * liftedScale) / textureLongestSide(sprite.texture);
    sprite.scale.set(scale);

    const targetContainer = leaf.awake ? this.activeContainer : this._groundTextureContainer(leaf);
    if (targetContainer && sprite.parent !== targetContainer) targetContainer.addChild(sprite);
  }

  update({ fx = null, now = particleBackgroundNow(), tick = particleBackgroundMonotonicNow() } = {}) {
    if (this._destroyed || !this.displayObject || this.displayObject.destroyed) return;

    const progress = this.progressAt(now, tick);
    this._currentProgress = progress;
    try {
      this.trailStore?.advance?.(tick, { progress });
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    this._syncSprites();
    const leaves = this.trailStore?.leaves ?? [];
    const count = Math.min(leaves.length, this._sprites.length);
    const motionRevision = Number(this.trailStore?.motionRevision) || 0;
    const awaitingTextures = this._textures.some((texture) => !textureIsRenderable(texture));
    const progressStep = Math.round(progress * 2048);
    const spriteSignature = [
      this._storeGeneration,
      motionRevision,
      progressStep,
      count,
      this.tint,
      Math.round(this.leafScale * 1000),
    ].join(":");
    if (awaitingTextures || spriteSignature !== this._spriteUpdateSignature) {
      if (!awaitingTextures) this._spriteUpdateSignature = spriteSignature;
      for (let index = 0; index < count; index++) this._updateSprite(this._sprites[index], leaves[index], progress);
    }

    const runtimeAlpha = clamp(fx?.alpha, 0, 1, 1);
    this.displayObject.alpha = clamp(this.opacity * runtimeAlpha, 0, 1, 1);
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
    this._destroySprites();
    this._destroyGroundTextureContainers();
    try {
      this.displayObject?.destroy?.({ children: true });
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    this.displayObject = null;
    this.groundContainer = null;
    this.activeContainer = null;
    this.trailStore = null;
    this._textures = [];
  }
}
