"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createProjectStore } = require("../project_store");
const { createXsxbMcpService } = require("../xsxb_mcp_service");
const { encodePngRgba } = require("../xsxb_mcp_cutout");
const {
  assembleGodotValidation,
  classifyInspectQa,
  composeValidationEvidence,
  evaluateScaleContract,
  isFxOrAirborne,
  measureKeyedSubject,
} = require("../../mcp/xsxb_mcp_validate_godot");
const { composeFrameDiff } = require("../../mcp/xsxb_mcp_diff_frames");
const { paintGroundedActor } = require("../acceptance_playbooks");

const BOOT = Object.freeze([210, 36, 42, 255]);

/**
 * Opaque standing block whose sole sits on an explicit canvas row.
 * @param {number} width Canvas width.
 * @param {number} height Canvas height.
 * @param {number} feetY Sole row.
 * @returns {{data:Uint8ClampedArray,width:number,height:number}} RGBA frame.
 */
function bodyOnCanvas(width, height, feetY) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  const bodyW = 8;
  const bodyH = 12;
  const left = Math.floor((width - bodyW) / 2);
  const top = feetY - bodyH + 1;
  for (let y = top; y <= feetY; y += 1) {
    for (let x = left; x < left + bodyW; x += 1) {
      rgba.set(BOOT, (y * width + x) * 4);
    }
  }
  return { data: rgba, width, height };
}

test("evaluateScaleContract skips VFX and fails grounded feet drift", () => {
  const contract = evaluateScaleContract([
    { id: "idle", grounded: true, feetY: 23, bodyH: 14 },
    { id: "walk", grounded: true, feetY: 17, bodyH: 14 },
    { id: "hit_vfx", grounded: false, feetY: 4, bodyH: 14 },
  ]);
  assert.equal(contract.ok, false);
  assert.equal(contract.reference, "idle");
  assert.ok(contract.issues.some((issue) => /walk/.test(issue) && /feet/.test(issue)));
  assert.ok(!contract.issues.some((issue) => /hit_vfx/.test(issue)));
});

test("evaluateScaleContract flags intra-clip sole bounce", () => {
  const contract = evaluateScaleContract([
    { id: "idle", grounded: true, feetYs: [23, 17], bodyHs: [14, 14] },
  ]);
  assert.equal(contract.ok, false);
  assert.ok(contract.issues.some((issue) => /spans/.test(issue)));
});

test("evaluateScaleContract fails when grounded canvas height differs from idle", () => {
  const contract = evaluateScaleContract([
    { id: "idle", grounded: true, feetY: 256, bodyH: 200, canvasW: 256, canvasH: 264 },
    { id: "walk", grounded: true, feetY: 255, bodyH: 200, canvasW: 256, canvasH: 256 },
    { id: "hit_vfx", grounded: false, feetY: 4, bodyH: 200, canvasW: 64, canvasH: 64 },
  ]);
  assert.equal(contract.ok, false);
  assert.equal(contract.reference, "idle");
  assert.ok(contract.issues.some((issue) => /walk/.test(issue) && /canvas/.test(issue) && /256/.test(issue)));
  assert.ok(!contract.issues.some((issue) => /hit_vfx/.test(issue)));
  const walk = contract.clips.find((clip) => clip.id === "walk");
  assert.ok(walk);
  assert.equal(walk.canvasW, 256);
  assert.equal(walk.canvasH, 256);
  assert.equal(walk.dCanvasW, 0);
  assert.equal(walk.dCanvasH, -8);
  assert.equal(walk.dFeet, -1);
});

test("evaluateScaleContract fails when grounded canvas width differs from idle", () => {
  const contract = evaluateScaleContract([
    { id: "idle", grounded: true, feetY: 20, bodyH: 14, canvasW: 264, canvasH: 256 },
    { id: "walk", grounded: true, feetY: 20, bodyH: 14, canvasW: 256, canvasH: 256 },
  ]);
  assert.equal(contract.ok, false);
  const walk = contract.clips.find((clip) => clip.id === "walk");
  assert.equal(walk.dCanvasW, -8);
  assert.equal(walk.dCanvasH, 0);
  assert.ok(contract.issues.some((issue) => /width/.test(issue)));
});

test("evaluateScaleContract accepts matching canvases with 1px feet slop", () => {
  const contract = evaluateScaleContract([
    { id: "idle", grounded: true, feetY: 256, bodyH: 14, canvasW: 256, canvasH: 264 },
    { id: "walk", grounded: true, feetY: 255, bodyH: 14, canvasW: 256, canvasH: 264 },
  ]);
  assert.equal(contract.ok, true);
  assert.equal(contract.clips[1].dCanvasH, 0);
  assert.equal(contract.clips[1].dFeet, -1);
});

test("evaluateScaleContract accepts 3px shorter attack when feet and canvas match", () => {
  const contract = evaluateScaleContract([
    { id: "idle", grounded: true, feetY: 256, bodyH: 196, canvasW: 256, canvasH: 264 },
    { id: "attack", grounded: true, feetY: 256, bodyH: 193, canvasW: 256, canvasH: 264 },
  ]);
  assert.equal(contract.ok, true);
  const attack = contract.clips.find((clip) => clip.id === "attack");
  assert.ok(attack);
  assert.equal(attack.dBody, -3);
  assert.equal(attack.dFeet, 0);
  assert.equal(attack.dCanvasH, 0);
});

test("evaluateScaleContract fails walk with 3px body height drift", () => {
  const contract = evaluateScaleContract([
    { id: "idle", grounded: true, feetY: 256, bodyH: 196, canvasW: 256, canvasH: 264 },
    { id: "walk", grounded: true, feetY: 256, bodyH: 193, canvasW: 256, canvasH: 264 },
  ]);
  assert.equal(contract.ok, false);
  const walk = contract.clips.find((clip) => clip.id === "walk");
  assert.ok(walk);
  assert.equal(walk.dBody, -3);
  assert.ok(contract.issues.some((issue) => /walk/.test(issue) && /height/.test(issue)));
});

test("evaluateScaleContract uses attack height slop for slash and hurt tokens", () => {
  for (const clip of [{ id: "slash" }, { id: "hurt" }, { id: "combo_01", name: "sword slash" }]) {
    const contract = evaluateScaleContract([
      { id: "idle", grounded: true, feetY: 256, bodyH: 196, canvasW: 256, canvasH: 264 },
      { ...clip, grounded: true, feetY: 256, bodyH: 193, canvasW: 256, canvasH: 264 },
    ]);
    assert.equal(contract.ok, true, String(clip.id || clip.name));
  }
});

test("validate_for_godot scale contract fails 256-tall walk against 264-tall idle", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-mcp-canvas-gate-"));
  const godotRoot = path.join(root, "godot");
  fs.mkdirSync(godotRoot, { recursive: true });
  fs.writeFileSync(path.join(godotRoot, "project.godot"), '[application]\nconfig/name="CanvasGate"\n');
  createProjectStore(root).addProject({ id: "hero", label: "Hero", projectRoot: godotRoot });
  const service = createXsxbMcpService({
    root,
    encodeGifImpl: async (job) => {
      fs.writeFileSync(job.outputPath, Buffer.from("GIF89a-fake"));
    },
  });
  try {
    const idleDir = path.join(root, "idle-seq");
    const walkDir = path.join(root, "walk-seq");
    fs.mkdirSync(idleDir);
    fs.mkdirSync(walkDir);
    const idle = bodyOnCanvas(256, 264, 256);
    const walk = bodyOnCanvas(256, 256, 255);
    fs.writeFileSync(path.join(idleDir, "01.png"), encodePngRgba(idle.data, idle.width, idle.height));
    fs.writeFileSync(path.join(walkDir, "01.png"), encodePngRgba(walk.data, walk.width, walk.height));
    await service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: idleDir,
      animation_id: "idle",
    });
    await service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: walkDir,
      animation_id: "walk",
    });
    const gate = await service.call("xsxb_validate_for_godot", {
      project_id: "hero",
      require_gameplay: false,
    });
    assert.equal(gate.scale_contract.ok, false);
    assert.notEqual(gate.qa, "clean");
    const walkClip = gate.scale_contract.clips.find((clip) => clip.id === "walk");
    assert.equal(walkClip.canvasH, 256);
    assert.equal(walkClip.dCanvasH, -8);
    assert.ok(gate.scale_contract.issues.some((issue) => /canvas/.test(issue) && /walk/.test(issue)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Bound Godot fixture with one imported idle clip and no Godot sync.
 * @returns {Promise<{root:string,godotRoot:string,service:object,cleanup:Function}>} Isolated service.
 */
async function boundIdleWithoutSync() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-mcp-validate-stale-"));
  const godotRoot = path.join(root, "godot");
  fs.mkdirSync(godotRoot, { recursive: true });
  fs.writeFileSync(path.join(godotRoot, "project.godot"), '[application]\nconfig/name="StaleTune"\n');
  createProjectStore(root).addProject({ id: "hero", label: "Hero", projectRoot: godotRoot });
  const service = createXsxbMcpService({
    root,
    encodeGifImpl: async (job) => {
      fs.writeFileSync(job.outputPath, Buffer.from("GIF89a-fake"));
    },
  });
  const idleDir = path.join(root, "idle-seq");
  fs.mkdirSync(idleDir);
  const idle = bodyOnCanvas(32, 32, 28);
  fs.writeFileSync(path.join(idleDir, "01.png"), encodePngRgba(idle.data, idle.width, idle.height));
  fs.writeFileSync(path.join(idleDir, "02.png"), encodePngRgba(idle.data, idle.width, idle.height));
  await service.call("xsxb_import_animation", {
    source: "png_sequence",
    directory: idleDir,
    animation_id: "idle",
    sync: false,
  });
  return {
    root,
    godotRoot,
    service,
    cleanup: () => {
      service.close?.();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("validate_for_godot syncs stale game-local tuning after estimate_boxes without sync", async () => {
  const current = await boundIdleWithoutSync();
  try {
    const estimated = await current.service.call("xsxb_estimate_boxes", {
      animation_id: "idle",
      sync: false,
    });
    assert.equal(estimated.sync.requested, false);

    const gate = await current.service.call("xsxb_validate_for_godot", {
      project_id: "hero",
      require_gameplay: false,
    });
    assert.ok(
      !gate.errors.includes("Standalone and game-local animation_tuning.json differ."),
      `stale game-local tuning must be synced before validate: ${gate.errors.join("; ")}`,
    );
    assert.ok(
      !gate.errors.some((error) => error.startsWith("Game-local XSXB data file is missing:")),
      `missing game-local files must be synced: ${gate.errors.join("; ")}`,
    );
    const leftover = gate.errors.filter((error) => !/scale|canvas|feet|gameplay/i.test(error));
    assert.deepEqual(leftover, [], `only scale/import issues may remain: ${gate.errors.join("; ")}`);
    assert.equal(gate.scale_contract.ok, true);
  } finally {
    current.cleanup();
  }
});

test("validate_for_godot next lists missing gameplay stub after bind and sync", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-mcp-validate-gameplay-next-"));
  const godotRoot = path.join(root, "godot");
  fs.mkdirSync(godotRoot, { recursive: true });
  fs.writeFileSync(path.join(godotRoot, "project.godot"), '[application]\nconfig/name="GameplayNext"\n');
  const service = createXsxbMcpService({
    root,
    encodeGifImpl: async (job) => {
      fs.writeFileSync(job.outputPath, Buffer.from("GIF89a-fake"));
    },
  });
  try {
    await service.call("xsxb_create_project", { project_id: "hero", label: "Hero" });
    await service.call("xsxb_bind_godot", { project_id: "hero", project_root: godotRoot });
    const idleDir = path.join(root, "idle-seq");
    fs.mkdirSync(idleDir);
    const idle = bodyOnCanvas(32, 32, 28);
    fs.writeFileSync(path.join(idleDir, "01.png"), encodePngRgba(idle.data, idle.width, idle.height));
    await service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: idleDir,
      animation_id: "idle",
      sync: false,
    });
    await service.call("xsxb_sync_godot", { project_id: "hero" });
    const data = await service.call("xsxb_validate_for_godot", {
      project_id: "hero",
      require_gameplay: true,
    });
    assert.match(data.next, /xsxb_frame_actor|animation_duration|gameplay/i);
    assert.match(data.next, /xsxb_frame_actor/i);
    assert.match(data.next, /animation_duration/i);
    assert.ok(data.errors.includes("No non-runtime gameplay scene or script uses xsxb_frame_actor."));
  } finally {
    service.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("assembleGodotValidation next names gameplay stub when animation_duration is unused", () => {
  const data = assembleGodotValidation(
    {
      ok: true,
      errors: [],
      warnings: [
        "Gameplay uses XSXB runtime but does not appear to consume animation_duration for action timing.",
      ],
      summary: {},
    },
    { ok: true, issues: [] },
    { path: "/tmp/evidence.png", width: 32, height: 32 },
  );
  assert.match(data.next, /xsxb_frame_actor|animation_duration|gameplay/i);
  assert.match(data.next, /xsxb_frame_actor/i);
  assert.match(data.next, /animation_duration/i);
  assert.equal(data.ok, true);
  assert.ok(
    data.warnings.includes(
      "Gameplay uses XSXB runtime but does not appear to consume animation_duration for action timing.",
    ),
  );
});

test("validate_for_godot does not sync when Godot is unbound", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-mcp-validate-unbound-"));
  createProjectStore(root).addProject({ id: "hero", label: "Hero" });
  const service = createXsxbMcpService({
    root,
    encodeGifImpl: async (job) => {
      fs.writeFileSync(job.outputPath, Buffer.from("GIF89a-fake"));
    },
  });
  try {
    const idleDir = path.join(root, "idle-seq");
    fs.mkdirSync(idleDir);
    const idle = bodyOnCanvas(32, 32, 28);
    fs.writeFileSync(path.join(idleDir, "01.png"), encodePngRgba(idle.data, idle.width, idle.height));
    await service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: idleDir,
      animation_id: "idle",
      sync: false,
    });
    await service.call("xsxb_estimate_boxes", { animation_id: "idle", sync: false });
    const gate = await service.call("xsxb_validate_for_godot", {
      project_id: "hero",
      require_gameplay: false,
    });
    assert.ok(Array.isArray(gate.errors));
    assert.ok(
      gate.errors.some((error) => /project\.godot not found/i.test(error)),
      `unbound validate must report the missing bind, got: ${gate.errors.join("; ")}`,
    );
    assert.ok(
      !gate.errors.some((error) => /Use xsxb_bind_godot to retarget/i.test(error)),
      "unbound validate must not throw the sync-godot bind requirement",
    );
    assert.equal(fs.existsSync(path.join(root, "xsxb_frame_tuner")), false);
  } finally {
    service.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("validate_for_godot still reports import errors after recovering stale tuning", async () => {
  const current = await boundIdleWithoutSync();
  try {
    await current.service.call("xsxb_estimate_boxes", { animation_id: "idle", sync: false });
    const store = createProjectStore(current.root);
    const project = store.activeProject("hero");
    const tuningPath = store.projectPaths(project).tuning;
    const tuning = JSON.parse(fs.readFileSync(tuningPath, "utf8"));
    const boxKey = Object.keys(tuning.frame_box_overrides || {})[0];
    assert.ok(boxKey, "estimate_boxes must persist a standalone override");
    tuning.frame_box_overrides[boxKey].hurtbox = { offset: { x: 0, y: 0 }, size: { x: 0, y: 0 } };
    fs.writeFileSync(tuningPath, `${JSON.stringify(tuning, null, 2)}\n`);

    const gate = await current.service.call("xsxb_validate_for_godot", {
      project_id: "hero",
      require_gameplay: false,
    });
    assert.ok(
      !gate.errors.includes("Standalone and game-local animation_tuning.json differ."),
      `stale tuning must not hide the invalid box: ${gate.errors.join("; ")}`,
    );
    assert.ok(
      gate.errors.some((error) => /invalid hurtbox/.test(error)),
      `invalid standalone boxes must remain visible: ${gate.errors.join("; ")}`,
    );
    assert.equal(gate.ok, false);
  } finally {
    current.cleanup();
  }
});

test("validate_for_godot evidence is one cell per clip, not a 4-frame strip", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-mcp-evidence-clips-"));
  const godotRoot = path.join(root, "godot");
  fs.mkdirSync(godotRoot, { recursive: true });
  fs.writeFileSync(path.join(godotRoot, "project.godot"), '[application]\nconfig/name="EvidenceClips"\n');
  createProjectStore(root).addProject({ id: "hero", label: "Hero", projectRoot: godotRoot });
  const service = createXsxbMcpService({
    root,
    encodeGifImpl: async (job) => {
      fs.writeFileSync(job.outputPath, Buffer.from("GIF89a-fake"));
    },
  });
  const clips = [
    { id: "idle" },
    { id: "walk" },
    { id: "jump" },
    { id: "attack" },
    { id: "hit_vfx", animation_type: "vfx" },
  ];
  const cellW = 256;
  const cellH = 264;
  try {
    const body = bodyOnCanvas(cellW, cellH, 256);
    for (const clip of clips) {
      const directory = path.join(root, `${clip.id}-seq`);
      fs.mkdirSync(directory);
      const png = encodePngRgba(body.data, body.width, body.height);
      fs.writeFileSync(path.join(directory, "01.png"), png);
      fs.writeFileSync(path.join(directory, "02.png"), png);
      await service.call("xsxb_import_animation", {
        source: "png_sequence",
        directory,
        animation_id: clip.id,
        ...(clip.animation_type ? { animation_type: clip.animation_type } : {}),
      });
    }
    const gate = await service.call("xsxb_validate_for_godot", {
      project_id: "hero",
      require_gameplay: false,
    });
    assert.equal(gate.evidence.height, cellH);
    assert.notEqual(gate.evidence.width, cellW * 4, "evidence must not stay a 4-cell idle/walk strip");
    assert.equal(gate.evidence.width, cellW * clips.length);
    assert.ok(gate.evidence.width >= cellW * 5);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("isFxOrAirborne matches type and whole tokens, not substrings", () => {
  assert.equal(isFxOrAirborne({ id: "hit_vfx" }), true);
  assert.equal(isFxOrAirborne({ id: "jump" }), true);
  assert.equal(isFxOrAirborne({ id: "walk" }), false);
  assert.equal(isFxOrAirborne({ id: "jumper" }), false);
  assert.equal(isFxOrAirborne({ id: "proposition" }), false);
  assert.equal(isFxOrAirborne({ id: "effective" }), false);
  assert.equal(isFxOrAirborne({ id: "spark", type: "vfx" }), true);
  assert.equal(isFxOrAirborne({ id: "spark", type: "actor" }), false);
});

test("classifyInspectQa is warn on errors and review on a real diff", () => {
  assert.equal(classifyInspectQa({ errors: ["missing actor"] }), "warn");
  assert.equal(classifyInspectQa({ changedPixelCount: 0 }), "warn");
  assert.equal(classifyInspectQa({ changedPixelCount: 40 }), "review");
  assert.equal(classifyInspectQa({ errors: [], warnings: [], scaleOk: true }), "clean");
});

const MAGENTA = Object.freeze([255, 0, 255, 255]);

/**
 * Reads one RGBA pixel from a decoded bitmap.
 * @param {{data:Uint8ClampedArray,width:number}} image Sheet or frame.
 * @param {number} x Column.
 * @param {number} y Row.
 * @returns {number[]} `[r,g,b,a]`.
 */
function rgbaAt(image, x, y) {
  const offset = (y * image.width + x) * 4;
  return Array.from(image.data.subarray(offset, offset + 4));
}

/**
 * Empty RGBA canvas, optionally stamped with one opaque pixel.
 * @param {number} width Canvas width.
 * @param {number} height Canvas height.
 * @param {{x:number,y:number,rgba:number[]}} [stamp] Visible pixel to copy.
 * @returns {{data:Uint8ClampedArray,width:number,height:number}} Frame.
 */
function blankFrame(width, height, stamp) {
  const data = new Uint8ClampedArray(width * height * 4);
  if (stamp) data.set(stamp.rgba, (stamp.y * width + stamp.x) * 4);
  return { data, width, height };
}

test("composeValidationEvidence leaves opaque magenta under a 256-tall cell beside a 264-tall sibling", () => {
  const short = blankFrame(32, 256, { x: 4, y: 255, rgba: [10, 20, 30, 255] });
  const tall = blankFrame(32, 264, { x: 4, y: 0, rgba: [40, 50, 60, 255] });
  const sheet = composeValidationEvidence([short, tall]);
  assert.equal(sheet.width, 64);
  assert.equal(sheet.height, 264);
  assert.deepEqual(rgbaAt(sheet, 4, 255), [10, 20, 30, 255]);
  assert.deepEqual(rgbaAt(sheet, 4, 263), MAGENTA, "short cell must not scale into the extra rows");
  for (let y = 256; y < 264; y += 1) {
    assert.deepEqual(rgbaAt(sheet, 4, y), MAGENTA, `extra row ${y} must stay opaque #FF00FF`);
  }
});

test("composeValidationEvidence leaves opaque magenta under a 264-tall frame's transparent bottom pad", () => {
  const padded = blankFrame(32, 264, { x: 4, y: 0, rgba: [10, 20, 30, 255] });
  const sheet = composeValidationEvidence([padded]);
  assert.equal(sheet.height, 264);
  assert.deepEqual(rgbaAt(sheet, 4, 0), [10, 20, 30, 255]);
  for (let y = 256; y < 264; y += 1) {
    assert.deepEqual(
      rgbaAt(sheet, 4, y),
      MAGENTA,
      `transparent pad row ${y} must stay opaque #FF00FF, not a=0`,
    );
  }
});

test("measureKeyedSubject finds boot soles on a black plate", () => {
  const pixels = paintGroundedActor(32, 32, {
    originX: 8,
    originY: 10,
    plate: [0, 0, 0, 255],
  });
  const geometry = measureKeyedSubject({ data: pixels, width: 32, height: 32 });
  assert.equal(geometry.feetY, 23);
  assert.equal(geometry.bodyH, 14);
});

test("composeFrameDiff onion keys the plate so vacated columns are red", () => {
  const left = paintGroundedActor(32, 32, { originX: 8, originY: 10 });
  const right = paintGroundedActor(32, 32, { originX: 12, originY: 10 });
  const onion = composeFrameDiff(
    { width: 32, height: 32, data: left },
    { width: 32, height: 32, data: right },
    {
      mode: "onion",
    },
  );
  let red = 0;
  let cyan = 0;
  let white = 0;
  for (let i = 0; i < onion.data.length; i += 4) {
    const r = onion.data[i];
    const g = onion.data[i + 1];
    const b = onion.data[i + 2];
    const a = onion.data[i + 3];
    if (r >= 180 && g <= 40 && b <= 40 && a > 200) red += 1;
    if (r <= 40 && g >= 180 && b >= 180 && a > 200) cyan += 1;
    if (r >= 220 && g >= 220 && b >= 220 && a > 200) white += 1;
  }
  assert.ok(red >= 20, `vacated subject must be red, got ${red}`);
  assert.ok(cyan >= 20, `new subject must be cyan, got ${cyan}`);
  assert.ok(white >= 20, `overlap must stay white, got ${white}`);
  assert.ok(red + cyan + white < 32 * 32, "plate must stay off after keying");
});
