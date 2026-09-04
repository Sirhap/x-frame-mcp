(function attachBatchCutoutReferenceRecoveryCore(root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BatchCutoutReferenceRecoveryCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  /**
   * Creates the reference replacement recovery pipeline.
   * @param {{
   *   clamp:Function,
   *   referenceSrgbToLinear:Function,
   *   referenceLinearToSrgb:Function,
   *   rgbToReferenceYcbcr:Function,
   *   referenceYcbcrToRgb:Function,
   *   createReferenceProtectionMask:Function
   * }} dependencies Required reference-kernel primitives.
   * @returns {object} Reference recovery operations.
   */
  function createReferenceRecoveryPipeline(dependencies) {
    const requiredDependencies = [
      "clamp",
      "referenceSrgbToLinear",
      "referenceLinearToSrgb",
      "rgbToReferenceYcbcr",
      "referenceYcbcrToRgb",
      "createReferenceProtectionMask",
    ];
    for (const name of requiredDependencies) {
      if (typeof dependencies?.[name] !== "function") {
        throw new TypeError(`Reference recovery dependency "${name}" must be a function.`);
      }
    }
    const {
      clamp,
      referenceSrgbToLinear,
      referenceLinearToSrgb,
      rgbToReferenceYcbcr,
      referenceYcbcrToRgb,
      createReferenceProtectionMask,
    } = dependencies;

    /**
     * Applies the reference Alpha high/low threshold branch in its original order.
     * @param {Uint8ClampedArray} data Mutable RGBA pixels.
     * @param {Uint8Array|null} operationMask Optional public 255 mask.
     * @param {number} high Alpha values above this value become opaque.
     * @param {number} low Alpha values below this value become transparent.
     * @returns {void}
     */
    function applyReferenceAlphaThresholds(data, operationMask, high, low) {
      const highThreshold = Math.trunc(high || 0) & 255;
      const lowThreshold = Math.trunc(low || 0) & 255;
      if (!highThreshold && !lowThreshold) return;
      if (highThreshold && lowThreshold && highThreshold < lowThreshold) return;
      if (!lowThreshold && highThreshold === 255) return;
      for (let pixel = 0; pixel < data.length / 4; pixel += 1) {
        if (operationMask && operationMask[pixel] !== 255) continue;
        const alphaOffset = pixel * 4 + 3;
        const alpha = data[alphaOffset];
        if (highThreshold && alpha > highThreshold) data[alphaOffset] = 255;
        else if (lowThreshold && alpha < lowThreshold) data[alphaOffset] = 0;
      }
    }

    /**
     * Applies byte-YCbCr directional despill to non-selected pixels.
     * @param {Uint8ClampedArray} data Mutable RGBA pixels.
     * @param {Uint8Array|null} selectedMask Replaced pixels.
     * @param {Uint8Array|null} operationMask Optional public 255 mask.
     * @param {Uint8Array|null} protectedMask Protected pixels.
     * @param {{r:number,g:number,b:number}} referenceColor Despill direction.
     * @param {number} strength Strength in the range 0-100.
     * @returns {void}
     */
    function applyReferenceDirectionalDespill(
      data,
      selectedMask,
      operationMask,
      protectedMask,
      referenceColor,
      strength,
    ) {
      const normalizedStrength = Math.min(100, Math.max(0, Math.trunc(strength || 0))) / 100;
      if (!normalizedStrength) return;
      const reference = rgbToReferenceYcbcr(referenceColor.r, referenceColor.g, referenceColor.b);
      const referenceCb = reference.cb - 128;
      const referenceCr = reference.cr - 128;
      const referenceChroma = Math.hypot(referenceCb, referenceCr);
      if (referenceChroma < 5) return;
      const directionCb = referenceCb / referenceChroma;
      const directionCr = referenceCr / referenceChroma;
      for (let pixel = 0; pixel < data.length / 4; pixel += 1) {
        if (
          (operationMask && operationMask[pixel] !== 255) ||
          protectedMask?.[pixel] ||
          selectedMask?.[pixel]
        )
          continue;
        const offset = pixel * 4;
        if (!data[offset + 3]) continue;
        const converted = rgbToReferenceYcbcr(data[offset], data[offset + 1], data[offset + 2]);
        const centeredCb = converted.cb - 128;
        const centeredCr = converted.cr - 128;
        if (Math.hypot(centeredCb, centeredCr) < 3) continue;
        const projection = centeredCb * directionCb + centeredCr * directionCr;
        if (projection <= 0) continue;
        const removal = projection * normalizedStrength;
        const convertedRgb = referenceYcbcrToRgb(
          converted.y,
          centeredCb - removal * directionCb + 128,
          centeredCr - removal * directionCr + 128,
        );
        data[offset] = convertedRgb.r;
        data[offset + 1] = convertedRgb.g;
        data[offset + 2] = convertedRgb.b;
      }
    }

    /**
     * Builds shared reconstruction configuration used by public kernel 07.
     * @param {{r:number,g:number,b:number,a:number}} referenceColor Sampled color.
     * @param {{r:number,g:number,b:number,a:number}} replacementColor Replacement color.
     * @param {{r:number,g:number,b:number}|null} despillReferenceColor Optional despill axis.
     * @param {number} strength Blend strength in the range 0-100.
     * @returns {object}
     */
    function createReferenceBlendConfiguration(
      referenceColor,
      replacementColor,
      despillReferenceColor,
      strength,
    ) {
      const fallbackReference =
        despillReferenceColor &&
        (despillReferenceColor.r || despillReferenceColor.g || despillReferenceColor.b)
          ? despillReferenceColor
          : referenceColor;
      const replacementLinear = [
        referenceSrgbToLinear(replacementColor.r),
        referenceSrgbToLinear(replacementColor.g),
        referenceSrgbToLinear(replacementColor.b),
      ];
      const referenceLinear = [
        referenceSrgbToLinear(fallbackReference.r),
        referenceSrgbToLinear(fallbackReference.g),
        referenceSrgbToLinear(fallbackReference.b),
      ];
      const axis = referenceLinear.map((channel, index) => channel - replacementLinear[index]);
      const axisLengthSquared = axis.reduce((sum, channel) => sum + channel * channel, 0);
      const replacementYcbcr = rgbToReferenceYcbcr(
        replacementColor.r,
        replacementColor.g,
        replacementColor.b,
      );
      const referenceYcbcr = rgbToReferenceYcbcr(
        fallbackReference.r,
        fallbackReference.g,
        fallbackReference.b,
      );
      const referenceCb = referenceYcbcr.cb - 128;
      const referenceCr = referenceYcbcr.cr - 128;
      const referenceChroma = Math.hypot(referenceCb, referenceCr);
      return {
        strength: Math.min(100, Math.max(0, Math.trunc(strength || 0))) / 100,
        replacementAlpha: replacementColor.a / 255,
        replacementAlphaByte: replacementColor.a,
        referenceAlphaByte: referenceColor.a,
        replacementLinear,
        referenceLinear,
        axis,
        axisLengthSquared,
        halfAxisLengthSquared: axisLengthSquared * 0.5,
        hasLinearAxis: axisLengthSquared >= 0.0001,
        replacementCb: replacementYcbcr.cb,
        replacementCr: replacementYcbcr.cr,
        referenceChroma,
        referenceDirectionCb: referenceChroma >= 5 ? referenceCb / referenceChroma : 0,
        referenceDirectionCr: referenceChroma >= 5 ? referenceCr / referenceChroma : 0,
      };
    }

    /**
     * Rebuilds the public linear-axis recovery branch.
     * @param {object} configuration Shared blend configuration.
     * @param {number} red Source red.
     * @param {number} green Source green.
     * @param {number} blue Source blue.
     * @param {number} alpha Source alpha.
     * @param {boolean} includeAuxiliary Whether confidence data is required.
     * @returns {object}
     */
    function recoverReferenceLinearAxis(configuration, red, green, blue, alpha, includeAuxiliary) {
      if (!alpha) return { valid: false };
      if (!configuration.hasLinearAxis) {
        const converted = rgbToReferenceYcbcr(red, green, blue);
        const centeredCb = converted.cb - 128;
        const centeredCr = converted.cr - 128;
        if (Math.hypot(centeredCb, centeredCr) < 3) return { valid: false };
        const projection =
          centeredCb * configuration.referenceDirectionCb + centeredCr * configuration.referenceDirectionCr;
        if (projection <= 0) return { valid: false };
        const removal = -configuration.strength * projection;
        const recovered = referenceYcbcrToRgb(
          converted.y,
          centeredCb + removal * configuration.referenceDirectionCb + 128,
          centeredCr + removal * configuration.referenceDirectionCr + 128,
        );
        return {
          valid: true,
          linear: [
            referenceSrgbToLinear(recovered.r),
            referenceSrgbToLinear(recovered.g),
            referenceSrgbToLinear(recovered.b),
          ],
          alpha: alpha / 255,
          confidence: includeAuxiliary ? 1 : 0,
          magnitude: 0,
        };
      }
      const pixelLinear = [
        referenceSrgbToLinear(red),
        referenceSrgbToLinear(green),
        referenceSrgbToLinear(blue),
      ];
      const relative = pixelLinear.map((channel, index) => channel - configuration.replacementLinear[index]);
      const projection =
        relative.reduce((sum, channel, index) => sum + channel * configuration.axis[index], 0) /
        configuration.axisLengthSquared;
      if (projection <= 0.01) return { valid: false };
      const residual = relative.map((channel, index) => channel - projection * configuration.axis[index]);
      const residualSquared = residual.reduce((sum, channel) => sum + channel * channel, 0);
      if (!(residualSquared < configuration.halfAxisLengthSquared)) return { valid: false };
      const confidence = 1 - residualSquared / configuration.halfAxisLengthSquared;
      if (confidence <= 0) return { valid: false };
      const magnitude = Math.min(1, projection) * confidence;
      const colorStrength = Math.sqrt(configuration.strength * magnitude);
      const converted = rgbToReferenceYcbcr(red, green, blue);
      const recovered = referenceYcbcrToRgb(
        converted.y,
        colorStrength * (configuration.replacementCb - converted.cb) + converted.cb,
        colorStrength * (configuration.replacementCr - converted.cr) + converted.cr,
      );
      return {
        valid: true,
        linear: [
          referenceSrgbToLinear(recovered.r),
          referenceSrgbToLinear(recovered.g),
          referenceSrgbToLinear(recovered.b),
        ],
        alpha:
          (configuration.strength *
            magnitude *
            (configuration.replacementAlphaByte - configuration.referenceAlphaByte) +
            alpha) /
          255,
        confidence: includeAuxiliary ? confidence : 0,
        magnitude: includeAuxiliary ? magnitude : 0,
      };
    }

    /**
     * Rebuilds the public compositing recovery branch.
     * @param {object} configuration Shared blend configuration.
     * @param {number} red Source red.
     * @param {number} green Source green.
     * @param {number} blue Source blue.
     * @param {number} alpha Source alpha.
     * @param {boolean} includeAuxiliary Whether confidence data is required.
     * @returns {object}
     */
    function recoverReferenceComposite(configuration, red, green, blue, alpha, includeAuxiliary) {
      if (!alpha) return { valid: false };
      const converted = rgbToReferenceYcbcr(red, green, blue);
      const centeredCb = converted.cb - 128;
      const centeredCr = converted.cr - 128;
      const chroma = Math.hypot(centeredCb, centeredCr);
      const chromaRatio = chroma / configuration.referenceChroma;
      const chromaConfidence = chromaRatio <= 0.05 ? 0 : chromaRatio >= 0.2 ? 1 : (chromaRatio - 0.05) / 0.15;
      const directionProjection =
        centeredCb * configuration.referenceDirectionCb + centeredCr * configuration.referenceDirectionCr;
      if (chroma < 3 || directionProjection <= 0) {
        if (chroma < 3) return { valid: false };
        return {
          valid: true,
          linear: [referenceSrgbToLinear(red), referenceSrgbToLinear(green), referenceSrgbToLinear(blue)],
          alpha: alpha / 255,
          confidence: includeAuxiliary ? chromaConfidence : 0,
          ratio: 0,
          fallback: includeAuxiliary ? 1 : 0,
        };
      }
      const ratio = clamp(directionProjection / configuration.referenceChroma, 0, 0.95);
      const reconstructionAmount = configuration.strength * ratio;
      const reconstructedAlpha = 1 - ratio * configuration.strength * (1 - configuration.replacementAlpha);
      const pixelLinear = [
        referenceSrgbToLinear(red),
        referenceSrgbToLinear(green),
        referenceSrgbToLinear(blue),
      ];
      const recovered = [0, 0, 0];
      if (reconstructedAlpha > 0.02) {
        for (let channel = 0; channel < 3; channel += 1) {
          recovered[channel] =
            (reconstructionAmount *
              (configuration.replacementAlpha * configuration.replacementLinear[channel] -
                configuration.referenceLinear[channel]) +
              pixelLinear[channel]) /
            reconstructedAlpha;
        }
      }
      const negativeMagnitude = recovered.reduce((sum, channel) => sum + (channel < 0 ? -channel : 0), 0);
      const gamutConfidence = negativeMagnitude >= 0.1 ? 0 : 1 - negativeMagnitude / 0.1;
      const saturationPenalty = ratio > 0.6 ? Math.min(1, (ratio - 0.6) / 0.35) : 0;
      return {
        valid: true,
        linear: recovered,
        alpha: reconstructedAlpha,
        confidence: includeAuxiliary ? chromaConfidence * gamutConfidence * (1 - saturationPenalty * 0.5) : 0,
        ratio: includeAuxiliary ? ratio : 0,
        fallback: 0,
      };
    }

    /**
     * Applies the reference blend/reconstruction slot before Alpha thresholds.
     * @param {Uint8ClampedArray} data Mutable output pixels.
     * @param {Uint8ClampedArray|Uint8Array} source Original pixels.
     * @param {Uint8Array} selectedMask Replaced pixels.
     * @param {Uint8Array|null} operationMask Optional public 255 mask.
     * @param {Uint8Array|null} protectedMask Protected pixels.
     * @param {object} referenceColor Reference color.
     * @param {object} replacementColor Replacement color.
     * @param {number} strength Blend strength.
     * @param {number} mode Reconstruction mode.
     * @param {object|null} despillReferenceColor Optional despill axis.
     * @returns {void}
     */
    function applyReferenceBlendRecovery(
      data,
      source,
      selectedMask,
      operationMask,
      protectedMask,
      referenceColor,
      replacementColor,
      strength,
      mode,
      despillReferenceColor,
    ) {
      if (!Math.min(100, Math.max(0, Math.trunc(strength || 0)))) return;
      const configuration = createReferenceBlendConfiguration(
        referenceColor,
        replacementColor,
        despillReferenceColor,
        strength,
      );
      for (let pixel = 0; pixel < selectedMask.length; pixel += 1) {
        if (selectedMask[pixel] || protectedMask?.[pixel] || (operationMask && operationMask[pixel] !== 255))
          continue;
        const offset = pixel * 4;
        let recovered;
        if ((mode | 0) === 1) {
          recovered = recoverReferenceComposite(
            configuration,
            source[offset],
            source[offset + 1],
            source[offset + 2],
            source[offset + 3],
            false,
          );
        } else if ((mode | 0) === 2) {
          const linearRecovery = recoverReferenceLinearAxis(
            configuration,
            source[offset],
            source[offset + 1],
            source[offset + 2],
            source[offset + 3],
            true,
          );
          const compositeRecovery = recoverReferenceComposite(
            configuration,
            source[offset],
            source[offset + 1],
            source[offset + 2],
            source[offset + 3],
            true,
          );
          if (!linearRecovery.valid) recovered = compositeRecovery;
          else if (!compositeRecovery.valid) recovered = linearRecovery;
          else if (linearRecovery.confidence < 0.1 && compositeRecovery.confidence < 0.1) {
            recovered = linearRecovery;
          } else if (linearRecovery.confidence < 0.1) recovered = compositeRecovery;
          else if (compositeRecovery.confidence < 0.1) recovered = linearRecovery;
          else {
            const inverseRatio = 1 - compositeRecovery.ratio;
            const ratioWeight =
              inverseRatio <= 0.15 ? 0 : inverseRatio >= 0.4 ? 1 : (inverseRatio - 0.15) * 4;
            const magnitudeDelta = linearRecovery.magnitude - compositeRecovery.ratio;
            const deltaWeight =
              Math.abs(magnitudeDelta) <= 0.25
                ? 1
                : Math.abs(magnitudeDelta) >= 0.6
                  ? 0
                  : 1 - (Math.abs(magnitudeDelta) - 0.25) / 0.35;
            const adjustedLinearConfidence = linearRecovery.confidence + (1 - ratioWeight) * 0.15;
            const confidenceSum = compositeRecovery.confidence + adjustedLinearConfidence + 0.000001;
            const linearShare = adjustedLinearConfidence / confidenceSum;
            let directionGate = 0;
            if (compositeRecovery.fallback > 0 && magnitudeDelta > 0) directionGate = 1;
            else if (magnitudeDelta > 0.3) {
              directionGate = magnitudeDelta >= 0.5 ? 1 : (magnitudeDelta - 0.3) / 0.2;
            }
            const preliminaryWeight =
              linearShare * (deltaWeight * 0.5 + 0.5) +
              (compositeRecovery.confidence <= linearRecovery.confidence ? 1 : 0) *
                (deltaWeight * -0.5 + 0.5);
            const suppression = compositeRecovery.confidence * ratioWeight * directionGate;
            const linearWeight = preliminaryWeight * (1 - suppression);
            const compositeWeight = 1 - linearWeight;
            const linear = linearRecovery.linear.map(
              (channel, index) => linearWeight * channel + compositeWeight * compositeRecovery.linear[index],
            );
            let recoveredAlpha;
            if (suppression > 0.5) recoveredAlpha = compositeRecovery.alpha;
            else {
              const alphaWeight = ((1 - ratioWeight) * (1 - linearShare) + linearShare) * (1 - suppression);
              if (deltaWeight > 0.5) {
                recoveredAlpha =
                  alphaWeight * linearRecovery.alpha + (1 - alphaWeight) * compositeRecovery.alpha;
              } else {
                const selectedAlpha = alphaWeight >= 0.5 ? linearRecovery.alpha : compositeRecovery.alpha;
                recoveredAlpha =
                  selectedAlpha * 0.6 + Math.min(linearRecovery.alpha, compositeRecovery.alpha) * 0.4;
              }
            }
            recovered = { valid: true, linear, alpha: recoveredAlpha };
          }
        } else {
          recovered = recoverReferenceLinearAxis(
            configuration,
            source[offset],
            source[offset + 1],
            source[offset + 2],
            source[offset + 3],
            false,
          );
        }
        if (!recovered?.valid) continue;
        data[offset] = referenceLinearToSrgb(recovered.linear[0]);
        data[offset + 1] = referenceLinearToSrgb(recovered.linear[1]);
        data[offset + 2] = referenceLinearToSrgb(recovered.linear[2]);
        data[offset + 3] = clamp(Math.trunc(recovered.alpha * 255 + 0.5), 0, 255);
      }
    }

    /**
     * Restores the non-zero-radius boundary produced by reference replacement.
     * @param {Uint8ClampedArray} data Mutable replaced pixels.
     * @param {Uint8ClampedArray|Uint8Array} source Original pixels.
     * @param {number} width Image width.
     * @param {number} height Image height.
     * @param {Uint8Array} selectedMask Replaced pixels.
     * @param {Uint8Array|null} operationMask Optional public mask.
     * @param {Uint8Array|null} protectedMask Protected pixels.
     * @param {object} referenceColor Sampled color.
     * @param {object} replacementColor Replacement color.
     * @param {number} radius Edge radius.
     * @param {number} mode Recovery mode.
     * @param {number} selectionThresholdSquared Squared selection tolerance.
     * @returns {void}
     */
    function restoreReferenceReplacementEdges(
      data,
      source,
      width,
      height,
      selectedMask,
      operationMask,
      protectedMask,
      referenceColor,
      replacementColor,
      radius,
      mode,
      selectionThresholdSquared,
    ) {
      const safeRadius = Math.max(0, Math.min(600, Math.trunc(radius || 0)));
      if (!safeRadius) return;
      const pixelCount = width * height;
      const edgeSource = new Uint8ClampedArray(data);
      const visited = new Uint8Array(pixelCount);
      let frontier = new Uint8Array(pixelCount);
      for (let pixel = 0; pixel < pixelCount; pixel += 1) {
        if (selectedMask[pixel] !== 1) continue;
        const x = pixel % width;
        const y = Math.floor(pixel / width);
        if (
          (x > 0 && !selectedMask[pixel - 1]) ||
          (x + 1 < width && !selectedMask[pixel + 1]) ||
          (y > 0 && !selectedMask[pixel - width]) ||
          (y + 1 < height && !selectedMask[pixel + width])
        )
          frontier[pixel] = 1;
      }
      const referenceLinear = [
        referenceSrgbToLinear(referenceColor.r),
        referenceSrgbToLinear(referenceColor.g),
        referenceSrgbToLinear(referenceColor.b),
      ];
      const replacementLinear = [
        referenceSrgbToLinear(replacementColor.r),
        referenceSrgbToLinear(replacementColor.g),
        referenceSrgbToLinear(replacementColor.b),
      ];
      const linearAxis = referenceLinear.map((channel, index) => channel - replacementLinear[index]);
      const linearAxisLengthSquared = linearAxis.reduce((sum, channel) => sum + channel * channel, 0);
      const halfLinearAxisLengthSquared = linearAxisLengthSquared * 0.5;
      const replacementYcbcr = rgbToReferenceYcbcr(
        replacementColor.r,
        replacementColor.g,
        replacementColor.b,
      );
      let minimumAlpha = replacementColor.a;
      let maximumAlpha = replacementColor.a;
      const alphaDelta = replacementColor.a - referenceColor.a;

      /**
       * Returns the public eight-neighbor minimum alpha among earlier edge layers.
       * @param {number} pixel Pixel index.
       * @returns {number}
       */
      const minimumVisitedNeighborAlpha = (pixel) => {
        const x = pixel % width;
        const y = Math.floor(pixel / width);
        let minimum = Number.POSITIVE_INFINITY;
        for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
          for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
            if (!offsetX && !offsetY) continue;
            const neighborX = x + offsetX;
            const neighborY = y + offsetY;
            if (neighborX < 0 || neighborX >= width || neighborY < 0 || neighborY >= height) continue;
            const neighbor = neighborY * width + neighborX;
            if (!visited[neighbor]) continue;
            const alpha = data[neighbor * 4 + 3];
            if (alpha < minimum) minimum = alpha;
          }
        }
        return Number.isFinite(minimum) ? minimum : 0;
      };

      /**
       * Applies public Alpha bounds and opaque-neighbor recovery.
       * @param {number} pixel Pixel index.
       * @param {number} candidate Candidate alpha.
       * @param {number} layer Current one-based layer.
       * @returns {number}
       */
      const constrainLayerAlpha = (pixel, candidate, layer) => {
        let alpha = clamp(Math.trunc(candidate + 0.5), 0, 255);
        if (alphaDelta > 0) alpha = Math.min(alpha, maximumAlpha);
        else if (alphaDelta < 0) {
          alpha = Math.max(alpha, minimumAlpha);
          const neighborAlpha = minimumVisitedNeighborAlpha(pixel);
          if (neighborAlpha >= 241) {
            const recovered = Math.trunc((layer / safeRadius) * (255 - neighborAlpha) + neighborAlpha + 0.5);
            alpha = Math.max(alpha, recovered);
          }
        }
        return alpha;
      };

      const modeNumber = mode | 0;
      const threshold = Math.max(0, Math.trunc(selectionThresholdSquared || 0));
      const expandedThreshold = Math.min(260100, threshold * 4);
      const thresholdRange = expandedThreshold - threshold;
      if (modeNumber === 0 && thresholdRange <= 0) return;
      if (modeNumber !== 0 && referenceColor.a === replacementColor.a && linearAxisLengthSquared < 0.0001)
        return;

      for (let layer = 1; layer <= safeRadius; layer += 1) {
        const next = new Uint8Array(pixelCount);
        let nextCount = 0;
        for (let pixel = 0; pixel < frontier.length; pixel += 1) {
          if (!frontier[pixel]) continue;
          const x = pixel % width;
          const y = Math.floor(pixel / width);
          const neighbors = [];
          if (x > 0) neighbors.push(pixel - 1);
          if (x + 1 < width) neighbors.push(pixel + 1);
          if (y > 0) neighbors.push(pixel - width);
          if (y + 1 < height) neighbors.push(pixel + width);
          for (const neighbor of neighbors) {
            if (selectedMask[neighbor] || visited[neighbor]) continue;
            if (!next[neighbor]) {
              next[neighbor] = 1;
              nextCount += 1;
            }
          }
        }
        if (!nextCount) break;
        const layerWeight = 1 - (layer - 1) / safeRadius;
        let layerChanged = false;
        let alphaTotal = 0;
        let alphaCount = 0;
        for (let pixel = 0; pixel < next.length; pixel += 1) {
          if (!next[pixel]) continue;
          visited[pixel] = 1;
          const offset = pixel * 4;
          if (modeNumber === 0) {
            const redDelta = edgeSource[offset] - referenceColor.r;
            const greenDelta = edgeSource[offset + 1] - referenceColor.g;
            const blueDelta = edgeSource[offset + 2] - referenceColor.b;
            const distanceSquared = redDelta * redDelta + greenDelta * greenDelta + blueDelta * blueDelta;
            if (distanceSquared > expandedThreshold) {
              if (edgeSource[offset + 3] !== 255) layerChanged = true;
              continue;
            }
            const toleranceWeight =
              distanceSquared > threshold ? 1 - (distanceSquared - threshold) / thresholdRange : 1;
            const influence = toleranceWeight * (1 - (layer - 0.5) / safeRadius) * toleranceWeight;
            data[offset] = clamp(
              Math.trunc(edgeSource[offset] + (replacementColor.r - referenceColor.r) * influence + 0.5),
              0,
              255,
            );
            data[offset + 1] = clamp(
              Math.trunc(edgeSource[offset + 1] + (replacementColor.g - referenceColor.g) * influence + 0.5),
              0,
              255,
            );
            data[offset + 2] = clamp(
              Math.trunc(edgeSource[offset + 2] + (replacementColor.b - referenceColor.b) * influence + 0.5),
              0,
              255,
            );
            data[offset + 3] = clamp(
              Math.trunc(edgeSource[offset + 3] + alphaDelta * influence + 0.5),
              0,
              255,
            );
            layerChanged = true;
            continue;
          }
          if (linearAxisLengthSquared < 0.0001) {
            data[offset + 3] = constrainLayerAlpha(
              pixel,
              edgeSource[offset + 3] + layerWeight * alphaDelta,
              layer,
            );
            layerChanged = true;
            alphaTotal += data[offset + 3];
            alphaCount += 1;
            continue;
          }
          const pixelLinear = [
            referenceSrgbToLinear(edgeSource[offset]),
            referenceSrgbToLinear(edgeSource[offset + 1]),
            referenceSrgbToLinear(edgeSource[offset + 2]),
          ];
          const relative = pixelLinear.map((channel, index) => channel - replacementLinear[index]);
          const projection =
            relative.reduce((sum, channel, index) => sum + channel * linearAxis[index], 0) /
            linearAxisLengthSquared;
          let confidence = 0;
          if (projection > 0.01) {
            if (modeNumber === 2) confidence = 1;
            else {
              const residual = relative.map((channel, index) => channel - projection * linearAxis[index]);
              const residualSquared = residual.reduce((sum, channel) => sum + channel * channel, 0);
              if (residualSquared < halfLinearAxisLengthSquared) {
                confidence = 1 - residualSquared / halfLinearAxisLengthSquared;
              }
            }
          }
          if (projection <= 0.01 || confidence <= 0) {
            alphaTotal += data[offset + 3];
            alphaCount += 1;
            continue;
          }
          const magnitude = Math.min(1, projection) * confidence;
          if (modeNumber === 2) {
            const colorInfluence = layerWeight * Math.sqrt(Math.min(1, projection));
            const converted = rgbToReferenceYcbcr(
              edgeSource[offset],
              edgeSource[offset + 1],
              edgeSource[offset + 2],
            );
            const recovered = referenceYcbcrToRgb(
              converted.y,
              colorInfluence * (replacementYcbcr.cb - converted.cb) + converted.cb,
              colorInfluence * (replacementYcbcr.cr - converted.cr) + converted.cr,
            );
            data[offset] = recovered.r;
            data[offset + 1] = recovered.g;
            data[offset + 2] = recovered.b;
            const alphaCandidate =
              projection < 0.3 ? 255 : edgeSource[offset + 3] + colorInfluence * alphaDelta;
            data[offset + 3] = constrainLayerAlpha(pixel, alphaCandidate, layer);
          } else {
            let taper = 1;
            if (linearAxisLengthSquared >= 0.0001 && safeRadius > 2 && layer > safeRadius * 0.7) {
              taper = Math.max(0.2, Math.min(1, (safeRadius - layer) / (safeRadius * 0.3)));
            }
            const colorScale = magnitude * -taper;
            for (let channel = 0; channel < 3; channel += 1) {
              data[offset + channel] = referenceLinearToSrgb(
                clamp(pixelLinear[channel] + colorScale * linearAxis[channel], 0, 1),
              );
            }
            data[offset + 3] = constrainLayerAlpha(
              pixel,
              edgeSource[offset + 3] + layerWeight * magnitude * alphaDelta,
              layer,
            );
          }
          layerChanged = true;
          alphaTotal += data[offset + 3];
          alphaCount += 1;
        }
        if (modeNumber !== 0 && alphaCount > 0) {
          const averageAlpha = Math.trunc(alphaTotal / alphaCount);
          if (alphaDelta > 0) {
            const blendedMaximum = Math.trunc((maximumAlpha * 2 + averageAlpha) / 3);
            maximumAlpha = Math.min(maximumAlpha, blendedMaximum);
          } else if (alphaDelta < 0) {
            const blendedMinimum = Math.trunc((replacementColor.a * 2 + averageAlpha) / 3);
            minimumAlpha = Math.max(minimumAlpha, blendedMinimum);
          }
        }
        frontier = next;
        if (modeNumber !== 0 && !layerChanged) break;
      }
    }

    /**
     * Runs the shared post-selection replacement pipeline used by kernels 07 and 13.
     * @param {Uint8ClampedArray|Uint8Array} source Original RGBA pixels.
     * @param {number} width Image width.
     * @param {number} height Image height.
     * @param {Uint8Array} selectedMask Selected pixels.
     * @param {object} referenceColor Reference color.
     * @param {object} replacementColor Replacement color.
     * @param {object} options Pipeline options.
     * @param {number} selectionThresholdSquared Squared selection tolerance.
     * @returns {Uint8ClampedArray}
     */
    function applyReferenceReplacementPipeline(
      source,
      width,
      height,
      selectedMask,
      referenceColor,
      replacementColor,
      options,
      selectionThresholdSquared,
    ) {
      const operationMask = options.mask || null;
      const protectedMask = createReferenceProtectionMask(
        source,
        width,
        height,
        referenceColor,
        options.protectColors || [],
      );
      const output = new Uint8ClampedArray(source);
      for (let pixel = 0; pixel < width * height; pixel += 1) {
        if (!selectedMask[pixel] || (operationMask && operationMask[pixel] !== 255) || protectedMask?.[pixel])
          continue;
        const offset = pixel * 4;
        output[offset] = replacementColor.r;
        output[offset + 1] = replacementColor.g;
        output[offset + 2] = replacementColor.b;
        output[offset + 3] = replacementColor.a;
      }
      applyReferenceBlendRecovery(
        output,
        source,
        selectedMask,
        operationMask,
        protectedMask,
        referenceColor,
        replacementColor,
        options.blendStrength,
        options.despillMode,
        options.despillRefColor || null,
      );
      applyReferenceAlphaThresholds(
        output,
        operationMask,
        options.alphaThresholdHigh,
        options.alphaThresholdLow,
      );
      restoreReferenceReplacementEdges(
        output,
        source,
        width,
        height,
        selectedMask,
        operationMask,
        protectedMask,
        referenceColor,
        replacementColor,
        options.edgeRestoreRadius,
        options.edgeRestoreMode,
        selectionThresholdSquared,
      );
      applyReferenceDirectionalDespill(
        output,
        selectedMask,
        operationMask,
        protectedMask,
        options.despillRefColor || referenceColor,
        options.despillStrength,
      );
      if (protectedMask) {
        for (let pixel = 0; pixel < protectedMask.length; pixel += 1) {
          if (!protectedMask[pixel]) continue;
          const offset = pixel * 4;
          output.set(source.subarray(offset, offset + 4), offset);
        }
      }
      return output;
    }

    return {
      applyReferenceAlphaThresholds,
      applyReferenceBlendRecovery,
      applyReferenceDirectionalDespill,
      applyReferenceReplacementPipeline,
      createReferenceBlendConfiguration,
      recoverReferenceComposite,
      recoverReferenceLinearAxis,
      restoreReferenceReplacementEdges,
    };
  }

  return { createReferenceRecoveryPipeline };
});
