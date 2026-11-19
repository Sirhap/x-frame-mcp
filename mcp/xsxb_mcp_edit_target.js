"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { getPngSize, parseSpriteFrames } = require("./lib/import_spriteframes");
const { withFileTransaction } = require("./lib/file_transaction");
const { listPngSequence, requireExistingFile, PNG_NAME } = require("./xsxb_mcp_arguments");
const { cutoutPngFile, decodePngRgba, encodePngRgba } = require("./xsxb_mcp_cutout");
const { analyzePngFiles } = require("./xsxb_mcp_loop");
const { editVideoTarget } = require("./xsxb_mcp_target_video");

/** One media argument contract shared by the catalog and direct-file implementation. */
const editTargetDefinition = {
  name: "xsxb_edit_target",
  description:
    "Operate directly on a video, PNG, PNG directory, SpriteFrames .tres or ordered PNG items without an XSXB project or import. Inspect or analyze reads the target. flip_horizontal and cutout preview by default; dry_run:false writes original textures once, including shared textures, and returns edited inline items. Video cutout uses FFmpeg color keying and an alpha-capable MOV/MKV; other containers default to a sibling _cut.mov.",
  inputSchema: {
    type: "object",
    required: ["operation"],
    additionalProperties: false,
    properties: {
      operation: { type: "string", enum: ["inspect", "analyze", "flip_horizontal", "cutout"] },
      source: {
        type: "string",
        enum: ["video", "png", "png_sequence", "spriteframes", "items"],
        description: "Inferred from file_path, directory or items.",
      },
      file_path: { type: "string", description: "Local PNG, video, or SpriteFrames resource." },
      directory: { type: "string", description: "PNG sequence in natural filename order." },
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string" },
            file_path: { type: "string" },
            data: { type: "string" },
            name: { type: "string" },
          },
        },
      },
      animation_id: {
        type: "string",
        description: "Optional SpriteFrames animation name or id. Omit to process all animations.",
      },
      project_root: {
        type: "string",
        description: "Godot root for res:// references. Inferred from project.godot when omitted.",
      },
      dry_run: { type: "boolean", default: true },
      key_color: {
        type: "string",
        description: "Optional #RRGGBB cutout color. Defaults to border estimation.",
      },
      output_path: {
        type: "string",
        description: "Optional destination for a single PNG or video. PNG batches edit the supplied paths.",
      },
    },
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
};

/** Resolves res:// from a nested resource without creating or binding an XSXB project. */
function godotRoot(file, explicit) {
  if (explicit) return fs.realpathSync(explicit);
  let dir = path.dirname(file);
  while (!fs.existsSync(path.join(dir, "project.godot"))) {
    const parent = path.dirname(dir);
    if (dir === parent) return path.dirname(file);
    dir = parent;
  }
  return dir;
}

/** Detects intervening edits during async preparation before publishing original-file replacements. */
function trackFiles() {
  const watched = new Map();
  const version = (file) => {
    const s = fs.statSync(file, { bigint: true });
    return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join("/");
  };
  return {
    watch(file) {
      const resolved = fs.realpathSync(file);
      if (!watched.has(resolved)) watched.set(resolved, version(resolved));
      return resolved;
    },
    assertCurrent() {
      for (const [file, previous] of watched)
        if (version(file) !== previous) throw new Error(`Target changed during processing: ${file}`);
    },
  };
}

/** Reads on-disk PNGs by reference. Only inline items need a temporary input file. */
function resolveClips(source, file, args, temp, watch) {
  const disk = (input) => {
    const target = watch(requireExistingFile(input, "Target PNG", Infinity));
    if (!PNG_NAME.test(target)) throw new Error(`Expected PNG: ${target}`);
    return { file: target, name: path.basename(target) };
  };
  if (source === "spriteframes") {
    const root = godotRoot(file, args.project_root);
    const clips = parseSpriteFrames(file, root, { strict: true, animationId: args.animation_id });
    if (!clips.length) throw new Error(`No matching PNG animation in ${file}`);
    return clips.map((clip) => ({
      name: clip.name,
      fps: clip.fps,
      frames: clip.frames.map((f) => ({ ...disk(f.source), duration: f.duration })),
    }));
  }
  if (source === "items") {
    if (!args.items.length) throw new Error("items requires at least one PNG.");
    const frames = args.items.map((item, index) => {
      if ([item.path, item.file_path, item.data].filter((v) => v !== undefined).length !== 1)
        throw new Error(`Item ${index} needs exactly one path or PNG data URL.`);
      if (item.data === undefined)
        return { ...disk(item.path ?? item.file_path), ...(item.name ? { name: item.name } : {}) };
      const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/i.exec(item.data);
      if (!match) throw new Error(`Item ${index} needs a PNG data URL.`);
      const local = path.join(temp, `inline-${index}.png`);
      fs.writeFileSync(local, Buffer.from(match[1], "base64"));
      return { file: local, inline: true, name: item.name || `frame_${index + 1}.png` };
    });
    return [{ frames }];
  }
  return [{ frames: source === "png" ? [disk(file)] : listPngSequence(file).map(disk) }];
}

/** Mirrors complete RGBA pixels so alpha and RGB move together. */
function flipPng(image) {
  const { data, width, height } = image;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < Math.floor(width / 2); x++) {
      const left = (y * width + x) * 4,
        right = (y * width + width - 1 - x) * 4;
      for (let channel = 0; channel < 4; channel++) {
        const value = data[left + channel];
        data[left + channel] = data[right + channel];
        data[right + channel] = value;
      }
    }
  return encodePngRgba(data, width, height);
}

/** Publishes every unique selected texture together, preserving logical frame order in receipts. */
function editClips(clips, source, args, temp, assertCurrent) {
  const frames = clips.flatMap((clip) => clip.frames);
  const unique = [...new Set(frames.map((frame) => frame.file))];
  if (args.output_path && source !== "png" && !(source === "items" && frames.length === 1))
    throw new Error("output_path is for one PNG or a video; batches write their original files.");
  let output = args.output_path && path.resolve(args.output_path);
  if (output && fs.existsSync(output)) output = fs.realpathSync(output);
  if (output && !PNG_NAME.test(output)) throw new Error("PNG output_path must end in .png.");
  const edit = ["cutout", "flip_horizontal"].includes(args.operation);
  const apply = edit && args.dry_run === false;
  const inlineFiles = new Set(frames.filter((frame) => frame.inline).map((frame) => frame.file));
  const sizeByPath = new Map();
  const inlineBytes = new Map();
  withFileTransaction((transaction) => {
    for (const [index, file] of unique.entries()) {
      const size = getPngSize(file);
      if (!size.width || !size.height) throw new Error(`Invalid PNG header: ${file}`);
      sizeByPath.set(file, size);
      if (!apply) continue;
      let bytes;
      if (args.operation === "flip_horizontal") bytes = flipPng(decodePngRgba(file));
      else {
        const staged = path.join(temp, `cut-${index}.png`);
        cutoutPngFile(file, staged, { keyColor: args.key_color });
        bytes = fs.readFileSync(staged);
      }
      const dest = output || file;
      if (inlineFiles.has(file) && !output) inlineBytes.set(file, bytes);
      else {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        transaction.writeFile(dest, bytes);
      }
    }
    assertCurrent();
  });
  const animations = clips.map(({ frames, ...clip }) => {
    let analysis;
    if (args.operation === "analyze") {
      const { images, ...metrics } = analyzePngFiles(frames.map((f) => f.file));
      analysis = metrics;
    }
    return {
      ...clip,
      frames: frames.map(({ file, inline, ...f }) => ({
        ...f,
        ...sizeByPath.get(file),
        ...(inline ? { inline: true } : { path: file }),
        ...(inlineBytes.has(file)
          ? { data: `data:image/png;base64,${inlineBytes.get(file).toString("base64")}` }
          : {}),
      })),
      ...(analysis ? { analysis } : {}),
    };
  });
  return {
    source,
    operation: args.operation,
    frameCount: frames.length,
    uniqueFrames: unique.length,
    animations,
    ...(output ? { output_path: output } : {}),
    ...(edit ? { dryRun: !apply } : {}),
  };
}

/** Runs a direct media operation without allocating a persistent project or importing assets. */
async function editTarget(args) {
  if ([args.file_path, args.directory, args.items].filter((v) => v !== undefined).length !== 1)
    throw new Error("Supply exactly one of file_path, directory, or items.");
  if (
    args.key_color !== undefined &&
    (args.operation !== "cutout" || !/^#[a-f0-9]{6}$/i.test(args.key_color))
  )
    throw new Error("key_color requires cutout and a #RRGGBB color.");
  if (args.output_path && ["inspect", "analyze"].includes(args.operation))
    throw new Error("output_path requires a write operation.");
  const files = trackFiles();
  const input = args.file_path ?? args.directory;
  if (input !== undefined && !input.trim()) throw new Error("Target path must not be empty.");
  const file = input === undefined ? null : fs.realpathSync(input);
  const isDirectory = file && fs.statSync(file).isDirectory();
  if (args.directory !== undefined && !isDirectory)
    throw new Error("directory must be a PNG sequence directory.");
  if (file && !isDirectory) files.watch(requireExistingFile(file, "Target", Infinity));
  const inferred =
    args.items !== undefined
      ? "items"
      : isDirectory
        ? "png_sequence"
        : PNG_NAME.test(file)
          ? "png"
          : /\.tres$/i.test(file)
            ? "spriteframes"
            : "video";
  const source = args.source || inferred;
  if (
    (source === "items") !== (args.items !== undefined) ||
    (source === "png_sequence") !== Boolean(isDirectory)
  )
    throw new Error(`Source ${source} conflicts with the supplied ${inferred} target.`);
  if ((args.animation_id || args.project_root) && source !== "spriteframes")
    throw new Error("animation_id and project_root select a SpriteFrames resource.");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-target-"));
  try {
    const result =
      source === "video"
        ? { operation: args.operation, ...(await editVideoTarget(file, args, temp, files.assertCurrent)) }
        : editClips(
            resolveClips(source, file, args, temp, files.watch),
            source,
            args,
            temp,
            files.assertCurrent,
          );
    const readOnly = args.operation === "inspect" || args.operation === "analyze";
    if (readOnly) files.assertCurrent();
    Object.defineProperty(result, "__mcp", {
      value: { readOnly, route: source === "video" ? "external_process" : "geometry" },
    });
    return result;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
module.exports = { editTarget, editTargetDefinition };
