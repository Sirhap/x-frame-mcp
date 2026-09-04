"use strict";

/**
 * Normalization and validation of the arguments MCP tools receive, plus the
 * small filesystem lookups the import paths depend on.
 *
 * These helpers hold no service state: they turn whatever an agent sent into a
 * value the handlers can trust, or throw an error the agent can act on.
 */

const fs = require("node:fs");
const path = require("node:path");

/**
 * Largest agent-supplied file accepted by the binding tools. They take single
 * frames, trail textures and sound effects, none of which come close, so the
 * limit only catches a mistyped path pointing at something enormous.
 */
const MAX_AGENT_FILE_BYTES = 64 * 1024 * 1024;
const PNG_NAME = /\.png$/i;

/**
 * Parses MCP JSON flags. Hosts often send the strings "true"/"false".
 * @param {unknown} value Raw argument.
 * @param {boolean} [fallback=false] Default when the value is omitted.
 * @returns {boolean} Resolved flag.
 */
function booleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "yes") return true;
    if (normalized === "false" || normalized === "no") return false;
  }
  return fallback;
}

/**
 * Parses a 0-based frame index or throws.
 * @param {unknown} value Raw frame argument.
 * @param {number} last Inclusive last valid index.
 * @returns {number} Integer frame index.
 */
function requireFrameIndex(value, last) {
  const frame = Number(value);
  if (!Number.isInteger(frame) || frame < 0 || frame > last) {
    throw new Error(`Frame must be an integer between 0 and ${Math.max(0, last)}.`);
  }
  return frame;
}

/**
 * Parses animation FPS in the inclusive 1–120 range.
 * @param {unknown} value Raw FPS.
 * @param {number} [fallback=12] Default FPS.
 * @returns {number} Sanitized FPS.
 */
function requireFps(value, fallback = 12) {
  const fps = Number(value === undefined || value === null || value === "" ? fallback : value);
  if (!Number.isFinite(fps) || fps < 1 || fps > 120) {
    throw new Error("fps must be a finite number between 1 and 120.");
  }
  return fps;
}

/** Pet state clips store milliseconds in `frame.duration` and set fps to this sentinel. */
const PET_MILLISECOND_FPS = 1000;

/**
 * Resolves GIF/sheet playback fps. Pet fps 1000 is a millisecond clock and must
 * not go through requireFps, sanitize to 12, or honor a 1–120 fps override.
 * @param {{fps?:unknown}|null|undefined} animation Animation record.
 * @param {unknown} [override] Optional GIF fps argument.
 * @returns {number} Playback fps used for delays.
 */
function resolveExportFps(animation, override) {
  const fps = Number(animation?.fps);
  if (fps === PET_MILLISECOND_FPS) return PET_MILLISECOND_FPS;
  if (override !== undefined && override !== null && override !== "") {
    return requireFps(override, 12);
  }
  return requireFps(animation?.fps, 12);
}

/**
 * Converts one frame's duration multiplier into seconds.
 * Prefers a playback override, then the animation frame's duration (pet ms clock).
 * @param {{duration?:unknown}|null|undefined} frame Animation frame.
 * @param {{duration?:unknown,disabled?:boolean}|null|undefined} playbackOverride Tuning override.
 * @param {number} fps Playback fps.
 * @returns {number} Seconds.
 */
function exportFrameDurationSeconds(frame, playbackOverride, fps) {
  const rate = Number(fps);
  const safeRate = Number.isFinite(rate) && rate > 0 ? rate : 12;
  const overrideDuration = playbackOverride?.duration;
  const source =
    overrideDuration !== undefined && overrideDuration !== null && overrideDuration !== ""
      ? overrideDuration
      : frame?.duration !== undefined && frame?.duration !== null && frame?.duration !== ""
        ? frame.duration
        : 1;
  return Math.max(0.001, Number(source) || 1) / safeRate;
}

/**
 * Parses a TCP port for the Tuner, including values taken from process.env.
 * @param {unknown} value Raw port.
 * @returns {number} Integer port in 1–65535.
 */
function requireTunerPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Tuner port must be an integer from 1 to 65535. Received: ${value}`);
  }
  return port;
}

/**
 * Parses a tuner-group point. Accepts {x,y}, "x,y", or [x,y].
 * @param {unknown} value Raw point.
 * @param {string} [label="point"] Error label.
 * @returns {{x:number,y:number}|null} Group point, or null when omitted.
 */
function parseGroupPoint(value, label = "point") {
  if (value === undefined || value === null || value === "") return null;
  let x;
  let y;
  if (typeof value === "string") {
    const match = value.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/u);
    if (!match) throw new Error(`${label} must be a group point like "40,-80".`);
    x = Number(match[1]);
    y = Number(match[2]);
  } else if (Array.isArray(value)) {
    if (value.length < 2) throw new Error(`${label} array must be [x, y].`);
    x = Number(value[0]);
    y = Number(value[1]);
  } else if (typeof value === "object") {
    const space = value.space;
    if (space !== undefined && space !== null && space !== "" && space !== "group") {
      throw new Error(`${label} space must be "group". Received "${space}".`);
    }
    const group = value.group && typeof value.group === "object" ? value.group : value;
    x = Number(group.x);
    y = Number(group.y);
  } else {
    throw new Error(`${label} must be {x,y}, "x,y", or [x,y] in group coordinates.`);
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`${label} x and y must be finite group coordinates.`);
  }
  return { x, y };
}

/**
 * Parses a required group point.
 * @param {unknown} value Raw point.
 * @param {string} [label="point"] Error label.
 * @returns {{x:number,y:number}} Group point.
 */
function requireGroupPoint(value, label = "point") {
  const point = parseGroupPoint(value, label);
  if (!point) throw new Error(`${label} is required.`);
  return point;
}

/**
 * Converts min/max corners or x,y,width,height into a center offset and size.
 * @param {object} patch Raw box patch.
 * @returns {{offset:{x:number,y:number},size:{x:number,y:number}}|null} Center box, or null.
 */
function boxFromGroupCorners(patch) {
  if (!patch || typeof patch !== "object") return null;
  if (patch.min !== undefined || patch.max !== undefined) {
    const min = parseGroupPoint(patch.min, "box min") || { x: 0, y: 0 };
    const max = parseGroupPoint(patch.max, "box max") || { x: 0, y: 0 };
    const left = Math.min(min.x, max.x);
    const right = Math.max(min.x, max.x);
    const top = Math.min(min.y, max.y);
    const bottom = Math.max(min.y, max.y);
    return {
      offset: { x: (left + right) / 2, y: (top + bottom) / 2 },
      size: { x: Math.max(1, right - left), y: Math.max(1, bottom - top) },
    };
  }
  const x = patch.x === undefined ? null : Number(patch.x);
  const y = patch.y === undefined ? null : Number(patch.y);
  const width =
    patch.width === undefined ? (patch.w === undefined ? null : Number(patch.w)) : Number(patch.width);
  const height =
    patch.height === undefined ? (patch.h === undefined ? null : Number(patch.h)) : Number(patch.height);
  if (x === null || y === null || width === null || height === null) return null;
  if (![x, y, width, height].every((value) => Number.isFinite(value))) return null;
  return {
    offset: { x: x + width / 2, y: y + height / 2 },
    size: { x: Math.max(1, width), y: Math.max(1, height) },
  };
}

/**
 * Converts a local PNG file into the organizer import item shape.
 * @param {string} filePath Absolute PNG path.
 * @returns {{name:string,data:string,sourcePath:string}} Import item.
 */
function pngFileToItem(filePath) {
  const resolved = path.resolve(filePath);
  return {
    name: path.basename(resolved),
    data: `data:image/png;base64,${fs.readFileSync(resolved).toString("base64")}`,
    sourcePath: resolved,
  };
}

/**
 * Lists PNG files in a directory using numeric filename order.
 * @param {string} directory Absolute directory.
 * @returns {string[]} Absolute PNG paths.
 */
function listPngSequence(directory) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`PNG sequence directory not found: ${directory}`);
  }
  const files = fs
    .readdirSync(directory)
    .filter((name) => PNG_NAME.test(name))
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }))
    .map((name) => path.join(directory, name));
  if (!files.length) throw new Error(`No PNG frames found in ${directory}`);
  return files;
}

/**
 * Resolves the unified import source from explicit or inferred arguments.
 * @param {object} args Tool arguments.
 * @returns {string} Source kind.
 */
function resolveImportSource(args = {}) {
  const explicit = String(args.source || args.kind || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  if (explicit) return explicit;
  if (Array.isArray(args.items) && args.items.length) return "items";
  const filePath = String(args.file_path || args.path || "");
  if (/\.spriteframes\.tres$/i.test(filePath)) return "spriteframes";
  if (args.directory) return "png_sequence";
  if (filePath) return "video";
  throw new Error("Provide source=video|png_sequence|spriteframes|items and a matching path or items.");
}

/**
 * Merges one collision/hurt/hit box patch onto the saved box.
 * @param {object|undefined} existing Current box.
 * @param {object} patch Requested fields.
 * @param {{ground?:boolean}} [options] Collision grounding.
 * @returns {object} Merged box.
 */
function mergeBox(existing, patch, options = {}) {
  const current = existing && typeof existing === "object" ? existing : {};
  const corners = boxFromGroupCorners(patch);
  const source = corners
    ? { enabled: patch?.enabled, offset: corners.offset, size: corners.size }
    : patch && typeof patch === "object"
      ? patch
      : {};
  const next = {
    enabled: source.enabled === undefined ? current.enabled !== false : Boolean(source.enabled),
    offset: {
      x: Number(source.offset?.x ?? current.offset?.x ?? 0),
      y: Number(source.offset?.y ?? current.offset?.y ?? 0),
    },
    size: {
      x: Number(source.size?.x ?? current.size?.x ?? 0),
      y: Number(source.size?.y ?? current.size?.y ?? 0),
    },
  };
  if (options.ground && source.offset?.y === undefined && !corners && next.size.y > 0) {
    next.offset.y = -next.size.y * 0.5;
  }
  return next;
}

/**
 * Classifies one validate_import message into standalone, bind, or gameplay.
 * @param {string} message Validation message.
 * @returns {"standalone"|"bind"|"gameplay"} Layer name.
 */
function classifyValidationMessage(message) {
  const text = String(message || "");
  if (/Generated runtime|gameplay scene|xsxb_frame_actor|animation_duration|scene_scale/i.test(text)) {
    return "gameplay";
  }
  if (
    /project\.godot not found|Game-local|game-local|bound game asset|res:\/\/|Unstable frame binding key/i.test(
      text,
    )
  ) {
    return "bind";
  }
  return "standalone";
}

/**
 * Slices extracted video frames by inclusive start/end indexes.
 * @param {string[]} extractedPaths Extracted PNG paths.
 * @param {{start_frame?:number,end_frame?:number}} [args] Inclusive indexes.
 * @returns {{paths:string[],extractedCount:number,startFrame:number,endFrame:number}} Sliced paths.
 */
function sliceExtractedFrames(extractedPaths, args = {}) {
  const paths = Array.isArray(extractedPaths) ? extractedPaths : [];
  const last = Math.max(0, paths.length - 1);
  const start = Number.isInteger(Number(args.start_frame))
    ? Math.max(0, Math.min(last, Number(args.start_frame)))
    : 0;
  const end = Number.isInteger(Number(args.end_frame))
    ? Math.max(start, Math.min(last, Number(args.end_frame)))
    : last;
  return {
    paths: paths.slice(start, end + 1),
    extractedCount: paths.length,
    startFrame: start,
    endFrame: end,
  };
}

/**
 * Resolves an existing local file or throws.
 *
 * Every caller reads the whole file into memory, so the size is checked from
 * the stat that already proves the file exists. Without it one mistyped path to
 * a disk image would be loaded in full before anything noticed.
 * @param {string} filePath Candidate path.
 * @param {string} label Error label.
 * @param {number} [maxBytes] Largest accepted file size.
 * @returns {string} Absolute path.
 */
function requireExistingFile(filePath, label, maxBytes = MAX_AGENT_FILE_BYTES) {
  const absolute = path.resolve(String(filePath || ""));
  if (!filePath || !fs.existsSync(absolute)) {
    throw new Error(`${label} not found: ${filePath || "(empty)"}`);
  }
  const stats = fs.statSync(absolute);
  if (!stats.isFile()) throw new Error(`${label} not found: ${filePath}`);
  if (stats.size > maxBytes) {
    throw new Error(
      `${label} is too large: ${formatMegabytes(stats.size)} exceeds the ` +
        `${formatMegabytes(maxBytes)} limit for a single file.`,
    );
  }
  return absolute;
}

/**
 * Renders a byte count as megabytes for operator-facing messages.
 * @param {number} bytes Byte count.
 * @returns {string} Human-readable size.
 */
function formatMegabytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Checks whether a filesystem path stays inside a parent directory.
 * @param {string} childPath Candidate child path.
 * @param {string} parentPath Expected parent path.
 * @returns {boolean} True when the child stays inside the parent.
 */
function isInsideDirectory(childPath, parentPath) {
  if (!parentPath) return false;
  const relativePath = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

/** Per-project folder for MCP inspection artifacts (GIF, sheet, overlay). */
const MCP_ARTIFACT_DIR = ".xsxb";

/**
 * Resolves the current project's MCP artifact directory.
 * @param {string|undefined} workspaceDir Tuner project workspace.
 * @param {string} root XSXB service root.
 * @returns {string} Absolute `.xsxb` directory.
 */
function mcpArtifactDir(workspaceDir, root) {
  if (workspaceDir) return path.join(workspaceDir, MCP_ARTIFACT_DIR);
  return path.join(root, "workspace", MCP_ARTIFACT_DIR);
}

/**
 * Resolves an MCP output path into the project `.xsxb` folder.
 * Relative paths hang off `.xsxb/` so `exports/foo.gif` cannot dump into the
 * MCP repo. Absolute paths stay inside the XSXB root unless allowOutsideRoot
 * is set (GIF/sheet/overlay/pack copies into /tmp or a game checkout).
 * @param {unknown} requested Agent `output_path`, or omitted.
 * @param {{root:string,artifactDir:string,defaultName:string,extensionPattern:RegExp,extensionLabel:string,allowOutsideRoot?:boolean}} options Path options.
 * @returns {string} Absolute destination.
 */
function resolveMcpArtifactPath(requested, options) {
  const root = path.resolve(options.root);
  const artifactDir = path.resolve(options.artifactDir);
  const defaultName = options.defaultName;
  let outputPath;
  if (requested) {
    const raw = String(requested);
    outputPath = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(artifactDir, raw);
  } else {
    outputPath = path.join(artifactDir, defaultName);
  }
  if (options.extensionPattern && !options.extensionPattern.test(outputPath)) {
    throw new Error(`output_path must end with ${options.extensionLabel}.`);
  }
  const outside = !isInsideDirectory(outputPath, root) && !isInsideDirectory(outputPath, artifactDir);
  if (outside && !(options.allowOutsideRoot && requested && path.isAbsolute(String(requested)))) {
    throw new Error(
      `output_path must stay inside the XSXB workspace root (${root}). Received: ${requested || defaultName}`,
    );
  }
  const repoDump = path.join(root, "exports");
  if (!outside && isInsideDirectory(outputPath, repoDump)) {
    throw new Error(
      `MCP artifacts belong in the current project's .xsxb/ folder, not the MCP exports/ dump. Received: ${requested}`,
    );
  }
  return outputPath;
}

/**
 * MIME type for a supported SFX file.
 * @param {string} filePath Audio path.
 * @returns {string} MIME type.
 */
function audioMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".wav") return "audio/wav";
  if (extension === ".ogg") return "audio/ogg";
  if (extension === ".mp3") return "audio/mpeg";
  throw new Error(`Unsupported SFX type ${extension || "(none)"}. Use .wav, .ogg, or .mp3.`);
}
module.exports = {
  MAX_AGENT_FILE_BYTES,
  MCP_ARTIFACT_DIR,
  PNG_NAME,
  audioMimeType,
  booleanFlag,
  classifyValidationMessage,
  formatMegabytes,
  isInsideDirectory,
  mcpArtifactDir,
  resolveMcpArtifactPath,
  listPngSequence,
  mergeBox,
  parseGroupPoint,
  pngFileToItem,
  PET_MILLISECOND_FPS,
  requireExistingFile,
  requireFps,
  resolveExportFps,
  exportFrameDurationSeconds,
  requireGroupPoint,
  requireTunerPort,
  requireFrameIndex,
  resolveImportSource,
  sliceExtractedFrames,
};
