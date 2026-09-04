(function attachBatchCutoutSessionController(root, factory) {
  "use strict";

  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BatchCutoutSessionController = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (root) => {
  "use strict";

  /**
   * Captures cutout queue mutations that should prompt before leaving.
   * Preview-arming `processingActivated` is not included: merely rendering the
   * result view is not a user edit.
   * @param {object[]} items Cutout queue items.
   * @returns {string} Stable session signature.
   */
  function sessionChangeSignature(items) {
    return Array.from(items || [])
      .map((item) =>
        [
          String(item.id || ""),
          item.excluded ? 1 : 0,
          Number(item.processingRevision || 0),
          JSON.stringify(item.processingParameters || {}),
          JSON.stringify(item.backgroundSamples || []),
          JSON.stringify(item.protectedColors || []),
          JSON.stringify(item.seedPoints || []),
          String((item.repairs || []).length),
        ].join("\u001f"),
      )
      .join("\u001e");
  }

  /**
   * Marks the current queue as the accepted leave-confirm baseline.
   * @param {object} state Cutout session state.
   * @returns {void}
   */
  function acceptSession(state) {
    if (!state) return;
    state.acceptedSessionSignature = sessionChangeSignature(state.items);
  }

  /**
   * Converts an estimated RGB background into the color input's canonical HEX.
   * @param {{r:number,g:number,b:number}} color Estimated background color.
   * @returns {string} Six-digit lowercase HEX color.
   */
  function backgroundHex(color) {
    const channel = (value) => Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
    return `#${[color.r, color.g, color.b]
      .map((value) => channel(value).toString(16).padStart(2, "0"))
      .join("")}`;
  }

  /**
   * Commits an auto-detected key color onto a queue item and arms automatic cutout.
   * Used by workset import and the live /tools/cutout file path.
   * @param {object} item Queue item with sourceImageData.
   * @param {{estimateBackgroundColor?:Function,backgroundController?:object}} [options] Detector and color helper.
   * @returns {void}
   */
  function activateAutomaticBackgroundDetection(item, options = {}) {
    const estimate = options.estimateBackgroundColor;
    if (typeof estimate !== "function") {
      throw new Error("Automatic background detection is unavailable.");
    }
    if (!item?.sourceImageData?.data) return;
    const estimatorApi =
      (typeof module === "object" && module.exports
        ? require("./batch_cutout_background_estimator")
        : root?.BatchCutoutBackgroundEstimator) || {};
    const alreadyCutOut =
      options.alreadyCutOut ||
      estimatorApi.alreadyCutOut ||
      (typeof module === "object" && module.exports
        ? require("../../xsxb_mcp_cutout").alreadyCutOut
        : null);
    if (
      typeof alreadyCutOut === "function" &&
      alreadyCutOut(
        item.sourceImageData.data,
        item.sourceImageData.width,
        item.sourceImageData.height,
      )
    ) {
      return;
    }
    const estimated = estimate(
      item.sourceImageData.data,
      item.sourceImageData.width,
      item.sourceImageData.height,
    );
    const background = options.backgroundController?.normalizeColor
      ? options.backgroundController.normalizeColor(estimated)
      : { r: estimated.r, g: estimated.g, b: estimated.b, a: 255 };
    const smartDefaults =
      (typeof module === "object" && module.exports
        ? require("./smart_cutout_defaults")
        : typeof globalThis !== "undefined"
          ? globalThis.XSXBSmartCutoutDefaults
          : null) || {};
    if (typeof smartDefaults.overlaySmartCutoutParameters === "function") {
      item.processingParameters = smartDefaults.overlaySmartCutoutParameters(
        item.processingParameters,
        background,
      );
    } else {
      item.processingParameters = { ...(item.processingParameters || {}) };
    }
    item.processingParameters.backgroundColor = backgroundHex(background);
    item.backgroundSamples = [background];
    item.seedPoints = [];
    item.automaticCutoutActivated = true;
    item.processingActivated = true;
    item.pendingAutomaticPropagation = false;
  }

  /**
   * Creates the modal and isolated-workset session controller.
   * @param {object} dependencies Modal/session dependencies supplied by the host.
   * @returns {{clear:Function,deleteSelectedItems:Function,open:Function,openWorkset:Function,close:Function,requestClose:Function,hasWorksetChanges:Function,hasUnsavedChanges:Function}}
   */
  function createController(dependencies = {}) {
    const {
      state,
      elements,
      text,
      documentRef = root?.document,
      host = {},
      setRepairMode,
      setEditorInert,
      renderLanguage,
      renderPreview,
      scheduleBatchThumbnails,
      stopBatchPlayback,
      cancelRepairGestureFrame,
      resolveConfirmation,
      resultArtifacts,
      assertImagePixelBudget,
      createItem,
      applyProcessingParametersToControls,
      selectedItem,
      renderQueue,
      setStatus,
      requestConfirmation,
      estimateBackgroundColor = root?.BatchCutoutBackgroundEstimator?.estimateBackgroundColor ||
        root?.BatchCutoutCore?.estimateBackgroundColor,
      backgroundController = root?.BatchCutoutBackgroundController,
      onSessionReset = () => {},
    } = dependencies;
    if (!state || !elements || typeof selectedItem !== "function" || typeof createItem !== "function") {
      throw new TypeError("BatchCutoutSessionController dependencies are required.");
    }
    const documentApi = documentRef;
    const suspendedBatchFields = [
      "items",
      "sourceKind",
      "sessionMode",
      "selectedIndex",
      "selectionAnchorIndex",
      "settingsMode",
      "repairMode",
      "previewScale",
      "previewFitScale",
      "previewPanX",
      "previewPanY",
      "previewMode",
      "previewBackground",
      "batchPreviewRepair",
      "batchPreviewRevision",
      "thumbnailMode",
      "batchTrayCollapsed",
      "qualityOnly",
      "protectionPreview",
      "samplingProtectedColor",
      "samplingBackgroundColor",
      "acceptedSessionSignature",
    ];

    /** Preserves a standalone batch while an organizer-owned workset is edited. @returns {void} */
    function suspendStandaloneBatch() {
      if (state.sourceKind === "workset" || !state.items.length || state.suspendedBatchSession) return;
      state.suspendedBatchSession = Object.fromEntries(
        suspendedBatchFields.map((field) => [field, state[field]]),
      );
      state.suspendedBatchSession.selectedIds = new Set(state.selectedIds || []);
    }

    /** Restores a standalone batch after its organizer-owned workset closes. @returns {boolean} */
    function restoreSuspendedBatch() {
      const snapshot = state.suspendedBatchSession;
      state.suspendedBatchSession = null;
      if (!snapshot) return false;
      for (const field of suspendedBatchFields) state[field] = snapshot[field];
      state.selectedIds = new Set(snapshot.selectedIds || []);
      applyProcessingParametersToControls(selectedItem()?.processingParameters);
      renderQueue();
      renderPreview();
      scheduleBatchThumbnails();
      return true;
    }

    /**
     * Restores persisted workset parameters, then optionally activates per-image background detection.
     * Explicit workset parameters take precedence so a new batch always starts from its requested profile.
     * @param {object} item Newly created cutout queue item.
     * @param {object} input Organizer workset input.
     * @param {object} workset Workset session options.
     * @returns {void}
     */
    function restoreWorksetCutoutState(item, input, workset) {
      const persisted = input?.cutoutState || {};
      item.processingParameters = {
        ...(item.processingParameters || {}),
        ...(persisted.processingParameters || {}),
        ...(workset.processingParameters || {}),
      };
      item.backgroundSamples = Array.from(persisted.backgroundSamples || [], (color) => ({ ...color }));
      item.seedPoints = Array.from(persisted.seedPoints || [], (point) => ({ ...point }));
      if (!workset.autoDetectBackground) return;
      activateAutomaticBackgroundDetection(item, { estimateBackgroundColor, backgroundController });
    }

    /** Clears transient batch-preview state without touching committed repairs. @returns {void} */
    function resetBatchPreviewState() {
      state.batchPreviewRepair = null;
      state.batchPreviewRevision = Number(state.batchPreviewRevision || 0) + 1;
      if (elements.cutoutModal?.dataset) elements.cutoutModal.dataset.batchPreview = "false";
      elements.cutoutRepairBatch?.classList.remove("previewPending");
      elements.cutoutRepairBatch?.setAttribute("aria-pressed", "false");
    }

    /**
     * Clears the current batch after an explicit confirmation.
     * @param {{mode?:"clear"|"new"}} [options] Confirmation wording variant.
     * @returns {Promise<boolean>} Whether the batch was cleared.
     */
    async function clear(options = {}) {
      const newBatch = options.mode === "new";
      if (!state.items.length) {
        onSessionReset();
        resetBatchPreviewState();
        acceptSession(state);
        setStatus(text("ready"));
        return true;
      }
      const confirmed = await requestConfirmation(text(newBatch ? "newBatchConfirm" : "clearConfirm"), [], {
        title: text(newBatch ? "newBatchTitle" : "clearTitle"),
        confirmLabel: text(newBatch ? "confirmNewBatch" : "confirmClear"),
        tone: "danger",
      });
      if (!confirmed) return false;
      onSessionReset();
      stopBatchPlayback();
      state.thumbnailJob += 1;
      resultArtifacts.clear();
      resetBatchPreviewState();
      state.items = [];
      state.sourceKind = "";
      state.selectedIndex = 0;
      state.selectedIds.clear();
      state.selectionAnchorIndex = 0;
      state.samplingProtectedColor = false;
      state.samplingBackgroundColor = false;
      state.protectionPreview = null;
      state.previewScale = null;
      state.previewFitScale = null;
      state.previewPanX = 0;
      state.previewPanY = 0;
      state.cancelRequested = false;
      state.batchTrayCollapsed = true;
      state.previewMode = "result";
      state.qualityOnly = false;
      acceptSession(state);
      renderQueue();
      renderPreview();
      setStatus(text("ready"));
      return true;
    }

    /**
     * Removes selected batch items after explicit confirmation.
     * @returns {Promise<void>}
     */
    async function deleteSelectedItems() {
      const selectedCount = state.selectedIds.size;
      if (!selectedCount) return;
      const confirmed = await requestConfirmation(text("deleteConfirm", { count: selectedCount }), [], {
        title: text("deleteTitle"),
        confirmLabel: text("confirmDelete"),
        tone: "danger",
      });
      if (!confirmed) return;
      onSessionReset();
      stopBatchPlayback();
      state.thumbnailJob += 1;
      const currentItemId = selectedItem()?.id;
      state.items = state.items.filter((item) => !state.selectedIds.has(item.id));
      if (
        state.batchPreviewRepair &&
        !state.items.some((item) => item.id === state.batchPreviewRepair.sourceItemId)
      ) {
        resetBatchPreviewState();
      }
      state.selectedIds.clear();
      const preservedIndex = state.items.findIndex((item) => item.id === currentItemId);
      state.selectedIndex =
        preservedIndex >= 0
          ? preservedIndex
          : Math.min(state.selectedIndex, Math.max(0, state.items.length - 1));
      if (state.items[state.selectedIndex]) state.selectedIds.add(state.items[state.selectedIndex].id);
      state.selectionAnchorIndex = state.selectedIndex;
      renderQueue();
      renderPreview();
      scheduleBatchThumbnails();
    }

    /**
     * Opens the modal workbench.
     * @param {{syncRoute?:boolean}} [options] Route synchronization behavior.
     * @returns {void}
     */
    function open(options = {}) {
      if (state.sourceKind !== "workset") state.sessionMode = "batch";
      if (!state.items.length) {
        elements.cutoutConnected.checked = false;
        elements.cutoutPerceptual.checked = false;
        state.batchTrayCollapsed = true;
      } else if (state.sourceKind !== "workset") {
        setStatus(text("batchResumed", { count: state.items.length }), "idle");
      }
      state.returnFocus = documentApi.activeElement;
      elements.cutoutModal.hidden = false;
      setRepairMode("automatic");
      setEditorInert(true);
      documentApi.body.classList.add("cutoutOpen");
      if (options.syncRoute !== false) host.onOpen?.();
      renderLanguage();
      renderPreview();
      scheduleBatchThumbnails();
      elements.cutoutAddFiles.focus();
    }

    /**
     * Opens an isolated cutout session for an unsaved animation workset.
     * Applying resolves with processed outputs; closing resolves with null.
     * @param {{name?:string,mode?:"single"|"batch",selectedIndex?:number,autoDetectBackground?:boolean,processingParameters?:object,onLiveApply?:(outputs:Array<object>)=>void,present?:boolean,items:Array<{name?:string,image:CanvasImageSource,frame?:object,cutoutState?:object}>}} workset Unsaved frame workset.
     * @returns {Promise<Array<object>|null>}
     */
    function openWorkset(workset) {
      if (state.busy) return Promise.reject(new Error("Batch cutout is busy."));
      const inputs = Array.isArray(workset?.items) ? workset.items : [];
      if (!inputs.length) return Promise.reject(new Error(text("invalidFiles")));
      if (inputs.length > 240) return Promise.reject(new Error(text("tooMany")));
      onSessionReset();
      if (state.worksetResolver) {
        const previousResolver = state.worksetResolver;
        state.worksetResolver = null;
        previousResolver(null);
      }
      let worksetItems;
      try {
        let retainedPixels = 0;
        worksetItems = inputs.map((item, index) => {
          const budget = assertImagePixelBudget(item.image, retainedPixels);
          retainedPixels = budget.totalPixels;
          const worksetItem = createItem(
            item.image,
            item.name || `frame_${String(index + 1).padStart(4, "0")}.png`,
            item.frame || null,
          );
          restoreWorksetCutoutState(worksetItem, item, workset);
          return worksetItem;
        });
      } catch (error) {
        return Promise.reject(error);
      }
      suspendStandaloneBatch();
      stopBatchPlayback();
      state.thumbnailJob += 1;
      resetBatchPreviewState();
      elements.cutoutConnected.checked = false;
      elements.cutoutPerceptual.checked = false;
      state.batchTrayCollapsed = true;
      state.items = worksetItems;
      state.sourceKind = "workset";
      state.sessionMode = workset.mode === "single" || inputs.length === 1 ? "single" : "batch";
      state.items.forEach((item, index) => {
        if (!workset.autoDetectBackground) {
          // A prior smart cutout left parameters on the frame. Keep automatic
          // processing armed so the editor shows that result on the true source,
          // and so dialing a slider back undoes the cut instead of stacking.
          const persisted = inputs[index]?.cutoutState || {};
          const hasPersistedCut = Boolean(
            persisted.processingParameters ||
              (Array.isArray(persisted.backgroundSamples) && persisted.backgroundSamples.length) ||
              (Array.isArray(persisted.seedPoints) && persisted.seedPoints.length),
          );
          item.automaticCutoutActivated = hasPersistedCut;
          item.processingActivated = hasPersistedCut;
        }
        item.pendingAutomaticPropagation = false;
      });
      state.worksetName = String(workset.name || "animation");
      state.selectedIndex = Math.max(0, Math.min(state.items.length - 1, Number(workset.selectedIndex) || 0));
      applyProcessingParametersToControls(selectedItem()?.processingParameters);
      state.selectedIds = new Set(
        state.items[state.selectedIndex] ? [state.items[state.selectedIndex].id] : [],
      );
      state.protectionPreview = null;
      state.selectionAnchorIndex = state.selectedIndex;
      state.previewScale = null;
      state.previewFitScale = null;
      state.previewPanX = 0;
      state.previewPanY = 0;
      state.cancelRequested = false;
      state.previewMode = state.sessionMode === "single" ? "original" : "result";
      state.qualityOnly = false;
      documentApi.querySelector?.('[data-cutout-tab="regular"]')?.click?.();
      return new Promise((resolve) => {
        resolve.liveApply = typeof workset.onLiveApply === "function" ? workset.onLiveApply : null;
        state.worksetResolver = resolve;
        if (workset.present !== false) {
          // A workset belongs to the organizer that created it. Keep the host
          // route and editor lifecycle intact instead of presenting the child
          // session as a standalone cutout workbench.
          open({ syncRoute: false });
          renderQueue();
          renderPreview();
          scheduleBatchThumbnails();
          setStatus(
            state.sessionMode === "single"
              ? text("singleLoaded")
              : text("worksetLoaded", { name: state.worksetName, count: state.items.length }),
            "success",
          );
        }
        acceptSession(state);
      });
    }
    /**
     * Closes the modal workbench.
     * @param {Array<object>|null} worksetResult Optional processed workset outputs.
     * @param {{syncRoute?:boolean}} [options] Route synchronization behavior.
     * @returns {void}
     */
    function close(worksetResult = null, options = {}) {
      const embeddedWorkset = typeof state.worksetResolver === "function";
      onSessionReset();
      stopBatchPlayback();
      cancelRepairGestureFrame();
      state.thumbnailJob += 1;
      if (!elements.cutoutConfirmPanel.hidden) resolveConfirmation(false);
      elements.cutoutModal.hidden = true;
      if (!embeddedWorkset) setEditorInert(false);
      documentApi.body.classList.remove("cutoutOpen");
      if (!embeddedWorkset && options.syncRoute !== false) host.onClose?.();
      state.previewSpacePan = false;
      state.previewPanDrag = null;
      elements.cutoutModal.classList.remove("isPreviewPanReady", "isPreviewPanning");
      const resolver = state.worksetResolver;
      state.worksetResolver = null;
      state.worksetName = "";
      if (resolver) {
        resultArtifacts.clear();
        resetBatchPreviewState();
        if (!restoreSuspendedBatch()) {
          state.items = [];
          state.sourceKind = "";
          state.selectedIndex = 0;
          state.selectedIds.clear();
          state.sessionMode = "batch";
          renderQueue();
          renderPreview();
        }
        resolver(worksetResult);
      }
      if (state.returnFocus && typeof state.returnFocus.focus === "function") state.returnFocus.focus();
    }
    /**
     * Requests a safe workbench close and protects isolated workset edits.
     * @param {Array<object>|null} worksetResult Optional processed workset outputs.
     * @param {{syncRoute?:boolean,force?:boolean}} [options] Close behavior.
     * @returns {Promise<boolean>} Whether the workbench closed.
     */
    async function requestClose(worksetResult = null, options = {}) {
      const discardsWorkset =
        worksetResult === null &&
        !options.force &&
        (typeof state.worksetResolver === "function" || state.sourceKind === "group") &&
        hasWorksetChanges();
      if (discardsWorkset && !options.force) {
        const confirmed = await requestConfirmation(text("discardConfirm"), [], {
          title: text("discardTitle"),
          confirmLabel: text("confirmDiscard"),
          tone: "danger",
        });
        if (!confirmed) return false;
      }
      close(worksetResult, options);
      return true;
    }

    /**
     * Returns whether an isolated workset has generated or edited output.
     * Loading a group, restoring persisted cutout parameters, or preview-arming
     * automatic processing is not a modification.
     * @returns {boolean}
     */
    function hasWorksetChanges() {
      return sessionChangeSignature(state.items) !== String(state.acceptedSessionSignature || "");
    }

    /**
     * Returns whether leaving would discard cutout work the user actually made.
     * Loading the current animation or clearing the batch is not a modification.
     * @returns {boolean}
     */
    function hasUnsavedChanges() {
      if (state.busy) return true;
      if (!Array.from(state.items || []).length) return false;
      if (state.sourceKind === "group" || state.sourceKind === "workset") return hasWorksetChanges();
      return true;
    }

    acceptSession(state);
    return {
      clear,
      deleteSelectedItems,
      open,
      openWorkset,
      close,
      requestClose,
      hasWorksetChanges,
      hasUnsavedChanges,
    };
  }

  return {
    createController,
    sessionChangeSignature,
    acceptSession,
    activateAutomaticBackgroundDetection,
  };
});
