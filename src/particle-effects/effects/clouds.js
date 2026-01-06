import { FXMasterParticleEffect } from "./effect.js";

/**
 * A full-screen particle effect which renders drifting clouds.
 */
export class CloudsParticleEffect extends FXMasterParticleEffect {
  /** @override */
  static label = "FXMASTER.Particles.Effects.Clouds";

  /** @override */
  static get icon() {
    return "modules/fxmaster/assets/particle-effects/icons/clouds.webp";
  }

  /** @override */
  static get group() {
    return "weather";
  }

  /** @override */
  static get parameters() {
    return foundry.utils.mergeObject(super.parameters, {
      density: { min: 0.001, value: 0.03, max: 0.2, step: 0.001, decimals: 3 },
      dropShadow: { label: "FXMASTER.Params.Shadow", type: "checkbox", value: false },
      shadowOnly: { label: "FXMASTER.Params.ShadowOnly", type: "checkbox", value: false },
      shadowRotation: {
        label: "FXMASTER.Params.ShadowRotation",
        type: "range",
        min: 0,
        value: 315,
        max: 360,
        step: 1,
        decimals: 0,
      },
      shadowDistance: {
        label: "FXMASTER.Params.ShadowDistance",
        type: "range",
        min: 0,
        value: 70,
        max: 300,
        step: 1,
        decimals: 0,
      },
      shadowBlur: {
        label: "FXMASTER.Params.ShadowBlur",
        type: "range",
        min: 0,
        value: 2,
        max: 20,
        step: 0.5,
        decimals: 1,
      },
      shadowOpacity: {
        label: "FXMASTER.Params.ShadowOpacity",
        type: "range",
        min: 0,
        value: 1,
        max: 1,
        step: 0.05,
        decimals: 2,
      },
    });
  }

  /**
   * Configuration for the particle emitter for drifting clouds
   * @type {PIXI.particles.EmitterConfigV3}
   */
  static CLOUDS_CONFIG = {
    behaviors: [
      {
        type: "alpha",
        config: {
          alpha: {
            list: [
              { value: 0, time: 0 },
              { value: 0.5, time: 0.05 },
              { value: 0.5, time: 0.95 },
              { value: 0, time: 1 },
            ],
          },
        },
      },
      { type: "moveSpeedStatic", config: { min: 30, max: 100 } },
      { type: "scaleStatic", config: { min: 0.08, max: 0.8 } },
      { type: "rotationStatic", config: { min: 80, max: 100 } },
      {
        type: "textureRandom",
        config: {
          textures: Array.fromRange(4).map(
            (n) => `modules/fxmaster/assets/particle-effects/effects/clouds/cloud${n + 1}.webp`,
          ),
        },
      },
    ],
  };

  /** @override */
  static get defaultConfig() {
    return this.CLOUDS_CONFIG;
  }

  /** @override */
  getParticleEmitters(options = {}) {
    options = this.constructor.mergeWithDefaults(options);
    const d = CONFIG.fxmaster.getParticleDimensions(options);

    const { maxParticles } = this.constructor.computeMaxParticlesFromView(options, {
      minViewCells: this.constructor.MIN_VIEW_CELLS ?? 3000,
    });

    const offsetFactor = 2 / 3;
    const config = foundry.utils.deepClone(this.constructor.CLOUDS_CONFIG);
    const speed = config.behaviors.find(({ type }) => type === "moveSpeedStatic")?.config;
    if (speed === undefined) {
      throw new Error("Expected CLOUDS_CONFIG to have a moveSpeedStatic behavior but it didn't.");
    }

    const diagonal = Math.sqrt(d.sceneRect.width * d.sceneRect.width + d.sceneRect.height * d.sceneRect.height);
    const averageSpeed = (speed.min + speed.max) / 2;
    const averageDiagonalTime = diagonal / averageSpeed;
    const minLifetime = averageDiagonalTime / offsetFactor / 2;
    const maxLifetime = averageDiagonalTime / offsetFactor;

    const angle = Math.toRadians(options.direction.value);
    const directionVector = {
      x: Math.cos(angle),
      y: Math.sin(angle),
    };

    config.maxParticles = maxParticles;
    config.frequency = (minLifetime + maxLifetime) / 2 / maxParticles;
    config.lifetime = { min: minLifetime, max: maxLifetime };
    config.behaviors.push({
      type: "spawnShape",
      config: {
        type: "rect",
        data: {
          x: d.sceneRect.x - directionVector.x * d.sceneRect.width * offsetFactor,
          y: d.sceneRect.y - directionVector.y * d.sceneRect.height * offsetFactor,
          w: d.sceneRect.width,
          h: d.sceneRect.height,
        },
      },
    });

    config._dropShadowEnabled = !!options.dropShadow?.value;
    config._dropShadowOnly = !!options.shadowOnly?.value;
    config._dropshadowRotation = Number.isFinite(options.shadowRotation?.value) ? options.shadowRotation.value : 315;
    config._dropshadowDistance = Number.isFinite(options.shadowDistance?.value)
      ? options.shadowDistance.value
      : Math.hypot(50, 50);
    config._dropshadowBlur = Number.isFinite(options.shadowBlur?.value) ? options.shadowBlur.value : 2;
    config._dropshadowOpacity = Number.isFinite(options.shadowOpacity?.value) ? options.shadowOpacity.value : 1;

    this.applyOptionsToConfig(options, config);

    return [this.createEmitter(config)];
  }

  /**
   * Create the particle emitter and (optionally) a single, wrapper-level DropShadowFilter.
   * @param {PIXI.particles.EmitterConfigV3 & {
   *   _dropShadowEnabled?: boolean,
   *   _dropShadowOnly?: boolean,
   *   _dropshadowRotation?: number,
   *   _dropshadowDistance?: number,
   *   _dropshadowBlur?: number,
   *   _dropshadowOpacity?: number
   * }} config
   * @returns {PIXI.particles.Emitter}
   */
  createEmitter(config) {
    const wrapper = new PIXI.Container();
    this.addChild(wrapper);

    config.autoUpdate = true;
    config.emit = false;
    const emitter = new PIXI.particles.Emitter(wrapper, config);

    if (!config._dropShadowEnabled) return emitter;

    const r = CONFIG.fxmaster.getParticleRenderer(this);
    if (!r) return emitter;

    const DropShadowCtor = PIXI.filters.DropShadowFilter;

    const BASE_OFFSET = { x: 50, y: -50 };
    const baseDistance = Math.hypot(BASE_OFFSET.x, BASE_OFFSET.y) || 50;

    const angleDeg = Number.isFinite(config._dropshadowRotation) ? config._dropshadowRotation : 315;
    const angleRad = Math.toRadians(angleDeg);
    const distance = Number.isFinite(config._dropshadowDistance) ? config._dropshadowDistance : baseDistance;
    const blur = Number.isFinite(config._dropshadowBlur) ? config._dropshadowBlur : 1;
    const alpha = Number.isFinite(config._dropshadowOpacity) ? config._dropshadowOpacity : 0.5;
    const shadowOnly = !!config._dropShadowOnly;

    const dir = { x: Math.cos(angleRad), y: Math.sin(angleRad) };

    const screenRect = new PIXI.Rectangle(0, 0, 1, 1);

    const updateScreenRect = () => {
      const scr = r.screen;
      screenRect.x = 0;
      screenRect.y = 0;
      screenRect.width = Math.max(1, scr.width | 0);
      screenRect.height = Math.max(1, scr.height | 0);
    };

    updateScreenRect();

    const shadow = new DropShadowCtor({
      offset: { x: 0, y: 0 },
      blur,
      alpha,
      color: 0x000000,
      quality: 20,
      shadowOnly,
      resolution: r.resolution || window.devicePixelRatio || 1,
    });

    shadow.autoFit = false;
    shadow.padding = 0;

    wrapper.filterArea = screenRect;
    shadow.filterArea = screenRect;

    const clampShadowResolution = () => {
      try {
        const gl = r.gl;
        const maxTex = gl?.getParameter?.(gl.MAX_TEXTURE_SIZE) || 8192;

        const wCSS = Math.max(1, screenRect.width | 0);
        const hCSS = Math.max(1, screenRect.height | 0);
        const maxDim = Math.max(wCSS, hCSS);

        const baseRes = r.resolution || window.devicePixelRatio || 1;
        const safeRes = Math.max(0.5, Math.min(baseRes, maxTex / maxDim));

        if (!Number.isFinite(safeRes) || safeRes <= 0) {
          shadow.enabled = false;
          shadow.alpha = 0;
          return;
        }

        if (!Number.isFinite(shadow.resolution) || shadow.resolution > safeRes || shadow.resolution <= 0) {
          shadow.resolution = safeRes;
        }
      } catch {
        try {
          shadow.enabled = false;
          shadow.alpha = 0;
        } catch {}
      }
    };

    clampShadowResolution();

    const existing = wrapper.filters ?? null;
    wrapper.filters = existing ? existing.concat([shadow]) : [shadow];

    let lastOffX = NaN;
    let lastOffY = NaN;
    let lastBlur = NaN;
    let lastAlpha = NaN;
    let lastShadowOnly = undefined;

    const tick = () => {
      const zoom = canvas?.stage?.scale?.x ?? 1;

      const offX = dir.x * distance * zoom;
      const offY = dir.y * distance * zoom;

      if (offX !== lastOffX || offY !== lastOffY) {
        if (shadow.offset) {
          shadow.offset.x = offX;
          shadow.offset.y = offY;
        }
        lastOffX = offX;
        lastOffY = offY;
      }

      if (blur !== lastBlur) {
        if ("blur" in shadow) shadow.blur = blur;
        lastBlur = blur;
      }

      if (alpha !== lastAlpha) {
        if ("alpha" in shadow) shadow.alpha = alpha;
        lastAlpha = alpha;
      }

      if (shadowOnly !== lastShadowOnly) {
        if ("shadowOnly" in shadow) shadow.shadowOnly = shadowOnly;
        lastShadowOnly = shadowOnly;
      }
    };

    PIXI.Ticker.shared.add(tick);

    const onResize = () => {
      updateScreenRect();
      clampShadowResolution();
    };
    r.on("resize", onResize);

    const origDestroy = emitter.destroy?.bind(emitter);
    emitter.destroy = (...args) => {
      PIXI.Ticker.shared.remove(tick);
      try {
        r.off("resize", onResize);
      } catch {}

      try {
        if (wrapper.filters) {
          const arr = wrapper.filters.filter((f) => f !== shadow);
          wrapper.filters = arr.length ? arr : null;
        }
        shadow.destroy?.();
      } catch {}

      return origDestroy ? origDestroy(...args) : undefined;
    };

    return emitter;
  }
}
