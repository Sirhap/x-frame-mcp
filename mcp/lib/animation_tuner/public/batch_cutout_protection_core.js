(function attachBatchCutoutProtectionCore(root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BatchCutoutProtectionCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  /**
   * Creates the protected-color selector behind the BatchCutoutCore compatibility facade.
   * @param {{
   *   rgbToReferenceYcbcr:Function,
   *   srgbToLinear:Function
   * }} dependencies Reference protection dependencies owned by the core facade.
   * @returns {{
   *   createProtectedRegionMask:Function,
   *   createReferenceProtectionMask:Function,
   *   extractProtectedColors:Function,
   *   referenceProtectionDescriptor:Function,
   *   referenceProtectionMatches:Function,
   *   selectProtectedColorsInRectangle:Function,
   *   selectReferenceProtectedColors:Function
   * }}
   */
  function createProtectionSelector(dependencies) {
    const { rgbToReferenceYcbcr, srgbToLinear } = dependencies || {};
    [
      ["rgbToReferenceYcbcr", rgbToReferenceYcbcr],
      ["srgbToLinear", srgbToLinear],
    ].forEach(([name, dependency]) => {
      if (typeof dependency !== "function") {
        throw new TypeError(`BatchCutoutProtectionCore requires ${name}().`);
      }
    });

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
     * Samples deduplicated local-background colors from a coarse selection border.
     * A user-drawn box describes the subject context more accurately than the
     * image-wide background color when the subject sits inside a detailed scene.
     * @param {Uint8ClampedArray|Uint8Array} data Original RGBA pixels.
     * @param {number} width Image width.
     * @param {{x1:number,y1:number,x2:number,y2:number}} bounds Selection bounds.
     * @returns {Array<{r:number,g:number,b:number}>} Local background samples.
     */
    function sampleSelectionBorderColors(data, width, bounds) {
      const selectionWidth = bounds.x2 - bounds.x1 + 1;
      const selectionHeight = bounds.y2 - bounds.y1 + 1;
      if (selectionWidth < 5 || selectionHeight < 5) return [];
      const perimeter = selectionWidth * 2 + selectionHeight * 2;
      const step = Math.max(1, Math.ceil(perimeter / 128));
      const samples = [];
      const append = (x, y) => {
        const offset = (y * width + x) * 4;
        if (!data[offset + 3]) return;
        const color = { r: data[offset], g: data[offset + 1], b: data[offset + 2] };
        const duplicate = samples.some(
          (sample) => (sample.r - color.r) ** 2 + (sample.g - color.g) ** 2 + (sample.b - color.b) ** 2 < 144,
        );
        if (!duplicate) samples.push(color);
      };
      for (let x = bounds.x1; x <= bounds.x2; x += step) {
        append(x, bounds.y1);
        append(x, bounds.y2);
      }
      for (let y = bounds.y1 + step; y < bounds.y2; y += step) {
        append(bounds.x1, y);
        append(bounds.x2, y);
      }
      return samples.slice(0, 128);
    }

    /**
     * Restores small opaque holes fully enclosed by the detected subject.
     * This preserves background-like details such as white eyes without filling
     * large gaps between limbs or unrelated scene areas.
     * @param {Uint8Array} mask Detected subject mask, mutated in place.
     * @param {Uint8ClampedArray|Uint8Array} data Original RGBA pixels.
     * @param {number} width Image width.
     * @param {number} height Image height.
     * @param {{x1:number,y1:number,x2:number,y2:number}} bounds Detected subject bounds.
     * @param {number} regionArea Coarse selection area.
     * @returns {void}
     */
    function fillSmallEnclosedHoles(mask, data, width, height, bounds, regionArea) {
      if (!bounds) return;
      const visited = new Uint8Array(mask.length);
      const maximumHoleSize = Math.max(4, Math.floor(regionArea * 0.25));
      for (let y = bounds.y1; y <= bounds.y2; y += 1) {
        for (let x = bounds.x1; x <= bounds.x2; x += 1) {
          const startIndex = y * width + x;
          if (mask[startIndex] || visited[startIndex] || !data[startIndex * 4 + 3]) continue;
          const stack = [startIndex];
          const hole = [];
          let touchesBounds = false;
          visited[startIndex] = 1;
          while (stack.length) {
            const index = stack.pop();
            hole.push(index);
            const pointX = index % width;
            const pointY = Math.floor(index / width);
            touchesBounds ||=
              pointX === bounds.x1 || pointX === bounds.x2 || pointY === bounds.y1 || pointY === bounds.y2;
            const neighbors = [
              pointX > bounds.x1 ? index - 1 : -1,
              pointX < bounds.x2 ? index + 1 : -1,
              pointY > bounds.y1 ? index - width : -1,
              pointY < bounds.y2 ? index + width : -1,
            ];
            for (const neighbor of neighbors) {
              if (neighbor < 0 || mask[neighbor] || visited[neighbor] || !data[neighbor * 4 + 3]) {
                continue;
              }
              visited[neighbor] = 1;
              stack.push(neighbor);
            }
          }
          if (!touchesBounds && hole.length <= maximumHoleSize) {
            hole.forEach((index) => {
              mask[index] = 1;
            });
          }
        }
      }
    }

    /**
     * Closes short gaps in a fragmented subject contour before enclosed pixels
     * are restored. The radius scales with the user's coarse selection and is
     * capped to keep large-image processing predictable.
     * @param {Uint8Array} mask Detected subject mask, mutated in place.
     * @param {number} width Image width.
     * @param {{x1:number,y1:number,x2:number,y2:number}} bounds Processing bounds.
     * @param {number} radius Closing radius in pixels.
     * @returns {void}
     */
    function closeSubjectContour(mask, width, bounds, radius) {
      if (!bounds || radius <= 0) return;
      const boundsWidth = bounds.x2 - bounds.x1 + 1;
      const boundsHeight = bounds.y2 - bounds.y1 + 1;
      if (boundsWidth <= radius * 2 || boundsHeight <= radius * 2) return;
      let current = new Uint8Array(mask);
      for (let iteration = 0; iteration < radius; iteration += 1) {
        const expanded = new Uint8Array(current);
        for (let y = bounds.y1; y <= bounds.y2; y += 1) {
          for (let x = bounds.x1; x <= bounds.x2; x += 1) {
            const index = y * width + x;
            if (current[index]) continue;
            if (
              (x > bounds.x1 && current[index - 1]) ||
              (x < bounds.x2 && current[index + 1]) ||
              (y > bounds.y1 && current[index - width]) ||
              (y < bounds.y2 && current[index + width])
            ) {
              expanded[index] = 1;
            }
          }
        }
        current = expanded;
      }
      for (let iteration = 0; iteration < radius; iteration += 1) {
        const contracted = new Uint8Array(current);
        for (let y = bounds.y1; y <= bounds.y2; y += 1) {
          for (let x = bounds.x1; x <= bounds.x2; x += 1) {
            const index = y * width + x;
            if (!current[index]) continue;
            if (
              x === bounds.x1 ||
              x === bounds.x2 ||
              y === bounds.y1 ||
              y === bounds.y2 ||
              !current[index - 1] ||
              !current[index + 1] ||
              !current[index - width] ||
              !current[index + width]
            ) {
              contracted[index] = 0;
            }
          }
        }
        current = contracted;
      }
      mask.set(current);
    }

    /**
     * Removes small scene fragments and restores the original opaque pixels
     * inside a row-wise subject envelope. This recovers dark clothing that is
     * chromatically indistinguishable from a dark scene while preserving a
     * non-rectangular silhouette derived from detected subject edges.
     * @param {Uint8Array} mask Detected subject mask, mutated in place.
     * @param {Uint8ClampedArray|Uint8Array} data Original RGBA pixels.
     * @param {number} width Image width.
     * @param {{x1:number,y1:number,x2:number,y2:number}} bounds Processing bounds.
     * @returns {void}
     */
    function restoreSubjectEnvelope(mask, data, width, bounds) {
      const visited = new Uint8Array(mask.length);
      const components = [];
      for (let y = bounds.y1; y <= bounds.y2; y += 1) {
        for (let x = bounds.x1; x <= bounds.x2; x += 1) {
          const startIndex = y * width + x;
          if (!mask[startIndex] || visited[startIndex]) continue;
          const stack = [startIndex];
          const indices = [];
          let sumX = 0;
          let sumY = 0;
          visited[startIndex] = 1;
          while (stack.length) {
            const index = stack.pop();
            const pointX = index % width;
            const pointY = Math.floor(index / width);
            indices.push(index);
            sumX += pointX;
            sumY += pointY;
            const neighbors = [
              pointX > bounds.x1 ? index - 1 : -1,
              pointX < bounds.x2 ? index + 1 : -1,
              pointY > bounds.y1 ? index - width : -1,
              pointY < bounds.y2 ? index + width : -1,
            ];
            for (const neighbor of neighbors) {
              if (neighbor < 0 || !mask[neighbor] || visited[neighbor]) continue;
              visited[neighbor] = 1;
              stack.push(neighbor);
            }
          }
          components.push({ indices, centerX: sumX / indices.length, centerY: sumY / indices.length });
        }
      }
      if (!components.length) return;
      const largestSize = components.reduce(
        (largest, component) => Math.max(largest, component.indices.length),
        0,
      );
      const centerX = (bounds.x1 + bounds.x2) * 0.5;
      const centerY = (bounds.y1 + bounds.y2) * 0.5;
      const halfWidth = Math.max(1, (bounds.x2 - bounds.x1 + 1) * 0.5);
      const halfHeight = Math.max(1, (bounds.y2 - bounds.y1 + 1) * 0.5);
      mask.fill(0);
      for (const component of components) {
        const central =
          Math.abs(component.centerX - centerX) / halfWidth <= 0.86 &&
          Math.abs(component.centerY - centerY) / halfHeight <= 0.86;
        if (
          component.indices.length !== largestSize &&
          (!central || component.indices.length < largestSize * 0.03)
        ) {
          continue;
        }
        component.indices.forEach((index) => {
          mask[index] = 1;
        });
      }
      const rows = [];
      for (let y = bounds.y1; y <= bounds.y2; y += 1) {
        let minimumX = bounds.x2 + 1;
        let maximumX = bounds.x1 - 1;
        for (let x = bounds.x1; x <= bounds.x2; x += 1) {
          if (!mask[y * width + x]) continue;
          minimumX = Math.min(minimumX, x);
          maximumX = Math.max(maximumX, x);
        }
        if (maximumX >= minimumX) rows.push({ y, minimumX, maximumX });
      }
      if (!rows.length) return;
      const fillRow = (y, minimumX, maximumX) => {
        for (let x = Math.round(minimumX); x <= Math.round(maximumX); x += 1) {
          const index = y * width + x;
          if (data[index * 4 + 3]) mask[index] = 1;
        }
      };
      const maximumGap = Math.max(2, Math.round((bounds.y2 - bounds.y1 + 1) * 0.22));
      rows.forEach((row) => fillRow(row.y, row.minimumX, row.maximumX));
      for (let index = 1; index < rows.length; index += 1) {
        const previous = rows[index - 1];
        const next = rows[index];
        const gap = next.y - previous.y - 1;
        if (gap <= 0 || gap > maximumGap) continue;
        for (let offset = 1; offset <= gap; offset += 1) {
          const progress = offset / (gap + 1);
          fillRow(
            previous.y + offset,
            previous.minimumX + (next.minimumX - previous.minimumX) * progress,
            previous.maximumX + (next.maximumX - previous.maximumX) * progress,
          );
        }
      }
    }

    /**
     * Detects a foreground boundary inside a coarse rectangle. Alpha from the
     * current preview is a positive hint, while distance from known background
     * colors and connected components determine the final spatial mask.
     * @param {Uint8ClampedArray|Uint8Array} data Original RGBA pixels.
     * @param {Uint8ClampedArray|Uint8Array|null} previewData Automatic cutout pixels.
     * @param {number} width Image width.
     * @param {number} height Image height.
     * @param {{x1:number,y1:number,x2:number,y2:number}} rectangle Coarse rectangle.
     * @param {{backgroundColors?:Array<object>,boundaryStrength?:number,padding?:number}} options Detection options.
     * @returns {{mask:Uint8Array,count:number,bounds:object|null,coverage:number}}
     */
    function createProtectedRegionMask(data, previewData, width, height, rectangle, options = {}) {
      if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        throw new RangeError("Protected-region dimensions must be positive integers.");
      }
      const pixelCount = width * height;
      const empty = { mask: new Uint8Array(pixelCount), count: 0, bounds: null, coverage: 0 };
      if (!data || data.length !== pixelCount * 4) {
        throw new RangeError("Protected-region RGBA length does not match its dimensions.");
      }
      if (previewData && previewData.length !== data.length) {
        throw new RangeError("Protected-region preview length does not match its source.");
      }
      if (![rectangle?.x1, rectangle?.y1, rectangle?.x2, rectangle?.y2].every(Number.isFinite)) {
        return empty;
      }
      const startX = Math.max(0, Math.floor(Math.min(rectangle.x1, rectangle.x2)));
      const endX = Math.min(width - 1, Math.ceil(Math.max(rectangle.x1, rectangle.x2)));
      const startY = Math.max(0, Math.floor(Math.min(rectangle.y1, rectangle.y2)));
      const endY = Math.min(height - 1, Math.ceil(Math.max(rectangle.y1, rectangle.y2)));
      const regionArea = Math.max(0, endX - startX + 1) * Math.max(0, endY - startY + 1);
      if (!regionArea) return empty;
      const providedBackgrounds = Array.isArray(options.backgroundColors)
        ? options.backgroundColors.filter((color) => [color?.r, color?.g, color?.b].every(Number.isFinite))
        : [];
      const localBackgrounds = sampleSelectionBorderColors(data, width, {
        x1: startX,
        y1: startY,
        x2: endX,
        y2: endY,
      });
      const backgrounds = [
        ...(providedBackgrounds.length ? providedBackgrounds : [{ r: 0, g: 255, b: 0 }]),
        ...localBackgrounds,
      ];
      const boundaryStrength = clamp(options.boundaryStrength ?? 55, 0, 100);
      const distanceThreshold = 5 + boundaryStrength * 0.27;
      const padding = Math.round(clamp(options.padding ?? 2, 0, 8));
      const searchStartX = Math.max(0, startX - padding);
      const searchEndX = Math.min(width - 1, endX + padding);
      const searchStartY = Math.max(0, startY - padding);
      const searchEndY = Math.min(height - 1, endY + padding);
      const distanceCache = new Float32Array(pixelCount);
      const distanceKnown = new Uint8Array(pixelCount);
      const normalizedDistance = (index) => {
        if (distanceKnown[index]) return distanceCache[index];
        const offset = index * 4;
        let nearest = Number.POSITIVE_INFINITY;
        for (const background of backgrounds) {
          nearest = Math.min(
            nearest,
            Math.hypot(
              data[offset] - Number(background.r || 0),
              data[offset + 1] - Number(background.g || 0),
              data[offset + 2] - Number(background.b || 0),
            ) / 4.416729559,
          );
        }
        distanceKnown[index] = 1;
        distanceCache[index] = nearest;
        return nearest;
      };
      const candidates = new Uint8Array(pixelCount);
      const strongSeeds = new Uint8Array(pixelCount);
      for (let y = startY; y <= endY; y += 1) {
        for (let x = startX; x <= endX; x += 1) {
          const index = y * width + x;
          const offset = index * 4;
          if (!data[offset + 3]) continue;
          const distance = normalizedDistance(index);
          const previewAlpha = previewData ? previewData[offset + 3] : 0;
          if (distance >= distanceThreshold || (previewAlpha >= 24 && distance >= distanceThreshold * 0.35)) {
            candidates[index] = 1;
          }
          if (previewAlpha >= 112 && distance >= distanceThreshold * 0.35) strongSeeds[index] = 1;
        }
      }
      const mask = new Uint8Array(pixelCount);
      const visited = new Uint8Array(pixelCount);
      const minimumComponentSize = Math.max(1, Math.floor(regionArea * 0.0015));
      const components = [];
      for (let y = startY; y <= endY; y += 1) {
        for (let x = startX; x <= endX; x += 1) {
          const startIndex = y * width + x;
          if (!candidates[startIndex] || visited[startIndex]) continue;
          const stack = [startIndex];
          const component = [];
          let hasStrongSeed = false;
          visited[startIndex] = 1;
          while (stack.length) {
            const index = stack.pop();
            component.push(index);
            hasStrongSeed ||= Boolean(strongSeeds[index]);
            const pointX = index % width;
            const pointY = Math.floor(index / width);
            for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
              for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
                if (!offsetX && !offsetY) continue;
                const nextX = pointX + offsetX;
                const nextY = pointY + offsetY;
                if (nextX < startX || nextX > endX || nextY < startY || nextY > endY) continue;
                const nextIndex = nextY * width + nextX;
                if (!candidates[nextIndex] || visited[nextIndex]) continue;
                visited[nextIndex] = 1;
                stack.push(nextIndex);
              }
            }
          }
          components.push({ indices: component, hasStrongSeed });
        }
      }
      const hasSeededComponent = components.some((component) => component.hasStrongSeed);
      const largestComponentSize = components.reduce(
        (largest, component) => Math.max(largest, component.indices.length),
        0,
      );
      const fallbackComponentSize = Math.max(
        minimumComponentSize,
        largestComponentSize > 1 ? 2 : 1,
        Math.ceil(largestComponentSize * 0.2),
      );
      for (const component of components) {
        const keepComponent = hasSeededComponent
          ? component.hasStrongSeed
          : component.indices.length >= fallbackComponentSize;
        if (!keepComponent) continue;
        component.indices.forEach((index) => {
          mask[index] = 1;
        });
      }
      for (let iteration = 0; iteration < padding; iteration += 1) {
        const expanded = new Uint8Array(mask);
        for (let y = searchStartY; y <= searchEndY; y += 1) {
          for (let x = searchStartX; x <= searchEndX; x += 1) {
            const index = y * width + x;
            if (!mask[index]) continue;
            const expand = (nextIndex) => {
              const offset = nextIndex * 4;
              const previewAlpha = previewData ? previewData[offset + 3] : 0;
              if (
                data[offset + 3] &&
                (normalizedDistance(nextIndex) >= distanceThreshold * 0.35 || previewAlpha)
              ) {
                expanded[nextIndex] = 1;
              }
            };
            if (x > searchStartX) expand(index - 1);
            if (x < searchEndX) expand(index + 1);
            if (y > searchStartY) expand(index - width);
            if (y < searchEndY) expand(index + width);
          }
        }
        mask.set(expanded);
      }
      const selectionWidth = endX - startX + 1;
      const selectionHeight = endY - startY + 1;
      const desiredContourRadius = Math.round(Math.min(selectionWidth, selectionHeight) * 0.015);
      const budgetContourRadius = Math.max(1, Math.floor(24000000 / Math.max(1, regionArea * 2)));
      const contourRadius = Math.min(10, budgetContourRadius, Math.max(1, desiredContourRadius));
      closeSubjectContour(
        mask,
        width,
        { x1: searchStartX, y1: searchStartY, x2: searchEndX, y2: searchEndY },
        contourRadius,
      );
      if (localBackgrounds.length) {
        restoreSubjectEnvelope(mask, data, width, {
          x1: searchStartX,
          y1: searchStartY,
          x2: searchEndX,
          y2: searchEndY,
        });
      }
      let preliminaryBounds = null;
      for (let y = searchStartY; y <= searchEndY; y += 1) {
        for (let x = searchStartX; x <= searchEndX; x += 1) {
          if (!mask[y * width + x]) continue;
          preliminaryBounds = preliminaryBounds
            ? {
                x1: Math.min(preliminaryBounds.x1, x),
                y1: Math.min(preliminaryBounds.y1, y),
                x2: Math.max(preliminaryBounds.x2, x),
                y2: Math.max(preliminaryBounds.y2, y),
              }
            : { x1: x, y1: y, x2: x, y2: y };
        }
      }
      fillSmallEnclosedHoles(mask, data, width, height, preliminaryBounds, regionArea);
      let count = 0;
      let countInsideSelection = 0;
      let detectedBounds = null;
      for (let y = searchStartY; y <= searchEndY; y += 1) {
        for (let x = searchStartX; x <= searchEndX; x += 1) {
          if (!mask[y * width + x]) continue;
          count += 1;
          if (x >= startX && x <= endX && y >= startY && y <= endY) {
            countInsideSelection += 1;
          }
          detectedBounds = detectedBounds
            ? {
                x1: Math.min(detectedBounds.x1, x),
                y1: Math.min(detectedBounds.y1, y),
                x2: Math.max(detectedBounds.x2, x),
                y2: Math.max(detectedBounds.y2, y),
              }
            : { x1: x, y1: y, x2: x, y2: y };
        }
      }
      return {
        mask,
        count,
        bounds: detectedBounds,
        coverage: Math.round((countInsideSelection * 100) / regionArea),
      };
    }

    /**
     * Builds the byte-scale YCbCr direction descriptor used by the reference
     * protection selector. Chroma values below three are treated as achromatic.
     * @param {number} red Red channel.
     * @param {number} green Green channel.
     * @param {number} blue Blue channel.
     * @returns {{r:number,g:number,b:number,y:number,chroma:number,dirCb:number,dirCr:number,achromatic:boolean}}
     */
    function referenceProtectionDescriptor(red, green, blue) {
      const color = rgbToReferenceYcbcr(red, green, blue);
      const centeredCb = color.cb - 128;
      const centeredCr = color.cr - 128;
      const chroma = Math.hypot(centeredCb, centeredCr);
      return {
        r: red & 255,
        g: green & 255,
        b: blue & 255,
        y: color.y,
        chroma,
        dirCb: chroma < 3 ? 0 : centeredCb / chroma,
        dirCr: chroma < 3 ? 0 : centeredCr / chroma,
        achromatic: chroma < 3,
      };
    }

    /**
     * Rebuilds the directional color-membership predicate shared by
     * `fp_kernel_07` and `fp_kernel_14`.
     * @param {ReturnType<referenceProtectionDescriptor>} background Background descriptor.
     * @param {ReturnType<referenceProtectionDescriptor>} candidate Candidate descriptor.
     * @param {number} red Pixel red channel.
     * @param {number} green Pixel green channel.
     * @param {number} blue Pixel blue channel.
     * @returns {boolean}
     */
    function referenceProtectionMatches(background, candidate, red, green, blue) {
      const directDistanceSquared =
        (red - candidate.r) ** 2 + (green - candidate.g) ** 2 + (blue - candidate.b) ** 2;
      const pixel = referenceProtectionDescriptor(red, green, blue);
      if (pixel.achromatic) {
        if (!candidate.achromatic) return false;
        return directDistanceSquared < 145;
      }
      if (candidate.achromatic) {
        const candidateLinear = [
          srgbToLinear(candidate.r),
          srgbToLinear(candidate.g),
          srgbToLinear(candidate.b),
        ];
        const backgroundLinear = [
          srgbToLinear(background.r),
          srgbToLinear(background.g),
          srgbToLinear(background.b),
        ];
        const pixelLinear = [srgbToLinear(red), srgbToLinear(green), srgbToLinear(blue)];
        const axis = backgroundLinear.map((channel, index) => channel - candidateLinear[index]);
        const axisLengthSquared = axis.reduce((sum, channel) => sum + channel * channel, 0);
        if (axisLengthSquared < 0.0001) return false;
        const projection =
          pixelLinear.reduce(
            (sum, channel, index) => sum + (channel - candidateLinear[index]) * axis[index],
            0,
          ) / axisLengthSquared;
        return projection <= 0.1 && directDistanceSquared < 301;
      }
      const directionDot = pixel.dirCb * candidate.dirCb + pixel.dirCr * candidate.dirCr;
      if (directionDot < 0.9) return false;
      if (
        directionDot >= 0.97 &&
        Math.abs(pixel.y - candidate.y) <= 5 &&
        Math.abs(pixel.chroma - candidate.chroma) <= 8
      ) {
        return true;
      }
      const crossAxis =
        background.chroma * (background.dirCb * candidate.dirCr - background.dirCr * candidate.dirCb);
      if (Math.abs(crossAxis) < 1) return false;
      const chromaPosition =
        (pixel.chroma * (pixel.dirCb * candidate.dirCr - pixel.dirCr * candidate.dirCb)) / crossAxis;
      if (pixel.chroma > candidate.chroma * 1.3) return false;
      const lightnessAxis = background.y - candidate.y;
      if (Math.abs(lightnessAxis) > 2 && chromaPosition + 0.2 < (pixel.y - candidate.y) / lightnessAxis) {
        return false;
      }
      return chromaPosition <= 0.1;
    }

    /**
     * Creates the reference directional protection mask. Mask bytes intentionally
     * use one for internal state while public selection masks continue to require 255.
     * @param {Uint8ClampedArray|Uint8Array} source RGBA source pixels.
     * @param {number} width Image width.
     * @param {number} height Image height.
     * @param {{r:number,g:number,b:number}} backgroundColor Reference/background color.
     * @param {Array<{r:number,g:number,b:number}|number[]>} protectedColors Protected colors.
     * @returns {Uint8Array|null}
     */
    function createReferenceProtectionMask(source, width, height, backgroundColor, protectedColors) {
      if (!Array.isArray(protectedColors) || !protectedColors.length) return null;
      const background = referenceProtectionDescriptor(
        backgroundColor.r,
        backgroundColor.g,
        backgroundColor.b,
      );
      const descriptors = protectedColors
        .slice(0, 32)
        .map((color) =>
          referenceProtectionDescriptor(
            Array.isArray(color) ? color[0] : color.r,
            Array.isArray(color) ? color[1] : color.g,
            Array.isArray(color) ? color[2] : color.b,
          ),
        );
      const protectedMask = new Uint8Array(width * height);
      for (let pixel = 0; pixel < protectedMask.length; pixel += 1) {
        const offset = pixel * 4;
        if (!source[offset + 3]) continue;
        if (
          descriptors.some((descriptor) =>
            referenceProtectionMatches(
              background,
              descriptor,
              source[offset],
              source[offset + 1],
              source[offset + 2],
            ),
          )
        )
          protectedMask[pixel] = 1;
      }
      return protectedMask;
    }

    /**
     * Selects protected colors with the reference direction-cluster and greedy
     * coverage semantics used by `fp_kernel_14`.
     * @param {Uint8ClampedArray|Uint8Array} data Source RGBA pixels.
     * @param {number} width Image width.
     * @param {number} height Image height.
     * @param {{r:number,g:number,b:number}} backgroundColor Background/reference color.
     * @param {object} [options] Reference selection options.
     * @returns {{colors:Array<{r:number,g:number,b:number,count:number}>,count:number,coverage:number,status:number,sampleCount:number}}
     */
    function selectReferenceProtectedColors(data, width, height, backgroundColor, options = {}) {
      const pixelCount = width * height;
      if (width <= 0 || height <= 0 || !data || data.length !== pixelCount * 4) {
        throw new RangeError("Reference protection RGBA length does not match its dimensions.");
      }
      const previewData = options.previewData || null;
      if (previewData && previewData.length !== data.length) {
        throw new RangeError("Reference protection preview length does not match its source.");
      }
      const background = referenceProtectionDescriptor(
        backgroundColor.r,
        backgroundColor.g,
        backgroundColor.b,
      );
      const maximumColors = Math.max(1, Math.min(32, Math.trunc(options.maximumColors || 32)));
      const coverageThreshold = Math.max(0, Math.min(100, Math.trunc(options.coverageThreshold ?? 95)));
      const step = pixelCount >= 5001 ? Math.max(1, Math.ceil(Math.sqrt(pixelCount / 5000))) : 1;
      const bucketCounts = new Uint32Array(4096);
      const samples = [];
      const centerX = width > 1 ? (width - 1) * 0.5 : 0;
      const centerY = height > 1 ? (height - 1) * 0.5 : 0;
      for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
          const pixel = y * width + x;
          const offset = pixel * 4;
          if (previewData && (previewData[offset + 3] === 0 || previewData[offset + 3] === 255)) continue;
          const descriptor = referenceProtectionDescriptor(data[offset], data[offset + 1], data[offset + 2]);
          const bucket = ((descriptor.r >> 4) << 8) | ((descriptor.g >> 4) << 4) | (descriptor.b >> 4);
          bucketCounts[bucket] += 1;
          samples.push({
            ...descriptor,
            sampleX: x,
            sampleY: y,
            radiusSquared: (x - centerX) ** 2 + (y - centerY) ** 2,
            bucket,
            weight: 0,
          });
        }
      }
      if (!samples.length) {
        return { colors: [], count: 0, coverage: 100, status: 0, sampleCount: 0 };
      }
      const sampleCoverageCache = new WeakMap();

      /**
       * Computes each candidate's sample membership once so medoid scoring and
       * greedy coverage reuse the reference predicate without changing its order.
       * @param {ReturnType<referenceProtectionDescriptor>} descriptor Candidate descriptor.
       * @returns {{matches:Uint8Array,count:number}} Matching sample facts.
       */
      const sampleCoverageFor = (descriptor) => {
        const cached = sampleCoverageCache.get(descriptor);
        if (cached) return cached;
        const matches = new Uint8Array(samples.length);
        let count = 0;
        for (let index = 0; index < samples.length; index += 1) {
          const sample = samples[index];
          if (!referenceProtectionMatches(background, descriptor, sample.r, sample.g, sample.b)) continue;
          matches[index] = 1;
          count += 1;
        }
        const facts = { matches, count };
        sampleCoverageCache.set(descriptor, facts);
        return facts;
      };
      for (const sample of samples) {
        sample.weight = bucketCounts[sample.bucket] / samples.length;
        if (!sample.achromatic && sample.dirCb * background.dirCb + sample.dirCr * background.dirCr >= 0.9) {
          sample.weight *= 0.1;
        }
      }
      samples.sort((left, right) => {
        if (left.achromatic !== right.achromatic) return left.achromatic ? 1 : -1;
        if (left.achromatic) return left.y - right.y;
        return Math.atan2(left.dirCr, left.dirCb) - Math.atan2(right.dirCr, right.dirCb);
      });
      const groups = [];
      let groupStart = 0;
      for (let index = 1; index <= samples.length; index += 1) {
        const previous = samples[index - 1];
        const current = samples[index];
        const sameDirection =
          current &&
          ((previous.achromatic && current.achromatic) ||
            (!previous.achromatic &&
              !current.achromatic &&
              previous.dirCb * current.dirCb + previous.dirCr * current.dirCr >= 0.9));
        if (sameDirection) continue;
        groups.push(samples.slice(groupStart, index));
        groupStart = index;
      }
      const candidates = [];
      for (const group of groups) {
        const selected = [];
        if (group.length < 5) {
          const representative = [...group].sort(
            (left, right) =>
              right.weight - left.weight || left.y - right.y || right.radiusSquared - left.radiusSquared,
          )[0];
          selected.push(
            [...group]
              .filter((sample) => sample.bucket === representative.bucket)
              .sort((left, right) => left.r - right.r || left.g - right.g || left.b - right.b)[0],
          );
        } else {
          const weights = group.map((sample) => sample.weight);
          if (Math.max(...weights) < Math.min(...weights) * 3) {
            const byLightness = [...group].sort(
              (left, right) => left.y - right.y || right.radiusSquared - left.radiusSquared,
            );
            const neighborhood = Math.max(1, Math.trunc(group.length / 6));
            for (const quantile of [0.25, 0.5, 0.75]) {
              const center = Math.min(
                group.length - 1,
                Math.max(0, Math.trunc((group.length - 1) * quantile)),
              );
              const start = Math.max(0, center - neighborhood);
              const end = Math.min(group.length - 1, center + neighborhood);
              let representative = byLightness[center];
              for (let index = start; index <= end; index += 1) {
                if (byLightness[index].weight > representative.weight) representative = byLightness[index];
              }
              selected.push(representative);
            }
          } else {
            const byWeight = [...group].sort(
              (left, right) =>
                right.weight - left.weight || left.y - right.y || right.radiusSquared - left.radiusSquared,
            );
            selected.push(byWeight[0]);
            const separated = byWeight.find((sample) => Math.abs(sample.y - byWeight[0].y) >= 15);
            if (separated) selected.push(separated);
          }
        }
        const globalCoverage = (candidate) => sampleCoverageFor(candidate).count;
        let bestCoverage = selected.reduce(
          (maximum, candidate) => Math.max(maximum, globalCoverage(candidate)),
          0,
        );
        let bestRadiusSquared = Number.POSITIVE_INFINITY;
        let medoid = null;
        for (const sample of group) {
          const coverage = globalCoverage(sample);
          const separatedFromBest = selected
            .filter((candidate) => globalCoverage(candidate) === bestCoverage)
            .every((candidate) => Math.abs(candidate.y - sample.y) >= 15);
          if (
            coverage > bestCoverage ||
            (coverage === bestCoverage &&
              separatedFromBest &&
              (!medoid || sample.radiusSquared < bestRadiusSquared))
          ) {
            medoid = sample;
            bestCoverage = coverage;
            bestRadiusSquared = sample.radiusSquared;
          }
        }
        if (medoid) selected.unshift(medoid);
        for (const sample of selected) {
          const alignedWithBackground =
            !sample.achromatic &&
            sample.chroma >= 3 &&
            sample.dirCb * background.dirCb + sample.dirCr * background.dirCr >= 0.9;
          candidates.push({
            ...sample,
            descriptor: sample,
            excluded: alignedWithBackground,
            fullCoverage: 0,
          });
        }
      }
      const fullOriginalData = options.fullOriginalData || null;
      const fullPreviewData = options.fullPreviewData || null;
      const fullWidth = Math.trunc(options.fullWidth || 0);
      const fullHeight = Math.trunc(options.fullHeight || 0);
      if (
        fullOriginalData &&
        fullPreviewData &&
        fullWidth > 0 &&
        fullHeight > 0 &&
        fullOriginalData.length === fullWidth * fullHeight * 4 &&
        fullPreviewData.length === fullOriginalData.length
      ) {
        let partialPixels = 0;
        for (let offset = 3; offset < fullPreviewData.length; offset += 4) {
          if (fullPreviewData[offset] > 0 && fullPreviewData[offset] < 255) partialPixels += 1;
        }
        const fullStep = partialPixels > 200000 ? 2 : 1;
        for (const candidate of candidates) {
          if (candidate.excluded) continue;
          let matches = 0;
          for (let y = 0; y < fullHeight; y += fullStep) {
            for (let x = 0; x < fullWidth; x += fullStep) {
              const offset = (y * fullWidth + x) * 4;
              const alpha = fullPreviewData[offset + 3];
              if (alpha === 0 || alpha === 255) continue;
              if (
                referenceProtectionMatches(
                  background,
                  candidate.descriptor,
                  fullOriginalData[offset],
                  fullOriginalData[offset + 1],
                  fullOriginalData[offset + 2],
                )
              )
                matches += 1;
            }
          }
          candidate.fullCoverage = (matches * fullStep * fullStep) / (fullWidth * fullHeight);
        }
        const visibleCandidates = candidates.filter((candidate) => !candidate.excluded);
        const substantial = visibleCandidates.filter((candidate) => candidate.fullCoverage >= 0.0005);
        if (substantial.length >= 2) {
          for (const candidate of visibleCandidates) {
            if (candidate.fullCoverage < 0.0005) candidate.excluded = true;
          }
        } else {
          const retained = new Set(
            [...visibleCandidates].sort((left, right) => right.fullCoverage - left.fullCoverage).slice(0, 2),
          );
          for (const candidate of visibleCandidates) {
            if (!retained.has(candidate)) candidate.excluded = true;
          }
        }
      }
      const existingColors = Array.isArray(options.existingColors) ? options.existingColors.slice(0, 32) : [];
      const existingDescriptors = existingColors.map((color) => {
        const red = Array.isArray(color) ? color[0] : color.r;
        const green = Array.isArray(color) ? color[1] : color.g;
        const blue = Array.isArray(color) ? color[2] : color.b;
        return referenceProtectionDescriptor(red, green, blue);
      });
      const covered = new Uint8Array(samples.length);
      let coveredCount = 0;
      for (let index = 0; index < samples.length; index += 1) {
        const sample = samples[index];
        if (
          existingDescriptors.some((descriptor) =>
            referenceProtectionMatches(background, descriptor, sample.r, sample.g, sample.b),
          )
        ) {
          covered[index] = 1;
          coveredCount += 1;
        }
      }
      const selectedColors = [];
      while (
        selectedColors.length < maximumColors &&
        coveredCount * 100 < samples.length * coverageThreshold
      ) {
        let bestCandidate = null;
        let bestCoverage = 0;
        for (const candidate of candidates) {
          if (candidate.excluded) continue;
          const matches = sampleCoverageFor(candidate.descriptor).matches;
          let candidateCoverage = 0;
          for (let index = 0; index < samples.length; index += 1) {
            if (!covered[index] && matches[index]) candidateCoverage += 1;
          }
          if (candidateCoverage > bestCoverage) {
            bestCandidate = candidate;
            bestCoverage = candidateCoverage;
          }
        }
        if (!bestCandidate || bestCoverage === 0) break;
        selectedColors.push({
          r: bestCandidate.r,
          g: bestCandidate.g,
          b: bestCandidate.b,
          count: bestCoverage,
        });
        const matches = sampleCoverageFor(bestCandidate.descriptor).matches;
        for (let index = 0; index < samples.length; index += 1) {
          if (!covered[index] && matches[index]) {
            covered[index] = 1;
            coveredCount += 1;
          }
        }
        bestCandidate.excluded = true;
      }
      const coverage = Math.trunc((coveredCount * 100) / samples.length);
      const status = coverage >= coverageThreshold ? 0 : selectedColors.length < maximumColors ? 2 : 1;
      return {
        colors: selectedColors,
        count: selectedColors.length,
        coverage,
        status,
        sampleCount: samples.length,
      };
    }

    /**
     * Selects representative protected colors inside a rectangle while retaining
     * the reference kernel's coverage and status metadata.
     * @param {Uint8ClampedArray|Uint8Array} data RGBA pixels.
     * @param {number} width Image width.
     * @param {number} height Image height.
     * @param {{x1:number,y1:number,x2:number,y2:number}} rectangle Selection rectangle.
     * @param {object} options Sampling options.
     * @returns {{colors:Array<{r:number,g:number,b:number,count:number}>,count:number,coverage:number,status:number,sampleCount:number}}
     */
    function selectProtectedColorsInRectangle(data, width, height, rectangle, options = {}) {
      const startX = Math.max(0, Math.floor(Math.min(rectangle.x1, rectangle.x2)));
      const endX = Math.min(width - 1, Math.ceil(Math.max(rectangle.x1, rectangle.x2)));
      const startY = Math.max(0, Math.floor(Math.min(rectangle.y1, rectangle.y2)));
      const endY = Math.min(height - 1, Math.ceil(Math.max(rectangle.y1, rectangle.y2)));
      const regionWidth = Math.max(0, endX - startX + 1);
      const regionHeight = Math.max(0, endY - startY + 1);
      if (!regionWidth || !regionHeight) {
        return { colors: [], count: 0, coverage: 100, status: 0, sampleCount: 0 };
      }
      const regionData = new Uint8ClampedArray(regionWidth * regionHeight * 4);
      const previewData = options.previewData || null;
      if (previewData && previewData.length !== data.length) {
        throw new RangeError("Protected-color preview length does not match its source.");
      }
      const regionPreviewData = previewData ? new Uint8ClampedArray(regionWidth * regionHeight * 4) : null;
      let targetOffset = 0;
      for (let y = startY; y <= endY; y += 1) {
        const sourceOffset = (y * width + startX) * 4;
        const sourceEnd = sourceOffset + regionWidth * 4;
        regionData.set(data.subarray(sourceOffset, sourceEnd), targetOffset);
        if (regionPreviewData) {
          regionPreviewData.set(previewData.subarray(sourceOffset, sourceEnd), targetOffset);
        }
        targetOffset += regionWidth * 4;
      }
      const excludeColors = Array.isArray(options.excludeColors) ? options.excludeColors : [];
      const backgroundColor = excludeColors[0] || options.backgroundColor || { r: 0, g: 255, b: 0 };
      return selectReferenceProtectedColors(regionData, regionWidth, regionHeight, backgroundColor, {
        coverageThreshold: Math.round(clamp(options.coverage ?? 0.95, 0, 1) * 100),
        maximumColors: options.maximumColors,
        existingColors: options.existingColors,
        previewData: regionPreviewData,
        fullOriginalData: data,
        fullPreviewData: previewData,
        fullWidth: width,
        fullHeight: height,
      });
    }

    /**
     * Samples representative protected colors inside a rectangle.
     * @param {Uint8ClampedArray|Uint8Array} data RGBA pixels.
     * @param {number} width Image width.
     * @param {number} height Image height.
     * @param {{x1:number,y1:number,x2:number,y2:number}} rectangle Selection rectangle.
     * @param {object} options Sampling options.
     * @returns {Array<{r:number,g:number,b:number,count:number}>}
     */
    function extractProtectedColors(data, width, height, rectangle, options = {}) {
      return selectProtectedColorsInRectangle(data, width, height, rectangle, options).colors;
    }

    return Object.freeze({
      createProtectedRegionMask,
      createReferenceProtectionMask,
      extractProtectedColors,
      referenceProtectionDescriptor,
      referenceProtectionMatches,
      selectProtectedColorsInRectangle,
      selectReferenceProtectedColors,
    });
  }

  return {
    createProtectionSelector,
  };
});
