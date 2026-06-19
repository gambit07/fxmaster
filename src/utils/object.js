/**
 * FXMaster: Object and collection utilities.
 */

/**
 * Return whether a value is a non-array plain object-like value.
 *
 * @param {*} value - Value to test.
 * @returns {boolean}
 */
export function isPlainObject(value) {
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
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (Array.isArray(collection.contents)) return collection.contents;
  if (typeof collection.toArray === "function") return collection.toArray();
  if (typeof collection.values === "function") return Array.from(collection.values());
  if (typeof collection[Symbol.iterator] === "function") return Array.from(collection);
  return [];
}
