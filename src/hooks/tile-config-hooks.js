/**
 * FXMaster: Tile configuration hooks
 *
 * Adds particle/filter-specific weather restriction flags to Foundry's Tile overhead configuration UI. Restricts Weather remains authoritative for both systems; these flags let users opt into only one FXMaster pipeline.
 */

import { packageId } from "../constants.js";
import { logger } from "../logger.js";
import { fxmDocumentId } from "../utils.js";

const TILE_RESTRICTION_FLAGS = Object.freeze([
  {
    key: "restrictsParticles",
    label: "FXMASTER.Tile.RestrictsParticles",
    hint: "FXMASTER.Tile.RestrictsParticlesHint",
  },
  {
    key: "restrictsFilters",
    label: "FXMASTER.Tile.RestrictsFilters",
    hint: "FXMASTER.Tile.RestrictsFiltersHint",
  },
]);

const pendingTileRestrictionSaves = new Map();

/**
 * Normalize ApplicationV2/jQuery render hook HTML into an HTMLElement.
 * @param {HTMLElement|JQuery|object|null|undefined} html
 * @param {Application|null|undefined} app
 * @returns {HTMLElement|null}
 */
function getRenderRoot(html, app) {
  return html?.querySelector
    ? html
    : html?.[0]?.querySelector
    ? html[0]
    : app?.element?.querySelector
    ? app.element
    : app?.element?.[0]?.querySelector
    ? app.element[0]
    : null;
}

/**
 * Resolve the TileDocument behind a tile config application.
 * @param {Application|null|undefined} app
 * @returns {TileDocument|null}
 */
function getTileDocument(app) {
  return app?.document ?? app?.object?.document ?? app?.object ?? null;
}

/**
 * Return a stable key for a tile document.
 * @param {TileDocument|null|undefined} doc
 * @returns {string|null}
 */
function getTileDocumentKey(doc) {
  return (doc?.uuid ?? fxmDocumentId(doc)) || null;
}

/**
 * Read a boolean FXMaster tile restriction flag from the document/source.
 * @param {TileDocument|null|undefined} doc
 * @param {string} key
 * @returns {boolean}
 */
function getTileRestrictionFlag(doc, key) {
  const value = doc?.getFlag?.(packageId, key) ?? doc?.flags?.[packageId]?.[key];
  return value === true || value === "true" || value === 1 || value === "1";
}

/**
 * Read the injected tile restriction checkbox values from a rendered config.
 * @param {HTMLElement|null|undefined} root
 * @returns {Record<string, boolean>|null}
 */
function readTileRestrictionControlValues(root) {
  if (!root?.querySelector) return null;

  const values = {};
  let foundAny = false;
  for (const cfg of TILE_RESTRICTION_FLAGS) {
    const input = root.querySelector(`input[type="checkbox"][data-fxm-tile-restriction="${cfg.key}"]`);
    if (!input) continue;
    values[cfg.key] = Boolean(input.checked);
    foundAny = true;
  }

  return foundAny ? values : null;
}

/**
 * Set a deep property path without depending on Foundry utils being available in static tooling.
 * @param {object} target
 * @param {string} path
 * @param {unknown} value
 * @returns {void}
 */
function setProperty(target, path, value) {
  if (globalThis.foundry?.utils?.setProperty) {
    globalThis.foundry.utils.setProperty(target, path, value);
    return;
  }

  const parts = String(path).split(".");
  let object = target;
  while (parts.length > 1) {
    const part = parts.shift();
    object[part] ??= {};
    object = object[part];
  }
  object[parts[0]] = value;
}

/**
 * Build a TileDocument update payload for the FXMaster restriction flags.
 * @param {Record<string, boolean>|null|undefined} values
 * @returns {Record<string, boolean>}
 */
function buildTileRestrictionUpdate(values) {
  const update = {};
  if (!values) return update;

  for (const cfg of TILE_RESTRICTION_FLAGS) {
    if (!(cfg.key in values)) continue;
    update[`flags.${packageId}.${cfg.key}`] = Boolean(values[cfg.key]);
  }

  return update;
}

/**
 * Return whether the document already reflects the requested values.
 * @param {TileDocument|null|undefined} doc
 * @param {Record<string, boolean>|null|undefined} values
 * @returns {boolean}
 */
function tileRestrictionValuesMatch(doc, values) {
  if (!doc || !values) return true;
  return TILE_RESTRICTION_FLAGS.every(
    (cfg) => !(cfg.key in values) || getTileRestrictionFlag(doc, cfg.key) === Boolean(values[cfg.key]),
  );
}

/**
 * Apply pending values directly to the TileDocument. This is a safety net for Foundry TileConfig implementations that ignore injected flag inputs when no core tile fields changed.
 * @param {string} key
 * @returns {Promise<void>}
 */
async function applyPendingTileRestrictionSave(key) {
  const pending = pendingTileRestrictionSaves.get(key);
  if (!pending) return;

  const { doc, values } = pending;
  if (!doc?.update || tileRestrictionValuesMatch(doc, values)) {
    pendingTileRestrictionSaves.delete(key);
    return;
  }

  try {
    await doc.update(buildTileRestrictionUpdate(values), { fxmasterTileRestrictionSave: true });
  } catch (err) {
    logger.warn("FXMaster | Failed saving tile restriction flags", err);
  } finally {
    if (pendingTileRestrictionSaves.get(key) === pending) pendingTileRestrictionSaves.delete(key);
  }
}

/**
 * Queue FXMaster restriction flag values captured from an explicit TileConfig save action. The values are inserted into Foundry's native tile update when possible, and written as a direct fallback when the native update does not include them.
 * @param {TileDocument|null|undefined} doc
 * @param {Record<string, boolean>|null|undefined} values
 * @returns {void}
 */
function queueTileRestrictionSave(doc, values) {
  const key = getTileDocumentKey(doc);
  if (!key || !values) return;

  const pending = { doc, values };
  pendingTileRestrictionSaves.set(key, pending);

  setTimeout(() => {
    if (pendingTileRestrictionSaves.get(key) === pending) void applyPendingTileRestrictionSave(key);
  }, 500);
}

/**
 * Queue the current rendered checkbox state for persistence.
 * @param {Application|null|undefined} app
 * @param {HTMLElement|null|undefined} root
 * @returns {void}
 */
function queueRenderedTileRestrictionSave(app, root) {
  const doc = getTileDocument(app);
  const values = readTileRestrictionControlValues(root);
  queueTileRestrictionSave(doc, values);
}

/**
 * Return whether a clicked control represents a save/submit action.
 * @param {EventTarget|null} target
 * @returns {boolean}
 */
function isSaveControl(target) {
  const control = target?.closest?.("button, input, a");
  if (!control) return false;

  const type = String(control.getAttribute?.("type") ?? "").toLowerCase();
  if (type === "submit") return true;

  const action = String(control.dataset?.action ?? control.dataset?.button ?? "").toLowerCase();
  return action === "save" || action === "submit" || action === "update";
}

/**
 * Attach save listeners to the TileConfig form/root once.
 * @param {Application|null|undefined} app
 * @param {HTMLElement} controlRoot
 * @param {HTMLFormElement|null} form
 * @param {HTMLElement|null|undefined} [listenerRoot=controlRoot]
 * @returns {void}
 */
function attachTileRestrictionSaveListeners(app, controlRoot, form, listenerRoot = controlRoot) {
  if (form && !form.dataset.fxmTileRestrictionsSubmitSync) {
    form.dataset.fxmTileRestrictionsSubmitSync = "1";
    form.addEventListener(
      "submit",
      () => {
        queueRenderedTileRestrictionSave(app, controlRoot);
      },
      { capture: true },
    );
  }

  if (listenerRoot?.dataset && !listenerRoot.dataset.fxmTileRestrictionsClickSync) {
    listenerRoot.dataset.fxmTileRestrictionsClickSync = "1";
    listenerRoot.addEventListener(
      "click",
      (event) => {
        if (isSaveControl(event.target)) queueRenderedTileRestrictionSave(app, controlRoot);
      },
      { capture: true },
    );
  }
}

/**
 * Build one Foundry-styled checkbox row.
 * @param {TileDocument|null} doc
 * @param {{key:string,label:string,hint:string}} cfg
 * @returns {HTMLElement}
 */
function buildRestrictionRow(doc, cfg) {
  const row = document.createElement("div");
  row.className = "form-group fxmaster-tile-restriction-row";

  const checked = getTileRestrictionFlag(doc, cfg.key) ? "checked" : "";
  const name = `flags.${packageId}.${cfg.key}`;

  row.innerHTML = `
    <label>${game.i18n.localize(cfg.label)}</label>
    <div class="form-fields">
      <input type="checkbox" name="${name}" value="true" data-dtype="Boolean" data-fxm-tile-restriction="${
    cfg.key
  }" ${checked}>
    </div>
    <p class="hint">${game.i18n.localize(cfg.hint)}</p>
  `;

  return row;
}

/**
 * Inject FXMaster tile restriction checkboxes below Foundry's Restricts Weather row.
 * @param {Application|null|undefined} app
 * @param {HTMLElement|JQuery|object|null|undefined} html
 * @returns {void}
 */
function injectTileRestrictionControls(app, html) {
  const root = getRenderRoot(html, app);
  if (!root?.querySelector) return;
  if (root.querySelector(".fxmaster-tile-restriction-controls")) return;

  const weatherInput =
    root.querySelector('input[name="restrictions.weather"]') ??
    root.querySelector('input[name$=".restrictions.weather"]') ??
    root.querySelector('input[name="occlusion.restrictions.weather"]');
  if (!weatherInput) return;

  const anchor = weatherInput.closest(".form-group") ?? weatherInput.closest("label") ?? weatherInput;
  if (!anchor?.insertAdjacentElement) return;

  const doc = getTileDocument(app);
  const wrapper = document.createElement("div");
  wrapper.className = "fxmaster-tile-restriction-controls";
  wrapper.dataset.tooltipDirection = game.settings?.get?.(packageId, "tooltipDirection") ?? "UP";

  for (const cfg of TILE_RESTRICTION_FLAGS) wrapper.appendChild(buildRestrictionRow(doc, cfg));
  anchor.insertAdjacentElement("afterend", wrapper);

  const form = anchor.closest?.("form") ?? root.closest?.("form") ?? root.querySelector?.("form");
  attachTileRestrictionSaveListeners(app, root, form);

  const appRoot = getRenderRoot(null, app);
  if (appRoot && appRoot !== root) attachTileRestrictionSaveListeners(app, root, form, appRoot);
}

/**
 * Register tile configuration hooks.
 * @returns {void}
 */
export function registerTileConfigHooks() {
  const onRender = (app, html) => {
    try {
      injectTileRestrictionControls(app, html);
      requestAnimationFrame(() => injectTileRestrictionControls(app, html));
    } catch (err) {
      logger.debug("FXMaster:", err);
    }
  };

  Hooks.on("renderTileConfig", onRender);
  Hooks.on("renderTileConfigV2", onRender);

  Hooks.on("preUpdateTile", (doc, changes, _options, userId) => {
    if (userId && game.user?.id && userId !== game.user.id) return;

    const key = getTileDocumentKey(doc);
    const pending = key ? pendingTileRestrictionSaves.get(key) : null;
    if (!pending) return;

    for (const [flagKey, value] of Object.entries(pending.values)) {
      setProperty(changes, `flags.${packageId}.${flagKey}`, Boolean(value));
    }
  });

  Hooks.on("updateTile", (doc, _changes, options, userId) => {
    if (userId && game.user?.id && userId !== game.user.id) return;
    if (options?.fxmasterTileRestrictionSave) return;

    const key = getTileDocumentKey(doc);
    const pending = key ? pendingTileRestrictionSaves.get(key) : null;
    if (!pending) return;

    if (tileRestrictionValuesMatch(doc, pending.values)) {
      pendingTileRestrictionSaves.delete(key);
      return;
    }

    setTimeout(() => void applyPendingTileRestrictionSave(key), 0);
  });
}
