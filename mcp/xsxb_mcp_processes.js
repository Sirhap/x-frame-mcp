"use strict";

/**
 * The external processes the MCP tools drive: FFmpeg for frame extraction and
 * GIF encoding.
 *
 * Isolated from the service so the handlers stay readable and every subprocess
 * invocation can be swapped for a stub in tests.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

/**
 * Builds ffmpeg args for native-frame extract. `-ss`/`-t` follow `-i` (accurate seek).
 * Omit start_time and duration to extract the whole file.
 * @param {string} videoPath Absolute input video path.
 * @param {string} outputPattern Output PNG pattern.
 * @param {{start_time?:unknown,duration?:unknown}} [options] Optional time window.
 * @returns {string[]} ffmpeg argv.
 */
function videoExtractFfmpegArgs(videoPath, outputPattern, options = {}) {
  const args = ["-hide_banner", "-loglevel", "error", "-i", videoPath, "-map", "0:v:0", "-vsync", "0"];
  if (options.start_time !== undefined && options.start_time !== null && options.start_time !== "") {
    args.push("-ss", String(options.start_time));
  }
  if (options.duration !== undefined && options.duration !== null && options.duration !== "") {
    args.push("-t", String(options.duration));
  }
  args.push(outputPattern);
  return args;
}

/**
 * Extracts every source video frame without changing the source frame rate.
 * @param {string} videoPath Absolute input video path.
 * @param {string} outputDirectory Temporary output directory.
 * @param {{ffmpegBinary?:string,start_time?:unknown,duration?:unknown}} [options] Optional binary override and time window.
 * @returns {Promise<string[]>} Ordered PNG frame paths.
 */
async function extractVideoFrames(videoPath, outputDirectory, options = {}) {
  const outputPattern = path.join(outputDirectory, "frame_%06d.png");
  try {
    await execFileAsync(
      options.ffmpegBinary || process.env.XSXB_FFMPEG || "ffmpeg",
      videoExtractFfmpegArgs(videoPath, outputPattern, options),
      { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
    );
  } catch (error) {
    throw new Error(`FFmpeg video extraction failed: ${error.stderr || error.message}`);
  }
  return fs
    .readdirSync(outputDirectory)
    .filter((name) => /^frame_\d+\.png$/i.test(name))
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }))
    .map((name) => path.join(outputDirectory, name));
}

/**
 * Encodes an animated GIF from PNG frames with per-frame durations via FFmpeg.
 * @param {{framePaths:string[],durations:number[],outputPath:string,ffmpegBinary?:string}} job Encode job.
 * @returns {Promise<void>}
 */
async function encodeGifWithFfmpeg(job) {
  const escapePath = (filePath) => filePath.replace(/'/g, "'\\''");
  const lines = ["ffconcat version 1.0"];
  job.framePaths.forEach((framePath, index) => {
    const duration = Number(job.durations?.[index]);
    if (!Number.isFinite(duration)) {
      throw new Error(`GIF duration is missing for frame ${index + 1}.`);
    }
    lines.push(`file '${escapePath(framePath)}'`);
    // A 1/100s image timebase matches GIF delay resolution; the default 1/25 rounds delays to 40ms.
    lines.push("option framerate 100");
    lines.push(`duration ${Math.max(0.001, duration).toFixed(6)}`);
  });
  // The concat demuxer ignores the trailing duration unless the last frame repeats.
  lines.push(`file '${escapePath(job.framePaths[job.framePaths.length - 1])}'`);
  lines.push("option framerate 100");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-gif-"));
  const concatPath = path.join(tempDir, "frames.ffconcat");
  try {
    fs.writeFileSync(concatPath, `${lines.join("\n")}\n`);
    await execFileAsync(
      job.ffmpegBinary || process.env.XSXB_FFMPEG || "ffmpeg",
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        concatPath,
        "-filter_complex",
        "[0:v]split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse=alpha_threshold=128",
        "-loop",
        "0",
        job.outputPath,
      ],
      { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
    );
  } catch (error) {
    throw new Error(
      `FFmpeg GIF export failed (install ffmpeg or set XSXB_FFMPEG): ${error.stderr || error.message}`,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Encodes a short PCM WAV tone for deterministic SFX integration tests.
 * @param {{frequency?:number,durationMs?:number,sampleRate?:number}} [options] Tone properties.
 * @returns {Buffer} Complete mono 16-bit WAV file.
 */
function createTestWav(options = {}) {
  const sampleRate = Math.max(8000, Number(options.sampleRate || 22050));
  const durationMs = Math.max(20, Math.min(1000, Number(options.durationMs || 120)));
  const frequency = Math.max(20, Math.min(4000, Number(options.frequency || 440)));
  const sampleCount = Math.max(1, Math.round((sampleRate * durationMs) / 1000));
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const envelope = Math.max(0, 1 - index / sampleCount);
    const sample = Math.round(Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 6000 * envelope);
    buffer.writeInt16LE(sample, 44 + index * 2);
  }
  return buffer;
}

module.exports = {
  createTestWav,
  encodeGifWithFfmpeg,
  extractVideoFrames,
  videoExtractFfmpegArgs,
};
