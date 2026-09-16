"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { toolDefinitions } = require("../../mcp/xsxb_mcp_tool_catalog");

const repoRoot = path.join(__dirname, "../..");

test("video-to-loop playbooks reorganize with applyOrder and export at suggestedGameFps", () => {
  const tunerSkill = fs.readFileSync(path.join(repoRoot, "skills/xsxb-frame-tuner/SKILL.md"), "utf8");
  const workflows = fs.readFileSync(
    path.join(repoRoot, "skills/xsxb-frame-tuner/references/media-and-tuning-workflows.md"),
    "utf8",
  );
  const readme = fs.readFileSync(path.join(repoRoot, "mcp/README.md"), "utf8");
  const videoBullet = readme.split("\n").find((line) => line.includes("视频做成循环动画"));

  assert.match(tunerSkill, /applyOrder/);
  assert.match(tunerSkill, /suggestedGameFps/);
  assert.doesNotMatch(
    tunerSkill,
    /reorganize_frames with `loop\.recommended\.order`/,
    "router skill must not apply loop.recommended.order as the reorganize payload",
  );
  assert.match(workflows, /applyOrder/);
  assert.ok(videoBullet, "mcp README must keep the 视频做成循环动画 bullet");
  assert.match(videoBullet, /applyOrder/);
  assert.doesNotMatch(
    videoBullet,
    /xsxb_reorganize_frames` 传 `loop\.recommended\.order`/,
    "README must not prescribe loop.recommended.order as the apply argument",
  );
});

test("godot skill names evidence as one cell per clip, not always frame 0", () => {
  const godot = fs.readFileSync(path.join(repoRoot, "skills/x-frame-godot/SKILL.md"), "utf8");
  assert.match(godot, /one cell per clip/);
  assert.match(godot, /apex/);
  assert.match(godot, /qa=review/);
});

test("gameplay skill plants hurt and enables hit only on a gold crescent", () => {
  const gameplay = fs.readFileSync(path.join(repoRoot, "skills/x-frame-gameplay/SKILL.md"), "utf8");
  assert.match(gameplay, /crescent|gold/);
  assert.match(gameplay, /hitbox\.enabled/);
  assert.match(gameplay, /walk\/attack\/hurt/);
  assert.doesNotMatch(gameplay, /Attacks need a hitbox\./);
});

test("estimate_boxes tool description writes when dry_run is omitted", () => {
  const tool = toolDefinitions().find((entry) => entry.name === "xsxb_estimate_boxes");
  assert.ok(tool, "xsxb_estimate_boxes must stay in the catalog");
  assert.match(tool.description, /omitting dry_run writes|omit writes/i);
  assert.doesNotMatch(
    tool.description,
    /Use dry_run to preview/,
    "agents read the tool blurb first; do not teach preview-by-default",
  );
});

test("tuner skill enables hit only on a gold crescent, not every attack-like frame", () => {
  const tunerSkill = fs.readFileSync(path.join(repoRoot, "skills/xsxb-frame-tuner/SKILL.md"), "utf8");
  const completion = tunerSkill.split("## Completion Contract")[1]?.split("## Locate the Tool")[0] || "";
  const validation = tunerSkill.split("## Validation Summary")[1]?.split("## Final Response")[0] || "";
  assert.match(
    `${completion}\n${validation}`,
    /crescent|gold/,
    "completion or validation must name the gold crescent gate",
  );
  assert.doesNotMatch(
    tunerSkill,
    /save `hitbox` for every attack-like frame/,
    "do not tell agents to enable junk hits on windup",
  );
});

test("validation playbook enables hit only on a gold crescent, not plausible frames", () => {
  const validation = fs.readFileSync(
    path.join(repoRoot, "skills/xsxb-frame-tuner/references/validation.md"),
    "utf8",
  );
  assert.match(validation, /crescent|gold/, "Visual Box Gate must name the gold crescent");
  assert.doesNotMatch(
    validation,
    /plausible enabled active frames/,
    "do not treat plausible enabled frames as the whole hit rule",
  );
});

test("cutout skill keeps gold crescents and re-keys from raw", () => {
  const cutout = fs.readFileSync(path.join(repoRoot, "skills/x-frame-cutout/SKILL.md"), "utf8");
  assert.match(cutout, /gold|yellow/);
  assert.match(cutout, /force/);
  assert.match(cutout, /key_color/);
});
