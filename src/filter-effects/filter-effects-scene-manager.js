/**
 * FilterEffectsSceneManager
 * -------------
 * Manages scene-wide post-processing filters for FXMaster.
 * - Attaches scene filters to canvas.environment
 * - Clamps filter effect to the scene rectangle via an allow-mask render texture
 * - Honors suppression regions: core "suppressWeather" and `${packageId}.suppressSceneFilters`
 *   Builds a device-pixel allow-mask RT and provides common uniforms
 *   (`maskSampler`, `hasMask`, `viewSize` in CSS px, `maskReady`, `deviceToCss`).
 * - Handles create/update/delete with fade-out, and keeps masks in sync with camera.
 *
 * CHANGE: Mixed belowTokens ordering
 * -------
 * When filters are mixed (some with options.belowTokens=true, some false), ensure
 * non-belowTokens filters run FIRST and belowTokens filters run LAST in the env.filters chain.
 * This prevents below-tokens passes from visually neutralizing earlier passes.
 *
 * CHANGE: Token-aware displacement guard for belowTokens
 * -------
 * For filters that visually displace the scene (e.g., Underwater), tokens appear to move unless
 * the shader can tell that the displaced source texel originated from a token. We now build a
 * CSS-space tokens-only mask RT and pass it as `tokenSampler` with a `hasTokenMask` flag for
 * filters whose options.belowTokens is true. Shaders can sample this RT at the *displaced*
 * screen-space location to decide whether to keep the undisplaced color.
 */

import { packageId } from "../constants.js";
import { logger } from "../logger.js";
import { resetFlag } from "../utils.js";

export class FilterEffectsSceneManager {
  constructor() {
    this.filters = {};
    this._dyingFilters = new Set();
    this._ticker = false;
    this._suppressMaskRT = null;
    this._suppressMaskCutoutRT = null;
    this._tokensMaskRT = null;
    this._lastRegionsMatrix = null;
  }

  static get instance() {
    if (!this.#instance) this.#instance = new this();
    return this.#instance;
  }
  static #instance;

  static get container() {
    return canvas.environment;
  }

  async activate() {
    await this.update({ skipFading: true });
    if (!this._ticker) {
      const PRIO = PIXI.UPDATE_PRIORITY?.HIGH ?? 25;
      try {
        canvas.app.ticker.add(this.#animate, this, PRIO);
      } catch {
        canvas.app.ticker.add(this.#animate, this);
      }
      this._ticker = true;
    }
    this.#refreshSceneFilterSuppressionMask();
  }

  async clear() {
    const env = this.constructor.container;
    const ours = Object.values(this.filters);
    const dying = [...this._dyingFilters];

    const promises = [...ours, ...dying].map((f) => f.stop?.({ skipFading: true }));
    await Promise.all(promises);

    try {
      if (env?.filters?.length) {
        const set = new Set([...ours, ...dying]);
        env.filters = env.filters.filter((f) => !set.has(f));
      }
    } catch {}

    this.filters = {};
    this._dyingFilters.clear();
    this.#destroySuppressMask();

    try {
      canvas?.app?.ticker?.remove?.(this.#animate, this);
    } catch {}
    this._ticker = false;
  }

  async update({ skipFading = false } = {}) {
    if (!canvas.scene) return;

    const filterInfos = Object.fromEntries(
      Object.entries(canvas.scene.getFlag(packageId, "filters") ?? {}).filter(([id, info]) => {
        if (!(info.type in CONFIG.fxmaster.filterEffects)) {
          logger.warn(game.i18n.format("FXMASTER.Filters.TypeErrors.TypeUnknown", { id, type: info.type }));
          return false;
        }
        return true;
      }),
    );

    const createKeys = Object.keys(filterInfos).filter((k) => !(k in this.filters));
    const updateKeys = Object.keys(filterInfos).filter((k) => k in this.filters);
    const deleteKeys = Object.keys(this.filters).filter((k) => !(k in filterInfos));

    for (const key of createKeys) {
      const { type, options } = filterInfos[key];
      this.filters[key] = new CONFIG.fxmaster.filterEffects[type](options, key);
      this.filters[key].play?.({ skipFading });
    }

    for (const key of updateKeys) {
      const { options } = filterInfos[key];
      const f = this.filters[key];
      f.configure?.(options);
      f.play?.({ skipFading });
    }

    for (const key of deleteKeys) {
      const f = this.filters[key];
      delete this.filters[key];
      if (!f) continue;
      this._dyingFilters.add(f);
      Promise.resolve(f.stop?.({ skipFading }))
        .catch(() => {})
        .finally(() => {
          this.#removeFromEnvFilters([f]);
          try {
            f.destroy?.();
          } catch {}
          this._dyingFilters.delete(f);
          if (!Object.keys(this.filters).length && this._dyingFilters.size === 0) {
            this.#destroySuppressMask();
          }
        });
    }

    this.#applyFilters();
    this.#applySuppressMaskToFilters();
  }

  refreshViewMaskGeometry() {
    this.#refreshSceneFilterSuppressionMask();
  }

  refreshSceneFilterSuppressionMask() {
    this.#refreshSceneFilterSuppressionMask();
  }

  async addFilter(name, type, options) {
    name = name ?? foundry.utils.randomID();
    await canvas.scene?.setFlag(packageId, "filters", { [name]: { type, options } });
  }

  async removeFilter(name) {
    await canvas.scene?.setFlag(packageId, "filters", { [`-=${name}`]: null });
  }

  async removeAll() {
    await canvas.scene?.unsetFlag(packageId, "filters");
  }

  async switch(name, type, options) {
    if (!canvas.scene) return;
    const infos = canvas.scene.getFlag(packageId, "filters") ?? {};
    if (infos[name]) return this.removeFilter(name);
    return this.addFilter(name, type, options);
  }

  async setFilters(arr) {
    const infos = Object.fromEntries(arr.map((fi) => [foundry.utils.randomID(), fi]));
    await resetFlag(canvas.scene, "filters", infos);
  }

  #destroySuppressMask() {
    try {
      this._suppressMaskRT?.destroy(true);
    } catch {}
    this._suppressMaskRT = null;
    try {
      this._suppressMaskCutoutRT?.destroy(true);
    } catch {}
    this._suppressMaskCutoutRT = null;
    try {
      this._tokensMaskRT?.destroy(true);
    } catch {}
    this._tokensMaskRT = null;
  }

  #getSuppressRegions() {
    const SUPPRESS_TYPES = new Set(["suppressWeather", `${packageId}.suppressSceneFilters`]);
    const placeables = canvas.regions?.placeables ?? [];
    return placeables.filter((region) =>
      region.document.behaviors?.some((b) => SUPPRESS_TYPES.has(b.type) && !b.disabled),
    );
  }

  #getCameraMatrix() {
    const M = canvas.primary?.worldTransform ?? canvas.stage?.worldTransform ?? new PIXI.Matrix();
    return M.clone();
  }

  /** Paint the suppression allow-mask (scene rect minus suppression regions) into an RT. */
  #paintSuppressMaskInto(rt) {
    const r = canvas?.app?.renderer;
    const dims = canvas?.scene?.dimensions;
    if (!r || !dims || !rt) return;

    const screenW = Math.max(1, r.screen.width | 0);
    const screenH = Math.max(1, r.screen.height | 0);

    {
      const bg = new PIXI.Graphics();
      bg.beginFill(0x000000, 1).drawRect(0, 0, screenW, screenH).endFill();
      r.render(bg, { renderTexture: rt, clear: true });
      bg.destroy(true);
    }

    const res = r.resolution || 1;
    const camRaw = this.#getCameraMatrix();
    const camM = camRaw.clone();
    camM.tx = Math.round(camM.tx * res) / res;
    camM.ty = Math.round(camM.ty * res) / res;

    {
      const rect = dims.sceneRect;
      if (rect) {
        const g = new PIXI.Graphics();
        g.transform.setFromMatrix(camM);
        g.roundPixels = false;
        g.beginFill(0xffffff, 1)
          .drawRect(rect.x | 0, rect.y | 0, rect.width | 0, rect.height | 0)
          .endFill();
        r.render(g, { renderTexture: rt, clear: false });
        g.destroy(true);
      }
    }

    {
      const regions = this.#getSuppressRegions();
      if (regions.length) {
        const shapesGfx = new PIXI.Graphics();
        shapesGfx.transform.setFromMatrix(camM);
        shapesGfx.roundPixels = false;

        shapesGfx.beginFill(0x000000, 1);
        for (const region of regions) {
          for (const s of region.document.shapes) {
            const drawShape = () => {
              switch (s.type) {
                case "polygon":
                  shapesGfx.drawShape(new PIXI.Polygon(s.points));
                  break;
                case "ellipse":
                  shapesGfx.drawEllipse(s.x, s.y, s.radiusX, s.radiusY);
                  break;
                case "rectangle":
                  shapesGfx.drawRect(s.x, s.y, s.width, s.height);
                  break;
                default:
                  if (Array.isArray(s.points)) shapesGfx.drawShape(new PIXI.Polygon(s.points));
              }
            };
            if (s.hole) {
              shapesGfx.beginHole();
              drawShape();
              shapesGfx.endHole();
            } else drawShape();
          }
        }
        shapesGfx.endFill();

        r.render(shapesGfx, { renderTexture: rt, clear: false });
        shapesGfx.destroy(true);
      }
    }
  }

  _collectTokenAlphaSprites() {
    const sprites = [];
    for (const t of canvas.tokens?.placeables ?? []) {
      if (!t.visible || t.document.hidden) continue;
      const icon = t.icon ?? t.mesh ?? t;
      const tex = icon?.texture;
      const wt = icon?.worldTransform;
      if (!tex?.baseTexture?.valid || !wt) continue;

      const spr = new PIXI.Sprite(tex);
      try {
        spr.anchor.set(icon.anchor?.x ?? 0.5, icon.anchor?.y ?? 0.5);
      } catch {}
      try {
        spr.transform.setFromMatrix(wt);
      } catch {
        try {
          spr.destroy(true);
        } catch {}
        continue;
      }
      sprites.push(spr);
    }
    return sprites;
  }

  _composeMaskMinusTokens(baseRT) {
    const r = canvas?.app?.renderer;
    if (!r || !baseRT) return baseRT;

    const out = PIXI.RenderTexture.create({
      width: baseRT.width | 0,
      height: baseRT.height | 0,
      resolution: baseRT.resolution || 1,
      multisample: 0,
    });

    r.render(new PIXI.Sprite(baseRT), { renderTexture: out, clear: true });

    const cont = new PIXI.Container();
    for (const s of this._collectTokenAlphaSprites()) {
      s.blendMode = PIXI.BLEND_MODES.DST_OUT;
      cont.addChild(s);
    }
    if (cont.children.length) r.render(cont, { renderTexture: out, clear: false });
    try {
      cont.destroy({ children: true, texture: false, baseTexture: false });
    } catch {}

    return out;
  }

  /** Repaint a cutout into an existing RT, copying base and erasing tokens. */
  _repaintCutoutFromBase(baseRT, outRT) {
    const r = canvas?.app?.renderer;
    if (!r || !baseRT || !outRT) return;
    r.render(new PIXI.Sprite(baseRT), { renderTexture: outRT, clear: true });
    const cont = new PIXI.Container();
    for (const s of this._collectTokenAlphaSprites()) {
      s.blendMode = PIXI.BLEND_MODES.DST_OUT;
      cont.addChild(s);
    }
    if (cont.children.length) r.render(cont, { renderTexture: outRT, clear: false });
    try {
      cont.destroy({ children: true, texture: false, baseTexture: false });
    } catch {}
  }

  /** NEW: repaint a tokens-only silhouette (CSS-space) into an existing RT. */
  _repaintTokensMaskInto(outRT) {
    const r = canvas?.app?.renderer;
    if (!r || !outRT) return;
    const cont = new PIXI.Container();
    for (const s of this._collectTokenAlphaSprites()) {
      s.blendMode = PIXI.BLEND_MODES.NORMAL;
      cont.addChild(s);
    }
    r.render(cont, { renderTexture: outRT, clear: true });
    try {
      cont.destroy({ children: true, texture: false, baseTexture: false });
    } catch {}
  }

  #applySuppressMaskToFilters() {
    const r = canvas?.app?.renderer;
    if (!r) return;

    const screen = r.screen;
    const cssW = Math.max(1, screen.width | 0);
    const cssH = Math.max(1, screen.height | 0);
    const cssFA = new PIXI.Rectangle(0, 0, cssW, cssH);
    const deviceToCss = 1 / (r.resolution || window.devicePixelRatio || 1);

    const filtersArr = [...Object.values(this.filters), ...this._dyingFilters];
    if (!filtersArr.length) return;

    const W = Math.max(1, r.screen.width | 0);
    const H = Math.max(1, r.screen.height | 0);
    const res = r.resolution || 1;

    if (
      !this._suppressMaskRT ||
      this._suppressMaskRT.width !== W ||
      this._suppressMaskRT.height !== H ||
      (this._suppressMaskRT.resolution || 1) !== res
    ) {
      try {
        this._suppressMaskRT?.destroy(true);
      } catch {}
      this._suppressMaskRT = PIXI.RenderTexture.create({ width: W, height: H, resolution: res, multisample: 0 });
    }
    this.#paintSuppressMaskInto(this._suppressMaskRT);
    try {
      this._suppressMaskRT.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
      this._suppressMaskRT.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
    } catch {}

    const baseForPlain = this._suppressMaskRT;

    const anyBelow = filtersArr.some((f) => !!f?.options?.belowTokens);
    if (anyBelow) {
      if (
        !this._suppressMaskCutoutRT ||
        this._suppressMaskCutoutRT.width !== W ||
        this._suppressMaskCutoutRT.height !== H ||
        (this._suppressMaskCutoutRT.resolution || 1) !== res
      ) {
        try {
          this._suppressMaskCutoutRT?.destroy(true);
        } catch {}
        this._suppressMaskCutoutRT = PIXI.RenderTexture.create({
          width: W,
          height: H,
          resolution: res,
          multisample: 0,
        });
      }
      this._repaintCutoutFromBase(baseForPlain, this._suppressMaskCutoutRT);
      try {
        this._suppressMaskCutoutRT.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
        this._suppressMaskCutoutRT.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
      } catch {}

      if (
        !this._tokensMaskRT ||
        this._tokensMaskRT.width !== W ||
        this._tokensMaskRT.height !== H ||
        (this._tokensMaskRT.resolution || 1) !== res
      ) {
        try {
          this._tokensMaskRT?.destroy(true);
        } catch {}
        this._tokensMaskRT = PIXI.RenderTexture.create({ width: W, height: H, resolution: res, multisample: 0 });
      }
      this._repaintTokensMaskInto(this._tokensMaskRT);
      try {
        this._tokensMaskRT.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
        this._tokensMaskRT.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
      } catch {}
    } else {
      if (this._suppressMaskCutoutRT) {
        try {
          this._suppressMaskCutoutRT.destroy(true);
        } catch {}
        this._suppressMaskCutoutRT = null;
      }
      if (this._tokensMaskRT) {
        try {
          this._tokensMaskRT.destroy(true);
        } catch {}
        this._tokensMaskRT = null;
      }
    }

    for (const f of filtersArr) {
      const u = f?.uniforms;
      if (!u) continue;

      const wantBelow = !!f?.options?.belowTokens;
      const rt = wantBelow ? this._suppressMaskCutoutRT || baseForPlain : baseForPlain;

      if ("maskSampler" in u) u.maskSampler = rt;
      if ("hasMask" in u) u.hasMask = 1.0;
      if ("viewSize" in u) u.viewSize = new Float32Array([cssW, cssH]);
      if ("maskReady" in u) u.maskReady = 1.0;
      if ("deviceToCss" in u) u.deviceToCss = deviceToCss;

      if (wantBelow && this._tokensMaskRT) {
        if ("tokenSampler" in u) u.tokenSampler = this._tokensMaskRT;
        if ("hasTokenMask" in u) u.hasTokenMask = 1.0;
      } else {
        if ("hasTokenMask" in u) u.hasTokenMask = 0.0;
      }

      try {
        f.filterArea = cssFA;
      } catch {}
      f.autoFit = false;
      f.padding = 0;
    }
  }

  #refreshSceneFilterSuppressionMask() {
    const hasAny = Object.keys(this.filters).length > 0 || this._dyingFilters.size > 0;

    if (hasAny) this.#applySuppressMaskToFilters();

    const M = this.#getCameraMatrix();
    this._lastRegionsMatrix = { a: M.a, b: M.b, c: M.c, d: M.d, tx: M.tx, ty: M.ty };
  }

  #applyFilters() {
    const env = this.constructor.container;
    if (!env) return;

    const oursActive = Object.values(this.filters);
    const oursDying = [...this._dyingFilters];
    const oursAll = [...oursActive, ...oursDying];

    const existing = env.filters ?? [];
    const others = existing.filter((f) => !oursAll.includes(f));

    const nonBelow = oursAll.filter((f) => !f?.options?.belowTokens);
    const below = oursAll.filter((f) => f?.options?.belowTokens);

    env.filters = [...nonBelow, ...others, ...below];
  }

  #removeFromEnvFilters(filtersToRemove = []) {
    const env = this.constructor.container;
    if (!env?.filters?.length) return;
    const set = new Set(filtersToRemove);
    env.filters = env.filters.filter((f) => !set.has(f));
  }

  #animate() {
    for (const f of Object.values(this.filters)) f.step?.();

    const M = this.#getCameraMatrix?.();
    if (!M) return;

    const L = this._lastRegionsMatrix;
    const eps = 1e-4;
    const changed =
      !L ||
      Math.abs(L.a - M.a) > eps ||
      Math.abs(L.b - M.b) > eps ||
      Math.abs(L.c - M.c) > eps ||
      Math.abs(L.d - M.d) > eps ||
      Math.abs(L.tx - M.tx) > eps ||
      Math.abs(L.ty - M.ty) > eps;

    if (changed) {
      this.#refreshSceneFilterSuppressionMask();
    }

    this._lastRegionsMatrix = { a: M.a, b: M.b, c: M.c, d: M.d, tx: M.tx, ty: M.ty };
  }
}
