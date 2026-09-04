"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { applyProductCutout } = require("./lib/animation_tuner/public/batch_cutout_core");
const {
  createSmartCutoutOptions,
  detectBackgroundColor,
} = require("./lib/animation_tuner/public/scatter_slice_smart_cutout");
const { encodePngRgba } = require("./xsxb_mcp_cutout");
const { resolveMcpArtifactPath } = require("./xsxb_mcp_arguments");
const { analyzeRegions } = require("./xsxb_mcp_perception");
const { resolveGridSpec } = require("./xsxb_mcp_visual_qa");

const COLORS = Object.freeze({
  subject: Object.freeze([70, 220, 120, 255]),
  elongated_attachment: Object.freeze([255, 196, 64, 255]),
  transient_effect: Object.freeze([90, 205, 255, 255]),
  contact_point: Object.freeze([255, 90, 180, 255]),
  text_like: Object.freeze([190, 140, 255, 255]),
  unknown: Object.freeze([255, 90, 90, 255]),
});

/**
 * Counts visible pixels and clear border pixels after an in-memory segmentation.
 * @param {Uint8ClampedArray} data RGBA pixels.
 * @param {number} width Width.
 * @param {number} height Height.
 * @returns {{visible:number,clearBorderRatio:number}}
 */
function segmentationMetrics(data, width, height) {
  let visible = 0;
  let border = 0;
  let clearBorder = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha > 16) visible += 1;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        border += 1;
        if (alpha <= 16) clearBorder += 1;
      }
    }
  }
  return { visible, clearBorderRatio: border ? clearBorder / border : 0 };
}

/**
 * Removes a stable studio plate in memory. It intentionally shares the Tuner
 * smart-cutout implementation but never writes the transformed pixels.
 * @param {{data:Uint8ClampedArray,width:number,height:number}} frame Source frame.
 * @returns {{data:Uint8ClampedArray,confidence:number,ambiguities:string[]}}
 */
function segmentBackground(frame) {
  const background = detectBackgroundColor(frame.data, frame.width, frame.height);
  const options = createSmartCutoutOptions(background);
  const segmented = applyProductCutout(frame.data, frame.width, frame.height, options, []);
  const metrics = segmentationMetrics(segmented.data, frame.width, frame.height);
  const coverage = metrics.visible / Math.max(1, frame.width * frame.height);
  const plausible = coverage >= 0.001 && coverage <= 0.98 && metrics.clearBorderRatio >= 0.5;
  return {
    data: segmented.data,
    confidence: plausible ? Math.min(0.9, 0.68 + metrics.clearBorderRatio * 0.22) : 0.48,
    ambiguities: plausible ? [] : ["background_segmentation_unstable"],
  };
}

/**
 * Writes one pixel without blending; used only for diagnostic overlays.
 * @param {Uint8ClampedArray} data RGBA output.
 * @param {number} width Width.
 * @param {number} height Height.
 * @param {number} x X.
 * @param {number} y Y.
 * @param {readonly number[]} color RGBA color.
 * @returns {void}
 */
function paint(data, width, height, x, y, color) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  data.set(color, (y * width + x) * 4);
}

/**
 * Draws grid lines and candidate boxes without changing the source pixels.
 * @param {object} frame Source frame.
 * @param {object[]} candidates Internal candidates.
 * @param {number} rows Grid rows.
 * @param {number} cols Grid columns.
 * @returns {Uint8ClampedArray} Overlay pixels.
 */
function renderRegionOverlay(frame, candidates, rows, cols) {
  const output = new Uint8ClampedArray(frame.data);
  const gridColor = [190, 220, 255, 92];
  for (let column = 1; column < cols; column += 1) {
    const x = Math.round((column * frame.width) / cols);
    for (let y = 0; y < frame.height; y += 1) paint(output, frame.width, frame.height, x, y, gridColor);
  }
  for (let row = 1; row < rows; row += 1) {
    const y = Math.round((row * frame.height) / rows);
    for (let x = 0; x < frame.width; x += 1) paint(output, frame.width, frame.height, x, y, gridColor);
  }
  for (const candidate of candidates) {
    const box = candidate.component;
    const color = COLORS[candidate.hypothesis] || COLORS.unknown;
    for (let x = box.minX; x <= box.maxX; x += 1) {
      paint(output, frame.width, frame.height, x, box.minY, color);
      paint(output, frame.width, frame.height, x, box.maxY, color);
    }
    for (let y = box.minY; y <= box.maxY; y += 1) {
      paint(output, frame.width, frame.height, box.minX, y, color);
      paint(output, frame.width, frame.height, box.maxX, y, color);
    }
  }
  return output;
}

/**
 * Measures how much of a model box is grounded by one code-derived component.
 * @param {number[]} modelBox Model [x1,y1,x2,y2].
 * @param {object} component Code component.
 * @returns {number} Intersection divided by model-box area.
 */
function groundingOverlap(modelBox, component) {
  const [x1, y1, x2, y2] = Array.isArray(modelBox) ? modelBox.map(Number) : [];
  if (![x1, y1, x2, y2].every(Number.isFinite) || x2 <= x1 || y2 <= y1) return 0;
  const intersectionWidth = Math.max(0, Math.min(x2, component.maxX + 1) - Math.max(x1, component.minX));
  const intersectionHeight = Math.max(0, Math.min(y2, component.maxY + 1) - Math.max(y1, component.minY));
  return (intersectionWidth * intersectionHeight) / Math.max(1, (x2 - x1) * (y2 - y1));
}

/**
 * Attaches Florence labels only to code-grounded geometry.
 * @param {object} code Code perception result.
 * @param {object} response Florence response.
 * @returns {{candidates:object[],model:object}}
 */
function fuseFlorence(code, response) {
  const candidates = code.candidates.map((candidate) => ({
    ...candidate,
    evidence: [...candidate.evidence],
    provenance: [...candidate.provenance],
  }));
  const rejected = [];
  for (const detection of response?.detections || []) {
    let bestIndex = -1;
    let bestOverlap = 0;
    code.internalCandidates.forEach((candidate, index) => {
      const detectionFrame = Number.isInteger(Number(detection.frame)) ? Number(detection.frame) : 0;
      const candidateFrame = Number.isInteger(Number(code.candidates[index]?.frame))
        ? Number(code.candidates[index].frame)
        : 0;
      if (candidateFrame !== detectionFrame) return;
      const overlap = groundingOverlap(detection.bbox, candidate.component);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestIndex = index;
      }
    });
    const label = String(detection.label || "").trim();
    if (bestIndex < 0 || bestOverlap < 0.25 || !label) {
      rejected.push({ label: label || null, reason: "code_geometry_conflict" });
      continue;
    }
    const selected = candidates[bestIndex];
    const subjectLabel = /person|character|human|figure|warrior|hero|人物|角色|人形/iu.test(label);
    if (selected.hypothesis === "subject" && selected.codeConfidence >= 0.8 && !subjectLabel) {
      rejected.push({ label, reason: "high_confidence_subject_conflict" });
      continue;
    }
    selected.semanticLabel = label;
    selected.evidence.push("florence_label_grounded_by_code");
    selected.provenance.push("local_florence");
  }
  return {
    candidates,
    model: {
      provider: "florence-2-base-ft",
      rejected,
      rawLabelCount: Array.isArray(response?.detections) ? response.detections.length : 0,
    },
  };
}

/**
 * Runs code-first detection and optionally delegates semantic grounding to an
 * injected Florence adapter.
 * @param {object} args Tool arguments.
 * @param {{frames:object[],observation:object,revalidate?:Function,root:string,artifactDir:string,florence?:Function}} context
 * @returns {Promise<object>} Raw tool data carrying private MCP envelope metadata.
 */
async function detectRegions(args, context) {
  const provider = String(args.provider || "auto");
  const targets = Array.isArray(args.targets) && args.targets.length ? args.targets : ["subject"];
  const grid = resolveGridSpec(args);
  const cols = grid.divs?.x || 8;
  const rows = grid.divs?.y || 8;
  if (cols > 26) {
    const error = new Error("xsxb_detect_regions supports at most 26 speakable columns (A-Z).");
    error.code = "GRID_TOO_WIDE";
    throw error;
  }
  const code = analyzeRegions(context.frames, {
    targets,
    rows,
    cols,
    maxCandidates: Number(args.max_candidates || 16),
    snapshotId: context.observation.snapshotId,
    segmentBackground,
  });
  let candidates = code.candidates;
  let model = null;
  let route = "code_perception";
  let effect = candidates.length ? "confirmed" : "unverifiable";
  let escalation = null;
  const requestModel = provider === "florence" || (provider === "auto" && code.needsModel);
  if (!requestModel && code.needsModel) {
    effect = "partial";
    escalation = { target: "agent_visual", reason: "code_ambiguity" };
  }
  if (requestModel) {
    if (typeof context.florence !== "function") {
      if (provider === "florence") {
        const error = new Error("Florence-2 is not installed. Run npm run mcp:perception:install.");
        error.code = "MODEL_UNAVAILABLE";
        throw error;
      }
      effect = "partial";
      escalation = { target: "agent_visual", reason: "model_unavailable" };
    } else {
      try {
        const response = await context.florence({ frames: context.frames, targets, code });
        const fused = fuseFlorence(code, response);
        model = fused.model;
        route = "local_florence";
        candidates = fused.candidates;
        const semanticResolved = candidates.some((candidate) => candidate.semanticLabel);
        effect = semanticResolved || !code.needsModel ? "confirmed" : "partial";
        if (!semanticResolved && code.needsModel) {
          escalation = { target: "agent_visual", reason: "code_ambiguity" };
        }
      } catch (error) {
        if (provider === "florence") throw error;
        effect = "partial";
        model = { provider: "florence-2-base-ft", error: String(error.message || error) };
        escalation = { target: "agent_visual", reason: "model_failed" };
      }
    }
  }
  const overlayFrame = context.frames[0];
  const overlayPath = resolveMcpArtifactPath(args.output_path, {
    root: context.root,
    artifactDir: context.artifactDir,
    defaultName: `${path.basename(
      context.observation.scope.file || context.observation.scope.animationId || "regions",
      path.extname(context.observation.scope.file || ""),
    )}_regions.png`,
    extensionPattern: /\.png$/i,
    extensionLabel: ".png",
  });
  const overlayDest = path.resolve(overlayPath);
  for (const frame of context.frames) {
    const source = path.resolve(String(frame.filePath || ""));
    if (source && overlayDest === source) {
      const error = new Error("xsxb_detect_regions output_path must not overwrite a source PNG.");
      error.code = "OVERWRITE_SOURCE";
      throw error;
    }
  }
  fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
  fs.writeFileSync(
    overlayPath,
    encodePngRgba(
      renderRegionOverlay(
        overlayFrame,
        code.internalCandidates.filter(
          (_item, index) => candidates[index]?.frame === (overlayFrame.frame || 0),
        ),
        rows,
        cols,
      ),
      overlayFrame.width,
      overlayFrame.height,
    ),
  );
  const data = {
    profileVersion: code.profileVersion,
    provider: route === "local_florence" ? "florence" : "code",
    targets,
    candidates,
    ambiguities: code.ambiguities,
    sampledFrames: code.sampledFrames,
    overlayPath,
    model,
  };
  Object.defineProperty(data, "__mcp", {
    enumerable: false,
    value: {
      observation: context.observation,
      revalidate: context.revalidate,
      execution: { effect, route, artifacts: [{ kind: "overlay", path: overlayPath }] },
      verification: {
        status: candidates.length && !code.ambiguities.length ? "satisfied" : "unknown",
        checks: ["source_unchanged", "candidate_geometry_bounded"],
        evidence: ["code_perception"],
      },
      escalation,
    },
  });
  return data;
}

module.exports = {
  detectRegions,
  fuseFlorence,
  groundingOverlap,
  renderRegionOverlay,
  segmentBackground,
  segmentationMetrics,
};
