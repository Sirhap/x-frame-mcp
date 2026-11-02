"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const { encodePngRgba } = require("../../mcp/xsxb_mcp_cutout");
const { encodeGifWithFfmpeg } = require("../../mcp/xsxb_mcp_processes");

const ffmpeg = process.env.XSXB_FFMPEG || "ffmpeg";
const ffprobe = process.env.XSXB_FFPROBE || "ffprobe";
let unavailable;
try {
  for (const binary of [ffmpeg, ffprobe]) execFileSync(binary, ["-version"], { stdio: "ignore" });
} catch (error) {
  unavailable = `Real GIF timing tests require ffmpeg and ffprobe: ${error.message}`;
}

/**
 * Encodes distinct flat colors and probes actual GIF packets and decoded pixels.
 * @param {number[]} durations Requested durations in seconds.
 * @param {number[]} expectedDelays Expected centiseconds, explicitly specified per scenario.
 * @returns {Promise<void>} Verified timing, frame count and frame content.
 */
async function verifyGif(durations, expectedDelays) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-gif-timing-"));
  const colors = [
    [255, 0, 0, 255],
    [0, 255, 0, 255],
    [0, 0, 255, 255],
  ];
  try {
    const framePaths = durations.map((_, index) => {
      const data = new Uint8ClampedArray(8 * 8 * 4);
      for (let offset = 0; offset < data.length; offset += 4) data.set(colors[index], offset);
      const file = path.join(root, `${index}.png`);
      fs.writeFileSync(file, encodePngRgba(data, 8, 8));
      return file;
    });
    const outputPath = path.join(root, "preview.gif");
    await encodeGifWithFfmpeg({ framePaths, durations, outputPath, ffmpegBinary: ffmpeg });
    // Disable the GIF demuxer's browser-style short-delay replacement when checking file timing.
    const probe = JSON.parse(
      execFileSync(
        ffprobe,
        [
          "-v",
          "error",
          "-min_delay",
          "0",
          "-show_packets",
          "-show_entries",
          "packet=pts_time,duration_time",
          "-of",
          "json",
          outputPath,
        ],
        { encoding: "utf8", timeout: 10000 },
      ),
    );
    assert.equal(probe.packets.length, durations.length, "GIF must contain exactly the requested frames");
    assert.deepEqual(
      probe.packets.map((packet) => Math.round(Number(packet.duration_time) * 100)),
      expectedDelays,
    );
    let elapsed = 0;
    for (let index = 0; index < expectedDelays.length; index += 1) {
      assert.equal(Math.round(Number(probe.packets[index].pts_time) * 100), elapsed);
      elapsed += expectedDelays[index];
    }
    const raw = execFileSync(
      ffmpeg,
      [
        "-v",
        "error",
        "-min_delay",
        "0",
        "-i",
        outputPath,
        "-vsync",
        "0",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgba",
        "pipe:1",
      ],
      { timeout: 10000 },
    );
    assert.equal(raw.length, durations.length * 8 * 8 * 4);
    for (let index = 0; index < durations.length; index += 1) {
      assert.deepEqual(
        [...raw.subarray(index * 256, index * 256 + 4)],
        colors[index],
        "Every frame, including the last, keeps its content",
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (const [name, durations, expectedDelays] of [
  ["one frame", [0.37], [37]],
  ["two frames", [0.1, 0.2], [10, 20]],
  ["long last frame", [0.04, 0.08, 1.23], [4, 8, 123]],
  ["fractional centiseconds", [0.014, 0.026, 0.047], [1, 3, 5]],
  ["sub-centisecond minimum", [0.001, 0.004, 0.02], [1, 1, 2]],
]) {
  test(`real GIF preserves frames and quantized timing: ${name}`, { skip: unavailable }, async () => {
    await verifyGif(durations, expectedDelays);
  });
}
