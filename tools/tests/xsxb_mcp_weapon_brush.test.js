"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createXsxbMcpService } = require("../../mcp/xsxb_mcp_service");
const { handleMessage } = require("../../mcp/xsxb_mcp_server");
const { encodePngRgba, decodePngRgba } = require("../../mcp/xsxb_mcp_cutout");
const { attachmentFrames } = require("../../mcp/xsxb_mcp_trail_preview");
const { BUNDLED_TRAIL_TEXTURE } = require("../../mcp/lib/attack_trails");

test("advertised brush example derives two poses, replaces on retry and syncs a usable default brush", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-auto-brush-"));
  const game = path.join(root, "game");
  fs.mkdirSync(game);
  fs.writeFileSync(path.join(game, "project.godot"), "config_version=5\n");
  const service = createXsxbMcpService({ root, florenceDetectImpl: null });
  t.after(() => {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  let id = 0;
  const rpc = async (method, params) =>
    (await handleMessage({ jsonrpc: "2.0", id: ++id, method, params }, service)).result;
  const call = async (name, args = {}) =>
    (await rpc("tools/call", { name, arguments: args })).structuredContent;
  const ok = async (name, args) => {
    const receipt = await call(name, args);
    assert.equal(receipt.ok, true, JSON.stringify(receipt.error));
    return receipt.data;
  };
  const catalog = await rpc("tools/list");
  const tool = catalog.tools.find((entry) => entry.name === "xsxb_add_attack_trail");
  const example = JSON.parse(tool.description.match(/\{[^}]+\}/)[0]);
  const pixels = new Uint8ClampedArray(32 * 8 * 4);
  for (let x = 0; x < 32; x++)
    for (let y = x === 3 ? 0 : 3; y <= (x === 3 ? 7 : 4); y++)
      pixels.set([255, 255, 255, 255], (y * 32 + x) * 4);
  const sword = path.join(root, "sword.png"),
    body = path.join(root, "body.png");
  fs.writeFileSync(sword, encodePngRgba(pixels, 32, 8));
  fs.writeFileSync(body, encodePngRgba(new Uint8ClampedArray(64 * 64 * 4), 64, 64));
  await ok("xsxb_create_project", { project_id: "demo" });
  await ok("xsxb_import_animation", {
    source: "items",
    animation_id: "attack",
    profile_id: "hero",
    items: Array.from({ length: 8 }, () => ({ path: body })),
  });
  await ok("xsxb_bind_godot", { project_root: game });
  await ok("xsxb_add_attachment", {
    file_path: sword,
    id: "sword",
    frames: [
      { frame: 3, offset_x: 0, offset_y: -32, rotation: -90, scale: 1 },
      { frame: 5, offset_x: 0, offset_y: -32, rotation: -45, scale: 1 },
      { frame: 7, offset_x: 0, offset_y: -32, rotation: 0, scale: 1.5 },
    ],
  });
  const response = await rpc("tools/call", { name: tool.name, arguments: example });
  assert.match(response.content[0].text, /textured brush, 2 poses/);
  const added = response.structuredContent.data;
  const sticks = added.segment.sticks;
  assert.equal(added.useMesh, true);
  assert.deepEqual(
    sticks.map((s) => s.frame),
    [3, 7],
  );
  assert.ok(sticks[0].top.y < -44 && Math.abs(sticks[0].top.x) < 2);
  assert.ok(sticks[1].top.x > 19 && Math.abs(sticks[1].top.y + 32) < 2);
  assert.ok(sticks.every((s) => s.tangentStrength > 0 && s.directionOffset === 180));
  await ok(tool.name, { ...example, sync: true });
  const json = JSON.parse(
    fs.readFileSync(path.join(game, "xsxb_frame_tuner/data/projects/demo/attack_trails.json")),
  );
  assert.equal(json.bindings["hero/attack"].length, 1);
  const texture = json.bindings["hero/attack"][0].texture.path;
  assert.match(texture, /^res:\/\//);
  assert.deepEqual(
    fs.readFileSync(path.join(game, texture.slice(6))),
    fs.readFileSync(BUNDLED_TRAIL_TEXTURE),
  );
  for (const bad of [
    { end_frame: 6 },
    { end_frame: 3 },
    { end_frame: 8 },
    { start_frame: undefined },
    { sticks: [] },
    { render_mode: "sweep" },
  ]) {
    const failed = await call(tool.name, { ...example, ...bad });
    assert.equal(failed.ok, false);
  }
  const missing = await rpc("tools/call", {
    name: tool.name,
    arguments: { ...example, attachment_id: "missing" },
  });
  assert.match(missing.content[0].text, /frame 3.*include:\["attachments"\]/);
  const list = await ok("xsxb_get_animation", { include: ["trails"] });
  assert.deepEqual(
    list.trails.map((s) => s.id),
    [added.segment.id],
  );
  // Existing projects used range-based ids. A combo must adopt those strokes in place.
  const storePath = path.join(root, ".x-frame/data/projects/demo/attack_trails.json");
  const state = JSON.parse(fs.readFileSync(storePath));
  const legacy = state.bindings["hero/attack"][0];
  delete legacy.brushSource;
  legacy.id = "sword_3_7";
  fs.writeFileSync(storePath, JSON.stringify(state));
  const allFrames = Array.from({ length: 8 }, (_, frame) => ({
    frame,
    offset_x: 0,
    offset_y: -32,
    rotation: -90 + frame * 16,
  }));
  await ok("xsxb_add_attachment", { id: "sword", file_path: sword, frames: allFrames });
  const hits = [
    { start_frame: 0, end_frame: 1 },
    { start_frame: 2, end_frame: 4 },
    { start_frame: 3, end_frame: 7 },
  ];
  const combo = await rpc("tools/call", { name: tool.name, arguments: { hits, color: "#ff2222" } });
  assert.equal(combo.isError, false, combo.content[0].text);
  const data = combo.structuredContent.data;
  const ids = data.hits.map((h) => h.id);
  assert.equal(new Set(ids).size, 3);
  assert.equal(ids[2], legacy.id);
  assert.ok(data.hits.every((h) => h.attachmentId === "sword" && h.segment.sticks.length === 2));
  assert.deepEqual(data.preview.frames, [1, 4, 7]);
  assert.deepEqual(Buffer.from(combo.content[1].data, "base64"), fs.readFileSync(data.preview.path));
  const readStrokes = async () => (await ok("xsxb_get_animation", { include: ["trails"] })).trails;
  const unchanged = fs.readFileSync(storePath);
  for (const badHits of [
    [],
    Array(13).fill(hits[0]),
    [hits[0], { start_frame: 5, end_frame: 8 }],
    [hits[0], hits[0]],
  ]) {
    assert.equal((await call(tool.name, { hits: badHits, color: "#ccff00" })).ok, false);
    assert.deepEqual(fs.readFileSync(storePath), unchanged);
  }
  const retimed = await ok(tool.name, { start_frame: 3, end_frame: 6, preview: false });
  assert.equal(retimed.id, legacy.id);
  assert.equal(retimed.segment.color, "#ff2222");
  await ok("xsxb_add_attachment", { id: "dagger", file_path: sword, frames: allFrames });
  const ambiguous = await call(tool.name, { start_frame: 4, end_frame: 5 });
  assert.equal(ambiguous.ok, false);
  assert.deepEqual(ambiguous.error.details.attachment_ids, ["dagger", "sword"]);
  const byId = await ok(tool.name, { id: retimed.id, start_frame: 4, end_frame: 5, preview: false });
  assert.equal(byId.attachmentId, "sword");
  assert.equal(byId.preview, undefined);
  assert.deepEqual((await readStrokes()).map((s) => s.id).sort(), ids.sort());
});

test("weapon motion tracks a translating and turning blade on the displayed frame", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-swing-"));
  const service = createXsxbMcpService({ root, florenceDetectImpl: null });
  t.after(() => {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const call = async (name, args) => {
    const result = await service.callMcp(name, args);
    assert.ok(result.ok);
    return result.data;
  };
  const size = 96,
    body = path.join(root, "body.png"),
    sword = path.join(root, "blade.png");
  fs.writeFileSync(body, encodePngRgba(new Uint8ClampedArray(size * size * 4), size, size));
  const pixels = new Uint8ClampedArray(40 * 9 * 4);
  for (let x = 0; x < 40; x++)
    for (let y = x === 4 ? 0 : 3; y <= (x === 4 ? 8 : 5); y++)
      pixels.set([255, 255, 255, 255], 4 * (40 * y + x));
  fs.writeFileSync(sword, encodePngRgba(pixels, 40, 9));
  await call("xsxb_create_project", { project_id: "swing" });
  await call("xsxb_import_animation", {
    source: "items",
    animation_id: "attack",
    items: Array.from({ length: 5 }, () => ({ path: body })),
  });
  const poses = [
    [-12, -40, -85],
    [-5, -54, -40],
    [6, -48, 5],
    [11, -38, 45],
  ];
  const frames = poses.map(([offset_x, offset_y, rotation], frame) => ({
    frame,
    offset_x,
    offset_y,
    rotation,
  }));
  await call("xsxb_add_attachment", { file_path: sword, id: "blade", frames });
  const args = {
    brush_preset: "weapon_motion",
    start_frame: 0,
    end_frame: 3,
    color: "#00ff00",
    trail_duration_ms: 160,
    preview: false,
  };
  const hit = await call("xsxb_add_attack_trail", args);
  assert.equal(hit.segment.sticks.length, 4);
  const greenPixels = async (frame) => {
    const sheet = await call("xsxb_export_sheet", {
      start_frame: frame,
      end_frame: frame,
      grid: false,
      normalize: "none",
      cell: size,
      pad: 1,
      columns: 1,
    });
    const img = decodePngRgba(sheet.outputPath),
      points = [];
    for (let y = 0; y < img.height; y++)
      for (let x = 0; x < img.width; x++) {
        const k = 4 * (img.width * y + x);
        if (img.data[k + 1] - Math.max(img.data[k], img.data[k + 2]) > 35)
          points.push([x - (img.width - size) / 2, y - (img.height - size) / 2]);
      }
    return points;
  };
  for (let frame = 1; frame <= 3; frame++) {
    const [x, y, angle] = poses[frame],
      theta = (angle * Math.PI) / 180;
    const tip = [size / 2 + x + 19 * Math.cos(theta), size + y + 19 * Math.sin(theta)];
    const points = await greenPixels(frame);
    assert.ok(points.length > 15);
    assert.ok(
      points.some(([px, py]) => Math.hypot(px - tip[0], py - tip[1]) < 5),
      `missing trail at displayed tip on frame ${frame}`,
    );
  }
  assert.deepEqual(await greenPixels(4), []);
  const retime = await call("xsxb_add_attack_trail", { ...args, start_frame: 1 });
  assert.equal(retime.id, hit.id);
  const reused = await call("xsxb_add_attack_trail", {
    id: hit.id,
    start_frame: 0,
    end_frame: 3,
    preview: false,
  });
  assert.equal(reused.segment.trailDurationMs, 160);
  assert.equal(reused.segment.brushSource, "motion:blade");
  await call("xsxb_update_timing", {
    frames: [
      { frame: 0, duration_ms: 80 },
      { frame: 1, duration_ms: 40 },
      { frame: 2, duration_ms: 90 },
    ],
  });
  const combo = await call("xsxb_add_attack_trail", {
    brush_preset: "weapon_motion",
    preview: false,
    hits: [
      { id: "quick", start_frame: 0, end_frame: 1, trail_duration_ms: 40 },
      { id: "measured", start_frame: 1, end_frame: 3 },
    ],
  });
  assert.deepEqual(
    combo.hits.map((h) => h.segment.trailDurationMs),
    [40, 130],
  );
  assert.equal(combo.hits[1].arcReview.sweepDegrees, 85);
  assert.deepEqual(combo.hits[1].arcReview.reversalFrames, []);
  const remapped = await call("xsxb_add_attack_trail", {
    id: "measured",
    start_frame: 0,
    end_frame: 3,
    preview: false,
  });
  assert.equal(remapped.segment.trailDurationMs, 210);
});

test("swing history crosses angle wrap and starts a new arc at reversal", () => {
  const { reviewSwing } = require("../../mcp/xsxb_mcp_weapon_trail");
  const poses = [160, 160, 175, -165, 170, 150, 150].map((deg, frame) => ({
    frame,
    top: { x: Math.cos((deg * Math.PI) / 180), y: Math.sin((deg * Math.PI) / 180) },
    bottom: { x: 0, y: 0 },
  }));
  assert.deepEqual(reviewSwing(poses, [0.5, 0.1, 0.2, 0.04, 0.06, 0.8, 0.1]), {
    sweepDegrees: 45,
    swingMs: 100,
    suggestedHistoryMs: 100,
    reversalFrames: [3],
  });
});

test("weapon frame lookup keeps identically named animations in different profiles separate", () => {
  const entries = [
    { id: "other", key: "b/attack:3" },
    { id: "compact", key: "a/attack:3" },
    { id: "workbench", key: "demo:runtime:a:actor:attack:src:3" },
    { id: "legacy", frame: 3, metadata: { animation: "a/attack" } },
  ];
  assert.deepEqual(
    attachmentFrames(entries, "a/attack")
      .get(3)
      .map((e) => e.id),
    ["compact", "workbench", "legacy"],
  );
});
