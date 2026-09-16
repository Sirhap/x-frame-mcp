"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createProjectStore } = require("../project_store");
const { createXsxbMcpService } = require("../xsxb_mcp_service");
const { encodePngRgba } = require("../xsxb_mcp_cutout");

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

const FFMPEG_SKIP = hasFfmpeg() ? false : "ffmpeg not on PATH";

/**
 * Builds a square opaque PNG of one color.
 * @param {number} size Edge length in pixels.
 * @param {number[]} [color] RGBA color.
 * @returns {Buffer} Encoded PNG.
 */
function solidPng(size, color = [200, 40, 40, 255]) {
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) rgba.set(color, offset);
  return encodePngRgba(rgba, size, size);
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
 * Isolated two-frame walk project that encodes with the real FFmpeg GIF path.
 * @returns {{root:string,sequenceDir:string,service:object,cleanup:Function}} Fixture.
 */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-mcp-gif-"));
  const godotRoot = path.join(root, "godot");
  fs.mkdirSync(godotRoot, { recursive: true });
  fs.writeFileSync(path.join(godotRoot, "project.godot"), '[application]\nconfig/name="Gif"\n');
  const store = createProjectStore(root);
  store.addProject({ id: "gif", label: "Gif", projectRoot: godotRoot });
  const sequenceDir = path.join(root, "seq");
  fs.mkdirSync(sequenceDir);
  fs.writeFileSync(path.join(sequenceDir, "a.png"), solidPng(16, [200, 40, 40, 255]));
  fs.writeFileSync(path.join(sequenceDir, "b.png"), solidPng(16, [40, 200, 40, 255]));
  return {
    root,
    sequenceDir,
    service: createXsxbMcpService({ root }),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test(
  "export_gif two-frame clip keeps receipt.frameCount 2, two GIF image blocks, and a real last delay",
  { skip: FFMPEG_SKIP, timeout: 30_000 },
  async () => {
    const current = fixture();
    try {
      await current.service.call("xsxb_import_animation", {
        source: "png_sequence",
        directory: current.sequenceDir,
        project_id: "gif",
        animation_id: "walk",
      });
      await current.service.call("xsxb_update_timing", { animation_id: "walk", fps: 8 });
      const exported = await current.service.call("xsxb_export_gif", { animation_id: "walk" });
      assert.equal(exported.frameCount, 2, "frameCount is the authored clip, not ffprobe packets");
      assert.equal(exported.totalDurationMs, 250);
      assert.ok(fs.existsSync(exported.outputPath), exported.outputPath);
      assert.equal(exported.concatRepeatsLast, undefined, "concat tail is gone; do not forgive n+1");
      const gif = readGifFrames(fs.readFileSync(exported.outputPath));
      assert.equal(gif.imageBlocks, exported.frameCount, "GIF image blocks must equal authored frameCount");
      assert.equal(gif.imageBlocks, 2, `GIF image blocks=${gif.imageBlocks} must be the 2-frame clip`);
      assert.ok(
        gif.delaysCs[1] >= 10,
        `last delay ${gif.delaysCs[1]}cs must keep the 125ms frame, not a 1cs concat tail`,
      );
    } finally {
      current.cleanup();
    }
  },
);
