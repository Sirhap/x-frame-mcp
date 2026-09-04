(function attachBatchCutoutProductCore(root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BatchCutoutProductCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  /**
   * Creates the product repair pipeline behind the BatchCutoutCore compatibility facade.
   * @param {{
   *   applyCutout:Function,
   *   applyReferenceColorReplace:Function,
   *   applyReferenceFloodFillDespill:Function,
   *   clamp:Function,
   *   colorDistance:Function,
   *   createProtectedRegionMask:Function,
   *   estimateBackgroundColor:Function,
   *   perceptualColorDistance:Function
   * }} dependencies Pixel-kernel dependencies owned by the core facade.
   * @returns {{
   *   applyCutoutBrushStroke:Function,
   *   applyCutoutRepairs:Function,
   *   applyProductCutout:Function
   * }}
   */
  function createProductPipeline(dependencies) {
    const {
      applyCutout,
      applyReferenceColorReplace,
      applyReferenceFloodFillDespill,
      clamp,
      colorDistance,
      createProtectedRegionMask,
      estimateBackgroundColor,
      perceptualColorDistance,
    } = dependencies || {};
    [
      ["applyCutout", applyCutout],
      ["applyReferenceColorReplace", applyReferenceColorReplace],
      ["applyReferenceFloodFillDespill", applyReferenceFloodFillDespill],
      ["clamp", clamp],
      ["colorDistance", colorDistance],
      ["createProtectedRegionMask", createProtectedRegionMask],
      ["estimateBackgroundColor", estimateBackgroundColor],
      ["perceptualColorDistance", perceptualColorDistance],
    ].forEach(([name, dependency]) => {
      if (typeof dependency !== "function") {
        throw new TypeError(`BatchCutoutProductCore requires ${name}().`);
      }
    });
    let smartRepairPatchCache = null;

    /**
     * Expands a persisted foreground bitset into the current repair rectangle.
     * The normalized mapping also keeps the mask usable when a batch frame has
     * the same subject at a proportionally remapped selection size.
     * @param {object} repair Protection repair containing a compact subject mask.
     * @param {number} width Target image width.
     * @param {number} height Target image height.
     * @returns {Uint8Array|null} Full-image mask, or null for legacy/invalid data.
     */
    function decodeSubjectMask(repair, width, height) {
      const subjectMask = repair?.subjectMask;
      if (
        !subjectMask?.data ||
        !Number.isInteger(subjectMask.width) ||
        !Number.isInteger(subjectMask.height) ||
        subjectMask.width <= 0 ||
        subjectMask.height <= 0
      ) {
        return null;
      }
      try {
        const binary = globalThis.atob(subjectMask.data);
        if (binary.length * 8 < subjectMask.width * subjectMask.height) return null;
        const startX = Math.max(0, Math.floor(Math.min(repair.x1, repair.x2)));
        const endX = Math.min(width - 1, Math.ceil(Math.max(repair.x1, repair.x2)));
        const startY = Math.max(0, Math.floor(Math.min(repair.y1, repair.y2)));
        const endY = Math.min(height - 1, Math.ceil(Math.max(repair.y1, repair.y2)));
        if (endX < startX || endY < startY) return null;
        const targetWidth = endX - startX + 1;
        const targetHeight = endY - startY + 1;
        const mask = new Uint8Array(width * height);
        for (let y = startY; y <= endY; y += 1) {
          const sourceY = Math.min(
            subjectMask.height - 1,
            Math.floor(((y - startY) * subjectMask.height) / targetHeight),
          );
          for (let x = startX; x <= endX; x += 1) {
            const sourceX = Math.min(
              subjectMask.width - 1,
              Math.floor(((x - startX) * subjectMask.width) / targetWidth),
            );
            const bitIndex = sourceY * subjectMask.width + sourceX;
            if (binary.charCodeAt(bitIndex >> 3) & (1 << (bitIndex & 7))) mask[y * width + x] = 1;
          }
        }
        return mask;
      } catch {
        return null;
      }
    }

    /**
     * Creates an identity for the inputs that can alter a smart-clear patch.
     * @param {object} options Processing options.
     * @param {object} repair Smart-clear repair.
     * @returns {string} Stable JSON identity for immutable source pixels.
     */
    function smartRepairPatchKey(options, repair) {
      return JSON.stringify({ options, repair });
    }

    /**
     * Copies a cached rectangular RGBA patch back into a mutable result image.
     * @param {Uint8ClampedArray} resultData Mutable result pixels.
     * @param {number} width Image width.
     * @param {{startX:number,startY:number,endX:number,endY:number,data:Uint8ClampedArray}} patch Cached patch.
     * @returns {void}
     */
    function applySmartRepairPatch(resultData, width, patch) {
      const rowWidth = (patch.endX - patch.startX + 1) * 4;
      for (let y = patch.startY; y <= patch.endY; y += 1) {
        const row = y - patch.startY;
        resultData.set(
          patch.data.subarray(row * rowWidth, (row + 1) * rowWidth),
          (y * width + patch.startX) * 4,
        );
      }
    }

    /**
     * Applies one serialized brush, eraser, or source-restore stroke to mutable RGBA pixels.
     * Eraser strokes are normally translated to source restoration by the repair
     * pipeline so they remove paint without changing the underlying cutout.
     * @param {Uint8ClampedArray} pixels Mutable result pixels.
     * @param {number} width Image width.
     * @param {number} height Image height.
     * @param {object} stroke Brush settings and source-space points.
     * @param {Uint8ClampedArray|Uint8Array|null} source Original RGBA pixels for source restore.
     * @returns {void}
     */
    function applyCutoutBrushStroke(pixels, width, height, stroke, source = null) {
      const points = Array.isArray(stroke?.points) ? stroke.points : [];
      if (!points.length) return;
      if (stroke.mode === "restore-source" && source?.length !== pixels.length) {
        throw new RangeError("Source pixels must match the repair result for source restore.");
      }
      const radius = Math.max(0.5, Number(stroke.size || 1) / 2);
      const hardness = Math.max(0.01, Math.min(0.999, Number(stroke.hardness || 1)));
      const opacity = Math.max(0.01, Math.min(1, Number(stroke.opacity || 1)));
      const color = stroke.color || { r: 0, g: 200, b: 0 };
      const stamp = (centerX, centerY) => {
        const startX = Math.max(0, Math.floor(centerX - radius));
        const endX = Math.min(width - 1, Math.ceil(centerX + radius));
        const startY = Math.max(0, Math.floor(centerY - radius));
        const endY = Math.min(height - 1, Math.ceil(centerY + radius));
        for (let y = startY; y <= endY; y += 1) {
          for (let x = startX; x <= endX; x += 1) {
            const distance = Math.hypot(x + 0.5 - centerX, y + 0.5 - centerY) / radius;
            if (distance > 1) continue;
            const feather = distance <= hardness ? 1 : 1 - (distance - hardness) / (1 - hardness);
            const strength = opacity * Math.max(0, Math.min(1, feather));
            const offset = (y * width + x) * 4;
            if (stroke.mode === "eraser") {
              pixels[offset + 3] = Math.round(pixels[offset + 3] * (1 - strength));
            } else if (stroke.mode === "restore-source") {
              for (let channel = 0; channel < 4; channel += 1) {
                pixels[offset + channel] = Math.round(
                  pixels[offset + channel] * (1 - strength) + source[offset + channel] * strength,
                );
              }
            } else {
              pixels[offset] = Math.round(pixels[offset] * (1 - strength) + color.r * strength);
              pixels[offset + 1] = Math.round(pixels[offset + 1] * (1 - strength) + color.g * strength);
              pixels[offset + 2] = Math.round(pixels[offset + 2] * (1 - strength) + color.b * strength);
              pixels[offset + 3] = Math.round(pixels[offset + 3] + (255 - pixels[offset + 3]) * strength);
            }
          }
        }
      };
      points.forEach((point, index) => {
        const previous = points[Math.max(0, index - 1)];
        const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
        const steps = Math.max(1, Math.ceil(distance / Math.max(1, radius * 0.35)));
        for (let step = 1; step <= steps; step += 1) {
          const ratio = step / steps;
          stamp(previous.x + (point.x - previous.x) * ratio, previous.y + (point.y - previous.y) * ratio);
        }
      });
    }

    /**
     * Applies a click-based fill or color replacement to mutable RGBA pixels.
     * Fill is always connected and restores opacity. Recolor delegates to the
     * reconstructed FramePacker global or flood-fill replacement kernel.
     * @param {Uint8ClampedArray} pixels Mutable result pixels.
     * @param {number} width Image width.
     * @param {number} height Image height.
     * @param {object} repair Serialized area-color repair.
     * @param {object} options Product processing options.
     * @returns {void}
     */
    function applyAreaColorRepair(pixels, width, height, repair, options) {
      const seedX = Math.max(0, Math.min(width - 1, Math.round(Number(repair.x || 0))));
      const seedY = Math.max(0, Math.min(height - 1, Math.round(Number(repair.y || 0))));
      const seedOffset = (seedY * width + seedX) * 4;
      const sampled = repair.sourceColor || {
        r: pixels[seedOffset],
        g: pixels[seedOffset + 1],
        b: pixels[seedOffset + 2],
        a: pixels[seedOffset + 3],
      };
      const replacement = repair.color || { r: 0, g: 200, b: 0 };
      const replacementAlpha = Number.isFinite(replacement.a) ? clamp(replacement.a, 0, 255) : null;
      const tolerance = clamp(repair.tolerance ?? 18, 0, 100);
      if (repair.mode === "recolor") {
        const fillColor = {
          r: replacement.r,
          g: replacement.g,
          b: replacement.b,
          a: replacementAlpha ?? 255,
        };
        const referenceOptions = {
          referenceColor: sampled,
          edgeEnhance: clamp(repair.edgeEnhance ?? 0, 0, 100),
          blendStrength: clamp(repair.blendStrength ?? 0, 0, 100),
          edgeRestoreRadius: Math.max(0, Math.trunc(repair.edgeRestoreRadius || 0)),
          edgeRestoreMode: Math.trunc(repair.edgeRestoreMode || 0),
          despillStrength: clamp(repair.despillStrength ?? 0, 0, 100),
          despillMode: Math.trunc(repair.despillMode || 0),
          despillRefColor: repair.despillReferenceColor || sampled,
          alphaThresholdHigh: clamp(repair.alphaThresholdHigh ?? 0, 0, 255),
          alphaThresholdLow: clamp(repair.alphaThresholdLow ?? 0, 0, 255),
          protectColors: Array.isArray(options?.protectedColors) ? options.protectedColors.slice(0, 32) : [],
        };
        const result =
          repair.scope === "global"
            ? applyReferenceColorReplace(
                pixels,
                width,
                height,
                { x: seedX, y: seedY },
                fillColor,
                tolerance,
                referenceOptions,
              )
            : applyReferenceFloodFillDespill(
                pixels,
                width,
                height,
                { x: seedX, y: seedY },
                fillColor,
                tolerance,
                referenceOptions,
              );
        pixels.set(result);
        return;
      }
      const alphaTolerance = Math.max(12, Math.round(tolerance * 2.55));
      const pixelCount = width * height;
      const matches = (index) => {
        const offset = index * 4;
        const alpha = pixels[offset + 3];
        if (sampled.a <= 16) return alpha <= Math.max(16, alphaTolerance);
        return (
          Math.abs(alpha - sampled.a) <= alphaTolerance &&
          colorDistance(pixels[offset], pixels[offset + 1], pixels[offset + 2], sampled) <= tolerance
        );
      };
      const applyPixel = (index) => {
        const offset = index * 4;
        const becomesTransparent = replacementAlpha === 0;
        pixels[offset] = becomesTransparent ? 0 : replacement.r;
        pixels[offset + 1] = becomesTransparent ? 0 : replacement.g;
        pixels[offset + 2] = becomesTransparent ? 0 : replacement.b;
        if (replacementAlpha !== null) pixels[offset + 3] = replacementAlpha;
        else if (repair.mode === "fill") pixels[offset + 3] = 255;
      };
      const visited = new Uint8Array(pixelCount);
      const stack = [seedY * width + seedX];
      while (stack.length) {
        const index = stack.pop();
        if (index < 0 || index >= pixelCount || visited[index]) continue;
        visited[index] = 1;
        if (!matches(index)) continue;
        applyPixel(index);
        const x = index % width;
        const y = Math.floor(index / width);
        if (x > 0) stack.push(index - 1);
        if (x + 1 < width) stack.push(index + 1);
        if (y > 0) stack.push(index - width);
        if (y + 1 < height) stack.push(index + width);
      }
    }

    /**
     * Normalizes global color-protection options without promoting local repair
     * samples into the global palette. Local samples are restored only inside
     * their persisted rectangle or subject mask by applyCutoutRepairs.
     * @param {object} options Processing options.
     * @returns {object}
     */
    function normalizeProtectionOptions(options) {
      const protectedColors = [];
      const appendColor = (color) => {
        if (![color?.r, color?.g, color?.b].every(Number.isFinite)) return;
        if (protectedColors.some((candidate) => colorDistance(color.r, color.g, color.b, candidate) < 2))
          return;
        protectedColors.push({
          r: Number(color.r),
          g: Number(color.g),
          b: Number(color.b),
        });
      };
      (Array.isArray(options?.protectedColors) ? options.protectedColors : []).forEach(appendColor);
      return { ...(options || {}), protectedColors };
    }

    /**
     * Applies serialized product repairs to one automatic cutout result.
     * @param {Uint8ClampedArray|Uint8Array} source Original RGBA pixels.
     * @param {Uint8ClampedArray} resultData Mutable automatic cutout pixels.
     * @param {number} width Image width.
     * @param {number} height Image height.
     * @param {object} options Processing options.
     * @param {Array<object>} repairs Serialized repairs.
     * @param {Uint8ClampedArray|Uint8Array|null} automaticData Immutable automatic cutout pixels.
     * @returns {Uint8ClampedArray}
     */
    function applyCutoutRepairs(
      source,
      resultData,
      width,
      height,
      options,
      repairs = [],
      automaticData = null,
    ) {
      const protectedColors = Array.isArray(options.protectedColors) ? options.protectedColors : [];
      const protectionTolerance = clamp(options.protectionTolerance ?? 8, 0, 100);
      const protectionPreview = automaticData || new Uint8ClampedArray(resultData);
      if (protectionPreview.length !== resultData.length) {
        throw new RangeError("Automatic cutout preview length does not match the repair result.");
      }
      const defaultBackground =
        (Array.isArray(options.backgroundColors) && options.backgroundColors.length
          ? options.backgroundColors[0]
          : options.backgroundColor) || estimateBackgroundColor(source, width, height);
      const hasEraser = repairs.some((repair) => repair?.mode === "eraser");
      const paintBaseline = hasEraser
        ? applyCutoutRepairs(
            source,
            new Uint8ClampedArray(resultData),
            width,
            height,
            options,
            repairs.filter((repair) => !["brush", "eraser"].includes(repair?.mode)),
            automaticData,
          )
        : null;
      for (const repair of repairs) {
        if (repair.mode === "eraser") {
          applyCutoutBrushStroke(
            resultData,
            width,
            height,
            { ...repair, mode: "restore-source" },
            paintBaseline,
          );
          continue;
        }
        if (["brush", "restore-source"].includes(repair.mode)) {
          applyCutoutBrushStroke(resultData, width, height, repair, source);
          continue;
        }
        if (repair.mode === "fill" || repair.mode === "recolor") {
          applyAreaColorRepair(resultData, width, height, repair, options);
          continue;
        }
        if (repair.mode === "protect-color") {
          const protectionMask = decodeSubjectMask(repair, width, height);
          const colors = Array.isArray(repair.colors) ? repair.colors : [];
          const tolerance = Math.max(0, Number(repair.tolerance ?? options.protectionTolerance ?? 8));
          if (!colors.length) continue;
          const startX = Math.max(0, Math.floor(Math.min(repair.x1, repair.x2)));
          const endX = Math.min(width - 1, Math.ceil(Math.max(repair.x1, repair.x2)));
          const startY = Math.max(0, Math.floor(Math.min(repair.y1, repair.y2)));
          const endY = Math.min(height - 1, Math.ceil(Math.max(repair.y1, repair.y2)));
          for (let y = startY; y <= endY; y += 1) {
            for (let x = startX; x <= endX; x += 1) {
              const index = y * width + x;
              if (protectionMask && !protectionMask[index]) continue;
              const offset = index * 4;
              if (!source[offset + 3]) continue;
              const matches = colors.some(
                (color) =>
                  colorDistance(source[offset], source[offset + 1], source[offset + 2], color) <= tolerance,
              );
              if (matches) resultData.set(source.subarray(offset, offset + 4), offset);
            }
          }
          continue;
        }
        if (repair.mode === "protect-range") {
          const persistedMask = decodeSubjectMask(repair, width, height);
          const protectionMask =
            persistedMask ||
            createProtectedRegionMask(source, protectionPreview, width, height, repair, {
              backgroundColors: options.backgroundColors || [defaultBackground],
              boundaryStrength: repair.boundaryStrength,
              padding: repair.padding,
            }).mask;
          for (let index = 0; index < protectionMask.length; index += 1) {
            if (!protectionMask[index]) continue;
            const offset = index * 4;
            resultData.set(source.subarray(offset, offset + 4), offset);
          }
          continue;
        }
        if (![repair.x1, repair.y1, repair.x2, repair.y2].every(Number.isFinite)) continue;
        const startX = Math.max(0, Math.floor(Math.min(repair.x1, repair.x2)));
        const endX = Math.min(width - 1, Math.ceil(Math.max(repair.x1, repair.x2)));
        const startY = Math.max(0, Math.floor(Math.min(repair.y1, repair.y2)));
        const endY = Math.min(height - 1, Math.ceil(Math.max(repair.y1, repair.y2)));
        const background = repair.backgroundColor || defaultBackground;
        const distanceFromBackground = (offset) =>
          options.perceptual
            ? perceptualColorDistance(source[offset], source[offset + 1], source[offset + 2], background)
            : colorDistance(source[offset], source[offset + 1], source[offset + 2], background);
        const maximumDistance =
          Number(repair.tolerance ?? options.tolerance ?? 18) +
          Number(repair.feather ?? options.feather ?? 6);
        if (repair.mode === "smart") {
          const cacheKey = smartRepairPatchKey(options, repair);
          const cachedPatch = smartRepairPatchCache;
          if (
            cachedPatch?.source === source &&
            cachedPatch.width === width &&
            cachedPatch.height === height &&
            cachedPatch.key === cacheKey
          ) {
            applySmartRepairPatch(resultData, width, cachedPatch);
            continue;
          }
          const selectionMask = new Uint8Array(width * height);
          for (let y = startY; y <= endY; y += 1) {
            selectionMask.fill(255, y * width + startX, y * width + endX + 1);
          }
          const seedPoints = [];
          for (let gridY = 0; gridY < 3; gridY += 1) {
            const cellStartY = Math.round(startY + ((endY - startY) * gridY) / 3);
            const cellEndY = gridY === 2 ? endY : Math.round(startY + ((endY - startY) * (gridY + 1)) / 3);
            for (let gridX = 0; gridX < 3; gridX += 1) {
              const cellStartX = Math.round(startX + ((endX - startX) * gridX) / 3);
              const cellEndX = gridX === 2 ? endX : Math.round(startX + ((endX - startX) * (gridX + 1)) / 3);
              let bestSeed = null;
              let bestDistance = Number.POSITIVE_INFINITY;
              for (let y = cellStartY; y <= cellEndY; y += 1) {
                for (let x = cellStartX; x <= cellEndX; x += 1) {
                  const distance = distanceFromBackground((y * width + x) * 4);
                  if (distance >= bestDistance) continue;
                  bestDistance = distance;
                  bestSeed = { x, y };
                }
              }
              if (bestSeed) seedPoints.push(bestSeed);
            }
          }
          const smartResult = applyCutout(source, width, height, {
            ...options,
            backgroundColor: background,
            backgroundColors: [background],
            tolerance: Number(repair.tolerance ?? options.tolerance ?? 18),
            feather: Number(repair.feather ?? options.feather ?? 6),
            connected: true,
            selectionMask,
            seedPoints,
          });
          const rowWidth = (endX - startX + 1) * 4;
          const patch = new Uint8ClampedArray(rowWidth * (endY - startY + 1));
          for (let y = startY; y <= endY; y += 1) {
            const row = y - startY;
            const startOffset = (y * width + startX) * 4;
            patch.set(smartResult.data.subarray(startOffset, startOffset + rowWidth), row * rowWidth);
          }
          smartRepairPatchCache = {
            source,
            width,
            height,
            key: cacheKey,
            startX,
            startY,
            endX,
            endY,
            data: patch,
          };
          applySmartRepairPatch(resultData, width, smartRepairPatchCache);
          continue;
        }
        for (let y = startY; y <= endY; y += 1) {
          for (let x = startX; x <= endX; x += 1) {
            const offset = (y * width + x) * 4;
            const protectedPixel = protectedColors.some(
              (color) =>
                colorDistance(source[offset], source[offset + 1], source[offset + 2], color) <=
                protectionTolerance,
            );
            if (repair.mode === "clear") {
              resultData[offset + 3] = 0;
            } else if (repair.mode === "restore") {
              resultData.set(source.subarray(offset, offset + 4), offset);
            } else if (!protectedPixel && distanceFromBackground(offset) <= maximumDistance) {
              resultData[offset + 3] = 0;
            }
          }
        }
      }
      return resultData;
    }

    /**
     * Executes the complete product path shared by preview, export, and replacement.
     * @param {Uint8ClampedArray|Uint8Array} source Original RGBA pixels.
     * @param {number} width Image width.
     * @param {number} height Image height.
     * @param {object} options Processing options.
     * @param {Array<object>} repairs Serialized local repairs.
     * @returns {{data:Uint8ClampedArray,automaticData:Uint8ClampedArray,removedPixels:number,partialPixels:number}}
     */
    function applyProductCutout(source, width, height, options = {}, repairs = []) {
      const normalizedRepairs = Array.isArray(repairs) ? repairs : [];
      const normalizedOptions = normalizeProtectionOptions(options);
      const result =
        normalizedOptions.automaticCutout === false
          ? {
              data: new Uint8ClampedArray(source),
              removedPixels: 0,
              partialPixels: 0,
            }
          : applyCutout(source, width, height, normalizedOptions);
      const automaticData = new Uint8ClampedArray(result.data);
      applyCutoutRepairs(
        source,
        result.data,
        width,
        height,
        normalizedOptions,
        normalizedRepairs,
        automaticData,
      );
      return { ...result, automaticData };
    }

    return Object.freeze({
      applyCutoutBrushStroke,
      applyCutoutRepairs,
      applyProductCutout,
    });
  }

  return {
    createProductPipeline,
  };
});
