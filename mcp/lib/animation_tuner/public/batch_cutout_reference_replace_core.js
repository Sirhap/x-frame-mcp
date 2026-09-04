(function attachBatchCutoutReferenceReplaceCore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BatchCutoutReferenceReplaceCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  /**
   * Creates the reference replacement kernels with their shared dependencies.
   * @param {{
   *   connectedCandidateMask: Function,
   *   applyReferenceReplacementPipeline: Function,
   * }} deps Kernel dependencies supplied by the compatibility facade.
   * @returns {{
   *   diffuseReferenceCandidateMask: Function,
   *   diffuseReferenceGlobalCandidateMask: Function,
   *   createReferenceColorCandidateMask: Function,
   *   applyReferenceColorReplace: Function,
   *   applyReferenceFloodFillDespill: Function,
   * }}
   */
  function createReferenceReplacementKernels(deps) {
    if (!deps || typeof deps !== "object") {
      throw new TypeError("Reference replacement kernel dependencies are required.");
    }
    if (typeof deps.connectedCandidateMask !== "function") {
      throw new TypeError("connectedCandidateMask dependency must be a function.");
    }
    if (typeof deps.applyReferenceReplacementPipeline !== "function") {
      throw new TypeError("applyReferenceReplacementPipeline dependency must be a function.");
    }

    const { connectedCandidateMask, applyReferenceReplacementPipeline } = deps;

    /**
     * Builds the squared RGBA radius used by `fp_kernel_06` and `fp_kernel_10`.
     * @param {number} tolerance Integer tolerance in the range normally exposed as 0-100.
     * @returns {number}
     */
    function referenceRgbaToleranceSquared(tolerance) {
      const radius = (Math.trunc(tolerance) / 100) * 2 * 255;
      return radius * radius;
    }

    /**
     * Tests an RGBA pixel against the reference kernel's Euclidean threshold.
     * @param {Uint8ClampedArray|Uint8Array} source RGBA source pixels.
     * @param {number} pixel Pixel index.
     * @param {{r:number,g:number,b:number,a?:number}} referenceColor Reference color.
     * @param {number} thresholdSquared Squared RGBA threshold.
     * @returns {boolean}
     */
    function referenceRgbaMatches(source, pixel, referenceColor, thresholdSquared) {
      const offset = pixel * 4;
      const referenceAlpha = referenceColor.a == null ? 255 : referenceColor.a & 255;
      const deltaRed = source[offset] - (referenceColor.r & 255);
      const deltaGreen = source[offset + 1] - (referenceColor.g & 255);
      const deltaBlue = source[offset + 2] - (referenceColor.b & 255);
      const deltaAlpha = source[offset + 3] - referenceAlpha;
      return (
        deltaRed * deltaRed + deltaGreen * deltaGreen + deltaBlue * deltaBlue + deltaAlpha * deltaAlpha <=
        thresholdSquared
      );
    }

    /**
     * Rebuilds `fp_kernel_06`: a four-neighbour scanline diffusion from one seed.
     * A maximum-pixel overflow rejects the whole candidate instead of truncating it.
     * @param {Uint8ClampedArray|Uint8Array} source RGBA source pixels.
     * @param {number} width Image width.
     * @param {number} height Image height.
     * @param {{x:number,y:number}} seed Rounded seed coordinate.
     * @param {{r:number,g:number,b:number,a?:number}} referenceColor Reference RGBA color.
     * @param {number} tolerance Integer tolerance.
     * @param {number} [maximumPixels=0] Zero disables the region-size cap.
     * @returns {Uint8Array|null}
     */
    function diffuseReferenceCandidateMask(
      source,
      width,
      height,
      seed,
      referenceColor,
      tolerance,
      maximumPixels = 0,
    ) {
      const pixelCount = width * height;
      if (width <= 0 || height <= 0 || !source || source.length !== pixelCount * 4) return null;
      const seedX = Math.round(seed?.x);
      const seedY = Math.round(seed?.y);
      if (seedX < 0 || seedX >= width || seedY < 0 || seedY >= height) return null;
      const thresholdSquared = referenceRgbaToleranceSquared(tolerance);
      const seedIndex = seedY * width + seedX;
      if (!referenceRgbaMatches(source, seedIndex, referenceColor, thresholdSquared)) return null;
      const selected = new Uint8Array(pixelCount);
      const visited = new Uint8Array(pixelCount);
      const stack = [seedIndex];
      visited[seedIndex] = 1;
      const limit =
        Number.isFinite(maximumPixels) && maximumPixels > 0
          ? Math.min(Math.trunc(maximumPixels), 0x7fffffff)
          : 0;
      let selectedPixels = 0;
      while (stack.length) {
        const current = stack.pop();
        const y = Math.floor(current / width);
        let left = current % width;
        let right = left;
        while (
          left > 0 &&
          !visited[y * width + left - 1] &&
          referenceRgbaMatches(source, y * width + left - 1, referenceColor, thresholdSquared)
        ) {
          left -= 1;
        }
        while (
          right + 1 < width &&
          !visited[y * width + right + 1] &&
          referenceRgbaMatches(source, y * width + right + 1, referenceColor, thresholdSquared)
        ) {
          right += 1;
        }
        for (let x = left; x <= right; x += 1) {
          const index = y * width + x;
          if (!visited[index]) visited[index] = 1;
          if (!referenceRgbaMatches(source, index, referenceColor, thresholdSquared)) continue;
          if (!selected[index]) {
            selected[index] = 255;
            selectedPixels += 1;
            if (limit > 0 && selectedPixels > limit) return null;
          }
          if (y > 0) {
            const above = index - width;
            if (!visited[above] && referenceRgbaMatches(source, above, referenceColor, thresholdSquared)) {
              visited[above] = 1;
              stack.push(above);
            }
          }
          if (y + 1 < height) {
            const below = index + width;
            if (!visited[below] && referenceRgbaMatches(source, below, referenceColor, thresholdSquared)) {
              visited[below] = 1;
              stack.push(below);
            }
          }
        }
      }
      return selectedPixels > 0 ? selected : null;
    }

    /**
     * Rebuilds `fp_kernel_10`: selects every RGBA pixel inside the reference radius.
     * @param {Uint8ClampedArray|Uint8Array} source RGBA source pixels.
     * @param {number} width Image width.
     * @param {number} height Image height.
     * @param {{r:number,g:number,b:number,a?:number}} referenceColor Reference RGBA color.
     * @param {number} tolerance Integer tolerance.
     * @returns {Uint8Array|null}
     */
    function diffuseReferenceGlobalCandidateMask(source, width, height, referenceColor, tolerance) {
      const pixelCount = width * height;
      if (width <= 0 || height <= 0 || !source || source.length !== pixelCount * 4) return null;
      const thresholdSquared = referenceRgbaToleranceSquared(tolerance);
      const selected = new Uint8Array(pixelCount);
      let selectedPixels = 0;
      for (let pixel = 0; pixel < pixelCount; pixel += 1) {
        if (!referenceRgbaMatches(source, pixel, referenceColor, thresholdSquared)) continue;
        selected[pixel] = 255;
        selectedPixels += 1;
      }
      return selectedPixels > 0 ? selected : null;
    }

    /**
     * Expands trusted base-tolerance pixels through four-neighbour candidates.
     * FramePacker treats edge enhancement as a spatial expansion: a wider color
     * match is accepted only when it remains connected to a base-tolerance pixel.
     * @param {Uint8ClampedArray|Uint8Array} source RGBA source pixels.
     * @param {number} width Image width.
     * @param {number} height Image height.
     * @param {{r:number,g:number,b:number,a?:number}} referenceColor Reference RGBA color.
     * @param {number} baseThresholdSquared Trusted seed threshold squared.
     * @param {number} enhancedThresholdSquared Expanded candidate threshold squared.
     * @param {Uint8Array|null} operationMask Optional exact-selection mask.
     * @returns {Uint8Array}
     */
    function expandReferenceCandidateMask(
      source,
      width,
      height,
      referenceColor,
      baseThresholdSquared,
      enhancedThresholdSquared,
      operationMask,
    ) {
      const pixelCount = width * height;
      const candidates = new Uint8Array(pixelCount);
      const selected = new Uint8Array(pixelCount);
      const queue = new Int32Array(pixelCount);
      let queueHead = 0;
      let queueTail = 0;

      if (baseThresholdSquared < 0 || enhancedThresholdSquared < 0) return selected;
      for (let pixel = 0; pixel < pixelCount; pixel += 1) {
        if (operationMask && operationMask[pixel] !== 255) continue;
        if (!referenceRgbaMatches(source, pixel, referenceColor, enhancedThresholdSquared)) continue;
        candidates[pixel] = 1;
        if (!referenceRgbaMatches(source, pixel, referenceColor, baseThresholdSquared)) continue;
        selected[pixel] = 1;
        queue[queueTail] = pixel;
        queueTail += 1;
      }

      const enqueueCandidate = (neighbour) => {
        if (!candidates[neighbour] || selected[neighbour]) return;
        selected[neighbour] = 1;
        queue[queueTail] = neighbour;
        queueTail += 1;
      };
      while (queueHead < queueTail) {
        const pixel = queue[queueHead];
        queueHead += 1;
        const x = pixel % width;
        if (x > 0) enqueueCandidate(pixel - 1);
        if (x + 1 < width) enqueueCandidate(pixel + 1);
        if (pixel >= width) enqueueCandidate(pixel - width);
        if (pixel + width < pixelCount) enqueueCandidate(pixel + width);
      }
      return selected;
    }

    /**
     * Builds the exact base-seeded candidate plane used by color replacement.
     * This lets product-level connected-background mode constrain the reference
     * candidates spatially without changing edge-enhancement tolerance semantics.
     * @param {Uint8ClampedArray|Uint8Array} source RGBA source pixels.
     * @param {number} width Image width.
     * @param {number} height Image height.
     * @param {{r:number,g:number,b:number,a?:number}} referenceColor Reference RGBA color.
     * @param {number} tolerance Base tolerance.
     * @param {number} edgeEnhance Edge-enhancement percentage.
     * @param {Uint8Array|null} [operationMask=null] Optional exact-selection mask.
     * @returns {Uint8Array} Non-zero pixels belong to the reference candidate plane.
     */
    function createReferenceColorCandidateMask(
      source,
      width,
      height,
      referenceColor,
      tolerance,
      edgeEnhance,
      operationMask = null,
    ) {
      const pixelCount = width * height;
      if (width <= 0 || height <= 0 || !source || source.length !== pixelCount * 4) {
        throw new RangeError("Reference candidate RGBA length does not match its dimensions.");
      }
      if (operationMask && operationMask.length !== pixelCount) {
        throw new RangeError("Reference candidate mask length does not match its dimensions.");
      }
      const safeTolerance = Math.trunc(tolerance);
      const safeEdgeEnhance = Math.trunc(edgeEnhance || 0);
      const effectiveTolerance =
        safeTolerance < 0 ? -1 : (Math.max(0, 100 - safeTolerance) * safeEdgeEnhance) / 100 + safeTolerance;
      const baseThresholdSquared = safeTolerance < 0 ? -1 : Math.trunc((safeTolerance * 5.1) ** 2 + 0.5);
      const enhancedThresholdSquared =
        effectiveTolerance < 0 ? -1 : Math.trunc((effectiveTolerance * 5.1) ** 2 + 0.5);
      return expandReferenceCandidateMask(
        source,
        width,
        height,
        referenceColor,
        baseThresholdSquared,
        enhancedThresholdSquared,
        operationMask,
      );
    }

    /**
     * Rebuilds the public `fp_kernel_07` color-replacement entry point.
     * @param {Uint8ClampedArray|Uint8Array} source RGBA source pixels.
     * @param {number} width Image width.
     * @param {number} height Image height.
     * @param {{x:number,y:number}} seed Rounded reference coordinate.
     * @param {{r:number,g:number,b:number,a?:number}} fillColor Replacement color.
     * @param {number} tolerance Integer tolerance.
     * @param {object} [options] Reference pipeline options.
     * @returns {Uint8ClampedArray}
     */
    function applyReferenceColorReplace(source, width, height, seed, fillColor, tolerance, options = {}) {
      const pixelCount = width * height;
      if (width <= 0 || height <= 0 || !source || source.length !== pixelCount * 4) {
        throw new RangeError("Reference color-replace RGBA length does not match its dimensions.");
      }
      const operationMask = options.mask || null;
      if (operationMask && operationMask.length !== pixelCount) {
        throw new RangeError("Reference color-replace mask length does not match its dimensions.");
      }
      const seedX = Math.round(seed?.x);
      const seedY = Math.round(seed?.y);
      const output = new Uint8ClampedArray(source);
      if (seedX < 0 || seedY < 0 || seedX >= width || seedY >= height) return output;
      const seedOffset = (seedY * width + seedX) * 4;
      const referenceColor = options.referenceColor || {
        r: source[seedOffset],
        g: source[seedOffset + 1],
        b: source[seedOffset + 2],
        a: source[seedOffset + 3],
      };
      const reference = {
        r: referenceColor.r & 255,
        g: referenceColor.g & 255,
        b: referenceColor.b & 255,
        a: referenceColor.a == null ? 255 : referenceColor.a & 255,
      };
      const replacement = {
        r: fillColor.r & 255,
        g: fillColor.g & 255,
        b: fillColor.b & 255,
        a: fillColor.a == null ? 255 : fillColor.a & 255,
      };
      if (
        reference.r === replacement.r &&
        reference.g === replacement.g &&
        reference.b === replacement.b &&
        reference.a === replacement.a
      )
        return output;
      const safeTolerance = Math.trunc(tolerance);
      const edgeEnhance = Math.trunc(options.edgeEnhance || 0);
      const effectiveTolerance =
        safeTolerance < 0 ? -1 : (Math.max(0, 100 - safeTolerance) * edgeEnhance) / 100 + safeTolerance;
      const thresholdSquared =
        effectiveTolerance < 0 ? -1 : Math.trunc((effectiveTolerance * 5.1) ** 2 + 0.5);
      const selectedMask = createReferenceColorCandidateMask(
        source,
        width,
        height,
        reference,
        safeTolerance,
        edgeEnhance,
        operationMask,
      );
      return applyReferenceReplacementPipeline(
        source,
        width,
        height,
        selectedMask,
        reference,
        replacement,
        options,
        thresholdSquared,
      );
    }

    /**
     * Rebuilds `fp_kernel_13` flood-fill replacement and its shared edge pipeline.
     * @param {Uint8ClampedArray|Uint8Array} source RGBA source pixels.
     * @param {number} width Image width.
     * @param {number} height Image height.
     * @param {{x:number,y:number}} seed Rounded seed coordinate.
     * @param {{r:number,g:number,b:number,a?:number}} fillColor Replacement RGBA color.
     * @param {number} tolerance Integer tolerance.
     * @param {{
     *   referenceColor?:{r:number,g:number,b:number,a?:number}|null,
     *   mask?:Uint8Array|null,
     *   edgeRestoreRadius?:number,
     * }} [options] Kernel options.
     * @returns {Uint8ClampedArray}
     */
    function applyReferenceFloodFillDespill(source, width, height, seed, fillColor, tolerance, options = {}) {
      const pixelCount = width * height;
      if (width <= 0 || height <= 0 || !source || source.length !== pixelCount * 4) {
        throw new RangeError("Reference flood-fill RGBA length does not match its dimensions.");
      }
      const mask = options.mask || null;
      if (mask && mask.length !== pixelCount) {
        throw new RangeError("Reference flood-fill mask length does not match its dimensions.");
      }
      const seedX = Math.round(seed?.x);
      const seedY = Math.round(seed?.y);
      const output = new Uint8ClampedArray(source);
      if (seedX < 0 || seedX >= width || seedY < 0 || seedY >= height) return output;
      const seedOffset = (seedY * width + seedX) * 4;
      const referenceColor = options.referenceColor || {
        r: source[seedOffset],
        g: source[seedOffset + 1],
        b: source[seedOffset + 2],
        a: source[seedOffset + 3],
      };
      const replacement = {
        r: fillColor.r & 255,
        g: fillColor.g & 255,
        b: fillColor.b & 255,
        a: fillColor.a == null ? 255 : fillColor.a & 255,
      };
      const reference = {
        r: referenceColor.r & 255,
        g: referenceColor.g & 255,
        b: referenceColor.b & 255,
        a: referenceColor.a == null ? 255 : referenceColor.a & 255,
      };
      if (
        replacement.r === reference.r &&
        replacement.g === reference.g &&
        replacement.b === reference.b &&
        replacement.a === reference.a
      ) {
        return output;
      }
      const thresholdSquared = Math.trunc((Math.trunc(tolerance) * 5.1) ** 2 + 0.5);
      const candidates = new Uint8Array(pixelCount);
      for (let pixel = 0; pixel < pixelCount; pixel += 1) {
        if (mask && mask[pixel] !== 255) continue;
        if (referenceRgbaMatches(source, pixel, reference, thresholdSquared)) {
          candidates[pixel] = 1;
        }
      }
      const selected = connectedCandidateMask(candidates, width, height, {
        seeds: [{ x: seedX, y: seedY }],
        maximumPixels: pixelCount,
      });
      return applyReferenceReplacementPipeline(
        source,
        width,
        height,
        selected,
        reference,
        replacement,
        {
          ...options,
          protectColors: [],
          despillStrength: 0,
          alphaThresholdHigh: 0,
          alphaThresholdLow: 0,
        },
        thresholdSquared,
      );
    }

    return {
      diffuseReferenceCandidateMask,
      diffuseReferenceGlobalCandidateMask,
      createReferenceColorCandidateMask,
      applyReferenceColorReplace,
      applyReferenceFloodFillDespill,
    };
  }

  return { createReferenceReplacementKernels };
});
