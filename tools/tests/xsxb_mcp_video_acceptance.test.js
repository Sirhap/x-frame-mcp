"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const test = require("node:test");
const { suggestImportFps } = require("../../mcp/xsxb_mcp_processes");
const { runVideoAcceptance } = require("../acceptance_video");

/**
 * Whether ffmpeg can be spawned.
 * @returns {boolean} True when `-version` exits 0.
 */
function hasFfmpeg() {
  try {
    execFileSync(process.env.XSXB_FFMPEG || "ffmpeg", ["-version"], {
      stdio: "ignore",
      timeout: 8_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether ffprobe can be spawned.
 * @returns {boolean} True when `-version` exits 0.
 */
function hasFfprobe() {
  try {
    execFileSync(process.env.XSXB_FFPROBE || "ffprobe", ["-version"], {
      stdio: "ignore",
      timeout: 8_000,
    });
    return true;
  } catch {
    return false;
  }
}

const FFMPEG_SKIP = hasFfmpeg() && hasFfprobe() ? false : "ffmpeg/ffprobe not on PATH";

/**
 * Walks GIF blocks and counts image descriptors.
 * @param {Buffer} bytes GIF file.
 * @returns {number} Visible image-block count.
 */
function countGifImageBlocks(bytes) {
  if (bytes.length < 13 || !/^GIF8[79]a/.test(bytes.subarray(0, 6).toString("ascii"))) {
    throw new Error("not a GIF");
  }
  let offset = 13;
  const packed = bytes[10];
  if (packed & 0x80) offset += 3 * 2 ** ((packed & 0x07) + 1);
  let imageBlocks = 0;
  while (offset < bytes.length) {
    const marker = bytes[offset];
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      offset += 2;
      while (offset < bytes.length && bytes[offset] !== 0) offset += 1 + bytes[offset];
      offset += 1;
      continue;
    }
    if (marker === 0x2c) {
      imageBlocks += 1;
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
  return imageBlocks;
}

test(
  "video session encodes walk plates to mp4, imports without fps, then exports a gif",
  { skip: FFMPEG_SKIP, timeout: 600_000 },
  async () => {
    const report = await runVideoAcceptance();
    assert.ok(report.encodedFps === 24 || report.encodedFps === 30, report);
    const expectedFps = suggestImportFps({
      sourceFrameCount: report.sourceFrameCount,
      sourceDurationSec: report.sourceDurationSec,
      probedFps: report.encodedFps,
    });
    assert.equal(report.suggestedFps, expectedFps, JSON.stringify(report));
    assert.equal(report.suggestedFps, report.encodedFps, "suggestedFps must match the encoded rate");
    assert.ok(report.importedFrameCount >= 4, `importedFrameCount=${report.importedFrameCount}`);
    assert.ok(report.gifPath, "video session must export a gif after reorganize");
    assert.ok(fs.existsSync(report.gifPath), `gif missing: ${report.gifPath}`);
    const imageBlocks = countGifImageBlocks(fs.readFileSync(report.gifPath));
    assert.equal(
      imageBlocks,
      report.reorganizedFrameCount,
      `GIF image blocks=${imageBlocks} must equal reorganized frames=${report.reorganizedFrameCount}`,
    );
  },
);
