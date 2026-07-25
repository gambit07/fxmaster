/**
 * FXMaster: Token & Tile Hooks
 *
 * Registers Foundry hooks for token and tile create/update/delete events that trigger mask refreshes for below-object rendering pipelines.
 *
 * @module hooks/token-hooks
 */

import { isEnabled } from "../settings.js";

/**
 * Register token and tile lifecycle hooks.
 *
 * @param {object} ctx - Shared hook context from {@link createHookContext}.
 */
export function registerTokenHooks(ctx) {
  Hooks.on("createToken", (tokenDoc) => {
    if (tokenDoc?.parent !== canvas.scene) return;
    if (!isEnabled()) return;
    ctx.requestTokenMaskRefresh();
  });

  Hooks.on("updateToken", (tokenDoc, changed, _options, userId) => {
    if (tokenDoc?.parent !== canvas.scene) return;
    if (!isEnabled()) return;
    canvas.particleeffects?.noteParticleTrailTokenMovement?.(tokenDoc, { changed, userId });
    ctx.requestTokenMaskRefresh();
  });

  Hooks.on("controlToken", (placeable) => {
    if (placeable?.document?.parent !== canvas.scene) return;
    if (!isEnabled()) return;
    canvas.particleeffects?.noteParticleTrailTokenControl?.(placeable);
    ctx.requestTokenMaskRefresh();
  });

  Hooks.on("deleteToken", (tokenDoc) => {
    if (tokenDoc?.parent !== canvas.scene) return;
    if (!isEnabled()) return;
    canvas.particleeffects?.forgetParticleTrailToken?.(tokenDoc);
    ctx.requestTokenMaskRefresh();
  });

  Hooks.on("refreshToken", (placeable) => {
    if (placeable?.document?.parent !== canvas.scene) return;
    if (!isEnabled()) return;
    ctx.requestTokenMaskRefresh();
  });

  Hooks.on("createTile", (tileDoc) => {
    if (tileDoc?.parent !== canvas.scene) return;
    if (!isEnabled()) return;
    ctx.requestTokenMaskRefresh();
  });

  Hooks.on("updateTile", (tileDoc) => {
    if (tileDoc?.parent !== canvas.scene) return;
    if (!isEnabled()) return;
    ctx.requestTokenMaskRefresh();
  });

  Hooks.on("deleteTile", (tileDoc) => {
    if (tileDoc?.parent !== canvas.scene) return;
    if (!isEnabled()) return;
    ctx.requestTokenMaskRefresh();
  });
  Hooks.on("refreshTile", (placeable) => {
    if (placeable?.document?.parent !== canvas.scene) return;
    if (!isEnabled()) return;
    ctx.requestTokenMaskRefresh();
  });
}
