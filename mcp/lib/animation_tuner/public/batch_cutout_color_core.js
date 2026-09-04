(function attachBatchCutoutColorCore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BatchCutoutColorCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  /**
   * Keeps a number inside an inclusive range.
   * @param {number} value Candidate number.
   * @param {number} minimum Inclusive minimum.
   * @param {number} maximum Inclusive maximum.
   * @returns {number}
   */
  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, Number(value || 0)));
  }

  /**
   * Converts an RGB color into a CSS hexadecimal color.
   * @param {{r:number,g:number,b:number}} color RGB color.
   * @returns {string}
   */
  function rgbToHex(color) {
    return `#${[color.r, color.g, color.b]
      .map((channel) =>
        Math.round(clamp(channel, 0, 255))
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")}`;
  }

  /**
   * Converts a CSS hexadecimal color into RGB channels.
   * @param {string} value Hexadecimal color.
   * @returns {{r:number,g:number,b:number}}
   */
  function hexToRgb(value) {
    const match = /^#?([0-9a-f]{6})$/i.exec(String(value || ""));
    if (!match) return { r: 255, g: 255, b: 255 };
    const number = Number.parseInt(match[1], 16);
    return {
      r: (number >> 16) & 255,
      g: (number >> 8) & 255,
      b: number & 255,
    };
  }

  /**
   * Returns perceptual RGB distance normalized to the range 0-100.
   * @param {number} red Red channel.
   * @param {number} green Green channel.
   * @param {number} blue Blue channel.
   * @param {{r:number,g:number,b:number}} target Target color.
   * @returns {number}
   */
  function colorDistance(red, green, blue, target) {
    const redMean = (red + target.r) / 2;
    const redDelta = red - target.r;
    const greenDelta = green - target.g;
    const blueDelta = blue - target.b;
    const weighted = Math.sqrt(
      (2 + redMean / 256) * redDelta * redDelta +
        4 * greenDelta * greenDelta +
        (2 + (255 - redMean) / 256) * blueDelta * blueDelta,
    );
    return clamp((weighted / 764.834) * 100, 0, 100);
  }

  /**
   * Calculates the linear-light value for an arbitrary sRGB channel.
   * This remains the fallback for non-integer callers of the public helper.
   * @param {number} channel sRGB channel.
   * @returns {number}
   */
  function calculateSrgbToLinear(channel) {
    const normalized = clamp(channel, 0, 255) / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  }

  /**
   * Precomputes exact float64 conversions for all image-data channel values.
   * Canvas and Uint8ClampedArray pixels are always integral bytes, so this avoids
   * millions of identical power operations without changing their numeric results.
   * @type {Float64Array}
   */
  const SRGB_TO_LINEAR_8BIT = Float64Array.from({ length: 256 }, (_unused, channel) =>
    calculateSrgbToLinear(channel),
  );

  /**
   * Converts an sRGB channel to linear light.
   * @param {number} channel Eight-bit sRGB channel.
   * @returns {number}
   */
  function srgbToLinear(channel) {
    const integerChannel = Number(channel);
    if (Number.isInteger(integerChannel) && integerChannel >= 0 && integerChannel <= 255) {
      return SRGB_TO_LINEAR_8BIT[integerChannel];
    }
    return calculateSrgbToLinear(integerChannel);
  }

  /**
   * Converts a linear-light channel to eight-bit sRGB.
   * @param {number} channel Linear-light channel.
   * @returns {number}
   */
  function linearToSrgb(channel) {
    const normalized = clamp(channel, 0, 1);
    const encoded = normalized <= 0.0031308 ? normalized * 12.92 : 1.055 * normalized ** (1 / 2.4) - 0.055;
    return clamp(Math.round(encoded * 255), 0, 255);
  }

  /**
   * Reads the public WASM's float32 sRGB lookup-table value.
   * @param {number} channel Eight-bit sRGB channel.
   * @returns {number}
   */
  function referenceSrgbToLinear(channel) {
    return Math.fround(srgbToLinear(channel));
  }

  /**
   * Applies the public WASM's linear-to-sRGB clamp and rounding rules.
   * @param {number} channel Linear-light channel.
   * @returns {number}
   */
  function referenceLinearToSrgb(channel) {
    if (channel <= 0) return 0;
    if (channel >= 1) return 255;
    const encoded = channel <= 0.003131 ? channel * 12.92 : channel ** (1 / 2.4) * 1.055 - 0.055;
    return clamp(Math.trunc(encoded * 255 + 0.5), 0, 255);
  }

  /**
   * Converts RGB into OKLab.
   * @param {number} red Red channel.
   * @param {number} green Green channel.
   * @param {number} blue Blue channel.
   * @returns {{l:number,a:number,b:number,chroma:number,hue:number}}
   */
  function rgbToOklab(red, green, blue) {
    const linearRed = srgbToLinear(red);
    const linearGreen = srgbToLinear(green);
    const linearBlue = srgbToLinear(blue);
    const l = Math.cbrt(0.4122214708 * linearRed + 0.5363325363 * linearGreen + 0.0514459929 * linearBlue);
    const m = Math.cbrt(0.2119034982 * linearRed + 0.6806995451 * linearGreen + 0.1073969566 * linearBlue);
    const s = Math.cbrt(0.0883024619 * linearRed + 0.2817188376 * linearGreen + 0.6299787005 * linearBlue);
    const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    const axisA = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const axisB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    return {
      l: lightness,
      a: axisA,
      b: axisB,
      chroma: Math.hypot(axisA, axisB),
      hue: (Math.atan2(axisB, axisA) * 180) / Math.PI,
    };
  }

  /**
   * Converts OKLab coordinates back to eight-bit sRGB.
   * @param {number} lightness OKLab lightness.
   * @param {number} axisA OKLab a axis.
   * @param {number} axisB OKLab b axis.
   * @returns {{r:number,g:number,b:number}}
   */
  function oklabToRgb(lightness, axisA, axisB) {
    const lRoot = lightness + 0.3963377774 * axisA + 0.2158037573 * axisB;
    const mRoot = lightness - 0.1055613458 * axisA - 0.0638541728 * axisB;
    const sRoot = lightness - 0.0894841775 * axisA - 1.291485548 * axisB;
    const l = lRoot ** 3;
    const m = mRoot ** 3;
    const s = sRoot ** 3;
    return {
      r: linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      g: linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      b: linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    };
  }

  /**
   * Converts RGB into normalized YCbCr values.
   * @param {number} red Red channel.
   * @param {number} green Green channel.
   * @param {number} blue Blue channel.
   * @returns {{y:number,cb:number,cr:number}}
   */
  function rgbToYcbcr(red, green, blue) {
    const normalizedRed = red / 255;
    const normalizedGreen = green / 255;
    const normalizedBlue = blue / 255;
    return {
      y: 0.299 * normalizedRed + 0.587 * normalizedGreen + 0.114 * normalizedBlue,
      cb: -0.168736 * normalizedRed - 0.331264 * normalizedGreen + 0.5 * normalizedBlue,
      cr: 0.5 * normalizedRed - 0.418688 * normalizedGreen - 0.081312 * normalizedBlue,
    };
  }

  /**
   * Returns the shortest circular hue distance in degrees.
   * @param {number} left First hue.
   * @param {number} right Second hue.
   * @returns {number}
   */
  function hueDistance(left, right) {
    const difference = Math.abs(left - right) % 360;
    return Math.min(difference, 360 - difference);
  }

  /**
   * Calculates a perceptual background distance in the range 0-100.
   * @param {number} red Red channel.
   * @param {number} green Green channel.
   * @param {number} blue Blue channel.
   * @param {{r:number,g:number,b:number}} target Background color.
   * @returns {number}
   */
  function perceptualColorDistance(red, green, blue, target) {
    const pixelLab = rgbToOklab(red, green, blue);
    const targetLab = rgbToOklab(target.r, target.g, target.b);
    const pixelYcbcr = rgbToYcbcr(red, green, blue);
    const targetYcbcr = rgbToYcbcr(target.r, target.g, target.b);
    const rgbDifference = colorDistance(red, green, blue, target);
    const chromaDifference = clamp(
      (Math.hypot(pixelYcbcr.cb - targetYcbcr.cb, pixelYcbcr.cr - targetYcbcr.cr) / 0.7072) * 100,
      0,
      100,
    );
    const labDifference = clamp(
      (Math.hypot(pixelLab.l - targetLab.l, pixelLab.a - targetLab.a, pixelLab.b - targetLab.b) / 0.8) * 100,
      0,
      100,
    );
    let distance = rgbDifference * 0.22 + chromaDifference * 0.46 + labDifference * 0.32;
    if (pixelLab.chroma > 0.035 && targetLab.chroma > 0.035) {
      const hueDifference = hueDistance(pixelLab.hue, targetLab.hue);
      if (hueDifference > 15) distance += clamp(((hueDifference - 15) / 30) * 24, 0, 24);
    }
    if (pixelLab.l < 0.22 && targetLab.l > 0.32) distance += 28;
    return clamp(distance, 0, 100);
  }

  /**
   * Precomputes immutable background facts shared by every pixel in a cutout pass.
   * @param {{r:number,g:number,b:number}} color Background RGB color.
   * @returns {{r:number,g:number,b:number,lab:object,ycbcr:object}} Compiled color descriptor.
   */
  function compilePerceptualColor(color) {
    const red = Number(color?.r || 0);
    const green = Number(color?.g || 0);
    const blue = Number(color?.b || 0);
    return {
      r: red,
      g: green,
      b: blue,
      lab: rgbToOklab(red, green, blue),
      ycbcr: rgbToYcbcr(red, green, blue),
    };
  }

  /**
   * Calculates perceptual distance against a precompiled background descriptor.
   * Its arithmetic order intentionally matches `perceptualColorDistance`.
   * @param {number} red Red channel.
   * @param {number} green Green channel.
   * @param {number} blue Blue channel.
   * @param {{r:number,g:number,b:number,lab:object,ycbcr:object}} target Compiled background color.
   * @returns {number} Distance normalized to 0-100.
   */
  function perceptualColorDistanceToCompiled(red, green, blue, target) {
    const pixelLab = rgbToOklab(red, green, blue);
    const pixelYcbcr = rgbToYcbcr(red, green, blue);
    const rgbDifference = colorDistance(red, green, blue, target);
    const chromaDifference = clamp(
      (Math.hypot(pixelYcbcr.cb - target.ycbcr.cb, pixelYcbcr.cr - target.ycbcr.cr) / 0.7072) * 100,
      0,
      100,
    );
    const labDifference = clamp(
      (Math.hypot(pixelLab.l - target.lab.l, pixelLab.a - target.lab.a, pixelLab.b - target.lab.b) / 0.8) *
        100,
      0,
      100,
    );
    let distance = rgbDifference * 0.22 + chromaDifference * 0.46 + labDifference * 0.32;
    if (pixelLab.chroma > 0.035 && target.lab.chroma > 0.035) {
      const hueDifference = hueDistance(pixelLab.hue, target.lab.hue);
      if (hueDifference > 15) distance += clamp(((hueDifference - 15) / 30) * 24, 0, 24);
    }
    if (pixelLab.l < 0.22 && target.lab.l > 0.32) distance += 28;
    return clamp(distance, 0, 100);
  }

  /**
   * Returns the closest distance to any sampled background color.
   * @param {number} red Red channel.
   * @param {number} green Green channel.
   * @param {number} blue Blue channel.
   * @param {Array<{r:number,g:number,b:number}>} colors Background samples.
   * @param {boolean} perceptual Whether to use perceptual color space.
   * @returns {number}
   */
  function nearestBackgroundDistance(red, green, blue, colors, perceptual) {
    let closest = 100;
    for (const color of colors) {
      const distance = perceptual
        ? perceptualColorDistance(red, green, blue, color)
        : colorDistance(red, green, blue, color);
      if (distance < closest) closest = distance;
    }
    return closest;
  }

  /**
   * Finds the nearest precompiled background descriptor without recomputing its color spaces.
   * @param {number} red Red channel.
   * @param {number} green Green channel.
   * @param {number} blue Blue channel.
   * @param {Array<{r:number,g:number,b:number,lab:object,ycbcr:object}>} descriptors Compiled backgrounds.
   * @returns {number} Closest perceptual distance.
   */
  function nearestCompiledBackgroundDistance(red, green, blue, descriptors) {
    let closest = 100;
    for (const descriptor of descriptors) {
      const distance = perceptualColorDistanceToCompiled(red, green, blue, descriptor);
      if (distance < closest) closest = distance;
    }
    return closest;
  }

  /**
   * Converts RGB to the byte-scale YCbCr representation used by the reference chroma kernel.
   * @param {number} red Red channel.
   * @param {number} green Green channel.
   * @param {number} blue Blue channel.
   * @returns {{y:number,cb:number,cr:number}}
   */
  function rgbToReferenceYcbcr(red, green, blue) {
    return {
      y: red * 0.299 + green * 0.587 + blue * 0.114,
      cb: red * -0.168736 + green * -0.331264 + blue * 0.5 + 128,
      cr: red * 0.5 + green * -0.418688 + blue * -0.081312 + 128,
    };
  }

  /**
   * Converts the reference byte-scale YCbCr representation back to RGB.
   * @param {number} y Luma channel.
   * @param {number} cb Blue-difference chroma including the 128 offset.
   * @param {number} cr Red-difference chroma including the 128 offset.
   * @returns {{r:number,g:number,b:number}}
   */
  function referenceYcbcrToRgb(y, cb, cr) {
    const centeredCb = cb - 128;
    const centeredCr = cr - 128;
    return {
      r: clamp(Math.round(y + centeredCr * 1.402), 0, 255),
      g: clamp(Math.round(y - centeredCb * 0.344136 - centeredCr * 0.714136), 0, 255),
      b: clamp(Math.round(y + centeredCb * 1.772), 0, 255),
    };
  }

  /**
   * Executes the behavior of the reference `fp_kernel_09` chroma-key operation.
   * @param {Uint8ClampedArray|Uint8Array} source Source RGBA pixels.
   * @param {number} width Image width.
   * @param {number} height Image height.
   * @param {{
   *   backgroundColor:{r:number,g:number,b:number},
   *   replacementColor?:Array<number>,
   *   cleanup?:number,
   *   feather?:number,
   *   mask?:Uint8Array|null
   * }} options Reference kernel options.
   * @returns {Uint8ClampedArray}
   */

  return {
    calculateSrgbToLinear,
    clamp,
    colorDistance,
    compilePerceptualColor,
    hexToRgb,
    hueDistance,
    linearToSrgb,
    nearestBackgroundDistance,
    nearestCompiledBackgroundDistance,
    oklabToRgb,
    perceptualColorDistance,
    perceptualColorDistanceToCompiled,
    referenceLinearToSrgb,
    referenceSrgbToLinear,
    referenceYcbcrToRgb,
    rgbToHex,
    rgbToOklab,
    rgbToReferenceYcbcr,
    rgbToYcbcr,
    srgbToLinear,
  };
});
