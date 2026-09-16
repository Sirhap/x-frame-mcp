"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { runAnalyzeAcceptance } = require("../acceptance_analyze");

test(
  "analyze session imports a hold-walk-hold PNG sequence, writes preview.path, then reorganizes",
  { timeout: 600_000 },
  async () => {
    const report = await runAnalyzeAcceptance();
    assert.ok(Array.isArray(report.orderBefore) && report.orderBefore.length >= 6);
    assert.ok(Array.isArray(report.orderAfter));
    assert.ok(
      report.orderAfter.length < report.orderBefore.length ||
        report.orderAfter.length === report.recommendedOrder.length,
      "apply must drop holds or match the recommended order length",
    );
    assert.ok(report.previewPath, "analyze must write preview.path");
    assert.match(report.previewPath, /\.png$/i);
    assert.ok(report.preview?.width > 0 && report.preview?.height > 0);
    assert.ok(report.used === "loop" || report.used === "motion");
    assert.ok(report.keptMotion, "kept frames must be the motion pair, not six identical holds");
  },
);
