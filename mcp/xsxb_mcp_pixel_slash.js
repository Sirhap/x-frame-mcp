"use strict";

const { decodePngRgba, encodePngRgba, subjectAnchor } = require("./xsxb_mcp_cutout");

// Original sprite silhouettes on a 64 × 40 grid. The second contour is the lit facet.
// Coordinates go left to right in screen space. Transparent space inside the spin keeps the actor visible.
const shapes = {
  pixel_cross: {
    width: 2.08,
    height: 0.48,
    aboveFeet: 0.94,
    left: 0.7,
    body: [
      [1, 29],
      [16, 25],
      [29, 21],
      [43, 12],
      [34, 12],
      [45, 7],
      [63, 5],
      [57, 14],
      [49, 23],
      [37, 31],
      [18, 33],
      [27, 29],
    ],
    light: [
      [17, 30],
      [32, 26],
      [46, 17],
      [54, 11],
      [61, 7],
      [55, 16],
      [45, 25],
      [34, 30],
    ],
  },
  pixel_overhead: {
    width: 1.89,
    height: 0.68,
    aboveFeet: 1.24,
    left: 0.72,
    body: [
      [0, 5],
      [11, 2],
      [25, 1],
      [36, 3],
      [45, 8],
      [53, 16],
      [59, 25],
      [63, 38],
      [54, 29],
      [45, 22],
      [36, 18],
      [42, 25],
      [30, 18],
      [18, 13],
      [24, 13],
      [11, 8],
    ],
    light: [
      [15, 5],
      [28, 3],
      [38, 6],
      [47, 12],
      [55, 20],
      [61, 33],
      [53, 24],
      [42, 16],
      [30, 10],
    ],
  },
  pixel_spin: {
    width: 2.04,
    height: 1.35,
    aboveFeet: 1.28,
    left: 0.96,
    body: [
      [20, 0],
      [18, 6],
      [16, 14],
      [17, 20],
      [20, 25],
      [25, 28],
      [32, 30],
      [39, 30],
      [45, 27],
      [49, 23],
      [50, 18],
      [48, 14],
      [43, 10],
      [39, 8],
      [47, 9],
      [55, 13],
      [60, 18],
      [63, 23],
      [62, 28],
      [57, 33],
      [49, 37],
      [40, 39],
      [28, 39],
      [19, 37],
      [11, 33],
      [5, 28],
      [2, 22],
      [1, 15],
      [4, 9],
      [10, 4],
    ],
    light: [
      [8, 19],
      [13, 25],
      [20, 30],
      [29, 33],
      [38, 33],
      [46, 30],
      [51, 26],
      [53, 21],
      [51, 16],
      [46, 12],
      [41, 9],
      [49, 11],
      [57, 16],
      [62, 22],
      [61, 28],
      [56, 32],
      [47, 36],
      [36, 38],
      [27, 37],
      [18, 34],
      [12, 29],
    ],
  },
};
const PIXEL_PRESETS = Object.keys(shapes);

function inside(x, y, contour) {
  let filled = false;
  for (let i = 0, j = contour.length - 1; i < contour.length; j = i++) {
    const [ax, ay] = contour[i],
      [bx, by] = contour[j];
    if (ay > y !== by > y && x < ax + ((bx - ax) * (y - ay)) / (by - ay)) filled = !filled;
  }
  return filled;
}

/** Rasterize the two flat colors. U=0 is the moving head, so mirror the art in texture space. */
function pixelSlashBrush(preset, color) {
  if (!/^#[a-f0-9]{6}$/i.test(color)) throw new Error("Pixel slash color must be #RRGGBB.");
  const shape = shapes[preset];
  const base = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const highlight = base.map((v) => Math.round(v + (255 - v) * 0.36));
  const width = 64,
    height = 40;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < 40; y++)
    for (let x = 0; x < 64; x++) {
      if (!inside(x + 0.5, y + 0.5, shape.body)) continue;
      const ink = [...(inside(x + 0.5, y + 0.5, shape.light) ? highlight : base), 255];
      rgba.set(ink, 4 * (y * width + (width - 1 - x)));
    }
  return encodePngRgba(rgba, width, height);
}

/** Fit a straight two-stick mesh around the strike pose. The texture supplies the cutout and both tips. */
function pixelSlashSticks({ preset, file, start, end, facing }) {
  const img = decodePngRgba(file);
  const body = subjectAnchor(img.data, img.width, img.height);
  if (!body) throw new Error(`Pixel slash needs a visible actor on end_frame ${end}.`);
  const shape = shapes[preset];
  const side = facing === "left" ? -1 : 1;
  const startRoom = side > 0 ? body.centerX : img.width - body.centerX;
  const size = Math.min(
    body.height,
    startRoom / shape.left,
    (img.width - startRoom) / (shape.width - shape.left),
    body.feetY / shape.aboveFeet,
  );
  if (size * shape.height < 2) throw new Error("Too little room for the pixel slash. Add canvas padding.");
  const top = Math.max(
    -img.height,
    Math.min(-shape.height * size, body.feetY - img.height - shape.aboveFeet * size),
  );
  const startX = body.centerX - img.width / 2 - side * shape.left * size;
  return [start, end].map((frame, i) => {
    const x = startX + i * side * size * shape.width;
    return {
      frame,
      top: { x, y: top },
      bottom: { x, y: top + shape.height * size },
      directionOffset: side > 0 ? 180 : 0,
      tangentStrength: 1,
      layer: "front",
      phaseMode: "manual",
      framePhase: 0,
    };
  });
}
module.exports = { PIXEL_PRESETS, pixelSlashBrush, pixelSlashSticks };
