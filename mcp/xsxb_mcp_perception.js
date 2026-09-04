"use strict";

const crypto = require("node:crypto");

const ALPHA_VISIBLE = 16;
const PROFILE_VERSION = "code-perception-v1";
const MIN_CODE_CONFIDENCE = 0.55;
const ACCEPT_CODE_CONFIDENCE = 0.8;

/**
 * Clamps a number into an inclusive range.
 * @param {number} value Source number.
 * @param {number} minimum Minimum.
 * @param {number} maximum Maximum.
 * @returns {number} Clamped number.
 */
function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Number(value) || 0));
}

/**
 * Builds an in-memory foreground mask. Existing transparency wins; fully opaque
 * plates may be removed through an injected code-only background segmenter.
 * @param {{data:Uint8ClampedArray,width:number,height:number}} frame Source image.
 * @param {{segmentBackground?:(frame:object)=>{data:Uint8ClampedArray,confidence:number,ambiguities?:string[]}}} [options]
 * @returns {{data:Uint8ClampedArray,segmentationScore:number,ambiguities:string[]}}
 */
function foregroundFrame(frame, options = {}) {
  let transparent = 0;
  let border = 0;
  let clearBorder = 0;
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const alpha = frame.data[(y * frame.width + x) * 4 + 3];
      if (alpha <= ALPHA_VISIBLE) transparent += 1;
      if (x === 0 || y === 0 || x === frame.width - 1 || y === frame.height - 1) {
        border += 1;
        if (alpha <= ALPHA_VISIBLE) clearBorder += 1;
      }
    }
  }
  const clearRatio = border ? clearBorder / border : 0;
  if (transparent > 0 && clearRatio >= 0.5) {
    return { data: frame.data, segmentationScore: clamp(0.82 + clearRatio * 0.18, 0, 1), ambiguities: [] };
  }
  if (typeof options.segmentBackground === "function") {
    const segmented = options.segmentBackground(frame);
    return {
      data: segmented.data,
      segmentationScore: clamp(segmented.confidence, 0, 1),
      ambiguities: Array.isArray(segmented.ambiguities) ? segmented.ambiguities : [],
    };
  }
  return {
    data: frame.data,
    segmentationScore: transparent > 0 ? 0.54 : 0.35,
    ambiguities: ["background_not_separated"],
  };
}

/**
 * Labels 8-connected foreground regions using fixed-size typed arrays.
 * @param {Uint8ClampedArray|Uint8Array} rgba RGBA pixels.
 * @param {number} width Image width.
 * @param {number} height Image height.
 * @returns {{components:object[],labels:Int32Array,noiseCount:number}}
 */
function connectedComponents(rgba, width, height) {
  const pixelCount = width * height;
  const labels = new Int32Array(pixelCount);
  labels.fill(-1);
  const queue = new Int32Array(pixelCount);
  const components = [];
  const minimumArea = Math.max(4, Math.ceil(pixelCount * 0.0005));
  let noiseCount = 0;
  for (let start = 0; start < pixelCount; start += 1) {
    if (labels[start] !== -1 || rgba[start * 4 + 3] <= ALPHA_VISIBLE) continue;
    const label = components.length;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = label;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let count = 0;
    let alphaMass = 0;
    let sumX = 0;
    let sumY = 0;
    let sumXX = 0;
    let sumXY = 0;
    let sumYY = 0;
    let lumaSum = 0;
    let chromaSum = 0;
    let borderPixels = 0;
    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = Math.floor(index / width);
      const offset = index * 4;
      const alpha = rgba[offset + 3] / 255;
      count += 1;
      alphaMass += alpha;
      sumX += x * alpha;
      sumY += y * alpha;
      sumXX += x * x * alpha;
      sumXY += x * y * alpha;
      sumYY += y * y * alpha;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      const red = rgba[offset];
      const green = rgba[offset + 1];
      const blue = rgba[offset + 2];
      lumaSum += (0.2126 * red + 0.7152 * green + 0.0722 * blue) * alpha;
      chromaSum += (Math.max(red, green, blue) - Math.min(red, green, blue)) * alpha;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) borderPixels += 1;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nextX = x + dx;
          const nextY = y + dy;
          if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
          const next = nextY * width + nextX;
          if (labels[next] !== -1 || rgba[next * 4 + 3] <= ALPHA_VISIBLE) continue;
          labels[next] = label;
          queue[tail++] = next;
        }
      }
    }
    const componentWidth = maxX - minX + 1;
    const componentHeight = maxY - minY + 1;
    const meanX = alphaMass ? sumX / alphaMass : (minX + maxX) / 2;
    const meanY = alphaMass ? sumY / alphaMass : (minY + maxY) / 2;
    const xx = Math.max(0, sumXX / Math.max(alphaMass, 1e-9) - meanX * meanX);
    const xy = sumXY / Math.max(alphaMass, 1e-9) - meanX * meanY;
    const yy = Math.max(0, sumYY / Math.max(alphaMass, 1e-9) - meanY * meanY);
    const trace = xx + yy;
    const root = Math.sqrt(Math.max(0, (xx - yy) ** 2 + 4 * xy * xy));
    const major = Math.max(0, (trace + root) / 2);
    const minor = Math.max(1e-6, (trace - root) / 2);
    const component = {
      label,
      minX,
      minY,
      maxX,
      maxY,
      width: componentWidth,
      height: componentHeight,
      count,
      alphaMass,
      centerX: meanX,
      centerY: meanY,
      fillRatio: count / Math.max(1, componentWidth * componentHeight),
      aspectRatio:
        Math.max(componentWidth, componentHeight) / Math.max(1, Math.min(componentWidth, componentHeight)),
      eigenRatio: major / minor,
      meanLuma: lumaSum / Math.max(alphaMass, 1e-9),
      meanChroma: chromaSum / Math.max(alphaMass, 1e-9),
      borderRatio: borderPixels / Math.max(1, count),
      noise: count < minimumArea,
    };
    if (component.noise) noiseCount += 1;
    components.push(component);
  }
  return { components, labels, noiseCount };
}

/**
 * Chooses the likely subject without claiming semantic identity.
 * @param {object[]} components Connected components.
 * @param {number} width Canvas width.
 * @param {number} height Canvas height.
 * @param {number} segmentationScore Background confidence.
 * @returns {object|null} Ranked subject component.
 */
function subjectCandidate(components, width, height, segmentationScore) {
  const usable = components.filter((component) => !component.noise);
  if (!usable.length) return null;
  const total = usable.reduce((sum, component) => sum + component.count, 0);
  for (const component of usable) {
    const dominance = component.count / Math.max(1, total);
    const centerDistance = Math.abs(component.centerX - (width - 1) / 2) / Math.max(1, width / 2);
    const centerScore = 1 - clamp(centerDistance, 0, 1);
    const shapeScore = clamp(component.height / Math.max(1, component.width * 1.2), 0, 1);
    const supportScore = clamp((component.maxY + 1) / Math.max(1, height), 0, 1);
    component.subjectScore = clamp(
      segmentationScore * 0.25 + dominance * 0.35 + shapeScore * 0.1 + supportScore * 0.1 + centerScore * 0.2,
      0,
      1,
    );
  }
  return usable.slice().sort((left, right) => right.subjectScore - left.subjectScore)[0];
}

/**
 * Produces a conservative subject-edge contact patch for a detached component.
 * It is a geometric hypothesis only and is deliberately capped below automatic
 * semantic acceptance.
 * @param {object} subject Subject component.
 * @param {object} attachment Detached component.
 * @param {number} width Canvas width.
 * @param {number} height Canvas height.
 * @returns {object} Small component-like contact box.
 */
function contactPatch(subject, attachment, width, height) {
  let x = clamp(Math.round(attachment.centerX), subject.minX, subject.maxX);
  let y = clamp(Math.round(attachment.centerY), subject.minY, subject.maxY);
  if (attachment.minX > subject.maxX) x = subject.maxX;
  else if (attachment.maxX < subject.minX) x = subject.minX;
  if (attachment.minY > subject.maxY) y = subject.maxY;
  else if (attachment.maxY < subject.minY) y = subject.minY;
  return {
    minX: clamp(x - 1, 0, width - 1),
    maxX: clamp(x + 1, 0, width - 1),
    minY: clamp(y - 1, 0, height - 1),
    maxY: clamp(y + 1, 0, height - 1),
    centerX: x,
    centerY: y,
    count: 1,
  };
}

/**
 * Converts a pixel box to all intersected A1 cells.
 * @param {object} box Inclusive pixel box.
 * @param {number} width Canvas width.
 * @param {number} height Canvas height.
 * @param {number} rows Grid rows.
 * @param {number} cols Grid columns.
 * @returns {string[]} Speakable cells.
 */
function boxCells(box, width, height, rows, cols) {
  const startCol = clamp(Math.floor((box.minX / width) * cols), 0, cols - 1);
  const endCol = clamp(Math.floor((box.maxX / width) * cols), 0, cols - 1);
  const startRow = clamp(Math.floor((box.minY / height) * rows), 0, rows - 1);
  const endRow = clamp(Math.floor((box.maxY / height) * rows), 0, rows - 1);
  const cells = [];
  for (let row = startRow; row <= endRow; row += 1) {
    for (let column = startCol; column <= endCol; column += 1) {
      cells.push(`${String.fromCharCode(65 + column)}${row + 1}`);
    }
  }
  return cells;
}

/**
 * Generates conservative code candidates for one frame.
 * @param {{data:Uint8ClampedArray,width:number,height:number}} frame Source frame.
 * @param {{targets?:string[],rows?:number,cols?:number,segmentBackground?:Function,frameIndex?:number}} [options]
 * @returns {{candidates:object[],internalCandidates:object[],ambiguities:string[],segmentationScore:number,noiseCount:number}}
 */
function analyzeFrame(frame, options = {}) {
  const foreground = foregroundFrame(frame, options);
  const connected = connectedComponents(foreground.data, frame.width, frame.height);
  const candidates = connected.components.filter((component) => !component.noise);
  const subject = subjectCandidate(candidates, frame.width, frame.height, foreground.segmentationScore);
  const sortedSubjects = candidates.slice().sort((left, right) => right.subjectScore - left.subjectScore);
  const globalAmbiguities = [...foreground.ambiguities];
  if (sortedSubjects.length > 1 && sortedSubjects[0].subjectScore - sortedSubjects[1].subjectScore < 0.12) {
    globalAmbiguities.push("subject_candidates_tied");
  }
  const rows = options.rows || 8;
  const cols = options.cols || 8;
  const requested = new Set(options.targets?.length ? options.targets : ["subject"]);
  const internalCandidates = [];
  if (subject && requested.has("subject")) {
    internalCandidates.push({
      hypothesis: "subject",
      component: subject,
      codeConfidence: Number(subject.subjectScore.toFixed(3)),
      evidence: ["alpha_components", "foreground_dominance", "center_and_support"],
      ambiguities: [...globalAmbiguities],
      provenance: ["code_perception", "alpha_components"],
    });
  }
  if (requested.has("text")) {
    for (const component of candidates) {
      internalCandidates.push({
        hypothesis: "text_like",
        component,
        codeConfidence: Number(
          Math.min(0.54, foreground.segmentationScore * 0.25 + component.fillRatio * 0.15).toFixed(3),
        ),
        evidence: ["foreground_component_region"],
        ambiguities: ["text_requires_ocr"],
        provenance: ["code_perception", "text_region_proposal"],
      });
    }
  }
  for (const component of candidates) {
    if (component === subject) continue;
    const elongatedScore = clamp(
      foreground.segmentationScore * 0.15 +
        clamp(component.aspectRatio / 6, 0, 1) * 0.35 +
        clamp(component.eigenRatio / 16, 0, 1) * 0.35 +
        (1 - component.borderRatio) * 0.15,
      0,
      1,
    );
    const effectScore = clamp(
      foreground.segmentationScore * 0.15 +
        clamp(component.meanLuma / 255, 0, 1) * 0.25 +
        clamp(component.meanChroma / 128, 0, 1) * 0.25 +
        clamp(component.count / Math.max(1, subject?.count || component.count), 0, 1) * 0.25 +
        (component.width > component.height ? 0.1 : 0),
      0,
      0.79,
    );
    if (requested.has("weapon") && (component.aspectRatio >= 2.5 || component.eigenRatio >= 8)) {
      internalCandidates.push({
        hypothesis: "elongated_attachment",
        component,
        codeConfidence: Number(elongatedScore.toFixed(3)),
        evidence: ["detached_component", "pca_axis", "axial_thickness"],
        ambiguities: ["geometry_does_not_prove_weapon"],
        provenance: ["code_perception", "pca_axis"],
      });
    }
    if (requested.has("hand") && subject && (component.aspectRatio >= 2.5 || component.eigenRatio >= 8)) {
      const gapX = Math.max(0, subject.minX - component.maxX, component.minX - subject.maxX);
      const gapY = Math.max(0, subject.minY - component.maxY, component.minY - subject.maxY);
      const proximity = 1 - clamp(Math.hypot(gapX, gapY) / Math.max(frame.width, frame.height), 0, 1);
      internalCandidates.push({
        hypothesis: "contact_point",
        component: contactPatch(subject, component, frame.width, frame.height),
        codeConfidence: Number(Math.min(0.79, elongatedScore * 0.55 + proximity * 0.25).toFixed(3)),
        evidence: ["detached_elongated_component", "nearest_subject_boundary"],
        ambiguities: ["contact_geometry_does_not_prove_hand"],
        provenance: ["code_perception", "contact_geometry"],
      });
    }
    if (requested.has("effect") && (component.meanLuma >= 170 || component.meanChroma >= 48)) {
      internalCandidates.push({
        hypothesis: "transient_effect",
        component,
        codeConfidence: Number(effectScore.toFixed(3)),
        evidence: ["detached_component", "luma_or_chroma"],
        ambiguities: ["single_frame_effect_unproven"],
        provenance: ["code_perception", "color_features"],
      });
    }
  }
  if (requested.has("hand")) globalAmbiguities.push("hand_requires_semantic_grounding");
  if (requested.has("text")) globalAmbiguities.push("text_requires_ocr");
  const publicCandidates = internalCandidates.map((candidate, index) => ({
    regionId: `pending_${index}`,
    hypothesis: candidate.hypothesis,
    cells: boxCells(candidate.component, frame.width, frame.height, rows, cols),
    codeConfidence: candidate.codeConfidence,
    semanticLabel: null,
    evidence: candidate.evidence,
    ambiguities: candidate.ambiguities,
    provenance: candidate.provenance,
    frame: Number.isInteger(options.frameIndex) ? options.frameIndex : undefined,
  }));
  return {
    candidates: publicCandidates,
    internalCandidates,
    ambiguities: [...new Set(globalAmbiguities)],
    segmentationScore: Number(foreground.segmentationScore.toFixed(3)),
    noiseCount: connected.noiseCount,
    foreground: { data: foreground.data, width: frame.width, height: frame.height },
  };
}

/**
 * Assigns content-addressed ids and determines whether model escalation is needed.
 * @param {object[]} frames Decoded frames.
 * @param {{targets?:string[],rows?:number,cols?:number,segmentBackground?:Function,maxCandidates?:number,snapshotId:string}} options
 * @returns {object} Code perception result.
 */
function analyzeRegions(frames, options) {
  const selected = frames.slice(0, 24);
  const analyses = selected.map((frame, frameIndex) =>
    analyzeFrame(frame, {
      ...options,
      frameIndex: Number.isInteger(frame.frame) ? frame.frame : frameIndex,
    }),
  );
  const joined = [];
  analyses.forEach((analysis, analysisIndex) => {
    analysis.candidates.forEach((candidate, candidateIndex) => {
      const internal = analysis.internalCandidates[candidateIndex];
      const signature = `${options.snapshotId}|${analysisIndex}|${candidate.hypothesis}|${internal.component.minX},${internal.component.minY},${internal.component.maxX},${internal.component.maxY}`;
      joined.push({
        ...candidate,
        regionId: `reg_${crypto.createHash("sha256").update(signature).digest("hex").slice(0, 16)}`,
        _internal: internal,
      });
    });
  });

  if (analyses.length > 1) {
    const subjectRows = joined.filter((candidate) => candidate.hypothesis === "subject");
    if (subjectRows.length > 1) {
      const centers = subjectRows.map(
        (candidate) => candidate._internal.component.centerX / selected[0].width,
      );
      const areas = subjectRows.map((candidate) => candidate._internal.component.count);
      const meanCenter = centers.reduce((sum, value) => sum + value, 0) / centers.length;
      const meanArea = areas.reduce((sum, value) => sum + value, 0) / areas.length;
      const centerDrift =
        centers.reduce((sum, value) => sum + Math.abs(value - meanCenter), 0) / centers.length;
      const areaDrift =
        areas.reduce((sum, value) => sum + Math.abs(value - meanArea), 0) /
        Math.max(1, areas.length * meanArea);
      const persistence = subjectRows.length / analyses.length;
      const temporalScore = clamp(persistence - centerDrift * 2 - areaDrift, 0, 1);
      for (const candidate of subjectRows) {
        candidate.codeConfidence = Number((candidate.codeConfidence * 0.8 + temporalScore * 0.2).toFixed(3));
        candidate.evidence.push("temporal_stability");
      }
    }
    const effectRows = joined.filter((candidate) => candidate.hypothesis === "transient_effect");
    const effectFrames = new Set(effectRows.map((candidate) => candidate.frame)).size;
    if (effectRows.length) {
      const transientScore = clamp(1 - effectFrames / analyses.length + 0.35, 0, 1);
      for (const candidate of effectRows) {
        candidate.codeConfidence = Number(
          Math.min(0.95, candidate.codeConfidence * 0.65 + transientScore * 0.35).toFixed(3),
        );
        candidate.evidence.push("temporal_activity");
        candidate.ambiguities = candidate.ambiguities.filter(
          (ambiguity) => ambiguity !== "single_frame_effect_unproven",
        );
        if (effectFrames / analyses.length > 0.8) candidate.ambiguities.push("constant_effect_or_body_part");
      }
    }
  }
  joined.sort((left, right) => right.codeConfidence - left.codeConfidence);
  const limited = joined.slice(0, options.maxCandidates || 16);
  const targets = new Set(options.targets?.length ? options.targets : ["subject"]);
  const ambiguities = [
    ...new Set([
      ...analyses.flatMap((analysis) => analysis.ambiguities),
      ...limited.flatMap((candidate) => candidate.ambiguities || []),
    ]),
  ];
  const accepted = (hypothesis) =>
    limited.some(
      (candidate) =>
        candidate.hypothesis === hypothesis && candidate.codeConfidence >= ACCEPT_CODE_CONFIDENCE,
    );
  const missingTarget = [...targets].some((target) => {
    if (target === "subject") return !accepted("subject");
    if (target === "weapon") return !accepted("elongated_attachment");
    if (target === "effect") return !accepted("transient_effect");
    return true;
  });
  const best = limited[0]?.codeConfidence || 0;
  const needsModel = missingTarget || best < MIN_CODE_CONFIDENCE || ambiguities.length > 0;
  return {
    profileVersion: PROFILE_VERSION,
    candidates: limited.map(({ _internal, ...candidate }) => candidate),
    internalCandidates: limited.map((candidate) => candidate._internal),
    needsModel,
    ambiguities,
    sampledFrames: selected.length,
    truncatedFrames: Math.max(0, frames.length - selected.length),
    analyses,
  };
}

module.exports = {
  ACCEPT_CODE_CONFIDENCE,
  MIN_CODE_CONFIDENCE,
  PROFILE_VERSION,
  analyzeFrame,
  analyzeRegions,
  boxCells,
  connectedComponents,
  foregroundFrame,
};
