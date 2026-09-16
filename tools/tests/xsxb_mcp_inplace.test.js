"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createProjectStore, FRAME_STORE_DIR } = require("../project_store");
const { createXsxbMcpService, toolDefinitions } = require("../xsxb_mcp_service");
const { encodePngRgba } = require("../xsxb_mcp_cutout");

const ONE_PIXEL_PNG = encodePngRgba(new Uint8ClampedArray([255, 255, 255, 255]), 1, 1);

/**
 * Isolated tuner root plus MCP service.
 * @returns {{root:string,service:object,cleanup:Function}} Fixture.
 */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-mcp-inplace-"));
  const godotRoot = path.join(root, "godot");
  fs.mkdirSync(godotRoot, { recursive: true });
  fs.writeFileSync(path.join(godotRoot, "project.godot"), '[application]\nconfig/name="InPlace"\n');
  createProjectStore(root).addProject({ id: "inplace", label: "InPlace", projectRoot: godotRoot });
  return {
    root,
    godotRoot,
    service: createXsxbMcpService({ root }),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Writes a numbered PNG sequence.
 * @param {string} directory Sequence directory.
 * @param {number} [count=2] How many frames to write.
 * @returns {string[]} Absolute PNG paths.
 */
function writeSequence(directory, count = 2) {
  fs.mkdirSync(directory, { recursive: true });
  const files = [];
  for (let index = 1; index <= count; index += 1) {
    const filePath = path.join(directory, `${String(index).padStart(2, "0")}.png`);
    fs.writeFileSync(filePath, ONE_PIXEL_PNG);
    files.push(filePath);
  }
  return files;
}

/**
 * Workspace copy folder for an imported animation.
 * @param {string} root XSXB root.
 * @param {string} projectId Project id.
 * @param {string} profileId Profile id.
 * @param {string} animationId Animation id.
 * @returns {string} Absolute assets directory.
 */
function copiedAssetDir(godotRoot, projectId, profileId, animationId) {
  return path.join(
    godotRoot,
    FRAME_STORE_DIR,
    "workspace",
    "projects",
    projectId,
    "assets",
    profileId,
    animationId,
  );
}

/**
 * PNG files inside a directory.
 * @param {string} directory Folder.
 * @returns {string[]} Absolute PNG paths.
 */
function listCopiedPngs(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => name.toLowerCase().endsWith(".png"))
    .map((name) => path.join(directory, name));
}

/**
 * Whether two paths share a filesystem inode.
 * @param {string} left First path.
 * @param {string} right Second path.
 * @returns {boolean} True when both exist and share device+inode.
 */
function sameInode(left, right) {
  try {
    const a = fs.statSync(left);
    const b = fs.statSync(right);
    return a.ino === b.ino && a.dev === b.dev;
  } catch {
    return false;
  }
}

test("catalog advertises in_place on import_animation", () => {
  const tool = toolDefinitions().find((entry) => entry.name === "xsxb_import_animation");
  assert.ok(tool);
  assert.equal(tool.inputSchema.properties.in_place.type, "boolean");
  assert.equal(tool.inputSchema.properties.in_place.default, false);
  const video = toolDefinitions().find((entry) => entry.name === "xsxb_import_video");
  assert.ok(video.inputSchema.properties.in_place);
});

test("default import copies frames so deleting the source sequence still resolves", async () => {
  const current = fixture();
  try {
    const directory = path.join(current.root, "walk-seq");
    const sources = writeSequence(directory);
    const imported = await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory,
      animation_id: "walk",
    });
    assert.equal(imported.importedFrameCount, 2);
    assert.equal(imported.inPlace, false);
    const copiedDir = copiedAssetDir(
      current.godotRoot,
      imported.projectId,
      imported.profileId,
      imported.animationId,
    );
    const copies = listCopiedPngs(copiedDir);
    assert.equal(copies.length, 2);
    assert.ok(copies.every((filePath) => fs.existsSync(filePath)));
    assert.ok(
      copies.every((filePath, index) => path.resolve(filePath) !== path.resolve(sources[index])),
      "workspace copies must not be the source paths",
    );
    for (const source of sources) fs.rmSync(source, { force: true });
    fs.rmSync(directory, { recursive: true, force: true });
    const animation = await current.service.call("xsxb_get_animation", { animation_id: "walk" });
    assert.equal(animation.frameCount, 2);
    assert.ok(animation.allFramesGenerated);
    for (const frame of animation.animation.frames) {
      assert.ok(frame.exists);
      assert.ok(fs.existsSync(frame.absolutePath));
      decodeRequiresPng(frame.absolutePath);
    }
  } finally {
    current.cleanup();
  }
});

test("in_place import does not duplicate PNG bytes and still measures frames", async () => {
  const current = fixture();
  try {
    const directory = path.join(current.root, "run-seq");
    const sources = writeSequence(directory);
    const imported = await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory,
      animation_id: "run",
      in_place: true,
    });
    assert.equal(imported.importedFrameCount, 2);
    assert.equal(imported.inPlace, true);
    assert.ok(imported.metrics);
    assert.equal(imported.metrics.canvas.width, 1);
    const copiedDir = copiedAssetDir(
      current.godotRoot,
      imported.projectId,
      imported.profileId,
      imported.animationId,
    );
    const copies = listCopiedPngs(copiedDir);
    const duplicated = copies.filter((copyPath, index) => {
      const source = sources[index];
      if (!source) return true;
      return !sameInode(copyPath, source);
    });
    assert.equal(duplicated.length, 0, "in_place must not write a second full byte copy");
    const animation = await current.service.call("xsxb_get_animation", { animation_id: "run" });
    assert.equal(animation.animation.inPlace, true);
    assert.equal(animation.frameCount, 2);
    assert.ok(animation.allFramesGenerated);
    for (const [index, frame] of animation.animation.frames.entries()) {
      assert.ok(frame.exists);
      assert.equal(path.resolve(frame.absolutePath), path.resolve(sources[index]));
      decodeRequiresPng(frame.absolutePath);
    }
    const measured = await current.service.call("xsxb_measure_frames", { animation_id: "run" });
    assert.equal(measured.frames.length, 2);
    assert.equal(typeof measured.frames[0].bboxH, "number");
  } finally {
    current.cleanup();
  }
});

test("in_place import can reference a game-pack directory outside the XSXB root", async () => {
  const current = fixture();
  const pack = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-game-pack-"));
  try {
    const sources = writeSequence(pack);
    const imported = await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: pack,
      animation_id: "pack_run",
      in_place: true,
    });
    assert.equal(imported.inPlace, true);
    const animation = await current.service.call("xsxb_get_animation", { animation_id: "pack_run" });
    assert.ok(animation.allFramesGenerated);
    assert.equal(path.resolve(animation.animation.frames[0].absolutePath), path.resolve(sources[0]));
    const measured = await current.service.call("xsxb_measure_frames", { animation_id: "pack_run" });
    assert.equal(measured.frames.length, 2);
  } finally {
    current.cleanup();
    fs.rmSync(pack, { recursive: true, force: true });
  }
});

test("replacing a copied animation with in_place drops the stale workspace folder", async () => {
  const current = fixture();
  try {
    const first = path.join(current.root, "first-seq");
    writeSequence(first);
    const copied = await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: first,
      animation_id: "swap",
    });
    const copiedDir = copiedAssetDir(
      current.godotRoot,
      copied.projectId,
      copied.profileId,
      copied.animationId,
    );
    assert.ok(listCopiedPngs(copiedDir).length >= 2);
    const second = path.join(current.root, "second-seq");
    const sources = writeSequence(second);
    const replaced = await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: second,
      animation_id: "swap",
      replace: true,
      in_place: true,
    });
    assert.equal(replaced.replaced, true);
    assert.equal(replaced.inPlace, true);
    assert.equal(listCopiedPngs(copiedDir).length, 0);
    const animation = await current.service.call("xsxb_get_animation", { animation_id: "swap" });
    assert.equal(path.resolve(animation.animation.frames[0].absolutePath), path.resolve(sources[0]));
    assert.ok(animation.allFramesGenerated);
  } finally {
    current.cleanup();
  }
});

test("restore_in_place_revision_unlinks_ghost_pack_pngs", async () => {
  const current = fixture();
  const pack = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-restore-pack-"));
  try {
    const sources = writeSequence(pack, 2);
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: pack,
      animation_id: "walk",
      in_place: true,
    });
    const saved = await current.service.call("xsxb_save_revision");
    const extras = ["03.png", "04.png"].map((name) => {
      const filePath = path.join(pack, name);
      fs.writeFileSync(filePath, ONE_PIXEL_PNG);
      return filePath;
    });
    const replaced = await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: pack,
      animation_id: "walk",
      replace: true,
      in_place: true,
    });
    assert.ok(replaced.importedFrameCount >= 3);
    assert.ok(fs.existsSync(extras[0]), "03.png must exist after in_place replace grows the clip");
    assert.ok(fs.existsSync(extras[1]), "04.png must exist after in_place replace grows the clip");
    await current.service.call("xsxb_restore_revision", {
      revision_id: saved.revisionId,
      dry_run: false,
      restore_external: true,
    });
    const animation = await current.service.call("xsxb_get_animation", { animation_id: "walk" });
    assert.equal(animation.frameCount, 2);
    assert.equal(animation.animation.frames.length, 2);
    assert.ok(fs.existsSync(sources[0]), "01.png must remain after restore");
    assert.ok(fs.existsSync(sources[1]), "02.png must remain after restore");
    assert.equal(
      fs.existsSync(extras[0]),
      false,
      "03.png must be unlinked after restore to the 2-frame in_place checkpoint",
    );
    assert.equal(
      fs.existsSync(extras[1]),
      false,
      "04.png must be unlinked after restore to the 2-frame in_place checkpoint",
    );
  } finally {
    current.cleanup();
    fs.rmSync(pack, { recursive: true, force: true });
  }
});

test("import_in_place_replace_drops_stale_pack_pngs", async () => {
  const current = fixture();
  const pack = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-game-pack-"));
  try {
    const sources = writeSequence(pack, 4);
    fs.writeFileSync(path.join(pack, "notes.txt"), "keep me\n");
    const imported = await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: pack,
      animation_id: "run",
      in_place: true,
    });
    assert.equal(imported.importedFrameCount, 4);
    const replaced = await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: pack,
      animation_id: "run",
      replace: true,
      in_place: true,
      start_frame: 0,
      end_frame: 1,
    });
    assert.equal(replaced.replaced, true);
    assert.equal(replaced.importedFrameCount, 2);
    assert.ok(fs.existsSync(sources[0]), "01.png must stay as the kept source");
    assert.ok(fs.existsSync(sources[1]), "02.png must stay as the kept source");
    assert.equal(
      fs.existsSync(sources[2]),
      false,
      "03.png must be unlinked after in_place replace shrinks the clip",
    );
    assert.equal(
      fs.existsSync(sources[3]),
      false,
      "04.png must be unlinked after in_place replace shrinks the clip",
    );
    assert.ok(fs.existsSync(path.join(pack, "notes.txt")), "non-owned files in the pack dir must survive");
    const animation = await current.service.call("xsxb_get_animation", { animation_id: "run" });
    assert.equal(animation.frameCount, 2);
    assert.equal(animation.animation.frames.length, 2);
    assert.equal(path.resolve(animation.animation.frames[0].absolutePath), path.resolve(sources[0]));
    assert.equal(path.resolve(animation.animation.frames[1].absolutePath), path.resolve(sources[1]));
    assert.ok(sameInode(animation.animation.frames[0].absolutePath, sources[0]));
    assert.ok(sameInode(animation.animation.frames[1].absolutePath, sources[1]));
  } finally {
    current.cleanup();
    fs.rmSync(pack, { recursive: true, force: true });
  }
});

test("import_in_place_replace_forgets_stale_godot_ctex", async () => {
  const current = fixture();
  const pack = path.join(current.godotRoot, "sprites", "run");
  try {
    const sources = writeSequence(pack, 4);
    fs.writeFileSync(path.join(pack, "notes.txt"), "keep me\n");
    const imported = await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: pack,
      animation_id: "run",
      in_place: true,
    });
    assert.equal(imported.importedFrameCount, 4);

    const importedDir = path.join(current.godotRoot, ".godot", "imported");
    fs.mkdirSync(importedDir, { recursive: true });
    for (const pngPath of [sources[2], sources[3]]) {
      const stem = path.basename(pngPath, path.extname(pngPath));
      fs.writeFileSync(`${pngPath}.import`, `path="res://.godot/imported/${stem}.ctex"\n`);
      fs.writeFileSync(path.join(importedDir, `${stem}.ctex`), "stale-ctex");
      fs.writeFileSync(path.join(importedDir, `${stem}.md5`), "stale-md5");
    }

    const replaced = await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: pack,
      animation_id: "run",
      replace: true,
      in_place: true,
      start_frame: 0,
      end_frame: 1,
    });
    assert.equal(replaced.importedFrameCount, 2);
    assert.ok(fs.existsSync(sources[0]), "01.png must stay as the kept source");
    assert.ok(fs.existsSync(sources[1]), "02.png must stay as the kept source");
    assert.equal(
      fs.existsSync(sources[2]),
      false,
      "03.png must be unlinked after in_place replace shrinks the clip",
    );
    assert.equal(
      fs.existsSync(sources[3]),
      false,
      "04.png must be unlinked after in_place replace shrinks the clip",
    );
    assert.equal(fs.existsSync(`${sources[2]}.import`), false, "03.png.import sidecar must be unlinked");
    assert.equal(fs.existsSync(`${sources[3]}.import`), false, "04.png.import sidecar must be unlinked");
    assert.equal(
      fs.existsSync(path.join(importedDir, "03.ctex")),
      false,
      "03.ctex must be forgotten from .godot/imported",
    );
    assert.equal(
      fs.existsSync(path.join(importedDir, "04.ctex")),
      false,
      "04.ctex must be forgotten from .godot/imported",
    );
    assert.ok(fs.existsSync(path.join(pack, "notes.txt")), "non-owned files in the pack dir must survive");
  } finally {
    current.cleanup();
  }
});

/**
 * Decodes a PNG header by requiring the file to exist and start with PNG magic.
 * @param {string} filePath Absolute PNG path.
 * @returns {void}
 */
function decodeRequiresPng(filePath) {
  const buffer = fs.readFileSync(filePath);
  assert.equal(buffer.toString("ascii", 1, 4), "PNG");
}
