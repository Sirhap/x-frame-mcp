"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createProjectStore } = require("../project_store");
const { createXsxbMcpService } = require("../xsxb_mcp_service");
const { decodePngRgba, encodePngRgba } = require("../xsxb_mcp_cutout");
const {
  assembleGodotValidation,
  classifyInspectQa,
  composeValidationEvidence,
  evaluateScaleContract,
  isFxOrAirborne,
  measureKeyedSubject,
  pickValidationEvidenceFrameIndex,
} = require("../../mcp/xsxb_mcp_validate_godot");
const { composeFrameDiff } = require("../../mcp/xsxb_mcp_diff_frames");
const { borderFloodKey } = require("../../mcp/xsxb_mcp_lock");
const { paintGroundedActor } = require("../acceptance_playbooks");

const BOOT = Object.freeze([210, 36, 42, 255]);

/**
 * Opaque standing block whose sole sits on an explicit canvas row.
 * @param {number} width Canvas width.
 * @param {number} height Canvas height.
 * @param {number} feetY Sole row.
 * @param {number} [bodyH=12] Body height in pixels (headY = feetY - bodyH + 1).
 * @returns {{data:Uint8ClampedArray,width:number,height:number}} RGBA frame.
 */
function bodyOnCanvas(width, height, feetY, bodyH = 12) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  const bodyW = 8;
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

const STEEL = Object.freeze([200, 204, 214, 255]);
const CRESCENT_GOLD = Object.freeze([255, 214, 56, 255]);
const NAVY = Object.freeze([36, 58, 118, 255]);

/**
 * Tiny grounded actor: optional left-hand steel sword or right-hand gold crescent.
 * @param {number} width Canvas width.
 * @param {number} height Canvas height.
 * @param {{sword?:boolean,crescent?:boolean}} [options] Windup blade vs slash arc.
 * @returns {{data:Uint8ClampedArray,width:number,height:number}} RGBA frame.
 */
function attackPoseFrame(width, height, options = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  const bodyW = 8;
  const bodyH = 16;
  const left = Math.floor((width - bodyW) / 2);
  const feetY = height - 3;
  const top = feetY - bodyH + 1;
  for (let y = top; y <= feetY; y += 1) {
    for (let x = left; x < left + bodyW; x += 1) {
      data.set(NAVY, (y * width + x) * 4);
    }
  }
  if (options.sword) {
    for (let y = top + 2; y < top + 12; y += 1) {
      for (let x = left - 3; x < left; x += 1) {
        if (x >= 0) data.set(STEEL, (y * width + x) * 4);
      }
    }
  }
  if (options.crescent) {
    for (let y = top + 3; y < top + 11; y += 1) {
      for (let x = left + bodyW - 2; x < left + bodyW + 18; x += 1) {
        if (x < width) data.set(CRESCENT_GOLD, (y * width + x) * 4);
      }
    }
  }
  return { data, width, height };
}

/**
 * Counts saturated gold/yellow slash pixels (same family as lock crescent gold).
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} image Frame or cell.
 * @returns {number} Gold pixel count.
 */
function countCrescentGold(image) {
  let count = 0;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const r = image.data[offset];
    const g = image.data[offset + 1];
    const b = image.data[offset + 2];
    const a = image.data[offset + 3];
    if (a <= 16) continue;
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    if (r >= 220 && g >= 180 && b <= 180 && r - b >= 50 && g - b >= 20 && sat >= 40) count += 1;
  }
  return count;
}

/**
 * Copies one evidence cell into its own bitmap.
 * @param {{data:Uint8ClampedArray,width:number,height:number}} sheet Magenta strip.
 * @param {number} index Cell index.
 * @param {number} cellW Cell width.
 * @returns {{data:Uint8ClampedArray,width:number,height:number}} Cell.
 */
function evidenceCell(sheet, index, cellW) {
  const cellH = sheet.height;
  const data = new Uint8ClampedArray(cellW * cellH * 4);
  const originX = index * cellW;
  for (let y = 0; y < cellH; y += 1) {
    for (let x = 0; x < cellW; x += 1) {
      const source = (y * sheet.width + originX + x) * 4;
      data.set(sheet.data.subarray(source, source + 4), (y * cellW + x) * 4);
    }
  }
  return { data, width: cellW, height: cellH };
}

/**
 * Counts subject pixels after studio-plate keying.
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} image Frame or cell.
 * @returns {number} Opaque occupancy (`a > 16`).
 */
function keyedOpaqueCount(image) {
  const keyed = borderFloodKey(image.data, image.width, image.height, { mode: "any" });
  let count = 0;
  for (let offset = 3; offset < keyed.data.length; offset += 4) {
    if (keyed.data[offset] > 16) count += 1;
  }
  return count;
}

test("pickValidationEvidenceFrameIndex skips plated windup gold and takes the slash crescent", () => {
  const windup = decodePngRgba(path.join(__dirname, "../fixtures/generated_hero/attack/00.png"));
  const slash = decodePngRgba(path.join(__dirname, "../fixtures/generated_hero/attack/01.png"));
  assert.ok(countCrescentGold(slash) > countCrescentGold(windup));
  assert.equal(
    pickValidationEvidenceFrameIndex({ id: "attack" }, [
      { image: windup, hitbox: { enabled: false } },
      { image: slash, hitbox: { enabled: false } },
    ]),
    1,
    "hair/belt gold on windup must not beat a reaching slash crescent",
  );
});

test("pickValidationEvidenceFrameIndex prefers enabled hit, else gold, else 0", () => {
  const windup = attackPoseFrame(64, 40, { sword: true });
  const slash = attackPoseFrame(64, 40, { crescent: true });
  const recover = attackPoseFrame(64, 40, { sword: true });
  assert.equal(
    pickValidationEvidenceFrameIndex({ id: "attack" }, [
      { image: windup, hitbox: { enabled: false } },
      { image: slash, hitbox: { enabled: true } },
      { image: recover, hitbox: { enabled: false } },
    ]),
    1,
  );
  assert.equal(
    pickValidationEvidenceFrameIndex({ id: "slash", name: "sword slash" }, [
      { image: windup, hitbox: { enabled: false } },
      { image: slash, hitbox: { enabled: false } },
    ]),
    1,
    "gold crescent is the fallback when every hitbox is disabled",
  );
  assert.equal(
    pickValidationEvidenceFrameIndex({ id: "walk" }, [
      { image: windup, hitbox: { enabled: false } },
      { image: slash, hitbox: { enabled: true } },
    ]),
    0,
    "non-attack clips stay on frame 0",
  );
  assert.equal(
    pickValidationEvidenceFrameIndex({ id: "hurt" }, [
      { image: windup, hitbox: { enabled: true } },
      { image: slash, hitbox: { enabled: true } },
    ]),
    0,
  );
  assert.equal(pickValidationEvidenceFrameIndex({ id: "attack" }, []), 0);
});

test("pickValidationEvidenceFrameIndex picks jump apex, not crouch, and ignores jumper", () => {
  const width = 32;
  const height = 32;
  const crouch = bodyOnCanvas(width, height, height - 1);
  const rise = bodyOnCanvas(width, height, height - 8);
  const apex = bodyOnCanvas(width, height, height - 16);
  const land = bodyOnCanvas(width, height, height - 3);
  const jumpFrames = [{ image: crouch }, { image: rise }, { image: apex }, { image: land }];
  assert.equal(
    measureKeyedSubject(crouch).feetY,
    height - 1,
    "frame 0 must be a grounded crouch with soles on the bottom row",
  );
  assert.ok(
    measureKeyedSubject(apex).feetY < measureKeyedSubject(crouch).feetY - 4,
    "apex boots must sit several rows higher than the crouch",
  );
  assert.equal(
    pickValidationEvidenceFrameIndex({ id: "jump" }, jumpFrames),
    2,
    "jump evidence must be the airborne apex (highest sole), not crouch frame 0",
  );
  assert.equal(
    pickValidationEvidenceFrameIndex({ id: "airborne" }, [{ image: crouch }, { image: apex }]),
    1,
    "whole airborne token uses the same apex pick as jump",
  );
  assert.equal(
    pickValidationEvidenceFrameIndex({ id: "jumper" }, jumpFrames),
    0,
    "jumper is not a whole jump token and must stay on frame 0",
  );
});

test("pickValidationEvidenceFrameIndex picks generated jump apex, not takeoff", () => {
  const jumpDir = path.join(__dirname, "../fixtures/generated_hero/jump");
  const frames = ["00", "01", "02", "03"].map((name) => ({
    image: decodePngRgba(path.join(jumpDir, `${name}.png`)),
  }));
  assert.equal(
    pickValidationEvidenceFrameIndex({ id: "jump" }, frames),
    2,
    "generated jump evidence must be apex 02 (highest head among near-highest soles), not takeoff 01",
  );
});

test("pickValidationEvidenceFrameIndex picks apex when takeoff sole is 1px higher", () => {
  const width = 32;
  const height = 40;
  const crouch = bodyOnCanvas(width, height, 36);
  const takeoff = bodyOnCanvas(width, height, 20, 10);
  const apex = bodyOnCanvas(width, height, 21, 16);
  const land = bodyOnCanvas(width, height, 35);
  const takeoffGeometry = measureKeyedSubject(takeoff);
  const apexGeometry = measureKeyedSubject(apex);
  assert.equal(takeoffGeometry.feetY, 20, "takeoff sole is one row higher than apex");
  assert.equal(apexGeometry.feetY, 21);
  assert.ok(
    apexGeometry.headY < takeoffGeometry.headY,
    `apex head must sit above takeoff (${apexGeometry.headY} vs ${takeoffGeometry.headY})`,
  );
  assert.equal(
    pickValidationEvidenceFrameIndex({ id: "jump" }, [
      { image: crouch },
      { image: takeoff },
      { image: apex },
      { image: land },
    ]),
    2,
    "near-min soles must break ties by highest head, not unique smallest feetY",
  );
});

test("validate_for_godot attack evidence cell is the slash, not windup", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-mcp-evidence-slash-"));
  const godotRoot = path.join(root, "godot");
  fs.mkdirSync(godotRoot, { recursive: true });
  fs.writeFileSync(path.join(godotRoot, "project.godot"), '[application]\nconfig/name="EvidenceSlash"\n');
  createProjectStore(root).addProject({ id: "hero", label: "Hero", projectRoot: godotRoot });
  const service = createXsxbMcpService({
    root,
    encodeGifImpl: async (job) => {
      fs.writeFileSync(job.outputPath, Buffer.from("GIF89a-fake"));
    },
  });
  const cellW = 64;
  const cellH = 40;
  const idle = attackPoseFrame(cellW, cellH);
  const windup = attackPoseFrame(cellW, cellH, { sword: true });
  const slash = attackPoseFrame(cellW, cellH, { crescent: true });
  try {
    const idleDir = path.join(root, "idle-seq");
    const attackDir = path.join(root, "attack-seq");
    fs.mkdirSync(idleDir);
    fs.mkdirSync(attackDir);
    fs.writeFileSync(path.join(idleDir, "01.png"), encodePngRgba(idle.data, idle.width, idle.height));
    fs.writeFileSync(path.join(attackDir, "00.png"), encodePngRgba(windup.data, windup.width, windup.height));
    fs.writeFileSync(path.join(attackDir, "01.png"), encodePngRgba(slash.data, slash.width, slash.height));
    await service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: idleDir,
      animation_id: "idle",
    });
    await service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: attackDir,
      animation_id: "attack",
    });
    await service.call("xsxb_estimate_boxes", { animation_id: "attack", replace: true });
    await service.call("xsxb_update_frame_boxes", {
      animation_id: "attack",
      frames: [
        { frame: 0, hitbox: { enabled: false, offset: { x: 0, y: -8 }, size: { x: 8, y: 8 } } },
        { frame: 1, hitbox: { enabled: true, offset: { x: 12, y: -14 }, size: { x: 20, y: 10 } } },
      ],
    });
    const gate = await service.call("xsxb_validate_for_godot", {
      project_id: "hero",
      require_gameplay: false,
    });
    assert.equal(gate.evidence.width, cellW * 2, "still one cell per clip (idle + attack)");
    assert.equal(gate.evidence.height, cellH);
    const sheet = decodePngRgba(gate.evidence.path);
    const attackCell = evidenceCell(sheet, 1, cellW);
    const slashGold = countCrescentGold(slash);
    const cellGold = countCrescentGold(attackCell);
    assert.ok(slashGold > 0, "slash fixture must contain a gold crescent");
    assert.equal(countCrescentGold(windup), 0, "windup must stay sword-only");
    assert.equal(countCrescentGold(evidenceCell(sheet, 0, cellW)), 0, "idle cell stays pose 0");
    assert.ok(cellGold > 0, "attack evidence cell must show the gold crescent, not windup");
    assert.equal(cellGold, slashGold, "attack cell occupancy must match the slash frame");
    assert.deepEqual(
      gate.evidence.cells,
      [
        { id: "idle", frame: 0 },
        { id: "attack", frame: 1 },
      ],
      "receipt must name the idle pose and attack slash indexes without decoding the PNG",
    );
  } finally {
    service.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("validate_for_godot generated jump evidence cell is apex 02", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-mcp-evidence-jump-"));
  const godotRoot = path.join(root, "godot");
  fs.mkdirSync(godotRoot, { recursive: true });
  fs.writeFileSync(path.join(godotRoot, "project.godot"), '[application]\nconfig/name="EvidenceJump"\n');
  createProjectStore(root).addProject({ id: "hero", label: "Hero", projectRoot: godotRoot });
  const service = createXsxbMcpService({
    root,
    encodeGifImpl: async (job) => {
      fs.writeFileSync(job.outputPath, Buffer.from("GIF89a-fake"));
    },
  });
  const fixtureRoot = path.join(__dirname, "../fixtures/generated_hero");
  const apex = decodePngRgba(path.join(fixtureRoot, "jump/02.png"));
  const cellW = apex.width;
  try {
    const idleDir = path.join(root, "idle-seq");
    const jumpDir = path.join(root, "jump-seq");
    fs.mkdirSync(idleDir);
    fs.mkdirSync(jumpDir);
    fs.copyFileSync(path.join(fixtureRoot, "idle/00.png"), path.join(idleDir, "00.png"));
    for (const name of ["00", "01", "02", "03"]) {
      fs.copyFileSync(path.join(fixtureRoot, "jump", `${name}.png`), path.join(jumpDir, `${name}.png`));
    }
    await service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: idleDir,
      animation_id: "idle",
    });
    await service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: jumpDir,
      animation_id: "jump",
    });
    const gate = await service.call("xsxb_validate_for_godot", {
      project_id: "hero",
      require_gameplay: false,
    });
    assert.deepEqual(
      gate.evidence.cells,
      [
        { id: "idle", frame: 0 },
        { id: "jump", frame: 2 },
      ],
      "receipt must name jump apex 02 so agents do not decode the evidence PNG",
    );
    assert.equal(gate.evidence.width, cellW * 2, "one cell per imported clip (idle + jump)");
    const sheet = decodePngRgba(gate.evidence.path);
    const jumpCell = evidenceCell(sheet, 1, cellW);
    const cellGeometry = measureKeyedSubject(jumpCell);
    const apexGeometry = measureKeyedSubject(apex);
    assert.equal(
      cellGeometry.headY,
      apexGeometry.headY,
      "jump cell headY must match generated 02, not takeoff 01",
    );
    assert.equal(
      keyedOpaqueCount(jumpCell),
      keyedOpaqueCount(apex),
      "jump cell keyed occupancy must match generated 02",
    );
    const summary = JSON.parse(fs.readFileSync(gate.run_summary.path, "utf8"));
    assert.deepEqual(summary.evidence.cells, gate.evidence.cells);
  } finally {
    service.close?.();
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
