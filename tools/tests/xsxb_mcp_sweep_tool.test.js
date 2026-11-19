"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createXsxbMcpService } = require("../../mcp/xsxb_mcp_service");
const { encodePngRgba, decodePngRgba } = require("../../mcp/xsxb_mcp_cutout");
const { compositeAttackTrails } = require("../../mcp/xsxb_mcp_trail_preview");

/** Exercises persisted sweep bindings and the same compositor used by sheet/GIF export. */
test("sweep tool bakes linear blade history and expires by elapsed time", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-sweep-tool-"));
  const service = createXsxbMcpService({ root, florenceDetectImpl: null });
  let baked;
  try {
    const sequence = path.join(root, "frames");
    fs.mkdirSync(sequence);
    const framePaths = Array.from({ length: 6 }, (_, index) => path.join(sequence, `${index}.png`));
    for (const file of framePaths)
      fs.writeFileSync(file, encodePngRgba(new Uint8ClampedArray(64 * 64 * 4), 64, 64));
    const created = await service.callMcp("xsxb_create_project", { project_id: "sweep", label: "Sweep" });
    assert.ok(created.ok, JSON.stringify(created));
    const imported = await service.callMcp("xsxb_import_animation", {
      project_id: "sweep",
      source: "png_sequence",
      directory: sequence,
      animation_id: "attack",
      fps: 10,
    });
    assert.ok(imported.ok, JSON.stringify(imported));
    const added = await service.callMcp("xsxb_add_attack_trail", {
      project_id: "sweep",
      animation_id: "attack",
      id: "sweep",
      render_mode: "sweep",
      path_kind: "polyline",
      trail_duration_ms: 150,
      opacity: 1,
      color: "#00aaff",
      sticks: [
        { frame: 0, top: { x: -20, y: -40 }, bottom: { x: -20, y: -20 }, layer: "front" },
        { frame: 1, top: { x: 0, y: -40 }, bottom: { x: 0, y: -20 }, layer: "front" },
        { frame: 2, top: { x: 20, y: -40 }, bottom: { x: 20, y: -20 }, layer: "front" },
      ],
    });
    assert.ok(added.ok, JSON.stringify(added));
    assert.equal(added.data.segment.renderMode, "sweep");
    baked = await compositeAttackTrails({
      root,
      framePaths,
      frameIndexes: [0, 1, 2, 3, 4, 5],
      fps: 10,
      durations: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
      bindingKey: added.data.bindingKey,
      trails: { bindings: { [added.data.bindingKey]: [added.data.segment] } },
    });
    assert.equal(baked.bakedTrails, true);
    const active = decodePngRgba(baked.framePaths[1]);
    const visible = Array.from(active.data).filter((value, index) => index % 4 === 3 && value > 32).length;
    assert.ok(visible > 100, `Expected visible filled ribbon, got ${visible}`);
    const expired = decodePngRgba(baked.framePaths[4]);
    assert.ok(
      expired.data.every((value, index) => index % 4 !== 3 || value === 0),
      "No visible trail after lifetime",
    );
    const sheet = await service.callMcp("xsxb_export_sheet", {
      project_id: "sweep",
      animation_id: "attack",
      grid: false,
      output_path: path.join(root, "sheet.png"),
    });
    assert.ok(sheet.ok, JSON.stringify(sheet));
    await assert.rejects(
      service.callMcp("xsxb_add_attack_trail", {
        project_id: "sweep",
        animation_id: "attack",
        render_mode: "sweep",
      }),
      { code: "SWEEP_STICKS_REQUIRED" },
    );
  } finally {
    service.close();
    if (baked?.tempDir) fs.rmSync(baked.tempDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("synced Godot sweep tracks blade coordinates and fades on a held final frame", async (t) => {
  const { spawnSync } = require("node:child_process");
  if (spawnSync("godot", ["--version"]).error?.code === "ENOENT") {
    t.skip("Godot executable unavailable");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-godot-sweep-"));
  const game = path.join(root, "game");
  const service = createXsxbMcpService({ root, florenceDetectImpl: null });
  t.after(() => {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(game);
  fs.writeFileSync(
    path.join(game, "project.godot"),
    'config_version=5\n[application]\nconfig/name="Sweep test"\n',
  );
  const png = path.join(root, "frame.png");
  fs.writeFileSync(png, encodePngRgba(new Uint8ClampedArray(64 * 64 * 4), 64, 64));
  await service.callMcp("xsxb_create_project", { project_id: "qa" });
  await service.callMcp("xsxb_import_animation", {
    source: "items",
    items: [{ path: png }, { path: png }],
    animation_id: "slash",
    fps: 10,
  });
  await service.callMcp("xsxb_bind_godot", { project_root: game });
  await service.callMcp("xsxb_add_attachment", { file_path: png, frame: 1, offset_x: 3, offset_y: -10 });
  const result = await service.callMcp("xsxb_add_attack_trail", {
    sync: true,
    render_mode: "sweep",
    trail_duration_ms: 150,
    sticks: [
      { frame: 0, top: { x: -20, y: -40 }, bottom: { x: -20, y: -20 }, layer: "front" },
      { frame: 1, top: { x: 20, y: -40 }, bottom: { x: 20, y: -20 }, layer: "front" },
    ],
  });
  assert.equal(result.data.sync.ok, true);
  fs.writeFileSync(
    path.join(game, "check.gd"),
    `extends SceneTree
func _initialize() -> void:
	call_deferred("check")
func check() -> void:
	var actor = load("res://xsxb_frame_tuner/runtime/xsxb_frame_actor.tscn").instantiate()
	root.add_child(actor)
	actor.set_process(false)
	actor.restart_frame_animation("slash", false)
	actor._process(0.15)
	var front = actor.get_node("AttackTrailsFront")
	var behind = actor.get_node("AttackTrailsBehind")
	if front.get_child_count() != 1 or behind.get_child_count() != 0:
		quit(1)
		return
	var ribbon = front.get_child(0)
	if not ribbon.visible or ribbon.material != null or ribbon.mesh.get_surface_count() != 1:
		quit(2)
		return
	var points = ribbon.mesh.surface_get_arrays(0)[Mesh.ARRAY_VERTEX]
	var attachment = actor.get_node("VisualOwner/AttachmentsAbove").get_child(0)
	var sprite = actor.get_node("VisualOwner/FrameSprite")
	var grip = sprite.to_local(attachment.global_position)
	var head = sprite.to_local(ribbon.to_global(points[-1]))
	if not grip.is_equal_approx(Vector2(3,22)) or not head.is_equal_approx(Vector2(10,-8)):
		quit(3)
		return
	actor._process(0.09)
	if not ribbon.visible:
		quit(4)
		return
	actor._process(0.2)
	if ribbon.visible:
		quit(5)
		return
	print("sweep passed")
	quit()
`,
  );
  const run = spawnSync(
    "godot",
    ["--headless", "--path", game, "--script", "check.gd", "--quit-after", "30"],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stderr, /SCRIPT ERROR|^ERROR:/m);
  assert.match(run.stdout, /sweep passed/);
});

test("drawing a pixel sprite at its native size preserves individual texels", () => {
  const { SoftwareCanvas } = require("../../mcp/lib/xsxb_software_canvas");
  const data = new Uint8ClampedArray([16, 200, 90, 255, 237, 18, 222, 255]);
  for (const smooth of [false, true]) {
    const ctx = new SoftwareCanvas(2, 1).getContext("2d");
    ctx.imageSmoothingEnabled = smooth;
    ctx.drawImage({ data, width: 2, height: 1 }, 0, 0);
    assert.deepEqual(ctx.getImageData(0, 0, 2, 1).data, data);
  }
});
