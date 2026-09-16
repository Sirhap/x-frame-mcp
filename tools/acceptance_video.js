#!/usr/bin/env node
"use strict";

/**
 * Public tools/call session for the video-to-loop path: encode a real MP4
 * from the generated hero walk plates, xsxb_import_video without fps so the
 * probed rate is stored, cutout, xsxb_analyze, xsxb_reorganize_frames with
 * applyOrder, then xsxb_export_gif.
 */

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createXsxbMcpService } = require("../mcp/xsxb_mcp_service");
const { decodePngRgba } = require("../mcp/xsxb_mcp_cutout");
const { suggestImportFps } = require("../mcp/xsxb_mcp_processes");
const { callTool } = require("./acceptance_playbooks");
const { countPixels, isTrueMagenta } = require("./acceptance_sprites");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DEFAULT_KEEP = "/opt/cursor/artifacts/generated_session_evidence";
const FALLBACK_KEEP = "/opt/cursor/artifacts/video_evidence";
const KEEP_GIF_NAME = "video_walk.gif";
const KEEP_CUTOUT_PREVIEW = "video_cutout_walk_preview.png";
const KEEP_ANALYZE_PREVIEW = "video_analyze_walk_preview.png";
const ENCODED_FPS = 24;
const ENCODED_FRAME_COUNT = 4;
const WALK_DIR = path.join(__dirname, "fixtures", "generated_hero", "walk");
const WALK_NAMES = Object.freeze(["00.png", "01.png", "02.png", "03.png"]);

/**
 * True when ffmpeg and ffprobe are on PATH (or XSXB_FFMPEG / XSXB_FFPROBE).
 * @returns {boolean} Whether both binaries respond to `-version`.
 */
function ffmpegPresent() {
  const ffmpeg = process.env.XSXB_FFMPEG || "ffmpeg";
  const ffprobe = process.env.XSXB_FFPROBE || "ffprobe";
  const ffmpegOk = spawnSync(ffmpeg, ["-version"], { encoding: "utf8" }).status === 0;
  const ffprobeOk = spawnSync(ffprobe, ["-version"], { encoding: "utf8" }).status === 0;
  return ffmpegOk && ffprobeOk;
}

/**
 * Keep directory for the exported GIF and magenta previews.
 * @param {{keepDir?:string}} [options] Caller override.
 * @returns {string} Destination directory.
 */
function resolveKeepDir(options = {}) {
  if (options.keepDir) return options.keepDir;
  if (process.env.XSXB_ACCEPTANCE_KEEP) return process.env.XSXB_ACCEPTANCE_KEEP;
  return DEFAULT_KEEP;
}

/**
 * Creates the keep directory, falling back to the sibling video_evidence path.
 * @param {{keepDir?:string}} [options] Caller override.
 * @returns {string} Writable destination directory.
 */
function ensureKeepDir(options = {}) {
  const preferred = resolveKeepDir(options);
  try {
    fs.mkdirSync(preferred, { recursive: true });
    return preferred;
  } catch (error) {
    if (preferred === FALLBACK_KEEP) {
      throw new Error(`cannot create keep dir ${preferred}: ${error.message}`);
    }
    fs.mkdirSync(FALLBACK_KEEP, { recursive: true });
    return FALLBACK_KEEP;
  }
}

/**
 * Copies existing files into a keep directory.
 * @param {string} dest Destination.
 * @param {Record<string,string>} files Basename to source path.
 * @returns {void}
 */
function keepFiles(dest, files) {
  if (!dest) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const [name, from] of Object.entries(files)) {
    if (from && fs.existsSync(from)) fs.copyFileSync(from, path.join(dest, name));
  }
}

/**
 * Walks GIF blocks and records each image descriptor plus its GCE delay.
 * @param {Buffer} bytes GIF file.
 * @returns {{imageBlocks:number,delaysCs:number[]}} Visible frames and centisecond delays.
 */
function readGifFrames(bytes) {
  if (bytes.length < 13 || !/^GIF8[79]a/.test(bytes.subarray(0, 6).toString("ascii"))) {
    throw new Error("not a GIF");
  }
  let offset = 13;
  const packed = bytes[10];
  if (packed & 0x80) offset += 3 * 2 ** ((packed & 0x07) + 1);
  const delaysCs = [];
  let pendingDelay = null;
  while (offset < bytes.length) {
    const marker = bytes[offset];
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      const label = bytes[offset + 1];
      offset += 2;
      if (label === 0xf9 && bytes[offset] === 4) {
        pendingDelay = bytes[offset + 2] + bytes[offset + 3] * 256;
      }
      while (offset < bytes.length && bytes[offset] !== 0) offset += 1 + bytes[offset];
      offset += 1;
      continue;
    }
    if (marker === 0x2c) {
      delaysCs.push(pendingDelay);
      pendingDelay = null;
      if (offset + 10 > bytes.length) break;
      const localPacked = bytes[offset + 9];
      offset += 10;
      if (localPacked & 0x80) offset += 3 * 2 ** ((localPacked & 0x07) + 1);
      offset += 1;
      while (offset < bytes.length && bytes[offset] !== 0) offset += 1 + bytes[offset];
      offset += 1;
      continue;
    }
    break;
  }
  return { imageBlocks: delaysCs.length, delaysCs };
}

/**
 * Reads GIF magic, size, image-block count, and ffprobe timing when available.
 * @param {string} filePath Absolute GIF path.
 * @returns {{header:string,bytes:number,imageBlocks:number,frameCount?:number,durationSec?:number}}
 *   File facts.
 */
function inspectGif(filePath) {
  const buffer = fs.readFileSync(filePath);
  const parsed = readGifFrames(buffer);
  const facts = {
    header: buffer.subarray(0, 6).toString("ascii"),
    bytes: buffer.length,
    imageBlocks: parsed.imageBlocks,
  };
  const probed = spawnSync(
    process.env.XSXB_FFPROBE || "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-count_packets",
      "-show_entries",
      "stream=nb_read_packets,nb_frames,duration",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      filePath,
    ],
    { encoding: "utf8" },
  );
  if (probed.status !== 0) return facts;
  try {
    const parsedProbe = JSON.parse(probed.stdout || "{}");
    const stream = Array.isArray(parsedProbe.streams) ? parsedProbe.streams[0] || {} : {};
    const format = parsedProbe.format && typeof parsedProbe.format === "object" ? parsedProbe.format : {};
    const packets = Number(stream.nb_read_packets);
    const frames = Number(stream.nb_frames);
    const duration = Number(stream.duration) || Number(format.duration);
    if (Number.isFinite(frames) && frames > 0) facts.frameCount = frames;
    else if (Number.isFinite(packets) && packets > 0) facts.frameCount = packets;
    if (Number.isFinite(duration) && duration > 0) facts.durationSec = duration;
  } catch {
    // Receipt timing is the contract; ffprobe is extra proof when it parses.
  }
  return facts;
}

/**
 * Lists the four authored walk plates and copies them into dest.
 * @param {string} destDir Output folder that will hold 00.png..03.png.
 * @returns {string[]} Absolute copied paths in playback order.
 */
function copyWalkPlates(destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  return WALK_NAMES.map((name) => {
    const from = path.join(WALK_DIR, name);
    assert.ok(fs.existsSync(from), `walk plate missing: ${from}`);
    const dest = path.join(destDir, name);
    fs.copyFileSync(from, dest);
    return dest;
  });
}

/**
 * Encodes the walk plate sequence to H.264 MP4 at a known constant fps.
 * Does not duplicate frames: input framerate and `-frames:v` match the plate count.
 * @param {string} sequenceDir Directory containing 00.png..03.png.
 * @param {string} destPath Output MP4 path.
 * @param {{fps?:number,frameCount?:number}} [options] Encode rate and frame cap.
 * @returns {{fps:number,frameCount:number,path:string}} Encode facts.
 */
function encodeWalkMp4(sequenceDir, destPath, options = {}) {
  const fps = Number(options.fps || ENCODED_FPS);
  const frameCount = Number(options.frameCount || ENCODED_FRAME_COUNT);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  execFileSync(
    process.env.XSXB_FFMPEG || "ffmpeg",
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-framerate",
      String(fps),
      "-start_number",
      "0",
      "-i",
      path.join(sequenceDir, "%02d.png"),
      "-frames:v",
      String(frameCount),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-vsync",
      "0",
      destPath,
    ],
    { timeout: 30_000 },
  );
  assert.ok(fs.existsSync(destPath), `encoded mp4 missing: ${destPath}`);
  return { fps, frameCount, path: destPath };
}

/**
 * True when the top-left pixel is still an opaque studio plate.
 * @param {string} filePath Absolute PNG path.
 * @returns {boolean} Whether the corner looks unkeyed.
 */
function plateCornerOpaque(filePath) {
  const image = decodePngRgba(filePath);
  return image.data[3] > 16;
}

/**
 * Opens a magenta flatten preview and asserts the navy-coat subject survived keying.
 * @param {string} previewPath Absolute PNG path.
 * @param {string} label Assertion label.
 * @returns {{magenta:number,subject:number,navy:number,width:number,height:number,path:string}}
 *   Flatten counts.
 */
function inspectMagentaPreview(previewPath, label) {
  assert.ok(previewPath && fs.existsSync(previewPath), `${label} missing preview.path`);
  const header = fs.readFileSync(previewPath).subarray(0, 8);
  assert.deepEqual([...header], [...PNG_SIGNATURE], `${label} preview must be a PNG`);
  const image = decodePngRgba(previewPath);
  const magenta = countPixels(image, isTrueMagenta);
  let subject = 0;
  let navy = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * 4;
      const r = image.data[offset];
      const g = image.data[offset + 1];
      const b = image.data[offset + 2];
      const a = image.data[offset + 3];
      if (isTrueMagenta(r, g, b, a) || a < 160) continue;
      subject += 1;
      const maxc = Math.max(r, g, b);
      const minc = Math.min(r, g, b);
      if (b >= r + 8 && b >= g && maxc <= 160 && maxc - minc >= 10 && r <= 90 && a >= 160) navy += 1;
    }
  }
  assert.ok(magenta >= 200, `${label} preview is not a magenta flatten (${magenta})`);
  assert.ok(subject >= 80, `${label} keyed the subject away (${subject})`);
  assert.ok(navy >= 20, `${label} navy coat vanished (${navy}) — keyed=true is not enough`);
  return { magenta, subject, navy, width: image.width, height: image.height, path: previewPath };
}

/**
 * Cuts out the imported walk clip, forcing a re-key when the first pass skips.
 * @param {object} service MCP service.
 * @param {string} snapshotId Current basis snapshot.
 * @param {string} firstFramePath First on-disk frame, used to detect an unkeyed plate.
 * @returns {Promise<object>} Cutout receipt.
 */
async function cutoutWalk(service, snapshotId, firstFramePath) {
  const args = {
    project_id: "hero",
    animation_id: "walk",
    key_mode: "border_flood",
    key_color: "#F8F8F8",
    basis_snapshot_id: snapshotId,
  };
  let cut = await callTool(service, "xsxb_cutout", args);
  assert.equal(cut.ok, true, JSON.stringify(cut.error || cut));
  const skipped = Number(cut.data?.skippedFrameCount || 0);
  const processed = Number(cut.data?.processedFrameCount || 0);
  const needsForce =
    (skipped > 0 && processed === 0) || (firstFramePath ? plateCornerOpaque(firstFramePath) : false);
  if (needsForce) {
    cut = await callTool(service, "xsxb_cutout", {
      ...args,
      key_color: "#FFFFFF",
      force: true,
    });
    assert.equal(cut.ok, true, JSON.stringify(cut.error || cut));
  }
  return cut;
}

/**
 * Runs one agent-shaped video → analyze → reorganize → export_gif session.
 * @param {{keepDir?:string}} [options] Artifact directory for video_walk.gif.
 * @returns {Promise<object>} Encoded rate, import receipt fields, gif path, and apply order.
 */
async function runVideoAcceptance(options = {}) {
  assert.ok(ffmpegPresent(), "ffmpeg/ffprobe not on PATH; skipped video acceptance");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-video-"));
  const game = path.join(root, "game");
  fs.mkdirSync(game);
  fs.writeFileSync(path.join(game, "project.godot"), '[application]\nconfig/name="Video"\n');
  const service = createXsxbMcpService({ root, florenceDetectImpl: null });
  const commands = [];
  try {
    const sequenceDir = path.join(root, "incoming", "walk");
    const plates = copyWalkPlates(sequenceDir);
    assert.equal(plates.length, ENCODED_FRAME_COUNT);
    const videoPath = path.join(root, "incoming", "walk.mp4");
    const encoded = encodeWalkMp4(sequenceDir, videoPath, {
      fps: ENCODED_FPS,
      frameCount: ENCODED_FRAME_COUNT,
    });

    const created = await callTool(service, "xsxb_create_project", {
      project_id: "hero",
      label: "Video",
      project_root: game,
    });
    assert.equal(created.ok, true, JSON.stringify(created.error || created));
    commands.push("xsxb_create_project");

    const imported = await callTool(service, "xsxb_import_video", {
      project_id: "hero",
      file_path: videoPath,
      profile_id: "hero",
      animation_id: "walk",
    });
    assert.equal(imported.ok, true, JSON.stringify(imported.error || imported));
    assert.ok(
      imported.data.importedFrameCount >= ENCODED_FRAME_COUNT,
      `importedFrameCount=${imported.data.importedFrameCount}`,
    );
    const expectedFps = suggestImportFps({
      sourceFrameCount: imported.data.sourceFrameCount,
      sourceDurationSec: imported.data.sourceDurationSec,
      probedFps: encoded.fps,
    });
    assert.equal(imported.data.suggestedFps, expectedFps, JSON.stringify(imported.data));
    assert.equal(imported.data.suggestedFps, encoded.fps, JSON.stringify(imported.data));
    assert.equal(imported.data.fps, imported.data.suggestedFps, JSON.stringify(imported.data));
    assert.equal(imported.data.suggestedGameFps, 8, JSON.stringify(imported.data));
    commands.push("xsxb_import_video");

    const got = await callTool(service, "xsxb_get_animation", {
      project_id: "hero",
      animation_id: "walk",
    });
    assert.equal(got.ok, true, JSON.stringify(got.error || got));
    assert.ok(got.observation?.snapshotId, "get_animation must mint basis_snapshot_id");
    assert.equal(Number(got.data.animation.fps), imported.data.suggestedFps);
    const firstFramePath = got.data.animation.frames?.[0]?.absolutePath;
    commands.push("xsxb_get_animation");

    const cut = await cutoutWalk(service, got.observation.snapshotId, firstFramePath);
    const cutPreview = inspectMagentaPreview(cut.data.preview?.path, "walk cutout");
    commands.push("xsxb_cutout");

    const analyzed = await callTool(service, "xsxb_analyze", {
      project_id: "hero",
      animation_id: "walk",
    });
    assert.equal(analyzed.ok, true, JSON.stringify(analyzed.error || analyzed));
    const analyzePreviewPath = analyzed.data.preview?.path;
    assert.ok(analyzePreviewPath, "analyze must write preview.path");
    assert.ok(fs.existsSync(analyzePreviewPath), `analyze preview missing: ${analyzePreviewPath}`);
    const analyzeHeader = fs.readFileSync(analyzePreviewPath).subarray(0, 8);
    assert.deepEqual([...analyzeHeader], [...PNG_SIGNATURE], "analyze preview must be a PNG");
    assert.ok(analyzed.observation?.snapshotId, "analyze must mint basis_snapshot_id");
    const recommendedOrder = analyzed.data.applyOrder || analyzed.data.recommended?.applyOrder;
    assert.ok(Array.isArray(recommendedOrder) && recommendedOrder.length >= 2, JSON.stringify(analyzed.data));
    commands.push("xsxb_analyze");

    const applied = await callTool(service, "xsxb_reorganize_frames", {
      project_id: "hero",
      animation_id: "walk",
      order: recommendedOrder,
      dry_run: false,
      basis_snapshot_id: analyzed.observation.snapshotId,
    });
    assert.equal(applied.ok, true, JSON.stringify(applied.error || applied));
    assert.equal(applied.data.dryRun, false, JSON.stringify(applied.data));
    commands.push("xsxb_reorganize_frames");

    const after = await callTool(service, "xsxb_get_animation", {
      project_id: "hero",
      animation_id: "walk",
    });
    assert.equal(after.ok, true, JSON.stringify(after.error || after));
    const afterFrames = after.data.animation.frames || [];
    assert.equal(
      afterFrames.length,
      recommendedOrder.length,
      "frame count must match the applied recommended order",
    );
    commands.push("xsxb_get_animation");

    const exported = await callTool(service, "xsxb_export_gif", {
      project_id: "hero",
      animation_id: "walk",
    });
    assert.equal(exported.ok, true, JSON.stringify(exported.error || exported));
    const outputPath = exported.data?.outputPath;
    assert.ok(outputPath, "export_gif must write outputPath");
    assert.ok(fs.existsSync(outputPath), `export_gif output missing: ${outputPath}`);
    const gifFacts = inspectGif(outputPath);
    assert.match(gifFacts.header, /^GIF8[79]a/, "export_gif output must be a GIF");
    assert.equal(
      exported.data.frameCount,
      afterFrames.length,
      "GIF frame count must match the reorganized clip",
    );
    assert.equal(
      gifFacts.imageBlocks,
      afterFrames.length,
      `GIF image blocks=${gifFacts.imageBlocks} must equal reorganized frames=${afterFrames.length}`,
    );
    commands.push("xsxb_export_gif");

    const keepDir = ensureKeepDir(options);
    keepFiles(keepDir, {
      [KEEP_GIF_NAME]: outputPath,
      [KEEP_CUTOUT_PREVIEW]: cutPreview.path,
      [KEEP_ANALYZE_PREVIEW]: analyzePreviewPath,
    });
    const gifPath = path.join(keepDir, KEEP_GIF_NAME);
    const keptCutout = path.join(keepDir, KEEP_CUTOUT_PREVIEW);
    const keptAnalyze = path.join(keepDir, KEEP_ANALYZE_PREVIEW);

    return {
      encodedFps: encoded.fps,
      encodedFrameCount: encoded.frameCount,
      videoPath,
      suggestedFps: imported.data.suggestedFps,
      suggestedGameFps: imported.data.suggestedGameFps,
      storedFps: Number(after.data.animation.fps),
      importedFrameCount: imported.data.importedFrameCount,
      sourceFrameCount: imported.data.sourceFrameCount,
      sourceDurationSec: imported.data.sourceDurationSec,
      recommendedOrder,
      reorganizedFrameCount: afterFrames.length,
      previewPath: fs.existsSync(keptAnalyze) ? keptAnalyze : analyzePreviewPath,
      cutoutPreviewPath: fs.existsSync(keptCutout) ? keptCutout : cutPreview.path,
      cutoutPreview: cutPreview,
      gifPath,
      gifBytes: Number(exported.data.bytes) || gifFacts.bytes,
      gifFrameCount: exported.data.frameCount,
      gifImageBlocks: gifFacts.imageBlocks,
      gifDurationMs: exported.data.totalDurationMs,
      gifFps: Number(exported.data.fps),
      gifProbe: gifFacts,
      used: analyzed.data.recommended?.kind || analyzed.data.preview?.kind,
      commands,
      ffmpeg: true,
      snapshotId: analyzed.observation.snapshotId,
    };
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = {
  copyWalkPlates,
  encodeWalkMp4,
  ffmpegPresent,
  inspectGif,
  inspectMagentaPreview,
  readGifFrames,
  runVideoAcceptance,
};

if (require.main === module) {
  if (!ffmpegPresent()) {
    process.stdout.write("ffmpeg/ffprobe not on PATH; skipped video acceptance\n");
    process.exit(0);
  }
  runVideoAcceptance()
    .then((report) => {
      process.stdout.write(
        `Video acceptance passed. fps=${report.encodedFps} suggestedFps=${report.suggestedFps} suggestedGameFps=${report.suggestedGameFps} imported=${report.importedFrameCount} after=${report.reorganizedFrameCount} gif=${report.gifPath} blocks=${report.gifImageBlocks}\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}
