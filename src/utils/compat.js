/**
 * FXMaster: Version Compatibility Helpers
 *
 * Centralises Foundry version differences around flag update operators.
 * V12/V13 use legacy "-=key" / "==key" update syntax, while V14+ prefers explicit DataFieldOperator instances.
 */

import { packageId } from "../constants.js";

/**
 * Check whether a key name is one of Foundry's legacy special keys.
 * @param {string} key
 * @returns {boolean}
 */
export function isLegacyOperatorKey(key) {
  return typeof key === "string" && (key.startsWith("-=") || key.startsWith("=="));
}

/**
 * Module-scoped cache for the V14+ ForcedDeletion operator singleton.
 * @type {foundry.data.operators.ForcedDeletion|null|undefined}
 */
let _cachedForcedDeletion;

/**
 * Get a V14+ ForcedDeletion operator instance.
 *
 * Preserves the legacy `globalThis._del`, then falls back to Foundry's operator APIs when available.
 *
 * @returns {foundry.data.operators.ForcedDeletion|null}
 */
export function getForcedDeletionOperator() {
  const ForcedDeletion = foundry?.data?.operators?.ForcedDeletion;
  if (!ForcedDeletion) return null;

  const del = globalThis?._del;
  if (del) return del;

  if (_cachedForcedDeletion !== undefined) return _cachedForcedDeletion;

  if (typeof ForcedDeletion.create === "function") {
    _cachedForcedDeletion = ForcedDeletion.create();
    return _cachedForcedDeletion;
  }
  try {
    _cachedForcedDeletion = new ForcedDeletion();
    return _cachedForcedDeletion;
  } catch {
    _cachedForcedDeletion = null;
    return null;
  }
}

/**
 * Module-scoped reference to the V14+ ForcedReplacement factory.
 * @type {Function|null|undefined}
 */
let _cachedReplacementFactory;

/**
 * Get a V14+ ForcedReplacement operator for a replacement value.
 *
 * Preserves the legacy `globalThis._replace` shim, then falls back to Foundry's `ForcedReplacement.create` factory when available.
 *
 * @param {*} replacement
 * @returns {foundry.data.operators.ForcedReplacement|null}
 */
export function getForcedReplacementOperator(replacement) {
  const ForcedReplacement = foundry?.data?.operators?.ForcedReplacement;
  if (!ForcedReplacement) return null;

  const rep = globalThis?._replace;
  if (typeof rep === "function") {
    try {
      return rep(replacement);
    } catch {
      /* fall through */
    }
  }

  if (_cachedReplacementFactory === undefined) {
    if (typeof ForcedReplacement.create === "function") {
      _cachedReplacementFactory = ForcedReplacement.create.bind(ForcedReplacement);
    } else {
      _cachedReplacementFactory = null;
    }
  }

  if (typeof _cachedReplacementFactory === "function") {
    try {
      return _cachedReplacementFactory(replacement);
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Add a "delete this key" operator to an update object in a way which is compatible with both legacy (V12/V13) and newer (V14+) Foundry.
 *
 * @param {object} update - The update object to mutate.
 * @param {string} key - The key to delete.
 * @returns {object} The same update object.
 */
export function addDeletionKey(update, key) {
  const op = getForcedDeletionOperator();
  if (op) update[key] = op;
  else update[`-=${key}`] = null;
  return update;
}

/**
 * Add a "replace this key" operator to an update object in a way which is compatible with both legacy (V12/V13) and newer (V14+) Foundry.
 *
 * @param {object} update - The update object to mutate.
 * @param {string} key - The key to replace.
 * @param {*} replacement - The replacement value.
 * @returns {object} The same update object.
 */
export function addReplacementKey(update, key, replacement) {
  const op = getForcedReplacementOperator(replacement);
  if (op) update[key] = op;
  else update[`==${key}`] = replacement;
  return update;
}

/**
 * Create an update object which replaces a specific key.
 * @param {string} key
 * @param {*} replacement
 * @returns {object}
 */
export function replacementUpdate(key, replacement) {
  return addReplacementKey({}, key, replacement);
}

/**
 * Create an update object which deletes a specific key.
 * @param {string} key
 * @returns {object}
 */
export function deletionUpdate(key) {
  return addDeletionKey({}, key);
}

/**
 * Reset a namespaced flag on a document, removing stale keys not present in the next value before calling `setFlag`.
 *
 * @param {foundry.abstract.Document} document
 * @param {string} key
 * @param {*} value
 * @returns {Promise<foundry.abstract.Document>}
 */
export async function resetFlag(document, key, value) {
  if (typeof value === "object" && !Array.isArray(value) && value !== null) {
    const oldFlags = document.getFlag(packageId, key);
    const keys = oldFlags ? Object.keys(oldFlags) : [];
    for (const k of keys) {
      if (isLegacyOperatorKey(k)) continue;
      if (Object.prototype.hasOwnProperty.call(value, k)) continue;
      addDeletionKey(value, k);
    }
  }
  return document.setFlag(packageId, key, value);
}
