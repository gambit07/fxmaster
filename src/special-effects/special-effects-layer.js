import { packageId } from "../constants.js";
import { logger } from "../logger.js";
import { SpecialEffectMesh } from "./mesh.js";

const SpecialEffectsLayerBase =
  CONFIG.fxmaster?.InteractionLayerNS ??
  foundry.canvas?.layers?.InteractionLayer ??
  foundry.canvas?.layers?.CanvasLayer;

/**
 * Lightweight compatibility layer for one-shot FXMaster special effects.
 *
 * Retired animation-effects management UI is omitted. Legacy `canvas.specials.playVideo(data)` and `game.socket.emit("module.fxmaster", data)` playback paths remain available for module compatibility.
 */
export class SpecialEffectsLayer extends SpecialEffectsLayerBase {
  constructor() {
    super();
    this.videos = [];
    this.ruler = null;
    this._dragging = false;
    this.windowVisible = false;
    this._socketHandler = (data) => this.#handleSocketPlayback(data);
    game.socket?.on?.(`module.${packageId}`, this._socketHandler);
  }

  static get layerOptions() {
    const baseOptions = super.layerOptions ?? {};
    return foundry.utils.mergeObject(baseOptions, {
      name: "specials",
      zIndex: 245,
    });
  }

  /**
   * Draw the compatibility interaction layer.
   *
   * @returns {Promise<void>}
   */
  async _draw() {
    await super._draw?.();
    this.ruler = this.addChild(new PIXI.Graphics());
  }

  /**
   * Remove playback state and the socket listener during canvas teardown.
   *
   * @returns {Promise<void>}
   */
  async _tearDown() {
    this.ruler = null;
    this.stopAllVideos();

    if (this._socketHandler) {
      try {
        game.socket?.off?.(`module.${packageId}`, this._socketHandler);
      } catch (err) {
        logger.debug("FXMaster:", err);
      }
      this._socketHandler = null;
    }

    return super._tearDown?.();
  }

  /**
   * Stop all active special-effect videos and release their meshes.
   */
  stopAllVideos() {
    for (const record of [...this.videos]) this.#finalizePlayback(record);
    this.videos = [];
  }

  /**
   * Play a one-shot special-effect video on the canvas.
   *
   * @param {object} data Placement and playback data.
   * @returns {Promise<void>}
   */
  playVideo(data) {
    if (!data?.file) return Promise.resolve();

    const playbackData = foundry.utils.mergeObject(
      {
        anchor: { x: 0.5, y: 0.5 },
        angle: 0,
        rotation: 0,
        scale: { x: 1, y: 1 },
        position: { x: 0, y: 0 },
        playbackRate: 1,
        ease: "Linear",
        elevation: 1,
      },
      data,
      { inplace: false },
    );

    return new Promise((resolve) => {
      const video = document.createElement("video");
      video.preload = "auto";
      video.crossOrigin = "anonymous";
      video.src = playbackData.file;
      video.playbackRate = Number(playbackData.playbackRate) || 1;

      const record = { video, mesh: null, resolved: false, resolve };
      this.videos.push(record);

      const complete = () => this.#finalizePlayback(record);
      const onCanPlay = () => {
        if (record.mesh || video.readyState < 2) return;

        try {
          record.mesh = new SpecialEffectMesh(PIXI.Texture.from(video));
          playbackData.dimensions = { w: video.videoWidth, h: video.videoHeight };
          playbackData.duration = video.duration;
          this.#configureSpecialEffectMesh(record.mesh, playbackData);
          canvas.primary?.addChild?.(record.mesh);
          canvas.primary?.videoMeshes?.add?.(record.mesh);
          void game.video
            ?.play?.(video, { playing: true, loop: false })
            ?.catch?.((err) => logger.debug("FXMaster:", err));
        } catch (err) {
          logger.debug("FXMaster:", err);
          complete();
        }
      };

      video.oncanplay = onCanPlay;
      video.onerror = complete;
      video.onended = complete;
      video.load?.();
    });
  }

  /**
   * Return a safe placeholder macro for retired special-effect macro generation.
   *
   * @returns {string}
   * @protected
   */
  static _createMacro() {
    const msg = "FXMaster no longer supports custom animations macros. For an alternative, use the Sequencer module.";
    try {
      ui.notifications.warn(msg);
    } catch (_err) {}
    return `ui.notifications.warn(${JSON.stringify(msg)});`;
  }

  #handleSocketPlayback(data) {
    if (!data?.file) return;
    void this.playVideo(data);
  }

  #configureSpecialEffectMesh(mesh, data) {
    mesh.anchor?.set?.(Number(data.anchor?.x ?? 0.5), Number(data.anchor?.y ?? 0.5));
    mesh.rotation = Math.normalizeRadians((Number(data.rotation) || 0) - Math.toRadians(Number(data.angle) || 0));
    mesh.scale?.set?.(Number(data.scale?.x ?? 1) || 1, Number(data.scale?.y ?? 1) || 1);
    mesh.position?.set?.(Number(data.position?.x ?? 0) || 0, Number(data.position?.y ?? 0) || 0);
    mesh.elevation = data.elevation ?? 1;

    const width = Number(data.width ?? 0);
    if (width > 0) {
      if (data.keepAspect && Number(mesh.width) !== 0) {
        const aspectRatio = mesh.height / mesh.width;
        mesh.height = width * aspectRatio;
      }
      mesh.width = width;
    }
  }

  #finalizePlayback(record) {
    if (!record || record.resolved) return;
    record.resolved = true;

    const { video, mesh } = record;
    this.videos = this.videos.filter((entry) => entry !== record);

    try {
      if (mesh) canvas.primary?.removeChild?.(mesh);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    try {
      if (mesh) canvas.primary?.videoMeshes?.delete?.(mesh);
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    try {
      if (mesh && !mesh.destroyed) mesh.destroy?.({ children: true, texture: true, baseTexture: true });
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    try {
      video.pause?.();
      video.removeAttribute?.("src");
      video.load?.();
    } catch (err) {
      logger.debug("FXMaster:", err);
    }

    record.resolve?.();
  }
}
