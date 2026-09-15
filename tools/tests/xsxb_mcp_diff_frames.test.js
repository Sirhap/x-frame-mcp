"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { encodePngRgba } = require("../../mcp/xsxb_mcp_cutout");
const { composeFrameDiff } = require("../../mcp/xsxb_mcp_diff_frames");
const { paintGroundedActor } = require("../acceptance_playbooks");

test("composeFrameDiff marks the vacated and newly occupied columns", () => {
  const left = paintGroundedActor(32, 32, { originX: 8, originY: 10 });
  const right = paintGroundedActor(32, 32, { originX: 12, originY: 10 });
  const composed = composeFrameDiff(
    { width: 32, height: 32, data: left },
    { width: 32, height: 32, data: right },
    { mode: "diff" },
  );
  assert.equal(composed.width, 32);
  assert.equal(composed.height, 32);
  assert.ok(composed.changedPixelCount >= 20);
  const png = encodePngRgba(composed.data, composed.width, composed.height);
  assert.ok(png.length > 80);
  let magenta = 0;
  for (let i = 0; i < composed.data.length; i += 4) {
    if (composed.data[i] >= 220 && composed.data[i + 2] >= 180) magenta += 1;
  }
  assert.ok(magenta >= 20);
});
