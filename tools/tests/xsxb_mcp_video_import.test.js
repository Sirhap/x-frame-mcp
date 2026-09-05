"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const test = require("node:test");
const { createXsxbMcpService } = require("../../mcp/xsxb_mcp_service");
const { createProjectStore } = require("../../mcp/lib/project_store");
const { encodePngRgba } = require("../../mcp/xsxb_mcp_cutout");

/**
 * Creates distinct PNGs with partial alpha so equality checks cover frame order.
 * @returns {Buffer[]} Encoded source frames.
 */
function sourceFrames() {
  return [0, 1, 2].map((index) => {
    const rgba = new Uint8ClampedArray(8 * 8 * 4);
    for (let y = 2; y < 6; y += 1) {
      for (let x = 2; x < 6; x += 1)
        rgba.set([40 + index * 60, 100, 150, y === 2 ? 128 : 255], (y * 8 + x) * 4);
    }
    return encodePngRgba(rgba, 8, 8);
  });
}

/**
 * Runs a public video import scenario in a disposable Godot project.
 * @param {Function} operation Test body.
 * @returns {Promise<void>} Completion with all temporary data removed.
 */
async function withVideoProject(operation) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-video-import-"));
  const game = path.join(root, "game");
  fs.mkdirSync(game);
  fs.writeFileSync(path.join(game, "project.godot"), '[application]\nconfig/name="Video"\n');
  const video = path.join(root, "clip.mp4");
  fs.writeFileSync(video, "stubbed extraction");
  const frames = sourceFrames();
  const extraction = { mode: "valid", directories: [], files: [] };
  const service = createXsxbMcpService({
    root,
    florenceDetectImpl: null,
    extractVideoFramesImpl: async (_video, directory) => {
      extraction.directories.push(directory);
      if (extraction.mode === "extract-error") throw new Error("injected extraction failure");
      extraction.files = frames.map((bytes, index) => {
        const file = path.join(directory, `frame_${index}.png`);
        if (index !== 1 || extraction.mode !== "missing") {
          fs.writeFileSync(file, index === 1 && extraction.mode === "corrupt" ? "not a PNG" : bytes);
        }
        return file;
      });
      return extraction.files;
    },
  });
  const call = async (name, args = {}) => (await service.callMcp(name, args)).data;
  try {
    await call("xsxb_create_project", { project_id: "video", project_root: game });
    const store = createProjectStore(root);
    const paths = store.projectPaths(store.activeProject("video"));
    await operation({ root, game, video, frames, extraction, paths, call });
    for (const directory of extraction.directories) assert.equal(fs.existsSync(directory), false);
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Hashes file bytes to compare encoding as well as decoded pixels.
 * @param {Buffer} bytes File bytes.
 * @returns {string} SHA-256 digest.
 */
function digest(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

test("video frame import does not encode PNG bytes as base64", async () => {
  await withVideoProject(async ({ call, video }) => {
    const toString = Buffer.prototype.toString;
    Buffer.prototype.toString = function (encoding, ...args) {
      if (encoding === "base64" && this.length >= 8 && this[0] === 137 && this[1] === 80) {
        throw new Error("unnecessary PNG base64 encoding");
      }
      return toString.call(this, encoding, ...args);
    };
    try {
      const result = await call("xsxb_import_video", { file_path: video, animation_id: "walk" });
      assert.equal(result.importedFrameCount, 3);
    } finally {
      Buffer.prototype.toString = toString;
    }
  });
});

test("video and base64 imports produce equal frame bytes, metadata, tuning and Godot output", async () => {
  const snapshots = [];
  for (const source of ["video", "base64"]) {
    await withVideoProject(async ({ call, video, frames, paths, game, root }) => {
      const common = {
        animation_id: "walk",
        profile_id: "hero",
        fps: 24,
        start_frame: 1,
        end_frame: 2,
        sync: true,
        validate: true,
      };
      const imported =
        source === "video"
          ? await call("xsxb_import_animation", { ...common, source: "video", file_path: video })
          : await call("xsxb_import_animation", {
              ...common,
              source: "items",
              items: frames.map((bytes) => ({ data: `data:image/png;base64,${bytes.toString("base64")}` })),
            });
      assert.equal(imported.importedFrameCount, 2);
      assert.equal(imported.sync.ok, true);
      const current = await call("xsxb_get_animation", { animation_id: "walk" });
      const hashes = current.animation.frames.map((frame) => digest(fs.readFileSync(frame.absolutePath)));
      assert.deepEqual(hashes, frames.slice(1).map(digest));
      const syncManifest = JSON.parse(
        fs.readFileSync(
          path.join(game, "xsxb_frame_tuner/data/projects/video/animation_manifest.json"),
          "utf8",
        ),
      );
      const synced = syncManifest.profiles[0].animations[0].frames.map((frame) =>
        digest(fs.readFileSync(path.join(game, frame.path))),
      );
      assert.deepEqual(synced, hashes);
      /** Removes only fixture-dependent absolute paths from persisted JSON. */
      const normalized = (file) => JSON.parse(fs.readFileSync(file, "utf8").split(root).join("<root>"));
      snapshots.push({
        manifest: normalized(paths.manifest),
        tuning: normalized(paths.tuning),
        hashes,
        syncManifest,
      });
    });
  }
  assert.deepEqual(snapshots[0], snapshots[1]);
});

for (const mode of ["missing", "corrupt", "extract-error"]) {
  test(`failed video replacement preserves existing data and cleans temporary files: ${mode}`, async () => {
    await withVideoProject(async ({ call, video, extraction, paths }) => {
      await call("xsxb_import_video", { file_path: video, animation_id: "keep" });
      await call("xsxb_update_timing", { frame: 0, duration: 2 });
      const current = await call("xsxb_get_animation");
      const files = current.animation.frames.map((frame) => frame.absolutePath);
      const originals = [...files, paths.manifest, paths.tuning].map((file) => fs.readFileSync(file));
      extraction.mode = mode;
      await assert.rejects(
        call("xsxb_import_video", { file_path: video, animation_id: "keep", replace: true }),
      );
      [...files, paths.manifest, paths.tuning].forEach((file, index) =>
        assert.deepEqual(fs.readFileSync(file), originals[index]),
      );
      const parent = path.dirname(path.dirname(files[0]));
      assert.equal(
        fs.readdirSync(parent).some((name) => /\.(import|backup)-/.test(name)),
        false,
      );
    });
  });
}

test("video replacement rolls back frames if the manifest commit fails", async () => {
  await withVideoProject(async ({ call, video, paths }) => {
    await call("xsxb_import_video", { file_path: video, animation_id: "keep" });
    const current = await call("xsxb_get_animation");
    const files = [
      ...current.animation.frames.map((frame) => frame.absolutePath),
      paths.manifest,
      paths.tuning,
    ];
    const originals = files.map((file) => fs.readFileSync(file));
    const rename = fs.renameSync;
    let failed = false;
    fs.renameSync = (source, target) => {
      if (target === paths.manifest && !failed) {
        failed = true;
        throw new Error("injected commit failure");
      }
      return rename(source, target);
    };
    try {
      await assert.rejects(
        call("xsxb_import_video", { file_path: video, animation_id: "keep", replace: true, start_frame: 1 }),
        /injected commit failure/,
      );
    } finally {
      fs.renameSync = rename;
    }
    assert.equal(failed, true);
    files.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), originals[index]));
  });
});
