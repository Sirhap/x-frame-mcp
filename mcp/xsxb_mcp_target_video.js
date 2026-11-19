"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { extractVideoFrames } = require("./xsxb_mcp_processes");
const { analyzePngFiles } = require("./xsxb_mcp_loop");
const { decodePngRgba } = require("./xsxb_mcp_cutout");
const { detectBackgroundColor } = require("./lib/animation_tuner/public/scatter_slice_smart_cutout");

const execute = promisify(execFile);
const ffmpeg = () => process.env.XSXB_FFMPEG || "ffmpeg";
const options = { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 };

/** Reads stream metadata without decoding or registering the target as an animation. */
async function probe(file) {
  const binary = process.env.XSXB_FFPROBE || path.join(path.dirname(ffmpeg()), "ffprobe");
  const { stdout } = await execute(binary, ["-v", "error", "-show_streams", "-of", "json", file], options);
  const streams = JSON.parse(stdout).streams;
  const video = streams.find((stream) => stream.codec_type === "video" && !stream.disposition?.attached_pic);
  if (!video) throw new Error("The target contains no video frames.");
  return { video, streams };
}

/** Uses the same border color estimator as PNG cutout when no video key was specified. */
async function videoKey(file, stream, temp) {
  const first = path.join(temp, "key.png");
  await execute(
    ffmpeg(),
    ["-v", "error", "-i", file, "-map", `0:${stream.index}`, "-frames:v", "1", first],
    options,
  );
  const frame = decodePngRgba(first);
  const { r, g, b } = detectBackgroundColor(frame.data, frame.width, frame.height);
  return "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
}

/** Edits the selected video stream. Other streams are remuxed, including audio and subtitles. */
async function editVideoTarget(file, args, temp, assertCurrent) {
  const { video, streams } = await probe(file);
  const info = {
    source: "video",
    file_path: file,
    width: video.width,
    height: video.height,
    fps: video.avg_frame_rate,
    frameCount: Number(video.nb_frames) || null,
    audioStreams: streams.filter((stream) => stream.codec_type === "audio").length,
  };
  if (args.operation === "inspect") return info;
  if (args.operation === "analyze") {
    const frames = await extractVideoFrames(file, temp, { streamIndex: video.index });
    const { images, ...analysis } = analyzePngFiles(frames);
    return { ...info, frameCount: frames.length, analysis };
  }
  const cutout = args.operation === "cutout";
  const alphaContainers = [".mov", ".mkv"];
  const ext = path.extname(file).toLowerCase();
  const defaultOutput =
    cutout && !alphaContainers.includes(ext)
      ? path.join(path.dirname(file), path.parse(file).name + "_cut.mov")
      : file;
  const requested = path.resolve(args.output_path || defaultOutput);
  const output = fs.existsSync(requested) ? fs.realpathSync(requested) : requested;
  const outExt = path.extname(output).toLowerCase();
  if (cutout && !alphaContainers.includes(outExt))
    throw new Error("Video cutout needs an alpha-capable .mov or .mkv output_path.");
  if (!args.output_path && output !== file && fs.existsSync(output))
    throw new Error(`Output already exists: ${output}. Supply output_path to choose the destination.`);
  const result = { ...info, output_path: output, dryRun: args.dry_run !== false };
  if (result.dryRun) return result;
  const key = cutout ? args.key_color || (await videoKey(file, video, temp)) : null;
  // Multiply the new matte by the original alpha to retain transparent foreground edges.
  const filter = cutout
    ? `format=rgba,split[original][input];[original]alphaextract[old];[input]colorkey=0x${key.slice(1)}:0.1:0,split[color][matte];[matte]alphaextract[keyed];[old][keyed]blend=all_mode=multiply[alpha];[color][alpha]alphamerge,format=rgba`
    : "hflip";
  const transcodeContainer = cutout || outExt !== ext;
  const codec =
    transcodeContainer && outExt === ".mov"
      ? "png"
      : transcodeContainer && outExt === ".mkv"
        ? "ffv1"
        : video.codec_name;
  // Absolute stream index is preserved by -map 0. Keep all non-target streams bit-for-bit.
  const stream = String(video.index);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(output), ".xsxb-video-"));
  const staged = path.join(staging, `output${outExt}`);
  try {
    await execute(
      ffmpeg(),
      [
        "-v",
        "error",
        "-nostdin",
        "-copyts",
        "-noautorotate",
        "-i",
        file,
        "-map",
        "0",
        "-map_metadata",
        "0",
        "-map_chapters",
        "0",
        "-c",
        "copy",
        "-filter:" + stream,
        filter,
        "-c:" + stream,
        codec,
        "-fps_mode:" + stream,
        "passthrough",
        "-enc_time_base:" + stream,
        "demux",
        staged,
      ],
      options,
    );
    assertCurrent();
    if (fs.existsSync(output)) fs.chmodSync(staged, fs.statSync(output).mode);
    if (output !== file && !args.output_path) fs.linkSync(staged, output);
    else fs.renameSync(staged, output);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return { ...result, pipeline: cutout ? "ffmpeg_colorkey" : "ffmpeg_hflip", keyColor: key };
}
module.exports = { editVideoTarget };
