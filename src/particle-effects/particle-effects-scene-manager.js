/**
 * FXMaster: Particle Scene Suppression Manager
 * Builds and applies a CSS-space allow-mask to scene-level particle containers and FX.
 */

import { packageId } from "../constants.js";
import { logger } from "../logger.js";
import { composeMaskMinusTokens, ensureCssSpaceMaskSprite, safeMaskTexture, buildSceneAllowMaskRT } from "../utils.js";

let _sceneParticlesMaskRT = null;
let _sceneParticlesMaskRT_Cutout = null;

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
      _swapSharedMaskRT(null, true);
      return;
    }

    const anyBelowTokens = [...liveFx, ...dyingFx].some(
      (fx) => !!(fx?._fxmOptsCache?.belowTokens?.value ?? fx?.options?.belowTokens?.value),
    );

    const suppressRegions = _getSuppressRegions();
    const hasSuppress = suppressRegions.length > 0;

    if (!hasSuppress && !anyBelowTokens) {
      const containers = _knownSceneFxContainers();
      for (const c of containers) _ensureContainerMaskSprite(c, null);
      _detachPerFxMasks(liveFx);
      _swapSharedMaskRT(null, true);
      return;
    }

    const newBase = buildSceneAllowMaskRT({
      regions: suppressRegions,
      reuseRT: _sceneParticlesMaskRT,
    });

    const oldBase = _sceneParticlesMaskRT || null;
    const oldCut = _sceneParticlesMaskRT_Cutout || null;

    _sceneParticlesMaskRT = newBase || null;
    _sceneParticlesMaskRT_Cutout = newBase && anyBelowTokens ? composeMaskMinusTokens(newBase) : null;

    _retargetSpritesFromTexture(oldBase, _sceneParticlesMaskRT);
    _retargetSpritesFromTexture(oldCut, _sceneParticlesMaskRT_Cutout ?? _sceneParticlesMaskRT);

    if (oldBase && oldBase !== _sceneParticlesMaskRT)
      requestAnimationFrame(() => {
        try {
          oldBase.destroy(true);
        } catch {}
      });
    if (oldCut && oldCut !== _sceneParticlesMaskRT_Cutout)
      requestAnimationFrame(() => {
        try {
          oldCut.destroy(true);
        } catch {}
      });

    const allFx = [...liveFx, ...dyingFx];
    const byParent = new Map();
    for (const fx of allFx) {
      const p = fx?.parent;
      if (!p) continue;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(fx);
    }

    const known = _knownSceneFxContainers();
    const activeContainers = byParent.size ? Array.from(byParent.keys()) : [];

    for (const c of known) {
      if (!activeContainers.includes(c)) _ensureContainerMaskSprite(c, null);
    }

    const containers = activeContainers.length ? activeContainers : known;
    for (const c of containers) {
      const fxInC = byParent.get(c) || [];
      _applyMasksRespectingExisting(c, fxInC, _sceneParticlesMaskRT, _sceneParticlesMaskRT_Cutout);
    }
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
 * Get regions that suppress scene-level particles.
 * @returns {PlaceableObject[]}
 * @private
 */
function _getSuppressRegions() {
  const SUPPRESS_TYPES = new Set(["suppressWeather", `${packageId}.suppressSceneParticles`]);
  const regions = canvas.regions?.placeables ?? [];
  return regions.filter((reg) => (reg.document.behaviors ?? []).some((b) => SUPPRESS_TYPES.has(b.type) && !b.disabled));
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
 * Swap the shared allow-mask RT and optionally destroy the old texture.
 * @param {PIXI.RenderTexture|null} newRT
 * @param {boolean} destroyOld
 * @private
 */
function _swapSharedMaskRT(newRT, destroyOld) {
  const old = _sceneParticlesMaskRT || null;
  _sceneParticlesMaskRT = newRT || null;
  if (destroyOld && old && !newRT) {
    try {
      old.destroy(true);
    } catch {}
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
    if (!sprite || sprite.destroyed || !texture) return;
    if (texture === _sceneParticlesMaskRT) _maskSpritesBase.add(sprite);
    else if (texture === _sceneParticlesMaskRT_Cutout) _maskSpritesCutout.add(sprite);
  } catch {}
}

/**
 * Retarget sprites that referenced an old shared RT to a new texture.
 * @param {PIXI.Texture|PIXI.RenderTexture|null} oldTex
 * @param {PIXI.Texture|PIXI.RenderTexture|null} newTex
 * @private
 */
function _retargetSpritesFromTexture(oldTex, newTex) {
  if (!oldTex) return;
  const set =
    oldTex === _sceneParticlesMaskRT
      ? _maskSpritesBase
      : oldTex === _sceneParticlesMaskRT_Cutout
      ? _maskSpritesCutout
      : null;
  if (!set) return;
  for (const spr of set) {
    if (!spr || spr.destroyed) continue;
    try {
      spr.texture = safeMaskTexture(newTex);
    } catch {}
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
