"use strict";

/**
 * Compiles a clip-specific weapon-smear brief from cells the agent traced on
 * this animation. The generic MCP playbook is only the skeleton; execute the
 * returned brief. A validated pixel-layer example lives in
 * VALIDATED_SMEAR_REFERENCE (example only, not a recipe for other attacks).
 */

const CELL_ID = /^[A-Z](?:[1-9]|1\d|2[0-6])$/i;
const PATH_KINDS = new Set(["polyline", "smooth_arc"]);
const WEIGHTS = new Set(["none", "faint", "solid", "remnant"]);
const LAYERS = new Set(["behind", "front"]);
const COLOR = /^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})$/;

const VALIDATED_SMEAR_REFERENCE = Object.freeze({
  note: "Validated pixel-layer weapon smear. Example only — not a canned recipe for other attacks.",
  animation: "niulai_plunger_chop",
  motion: "overhead then nearly vertical downward chop",
  pathKind: "polyline",
  headPath: "D1→G3 then H8",
  method: "像素层 月牙",
  layer: "behind",
  files: Object.freeze([
    "exports/niulai-plunger-mcp/niulai-chop-crescent-trail-v4.gif",
    "exports/niulai-plunger-mcp/niulai-chop-crescent-trail-v4-sheet.png",
  ]),
});

/**
 * Normalizes one speakable overlay cell id.
 * @param {unknown} value Raw cell.
 * @param {string} label Argument name for errors.
 * @returns {string} Uppercase cell id.
 */
function requireCell(value, label) {
  const cell = String(value || "")
    .trim()
    .toUpperCase();
  if (!CELL_ID.test(cell)) throw new Error(`${label} must be a speakable cell id such as D1.`);
  return cell;
}

/**
 * Compiles the clip-specific smear prompt the agent should execute next.
 * @param {object} [args] Traced motion, path kind, color, and per-frame cells.
 * @returns {object} Brief receipt.
 */
function compileSmearBrief(args = {}) {
  const motion = String(args.motion || "").trim();
  if (motion.length < 8) {
    throw new Error("motion must describe the weapon-head path you read from this clip's frames.");
  }
  const pathKind = String(args.path_kind || "").trim();
  if (!PATH_KINDS.has(pathKind)) throw new Error('path_kind must be "polyline" or "smooth_arc".');
  const color = String(args.color || "").trim();
  if (!COLOR.test(color)) {
    throw new Error("color must be a sampled #RGB or #RRGGBB hex, not a hardcoded default.");
  }
  const layer = String(args.layer || "behind").trim();
  if (!LAYERS.has(layer)) throw new Error('layer must be "behind" or "front".');
  if (!Array.isArray(args.frames) || args.frames.length < 1) {
    throw new Error("frames must list per-frame start and end cells from the trace.");
  }
  const warnings = [];
  const frames = args.frames.map((frame, index) => {
    const frameIndex = Number(frame?.index ?? frame?.frame);
    if (!Number.isInteger(frameIndex) || frameIndex < 0) {
      throw new Error(`frames[${index}].index must be a 0-based frame integer.`);
    }
    const start = requireCell(frame.start, `frames[${index}].start`);
    const end = requireCell(frame.end, `frames[${index}].end`);
    const head =
      frame.head == null || frame.head === "" ? "" : requireCell(frame.head, `frames[${index}].head`);
    const weight = String(frame.weight || "solid").trim();
    if (!WEIGHTS.has(weight)) {
      throw new Error(`frames[${index}].weight must be none, faint, solid, or remnant.`);
    }
    if (head && end === head) {
      warnings.push(
        `frame ${frameIndex}: end is on the striking-mass cell ${head} — that paints onto the cup/shaft. Move end to the leading/outer side. Do not skip a full grid cell.`,
      );
    }
    return { index: frameIndex, start, end, head: head || null, weight };
  });
  const useMesh = pathKind === "smooth_arc";
  const acceptedPath = String(args.accepted_path || "").trim();
  const animationId = String(args.animation_id || "").trim();
  const meshLine = useMesh
    ? "Hermite mesh is allowed only if that arc already matches the intended smear."
    : "Do not use xsxb_add_attack_trail Hermite. Paint a 像素层 月牙/镰刀.";
  const lines = [
    "Clip-specific weapon smear brief. Execute this brief. The generic MCP playbook is only the skeleton.",
  ];
  if (animationId) lines.push(`Animation: ${animationId}.`);
  lines.push(`Motion (read from this clip's frames, not a canned recipe): ${motion}.`);
  lines.push(`Path kind: ${pathKind}. ${meshLine}`);
  lines.push(`Smear color (sampled, not a hardcoded red): ${color}.`);
  lines.push(
    `Composite layer ${layer} so opaque weapon pixels stay readable (hairline). Reject pinning the smear head on the striking-mass cell. Reject a full-grid-cell void that floats the smear.`,
  );
  if (acceptedPath) {
    lines.push(
      `An accepted sequence already passed eye QA: ${acceptedPath}. Reuse those frames. Do not GenerateImage a weaker sickle.`,
    );
  }
  lines.push("Per-frame locked cells:");
  for (const frame of frames) {
    const headBit = frame.head ? ` head ${frame.head}` : "";
    lines.push(`- frame ${frame.index}: start ${frame.start} → end ${frame.end}${headBit} (${frame.weight})`);
  }
  lines.push(
    "Paint with this same tool: pass target_path, overlay_id, view, and pivot_cells. MCP rasterizes a 像素层 月牙 from the blade pivot→tip. Do not GenerateImage a smear PNG. Do not xsxb_place_image a smear PNG. Timing: none/faint on wind-up, solid on the committed swing, remnant on follow-through, none on idle.",
  );
  lines.push(
    "Export xsxb_export_gif and xsxb_export_sheet. Human inspect sheets pass grid=false. Accept a continuous bow; reject bars, slices, 7字, overlap onto the weapon, and a floating cell-sized gap.",
  );
  return {
    brief: lines.join("\n"),
    useMesh,
    pathKind,
    motion,
    color,
    layer,
    animationId: animationId || null,
    acceptedPath: acceptedPath || null,
    frames,
    warnings,
    reference:
      animationId && !/^niulai/i.test(animationId)
        ? {
            note: "Example only — not a canned recipe for this clip. Trace this animation's cells; do not paste another attack's D1 path.",
          }
        : VALIDATED_SMEAR_REFERENCE,
  };
}

module.exports = { VALIDATED_SMEAR_REFERENCE, compileSmearBrief };
