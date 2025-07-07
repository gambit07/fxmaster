import { packageId } from "../constants.js";

export function registerDrawingsMaskFunctionality() {
  Hooks.on("canvasReady", () => {
    Hooks.once(`${packageId}.drawingsReady`, drawDrawingsMask);
  });

  Hooks.on("refreshDrawing", () => {
    if (canvas.drawings.placeables.every((drawing) => drawing.shape.geometry.graphicsData.length > 0)) {
      Hooks.call(`${packageId}.drawingsReady`);
    }
  });

  for (const hook of ["updateDrawing", "createDrawing", "deleteDrawing"]) {
    Hooks.on(hook, (drawing) => {
      drawDrawingsMaskIfCurrentScene(drawing.parent);
    });
  }

  Hooks.on("updateScene", (scene, data) => {
    if (
      foundry.utils.hasProperty(data, "flags.fxmaster.invert") ||
      foundry.utils.hasProperty(data, "flags.fxmaster.-=invert")
    ) {
      drawDrawingsMaskIfCurrentScene(scene);
    }
  });
}

export function drawDrawingsMaskIfCurrentScene(scene) {
  if (scene === canvas.scene) {
    drawDrawingsMask();
  }
}

function drawDrawingsMask() {
  const msk = canvas.masks.depth;
  if (msk.fxmasterDrawingsMask) {
    msk.removeChild(msk.fxmasterDrawingsMask);
    delete msk.fxmasterDrawingsMask;
  }

  // Only apply a mask if we have flagged drawings or suppressWeather regions
  const maskedDrawings = canvas.drawings.placeables.filter((d) => d.document.getFlag(packageId, "masking"));
  const maskedRegions =
    canvas.regions?.placeables.filter((region) =>
      region.document.behaviors?.some((b) => b.type === "suppressWeather" && !b.disabled),
    ) ?? [];

  if (maskedDrawings.length === 0 && maskedRegions.length === 0) {
    msk.mask = null;
    return;
  }

  const invert = canvas.scene.getFlag(packageId, "invert");
  const mask = invert ? createInvertedMask(maskedDrawings, maskedRegions) : createMask(maskedDrawings, maskedRegions);

  mask.mask = new PIXI.MaskData();
  mask.mask.colorMask = PIXI.COLOR_MASK_BITS.BLUE;
  msk.fxmasterDrawingsMask = msk.addChild(mask);
}

function createMask(maskedDrawings, maskedRegions) {
  const mask = new PIXI.LegacyGraphics();
  maskedDrawings.forEach((drawing) => {
    mask.beginFill(0x0000ff);
    drawShapeToMask(mask, drawing);
    mask.endFill();
  });

  maskedRegions.forEach((region) => {
    mask.beginFill(0x0000ff);
    drawRegionShapeToMask(mask, region);
    mask.endFill();
  });

  return mask;
}

function createInvertedMask(maskedDrawings, maskedRegions) {
  const mask = new PIXI.LegacyGraphics();
  mask.beginFill(0x0000ff).drawShape(canvas.dimensions.rect).endFill();

  maskedDrawings.forEach((drawing) => {
    mask.beginHole();
    drawShapeToMask(mask, drawing);
    mask.endHole();
  });

  maskedRegions.forEach((region) => {
    mask.beginHole();
    drawRegionShapeToMask(mask, region);
    mask.endHole();
  });

  return mask;
}

/**
 * Draw a shape to a mask.
 * @param {PIXI.Graphics} mask    The mask to draw to
 * @param {Drawing}       drawing The drawing of which to draw the shape
 */
function drawShapeToMask(mask, drawing) {
  const shape = drawing.shape.geometry.graphicsData[0].shape.clone();
  switch (drawing.type) {
    case CONFIG.fxmaster.DrawingNS.SHAPE_TYPES.ELLIPSE: {
      shape.x = drawing.center.x;
      shape.y = drawing.center.y;
      mask.drawShape(shape);
      break;
    }
    case CONFIG.fxmaster.DrawingNS.SHAPE_TYPES.POLYGON: {
      const points = drawing.document.shape.points.map((p, i) =>
        i % 2 === 0 ? p + drawing.bounds.x : p + drawing.bounds.y,
      );
      mask.drawPolygon(points);
      break;
    }
    default: {
      const s = drawing.document.shape;
      shape.x = drawing.center.x - s.width / 2;
      shape.y = drawing.center.y - s.height / 2;
      mask.drawShape(shape);
    }
  }
}

function drawRegionShapeToMask(mask, region) {
  for (const s of region.document.shapes) {
    switch (s.type) {
      case "polygon": {
        const pts = s.points.map((p, i) => (i % 2 === 0 ? p + s.x : p + s.y));
        mask.drawPolygon(pts);
        break;
      }
      case "ellipse": {
        mask.drawCircle(s.x, s.y, s.distance);
        break;
      }
      case "rectangle": {
        mask.drawRect(s.x, s.y, s.width, s.height);
        break;
      }
      default: {
        const pts = s.points.map((p, i) => (i % 2 === 0 ? p + s.x : p + s.y));
        mask.drawPolygon(pts);
        break;
      }
    }
  }
}
