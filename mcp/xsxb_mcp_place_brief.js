"use strict";

/**
 * Compiles a still-image place brief (图度) from the agent's self-review:
 * read → physics/accept → short plan. The generic place skeleton is not enough
 * alone — execute receipt.brief. Does not composite pixels or call a VLM.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  booleanFlag,
  isInsideDirectory,
  mcpArtifactDir,
  requireExistingFile,
} = require("./xsxb_mcp_arguments");
const { parseCellId } = require("./xsxb_mcp_place");

const INTENT_MIN = 8;
const PLAN_MIN = 3;
const PLAN_MAX = 5;
const PROPOSED_KEYS = new Set(["layer", "snap", "rotation", "scale", "notes"]);

/**
 * Resolves a PNG that must exist inside the XSXB root.
 * @param {unknown} filePath Raw path.
 * @param {string} label Error label.
 * @param {string} root Workspace root.
 * @returns {string} Absolute path.
 */
function requireWorkspacePng(filePath, label, root) {
  const raw = String(filePath || "").trim();
  if (!raw) throw new Error(`${label} is required.`);
  const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  if (!isInsideDirectory(absolute, root)) {
    throw new Error(`${label} must stay inside the XSXB workspace root (${root}). Received: ${filePath}`);
  }
  const existing = requireExistingFile(absolute, label);
  if (!/\.png$/i.test(existing)) throw new Error(`${label} must be a PNG file.`);
  return existing;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function requireText(value, label, min = 1) {
  const text = String(value || "").trim();
  if (text.length < min) throw new Error(`${label} must describe the task (at least ${min} characters).`);
  return text;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string[]}
 */
function requireStringList(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty string array.`);
  }
  return value.map((entry, index) => {
    const text = String(entry || "").trim();
    if (!text) throw new Error(`${label}[${index}] must be a non-empty string.`);
    return text;
  });
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function requirePlan(value) {
  if (!Array.isArray(value)) throw new Error("plan must be an array of 3–5 steps.");
  if (value.length < PLAN_MIN || value.length > PLAN_MAX) {
    throw new Error(`plan must list ${PLAN_MIN}–${PLAN_MAX} steps. Received ${value.length}.`);
  }
  return value.map((entry, index) => {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const step = String(entry.step || entry.detail || "").trim();
      if (!step) throw new Error(`plan[${index}] must include step or detail text.`);
      const detail = String(entry.detail || "").trim();
      return detail && detail !== step ? `${step}: ${detail}` : step;
    }
    const text = String(entry || "").trim();
    if (!text) throw new Error(`plan[${index}] must be a non-empty string.`);
    return text;
  });
}

/**
 * @param {unknown} cells
 * @param {string} label
 * @returns {string[]|undefined}
 */
function optionalCells(cells, label) {
  if (cells === undefined || cells === null || cells === "") return undefined;
  if (!Array.isArray(cells)) throw new Error(`${label} must be an array of speakable cell ids.`);
  return cells.map((cell, index) => {
    try {
      return parseCellId(cell).id;
    } catch (error) {
      throw new Error(`${label}[${index}] must be a speakable cell id such as E5. ${error.message}`);
    }
  });
}

/**
 * @param {unknown} raw
 * @returns {{target_contact:string,object_contact:string,target_cells?:string[],object_cells?:string[],notes?:string}}
 */
function requireRead(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("read must be an object with target_contact and object_contact.");
  }
  const target_contact = requireText(raw.target_contact, "read.target_contact", 3);
  const object_contact = requireText(raw.object_contact, "read.object_contact", 3);
  const target_cells = optionalCells(raw.target_cells, "read.target_cells");
  const object_cells = optionalCells(raw.object_cells, "read.object_cells");
  const notes = raw.notes == null || raw.notes === "" ? undefined : requireText(raw.notes, "read.notes", 1);
  const out = { target_contact, object_contact };
  if (target_cells) out.target_cells = target_cells;
  if (object_cells) out.object_cells = object_cells;
  if (notes) out.notes = notes;
  return out;
}

/**
 * @param {unknown} raw
 * @returns {object|null}
 */
function optionalProposed(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("proposed must be an object of place intent prose, not freehand coordinates.");
  }
  if (Object.prototype.hasOwnProperty.call(raw, "x") || Object.prototype.hasOwnProperty.call(raw, "y")) {
    throw new Error("proposed must not include freehand x,y — use speakable cells and snap instead.");
  }
  for (const key of Object.keys(raw)) {
    if (!PROPOSED_KEYS.has(key)) {
      throw new Error(`proposed.${key} is not allowed. Use layer|snap|rotation|scale|notes only.`);
    }
  }
  const proposed = {};
  for (const key of PROPOSED_KEYS) {
    if (raw[key] === undefined || raw[key] === null || raw[key] === "") continue;
    proposed[key] = String(raw[key]).trim();
  }
  return Object.keys(proposed).length ? proposed : null;
}

/**
 * Canonical plan identity. Missing optional fields are null so the same
 * inputs always hash to the same plan_id.
 * @param {string} targetPath Absolute target PNG.
 * @param {string} objectPath Absolute object PNG.
 * @param {{target_cells?:string[],object_cells?:string[]}} read Contact cells.
 * @param {{layer?:string,snap?:string}|null} proposed Place intent.
 * @returns {{target_path:string,object_path:string,read:{target_cells:string[]|null,object_cells:string[]|null},proposed:{layer:string|null,snap:string|null}}}
 */
function canonicalPlacePlan(targetPath, objectPath, read, proposed) {
  return {
    target_path: targetPath,
    object_path: objectPath,
    read: {
      target_cells: read.target_cells || null,
      object_cells: read.object_cells || null,
    },
    proposed: {
      layer: proposed?.layer || null,
      snap: proposed?.snap || null,
    },
  };
}

/**
 * @param {object} canonical Canonical plan object.
 * @returns {string} `pln_` plus 12 hex chars.
 */
function placePlanId(canonical) {
  const digest = crypto.createHash("sha1").update(JSON.stringify(canonical)).digest("hex").slice(0, 12);
  return `pln_${digest}`;
}

/**
 * Writes `{artifactDir}/place-plans/{plan_id}.json` for xsxb_place_image.
 * File snap defaults to alpha_centroid; the hash still treats omitted snap as null.
 * @param {string} artifactDir MCP artifact directory.
 * @param {string} planId Plan id.
 * @param {ReturnType<typeof canonicalPlacePlan>} canonical Canonical fields.
 * @returns {string} Absolute JSON path.
 */
function persistPlacePlan(artifactDir, planId, canonical) {
  const dir = path.join(artifactDir, "place-plans");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${planId}.json`);
  const record = {
    plan_id: planId,
    target_path: canonical.target_path,
    object_path: canonical.object_path,
    read: {
      target_cells: canonical.read.target_cells,
      object_cells: canonical.read.object_cells,
    },
    proposed: {
      layer: canonical.proposed.layer,
      snap: canonical.proposed.snap || "alpha_centroid",
    },
  };
  fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`);
  return filePath;
}

/**
 * Compiles the place brief the agent should execute next.
 * @param {object} [args] 图度 fields.
 * @param {{root?:string,artifactDir?:string}} [options] Service root and artifact dir.
 * @returns {object} Brief receipt.
 */
function compilePlaceBrief(args = {}, options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const artifactDir = path.resolve(options.artifactDir || mcpArtifactDir("", root));
  const targetPath = requireWorkspacePng(args.target_path, "target_path", root);
  const objectPath = requireWorkspacePng(args.object_path, "object_path", root);
  const intent = requireText(args.intent, "intent", INTENT_MIN);
  const read = requireRead(args.read);
  const physics = requireStringList(args.physics, "physics");
  const accept = requireStringList(args.accept, "accept");
  const plan = requirePlan(args.plan);
  const awaitConfirm = booleanFlag(args.await_confirm, false);
  const proposed = optionalProposed(args.proposed);
  const warnings = [];
  if (physics.length < 2) {
    warnings.push("physics has fewer than 2 rules — double-check contact, scale, layer, and redraw limits.");
  }

  const canonical = canonicalPlacePlan(targetPath, objectPath, read, proposed);
  const planId = placePlanId(canonical);
  persistPlacePlan(artifactDir, planId, canonical);

  const lines = [
    "Still-image place brief (图度). Execute this brief. The generic place skeleton alone is not enough.",
    `Intent: ${intent}.`,
    `Target: ${path.basename(targetPath)}. Object: ${path.basename(objectPath)}.`,
    `Read — target contact: ${read.target_contact}. Object contact: ${read.object_contact}.`,
  ];
  if (read.target_cells?.length) lines.push(`Target contact cells: ${read.target_cells.join(", ")}.`);
  if (read.object_cells?.length) {
    lines.push(`Object contact cells: ${read.object_cells.join(", ")}.`);
    lines.push(
      "Those object_cells are read notes. Place may use object_anchor.measure_t for the grip instead of matching those cells.",
    );
  }
  if (read.notes) lines.push(`Read notes: ${read.notes}.`);
  lines.push("Physics:");
  for (const rule of physics) lines.push(`- ${rule}`);
  lines.push("Accept when:");
  for (const rule of accept) lines.push(`- ${rule}`);
  lines.push("Plan:");
  plan.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  lines.push(
    "Place with speakable cell ids and snap alpha_centroid on both contact patches — never freehand x,y. Prefer crop_from when a patch is small inside a coarse cell.",
  );
  lines.push(
    `Execute with xsxb_place_image passing this plan_id ${planId} AND overlay_id from xsxb_overlay_grid.`,
  );
  lines.push(
    "The tool composites only — it does not redraw either sprite. Inspect verify_overlay_path against accept; nudge only if needed.",
  );
  if (proposed) {
    lines.push(
      `Proposed intent: layer=${proposed.layer || "(unset)"} snap=${proposed.snap || "alpha_centroid"} rotation=${proposed.rotation || "(from pose)"} scale=${proposed.scale || "(named span)"}.`,
    );
  }
  if (awaitConfirm) {
    lines.push(
      "await_confirm is set — show this brief to the user and do not call xsxb_place_image until they confirm.",
    );
  } else {
    lines.push("Proceed to xsxb_place_image unless the user asked to review the plan first.");
  }

  return {
    brief: lines.join("\n"),
    intent,
    target_path: targetPath,
    object_path: objectPath,
    read,
    physics,
    accept,
    plan,
    await_confirm: awaitConfirm,
    proposed,
    plan_id: planId,
    warnings,
    next: awaitConfirm ? "await_user" : "place",
  };
}

module.exports = {
  INTENT_MIN,
  PLAN_MAX,
  PLAN_MIN,
  compilePlaceBrief,
};
