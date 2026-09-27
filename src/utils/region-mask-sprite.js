/** Restrict sprite-mask captures to the occupied area of a region's base texture. */
export class RegionMaskSprite extends PIXI.Sprite {
  /** @type {PIXI.RenderTexture|null} */
  regionMaskTexture = null;

  /** @override */
  getBounds(skipUpdate, rect) {
    const full = super.getBounds(skipUpdate, rect);
    const base = this.regionMaskTexture;
    const bounds = base?.__fxmRegionMaskBounds;
    const texture = this.texture;
    const { a, b, c, d, tx, ty } = this.worldTransform;
    if (
      !bounds ||
      base.destroyed ||
      base.baseTexture?.destroyed ||
      base.resolution !== 1 ||
      texture.baseTexture.resolution !== 1 ||
      canvas?.app?.renderer?.resolution !== 1 ||
      Math.abs(a - 1) > 1e-6 ||
      Math.abs(d - 1) > 1e-6 ||
      Math.abs(b) > 1e-6 ||
      Math.abs(c) > 1e-6 ||
      texture.trim ||
      texture.rotate ||
      texture.frame.x !== 0 ||
      texture.frame.y !== 0 ||
      texture.width !== base.width ||
      texture.height !== base.height ||
      texture.orig.width !== base.width ||
      texture.orig.height !== base.height
    ) {
      return full;
    }

    const pad = 2 / (base.resolution || 1);
    const x0 = Math.max(0, bounds.x - pad) - this.anchor.x * base.width;
    const y0 = Math.max(0, bounds.y - pad) - this.anchor.y * base.height;
    const x1 = Math.min(base.width, bounds.x + bounds.width + pad) - this.anchor.x * base.width;
    const y1 = Math.min(base.height, bounds.y + bounds.height + pad) - this.anchor.y * base.height;
    const minX = Math.max(full.x, Math.min(a * x0, a * x1) + Math.min(c * y0, c * y1) + tx);
    const minY = Math.max(full.y, Math.min(b * x0, b * x1) + Math.min(d * y0, d * y1) + ty);
    const maxX = Math.min(full.right, Math.max(a * x0, a * x1) + Math.max(c * y0, c * y1) + tx);
    const maxY = Math.min(full.bottom, Math.max(b * x0, b * x1) + Math.max(d * y0, d * y1) + ty);
    if (![minX, minY, maxX, maxY].every(Number.isFinite)) return full;

    full.x = minX;
    full.y = minY;
    full.width = x1 > x0 && y1 > y0 ? Math.max(0, maxX - minX) : 0;
    full.height = x1 > x0 && y1 > y0 ? Math.max(0, maxY - minY) : 0;
    return full;
  }
}
