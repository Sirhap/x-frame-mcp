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
 * Parses a clock (`HH:MM:SS.xx`) or raw seconds value.
 * @param {unknown} value Duration text.
 * @returns {number|undefined} Seconds when finite and positive.
 */
function parseDurationSeconds(value) {
  const text = String(value || "").trim();
  const clock = text.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (clock) {
    const seconds = Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  }
  const numeric = Number(text);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

/**
 * Parses a container rate (`30/1`, `30000/1001`, or `30`).
 * @param {unknown} value Rate text.
 * @returns {number|undefined} Frames per second when finite and positive.
 */
function parseFrameRate(value) {
  const text = String(value || "").trim();
  const fraction = text.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (fraction) {
    const denominator = Number(fraction[2]);
    const fps = denominator ? Number(fraction[1]) / denominator : NaN;
    return Number.isFinite(fps) && fps > 0 ? fps : undefined;
  }
  const numeric = Number(text);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

/**
 * Keeps a suggested import fps only when it is a sane 1–60 playback rate.
 * Values within half a frame of an integer snap to that integer.
 * @param {unknown} value Candidate fps.
 * @returns {number|undefined} Sanitized fps, or undefined when unusable.
 */
function sanitizeSuggestedFps(value) {
  const fps = Number(value);
  if (!Number.isFinite(fps) || fps < 1 || fps > 60) return undefined;
  const nearest = Math.round(fps);
  if (Math.abs(fps - nearest) <= 0.51 && nearest >= 1 && nearest <= 60) return nearest;
  return Math.round(fps * 100) / 100;
}

/**
 * Suggests animation fps from extracted frame count, source duration, or a probed rate.
 * Count/duration wins when both are known so a 30-frame/1s extract is 30, not 12.
 * @param {{sourceFrameCount?:unknown,sourceDurationSec?:unknown,probedFps?:unknown}} [timing]
 *   Extracted count, probed duration, and optional container fps.
 * @returns {number|undefined} Suggested fps in 1–60, or undefined when unknown/out of range.
 */
function suggestImportFps(timing = {}) {
  const count = Number(timing.sourceFrameCount);
  const duration = Number(timing.sourceDurationSec);
  if (Number.isFinite(count) && count > 0 && Number.isFinite(duration) && duration > 0) {
    const fromCount = sanitizeSuggestedFps(count / duration);
    if (fromCount !== undefined) return fromCount;
  }
  return sanitizeSuggestedFps(timing.probedFps);
}

/**
 * Resolves the imported clip duration from an explicit window or a probe.
 * @param {{start_time?:unknown,duration?:unknown}} [options] Extract window.
 * @param {{sourceDurationSec?:unknown}} [probed] File-level probe.
 * @returns {number|undefined} Seconds covering the extracted frames, when known.
 */
function resolveSourceDurationSec(options = {}, probed = {}) {
  if (options.duration !== undefined && options.duration !== null && options.duration !== "") {
    return parseDurationSeconds(options.duration);
  }
  const probedDuration = parseDurationSeconds(probed.sourceDurationSec);
  if (probedDuration === undefined) return undefined;
  if (options.start_time !== undefined && options.start_time !== null && options.start_time !== "") {
    const start = Number(options.start_time);
    if (Number.isFinite(start) && start > 0) {
      const remaining = probedDuration - start;
      return remaining > 0 ? remaining : undefined;
    }
  }
  return probedDuration;
}

/**
 * Reads duration / frame count / fps from ffprobe JSON.
 * @param {string} text ffprobe stdout.
 * @returns {{sourceDurationSec?:number,sourceFrameCount?:number,probedFps?:number}} Probe fields.
 */
function parseFfprobeJson(text) {
  try {
    const parsed = JSON.parse(String(text || "{}"));
    const stream = Array.isArray(parsed.streams) ? parsed.streams[0] || {} : {};
    const format = parsed.format && typeof parsed.format === "object" ? parsed.format : {};
    const sourceDurationSec = parseDurationSeconds(stream.duration) || parseDurationSeconds(format.duration);
    const frames = Number(stream.nb_frames);
    const sourceFrameCount = Number.isFinite(frames) && frames > 0 ? frames : undefined;
    const probedFps = parseFrameRate(stream.avg_frame_rate) || parseFrameRate(stream.r_frame_rate);
    return { sourceDurationSec, sourceFrameCount, probedFps };
  } catch {
    return {};
  }
}

/**
 * Reads duration and fps from `ffmpeg -i` banner text.
 * @param {string} text ffmpeg stderr/stdout.
 * @returns {{sourceDurationSec?:number,probedFps?:number}} Probe fields.
 */
function parseFfmpegProbeText(text) {
  const blob = String(text || "");
  const durationMatch = blob.match(/Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/);
  const fpsMatch = blob.match(/(\d+(?:\.\d+)?)\s*fps\b/i) || blob.match(/(\d+(?:\.\d+)?)\s*tbr\b/i);
  return {
    sourceDurationSec: durationMatch ? parseDurationSeconds(durationMatch[1]) : undefined,
    probedFps: fpsMatch ? parseFrameRate(fpsMatch[1]) : undefined,
  };
}

/**
 * Derives an ffprobe binary next to a named ffmpeg binary.
 * @param {string} ffmpegPath ffmpeg command or absolute path.
 * @returns {string} ffprobe command or sibling path.
 */
function ffprobeBinaryFor(ffmpegPath) {
  const ffmpeg = String(ffmpegPath || "ffmpeg");
  if (ffmpeg === "ffmpeg" || path.basename(ffmpeg) === "ffmpeg") {
    return ffmpeg === "ffmpeg" ? "ffprobe" : path.join(path.dirname(ffmpeg), "ffprobe");
  }
  return ffmpeg.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
}

/**
 * Probes source duration, frame count, and container fps when ffmpeg/ffprobe can read the file.
 * Fail-soft: unreadable files return empty fields so stub imports still default to 12.
 * @param {string} videoPath Absolute input video path.
 * @param {{ffmpegBinary?:string,ffprobeBinary?:string}} [options] Binary overrides.
 * @returns {Promise<{sourceDurationSec?:number,sourceFrameCount?:number,probedFps?:number}>}
 *   Known timing fields.
 */
async function probeVideoTiming(videoPath, options = {}) {
  const ffmpeg = options.ffmpegBinary || process.env.XSXB_FFMPEG || "ffmpeg";
  const ffprobe = options.ffprobeBinary || process.env.XSXB_FFPROBE || ffprobeBinaryFor(ffmpeg);
  try {
    const { stdout } = await execFileAsync(
      ffprobe,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=nb_frames,duration,avg_frame_rate,r_frame_rate",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        videoPath,
      ],
      { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 },
    );
    const probed = parseFfprobeJson(stdout);
    if (probed.sourceDurationSec || probed.sourceFrameCount || probed.probedFps) return probed;
  } catch {
    // Fall through to ffmpeg -i. Missing ffprobe or unreadable files are not fatal.
  }
  try {
    await execFileAsync(ffmpeg, ["-hide_banner", "-i", videoPath], {
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return {};
  } catch (error) {
    if (error.killed) return {};
    return parseFfmpegProbeText(`${error.stderr || ""}\n${error.stdout || ""}`);
  }
}

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
  let lastDurationSec = 0.001;
  job.framePaths.forEach((framePath, index) => {
    const duration = Number(job.durations?.[index]);
    if (!Number.isFinite(duration)) {
      throw new Error(`GIF duration is missing for frame ${index + 1}.`);
    }
    lastDurationSec = Math.max(0.001, duration);
    lines.push(`file '${escapePath(framePath)}'`);
    // A 1/100s image timebase matches GIF delay resolution; the default 1/25 rounds delays to 40ms.
    lines.push("option framerate 100");
    lines.push(`duration ${lastDurationSec.toFixed(6)}`);
  });
  // Concat ignores the last duration. GIF `-final_delay` (centiseconds) keeps it
  // without repeating the last file, so ffprobe nb_frames matches framePaths.length.
  const finalDelayCs = Math.max(1, Math.round(lastDurationSec * 100));
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
        "-final_delay",
        String(finalDelayCs),
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
  probeVideoTiming,
  resolveSourceDurationSec,
  suggestImportFps,
  videoExtractFfmpegArgs,
};
