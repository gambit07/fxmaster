/**
 * FXMaster: Object and collection utilities.
 */

import { fxmCollectionValues } from "./foundry-public.js";

/**
 * Return whether a value is a non-array plain object-like value.
 *
 * @param {*} value - Value to test.
 * @returns {boolean}
 */
export function isPlainObject(value) {
  const foundryImplementation = globalThis.foundry?.utils?.isPlainObject;
  if (typeof foundryImplementation === "function" && foundryImplementation(value)) return true;
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Return whether an object owns a property key.
 *
 * @param {*} value - Object-like value.
 * @param {string|number|symbol} key - Property key.
 * @returns {boolean}
 */
export function hasOwn(value, key) {
  if (typeof Object.hasOwn === "function") return Object.hasOwn(value ?? {}, key);
  return Object.prototype.hasOwnProperty.call(value ?? {}, key);
}

/**
 * Normalize Foundry collections, arrays, and iterables into a plain array.
 *
 * @template T
 * @param {Iterable<T>|{contents?: T[], toArray?: Function, values?: Function}|T[]|null|undefined} collection - Collection-like value.
 * @returns {T[]}
 */
export function collectionValues(collection) {
  return fxmCollectionValues(collection);
}
