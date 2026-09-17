"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { decodePngRgba, encodePngRgba } = require("../../mcp/xsxb_mcp_cutout");
const { ASSET_CANDIDATES, REQUIRED_CLIPS, listClipPngs, pickAssetPair } = require("../acceptance_generated");

const HERO_DIR = path.join(__dirname, "../fixtures/generated_hero");
const RAW_DIR = path.join(HERO_DIR, "raw");
const PNG_SIGNATURE = Object.freeze([137, 80, 78, 71, 13, 10, 26, 10]);

const JUMP_PLATES = Object.freeze([
  "hero_jump_crouch.png",
  "hero_jump.png",
  "hero_jump_b.png",
  "hero_jump_land.png",
]);
const ATTACK_PLATES = Object.freeze([
  "hero_attack_windup.png",
  "hero_attack.png",
  "hero_attack_followthrough.png",
  "hero_attack_recover.png",
]);
const HURT_PLATES = Object.freeze(["hero_hurt.png", "hero_hurt_b.png"]);

/**
 * Lists clip PNG basenames in numeric order.
 * @param {string} directory Clip folder.
 * @returns {string[]} Basenames.
 */
function clipNames(directory) {
  return listClipPngs(directory).map((filePath) => path.basename(filePath));
}

/**
 * Writes a 1×1 PNG into dest.
 * @param {string} dest Output path.
 * @returns {void}
 */
function writeDotPng(dest) {
  fs.writeFileSync(dest, encodePngRgba(new Uint8ClampedArray([10, 20, 30, 255]), 1, 1));
}

test("generated_hero jump fixture is at least a three-pose cycle", () => {
  const names = clipNames(path.join(HERO_DIR, "jump"));
  assert.ok(names.length >= 3, `jump must have >=3 frames, got ${names.join(",") || "none"}`);
  assert.deepEqual(names.slice(0, 4), ["00.png", "01.png", "02.png", "03.png"]);
});

test("generated_hero attack fixture is at least a three-pose cycle", () => {
  const names = clipNames(path.join(HERO_DIR, "attack"));
  assert.ok(names.length >= 3, `attack must have >=3 frames, got ${names.join(",") || "none"}`);
  assert.deepEqual(names.slice(0, 4), ["00.png", "01.png", "02.png", "03.png"]);
});

test("generated_hero hurt fixture is a grounded two-pose clip", () => {
  const names = clipNames(path.join(HERO_DIR, "hurt"));
  assert.ok(names.length >= 2, `hurt must have >=2 frames, got ${names.join(",") || "none"}`);
  assert.deepEqual(names.slice(0, 2), ["00.png", "01.png"]);
});

test("generated_hero raw jump/attack/hurt extras are real 1024 PNGs", () => {
  const extras = [
    "hero_jump_crouch.png",
    "hero_jump_land.png",
    "hero_attack_windup.png",
    "hero_attack_recover.png",
    "hero_hurt.png",
    "hero_hurt_b.png",
  ];
  for (const name of extras) {
    const filePath = path.join(RAW_DIR, name);
    assert.ok(fs.existsSync(filePath), `${name} missing under raw/`);
    const header = fs.readFileSync(filePath).subarray(0, 8);
    assert.deepEqual([...header], [...PNG_SIGNATURE], `${name} must be a real PNG`);
    const image = decodePngRgba(filePath);
    assert.equal(Math.max(image.width, image.height), 1024, `${name} long edge`);
  }
});

test("ASSET_CANDIDATES lists jump crouch/land, attack extras, and hurt", () => {
  assert.deepEqual([...ASSET_CANDIDATES.jump], [...JUMP_PLATES]);
  assert.deepEqual([...ASSET_CANDIDATES.attack], [...ATTACK_PLATES]);
  assert.equal(ASSET_CANDIDATES.attack[0], "hero_attack_windup.png");
  assert.deepEqual([...ASSET_CANDIDATES.hurt], [...HURT_PLATES]);
});

test("REQUIRED_CLIPS includes the grounded hurt actor clip", () => {
  assert.ok(REQUIRED_CLIPS.includes("hurt"), `REQUIRED_CLIPS=${JSON.stringify(REQUIRED_CLIPS)}`);
});

test("pickAssetPair keeps every unique jump, attack, and hurt plate", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-clip-assets-"));
  const previous = process.env.XSXB_GENERATED_ASSETS;
  try {
    for (const name of [...JUMP_PLATES, ...ATTACK_PLATES, ...HURT_PLATES]) {
      writeDotPng(path.join(root, name));
    }
    process.env.XSXB_GENERATED_ASSETS = root;
    const jump = pickAssetPair(JUMP_PLATES);
    const attack = pickAssetPair(ATTACK_PLATES);
    const hurt = pickAssetPair(HURT_PLATES);
    assert.equal(jump.length, 4, `jump capped at ${jump.length}`);
    assert.equal(attack.length, 4, `attack capped at ${attack.length}`);
    assert.equal(hurt.length, 2, `hurt capped at ${hurt.length}`);
    assert.deepEqual(
      jump.map((filePath) => path.basename(filePath)),
      [...JUMP_PLATES],
    );
    assert.deepEqual(
      attack.map((filePath) => path.basename(filePath)),
      [...ATTACK_PLATES],
    );
  } finally {
    if (previous === undefined) delete process.env.XSXB_GENERATED_ASSETS;
    else process.env.XSXB_GENERATED_ASSETS = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
