#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile, fork } = require("node:child_process");
const { promisify } = require("node:util");
const { performance } = require("node:perf_hooks");
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

/** Returns a cross-process comparable monotonic timestamp in milliseconds. */
function timestamp() {
  return performance.timeOrigin + performance.now();
}

/**
 * Marks the execution window over IPC without adding anything to MCP stdout.
 * @param {object} service Real service or deterministic test service.
 * @param {()=>object} metrics Per-process counters collected after each request.
 * @returns {object} Instrumented transport service.
 */
function instrumentService(service, metrics = () => ({})) {
  return {
    ...service,
    async callMcp(name, args) {
      process.send({ kind: "benchmark-tool-started", time: timestamp() });
      try {
        return await service.callMcp(name, args);
      } finally {
        process.send({ kind: "benchmark-tool-finished", time: timestamp(), metrics: metrics() });
      }
    },
  };
}

/**
 * Sends ping from an independent process after the server marks tool execution.
 * This measures queued input during synchronous CPU work as well as async work.
 * @param {import("node:child_process").ChildProcess} child Instrumented MCP child.
 * @param {string} name Tool name.
 * @param {object} args Arguments.
 * @returns {Promise<object>} Validated receipt, timings, execution-window evidence.
 */
function toolAndPing(child, name, args) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let pingSentAt;
    let executionStartedAt;
    let executionFinishedAt;
    const started = timestamp();
    const result = {};
    const timer = setTimeout(() => finish(new Error(`Benchmark request timed out: ${name}`)), 120_000);
    /** Releases all per-request listeners before resolving or rejecting. */
    function finish(error) {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", finish);
      child.stdin.off("error", finish);
      if (error) reject(error);
      else resolve(result);
    }
    /** Completes only after both wire responses and execution metadata arrive. */
    function maybeFinish() {
      if (!result.receipt || result.pingMs === undefined || executionFinishedAt === undefined) return;
      result.pingIssuedDuringTool = pingSentAt >= executionStartedAt && pingSentAt <= executionFinishedAt;
      result.pingDispatchDelayMs = pingSentAt - executionStartedAt;
      finish();
    }
    /** Emits the probe after the child has actually entered the request. */
    function onMessage(message) {
      if (message.kind === "benchmark-tool-started") {
        executionStartedAt = message.time;
        pingSentAt = timestamp();
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`);
      } else if (message.kind === "benchmark-tool-finished") {
        executionFinishedAt = message.time;
        result.metrics = message.metrics;
        maybeFinish();
      }
    }
    /** Parses newline-delimited MCP responses, including split pipe chunks. */
    function onData(chunk) {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const response = JSON.parse(line);
          if (response.error || response.result?.isError) throw new Error(JSON.stringify(response));
          if (response.id === 1) {
            result.toolMs = timestamp() - started;
            result.receipt = response.result.structuredContent;
          } else if (response.id === 2) result.pingMs = timestamp() - pingSentAt;
          maybeFinish();
        } catch (error) {
          finish(error);
        }
      }
    }
    /** Rejects immediately if the server exits before the response completes. */
    function onExit(code, signal) {
      finish(new Error(`Benchmark server exited: code=${code}, signal=${signal}`));
    }
    child.stdout.on("data", onData);
    child.on("message", onMessage);
    child.on("exit", onExit);
    child.on("error", finish);
    child.stdin.on("error", finish);
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })}\n`,
    );
  });
}

/**
 * Runs the real service in a dedicated process; FFmpeg extraction stays stubbed.
 * @param {string} root Disposable project root.
 * @param {number} count Frame count.
 * @returns {Promise<void>} Server setup, followed by normal STDIO processing.
 */
async function serveCase(root, count) {
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
  await service.callMcp("xsxb_create_project", { project_id: "benchmark" });
  const readFile = fs.readFileSync;
  let files = new Set();
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
  const measuredService = {
    ...service,
    async callMcp(name, args) {
      reads = 0;
      bytes = 0;
      const receipt = await service.callMcp(name, args);
      if (name === "xsxb_get_animation" && receipt.data?.animation?.frames) {
        files = new Set(receipt.data.animation.frames.map((frame) => frame.absolutePath));
      }
      return receipt;
    },
  };
  const reader = startServer({
    service: instrumentService(measuredService, () => ({
      reads,
      bytes,
      extractionCopyMs,
      peakRssMiB: process.resourceUsage().maxRSS / 1024,
    })),
  });
  reader.once("close", () => {
    fs.readFileSync = readFile;
    process.disconnect();
  });
  process.send({ kind: "benchmark-ready", pngBytes: png.length });
}

/**
 * Waits for initialized server metadata and preserves startup diagnostics.
 * @param {import("node:child_process").ChildProcess} child Benchmark server.
 * @returns {Promise<object>} Fixture metadata.
 */
function waitReady(child) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => finish(new Error("Benchmark server startup timed out.")), 30_000);
    /** Releases startup listeners and settles readiness once. */
    function finish(error, metadata) {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", finish);
      child.off("exit", onExit);
      child.stderr.off("data", onStderr);
      if (error) reject(error);
      else resolve(metadata);
    }
    /** Buffers short setup errors without polluting benchmark JSON output. */
    function onStderr(chunk) {
      stderr = (stderr + chunk.toString()).slice(-8192);
    }
    /** Accepts only the explicit server-ready marker. */
    function onMessage(message) {
      if (message.kind === "benchmark-ready") finish(null, message);
    }
    /** Reports early startup termination with available diagnostics. */
    function onExit(code, signal) {
      finish(new Error(`Benchmark server startup failed (${code}, ${signal}): ${stderr}`));
    }
    child.on("message", onMessage);
    child.on("error", finish);
    child.on("exit", onExit);
    child.stderr.on("data", onStderr);
  });
}

/**
 * Measures one size with independent server and probe event loops.
 * @param {number} count Frame count.
 * @returns {Promise<object>} Import, observation and busy-ping measurements.
 */
async function measureCase(count) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-benchmark-"));
  const child = fork(__filename, ["--serve-case", root, String(count)], { silent: true });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    const metadata = await waitReady(child);
    const imported = await toolAndPing(child, "xsxb_import_video", {
      file_path: path.join(root, "fixture.mp4"),
      animation_id: "load",
    });
    if (imported.receipt.data.importedFrameCount !== count) throw new Error("Incomplete import");
    await toolAndPing(child, "xsxb_get_animation", {});
    const samples = [];
    for (let index = 0; index < 3; index += 1) {
      const measured = await toolAndPing(child, "xsxb_get_animation", { frames: "summary" });
      samples.push(measured);
    }
    return {
      count,
      dimensions: [512, 512],
      pngBytes: metadata.pngBytes,
      sourceMiB: (count * metadata.pngBytes) / 1024 ** 2,
      importMs: imported.toolMs,
      importPingMs: imported.pingMs,
      importPingIssuedDuringTool: imported.pingIssuedDuringTool,
      importPingDispatchDelayMs: imported.pingDispatchDelayMs,
      extractionCopyMs: imported.metrics.extractionCopyMs,
      observationSamples: samples.map(({ toolMs, pingMs, pingIssuedDuringTool, pingDispatchDelayMs }) => ({
        toolMs,
        pingMs,
        pingIssuedDuringTool,
        pingDispatchDelayMs,
      })),
      pngReadsPerObservation: samples.reduce((sum, sample) => sum + sample.metrics.reads, 0) / samples.length,
      pngMiBReadPerObservation:
        samples.reduce((sum, sample) => sum + sample.metrics.bytes, 0) / samples.length / 1024 ** 2,
      peakRssMiB: samples.at(-1).metrics.peakRssMiB,
    };
  } finally {
    child.kill();
    await exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Runs independent processes so peak RSS does not carry over between cases. */
async function main() {
  if (process.argv[2] === "--serve-case") {
    await serveCase(process.argv[3], Number(process.argv[4]));
    return;
  }
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
          "Synthetic identical textured 512x512 sprites; stubbed FFmpeg extraction; warm local file cache; three observation samples. Ping comes from a separate process after an execution-start marker; pingIssuedDuringTool=false samples are not busy latency. Not an end-to-end video benchmark.",
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

module.exports = { instrumentService, toolAndPing };
