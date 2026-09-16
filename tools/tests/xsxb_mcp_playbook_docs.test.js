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

test("playbook acceptance pins evidence.cells so attack windup cannot hide", () => {
  const playbook = fs.readFileSync(path.join(repoRoot, "tools/acceptance_playbooks.js"), "utf8");
  assert.match(
    playbook,
    /deepEqual\(\s*\w+\.data\.evidence\.cells/,
    "older playbook must pin receipt cells; a windup-as-attack picker must fail",
  );
  assert.match(playbook, /expectedPlaybookEvidenceCells/, "pin must use the shared {id,frame} helper");
});

test("godot skill names evidence as one cell per clip, not always frame 0", () => {
  const godot = fs.readFileSync(path.join(repoRoot, "skills/x-frame-godot/SKILL.md"), "utf8");
  assert.match(godot, /one cell per clip/);
  assert.match(godot, /apex/);
  assert.match(
    godot,
    /highest head among near-highest soles|head.*sole band|near-highest soles/,
    "jump evidence is highest head among a near-highest sole band, not highest sole as apex",
  );
  assert.doesNotMatch(godot, /highest sole \/ apex/, "do not treat highest sole and apex as synonyms");
  assert.match(godot, /qa=review/);
  assert.match(godot, /evidence\.cells/, "same evidence sentence must name receipt cells");
  const tool = toolDefinitions().find((entry) => entry.name === "xsxb_validate_for_godot");
  assert.ok(tool, "xsxb_validate_for_godot must stay in the catalog");
  assert.match(tool.description, /evidence\.cells/, "catalog must name per-cell id + frame index");
});

test("godot skill has a copy-paste stub validateImport will accept", () => {
  const godot = fs.readFileSync(path.join(repoRoot, "skills/x-frame-godot/SKILL.md"), "utf8");
  assert.match(godot, /animation_duration\(/, "skill must include a copy-paste animation_duration() call");
  assert.match(
    godot,
    /instantiate[\s\S]*xsxb_frame_actor|xsxb_frame_actor[\s\S]*instantiate/,
    "skill must instantiate xsxb_frame_actor, not only name the packed scene",
  );
  assert.match(
    godot,
    /res:\/\/xsxb_frame_tuner\/runtime\/xsxb_frame_actor\.tscn/,
    "copy-paste preload must use this MCP's GODOT_SYNC_ROOT, not a literal {sync_root}",
  );
  assert.doesNotMatch(
    godot,
    /preload\("res:\/\/\{sync_root\}\//,
    "literal {sync_root} in preload will not pass validateImport",
  );
});

test("gameplay skill plants hurt and enables hit only on a gold crescent", () => {
  const gameplay = fs.readFileSync(path.join(repoRoot, "skills/x-frame-gameplay/SKILL.md"), "utf8");
  assert.match(gameplay, /crescent|gold/);
  assert.match(gameplay, /hitbox\.enabled/);
  assert.match(gameplay, /walk\/attack\/hurt/);
  assert.doesNotMatch(gameplay, /Attacks need a hitbox\./);
});

test("gameplay skill qa=warn names occupancy XOR and interior navy/key mismatch", () => {
  const gameplay = fs.readFileSync(path.join(repoRoot, "skills/x-frame-gameplay/SKILL.md"), "utf8");
  assert.doesNotMatch(
    gameplay,
    /qa=warn` means stop \(identical frames or the wrong pair\)/,
    "interior navy/key mismatch also warns; do not equate qa=warn with identical frames",
  );
  assert.match(
    gameplay,
    /occupancy[- ]xor|identical occupancy|interior navy|key mismatch/i,
    "gameplay skill must name occupancy XOR / navy-key warn, not only identical frames",
  );
});

test("plant_feet catalog omitted reference defaults grounded non-idle to idle", () => {
  const plant = toolDefinitions().find((entry) => entry.name === "xsxb_plant_feet");
  assert.ok(plant, "xsxb_plant_feet must stay in the catalog");
  assert.match(
    plant.description,
    /omitted reference on (?:a )?grounded non-idle/i,
    "handler defaults any grounded non-idle clip; do not name only walk",
  );
  assert.match(plant.description, /defaults to(?: profile)? idle/i);
  assert.doesNotMatch(
    plant.description,
    /omitted reference on walk defaults to idle/i,
    "walk-only wording hides attack/hurt inheriting idle",
  );
  assert.doesNotMatch(
    plant.description,
    /omitted reference on (?:vfx|jump|airborne)/i,
    "do not claim VFX/jump get the idle default",
  );
  const gameplay = fs.readFileSync(path.join(repoRoot, "skills/x-frame-gameplay/SKILL.md"), "utf8");
  assert.match(
    gameplay,
    /omitted reference on (?:a )?grounded non-idle/i,
    "gameplay skill must match the plantFeet handler default",
  );
  assert.doesNotMatch(gameplay, /Omitted reference on walk defaults to idle/);
});

test("README reorganize defaults match runtime commit-on-order", () => {
  const readme = fs.readFileSync(path.join(repoRoot, "mcp/README.md"), "utf8");
  const defaults = readme.split("### 默认提交规则")[1]?.split("## ")[0] || "";
  assert.ok(defaults, "mcp README must keep the 默认提交规则 section");
  assert.doesNotMatch(
    defaults,
    /xsxb_reorganize_frames` 和 `xsxb_compress_frames` 默认预览/,
    "reorganize is not default-preview; do not lump it with compress",
  );
  assert.doesNotMatch(
    defaults,
    /xsxb_reorganize_frames`[^。]*提交必须传 `dry_run:false`/,
    "reorganize commit is driven by non-empty order, not dry_run:false",
  );
  assert.match(
    defaults,
    /xsxb_reorganize_frames`[^。]*(非空 `?order`? 提交|omit order|省略 `order` 预览)/,
    "README must say non-empty order commits or omit order previews",
  );
  assert.match(defaults, /xsxb_compress_frames` 默认预览/, "compress may still default to preview");
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

test("cutout catalog force does not rematch without key_color", () => {
  const cutout = toolDefinitions().find((entry) => entry.name === "xsxb_cutout");
  assert.ok(cutout, "xsxb_cutout is in the catalog");
  const force = cutout.inputSchema.properties.force.description || "";
  assert.match(force, /key_color/, "force must name the required key_color companion");
  assert.match(
    force,
    /plus key_color|with key_color|and key_color/i,
    "already-keyed rematch is force plus key_color, not force alone",
  );
});

test("diff_frames catalog names occupancy XOR and qa=warn beyond identical pixels", () => {
  const tool = toolDefinitions().find((entry) => entry.name === "xsxb_diff_frames");
  assert.ok(tool, "xsxb_diff_frames must stay in the catalog");
  assert.match(
    tool.description,
    /occupancy[- ]xor|occupancy delta|occupancy-xor/i,
    "agents must not treat magenta as a raw RGBA pixel compare",
  );
  assert.doesNotMatch(
    tool.description,
    /qa is review when pixels changed, warn when frames are identical/,
    "interior navy/key mismatch also warns; do not equate qa=warn with identical pixels",
  );
  assert.match(
    tool.description,
    /interior|navy|key mismatch|wrong pair/i,
    "qa=warn must name the rekey/wrong-pair stop, not only identical frames",
  );
  const mode = tool.inputSchema.properties.mode.description || "";
  assert.match(mode, /occupancy/i, "mode blurb must say occupancy, not generic changed pixels");
  assert.doesNotMatch(mode, /^diff marks changed pixels magenta/i);
});
