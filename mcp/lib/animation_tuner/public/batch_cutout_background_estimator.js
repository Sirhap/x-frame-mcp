(function attachBatchCutoutBackgroundEstimator(root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BatchCutoutBackgroundEstimator = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  /**
   * Converts one byte channel to a two-character hexadecimal component.
   * @param {number} channel RGB channel.
   * @returns {string} Lowercase hexadecimal component.
   */
  function channelToHex(channel) {
    return Math.max(0, Math.min(255, Math.round(Number(channel) || 0)))
      .toString(16)
      .padStart(2, "0");
  }

  /**
   * Formats a browser RGB color without depending on protected color kernels.
   * @param {{r:number,g:number,b:number}} color RGB color.
   * @returns {string} CSS hexadecimal color.
   */
  function rgbToHex(color) {
    return `#${channelToHex(color.r)}${channelToHex(color.g)}${channelToHex(color.b)}`;
  }

  /**
   * True when a sample is a near-neutral studio plate (white/gray/black).
   * Reuses scatter's classifySmartBackground when that module is loaded.
   * @param {{r:number,g:number,b:number}|null} color Sampled RGB.
   * @returns {boolean} Whether the sample is a plate.
   */
  function isNearNeutralPlate(color) {
    if (!color) return false;
    let classify = null;
    if (typeof module === "object" && module.exports) {
      try {
        classify = require("./smart_cutout_defaults").classifySmartBackground;
      } catch (_error) {
        classify = null;
      }
    } else if (typeof globalThis !== "undefined") {
      classify = globalThis.XFrameSmartCutoutDefaults?.classifySmartBackground;
    }
    if (typeof classify === "function") return classify(color) === "plate";
    const max = Math.max(color.r, color.g, color.b);
    const min = Math.min(color.r, color.g, color.b);
    return max - min <= 24;
  }

  /**
   * Picks the most frequent exact color from 4-bit buckets.
   * @param {Map<string,{r:number,g:number,b:number,count:number,colors:Map<number,object>}>} buckets Color buckets.
   * @returns {{r:number,g:number,b:number,sampleCount:number}|null} Dominant visible color.
   */
  function pickDominantColor(buckets) {
    let dominant = null;
    for (const bucket of buckets.values()) {
      if (!dominant || bucket.count > dominant.count) dominant = bucket;
    }
    if (!dominant?.count) return null;
    const centroid = {
      r: dominant.r / dominant.count,
      g: dominant.g / dominant.count,
      b: dominant.b / dominant.count,
    };
    const selectedColor = [...dominant.colors.values()].sort((left, right) => {
      if (left.count !== right.count) return right.count - left.count;
      const leftDistance =
        (left.r - centroid.r) ** 2 + (left.g - centroid.g) ** 2 + (left.b - centroid.b) ** 2;
      const rightDistance =
        (right.r - centroid.r) ** 2 + (right.g - centroid.g) ** 2 + (right.b - centroid.b) ** 2;
      return leftDistance - rightDistance || left.firstSeen - right.firstSeen;
    })[0];
    return { r: selectedColor.r, g: selectedColor.g, b: selectedColor.b, sampleCount: dominant.count };
  }

  /**
   * Estimates the auto-key color for /tools/cutout.
   * Samples the perimeter first. When that ring is a studio plate but the
   * image-wide majority is chroma-green, the chroma is the key — white chrome
   * around a green screen must not win. A large subject on a white plate still
   * keys white.
   * @param {Uint8ClampedArray|Uint8Array} data RGBA pixel data.
   * @param {number} width Image width.
   * @param {number} height Image height.
   * @returns {{r:number,g:number,b:number,hex:string,sampleCount:number}}
   */
  function estimateBackgroundColor(data, width, height) {
    const normalizedWidth = Math.max(0, Math.trunc(Number(width) || 0));
    const normalizedHeight = Math.max(0, Math.trunc(Number(height) || 0));
    if (!data || data.length < normalizedWidth * normalizedHeight * 4) {
      return { r: 255, g: 255, b: 255, hex: "#ffffff", sampleCount: 0 };
    }

    const perimeterBuckets = new Map();
    const thinPlateBuckets = new Map();
    const imageWideBuckets = new Map();
    const edgeDepth = Math.max(
      1,
      Math.min(12, Math.ceil(Math.min(normalizedWidth, normalizedHeight) * 0.04)),
    );
    const plateRingDepth = Math.min(edgeDepth, 3);
    /**
     * Adds one visible pixel to a bucket map.
     * @param {Map<string,object>} buckets Destination buckets.
     * @param {number} x Pixel x coordinate.
     * @param {number} y Pixel y coordinate.
     * @returns {void}
     */
    const addPixel = (buckets, x, y) => {
      const offset = (y * normalizedWidth + x) * 4;
      if ((data[offset + 3] || 0) < 16) return;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      const key = `${red >> 4},${green >> 4},${blue >> 4}`;
      const bucket = buckets.get(key) || { r: 0, g: 0, b: 0, count: 0, colors: new Map() };
      bucket.r += red;
      bucket.g += green;
      bucket.b += blue;
      bucket.count += 1;
      const packedColor = (red << 16) | (green << 8) | blue;
      const exactColor = bucket.colors.get(packedColor) || {
        r: red,
        g: green,
        b: blue,
        count: 0,
        firstSeen: bucket.count,
      };
      exactColor.count += 1;
      bucket.colors.set(packedColor, exactColor);
      buckets.set(key, bucket);
    };

    for (let y = 0; y < normalizedHeight; y += 1) {
      for (let x = 0; x < normalizedWidth; x += 1) {
        addPixel(imageWideBuckets, x, y);
        const inBand =
          x < edgeDepth ||
          x >= normalizedWidth - edgeDepth ||
          y < edgeDepth ||
          y >= normalizedHeight - edgeDepth;
        const inPlateRing =
          x < plateRingDepth ||
          x >= normalizedWidth - plateRingDepth ||
          y < plateRingDepth ||
          y >= normalizedHeight - plateRingDepth;
        if (inBand) addPixel(perimeterBuckets, x, y);
        if (inPlateRing) addPixel(thinPlateBuckets, x, y);
      }
    }

    const perimeter = pickDominantColor(perimeterBuckets);
    const thinPlate = pickDominantColor(thinPlateBuckets);
    const imageWide = pickDominantColor(imageWideBuckets);
    const chromaBehindChrome =
      perimeter &&
      imageWide &&
      isNearNeutralPlate(perimeter) &&
      imageWide.g > imageWide.r + 24 &&
      imageWide.g > imageWide.b + 24;
    const leftoverStudioPlate =
      thinPlate && isNearNeutralPlate(thinPlate) && perimeter && !isNearNeutralPlate(perimeter);
    const selected = chromaBehindChrome ? imageWide : leftoverStudioPlate ? thinPlate : perimeter;
    if (!selected) {
      return { r: 255, g: 255, b: 255, hex: "#ffffff", sampleCount: 0 };
    }
    const color = { r: selected.r, g: selected.g, b: selected.b };
    return { ...color, hex: rgbToHex(color), sampleCount: selected.sampleCount };
  }

  /**
   * True when the field is already punched (transparent border, opaque interior).
   * A second auto-key would chew pale edge subject pixels.
   */
  function alreadyCutOut(rgba, width, height) {
    const normalizedWidth = Math.max(0, Math.trunc(Number(width) || 0));
    const normalizedHeight = Math.max(0, Math.trunc(Number(height) || 0));
    if (!rgba || normalizedWidth < 2 || normalizedHeight < 2) return false;
    const edgeDepth = Math.max(
      3,
      Math.min(12, Math.ceil(Math.min(normalizedWidth, normalizedHeight) * 0.04)),
    );
    let ringPixels = 0;
    let clearPixels = 0;
    let interiorOpaque = 0;
    for (let y = 0; y < normalizedHeight; y += 1) {
      for (let x = 0; x < normalizedWidth; x += 1) {
        const inBand =
          x < edgeDepth ||
          x >= normalizedWidth - edgeDepth ||
          y < edgeDepth ||
          y >= normalizedHeight - edgeDepth;
        const alpha = rgba[(y * normalizedWidth + x) * 4 + 3] || 0;
        if (!inBand) {
          if (alpha > 16) interiorOpaque += 1;
          continue;
        }
        ringPixels += 1;
        if (alpha <= 16) clearPixels += 1;
      }
    }
    return ringPixels > 0 && clearPixels / ringPixels >= 0.5 && interiorOpaque > 0;
  }

  return Object.freeze({ alreadyCutOut, estimateBackgroundColor });
});
