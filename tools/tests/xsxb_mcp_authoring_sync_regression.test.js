"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createXsxbMcpService } = require("../../mcp/xsxb_mcp_service");
const { createProjectStore } = require("../../mcp/lib/project_store");
const { encodePngRgba } = require("../../mcp/xsxb_mcp_cutout");

/** Runs public tools against an isolated host, external authoring directory and Godot target. */
async function fixture(run) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-authoring-sync-"));
  const root = path.join(base, "host"),
    author = path.join(base, "author"),
    game = path.join(base, "game");
  for (const directory of [root, author, game]) fs.mkdirSync(directory);
  fs.writeFileSync(path.join(game, "project.godot"), '[application]\nconfig/name="Review"\n');
  const red = encodePngRgba(new Uint8ClampedArray([255, 0, 0, 255]), 1, 1);
  const green = encodePngRgba(new Uint8ClampedArray([0, 255, 0, 255]), 1, 1);
  const png = path.join(root, "frame.png");
  fs.writeFileSync(png, red);
  const service = createXsxbMcpService({ root, florenceDetectImpl: null });
  const call = async (name, args = {}) => (await service.callMcp(name, args)).data;
  try {
    await run({ root, author, game, png, red, green, service, call });
  } finally {
    service.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

for (const mode of ["ordinary", "external", "in_place", "external_in_place", "res"]) {
  test(`Godot sync copies ${mode} frames and preserves different animations with identical filenames`, async () =>
    fixture(async ({ root, author, game, png, red, green, call }) => {
      await call("xsxb_create_project", {
        project_id: "test",
        ...(mode === "external" ? { project_root: author } : {}),
      });
      for (const [id, bytes] of [
        ["walk", red],
        ["idle", green],
      ]) {
        const source = path.join(mode === "external_in_place" ? author : root, `${id}.png`);
        fs.writeFileSync(source, bytes);
        await call("xsxb_import_animation", {
          source: "items",
          items: [{ path: source }],
          in_place: mode.endsWith("in_place"),
          profile_id: "hero",
          animation_id: id,
        });
      }
      await call("xsxb_bind_godot", { project_root: game });
      if (mode === "res") {
        const store = createProjectStore(root),
          project = store.activeProject("test"),
          paths = store.projectPaths(project);
        const manifest = store.readJson(paths.manifest, {});
        for (const [index, animation] of manifest.profiles[0].animations.entries()) {
          const source = `${animation.id}.png`;
          fs.writeFileSync(path.join(game, source), index ? green : red);
          animation.frames[0].path = `res://${source}`;
        }
        store.writeJson(paths.manifest, manifest);
      }
      const result = await call("xsxb_sync_godot");
      assert.equal(result.ok, true);
      assert.equal(result.copiedFrames, 2);
      const manifest = JSON.parse(
        fs.readFileSync(path.join(game, "xsxb_frame_tuner/data/projects/test/animation_manifest.json")),
      );
      const files = manifest.profiles[0].animations.map((animation) =>
        path.join(game, animation.frames[0].path),
      );
      assert.notEqual(files[0], files[1]);
      assert.deepEqual(fs.readFileSync(files[0]), red);
      assert.deepEqual(fs.readFileSync(files[1]), green);
    }));
}

test("missing source PNG produces a public sync failure instead of a successful broken manifest", async () =>
  fixture(async ({ png, game, service, call }) => {
    await call("xsxb_create_project", { project_id: "test" });
    await call("xsxb_import_animation", {
      source: "items",
      items: [{ path: png }],
      profile_id: "hero",
      animation_id: "walk",
    });
    const state = await call("xsxb_get_animation");
    fs.rmSync(state.animation.frames[0].absolutePath);
    await call("xsxb_bind_godot", { project_root: game });
    const result = await service.callMcp("xsxb_sync_godot", {});
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "GODOT_SYNC_FAILED");
    assert.match(result.error.message, /frame|PNG/i);
    assert.equal(
      fs.existsSync(path.join(game, "xsxb_frame_tuner/data/projects/test/animation_manifest.json")),
      false,
    );
  }));

test("in_place revision comparison renders changed PNGs without changing external snapshot keys", async () =>
  fixture(async ({ png, green, call }) => {
    await call("xsxb_create_project", { project_id: "test" });
    await call("xsxb_import_animation", {
      source: "items",
      items: [{ path: png }, { path: png }],
      in_place: true,
      profile_id: "hero",
      animation_id: "walk",
    });
    const saved = await call("xsxb_save_revision");
    fs.writeFileSync(png, green);
    const compared = await call("xsxb_compare_revisions", { revision_id: saved.revisionId });
    assert.equal(compared.changes.length, 1);
    assert.match(compared.changes[0].key, /^external\/[a-f0-9]{64}$/);
    assert.ok(compared.preview);
    assert.ok(fs.existsSync(compared.preview.path));
    assert.equal(compared.preview.files.length, 1);
  }));

test("Godot res paths cannot traverse outside the bound project", async () =>
  fixture(async ({ root, png, game, author, red, service, call }) => {
    await call("xsxb_create_project", { project_id: "test" });
    await call("xsxb_import_animation", {
      source: "items",
      items: [{ path: png }],
      profile_id: "hero",
      animation_id: "walk",
    });
    await call("xsxb_bind_godot", { project_root: game });
    fs.writeFileSync(path.join(author, "outside.png"), red);
    const store = createProjectStore(root),
      paths = store.projectPaths(store.activeProject("test"));
    const manifest = store.readJson(paths.manifest, {});
    manifest.profiles[0].animations[0].frames[0].path = "res://../author/outside.png";
    store.writeJson(paths.manifest, manifest);
    const result = await service.callMcp("xsxb_sync_godot", {});
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "GODOT_SYNC_FAILED");
  }));
