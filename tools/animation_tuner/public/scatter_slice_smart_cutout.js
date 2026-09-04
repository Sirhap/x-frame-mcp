(function attachScatterSliceSmartCutout(root, factory) {
  "use strict";

  const cutoutCore =
    typeof module === "object" && module.exports ? require("./batch_cutout_core") : root?.BatchCutoutCore;
  const smartCutoutDefaults =
    typeof module === "object" && module.exports
      ? require("./smart_cutout_defaults")
      : root?.XSXBSmartCutoutDefaults;
  const api = factory(cutoutCore, smartCutoutDefaults);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.XSXBScatterSliceSmartCutout = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (cutoutCore, smartCutoutDefaults) => {
  "use strict";

  if (!cutoutCore?.applyProductCutout || !cutoutCore?.estimateBackgroundColor) {
    throw new Error("BatchCutoutCore is required for smart slice cutout.");
  }
  if (
    !smartCutoutDefaults?.REGULAR_AUTO_BACKGROUND_PARAMETERS ||
    typeof smartCutoutDefaults.resolveSmartCutoutParameters !== "function" ||
    typeof smartCutoutDefaults.classifySmartBackground !== "function"
  ) {
    throw new Error("Shared smart-cutout defaults are required.");
  }

  /**
   * Validates one RGBA image before running background analysis or replacement.
   * @param {Uint8ClampedArray} rgba Source RGBA pixels.
   * @param {number} width Image width.
   * @param {number} height Image height.
   * @returns {void}
   */
  function validateImage(rgba, width, height) {
    if (!(rgba instanceof Uint8ClampedArray)) throw new TypeError("rgba 必须是 Uint8ClampedArray");
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new RangeError("切片尺寸必须是正整数");
    }
    if (rgba.length !== width * height * 4) throw new RangeError("RGBA 长度与切片尺寸不一致");
  }

  /**
   * Estimates the most frequent visible color across the complete image.
   * Sampling the full image avoids mistaking a decorative border or editor grid for the background.
   * @param {Uint8ClampedArray} rgba Source RGBA pixels.
   * @param {number} width Image width.
   * @param {number} height Image height.
   * @returns {{r:number,g:number,b:number}|null} Dominant visible RGB color.
   */
  function detectDominantImageColor(rgba, width, height) {
    const pixelCount = width * height;
    const step = Math.max(1, Math.ceil(Math.sqrt(pixelCount / 100_000)));
    const buckets = new Map();
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const offset = (y * width + x) * 4;
        if (rgba[offset + 3] < 16) continue;
        const red = rgba[offset];
        const green = rgba[offset + 1];
        const blue = rgba[offset + 2];
        const bucketKey = `${red >> 4},${green >> 4},${blue >> 4}`;
        const bucket = buckets.get(bucketKey) || { count: 0, colors: new Map() };
        const exactKey = (red << 16) | (green << 8) | blue;
        const exact = bucket.colors.get(exactKey) || { r: red, g: green, b: blue, count: 0 };
        exact.count += 1;
        bucket.colors.set(exactKey, exact);
        bucket.count += 1;
        buckets.set(bucketKey, bucket);
      }
    }
    let dominantBucket = null;
    for (const bucket of buckets.values()) {
      if (!dominantBucket || bucket.count > dominantBucket.count) dominantBucket = bucket;
    }
    if (!dominantBucket) return null;
    return [...dominantBucket.colors.values()].sort((left, right) => right.count - left.count)[0] || null;
  }

  /**
   * True when a color is a studio plate: near-white, gray, near-black, or chroma green.
   * Decorative editor borders (cyan, teal, etc.) stay false so image-wide majority wins.
   * @param {{r:number,g:number,b:number}|null} color Sampled RGB.
   * @returns {boolean} Whether the sample looks like a keyable plate.
   */
  function isStudioPlateColor(color) {
    if (!color) return false;
    if (smartCutoutDefaults.classifySmartBackground(color) === "plate") return true;
    const red = Number(color.r);
    const green = Number(color.g);
    const blue = Number(color.b);
    if (![red, green, blue].every(Number.isFinite)) return false;
    return green > red + 24 && green > blue + 24;
  }

  /**
   * Estimates the most frequent visible color in a perimeter band.
   * @param {Uint8ClampedArray} rgba Source RGBA pixels.
   * @param {number} width Image width.
   * @param {number} height Image height.
   * @returns {{r:number,g:number,b:number}|null} Dominant visible RGB color.
   */
  function detectDominantPerimeterColor(rgba, width, height) {
    const edgeDepth = Math.max(2, Math.min(12, Math.ceil(Math.min(width, height) * 0.04)));
    const buckets = new Map();
    const addPixel = (x, y) => {
      const offset = (y * width + x) * 4;
      if (rgba[offset + 3] < 16) return;
      const red = rgba[offset];
      const green = rgba[offset + 1];
      const blue = rgba[offset + 2];
      const bucketKey = `${red >> 4},${green >> 4},${blue >> 4}`;
      const bucket = buckets.get(bucketKey) || { count: 0, colors: new Map() };
      const exactKey = (red << 16) | (green << 8) | blue;
      const exact = bucket.colors.get(exactKey) || { r: red, g: green, b: blue, count: 0 };
      exact.count += 1;
      bucket.colors.set(exactKey, exact);
      bucket.count += 1;
      buckets.set(bucketKey, bucket);
    };
    for (let y = 0; y < height; y += 1) {
      for (let depth = 0; depth < edgeDepth; depth += 1) {
        addPixel(depth, y);
        addPixel(width - 1 - depth, y);
      }
    }
    for (let x = edgeDepth; x < width - edgeDepth; x += 1) {
      for (let depth = 0; depth < edgeDepth; depth += 1) {
        addPixel(x, depth);
        addPixel(x, height - 1 - depth);
      }
    }
    let dominantBucket = null;
    for (const bucket of buckets.values()) {
      if (!dominantBucket || bucket.count > dominantBucket.count) dominantBucket = bucket;
    }
    if (!dominantBucket) return null;
    return [...dominantBucket.colors.values()].sort((left, right) => right.count - left.count)[0] || null;
  }

  /**
   * Detects one shared background sample from the complete source image.
   * Prefers a perimeter studio plate over the image-wide majority so a large
   * subject is not keyed as the background. Decorative borders that are not
   * plates fall through to the image-wide dominant color.
   * @param {Uint8ClampedArray} rgba Source RGBA pixels.
   * @param {number} width Image width.
   * @param {number} height Image height.
   * @returns {{r:number,g:number,b:number}} Detected RGB background.
   */
  function detectBackgroundColor(rgba, width, height) {
    validateImage(rgba, width, height);
    const perimeter = detectDominantPerimeterColor(rgba, width, height);
    const imageWide = detectDominantImageColor(rgba, width, height);
    const chromaBehindChrome =
      perimeter &&
      imageWide &&
      smartCutoutDefaults.classifySmartBackground(perimeter) === "plate" &&
      imageWide.g > imageWide.r + 24 &&
      imageWide.g > imageWide.b + 24;
    const detected =
      (chromaBehindChrome ? imageWide : null) ||
      (isStudioPlateColor(perimeter) ? perimeter : null) ||
      imageWide ||
      cutoutCore.estimateBackgroundColor(rgba, width, height);
    return { r: detected.r, g: detected.g, b: detected.b };
  }

  /**
   * Creates the regular background-clear settings used by the single-image editor.
   * @param {{r:number,g:number,b:number}} backgroundColor Automatically detected background.
   * @returns {object} BatchCutoutCore product options.
   */
  function createSmartCutoutOptions(backgroundColor) {
    const resolved = smartCutoutDefaults.resolveSmartCutoutParameters(backgroundColor);
    return {
      ...resolved,
      automaticCutout: true,
      backgroundColor,
      backgroundColors: [backgroundColor],
      connected: resolved.connected,
      edgeRecoveryTolerance: 0,
      referenceChromaKey: smartCutoutDefaults.referenceChromaKeyFor(backgroundColor, resolved.perceptual),
    };
  }

  /**
   * Applies the existing product smart-cutout pipeline to one cropped slice.
   * @param {Uint8ClampedArray} rgba Source RGBA pixels.
   * @param {number} width Slice width.
   * @param {number} height Slice height.
   * @param {{r:number,g:number,b:number}} [backgroundColor] Shared source background sample.
   * @returns {Uint8ClampedArray} Smart-cutout pixels.
   */
  function applySmartCutout(rgba, width, height, backgroundColor) {
    validateImage(rgba, width, height);
    const resolvedBackground = backgroundColor || detectBackgroundColor(rgba, width, height);
    return cutoutCore.applyProductCutout(
      rgba,
      width,
      height,
      createSmartCutoutOptions(resolvedBackground),
      [],
    ).data;
  }

  return Object.freeze({ applySmartCutout, createSmartCutoutOptions, detectBackgroundColor });
});
