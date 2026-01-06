import { FXMasterParticleEffect } from "./effect.js";

/**
 * A full-screen particle effect which renders flying eagles.
 */
export class EaglesParticleEffect extends FXMasterParticleEffect {
  /**
   * The cached textures for this weather effect.
   * @type {PIXI.Texture[] | undefined}
   * @private
   */
  static _textureCache;

  /** @override */
  static label = "FXMASTER.Particles.Effects.Eagles";

  /** @override */
  static get icon() {
    return "modules/fxmaster/assets/particle-effects/icons/eagles.webp";
  }

  /** @override */
  static get group() {
    return "animals";
  }

  /** @override */
  static get parameters() {
    return foundry.utils.mergeObject(
      super.parameters,
      {
        density: { min: 0.0005, value: 0.002, max: 0.01, step: 0.0005, decimals: 4 },
        "-=direction": null,
        animations: {
          label: "FXMASTER.Params.Animations",
          type: "multi-select",
          options: {
            flap: "FXMASTER.Particles.BirdsAnimations.Flap",
            glide: "FXMASTER.Particles.BirdsAnimations.Glide",
          },
          value: ["glide"],
        },
      },
      { performDeletions: true },
    );
  }

  /**
   * Configuration for the particle emitter for flying eagles
   * @type {PIXI.particles.EmitterConfigV3}
   */
  static EAGLES_CONFIG = {
    lifetime: { min: 7, max: 14 },
    behaviors: [
      {
        type: "alpha",
        config: {
          alpha: {
            list: [
              { value: 0, time: 0 },
              { value: 1, time: 0.02 },
              { value: 1, time: 0.98 },
              { value: 0, time: 1 },
            ],
          },
        },
      },
      {
        type: "moveSpeed",
        config: {
          speed: {
            list: [
              { time: 0, value: 360 },
              { time: 1, value: 400 },
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
              { value: 0.15, time: 0 },
              { value: 0.3, time: 0.1 },
              { value: 0.3, time: 0.9 },
              { value: 0.15, time: 1 },
            ],
          },
        },
      },
      {
        type: "rotationStatic",
        config: { min: 0, max: 359 },
      },
    ],
  };

  /** @override */
  static get defaultConfig() {
    return this.EAGLES_CONFIG;
  }

  /** @override */
  getParticleEmitters(options = {}) {
    options = this.constructor.mergeWithDefaults(options);

    const d = CONFIG.fxmaster.getParticleDimensions(options);

    const { maxParticles } = this.constructor.computeMaxParticlesFromView(options, {
      minViewCells: this.constructor.MIN_VIEW_CELLS ?? 5000,
    });

    const config = foundry.utils.deepClone(this.constructor.EAGLES_CONFIG);
    config.maxParticles = maxParticles;

    const lifetime = config.lifetime ?? 1;
    const lifetimeMin = typeof lifetime === "number" ? lifetime : lifetime.min ?? lifetime.max ?? 1;
    config.frequency = lifetimeMin / maxParticles;

    config.behaviors ??= [];

    config.behaviors.push({
      type: "spawnShape",
      config: {
        type: "rect",
        data: {
          x: d.sceneRect.x,
          y: d.sceneRect.y,
          w: d.sceneRect.width,
          h: d.sceneRect.height,
        },
      },
    });

    config.behaviors.push({
      type: "animatedRandom",
      config: {
        anims: this._getAnimations(options),
      },
    });

    this.applyOptionsToConfig(options, config);

    return [this.createEmitter(config)];
  }

  /**
   * Get the animation to use for this effect.
   * @returns The animations to use for the effect
   * @protected
   */
  _getAnimations(options) {
    if (!this._textures) {
      this._initializeTextures();
    }

    const flap = Array.fromRange(19).map((textureNumber) => ({
      textureNumber,
      count: 1,
    }));

    const glide = [
      { textureNumber: 0, count: 30 },
      ...Array(2).fill(flap).deepFlatten(),
      { textureNumber: 0, count: 68 },
    ];

    const animations = {
      glide,
      flap,
    };

    const getAnim = (animation) => ({
      framerate: 20,
      loop: true,
      textures: animation.map(({ textureNumber, count }) => ({
        texture: this._textures[textureNumber],
        count,
      })),
    });

    const anims = (Array.isArray(options.animations?.value) ? options.animations.value : [])
      .filter((a) => Object.prototype.hasOwnProperty.call(animations, a))
      .map((a) => getAnim(animations[a]));

    if (!anims.length) anims.push(getAnim(animations.glide));

    return anims;
  }

  /**
   * Get the textures for this particle effect.
   * @private
   * @returns {PIXI.Texture[]}
   */
  get _textures() {
    if (!this.constructor._textureCache) {
      const spriteSheetTexture = PIXI.Texture.from(
        "modules/fxmaster/assets/particle-effects/effects/eagles/eagle.webp",
      );
      const spriteSheetData = {
        meta: {
          scale: "1",
        },
        frames: {
          "eagle0000.webp": {
            frame: { x: 0, y: 0, w: 512, h: 512 },
            rotated: false,
            trimmed: false,
            spriteSourceSize: { x: 0, y: 0, w: 512, h: 512 },
            sourceSize: { w: 512, h: 512 },
          },
          "eagle0001.webp": {
            frame: { x: 512, y: 0, w: 512, h: 512 },
            rotated: false,
            trimmed: false,
            spriteSourceSize: { x: 0, y: 0, w: 512, h: 512 },
            sourceSize: { w: 512, h: 512 },
          },
          "eagle0002.webp": {
            frame: { x: 0, y: 512, w: 512, h: 512 },
            rotated: false,
            trimmed: false,
            spriteSourceSize: { x: 0, y: 0, w: 512, h: 512 },
            sourceSize: { w: 512, h: 512 },
          },
          "eagle0003.webp": {
            frame: { x: 512, y: 512, w: 512, h: 512 },
            rotated: false,
            trimmed: false,
            spriteSourceSize: { x: 0, y: 0, w: 512, h: 512 },
            sourceSize: { w: 512, h: 512 },
          },
          "eagle0004.webp": {
            frame: { x: 1024, y: 0, w: 512, h: 512 },
            rotated: false,
            trimmed: false,
            spriteSourceSize: { x: 0, y: 0, w: 512, h: 512 },
            sourceSize: { w: 512, h: 512 },
          },
          "eagle0005.webp": {
            frame: { x: 1024, y: 512, w: 512, h: 512 },
            rotated: false,
            trimmed: false,
            spriteSourceSize: { x: 0, y: 0, w: 512, h: 512 },
            sourceSize: { w: 512, h: 512 },
          },
          "eagle0006.webp": {
            frame: { x: 0, y: 1024, w: 512, h: 512 },
            rotated: false,
            trimmed: false,
            spriteSourceSize: { x: 0, y: 0, w: 512, h: 512 },
            sourceSize: { w: 512, h: 512 },
          },
          "eagle0007.webp": {
            frame: { x: 512, y: 1024, w: 512, h: 512 },
            rotated: false,
            trimmed: false,
            spriteSourceSize: { x: 0, y: 0, w: 512, h: 512 },
            sourceSize: { w: 512, h: 512 },
          },
          "eagle0008.webp": {
            frame: { x: 1024, y: 1024, w: 512, h: 512 },
            rotated: false,
            trimmed: false,
            spriteSourceSize: { x: 0, y: 0, w: 512, h: 512 },
            sourceSize: { w: 512, h: 512 },
          },
          "eagle0009.webp": {
            frame: { x: 1536, y: 0, w: 512, h: 512 },
            rotated: false,
            trimmed: false,
            spriteSourceSize: { x: 0, y: 0, w: 512, h: 512 },
            sourceSize: { w: 512, h: 512 },
          },
          "eagle0010.webp": {
            frame: { x: 1536, y: 512, w: 512, h: 512 },
            rotated: false,
            trimmed: false,
            spriteSourceSize: { x: 0, y: 0, w: 512, h: 512 },
            sourceSize: { w: 512, h: 512 },
          },
          "eagle0011.webp": {
            frame: { x: 1536, y: 1024, w: 512, h: 512 },
            rotated: false,
            trimmed: false,
            spriteSourceSize: { x: 0, y: 0, w: 512, h: 512 },
            sourceSize: { w: 512, h: 512 },
          },
          "eagle0012.webp": {
            frame: { x: 0, y: 1536, w: 512, h: 512 },
            rotated: false,
            trimmed: false,
            spriteSourceSize: { x: 0, y: 0, w: 512, h: 512 },
            sourceSize: { w: 512, h: 512 },
          },
          "eagle0013.webp": {
            frame: { x: 512, y: 1536, w: 512, h: 512 },
            rotated: false,
            trimmed: false,
            spriteSourceSize: { x: 0, y: 0, w: 512, h: 512 },
            sourceSize: { w: 512, h: 512 },
          },
          "eagle0014.webp": {
            frame: { x: 1024, y: 1536, w: 512, h: 512 },
            rotated: false,
            trimmed: false,
            spriteSourceSize: { x: 0, y: 0, w: 512, h: 512 },
            sourceSize: { w: 512, h: 512 },
          },
          "eagle0015.webp": {
            frame: { x: 1536, y: 1536, w: 512, h: 512 },
            rotated: false,
            trimmed: false,
            spriteSourceSize: { x: 0, y: 0, w: 512, h: 512 },
            sourceSize: { w: 512, h: 512 },
          },
          "eagle0016.webp": {
            frame: { x: 2048, y: 0, w: 512, h: 512 },
            rotated: false,
            trimmed: false,
            spriteSourceSize: { x: 0, y: 0, w: 512, h: 512 },
            sourceSize: { w: 512, h: 512 },
          },
          "eagle0017.webp": {
            frame: { x: 2048, y: 512, w: 512, h: 512 },
            rotated: false,
            trimmed: false,
            spriteSourceSize: { x: 0, y: 0, w: 512, h: 512 },
            sourceSize: { w: 512, h: 512 },
          },
          "eagle0018.webp": {
            frame: { x: 2048, y: 1024, w: 512, h: 512 },
            rotated: false,
            trimmed: false,
            spriteSourceSize: { x: 0, y: 0, w: 512, h: 512 },
            sourceSize: { w: 512, h: 512 },
          },
          "eagle0019.webp": {
            frame: { x: 2048, y: 1536, w: 512, h: 512 },
            rotated: false,
            trimmed: false,
            spriteSourceSize: { x: 0, y: 0, w: 512, h: 512 },
            sourceSize: { w: 512, h: 512 },
          },
        },
      };
      const spriteSheet = new PIXI.Spritesheet(spriteSheetTexture, spriteSheetData);
      this.constructor._textureCache = parseSpriteSheetSync.call(spriteSheet);
    }
    return this.constructor._textureCache;
  }
}

function parseSpriteSheetSync() {
  let textures;
  this._callback = (parsedTextures) => (textures = Object.values(parsedTextures));
  this._batchIndex = 0;
  this._processFrames(0);
  this._processAnimations();
  this._parseComplete();
  return textures;
}
