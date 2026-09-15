#!/usr/bin/env node
"use strict";

const readline = require("node:readline");
const { createXsxbMcpService } = require("./xsxb_mcp_service");
const { errorReceipt, receiptSummary, successReceipt } = require("./xsxb_mcp_receipt");

const SERVER_INFO = Object.freeze({ name: "x-frame", version: "0.2.0" });
const INSTRUCTIONS = [
  "XSXB MCP receipt v2: results live under data; execution and verification are separate; ok is not a visual pass.",
  "State the user goal in one sentence, then xsxb_list_projects or xsxb_get_project, and pick skills/x-frame-import, x-frame-cutout, x-frame-gameplay, or x-frame-godot. Multi-step work uses an ordered todo; after each mutation open preview.path, overlay, gif, or a grid=false sheet — confirmed/keyed is not done. If the eye fails, stop and do not continue the playbook.",
  "Walk-lock: xsxb_measure_frames → xsxb_register_clip (apply bakes about the feet) → xsxb_export_sheet normalize=feet|none, xsxb_export_overlay or xsxb_diff_frames; plant with xsxb_plant_feet at y=-1, not 0,0. Do not use xsxb_place_image or xsxb_add_attack_trail.",
  "Video-to-loop: import, then xsxb_get_animation for basis_snapshot_id, xsxb_cutout (border_flood for white or black plates; inspect preview.path), xsxb_analyze, then xsxb_reorganize_frames with that order. Prefer xsxb_analyze after import. Do not export_sheet every candidate.",
  "Still-place: xsxb_overlay_grid → xsxb_plan_place → xsxb_place_image with overlay_id. Held object: detect_regions hand as target_anchor, layer=under_target. Do not mix still views with animation grid.cells. Do not OCR overlay digits.",
  "Smear: xsxb_plan_smear then a pixel crescent (polyline) or matching trail mesh.",
  "Observation writes need basis_snapshot_id; still cells need overlay_id. Register/plant/estimate/reorganize/compress preview until apply or dry_run:false. Sync is opt-in. Godot handoff: xsxb_validate_for_godot (require_gameplay default). qa=warn means stop.",
  "Report actual results. Missing capability: tell the user and raise to X-Frame with tool, arguments, expected and actual.",
].join(" ");

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
        isError: result.ok === false,
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
    if (!line.trim()) return;

    // Parse before entering the serialized business queue so pings can be
    // answered immediately while a long-running write is active.
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      output.write(`${JSON.stringify(failure(null, -32700, `Parse error: ${error.message}`))}\n`);
      return;
    }

    if (message?.method === "ping" && Object.prototype.hasOwnProperty.call(message, "id")) {
      output.write(`${JSON.stringify(success(message.id, {}))}\n`);
      return;
    }

    queue = queue
      .then(async () => {
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
