"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { fuseFlorence } = require("../../mcp/xsxb_mcp_detect_regions");

/**
 * Builds a fusion input with public candidates mirrored onto internal boxes.
 * @param {object[]} rows Hypothesis rows with component boxes.
 * @returns {object} Code perception result.
 */
function codeFrom(rows) {
  return {
    candidates: rows.map((row) => ({
      hypothesis: row.hypothesis,
      codeConfidence: row.codeConfidence,
      semanticLabel: null,
      evidence: ["alpha_components"],
      provenance: ["code_perception"],
      cells: row.cells || ["A1"],
      frame: row.frame,
    })),
    internalCandidates: rows.map((row) => ({
      hypothesis: row.hypothesis,
      component: row.component,
    })),
  };
}

test("Florence can label a lone high-confidence subject as a sword", () => {
  const fused = fuseFlorence(
    codeFrom([
      {
        hypothesis: "subject",
        codeConfidence: 0.959,
        component: { minX: 10, maxX: 80, minY: 10, maxY: 90 },
      },
    ]),
    { detections: [{ bbox: [10, 10, 81, 91], label: "sword" }] },
  );
  assert.equal(fused.candidates[0].semanticLabel, "sword");
  assert.equal(fused.model.rejected.length, 0);
});

test("Florence can label a lone subject as a dog and sunglasses", () => {
  const fused = fuseFlorence(
    codeFrom([
      {
        hypothesis: "subject",
        codeConfidence: 0.838,
        component: { minX: 0, maxX: 99, minY: 0, maxY: 99 },
      },
    ]),
    {
      detections: [
        { bbox: [20, 20, 80, 90], label: "cartoon dog" },
        { bbox: [30, 22, 70, 40], label: "sunglasses" },
      ],
    },
  );
  assert.match(fused.candidates[0].semanticLabel, /cartoon dog/u);
  assert.match(fused.candidates[0].semanticLabel, /sunglasses/u);
  assert.equal(fused.model.rejected.length, 0);
});

test("character labels prefer the subject over a larger weapon blob", () => {
  const fused = fuseFlorence(
    codeFrom([
      {
        hypothesis: "subject",
        codeConfidence: 0.736,
        component: { minX: 10, maxX: 40, minY: 20, maxY: 70 },
      },
      {
        hypothesis: "elongated_attachment",
        codeConfidence: 0.735,
        component: { minX: 35, maxX: 90, minY: 5, maxY: 80 },
      },
    ]),
    { detections: [{ bbox: [10, 5, 91, 81], label: "blue and white cartoon character" }] },
  );
  assert.equal(fused.candidates[0].semanticLabel, "blue and white cartoon character");
  assert.equal(fused.candidates[1].semanticLabel, null);
  assert.equal(fused.model.rejected.length, 0);
});

test("weapon labels still refuse a confident character when a blade blob exists", () => {
  const fused = fuseFlorence(
    codeFrom([
      {
        hypothesis: "subject",
        codeConfidence: 0.9,
        component: { minX: 12, maxX: 18, minY: 5, maxY: 19 },
      },
      {
        hypothesis: "elongated_attachment",
        codeConfidence: 0.7,
        component: { minX: 21, maxX: 30, minY: 9, maxY: 9 },
      },
    ]),
    { detections: [{ bbox: [11, 4, 20, 21], label: "sword" }] },
  );
  assert.equal(fused.candidates[0].semanticLabel, null);
  assert.equal(fused.model.rejected[0]?.reason, "high_confidence_subject_conflict");
});
