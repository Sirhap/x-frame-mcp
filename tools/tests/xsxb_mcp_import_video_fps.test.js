"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createXsxbMcpService } = require("../../mcp/xsxb_mcp_service");
const { encodePngRgba } = require("../../mcp/xsxb_mcp_cutout");
const { probeVideoTiming, suggestGameFps, suggestImportFps } = require("../../mcp/xsxb_mcp_processes");
const { toolDefinitions } = require("../../mcp/xsxb_mcp_tool_catalog");

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
 * Builds one lavfi MP4 with a known frame rate and duration.
 * @param {string} filePath Destination path.
 * @param {{fps?:number,durationSec?:number}} [options] Generator options.
 * @returns {void}
 */
function writeLavfiVideo(filePath, options = {}) {
  const fps = Number(options.fps || 30);
  const durationSec = Number(options.durationSec || 1);
  execFileSync(
    process.env.XSXB_FFMPEG || "ffmpeg",
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=green:s=32x32:r=${fps}:d=${durationSec}`,
      "-pix_fmt",
      "yuv420p",
      filePath,
    ],
    { timeout: 20_000 },
  );
}

/**
 * Runs a public video import against a disposable Godot project.
 * @param {Function} operation Test body.
 * @param {{extractVideoFramesImpl?:Function,videoBytes?:string}} [options] Service overrides.
 * @returns {Promise<void>} Completion with temporary data removed.
 */
async function withImportProject(operation, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-import-fps-"));
  const game = path.join(root, "game");
  fs.mkdirSync(game);
  fs.writeFileSync(path.join(game, "project.godot"), '[application]\nconfig/name="Fps"\n');
  const video = path.join(root, "clip.mp4");
  if (options.videoBytes !== undefined) fs.writeFileSync(video, options.videoBytes);
  const service = createXsxbMcpService({
    root,
    florenceDetectImpl: null,
    ...(options.extractVideoFramesImpl ? { extractVideoFramesImpl: options.extractVideoFramesImpl } : {}),
  });
  const call = async (name, args = {}) => (await service.callMcp(name, args)).data;
  try {
    await call("xsxb_create_project", { project_id: "fps", project_root: game });
    await operation({ root, game, video, call });
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("suggestImportFps uses extracted count over duration when both are known", () => {
  assert.equal(suggestImportFps({ sourceFrameCount: 30, sourceDurationSec: 1 }), 30);
  assert.equal(suggestImportFps({ sourceFrameCount: 60, sourceDurationSec: 2 }), 30);
  assert.equal(suggestImportFps({ sourceFrameCount: 24, sourceDurationSec: 1 }), 24);
});

test("suggestImportFps stays undefined outside the sane 1-60 import range", () => {
  assert.equal(suggestImportFps({ sourceFrameCount: 90, sourceDurationSec: 1 }), undefined);
  assert.equal(suggestImportFps({ sourceFrameCount: 30, sourceDurationSec: 0 }), undefined);
  assert.equal(suggestImportFps({ sourceFrameCount: 0, sourceDurationSec: 1 }), undefined);
  assert.equal(suggestImportFps({}), undefined);
});

test("suggestImportFps falls back to a probed container rate", () => {
  assert.equal(suggestImportFps({ probedFps: 30 }), 30);
  assert.equal(suggestImportFps({ probedFps: 120 }), undefined);
});

test("suggestGameFps maps source rate onto the 8-12 game-loop band", () => {
  assert.equal(suggestGameFps(24), 8);
  assert.equal(suggestGameFps(30), 8);
  assert.equal(suggestGameFps(10), 10);
  assert.equal(suggestGameFps(8), 8);
  assert.equal(suggestGameFps(12), 12);
  assert.equal(suggestGameFps(6), 8);
  assert.equal(suggestGameFps(1), 8);
});

test("xsxb_import_video catalog names source and game fps on the receipt", () => {
  const video = toolDefinitions().find((entry) => entry.name === "xsxb_import_video");
  assert.match(video.description, /suggestedFps \(source\)/);
  assert.match(video.description, /suggestedGameFps \(8–12 for GIF\/Godot loops\)/);
  assert.match(video.description, /Pass fps=suggestedGameFps/);
});

/**
 * Writes a numbered 1×1 PNG sequence.
 * @param {string} directory Sequence directory.
 * @param {number} count Frame count.
 * @returns {string[]} Absolute PNG paths.
 */
function writePngSequence(directory, count) {
  fs.mkdirSync(directory, { recursive: true });
  const files = [];
  for (let index = 1; index <= count; index += 1) {
    const filePath = path.join(directory, `${String(index).padStart(2, "0")}.png`);
    const rgba = new Uint8ClampedArray([10 + index, 20, 30, 255]);
    fs.writeFileSync(filePath, encodePngRgba(rgba, 1, 1));
    files.push(filePath);
  }
  return files;
}

test("import_replace_preserves_manifest_fps_when_fps_omitted", async () => {
  await withImportProject(async ({ call, root, game }) => {
    const omitDir = path.join(root, "omit-first");
    writePngSequence(omitDir, 2);
    const firstOmit = await call("xsxb_import_animation", {
      source: "png_sequence",
      directory: omitDir,
      animation_id: "fresh",
    });
    assert.equal(firstOmit.fps, 12, "first-import omit still defaults to 12");

    const firstDir = path.join(root, "first");
    writePngSequence(firstDir, 2);
    const imported = await call("xsxb_import_animation", {
      source: "png_sequence",
      directory: firstDir,
      animation_id: "walk",
      fps: 24,
    });
    assert.equal(imported.fps, 24);
    assert.equal(imported.importedFrameCount, 2);

    const secondDir = path.join(root, "second");
    writePngSequence(secondDir, 3);
    const replaced = await call("xsxb_import_animation", {
      source: "png_sequence",
      directory: secondDir,
      animation_id: "walk",
      replace: true,
    });
    assert.equal(replaced.replaced, true);
    assert.equal(replaced.importedFrameCount, 3);
    assert.equal(replaced.fps, 24);

    const stored = await call("xsxb_get_animation", { animation_id: "walk" });
    assert.equal(Number(stored.animation.fps), 24);

    const manifestPath = path.join(game, ".x-frame", "data", "projects", "fps", "animation_manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const walk = (manifest.profiles || [])
      .flatMap((profile) => profile.animations || [])
      .find((entry) => String(entry.id || entry.name) === "walk");
    assert.equal(Number(walk.fps), 24);
  });
});

test("import_replace_preserves_manifest_type_when_animation_type_omitted", async () => {
  await withImportProject(async ({ call, root, game }) => {
    const omitDir = path.join(root, "omit-type-first");
    writePngSequence(omitDir, 2);
    const firstOmit = await call("xsxb_import_animation", {
      source: "png_sequence",
      directory: omitDir,
      animation_id: "fresh",
    });
    assert.equal(firstOmit.animationType, "actor", "first-import omit still defaults to actor");

    const firstDir = path.join(root, "vfx-first");
    writePngSequence(firstDir, 2);
    const imported = await call("xsxb_import_animation", {
      source: "png_sequence",
      directory: firstDir,
      animation_id: "spark",
      animation_type: "vfx",
    });
    assert.equal(imported.animationType, "vfx");
    assert.equal(imported.importedFrameCount, 2);

    const secondDir = path.join(root, "vfx-second");
    writePngSequence(secondDir, 3);
    const replaced = await call("xsxb_import_animation", {
      source: "png_sequence",
      directory: secondDir,
      animation_id: "spark",
      replace: true,
    });
    assert.equal(replaced.replaced, true);
    assert.equal(replaced.importedFrameCount, 3);
    assert.equal(replaced.animationType, "vfx");

    const stored = await call("xsxb_get_animation", { animation_id: "spark" });
    assert.equal(stored.animation.type, "vfx");

    const manifestPath = path.join(game, ".x-frame", "data", "projects", "fps", "animation_manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const spark = (manifest.profiles || [])
      .flatMap((profile) => profile.animations || [])
      .find((entry) => String(entry.id || entry.name) === "spark");
    assert.equal(spark.type, "vfx");
  });
});

test("import_video fps schema has no injected default so omit stores the probed source rate", () => {
  const video = toolDefinitions().find((entry) => entry.name === "xsxb_import_video");
  const fps = video.inputSchema.properties.fps;
  assert.equal(
    fps.default,
    undefined,
    "schema default 12 is injected as an explicit fps and skips the probe-on-omit path",
  );
  assert.match(fps.description, /Omit to store the probed source rate/);
});

test("import_animation fps schema has no injected default so video omit stores the probed source rate", () => {
  const animation = toolDefinitions().find((entry) => entry.name === "xsxb_import_animation");
  const fps = animation.inputSchema.properties.fps;
  assert.equal(
    fps.default,
    undefined,
    "schema default 12 is injected as an explicit fps and skips importVideo probe-on-omit",
  );
  assert.match(fps.description, /probed source rate/);
});

test("xsxb_export_gif catalog tells video imports to pass suggestedGameFps", () => {
  const gif = toolDefinitions().find((entry) => entry.name === "xsxb_export_gif");
  assert.match(gif.description, /imported from video at camera rate/);
  assert.match(gif.description, /fps=suggestedGameFps/);
  assert.match(gif.inputSchema.properties.fps.description, /suggestedGameFps/);
});

test("import_video without fps stays 12 when source timing cannot be probed", async () => {
  await withImportProject(
    async ({ call, video }) => {
      const imported = await call("xsxb_import_video", { file_path: video, animation_id: "walk" });
      assert.equal(imported.sourceFrameCount, 3);
      assert.equal(imported.fps, 12);
      assert.equal(imported.suggestedFps, undefined);
      assert.equal(imported.suggestedGameFps, undefined);
      assert.equal(imported.next, undefined);
      assert.equal(imported.sourceDurationSec, undefined);
      const stored = await call("xsxb_get_animation", { animation_id: "walk" });
      assert.equal(Number(stored.animation.fps), 12);
    },
    {
      videoBytes: "not a real video",
      extractVideoFramesImpl: async (_video, directory) => {
        return [0, 1, 2].map((index) => {
          const file = path.join(directory, `frame_${String(index + 1).padStart(6, "0")}.png`);
          const rgba = new Uint8ClampedArray(4);
          rgba.set([10 + index, 20, 30, 255]);
          fs.writeFileSync(file, encodePngRgba(rgba, 1, 1));
          return file;
        });
      },
    },
  );
});

test("import_video receipt includes suggestedFps and suggestedGameFps", async () => {
  await withImportProject(
    async ({ call, video }) => {
      const imported = await call("xsxb_import_video", {
        file_path: video,
        animation_id: "walk",
        duration: 0.125,
      });
      assert.equal(imported.sourceFrameCount, 3);
      assert.equal(imported.suggestedFps, 24);
      assert.equal(imported.suggestedGameFps, 8);
      assert.match(String(imported.next), /suggestedGameFps/);
      assert.equal(imported.fps, imported.suggestedFps);
      const stored = await call("xsxb_get_animation", { animation_id: "walk" });
      assert.equal(Number(stored.animation.fps), 24);
    },
    {
      videoBytes: "not a real video",
      extractVideoFramesImpl: async (_video, directory) => {
        return [0, 1, 2].map((index) => {
          const file = path.join(directory, `frame_${String(index + 1).padStart(6, "0")}.png`);
          const rgba = new Uint8ClampedArray(4);
          rgba.set([10 + index, 20, 30, 255]);
          fs.writeFileSync(file, encodePngRgba(rgba, 1, 1));
          return file;
        });
      },
    },
  );
});

test("probeVideoTiming reads lavfi duration and frame rate", { skip: FFMPEG_SKIP }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-probe-fps-"));
  const video = path.join(folder, "clip.mp4");
  try {
    writeLavfiVideo(video, { fps: 30, durationSec: 1 });
    const probed = await probeVideoTiming(video);
    assert.ok(probed.sourceDurationSec > 0.8 && probed.sourceDurationSec < 1.2, probed);
    assert.ok(
      (Number.isFinite(probed.sourceFrameCount) && probed.sourceFrameCount >= 28) ||
        (Number.isFinite(probed.probedFps) && probed.probedFps >= 28 && probed.probedFps <= 32),
      probed,
    );
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("import_video without fps uses the probed 30fps source rate", { skip: FFMPEG_SKIP }, async () => {
  await withImportProject(async ({ call, video }) => {
    writeLavfiVideo(video, { fps: 30, durationSec: 1 });
    const imported = await call("xsxb_import_video", { file_path: video, animation_id: "clip" });
    assert.ok(imported.sourceFrameCount >= 28 && imported.sourceFrameCount <= 32, imported);
    assert.ok(imported.sourceDurationSec > 0.8 && imported.sourceDurationSec < 1.2, imported);
    assert.ok(imported.suggestedFps >= 28 && imported.suggestedFps <= 32, imported);
    assert.equal(imported.suggestedGameFps, 8, imported);
    assert.equal(imported.fps, imported.suggestedFps);
    assert.notEqual(imported.fps, 12);
    const stored = await call("xsxb_get_animation", { animation_id: "clip" });
    assert.equal(Number(stored.animation.fps), imported.fps);
  });
});

test("import_animation video omit uses the probed 30fps source rate", { skip: FFMPEG_SKIP }, async () => {
  await withImportProject(async ({ call, video }) => {
    writeLavfiVideo(video, { fps: 30, durationSec: 1 });
    const imported = await call("xsxb_import_animation", {
      source: "video",
      file_path: video,
      animation_id: "clip",
    });
    assert.ok(imported.suggestedFps >= 28 && imported.suggestedFps <= 32, imported);
    assert.equal(imported.fps, imported.suggestedFps);
    assert.notEqual(imported.fps, 12);
    const stored = await call("xsxb_get_animation", { animation_id: "clip" });
    assert.equal(Number(stored.animation.fps), imported.fps);
  });
});

test("import_video keeps an explicit fps and still reports suggestedFps", { skip: FFMPEG_SKIP }, async () => {
  await withImportProject(async ({ call, video }) => {
    writeLavfiVideo(video, { fps: 30, durationSec: 1 });
    const imported = await call("xsxb_import_video", {
      file_path: video,
      animation_id: "clip",
      fps: 12,
    });
    assert.equal(imported.fps, 12);
    assert.ok(imported.suggestedFps >= 28 && imported.suggestedFps <= 32, imported);
    assert.equal(imported.suggestedGameFps, 8, imported);
    assert.ok(imported.sourceFrameCount >= 28, imported);
    const stored = await call("xsxb_get_animation", { animation_id: "clip" });
    assert.equal(Number(stored.animation.fps), 12);
  });
});
