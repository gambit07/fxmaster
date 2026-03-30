import { packageId } from "../constants.js";
import { logger } from "../logger.js";
import { SpecialEffectMesh } from "./mesh.js";

export class SpecialEffectsLayer extends CONFIG.fxmaster.InteractionLayerNS {
  constructor() {
    super();
    this.videos = [];
    this._dragging = false;
    this.ruler = null;
    this.windowVisible = false;

    /** Bind socket handler so it can be removed during teardown. */
    this._socketHandler = (data) => this.playVideo(data);
    game.socket.on(`module.${packageId}`, this._socketHandler);
  }

  static get layerOptions() {
    return foundry.utils.mergeObject(super.layerOptions, {
      name: "specials",
      zIndex: 245,
    });
  }

  /** @override */
  async _draw() {
    await super._draw();
    this.ruler = this.addChild(new PIXI.Graphics());
  }

  /** @inheritdoc */
  async _tearDown() {
    this.ruler = null;
    for (const video of this.videos) {
      video.remove();
    }
    this.videos = [];

    /** Remove socket listener to prevent duplicate playback after canvas re-init. */
    if (this._socketHandler) {
      try {
        game.socket.off(`module.${packageId}`, this._socketHandler);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this._socketHandler = null;
    }

    return super._tearDown();
  }

  /**
   * Apply position, rotation, scale, and sizing to a special-effect mesh.
   *
   * @param {SpriteMesh} mesh - The mesh to configure.
   * @param {object} data - Effect placement data.
   */
  #configureSpecialEffectMesh(mesh, data) {
    mesh.anchor.set(data.anchor.x, data.anchor.y);
    mesh.rotation = Math.normalizeRadians(data.rotation - Math.toRadians(data.angle));
    mesh.scale.set(data.scale.x, data.scale.y);
    mesh.position.set(data.position.x, data.position.y);
    mesh.elevation = data.elevation ?? 1;

    if (data.width) {
      if (data.keepAspect) {
        const aspectRatio = mesh.height / mesh.width;
        mesh.height = data.width * aspectRatio;
      }
      mesh.width = data.width;
    }
  }

  playVideo(data) {
    return new Promise((resolve) => {
      data = foundry.utils.mergeObject(
        {
          anchor: { x: 0.5, y: 0.5 },
          rotation: 0,
          scale: { x: 1.0, y: 1.0 },
          position: { x: 0, y: 0 },
          playbackRate: 1.0,
          ease: "Linear",
        },
        data,
      );
      const video = document.createElement("video");
      video.preload = "auto";
      video.crossOrigin = "anonymous";
      video.src = data.file;
      video.playbackRate = data.playbackRate;
      this.videos.push(video);

      /** @type {SpriteMesh | undefined} */
      let mesh;

      const onCanPlay = () => {
        mesh = new SpecialEffectMesh(PIXI.Texture.from(video));

        data.dimensions = { w: video.videoWidth, h: video.videoHeight };
        data.duration = video.duration;
        this.#configureSpecialEffectMesh(mesh, data);

        canvas.primary.addChild(mesh);
        canvas.primary.videoMeshes.add(mesh);
      };

      const onEnd = () => {
        try {
          if (mesh) {
            try {
              canvas.primary?.removeChild?.(mesh);
            } catch {}
            try {
              canvas.primary?.videoMeshes?.delete?.(mesh);
            } catch {}
            try {
              if (!mesh?._destroyed) mesh?.destroy?.({ children: true, texture: true, baseTexture: true });
            } catch {}
          }
        } finally {
          resolve();
        }
      };

      video.oncanplay = onCanPlay;
      video.onerror = onEnd;
      video.onended = onEnd;
    });
  }

  /**
   * Create a macro command for a dropped special effect.
   *
   * Special-effect macro generation is not supported; return a command which warns when executed.
   *
   * @param {object} _effectData - Dropped effect data (unused).
   * @returns {string} Macro command.
   * @protected
   */
  static _createMacro(_effectData) {
    const msg = "FXMaster no longer supports custom animations macros. For an alternative, use the Sequencer module.";
    try {
      ui.notifications.warn(msg);
    } catch {}
    return `ui.notifications.warn(${JSON.stringify(msg)});`;
  }

  /**
   * Draw the currently-selected special effect.
   *
   * @param {PIXI.InteractionEvent} event
   * @param {PIXI.Point} [savedOrigin] Origin captured at mousedown time. Used for click events where
   *                                  Foundry/PIXI may no longer provide the origin by the time the event is handled.
   * @returns {Promise<void>|undefined}
   */
  _drawSpecial(event, savedOrigin) {
    event.stopPropagation();

    const windows = Object.values(ui.windows);
    const effectConfig = windows.find((w) => w.id === "specials-config");
    if (!effectConfig) return;

    const active = effectConfig.element.find(".special-effects.active");
    if (active.length === 0) return;

    const id = active[0].dataset.effectId;
    const folder = active[0].closest(".folder").dataset.folderId;
    const effect = CONFIG.fxmaster.userSpecials[folder].effects[id];

    const effectData = foundry.utils.deepClone(effect);
    const { x, y } = event.interactionData.origin ?? savedOrigin;
    const data = {
      ...effectData,
      position: { x, y },
      rotation: event.interactionData.rotation,
      elevation: this.#elevation,
    };

    game.socket.emit(`module.${packageId}`, data);
    return this.playVideo(data);
  }

  /** @override */
  _onDragLeftDrop(event) {
    const u = {
      x: event.interactionData.destination.x - event.interactionData.origin.x,
      y: event.interactionData.destination.y - event.interactionData.origin.y,
    };
    const cos = u.x / Math.hypot(u.x, u.y);
    event.interactionData.rotation = u.y > 0 ? Math.acos(cos) : -Math.acos(cos);
    this._drawSpecial(event);
    this.ruler.clear();
  }

  /** @override */
  _onDragLeftStart() {
    this.windowVisible = this._isWindowVisible();
    if (!this.windowVisible) return;
    this._dragging = true;
  }

  /** @override */
  _onDragLeftMove(event) {
    if (!this.windowVisible) return;
    const ray = new Ray(event.interactionData.origin, event.interactionData.destination);
    this.ruler.clear();
    this.ruler
      .lineStyle(3, 0xaa0033, 0.6)
      .drawCircle(ray.A.x, ray.A.y, 2)
      .moveTo(ray.A.x, ray.A.y)
      .lineTo(ray.B.x, ray.B.y)
      .drawCircle(ray.B.x, ray.B.y, 2);
  }

  _isWindowVisible() {
    const windows = Object.values(ui.windows);
    const effectConfig = windows.find((w) => w.id === "specials-config");
    if (!effectConfig) return false;
    return true;
  }

  /**
   * Handle a left-click. If a drag has not started, fire the special effect immediately.
   * @override
   * @param {PIXI.InteractionEvent} event
   */
  _onClickLeft(event) {
    if (this._dragging) {
      this._dragging = false;
      return;
    }
    const origin = event.interactionData.origin;
    event.interactionData.rotation = 0;
    event.interactionData.destination = undefined;
    this._drawSpecial(event, origin);
  }

  get #elevation() {
    const effectConfig = Object.values(ui.windows).find((w) => w.id === "specials-config");
    const elevationString = effectConfig?.element.find("input[name='elevation']").val();
    const elevation = Number.parseFloat(elevationString);
    if (Number.isNaN(elevation) || !Number.isFinite(elevation)) return 1;
    return elevation;
  }
}
