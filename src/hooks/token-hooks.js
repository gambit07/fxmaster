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

  Hooks.on("updateToken", (tokenDoc) => {
    if (tokenDoc?.parent !== canvas.scene) return;
    if (!isEnabled()) return;
    ctx.requestTokenMaskRefresh();
  });

  Hooks.on("deleteToken", (tokenDoc) => {
    if (tokenDoc?.parent !== canvas.scene) return;
    if (!isEnabled()) return;
    ctx.requestTokenMaskRefresh();
  });

  Hooks.on("refreshToken", (placeable) => {
    if (placeable?.document?.parent !== canvas.scene) return;
    if (!isEnabled()) return;
    ctx.requestTokenMaskRefresh();
  });

  Hooks.on("createTile", () => ctx.requestTokenMaskRefresh());
  Hooks.on("updateTile", () => ctx.requestTokenMaskRefresh());
  Hooks.on("deleteTile", () => ctx.requestTokenMaskRefresh());
  Hooks.on("refreshTile", (placeable) => {
    if (placeable?.document?.parent !== canvas.scene) return;
    if (!isEnabled()) return;
    ctx.requestTokenMaskRefresh();
  });
}
