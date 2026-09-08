"use strict";
const selection = {
  project_id: { type: "string" },
  profile_id: { type: "string" },
  animation_id: { type: "string" },
};
const preview = {
  dry_run: { type: "boolean", default: true, description: "Preview by default; false commits changes." },
  sync: { type: "boolean", default: false },
};
const range = {
  frames: { type: "array", items: { type: "integer", minimum: 0 } },
  start_frame: { type: "integer", minimum: 0 },
  end_frame: { type: "integer", minimum: 0 },
};
const EFFECTS = {
  xsxb_save_revision: { title: "Save revision", destructiveHint: false, idempotentHint: false },
  xsxb_list_revisions: { title: "List revisions", destructiveHint: false, idempotentHint: true },
  xsxb_compare_revisions: { title: "Compare revisions", destructiveHint: false, idempotentHint: false },
  xsxb_restore_revision: { title: "Restore revision", destructiveHint: true, idempotentHint: false },
  xsxb_undo: { title: "Undo authoring edit", destructiveHint: true, idempotentHint: false },
  xsxb_manage_animation: { title: "Manage animation", destructiveHint: true, idempotentHint: false },
  xsxb_resize_canvas: { title: "Resize canvas", destructiveHint: true, idempotentHint: false },
  xsxb_check_animation: { title: "Check animation", destructiveHint: false, idempotentHint: false },
  xsxb_interpolate_attachment: {
    title: "Interpolate attachment",
    destructiveHint: true,
    idempotentHint: false,
  },
};
/** Defines a closed public authoring command. */
function tool(name, description, properties, required = [], readOnly = false) {
  const { title, ...effects } = EFFECTS[name];
  return {
    name,
    title,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    annotations: { readOnlyHint: readOnly, ...effects },
  };
}
/** Returns the cohesive authoring extension catalog. */
function authoringDefinitions() {
  return [
    tool(
      "xsxb_save_revision",
      "Save exact authoring PNGs, metadata, timing and bindings as an immutable project checkpoint. Registry/Godot binding and preview files are excluded.",
      { project_id: selection.project_id, label: { type: "string" } },
    ),
    tool(
      "xsxb_list_revisions",
      "List newest project checkpoints first; includes automatic pre-edit checkpoints.",
      { project_id: selection.project_id },
      [],
      true,
    ),
    tool(
      "xsxb_compare_revisions",
      "Compare one checkpoint with current authoring data or another checkpoint; return changed files and before/after PNG evidence.",
      {
        project_id: selection.project_id,
        revision_id: { type: "string" },
        other_revision_id: { type: "string" },
      },
      ["revision_id"],
    ),
    tool(
      "xsxb_restore_revision",
      "Restore all project authoring files to a checkpoint. dry_run defaults true; apply creates a safety checkpoint for redo. External in_place PNG restoration requires restore_external=true.",
      {
        project_id: selection.project_id,
        revision_id: { type: "string" },
        restore_external: { type: "boolean", default: false },
        ...preview,
      },
      ["revision_id"],
    ),
    tool(
      "xsxb_undo",
      "Restore the newest pre-edit checkpoint (or explicit revision_id). Preview by default. Undo of a restore can redo it via the safety checkpoint.",
      {
        project_id: selection.project_id,
        revision_id: { type: "string" },
        restore_external: { type: "boolean", default: false },
        ...preview,
      },
    ),
    tool(
      "xsxb_manage_animation",
      "Copy, split, merge or rename animations in the selected profile, preserving PNG bytes, timing, boxes, attachments, audio and trails. Sources remain for copy/split/merge. Rename changes ownership; a pre-edit checkpoint preserves originals for recovery. Preview by default. Merge requires matching group visuals/anchors; differing FPS are retimed.",
      {
        ...selection,
        action: { type: "string", enum: ["copy", "split", "merge", "rename"] },
        target_animation_id: { type: "string" },
        source_animation_ids: { type: "array", items: { type: "string" } },
        segments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              animation_id: { type: "string" },
              start_frame: { type: "integer", minimum: 0 },
              end_frame: { type: "integer", minimum: 0 },
            },
            required: ["animation_id", "start_frame", "end_frame"],
            additionalProperties: false,
          },
        },
        fps: { type: "number", minimum: 1, maximum: 120 },
        ...preview,
      },
      ["action"],
    ),
    tool(
      "xsxb_resize_canvas",
      "Pad to width/height or trim shared transparent margins without scaling pixels. Preserve group origin by default (requires compatible pixel parity); clipped visible pixels are refused unless allow_clip=true. Origin-changing trim updates boxes, attachments and trail points. Preview and checkpoint precede commit.",
      {
        ...selection,
        ...range,
        mode: { type: "string", enum: ["pad", "trim"], default: "pad" },
        width: { type: "integer", minimum: 1, maximum: 4096 },
        height: { type: "integer", minimum: 1, maximum: 4096 },
        padding: { type: "integer", minimum: 0, maximum: 1024 },
        preserve_origin: { type: "boolean", default: true },
        allow_clip: { type: "boolean", default: false },
        ...preview,
      },
    ),
    tool(
      "xsxb_check_animation",
      "Flag suspected size jumps, feet/center drift, transparent holes, bright edges and canvas clipping; return per-frame metrics and magenta evidence sheet. Does not modify PNGs. Flags are geometric heuristics, not semantic proof.",
      {
        ...selection,
        ...range,
        size_tolerance: { type: "number", minimum: 0, maximum: 1 },
        feet_tolerance: { type: "number", minimum: 0 },
        center_tolerance: { type: "number", minimum: 0 },
        min_hole_pixels: { type: "integer", minimum: 1 },
        white_edge_ratio: { type: "number", minimum: 0, maximum: 1 },
      },
    ),
    tool(
      "xsxb_interpolate_attachment",
      "Interpolate an existing attachment id between explicit group-coordinate keyframes. Linear, smoothstep or hold. Angles are radians; shortest path by default, direct supports full spins. Layer switches at keyframes. Does not track hands or infer occlusion. Preview by default; replace=false refuses overlaps.",
      {
        ...selection,
        id: { type: "string" },
        interpolation: { type: "string", enum: ["linear", "smooth", "hold"], default: "linear" },
        rotation_path: { type: "string", enum: ["shortest", "direct"], default: "shortest" },
        replace: { type: "boolean", default: true },
        keyframes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              frame: { type: "integer", minimum: 0 },
              offset_x: { type: "number" },
              offset_y: { type: "number" },
              rotation: { type: "number" },
              scale: { type: "number", exclusiveMinimum: 0 },
              layer: { type: "string", enum: ["above", "below"] },
            },
            required: ["frame", "offset_x", "offset_y"],
            additionalProperties: false,
          },
        },
        ...preview,
      },
      ["id", "keyframes"],
    ),
  ];
}
module.exports = { authoringDefinitions };
