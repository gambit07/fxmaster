/**
 * Encode freshly read affine components without discarding precision. Numeric matrices avoid temporary arrays and redundant coercion.
 * @param {PIXI.Matrix|object|null|undefined} matrix
 * @returns {string}
 */
export function matrixCacheKey(matrix) {
  if (!matrix) return "";
  const a = matrix.a;
  const b = matrix.b;
  const c = matrix.c;
  const d = matrix.d;
  const tx = matrix.tx;
  const ty = matrix.ty;
  if (
    typeof a === "number" &&
    typeof b === "number" &&
    typeof c === "number" &&
    typeof d === "number" &&
    typeof tx === "number" &&
    typeof ty === "number"
  ) {
    return `${Number.isFinite(a) ? a : "NaN"},${Number.isFinite(b) ? b : "NaN"},${Number.isFinite(c) ? c : "NaN"},${
      Number.isFinite(d) ? d : "NaN"
    },${Number.isFinite(tx) ? tx : "NaN"},${Number.isFinite(ty) ? ty : "NaN"}`;
  }
  return [a, b, c, d, tx, ty]
    .map((value) => (Number.isFinite(Number(value)) ? String(Number(value)) : "NaN"))
    .join(",");
}

/**
 * Encode local transforms beneath a root without including camera movement.
 * @param {PIXI.DisplayObject|null|undefined} object
 * @param {PIXI.DisplayObject|null|undefined} root
 * @returns {string}
 */
export function localTransformChainKey(object, root) {
  const parts = [];
  for (let current = object; current && current !== root; current = current.parent) {
    const transform = current.transform;
    transform?.updateLocalTransform?.();
    parts.push(matrixCacheKey(transform?.localTransform ?? current.localTransform));
  }
  return parts.join("/");
}

/**
 * Encode texture pixels and atlas placement used by a cached alpha mask.
 * @param {PIXI.Texture|null|undefined} texture
 * @returns {string}
 */
export function textureContentKey(texture) {
  if (!texture) return "";
  const base = texture.baseTexture;
  const parts = [
    base?.uid ?? base?.cacheId ?? base?.resource?.url ?? "",
    base?.dirtyId ?? 0,
    base?.valid === false ? 0 : 1,
    texture.valid === false ? 0 : 1,
    texture.rotate ?? 0,
  ];
  for (const rect of [texture.frame, texture.orig, texture.trim]) {
    parts.push(rect ? `${rect.x},${rect.y},${rect.width},${rect.height}` : "");
  }
  return parts.join(":");
}
