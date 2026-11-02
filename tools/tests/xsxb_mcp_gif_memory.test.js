"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const { createXsxbMcpService } = require("../../mcp/xsxb_mcp_service");
const { encodePngRgba, decodePngRgba, placeFramesOnCanvas } = require("../../mcp/xsxb_mcp_cutout");

/** Builds a transparent sprite with deterministic asymmetric opaque pixels. */
function sprite(width, height) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 3; y < height - 2; y += 1)
    for (let x = 2; x < width - 4; x += 1) pixels.set([x % 256, y % 256, 100, 255], (y * width + x) * 4);
  return encodePngRgba(pixels, width, height);
}

/** Measures retained pixel buffers while exporting through the public service. */
async function memoryProbe(count = 40, size = 256) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-gif-memory-"));
  const source = path.join(root, "source.png");
  fs.writeFileSync(source, sprite(size, size));
  const hashes = [];
  const service = createXsxbMcpService({
    root,
    florenceDetectImpl: null,
    encodeGifImpl: async (job) => {
      for (const file of job.framePaths)
        hashes.push(crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
      fs.writeFileSync(job.outputPath, "GIF89a-probe");
    },
  });
  const writeFile = fs.writeFileSync;
  let peakLiveArrayBuffers = 0;
  let samples = 0;
  try {
    await service.call("xsxb_create_project", { project_id: "memory" });
    await service.call("xsxb_import_animation", {
      source: "items",
      animation_id: "walk",
      items: Array.from({ length: count }, () => ({ path: source })),
    });
    await service.call("xsxb_set_visual_transform", { level: "group", visual_size: 0.75 });
    global.gc();
    const baseline = process.memoryUsage().arrayBuffers;
    fs.writeFileSync = (file, ...args) => {
      const result = writeFile(file, ...args);
      if (typeof file === "string" && file.includes("xsxb-gif-visual-") && /\.png$/.test(file)) {
        global.gc();
        samples += 1;
        peakLiveArrayBuffers = Math.max(peakLiveArrayBuffers, process.memoryUsage().arrayBuffers - baseline);
      }
      return result;
    };
    const receipt = await service.callMcp("xsxb_export_gif", { background: "transparent" });
    assert.equal(receipt.ok, true);
    assert.equal(samples, count);
    return { count, size, peakLiveArrayBuffers, peakRssMiB: process.resourceUsage().maxRSS / 1024, hashes };
  } finally {
    fs.writeFileSync = writeFile;
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv.includes("--probe")) {
  memoryProbe(Number(process.argv[3] || 40), Number(process.argv[4] || 256))
    .then((result) => process.stdout.write(JSON.stringify(result)))
    .catch((error) => {
      process.stderr.write(error.stack);
      process.exitCode = 1;
    });
} else {
  test("visual GIF export keeps live pixel buffers bounded instead of retaining every frame", () => {
    const result = JSON.parse(
      execFileSync(process.execPath, ["--expose-gc", __filename, "--probe"], { encoding: "utf8" }),
    );
    // Twelve RGBA frames allow decoder/compressor scratch space while rejecting
    // retention of the forty source and forty destination frames in this case.
    assert.ok(
      result.peakLiveArrayBuffers < 12 * result.size ** 2 * 4,
      `Retained ${result.peakLiveArrayBuffers} bytes for ${result.count} frames of ${result.size}px`,
    );
  });

  test("incremental visual GIF frames match batch placement with mixed sizes and disabled frames", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-gif-equivalence-"));
    let encoded;
    let encodedPaths;
    const service = createXsxbMcpService({
      root,
      florenceDetectImpl: null,
      encodeGifImpl: async (job) => {
        encoded = job.framePaths.map((file) => fs.readFileSync(file));
        encodedPaths = [...job.framePaths];
        fs.writeFileSync(job.outputPath, "GIF89a-equivalence");
      },
    });
    try {
      const files = [sprite(16, 20), sprite(24, 24), sprite(20, 16)].map((bytes, index) => {
        const file = path.join(root, `source_${index}.png`);
        fs.writeFileSync(file, bytes);
        return file;
      });
      await service.call("xsxb_create_project", { project_id: "equivalence" });
      await service.call("xsxb_import_animation", {
        source: "items",
        animation_id: "walk",
        items: files.map((file) => ({ path: file })),
      });
      await service.call("xsxb_set_visual_transform", { level: "group", visual_size: 0.5 });
      await service.call("xsxb_set_visual_transform", { level: "frame", frame: 2, visual_size: 1.25 });
      await service.call("xsxb_update_timing", { frame: 1, disabled: true });
      for (const includeDisabled of [false, true]) {
        const indexes = includeDisabled ? [0, 1, 2] : [0, 2];
        const decoded = indexes.map((index) => decodePngRgba(files[index]));
        const scales = indexes.map((index) => (index === 2 ? 1.25 : 0.5));
        const expected = placeFramesOnCanvas(decoded, decoded[0].width, decoded[0].height, {
          frameScales: scales,
        }).map((frame) => encodePngRgba(frame.data, frame.width, frame.height));
        const receipt = await service.callMcp("xsxb_export_gif", {
          background: "transparent",
          include_disabled: includeDisabled,
        });
        assert.equal(receipt.data.appliedVisual, true);
        assert.deepEqual(encoded, expected);
        assert.ok(
          encodedPaths.every((file) => !fs.existsSync(file)),
          "temporary frames must be cleaned",
        );
      }
    } finally {
      service.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
