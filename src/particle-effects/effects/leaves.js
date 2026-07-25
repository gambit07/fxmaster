import { FXMasterParticleEffect, fxmDeltaSeconds, fxmForEachEmitterParticle, fxmGetParticleAge } from "./effect.js";
import { DefaultRectangleSpawnMixin } from "./mixins/default-rectangle-spawn.js";
import { geometricDirectionToScreenDegrees } from "../../utils.js";
import { logger } from "../../logger.js";

const LEAF_TWO_PI = Math.PI * 2;
const hideLeafDirectionalControls = ({ get }) => get("orbit") === true || get("topDown") === true;

const LEAF_EDGE_FRAGMENT_SHADER = `
varying vec2 vTextureCoord;
uniform sampler2D uSampler;
uniform vec4 inputPixel;
uniform vec4 inputClamp;
uniform float uEdgeStrength;
uniform float uEdgeWidth;

vec4 leafSample(vec2 offset) {
  return texture2D(uSampler, clamp(vTextureCoord + offset, inputClamp.xy, inputClamp.zw));
}

void main() {
  vec4 base = texture2D(uSampler, vTextureCoord);
  vec2 pixel = inputPixel.zw * uEdgeWidth;
  float leftAlpha = leafSample(vec2(-pixel.x, 0.0)).a;
  float rightAlpha = leafSample(vec2(pixel.x, 0.0)).a;
  float topAlpha = leafSample(vec2(0.0, -pixel.y)).a;
  float bottomAlpha = leafSample(vec2(0.0, pixel.y)).a;
  float neighborMax = max(max(leftAlpha, rightAlpha), max(topAlpha, bottomAlpha));
  float neighborMin = min(min(leftAlpha, rightAlpha), min(topAlpha, bottomAlpha));
  float outerEdge = max(0.0, neighborMax - base.a);
  float innerEdge = max(0.0, base.a - neighborMin);
  float outlineAlpha = outerEdge * uEdgeStrength * 0.82;
  float innerMix = innerEdge * uEdgeStrength * 0.48;
  vec3 edgeColor = vec3(0.055, 0.045, 0.03);
  vec4 shadedBase = vec4(mix(base.rgb, edgeColor * base.a, innerMix), base.a);
  vec4 outline = vec4(edgeColor * outlineAlpha, outlineAlpha);
  gl_FragColor = shadedBase + outline * (1.0 - shadedBase.a);
}
`;

function leafOptionValue(value, fallback = undefined) {
  if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "value")) return value.value;
  return value === undefined ? fallback : value;
}

function leafNumber(value, fallback = 0) {
  const numeric = Number(leafOptionValue(value, fallback));
  return Number.isFinite(numeric) ? numeric : fallback;
}

function leafClamp(value, min, max, fallback = min) {
  return Math.max(min, Math.min(max, leafNumber(value, fallback)));
}

function leafTintBrightness(tint, brightness) {
  const color = Number(tint);
  if (!Number.isFinite(color)) return tint;
  const factor = leafClamp(brightness, 0, 2, 1);
  const packed = color & 0xffffff;
  const red = Math.min(255, Math.round(((packed >> 16) & 0xff) * factor));
  const green = Math.min(255, Math.round(((packed >> 8) & 0xff) * factor));
  const blue = Math.min(255, Math.round((packed & 0xff) * factor));
  return (red << 16) | (green << 8) | blue;
}

function leafProfile(profile = {}) {
  return {
    size: leafClamp(profile.size, 0.1, 3, 1),
    speed: leafClamp(profile.speed, 0.2, 2.5, 1),
    spin: leafClamp(profile.spin, 0, 2.5, 1),
    turbulence: leafClamp(profile.turbulence, 0, 2.5, 1),
    gust: leafClamp(profile.gust, 0, 2.5, 1),
    liveliness: leafClamp(profile.liveliness, 0, 2.5, 1),
  };
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

  static get orbitFacesTangent() {
    return false;
  }

  static LEAF_TEXTURES = Object.freeze([
    "modules/fxmaster/assets/particle-effects/effects/autumnleaves/leaf1.webp",
    "modules/fxmaster/assets/particle-effects/effects/autumnleaves/leaf2.webp",
    "modules/fxmaster/assets/particle-effects/effects/autumnleaves/leaf3.webp",
    "modules/fxmaster/assets/particle-effects/effects/autumnleaves/leaf4.webp",
    "modules/fxmaster/assets/particle-effects/effects/autumnleaves/leaf5.webp",
    "modules/fxmaster/assets/particle-effects/effects/autumnleaves/leaf6.webp",
  ]);

  static SPIN_REFERENCE = 0.5;

  static SPIN_DEFAULT = 0.25;
  static TURBULENCE_DEFAULT = 0;
  static GUSTINESS_DEFAULT = 0;
  static DEPTH_VARIATION_DEFAULT = 0;
  static RIPPLE_DEFAULT = 0;
  static EDGE_DEFINITION_DEFAULT = 0;
  static EDGE_WIDTH_DEFAULT = 0;
  static RIPPLE_CYCLES = 0.392;

  /** @override */
  static get parameters() {
    const p = super.parameters;
    return {
      belowTokens: p.belowTokens,
      belowTiles: p.belowTiles,
      soundFxEnabled: p.soundFxEnabled,
      tint: p.tint,
      topDown: { label: "FXMASTER.Params.TopDown", type: "checkbox", value: false, hideWhen: { orbit: true } },
      orbit: { label: "FXMASTER.Params.Orbit", type: "checkbox", value: false, hideWhen: { topDown: true } },
      orbitDistance: {
        label: "FXMASTER.Params.OrbitDistance",
        type: "range",
        min: 0,
        value: 0.5,
        max: 1,
        step: 0.01,
        decimals: 2,
        showWhen: { orbit: true },
      },
      directionalMovement: {
        label: "FXMASTER.Params.DirectionalMovement",
        type: "checkbox",
        value: false,
        hideWhen: hideLeafDirectionalControls,
      },
      direction: {
        ...p.direction,
        showWhen: ({ get }) => get("directionalMovement") === true || get("spawnMode") === "upwind",
        hideWhen: hideLeafDirectionalControls,
      },
      synchronizedDirection: {
        ...this.synchronizedDirectionParameter,
        showWhen: { directionalMovement: true },
        hideWhen: hideLeafDirectionalControls,
      },
      spread: {
        label: "FXMASTER.Params.Spread",
        type: "range",
        min: 0,
        value: 0,
        max: 20,
        step: 1,
        decimals: 0,
        labelOutput: "minutes",
        showWhen: { directionalMovement: true },
        hideWhen: hideLeafDirectionalControls,
      },
      spawnMode: {
        label: "FXMASTER.Params.SpawnMode",
        type: "select",
        value: "full",
        options: {
          full: "FXMASTER.Params.SpawnModeFullView",
          top: "FXMASTER.Params.SpawnModeTopEdge",
          upwind: "FXMASTER.Params.SpawnModeUpwindEdge",
        },
        hideWhen: hideLeafDirectionalControls,
        tooltip: "FXMASTER.ParamTooltips.SpawnMode",
      },
      scale: { ...p.scale, value: 1.188889 },
      speed: { ...p.speed, value: 0.65, max: 10 },
      lifetime: { ...p.lifetime, value: 3.094444 },
      density: { ...p.density, min: 0.05, value: 0.5, max: 1, step: 0.05, decimals: 2 },
      alpha: p.alpha,
      spin: {
        label: "FXMASTER.Params.Spin",
        type: "range",
        min: 0,
        value: this.SPIN_DEFAULT,
        max: 1,
        step: 0.05,
        decimals: 2,
      },
      turbulence: {
        label: "FXMASTER.Params.Turbulence",
        type: "range",
        min: 0,
        value: this.TURBULENCE_DEFAULT,
        max: 1,
        step: 0.05,
        decimals: 2,
        hideWhen: { orbit: true },
        tooltip: "FXMASTER.ParamTooltips.LeafTurbulence",
      },
      gustiness: {
        label: "FXMASTER.Params.Gustiness",
        type: "range",
        min: 0,
        value: this.GUSTINESS_DEFAULT,
        max: 1,
        step: 0.05,
        decimals: 2,
        hideWhen: { orbit: true },
        tooltip: "FXMASTER.ParamTooltips.LeafGustiness",
      },
      depthVariation: {
        label: "FXMASTER.Params.DepthVariation",
        type: "range",
        min: 0,
        value: this.DEPTH_VARIATION_DEFAULT,
        max: 1,
        step: 0.05,
        decimals: 2,
        tooltip: "FXMASTER.ParamTooltips.DepthVariation",
      },
      liveliness: {
        label: "FXMASTER.Params.Ripple",
        type: "range",
        min: 0,
        value: this.RIPPLE_DEFAULT,
        max: 1,
        step: 0.05,
        decimals: 2,
        tooltip: "FXMASTER.ParamTooltips.LeafRipple",
      },
      edgeDefinition: {
        label: "FXMASTER.Params.EdgeDefinition",
        type: "range",
        min: 0,
        value: this.EDGE_DEFINITION_DEFAULT,
        max: 1,
        step: 0.05,
        decimals: 2,
        tooltip: "FXMASTER.ParamTooltips.LeafEdgeDefinition",
      },
      edgeWidth: {
        label: "FXMASTER.Params.EdgeWidth",
        type: "range",
        min: 0,
        value: this.EDGE_WIDTH_DEFAULT,
        max: 3,
        step: 0.25,
        decimals: 2,
        tooltip: "FXMASTER.ParamTooltips.LeafEdgeWidth",
      },
      backgroundEnabled: {
        label: "FXMASTER.Params.Background",
        type: "checkbox",
        value: false,
        tooltip: "FXMASTER.ParamTooltips.LeafBackground",
      },
      backgroundMode: {
        label: "FXMASTER.Params.BackgroundMode",
        type: "select",
        value: "accumulate",
        options: {
          full: "FXMASTER.Params.BackgroundModeFull",
          accumulate: "FXMASTER.Params.BackgroundModeAccumulate",
        },
        showWhen: { backgroundEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.LeafBackgroundMode",
      },
      backgroundDuration: {
        label: "FXMASTER.Params.BackgroundDuration",
        type: "range",
        min: 10,
        value: 180,
        max: 3600,
        step: 10,
        decimals: 0,
        labelOutput: "minutes",
        showWhen: { backgroundEnabled: true, backgroundMode: "accumulate" },
        tooltip: "FXMASTER.ParamTooltips.LeafBackgroundDuration",
      },
      backgroundOpacity: {
        label: "FXMASTER.Params.BackgroundOpacity",
        type: "range",
        min: 0,
        value: 0.8,
        max: 1,
        step: 0.01,
        decimals: 2,
        showWhen: { backgroundEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.LeafBackgroundOpacity",
      },
      backgroundCoverage: {
        label: "FXMASTER.Params.BackgroundCoverage",
        type: "range",
        min: 0.05,
        value: 0.4,
        max: 1,
        step: 0.05,
        decimals: 2,
        showWhen: { backgroundEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.LeafBackgroundCoverage",
      },
      backgroundFillVariation: {
        label: "FXMASTER.Params.BackgroundFillVariation",
        type: "range",
        min: 0,
        value: 0.7,
        max: 1,
        step: 0.05,
        decimals: 2,
        showWhen: { backgroundEnabled: true, backgroundMode: "accumulate" },
        tooltip: "FXMASTER.ParamTooltips.LeafBackgroundFillVariation",
      },
      backgroundPileStrength: {
        label: "FXMASTER.Params.BackgroundPileStrength",
        type: "range",
        min: 0,
        value: 0.6,
        max: 1,
        step: 0.05,
        decimals: 2,
        showWhen: { backgroundEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.LeafBackgroundPileStrength",
      },
      backgroundPileSize: {
        label: "FXMASTER.Params.BackgroundPileSize",
        type: "range",
        min: 0.5,
        value: 3.5,
        max: 12,
        step: 0.5,
        decimals: 1,
        showWhen: { backgroundEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.LeafBackgroundPileSize",
      },
      backgroundLeafSize: {
        label: "FXMASTER.Params.BackgroundParticleSize",
        type: "range",
        min: 0.05,
        value: 0.54,
        max: 2.5,
        step: 0.05,
        decimals: 2,
        showWhen: { backgroundEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.LeafBackgroundLeafSize",
      },
      backgroundInteractionEnabled: {
        label: "FXMASTER.Params.BackgroundInteraction",
        type: "checkbox",
        value: true,
        showWhen: { backgroundEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.LeafBackgroundInteraction",
      },
      backgroundInteractionRadius: {
        label: "FXMASTER.Params.BackgroundInteractionRadius",
        type: "range",
        min: 0,
        value: 0.9,
        max: 2,
        step: 0.05,
        decimals: 2,
        showWhen: { backgroundEnabled: true, backgroundInteractionEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.LeafBackgroundInteractionRadius",
      },
      backgroundInteractionStrength: {
        label: "FXMASTER.Params.BackgroundInteractionStrength",
        type: "range",
        min: 0,
        value: 0.7,
        max: 1,
        step: 0.05,
        decimals: 2,
        showWhen: { backgroundEnabled: true, backgroundInteractionEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.LeafBackgroundInteractionStrength",
      },
      backgroundInteractionSwirl: {
        label: "FXMASTER.Params.BackgroundInteractionSwirl",
        type: "range",
        min: 0,
        value: 0.55,
        max: 1,
        step: 0.05,
        decimals: 2,
        showWhen: { backgroundEnabled: true, backgroundInteractionEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.LeafBackgroundInteractionSwirl",
      },
      backgroundInteractionLiftChance: {
        label: "FXMASTER.Params.BackgroundInteractionLiftChance",
        type: "range",
        min: 0,
        value: 0.25,
        max: 1,
        step: 0.05,
        decimals: 2,
        showWhen: { backgroundEnabled: true, backgroundInteractionEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.LeafBackgroundInteractionLiftChance",
      },
      backgroundInteractionElevationThreshold: {
        label: "FXMASTER.Params.BackgroundInteractionElevationThreshold",
        type: "number-infinity",
        min: 0,
        value: 5,
        max: "Infinity",
        step: 0.5,
        decimals: 1,
        showWhen: { backgroundEnabled: true, backgroundInteractionEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.BackgroundInteractionElevationThreshold",
      },
      backgroundInteractionSettleTime: {
        label: "FXMASTER.Params.BackgroundInteractionSettleTime",
        type: "range",
        min: 0.1,
        value: 0.2,
        max: 12,
        step: 0.1,
        decimals: 1,
        showWhen: { backgroundEnabled: true, backgroundInteractionEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.LeafBackgroundInteractionSettleTime",
      },
      backgroundInteractionSettleImpact: {
        label: "FXMASTER.Params.BackgroundInteractionSettleImpact",
        type: "range",
        min: 0,
        value: 1,
        max: 1,
        step: 0.05,
        decimals: 2,
        showWhen: { backgroundEnabled: true, backgroundInteractionEnabled: true },
        tooltip: "FXMASTER.ParamTooltips.LeafBackgroundInteractionSettleImpact",
      },
    };
  }

  static get backgroundProfile() {
    return "autumn-leaves";
  }

  /** @override */
  static get backgroundSurface() {
    return {
      type: "scatter",
      profile: this.backgroundProfile,
      textures: this.LEAF_TEXTURES,
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
          textures: AutumnLeavesParticleEffect.LEAF_TEXTURES,
        },
      },
    ],
  };

  /** @override */
  static get defaultConfig() {
    const config = foundry.utils.deepClone(this.LEAF_CONFIG);
    const textureBehavior = config.behaviors?.find((behavior) => behavior?.type === "textureRandom");
    if (textureBehavior?.config) textureBehavior.config.textures = Array.from(this.LEAF_TEXTURES);
    return config;
  }

  static spinMultiplier(options = {}) {
    const value = leafNumber(options?.spin, this.SPIN_DEFAULT);
    return Math.max(0, value) / this.SPIN_REFERENCE;
  }

  static leafMotionProfileForTexture(_texture, _options = {}) {
    return leafProfile();
  }

  static leafMotionProfileForParticle(particle, options = {}) {
    return this.leafMotionProfileForTexture(particle?.texture, options);
  }

  /** @override */
  applyOptionsToConfig(options, config) {
    const rotationBehavior = (config.behaviors ?? []).find((behavior) => behavior?.type === "rotation");
    const rotationConfig = rotationBehavior?.config ?? {};
    const spinMultiplier = this.constructor.spinMultiplier(options);
    const minSpinDegrees = (Number(rotationConfig.minSpeed) || 0) * spinMultiplier;
    const maxSpinDegrees = (Number(rotationConfig.maxSpeed) || 0) * spinMultiplier;

    const incompatibleDirectionalMode =
      (leafOptionValue(options?.topDown, false) || leafOptionValue(options?.orbit, false)) &&
      leafOptionValue(options?.directionalMovement, false);
    const runtimeOptions = incompatibleDirectionalMode
      ? {
          ...options,
          directionalMovement: { ...(options?.directionalMovement ?? {}), value: false },
        }
      : options;

    super.applyOptionsToConfig(runtimeOptions, config);

    if (rotationBehavior?.config) {
      rotationBehavior.config.minSpeed = 0;
      rotationBehavior.config.maxSpeed = 0;
      rotationBehavior.config.accel = 0;
    }

    config._fxmLeafMotion = {
      minSpinRadians: (Math.min(minSpinDegrees, maxSpinDegrees) * Math.PI) / 180,
      maxSpinRadians: (Math.max(minSpinDegrees, maxSpinDegrees) * Math.PI) / 180,
      turbulence: leafClamp(options?.turbulence, 0, 1, this.constructor.TURBULENCE_DEFAULT),
      gustiness: leafClamp(options?.gustiness, 0, 1, this.constructor.GUSTINESS_DEFAULT),
      depthVariation: leafClamp(options?.depthVariation, 0, 1, this.constructor.DEPTH_VARIATION_DEFAULT),
      liveliness: leafClamp(options?.liveliness, 0, 1, this.constructor.RIPPLE_DEFAULT),
      orbit: !!leafOptionValue(options?.orbit, false),
    };
    config._fxmLeafEdge = {
      strength: leafClamp(options?.edgeDefinition, 0, 1, this.constructor.EDGE_DEFINITION_DEFAULT),
      width: leafClamp(options?.edgeWidth, 0, 3, this.constructor.EDGE_WIDTH_DEFAULT),
    };

    this._applyLeafSpawnMode(options, config);
  }

  _applyLeafSpawnMode(options, config) {
    const mode = String(leafOptionValue(options?.spawnMode, "full") ?? "full");
    if (mode === "full" || leafOptionValue(options?.orbit, false) || leafOptionValue(options?.topDown, false)) return;

    const spawn = (config.behaviors ?? []).find(
      (behavior) => behavior?.type === "spawnShape" && behavior?.config?.type === "rect",
    );
    const data = spawn?.config?.data;
    if (!data) return;

    const dimensions = CONFIG.fxmaster.getParticleDimensions(options);
    const rect = dimensions?.sceneRect ?? {};
    const x = Number(rect.x ?? data.x ?? 0) || 0;
    const y = Number(rect.y ?? data.y ?? 0) || 0;
    const width = Math.max(1, Number(rect.width ?? rect.w ?? data.w ?? 1) || 1);
    const height = Math.max(1, Number(rect.height ?? rect.h ?? data.h ?? 1) || 1);
    const grid = Math.max(1, Number(dimensions?.size ?? canvas?.dimensions?.size ?? 100) || 100);
    const band = Math.max(grid * 1.25, Math.min(width, height) * 0.12);
    const margin = grid * 0.75;

    if (mode === "top") {
      Object.assign(data, { x: x - margin, y: y - band, w: width + margin * 2, h: band });
      return;
    }

    const fallbackDirection = leafNumber(options?.direction, this.constructor.defaultDirection ?? 0);
    const direction =
      CONFIG.fxmaster?.resolveSynchronizedDirection?.(options, fallbackDirection, options?.__fxmParticleContext) ??
      fallbackDirection;
    const radians = (geometricDirectionToScreenDegrees(direction) * Math.PI) / 180;
    const dx = Math.cos(radians);
    const dy = Math.sin(radians);

    if (Math.abs(dx) >= Math.abs(dy)) {
      Object.assign(data, {
        x: dx >= 0 ? x - band : x + width,
        y: y - margin,
        w: band,
        h: height + margin * 2,
      });
      return;
    }

    Object.assign(data, {
      x: x - margin,
      y: dy >= 0 ? y - band : y + height,
      w: width + margin * 2,
      h: band,
    });
  }

  /** Apply an edge-definition filter to airborne leaves. */
  _fxmApplyLeafEdgeFilter(config = {}) {
    const edge = config?._fxmLeafEdge ?? {};
    const strength = leafClamp(edge.strength, 0, 1, this.constructor.EDGE_DEFINITION_DEFAULT);
    const width = leafClamp(edge.width, 0, 3, this.constructor.EDGE_WIDTH_DEFAULT);
    if (strength <= 0.001 || width <= 0.001) {
      this._fxmDestroyLeafEdgeFilter();
      return;
    }

    const renderer = CONFIG.fxmaster.getParticleRenderer?.(this);
    if (!renderer) return;

    if (!this._fxmLeafEdgeFilter || this._fxmLeafEdgeFilter.destroyed) {
      try {
        this._fxmLeafEdgeFilter = new PIXI.Filter(undefined, LEAF_EDGE_FRAGMENT_SHADER, {
          uEdgeStrength: strength,
          uEdgeWidth: width,
        });
      } catch (err) {
        logger.debug("FXMaster:", err);
        this._fxmLeafEdgeFilter = null;
        return;
      }
      this._fxmLeafEdgeFilter.autoFit = false;
      this._fxmLeafEdgePreviousFilterArea = this.filterArea ?? null;
      this._fxmLeafEdgeScreenRect = new PIXI.Rectangle(0, 0, 1, 1);
      this._fxmLeafEdgeResize = () => {
        const screen = renderer.screen;
        const resolution = Math.min(0.85, Number(renderer.resolution) || 1);
        this._fxmLeafEdgeFilter.resolution = resolution;
        this._fxmLeafEdgeFilter.uniforms.uEdgeWidth = width * resolution;
        this._fxmLeafEdgeScreenRect.x = 0;
        this._fxmLeafEdgeScreenRect.y = 0;
        this._fxmLeafEdgeScreenRect.width = Math.max(1, Number(screen?.width) || 1);
        this._fxmLeafEdgeScreenRect.height = Math.max(1, Number(screen?.height) || 1);
        this.filterArea = this._fxmLeafEdgeScreenRect;
      };
      this._fxmLeafEdgeResize();
      renderer.on?.("resize", this._fxmLeafEdgeResize);
      const filters = Array.isArray(this.filters) ? this.filters.filter(Boolean) : [];
      this.filters = filters.concat(this._fxmLeafEdgeFilter);
    }

    this._fxmLeafEdgeFilter.uniforms.uEdgeStrength = strength;
    this._fxmLeafEdgeFilter.uniforms.uEdgeWidth = width * this._fxmLeafEdgeFilter.resolution;
    this._fxmLeafEdgeFilter.padding = Math.ceil(width) + 1;
  }

  /** Release the airborne leaf edge filter. */
  _fxmDestroyLeafEdgeFilter() {
    const filter = this._fxmLeafEdgeFilter;
    const renderer = CONFIG.fxmaster.getParticleRenderer?.(this);
    if (renderer && this._fxmLeafEdgeResize) renderer.off?.("resize", this._fxmLeafEdgeResize);
    if (filter && Array.isArray(this.filters)) {
      const filters = this.filters.filter((entry) => entry !== filter);
      this.filters = filters.length ? filters : null;
    }
    filter?.destroy?.();
    this._fxmLeafEdgeFilter = null;
    this._fxmLeafEdgeResize = null;
    this._fxmLeafEdgeScreenRect = null;
    this.filterArea = this._fxmLeafEdgePreviousFilterArea ?? null;
    this._fxmLeafEdgePreviousFilterArea = null;
  }

  /** @override */
  createEmitter(config) {
    const emitter = super.createEmitter(config);
    this._fxmApplyLeafEdgeFilter(config);
    return emitter;
  }

  /** @override */
  destroy(options) {
    this._fxmDestroyLeafEdgeFilter();
    return super.destroy(options);
  }

  _fxmInstallLeafMotion(emitter, options = {}) {
    if (!emitter || emitter._fxmLeafMotionWrapped) return;

    const config = emitter?._fxmOrbitConfig ?? emitter?._origConfig ?? emitter?.config ?? {};
    const motion = config?._fxmLeafMotion ?? {};
    const orbit = !!motion.orbit;
    const rippleCycles = Math.max(0.01, Number(this.constructor.RIPPLE_CYCLES) || 0.392);
    const origUpdate = emitter.update.bind(emitter);
    let elapsed = 0;

    const restoreParticle = (particle) => {
      const state = particle?._fxmLeafMotionState;
      if (!particle || !state) return;

      if (particle.scale) {
        if (Number.isFinite(state.scaleXMultiplier) && Math.abs(state.scaleXMultiplier) > 1e-6) {
          particle.scale.x /= state.scaleXMultiplier;
        }
        if (Number.isFinite(state.scaleYMultiplier) && Math.abs(state.scaleYMultiplier) > 1e-6) {
          particle.scale.y /= state.scaleYMultiplier;
        }
      }
      state.scaleXMultiplier = 1;
      state.scaleYMultiplier = 1;

      if (Number.isFinite(state.alphaMultiplier) && Math.abs(state.alphaMultiplier) > 1e-6) {
        particle.alpha /= state.alphaMultiplier;
      }
      state.alphaMultiplier = 1;

      if (particle.skew) {
        particle.skew.x = Number(state.baseSkewX) || 0;
        particle.skew.y = Number(state.baseSkewY) || 0;
      }

      if (Number.isFinite(state.baseTint)) particle.tint = state.baseTint;
      if (Number.isFinite(state.travelRotation)) particle.rotation = state.travelRotation;
    };

    const initializeParticle = (particle) => {
      const profile = leafProfile(this.constructor.leafMotionProfileForParticle(particle, options));
      const minSpin = Math.max(0, Number(motion.minSpinRadians) || 0);
      const maxSpin = Math.max(minSpin, Number(motion.maxSpinRadians) || minSpin);
      const spinVelocity = minSpin + Math.random() * (maxSpin - minSpin);
      const travelRotation = Number.isFinite(Number(particle?.rotation)) ? Number(particle.rotation) : 0;
      const state = {
        texture: particle?.texture ?? null,
        lastAge: fxmGetParticleAge(particle),
        travelRotation,
        visualBase: Math.random() * LEAF_TWO_PI,
        spinAngle: Math.random() * LEAF_TWO_PI,
        spinVelocity: (Math.random() < 0.5 ? -1 : 1) * spinVelocity,
        turbulencePhase: Math.random() * LEAF_TWO_PI,
        turbulencePhase2: Math.random() * LEAF_TWO_PI,
        ripplePhase: Math.random() * LEAF_TWO_PI,
        ripplePhase2: Math.random() * LEAF_TWO_PI,
        rippleRate: 0.78 + Math.random() * 0.44,
        rippleRate2: 0.8 + Math.random() * 0.4,
        depth: Math.random() * 2 - 1,
        profile,
        scaleXMultiplier: 1,
        scaleYMultiplier: 1,
        alphaMultiplier: 1,
        baseSkewX: Number(particle?.skew?.x) || 0,
        baseSkewY: Number(particle?.skew?.y) || 0,
        baseTint: Number.isFinite(Number(particle?.tint)) ? Number(particle.tint) & 0xffffff : 0xffffff,
      };
      particle._fxmLeafMotionState = state;
      return state;
    };

    const wasAuto = !!emitter.autoUpdate;
    if (wasAuto) emitter.autoUpdate = false;

    emitter.update = (delta) => {
      const dt = Math.min(0.08, Math.max(0, fxmDeltaSeconds(delta)));
      elapsed += dt;

      fxmForEachEmitterParticle(emitter, (particle) => {
        if (!particle) return;
        restoreParticle(particle);
        particle._fxmLeafBeforeX = Number(particle.x) || 0;
        particle._fxmLeafBeforeY = Number(particle.y) || 0;
      });

      origUpdate(delta);

      const gustWave =
        Math.sin(elapsed * 0.82) * 0.24 +
        Math.sin(elapsed * 1.91 + 1.35) * 0.13 +
        Math.pow(Math.max(0, Math.sin(elapsed * 0.37 + 0.45)), 4) * 0.18;

      fxmForEachEmitterParticle(emitter, (particle) => {
        if (!particle) return;

        const age = fxmGetParticleAge(particle);
        let state = particle._fxmLeafMotionState;
        const respawn =
          state &&
          age !== undefined &&
          typeof state.lastAge === "number" &&
          Number.isFinite(state.lastAge) &&
          age < state.lastAge;
        const textureChanged = state && state.texture !== particle.texture;
        const initialized = !state || respawn || textureChanged;
        if (initialized) state = initializeParticle(particle);
        state.lastAge = age;

        const profile = state.profile;
        const nativeX = Number(particle.x) || 0;
        const nativeY = Number(particle.y) || 0;
        const originX = initialized ? nativeX : Number(particle._fxmLeafBeforeX) || 0;
        const originY = initialized ? nativeY : Number(particle._fxmLeafBeforeY) || 0;
        const dx = nativeX - originX;
        const dy = nativeY - originY;
        const nativeHeading = Number.isFinite(Number(particle.rotation))
          ? Number(particle.rotation)
          : Math.atan2(dy, dx);

        const depthAmount = leafClamp(motion.depthVariation, 0, 1, this.constructor.DEPTH_VARIATION_DEFAULT);
        const depthSize = Math.max(0.62, 1 + state.depth * depthAmount * 0.3);
        const depthSpeed = Math.max(0.72, 1 + state.depth * depthAmount * 0.2);
        const depthAlpha = Math.max(0.72, 1 + state.depth * depthAmount * 0.14);
        const gustAmount = leafClamp(motion.gustiness, 0, 1, this.constructor.GUSTINESS_DEFAULT) * profile.gust;
        const gustFactor = Math.max(0.62, 1 + gustWave * gustAmount);

        const turbulenceAmount = orbit
          ? 0
          : leafClamp(motion.turbulence, 0, 1, this.constructor.TURBULENCE_DEFAULT) * profile.turbulence;
        const turbulenceAngle =
          (Math.sin(elapsed * 2.2 + state.turbulencePhase) * 0.18 +
            Math.sin(elapsed * 4.9 + state.turbulencePhase2) * 0.07) *
          turbulenceAmount;

        if (!orbit) {
          const speedFactor = Math.max(0.15, profile.speed * depthSpeed * gustFactor);
          const cos = Math.cos(turbulenceAngle);
          const sin = Math.sin(turbulenceAngle);
          particle.x = originX + (dx * cos - dy * sin) * speedFactor;
          particle.y = originY + (dx * sin + dy * cos) * speedFactor;
        }

        state.ripplePhase = (state.ripplePhase + dt * LEAF_TWO_PI * rippleCycles * state.rippleRate) % LEAF_TWO_PI;
        state.ripplePhase2 =
          (state.ripplePhase2 + dt * LEAF_TWO_PI * rippleCycles * 0.57 * state.rippleRate2) % LEAF_TWO_PI;
        state.spinAngle = (state.spinAngle + state.spinVelocity * profile.spin * dt) % LEAF_TWO_PI;

        const heading = Number.isFinite(nativeHeading) ? nativeHeading : state.travelRotation;
        state.travelRotation = heading + turbulenceAngle;

        const rippleAmount = leafClamp(motion.liveliness, 0, 1, this.constructor.RIPPLE_DEFAULT) * profile.liveliness;
        const rippleWave = Math.sin(state.ripplePhase + Math.sin(state.ripplePhase2) * 0.24);
        const rippleCrossWave = Math.sin(state.ripplePhase2 + Math.sin(state.ripplePhase) * 0.32);
        const rippleFold = Math.abs(rippleWave);
        const sizeMultiplier = profile.size * depthSize;
        const rippleWidth = Math.max(0.62, 1 - rippleFold * rippleAmount * 0.24);
        const rippleHeight = Math.max(0.78, 1 + rippleCrossWave * rippleAmount * 0.09);
        state.scaleXMultiplier = sizeMultiplier * rippleWidth;
        state.scaleYMultiplier = sizeMultiplier * rippleHeight;
        if (particle.scale) {
          particle.scale.x *= state.scaleXMultiplier;
          particle.scale.y *= state.scaleYMultiplier;
        }

        state.alphaMultiplier = depthAlpha;
        particle.alpha *= state.alphaMultiplier;

        if (particle.skew) {
          particle.skew.x = state.baseSkewX + rippleWave * rippleAmount * 0.2;
          particle.skew.y = state.baseSkewY + rippleCrossWave * rippleAmount * 0.1;
        }

        const nativeTint = Number(particle.tint);
        if (Number.isFinite(nativeTint)) state.baseTint = nativeTint & 0xffffff;
        const rippleLight = rippleWave * 0.7 + rippleCrossWave * 0.3;
        const brightness = 1 + rippleLight * rippleAmount * 0.11 - rippleFold * rippleAmount * 0.045;
        particle.tint = leafTintBrightness(state.baseTint, brightness);

        const rippleRotation = rippleWave * rippleAmount * 0.035;
        particle.rotation = state.visualBase + state.spinAngle + rippleRotation;
      });
    };

    emitter._fxmLeafMotionWrapped = true;
    if (wasAuto) emitter.autoUpdate = true;
  }

  /** @override */
  getParticleEmitters(options = {}) {
    options = this.constructor.mergeWithDefaults(options);
    const orbit = !!options?.orbit?.value;
    const topDown = !!options?.topDown?.value && !orbit;

    if (!topDown) {
      this._fxmCanvasPanOwnerPosEnabled = false;
      const emitters = super.getParticleEmitters(options);
      for (const emitter of emitters) this._fxmInstallLeafMotion(emitter, options);
      return emitters;
    }

    this._fxmCanvasPanOwnerPosEnabled = true;

    const { maxParticles } = this.constructor.computeMaxParticlesFromView(options, {
      minViewCells: this.constructor.MIN_VIEW_CELLS ?? 3000,
    });

    const d = CONFIG.fxmaster.getParticleDimensions(options);
    const sceneRadius = Math.sqrt(d.sceneWidth * d.sceneWidth + d.sceneHeight * d.sceneHeight) / 2;

    const config = foundry.utils.deepClone(this.constructor.defaultConfig);
    config.maxParticles = maxParticles;

    const rotationCfg = config.behaviors?.find((behavior) => behavior?.type === "rotation")?.config ?? {};
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
    const topDownSpinMultiplier = this.constructor.spinMultiplier(options);
    config._fxmLeafMotion ??= {};
    config._fxmLeafMotion.minSpinRadians =
      (Math.min(Number(rotationCfg.minSpeed ?? 100), Number(rotationCfg.maxSpeed ?? 200)) *
        topDownSpinMultiplier *
        Math.PI) /
      180;
    config._fxmLeafMotion.maxSpinRadians =
      (Math.max(Number(rotationCfg.minSpeed ?? 100), Number(rotationCfg.maxSpeed ?? 200)) *
        topDownSpinMultiplier *
        Math.PI) /
      180;

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
    const scopedContext = CONFIG.fxmaster?.isScopedParticleContext?.(ctx) ?? !!ctx?.dimensions;
    const ownerX = scopedContext ? 0 : canvas.stage.pivot.x - d.sceneX - d.sceneWidth / 2;
    const ownerY = scopedContext ? 0 : canvas.stage.pivot.y - d.sceneY - d.sceneHeight / 2;
    emitter.updateOwnerPos(ownerX, ownerY);

    this._fxmInstallLeafMotion(emitter, options);

    return [emitter];
  }
}
