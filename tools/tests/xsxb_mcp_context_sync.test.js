"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createXsxbMcpService } = require("../../mcp/xsxb_mcp_service");
const { handleMessage } = require("../../mcp/xsxb_mcp_server");
const { createProjectStore } = require("../../mcp/lib/project_store");
const { encodePngRgba } = require("../../mcp/xsxb_mcp_cutout");

/**
 * Runs a public MCP workflow with two projects and different animation selections.
 * @param {Function} operation Scenario body.
 * @returns {Promise<void>} Completion with temporary data removed.
 */
async function withProjects(operation) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-context-sync-"));
  const service = createXsxbMcpService({ root, florenceDetectImpl: null });
  const call = async (name, args = {}) => (await service.callMcp(name, args)).data;
  try {
    const png = path.join(root, "frame.png");
    fs.writeFileSync(png, encodePngRgba(new Uint8ClampedArray([210, 30, 40, 255]), 1, 1));
    for (const [id, profile, animation] of [
      ["a", "hero", "walk"],
      ["b", "enemy", "idle"],
    ]) {
      await call("xsxb_create_project", { project_id: id });
      await call("xsxb_import_animation", {
        source: "items",
        items: [{ path: png }],
        profile_id: profile,
        animation_id: animation,
      });
    }
    await operation({ root, service, call, png });
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (const selector of ["xsxb_set_active_project", "xsxb_create_project"]) {
  test(`${selector} switching projects clears the previous animation selection`, async () => {
    await withProjects(async ({ call }) => {
      await call(
        selector,
        selector === "xsxb_create_project" ? { project_id: "a", set_active: true } : { project_id: "a" },
      );
      const selected = await call("xsxb_get_animation");
      assert.equal(selected.project.id, "a");
      assert.equal(selected.profile.id, "hero");
      assert.equal(selected.animation.id, "walk");
      const direct = await call("xsxb_get_animation", { project_id: "b" });
      assert.equal(direct.profile.id, "enemy");
      assert.equal(direct.animation.id, "idle");
    });
  });
}

test("switching profiles clears only the old animation and same-project selection stays selected", async () => {
  await withProjects(async ({ call, png }) => {
    await call("xsxb_import_animation", {
      project_id: "b",
      source: "items",
      items: [{ path: png }],
      profile_id: "second",
      animation_id: "jump",
    });
    await call("xsxb_set_active_project", { project_id: "b" });
    assert.equal((await call("xsxb_get_animation")).animation.id, "jump");
    const peeked = await call("xsxb_get_animation", { profile_id: "enemy" });
    assert.equal(peeked.animation.id, "idle");
    assert.equal((await call("xsxb_get_animation")).animation.id, "jump");
    await call("xsxb_update_timing", {
      profile_id: "enemy",
      animation_id: "idle",
      frame: 0,
      duration: 2,
    });
    const selected = await call("xsxb_get_animation");
    assert.equal(selected.profile.id, "enemy");
    assert.equal(selected.animation.id, "idle");
    await call("xsxb_create_project", { project_id: "background", set_active: false });
    assert.equal((await call("xsxb_get_animation")).project.id, "b");
  });
});

test("create_project_existing_omit_set_active_keeps_active_project", async () => {
  await withProjects(async ({ call }) => {
    const again = await call("xsxb_create_project", { project_id: "a" });
    assert.equal(again.created, false);
    const listed = await call("xsxb_list_projects");
    assert.equal(listed.activeProjectId, "b");
  });
});

test("get_animation_inspect_does_not_steal_context", async () => {
  await withProjects(async ({ service, call }) => {
    const response = await handleMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "xsxb_get_animation",
          arguments: { project_id: "a", animation_id: "walk" },
        },
      },
      service,
    );
    const receipt = response.result.structuredContent.data;
    assert.equal(receipt.project.id, "a");
    assert.equal(receipt.profile.id, "hero");
    assert.equal(receipt.animation.id, "walk");
    const listed = await call("xsxb_list_projects");
    assert.equal(listed.activeProjectId, "b");
    const selected = await call("xsxb_get_animation");
    assert.equal(selected.project.id, "b");
    assert.equal(selected.profile.id, "enemy");
    assert.equal(selected.animation.id, "idle");
    const followUp = await call("xsxb_get_project");
    assert.equal(followUp.projectId, "b");
    assert.equal(followUp.id, "b");
  });
});

test("measure_and_find_inspect_does_not_steal_context", async () => {
  await withProjects(async ({ service, call, png }) => {
    await call("xsxb_import_animation", {
      project_id: "a",
      source: "items",
      items: [{ path: png }, { path: png }, { path: png }, { path: png }],
      profile_id: "hero",
      animation_id: "walk",
      replace: true,
    });
    await call("xsxb_set_active_project", { project_id: "b" });
    let rpcId = 1;
    for (const [name, extra] of [
      ["xsxb_measure_frames", {}],
      ["xsxb_find_loop", { sample_size: 8 }],
      ["xsxb_find_duplicates", { sample_size: 8 }],
      ["xsxb_find_motion", {}],
    ]) {
      const response = await handleMessage(
        {
          jsonrpc: "2.0",
          id: rpcId,
          method: "tools/call",
          params: {
            name,
            arguments: { project_id: "a", animation_id: "walk", ...extra },
          },
        },
        service,
      );
      rpcId += 1;
      const receipt = response.result.structuredContent;
      assert.equal(response.result.isError, false, name);
      assert.equal(receipt.ok, true, name);
    }
    const listed = await call("xsxb_list_projects");
    assert.equal(listed.activeProjectId, "b");
    const selected = await call("xsxb_get_animation");
    assert.equal(selected.project.id, "b");
    assert.equal(selected.profile.id, "enemy");
    assert.equal(selected.animation.id, "idle");
  });
});

test("analyze_diff_validate_inspect_does_not_steal_context", async () => {
  await withProjects(async ({ root, service, call, png }) => {
    await call("xsxb_import_animation", {
      project_id: "a",
      source: "items",
      items: [{ path: png }, { path: png }, { path: png }, { path: png }],
      profile_id: "hero",
      animation_id: "walk",
      replace: true,
    });
    const game = path.join(root, "game");
    fs.mkdirSync(game);
    fs.writeFileSync(path.join(game, "project.godot"), '[application]\nconfig/name="Peek"\n');
    await call("xsxb_bind_godot", { project_id: "a", project_root: game });
    await call("xsxb_set_active_project", { project_id: "b" });
    let rpcId = 1;
    for (const [name, extra] of [
      ["xsxb_analyze", {}],
      ["xsxb_diff_frames", { frame_a: 0, frame_b: 1 }],
      ["xsxb_detect_regions", { frame: 0, provider: "code" }],
      ["xsxb_validate_project", {}],
      ["xsxb_validate_for_godot", { require_gameplay: false }],
      ["xsxb_list_revisions", {}],
    ]) {
      const arguments_ =
        name.startsWith("xsxb_validate") || name === "xsxb_list_revisions"
          ? { project_id: "a", ...extra }
          : { project_id: "a", animation_id: "walk", ...extra };
      const response = await handleMessage(
        {
          jsonrpc: "2.0",
          id: rpcId,
          method: "tools/call",
          params: { name, arguments: arguments_ },
        },
        service,
      );
      rpcId += 1;
      assert.equal(response.error, undefined, name);
      assert.ok(response.result, name);
      const receipt = response.result.structuredContent;
      assert.ok(receipt, name);
      if (name === "xsxb_validate_for_godot" || name === "xsxb_validate_project") continue;
      assert.equal(response.result.isError, false, name);
      assert.equal(receipt.ok, true, name);
    }
    const listed = await call("xsxb_list_projects");
    assert.equal(listed.activeProjectId, "b");
    const selected = await call("xsxb_get_animation");
    assert.equal(selected.project.id, "b");
    assert.equal(selected.profile.id, "enemy");
    assert.equal(selected.animation.id, "idle");
  });
});

test("get_project_existing_id_does_not_activate", async () => {
  await withProjects(async ({ service, call }) => {
    const response = await handleMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "xsxb_get_project", arguments: { project_id: "a" } },
      },
      service,
    );
    const snapshot = response.result.structuredContent.data;
    assert.equal(snapshot.projectId, "a");
    assert.equal(snapshot.id, "a");
    assert.equal(snapshot.active, false);
    const listed = await call("xsxb_list_projects");
    assert.equal(listed.activeProjectId, "b");
    const selected = await call("xsxb_get_animation");
    assert.equal(selected.project.id, "b");
    assert.equal(selected.profile.id, "enemy");
    assert.equal(selected.animation.id, "idle");
    const followUp = await call("xsxb_get_project");
    assert.equal(followUp.projectId, "b");
    assert.equal(followUp.id, "b");
    assert.equal(followUp.active, true);
  });
});

for (const [tool, args] of [
  ["xsxb_update_timing", { frame: 0, duration: 2 }],
  ["xsxb_shift_frames", { frames: [{ frame: 0, dy: 2 }] }],
]) {
  test(`${tool} reports local changes when Godot sync fails and supports sync-only retry`, async () => {
    await withProjects(async ({ root, service, call }) => {
      const game = path.join(root, "game");
      fs.mkdirSync(game);
      fs.writeFileSync(path.join(game, "project.godot"), '[application]\nconfig/name="Sync"\n');
      await call("xsxb_bind_godot", { project_id: "a", project_root: game });
      const selector = { project_id: "a", profile_id: "hero", animation_id: "walk" };
      const before = await call("xsxb_get_animation", selector);
      const png = before.animation.frames[0].absolutePath;
      const store = createProjectStore(root);
      const paths = store.projectPaths(store.activeProject("a"));
      const affected = tool === "xsxb_update_timing" ? paths.tuning : png;
      const original = fs.readFileSync(affected);
      const targetTuning = path.join(game, "xsxb_frame_tuner/data/projects/a/animation_tuning.json");
      const rename = fs.renameSync;
      let response;
      fs.renameSync = (source, target) => {
        if (target === targetTuning) throw new Error("injected Godot write failure");
        return rename(source, target);
      };
      try {
        response = await handleMessage(
          {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: tool, arguments: { ...selector, ...args, sync: true } },
          },
          service,
        );
      } finally {
        fs.renameSync = rename;
      }
      const receipt = response.result.structuredContent;
      assert.equal(response.result.isError, true);
      assert.equal(receipt.ok, false);
      assert.equal(receipt.execution.effect, "partial");
      assert.equal(receipt.data.sync.ok, false);
      assert.equal(receipt.error.code, "GODOT_SYNC_FAILED");
      assert.equal(receipt.error.details.localChangesSaved, true);
      assert.match(response.result.content[0].text, /local.*saved.*xsxb_sync_godot/i);
      const saved = fs.readFileSync(affected);
      assert.notDeepEqual(saved, original);
      const retry = receipt.error.details.retry;
      assert.deepEqual(retry, { tool: "xsxb_sync_godot", arguments: { project_id: "a" } });
      const synced = await service.callMcp(retry.tool, retry.arguments);
      assert.equal(synced.ok, true);
      assert.equal(synced.data.ok, true);
      assert.deepEqual(fs.readFileSync(affected), saved, "sync retry does not reapply the local mutation");
      assert.deepEqual(JSON.parse(fs.readFileSync(targetTuning)), JSON.parse(fs.readFileSync(paths.tuning)));
    });
  });
}

test("sync requested without a binding reports a failed sync instead of full success", async () => {
  await withProjects(async ({ service }) => {
    const receipt = await service.callMcp("xsxb_update_timing", { frame: 0, duration: 2, sync: true });
    assert.equal(receipt.ok, false);
    assert.equal(receipt.execution.effect, "partial");
    assert.equal(receipt.data.sync.ok, false);
    assert.match(receipt.error.message, /bound Godot/);
  });
});

test("invalid edits remain refused and do not claim locally saved changes", async () => {
  await withProjects(async ({ service }) => {
    const result = await handleMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "xsxb_update_timing", arguments: { frame: 99, duration: 2, sync: true } },
      },
      service,
    );
    assert.equal(result.result.isError, true);
    assert.equal(result.result.structuredContent.execution.effect, "refused");
    assert.equal(result.result.structuredContent.data, null);
  });
});

test("a standalone failed sync keeps partial status without claiming a new local edit", async () => {
  await withProjects(async ({ root, service, call }) => {
    const game = path.join(root, "game");
    fs.mkdirSync(game);
    fs.writeFileSync(path.join(game, "project.godot"), '[application]\nconfig/name="Sync"\n');
    await call("xsxb_bind_godot", { project_id: "b", project_root: game });
    const store = createProjectStore(root);
    const paths = store.projectPaths(store.activeProject("b"));
    const original = fs.readFileSync(paths.tuning);
    const targetManifest = path.join(game, "xsxb_frame_tuner/data/projects/b/animation_manifest.json");
    const rename = fs.renameSync;
    fs.renameSync = (source, target) => {
      if (target === targetManifest) throw new Error("injected sync failure");
      return rename(source, target);
    };
    let receipt;
    try {
      receipt = await service.callMcp("xsxb_sync_godot", { project_id: "b" });
    } finally {
      fs.renameSync = rename;
    }
    assert.equal(receipt.ok, false);
    assert.equal(receipt.execution.effect, "partial");
    assert.equal(receipt.error.details.localChangesSaved, false);
    assert.deepEqual(fs.readFileSync(paths.tuning), original);
    assert.equal((await service.callMcp("xsxb_sync_godot", { project_id: "b" })).ok, true);
  });
});
