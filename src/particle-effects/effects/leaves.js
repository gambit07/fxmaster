import { FXMasterParticleEffect } from "./effect.js";
import { DefaultRectangleSpawnMixin } from "./mixins/default-rectangle-spawn.js";

/**
 * Convert the delta passed to PIXI-particles emitter.update into seconds.
 * PIXI provides deltaTime where 1.0 ~= one 60fps frame.
 */
function fxmDeltaSeconds(delta) {
  if (typeof delta !== "number" || !Number.isFinite(delta)) return 1 / 60;
  return delta / 60;
}

function fxmNextParticle(p) {
  return p?.next ?? p?._next ?? p?.nextParticle ?? p?._nextParticle ?? p?.__next ?? null;
}

function fxmForEachEmitterParticle(emitter, fn) {
  let p = emitter?._activeParticlesFirst;
  if (p) {
    const max = Math.min(emitter?.particleCount ?? emitter?.maxParticles ?? 10000, 20000);
    for (let i = 0; p && i < max; i++) {
      fn(p);
      p = fxmNextParticle(p);
    }
    return;
  }
}

/**
 * A full-screen particle effect which renders gently falling autumn leaves.
 */
export class AutumnLeavesParticleEffect extends DefaultRectangleSpawnMixin(FXMasterParticleEffect) {
  /** @override */
  static label = "FXMASTER.Particles.Effects.AutumnLeaves";

  /** @override */
  static get icon() {
    return "modules/fxmaster/assets/particle-effects/icons/autumn-leaves.webp";
  }

  /** @override */
  static get group() {
    return "ambient";
  }

  /** @override */
  static get parameters() {
    const p = super.parameters;
    return {
      belowTokens: p.belowTokens,
      tint: p.tint,
      topDown: { label: "FXMASTER.Params.TopDown", type: "checkbox", value: false },
      scale: p.scale,
      speed: p.speed,
      lifetime: p.lifetime,
      density: { ...p.density, min: 0.05, value: 0.25, max: 1, step: 0.05, decimals: 2 },
      alpha: p.alpha,
    };
  }

  /**
   * Configuration for the particle emitter for falling leaves
   * @type {PIXI.particles.EmitterConfigV3}
   */
  static LEAF_CONFIG = {
    lifetime: { min: 10, max: 10 },
    behaviors: [
      {
        type: "alpha",
        config: {
          alpha: {
            list: [
              { time: 0, value: 0.9 },
              { time: 0.85, value: 0.5 },
              { time: 1, value: 0 },
            ],
          },
        },
      },
      {
        type: "moveSpeed",
        config: {
          speed: {
            list: [
              { time: 0, value: 20 },
              { time: 1, value: 60 },
            ],
          },
          minMult: 0.6,
        },
      },
      {
        type: "scale",
        config: {
          scale: {
            list: [
              { time: 0, value: 0.2 },
              { time: 1, value: 0.4 },
            ],
          },
          minMult: 0.5,
        },
      },
      {
        type: "rotation",
        config: { accel: 0, minSpeed: 100, maxSpeed: 200, minStart: 0, maxStart: 365 },
      },
      {
        type: "textureRandom",
        config: {
          textures: Array.fromRange(6).map(
            (n) => `modules/fxmaster/assets/particle-effects/effects/autumnleaves/leaf${n + 1}.webp`,
          ),
        },
      },
    ],
  };

  /** @override */
  static get defaultConfig() {
    return this.LEAF_CONFIG;
  }

  /** @override */
  getParticleEmitters(options = {}) {
    options = this.constructor.mergeWithDefaults(options);
    const topDown = !!options?.topDown?.value;

    if (!topDown) {
      this._fxmCanvasPanOwnerPosEnabled = false;
      return super.getParticleEmitters(options);
    }

    this._fxmCanvasPanOwnerPosEnabled = true;

    const { maxParticles } = this.constructor.computeMaxParticlesFromView(options, {
      minViewCells: this.constructor.MIN_VIEW_CELLS ?? 3000,
    });

    const d = CONFIG.fxmaster.getParticleDimensions(options);
    const sceneRadius = Math.sqrt(d.sceneWidth * d.sceneWidth + d.sceneHeight * d.sceneHeight) / 2;

    const config = foundry.utils.deepClone(this.constructor.LEAF_CONFIG);
    config.maxParticles = maxParticles;

    const lifetime = config.lifetime ?? 1;
    const lifetimeMin = typeof lifetime === "number" ? lifetime : lifetime.min ?? 1;
    config.frequency = lifetimeMin / maxParticles;

    config.behaviors = (config.behaviors ?? []).filter((b) => b.type !== "rotation" && b.type !== "rotationStatic");
    config.behaviors.push({ type: "rotationStatic", config: { min: 175, max: 185 } });

    const scaleBehavior = (config.behaviors ?? []).find((b) => b.type === "scale");
    const scaleList = scaleBehavior?.config?.scale?.list;
    if (Array.isArray(scaleList) && scaleList.length) {
      const start = scaleList[0]?.value ?? 0.2;
      const mid = scaleList[scaleList.length - 1]?.value ?? 0.4;
      scaleBehavior.config.scale.list = [
        { time: 0, value: start },
        { time: 0.75, value: mid },
        { time: 1, value: 0.06 },
      ];
    }

    this.applyOptionsToConfig(options, config);

    const moveSpeedBehavior = config.behaviors.find(({ type }) => type === "moveSpeed");
    const moveSpeedList = moveSpeedBehavior?.config?.speed?.list ?? [{ value: 20 }, { value: 60 }];
    const averageSpeed =
      moveSpeedList.reduce((acc, cur) => acc + (cur.value ?? 0), 0) / Math.max(1, moveSpeedList.length);

    const lifetimeMax = typeof config.lifetime === "number" ? config.lifetime : config.lifetime?.max ?? lifetimeMin;

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

    const rotationCfg = this.constructor.LEAF_CONFIG?.behaviors?.find((b) => b.type === "rotation")?.config ?? {};
    const minDeg = Number(rotationCfg.minSpeed ?? 100);
    const maxDeg = Number(rotationCfg.maxSpeed ?? 200);
    const minRad = (Math.min(minDeg, maxDeg) * Math.PI) / 180;
    const maxRad = (Math.max(minDeg, maxDeg) * Math.PI) / 180;

    const origUpdate = emitter.update.bind(emitter);
    emitter.update = (delta) => {
      const dt = fxmDeltaSeconds(delta);

      fxmForEachEmitterParticle(emitter, (p) => {
        if (p?._fxmTDMoveDir !== undefined) p.rotation = p._fxmTDMoveDir;
      });

      origUpdate(delta);

      fxmForEachEmitterParticle(emitter, (p) => {
        if (!p) return;

        p._fxmTDMoveDir = p.rotation;

        const age =
          typeof p.age === "number"
            ? p.age
            : typeof p._age === "number"
            ? p._age
            : typeof p.life === "number"
            ? p.life
            : typeof p._life === "number"
            ? p._life
            : undefined;

        const respawn =
          age !== undefined &&
          typeof p._fxmTDLastAge === "number" &&
          Number.isFinite(p._fxmTDLastAge) &&
          age < p._fxmTDLastAge;
        p._fxmTDLastAge = age;

        if (respawn || p._fxmTDSpinVel === undefined || p._fxmTDVisualBase === undefined) {
          p._fxmTDVisualBase = Math.random() * Math.PI * 2;
          p._fxmTDSpin = Math.random() * Math.PI * 2;

          const u = Math.random();
          const vel = minRad + u * (maxRad - minRad);
          p._fxmTDSpinVel = (Math.random() < 0.5 ? -1 : 1) * vel;
        }

        p._fxmTDSpin = (p._fxmTDSpin ?? 0) + (p._fxmTDSpinVel ?? 0) * dt;
        p.rotation = (p._fxmTDVisualBase ?? 0) + (p._fxmTDSpin ?? 0);
      });
    };

    return [emitter];
  }
}
