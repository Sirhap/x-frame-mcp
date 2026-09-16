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
  classifyInspectQa,
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
