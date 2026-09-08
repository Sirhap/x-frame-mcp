"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { detectRegions } = require("../../mcp/xsxb_mcp_detect_regions");
const { encodePngRgba } = require("../../mcp/xsxb_mcp_cutout");
const { observeFile } = require("../../mcp/xsxb_mcp_observation");

/** Creates a connected clothed figure with pixel-supported hands and a blue hole. */
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-region-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const width = 120;
  const height = 140;
  const data = new Uint8ClampedArray(width * height * 4);
  /** Paints a rectangle into the fixture. */
  function rect(x, y, w, h, color) {
    for (let yy = y; yy < y + h; yy += 1) {
      for (let xx = x; xx < x + w; xx += 1) data.set([...color, 255], (yy * width + xx) * 4);
    }
  }
  rect(40, 10, 40, 115, [20, 70, 190]);
  rect(18, 65, 84, 12, [20, 70, 190]);
  rect(16, 74, 12, 12, [220, 145, 90]);
  rect(92, 74, 12, 12, [220, 145, 90]);
  rect(97, 79, 2, 2, [20, 70, 190]);
  const filePath = path.join(root, "character.png");
  fs.writeFileSync(filePath, encodePngRgba(data, width, height));
  const observation = observeFile(filePath, { file: filePath });
  return {
    root,
    filePath,
    observation,
    frames: [{ data, width, height, filePath, frame: 0 }],
    artifactDir: path.join(root, ".x-frame", "artifacts"),
    revalidate: () => observeFile(filePath, { file: filePath }),
  };
}

test("subject labels do not confirm a requested hand or readable text", async (t) => {
  const context = setup(t);
  context.florence = async () => ({ detections: [{ label: "character", bbox: [16, 10, 104, 125] }] });
  const result = await detectRegions({ provider: "florence", targets: ["subject", "hand", "text"] }, context);
  assert.equal(result.__mcp.execution.effect, "partial");
  assert.equal(result.targetStatus.subject.semantic, "confirmed");
  assert.equal(result.targetStatus.hand.semantic, "unknown");
  assert.equal(result.targetStatus.text.semantic, "unknown");
});

test("no foreground means missing geometry and unknown semantics, never confirmed absence", async (t) => {
  const context = setup(t);
  context.frames[0].data.fill(0);
  fs.writeFileSync(context.filePath, encodePngRgba(context.frames[0].data, 120, 140));
  context.observation = context.revalidate();
  const result = await detectRegions({ provider: "code", targets: ["subject", "hand"] }, context);
  assert.equal(result.targetStatus.hand.status, "missing");
  assert.equal(result.targetStatus.hand.geometry, "missing");
  assert.equal(result.targetStatus.hand.semantic, "unknown");
  assert.equal(result.__mcp.execution.effect, "unverifiable");
});

test("detected references resolve actual local pixels and reject wrong or changed sources", async (t) => {
  const context = setup(t);
  const result = await detectRegions({ provider: "code", targets: ["hand"] }, context);
  const { resolvePerceptionRegion } = require("../../mcp/xsxb_mcp_region_store");
  const hands = result.candidates.map((candidate) =>
    resolvePerceptionRegion(candidate.reference, context.filePath, context),
  );
  const right = hands.find((hand) => hand.x > 60);
  assert.ok(right);
  assert.equal(right.mask.length, 120 * 140);
  assert.equal(right.mask[78 * 120 + 96], 255);
  assert.equal(right.mask[79 * 120 + 97], 0);
  assert.equal(right.mask[50 * 120 + 60], 0);
  const reference = result.candidates[0].reference;
  assert.throws(
    () => resolvePerceptionRegion({ ...reference, region_id: "../escape" }, context.filePath, context),
    { code: "INVALID_REGION_REFERENCE" },
  );
  assert.throws(
    () => resolvePerceptionRegion({ ...reference, basis_snapshot_id: "wrong" }, context.filePath, context),
    { code: "STALE_SNAPSHOT" },
  );
  const other = path.join(context.root, "copy.png");
  fs.copyFileSync(context.filePath, other);
  assert.throws(() => resolvePerceptionRegion(reference, other, context), { code: "REGION_SOURCE_MISMATCH" });
  fs.appendFileSync(context.filePath, "changed");
  assert.throws(() => resolvePerceptionRegion(reference, context.filePath, context), {
    code: "STALE_SNAPSHOT",
  });
});

test("automatic model failure keeps geometry and reports failure", async (t) => {
  const context = setup(t);
  context.florence = async () => {
    throw new Error("worker failed");
  };
  const result = await detectRegions({ provider: "auto", targets: ["hand"] }, context);
  assert.equal(result.__mcp.execution.effect, "partial");
  assert.equal(result.targetStatus.hand.semantic, "unknown");
  assert.match(result.model.error, /worker failed/u);
  assert.ok(result.candidates.every((candidate) => candidate.reference));
});
