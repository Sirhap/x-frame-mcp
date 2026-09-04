"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { MCP_TOOL_NAMES, createXsxbMcpService, toolDefinitions } = require("../xsxb_mcp_service");
const { VALIDATED_SMEAR_REFERENCE, compileSmearBrief } = require("../xsxb_mcp_smear_brief");

const CHOP_ARGS = Object.freeze({
  animation_id: "niulai_plunger_chop",
  motion: "overhead then nearly vertical downward chop, cup D1 across to G3 then down H8",
  path_kind: "polyline",
  color: "#DC2E2E",
  layer: "behind",
  frames: [
    { index: 3, start: "D1", end: "E1", head: "D1", weight: "faint" },
    { index: 4, start: "D1", end: "H2", head: "G3", weight: "solid" },
    { index: 5, start: "D1", end: "H6", head: "H8", weight: "solid" },
    { index: 6, start: "G3", end: "H7", head: "H8", weight: "remnant" },
  ],
});

test("a polyline chop compiles a pixel-layer brief and forbids Hermite", () => {
  const planned = compileSmearBrief(CHOP_ARGS);
  assert.equal(planned.useMesh, false);
  assert.equal(planned.pathKind, "polyline");
  assert.match(planned.brief, /Clip-specific weapon smear brief/);
  assert.match(planned.brief, /generic MCP playbook is only the skeleton/);
  assert.match(planned.brief, /overhead then nearly vertical downward chop/);
  assert.match(planned.brief, /Do not use xsxb_add_attack_trail Hermite/);
  assert.match(planned.brief, /像素层 月牙/);
  assert.match(planned.brief, /#DC2E2E/);
  assert.match(planned.brief, /layer behind/);
  assert.match(planned.brief, /frame 4: start D1 → end H2 head G3 \(solid\)/);
  assert.doesNotMatch(planned.brief, /one gap off/);
  assert.doesNotMatch(planned.brief, /canned chop/);
  assert.equal(planned.reference, VALIDATED_SMEAR_REFERENCE);
});

test("an 上挑 motion is copied into the brief instead of a downward recipe", () => {
  const planned = compileSmearBrief({
    motion: "head scoops upward from H8 through G5 to D1",
    path_kind: "polyline",
    color: "#C41E1E",
    frames: [{ index: 4, start: "H8", end: "G4", head: "G5", weight: "solid" }],
  });
  assert.match(planned.brief, /scoops upward from H8/);
  assert.doesNotMatch(planned.brief, /downward chop, cup D1/);
  assert.equal(planned.useMesh, false);
});

test("end on the striking-mass cell warns without telling the agent to skip a full cell", () => {
  const planned = compileSmearBrief({
    motion: "mid swing cup sits on G3",
    path_kind: "polyline",
    color: "#DC2E2E",
    frames: [{ index: 4, start: "D1", end: "G3", head: "G3", weight: "solid" }],
  });
  assert.equal(planned.warnings.length, 1);
  assert.match(planned.warnings[0], /striking-mass cell G3/);
  assert.match(planned.warnings[0], /leading\/outer side/);
  assert.match(planned.warnings[0], /Do not skip a full grid cell/);
});

test("an accepted sequence tells the agent not to regenerate a weaker sickle", () => {
  const planned = compileSmearBrief({
    ...CHOP_ARGS,
    accepted_path: "exports/niulai-plunger-mcp/niulai-chop-crescent-trail-v4.gif",
  });
  assert.match(planned.brief, /already passed eye QA/);
  assert.match(planned.brief, /Do not GenerateImage a weaker sickle/);
  assert.match(planned.brief, /niulai-chop-crescent-trail-v4\.gif/);
});

test("a smooth-arc path may use the mesh only when that arc already matches", () => {
  const planned = compileSmearBrief({
    motion: "blade tip already traces a smooth sickle",
    path_kind: "smooth_arc",
    color: "#88CCFF",
    frames: [{ index: 2, start: "B2", end: "G6", head: "F5", weight: "solid" }],
  });
  assert.equal(planned.useMesh, true);
  assert.match(planned.brief, /Hermite mesh is allowed only if that arc already matches/);
});

test("missing motion, path, color, or frames fail with an actionable error", () => {
  assert.throws(() => compileSmearBrief({}), /motion must describe/);
  assert.throws(
    () =>
      compileSmearBrief({
        motion: "overhead then down",
        path_kind: "zigzag",
        color: "#DC2E2E",
        frames: CHOP_ARGS.frames,
      }),
    /path_kind/,
  );
  assert.throws(
    () =>
      compileSmearBrief({
        motion: "overhead then down",
        path_kind: "polyline",
        color: "red",
        frames: CHOP_ARGS.frames,
      }),
    /sampled #RGB/,
  );
  assert.throws(
    () =>
      compileSmearBrief({
        motion: "overhead then down",
        path_kind: "polyline",
        color: "#DC2E2E",
        frames: [],
      }),
    /frames must list/,
  );
  assert.throws(
    () =>
      compileSmearBrief({
        motion: "overhead then down",
        path_kind: "polyline",
        color: "#DC2E2E",
        frames: [{ index: 4, start: "cup", end: "G3" }],
      }),
    /speakable cell id/,
  );
});

test("the validated smear reference names the v4 files and is example-only", () => {
  assert.match(VALIDATED_SMEAR_REFERENCE.note, /Example only/);
  assert.equal(VALIDATED_SMEAR_REFERENCE.pathKind, "polyline");
  assert.equal(VALIDATED_SMEAR_REFERENCE.method, "像素层 月牙");
  assert.equal(VALIDATED_SMEAR_REFERENCE.layer, "behind");
  assert.ok(VALIDATED_SMEAR_REFERENCE.files.some((file) => file.includes("crescent-trail-v4.gif")));
  assert.ok(VALIDATED_SMEAR_REFERENCE.files.some((file) => file.includes("crescent-trail-v4-sheet.png")));
});

test("a non-niulai animation_id does not paste the D1→G3 recipe as reference", () => {
  const planned = compileSmearBrief({
    animation_id: "ice_slash",
    motion: "head sweeps from F5 through C7 onto G8",
    path_kind: "polyline",
    color: "#54befb",
    frames: [{ index: 5, start: "F5", end: "C7", head: "C5", weight: "solid" }],
  });
  assert.match(String(planned.reference.note || planned.reference), /example only/i);
  assert.notEqual(planned.reference.headPath, "D1→G3 then H8");
  assert.doesNotMatch(JSON.stringify(planned.reference), /D1→G3 then H8/);
});

test("xsxb_plan_smear is a catalog tool that returns the compiled brief", async () => {
  assert.ok(MCP_TOOL_NAMES.includes("xsxb_plan_smear"));
  const tool = toolDefinitions().find((entry) => entry.name === "xsxb_plan_smear");
  assert.ok(tool);
  assert.match(tool.description, /clip-specific/);
  assert.match(tool.description, /receipt\.brief/);
  assert.match(tool.description, /skeleton/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-plan-smear-"));
  try {
    const service = createXsxbMcpService({ root });
    const planned = await service.call("xsxb_plan_smear", CHOP_ARGS);
    assert.equal(planned.useMesh, false);
    assert.match(planned.brief, /frame 5: start D1 → end H6 head H8 \(solid\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
