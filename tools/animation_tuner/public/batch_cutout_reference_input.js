(function attachBatchCutoutReferenceInput(root, factory) {
  const colorCore =
    typeof module === "object" && module.exports
      ? require("./batch_cutout_color_core")
      : root?.BatchCutoutColorCore;
  const backgroundEstimator =
    typeof module === "object" && module.exports
      ? require("./batch_cutout_background_estimator")
      : root?.BatchCutoutBackgroundEstimator;
  const api = factory(colorCore, backgroundEstimator);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BatchCutoutReferenceInput = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (colorCore, backgroundEstimator) => {
  "use strict";

  if (!colorCore?.clamp || !colorCore?.rgbToOklab || !colorCore?.rgbToReferenceYcbcr) {
    throw new Error("BatchCutoutColorCore is required.");
  }
  if (typeof backgroundEstimator?.estimateBackgroundColor !== "function") {
    throw new Error("BatchCutoutBackgroundEstimator is required.");
  }

  const { clamp, hueDistance, oklabToRgb, rgbToOklab, rgbToReferenceYcbcr } = colorCore;
  const { estimateBackgroundColor } = backgroundEstimator;

  /**
   * Applies the reference smooth-step curve.
   * @param {number} minimum Lower edge.
   * @param {number} maximum Upper edge.
   * @param {number} value Input value.
   * @returns {number}
   */
  function smoothstep(minimum, maximum, value) {
    const position = clamp((value - minimum) / (maximum - minimum), 0, 1);
    return position * position * (3 - 2 * position);
  }

  /**
   * Returns the reference chroma response around the sampled background magnitude.
   * @param {number} chroma Pixel OKLab chroma.
   * @param {number} referenceChroma Background OKLab chroma.
   * @returns {number}
   */
  function chromaResponse(chroma, referenceChroma) {
    if (chroma < 0.03) return 0;
    if (chroma <= referenceChroma) return chroma / referenceChroma;
    const upper = referenceChroma * 1.5;
    return chroma < upper ? 1 - smoothstep(referenceChroma, upper, chroma) : 0;
  }

  /**
   * Reduces contamination with the reference OKLab 15°/30° hue falloff.
   * @param {Uint8ClampedArray} data Mutable RGBA pixel data.
   * @param {number} offset Pixel byte offset.
   * @param {{r:number,g:number,b:number}} backgroundColor Sampled background.
   * @param {number} strength Normalized strength in the range 0-1.
   * @returns {void}
   */
  function applyReferenceDespillPixel(data, offset, backgroundColor, strength) {
    if (data[offset + 3] < 1 || strength <= 0) return;
    const reference = rgbToOklab(backgroundColor.r, backgroundColor.g, backgroundColor.b);
    if (reference.chroma < 0.02) return;
    const pixel = rgbToOklab(data[offset], data[offset + 1], data[offset + 2]);
    if (pixel.chroma < 0.03) return;
    const hueDifference = hueDistance(pixel.hue, reference.hue);
    const hueWeight = 1 - smoothstep(15, 30, hueDifference);
    if (hueWeight === 0) return;
    const magnitudeWeight = chromaResponse(pixel.chroma, reference.chroma);
    if (magnitudeWeight === 0) return;
    const chromaScale = 1 - hueWeight * magnitudeWeight * clamp(strength, 0, 1);
    const converted = oklabToRgb(pixel.l, pixel.a * chromaScale, pixel.b * chromaScale);
    data[offset] = converted.r;
    data[offset + 1] = converted.g;
    data[offset + 2] = converted.b;
  }

  /**
   * Applies the reference chroma-key operation.
   * @param {Uint8ClampedArray|Uint8Array} source Source RGBA pixels.
   * @param {number} width Image width.
   * @param {number} height Image height.
   * @param {object} options Chroma-key options.
   * @returns {Uint8ClampedArray}
   */
  function applyReferenceChromaKey(source, width, height, options) {
    const pixelCount = width * height;
    if (!source || source.length !== pixelCount * 4) {
      throw new RangeError("Reference chroma-key RGBA length does not match its dimensions.");
    }
    const backgroundColor = options?.backgroundColor || { r: 0, g: 255, b: 0 };
    const replacement = Array.isArray(options?.replacementColor) ? options.replacementColor : [0, 0, 0, 0];
    const cleanupBand = Math.trunc(options?.cleanup ?? 40) * 0.6;
    const featherWidth = Math.trunc(options?.feather ?? 30) * 0.3;
    const outerBand = cleanupBand + featherWidth;
    const mask = options?.mask || null;
    if (mask && mask.length !== pixelCount) {
      throw new RangeError("Reference chroma-key mask length does not match its dimensions.");
    }
    const output = new Uint8ClampedArray(source);
    const backgroundLab = rgbToOklab(backgroundColor.r, backgroundColor.g, backgroundColor.b);
    const backgroundYcbcr = rgbToReferenceYcbcr(backgroundColor.r, backgroundColor.g, backgroundColor.b);
    const backgroundChromatic = backgroundLab.chroma >= 0.02;
    const maximumBackgroundChroma = backgroundLab.chroma * 1.5;
    for (let pixel = 0; pixel < pixelCount; pixel += 1) {
      if (mask && !mask[pixel]) continue;
      const offset = pixel * 4;
      const sourceAlpha = source[offset + 3];
      if (!sourceAlpha) continue;
      const red = source[offset];
      const green = source[offset + 1];
      const blue = source[offset + 2];
      let innerBand = cleanupBand;
      if (backgroundChromatic) {
        const pixelLab = rgbToOklab(red, green, blue);
        if (pixelLab.l < 0.22 || pixelLab.chroma < 0.03) continue;
        const hueWeight = 1 - smoothstep(15, 30, hueDistance(pixelLab.hue, backgroundLab.hue));
        if (!hueWeight) continue;
        let magnitudeWeight = 0;
        if (pixelLab.chroma <= backgroundLab.chroma) {
          magnitudeWeight = pixelLab.chroma / backgroundLab.chroma;
        } else {
          if (pixelLab.chroma >= maximumBackgroundChroma) continue;
          magnitudeWeight = 1 - smoothstep(backgroundLab.chroma, maximumBackgroundChroma, pixelLab.chroma);
        }
        if (!magnitudeWeight) continue;
        innerBand *= hueWeight * magnitudeWeight;
      }
      const pixelYcbcr = rgbToReferenceYcbcr(red, green, blue);
      const deltaCb = pixelYcbcr.cb - backgroundYcbcr.cb;
      const deltaCr = pixelYcbcr.cr - backgroundYcbcr.cr;
      const chromaDistance = Math.sqrt(deltaCb * deltaCb + deltaCr * deltaCr);
      if (innerBand >= chromaDistance) {
        output[offset] = replacement[0] || 0;
        output[offset + 1] = replacement[1] || 0;
        output[offset + 2] = replacement[2] || 0;
        output[offset + 3] = replacement[3] || 0;
        continue;
      }
      if (featherWidth <= 0 || chromaDistance > outerBand) continue;
      const blend = (chromaDistance - innerBand) / (outerBand - innerBand);
      if (!(replacement[3] || 0)) {
        output[offset] = red;
        output[offset + 1] = green;
        output[offset + 2] = blue;
        output[offset + 3] = Math.round(sourceAlpha * blend);
        continue;
      }
      const replacementWeight = 1 - blend;
      const correctedCb = pixelYcbcr.cb - replacementWeight * deltaCb - 128;
      const correctedCr = pixelYcbcr.cr - replacementWeight * deltaCr - 128;
      const correctedRed = clamp(Math.round(pixelYcbcr.y + correctedCr * 1.402), 0, 255);
      const correctedGreen = clamp(
        Math.round(pixelYcbcr.y - correctedCb * 0.344136 - correctedCr * 0.714136),
        0,
        255,
      );
      const correctedBlue = clamp(Math.round(pixelYcbcr.y + correctedCb * 1.772), 0, 255);
      output[offset] = Math.round(correctedRed * blend + replacement[0] * replacementWeight);
      output[offset + 1] = Math.round(correctedGreen * blend + replacement[1] * replacementWeight);
      output[offset + 2] = Math.round(correctedBlue * blend + replacement[2] * replacementWeight);
      output[offset + 3] = Math.round(sourceAlpha * blend + replacement[3] * replacementWeight);
    }
    return output;
  }

  /**
   * Executes the reference chroma-key operation followed by its main-band OKLab despill.
   * @param {Uint8ClampedArray|Uint8Array} source Source RGBA pixels.
   * @param {number} width Image width.
   * @param {number} height Image height.
   * @param {object} options Reference chroma options.
   * @returns {{data:Uint8ClampedArray,removedPixels:number,partialPixels:number}}
   */
  function applyReferenceChromaKeyClean(source, width, height, options = {}) {
    const backgroundColor = options.backgroundColor || { r: 0, g: 255, b: 0 };
    const data = applyReferenceChromaKey(source, width, height, {
      backgroundColor,
      replacementColor: options.replacementColor || [0, 0, 0, 0],
      cleanup: options.cleanup ?? 40,
      feather: options.feather ?? 30,
      mask: options.mask || null,
    });
    const strength = clamp(options.despillStrength ?? 70, 0, 100) / 100;
    if (strength > 0) {
      for (let pixel = 0; pixel < width * height; pixel += 1) {
        const offset = pixel * 4;
        applyReferenceDespillPixel(data, offset, backgroundColor, strength);
        if (options.mask && !options.mask[pixel]) {
          data[offset] = source[offset];
          data[offset + 1] = source[offset + 1];
          data[offset + 2] = source[offset + 2];
        }
      }
    }
    let removedPixels = 0;
    let partialPixels = 0;
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const offset = pixel * 4;
      if (source[offset + 3] > 0 && data[offset + 3] === 0) removedPixels += 1;
      else if (data[offset + 3] < source[offset + 3]) partialPixels += 1;
    }
    return { data, removedPixels, partialPixels };
  }

  return {
    applyReferenceChromaKey,
    applyReferenceChromaKeyClean,
    applyReferenceDespillPixel,
    estimateBackgroundColor,
    smoothstep,
  };
});
