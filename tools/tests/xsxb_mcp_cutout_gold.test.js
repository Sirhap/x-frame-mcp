"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { cutoutFrameFiles, decodePngRgba, encodePngRgba } = require("../xsxb_mcp_cutout");
const { flattenFrameBackground, resolvePreviewBackground } = require("../xsxb_mcp_lock");

const FIXTURE = path.join(__dirname, "../fixtures/generated_hero/attack/00.png");
const PROTECTED_GOLDS = ["#ffe040", "#ffe080", "#ffd070", "#ffcc33"];
const PREVIEW_PATH = "/tmp/xsxb_cutout_gold_preview.png";

/**
 * True when a pixel is saturated yellow/gold glow, not brown hair or white plate.
 * @param {number} r Red.
 * @param {number} g Green.
 * @param {number} b Blue.
 * @param {number} a Alpha.
 * @returns {boolean} Crescent gold sample.
 */
function isCrescentGold(r, g, b, a) {
  if (a < 160) return false;
  const sat = Math.max(r, g, b) - Math.min(r, g, b);
  return r >= 220 && g >= 180 && b <= 180 && r - b >= 50 && g - b >= 20 && sat >= 40;
}

/**
 * True when a flatten pixel is a dark blue coat.
 * @param {number} r Red.
 * @param {number} g Green.
 * @param {number} b Blue.
 * @param {number} a Alpha.
 * @returns {boolean} Navy sample.
 */
function isNavyCoat(r, g, b, a) {
  if (a < 160) return false;
  const maxc = Math.max(r, g, b);
  const minc = Math.min(r, g, b);
  return b >= r + 8 && b >= g && maxc <= 160 && maxc - minc >= 10 && r <= 90;
}

/**
 * True when a flatten pixel is a near-black boot.
 * @param {number} r Red.
 * @param {number} g Green.
 * @param {number} b Blue.
 * @param {number} a Alpha.
 * @returns {boolean} Boot sample.
 */
function isBlackBoot(r, g, b, a) {
  if (a < 160) return false;
  return Math.max(r, g, b) <= 48;
}

/**
 * Restricts samples to the right-hand slash (below the head, away from hair).
 * @param {number} x Column.
 * @param {number} y Row.
 * @param {number} width Frame width.
 * @param {number} height Frame height.
 * @returns {boolean} Inside the slash region.
 */
function inSlashRegion(x, y, width, height) {
  return x >= Math.round(width * 0.55) && y >= Math.round(height * 0.35);
}

/**
 * Finds 8-connected crescent-gold blobs in the slash region.
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} image Frame.
 * @returns {Array<{count:number,width:number,height:number,minX:number,minY:number,maxX:number,maxY:number}>}
 */
function slashGoldBlobs(image) {
  const { data, width, height } = image;
  const seen = new Uint8Array(width * height);
  const blobs = [];
  const hit = (x, y) => {
    const offset = (y * width + x) * 4;
    return (
      inSlashRegion(x, y, width, height) &&
      isCrescentGold(data[offset], data[offset + 1], data[offset + 2], data[offset + 3])
    );
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const start = y * width + x;
      if (seen[start] || !hit(x, y)) continue;
      const stack = [start];
      seen[start] = 1;
      let count = 0;
      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;
      while (stack.length) {
        const index = stack.pop();
        const px = index % width;
        const py = Math.floor(index / width);
        count += 1;
        minX = Math.min(minX, px);
        minY = Math.min(minY, py);
        maxX = Math.max(maxX, px);
        maxY = Math.max(maxY, py);
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (!dx && !dy) continue;
            const nx = px + dx;
            const ny = py + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const next = ny * width + nx;
            if (seen[next] || !hit(nx, ny)) continue;
            seen[next] = 1;
            stack.push(next);
          }
        }
      }
      blobs.push({
        count,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
        minX,
        minY,
        maxX,
        maxY,
      });
    }
  }
  return blobs.sort((left, right) => right.count - left.count);
}

/**
 * Counts slash-region gold on the steel highlight versus the crescent wings.
 * The failed session left ~380 gold on the blade box (x 176–224, y 112–160).
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} image Frame.
 * @returns {{gold:number,onBlade:number,offBlade:number}} Counts.
 */
function goldVersusBladeBox(image) {
  const { data, width, height } = image;
  const boxX1 = Math.round((176 / 256) * width);
  const boxX2 = Math.round((224 / 256) * width);
  const boxY1 = Math.round((112 / 256) * height);
  const boxY2 = Math.round((160 / 256) * height);
  let gold = 0;
  let onBlade = 0;
  let offBlade = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      if (!inSlashRegion(x, y, width, height)) continue;
      if (!isCrescentGold(data[offset], data[offset + 1], data[offset + 2], data[offset + 3])) continue;
      gold += 1;
      if (x >= boxX1 && x <= boxX2 && y >= boxY1 && y <= boxY2) onBlade += 1;
      else offBlade += 1;
    }
  }
  return { gold, onBlade, offBlade };
}

/**
 * Asserts the magenta flatten still has a navy coat that continues into boots.
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} preview Flatten.
 * @returns {{navy:number,boot:number,bridges:number}} Counts.
 */
function assertNavyCoatIntoBoots(preview) {
  const { data, width, height } = preview;
  let navy = 0;
  let boot = 0;
  let bridges = 0;
  for (let x = 0; x < width; x += 1) {
    let sawNavy = false;
    let lastNavyY = -1;
    let gap = 0;
    for (let y = 0; y < height; y += 1) {
      const offset = (y * width + x) * 4;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      const a = data[offset + 3];
      if (isNavyCoat(r, g, b, a)) {
        navy += 1;
        sawNavy = true;
        lastNavyY = y;
        gap = 0;
        continue;
      }
      if (isBlackBoot(r, g, b, a)) {
        boot += 1;
        if (sawNavy && y > lastNavyY && gap <= 12) bridges += 1;
        continue;
      }
      if (sawNavy && r >= 250 && b >= 250 && g <= 10) gap += 1;
    }
  }
  assert.ok(navy >= 200, `navy coat was eaten (${navy})`);
  assert.ok(boot >= 20, `boots were eaten (${boot})`);
  assert.ok(bridges >= 3, `navy coat does not continue into boots (bridges=${bridges})`);
  return { navy, boot, bridges };
}

test("fixture attack plate contains a gold crescent, not only blade sparks", () => {
  const source = decodePngRgba(FIXTURE);
  const blobs = slashGoldBlobs(source);
  assert.ok(blobs.length, "attack/00.png must decode");
  const largest = blobs[0];
  assert.ok(
    largest && largest.count >= 160 && largest.width >= 28 && largest.height >= 20,
    `fixture art has no crescent (largest blob ${JSON.stringify(largest)})`,
  );
});

test("border_flood + key_color keeps a gold crescent off the steel blade", () => {
  assert.equal(fs.existsSync(FIXTURE), true, "generated_hero attack/00.png is required");
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-cutout-gold-"));
  const dest = path.join(folder, "00.png");
  try {
    fs.copyFileSync(FIXTURE, dest);
    const receipt = cutoutFrameFiles([dest], {
      keyMode: "border_flood",
      keyColor: "#F8F8F8",
      protectedColors: PROTECTED_GOLDS,
      force: true,
    });
    assert.equal(receipt.keyed, true);
    assert.ok(receipt.processedFrameCount >= 1, "must re-cut from the plated fixture, not skip");

    const cut = decodePngRgba(dest);
    const blobs = slashGoldBlobs(cut);
    const largest = blobs[0];
    const versus = goldVersusBladeBox(cut);
    assert.ok(largest, "cutout left no slash-region gold");
    assert.ok(
      largest.count >= 160,
      `gold crescent area collapsed to a sliver (${largest.count} px, bbox ${largest.width}x${largest.height}; off-blade ${versus.offBlade})`,
    );
    assert.ok(
      largest.width >= 28 && largest.height >= 20,
      `gold remains a blade-line sliver, not an arc (bbox ${largest.width}x${largest.height} at ${largest.minX},${largest.minY})`,
    );
    assert.ok(
      versus.offBlade >= 200,
      `gold off the steel box is ${versus.offBlade} (need crescent wings, not a blade highlight; on-blade ${versus.onBlade})`,
    );

    const preview = flattenFrameBackground(cut, resolvePreviewBackground("magenta"));
    fs.writeFileSync(PREVIEW_PATH, encodePngRgba(preview.data, preview.width, preview.height));
    assertNavyCoatIntoBoots(preview);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
