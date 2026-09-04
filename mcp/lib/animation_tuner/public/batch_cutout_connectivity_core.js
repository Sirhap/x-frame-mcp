(function attachBatchCutoutConnectivityCore(root, factory) {
  const colorCore =
    typeof module === "object" && module.exports
      ? require("./batch_cutout_color_core")
      : root?.BatchCutoutColorCore;
  const api = factory(colorCore);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BatchCutoutConnectivityCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (colorCore) => {
  "use strict";

  if (typeof colorCore?.colorDistance !== "function") {
    throw new Error("BatchCutoutColorCore is required.");
  }

  const { colorDistance } = colorCore;

  /**
   * Produces an edge-connected removal mask using an iterative flood fill.
   * @param {Uint8ClampedArray|Uint8Array} data RGBA pixel data.
   * @param {number} width Image width.
   * @param {number} height Image height.
   * @param {{r:number,g:number,b:number}} backgroundColor Background color.
   * @param {number} maximumDistance Maximum accepted normalized color distance.
   * @returns {Uint8Array}
   */
  function connectedRemovalMask(data, width, height, backgroundColor, maximumDistance) {
    const pixelCount = width * height;
    const visited = new Uint8Array(pixelCount);
    const queue = new Int32Array(pixelCount);
    let head = 0;
    let tail = 0;

    const enqueue = (index) => {
      if (index < 0 || index >= pixelCount || visited[index]) return;
      const offset = index * 4;
      if ((data[offset + 3] || 0) === 0) {
        visited[index] = 1;
        queue[tail] = index;
        tail += 1;
        return;
      }
      if (colorDistance(data[offset], data[offset + 1], data[offset + 2], backgroundColor) > maximumDistance)
        return;
      visited[index] = 1;
      queue[tail] = index;
      tail += 1;
    };

    for (let x = 0; x < width; x += 1) {
      enqueue(x);
      enqueue((height - 1) * width + x);
    }
    for (let y = 1; y < height - 1; y += 1) {
      enqueue(y * width);
      enqueue(y * width + width - 1);
    }

    while (head < tail) {
      const index = queue[head];
      head += 1;
      const x = index % width;
      const y = Math.floor(index / width);
      if (x > 0) enqueue(index - 1);
      if (x + 1 < width) enqueue(index + 1);
      if (y > 0) enqueue(index - width);
      if (y + 1 < height) enqueue(index + width);
    }
    return visited;
  }

  /**
   * Flood-fills a binary candidate mask with scanline spans.
   * @param {Uint8Array} candidates Non-zero pixels can be selected.
   * @param {number} width Image width.
   * @param {number} height Image height.
   * @param {{
   *   seeds?:Array<{x:number,y:number}>,
   *   selectionMask?:Uint8Array|null,
   *   maximumPixels?:number
   * }} options Fill constraints.
   * @returns {Uint8Array}
   */
  function connectedCandidateMask(candidates, width, height, options = {}) {
    const pixelCount = width * height;
    const selected = new Uint8Array(pixelCount);
    const selectionMask = options.selectionMask || null;
    const maximumPixels = Math.max(1, Math.min(pixelCount, Number(options.maximumPixels || pixelCount)));
    const stack = [];
    let selectedPixels = 0;
    const allowed = (index) =>
      index >= 0 &&
      index < pixelCount &&
      candidates[index] &&
      !selected[index] &&
      (!selectionMask || selectionMask[index]);
    const pushSeed = (x, y) => {
      const safeX = Math.round(x);
      const safeY = Math.round(y);
      if (safeX < 0 || safeY < 0 || safeX >= width || safeY >= height) return;
      const index = safeY * width + safeX;
      if (allowed(index)) stack.push(index);
    };
    const seeds = Array.isArray(options.seeds) && options.seeds.length ? options.seeds : null;
    if (seeds) {
      seeds.forEach((seed) => pushSeed(seed.x, seed.y));
    } else {
      for (let x = 0; x < width; x += 1) {
        pushSeed(x, 0);
        pushSeed(x, height - 1);
      }
      for (let y = 1; y < height - 1; y += 1) {
        pushSeed(0, y);
        pushSeed(width - 1, y);
      }
    }

    while (stack.length && selectedPixels < maximumPixels) {
      const seedIndex = stack.pop();
      if (!allowed(seedIndex)) continue;
      const seedY = Math.floor(seedIndex / width);
      let left = seedIndex % width;
      let right = left;
      while (left > 0 && allowed(seedY * width + left - 1)) left -= 1;
      while (right + 1 < width && allowed(seedY * width + right + 1)) right += 1;
      for (let x = left; x <= right && selectedPixels < maximumPixels; x += 1) {
        const index = seedY * width + x;
        if (!allowed(index)) continue;
        selected[index] = 1;
        selectedPixels += 1;
        if (seedY > 0 && allowed(index - width)) stack.push(index - width);
        if (seedY + 1 < height && allowed(index + width)) stack.push(index + width);
      }
    }
    return selected;
  }

  /**
   * Computes a 3-4 chamfer distance to transparent pixels.
   * @param {Uint8ClampedArray|Uint8Array} data RGBA pixels or an alpha plane.
   * @param {number} width Image width.
   * @param {number} height Image height.
   * @param {boolean} [rgba=true] Whether data contains RGBA pixels.
   * @returns {Uint16Array}
   */
  function chamferDistanceToTransparent(data, width, height, rgba = true) {
    const pixelCount = width * height;
    const distance = new Uint16Array(pixelCount);
    const infinity = 0x3fff;
    for (let index = 0; index < pixelCount; index += 1) {
      const alpha = rgba ? data[index * 4 + 3] : data[index];
      distance[index] = alpha === 0 ? 0 : infinity;
    }
    const update = (index, neighbor, cost) => {
      if (neighbor < 0 || neighbor >= pixelCount) return;
      distance[index] = Math.min(distance[index], distance[neighbor] + cost);
    };
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (x > 0) update(index, index - 1, 3);
        if (y > 0) update(index, index - width, 3);
        if (x > 0 && y > 0) update(index, index - width - 1, 4);
        if (x + 1 < width && y > 0) update(index, index - width + 1, 4);
      }
    }
    for (let y = height - 1; y >= 0; y -= 1) {
      for (let x = width - 1; x >= 0; x -= 1) {
        const index = y * width + x;
        if (x + 1 < width) update(index, index + 1, 3);
        if (y + 1 < height) update(index, index + width, 3);
        if (x + 1 < width && y + 1 < height) update(index, index + width + 1, 4);
        if (x > 0 && y + 1 < height) update(index, index + width - 1, 4);
      }
    }
    return distance;
  }

  /**
   * Executes the reference `fp_kernel_04` 3-4-5 chamfer transform on a binary seed mask.
   * Non-zero mask cells are zero-distance seeds; all other cells start at 32767.
   * @param {Uint8Array} mask Binary seed mask.
   * @param {number} width Mask width.
   * @param {number} height Mask height.
   * @returns {Int16Array}
   */
  function chamfer345Distance(mask, width, height) {
    const pixelCount = width * height;
    const distance = new Int16Array(pixelCount);
    if (!mask || mask.length !== pixelCount || width <= 0 || height <= 0) {
      distance.fill(0x7fff);
      return distance;
    }
    for (let index = 0; index < pixelCount; index += 1) {
      distance[index] = mask[index] ? 0 : 0x7fff;
    }
    const update = (index, neighbor, cost) => {
      if (neighbor < 0 || neighbor >= pixelCount) return;
      distance[index] = Math.min(distance[index], distance[neighbor] + cost);
    };
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (!distance[index]) continue;
        if (x > 0) update(index, index - 1, 3);
        if (y > 0) update(index, index - width, 3);
        if (x > 0 && y > 0) update(index, index - width - 1, 4);
        if (x + 1 < width && y > 0) update(index, index - width + 1, 4);
      }
    }
    for (let y = height - 1; y >= 0; y -= 1) {
      for (let x = width - 1; x >= 0; x -= 1) {
        const index = y * width + x;
        if (!distance[index]) continue;
        if (x + 1 < width) update(index, index + 1, 3);
        if (y + 1 < height) update(index, index + width, 3);
        if (x > 0 && y + 1 < height) update(index, index + width - 1, 4);
        if (x + 1 < width && y + 1 < height) update(index, index + width + 1, 4);
      }
    }
    return distance;
  }

  /**
   * Executes the reference `fp_kernel_03` connectivity proximity predicate.
   * @param {Uint8Array} mask Candidate mask.
   * @param {Int16Array} distance Reference chamfer distance plane.
   * @param {number} width Mask width.
   * @param {number} height Mask height.
   * @returns {boolean}
   */
  function isWithinConnectivityTolerance(mask, distance, width, height) {
    const pixelCount = width * height;
    if (!mask || !distance || mask.length !== pixelCount || distance.length !== pixelCount) return false;
    for (let index = 0; index < pixelCount; index += 1) {
      if (mask[index] && distance[index] < 10) return true;
    }
    return false;
  }

  return Object.freeze({
    chamfer345Distance,
    chamferDistanceToTransparent,
    connectedCandidateMask,
    connectedRemovalMask,
    isWithinConnectivityTolerance,
  });
});
