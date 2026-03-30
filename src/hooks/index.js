/**
 * FXMaster: Hook Registration - Barrel
 *
 * Orchestrates hook registration by creating the shared context and
 * delegating to domain-specific registrar functions.
 *
 * Domain groups:
 * - **Token hooks** - Token/tile CRUD → mask refresh
 * - **Region hooks** - Region/behavior CRUD → effect drawing & suppression
 * - **Canvas hooks** - canvasInit/Ready/activateScene → pipeline setup
 * - **Scene hooks** - updateScene, dropCanvasData, hotbarDrop, pan/zoom
 * - **UI hooks** - Management window tracking, scene controls, settings
 *
 * @module hooks
 */

import { createHookContext } from "./context.js";
import { registerTokenHooks } from "./token-hooks.js";
import { registerRegionHooks } from "./region-hooks.js";
import { registerCanvasHooks } from "./canvas-hooks.js";
import { registerSceneHooks } from "./scene-hooks.js";
import { registerUIHooks } from "./ui-hooks.js";

/**
 * Register all FXMaster Foundry VTT hooks.
 *
 * Creates a shared context containing mutable state and coalesced helpers, then passes it to each domain-specific registrar.
 */
export const registerHooks = function () {
  const ctx = createHookContext();

  registerTokenHooks(ctx);
  registerUIHooks(ctx);
  registerRegionHooks(ctx);
  registerCanvasHooks(ctx);
  registerSceneHooks(ctx);
};
