#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { performance } = require("node:perf_hooks");
const { PassThrough } = require("node:stream");
const { createXsxbMcpService } = require("../mcp/xsxb_mcp_service");
const { startServer } = require("../mcp/xsxb_mcp_server");
const { encodePngRgba } = require("../mcp/xsxb_mcp_cutout");

const execFileAsync = promisify(execFile);

/**
 * Builds deterministic textured sprite bytes; empty canvas remains transparent.
 * @returns {Buffer} 512 by 512 PNG with a textured central subject.
 */
function spritePng() {
  const size = 512;
  const rgba = new Uint8ClampedArray(size * size * 4);
  let seed = 123456789;
  for (let y = 64; y < 448; y += 1) {
    for (let x = 128; x < 384; x += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      rgba.set([seed & 255, (seed >>> 8) & 255, (seed >>> 16) & 255, 255], (y * size + x) * 4);
    }
  }
  return encodePngRgba(rgba, size, size);
}

/**
 * Sends a tool request and immediately queues ping through the real STDIO reader.
 * @param {object} service Active MCP service.
 * @param {string} name Tool name.
 * @param {object} args Arguments.
 * @returns {Promise<object>} Wall-clock latency and validated receipt.
 */
async function toolAndPing(service, name, args) {
  const input = new PassThrough();
  const output = new PassThrough();
  const reader = startServer({ input, output, service: { ...service, close() {} } });
  let buffer = "";
  const started = performance.now();
  try {
    return await new Promise((resolve, reject) => {
      const result = {};
      const timer = setTimeout(() => reject(new Error(`Benchmark request timed out: ${name}`)), 120_000);
      output.on("data", (chunk) => {
        buffer += chunk.toString();
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const response = JSON.parse(line);
            if (response.error || response.result?.isError) throw new Error(JSON.stringify(response));
            if (response.id === 1) {
              result.toolMs = performance.now() - started;
              result.receipt = response.result.structuredContent;
            } else if (response.id === 2) result.pingMs = performance.now() - started;
            if (result.receipt && result.pingMs !== undefined) {
              clearTimeout(timer);
              resolve(result);
            }
          } catch (error) {
            clearTimeout(timer);
            reject(error);
          }
        }
      });
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })}\n`,
      );
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`);
    });
  } finally {
    reader.close();
    input.destroy();
    output.destroy();
  }
}

/**
 * Measures one frame count in an isolated process and temporary project.
 * FFmpeg is stubbed with already-decoded frames to isolate import overhead.
 * @param {number} count Frame count.
 * @returns {Promise<object>} Measurements and workload metadata.
 */
async function measureCase(count) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-benchmark-"));
  const png = spritePng();
  const source = path.join(root, "template.png");
  fs.writeFileSync(source, png);
  const video = path.join(root, "fixture.mp4");
  fs.writeFileSync(video, "stubbed extraction");
  let extractionCopyMs = 0;
  const service = createXsxbMcpService({
    root,
    florenceDetectImpl: null,
    extractVideoFramesImpl: async (_video, directory) => {
      const started = performance.now();
      const files = Array.from({ length: count }, (_, index) => {
        const destination = path.join(directory, `frame_${String(index).padStart(6, "0")}.png`);
        fs.copyFileSync(source, destination);
        return destination;
      });
      extractionCopyMs = performance.now() - started;
      return files;
    },
  });
  const readFile = fs.readFileSync;
  try {
    await service.callMcp("xsxb_create_project", { project_id: "benchmark" });
    const imported = await toolAndPing(service, "xsxb_import_video", {
      file_path: video,
      animation_id: "load",
    });
    if (imported.receipt.data.importedFrameCount !== count) throw new Error("Incomplete import");
    const animation = (await service.callMcp("xsxb_get_animation", {})).data;
    const files = new Set(animation.animation.frames.map((frame) => frame.absolutePath));
    let reads = 0;
    let bytes = 0;
    fs.readFileSync = (file, ...args) => {
      const value = readFile(file, ...args);
      if (typeof file === "string" && files.has(file)) {
        reads += 1;
        bytes += value.length;
      }
      return value;
    };
    const samples = [];
    for (let index = 0; index < 3; index += 1) {
      const measured = await toolAndPing(service, "xsxb_get_animation", { frames: "summary" });
      samples.push({ toolMs: measured.toolMs, pingMs: measured.pingMs });
    }
    return {
      count,
      dimensions: [512, 512],
      pngBytes: png.length,
      sourceMiB: (count * png.length) / 1024 ** 2,
      importMs: imported.toolMs,
      importPingMs: imported.pingMs,
      extractionCopyMs,
      observationSamples: samples,
      pngReadsPerObservation: reads / samples.length,
      pngMiBReadPerObservation: bytes / samples.length / 1024 ** 2,
      peakRssMiB: process.resourceUsage().maxRSS / 1024,
    };
  } finally {
    fs.readFileSync = readFile;
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Runs independent processes so peak RSS does not carry over between cases. */
async function main() {
  if (process.argv[2] === "--case") {
    const count = Number(process.argv[3]);
    if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error("Frame count must be 1–1000.");
    process.stdout.write(`${JSON.stringify(await measureCase(count))}\n`);
    return;
  }
  const results = [];
  for (const count of [100, 500]) {
    const result = await execFileAsync(process.execPath, [__filename, "--case", String(count)], {
      timeout: 180_000,
      maxBuffer: 1024 * 1024,
    });
    results.push(JSON.parse(result.stdout));
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: os.cpus()[0]?.model,
        workload:
          "Synthetic identical textured 512x512 sprites; stubbed FFmpeg extraction; warm local file cache; three observation samples. Not an end-to-end video benchmark.",
        results,
      },
      null,
      2,
    )}\n`,
  );
}

if (require.main === module)
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
