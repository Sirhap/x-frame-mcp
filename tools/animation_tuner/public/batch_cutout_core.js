(function attachBatchCutoutCore(root, factory) {
  const colorCore =
    typeof module === "object" && module.exports
      ? require("./batch_cutout_color_core")
      : root?.BatchCutoutColorCore;
  const productCore =
    typeof module === "object" && module.exports
      ? require("./batch_cutout_product_core")
      : root?.BatchCutoutProductCore;
  const protectionCore =
    typeof module === "object" && module.exports
      ? require("./batch_cutout_protection_core")
      : root?.BatchCutoutProtectionCore;
  const referenceRecoveryCore =
    typeof module === "object" && module.exports
      ? require("./batch_cutout_reference_recovery_core")
      : root?.BatchCutoutReferenceRecoveryCore;
  const referenceReplaceCore =
    typeof module === "object" && module.exports
      ? require("./batch_cutout_reference_replace_core")
      : root?.BatchCutoutReferenceReplaceCore;
  const connectivityCore =
    typeof module === "object" && module.exports
      ? require("./batch_cutout_connectivity_core")
      : root?.BatchCutoutConnectivityCore;
  const referenceInputCore =
    typeof module === "object" && module.exports
      ? require("./batch_cutout_reference_input")
      : root?.BatchCutoutReferenceInput;
  const api = factory(
    colorCore,
    productCore,
    protectionCore,
    referenceRecoveryCore,
    referenceReplaceCore,
    connectivityCore,
    referenceInputCore,
    root?.ProtectedWasmKernelBridge,
  );
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BatchCutoutCore = api;
})(
  typeof globalThis !== "undefined" ? globalThis : this,
  (
    colorCore,
    productCore,
    protectionCore,
    referenceRecoveryCore,
    referenceReplaceCore,
    connectivityCore,
    referenceInputCore,
    protectedWasmKernelBridge,
  ) => {
    "use strict";

    if (!colorCore?.clamp) {
      throw new Error("BatchCutoutColorCore is required.");
    }
    if (!referenceInputCore?.applyReferenceChromaKey || !referenceInputCore?.estimateBackgroundColor) {
      throw new Error("BatchCutoutReferenceInput is required.");
    }

    const {
      clamp,
      colorDistance,
      compilePerceptualColor,
      hexToRgb,
      linearToSrgb,
      nearestBackgroundDistance,
      nearestCompiledBackgroundDistance,
      oklabToRgb,
      perceptualColorDistance,
      referenceLinearToSrgb,
      referenceSrgbToLinear,
      referenceYcbcrToRgb,
      rgbToHex,
      rgbToOklab,
      rgbToReferenceYcbcr,
      rgbToYcbcr,
      srgbToLinear,
    } = colorCore;

    const {
      applyReferenceChromaKey,
      applyReferenceChromaKeyClean,
      applyReferenceDespillPixel,
      estimateBackgroundColor,
    } = referenceInputCore;

    if (!productCore?.createProductPipeline) {
      throw new Error("BatchCutoutProductCore is required.");
    }
    if (!protectionCore?.createProtectionSelector) {
      throw new Error("BatchCutoutProtectionCore is required.");
    }
    if (!referenceRecoveryCore?.createReferenceRecoveryPipeline) {
      throw new Error("BatchCutoutReferenceRecoveryCore is required.");
    }
    if (!referenceReplaceCore?.createReferenceReplacementKernels) {
      throw new Error("BatchCutoutReferenceReplaceCore is required.");
    }
    if (
      !connectivityCore?.connectedCandidateMask ||
      !connectivityCore?.connectedRemovalMask ||
      !connectivityCore?.chamferDistanceToTransparent ||
      !connectivityCore?.chamfer345Distance ||
      !connectivityCore?.isWithinConnectivityTolerance
    ) {
      throw new Error("BatchCutoutConnectivityCore is required.");
    }

    const {
      chamfer345Distance,
      chamferDistanceToTransparent,
      connectedCandidateMask,
      connectedRemovalMask,
      isWithinConnectivityTolerance,
    } = connectivityCore;

    const RGBA_CHANNEL_COUNT = 4;
    const RGB_CHANNEL_KEYS = Object.freeze(["r", "g", "b"]);
    const MAX_PROCESSING_PIXELS = 16_777_216;
    const PERCENT_SCALE = 100;
    const DEFAULT_CUTOUT_TOLERANCE = 18;
    const DEFAULT_EDGE_RECOVERY_TOLERANCE = 30;
    const DEFAULT_EDGE_RECOVERY_BACKGROUND_RADIUS = 30;
    const MAX_EDGE_RECOVERY_BACKGROUND_RADIUS = 30;
    const BLEND_NEUTRALIZATION_FACTOR = 0.2;
    const BLEND_CORRECTION_FACTOR = 0.65;
    const MAX_BLUR_RADIUS = 6;
    const MIN_VISIBLE_ALPHA = 0.001;
    const EDGE_RESTORE_COLOR_CACHE_LIMIT = 128;
    const developmentEdgeRestoreColorCache = new Map();

    /**
     * Validates image dimensions and their RGBA byte buffer before allocations.
     * Zero-sized images are accepted as stable no-op inputs.
     * @param {Uint8ClampedArray|Uint8Array} source Source RGBA pixels.
     * @param {number} width Image width.
     * @param {number} height Image height.
     * @param {string} operation Operation label used in validation errors.
     * @returns {number} Validated pixel count.
     */
    function validateRgbaInput(source, width, height, operation) {
      if (!ArrayBuffer.isView(source) || source.BYTES_PER_ELEMENT !== 1) {
        throw new TypeError(`${operation} requires an 8-bit RGBA buffer.`);
      }
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 0 || height < 0) {
        throw new RangeError(`${operation} dimensions must be non-negative safe integers.`);
      }
      const pixelCount = width * height;
      const expectedLength = pixelCount * RGBA_CHANNEL_COUNT;
      if (!Number.isSafeInteger(pixelCount) || !Number.isSafeInteger(expectedLength)) {
        throw new RangeError(`${operation} dimensions exceed the safe allocation range.`);
      }
      if (pixelCount > MAX_PROCESSING_PIXELS) {
        throw new RangeError(
          `${operation} exceeds the ${MAX_PROCESSING_PIXELS.toLocaleString("en-US")} pixel memory limit.`,
        );
      }
      if (source.length !== expectedLength) {
        throw new RangeError(`${operation} RGBA length does not match its dimensions.`);
      }
      return pixelCount;
    }

    /**
     * Compiles and caches immutable color-axis values used by the JavaScript edge fallback.
     * @param {{r:number,g:number,b:number}} correctColor Desired edge color.
     * @param {{r:number,g:number,b:number}} contaminatedColor Contaminated edge color.
     * @returns {{correct:number[],contaminated:number[],axis:number[],axisLengthSquared:number}}
     */
    function compileDevelopmentEdgeRestoreColors(correctColor, contaminatedColor) {
      const channels = [
        ...RGB_CHANNEL_KEYS.map((key) => correctColor?.[key]),
        ...RGB_CHANNEL_KEYS.map((key) => contaminatedColor?.[key]),
      ];
      if (channels.some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 255)) {
        throw new TypeError("Reference edge restoration colors require RGB channels in the range 0-255.");
      }
      const cacheKey = channels.join(":");
      const cached = developmentEdgeRestoreColorCache.get(cacheKey);
      if (cached) return cached;
      const linear = (channel) => Math.fround(srgbToLinear(channel));
      const correct = RGB_CHANNEL_KEYS.map((key) => linear(correctColor[key]));
      const contaminated = RGB_CHANNEL_KEYS.map((key) => linear(contaminatedColor[key]));
      const axis = contaminated.map((channel, index) => channel - correct[index]);
      const axisLengthSquared = axis.reduce((sum, channel) => sum + channel * channel, 0);
      const compiled = { correct, contaminated, axis, axisLengthSquared };
      if (developmentEdgeRestoreColorCache.size >= EDGE_RESTORE_COLOR_CACHE_LIMIT) {
        developmentEdgeRestoreColorCache.delete(developmentEdgeRestoreColorCache.keys().next().value);
      }
      developmentEdgeRestoreColorCache.set(cacheKey, compiled);
      return compiled;
    }

    const protectionSelector = protectionCore.createProtectionSelector({
      rgbToReferenceYcbcr,
      srgbToLinear,
    });
    const {
      createProtectedRegionMask,
      createReferenceProtectionMask,
      extractProtectedColors,
      referenceProtectionDescriptor,
      referenceProtectionMatches,
      selectProtectedColorsInRectangle,
      selectReferenceProtectedColors,
    } = protectionSelector;
    const referenceRecoveryPipeline = referenceRecoveryCore.createReferenceRecoveryPipeline({
      clamp,
      referenceSrgbToLinear,
      referenceLinearToSrgb,
      rgbToReferenceYcbcr,
      referenceYcbcrToRgb,
      createReferenceProtectionMask,
    });
    const {
      applyReferenceAlphaThresholds,
      applyReferenceDirectionalDespill,
      applyReferenceReplacementPipeline,
    } = referenceRecoveryPipeline;
    const referenceReplacementKernels = referenceReplaceCore.createReferenceReplacementKernels({
      connectedCandidateMask,
      applyReferenceReplacementPipeline,
    });
    const {
      applyReferenceColorReplace,
      applyReferenceFloodFillDespill,
      createReferenceColorCandidateMask,
      diffuseReferenceCandidateMask,
      diffuseReferenceGlobalCandidateMask,
    } = referenceReplacementKernels;
    /**
     * Neutralizes a background color by blending channels toward a balanced foreground.
     * @param {Uint8ClampedArray} data Mutable RGBA pixels.
     * @param {number} offset Pixel byte offset.
     * @param {{r:number,g:number,b:number}} backgroundColor Sampled background color.
     * @param {number} strength Normalized correction strength.
     * @returns {void}
     */
    function applyBlendDespillPixel(data, offset, backgroundColor, strength) {
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      const foregroundAverage = (red + green + blue) / 3;
      const channels = [red, green, blue];

      for (let channelIndex = 0; channelIndex < RGB_CHANNEL_KEYS.length; channelIndex += 1) {
        const backgroundChannel = backgroundColor[RGB_CHANNEL_KEYS[channelIndex]];
        const neutralTarget =
          foregroundAverage + (foregroundAverage - backgroundChannel) * BLEND_NEUTRALIZATION_FACTOR;
        channels[channelIndex] +=
          (neutralTarget - channels[channelIndex]) * strength * BLEND_CORRECTION_FACTOR;
      }

      data[offset] = Math.round(clamp(channels[0], 0, 255));
      data[offset + 1] = Math.round(clamp(channels[1], 0, 255));
      data[offset + 2] = Math.round(clamp(channels[2], 0, 255));
    }

    /**
     * Applies the selected despill strategy to one visible pixel.
     * @param {Uint8ClampedArray} data Mutable RGBA pixels.
     * @param {number} offset Pixel byte offset.
     * @param {{r:number,g:number,b:number}} backgroundColor Sampled background color.
     * @param {number} strength Normalized correction strength.
     * @param {"general"|"blend"|"chroma"} mode Despill strategy.
     * @returns {void}
     */
    function applyDespillPixel(data, offset, backgroundColor, strength, mode) {
      if (mode === "chroma") {
        applyReferenceDespillPixel(data, offset, backgroundColor, strength);
        return;
      }
      if (mode === "blend") {
        applyBlendDespillPixel(data, offset, backgroundColor, strength);
        return;
      }
      applyReferenceDespillPixel(data, offset, backgroundColor, strength * 0.65);
      applyBlendDespillPixel(data, offset, backgroundColor, strength * 0.35);
    }

    /**
     * Applies a separable Gaussian blur in premultiplied-alpha space.
     * @param {Uint8ClampedArray} data Mutable RGBA pixels.
     * @param {number} width Image width.
     * @param {number} height Image height.
     * @param {number} radius Blur radius.
     * @param {Uint16Array|null} edgeDistance Optional chamfer distance.
     * @returns {void}
     */
    function blurPremultipliedEdges(data, width, height, radius, edgeDistance = null) {
      const pixelCount = width * height;
      const safeRadius = Math.max(0, Math.min(MAX_BLUR_RADIUS, Math.round(radius)));
      if (!pixelCount || !safeRadius) return;
      if (edgeDistance && edgeDistance.length !== pixelCount) {
        throw new RangeError("Blur edge-distance length does not match its dimensions.");
      }
      const sigma = Math.max(0.7, safeRadius / 1.5);
      const kernel = [];
      let kernelTotal = 0;
      for (let offset = -safeRadius; offset <= safeRadius; offset += 1) {
        const weight = Math.exp(-(offset * offset) / (2 * sigma * sigma));
        kernel.push(weight);
        kernelTotal += weight;
      }
      for (let index = 0; index < kernel.length; index += 1) kernel[index] /= kernelTotal;
      const premultiplied = new Float32Array(pixelCount * 4);
      const horizontal = new Float32Array(pixelCount * 4);
      const verticalPixel = new Float32Array(4);
      for (let index = 0; index < pixelCount; index += 1) {
        const offset = index * 4;
        const alpha = data[offset + 3] / 255;
        premultiplied[offset] = srgbToLinear(data[offset]) * alpha;
        premultiplied[offset + 1] = srgbToLinear(data[offset + 1]) * alpha;
        premultiplied[offset + 2] = srgbToLinear(data[offset + 2]) * alpha;
        premultiplied[offset + 3] = alpha;
      }
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const outputOffset = (y * width + x) * 4;
          for (let kernelIndex = 0; kernelIndex < kernel.length; kernelIndex += 1) {
            const sampleX = Math.max(0, Math.min(width - 1, x + kernelIndex - safeRadius));
            const inputOffset = (y * width + sampleX) * 4;
            const weight = kernel[kernelIndex];
            for (let channel = 0; channel < 4; channel += 1) {
              horizontal[outputOffset + channel] += premultiplied[inputOffset + channel] * weight;
            }
          }
        }
      }
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const outputOffset = (y * width + x) * 4;
          verticalPixel.fill(0);
          for (let kernelIndex = 0; kernelIndex < kernel.length; kernelIndex += 1) {
            const sampleY = Math.max(0, Math.min(height - 1, y + kernelIndex - safeRadius));
            const inputOffset = (sampleY * width + x) * 4;
            const weight = kernel[kernelIndex];
            for (let channel = 0; channel < 4; channel += 1) {
              verticalPixel[channel] += horizontal[inputOffset + channel] * weight;
            }
          }
          const index = y * width + x;
          if (edgeDistance && edgeDistance[index] > safeRadius * 6 + 4) continue;
          const alpha = verticalPixel[3];
          if (alpha <= MIN_VISIBLE_ALPHA) {
            data[outputOffset + 3] = 0;
            continue;
          }
          data[outputOffset] = linearToSrgb(verticalPixel[0] / alpha);
          data[outputOffset + 1] = linearToSrgb(verticalPixel[1] / alpha);
          data[outputOffset + 2] = linearToSrgb(verticalPixel[2] / alpha);
          data[outputOffset + 3] = Math.round(clamp(alpha, 0, 1) * 255);
        }
      }
    }

    /**
     * Finds an opaque interior color near an edge pixel.
     * @param {Uint8ClampedArray} data RGBA pixels.
     * @param {Uint16Array} edgeDistance Chamfer distance.
     * @param {number} width Image width.
     * @param {number} height Image height.
     * @param {number} index Edge pixel index.
     * @param {number} radius Search radius.
     * @returns {{r:number,g:number,b:number}|null}
     */
    function findInteriorColor(data, edgeDistance, width, height, index, radius) {
      const centerX = index % width;
      const centerY = Math.floor(index / width);
      const safeRadius = Math.max(1, Math.min(16, Math.round(radius)));
      let bestIndex = -1;
      let bestScore = -1;
      for (
        let y = Math.max(0, centerY - safeRadius);
        y <= Math.min(height - 1, centerY + safeRadius);
        y += 1
      ) {
        for (
          let x = Math.max(0, centerX - safeRadius);
          x <= Math.min(width - 1, centerX + safeRadius);
          x += 1
        ) {
          const sampleIndex = y * width + x;
          const alpha = data[sampleIndex * 4 + 3];
          if (alpha < 192) continue;
          const score = edgeDistance[sampleIndex] * 2 - Math.hypot(x - centerX, y - centerY);
          if (score > bestScore) {
            bestScore = score;
            bestIndex = sampleIndex;
          }
        }
      }
      if (bestIndex < 0) return null;
      const offset = bestIndex * 4;
      return { r: data[offset], g: data[offset + 1], b: data[offset + 2] };
    }

    /**
     * Recovers edge color by projecting pixels onto a foreground-to-background color axis.
     * @param {Uint8ClampedArray} data Mutable RGBA pixels.
     * @param {number} width Image width.
     * @param {number} height Image height.
     * @param {Uint16Array} edgeDistance Chamfer distance.
     * @param {Array<{r:number,g:number,b:number}>} backgroundColors Background samples.
     * @param {{strength:number,edgeRadius:number,backgroundRadius:number,tolerance:number}} options Recovery options.
     * @returns {void}
     */
    function recoverEdgeColors(data, width, height, edgeDistance, backgroundColors, options = {}) {
      const pixelCount = width * height;
      const strength = clamp(options.strength, 0, PERCENT_SCALE) / PERCENT_SCALE;
      const edgeLimit = Math.max(1, options.edgeRadius) * 3 + 4;
      if (!pixelCount || !strength || !backgroundColors?.length) return;
      if (!edgeDistance || edgeDistance.length !== pixelCount) {
        throw new RangeError("Edge recovery distance length does not match its dimensions.");
      }
      for (let index = 0; index < pixelCount; index += 1) {
        const offset = index * 4;
        if (data[offset + 3] === 0 || edgeDistance[index] > edgeLimit) continue;
        const foreground = findInteriorColor(
          data,
          edgeDistance,
          width,
          height,
          index,
          options.backgroundRadius,
        );
        if (!foreground) continue;
        const background = backgroundColors.reduce(
          (closest, color) =>
            colorDistance(data[offset], data[offset + 1], data[offset + 2], color) <
            colorDistance(data[offset], data[offset + 1], data[offset + 2], closest)
              ? color
              : closest,
          backgroundColors[0],
        );
        const pixelLinear = [
          srgbToLinear(data[offset]),
          srgbToLinear(data[offset + 1]),
          srgbToLinear(data[offset + 2]),
        ];
        const foregroundLinear = [
          srgbToLinear(foreground.r),
          srgbToLinear(foreground.g),
          srgbToLinear(foreground.b),
        ];
        const backgroundLinear = [
          srgbToLinear(background.r),
          srgbToLinear(background.g),
          srgbToLinear(background.b),
        ];
        const axis = backgroundLinear.map(
          (channel, channelIndex) => channel - foregroundLinear[channelIndex],
        );
        const axisLengthSquared = axis.reduce((sum, channel) => sum + channel * channel, 0);
        if (axisLengthSquared < 0.00001) continue;
        const projection =
          pixelLinear.reduce(
            (sum, channel, channelIndex) =>
              sum + (channel - foregroundLinear[channelIndex]) * axis[channelIndex],
            0,
          ) / axisLengthSquared;
        if (projection <= 0 || projection >= 0.85) continue;
        const projected = foregroundLinear.map(
          (channel, channelIndex) => channel + axis[channelIndex] * projection,
        );
        const residual = Math.hypot(
          ...pixelLinear.map((channel, channelIndex) => channel - projected[channelIndex]),
        );
        if (residual * PERCENT_SCALE > options.tolerance) continue;
        const recovered = pixelLinear.map((channel, channelIndex) =>
          clamp((channel - projection * backgroundLinear[channelIndex]) / (1 - projection), 0, 1),
        );
        const edgeWeight = clamp(1 - edgeDistance[index] / Math.max(1, edgeLimit), 0.15, 1) * strength;
        data[offset] = linearToSrgb(pixelLinear[0] + (recovered[0] - pixelLinear[0]) * edgeWeight);
        data[offset + 1] = linearToSrgb(pixelLinear[1] + (recovered[1] - pixelLinear[1]) * edgeWeight);
        data[offset + 2] = linearToSrgb(pixelLinear[2] + (recovered[2] - pixelLinear[2]) * edgeWeight);
      }
    }

    /**
     * Executes the reference `fp_kernel_08` edge-color restoration algorithm.
     * @param {Uint8ClampedArray|Uint8Array} source Source RGBA pixels.
     * @param {number} width Image width.
     * @param {number} height Image height.
     * @param {{r:number,g:number,b:number}} correctColor Desired uncontaminated edge color.
     * @param {{r:number,g:number,b:number}} contaminatedColor Observed polluted edge color.
     * @param {{tolerance?:number,edgeRadius?:number,backgroundRadius?:number,mask?:Uint8Array|null}} options Kernel options.
     * @returns {Uint8ClampedArray}
     */
    function applyDevelopmentReferenceEdgeColorRestore(
      source,
      width,
      height,
      correctColor,
      contaminatedColor,
      options = {},
    ) {
      const pixelCount = validateRgbaInput(source, width, height, "Reference edge restoration");
      if (!pixelCount) return new Uint8ClampedArray(source);
      const mask = options.mask || null;
      if (mask && mask.length !== pixelCount) {
        throw new RangeError("Reference edge restoration mask length does not match its dimensions.");
      }
      const { correct, contaminated, axis, axisLengthSquared } = compileDevelopmentEdgeRestoreColors(
        correctColor,
        contaminatedColor,
      );
      const linear = (channel) => Math.fround(srgbToLinear(channel));
      if (axisLengthSquared < 0.0001) {
        throw new RangeError("Reference edge restoration colors are too similar.");
      }
      const edgeRadius = Math.trunc(options.edgeRadius ?? 0);
      const backgroundRadius = Math.trunc(
        options.backgroundRadius ?? DEFAULT_EDGE_RECOVERY_BACKGROUND_RADIUS,
      );
      let edgeMask = null;
      if (edgeRadius > 0) {
        const candidates = new Uint8Array(pixelCount);
        const horizontal = new Uint8Array(pixelCount);
        edgeMask = new Uint8Array(pixelCount);
        const colorRadius = (backgroundRadius / 255) * 1.2;
        const colorRadiusSquared = colorRadius * colorRadius;
        for (let pixel = 0; pixel < pixelCount; pixel += 1) {
          const offset = pixel * 4;
          if (!source[offset + 3]) continue;
          const pixelLinear = [
            linear(source[offset]),
            linear(source[offset + 1]),
            linear(source[offset + 2]),
          ];
          const contaminatedDistance = pixelLinear.reduce(
            (sum, channel, index) => sum + (channel - contaminated[index]) ** 2,
            0,
          );
          if (contaminatedDistance >= colorRadiusSquared) continue;
          const projection =
            pixelLinear.reduce((sum, channel, index) => sum + (channel - correct[index]) * axis[index], 0) /
            axisLengthSquared;
          if (projection >= 0.7) candidates[pixel] = 1;
        }
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const minimumX = Math.max(0, x - edgeRadius);
            const maximumX = Math.min(width - 1, x + edgeRadius);
            for (let sampleX = minimumX; sampleX <= maximumX; sampleX += 1) {
              if (candidates[y * width + sampleX]) {
                horizontal[y * width + x] = 1;
                break;
              }
            }
          }
        }
        for (let x = 0; x < width; x += 1) {
          for (let y = 0; y < height; y += 1) {
            const minimumY = Math.max(0, y - edgeRadius);
            const maximumY = Math.min(height - 1, y + edgeRadius);
            for (let sampleY = minimumY; sampleY <= maximumY; sampleY += 1) {
              if (horizontal[sampleY * width + x]) {
                edgeMask[y * width + x] = 1;
                break;
              }
            }
          }
        }
      }
      const residualLimit = Math.trunc(options.tolerance ?? DEFAULT_EDGE_RECOVERY_TOLERANCE) / 1000;
      const residualLimitSquared = residualLimit * residualLimit;
      const output = new Uint8ClampedArray(source);
      for (let pixel = 0; pixel < pixelCount; pixel += 1) {
        if ((mask && !mask[pixel]) || (edgeMask && !edgeMask[pixel])) continue;
        const offset = pixel * 4;
        if (!source[offset + 3]) continue;
        const pixelLinear = [linear(source[offset]), linear(source[offset + 1]), linear(source[offset + 2])];
        const projection =
          pixelLinear.reduce((sum, channel, index) => sum + (channel - correct[index]) * axis[index], 0) /
          axisLengthSquared;
        if (projection < 0 || projection >= 0.85) continue;
        const residualSquared = pixelLinear.reduce((sum, channel, index) => {
          const residual = channel - correct[index] - projection * axis[index];
          return sum + residual * residual;
        }, 0);
        if (residualSquared >= residualLimitSquared) continue;
        let red = correctColor.r;
        let green = correctColor.g;
        let blue = correctColor.b;
        if (projection > 0.5) {
          const correctionWeight = (0.9 - projection) / 0.4;
          if (correctionWeight <= 0) continue;
          if (correctionWeight < 1) {
            const sourceWeight = 1 - correctionWeight;
            red = Math.round(source[offset] * sourceWeight + correctColor.r * correctionWeight);
            green = Math.round(source[offset + 1] * sourceWeight + correctColor.g * correctionWeight);
            blue = Math.round(source[offset + 2] * sourceWeight + correctColor.b * correctionWeight);
          }
        }
        output[offset] = red;
        output[offset + 1] = green;
        output[offset + 2] = blue;
      }
      return output;
    }

    /**
     * Routes protected edge restoration through WASM in production Workers.
     * @param {Uint8ClampedArray|Uint8Array} source Source RGBA pixels.
     * @param {number} width Image width.
     * @param {number} height Image height.
     * @param {object} correctColor Desired edge color.
     * @param {object} contaminatedColor Contaminated edge color.
     * @param {object} [options] Restoration options.
     * @returns {Uint8ClampedArray} Restored pixels.
     */
    function applyReferenceEdgeColorRestore(
      source,
      width,
      height,
      correctColor,
      contaminatedColor,
      options = {},
    ) {
      const pixelCount = validateRgbaInput(source, width, height, "Reference edge restoration");
      if (!pixelCount) return new Uint8ClampedArray(source);
      return protectedWasmKernelBridge?.isReady?.()
        ? protectedWasmKernelBridge.restoreEdges(
            source,
            width,
            height,
            correctColor,
            contaminatedColor,
            options,
          )
        : applyDevelopmentReferenceEdgeColorRestore(
            source,
            width,
            height,
            correctColor,
            contaminatedColor,
            options,
          );
    }

    /**
     * Converts the product selection mask and protected-color tolerance into the
     * public reference-kernel mask convention where enabled pixels equal 255.
     * @param {Uint8ClampedArray|Uint8Array} source Source RGBA pixels.
     * @param {number} width Image width.
     * @param {number} height Image height.
     * @param {object} options Product processing options.
     * @returns {Uint8Array|null}
     */
    function createReferenceOperationMask(source, width, height, options) {
      const selectionMask = options.selectionMask || null;
      const protectedColors = Array.isArray(options.protectedColors) ? options.protectedColors : [];
      if (!selectionMask && !protectedColors.length) return null;
      const operationMask = new Uint8Array(width * height);
      const protectionTolerance = clamp(options.protectionTolerance ?? 8, 0, PERCENT_SCALE);
      for (let pixel = 0; pixel < operationMask.length; pixel += 1) {
        if (selectionMask && !selectionMask[pixel]) continue;
        const offset = pixel * 4;
        const protectedPixel = protectedColors.some(
          (color) =>
            colorDistance(source[offset], source[offset + 1], source[offset + 2], color) <=
            protectionTolerance,
        );
        if (!protectedPixel) operationMask[pixel] = 255;
      }
      return operationMask;
    }

    /**
     * Maps product despill names to the complete reference reconstruction modes.
     * @param {string} mode Product despill mode.
     * @returns {number}
     */
    function referenceDespillMode(mode) {
      if (mode === "blend") return 1;
      if (mode === "chroma") return 2;
      return 0;
    }

    /**
     * Applies the rebuilt edge-color restoration kernel when product protection
     * samples provide a trustworthy uncontaminated foreground color.
     * @param {Uint8ClampedArray} data Mutable cutout pixels.
     * @param {number} width Image width.
     * @param {number} height Image height.
     * @param {Array<{r:number,g:number,b:number}>} protectedColors Foreground samples.
     * @param {Array<{r:number,g:number,b:number}>} backgroundColors Contamination samples.
     * @param {Uint8Array|null} operationMask Optional public 255 mask.
     * @param {object} options Product processing options.
     * @returns {void}
     */
    function restoreReferenceProtectedEdges(
      data,
      width,
      height,
      protectedColors,
      backgroundColors,
      operationMask,
      options,
    ) {
      const strength = clamp(options.edgeRecoveryStrength ?? 0, 0, PERCENT_SCALE) / PERCENT_SCALE;
      if (!strength || !protectedColors.length || !backgroundColors.length) return;
      for (const correctColor of protectedColors.slice(0, 32)) {
        for (const contaminatedColor of backgroundColors) {
          let restored;
          try {
            restored = applyReferenceEdgeColorRestore(data, width, height, correctColor, contaminatedColor, {
              tolerance: clamp(
                options.edgeRecoveryTolerance ?? DEFAULT_EDGE_RECOVERY_TOLERANCE,
                0,
                PERCENT_SCALE,
              ),
              edgeRadius: Math.max(0, Math.trunc(options.edgeDespillRadius || 0)),
              backgroundRadius: clamp(options.backgroundRadius ?? 8, 1, MAX_EDGE_RECOVERY_BACKGROUND_RADIUS),
              mask: operationMask,
            });
          } catch (error) {
            if (!(error instanceof RangeError)) throw error;
            continue;
          }
          for (let pixel = 0; pixel < width * height; pixel += 1) {
            if (operationMask && operationMask[pixel] !== 255) continue;
            const offset = pixel * 4;
            for (let channel = 0; channel < 3; channel += 1) {
              data[offset + channel] = Math.round(
                data[offset + channel] + (restored[offset + channel] - data[offset + channel]) * strength,
              );
            }
          }
        }
      }
    }

    /**
     * Runs the rebuilt reference replacement kernels through the real product
     * entry point, including multi-sample and connected-background semantics.
     * @param {Uint8ClampedArray|Uint8Array} source Source RGBA pixels.
     * @param {number} width Image width.
     * @param {number} height Image height.
     * @param {object} options Product processing options.
     * @param {Array<{r:number,g:number,b:number}>} backgroundColors Background samples.
     * @returns {{data:Uint8ClampedArray,removedPixels:number,partialPixels:number}}
     */
    function applyReferenceCutout(source, width, height, options, backgroundColors) {
      const operationMask = createReferenceOperationMask(source, width, height, options);
      // Keep the regular replacement controls byte-compatible with FramePacker.
      // Chroma cleanup belongs to the perceptual key path and must not silently
      // rewrite the tolerance shown in the regular panel.
      const baseTolerance = Math.trunc(
        clamp(options.tolerance ?? DEFAULT_CUTOUT_TOLERANCE, -1, PERCENT_SCALE),
      );
      const edgeEnhance = Math.trunc(clamp(options.edgeBoost ?? 0, 0, PERCENT_SCALE));
      const edgeRecoveryStrength = clamp(options.edgeRecoveryStrength ?? 0, 0, PERCENT_SCALE);
      const protectedColors = Array.isArray(options.protectedColors) ? options.protectedColors : [];
      const edgeRestoreRadius = Math.max(0, Math.trunc(options.edgeDespillRadius || 0));
      const blendMode = referenceDespillMode(options.blendMode ?? options.despillMode ?? "blend");
      const edgeRestoreMode = referenceDespillMode(options.despillMode ?? "general");
      const seedPoints = Array.isArray(options.seedPoints) ? options.seedPoints : [];
      const connected = options.connected !== false;
      let data = new Uint8ClampedArray(source);
      for (let backgroundIndex = 0; backgroundIndex < backgroundColors.length; backgroundIndex += 1) {
        const backgroundColor = backgroundColors[backgroundIndex];
        const referenceColor = {
          ...backgroundColor,
          a: Number.isFinite(backgroundColor.a) ? backgroundColor.a : 255,
        };
        const pipelineOptions = {
          mask: operationMask,
          referenceColor,
          edgeEnhance,
          blendStrength: clamp(options.blendStrength ?? edgeRecoveryStrength, 0, PERCENT_SCALE),
          despillMode: blendMode,
          despillRefColor: backgroundColor,
          despillStrength: clamp(options.despillStrength ?? 0, 0, PERCENT_SCALE),
          edgeRestoreRadius,
          edgeRestoreMode,
          alphaThresholdHigh: clamp(options.alphaHigh ?? 255, 0, 255),
          alphaThresholdLow: clamp(options.alphaLow ?? 0, 0, 255),
        };
        if (connected) {
          const assignedSeeds = seedPoints.filter((seed) => {
            if (!Number.isFinite(seed?.x) || !Number.isFinite(seed?.y)) return false;
            const x = clamp(Math.round(seed.x), 0, width - 1);
            const y = clamp(Math.round(seed.y), 0, height - 1);
            const offset = (y * width + x) * 4;
            let closestIndex = 0;
            let closestDistance = Number.POSITIVE_INFINITY;
            for (let index = 0; index < backgroundColors.length; index += 1) {
              const distance = colorDistance(
                source[offset],
                source[offset + 1],
                source[offset + 2],
                backgroundColors[index],
              );
              if (distance < closestDistance) {
                closestDistance = distance;
                closestIndex = index;
              }
            }
            return closestIndex === backgroundIndex;
          });
          const referenceCandidates = createReferenceColorCandidateMask(
            data,
            width,
            height,
            referenceColor,
            baseTolerance,
            edgeEnhance,
            operationMask,
          );
          const connectedCandidates = connectedCandidateMask(referenceCandidates, width, height, {
            seeds: assignedSeeds.length ? assignedSeeds : undefined,
            selectionMask: operationMask,
          });
          const connectedOperationMask = Uint8Array.from(connectedCandidates, (candidate) =>
            candidate ? 255 : 0,
          );
          data = protectedReferenceColorReplace(
            data,
            width,
            height,
            { x: 0, y: 0 },
            { r: 0, g: 0, b: 0, a: 0 },
            baseTolerance,
            { ...pipelineOptions, mask: connectedOperationMask },
          );
        } else {
          data = protectedReferenceColorReplace(
            data,
            width,
            height,
            { x: 0, y: 0 },
            { r: 0, g: 0, b: 0, a: 0 },
            baseTolerance,
            pipelineOptions,
          );
        }
      }
      const selectedMask = new Uint8Array(width * height);
      for (let pixel = 0; pixel < selectedMask.length; pixel += 1) {
        if (data[pixel * 4 + 3] < source[pixel * 4 + 3]) selectedMask[pixel] = 1;
      }
      applyReferenceAlphaThresholds(
        data,
        operationMask,
        clamp(options.alphaHigh ?? 255, 0, 255),
        clamp(options.alphaLow ?? 0, 0, 255),
      );
      if (connected) {
        for (const backgroundColor of backgroundColors) {
          applyReferenceDirectionalDespill(
            data,
            selectedMask,
            operationMask,
            null,
            backgroundColor,
            clamp(options.despillStrength ?? 0, 0, PERCENT_SCALE),
          );
        }
      }
      const featherRadius = clamp(
        Math.round(
          (clamp(options.feather ?? 0, 0, 40) + clamp(options.chromaFeather ?? 0, 0, PERCENT_SCALE) * 0.25) /
            10,
        ),
        0,
        6,
      );
      const blurRadius = Math.max(featherRadius, clamp(options.blurRadius ?? 0, 0, 6));
      let edgeDistance = chamferDistanceToTransparent(data, width, height);
      if (blurRadius > 0) {
        blurPremultipliedEdges(data, width, height, blurRadius, edgeDistance);
        edgeDistance = chamferDistanceToTransparent(data, width, height);
      }
      const alphaThreshold = clamp(options.alphaThreshold ?? 2, 0, 255);
      for (let pixel = 0; pixel < selectedMask.length; pixel += 1) {
        if (!selectedMask[pixel]) continue;
        const alphaOffset = pixel * 4 + 3;
        if (data[alphaOffset] <= alphaThreshold) data[alphaOffset] = 0;
      }
      if (edgeRecoveryStrength > 0 && protectedColors.length) {
        restoreReferenceProtectedEdges(
          data,
          width,
          height,
          protectedColors,
          backgroundColors,
          operationMask,
          options,
        );
      } else if (edgeRecoveryStrength > 0) {
        recoverEdgeColors(data, width, height, edgeDistance, backgroundColors, {
          strength: edgeRecoveryStrength,
          edgeRadius: Math.max(1, edgeRestoreRadius || 2),
          backgroundRadius: clamp(options.backgroundRadius ?? 8, 1, MAX_EDGE_RECOVERY_BACKGROUND_RADIUS),
          tolerance: clamp(
            options.edgeRecoveryTolerance ?? DEFAULT_EDGE_RECOVERY_TOLERANCE,
            0,
            PERCENT_SCALE,
          ),
        });
      }
      if (operationMask) {
        for (let pixel = 0; pixel < operationMask.length; pixel += 1) {
          if (operationMask[pixel] === 255) continue;
          const offset = pixel * 4;
          data.set(source.subarray(offset, offset + 4), offset);
        }
      }
      let removedPixels = 0;
      let partialPixels = 0;
      for (let pixel = 0; pixel < selectedMask.length; pixel += 1) {
        const alphaOffset = pixel * 4 + 3;
        if (source[alphaOffset] > 0 && data[alphaOffset] === 0) removedPixels += 1;
        else if (data[alphaOffset] < source[alphaOffset]) partialPixels += 1;
      }
      return { data, removedPixels, partialPixels };
    }

    /**
     * Removes a sampled background from RGBA pixels.
     * @param {Uint8ClampedArray|Uint8Array} source RGBA pixel data.
     * @param {number} width Image width.
     * @param {number} height Image height.
     * @param {{
     *   backgroundColor?:{r:number,g:number,b:number},
     *   backgroundColors?:Array<{r:number,g:number,b:number}>,
     *   tolerance?:number,
     *   feather?:number,
     *   alphaThreshold?:number,
     *   connected?:boolean,
     *   perceptual?:boolean,
     *   seedPoints?:Array<{x:number,y:number}>,
     *   selectionMask?:Uint8Array|null,
     *   maximumPixels?:number,
     *   edgeBoost?:number,
     *   blendStrength?:number,
     *   blendMode?:"general"|"blend"|"chroma",
     *   alphaLow?:number,
     *   alphaHigh?:number,
     *   despillStrength?:number,
     *   despillMode?:"general"|"blend"|"chroma",
     *   edgeDespillRadius?:number,
     *   edgeRecoveryStrength?:number,
     *   edgeRecoveryTolerance?:number,
     *   backgroundRadius?:number,
     *   blurRadius?:number,
     *   protectedColors?:Array<{r:number,g:number,b:number}>,
     *   protectionTolerance?:number
     * }} options Processing options.
     * @returns {{data:Uint8ClampedArray,removedPixels:number,partialPixels:number}}
     */
    function applyCutout(source, width, height, options = {}) {
      const pixelCount = validateRgbaInput(source, width, height, "Cutout");
      if (!pixelCount) {
        return { data: new Uint8ClampedArray(source), removedPixels: 0, partialPixels: 0 };
      }
      const data = new Uint8ClampedArray(source);
      const estimatedBackground = options.backgroundColor || estimateBackgroundColor(data, width, height);
      const backgroundColors =
        Array.isArray(options.backgroundColors) && options.backgroundColors.length
          ? options.backgroundColors
          : [estimatedBackground];
      const backgroundColor = backgroundColors[0];
      if (options.referenceChromaKey === true) {
        return applyReferenceCutout(source, width, height, options, backgroundColors);
      }
      // -1 is the matching off/closed stop. Do not clamp it to 0 (exact match)
      // and do not invent a positive tolerance from the estimated background.
      const tolerance = clamp(options.tolerance ?? DEFAULT_CUTOUT_TOLERANCE, -1, PERCENT_SCALE);
      const matchingClosed = tolerance < 0;
      const feather = clamp(options.feather ?? 6, 0, 40);
      const alphaThreshold = clamp(options.alphaThreshold ?? 2, 0, 255);
      const edgeBoost = clamp(options.edgeBoost ?? 0, 0, PERCENT_SCALE);
      const alphaLow = clamp(options.alphaLow ?? 0, 0, 255);
      const alphaHigh = clamp(options.alphaHigh ?? 255, 0, 255);
      const despillStrength = clamp(options.despillStrength ?? 0, 0, PERCENT_SCALE) / PERCENT_SCALE;
      const despillMode = ["blend", "chroma"].includes(options.despillMode) ? options.despillMode : "general";
      const edgeDespillRadius = clamp(options.edgeDespillRadius ?? 0, 0, 12);
      const edgeRecoveryStrength = clamp(options.edgeRecoveryStrength ?? 0, 0, PERCENT_SCALE);
      const edgeRecoveryTolerance = clamp(
        options.edgeRecoveryTolerance ?? DEFAULT_EDGE_RECOVERY_TOLERANCE,
        0,
        PERCENT_SCALE,
      );
      const backgroundRadius = clamp(options.backgroundRadius ?? 8, 1, MAX_EDGE_RECOVERY_BACKGROUND_RADIUS);
      const blurRadius = clamp(options.blurRadius ?? 0, 0, MAX_BLUR_RADIUS);
      const protectedColors = Array.isArray(options.protectedColors) ? options.protectedColors : [];
      const protectionTolerance = clamp(options.protectionTolerance ?? 8, 0, PERCENT_SCALE);
      // Edge enhancement widens only the connected candidate search. Keeping it
      // out of the opacity curve avoids turning similarly colored foreground
      // details semi-transparent.
      const keyTolerance = matchingClosed ? -1 : clamp(tolerance, 0, PERCENT_SCALE);
      const featherLimit = matchingClosed ? -1 : clamp(keyTolerance + feather, 0, PERCENT_SCALE);
      const maximumDistance = matchingClosed ? -1 : clamp(featherLimit + edgeBoost * 0.12, 0, PERCENT_SCALE);
      const perceptual = options.perceptual !== false;
      const compiledBackgroundColors = perceptual
        ? backgroundColors.map((color) => compilePerceptualColor(color))
        : [];
      const connected = options.connected !== false;
      const candidateStrength = new Uint8Array(pixelCount);
      const candidates = new Uint8Array(pixelCount);
      const protectedMask = protectedColors.length ? new Uint8Array(pixelCount) : null;

      for (let index = 0; index < pixelCount; index += 1) {
        const offset = index * 4;
        const originalAlpha = data[offset + 3];
        if (!originalAlpha) continue;
        let protectedPixel = false;
        for (const color of protectedColors) {
          if (colorDistance(data[offset], data[offset + 1], data[offset + 2], color) > protectionTolerance)
            continue;
          protectedPixel = true;
          break;
        }
        if (protectedPixel) {
          protectedMask[index] = 1;
          continue;
        }
        const distance = perceptual
          ? nearestCompiledBackgroundDistance(
              data[offset],
              data[offset + 1],
              data[offset + 2],
              compiledBackgroundColors,
            )
          : nearestBackgroundDistance(
              data[offset],
              data[offset + 1],
              data[offset + 2],
              backgroundColors,
              false,
            );
        const backgroundStrength =
          feather <= 0
            ? distance <= keyTolerance
              ? 1
              : 0
            : clamp((featherLimit - distance) / Math.max(0.001, feather), 0, 1);
        candidateStrength[index] = Math.round(backgroundStrength * 255);
        candidates[index] = distance <= maximumDistance ? 1 : 0;
      }
      const mask = connected
        ? connectedCandidateMask(candidates, width, height, {
            seeds: options.seedPoints,
            selectionMask: options.selectionMask,
            maximumPixels: options.maximumPixels,
          })
        : candidates;

      for (let index = 0; index < pixelCount; index += 1) {
        if (!mask[index] || protectedMask?.[index]) continue;
        const offset = index * 4;
        const originalAlpha = data[offset + 3];
        const nextAlpha = Math.round(originalAlpha * (1 - candidateStrength[index] / 255));
        data[offset + 3] = nextAlpha <= alphaThreshold ? 0 : nextAlpha;
        if (alphaLow > 0 && data[offset + 3] < alphaLow) data[offset + 3] = 0;
        if (alphaHigh > 0 && alphaHigh < 255 && data[offset + 3] > alphaHigh) data[offset + 3] = 255;
      }

      let edgeDistance = chamferDistanceToTransparent(data, width, height);
      if (blurRadius > 0) {
        blurPremultipliedEdges(data, width, height, blurRadius, edgeDistance);
        edgeDistance = chamferDistanceToTransparent(data, width, height);
      }
      if (edgeRecoveryStrength > 0) {
        recoverEdgeColors(data, width, height, edgeDistance, backgroundColors, {
          strength: edgeRecoveryStrength,
          edgeRadius: Math.max(1, edgeDespillRadius || 2),
          backgroundRadius,
          tolerance: edgeRecoveryTolerance,
        });
      }
      if (despillStrength > 0) {
        for (let index = 0; index < pixelCount; index += 1) {
          const offset = index * 4;
          if (data[offset + 3] === 0 || protectedMask?.[index]) continue;
          const nearestBackground = backgroundColors.reduce(
            (closest, color) =>
              colorDistance(data[offset], data[offset + 1], data[offset + 2], color) <
              colorDistance(data[offset], data[offset + 1], data[offset + 2], closest)
                ? color
                : closest,
            backgroundColor,
          );
          const distance = perceptual
            ? nearestCompiledBackgroundDistance(
                data[offset],
                data[offset + 1],
                data[offset + 2],
                compiledBackgroundColors,
              )
            : nearestBackgroundDistance(
                data[offset],
                data[offset + 1],
                data[offset + 2],
                backgroundColors,
                false,
              );
          const nearEdge = edgeDespillRadius > 0 && edgeDistance[index] <= edgeDespillRadius * 3 + 4;
          const eligibleForGlobalCleanup = distance <= maximumDistance + 18;
          if (!nearEdge && !eligibleForGlobalCleanup) continue;
          const edgeMultiplier = nearEdge ? 1 : 0.45;
          applyDespillPixel(data, offset, nearestBackground, despillStrength * edgeMultiplier, despillMode);
        }
      }

      let removedPixels = 0;
      let partialPixels = 0;
      for (let index = 0; index < pixelCount; index += 1) {
        const offset = index * 4;
        if (protectedMask?.[index]) {
          data[offset] = source[offset];
          data[offset + 1] = source[offset + 1];
          data[offset + 2] = source[offset + 2];
          data[offset + 3] = source[offset + 3];
        }
        if (source[offset + 3] > 0 && data[offset + 3] === 0) removedPixels += 1;
        else if (data[offset + 3] < source[offset + 3]) partialPixels += 1;
      }
      return { data, removedPixels, partialPixels };
    }

    /**
     * Routes a protected reference operation through an initialized WASM core.
     * Development and explicit non-production tests retain the readable JavaScript implementation.
     * @param {"applyReferenceColorReplace"|"applyReferenceFloodFillDespill"} operation Protected operation.
     * @param {Function} developmentImplementation Readable development implementation.
     * @param {unknown[]} args Product-kernel arguments.
     * @returns {Uint8ClampedArray} Owned result pixels.
     */
    function runProtectedReferenceOperation(operation, developmentImplementation, args) {
      if (protectedWasmKernelBridge?.isReady?.()) {
        return protectedWasmKernelBridge[operation](...args);
      }
      return developmentImplementation(...args);
    }

    function protectedReferenceColorReplace(...args) {
      return runProtectedReferenceOperation("applyReferenceColorReplace", applyReferenceColorReplace, args);
    }

    function protectedReferenceFloodFillDespill(...args) {
      return runProtectedReferenceOperation(
        "applyReferenceFloodFillDespill",
        applyReferenceFloodFillDespill,
        args,
      );
    }

    const productPipeline = productCore.createProductPipeline({
      applyCutout,
      applyReferenceColorReplace: protectedReferenceColorReplace,
      applyReferenceFloodFillDespill: protectedReferenceFloodFillDespill,
      clamp,
      colorDistance,
      createProtectedRegionMask,
      estimateBackgroundColor,
      perceptualColorDistance,
    });

    return {
      applyCutout,
      applyCutoutBrushStroke: productPipeline.applyCutoutBrushStroke,
      applyCutoutRepairs: productPipeline.applyCutoutRepairs,
      applyProductCutout: productPipeline.applyProductCutout,
      applyReferenceChromaKey,
      applyReferenceChromaKeyClean,
      applyReferenceColorReplace: protectedReferenceColorReplace,
      applyReferenceDespillPixel,
      applyReferenceEdgeColorRestore,
      applyReferenceFloodFillDespill: protectedReferenceFloodFillDespill,
      chamfer345Distance,
      chamferDistanceToTransparent,
      colorDistance,
      connectedCandidateMask,
      connectedRemovalMask,
      createProtectedRegionMask,
      createReferenceProtectionMask,
      diffuseReferenceCandidateMask,
      diffuseReferenceGlobalCandidateMask,
      estimateBackgroundColor,
      extractProtectedColors,
      hexToRgb,
      isWithinConnectivityTolerance,
      perceptualColorDistance,
      referenceProtectionDescriptor,
      referenceProtectionMatches,
      selectProtectedColorsInRectangle,
      selectReferenceProtectedColors,
      rgbToHex,
      rgbToOklab,
      rgbToYcbcr,
      oklabToRgb,
    };
  },
);
