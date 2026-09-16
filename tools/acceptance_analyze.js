#!/usr/bin/env node
"use strict";

/**
 * Public tools/call session for the video-to-loop path: import a PNG
 * sequence, get_animation, optional plate cutout, xsxb_analyze, then
 * xsxb_reorganize_frames with applyOrder (holds dropped, then loop or motion),
 * then xsxb_export_gif so the trimmed clip's timing is proven.
 */

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createXsxbMcpService } = require("../mcp/xsxb_mcp_service");
const { decodePngRgba } = require("../mcp/xsxb_mcp_cutout");
const { callTool } = require("./acceptance_playbooks");
const { copyKeepFile } = require("./acceptance_keep");
const { heroFrame, writePngSequence } = require("./acceptance_sprites");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DEFAULT_KEEP = "/opt/cursor/artifacts/generated_session_evidence";
const FALLBACK_KEEP = "/opt/cursor/artifacts/analyze_evidence";
const KEEP_GIF_NAME = "analyze_walk.gif";

/**
 * SHA-256 of decoded RGBA so PNG re-encode does not hide identity.
 * @param {string} filePath Absolute PNG path.
 * @returns {string} Hex digest.
 */
function rgbaDigest(filePath) {
  const image = decodePngRgba(filePath);
  return crypto.createHash("sha256").update(Buffer.from(image.data)).digest("hex");
}

/**
 * True when ffmpeg is on PATH. The session still prefers a PNG sequence.
 * @returns {boolean} Whether `which ffmpeg` succeeds.
 */
function ffmpegPresent() {
  return spawnSync("which", ["ffmpeg"], { encoding: "utf8" }).status === 0;
}

/**
 * Keep directory for the exported GIF. Prefers an explicit override, then
 * XSXB_ACCEPTANCE_KEEP, then generated_session_evidence, then analyze_evidence.
 * @param {{keepDir?:string}} [options] Caller override.
 * @returns {string} Destination directory.
 */
function resolveKeepDir(options = {}) {
  if (options.keepDir) return options.keepDir;
  if (process.env.XSXB_ACCEPTANCE_KEEP) return process.env.XSXB_ACCEPTANCE_KEEP;
  return DEFAULT_KEEP;
}

/**
 * Creates the keep directory, falling back to the sibling analyze_evidence path.
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
 * Reads GIF magic, size, and ffprobe timing when ffprobe is on PATH.
 * @param {string} filePath Absolute GIF path.
 * @returns {{header:string,bytes:number,frameCount?:number,durationSec?:number}} File facts.
 */
function inspectGif(filePath) {
  const bytes = fs.statSync(filePath).size;
  const header = fs.readFileSync(filePath).subarray(0, 6).toString("ascii");
  const facts = { header, bytes };
  const probed = spawnSync(
    "ffprobe",
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
    const parsed = JSON.parse(probed.stdout || "{}");
    const stream = Array.isArray(parsed.streams) ? parsed.streams[0] || {} : {};
    const format = parsed.format && typeof parsed.format === "object" ? parsed.format : {};
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
 * Runs one agent-shaped analyze → reorganize → export_gif session against public tools/call.
 * @param {{keepDir?:string}} [options] Artifact directory for analyze_walk.gif.
 * @returns {Promise<object>} Order, preview, gif path, and which window was applied.
 */
async function runAnalyzeAcceptance(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-analyze-"));
  const service = createXsxbMcpService({ root, florenceDetectImpl: null });
  const commands = [];
  try {
    const rest = heroFrame({ stride: 0, arm: 0 });
    const walkA = heroFrame({ stride: 3, arm: 2, lift: 8 });
    const walkB = heroFrame({ stride: 5, arm: -2, lift: 12 });
    const sequence = writePngSequence(path.join(root, "incoming", "walk"), [
      rest,
      rest,
      walkA,
      walkB,
      rest,
      rest,
    ]);
    assert.equal(fs.readdirSync(sequence).filter((name) => /\.png$/i.test(name)).length, 6);

    const created = await callTool(service, "xsxb_create_project", {
      project_id: "hero",
      label: "Analyze",
    });
    assert.equal(created.ok, true, JSON.stringify(created.error || created));
    commands.push("xsxb_create_project");

    const imported = await callTool(service, "xsxb_import_animation", {
      project_id: "hero",
      source: "png_sequence",
      directory: sequence,
      profile_id: "hero",
      animation_id: "walk",
      fps: 8,
    });
    assert.equal(imported.ok, true, JSON.stringify(imported.error || imported));
    assert.equal(imported.data.importedFrameCount, 6);
    commands.push("xsxb_import_animation");

    const got = await callTool(service, "xsxb_get_animation", {
      project_id: "hero",
      animation_id: "walk",
    });
    assert.equal(got.ok, true, JSON.stringify(got.error || got));
    assert.ok(got.observation?.snapshotId, "get_animation must mint basis_snapshot_id");
    assert.equal(got.data.frameCount, 6);
    const orderBefore = (got.data.animation.frames || []).map((frame) => frame.index);
    commands.push("xsxb_get_animation");

    const cut = await callTool(service, "xsxb_cutout", {
      project_id: "hero",
      animation_id: "walk",
      key_mode: "border_flood",
      key_color: "#f8f8f8",
      basis_snapshot_id: got.observation.snapshotId,
    });
    assert.equal(cut.ok, true, JSON.stringify(cut.error || cut));
    commands.push("xsxb_cutout");

    const basis = await callTool(service, "xsxb_get_animation", {
      project_id: "hero",
      animation_id: "walk",
    });
    assert.equal(basis.ok, true, JSON.stringify(basis.error || basis));
    const beforeFrames = basis.data.animation.frames || [];
    assert.equal(beforeFrames.length, 6);
    const beforeDigests = beforeFrames.map((frame) => rgbaDigest(frame.absolutePath));
    assert.equal(beforeDigests[0], beforeDigests[1], "leading holds must match");
    assert.equal(beforeDigests[0], beforeDigests[4], "trailing holds must match rest");
    assert.equal(beforeDigests[0], beforeDigests[5], "trailing holds must match rest");
    assert.notEqual(beforeDigests[2], beforeDigests[0], "first walk must differ from rest");
    assert.notEqual(beforeDigests[3], beforeDigests[0], "second walk must differ from rest");
    assert.notEqual(beforeDigests[2], beforeDigests[3], "walk frames must be distinct");
    commands.push("xsxb_get_animation");

    const analyzed = await callTool(service, "xsxb_analyze", {
      project_id: "hero",
      animation_id: "walk",
    });
    assert.equal(analyzed.ok, true, JSON.stringify(analyzed.error || analyzed));
    const previewPath = analyzed.data.preview?.path;
    assert.ok(previewPath, "analyze must write preview.path");
    assert.ok(fs.existsSync(previewPath), `analyze preview missing: ${previewPath}`);
    const header = fs.readFileSync(previewPath).subarray(0, 8);
    assert.deepEqual([...header], [...PNG_SIGNATURE], "analyze preview must be a PNG");
    const preview = decodePngRgba(previewPath);
    assert.ok(preview.width > 0 && preview.height > 0, "analyze preview must have a positive size");
    assert.ok(analyzed.observation?.snapshotId, "analyze must mint basis_snapshot_id");
    commands.push("xsxb_analyze");

    const recommendedOrder = analyzed.data.applyOrder || analyzed.data.recommended?.applyOrder;
    const used = analyzed.data.recommended?.kind || analyzed.data.preview?.kind;
    assert.ok(Array.isArray(recommendedOrder) && recommendedOrder.length >= 2, JSON.stringify(analyzed.data));

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
    const orderAfter = afterFrames.map((frame) => frame.index);
    assert.equal(
      afterFrames.length,
      recommendedOrder.length,
      "frame count must match the applied recommended order",
    );
    assert.ok(afterFrames.length < orderBefore.length, "apply must drop the rest holds");
    const afterDigests = afterFrames.map((frame) => rgbaDigest(frame.absolutePath));
    const expectedDigests = recommendedOrder.map((sourceIndex) => beforeDigests[sourceIndex]);
    assert.deepEqual(afterDigests, expectedDigests, "kept frames must follow the recommended source order");
    const restDigest = beforeDigests[0];
    const motionDigests = new Set([beforeDigests[2], beforeDigests[3]]);
    assert.ok(
      afterDigests.every((digest) => digest !== restDigest),
      "kept frames must not be the rest hold",
    );
    assert.ok(
      afterDigests.every((digest) => motionDigests.has(digest)),
      "kept frames must be the motion pair",
    );
    assert.equal(new Set(afterDigests).size, afterDigests.length, "kept motion frames must stay distinct");
    commands.push("xsxb_get_animation");

    const ffmpeg = ffmpegPresent();
    let gifPath = null;
    let gifBytes = null;
    let gifFrameCount = null;
    let gifDurationMs = null;
    let gifFps = null;
    let gifSkipped = null;
    let gifProbe = null;
    if (!ffmpeg) {
      gifSkipped = "ffmpeg not on PATH; skipped GIF export asserts";
    } else {
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
      assert.equal(exported.data.frameCount, 2, "hold-walk-hold fixture must export 2 motion frames");
      assert.notEqual(
        exported.data.frameCount,
        orderBefore.length,
        "GIF must not use the original 6-frame hold clip",
      );
      const fps = Number(exported.data.fps);
      assert.ok(Number.isFinite(fps) && fps > 0, "export_gif must report fps");
      const expectedMs = Math.round((afterFrames.length / fps) * 1000);
      const originalMs = Math.round((orderBefore.length / fps) * 1000);
      assert.equal(
        exported.data.totalDurationMs,
        expectedMs,
        `GIF duration must match the reorganized clip (${expectedMs}ms)`,
      );
      assert.notEqual(
        exported.data.totalDurationMs,
        originalMs,
        "GIF duration must not match the original 6-frame window",
      );
      if (gifFacts.frameCount !== undefined) {
        assert.ok(
          gifFacts.frameCount === afterFrames.length || gifFacts.frameCount === afterFrames.length + 1,
          `probed GIF frames ${gifFacts.frameCount} must be the 2-frame clip (ffmpeg may repeat the tail)`,
        );
        assert.notEqual(gifFacts.frameCount, orderBefore.length, "probed GIF must not be 6 frames");
      }
      if (gifFacts.durationSec !== undefined) {
        const originalSec = originalMs / 1000;
        assert.ok(
          gifFacts.durationSec < originalSec * 0.8,
          `probed GIF duration ${gifFacts.durationSec}s must be the trimmed window, not ${originalSec}s`,
        );
      }
      commands.push("xsxb_export_gif");
      gifBytes = Number(exported.data.bytes) || gifFacts.bytes;
      gifFrameCount = exported.data.frameCount;
      gifDurationMs = exported.data.totalDurationMs;
      gifFps = fps;
      gifProbe = gifFacts;
      const keepDir = ensureKeepDir(options);
      const keptGif = path.join(keepDir, KEEP_GIF_NAME);
      copyKeepFile(outputPath, keptGif);
      gifPath = keptGif;
    }

    return {
      orderBefore,
      orderAfter,
      recommendedOrder,
      previewPath,
      gifPath,
      gifBytes,
      gifFrameCount,
      gifDurationMs,
      gifFps,
      gifSkipped,
      gifProbe,
      used,
      keptMotion: true,
      commands,
      ffmpeg,
      snapshotId: analyzed.observation.snapshotId,
      preview: { width: preview.width, height: preview.height, kind: analyzed.data.preview?.kind },
    };
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = { runAnalyzeAcceptance };

if (require.main === module) {
  runAnalyzeAcceptance()
    .then((report) => {
      process.stdout.write(
        `Analyze acceptance passed. used=${report.used} before=${report.orderBefore.join(",")} after=${report.orderAfter.join(",")} preview=${report.previewPath} gif=${report.gifPath} frames=${report.gifFrameCount} durationMs=${report.gifDurationMs}\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}
