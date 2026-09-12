"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createXsxbMcpService } = require("../../mcp/xsxb_mcp_service");
const { createProjectStore } = require("../../mcp/lib/project_store");
const { encodePngRgba } = require("../../mcp/xsxb_mcp_cutout");

/**
 * Runs a public MCP regression against an isolated two-frame project.
 * @param {Function} operation Test body.
 * @param {object} options Import options.
 * @returns {Promise<void>} Test completion.
 */
async function withProject(operation, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-reliability-"));
  const service = createXsxbMcpService({
    root,
    florenceDetectImpl: null,
  });
  const call = async (name, args = {}) => (await service.callMcp(name, args)).data;
  try {
    const rgba = new Uint8ClampedArray(4 * 4 * 4);
    rgba.set([255, 0, 0, 255], (1 * 4 + 1) * 4);
    const files = [0, 1].map((index) => {
      const file = path.join(root, `source-${index}.png`);
      fs.writeFileSync(file, encodePngRgba(rgba, 4, 4));
      return file;
    });
    await call("xsxb_create_project", { project_id: "review" });
    await call("xsxb_import_animation", {
      source: "items",
      items: files.map((file) => ({ path: file })),
      profile_id: "hero",
      animation_id: "idle",
      ...options,
    });
    const animation = await call("xsxb_get_animation");
    const store = createProjectStore(root);
    const paths = store.projectPaths(store.activeProject("review"));
    await operation({ root, call, service, paths, animation });
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("binding and rebinding Godot preserve existing authoring files across restart", async () => {
  await withProject(async ({ root, call, paths, animation }) => {
    await call("xsxb_update_timing", { frame: 0, duration: 2 });
    const originalManifest = fs.readFileSync(paths.manifest);
    const originalTuning = fs.readFileSync(paths.tuning);
    for (const name of ["game-a", "game-b"]) {
      const game = path.join(root, name);
      fs.mkdirSync(game);
      fs.writeFileSync(path.join(game, "project.godot"), '[application]\nconfig/name="Review"\n');
      await call("xsxb_bind_godot", { project_root: game });
      const restarted = createXsxbMcpService({ root, florenceDetectImpl: null });
      try {
        const after = (
          await restarted.callMcp("xsxb_get_animation", { profile_id: "hero", animation_id: "idle" })
        ).data;
        assert.deepEqual(after.animation.frames, animation.animation.frames);
        assert.equal(after.project.dataPath, animation.project.dataPath);
        assert.equal(after.project.projectRoot, game);
        assert.deepEqual(fs.readFileSync(paths.manifest), originalManifest);
        assert.deepEqual(fs.readFileSync(paths.tuning), originalTuning);
        const sync = (await restarted.callMcp("xsxb_sync_godot", {})).data;
        assert.equal(sync.ok, true);
      } finally {
        restarted.close();
      }
    }
  });
});

test("legacy project roots remain the authoring location when retargeted", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-legacy-root-"));
  try {
    const oldRoot = path.join(root, "old");
    fs.mkdirSync(oldRoot);
    const store = createProjectStore(root);
    store.addProject({ id: "legacy", projectRoot: oldRoot });
    const registry = store.readRegistry();
    delete registry.projects[0].authoringRoot;
    store.writeJson(store.path, registry);
    const before = store.projectPaths(registry.projects[0]);
    store.writeJson(before.tuning, { sentinel: "preserved" });
    const updated = store.setProjectRoot("legacy", path.join(root, "new")).project;
    assert.equal(store.projectPaths(updated).tuning, before.tuning);
    assert.deepEqual(store.readJson(store.projectPaths(updated).tuning, {}), { sentinel: "preserved" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const inPlace of [false, true]) {
  test(`invalid tail in a frame batch leaves PNGs and manifest unchanged (in_place=${inPlace})`, async () => {
    await withProject(
      async ({ call, animation, paths }) => {
        const frame = animation.animation.frames[0].absolutePath;
        const bytes = fs.readFileSync(frame);
        const manifest = fs.readFileSync(paths.manifest);
        await assert.rejects(
          call("xsxb_shift_frames", {
            frames: [
              { frame: 0, dy: 5 },
              { frame: 99, dy: 1 },
            ],
          }),
          /Frame/,
        );
        assert.deepEqual(fs.readFileSync(frame), bytes);
        assert.deepEqual(fs.readFileSync(paths.manifest), manifest);
      },
      { in_place: inPlace },
    );
  });
}

for (const [name, args] of [
  [
    "xsxb_shift_frames",
    {
      frames: [
        { frame: 0, dy: 5 },
        { frame: 1, dy: 5 },
      ],
    },
  ],
  ["xsxb_plant_feet", { apply: true, target_y: -1 }],
  ["xsxb_register_clip", { apply: true, target_bbox: 2 }],
]) {
  test(`${name} restores earlier PNGs when a later commit fails`, async () => {
    await withProject(async ({ call, animation, paths }) => {
      const files = animation.animation.frames.map((frame) => frame.absolutePath);
      const originals = files.map((file) => fs.readFileSync(file));
      const manifest = fs.readFileSync(paths.manifest);
      const rename = fs.renameSync;
      const write = fs.writeFileSync;
      let failed = false;
      /** Simulates a single destination failure without disrupting rollback. */
      const refuse = (target) => {
        if (String(target) === files[1] && !failed) {
          failed = true;
          throw new Error("injected disk failure");
        }
      };
      fs.renameSync = (source, target) => {
        refuse(target);
        return rename(source, target);
      };
      fs.writeFileSync = (target, ...rest) => {
        refuse(target);
        return write(target, ...rest);
      };
      try {
        await assert.rejects(call(name, args), /injected disk failure/);
      } finally {
        fs.renameSync = rename;
        fs.writeFileSync = write;
      }
      assert.equal(failed, true);
      files.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), originals[index]));
      assert.deepEqual(fs.readFileSync(paths.manifest), manifest);
    });
  });
}

test("public timing arguments normalize booleans and fractions before writing", async () => {
  await withProject(async ({ call, paths }) => {
    const args = { frames: [{ frame: "0", duration: "1/2", disabled: "false" }] };
    const result = await call("xsxb_update_timing", args);
    assert.equal(result.playbackUpdates[0].duration, 0.5);
    assert.equal(result.playbackUpdates[0].disabled, false);
    const tuning = JSON.parse(fs.readFileSync(paths.tuning, "utf8"));
    assert.deepEqual(Object.values(tuning.frame_playback_overrides)[0], { duration: 0.5, disabled: false });
    assert.equal(args.frames[0].duration, "1/2", "caller input stays unchanged");
  });
});

test("public numeric and nested enum validation rejects malformed values before writes", async () => {
  await withProject(async ({ call, paths }) => {
    const original = fs.readFileSync(paths.tuning);
    for (const frame of [[], null, true, {}]) {
      await assert.rejects(call("xsxb_update_timing", { frame, duration_ms: 500 }), /must be integer/);
    }
    await assert.rejects(call("xsxb_get_animation", { include: ["typo"] }), /must be one of/);
    await assert.rejects(call("xsxb_reorganize_frames", { order: [-1] }), /at least 0/);
    assert.deepEqual(fs.readFileSync(paths.tuning), original);
  });
});

test("manifest commit failure restores all frame bytes and removes staging files", async () => {
  await withProject(async ({ call, animation, paths }) => {
    const files = animation.animation.frames.map((frame) => frame.absolutePath);
    const originals = files.map((file) => fs.readFileSync(file));
    const manifest = fs.readFileSync(paths.manifest);
    const rename = fs.renameSync;
    let failed = false;
    fs.renameSync = (source, target) => {
      if (target === paths.manifest && !failed) {
        failed = true;
        throw new Error("injected manifest failure");
      }
      return rename(source, target);
    };
    try {
      await assert.rejects(
        call("xsxb_shift_frames", {
          frames: [
            { frame: 0, dy: 5 },
            { frame: 1, dy: 5 },
          ],
        }),
        /injected manifest failure/,
      );
    } finally {
      fs.renameSync = rename;
    }
    assert.equal(failed, true);
    files.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), originals[index]));
    assert.deepEqual(fs.readFileSync(paths.manifest), manifest);
    for (const directory of [path.dirname(files[0]), paths.dataDir]) {
      assert.equal(
        fs.readdirSync(directory).some((name) => /\.(tmp|backup)-/.test(name)),
        false,
      );
    }
  });
});

test("a corrupt later frame prevents all plant writes", async () => {
  await withProject(async ({ call, animation, paths }) => {
    const [first, second] = animation.animation.frames.map((frame) => frame.absolutePath);
    const original = fs.readFileSync(first);
    const manifest = fs.readFileSync(paths.manifest);
    fs.writeFileSync(second, "invalid png");
    await assert.rejects(call("xsxb_plant_feet", { apply: true, target_y: -1 }));
    assert.deepEqual(fs.readFileSync(first), original);
    assert.deepEqual(fs.readFileSync(paths.manifest), manifest);
    assert.equal(
      fs.readdirSync(path.dirname(first)).some((name) => /\.(tmp|backup)-/.test(name)),
      false,
    );
  });
});

test("repeated shifts of one frame retain ordered semantics and commit matching dimensions", async () => {
  await withProject(async ({ call, animation }) => {
    await call("xsxb_shift_frames", {
      frames: [
        { frame: 0, dy: 2 },
        { frame: 0, dy: 2 },
        { frame: 1, dy: 4 },
      ],
    });
    const after = await call("xsxb_get_animation");
    const [first, second] = after.animation.frames;
    assert.deepEqual(fs.readFileSync(first.absolutePath), fs.readFileSync(second.absolutePath));
    assert.equal(first.height, fs.readFileSync(first.absolutePath).readUInt32BE(20));
    assert.equal(first.height, 6);
    assert.equal(first.absolutePath, animation.animation.frames[0].absolutePath);
  });
});

test("single-frame timing uses the same normalized semantics as batches", async () => {
  await withProject(async ({ call, paths }) => {
    const result = await call("xsxb_update_timing", { frame: "0", duration: "1/2", disabled: "false" });
    assert.equal(result.playback.duration, 0.5);
    assert.equal(result.playback.disabled, false);
    const original = fs.readFileSync(paths.tuning);
    for (const entry of [{ frame: [] }, { frame: null }, { frame: true }, { frame: 0, duration: "1/0" }]) {
      await assert.rejects(call("xsxb_update_timing", { frames: [entry] }), {
        code: "xsxb_invalid_arguments",
      });
    }
    assert.deepEqual(fs.readFileSync(paths.tuning), original);
  });
});

test("creating under a bound Godot folder does not reuse a project authored elsewhere", async () => {
  await withProject(async ({ root, call }) => {
    const game = path.join(root, "game");
    fs.mkdirSync(game);
    fs.writeFileSync(path.join(game, "project.godot"), '[application]\nconfig/name="Review"\n');
    await call("xsxb_bind_godot", { project_root: game });
    const created = await call("xsxb_create_project", { project_id: "game-local", project_root: game });
    assert.equal(created.project.id, "game-local");
    assert.equal(created.project.authoringRoot, game);
    assert.ok(created.project.dataPath.startsWith(path.join(game, ".x-frame")));
  });
});

test("failed rollback retains original bytes and reports their recovery path", async () => {
  await withProject(async ({ call, animation }) => {
    const [first, second] = animation.animation.frames.map((frame) => frame.absolutePath);
    const original = fs.readFileSync(first);
    const rename = fs.renameSync;
    fs.renameSync = (source, target) => {
      if (target === second) throw new Error("injected destination failure");
      if (target === first && source.includes(".backup-")) throw new Error("injected restore failure");
      return rename(source, target);
    };
    let failure;
    try {
      await assert.rejects(
        call("xsxb_shift_frames", {
          frames: [
            { frame: 0, dy: 5 },
            { frame: 1, dy: 5 },
          ],
        }),
        (error) => {
          failure = error;
          return /Rollback incomplete/.test(error.message);
        },
      );
    } finally {
      fs.renameSync = rename;
    }
    const backup = fs
      .readdirSync(path.dirname(first))
      .find((name) => name.startsWith(`${path.basename(first)}.backup-`));
    assert.ok(backup, "original is retained even when restoring the destination fails");
    const recoveryPath = path.join(path.dirname(first), backup);
    assert.ok(failure.message.includes(recoveryPath));
    assert.deepEqual(fs.readFileSync(recoveryPath), original);
  });
});
