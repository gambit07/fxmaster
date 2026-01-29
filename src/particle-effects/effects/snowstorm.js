import { FXMasterParticleEffect } from "./effect.js";

/**
 * A full-screen particle effect which renders heavy snow fall.
 */
export class SnowstormParticleEffect extends FXMasterParticleEffect {
  /** @override */
  static label = "FXMASTER.Particles.Effects.Snowstorm";

  /** @override */
  static get icon() {
    return "modules/fxmaster/assets/particle-effects/icons/snow-storm.webp";
  }

  /** @override */
  static get group() {
    return "weather";
  }

  /** @override */
  static get parameters() {
    const p = super.parameters;
    return {
      belowTokens: p.belowTokens,
      tint: p.tint,
      topDown: { label: "FXMASTER.Params.TopDown", type: "checkbox", value: false },
      rotationStrength: {
        label: "FXMASTER.Params.RotationStrength",
        type: "range",
        min: 0,
        value: 3,
        max: 5,
        step: 0.5,
        decimals: 1,
        showWhen: { topDown: true },
      },
      scale: p.scale,
      direction: { ...p.direction, showWhen: { topDown: false } },
      speed: { ...p.speed, min: 0.1, max: 10, value: 5, step: 0.05, decimals: 2 },
      lifetime: p.lifetime,
      density: { ...p.density, min: 0.05, value: 0.6, max: 1, step: 0.05, decimals: 2 },
      alpha: p.alpha,
    };
  }

  /**
   * Configuration for the particle emitter for heavy snow fall
   * @type {PIXI.particles.EmitterConfigV3}
   */
  static SNOWSTORM_CONFIG = {
    lifetime: { min: 2.5, max: 6 },
    behaviors: [
      {
        type: "alphaStatic",
        config: { alpha: 1 },
      },
      {
        type: "movePath",
        config: {
          path: "sin(x / 150) * 25",
          speed: {
            list: [
              { value: 400, time: 0 },
              { value: 350, time: 1 },
            ],
          },
          minMult: 0.2,
        },
      },
      {
        type: "scale",
        config: {
          scale: {
            list: [
              { value: 0.2, time: 0 },
              { value: 0.08, time: 1 },
            ],
          },
          minMult: 0.8,
        },
      },
      {
        type: "rotation",
        config: { accel: 0, minSpeed: -60, maxSpeed: 60, minStart: 86, maxStart: 94 },
      },
      {
        type: "textureRandom",
        config: {
          textures: Array.fromRange(2).map(
            (n) => `modules/fxmaster/assets/particle-effects/effects/snowstorm/snow${n + 1}.webp`,
          ),
        },
      },
    ],
  };

  /** @override */
  static get defaultConfig() {
    return this.SNOWSTORM_CONFIG;
  }

  /** @override */
  getParticleEmitters(options = {}) {
    options = this.constructor.mergeWithDefaults(options);

    const topDown = !!options?.topDown?.value;
    if (topDown) return this._getTopDownEmitters(options);

    this._fxmCanvasPanOwnerPosEnabled = false;

    const d = CONFIG.fxmaster.getParticleDimensions(options);

    const { maxParticles } = this.constructor.computeMaxParticlesFromView(options, {
      minViewCells: this.constructor.MIN_VIEW_CELLS ?? 15000,
    });

    const config = foundry.utils.deepClone(this.constructor.defaultConfig);
    config.maxParticles = maxParticles;

    const lifetime = config.lifetime ?? 1;
    let avgLifetime;
    if (typeof lifetime === "number") {
      avgLifetime = lifetime;
    } else {
      const min = lifetime.min ?? lifetime.max ?? 1;
      const max = lifetime.max ?? lifetime.min ?? min;
      avgLifetime = (min + max) / 2;
    }
    config.frequency = avgLifetime / maxParticles;

    config.behaviors.push({
      type: "spawnShape",
      config: {
        type: "rect",
        data: { x: d.sceneRect.x, y: d.sceneRect.y, w: d.sceneRect.width, h: d.sceneRect.height },
      },
    });

    this.applyOptionsToConfig(options, config);

    return [this.createEmitter(config)];
  }

  /**
   * Build a top-down variant of the snowstorm effect.
   * - Spawns in a ring around the view center (torus)
   * - Forces inward motion (spawnShape affectRotation + rotationStatic 180)
   * - Leaves a central "hole" so it doesn't read as a vortex
   * - Keeps ownerPos synced to canvas pan/zoom
   * @private
   */
  _getTopDownEmitters(options) {
    this._fxmCanvasPanOwnerPosEnabled = true;

    const d = CONFIG.fxmaster.getParticleDimensions(options);

    const { maxParticles } = this.constructor.computeMaxParticlesFromView(options, {
      minViewCells: this.constructor.MIN_VIEW_CELLS ?? 15000,
    });

    const config = foundry.utils.deepClone(this.constructor.SNOWSTORM_CONFIG);
    config.maxParticles = maxParticles;

    const lifetime = config.lifetime ?? 1;
    let avgLifetime;
    if (typeof lifetime === "number") {
      avgLifetime = lifetime;
    } else {
      const min = lifetime.min ?? lifetime.max ?? 1;
      const max = lifetime.max ?? lifetime.min ?? min;
      avgLifetime = (min + max) / 2;
    }
    config.frequency = avgLifetime / maxParticles;

    const movePath = config.behaviors?.find((b) => b.type === "movePath");
    const movePathSpeed = movePath?.config?.speed ?? {
      list: [
        { value: 400, time: 0 },
        { value: 350, time: 1 },
      ],
    };
    const movePathMinMult = movePath?.config?.minMult ?? 0.2;

    config.behaviors = (config.behaviors ?? []).filter(
      (b) => b.type !== "rotation" && b.type !== "rotationStatic" && b.type !== "movePath",
    );

    config.behaviors.push({
      type: "moveSpeed",
      config: {
        speed: foundry.utils.deepClone(movePathSpeed),
        minMult: movePathMinMult,
      },
    });

    config.behaviors.push({ type: "rotationStatic", config: { min: 180, max: 180 } });

    const optsNoDir = foundry.utils.deepClone(options);
    try {
      delete optsNoDir.direction;
    } catch {}

    this.applyOptionsToConfig(optsNoDir, config);

    const moveSpeedBehavior = config.behaviors.find(({ type }) => type === "moveSpeed");
    const moveSpeedList = moveSpeedBehavior?.config?.speed?.list ?? [{ value: 400 }, { value: 350 }];
    const averageSpeed =
      moveSpeedList.reduce((acc, cur) => acc + (cur.value ?? 0), 0) / Math.max(1, moveSpeedList.length);

    const lifetimeMax = typeof config.lifetime === "number" ? config.lifetime : config.lifetime?.max ?? avgLifetime;

    const sceneRadius = Math.sqrt(d.sceneWidth * d.sceneWidth + d.sceneHeight * d.sceneHeight) / 2;

    const holeRadius = this.getTopDownDeadzoneRadius(d);

    const travel = averageSpeed * lifetimeMax;
    const innerRadius = travel + holeRadius;
    const outerRadius = innerRadius + sceneRadius * 2;

    config.behaviors.push({
      type: "spawnShape",
      config: {
        type: "torus",
        data: {
          x: d.sceneRect.x + d.sceneWidth / 2,
          y: d.sceneRect.y + d.sceneHeight / 2,
          radius: outerRadius,
          innerRadius,
          affectRotation: true,
        },
      },
    });

    const emitter = this.createEmitter(config);

    const ctx = options?.__fxmParticleContext ?? this.__fxmParticleContext;
    const ownerX = ctx ? 0 : canvas.stage.pivot.x - d.sceneX - d.sceneWidth / 2;
    const ownerY = ctx ? 0 : canvas.stage.pivot.y - d.sceneY - d.sceneHeight / 2;
    emitter.updateOwnerPos(ownerX, ownerY);

    try {
      const randBetween = (min, max) => min + Math.random() * (max - min);
      const smoothstep = (x) => x * x * (3 - 2 * x);
      const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

      // Re-target vortex every 10–30 seconds. Blend over 2–6 seconds.
      const MIN_HOLD = 10.0;
      const MAX_HOLD = 30.0;
      const MIN_BLEND = 2.0;
      const MAX_BLEND = 6.0;

      // Tangential drift magnitude as a ratio of inward speed.
      const BASE_RATIO = 0.85;
      const DELTA_RATIO = 0.12;
      const MIN_RATIO = 0.6;
      const MAX_RATIO = 1.05;

      // Overall multiplier for the top-down rotational drift.
      const rawRotationStrength = Number(options?.rotationStrength?.value);
      const ROTATION_STRENGTH = clamp(
        Math.round((Number.isFinite(rawRotationStrength) ? rawRotationStrength : 3) * 2) / 2,
        0,
        4,
      );

      const getCenter = () => {
        if (ctx) {
          return {
            x: d.sceneRect.x + d.sceneWidth / 2,
            y: d.sceneRect.y + d.sceneHeight / 2,
          };
        }
        return {
          x: canvas?.stage?.pivot?.x ?? d.sceneRect.x + d.sceneWidth / 2,
          y: canvas?.stage?.pivot?.y ?? d.sceneRect.y + d.sceneHeight / 2,
        };
      };

      const nextOf = (p) => p?.next ?? p?._next ?? p?.nextParticle ?? p?._nextParticle ?? p?.__next ?? null;

      const outerMinusHole = Math.max(1, outerRadius - holeRadius);

      const initSigned = (() => {
        const sign = Math.random() < 0.5 ? -1 : 1;
        const mag = clamp(BASE_RATIO + randBetween(-DELTA_RATIO, DELTA_RATIO), MIN_RATIO, MAX_RATIO);
        return sign * mag;
      })();

      emitter._fxmVortexState ??= {
        signed: initSigned,
        holdRemaining: randBetween(MIN_HOLD, MAX_HOLD),
        blendRemaining: 0,
        blendDuration: 0,
        fromSigned: initSigned,
        toSigned: initSigned,
      };

      const originalUpdate = emitter.update.bind(emitter);

      emitter.update = function (delta) {
        originalUpdate(delta);

        // Convert PIXI ticker deltaTime (~1 at 60fps) into seconds.
        let dt = 0;
        if (typeof delta === "number") {
          dt = delta > 0 && delta < 5 ? delta / 60 : delta > 5 ? delta / 1000 : delta;
        }
        if (!Number.isFinite(dt) || dt <= 0) return;
        dt = Math.min(dt, 0.05);

        const s = emitter._fxmVortexState;
        if (!s) return;

        if (s.blendRemaining > 0) {
          s.blendRemaining -= dt;
          const prog = 1 - s.blendRemaining / Math.max(1e-6, s.blendDuration);
          const u = smoothstep(clamp(prog, 0, 1));
          s.signed = s.fromSigned * (1 - u) + s.toSigned * u;
          if (s.blendRemaining <= 0) s.signed = s.toSigned;
        } else {
          s.holdRemaining -= dt;
          if (s.holdRemaining <= 0) {
            const cur = Number(s.signed) || initSigned;
            const curSign = Math.sign(cur) || 1;
            const curMag = Math.abs(cur);
            const nextSign = -curSign;
            const nextMag = clamp(curMag + randBetween(-DELTA_RATIO, DELTA_RATIO), MIN_RATIO, MAX_RATIO);

            s.fromSigned = cur;
            s.toSigned = nextSign * nextMag;
            s.blendDuration = randBetween(MIN_BLEND, MAX_BLEND);
            s.blendRemaining = s.blendDuration;
            s.holdRemaining = randBetween(MIN_HOLD, MAX_HOLD);
          }
        }

        const signedRatio = Number(s.signed) || 0;
        if (!Number.isFinite(signedRatio) || signedRatio === 0) return;

        const first = emitter._activeParticlesFirst;

        const getArrayParticles = () => {
          const pc = emitter.particleContainer ?? emitter._particleContainer;
          const candidates = [
            emitter.particles,
            emitter._particles,
            emitter._activeParticles,
            emitter._active,
            pc?.children,
          ];
          for (const c of candidates) {
            if (Array.isArray(c) && c.length) return c;
          }
          return null;
        };

        let arrayParticles = null;
        if (!first) {
          arrayParticles = getArrayParticles();
          if (!arrayParticles) return;
        }

        const c = getCenter();
        const cx = c.x;
        const cy = c.y;

        const applyVortex = (p) => {
          const px = p?.x ?? p?.position?.x;
          const py = p?.y ?? p?.position?.y;
          if (!Number.isFinite(px) || !Number.isFinite(py)) return;

          const dx = px - cx;
          const dy = py - cy;
          const r = Math.hypot(dx, dy);
          if (!Number.isFinite(r) || r <= holeRadius * 0.95) return;

          const f = clamp((r - holeRadius) / outerMinusHole, 0, 1);
          const env = smoothstep(f);
          if (env <= 0) return;

          let mul = p._fxmVortexMul;
          if (!Number.isFinite(mul)) {
            mul = randBetween(0.85, 1.15);
            p._fxmVortexMul = mul;
          }

          const invR = 1 / r;
          const tx = -dy * invR;
          const ty = dx * invR;

          const disp = averageSpeed * signedRatio * dt * env * mul * ROTATION_STRENGTH;
          if (!Number.isFinite(disp) || disp === 0) return;

          const nx = px + tx * disp;
          const ny = py + ty * disp;

          if (p.position) {
            p.position.x = nx;
            p.position.y = ny;
          } else {
            p.x = nx;
            p.y = ny;
          }
        };

        let iterated = 0;
        if (first) {
          const countHint = Number(emitter.particleCount ?? emitter.maxParticles ?? 0) || 0;
          const maxIter = Math.max(200, Math.min(12000, countHint ? countHint + 25 : 6000));
          let cur = first;
          for (let i = 0; cur && i < maxIter; i++) {
            const p = cur;
            const nxt = nextOf(cur);
            cur = !nxt || nxt === cur ? null : nxt;
            applyVortex(p);
            iterated++;
          }
        }

        if ((!first || iterated <= 1) && !arrayParticles) arrayParticles = getArrayParticles();

        if ((!first || iterated <= 1) && arrayParticles) {
          const n = arrayParticles.length;
          for (let i = 0; i < n; i++) applyVortex(arrayParticles[i]);
        }
      };
    } catch {}

    try {
      const was = !!emitter.autoUpdate;
      emitter.autoUpdate = false;
      emitter.autoUpdate = was;
    } catch {}

    return [emitter];
  }

  /** @override */
  play({ prewarm = false } = {}) {
    super.play({ prewarm });

    try {
      if (!this.options?.topDown?.value) return;
      const emitters = this.emitters ?? [];
      for (const e of emitters) {
        try {
          const was = !!e.autoUpdate;
          e.autoUpdate = false;
          e.autoUpdate = was;
        } catch {}
      }
    } catch {}
  }
}
