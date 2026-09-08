"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { analyzeFrame } = require("../../mcp/xsxb_mcp_perception");
const { fuseFlorence } = require("../../mcp/xsxb_mcp_detect_regions");

/** Builds a connected, clothed character with exposed fists, face and torso. */
function fixture(scale = 1, skin = [220, 145, 90]) {
  const width = 120 * scale;
  const height = 140 * scale;
  const data = new Uint8ClampedArray(width * height * 4);
  /** Paints a rectangle in reference-space pixels. */
  function rect(x, y, w, h, color) {
    for (let yy = y * scale; yy < (y + h) * scale; yy += 1) {
      for (let xx = x * scale; xx < (x + w) * scale; xx += 1) {
        data.set([...color, 255], (yy * width + xx) * 4);
      }
    }
  }
  rect(40, 10, 40, 115, [20, 70, 190]);
  rect(18, 65, 84, 12, [20, 70, 190]);
  rect(16, 74, 12, 12, skin);
  rect(92, 74, 12, 12, skin);
  rect(47, 20, 25, 20, skin);
  rect(47, 55, 25, 30, skin);
  return { data, width, height };
}

test("connected fists are pixel-supported contacts, not fixed body-ratio boxes", () => {
  for (const scale of [1, 2]) {
    for (const skin of [
      [220, 145, 90],
      [100, 65, 42],
    ]) {
      const analysis = analyzeFrame(fixture(scale, skin), { targets: ["hand"] });
      const hands = analysis.internalCandidates.filter((c) => c.hypothesis === "contact_point");
      assert.equal(hands.length, 2);
      assert.ok(hands.some((c) => Math.abs(c.component.centerX / scale - 21.5) < 1));
      assert.ok(hands.some((c) => Math.abs(c.component.centerX / scale - 97.5) < 1));
      assert.ok(hands.every((c) => c.ambiguities.includes("contact_geometry_does_not_prove_hand")));
    }
  }
});

test("no exposed hand pixels means abstain, not invented positions", () => {
  const result = analyzeFrame(fixture(1, [20, 70, 190]), { targets: ["hand"] });
  assert.equal(result.candidates.length, 0);
});

test("Florence hand labels prefer local contact over the containing subject", () => {
  const frame = fixture();
  const code = analyzeFrame(frame, { targets: ["subject", "hand"] });
  const fused = fuseFlorence(code, {
    detections: [{ bbox: [92, 74, 104, 86], label: "hand", task: "hand_grounding" }],
  });
  const hands = fused.candidates.filter(
    (c) => c.hypothesis === "contact_point" && c.semanticLabel === "hand",
  );
  assert.equal(hands.length, 1);
  assert.equal(fused.candidates.find((c) => c.hypothesis === "subject").semanticLabel, null);
});

test("whole-character and unrelated labels cannot confirm a contact", () => {
  const code = analyzeFrame(fixture(), { targets: ["hand"] });
  const fused = fuseFlorence(code, {
    detections: [
      { bbox: [16, 10, 104, 125], label: "hand", task: "hand_grounding" },
      { bbox: [92, 74, 104, 86], label: "cartoon character" },
    ],
  });
  assert.ok(fused.candidates.every((c) => !c.semanticLabel));
});
