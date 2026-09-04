#!/usr/bin/env node
"use strict";

const readline = require("node:readline");
const { createXsxbMcpService } = require("./xsxb_mcp_service");
const { errorReceipt, receiptSummary, successReceipt } = require("./xsxb_mcp_receipt");

const SERVER_INFO = Object.freeze({ name: "xsxb-frame-tuner", version: "0.2.0" });
const RECEIPT_INSTRUCTIONS =
  "MCP receipt v2 stores business data under data and separates execution from verification; ok only means the tool call completed. Observation-derived frame order and A1 cell writes require basis_snapshot_id; still-image anchors require overlay_id. Perception is code-first: xsxb_detect_regions uses deterministic alpha/connectivity/color/shape/temporal evidence before optional Florence-2 fallback, never mutates source pixels, and never drives a mutation directly. ";
const INSTRUCTIONS =
  RECEIPT_INSTRUCTIONS +
  "Session process: state the user goal in one sentence, then xsxb_list_projects or xsxb_get_project, and pick the playbook (walk lock, video-to-loop, still place, smear) before the first mutation. Multi-step work uses an ordered todo; after each mutating tool, open the image (preview.path, overlay, gif, or grid=false sheet) — receipt confirmed/keyed is not done. If the eye fails, stop and fix that step; do not continue the playbook. Use xsxb_list_projects or xsxb_get_project before mutations. Create a missing project with xsxb_create_project (optional project_id / label / project_root; existing id is idempotent). Bind Godot with xsxb_bind_godot before xsxb_sync_godot. Import with xsxb_import_animation (start_frame/end_frame/replace supported); xsxb_import_video remains a video alias (optional start_time / duration after -i; omit for the full file). Packed sprite/contact sheets: xsxb_slice_sheet (切表 / sheet→PNG sequence). Walk-loop lock-ruler still prefers measure/register — slice is for packed sheets. Walk/run lock-ruler: xsxb_measure_frames (bbox/feet/cx vs idle) → xsxb_register_clip (equalize or shared_scale; apply bakes pixels about the feet) → xsxb_export_sheet normalize=feet|none (do not cell-fit for height QA) and xsxb_export_overlay (A red / B cyan / intersection white) → xsxb_export_gif (background magenta or checker; output_path may leave the XSXB root; copy_to for a game checkout) or xsxb_export_pack_slot. Walk loops do not use xsxb_add_attack_trail, xsxb_plan_smear, or xsxb_place_image — those stay still-frame / smear tools. Video-to-loop playbook: import the clip; xsxb_cutout (fit=none by default; pass basis_snapshot_id from get_animation or analyze; receipt=short; key_mode=border_flood for generated white or black plates; look at preview.path (magenta flatten), not the planted grid sheet; same workbench sliders; omit for the shared profile) so loop search is not poisoned by a keyed background; xsxb_analyze (one decode: duplicates, loop, motion, and a grid=false preview sheet of the recommended window). Look at preview.path — do not export_sheet every candidate. oneShotLikely means a short burst inside a longer clip; a solid interior cycle in a long take is not a one-shot. Apply with xsxb_reorganize_frames using loop.recommended.order or motion.order (loop_endpoint=duplicate_first copies frame 0 as the tail). After xsxb_analyze or xsxb_find_duplicates, do not apply duplicates.order when autoAdjustedThreshold is set unless you passed auto_adjust. xsxb_estimate_visual is a scale estimator (equalize vs shared; metric bbox|body; reference_frame 0), not the lock; bake leftover visual_size with xsxb_cutout apply_visual. Cut frames with xsxb_cutout (optional protected_colors; already-cut frames are skipped unless force plus an explicit key_color; force alone rematches without re-keying; receipts include keyed plus bodyHeight/nearWhite metrics unless metrics=false). Remove mistaken bindings with xsxb_remove_binding (dry_run first). Read back current boxes, timing, and bindings with xsxb_get_animation include=[boxes,timing,sfx,attachments,trails]. Find ranked loop segments with xsxb_find_loop (imported animation, PNG directory, or file_paths; oneShotLikely means a short burst — inspect preview.path or use xsxb_find_motion); trim one-shot holds with xsxb_find_motion; apply either order with xsxb_reorganize_frames. Prefer xsxb_analyze after import instead of calling the three finders and export_sheet for every candidate. Auto-fill boxes with xsxb_estimate_boxes (dry_run to preview, replace to recompute); batch-edit many frames via the frames array on xsxb_update_frame_boxes, xsxb_update_timing, and xsxb_add_attachment. Scale or offset visuals with xsxb_set_visual_transform (character|group|frame level, or frames[] plus clear_group). Swap one frame image with xsxb_replace_frame (keeps boxes and bindings). Translate planted pixels with xsxb_shift_frames (positive dy plants down toward the foot origin; does not scale — lock height with xsxb_register_clip). Walk-loop plant after xsxb_measure_frames with xsxb_plant_feet (translate only; still confirm on the overlay; plant soles to y=-1, not 0,0). Lossless-reencode workspace PNGs with xsxb_compress_frames (pixels stay identical; dry_run previews savings). Render a shareable preview with xsxb_export_gif (honors per-frame timing and group/frame visual_size; requires ffmpeg) or a labeled contact sheet with xsxb_export_sheet (overlay grid for the eye; source animation PNGs stay unchanged). Pass grid_density (sparse|normal|dense), grid_divs like 8x8, or grid_x/grid_y, and grid_scope canvas|subject — fill these from the task and image size; omit to keep the auto step. Density densifies grid lines. Overlay paints row/col indices matching export_sheet grid.cells; group x,y are in that JSON and grid.legend — do not OCR overlay digits. Use export_sheet grid.cells[row][col] (row 0 = top, col 0 = left; x,y is that square's top-left) for write-back. Write tools accept the same group coordinates or overlay cell ids (E5 / e5 / {cell:E5}, from the frame PNG size plus grid_divs/grid_density/grid_scope; do not OCR overlay digits): xsxb_shift_frames from/to or dx/dy, xsxb_plant_feet to, box min/max, attachment hand plus t, trail sticks, visual offset. Do not convert those numbers to canvas pixels yourself. After rematch, xsxb_cutout receipt=full returns inspectFeet with that overlay; plant with xsxb_plant_feet or xsxb_shift_frames after reading cells[row][col], never by guessing boot colors. xsxb_shift_frames is a catalog tool (MCP_TOOL_NAMES / tools/list already include it). If a client reports it not found, the session catalog is stale — reload the xsxb MCP server; do not skip planting or convert overlay numbers to canvas pixels. grid_divs / grid_density already work on xsxb_export_sheet / xsxb_cutout. Yellow 0,0 is outside the bitmap: canvasAnchor uses y=height, so the last pixel row is group y=-1; do not plant soles to 0,0 or they clip 1px — plant the sole to y=-1. metrics.feetY is the boot sole and ignores connected bright slash/glow below it; confirm on the overlay before planting. Measure a weapon PNG's pommel/tip/handle fraction with xsxb_measure_image (pommel is the end nearer the widest station; t=0.5 middle, t=2/3 toward the tip); to place it, pass the same t plus hand group coordinates to xsxb_add_attachment. Speakable still overlays: xsxb_overlay_grid paints A1-style cell ids on a PNG (the agent is the eye; only report those cell ids; do not OCR pixel boxes or x,y). Receipt overlay_id stamps that PNG+view — agent-led crop_from and xsxb_place_image MUST pass it; a mismatch is STALE_OVERLAY. If overlay.next is crop_from, overlay the contact cells before placing. Do not mix still view / overlay_id with animation export_sheet grid.cells. No AX, VLM, or [0,1000] coordinates. Pass crop_from with parent_view plus cells (padding_cells optional, overlay_id is the parent stamp) to integer-crop a finer overlay; view stays in original-image pixels. After the user confirms a still composite, call xsxb_plan_place with 图度 fields (read contact on both images, physics rules, accept criteria, 3–5 step plan) and execute receipt.brief before placing; await_confirm pauses for the user; pass optional plan_id from that brief on xsxb_place_image. Composite a sprite with xsxb_place_image using target_anchor/object_anchor (named cells default snap alpha_centroid when derive is omitted, optional nudge {dx,dy} after snap, or alpha_support). Receipt.resolved lists MCP pixel coordinates (debug only); inspect verify.status and verify_overlay_path. Never freehand x,y. scale relative|physical from the selected span — never image-width-per-meter — layer front|under_target|behind (under_target puts the object under opaque pixels inside the target cell union), and rotation as clockwise degrees around the object anchor (screen y-down). Held objects follow pose physics, not source-upright: rotation 0 is the PNG as generated (often the heavy head down). Rotate around the grip so the mass/striking end faces the figure's facing or attack side and the shaft follows the forearm/wrist, not world-vertical. Scale physical or relative from the body span — two full canvases are not 1:1 meters. object_anchor is the handle grip (measure t or handle cells), not the head; target_anchor is the palm or fist with layer under_target. xsxb_place_image does not redraw a hand — a closed fist reads held, an open palm stays open. After placing, look at the overlay: handle through the palm cells, head on the strike side; if the head clips the canvas, pad that edge or grip closer to the head. xsxb_cutout file_path cuts a standalone workspace PNG with the same smart-cutout as animation frames (receipt=full adds inspectFeet on that PNG too). Example: stand a figure on a marked region by naming its cells and a physical width. xsxb_measure_image anchor=alpha_bottom returns that opaque-foot point. After xsxb_find_duplicates, do not apply order when autoAdjustedThreshold is set unless you passed auto_adjust. xsxb_open_tuner starts the local Tuner when it is down. Set the default project with xsxb_set_active_project. Edit boxes and timing without syncing, then sync explicitly. Validate with layer=standalone|bind|gameplay. Delete mistaken imports with dry_run first. Report all tool results without inventing success. If MCP errors, a needed capability is missing, or you must leave MCP to finish the request, do not hide it: tell the user and raise it to the XSXB-Frame-Tuner project with tool name, arguments, receipt or error, expected result, and actual result.";

/**
 * Creates one successful JSON-RPC response.
 * @param {string|number|null} id Request id.
 * @param {unknown} result Response result.
 * @returns {object} JSON-RPC response.
 */
function success(id, result) {
  return { jsonrpc: "2.0", id, result };
}

/**
 * Creates one JSON-RPC error response.
 * @param {string|number|null} id Request id.
 * @param {number} code JSON-RPC error code.
 * @param {string} message Error message.
 * @returns {object} JSON-RPC response.
 */
function failure(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Handles one MCP JSON-RPC request.
 * @param {object} message Parsed request.
 * @param {{tools:object[],call:Function}} service XSXB service.
 * @returns {Promise<object|null>} Response, or null for notifications.
 */
async function handleMessage(message, service) {
  const id = Object.prototype.hasOwnProperty.call(message || {}, "id") ? message.id : null;
  const method = String(message?.method || "");
  if (!method) return failure(id, -32600, "Invalid JSON-RPC request.");
  if (id === null) return null;
  if (method === "initialize") {
    return success(id, {
      protocolVersion: String(message.params?.protocolVersion || "2025-06-18"),
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
    });
  }
  if (method === "ping") return success(id, {});
  if (method === "tools/list") return success(id, { tools: service.tools });
  if (method === "tools/call") {
    const name = String(message.params?.name || "");
    try {
      const result = service.callMcp
        ? await service.callMcp(name, message.params?.arguments || {})
        : successReceipt(name, await service.call(name, message.params?.arguments || {}), {
            readOnly: service.tools?.find((tool) => tool.name === name)?.annotations?.readOnlyHint === true,
          });
      return success(id, {
        content: [{ type: "text", text: receiptSummary(result) }],
        structuredContent: result,
        isError: false,
      });
    } catch (error) {
      const result = errorReceipt(name, error);
      return success(id, {
        content: [{ type: "text", text: receiptSummary(result) }],
        structuredContent: result,
        isError: true,
      });
    }
  }
  return failure(id, -32601, `Method not found: ${method}`);
}

/**
 * Starts the newline-delimited STDIO MCP transport.
 * @param {{input?:NodeJS.ReadableStream,output?:NodeJS.WritableStream,service?:object}} [options] Transport dependencies.
 * @returns {readline.Interface} Active line reader.
 */
function startServer(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const service = options.service || createXsxbMcpService();
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let queue = Promise.resolve();
  lines.on("line", (line) => {
    queue = queue
      .then(async () => {
        if (!line.trim()) return;
        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          output.write(`${JSON.stringify(failure(null, -32700, `Parse error: ${error.message}`))}\n`);
          return;
        }
        const response = await handleMessage(message, service);
        if (response) output.write(`${JSON.stringify(response)}\n`);
      })
      .catch((error) => {
        output.write(`${JSON.stringify(failure(null, -32603, error.message || "Internal MCP error."))}\n`);
      });
  });
  lines.once("close", () => {
    queue = queue.then(() => service.close?.()).catch(() => undefined);
  });
  return lines;
}

if (require.main === module) startServer();

module.exports = { INSTRUCTIONS, handleMessage, startServer };
