"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ORGANIZER_SIMILARITY_THRESHOLD } = require("../animation_tuner/public/frame_organizer_core");
const { createProjectStore } = require("../project_store");
const {
  adviseLoopCandidate,
  analyzePngFiles,
  findDuplicatesInPngFiles,
  findLoopInPngFiles,
} = require("../xsxb_mcp_loop");
const { createXsxbMcpService, toolDefinitions } = require("../xsxb_mcp_service");
const { validateToolArguments } = require("../xsxb_mcp_schema");
const { encodePngRgba, decodePngRgba } = require("../xsxb_mcp_cutout");

const PHASES = [
  [255, 0, 0, 255],
  [0, 255, 0, 255],
  [0, 0, 255, 255],
];

/**
 * Encodes an 8×8 opaque PNG of one color.
 * @param {number[]} color RGBA color.
 * @returns {Buffer} Encoded PNG.
 */
function solidPng(color) {
  const size = 8;
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) rgba.set(color, offset);
  return encodePngRgba(rgba, size, size);
}

/**
 * Writes a repeating 3-phase PNG cycle.
 * @param {string} directory Output directory.
 * @param {number} [count=7] Frame count.
 * @returns {string[]} Written paths.
 */
function writeCycle(directory, count = 7) {
  fs.mkdirSync(directory, { recursive: true });
  return Array.from({ length: count }, (_, index) => {
    const filePath = path.join(directory, `${String(index + 1).padStart(2, "0")}.png`);
    fs.writeFileSync(filePath, solidPng(PHASES[index % PHASES.length]));
    return filePath;
  });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-mcp-loop-"));
  const godotRoot = path.join(root, "godot");
  fs.mkdirSync(godotRoot, { recursive: true });
  fs.writeFileSync(path.join(godotRoot, "project.godot"), '[application]\nconfig/name="Loop"\n');
  createProjectStore(root).addProject({ id: "loop", label: "Loop", projectRoot: godotRoot });
  return {
    root,
    service: createXsxbMcpService({ root }),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("findLoopInPngFiles ranks the same 3-frame period as the Tuner core", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-loop-core-"));
  try {
    const files = writeCycle(directory);
    const found = findLoopInPngFiles(files, { minPeriod: 2, maxPeriod: 4, sampleSize: 8 });
    assert.equal(found.frameCount, 7);
    assert.equal(found.recommended.period, 3);
    assert.equal(
      found.recommended.length,
      found.recommended.period,
      "inclusive start..end must keep every unique pose in the period",
    );
    assert.equal(
      found.recommended.end - found.recommended.start + 1,
      found.recommended.period,
      "end = start + period - 1 so RGBRGB keeps three poses, not two",
    );
    assert.deepEqual(
      found.recommended.order,
      Array.from(
        { length: found.recommended.end - found.recommended.start + 1 },
        (_, index) => found.recommended.start + index,
      ),
    );
    assert.equal(found.oneShotLikely, false, "a short repeating cycle is not a one-shot");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("adviseLoopCandidate flags a burst, not an interior gait in a long take", () => {
  const partial = adviseLoopCandidate(26, { coverage: 0.42 });
  assert.equal(partial.oneShotLikely, true);
  assert.match(partial.note, /find_motion|one-shot/i);
  const burst = adviseLoopCandidate(26, { coverage: 0.42, length: 8, period: 8, score: 0.4 });
  assert.equal(burst.oneShotLikely, true);
  const shortCycle = adviseLoopCandidate(7, { coverage: 0.43 });
  assert.equal(shortCycle.oneShotLikely, false);
  assert.equal(shortCycle.note, "");
  const interiorGait = adviseLoopCandidate(145, {
    coverage: 0.276,
    length: 40,
    period: 40,
    score: 0.5,
    smoothness: 0.77,
    similarity: 77,
  });
  assert.equal(
    interiorGait.oneShotLikely,
    false,
    "a 40-frame run cycle inside a long take is not a one-shot",
  );
});

test("xsxb_find_loop queries a PNG directory without importing", async () => {
  const current = fixture();
  try {
    const directory = path.join(current.root, "run-seq");
    writeCycle(directory);
    const found = await current.service.call("xsxb_find_loop", {
      directory,
      sample_size: 8,
      min_period: 2,
      max_period: 4,
    });
    assert.equal(found.source, "directory");
    assert.equal(found.applied, false);
    assert.equal(found.recommended.period, 3);
    assert.ok(Array.isArray(found.candidates) && found.candidates.length >= 1);
    assert.ok(found.recommended.order.length >= 2);
  } finally {
    current.cleanup();
  }
});

test("xsxb_find_loop queries an imported animation and honors start_frame", async () => {
  const current = fixture();
  try {
    const directory = path.join(current.root, "idle-seq");
    writeCycle(directory);
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory,
      animation_id: "idle",
      fps: 12,
    });
    const found = await current.service.call("xsxb_find_loop", {
      animation_id: "idle",
      sample_size: 8,
      min_period: 2,
      max_period: 4,
      start_frame: 3,
    });
    assert.equal(found.source, "animation");
    assert.equal(found.animationId, "idle");
    assert.ok(found.candidates.every((candidate) => candidate.start >= 3));
  } finally {
    current.cleanup();
  }
});

test("xsxb_find_loop prefers file_paths over an imported animation", async () => {
  const current = fixture();
  try {
    const imported = path.join(current.root, "imported");
    const queried = path.join(current.root, "queried");
    writeCycle(imported, 7);
    const files = writeCycle(queried, 7);
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: imported,
      animation_id: "walk",
    });
    const found = await current.service.call("xsxb_find_loop", {
      animation_id: "walk",
      file_paths: files,
      sample_size: 8,
    });
    assert.equal(found.source, "files");
    assert.equal(found.animationId, undefined);
    assert.equal(found.recommended.period, 3);
  } finally {
    current.cleanup();
  }
});

test("xsxb_find_loop rejects sequences shorter than four frames", async () => {
  const current = fixture();
  try {
    const directory = path.join(current.root, "short");
    writeCycle(directory, 3);
    await assert.rejects(
      () => current.service.call("xsxb_find_loop", { directory, sample_size: 8 }),
      /at least 4 PNG frames/u,
    );
  } finally {
    current.cleanup();
  }
});

/**
 * Writes a hold-heavy sequence: two reds, two greens, one blue.
 * @param {string} directory Output directory.
 * @returns {string[]} Written paths.
 */
function writeHolds(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const colors = [PHASES[0], PHASES[0], PHASES[1], PHASES[1], PHASES[2]];
  return colors.map((color, index) => {
    const filePath = path.join(directory, `${String(index + 1).padStart(2, "0")}.png`);
    fs.writeFileSync(filePath, solidPng(color));
    return filePath;
  });
}

test("find_duplicates slider matches the organizer 重复比例 range", () => {
  const schema = toolDefinitions().find((tool) => tool.name === "xsxb_find_duplicates").inputSchema;
  for (const name of ["threshold", "duplicate_ratio"]) {
    assert.equal(schema.properties[name].minimum, ORGANIZER_SIMILARITY_THRESHOLD.min, name);
    assert.equal(schema.properties[name].maximum, ORGANIZER_SIMILARITY_THRESHOLD.max, name);
    assert.equal(schema.properties[name].default, ORGANIZER_SIMILARITY_THRESHOLD.fallback, name);
  }
  assert.throws(
    () =>
      validateToolArguments("xsxb_find_duplicates", schema, {
        threshold: ORGANIZER_SIMILARITY_THRESHOLD.min - 1,
      }),
    /threshold/,
  );
});

test("findDuplicatesInPngFiles keeps the first of each hold and drops the rest", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-dup-core-"));
  try {
    const files = writeHolds(directory);
    const found = findDuplicatesInPngFiles(files, { sampleSize: 8, threshold: 88 });
    assert.deepEqual(found.drop, [1, 3]);
    assert.deepEqual(found.order, [0, 2, 4]);
    assert.equal(found.applied, false);
    assert.equal(found.threshold, 88);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("findDuplicatesInPngFiles does not apply an auto-lowered threshold unless asked", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-dup-auto-"));
  try {
    const near = new Uint8ClampedArray(16 * 16 * 4);
    const tinted = new Uint8ClampedArray(16 * 16 * 4);
    for (let y = 0; y < 16; y += 1) {
      for (let x = 0; x < 16; x += 1) {
        const offset = (y * 16 + x) * 4;
        const border = x < 3 || y < 3 || x > 12 || y > 12;
        near.set(border ? [40, 40, 40, 255] : [210, 36, 42, 255], offset);
        tinted.set(border ? [40, 40, 40, 255] : [40, 90, 200, 255], offset);
      }
    }
    const files = ["a.png", "b.png", "c.png"].map((name, index) => {
      const filePath = path.join(directory, name);
      fs.writeFileSync(filePath, encodePngRgba(index === 1 ? tinted : near, 16, 16));
      return filePath;
    });
    const strict = findDuplicatesInPngFiles(files, { sampleSize: 8, threshold: 100 });
    assert.equal(strict.autoAdjustedThreshold != null, true);
    assert.deepEqual(strict.drop, []);
    assert.deepEqual(strict.order, [0, 1, 2]);
    assert.ok(strict.suggestedDrop.length >= 1);
    const opted = findDuplicatesInPngFiles(files, { sampleSize: 8, threshold: 100, autoAdjust: true });
    assert.ok(opted.drop.length >= 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("xsxb_find_duplicates queries an imported animation without mutating it", async () => {
  const current = fixture();
  try {
    const directory = path.join(current.root, "hold-seq");
    writeHolds(directory);
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory,
      animation_id: "hold",
    });
    const found = await current.service.call("xsxb_find_duplicates", {
      animation_id: "hold",
      sample_size: 8,
    });
    const byRatio = await current.service.call("xsxb_find_duplicates", {
      animation_id: "hold",
      sample_size: 8,
      duplicate_ratio: ORGANIZER_SIMILARITY_THRESHOLD.fallback,
    });
    assert.equal(found.source, "animation");
    assert.equal(found.applied, false);
    assert.equal(found.threshold, ORGANIZER_SIMILARITY_THRESHOLD.fallback);
    assert.deepEqual(found.drop, [1, 3]);
    assert.deepEqual(found.order, [0, 2, 4]);
    assert.deepEqual(byRatio.drop, found.drop);
    await assert.rejects(
      current.service.call("xsxb_find_duplicates", {
        animation_id: "hold",
        threshold: 88,
        duplicate_ratio: 70,
      }),
      /disagree/,
    );
    const still = await current.service.call("xsxb_get_animation", { animation_id: "hold" });
    assert.equal(still.frameCount, 5);
  } finally {
    current.cleanup();
  }
});

test("analyzePngFiles decodes each PNG once and returns compact dup/loop/motion", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-analyze-core-"));
  try {
    const files = writeCycle(directory);
    let decodes = 0;
    const found = analyzePngFiles(files, {
      sampleSize: 8,
      minPeriod: 2,
      maxPeriod: 4,
      decodePngRgba: (filePath) => {
        decodes += 1;
        return decodePngRgba(filePath);
      },
    });
    assert.equal(found.decodeCount, files.length);
    assert.equal(decodes, files.length, "one decode per frame, not three finder passes");
    assert.equal(found.loop.recommended.period, 3);
    assert.ok(Array.isArray(found.loop.recommended.order));
    assert.equal(
      found.loop.candidates.some((candidate) => Array.isArray(candidate.order)),
      false,
      "extra loop candidates omit order arrays",
    );
    assert.equal(found.duplicates.applied, false);
    assert.ok(Array.isArray(found.duplicates.order));
    assert.equal(Number.isInteger(found.motion.start), true);
    assert.equal(found.motion.activity, undefined);
    assert.equal(found.motion.frames, undefined);
    assert.ok(found.metrics.bodyHeight);
    assert.equal(found.images.length, files.length);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("xsxb_analyze runs after import, writes a preview sheet, and does not mutate frames", async () => {
  const current = fixture();
  try {
    const directory = path.join(current.root, "analyze-seq");
    writeCycle(directory);
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory,
      animation_id: "cycle",
    });
    const analyzed = await current.service.call("xsxb_analyze", {
      animation_id: "cycle",
      sample_size: 8,
      min_period: 2,
      max_period: 4,
    });
    assert.equal(analyzed.source, "animation");
    assert.equal(analyzed.applied, false);
    assert.equal(analyzed.animationId, "cycle");
    assert.equal(analyzed.decodeCount, 7);
    assert.equal(analyzed.loop.recommended.period, 3);
    assert.equal(analyzed.images, undefined, "decoded pixels stay off the MCP receipt");
    assert.equal(analyzed.preview.kind, "loop");
    assert.ok(analyzed.preview.path);
    assert.equal(fs.existsSync(analyzed.preview.path), true);
    const still = await current.service.call("xsxb_get_animation", { animation_id: "cycle" });
    assert.equal(still.frameCount, 7);
  } finally {
    current.cleanup();
  }
});

test("MCP catalog lists xsxb_analyze after the surgical finders", () => {
  const names = toolDefinitions().map((tool) => tool.name);
  assert.ok(names.includes("xsxb_analyze"));
  assert.ok(names.indexOf("xsxb_analyze") > names.indexOf("xsxb_find_motion"));
});
