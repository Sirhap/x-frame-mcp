"use strict";

/**
 * Declarative catalog of the XSXB MCP tools: the advertised order, the input
 * schema of every tool, and the annotations clients use to reason about them.
 * Kept apart from the service so the schemas can be read and reviewed without
 * scrolling past the handler implementations.
 */

const path = require("node:path");
const { authoringDefinitions } = require("./authoring/catalog");
const { ORGANIZER_SIMILARITY_THRESHOLD } = require("./lib/animation_tuner/public/frame_organizer_core");
const { workbenchSliderSchemaProperties } = require("./xsxb_mcp_cutout");
const { receiptEnvelopeSchema } = require("./xsxb_mcp_receipt");

const DEFAULT_PROFILE_ID = "mcp_imports";
const ANIMATION_TYPE_PROPERTY = Object.freeze({
  type: "string",
  enum: ["actor", "boss", "vfx", "prop", "scene_prop_attachment"],
  default: "actor",
  description:
    "Stored clip type. vfx and prop skip the idle feet contract. Default actor. Do not rely on naming the id *_vfx.",
});
const MCP_TOOL_NAMES = Object.freeze([
  "xsxb_list_projects",
  "xsxb_get_project",
  "xsxb_create_project",
  "xsxb_import_video",
  "xsxb_slice_sheet",
  "xsxb_import_animation",
  "xsxb_get_animation",
  "xsxb_find_loop",
  "xsxb_find_duplicates",
  "xsxb_find_motion",
  "xsxb_analyze",
  "xsxb_update_frame_boxes",
  "xsxb_estimate_boxes",
  "xsxb_update_timing",
  "xsxb_set_visual_transform",
  "xsxb_estimate_visual",
  "xsxb_measure_frames",
  "xsxb_register_clip",
  "xsxb_reorganize_frames",
  "xsxb_replace_frame",
  "xsxb_shift_frames",
  "xsxb_plant_feet",
  "xsxb_compress_frames",
  "xsxb_add_attack_trail",
  "xsxb_plan_smear",
  "xsxb_add_attachment",
  "xsxb_add_sfx",
  "xsxb_remove_binding",
  "xsxb_delete_animation",
  "xsxb_sync_godot",
  "xsxb_validate_project",
  "xsxb_validate_for_godot",
  "xsxb_set_active_project",
  "xsxb_bind_godot",
  "xsxb_cutout",
  "xsxb_export_gif",
  "xsxb_export_sheet",
  "xsxb_export_overlay",
  "xsxb_diff_frames",
  "xsxb_export_pack_slot",
  "xsxb_measure_image",
  "xsxb_detect_regions",
  "xsxb_overlay_grid",
  "xsxb_plan_place",
  "xsxb_place_image",
  ...authoringDefinitions().map((tool) => tool.name),
]);

function toolDefinitions() {
  const projectProperty = {
    type: "string",
    description: "XSXB project id. Defaults to the last selected/imported project.",
  };
  const animationProperties = {
    project_id: projectProperty,
    profile_id: { type: "string", description: "Animation profile id." },
    animation_id: { type: "string", description: "Animation id." },
    basis_snapshot_id: {
      type: "string",
      description:
        "Content-addressed observation id. Required when a write derives frame order or A1 cells from an earlier observation.",
    },
  };
  const frameTimingProperties = {
    frame: { type: "integer", minimum: 0 },
    duration_ms: { type: "number", minimum: 1 },
    duration: {
      type: "number",
      minimum: 0.001,
      description: "Frame duration multiplier. 1 equals one FPS tick.",
    },
    disabled: { type: "boolean" },
  };
  const gridOverlayProperties = {
    grid_density: {
      type: "string",
      enum: ["sparse", "normal", "dense"],
      description:
        "Preset overlay divisions of the chosen scope: sparse=4x4, normal=8x8, dense=16x16. This densifies the lines. Large cells paint row/col indices matching grid.cells; group x,y live in that JSON. AI fills this from the task and image size. grid_divs or grid_x/grid_y win when set.",
    },
    grid_divs: {
      type: "string",
      description:
        'Explicit overlay cells, e.g. "8x8". Same group coordinates as the tuner. Wins over grid_density.',
    },
    grid_x: {
      type: "integer",
      minimum: 2,
      maximum: 64,
      description: "Explicit X divisions. Pair with grid_y. Wins over grid_density.",
    },
    grid_y: {
      type: "integer",
      minimum: 2,
      maximum: 64,
      description: "Explicit Y divisions. Pair with grid_x. Wins over grid_density.",
    },
    grid_scope: {
      type: "string",
      enum: ["canvas", "subject"],
      default: "canvas",
      description:
        "canvas covers the source frame. subject covers the opaque character box. Grid lines follow this density. Overlay paints row/col indices matching grid.cells; group coordinates are in the receipt JSON.",
    },
  };
  const tools = [
    {
      name: "xsxb_list_projects",
      description: "List every local XSXB project, its active state, Godot binding, and animation counts.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "xsxb_get_project",
      description:
        "Return one project's registry record, Godot binding, animation list, frame counts, and last sync receipt.",
      inputSchema: {
        type: "object",
        properties: { project_id: projectProperty },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "xsxb_create_project",
      description:
        "Create a local XSXB project and optionally make it active. If project_id already exists, return that project without duplicating. Omit project_id to allocate one from label.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: projectProperty,
          label: { type: "string", description: "Display label. Defaults to project_id." },
          project_root: {
            type: "string",
            description:
              "Directory this project belongs to (any folder, not only Godot). Authoring files are stored in that folder's .x-frame/ directory.",
          },
          set_active: {
            type: "boolean",
            default: true,
            description: "Make this the active project. Default true.",
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "xsxb_import_video",
      description:
        "Video alias of xsxb_import_animation: extract every native frame from a local video, import it as an XSXB animation, optionally sync to Godot, and validate the result. Omitting fps stores the probed source rate when it is between 1 and 60; otherwise 12. Receipt includes sourceFrameCount, sourceDurationSec when known, and suggestedFps.",
      inputSchema: {
        type: "object",
        required: ["file_path"],
        properties: {
          file_path: { type: "string", description: "Absolute local video path." },
          fps: {
            type: "number",
            minimum: 1,
            maximum: 120,
            default: 12,
            description: "Playback fps. Omit to use the probed source rate (1–60) when known; otherwise 12.",
          },
          start_time: {
            type: "number",
            minimum: 0,
            description: "Optional ffmpeg start seconds. Accurate seek after -i. Omit for the full file.",
          },
          duration: {
            type: "number",
            exclusiveMinimum: 0,
            description: "Optional ffmpeg window length in seconds. Omit for the rest of the file.",
          },
          start_frame: {
            type: "integer",
            minimum: 0,
            description: "Inclusive 0-based extracted frame index.",
          },
          end_frame: { type: "integer", minimum: 0, description: "Inclusive 0-based extracted frame index." },
          replace: {
            type: "boolean",
            default: false,
            description: "Replace an existing animation id atomically.",
          },
          sync: { type: "boolean", default: false },
          validate: { type: "boolean", default: false },
          project_id: projectProperty,
          profile_id: { type: "string", default: DEFAULT_PROFILE_ID },
          animation_id: { type: "string", description: "Defaults to a sanitized video filename." },
          animation_type: ANIMATION_TYPE_PROPERTY,
          in_place: {
            type: "boolean",
            default: false,
            description:
              "Not supported for video extraction (frames are temporary). Use a PNG sequence with in_place instead.",
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    {
      name: "xsxb_slice_sheet",
      description:
        "切表: cut a packed sprite/contact sheet into a PNG sequence. Walk-loop lock-ruler still prefers xsxb_measure_frames / xsxb_register_clip — slice is for packed sheets, not height QA.",
      inputSchema: {
        type: "object",
        required: ["file_path"],
        properties: {
          file_path: { type: "string", description: "Absolute sheet PNG path." },
          columns: {
            type: "integer",
            minimum: 1,
            maximum: 256,
            description: "Grid columns. Pair with rows, or omit and pass cell / grid_divs.",
          },
          rows: {
            type: "integer",
            minimum: 1,
            maximum: 256,
            description: "Grid rows. Pair with columns, or omit and pass cell / grid_divs.",
          },
          cell: {
            type: "integer",
            minimum: 1,
            maximum: 4096,
            description:
              "Uniform cell edge in pixels. Infers columns×rows from the image when those are omitted.",
          },
          cell_w: {
            type: "integer",
            minimum: 1,
            maximum: 4096,
            description: "Rectangular cell width. Pair with cell_h.",
          },
          cell_h: {
            type: "integer",
            minimum: 1,
            maximum: 4096,
            description: "Rectangular cell height. Pair with cell_w.",
          },
          grid_divs: {
            type: "string",
            description: 'Grid size like "8x8" (columns x rows), same language as export_sheet.',
          },
          pad: {
            type: "integer",
            minimum: 0,
            maximum: 64,
            default: 0,
            description: "Pixels between cells. Default 0.",
          },
          padding: {
            type: "integer",
            minimum: 0,
            maximum: 64,
            description: "Alias of pad.",
          },
          dest: {
            type: "string",
            description:
              "Output directory. May be absolute outside the XSXB root, like xsxb_export_pack_slot. Defaults to <sheet>_cells next to the sheet.",
          },
          start_index: {
            type: "integer",
            minimum: 0,
            default: 0,
            description: "First output name: 0.png, 1.png, … left-to-right, top-to-bottom among kept cells.",
          },
          skip_empty: {
            type: "boolean",
            default: true,
            description: "Skip fully transparent cells. Receipt.skipped lists them. Default true.",
          },
          animation_id: {
            type: "string",
            description: "When set, import the kept PNG sequence after slicing.",
          },
          animation_name: { type: "string" },
          animation_type: ANIMATION_TYPE_PROPERTY,
          project_id: projectProperty,
          profile_id: { type: "string", default: DEFAULT_PROFILE_ID },
          fps: { type: "number", minimum: 1, maximum: 120, default: 12 },
          replace: { type: "boolean", default: false },
          sync: { type: "boolean", default: false },
          validate: { type: "boolean", default: false },
          loop_endpoint: {
            type: "string",
            enum: ["none", "duplicate_first"],
            default: "none",
            description: "Forwarded to import when animation_id is set.",
          },
          in_place: {
            type: "boolean",
            default: false,
            description: "Forwarded to xsxb_import_animation when animation_id is set.",
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    {
      name: "xsxb_import_animation",
      description:
        "Import a video, PNG sequence, SpriteFrames file, or PNG data items as an XSXB animation. xsxb_import_video is this tool's video alias. Pass animation_type=vfx|prop for FX so Godot scale skips idle feet; default actor.",
      inputSchema: {
        type: "object",
        properties: {
          source: {
            type: "string",
            enum: ["video", "png_sequence", "spriteframes", "items"],
            description: "Import kind. Inferred from file_path, directory, or items when omitted.",
          },
          file_path: { type: "string", description: "Absolute video or .spriteframes.tres path." },
          directory: { type: "string", description: "Absolute directory of PNG frames." },
          items: {
            type: "array",
            items: { type: "object" },
            description: "PNG data-URL items for source=items.",
          },
          fps: { type: "number", minimum: 1, maximum: 120, default: 12 },
          start_time: {
            type: "number",
            minimum: 0,
            description: "Optional ffmpeg start seconds when source is video. Omit for the full file.",
          },
          duration: {
            type: "number",
            exclusiveMinimum: 0,
            description: "Optional ffmpeg window length in seconds when source is video.",
          },
          start_frame: { type: "integer", minimum: 0 },
          end_frame: { type: "integer", minimum: 0 },
          replace: { type: "boolean", default: false },
          sync: { type: "boolean", default: false },
          validate: { type: "boolean", default: false },
          project_id: projectProperty,
          profile_id: { type: "string", default: DEFAULT_PROFILE_ID },
          animation_id: { type: "string" },
          animation_name: { type: "string" },
          animation_type: ANIMATION_TYPE_PROPERTY,
          loop_endpoint: {
            type: "string",
            enum: ["none", "duplicate_first"],
            default: "none",
            description:
              "duplicate_first copies frame 0 as the last frame so a walk/run loop closes on the same pixels.",
          },
          in_place: {
            type: "boolean",
            default: false,
            description:
              "Keep frames at their original PNG paths; do not copy into workspace/assets. Source may be inside the XSXB root or a game-pack directory. Default copies into the project workspace.",
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    {
      name: "xsxb_get_animation",
      description:
        "Return animation metadata and frames. Pass frames=summary for a compact sample without animation.frames. Pass include to also read back current boxes, timing, sfx, attachments, or trails. Receipts use group coordinates (foot 0,0, body negative y), the same space as the overlay ticks.",
      inputSchema: {
        type: "object",
        properties: {
          ...animationProperties,
          frames: { type: "string", enum: ["summary", "full"], default: "full" },
          include: {
            type: "array",
            items: {
              type: "string",
              enum: ["boxes", "timing", "visual", "sfx", "attachments", "trails"],
            },
            description:
              "Extra sections to return: box overrides, playback timing, visual transforms, and bindings.",
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "xsxb_find_loop",
      description:
        "Rank loop-segment candidates with the same Tuner loop finder. Query an imported animation, a PNG directory, or file_paths. Does not mutate frames; apply a candidate with xsxb_reorganize_frames order. oneShotLikely means a short burst inside a longer clip — inspect the preview or use xsxb_find_motion. A solid interior cycle in a long take is not a one-shot. Prefer xsxb_analyze after import.",
      inputSchema: {
        type: "object",
        properties: {
          ...animationProperties,
          directory: {
            type: "string",
            description: "Absolute PNG sequence directory. Overrides the imported animation when set.",
          },
          file_paths: {
            type: "array",
            items: { type: "string" },
            description:
              "Absolute PNG paths in playback order. Overrides directory and the imported animation when set.",
          },
          min_period: {
            type: "integer",
            minimum: 2,
            description: "Smallest loop period to consider. Defaults to the Tuner minimum of 2.",
          },
          max_period: {
            type: "integer",
            minimum: 2,
            description: "Largest loop period to consider. Defaults to two-thirds of the frame count.",
          },
          start_frame: {
            type: "integer",
            minimum: 0,
            description: "Ignore candidates that start before this 0-based index.",
          },
          preference: {
            type: "string",
            enum: ["auto", "short", "long"],
            default: "auto",
            description: "Bias ranking toward shorter or longer periods without dropping valid ones.",
          },
          boundary_factor: {
            type: "number",
            minimum: 0,
            maximum: 1,
            default: 0.85,
            description: "Same Tuner seam threshold as the organizer loop search.",
          },
          sample_size: {
            type: "integer",
            minimum: 8,
            maximum: 256,
            default: 256,
            description: "Square analysis sample. Matches the Tuner 256×256 reference size.",
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "xsxb_find_duplicates",
      description:
        "Find near-duplicate hold frames with the same Tuner duplicate finder. Pass threshold or duplicate_ratio for the organizer 重复比例 slider; do not pass both unless they match. If autoAdjustedThreshold is set and you did not pass auto_adjust, applyBlocked is true and order is empty — use suggestedOrder only after auto_adjust. Query an imported animation, a PNG directory, or file_paths. Does not mutate frames; apply the keep-order with xsxb_reorganize_frames.",
      inputSchema: {
        type: "object",
        properties: {
          ...animationProperties,
          directory: {
            type: "string",
            description: "Absolute PNG sequence directory. Overrides the imported animation when set.",
          },
          file_paths: {
            type: "array",
            items: { type: "string" },
            description:
              "Absolute PNG paths in playback order. Overrides directory and the imported animation when set.",
          },
          threshold: {
            type: "number",
            minimum: ORGANIZER_SIMILARITY_THRESHOLD.min,
            maximum: ORGANIZER_SIMILARITY_THRESHOLD.max,
            default: ORGANIZER_SIMILARITY_THRESHOLD.fallback,
            description: "Organizer 相似度阈值 / 重复比例 slider. Higher keeps more near-duplicates.",
          },
          duplicate_ratio: {
            type: "number",
            minimum: ORGANIZER_SIMILARITY_THRESHOLD.min,
            maximum: ORGANIZER_SIMILARITY_THRESHOLD.max,
            default: ORGANIZER_SIMILARITY_THRESHOLD.fallback,
            description: "Alias of threshold. Same organizer 重复比例 slider.",
          },
          auto_adjust: {
            type: "boolean",
            default: false,
            description:
              "If true, apply the finder's lowered threshold when nothing matches the requested slider. Default sets applyBlocked, leaves order empty, and reports autoAdjustedThreshold / suggestedOrder / suggestedDrop.",
          },
          sample_size: {
            type: "integer",
            minimum: 8,
            maximum: 256,
            default: 256,
            description: "Square analysis sample. Matches the Tuner 256×256 reference size.",
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "xsxb_find_motion",
      description:
        "Find the interior motion window by trimming a leading rest hold and, when the clip returns to that rest, the trailing hold. Query an imported animation, a PNG directory, or file_paths. Does not mutate frames; apply the order with xsxb_reorganize_frames.",
      inputSchema: {
        type: "object",
        properties: {
          ...animationProperties,
          directory: {
            type: "string",
            description: "Absolute PNG sequence directory. Overrides the imported animation when set.",
          },
          file_paths: {
            type: "array",
            items: { type: "string" },
            description:
              "Absolute PNG paths in playback order. Overrides directory and the imported animation when set.",
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "xsxb_analyze",
      description:
        "One-pass clip analysis after import: duplicates, loop, and motion window. Decodes each PNG once. Writes a grid=false preview sheet of the recommended window (loop, or motion when oneShotLikely). Does not mutate frames; apply with xsxb_reorganize_frames using applyOrder (or recommended.applyOrder): drop holds when auto_adjust is set or autoAdjustedThreshold is null, then slice to the loop or motion window. Do not pass loop.recommended.order or motion.order alone — those index the full imported clip and keep rest holds. Look at preview.path — do not export_sheet every candidate. oneShotLikely means a short burst inside a longer clip; a solid interior cycle in a long take is not a one-shot. When duplicates.applyBlocked, do not apply duplicates.order until you pass auto_adjust. Surgical find_loop / find_duplicates / find_motion remain for a single query.",
      inputSchema: {
        type: "object",
        properties: {
          ...animationProperties,
          directory: {
            type: "string",
            description: "Absolute PNG sequence directory. Overrides the imported animation when set.",
          },
          file_paths: {
            type: "array",
            items: { type: "string" },
            description:
              "Absolute PNG paths in playback order. Overrides directory and the imported animation when set.",
          },
          threshold: {
            type: "number",
            minimum: ORGANIZER_SIMILARITY_THRESHOLD.min,
            maximum: ORGANIZER_SIMILARITY_THRESHOLD.max,
            default: ORGANIZER_SIMILARITY_THRESHOLD.fallback,
            description: "Organizer 相似度阈值 / 重复比例 slider. Higher keeps more near-duplicates.",
          },
          duplicate_ratio: {
            type: "number",
            minimum: ORGANIZER_SIMILARITY_THRESHOLD.min,
            maximum: ORGANIZER_SIMILARITY_THRESHOLD.max,
            default: ORGANIZER_SIMILARITY_THRESHOLD.fallback,
            description: "Alias of threshold. Same organizer 重复比例 slider.",
          },
          auto_adjust: {
            type: "boolean",
            default: false,
            description:
              "If true, apply the finder's lowered threshold when nothing matches the requested slider. Default sets applyBlocked, leaves order empty, and reports autoAdjustedThreshold / suggestedOrder / suggestedDrop.",
          },
          min_period: {
            type: "integer",
            minimum: 2,
            description: "Smallest loop period to consider. Defaults to the Tuner minimum of 2.",
          },
          max_period: {
            type: "integer",
            minimum: 2,
            description: "Largest loop period to consider. Defaults to two-thirds of the frame count.",
          },
          start_frame: {
            type: "integer",
            minimum: 0,
            description: "Ignore loop candidates that start before this 0-based index.",
          },
          preference: {
            type: "string",
            enum: ["auto", "short", "long"],
            default: "auto",
            description: "Bias loop ranking toward shorter or longer periods without dropping valid ones.",
          },
          boundary_factor: {
            type: "number",
            minimum: 0,
            maximum: 1,
            default: 0.85,
            description: "Same Tuner seam threshold as the organizer loop search.",
          },
          sample_size: {
            type: "integer",
            minimum: 8,
            maximum: 256,
            default: 256,
            description: "Square analysis sample. Matches the Tuner 256×256 reference size.",
          },
          preview: {
            type: "boolean",
            default: true,
            description: "Write a contact sheet of the recommended window. Default true.",
          },
          output_path: {
            type: "string",
            description:
              "Preview PNG destination inside the XSXB root. Relative paths hang off the current project's .xsxb/ folder.",
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "xsxb_update_frame_boxes",
      description:
        "Update hurtbox, collisionbox, and hitbox for one animation frame, or many frames at once via frames. Boxes are group coordinates (foot 0,0). Pass offset+size, min/max corners, or x,y,width,height. min/max also accept overlay cell ids (E5 / e5 / {cell:E5}) resolved from the frame PNG size plus grid_divs/grid_density/grid_scope. Does not sync Godot.",
      inputSchema: {
        type: "object",
        properties: {
          ...animationProperties,
          ...gridOverlayProperties,
          frame: { type: "integer", minimum: 0, default: 0 },
          hurtbox: { type: "object" },
          collisionbox: { type: "object" },
          hitbox: { type: "object" },
          frames: {
            type: "array",
            items: { type: "object" },
            description:
              "Batch mode: [{frame, hurtbox?, collisionbox?, hitbox?}, ...] applied in one write. Overrides the single-frame parameters.",
          },
          sync: { type: "boolean", default: false },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "xsxb_estimate_boxes",
      description:
        "Auto-estimate hurtbox, collisionbox, and hitbox overrides for every animation frame from opaque pixel bounds. Keeps existing overrides unless replace=true. Use dry_run to preview.",
      inputSchema: {
        type: "object",
        properties: {
          ...animationProperties,
          replace: {
            type: "boolean",
            default: false,
            description: "Recompute frames that already have box overrides.",
          },
          dry_run: { type: "boolean", default: false },
          sync: { type: "boolean", default: false },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "xsxb_update_timing",
      description:
        "Update animation FPS and optional per-frame duration or disabled playback, or many frames at once via frames. Does not sync Godot.",
      inputSchema: {
        type: "object",
        properties: {
          ...animationProperties,
          fps: { type: "number", minimum: 1, maximum: 120 },
          ...frameTimingProperties,
          frames: {
            type: "array",
            items: { type: "object", properties: frameTimingProperties, additionalProperties: false },
            description:
              "Batch mode: [{frame, duration_ms?, duration?, disabled?}, ...] applied in one write. Overrides the single-frame parameters.",
          },
          sync: { type: "boolean", default: false },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "xsxb_set_visual_transform",
      description:
        "Set visual size, offset, and rotation at the character (profile), animation group, or single-frame level. offset_x/offset_y are group coordinates, the same numbers as the overlay ticks. Pass frames:[{frame,visual_size}] to write many frames at once; clear_group=true clears the group scale in the same call. Pass clear=true to remove overrides at that level. Does not sync Godot.",
      inputSchema: {
        type: "object",
        properties: {
          ...animationProperties,
          level: {
            type: "string",
            enum: ["character", "group", "frame"],
            default: "group",
            description:
              "character applies to the whole profile; group to one animation; frame to one frame. Ignored when frames is set.",
          },
          frame: { type: "integer", minimum: 0, description: "Required when level=frame." },
          frames: {
            type: "array",
            items: {
              type: "object",
              required: ["frame"],
              additionalProperties: false,
              properties: {
                frame: { type: "integer", minimum: 0 },
                visual_size: { type: "number", exclusiveMinimum: 0 },
                offset_x: { type: "number" },
                offset_y: { type: "number" },
                rotation: { type: "number" },
                clear: { type: "boolean", default: false },
              },
            },
            description: "Batch frame-level writes. Clears the need for one call per frame.",
          },
          clear_group: {
            type: "boolean",
            default: false,
            description: "Remove group visual_size while writing frames in this call.",
          },
          visual_size: {
            type: "number",
            exclusiveMinimum: 0,
            description: "Uniform visual scale multiplier.",
          },
          offset_x: { type: "number" },
          offset_y: { type: "number" },
          rotation: { type: "number", description: "Rotation in radians." },
          clear: {
            type: "boolean",
            default: false,
            description: "Remove all visual overrides at the selected level.",
          },
          sync: { type: "boolean", default: false },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "xsxb_estimate_visual",
      description:
        "Estimate group and per-frame visual_size so standing height matches a reference animation or target_height. Default shared mode keeps pose bounce (one groupScale; zoomed-out frames get their own scale). equalize=true scales every frame independently to the target. metric is bbox (opaque box, what idle lock uses), body (glow-stripped), or torso. reference_frame picks the idle frame instead of a clip median. This is a scale estimator — lock feet/cx in pixels with xsxb_register_clip. apply writes those scales; bake pixels later with xsxb_cutout apply_visual.",
      inputSchema: {
        type: "object",
        properties: {
          ...animationProperties,
          reference_animation_id: {
            type: "string",
            description: "Animation whose standing height is the target when target_height is omitted.",
          },
          reference_frame: {
            type: "integer",
            minimum: 0,
            default: 0,
            description: "Reference animation frame used as the target pose. Default 0, not a median.",
          },
          target_height: {
            type: "number",
            exclusiveMinimum: 0,
            description: "Desired standing height in pixels. Overrides the reference frame when set.",
          },
          metric: {
            type: "string",
            enum: ["bbox", "body", "torso"],
            default: "body",
            description: "bbox is the opaque box; body/torso ignore glow below the boots.",
          },
          equalize: {
            type: "boolean",
            default: false,
            description: "Scale each frame on its own to the target. Default shared keeps relative bounce.",
          },
          zoom_ratio: {
            type: "number",
            minimum: 1,
            default: 1.12,
            description:
              "A frame shorter than native/zoom_ratio is treated as camera zoom-out (shared mode).",
          },
          apply: {
            type: "boolean",
            description:
              "true commits visual_size; false forces preview. Omit both apply and dry_run to preview. Does not bake pixels.",
          },
          dry_run: {
            type: "boolean",
            description:
              "true forces preview; false commits unless apply is false. Omit both flags to preview.",
          },
          sync: { type: "boolean", default: false },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "xsxb_measure_frames",
      description:
        "Measure every animation frame: bbox, body height, head y, feet y, centroid cx, foot center fx. Pass reference_animation_id (usually idle) to get per-frame dBbox / dFirst / dCx / dFx. This is the lock-ruler; xsxb_measure_image is a weapon axis tool.",
      inputSchema: {
        type: "object",
        properties: {
          ...animationProperties,
          reference_animation_id: {
            type: "string",
            description: "Idle or other clip to diff against. Uses reference_frame of that clip.",
          },
          reference_frame: {
            type: "integer",
            minimum: 0,
            default: 0,
            description: "Frame of the reference animation. Default 0.",
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "xsxb_register_clip",
      description:
        "Lock a clip to a reference pose or target_bbox: measure, scale about the feet, then translate cx/fx. mode=equalize scales each frame on its own (camera distance); shared_scale keeps pose bounce. apply writes pixels in one call. dry_run returns the Δ table. Do not use xsxb_shift_frames to lock height.",
      inputSchema: {
        type: "object",
        properties: {
          ...animationProperties,
          reference_animation_id: {
            type: "string",
            description: "Idle or other clip whose geometry is the lock target.",
          },
          reference_frame: {
            type: "integer",
            minimum: 0,
            default: 0,
            description: "Reference pose frame. Default 0, not a median.",
          },
          target_bbox: {
            type: "number",
            exclusiveMinimum: 0,
            description: "Opaque bbox height to lock to when no reference is set.",
          },
          mode: {
            type: "string",
            enum: ["equalize", "shared_scale"],
            default: "equalize",
            description: "equalize flattens source zoom; shared_scale keeps relative bounce.",
          },
          metric: {
            type: "string",
            enum: ["bbox", "body", "torso"],
            default: "bbox",
            description: "Height to lock. Idle lock is bbox, not MCP bodyHeight.",
          },
          anchor: {
            type: "string",
            enum: ["feet"],
            default: "feet",
            description: "Scale about the soles.",
          },
          align: {
            type: "string",
            enum: ["cx", "fx", "torso"],
            default: "cx",
            description: "Horizontal plant: centroid, foot center, or torso.",
          },
          dry_run: {
            type: "boolean",
            description:
              "true forces preview; false commits unless apply is false. Omit both flags to preview.",
          },
          apply: {
            type: "boolean",
            description:
              "true bakes the lock into workspace PNGs unless dry_run is true; false forces preview.",
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    {
      name: "xsxb_reorganize_frames",
      description:
        "Reorder frames and remap frame-owned tuning, audio, attachments, and trails; a non-empty order commits unless dry_run is true, omitting order is an identity preview, and sync:true explicitly synchronizes Godot.",
      inputSchema: {
        type: "object",
        properties: {
          ...animationProperties,
          order: {
            type: "array",
            items: { type: "integer", minimum: 0 },
            description: "Source frame indexes in the desired output order. Defaults to the current order.",
          },
          loop_endpoint: {
            type: "string",
            enum: ["none", "duplicate_first"],
            default: "none",
            description: "duplicate_first appends source frame 0 after the given order.",
          },
          dry_run: {
            type: "boolean",
            default: true,
            description: "Preview the output order; false commits the reorganization.",
          },
          sync: { type: "boolean", default: false },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "xsxb_replace_frame",
      description:
        "Replace one workspace frame PNG with a new local PNG while keeping boxes, timing, and bindings. Updates the stored frame size when it changes.",
      inputSchema: {
        type: "object",
        required: ["frame", "file_path"],
        properties: {
          ...animationProperties,
          frame: { type: "integer", minimum: 0 },
          file_path: { type: "string", description: "Absolute replacement PNG path." },
          sync: { type: "boolean", default: false },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    {
      name: "xsxb_shift_frames",
      description:
        "Translate frame PNGs without resampling or scaling; coordinates use overlay group units (or cell ids). Positive dy moves down; plant soles at y=-1, never 0,0. Use xsxb_register_clip for height and xsxb_plant_feet for automatic planting; stale catalogs should be reloaded.",
      inputSchema: {
        type: "object",
        required: ["frames"],
        properties: {
          ...animationProperties,
          frames: {
            type: "array",
            items: {
              type: "object",
              required: ["frame"],
              additionalProperties: false,
              properties: {
                frame: { type: "integer", minimum: 0 },
                dx: {
                  type: "integer",
                  default: 0,
                  description: "Group units right. Same as overlay x ticks. Negative is left.",
                },
                dy: {
                  type: "integer",
                  default: 0,
                  description:
                    "Group units down toward the foot origin. Same as overlay y ticks. Negative lifts the subject.",
                },
                from: {
                  description: 'Group point to move, {x,y} or "x,y", or overlay cell id E5 / e5 / {cell:E5}.',
                },
                to: {
                  description:
                    "Group point or overlay cell that from should land on. MCP computes dx/dy. Plant soles to y=-1, not 0,0: yellow 0,0 is outside the bitmap (canvasAnchor y=height).",
                },
              },
            },
            description: "Each entry needs frame plus dx/dy or from/to group points.",
          },
          ...gridOverlayProperties,
          sync: { type: "boolean", default: false },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    {
      name: "xsxb_plant_feet",
      description:
        "Plant opaque soles onto a target group-Y without computing dx/dy. Translate only — does not scale; lock height with xsxb_register_clip. Walk-loop plant after xsxb_measure_frames; still confirm on the overlay. Default target is y=-1 (last pixel row of the lock canvas). Yellow 0,0 is outside the bitmap — do not plant soles to 0,0. metrics.feetY is the boot sole and ignores connected bright slash/glow below it. Hanging VFX that would clip is kept by padding the PNG; apply writes the new height into the animation manifest so Tuner/Godot origin matches the bitmap. After apply plans selected frames, every frame in this animation is padded to that clip's on-disk max(width)×max(height) with xsxb_resize_canvas pad rules (no resample) so canvases match for diff_frames. Pass reference_animation_id (usually idle) so apply pads this clip to at least that canvas with xsxb_resize_canvas pad rules, then plants soles onto the reference clip's measured feetY (same group row as idle boots) when target_y is omitted or -1. Omitted reference on walk defaults to idle. Optional to accepts an overlay cell id (E5 / e5 / {cell:E5}) and maps to that cell's group coordinate. dry_run (default) returns the plan; apply bakes the translate. Reuses the shift_frames pixel pipeline.",
      inputSchema: {
        type: "object",
        properties: {
          ...animationProperties,
          frames: {
            type: "array",
            items: { type: "integer", minimum: 0 },
            description: "Frame indexes to plant. Omit to plant every frame.",
          },
          target_y: {
            type: "number",
            default: -1,
            description:
              "Destination group Y for the opaque sole. Default -1 is the last pixel row. Do not use 0 (yellow 0,0 is outside the bitmap).",
          },
          reference_animation_id: {
            type: "string",
            description:
              "When set, pad this clip to at least the reference canvas (transparent, no resample; same origin-preserving pad as xsxb_resize_canvas) then plant soles onto that clip's measured feetY (same group row as idle boots) when target_y is omitted or -1. Usually idle.",
          },
          to: {
            description:
              "Optional overlay cell id (E5 / e5 / {cell:E5}) or group point. Maps to that cell's group coordinate. Default remains y=-1 sole plant.",
          },
          dry_run: {
            type: "boolean",
            description:
              "true forces preview; false commits unless apply is false. Omit both flags to preview.",
          },
          apply: {
            type: "boolean",
            description: "true writes the translation unless dry_run is true; false forces preview.",
          },
          ...gridOverlayProperties,
          sync: { type: "boolean", default: false },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    {
      name: "xsxb_compress_frames",
      description:
        "Lossless-reencode workspace PNG frames with max zlib. Pixels stay identical. Writes only when the file shrinks. dry_run reports savings without writing.",
      inputSchema: {
        type: "object",
        properties: {
          ...animationProperties,
          dry_run: {
            type: "boolean",
            default: true,
            description: "Preview byte savings by default; false writes smaller files.",
          },
          start_frame: { type: "integer", minimum: 0, description: "Inclusive 0-based frame index." },
          end_frame: { type: "integer", minimum: 0, description: "Inclusive 0-based frame index." },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "xsxb_add_attack_trail",
      description:
        "Add or replace a still-frame attack-trail segment with blade-edge sticks, layer, color, and optional reverseDirection. Use smooth_arc only for truly curved motion; walk/run loops should use other tools and pixel-layer crescents belong to place_image.",
      inputSchema: {
        type: "object",
        properties: {
          ...animationProperties,
          id: { type: "string", description: "Segment id. Defaults to the texture basename or trail." },
          name: { type: "string" },
          color: { type: "string", description: "#RRGGBB solid color." },
          color_mode: { type: "string", enum: ["solid", "original", "gradient"], default: "solid" },
          render_mode: {
            type: "string",
            enum: ["mesh", "sweep"],
            default: "mesh",
            description:
              "sweep fills the recent blade-edge trajectory with time decay in MCP sheet/GIF exports. Requires explicit sticks. Godot/Tuner continue using their mesh fallback; mesh keeps existing behavior everywhere.",
          },
          trail_duration_ms: { type: "number", minimum: 1, maximum: 5000, default: 150 },
          opacity: { type: "number", minimum: 0, maximum: 1, default: 0.85 },
          path_kind: {
            type: "string",
            enum: ["polyline", "smooth_arc"],
            default: "smooth_arc",
            description:
              "polyline forbids Hermite mesh (sticks stay stored; GIF/sheet do not bake the mesh). smooth_arc may use the mesh only if that arc already matches.",
          },
          texture_path: {
            type: "string",
            description: "Absolute PNG trail texture. Defaults to the built-in luma preset.",
          },
          start_frame: { type: "integer", minimum: 0 },
          end_frame: { type: "integer", minimum: 0 },
          before_stop_chase: {
            type: "number",
            minimum: 0,
            maximum: 1,
            default: 0.12,
            description:
              "0.12 keeps a long smear so a follow-through does not erase the slash. 0 fills the whole swing. 1 hugs the current blade.",
          },
          after_stop_chase: {
            type: "number",
            minimum: 0.1,
            maximum: 20,
            default: 2,
            description: "How fast the tail catches the head after the last stick.",
          },
          sticks: {
            type: "array",
            description: "Blade-edge sticks. One swing per segment.",
            items: {
              type: "object",
              properties: {
                frame: { type: "integer", minimum: 0 },
                top: {
                  description:
                    'Blade tip in group coordinates. {x,y} or "x,y", or overlay cell id E5 / e5 / {cell:E5}.',
                },
                bottom: {
                  description:
                    'Blade grip in group coordinates. {x,y} or "x,y", or overlay cell id E5 / e5 / {cell:E5}.',
                },
                layer: {
                  type: "string",
                  enum: ["behind", "front"],
                  description: "Draw this stick's mesh behind or in front of the character.",
                },
                reverseDirection: {
                  type: "boolean",
                  description: "Flip the curve handle. Use when the ribbon folds through the body.",
                },
                tangentStrength: {
                  type: "number",
                  description: "Curve handle length. Product default 0.8; omit unless editing in Tuner.",
                },
              },
            },
          },
          ...gridOverlayProperties,
          sync: { type: "boolean", default: false },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "xsxb_plan_smear",
      description:
        "Walk/run loops: do not use this (still-frame / smear only). Compile a clip-specific weapon-smear prompt from the motion and cells you traced on this animation. The generic playbook is only the skeleton — call this before GenerateImage or xsxb_place_image, then execute receipt.brief. path_kind polyline forbids Hermite; smooth_arc may use the mesh only if that arc already matches. layer behind keeps the cup readable (hairline); do not pin the head on the striking-mass cell; do not skip a full grid cell. If a GIF/sheet already passed eye QA, pass accepted_path and reuse it. Receipt.reference is a validated example only (牛来 chop v4), not a recipe for other attacks.",
      inputSchema: {
        type: "object",
        required: ["motion", "path_kind", "color", "frames"],
        properties: {
          animation_id: { type: "string", description: "Animation id this brief is for." },
          motion: {
            type: "string",
            description:
              "Weapon-head path you read from this clip's frames. Not a canned chop or 上挑 recipe.",
          },
          path_kind: {
            type: "string",
            enum: ["polyline", "smooth_arc"],
            description: "polyline → 像素层 月牙. smooth_arc → Hermite only if that arc already matches.",
          },
          color: {
            type: "string",
            description: "Sampled smear hex from the striking mass or a user-named hex. Do not hardcode red.",
          },
          layer: {
            type: "string",
            enum: ["behind", "front"],
            default: "behind",
            description: "behind restores opaque weapon pixels so the cup stays readable.",
          },
          accepted_path: {
            type: "string",
            description: "GIF/sheet that already passed eye QA. Reuse those frames; do not regenerate.",
          },
          frames: {
            type: "array",
            description: "Locked per-frame smear cells from the trace.",
            items: {
              type: "object",
              properties: {
                index: { type: "integer", minimum: 0, description: "0-based frame index." },
                start: { type: "string", description: "Far cell already swept, e.g. D1." },
                end: {
                  type: "string",
                  description: "Leading/outer side of this frame's striking face, e.g. H2.",
                },
                head: {
                  type: "string",
                  description:
                    "Current striking-mass cell. End must not equal this or the ribbon paints onto the cup.",
                },
                weight: {
                  type: "string",
                  enum: ["none", "faint", "solid", "remnant"],
                  description: "Wind-up none/faint; committed swing solid; follow-through remnant.",
                },
              },
            },
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "xsxb_add_attachment",
      description:
        "Walk/run loops: do not use this. Bind a local PNG as a frame image attachment. file_path is required for a real asset. Pass frames to bind the same asset on many frames in one write. offset_x/offset_y are group coordinates. Prefer hand (group point, overlay cell, or fresh detect_regions reference) plus t; MCP measures the PNG and applies its scale and rotation before solving the grip offset.",
      inputSchema: {
        type: "object",
        properties: {
          ...animationProperties,
          file_path: { type: "string", description: "Absolute PNG path to attach." },
          frame: { type: "integer", minimum: 0, default: 0 },
          frames: {
            type: "array",
            items: { type: "object" },
            description:
              "Batch mode: [{frame, offset_x?, offset_y?, scale?, rotation?}, ...] applied in one write. Shared file_path/id/layer apply to every entry. Overrides the single-frame parameters.",
          },
          id: { type: "string" },
          name: { type: "string" },
          layer: { type: "string", enum: ["above", "below"], default: "above" },
          layer_order: {
            type: "integer",
            description: "Signed draw order; omitted derives -1 for below and +1 for above.",
          },
          offset_x: { type: "number", default: 0 },
          offset_y: { type: "number" },
          hand: {
            description:
              "Stage grip: group {x,y}, cell id, or {region_id,basis_snapshot_id} from detect_regions for this frame. With t, MCP subtracts the rotated, scaled local grip from hand. Region references validate source freshness.",
          },
          t: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description:
              "Grip fraction along the attachment PNG pommel→tip. Used with hand. 0.5 is the middle.",
          },
          scale: { type: "number", default: 1 },
          rotation: { type: "number", default: 0 },
          ...gridOverlayProperties,
          sync: { type: "boolean", default: false },
        },
        required: ["file_path"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "xsxb_add_sfx",
      description:
        "Walk/run loops: do not use this. Bind a local WAV/OGG/MP3 to one animation frame. file_path is required for a real clip.",
      inputSchema: {
        type: "object",
        properties: {
          ...animationProperties,
          file_path: { type: "string", description: "Absolute audio path." },
          frame: { type: "integer", minimum: 0, default: 0 },
          id: { type: "string" },
          name: { type: "string" },
          sync: { type: "boolean", default: false },
        },
        required: ["file_path"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "xsxb_remove_binding",
      description:
        "Remove one SFX, attachment, or attack-trail binding by id from one animation. Use frame to disambiguate sfx/attachment bindings that share an id. Supports dry_run.",
      inputSchema: {
        type: "object",
        required: ["kind", "id"],
        properties: {
          ...animationProperties,
          kind: { type: "string", enum: ["sfx", "attachment", "trail"] },
          id: { type: "string", description: "Binding or trail segment id." },
          frame: {
            type: "integer",
            minimum: 0,
            description: "Only remove the binding on this frame. Not applicable to trails.",
          },
          dry_run: { type: "boolean", default: false },
          sync: { type: "boolean", default: false },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    {
      name: "xsxb_delete_animation",
      description:
        "Delete one imported animation and its owned frames, tuning, and bindings. Supports dry_run.",
      inputSchema: {
        type: "object",
        properties: {
          ...animationProperties,
          dry_run: { type: "boolean", default: false },
          sync: { type: "boolean", default: false },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    {
      name: "xsxb_sync_godot",
      description:
        "Synchronize the current project to its bound Godot root without changing animation data. Drops stale .godot/imported .ctex files when synced PNG bytes no longer match the cached source_md5. Receipt.godot is a disk snapshot (runtime files, animation counts) an editor MCP can describe against.",
      inputSchema: {
        type: "object",
        properties: { project_id: projectProperty, force: { type: "boolean", default: false } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "xsxb_validate_project",
      description:
        "Validate standalone XSXB data, generated frames, Godot-synchronized data, assets, and runtime files.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: projectProperty,
          strict: { type: "boolean", default: false },
          require_gameplay: { type: "boolean", default: false },
          layer: {
            type: "string",
            enum: ["all", "standalone", "bind", "gameplay"],
            default: "all",
            description: "Report only one validation layer. Default all, bind errors listed first.",
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "xsxb_validate_for_godot",
      description:
        "Gate Godot handoff: import/sync files, a real gameplay scene using xsxb_frame_actor, and a grounded scale contract (idle feet/height; clips with animation_type vfx/prop or jump/airborne tokens skipped). require_gameplay defaults true. Scale drift is a warning unless strict. qa is clean|review|warn — warn means stop. ok is the gate, not a visual pass — open evidence.path and run_summary.path. Compose with an editor MCP; this tool does not drive Godot.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: projectProperty,
          strict: { type: "boolean", default: false },
          require_gameplay: {
            type: "boolean",
            default: true,
            description: "Require a non-runtime gameplay scene that uses xsxb_frame_actor. Default true.",
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "xsxb_set_active_project",
      description: "Set the registry active XSXB project used when project_id is omitted.",
      inputSchema: {
        type: "object",
        required: ["project_id"],
        properties: { project_id: projectProperty },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "xsxb_bind_godot",
      description:
        "Point one XSXB project at an existing Godot root that contains project.godot. Keeps the existing authoring directory and animation data unchanged. Does not sync files.",
      inputSchema: {
        type: "object",
        required: ["project_root"],
        properties: {
          project_id: projectProperty,
          project_root: { type: "string", description: "Absolute Godot project directory." },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "xsxb_cutout",
      description:
        "Run smart cutout on animation frames or one workspace PNG. Writes require basis_snapshot_id; fit=none preserves layout and keyed frames are skipped. Use border_flood for white/black plates, protected_colors for 月牙 VFX, and inspect receipt.preview.path (magenta flatten; feetY stays visible).",
      inputSchema: {
        type: "object",
        properties: {
          ...animationProperties,
          frames: {
            type: "array",
            items: { type: "integer", minimum: 0 },
            description: "Process only these frame indexes; do not combine with start/end range.",
          },
          start_frame: { type: "integer", minimum: 0 },
          end_frame: { type: "integer", minimum: 0 },
          file_path: {
            type: "string",
            description:
              "Standalone workspace PNG. When set, skips animation frames and writes <workspace>/.xsxb/<name>_cut.png (or output_path) inside the XSXB root. Source bytes stay unchanged unless output_path is the same file.",
          },
          output_path: {
            type: "string",
            description:
              "PNG destination inside the XSXB root for standalone file_path. Defaults to the current project's .xsxb/<name>_cut.png.",
          },
          key_color: {
            type: "string",
            description: "Optional #RRGGBB key. Omit to auto-detect the same background as the tuner.",
          },
          output_width: {
            type: "integer",
            minimum: 8,
            maximum: 4096,
            description: "Optional canvas width. Omit to keep each frame's source size.",
          },
          output_height: {
            type: "integer",
            minimum: 8,
            maximum: 4096,
            description: "Optional canvas height. Defaults to output_width when only width is set.",
          },
          canvas: {
            type: "integer",
            minimum: 8,
            maximum: 4096,
            description: "Alias for a square output_width/output_height.",
          },
          fit: {
            type: "string",
            enum: ["none", "fill_canvas", "match_reference"],
            default: "none",
            description:
              "fill_canvas shares one scale and fills the canvas. none/match_reference keep native size.",
          },
          key_mode: {
            type: "string",
            enum: ["smart", "border_flood"],
            default: "smart",
            description: "border_flood keys near-white/near-black from the border before smart cutout.",
          },
          receipt: {
            type: "string",
            enum: ["short", "full"],
            default: "short",
            description: "short keeps metrics and sheetPath. full includes inspectFeet.grid.",
          },
          protected_colors: {
            type: "array",
            items: { type: "string" },
            description: "Optional #RRGGBB colors to keep, same as the tuner protect-color list.",
          },
          ...workbenchSliderSchemaProperties(),
          ...gridOverlayProperties,
          force: {
            type: "boolean",
            default: false,
            description: "Re-cut frames whose borders are already transparent.",
          },
          apply_visual: {
            type: "boolean",
            default: false,
            description:
              "Rematch using group/frame visual_size instead of one shared scale. Requires or infers a canvas. Character visual_size is not baked.",
          },
          metrics: {
            type: "boolean",
            default: true,
            description:
              "Include per-frame bodyHeight, feetY, and leftover near-white counts on the receipt.",
          },
          sync: { type: "boolean", default: false },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    {
      name: "xsxb_export_gif",
      description:
        "Export one animation as an animated GIF preview via FFmpeg, honoring per-frame durations, group/frame visual_size, authored attack-trail meshes, and frame image attachments. Skips disabled frames. Returns the absolute output path. output_path may be an absolute path outside the XSXB root (/tmp, a game repo). background defaults to magenta so alpha feet do not bounce on opaque black; pass checker, #00FF00, or transparent. After a 像素层 月牙 trail, also xsxb_export_sheet — GIF forward-play can hide a 7字.",
      inputSchema: {
        type: "object",
        properties: {
          ...animationProperties,
          output_path: {
            type: "string",
            description:
              "Absolute .gif destination, including /tmp or a game checkout. Relative paths hang off the current project's .xsxb/ folder.",
          },
          copy_to: {
            type: "string",
            description: "Optional extra copy of the written GIF.",
          },
          background: {
            type: "string",
            description: "magenta (default), checker, #00FF00, black, or transparent.",
          },
          fps: { type: "number", minimum: 1, maximum: 120, description: "Defaults to the animation FPS." },
          start_frame: { type: "integer", minimum: 0, description: "Inclusive 0-based frame index." },
          end_frame: { type: "integer", minimum: 0, description: "Inclusive 0-based frame index." },
          include_disabled: {
            type: "boolean",
            default: false,
            description: "Also render frames whose playback is disabled.",
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "xsxb_export_sheet",
      description:
        "Export a contact sheet PNG without changing source frames. normalize=none|feet preserves scale; normalize=cell stretches into cells. Optional grid settings annotate group cells; use grid=false for clean 月牙/feetY QA.",
      inputSchema: {
        type: "object",
        properties: {
          ...animationProperties,
          output_path: {
            type: "string",
            description:
              "Absolute .png destination. Relative paths hang off the current project's .xsxb/ folder. Defaults to <workspace>/.xsxb/<profile>_<animation>_sheet.png (grid true) or *_sheet_view.png (grid false). Do not write into the MCP repo exports/ dump.",
          },
          start_frame: { type: "integer", minimum: 0, description: "Inclusive 0-based frame index." },
          end_frame: { type: "integer", minimum: 0, description: "Inclusive 0-based frame index." },
          mark_frame: {
            type: "integer",
            minimum: 0,
            description:
              "Absolute 0-based frame to highlight. Defaults to start_frame so the loop start is marked.",
          },
          columns: {
            type: "integer",
            minimum: 1,
            maximum: 32,
            description: "Cells per row. Defaults to min(frameCount, 8).",
          },
          cell: {
            type: "integer",
            minimum: 8,
            maximum: 1024,
            default: 220,
            description: "Shared cell edge in pixels.",
          },
          pad: { type: "integer", minimum: 1, maximum: 64, default: 8 },
          normalize: {
            type: "string",
            enum: ["none", "feet", "height", "cell"],
            default: "none",
            description:
              "none/feet keep 1:1 pixels and a shared foot line. cell stretches each canvas into the cell (planting only). height equalizes subject height — not for lock QA.",
          },
          guides: {
            type: "boolean",
            default: false,
            description: "Paint a red foot line and a green head line across the sheet.",
          },
          copy_to: { type: "string", description: "Optional extra copy of the written PNG." },
          grid: {
            type: "boolean",
            default: true,
            description:
              "Paint the tuner group-coordinate overlay (axes, tick numbers, 0,0). Default true for planting. Pass false when the sheet is for a human to look at the animation.",
          },
          ...gridOverlayProperties,
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "xsxb_export_overlay",
      description:
        "Paint two frames as red / cyan / white intersection for neighbor or idle-vs-run QA. Returns mse and leg width. Walk-loop comparison tool — not a smear mesh.",
      inputSchema: {
        type: "object",
        properties: {
          ...animationProperties,
          frame_a: { type: "integer", minimum: 0, default: 0 },
          frame_b: { type: "integer", minimum: 0, description: "Defaults to frame_a + 1." },
          reference_animation_id: {
            type: "string",
            description: "When set, frame_b is taken from this clip (usually idle) at reference_frame.",
          },
          reference_frame: { type: "integer", minimum: 0, default: 0 },
          output_path: { type: "string", description: "Absolute PNG path. May leave the XSXB root." },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "xsxb_diff_frames",
      description:
        "Write a real PNG comparing two animation frames. mode=diff paints changed pixels magenta; mode=onion keys the studio plate then paints red/cyan/white. qa is review when pixels changed, warn when frames are identical. Open preview.path — import or sync is not a visual pass. Same-size frames only.",
      inputSchema: {
        type: "object",
        properties: {
          ...animationProperties,
          frame_a: { type: "integer", minimum: 0, default: 0 },
          frame_b: { type: "integer", minimum: 0, description: "Defaults to frame_a + 1." },
          mode: {
            type: "string",
            enum: ["diff", "onion"],
            default: "diff",
            description: "diff marks changed pixels magenta. onion composites red/cyan intersection.",
          },
          output_path: { type: "string", description: "Optional PNG path. May leave the XSXB root." },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "xsxb_export_pack_slot",
      description:
        "Copy workspace frame PNGs into a game-pack directory such as frost_armed/run/front. dest may be any absolute folder.",
      inputSchema: {
        type: "object",
        required: ["dest"],
        properties: {
          ...animationProperties,
          dest: { type: "string", description: "Absolute destination directory." },
          slot: {
            type: "string",
            description: "Optional slot id recorded on the receipt (run, idle, attack).",
          },
          view: { type: "string", description: "Optional view id recorded on the receipt (front, back)." },
          start_frame: { type: "integer", minimum: 0 },
          end_frame: { type: "integer", minimum: 0 },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "xsxb_measure_image",
      description:
        'Measure a PNG\'s long axis. The pommel is the end closer to the widest cross-section (guard or forte); the far end is the tip. Pass t for a handle fraction (0=pommel, 0.5=middle, 0.666 or "2/3", 1=tip). Returns image-pixel landmarks. To place the grip on stage, pass the same t plus hand group coordinates to xsxb_add_attachment; do not subtract localFromCenter yourself. Does not bind or write frames.',
      inputSchema: {
        type: "object",
        required: ["file_path"],
        properties: {
          file_path: { type: "string", description: "Absolute PNG path of the weapon or sprite." },
          t: {
            type: "number",
            minimum: 0,
            maximum: 1,
            default: 0.5,
            description: "Grip fraction along pommel→tip. 0.5 is the middle; send 0.666… or the string 2/3.",
          },
          anchor: {
            type: "string",
            enum: ["axis", "alpha_bottom"],
            default: "axis",
            description:
              "axis (default) measures pommel→tip. alpha_bottom returns the opaque-foot point using the same geometry as place_image alpha_support.",
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "xsxb_detect_regions",
      description:
        "Read-only, code-first perception for a PNG or animation. Uses deterministic alpha, connectivity, color, shape, and temporal evidence before optional Florence-2 fallback. Each candidate returns a fresh {region_id,basis_snapshot_id} reference usable by place_image or add_attachment; targetStatus reports geometry and semantic state separately. Never mutates source images or exposes freehand pixel boxes. output_path that resolves to a source PNG is refused (OVERWRITE_SOURCE).",
      inputSchema: {
        type: "object",
        properties: {
          ...animationProperties,
          ...gridOverlayProperties,
          file_path: { type: "string", description: "Standalone PNG inside the XSXB root." },
          frame: { type: "integer", minimum: 0, description: "Animation frame; omit to sample the clip." },
          targets: {
            type: "array",
            items: { type: "string", enum: ["subject", "hand", "weapon", "effect", "text"] },
            description: "Requested hypotheses. Defaults to subject.",
          },
          provider: {
            type: "string",
            enum: ["auto", "code", "florence"],
            default: "auto",
          },
          max_candidates: { type: "integer", minimum: 1, maximum: 32, default: 16 },
          output_path: {
            type: "string",
            description: "Optional perception overlay path inside the XSXB root.",
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "xsxb_overlay_grid",
      description:
        "Paint a speakable A1-style overlay on a PNG. The agent is the eye: look at overlay_path and report only cell ids, never OCR pixel boxes or x,y. Receipt overlay_id stamps this PNG+view — agent-led crop_from and place MUST pass it. cells is {A1:{id}} only (no x1/y1). If next is crop_from, overlay the contact cells before placing. view is always original-image pixels; do not mix with animation grid.cells. Pass crop_from {parent_view, cells, padding_cells, overlay_id} to integer-crop (floor origin, ceil far edge) a finer overlay; crop origin equals the remapped A1 origin; overlay_id is the parent stamp. Invalid ids throw GRID_INVALID_CELL or GRID_CELL_OUT_OF_RANGE. Source PNG is unchanged. output_path must stay inside the XSXB root. No AX, VLM, or [0,1000].",
      inputSchema: {
        type: "object",
        required: ["file_path"],
        properties: {
          file_path: { type: "string", description: "Absolute PNG to overlay. Not modified." },
          project_id: projectProperty,
          rows: {
            type: "integer",
            minimum: 2,
            maximum: 26,
            default: 8,
            description: "Grid rows. Default 8. Wins over grid_divs when set.",
          },
          cols: {
            type: "integer",
            minimum: 2,
            maximum: 26,
            default: 8,
            description: "Grid columns A–Z. Default 8. Wins over grid_divs when set.",
          },
          grid_divs: {
            type: "string",
            description: 'Explicit grid size such as "8x8". Used when rows/cols are omitted.',
          },
          crop_from: {
            type: "object",
            description:
              "Integer-crop a parent overlay. parent_view is a prior receipt.view; cells are speakable ids; padding_cells expands the union in parent-cell units. overlay_id is the parent overlay stamp (file_path + parent_view).",
            properties: {
              parent_view: {
                type: "object",
                description: "Original-image view {x,y,width,height,rows,cols} from a prior overlay_grid.",
              },
              cells: {
                type: "array",
                items: { type: "string" },
                description: 'Speakable ids to union, e.g. ["C3","D4"].',
              },
              padding_cells: {
                type: "number",
                minimum: 0,
                default: 0,
                description: "Padding in parent-cell units on every side.",
              },
              overlay_id: {
                type: "string",
                description:
                  "Parent overlay_id from the overlay that produced parent_view. Mismatch is STALE_OVERLAY.",
              },
            },
            additionalProperties: false,
          },
          output_path: {
            type: "string",
            description:
              "PNG destination inside the XSXB root. Defaults to the current project's .xsxb/<name>_grid.png. Relative paths hang off .xsxb/. Do not write into the MCP repo exports/ dump.",
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "xsxb_plan_place",
      description:
        "Walk/run loops: do not use this (still-frame only). Compile a still-image place brief (图度) before xsxb_place_image: read contact patches on both PNGs, list physics rules and accept criteria, then a 3–5 step plan. Call this after the user confirms a composite and after overlay_grid on both images; execute receipt.brief. Prefer snap alpha_centroid on contact cells — never freehand x,y. Does not composite or redraw. await_confirm true pauses until the user OKs the brief. place_image stays callable without a plan id, but agent-led composites must plan first.",
      inputSchema: {
        type: "object",
        required: ["target_path", "object_path", "intent", "read", "physics", "accept", "plan"],
        properties: {
          target_path: { type: "string", description: "Target PNG inside the XSXB root." },
          object_path: { type: "string", description: "Object PNG inside the XSXB root." },
          intent: {
            type: "string",
            description: "One-line task (user wording or rewrite).",
          },
          read: {
            type: "object",
            additionalProperties: false,
            description: "What you see on each image before placing.",
            properties: {
              target_contact: { type: "string", description: "Contact patch on the target." },
              object_contact: { type: "string", description: "Contact patch on the object." },
              target_cells: {
                type: "array",
                items: { type: "string" },
                description: "Optional speakable cells on the target.",
              },
              object_cells: {
                type: "array",
                items: { type: "string" },
                description:
                  "Optional speakable cells on the object (read notes). When place uses object_anchor.measure_t, these do not need to match object_anchor.cells.",
              },
              notes: { type: "string", description: "Optional orientation / occlusion notes." },
            },
          },
          physics: {
            type: "array",
            items: { type: "string" },
            description: "Physical / picture rules the composite must obey.",
          },
          accept: {
            type: "array",
            items: { type: "string" },
            description: "verify_overlay pass criteria.",
          },
          plan: {
            type: "array",
            description: "Exactly 3–5 executable step strings.",
            items: { type: "string" },
          },
          await_confirm: {
            type: "boolean",
            description: "When true, receipt.next is await_user — do not place until the user confirms.",
          },
          proposed: {
            type: "object",
            additionalProperties: false,
            description: "Optional place intent prose only — no freehand x,y.",
            properties: {
              layer: { type: "string" },
              snap: { type: "string", description: "Prefer alpha_centroid." },
              rotation: { type: "string" },
              scale: { type: "string" },
              notes: { type: "string" },
            },
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "xsxb_place_image",
      description:
        "Composite one PNG onto another using cell or alpha anchors; require overlay_id and prefer xsxb_plan_place. Choose scale from the body span, align held objects to the forearm, and rotate generated source-upright art; place_image does not redraw a hand and clipped heads need padding. output_path stays inside XSXB root.",
      inputSchema: {
        type: "object",
        required: ["target_path", "object_path", "target_anchor", "object_anchor"],
        properties: {
          target_path: { type: "string", description: "Absolute target PNG. Not modified." },
          object_path: { type: "string", description: "Absolute PNG to composite." },
          target_anchor: {
            type: "object",
            additionalProperties: false,
            description:
              "{view, cells, derive} or {x_from, y_from} with the same fields on each arm. derive: center|bottom_center|top_center|left_center|right_center|median_center. Named cells without snap or derive default to snap alpha_centroid. snap: alpha_center|alpha_centroid|alpha_bottom_center|alpha_support on the cell union's opaque pixels. overlay_id from xsxb_overlay_grid is required for agent-led calls. nudge: {dx,dy} pixel tweak after snap/derive. Never freehand x,y.",
            properties: {
              region_id: {
                type: "string",
                description:
                  "Opaque detect_regions candidate id; pair with basis_snapshot_id, exclusive with other anchor fields.",
              },
              basis_snapshot_id: {
                type: "string",
                description: "Observation snapshot returned with region_id.",
              },
              view: { type: "object", description: "Overlay view that produced the cell ids." },
              cells: { type: "array", items: { type: "string" }, description: "Speakable cell ids." },
              derive: {
                type: "string",
                description: "center|bottom_center|top_center|left_center|right_center|median_center.",
              },
              snap: {
                type: "string",
                description:
                  "alpha_center|alpha_centroid|alpha_bottom_center|alpha_support. Snaps onto opaque pixels inside the named cells. Default alpha_centroid when cells are set without derive.",
              },
              overlay_id: {
                type: "string",
                description: "overlay_id from xsxb_overlay_grid for this view. Mismatch is STALE_OVERLAY.",
              },
              nudge: {
                type: "object",
                additionalProperties: false,
                description: "Pixel {dx,dy} applied after snap or derive. Grounded cells required first.",
                properties: {
                  dx: { type: "number", description: "Horizontal pixel delta. Positive is right." },
                  dy: { type: "number", description: "Vertical pixel delta. Positive is down." },
                },
              },
              x_from: {
                type: "object",
                description: "{view, cells, derive} used for the X coordinate.",
              },
              y_from: {
                type: "object",
                description: "{view, cells, derive} used for the Y coordinate.",
              },
            },
          },
          object_anchor: {
            type: "object",
            additionalProperties: false,
            description:
              "mode alpha_center|alpha_centroid|alpha_bottom_center|alpha_support, cells+derive, cells+snap on the grip region (cells without snap/derive default to alpha_centroid), or measure_t along pommel→tip. overlay_id from the object overlay for agent-led calls. alpha_support uses the opaque bbox bottom band; footY is maxY+1.",
            properties: {
              region_id: {
                type: "string",
                description:
                  "Fresh detect_regions candidate on object_path; exclusive with other anchor fields.",
              },
              basis_snapshot_id: {
                type: "string",
                description: "Observation snapshot returned with region_id.",
              },
              mode: {
                type: "string",
                description: "alpha_center|alpha_centroid|alpha_bottom_center|alpha_support.",
              },
              view: { type: "object", description: "Overlay view that produced the cell ids." },
              cells: { type: "array", items: { type: "string" }, description: "Speakable cell ids." },
              derive: { type: "string", description: "Cell derive when anchoring by cells." },
              snap: {
                type: "string",
                description:
                  "alpha_center|alpha_centroid|alpha_bottom_center|alpha_support inside object cells (grip mass, not cell midpoints). Named cells without snap or derive default to alpha_centroid.",
              },
              overlay_id: {
                type: "string",
                description:
                  "overlay_id from xsxb_overlay_grid for this object view. Mismatch is STALE_OVERLAY.",
              },
              measure_t: {
                type: "number",
                minimum: 0,
                maximum: 1,
                description:
                  "Grip fraction on the object long axis (same t as xsxb_measure_image). Cannot combine with mode/cells/snap.",
              },
            },
          },
          scale: {
            description:
              'Omit or {mode:"none"} for 1. relative: target view+cells, or a fresh target_anchor/target region, span width|height, ratio. physical: span, target_m, object_m, object_span bbox_width|bbox_height. Uniform scale from that span.',
            properties: {
              mode: { type: "string", enum: ["none", "relative", "physical"] },
              target: {
                type: "object",
                description:
                  "{view,cells,overlay_id} naming the span, or {region_id,basis_snapshot_id} from detect_regions on target_path. Omit only when target_anchor itself is that region.",
                additionalProperties: false,
                properties: {
                  view: { type: "object" },
                  cells: { type: "array", items: { type: "string" } },
                  region_id: { type: "string" },
                  basis_snapshot_id: { type: "string" },
                  overlay_id: {
                    type: "string",
                    description:
                      "Exact overlay stamp for this scale view. May be omitted only when view exactly matches target_anchor.view and target_anchor carries the stamp.",
                  },
                },
              },
              span: { type: "string", enum: ["width", "height"] },
              ratio: { type: "number", exclusiveMinimum: 0 },
              target_m: { type: "number", exclusiveMinimum: 0 },
              object_m: { type: "number", exclusiveMinimum: 0 },
              object_span: { type: "string", enum: ["bbox_width", "bbox_height"] },
            },
            additionalProperties: false,
          },
          rotation: {
            type: "number",
            default: 0,
            description: "Clockwise degrees around the object anchor. Screen y-down. 0 is upright.",
          },
          layer: {
            type: "string",
            enum: ["front", "behind", "under_target"],
            default: "front",
            description:
              "front paints the object on top. behind restores every opaque target pixel. under_target restores opaque target pixels only inside the target_anchor cell union.",
          },
          occlusion: {
            type: "object",
            additionalProperties: false,
            description:
              "Restore only local foreground over the object. Use {region_id,basis_snapshot_id} from target detection or {mask_path} for a target-sized alpha PNG; mutually exclusive. Mask alpha is absolute foreground opacity. With under_target and a region target anchor, that region mask is automatic.",
            properties: {
              region_id: { type: "string" },
              basis_snapshot_id: { type: "string" },
              mask_path: { type: "string" },
            },
          },
          output_path: {
            type: "string",
            description:
              "PNG destination inside the XSXB root. Defaults to the current project's .xsxb/<name>_placed.png. Relative paths hang off .xsxb/.",
          },
          verify_overlay: {
            type: "boolean",
            default: true,
            description: "Write a speakable overlay of the composite. Defaults on. Pass false to skip.",
          },
          verify_overlay_path: {
            type: "string",
            description: "Optional overlay destination inside the XSXB root.",
          },
          plan_id: {
            type: "string",
            description:
              "Optional plan_id from xsxb_plan_place. When set, target cells/layer/snap must match the stored brief or place throws PLAN_MISMATCH. object_cells are read notes: object_anchor.measure_t is an allowed pairing and does not have to match those cells. Place still works without it.",
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
  ];
  return [...tools, ...authoringDefinitions()].map((tool) => ({
    ...tool,
    outputSchema: receiptEnvelopeSchema(),
  }));
}

module.exports = { DEFAULT_PROFILE_ID, MCP_TOOL_NAMES, toolDefinitions };
