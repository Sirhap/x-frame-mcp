"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { decodePngRgba, encodePngRgba } = require("../../mcp/xsxb_mcp_cutout");
const {
  ASSET_CANDIDATES,
  downsampleRgbaToMax,
  ensureTwoFrames,
  listClipPngs,
  pickAssetPair,
} = require("../acceptance_generated");

const WALK_DIR = path.join(__dirname, "../fixtures/generated_hero/walk");
const RAW_DIR = path.join(__dirname, "../fixtures/generated_hero/raw");
const PNG_SIGNATURE = Object.freeze([137, 80, 78, 71, 13, 10, 26, 10]);
const WALK_PLATES = Object.freeze(["hero_walk.png", "hero_walk_b.png", "hero_walk_c.png", "hero_walk_d.png"]);

/**
 * Writes a 1×1 PNG into dest.
 * @param {string} dest Output path.
 * @returns {void}
 */
function writeDotPng(dest) {
  fs.writeFileSync(dest, encodePngRgba(new Uint8ClampedArray([10, 20, 30, 255]), 1, 1));
}

test("generated_hero walk fixture is a four-frame cycle", () => {
  const names = fs
    .readdirSync(WALK_DIR)
    .filter((name) => /\.png$/i.test(name))
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
  assert.deepEqual(names, ["00.png", "01.png", "02.png", "03.png"]);
});

test("generated_hero raw walk plates include c and d as real PNGs", () => {
  for (const name of ["hero_walk_c.png", "hero_walk_d.png"]) {
    const filePath = path.join(RAW_DIR, name);
    assert.ok(fs.existsSync(filePath), `${name} missing under raw/`);
    const header = fs.readFileSync(filePath).subarray(0, 8);
    assert.deepEqual([...header], [...PNG_SIGNATURE], `${name} must be a real PNG`);
    const image = decodePngRgba(filePath);
    assert.equal(Math.max(image.width, image.height), 1024, `${name} long edge`);
  }
});

test("walk 02 and 03 are 256 long-edge nearest-neighbor plates", () => {
  for (const name of ["02.png", "03.png"]) {
    const filePath = path.join(WALK_DIR, name);
    const image = decodePngRgba(filePath);
    assert.equal(image.width, 256, `${name} width`);
    assert.equal(image.height, 256, `${name} height`);
  }
});

test("ASSET_CANDIDATES.walk lists the four authored plates", () => {
  assert.deepEqual([...ASSET_CANDIDATES.walk], [...WALK_PLATES]);
});

test("pickAssetPair returns every unique found plate, not only the first two", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-walk-assets-"));
  const previous = process.env.XSXB_GENERATED_ASSETS;
  try {
    for (const name of WALK_PLATES) writeDotPng(path.join(root, name));
    process.env.XSXB_GENERATED_ASSETS = root;
    const picked = pickAssetPair(WALK_PLATES);
    assert.ok(picked, "pickAssetPair must find the four plates");
    assert.equal(picked.length, 4, `pickAssetPair capped the walk sequence at ${picked.length}`);
    assert.deepEqual(
      picked.map((filePath) => path.basename(filePath)),
      [...WALK_PLATES],
    );
  } finally {
    if (previous === undefined) delete process.env.XSXB_GENERATED_ASSETS;
    else process.env.XSXB_GENERATED_ASSETS = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ensureTwoFrames keeps every PNG when a clip already has more than two", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-walk-keep-"));
  const incoming = path.join(root, "incoming");
  const clip = path.join(root, "walk");
  fs.mkdirSync(clip);
  fs.mkdirSync(incoming);
  try {
    for (const name of ["00.png", "01.png", "02.png", "03.png"]) {
      writeDotPng(path.join(clip, name));
    }
    const dest = ensureTwoFrames(clip, incoming, "walk");
    assert.equal(dest, clip);
    assert.equal(listClipPngs(dest).length, 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("downsampleRgbaToMax nearest-neighbor caps the long edge at 256", () => {
  const rgba = new Uint8ClampedArray(1024 * 1024 * 4);
  rgba.fill(255);
  const down = downsampleRgbaToMax({ data: rgba, width: 1024, height: 1024 }, 256);
  assert.equal(down.width, 256);
  assert.equal(down.height, 256);
});
