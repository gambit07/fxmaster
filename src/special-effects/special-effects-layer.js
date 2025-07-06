import { packageId } from "../constants.js";
import { SpecialEffectMesh } from "./mesh.js";

export class SpecialEffectsLayer extends CONFIG.fxmaster.InteractionLayerNS {
  constructor() {
    super();
    this.videos = [];
    this._dragging = false;
    this.ruler = null;
    this.windowVisible = false;
    // Listen to the socket
    game.socket.on(`module.${packageId}`, (data) => {
      this.playVideo(data);
    });
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
    return super._tearDown();
  }

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

    return () => {};
  }

  playVideo(data) {
    return new Promise((resolve) => {
      // Set default values
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

      // Create video
      const video = document.createElement("video");
      video.preload = "auto";
      video.crossOrigin = "anonymous";
      video.src = data.file;
      video.playbackRate = data.playbackRate;
      this.videos.push(video);

      /** @type {SpriteMesh | undefined} */
      let mesh;
      /** @type {(() => void) | undefined} */
      let terminateAnimation;

      const onCanPlay = () => {
        mesh = new SpecialEffectMesh(PIXI.Texture.from(video));

        data.dimensions = { w: video.videoWidth, h: video.videoHeight };
        data.duration = video.duration;
        terminateAnimation = this.#configureSpecialEffectMesh(mesh, data);

        canvas.primary.addChild(mesh);
        canvas.primary.videoMeshes.add(mesh);
      };

      const onEnd = () => {
        terminateAnimation?.();
        canvas.primary.removeChild(mesh);
        canvas.primary.videoMeshes.delete(mesh);
        resolve();
        if (!mesh?._destroyed) mesh?.destroy({ children: true });
      };

      video.oncanplay = onCanPlay;
      video.onerror = onEnd;
      video.onended = onEnd;
    });
  }

  static _createMacro(_effectData) {
    return ui.notifications.warn(
      "FXMaster no longer supports custom animations macros. For an alternative, use the Sequencer module.",
    );
  }

  /**
   * Draw a special effect.
   * @param {PIXI.InteractionEvent} event         The event that triggered the drawing of the special effect
   * @param {PIXI.Point}            [savedOrigin] The point that was originally clicked on
   * @returns {Promise<void>}
   * @remarks
   * The savedOrigin parameter is required for regular click events because for some reason, the origin has been removed
   * from the event's data by the time the event is handled.
   * TODO: investigate further.
   */
  _drawSpecial(event, savedOrigin) {
    event.stopPropagation();

    const windows = Object.values(ui.windows);
    const effectConfig = windows.find((w) => w.id == "specials-config");
    if (!effectConfig) return;

    const active = effectConfig.element.find(".special-effects.active");
    if (active.length == 0) return;

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

    if (!event.interactionData.destination) {
      game.socket.emit(`module.${packageId}`, data);
      return this.playVideo(data);
    }

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
    const effectConfig = windows.find((w) => w.id == "specials-config");
    if (!effectConfig) return false;
    return true;
  }

  /** @override */
  _onClickLeft(event) {
    this._dragging = false;
    const origin = event.interactionData.origin;
    setTimeout(() => {
      if (!this._dragging) {
        event.interactionData.rotation = 0;
        event.interactionData.destination = undefined;
        this._drawSpecial(event, origin);
      }
      this._dragging = false;
    }, 400);
  }

  get #elevation() {
    const effectConfig = Object.values(ui.windows).find((w) => w.id == "specials-config");
    const elevationString = effectConfig?.element.find("input[name='elevation']").val();
    const elevation = Number.parseFloat(elevationString);
    if (Number.isNaN(elevation) || !Number.isFinite(elevation)) return 1;
    return elevation;
  }
}
