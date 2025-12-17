/**
 * FXMaster: Particle Scene Suppression Manager
 * Builds and applies a CSS-space allow-mask to scene-level particle containers and FX.
 */

import { packageId } from "../constants.js";
import { logger } from "../logger.js";
import {
  ensureCssSpaceMaskSprite,
  safeMaskTexture,
  getCssViewportMetrics,
  applyMaskSpriteTransform,
} from "../utils.js";
import { SceneMaskManager } from "../common/base-effects-scene-manager.js";

const CONTAINER_MASK_NAME = "fxmaster:scene-particles-container-mask";
const FX_MASK_NAME = "fxmaster:scene-particles-fx-mask";

const _maskSpritesBase = new Set();
const _maskSpritesCutout = new Set();

/**
 * Recompute and attach suppression masks for scene-level particles.
 */
export function refreshSceneParticlesSuppressionMasks() {
  try {
    const layer = canvas.particleeffects;
    if (!layer) return;

    layer._dyingSceneEffects ??= new Set();

    const liveFx = _collectSceneLevelFx(layer);
    const dyingFx = Array.from(layer._dyingSceneEffects ?? []);

    const _knownSceneFxContainers = () => {
      const out = [];
      try {
        if (layer?._belowContainer) out.push(layer._belowContainer);
      } catch {}
      try {
        if (layer?._aboveContent) out.push(layer._aboveContent);
      } catch {}
      return out.filter(Boolean);
    };

    if (liveFx.length === 0 && dyingFx.length === 0) {
      const containers = _knownSceneFxContainers();
      for (const c of containers) _ensureContainerMaskSprite(c, null);
      _detachPerFxMasks(liveFx);
      return;
    }

    SceneMaskManager.instance.refreshSync("particles");
    const { base: maskRT, cutout: cutoutRT } = SceneMaskManager.instance.masks;

    const allFxEntries = [...liveFx, ...dyingFx].map((fx) => ({ fx }));

    const containers = _knownSceneFxContainers();
    for (const c of containers) _ensureContainerMaskSprite(c, null);

    _retargetSpritesFromTexture(allFxEntries, maskRT, { useCutout: false });

    _retargetSpritesFromTexture(allFxEntries, cutoutRT, { useCutout: true });
  } catch (err) {
    logger?.error?.(err);
  }
}

/**
 * Collect all scene-level particle effect nodes that should be masked.
 * @param {ParticleEffectsRegionLayer} layer
 * @returns {PIXI.DisplayObject[]}
 * @private
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
            if (ch instanceof CONFIG.fxmaster.ParticleEffectNS || ch?.__fxmIsParticleEffect || ch?.isParticleEffect)
              out.push(ch);
          } catch {}
          if (ch?.children?.length) stack.push(ch);
        }
      }
    }
  } catch {}
  return out;
}

/**
 * Ensure a container-level CSS-space sprite exists and is applied as container.mask.
 * @param {PIXI.Container} container
 * @param {PIXI.RenderTexture|null} texture
 * @private
 */
function _ensureContainerMaskSprite(container, texture) {
  if (!container) return;

  let spr = container.children?.find?.((c) => c?.name === CONTAINER_MASK_NAME) || null;

  if (!texture) {
    if (spr && !spr.destroyed) {
      try {
        if (container.mask === spr) container.mask = null;
      } catch {}
      try {
        spr.texture = safeMaskTexture(null);
      } catch {}
      _registerMaskSprite(spr, null);
      try {
        container.removeChild(spr);
      } catch {}
      try {
        spr.destroy({ texture: false, baseTexture: false });
      } catch {}
    }
    return;
  }

  spr = ensureCssSpaceMaskSprite(container, texture, CONTAINER_MASK_NAME);
  _registerMaskSprite(spr, texture);
}

/**
 * Remove per-FX mask sprites from FX nodes.
 * @param {PIXI.DisplayObject[]} fxList
 * @private
 */
function _detachPerFxMasks(fxList) {
  for (const fx of fxList) {
    try {
      const old = fx?._fxmSceneParticlesMaskSprite;
      if (old && !old.destroyed) {
        if (fx.mask === old) fx.mask = null;
        try {
          old.texture = safeMaskTexture(null);
        } catch {}
        _registerMaskSprite(old, null);
        fx.removeChild(old);
        old.destroy({ texture: false, baseTexture: false });
      }
    } catch {}
    if (fx) fx._fxmSceneParticlesMaskSprite = null;
  }
}

/**
 * Apply container-level or per-FX masks depending on container state.
 * @param {PIXI.Container} container
 * @param {PIXI.DisplayObject[]} fxInContainer
 * @param {PIXI.RenderTexture|null} baseTexture
 * @param {PIXI.RenderTexture|null} cutoutTexture
 * @private
 */
function _applyMasksRespectingExisting(container, fxInContainer, baseTexture, cutoutTexture) {
  const hasRenderableChild = (container.children || []).some(
    (ch) => ch && !ch.destroyed && ch.name !== CONTAINER_MASK_NAME,
  );
  if (!hasRenderableChild) {
    _ensureContainerMaskSprite(container, null);
    _detachPerFxMasks(fxInContainer);
    return;
  }

  const hasForeignMask = !!container.mask && container.mask.name !== CONTAINER_MASK_NAME;

  if (!hasForeignMask) {
    _ensureContainerMaskSprite(container, baseTexture);
    for (const fx of fxInContainer) {
      const wantsCutout = !!fx?._fxmOptsCache?.belowTokens?.value || !!fx?.options?.belowTokens?.value;
      if (wantsCutout && cutoutTexture) {
        const spr = _ensureCssSpaceMaskSpriteSafe(fx, cutoutTexture, FX_MASK_NAME);
        fx._fxmSceneParticlesMaskSprite = spr;
      } else {
        try {
          const spr = fx?._fxmSceneParticlesMaskSprite;
          if (spr && !spr.destroyed) {
            if (fx.mask === spr) fx.mask = null;
            spr.texture = safeMaskTexture(null);
            _registerMaskSprite(spr, null);
            fx.removeChild(spr);
            spr.destroy({ texture: false, baseTexture: false });
          }
        } catch {}
        fx._fxmSceneParticlesMaskSprite = null;
      }
    }
    return;
  }

  for (const fx of fxInContainer) {
    const wantsCutout = !!fx?._fxmOptsCache?.belowTokens?.value || !!fx?.options?.belowTokens?.value;
    const tex = wantsCutout ? cutoutTexture || baseTexture : baseTexture;

    if (!tex) {
      try {
        const spr = fx?._fxmSceneParticlesMaskSprite;
        if (spr && !spr.destroyed) {
          if (fx.mask === spr) fx.mask = null;
          spr.texture = safeMaskTexture(null);
          _registerMaskSprite(spr, null);
          fx.removeChild(spr);
          spr.destroy({ texture: false, baseTexture: false });
        }
      } catch {}
      fx._fxmSceneParticlesMaskSprite = null;
      continue;
    }

    const spr = _ensureCssSpaceMaskSpriteSafe(fx, tex, FX_MASK_NAME);
    fx._fxmSceneParticlesMaskSprite = spr;
  }
}

/**
 * Track which shared RT a sprite uses for safe retargeting.
 * @param {PIXI.Sprite} sprite
 * @param {PIXI.Texture|PIXI.RenderTexture|null} texture
 * @private
 */
function _registerMaskSprite(sprite, texture) {
  try {
    _maskSpritesBase.delete(sprite);
    _maskSpritesCutout.delete(sprite);
    const { base, cutout } = SceneMaskManager.instance.masks;
    if (!sprite || sprite.destroyed || !texture) return;
    if (texture === base) _maskSpritesBase.add(sprite);
    else if (texture === cutout) _maskSpritesCutout.add(sprite);
  } catch {}
}

/**
 * Retarget sprites that referenced an old shared RT to a new texture,
 * and re-project them for the current camera / viewport.
 * @param {PIXI.Texture|PIXI.RenderTexture|null} oldTex
 * @param {PIXI.Texture|PIXI.RenderTexture|null} newTex
 * @private
 */
/**
 * Retarget per-FX mask sprites to the given shared RT, and re-project
 * them for the current camera / viewport.
 *
 * @param {{fx: PIXI.Container}[]|PIXI.Container[]} entries
 * @param {PIXI.Texture|PIXI.RenderTexture|null} tex
 * @param {{useCutout?: boolean}} [opts]
 * @private
 */
function _retargetSpritesFromTexture(entries, tex, { useCutout = false } = {}) {
  if (!entries || !entries[Symbol.iterator]) return;

  const { cssW, cssH } = getCssViewportMetrics();

  for (const entry of entries) {
    const fx = entry?.fx ?? entry;
    if (!fx || fx.destroyed) continue;

    const wantsCutout =
      !!fx?._fxmOptsCache?.belowTokens?.value || !!fx?.options?.belowTokens?.value || !!fx?.__fxmBelowTokens;

    if (wantsCutout !== useCutout) continue;

    if (!tex) {
      try {
        const old = fx._fxmSceneParticlesMaskSprite;
        if (old && !old.destroyed) {
          if (fx.mask === old) fx.mask = null;
          try {
            old.texture = safeMaskTexture(null);
          } catch {}
          try {
            fx.removeChild(old);
          } catch {}
          try {
            old.destroy({ texture: false, baseTexture: false });
          } catch {}
        }
      } catch {}
      fx._fxmSceneParticlesMaskSprite = null;
      continue;
    }

    let spr = fx._fxmSceneParticlesMaskSprite;
    if (!spr || spr.destroyed) {
      spr = new PIXI.Sprite(safeMaskTexture(tex));
      spr.name = FX_MASK_NAME;
      spr.eventMode = "none";
      spr.interactive = false;
      spr.cursor = null;
      try {
        fx.addChildAt(spr, 0);
      } catch {
        fx.addChild(spr);
      }
      fx._fxmSceneParticlesMaskSprite = spr;
    } else {
      try {
        spr.texture = safeMaskTexture(tex);
      } catch {}
    }

    spr.x = 0;
    spr.y = 0;
    spr.width = cssW;
    spr.height = cssH;

    try {
      applyMaskSpriteTransform(fx, spr);
    } catch (e) {
      try {
        logger.error(`${packageId} | Failed to reapply scene particles mask sprite transform`, e);
      } catch {}
    }

    if (fx.mask !== spr) {
      try {
        fx.mask = spr;
      } catch {}
    }
  }
}

/**
 * Safe wrapper around ensureCssSpaceMaskSprite with sprite tracking.
 * @param {PIXI.Container} node
 * @param {PIXI.Texture|PIXI.RenderTexture|null} texture
 * @param {string} name
 * @returns {PIXI.Sprite}
 * @private
 */
function _ensureCssSpaceMaskSpriteSafe(node, texture, name) {
  const spr = ensureCssSpaceMaskSprite(node, safeMaskTexture(texture), name);
  try {
    spr.texture = safeMaskTexture(texture);
  } catch {}
  _registerMaskSprite(spr, texture);
  return spr;
}
