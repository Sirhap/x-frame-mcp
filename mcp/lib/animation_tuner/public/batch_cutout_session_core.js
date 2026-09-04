(function attachBatchCutoutSessionCore(root, factory) {
  "use strict";

  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.BatchCutoutSessionCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (root) => {
  "use strict";

  const smartCutoutDefaults =
    (typeof module === "object" && module.exports
      ? require("./smart_cutout_defaults")
      : root?.XSXBSmartCutoutDefaults) || {};

  const NUMERIC_CONTROLS = Object.freeze([
    ["cutoutTolerance", "cutoutToleranceValue", "tolerance"],
    ["cutoutFeather", "cutoutFeatherValue", "feather"],
    ["cutoutAlphaThreshold", "cutoutAlphaValue", "alphaThreshold"],
    ["cutoutChromaFeather", "cutoutChromaFeatherValue", "chromaFeather"],
    ["cutoutEdgeBoost", "cutoutEdgeBoostValue", "edgeBoost"],
    ["cutoutBlendStrength", "cutoutBlendStrengthValue", "blendStrength"],
    ["cutoutAlphaLow", "cutoutAlphaLowValue", "alphaLow"],
    ["cutoutAlphaHigh", "cutoutAlphaHighValue", "alphaHigh"],
    ["cutoutDespillStrength", "cutoutDespillStrengthValue", "despillStrength"],
    ["cutoutEdgeDespillRadius", "cutoutEdgeDespillRadiusValue", "edgeDespillRadius"],
    ["cutoutEdgeRecoveryStrength", "cutoutEdgeRecoveryStrengthValue", "edgeRecoveryStrength"],
    ["cutoutBackgroundRadius", "cutoutBackgroundRadiusValue", "backgroundRadius"],
    ["cutoutBlurRadius", "cutoutBlurRadiusValue", "blurRadius"],
    ["cutoutProtectionTolerance", "cutoutProtectionToleranceValue", "protectionTolerance"],
  ]);
  const NUMERIC_PARAMETER_LIMITS = Object.freeze({
    tolerance: Object.freeze({ minimum: -1, maximum: 100, fallback: 1 }),
    feather: Object.freeze({ minimum: 0, maximum: 24, fallback: 0 }),
    alphaThreshold: Object.freeze({ minimum: 0, maximum: 48, fallback: 0 }),
    chromaFeather: Object.freeze({ minimum: 0, maximum: 100, fallback: 0 }),
    edgeBoost: Object.freeze({ minimum: 0, maximum: 100, fallback: 10 }),
    blendStrength: Object.freeze({ minimum: 0, maximum: 100, fallback: 0 }),
    alphaLow: Object.freeze({ minimum: 0, maximum: 255, fallback: 0 }),
    alphaHigh: Object.freeze({ minimum: 0, maximum: 255, fallback: 0 }),
    despillStrength: Object.freeze({ minimum: 0, maximum: 100, fallback: 0 }),
    edgeDespillRadius: Object.freeze({ minimum: 0, maximum: 12, fallback: 0 }),
    edgeRecoveryStrength: Object.freeze({ minimum: 0, maximum: 100, fallback: 0 }),
    backgroundRadius: Object.freeze({ minimum: 0, maximum: 30, fallback: 0 }),
    blurRadius: Object.freeze({ minimum: 0, maximum: 6, fallback: 0 }),
    protectionTolerance: Object.freeze({ minimum: 0, maximum: 40, fallback: 0 }),
  });
  const PROPAGATION_FIELDS = Object.freeze([
    "repairs",
    "undoneRepairs",
    "protectedColors",
    "backgroundSamples",
    "seedPoints",
    "processingParameters",
    "processingActivated",
    "automaticCutoutActivated",
    "pendingAutomaticPropagation",
  ]);
  const MAX_EDIT_HISTORY = 100;
  const REFERENCE_MODE_VALUES = new Set(["general", "blend", "chroma"]);

  /**
   * Normalizes one reference-kernel mode while preserving a caller-selected fallback.
   * @param {*} value Candidate mode.
   * @param {"general"|"blend"|"chroma"} fallback Safe fallback mode.
   * @returns {"general"|"blend"|"chroma"} Supported reference mode.
   */
  function normalizeReferenceMode(value, fallback) {
    const mode = String(value || "");
    return REFERENCE_MODE_VALUES.has(mode) ? mode : fallback;
  }

  /**
   * Normalizes persisted, preset, or generated automatic-processing parameters.
   * @param {object|null|undefined} value Candidate parameter record.
   * @param {object|null|undefined} fallback Existing parameters used for missing or invalid fields.
   * @returns {object} Complete bounded automatic-processing snapshot.
   */
  function normalizeProcessingParameters(value, fallback = {}) {
    const source = value && typeof value === "object" ? value : {};
    const defaults = fallback && typeof fallback === "object" ? fallback : {};
    const fallbackColor = /^#[0-9a-f]{6}$/i.test(String(defaults.backgroundColor || ""))
      ? String(defaults.backgroundColor).toLowerCase()
      : "#ffffff";
    const backgroundColor = /^#[0-9a-f]{6}$/i.test(String(source.backgroundColor || ""))
      ? String(source.backgroundColor).toLowerCase()
      : fallbackColor;
    const parameters = {
      backgroundColor,
      connected: source.connected === undefined ? Boolean(defaults.connected) : Boolean(source.connected),
      perceptual: source.perceptual === undefined ? Boolean(defaults.perceptual) : Boolean(source.perceptual),
      blendMode: normalizeReferenceMode(
        source.blendMode,
        normalizeReferenceMode(defaults.blendMode, "blend"),
      ),
      despillMode: normalizeReferenceMode(
        source.despillMode,
        normalizeReferenceMode(defaults.despillMode, "general"),
      ),
    };
    for (const [parameterKey, limits] of Object.entries(NUMERIC_PARAMETER_LIMITS)) {
      const candidate = Number(source[parameterKey]);
      const fallbackValue = Number(defaults[parameterKey]);
      const resolved = Number.isFinite(candidate)
        ? candidate
        : Number.isFinite(fallbackValue)
          ? fallbackValue
          : limits.fallback;
      parameters[parameterKey] = Math.max(limits.minimum, Math.min(limits.maximum, Math.round(resolved)));
    }
    if (parameters.alphaHigh > 0 && parameters.alphaLow > parameters.alphaHigh) {
      [parameters.alphaLow, parameters.alphaHigh] = [parameters.alphaHigh, parameters.alphaLow];
    }
    return parameters;
  }

  /**
   * Clones logical session values without copying Canvas or ImageData instances.
   * @param {*} value Serializable repair or parameter value.
   * @returns {*} Independent clone.
   */
  function cloneSessionValue(value) {
    if (Array.isArray(value)) return value.map(cloneSessionValue);
    if (ArrayBuffer.isView(value)) return value.slice();
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneSessionValue(entry)]));
  }

  /**
   * Stages the source frame's latest recolor as a non-destructive batch preview.
   * Target items keep their committed repair arrays unchanged until propagation.
   * @param {object} state Mutable batch session state.
   * @param {object|null|undefined} sourceItem Frame that owns the recolor repair.
   * @returns {boolean} Whether a recolor preview is active.
   */
  function stageBatchRepairPreview(state, sourceItem) {
    if (!state || typeof state !== "object") {
      throw new TypeError("Batch repair preview requires session state.");
    }
    const repair = sourceItem?.repairs?.at(-1);
    if (!sourceItem || !repair || repair.mode !== "recolor" || (state.items?.length || 0) < 2) {
      state.batchPreviewRepair = null;
      return false;
    }
    state.batchPreviewRepair = {
      sourceItemId: sourceItem.id,
      sourceWidth: Number(sourceItem.sourceImageData?.width || 1),
      sourceHeight: Number(sourceItem.sourceImageData?.height || 1),
      repair: cloneSessionValue(repair),
    };
    return true;
  }

  /**
   * Clears the non-destructive batch repair preview.
   * @param {object} state Mutable batch session state.
   * @returns {boolean} Whether a staged preview was removed.
   */
  function clearBatchRepairPreview(state) {
    if (!state || typeof state !== "object") return false;
    const changed = Boolean(state.batchPreviewRepair);
    state.batchPreviewRepair = null;
    return changed;
  }

  /**
   * Resolves committed repairs plus a derived recolor preview for one target frame.
   * Existing propagated geometry is reused when available; otherwise point
   * coordinates are normalized between source and target canvases.
   * @param {object} state Mutable batch session state.
   * @param {object} item Target queue item.
   * @returns {object[]} Effective repairs for preview rendering.
   */
  function previewRepairsForItem(state, item) {
    const committedRepairs = Array.isArray(item?.repairs) ? item.repairs : [];
    const preview = state?.batchPreviewRepair;
    if (!preview || !item || item.id === preview.sourceItemId) return committedRepairs;
    const sourceRepair = preview.repair;
    if (!sourceRepair || sourceRepair.mode !== "recolor") return committedRepairs;
    const propagatedRepair = committedRepairs.find(
      (repair) => repair.propagatedFrom && repair.propagatedFrom === sourceRepair.id,
    );
    const targetWidth = Math.max(1, Number(item.sourceImageData?.width || preview.sourceWidth));
    const targetHeight = Math.max(1, Number(item.sourceImageData?.height || preview.sourceHeight));
    const previewRepair = {
      ...(propagatedRepair ? cloneSessionValue(propagatedRepair) : cloneSessionValue(sourceRepair)),
      id: `batch_preview_${sourceRepair.id || "recolor"}_${item.id}`,
      previewOnly: true,
      color: cloneSessionValue(sourceRepair.color),
      tolerance: sourceRepair.tolerance,
      scope: sourceRepair.scope,
    };
    if (!propagatedRepair && sourceRepair.scope !== "global") {
      previewRepair.x =
        (Number(sourceRepair.x || 0) * targetWidth) / Math.max(1, Number(preview.sourceWidth || 1));
      previewRepair.y =
        (Number(sourceRepair.y || 0) * targetHeight) / Math.max(1, Number(preview.sourceHeight || 1));
    }
    const effectiveRepairs = propagatedRepair
      ? committedRepairs.filter((repair) => repair !== propagatedRepair)
      : [...committedRepairs];
    effectiveRepairs.push(previewRepair);
    return effectiveRepairs;
  }

  /**
   * Captures logical item state for a reversible apply-to-all transaction.
   * @param {object[]} items Session items.
   * @returns {Array<{item:object,state:object}>} In-memory transaction snapshot.
   */
  function captureItems(items) {
    return Array.from(items || []).map((item) => ({
      item,
      state: Object.fromEntries(PROPAGATION_FIELDS.map((field) => [field, cloneSessionValue(item[field])])),
    }));
  }

  /**
   * Restores a transaction snapshot and invalidates every restored result.
   * @param {Array<{item:object,state:object}>} snapshot Transaction snapshot.
   * @returns {void}
   */
  function restoreItems(snapshot) {
    for (const entry of snapshot || []) {
      for (const field of PROPAGATION_FIELDS) {
        entry.item[field] = cloneSessionValue(entry.state[field]);
      }
      resetItemProcessing(entry.item);
    }
  }

  /**
   * Captures one image's complete user-editable state.
   * @param {object} item Cutout session item.
   * @returns {object} Independent logical snapshot.
   */
  function captureItemState(item) {
    return Object.fromEntries(PROPAGATION_FIELDS.map((field) => [field, cloneSessionValue(item?.[field])]));
  }

  /**
   * Restores one image's complete user-editable state and invalidates derived pixels.
   * @param {object} item Cutout session item.
   * @param {object} snapshot Previously captured logical state.
   * @returns {void}
   */
  function restoreItemState(item, snapshot) {
    if (!item || !snapshot) return;
    for (const field of PROPAGATION_FIELDS) item[field] = cloneSessionValue(snapshot[field]);
    resetItemProcessing(item);
  }

  /**
   * Starts one reversible user edit and clears the stale redo branch.
   * @param {object} item Cutout session item.
   * @returns {void}
   */
  function recordItemEdit(item) {
    if (!item) return;
    if (!Array.isArray(item.editUndo)) item.editUndo = [];
    item.editUndo.push(captureItemState(item));
    if (item.editUndo.length > MAX_EDIT_HISTORY) item.editUndo.shift();
    item.editRedo = [];
  }

  /**
   * Ensures the DOM adapter exposes every required processing control.
   * @param {object} elements Cutout DOM adapter.
   * @returns {void}
   * @throws {TypeError} When a required control is missing.
   */
  function assertControls(elements) {
    const required = [
      "cutoutColor",
      "cutoutConnected",
      "cutoutPerceptual",
      "cutoutBlendMode",
      "cutoutDespillMode",
      ...NUMERIC_CONTROLS.flatMap(([inputKey, outputKey]) => [inputKey, outputKey]),
    ];
    const missing = required.filter((key) => !elements?.[key]);
    if (missing.length) throw new TypeError(`Missing cutout controls: ${missing.join(", ")}`);
  }

  /**
   * Captures automatic-cutout controls as a serializable per-image snapshot.
   * @param {object} elements Cutout DOM adapter.
   * @returns {object} Normalized processing parameters.
   */
  function captureProcessingParameters(elements) {
    assertControls(elements);
    const parameters = {
      backgroundColor: String(elements.cutoutColor.value || "#ffffff"),
      connected: Boolean(elements.cutoutConnected.checked),
      perceptual: Boolean(elements.cutoutPerceptual.checked),
      blendMode: normalizeReferenceMode(elements.cutoutBlendMode.value, "blend"),
      despillMode: normalizeReferenceMode(elements.cutoutDespillMode.value, "general"),
    };
    for (const [inputKey, , parameterKey] of NUMERIC_CONTROLS) {
      parameters[parameterKey] = Number(elements[inputKey].value);
    }
    return parameters;
  }

  /**
   * Restores a processing snapshot through the DOM adapter without emitting input events.
   * @param {object} elements Cutout DOM adapter.
   * @param {object|null|undefined} parameters Stored processing parameters.
   * @param {{syncNumericRange?:(input:object,output:object)=>void,onApplied?:()=>void}} [adapter] UI synchronization adapter.
   * @returns {void}
   */
  function applyProcessingParameters(elements, parameters, adapter = {}) {
    if (!parameters) return;
    assertControls(elements);
    elements.cutoutColor.value = String(parameters.backgroundColor || "#ffffff");
    elements.cutoutConnected.checked = Boolean(parameters.connected);
    elements.cutoutPerceptual.checked = Boolean(parameters.perceptual);
    elements.cutoutBlendMode.value = normalizeReferenceMode(parameters.blendMode, "blend");
    elements.cutoutDespillMode.value = normalizeReferenceMode(parameters.despillMode, "general");
    for (const [inputKey, outputKey, parameterKey] of NUMERIC_CONTROLS) {
      const value = Number(parameters[parameterKey]);
      if (Number.isFinite(value)) elements[inputKey].value = String(value);
      adapter.syncNumericRange?.(elements[inputKey], elements[outputKey]);
    }
    adapter.onApplied?.();
  }

  /**
   * Creates normalized worker options from one item's processing snapshot.
   * @param {object} item Queue item.
   * @param {{backgroundColor:object,backgroundColors:object[],protectedColors:object[]}} palettes Resolved per-image colors.
   * @returns {object} Worker processing options.
   */
  function createProcessingOptions(item, palettes) {
    const parameters = item?.processingParameters;
    if (!parameters) throw new TypeError("Cutout item has no processing parameter snapshot.");
    return {
      backgroundColor: palettes.backgroundColor,
      backgroundColors: palettes.backgroundColors,
      tolerance: parameters.tolerance,
      feather: parameters.feather,
      alphaThreshold: parameters.alphaThreshold,
      connected: parameters.connected,
      perceptual: parameters.perceptual,
      referenceChromaKey:
        typeof smartCutoutDefaults.referenceChromaKeyFor === "function"
          ? smartCutoutDefaults.referenceChromaKeyFor(palettes.backgroundColor, parameters.perceptual)
          : !parameters.perceptual,
      chromaFeather: parameters.chromaFeather,
      seedPoints: item.seedPoints || [],
      edgeBoost: parameters.edgeBoost,
      blendStrength: parameters.blendStrength,
      blendMode: normalizeReferenceMode(parameters.blendMode, "blend"),
      alphaLow:
        parameters.alphaHigh > 0 ? Math.min(parameters.alphaLow, parameters.alphaHigh) : parameters.alphaLow,
      alphaHigh:
        parameters.alphaHigh > 0 ? Math.max(parameters.alphaLow, parameters.alphaHigh) : parameters.alphaHigh,
      despillStrength: parameters.despillStrength,
      despillMode: normalizeReferenceMode(parameters.despillMode, "general"),
      edgeDespillRadius: parameters.edgeDespillRadius,
      edgeRecoveryStrength: parameters.edgeRecoveryStrength,
      edgeRecoveryTolerance: 0,
      backgroundRadius: parameters.backgroundRadius,
      blurRadius: parameters.blurRadius,
      protectedColors: palettes.protectedColors,
      protectionTolerance: parameters.protectionTolerance,
      automaticCutout: Boolean(item.automaticCutoutActivated),
    };
  }

  /**
   * Clears one item's derived processing caches while retaining source data and edits.
   * @param {object|null} item Queue item.
   * @returns {void}
   */
  function resetItemProcessing(item) {
    if (!item) return;
    item.processingRevision = Number(item.processingRevision || 0) + 1;
    item.processingPromise = null;
    item.status = "ready";
    item.error = "";
    item.resultCanvas = null;
    item.resultImageData = null;
    item.resultThumbnail = "";
    item.resultVariant = "";
    item.thumbnailRevision = -1;
    item.qualityMetrics = null;
    item.quality = null;
    item.diagnosticCanvases = {};
  }

  /**
   * Finds the nearest target pixel that still matches one propagated background color.
   * Color distance is evaluated before spatial distance so a moved sprite cannot leave
   * the mapped seed on foreground pixels and silently produce an empty connected mask.
   * @param {{width:number,height:number,data:ArrayLike<number>}|null} imageData Target source pixels.
   * @param {{r:number,g:number,b:number}|null} color Propagated background sample.
   * @param {{x:number,y:number}} predictedPoint Canvas-scaled source position.
   * @param {number} tolerance Maximum normalized RGB distance accepted as background.
   * @returns {{x:number,y:number}|null} Reacquired target seed, or null when no color match exists.
   */
  function reacquireAutomaticSeed(imageData, color, predictedPoint, tolerance) {
    const width = Math.trunc(Number(imageData?.width));
    const height = Math.trunc(Number(imageData?.height));
    if (!imageData?.data || width <= 0 || height <= 0 || !color) return null;
    const maximumColorDistance = Math.max(0, Number(tolerance) || 0);
    let bestPoint = null;
    let bestColorDistance = Number.POSITIVE_INFINITY;
    let bestSpatialDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < width * height; index += 1) {
      const offset = index * 4;
      if ((imageData.data[offset + 3] || 0) === 0) continue;
      const redDelta = Number(imageData.data[offset]) - Number(color.r);
      const greenDelta = Number(imageData.data[offset + 1]) - Number(color.g);
      const blueDelta = Number(imageData.data[offset + 2]) - Number(color.b);
      const colorDistance = (Math.hypot(redDelta, greenDelta, blueDelta) / Math.sqrt(3 * 255 * 255)) * 100;
      if (colorDistance > maximumColorDistance) continue;
      const x = index % width;
      const y = Math.floor(index / width);
      const spatialDistance = (x - predictedPoint.x) ** 2 + (y - predictedPoint.y) ** 2;
      if (
        colorDistance < bestColorDistance ||
        (colorDistance === bestColorDistance && spatialDistance < bestSpatialDistance)
      ) {
        bestColorDistance = colorDistance;
        bestSpatialDistance = spatialDistance;
        bestPoint = { x, y };
      }
    }
    return bestPoint;
  }

  /**
   * Reacquires source background seed points in a target image's canvas space.
   * @param {object} sourceItem Source session item.
   * @param {object} targetItem Target session item.
   * @returns {Array<{x:number,y:number}>} Independent target-space seed points.
   */
  function mapAutomaticSeedPoints(sourceItem, targetItem) {
    const sourceWidth = Number(sourceItem?.sourceImageData?.width || sourceItem?.sourceCanvas?.width);
    const sourceHeight = Number(sourceItem?.sourceImageData?.height || sourceItem?.sourceCanvas?.height);
    const targetWidth = Number(targetItem?.sourceImageData?.width || targetItem?.sourceCanvas?.width);
    const targetHeight = Number(targetItem?.sourceImageData?.height || targetItem?.sourceCanvas?.height);
    if (
      sourceWidth <= 0 ||
      sourceHeight <= 0 ||
      targetWidth <= 0 ||
      targetHeight <= 0 ||
      !Array.isArray(sourceItem?.seedPoints)
    )
      return [];
    const tolerance = Math.max(
      1,
      Number(sourceItem.processingParameters?.tolerance || 0) +
        Number(sourceItem.processingParameters?.edgeBoost || 0) * 0.12,
    );
    return sourceItem.seedPoints.flatMap((point, index) => {
      if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return [];
      const predictedPoint = {
        x: Math.max(0, Math.min(targetWidth - 1, (point.x * targetWidth) / sourceWidth)),
        y: Math.max(0, Math.min(targetHeight - 1, (point.y * targetHeight) / sourceHeight)),
      };
      const targetPoint = reacquireAutomaticSeed(
        targetItem?.sourceImageData || null,
        sourceItem.backgroundSamples?.[index] || sourceItem.backgroundSamples?.[0] || null,
        predictedPoint,
        tolerance,
      );
      return [targetPoint || predictedPoint];
    });
  }

  /**
   * Samples target-frame background colors at propagated seed points.
   * Video decoding can shift a nominally solid background by a few RGB values
   * between frames, so retaining the source-frame colors would make a narrow
   * tolerance remove only the frame where the user sampled the background.
   *
   * @param {object} sourceItem Source session item.
   * @param {object} targetItem Target session item.
   * @param {Array<{x:number,y:number}>} seedPoints Mapped target-space seed points.
   * @returns {Array<{r:number,g:number,b:number,a:number}>} Per-target background colors.
   */
  function sampleMappedBackgroundColors(sourceItem, targetItem, seedPoints) {
    const sourceColors = Array.isArray(sourceItem?.backgroundSamples) ? sourceItem.backgroundSamples : [];
    const imageData = targetItem?.sourceImageData;
    const width = Math.trunc(Number(imageData?.width));
    const height = Math.trunc(Number(imageData?.height));
    if (!imageData?.data || width <= 0 || height <= 0 || !seedPoints.length) {
      return cloneSessionValue(sourceColors);
    }
    return sourceColors.map((sourceColor, index) => {
      const point = seedPoints[index];
      if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
        return cloneSessionValue(sourceColor);
      }
      const x = Math.max(0, Math.min(width - 1, Math.round(point.x)));
      const y = Math.max(0, Math.min(height - 1, Math.round(point.y)));
      const offset = (y * width + x) * 4;
      const alpha = Number(imageData.data[offset + 3] || 0);
      if (!alpha) return cloneSessionValue(sourceColor);
      return {
        r: Number(imageData.data[offset]),
        g: Number(imageData.data[offset + 1]),
        b: Number(imageData.data[offset + 2]),
        a: alpha,
      };
    });
  }

  /**
   * Copies the complete automatic background-removal stage to one target item.
   * Local repairs are intentionally preserved so callers can compose automatic
   * processing with a subsequently propagated repair in the same transaction.
   * @param {object} targetItem Target session item.
   * @param {object} sourceItem Source session item.
   * @param {{mapSeedPoints?:boolean}} [options] Per-image propagation behavior.
   * @returns {void}
   */
  function copyAutomaticProcessingState(targetItem, sourceItem, options = {}) {
    if (!targetItem || !sourceItem?.processingParameters) {
      throw new TypeError("Automatic processing copy requires source parameters and a target item.");
    }
    targetItem.processingParameters = cloneSessionValue(sourceItem.processingParameters);
    targetItem.seedPoints = options.mapSeedPoints ? mapAutomaticSeedPoints(sourceItem, targetItem) : [];
    targetItem.backgroundSamples = options.mapSeedPoints
      ? sampleMappedBackgroundColors(sourceItem, targetItem, targetItem.seedPoints)
      : cloneSessionValue(sourceItem.backgroundSamples || []);
    targetItem.automaticCutoutActivated = true;
    targetItem.processingActivated = true;
    targetItem.pendingAutomaticPropagation = false;
    resetItemProcessing(targetItem);
  }

  /**
   * Synchronizes shared automatic settings for a file batch without creating a
   * user-visible repair propagation transaction. Background samples captured
   * from the source frame are reacquired at the same normalized seed points so
   * video frames with slightly different green-screen colors do not retain the
   * source frame's color by mistake.
   * @param {object[]} items Session items.
   * @param {object|null} sourceItem Selected source item.
   * @param {object} processingParameters Current automatic processing parameters.
   * @param {{mapSeedPoints?:boolean}} [options] Background sample mapping behavior.
   * @returns {{updated:number,mappedBackgroundSamples:boolean}} Synchronization summary.
   */
  function synchronizeBatchAutomaticProcessing(items, sourceItem, processingParameters, options = {}) {
    const targets = Array.isArray(items) ? items : [];
    if (!sourceItem || !processingParameters || typeof processingParameters !== "object") {
      throw new TypeError("Batch automatic synchronization requires a source item and parameters.");
    }
    sourceItem.processingParameters = cloneSessionValue(processingParameters);
    const mappedBackgroundSamples = Boolean(
      sourceItem.automaticCutoutActivated && sourceItem.backgroundSamples?.length,
    );
    for (const item of targets) {
      if (mappedBackgroundSamples) {
        copyAutomaticProcessingState(item, sourceItem, {
          mapSeedPoints: options.mapSeedPoints !== false,
        });
        continue;
      }
      item.processingParameters = cloneSessionValue(processingParameters);
      item.pendingAutomaticPropagation = false;
      resetItemProcessing(item);
    }
    return { updated: targets.length, mappedBackgroundSamples };
  }

  /**
   * Copies one source image's automatic-cutout settings to every session item.
   * Manual FramePacker reference colors are copied to every target image.
   * @param {object[]} items Session items.
   * @param {object} sourceItem Selected source item.
   * @param {{publishedCanvases?:object[],mapSeedPoints?:boolean}} [options] Transaction and per-image seed behavior.
   * @returns {number} Number of updated items.
   */
  function propagateAutomaticProcessing(items, sourceItem, options = {}) {
    if (!sourceItem?.processingParameters) {
      throw new TypeError("Automatic propagation requires a source parameter snapshot.");
    }
    beginPropagation(items, sourceItem, options);
    for (const item of items || []) {
      copyAutomaticProcessingState(item, sourceItem, options);
    }
    return Array.isArray(items) ? items.length : 0;
  }

  /**
   * Starts a reversible apply-to-all transaction on the source item.
   * @param {object[]} items Session items.
   * @param {object} sourceItem Selected source item.
   * @param {{publishedCanvases?:object[],live?:boolean}} [options] Host publication behavior.
   * @returns {void}
   */
  function beginPropagation(items, sourceItem, options = {}) {
    if (!sourceItem) throw new TypeError("Propagation requires a source item.");
    sourceItem.propagationUndo = {
      snapshot: captureItems(items),
      repairCount: sourceItem.repairs?.length || 0,
      editUndoCount: sourceItem.editUndo?.length || 0,
      live: options.live !== false,
      publishedCanvases: Array.isArray(options.publishedCanvases)
        ? Array.from(options.publishedCanvases)
        : null,
    };
    sourceItem.propagationRedo = null;
  }

  /**
   * Restores the state preceding the latest apply-to-all transaction.
   * @param {object[]} items Session items.
   * @param {object} sourceItem Selected source item.
   * @returns {boolean} Whether a transaction was restored.
   */
  function undoPropagation(items, sourceItem) {
    const transaction = sourceItem?.propagationUndo;
    const hasNewerRepair = (sourceItem?.repairs?.length || 0) > transaction?.repairCount;
    const hasNewerItemEdit = (sourceItem?.editUndo?.length || 0) > transaction?.editUndoCount;
    if (!transaction || hasNewerRepair || hasNewerItemEdit) return false;
    const redoSnapshot = captureItems(items);
    const redoPublishedCanvases =
      transaction.live === false ? null : Array.from(items || [], (item) => item.publishedCanvas || null);
    restoreItems(transaction.snapshot);
    sourceItem.propagationUndo = null;
    sourceItem.propagationRedo = {
      snapshot: redoSnapshot,
      publishedCanvases: redoPublishedCanvases,
      live: transaction.live !== false,
    };
    return true;
  }

  /**
   * Reapplies the most recently undone apply-to-all transaction.
   * @param {object[]} items Session items.
   * @param {object} sourceItem Selected source item.
   * @returns {boolean} Whether a transaction was reapplied.
   */
  function redoPropagation(items, sourceItem) {
    const transaction = sourceItem?.propagationRedo;
    if (!transaction) return false;
    const undoSnapshot = captureItems(items);
    restoreItems(transaction.snapshot);
    sourceItem.propagationUndo = {
      snapshot: undoSnapshot,
      repairCount: sourceItem.repairs?.length || 0,
      editUndoCount: sourceItem.editUndo?.length || 0,
      publishedCanvases:
        transaction.live === false ? null : Array.from(items || [], (item) => item.publishedCanvas || null),
      live: transaction.live !== false,
    };
    sourceItem.propagationRedo = null;
    return true;
  }

  /**
   * Undoes the latest local edit or apply-to-all transaction in user-visible order.
   * @param {object[]} items Session items.
   * @param {object} sourceItem Selected source item.
   * @returns {{changed:boolean,live:boolean}} Undo result and live-publish requirement.
   */
  function undoEdit(items, sourceItem) {
    const transaction = sourceItem?.propagationUndo;
    const publishedCanvases = transaction?.publishedCanvases;
    if (undoPropagation(items, sourceItem)) {
      return {
        changed: true,
        live: transaction?.live !== false,
        ...(publishedCanvases ? { publishedCanvases } : {}),
      };
    }
    const snapshot = sourceItem?.editUndo?.pop();
    if (snapshot) {
      if (!Array.isArray(sourceItem.editRedo)) sourceItem.editRedo = [];
      sourceItem.editRedo.push(captureItemState(sourceItem));
      restoreItemState(sourceItem, snapshot);
      return { changed: true, live: false };
    }
    const repair = sourceItem?.repairs?.pop();
    if (!repair) return { changed: false, live: false };
    sourceItem.undoneRepairs.push(repair);
    resetItemProcessing(sourceItem);
    return { changed: true, live: Boolean(sourceItem.propagationRedo) };
  }

  /**
   * Redoes local edits before reapplying a later apply-to-all transaction.
   * @param {object[]} items Session items.
   * @param {object} sourceItem Selected source item.
   * @returns {{changed:boolean,live:boolean}} Redo result and live-publish requirement.
   */
  function redoEdit(items, sourceItem) {
    const snapshot = sourceItem?.editRedo?.pop();
    if (snapshot) {
      if (!Array.isArray(sourceItem.editUndo)) sourceItem.editUndo = [];
      sourceItem.editUndo.push(captureItemState(sourceItem));
      restoreItemState(sourceItem, snapshot);
      return { changed: true, live: false };
    }
    const repair = sourceItem?.undoneRepairs?.pop();
    if (repair) {
      sourceItem.repairs.push(repair);
      resetItemProcessing(sourceItem);
      return { changed: true, live: Boolean(sourceItem.propagationRedo) };
    }
    const transaction = sourceItem?.propagationRedo;
    const publishedCanvases = transaction?.publishedCanvases;
    if (!redoPropagation(items, sourceItem)) return { changed: false, live: false };
    return {
      changed: true,
      live: transaction?.live !== false,
      ...(publishedCanvases ? { publishedCanvases } : {}),
    };
  }

  return Object.freeze({
    NUMERIC_PARAMETER_LIMITS,
    applyProcessingParameters,
    beginPropagation,
    captureProcessingParameters,
    clearBatchRepairPreview,
    copyAutomaticProcessingState,
    createProcessingOptions,
    normalizeProcessingParameters,
    previewRepairsForItem,
    recordItemEdit,
    propagateAutomaticProcessing,
    redoEdit,
    redoPropagation,
    resetItemProcessing,
    stageBatchRepairPreview,
    synchronizeBatchAutomaticProcessing,
    undoEdit,
    undoPropagation,
  });
});
