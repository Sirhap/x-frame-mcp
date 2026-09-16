"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  classifyInspectQa,
  evaluateScaleContract,
  isFxOrAirborne,
  measureKeyedSubject,
} = require("../../mcp/xsxb_mcp_validate_godot");
const { composeFrameDiff } = require("../../mcp/xsxb_mcp_diff_frames");
const { paintGroundedActor } = require("../acceptance_playbooks");

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
