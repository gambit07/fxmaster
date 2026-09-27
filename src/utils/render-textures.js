/** Return the physical and logical dimensions used by a render texture. */
export function renderTextureSize(width, height, resolution = 1) {
  const value = Number(resolution);
  const scale = Number.isFinite(value) && value > 0 ? value : 1;
  const pixels = (size) => Math.max(1, Math.round(Math.max(1, Number(size) || 1) * scale));
  const pixelWidth = pixels(width);
  const pixelHeight = pixels(height);
  return { width: pixelWidth / scale, height: pixelHeight / scale, resolution: scale, pixelWidth, pixelHeight };
}

/** Return whether a render texture still owns usable dimensions and backing storage. */
export function renderTextureIsUsable(texture) {
  return !!(texture && !texture.destroyed && texture.orig && texture.baseTexture && !texture.baseTexture.destroyed);
}

/** Test a render texture against the rounded dimensions of its allocation request. */
export function renderTextureMatches(texture, width, height, resolution = 1) {
  if (!renderTextureIsUsable(texture)) return false;
  const size = renderTextureSize(width, height, resolution);
  return (
    texture.width === size.width && texture.height === size.height && (texture.resolution ?? 1) === size.resolution
  );
}
