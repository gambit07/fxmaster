/**
 * Particle Scene Suppression Manager
 * ----------------------------------
 * Builds and applies a single screen-space (CSS px) allow-mask RenderTexture to
 * parent containers that host scene-level particle effects. The mask enforces
 * suppression regions for:
 *   - core "suppressWeather"
 *   - FXMaster "${packageId}.suppressSceneParticles"
 *
 * Approach:
 *   1) Collect all scene-level FX nodes (FXMaster scene effects + Weather tree).
 *   2) If suppression regions exist, build a white (allow) RT and punch out
 *      suppressed areas in alpha; otherwise detach masks.
 *   3) Attach one sprite (using the shared RT) per distinct parent container and
 *      set container.mask to that sprite.
 *   4) Keep a shared RT alive across swaps to minimize visible tearing.
 *
 * v12+ note:
 * With sortLayer lanes, FXMaster scene FX live under:
 *   - layer._belowContainer        (default / below weather lane content)
 *   - layer._aboveContent          (above-darkness lane content)
 *   - layer._belowTokensContent    (below-tokens lane content)
 * This manager masks those content containers directly.
 */

import { packageId } from "../constants.js";
import { logger } from "../logger.js";

/** Shared screen-space allow-mask RT (kept across swaps to reduce tearing). */
let _sceneParticlesMaskRT = null;

/** Name used for the container-level mask sprite child. */
const CONTAINER_MASK_NAME = "fxmaster:scene-particles-container-mask";

/**
 * Recompute and attach container-level suppression masks for scene-level particles.
 * Detects suppression regions, (re)builds the shared RT if needed, attaches a
 * container-level sprite mask for each parent container that hosts FX, and
 * cleans up legacy per-FX masks.
 */
export function refreshSceneParticlesSuppressionMasks() {
  try {
    const layer = canvas.particleeffects;
    if (!layer) return;

    const _knownSceneFxContainers = () => {
      const out = [];
      try {
        if (layer?._belowContainer) out.push(layer._belowContainer);
      } catch {}
      try {
        if (layer?._aboveContent) out.push(layer._aboveContent);
      } catch {}
      try {
        if (layer?._belowTokensContent) out.push(layer._belowTokensContent);
      } catch {}
      try {
        if (layer?._laneRoots?.def) out.push(layer._laneRoots.def);
      } catch {}
      try {
        if (layer?._laneRoots?.above) out.push(layer._laneRoots.above);
      } catch {}
      try {
        if (layer?._laneRoots?.belowTokens) out.push(layer._laneRoots.belowTokens);
      } catch {}
      return out.filter(Boolean);
    };

    layer._dyingSceneEffects ??= new Set();

    const liveFx = _collectSceneLevelFx(layer);
    const dyingFx = Array.from(layer._dyingSceneEffects ?? []);

    if (liveFx.length === 0 && dyingFx.length === 0) {
      _detachContainerMasksFor(_knownSceneFxContainers());
      _detachPerFxMasks(liveFx);
      _swapSharedMaskRT(null);
      return;
    }

    const hasSuppress = _getSuppressRegions();
    if (hasSuppress.length === 0) {
      const containers = _uniqueParents([...liveFx, ...dyingFx]);
      _detachContainerMasksFor(containers.length ? containers : _knownSceneFxContainers());
      _detachContainerMasksFor(_knownSceneFxContainers());
      _detachPerFxMasks(liveFx);
      _detachPerFxMasks(dyingFx);
      _swapSharedMaskRT(null);
      return;
    }

    const newRT = _buildSceneParticlesSuppressMaskRT(hasSuppress);

    const oldRT = _sceneParticlesMaskRT || null;
    _swapSharedMaskRT(newRT);

    const containers = _uniqueParents([...liveFx, ...dyingFx]);
    _applyContainerMasks(containers, _sceneParticlesMaskRT);

    const known = _knownSceneFxContainers();
    const stale = known.filter((c) => !containers.includes(c));
    _detachContainerMasksFor(stale);

    _detachPerFxMasks(liveFx);
    _detachPerFxMasks(dyingFx);

    if (oldRT && oldRT !== _sceneParticlesMaskRT) {
      requestAnimationFrame(() => {
        try {
          oldRT.destroy(true);
        } catch {}
      });
    }
  } catch (err) {
    logger?.error?.(err);
  }
}

/**
 * Collect all scene-level particle effect nodes that should be masked:
 * - FXMaster scene effects from the layer map
 * - Weather subtree nodes that represent particle effects
 */
function _collectSceneLevelFx(layer) {
  const out = [];
  try {
    const map = layer?.particleEffects;
    if (map?.values) for (const fx of map.values()) out.push(fx);
  } catch {}

  try {
    const root = canvas.weather;
    if (root) {
      const stack = [root];
      while (stack.length) {
        const n = stack.pop();
        for (const ch of n?.children ?? []) {
          try {
            if (ch instanceof CONFIG.fxmaster.ParticleEffectNS || ch?.__fxmIsParticleEffect || ch?.isParticleEffect) {
              out.push(ch);
            }
          } catch {}
          if (ch?.children?.length) stack.push(ch);
        }
      }
    }
  } catch {}

  return out;
}

/**
 * Return Regions that suppress scene-level particles.
 * Matches core "suppressWeather" and FXMaster "${packageId}.suppressSceneParticles".
 */
function _getSuppressRegions() {
  const SUPPRESS_TYPES = new Set(["suppressWeather", `${packageId}.suppressSceneParticles`]);
  const regions = canvas.regions?.placeables ?? [];
  return regions.filter((reg) => (reg.document.behaviors ?? []).some((b) => SUPPRESS_TYPES.has(b.type) && !b.disabled));
}

/**
 * Build a CSS-space allow-mask RT (white=allow, transparent=suppress).
 * Steps:
 *   1) Create a white full-screen base RT in CSS px (renderer resolution applied).
 *   2) Draw suppression geometry to a temp RT in CSS space.
 *   3) Composite the temp RT with BLEND_MODES.ERASE onto the base to punch holes.
 *
 * @param {PlaceableObject[]} hasSuppress Regions with suppression behaviors
 * @returns {PIXI.RenderTexture|null} Allow-mask RT or null if unavailable
 */
function _buildSceneParticlesSuppressMaskRT(hasSuppress) {
  const r = canvas?.app?.renderer;
  if (!r) return null;

  const res = r.resolution || 1;
  const cssW = Math.max(1, ((r.view?.width ?? r.screen.width) / res) | 0);
  const cssH = Math.max(1, ((r.view?.height ?? r.screen.height) / res) | 0);

  const rt = PIXI.RenderTexture.create({
    width: cssW,
    height: cssH,
    resolution: res,
  });
  try {
    rt.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
    rt.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
  } catch {}

  {
    const bg = new PIXI.Graphics();
    bg.beginFill(0xffffff, 1).drawRect(0, 0, cssW, cssH).endFill();
    r.render(bg, { renderTexture: rt, clear: true });
    bg.destroy(true);
  }

  const suppressedRT = PIXI.RenderTexture.create({
    width: cssW,
    height: cssH,
    resolution: res,
  });
  try {
    suppressedRT.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
    suppressedRT.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
  } catch {}

  {
    const g = new PIXI.Graphics();
    const M = (canvas.regions?.worldTransform ?? canvas.stage.worldTransform).clone();
    M.tx = Math.round(M.tx);
    M.ty = Math.round(M.ty);
    g.transform.setFromMatrix(M);
    g.roundPixels = true;

    g.beginFill(0xffffff, 1);
    for (const region of hasSuppress) {
      const shapes = region.document?.shapes ?? [];
      for (const s of shapes) {
        const draw = () => {
          switch (s.type) {
            case "polygon":
              g.drawShape(new PIXI.Polygon(s.points));
              break;
            case "ellipse":
              g.drawEllipse(s.x, s.y, s.radiusX, s.radiusY);
              break;
            case "rectangle":
              g.drawRect(s.x, s.y, s.width, s.height);
              break;
            default:
              if (Array.isArray(s.points)) g.drawShape(new PIXI.Polygon(s.points));
          }
        };
        if (s.hole) {
          g.beginHole();
          draw();
          g.endHole();
        } else draw();
      }
    }
    g.endFill();

    r.render(g, { renderTexture: suppressedRT, clear: true });
    g.destroy(true);
  }

  {
    const spr = new PIXI.Sprite(suppressedRT);
    spr.blendMode = PIXI.BLEND_MODES.ERASE;
    spr.width = cssW;
    spr.height = cssH;
    const c = new PIXI.Container();
    c.addChild(spr);
    r.render(c, { renderTexture: rt, clear: false });
    try {
      c.destroy({ children: true });
    } catch {}
  }

  try {
    suppressedRT.destroy(true);
  } catch {}
  return rt;
}

/**
 * Return unique parent containers for a list of FX nodes.
 * @param {PIXI.DisplayObject[]} fxList
 * @returns {PIXI.Container[]}
 */
function _uniqueParents(fxList) {
  const set = new Set();
  for (const fx of fxList) {
    let p = fx?.parent;
    if (!p) continue;

    // If a parent advertises a redirect for masking, honor it.
    if (p.fxmMaskRedirect) p = p.fxmMaskRedirect;
    set.add(p);
  }
  return Array.from(set);
}

/**
 * Ensure each container has a container-level mask sprite using the given texture.
 * @param {PIXI.Container[]} containers
 * @param {PIXI.RenderTexture|null} texture
 */
function _applyContainerMasks(containers, texture) {
  for (const container of containers) {
    _ensureContainerMaskSprite(container, texture);
  }
}

/**
 * Ensure a container-level CSS-space sprite exists and is applied as container.mask.
 * If texture is null, detach the mask sprite if present.
 * @param {PIXI.Container} container
 * @param {PIXI.RenderTexture|null} texture
 */
function _ensureContainerMaskSprite(container, texture) {
  if (!container) return;

  let spr = container.children?.find?.((c) => c?.name === CONTAINER_MASK_NAME);

  if (!texture) {
    if (spr && !spr.destroyed) {
      try {
        if (container.mask === spr) container.mask = null;
      } catch {}
      try {
        container.removeChild(spr);
      } catch {}
      try {
        spr.destroy({ texture: false, baseTexture: false });
      } catch {}
    }
    return;
  }

  const r = canvas?.app?.renderer;
  const res = r?.resolution || 1;
  const cssW = Math.max(1, ((r?.view?.width ?? r?.screen?.width) / res) | 0);
  const cssH = Math.max(1, ((r?.view?.height ?? r?.screen?.height) / res) | 0);

  if (!spr || spr.destroyed) {
    spr = new PIXI.Sprite(texture);
    spr.name = CONTAINER_MASK_NAME;
    spr.renderable = true;
    spr.eventMode = "none";
    spr.interactive = false;
    spr.cursor = null;
    container.addChildAt(spr, 0);
  } else {
    spr.texture = texture;
  }

  spr.x = 0;
  spr.y = 0;
  spr.width = cssW;
  spr.height = cssH;

  try {
    container.parent?.updateTransform();
    container.updateTransform();
    const Minv = container.worldTransform.clone().invert();
    spr.transform.setFromMatrix(Minv);
    spr.roundPixels = true;
    container.roundPixels = true;
  } catch {}

  container.mask = spr;
}

/**
 * Remove legacy per-FX mask sprites from FX nodes (no-op if none exist).
 * @param {PIXI.DisplayObject[]} fxList
 */
function _detachPerFxMasks(fxList) {
  for (const fx of fxList) {
    try {
      const old = fx?._fxmSceneParticlesMaskSprite;
      if (old && !old.destroyed) {
        if (fx.mask === old) fx.mask = null;
        fx.removeChild(old);
        old.destroy({ texture: false, baseTexture: false });
      }
    } catch {}
    if (fx) fx._fxmSceneParticlesMaskSprite = null;
    try {
      if (fx?.mask && fx.mask.name === CONTAINER_MASK_NAME) {
        /* intentional */
      }
    } catch {}
  }
}

/**
 * Detach container-level masks for the provided containers.
 * @param {PIXI.Container[]} containers
 */
function _detachContainerMasksFor(containers) {
  for (const container of containers) {
    _ensureContainerMaskSprite(container, null);
  }
}

/**
 * Swap the shared allow-mask RT. Destroy the old texture immediately if replaced with null.
 * @param {PIXI.RenderTexture|null} newRT
 */
function _swapSharedMaskRT(newRT) {
  const old = _sceneParticlesMaskRT || null;
  _sceneParticlesMaskRT = newRT || null;
  if (old && !newRT) {
    try {
      old.destroy(true);
    } catch {}
  }
}
