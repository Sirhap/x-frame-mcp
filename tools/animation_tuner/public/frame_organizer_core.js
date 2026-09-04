(function attachFrameOrganizerCore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.FrameOrganizerCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  /**
   * Keeps a number inside an inclusive range.
   * @param {number} value Candidate value.
   * @param {number} minimum Inclusive minimum.
   * @param {number} maximum Inclusive maximum.
   * @returns {number}
   */
  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, Number(value || 0)));
  }

  const REFERENCE_SAMPLE_SIZE = 256;
  const ORGANIZER_SIMILARITY_THRESHOLD = Object.freeze({ min: 55, max: 100, fallback: 88 });
  const BACKGROUND_CORNER_SIZE = 16;
  const BACKGROUND_SATURATION = 0.15;
  const BACKGROUND_HUE_TOLERANCE = 15;
  const BACKGROUND_ALPHA_THRESHOLD = 65;

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
   * Converts an RGB triplet to HSV using the same branch order as the reference client.
   * @param {number} red Red channel.
   * @param {number} green Green channel.
   * @param {number} blue Blue channel.
   * @returns {{h:number,s:number,v:number}}
   */
  function rgbToHsv(red, green, blue) {
    const normalizedRed = red / 255;
    const normalizedGreen = green / 255;
    const normalizedBlue = blue / 255;
    const maximum = Math.max(normalizedRed, normalizedGreen, normalizedBlue);
    const delta = maximum - Math.min(normalizedRed, normalizedGreen, normalizedBlue);
    let hue = 0;
    if (delta !== 0) {
      if (maximum === normalizedRed) hue = 60 * (((normalizedGreen - normalizedBlue) / delta) % 6);
      else if (maximum === normalizedGreen) hue = 60 * ((normalizedBlue - normalizedRed) / delta + 2);
      else hue = 60 * ((normalizedRed - normalizedGreen) / delta + 4);
      if (hue < 0) hue += 360;
    }
    return { h: hue, s: maximum === 0 ? 0 : delta / maximum, v: maximum };
  }

  /**
   * Returns the shortest circular hue distance in degrees.
   * @param {number} left First hue.
   * @param {number} right Second hue.
   * @returns {number}
   */
  function hueDistance(left, right) {
    let difference = Math.abs(left - right) % 360;
    if (difference > 180) difference = 360 - difference;
    return difference;
  }

  /**
   * Calculates the circular mean of hue angles.
   * @param {number[]} hues Hue values in degrees.
   * @returns {number}
   */
  function circularMean(hues) {
    let sine = 0;
    let cosine = 0;
    hues.forEach((hue) => {
      const radians = (hue * Math.PI) / 180;
      sine += Math.sin(radians);
      cosine += Math.cos(radians);
    });
    return ((Math.atan2(sine, cosine) * 180) / Math.PI + 360) % 360;
  }

  /**
   * Calculates circular hue dispersion in degrees.
   * @param {number[]} hues Hue values in degrees.
   * @returns {number}
   */
  function circularDeviation(hues) {
    if (!hues.length) return 0;
    let sine = 0;
    let cosine = 0;
    hues.forEach((hue) => {
      const radians = (hue * Math.PI) / 180;
      sine += Math.sin(radians);
      cosine += Math.cos(radians);
    });
    const resultant = Math.sqrt((sine / hues.length) ** 2 + (cosine / hues.length) ** 2);
    return resultant >= 1 ? 0 : (Math.sqrt(-2 * Math.log(resultant)) * 180) / Math.PI;
  }

  /**
   * Normalizes legacy typed arrays and reference frame samples.
   * @param {object|Uint8Array|Uint8ClampedArray} signature Frame sample.
   * @returns {{data:Uint8Array|Uint8ClampedArray,width:number,height:number}|null}
   */
  function normalizeSignature(signature) {
    if (signature?.data && Number.isFinite(signature.width) && Number.isFinite(signature.height)) {
      return signature;
    }
    if (!ArrayBuffer.isView(signature) || signature.length < 4 || signature.length % 4 !== 0) return null;
    return { data: signature, width: signature.length / 4, height: 1 };
  }

  /**
   * Samples one corner block in HSV and alpha space.
   * @param {{data:Uint8Array|Uint8ClampedArray,width:number,height:number}} signature Frame sample.
   * @param {number} startX Block X origin.
   * @param {number} startY Block Y origin.
   * @param {number} size Block size.
   * @returns {{h:number,s:number,v:number,a:number}}
   */
  function sampleCorner(signature, startX, startY, size) {
    let hueSine = 0;
    let hueCosine = 0;
    let saturation = 0;
    let value = 0;
    let alpha = 0;
    let samples = 0;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const offset = ((startY + y) * signature.width + startX + x) * 4;
        const hsv = rgbToHsv(signature.data[offset], signature.data[offset + 1], signature.data[offset + 2]);
        const radians = (hsv.h * Math.PI) / 180;
        hueSine += Math.sin(radians);
        hueCosine += Math.cos(radians);
        saturation += hsv.s;
        value += hsv.v;
        alpha += signature.data[offset + 3];
        samples += 1;
      }
    }
    if (!samples) return { h: 0, s: 0, v: 0, a: 0 };
    return {
      h: ((Math.atan2(hueSine / samples, hueCosine / samples) * 180) / Math.PI + 360) % 360,
      s: saturation / samples,
      v: value / samples,
      a: alpha / samples,
    };
  }

  /**
   * Returns the four reference corner descriptors.
   * @param {{data:Uint8Array|Uint8ClampedArray,width:number,height:number}} signature Frame sample.
   * @returns {Array<{h:number,s:number,v:number,a:number}>}
   */
  function frameCorners(signature) {
    const size = Math.min(BACKGROUND_CORNER_SIZE, signature.width, signature.height);
    return [
      sampleCorner(signature, 0, 0, size),
      sampleCorner(signature, signature.width - size, 0, size),
      sampleCorner(signature, 0, signature.height - size, size),
      sampleCorner(signature, signature.width - size, signature.height - size, size),
    ];
  }

  /**
   * Detects whether a sequence has a stable removable corner background.
   * @param {Array<object|Uint8Array|Uint8ClampedArray>} signatures Frame samples.
   * @returns {{enabled:boolean}|null}
   */
  function detectStableBackground(signatures) {
    if (!Array.isArray(signatures) || signatures.length < 2) return null;
    const indexes =
      signatures.length <= 5
        ? Array.from({ length: signatures.length }, (_, index) => index)
        : [
            0,
            Math.floor(signatures.length * 0.25),
            Math.floor(signatures.length * 0.5),
            Math.floor(signatures.length * 0.75),
            signatures.length - 1,
          ];
    const corners = [];
    for (const index of indexes) {
      const signature = normalizeSignature(signatures[index]);
      if (!signature) return null;
      corners.push(...frameCorners(signature));
    }
    if (!corners.length) return null;
    const colored = corners.filter((corner) => corner.s >= BACKGROUND_SATURATION);
    const gray = corners.filter((corner) => corner.s < BACKGROUND_SATURATION);
    if (colored.length / corners.length >= 0.6) {
      return circularDeviation(colored.map((corner) => corner.h)) < BACKGROUND_HUE_TOLERANCE
        ? { enabled: true }
        : null;
    }
    return gray.length / corners.length >= 0.6 ? { enabled: true } : null;
  }

  /**
   * Builds the per-frame background mask used by the reference comparator.
   * @param {{data:Uint8Array|Uint8ClampedArray,width:number,height:number}} signature Frame sample.
   * @param {{enabled:boolean}|null} background Stable sequence background marker.
   * @returns {Uint8Array|null}
   */
  function createBackgroundMask(signature, background) {
    if (!background?.enabled) return null;
    const corners = frameCorners(signature);
    const colored = corners.filter((corner) => corner.s >= BACKGROUND_SATURATION);
    const gray = corners.filter((corner) => corner.s < BACKGROUND_SATURATION);
    let descriptor = { type: "none" };
    if (colored.length >= 3) {
      const hues = colored.map((corner) => corner.h);
      if (circularDeviation(hues) < BACKGROUND_HUE_TOLERANCE) {
        descriptor = { type: "color", hue: circularMean(hues) };
      }
    } else if (gray.length >= 3) {
      const alphas = gray.map((corner) => corner.a).sort((left, right) => left - right);
      descriptor = { type: "gray", alpha: alphas[Math.floor(alphas.length / 2)] };
    }
    if (descriptor.type === "none") return null;
    const mask = new Uint8Array(signature.width * signature.height);
    for (let pixel = 0; pixel < mask.length; pixel += 1) {
      const offset = pixel * 4;
      const alpha = signature.data[offset + 3];
      if (alpha < BACKGROUND_ALPHA_THRESHOLD) {
        mask[pixel] = 1;
        continue;
      }
      const hsv = rgbToHsv(signature.data[offset], signature.data[offset + 1], signature.data[offset + 2]);
      if (descriptor.type === "color") {
        if (hsv.s >= BACKGROUND_SATURATION && hueDistance(hsv.h, descriptor.hue) < BACKGROUND_HUE_TOLERANCE)
          mask[pixel] = 1;
      } else if (hsv.s < BACKGROUND_SATURATION && Math.abs(alpha - descriptor.alpha) < 100) {
        mask[pixel] = 1;
      }
    }
    return mask;
  }

  /**
   * Stores a reference-size RGBA frame sample. Resizing is intentionally performed by Canvas in the UI.
   * @param {Uint8ClampedArray|Uint8Array} data RGBA pixels.
   * @param {number} width Image width.
   * @param {number} height Image height.
   * @returns {{data:Uint8ClampedArray,width:number,height:number}}
   */
  function createSignature(data, width, height) {
    const safeWidth = Math.max(1, Math.round(width));
    const safeHeight = Math.max(1, Math.round(height));
    if (!data || data.length !== safeWidth * safeHeight * 4) {
      throw new RangeError("Frame signature RGBA length does not match its dimensions.");
    }
    return { data: new Uint8ClampedArray(data), width: safeWidth, height: safeHeight };
  }

  /**
   * Calculates the reference premultiplied-alpha similarity in the range 0-100.
   * @param {object|Uint8Array|Uint8ClampedArray} left First frame sample.
   * @param {object|Uint8Array|Uint8ClampedArray} right Second frame sample.
   * @param {{enabled:boolean}|null} [background=null] Stable sequence background marker.
   * @param {Uint8Array|null} [leftMask=null] Optional cached left background mask.
   * @param {Uint8Array|null} [rightMask=null] Optional cached right background mask.
   * @returns {number}
   */
  function signatureSimilarity(left, right, background = null, leftMask = null, rightMask = null) {
    const leftSignature = normalizeSignature(left);
    const rightSignature = normalizeSignature(right);
    if (!leftSignature || !rightSignature || leftSignature.data.length !== rightSignature.data.length)
      return 0;
    const useBackground = background?.enabled;
    const resolvedLeftMask = useBackground
      ? (leftMask ?? createBackgroundMask(leftSignature, background))
      : null;
    const resolvedRightMask = useBackground
      ? (rightMask ?? createBackgroundMask(rightSignature, background))
      : null;
    let squaredError = 0;
    let comparedPixels = 0;
    for (let offset = 0, pixel = 0; offset < leftSignature.data.length; offset += 4, pixel += 1) {
      if (resolvedLeftMask?.[pixel] && resolvedRightMask?.[pixel]) continue;
      const leftAlphaByte = leftSignature.data[offset + 3];
      const rightAlphaByte = rightSignature.data[offset + 3];
      if (
        useBackground &&
        leftAlphaByte < BACKGROUND_ALPHA_THRESHOLD &&
        rightAlphaByte < BACKGROUND_ALPHA_THRESHOLD
      )
        continue;
      const leftWeight = smoothstep(0, 40, leftAlphaByte);
      const rightWeight = smoothstep(0, 40, rightAlphaByte);
      if (!useBackground && leftWeight === 0 && rightWeight === 0) continue;
      comparedPixels += 1;
      const leftAlpha = leftAlphaByte / 255;
      const rightAlpha = rightAlphaByte / 255;
      const redDifference = leftSignature.data[offset] * leftAlpha - rightSignature.data[offset] * rightAlpha;
      const greenDifference =
        leftSignature.data[offset + 1] * leftAlpha - rightSignature.data[offset + 1] * rightAlpha;
      const blueDifference =
        leftSignature.data[offset + 2] * leftAlpha - rightSignature.data[offset + 2] * rightAlpha;
      const alphaWeightDifference = leftWeight - rightWeight;
      squaredError +=
        leftWeight * rightWeight * ((redDifference ** 2 + greenDifference ** 2 + blueDifference ** 2) / 3) +
        alphaWeightDifference ** 2 * 255 ** 2 * 0.25;
    }
    if (!comparedPixels) return 100;
    return (1 - Math.sqrt(squaredError / comparedPixels) / 255) * 100;
  }

  /**
   * Creates one sequence comparator with stable-background detection and mask caching.
   * @param {Array<object|Uint8Array|Uint8ClampedArray>} signatures Frame samples.
   * @returns {(left:object|Uint8Array|Uint8ClampedArray,right:object|Uint8Array|Uint8ClampedArray)=>number}
   */
  function createSequenceComparator(signatures) {
    const background = detectStableBackground(signatures);
    const masks = new Map();
    const maskFor = (signature) => {
      if (!background) return null;
      if (!masks.has(signature))
        masks.set(signature, createBackgroundMask(normalizeSignature(signature), background));
      return masks.get(signature);
    };
    return (left, right) => signatureSimilarity(left, right, background, maskFor(left), maskFor(right));
  }

  /**
   * Creates a reusable, ordered sequence comparison context.
   * Background detection and per-frame masks are prepared once; calculated frame-pair
   * similarities are memoized by their two indexes. Reuse one context only while its
   * ordered source signatures remain unchanged.
   * @param {Array<object|Uint8Array|Uint8ClampedArray>} signatures Ordered frame samples.
   * @returns {{compareIndexes:(leftIndex:number,rightIndex:number)=>number,getComparisonCount:()=>number}}
   */
  function createSequenceAnalysisContext(signatures) {
    const source = Array.isArray(signatures) ? signatures : [];
    const compare = createSequenceComparator(source);
    const pairSimilarities = new Map();
    let comparisonCount = 0;
    const isValidIndex = (index) => Number.isInteger(index) && index >= 0 && index < source.length;
    return {
      /**
       * Compares two frame indexes and reuses an already calculated unordered pair.
       * @param {number} leftIndex Left frame index.
       * @param {number} rightIndex Right frame index.
       * @returns {number} Similarity in the range 0-100.
       */
      compareIndexes(leftIndex, rightIndex) {
        if (!isValidIndex(leftIndex) || !isValidIndex(rightIndex)) return 0;
        if (leftIndex === rightIndex) return 100;
        const first = Math.min(leftIndex, rightIndex);
        const second = Math.max(leftIndex, rightIndex);
        const key = `${first}:${second}`;
        if (pairSimilarities.has(key)) return pairSimilarities.get(key);
        const similarity = compare(source[first], source[second]);
        pairSimilarities.set(key, similarity);
        comparisonCount += 1;
        return similarity;
      },
      /**
       * Returns how many unique frame pairs required pixel-level comparison.
       * @returns {number}
       */
      getComparisonCount() {
        return comparisonCount;
      },
    };
  }

  /**
   * True when auto-adjust would mark a regular translation stride (every other
   * walk card, or a dense 1-step hold of most of the clip). That is motion, not duplicates.
   * @param {number[]} indexes Marked frame indexes.
   * @param {number} frameCount Sequence length.
   * @returns {boolean} Whether the marks look like a uniform walk.
   */
  function isUniformTranslationStride(indexes, frameCount) {
    if (!Array.isArray(indexes) || indexes.length < 3 || frameCount < 4) return false;
    const gaps = [];
    for (let index = 1; index < indexes.length; index += 1) {
      gaps.push(indexes[index] - indexes[index - 1]);
    }
    if (!gaps.length || !gaps.every((gap) => gap === gaps[0] && gap >= 1)) return false;
    return indexes.length >= Math.floor((frameCount - 1) / 2);
  }

  /**
   * Runs ordered duplicate-frame analysis with a persistent non-duplicate anchor.
   * This avoids deleting a whole slow transition merely because adjacent frames are similar.
   * @param {Uint8Array[]} signatures Ordered signatures.
   * @param {number} threshold Similarity threshold in the range 0-100.
   * @param {{compareIndexes:(leftIndex:number,rightIndex:number)=>number}} [context] Reusable ordered comparison context.
   * @returns {{matches:Array<{index:number,matchIndex:number,similarity:number,anchorSimilarity:number}>,autoAdjustedThreshold:number|null}}
   */
  function analyzeDuplicateFrames(signatures, threshold, context = null) {
    const requestedThreshold = clamp(threshold, 0, 100);
    if (!Array.isArray(signatures) || signatures.length < 3) {
      return { matches: [], autoAdjustedThreshold: null };
    }
    const compare = context?.compareIndexes || createSequenceAnalysisContext(signatures).compareIndexes;
    const matches = [];
    const comparisons = [];
    let anchorIndex = 0;
    for (let index = 1; index < signatures.length; index += 1) {
      const similarity = compare(index - 1, index);
      const anchorSimilarity = compare(anchorIndex, index);
      comparisons.push({ index, matchIndex: anchorIndex, similarity, anchorSimilarity });
      if (similarity >= requestedThreshold && anchorSimilarity >= requestedThreshold) {
        matches.push({ index, matchIndex: anchorIndex, similarity, anchorSimilarity });
      } else {
        anchorIndex = index;
      }
    }
    if (matches.length || !comparisons.length) {
      return { matches, autoAdjustedThreshold: null };
    }
    const strongestSimilarity = Math.max(...comparisons.map((entry) => entry.similarity));
    const adjustedThreshold = Math.floor(strongestSimilarity);
    if (
      adjustedThreshold <= ORGANIZER_SIMILARITY_THRESHOLD.min ||
      adjustedThreshold >= requestedThreshold
    ) {
      return { matches, autoAdjustedThreshold: null };
    }
    const adjustedMatches = [];
    let adjustedAnchorIndex = 0;
    for (let index = 1; index < signatures.length; index += 1) {
      const similarity = compare(index - 1, index);
      const anchorSimilarity = compare(adjustedAnchorIndex, index);
      if (similarity >= adjustedThreshold && anchorSimilarity >= adjustedThreshold) {
        adjustedMatches.push({
          index,
          matchIndex: adjustedAnchorIndex,
          similarity,
          anchorSimilarity,
        });
      } else {
        adjustedAnchorIndex = index;
      }
    }
    const adjustedIndexes = adjustedMatches.map((entry) => entry.index);
    if (isUniformTranslationStride(adjustedIndexes, signatures.length)) {
      return { matches: [], autoAdjustedThreshold: null };
    }
    return {
      matches: adjustedMatches,
      autoAdjustedThreshold: adjustedThreshold,
    };
  }

  /**
   * Finds redundant frames while preserving the historical array return type.
   * @param {Uint8Array[]} signatures Ordered signatures.
   * @param {number} threshold Similarity threshold in the range 0-100.
   * @returns {Array<{index:number,matchIndex:number,similarity:number,anchorSimilarity:number}>}
   */
  function findDuplicateFrames(signatures, threshold) {
    return analyzeDuplicateFrames(signatures, threshold).matches;
  }

  /**
   * Runs three-frame jump analysis using bridge similarity minus the weaker neighbor transition.
   * @param {Uint8Array[]} signatures Ordered signatures.
   * @param {number} threshold Sensitivity expressed as similarity in the range 0-100.
   * @param {{compareIndexes:(leftIndex:number,rightIndex:number)=>number}} [context] Reusable ordered comparison context.
   * @returns {{matches:Array<{index:number,previousSimilarity:number,nextSimilarity:number,bridgeSimilarity:number,score:number}>,autoAdjustedThreshold:number|null}}
   */
  function analyzeJumpFrames(signatures, threshold, context = null) {
    const requestedThreshold = clamp(threshold, 0, 100);
    if (!Array.isArray(signatures) || signatures.length < 3) {
      return { matches: [], autoAdjustedThreshold: null };
    }
    const compare = context?.compareIndexes || createSequenceAnalysisContext(signatures).compareIndexes;
    const comparisons = [];
    for (let index = 1; index < signatures.length - 1; index += 1) {
      const previousSimilarity = compare(index - 1, index);
      const nextSimilarity = compare(index, index + 1);
      const bridgeSimilarity = compare(index - 1, index + 1);
      const score = bridgeSimilarity - Math.min(previousSimilarity, nextSimilarity);
      if (score > 0) {
        comparisons.push({
          index,
          previousSimilarity,
          nextSimilarity,
          bridgeSimilarity,
          score,
        });
      }
    }
    const minimumScore = 100 - requestedThreshold;
    const matches = comparisons.filter((entry) => entry.score >= minimumScore);
    if (matches.length || !comparisons.length) {
      return { matches, autoAdjustedThreshold: null };
    }
    const strongestScore = Math.max(...comparisons.map((entry) => entry.score));
    const adjustedThreshold = Math.ceil(100 - strongestScore);
    if (adjustedThreshold <= requestedThreshold || adjustedThreshold > 100) {
      return { matches, autoAdjustedThreshold: null };
    }
    return {
      matches: comparisons.filter((entry) => entry.score >= 100 - adjustedThreshold),
      autoAdjustedThreshold: adjustedThreshold,
    };
  }

  /**
   * Finds isolated jump frames while preserving the historical array return type.
   * @param {Uint8Array[]} signatures Ordered signatures.
   * @param {number} threshold Sensitivity expressed as similarity in the range 0-100.
   * @returns {Array<{index:number,previousSimilarity:number,nextSimilarity:number,bridgeSimilarity:number,score:number}>}
   */
  function findJumpFrames(signatures, threshold) {
    return analyzeJumpFrames(signatures, threshold).matches;
  }

  /**
   * Returns the compact upper-triangle index for a frame pair.
   * @param {number} left Left frame index.
   * @param {number} right Right frame index.
   * @param {number} total Frame count.
   * @returns {number}
   */
  function similarityMatrixIndex(left, right, total) {
    return left * total - (left * (left + 1)) / 2 + (right - left - 1);
  }

  /**
   * Reads a normalized similarity value from a compact self-similarity matrix.
   * @param {Float32Array} matrix Compact upper-triangle matrix.
   * @param {number} left Left frame index.
   * @param {number} right Right frame index.
   * @param {number} total Frame count.
   * @returns {number}
   */
  function matrixSimilarity(matrix, left, right, total) {
    if (left === right) return 1;
    if (left > right) return matrixSimilarity(matrix, right, left, total);
    return matrix[similarityMatrixIndex(left, right, total)];
  }

  /**
   * Builds the complete frame self-similarity matrix.
   * @param {Uint8Array[]} signatures Ordered signatures.
   * @returns {Float32Array}
   */
  function createSimilarityMatrix(signatures) {
    const total = signatures.length;
    const matrix = new Float32Array((total * (total - 1)) / 2);
    const compare = createSequenceComparator(signatures);
    for (let left = 0; left < total - 1; left += 1) {
      for (let right = left + 1; right < total; right += 1) {
        matrix[similarityMatrixIndex(left, right, total)] =
          compare(signatures[left], signatures[right]) / 100;
      }
    }
    return matrix;
  }

  /**
   * Calculates average self-similarity for each temporal offset.
   * @param {Float32Array} matrix Compact self-similarity matrix.
   * @param {number} total Frame count.
   * @param {number} maximumPeriod Largest temporal offset to evaluate.
   * @returns {Float32Array}
   */
  function calculateAutocorrelation(matrix, total, maximumPeriod) {
    const autocorrelation = new Float32Array(maximumPeriod + 1);
    autocorrelation[0] = 1;
    for (let period = 1; period <= maximumPeriod; period += 1) {
      let score = 0;
      let count = 0;
      for (let index = 0; index <= total - 1 - period; index += 1) {
        score += matrixSimilarity(matrix, index, index + period, total);
        count += 1;
      }
      autocorrelation[period] = count ? score / count : 0;
    }
    return autocorrelation;
  }

  /**
   * Extracts local autocorrelation peaks above their convex baseline.
   * @param {Float32Array} autocorrelation Period scores.
   * @param {number} minimumPeriod Smallest period.
   * @param {number} maximumPeriod Largest period.
   * @returns {Array<{period:number,acfScore:number}>}
   */
  function findAutocorrelationPeaks(autocorrelation, minimumPeriod, maximumPeriod) {
    const hull = [];
    for (let period = minimumPeriod; period <= maximumPeriod; period += 1) {
      while (hull.length >= 2) {
        const first = hull[hull.length - 2];
        const second = hull[hull.length - 1];
        const cross =
          (second.period - first.period) * (autocorrelation[period] - first.value) -
          (period - first.period) * (second.value - first.value);
        if (cross > 0) break;
        hull.pop();
      }
      hull.push({ period, value: autocorrelation[period] });
    }
    const baseline = new Float32Array(autocorrelation.length);
    let segment = 0;
    for (let period = minimumPeriod; period <= maximumPeriod; period += 1) {
      while (segment < hull.length - 1 && hull[segment + 1].period <= period) segment += 1;
      const left = hull[segment];
      const right = hull[Math.min(segment + 1, hull.length - 1)];
      const width = right.period - left.period;
      baseline[period] =
        width > 0 ? left.value + ((right.value - left.value) * (period - left.period)) / width : left.value;
    }
    const peaks = [];
    for (let period = minimumPeriod; period <= maximumPeriod; period += 1) {
      const normalized = baseline[period] > 0 ? autocorrelation[period] / baseline[period] : 0;
      if (normalized <= 1) continue;
      const previous =
        period > minimumPeriod
          ? autocorrelation[period - 1] / Math.max(Number.EPSILON, baseline[period - 1])
          : -Infinity;
      const next =
        period < maximumPeriod
          ? autocorrelation[period + 1] / Math.max(Number.EPSILON, baseline[period + 1])
          : -Infinity;
      if (normalized >= previous && normalized >= next) {
        peaks.push({ period, acfScore: autocorrelation[period] });
      }
    }
    return peaks.sort((left, right) => right.acfScore - left.acfScore);
  }

  /**
   * Applies the short/long loop preference without excluding valid periods.
   * @param {number} period Candidate period.
   * @param {number} minimumPeriod Smallest period.
   * @param {number} maximumPeriod Largest period.
   * @param {"auto"|"short"|"long"} preference Ranking preference.
   * @returns {number}
   */
  function loopPreferenceWeight(period, minimumPeriod, maximumPeriod, preference) {
    if (preference !== "short" && preference !== "long") return 1;
    const position = (period - minimumPeriod) / Math.max(1, maximumPeriod - minimumPeriod);
    return preference === "short" ? 1 - 0.3 * position : 0.7 + 0.3 * position;
  }

  /**
   * Scores loop candidates from a completed self-similarity matrix.
   * @param {Float32Array} matrix Compact self-similarity matrix.
   * @param {number} total Frame count.
   * @param {{minPeriod?:number,maxPeriod?:number,startFrame?:number,preference?:"auto"|"short"|"long",boundaryFactor?:number}} [options] Search options.
   * @returns {Array<{id:string,start:number,end:number,startIdx:number,endIdx:number,length:number,period:number,acfScore:number,smoothness:number,coverage:number,similarity:number,score:number,rankScore:number}>}
   */
  function scoreLoopCandidates(matrix, total, options = {}) {
    if (total < 4) return [];
    const minimumPeriod = Math.max(2, Math.round(options.minPeriod ?? 2));
    const maximumPeriod = Math.min(total - 1, Math.round(options.maxPeriod ?? Math.floor((2 * total) / 3)));
    const startFrame = Math.max(0, Math.round(options.startFrame ?? 0));
    const preference = ["short", "long"].includes(options.preference) ? options.preference : "auto";
    const boundaryFactor = clamp(options.boundaryFactor ?? 0.85, 0, 1);
    if (maximumPeriod < minimumPeriod) return [];
    const autocorrelation = calculateAutocorrelation(matrix, total, Math.min(maximumPeriod + 1, total - 1));
    const peaks = findAutocorrelationPeaks(autocorrelation, minimumPeriod, maximumPeriod);
    const distinctPeaks = [];
    peaks.forEach((peak) => {
      if (!distinctPeaks.some((entry) => Math.abs(entry.period - peak.period) <= 2)) {
        distinctPeaks.push(peak);
      }
    });
    const candidates = [];
    distinctPeaks.forEach(({ period, acfScore }) => {
      const boundaryThreshold = acfScore * boundaryFactor;
      const possibleStarts = [];
      for (let index = 0; index <= total - 1 - period; index += 1) {
        if (matrixSimilarity(matrix, index, index + period, total) >= boundaryThreshold) {
          possibleStarts.push(index);
        }
      }
      if (possibleStarts.length < period / 2) return;
      const eligibleStarts = possibleStarts.filter((index) => index >= startFrame);
      if (!eligibleStarts.length) return;
      let bestStart = eligibleStarts[0];
      let smoothness = -1;
      eligibleStarts.forEach((index) => {
        const seamSimilarity = matrixSimilarity(matrix, index, index + period - 1, total);
        if (seamSimilarity > smoothness) {
          bestStart = index;
          smoothness = seamSimilarity;
        }
      });
      const end = bestStart + period - 1;
      if (end < bestStart) return;
      const coverage = period / total;
      const score = acfScore * smoothness;
      const rankScore = score * loopPreferenceWeight(period, minimumPeriod, maximumPeriod, preference);
      candidates.push({
        id: `loop-${period}-${bestStart}-${end}`,
        start: bestStart,
        end,
        startIdx: bestStart,
        endIdx: end,
        length: end - bestStart + 1,
        period,
        acfScore,
        smoothness,
        coverage,
        similarity: smoothness * 100,
        score,
        rankScore,
      });
    });
    return candidates.sort((left, right) => right.rankScore - left.rankScore).slice(0, 6);
  }

  /**
   * Finds ranked loop candidates synchronously.
   * @param {Uint8Array[]} signatures Ordered signatures.
   * @param {{minPeriod?:number,maxPeriod?:number,startFrame?:number,preference?:"auto"|"short"|"long",boundaryFactor?:number}} [options] Search options.
   * @returns {Array<object>}
   */
  function findLoopCandidates(signatures, options = {}) {
    if (!Array.isArray(signatures) || signatures.length < 4) return [];
    return scoreLoopCandidates(createSimilarityMatrix(signatures), signatures.length, options);
  }

  /**
   * Finds ranked loop candidates while yielding between matrix rows.
   * @param {Uint8Array[]} signatures Ordered signatures.
   * @param {{minPeriod?:number,maxPeriod?:number,startFrame?:number,preference?:"auto"|"short"|"long",boundaryFactor?:number}} [options] Search options.
   * @param {{onProgress?:(current:number,total:number)=>void,isCancelled?:()=>boolean}} [callbacks] Runtime callbacks.
   * @returns {Promise<Array<object>>}
   */
  async function findLoopCandidatesAsync(signatures, options = {}, callbacks = {}) {
    if (!Array.isArray(signatures) || signatures.length < 4) return [];
    const total = signatures.length;
    const progressTotal = total * 3;
    const matrix = new Float32Array((total * (total - 1)) / 2);
    const compare = createSequenceComparator(signatures);
    callbacks.onProgress?.(total, progressTotal);
    for (let left = 0; left < total - 1; left += 1) {
      if (callbacks.isCancelled?.()) return [];
      for (let right = left + 1; right < total; right += 1) {
        matrix[similarityMatrixIndex(left, right, total)] =
          compare(signatures[left], signatures[right]) / 100;
      }
      callbacks.onProgress?.(total + left + 1, progressTotal);
      if (left % 4 === 3) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (callbacks.isCancelled?.()) return [];
    callbacks.onProgress?.(total * 2, progressTotal);
    const candidates = scoreLoopCandidates(matrix, total, options);
    callbacks.onProgress?.(progressTotal, progressTotal);
    return candidates;
  }

  return {
    analyzeDuplicateFrames,
    analyzeJumpFrames,
    calculateAutocorrelation,
    createBackgroundMask,
    createSequenceAnalysisContext,
    createSignature,
    createSimilarityMatrix,
    detectStableBackground,
    findDuplicateFrames,
    findJumpFrames,
    findLoopCandidates,
    findLoopCandidatesAsync,
    matrixSimilarity,
    scoreLoopCandidates,
    signatureSimilarity,
    ORGANIZER_SIMILARITY_THRESHOLD,
    REFERENCE_SAMPLE_SIZE,
  };
});
