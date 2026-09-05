"use strict";
/**
 * Reduces all frames at one shared scale into a foot-aligned preview canvas.
 * Unlike fitting each subject separately, this retains relative size and drift.
 * @param {object[]} images RGBA images.
 * @param {number} size Preview cell size.
 * @returns {object[]} Complete subject previews with a common scale.
 */
function previewFrames(images, size = 256) {
  const scale = Math.min(1, size / Math.max(...images.flatMap((image) => [image.width, image.height])));
  return images.map((image) => {
    const width = Math.max(1, Math.round(image.width * scale)),
      height = Math.max(1, Math.round(image.height * scale)),
      data = new Uint8ClampedArray(size * size * 4),
      dx = Math.floor((size - width) / 2),
      dy = size - height;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const sx = Math.min(image.width - 1, Math.floor(x / scale)),
          sy = Math.min(image.height - 1, Math.floor(y / scale)),
          offset = (sy * image.width + sx) * 4;
        data.set(image.data.subarray(offset, offset + 4), ((y + dy) * size + x + dx) * 4);
      }
    return { data, width: size, height: size };
  });
}
module.exports = { previewFrames };
