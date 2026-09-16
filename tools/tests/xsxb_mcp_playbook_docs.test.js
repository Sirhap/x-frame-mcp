"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

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
