"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { handleMessage } = require("../xsxb_mcp_server");
const { receiptSummary } = require("../../mcp/xsxb_mcp_receipt");
const { createProjectStore } = require("../project_store");
const { createXsxbMcpService, toolDefinitions } = require("../xsxb_mcp_service");
const { encodePngRgba } = require("../xsxb_mcp_cutout");
const {
  FlorenceWorker,
  MODEL_ID,
  MODEL_REVISION,
  florenceRuntimeStatus,
} = require("../../mcp/xsxb_mcp_florence");
const { analyzeRegions } = require("../../mcp/xsxb_mcp_perception");
const { parsePng } = require("../../mcp/lib/attachment_sequence_analysis");
const { pngInfo } = require("../../mcp/lib/attack_trails");

/**
 * Creates a small transparent sprite with a body and a detached blade.
 * @returns {{data:Uint8ClampedArray,width:number,height:number}}
 */
function spriteFixture() {
  const width = 32;
  const height = 24;
  const data = new Uint8ClampedArray(width * height * 4);
  const paint = (x, y, color) => data.set(color, (y * width + x) * 4);
  for (let y = 5; y <= 19; y += 1) {
    for (let x = 12; x <= 18; x += 1) paint(x, y, [96, 38, 30, 255]);
  }
  for (let x = 21; x <= 30; x += 1) paint(x, 9, [220, 230, 245, 255]);
  return { data, width, height };
}

/**
 * Builds a structurally sufficient PNG header without allocating decoded pixels.
 * CRCs are ignored by the shared parser and remain zero for this guard test.
 * @param {number} width Width.
 * @param {number} height Height.
 * @returns {Buffer} Minimal PNG bytes.
 */
function oversizedPngHeader(width, height) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  const idat = Buffer.alloc(13);
  idat.writeUInt32BE(1, 0);
  idat.write("IDAT", 4, "ascii");
  return Buffer.concat([signature, ihdr, idat]);
}

test("oversized PNG dimensions are refused before inflate or RGBA allocation", () => {
  assert.throws(
    () => parsePng(oversizedPngHeader(16_384, 16_384)),
    (error) => error.code === "PNG_PIXEL_LIMIT",
  );
});

test("pngInfo refuses oversized IHDR before inflate", () => {
  assert.throws(
    () => pngInfo(oversizedPngHeader(16_384, 16_384)),
    (error) => error.code === "PNG_PIXEL_LIMIT",
  );
});

/**
 * White studio plate with an opaque body so animation cutout actually keys pixels.
 * @returns {{data:Uint8ClampedArray,width:number,height:number}}
 */
function whitePlateBody() {
  const width = 32;
  const height = 24;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set([255, 255, 255, 255], offset);
  for (let y = 6; y <= 18; y += 1) {
    for (let x = 12; x <= 18; x += 1) data.set([96, 38, 30, 255], (y * width + x) * 4);
  }
  return { data, width, height };
}

test("every advertised tool declares the closed v2 receipt output schema", () => {
  for (const tool of toolDefinitions()) {
    assert.equal(tool.outputSchema.type, "object", tool.name);
    assert.deepEqual(tool.outputSchema.required, [
      "schemaVersion",
      "tool",
      "ok",
      "data",
      "observation",
      "execution",
      "verification",
      "escalation",
    ]);
    assert.equal(tool.outputSchema.additionalProperties, false, tool.name);
  }
});

test("MCP transport wraps successful calls in v2 and keeps text content compact", async () => {
  const payload = { projects: [{ id: "demo", label: "Demo" }], activeProjectId: "demo" };
  const service = { tools: toolDefinitions(), call: async () => payload };
  const response = await handleMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "xsxb_list_projects" } },
    service,
  );
  const receipt = response.result.structuredContent;
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.tool, "xsxb_list_projects");
  assert.equal(receipt.ok, true);
  assert.deepEqual(receipt.data, payload);
  assert.equal(receipt.execution, null);
  assert.equal(receipt.verification, null);
  assert.equal(response.result.isError, false);
  assert.ok(response.result.content[0].text.length < JSON.stringify(receipt).length / 2);
  assert.doesNotMatch(response.result.content[0].text, /activeProjectId/);
  assert.equal(response.result.content[0].text, "xsxb_list_projects: ok");
});

test("receiptSummary includes snapshot id and artifact basename without dumping JSON", async () => {
  const snapshotId = "obs_v1_0123456789abcdef01234567";
  const receipt = {
    schemaVersion: 2,
    tool: "xsxb_analyze",
    ok: true,
    data: {
      activeProjectId: "demo",
      preview: { path: "/workspace/projects/demo/.xsxb/previews/walk_preview.png" },
      projects: [{ id: "demo", label: "Demo" }],
    },
    observation: {
      snapshotId,
      scope: { projectId: "demo" },
      sourceHashes: { walk: "abc" },
      createdAt: "2026-09-03T00:00:00.000Z",
    },
    execution: { effect: "confirmed", route: "domain_read", artifacts: [] },
    verification: { status: "unknown", checks: [], evidence: [] },
    escalation: null,
  };
  const text = receiptSummary(receipt);
  assert.match(text, /obs_v1_0123456789abcdef01234567/);
  assert.match(text, /walk_preview\.png/);
  assert.doesNotMatch(text, /activeProjectId/);
  assert.doesNotMatch(text, /\/workspace\/projects\/demo/);
  assert.equal(text.includes("\n"), false);
  assert.ok(text.length < JSON.stringify(receipt).length / 2);

  const service = { tools: toolDefinitions(), callMcp: async () => receipt };
  const response = await handleMessage(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "xsxb_analyze" } },
    service,
  );
  assert.equal(response.result.content[0].text, text);
});

test("MCP transport returns the same v2 envelope for tool errors", async () => {
  const error = Object.assign(new Error("snapshot changed"), {
    code: "STALE_SNAPSHOT",
    details: { expected: "obs_old", actual: "obs_new" },
  });
  const service = {
    tools: toolDefinitions(),
    call: async () => {
      throw error;
    },
  };
  const response = await handleMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "xsxb_reorganize_frames" } },
    service,
  );
  const receipt = response.result.structuredContent;
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.ok, false);
  assert.deepEqual(receipt.error, {
    code: "STALE_SNAPSHOT",
    message: "snapshot changed",
    details: { expected: "obs_old", actual: "obs_new" },
  });
  assert.equal(receipt.execution.effect, "refused");
  assert.equal(response.result.isError, true);
});

test("xsxb_detect_regions is read-only, code-first, and returns speakable candidates", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-detect-regions-"));
  try {
    const source = spriteFixture();
    const filePath = path.join(root, "sprite.png");
    fs.writeFileSync(filePath, encodePngRgba(source.data, source.width, source.height));
    const before = fs.readFileSync(filePath);
    const service = createXsxbMcpService({ root });
    const receipt = await service.callMcp("xsxb_detect_regions", {
      file_path: filePath,
      provider: "code",
      targets: ["subject", "weapon"],
      grid_divs: "8x8",
    });
    assert.equal(receipt.schemaVersion, 2);
    assert.equal(receipt.execution.route, "code_perception");
    assert.match(receipt.observation.snapshotId, /^obs_v1_[0-9a-f]{24}$/);
    assert.match(receipt.data.overlayPath, /\.png$/);
    assert.ok(receipt.data.candidates.some((candidate) => candidate.hypothesis === "subject"));
    assert.ok(receipt.data.candidates.some((candidate) => candidate.hypothesis === "elongated_attachment"));
    for (const candidate of receipt.data.candidates) {
      assert.match(candidate.regionId, /^reg_[0-9a-f]{16}$/);
      assert.ok(candidate.cells.every((cell) => /^[A-Z][1-9][0-9]*$/.test(cell)));
      assert.equal(Object.hasOwn(candidate, "bbox"), false, "public candidates hide pixel boxes");
      assert.ok(Array.isArray(candidate.evidence));
      assert.ok(Array.isArray(candidate.ambiguities));
    }
    assert.deepEqual(fs.readFileSync(filePath), before, "detection must not mutate the source PNG");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detect_regions refuses an overlay path that is the source PNG", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-detect-overwrite-"));
  try {
    const source = spriteFixture();
    const filePath = path.join(root, "sprite.png");
    fs.writeFileSync(filePath, encodePngRgba(source.data, source.width, source.height));
    const before = fs.readFileSync(filePath);
    const service = createXsxbMcpService({ root });
    await assert.rejects(
      () =>
        service.callMcp("xsxb_detect_regions", {
          file_path: filePath,
          output_path: filePath,
          provider: "code",
        }),
      (error) => error.code === "OVERWRITE_SOURCE",
    );
    assert.deepEqual(fs.readFileSync(filePath), before, "refusing overlay dest must leave the source PNG");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("code perception uses in-memory studio-plate removal and temporal evidence", async () => {
  const source = spriteFixture();
  const plated = new Uint8ClampedArray(source.width * source.height * 4);
  for (let offset = 0; offset < plated.length; offset += 4) plated.set([0, 255, 0, 255], offset);
  for (let offset = 0; offset < source.data.length; offset += 4) {
    if (source.data[offset + 3] > 16) plated.set(source.data.subarray(offset, offset + 4), offset);
  }
  const frames = Array.from({ length: 30 }, (_unused, frame) => ({
    data: new Uint8ClampedArray(frame === 0 ? plated : source.data),
    width: source.width,
    height: source.height,
    frame,
  }));
  const result = analyzeRegions(frames, {
    targets: ["subject"],
    rows: 8,
    cols: 8,
    maxCandidates: 16,
    snapshotId: "obs_v1_000000000000000000000000",
    segmentBackground: (input) => {
      const data = new Uint8ClampedArray(input.data);
      for (let offset = 0; offset < data.length; offset += 4) {
        if (data[offset] === 0 && data[offset + 1] === 255 && data[offset + 2] === 0) {
          data[offset + 3] = 0;
        }
      }
      return { data, confidence: 0.9, ambiguities: [] };
    },
  });
  assert.equal(result.sampledFrames, 24);
  assert.ok(
    result.candidates
      .filter((candidate) => candidate.hypothesis === "subject")
      .every((candidate) => candidate.evidence.includes("temporal_stability")),
  );
});

test("auto perception degrades cleanly and explicit Florence requires an installed provider", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-detect-fallback-"));
  try {
    const source = spriteFixture();
    const filePath = path.join(root, "sprite.png");
    fs.writeFileSync(filePath, encodePngRgba(source.data, source.width, source.height));
    const service = createXsxbMcpService({ root });
    const automatic = await service.callMcp("xsxb_detect_regions", {
      file_path: filePath,
      provider: "auto",
      targets: ["hand"],
    });
    assert.equal(automatic.execution.effect, "partial");
    assert.deepEqual(automatic.escalation, { target: "agent_visual", reason: "model_unavailable" });
    await assert.rejects(
      () => service.call("xsxb_detect_regions", { file_path: filePath, provider: "florence" }),
      (error) => error.code === "MODEL_UNAVAILABLE",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Florence labels are accepted only when grounded by code geometry", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-detect-florence-"));
  try {
    const source = spriteFixture();
    const filePath = path.join(root, "sprite.png");
    fs.writeFileSync(filePath, encodePngRgba(source.data, source.width, source.height));
    const service = createXsxbMcpService({
      root,
      florenceDetectImpl: async () => ({
        detections: [
          { bbox: [20, 8, 31, 11], label: "sword" },
          { bbox: [11, 4, 20, 21], label: "sword" },
          { bbox: [0, 0, 2, 2], label: "hallucinated corner object" },
        ],
      }),
    });
    const receipt = await service.callMcp("xsxb_detect_regions", {
      file_path: filePath,
      provider: "florence",
      targets: ["subject", "weapon"],
    });
    assert.equal(receipt.execution.route, "local_florence");
    assert.equal(
      receipt.data.candidates.some((candidate) => candidate.semanticLabel === "sword"),
      true,
    );
    assert.equal(
      receipt.data.candidates.some((candidate) => candidate.semanticLabel === "hallucinated corner object"),
      false,
    );
    assert.equal(receipt.data.model.rejected.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("auto perception keeps code evidence when the installed model fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-detect-model-failure-"));
  try {
    const source = spriteFixture();
    const filePath = path.join(root, "sprite.png");
    fs.writeFileSync(filePath, encodePngRgba(source.data, source.width, source.height));
    const service = createXsxbMcpService({
      root,
      florenceDetectImpl: async () => {
        throw new Error("model crashed");
      },
    });
    const receipt = await service.callMcp("xsxb_detect_regions", {
      file_path: filePath,
      provider: "auto",
      targets: ["hand"],
    });
    assert.equal(receipt.execution.effect, "partial");
    assert.deepEqual(receipt.escalation, { target: "agent_visual", reason: "model_failed" });
    assert.match(receipt.data.model.error, /model crashed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an empty Florence result stays partial when semantic ambiguity remains", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-detect-empty-model-"));
  try {
    const source = spriteFixture();
    const filePath = path.join(root, "sprite.png");
    fs.writeFileSync(filePath, encodePngRgba(source.data, source.width, source.height));
    const service = createXsxbMcpService({
      root,
      florenceDetectImpl: async () => ({ detections: [] }),
    });
    const receipt = await service.callMcp("xsxb_detect_regions", {
      file_path: filePath,
      provider: "auto",
      targets: ["hand"],
    });
    assert.equal(receipt.execution.effect, "partial");
    assert.deepEqual(receipt.escalation, { target: "agent_visual", reason: "code_ambiguity" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Florence keeps requested animation frame ids and can ground OCR regions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-detect-frame-id-"));
  try {
    const godotRoot = path.join(root, "godot");
    fs.mkdirSync(godotRoot, { recursive: true });
    fs.writeFileSync(path.join(godotRoot, "project.godot"), "[application]\n");
    const store = createProjectStore(root);
    store.addProject({ id: "detect", label: "Detect", projectRoot: godotRoot });
    const sourceDir = path.join(root, "source");
    fs.mkdirSync(sourceDir, { recursive: true });
    const sprite = spriteFixture();
    for (let index = 0; index < 3; index += 1) {
      fs.writeFileSync(
        path.join(sourceDir, `frame_${index}.png`),
        encodePngRgba(sprite.data, sprite.width, sprite.height),
      );
    }
    const service = createXsxbMcpService({
      root,
      florenceDetectImpl: async ({ frames }) => ({
        detections: [{ frame: frames[0].frame, bbox: [11, 4, 20, 21], label: "text: READY" }],
      }),
    });
    await service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: sourceDir,
      project_id: "detect",
      animation_id: "idle",
    });
    const receipt = await service.callMcp("xsxb_detect_regions", {
      project_id: "detect",
      animation_id: "idle",
      frame: 2,
      provider: "florence",
      targets: ["text"],
    });
    assert.equal(
      receipt.data.candidates.some((candidate) => candidate.frame === 2),
      true,
    );
    assert.equal(
      receipt.data.candidates.some((candidate) => candidate.semanticLabel === "text: READY"),
      true,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("public still-image cell writes require the overlay that grounded each anchor", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-still-freshness-"));
  try {
    const source = spriteFixture();
    const targetPath = path.join(root, "target.png");
    const objectPath = path.join(root, "object.png");
    fs.writeFileSync(targetPath, encodePngRgba(source.data, source.width, source.height));
    fs.writeFileSync(objectPath, encodePngRgba(source.data, source.width, source.height));
    const service = createXsxbMcpService({ root });
    await assert.rejects(
      () =>
        service.callMcp("xsxb_place_image", {
          target_path: targetPath,
          object_path: objectPath,
          target_anchor: {
            view: { x: 0, y: 0, width: 32, height: 24, rows: 8, cols: 8 },
            cells: ["D4"],
          },
          object_anchor: { mode: "alpha_center" },
        }),
      (error) => error.code === "MISSING_OVERLAY",
    );
    await assert.rejects(
      () =>
        service.callMcp("xsxb_overlay_grid", {
          file_path: targetPath,
          crop_from: {
            parent_view: { x: 0, y: 0, width: 32, height: 24, rows: 8, cols: 8 },
            cells: ["D4"],
          },
        }),
      (error) => error.code === "MISSING_OVERLAY",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("place v2 separates confirmed geometric execution from unproven visual fit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-place-v2-"));
  try {
    const source = spriteFixture();
    const targetPath = path.join(root, "target.png");
    const objectPath = path.join(root, "object.png");
    fs.writeFileSync(targetPath, encodePngRgba(source.data, source.width, source.height));
    fs.writeFileSync(objectPath, encodePngRgba(source.data, source.width, source.height));
    const service = createXsxbMcpService({ root });
    const overlay = await service.call("xsxb_overlay_grid", { file_path: targetPath });
    const receipt = await service.callMcp("xsxb_place_image", {
      target_path: targetPath,
      object_path: objectPath,
      target_anchor: { view: overlay.view, cells: ["D4"], overlay_id: overlay.overlay_id },
      object_anchor: { mode: "alpha_center" },
      verify_overlay: false,
    });
    assert.equal(receipt.execution.effect, "confirmed");
    assert.equal(receipt.verification.status, "unknown");
    assert.deepEqual(receipt.verification.evidence, ["geometric_only_visual_fit_unproven"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a separate scale view requires its own matching overlay stamp", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-scale-freshness-"));
  try {
    const source = spriteFixture();
    const targetPath = path.join(root, "target.png");
    const objectPath = path.join(root, "object.png");
    fs.writeFileSync(targetPath, encodePngRgba(source.data, source.width, source.height));
    fs.writeFileSync(objectPath, encodePngRgba(source.data, source.width, source.height));
    const service = createXsxbMcpService({ root });
    const overlay = await service.call("xsxb_overlay_grid", { file_path: targetPath });
    await assert.rejects(
      () =>
        service.callMcp("xsxb_place_image", {
          target_path: targetPath,
          object_path: objectPath,
          target_anchor: { view: overlay.view, cells: ["D4"], overlay_id: overlay.overlay_id },
          object_anchor: { mode: "alpha_center" },
          scale: {
            mode: "relative",
            span: "width",
            ratio: 1,
            target: { view: { ...overlay.view, width: 3200 }, cells: ["A1"] },
          },
        }),
      (error) => error.code === "MISSING_OVERLAY",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("preview-only mutations never report a confirmed execution effect", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-preview-receipt-"));
  try {
    const godotRoot = path.join(root, "godot");
    fs.mkdirSync(godotRoot, { recursive: true });
    fs.writeFileSync(path.join(godotRoot, "project.godot"), "[application]\n");
    const store = createProjectStore(root);
    store.addProject({ id: "preview", label: "Preview", projectRoot: godotRoot });
    const sourceDir = path.join(root, "source");
    fs.mkdirSync(sourceDir, { recursive: true });
    const sprite = spriteFixture();
    fs.writeFileSync(
      path.join(sourceDir, "frame.png"),
      encodePngRgba(sprite.data, sprite.width, sprite.height),
    );
    const service = createXsxbMcpService({ root });
    await service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: sourceDir,
      project_id: "preview",
      animation_id: "walk",
    });
    const receipt = await service.callMcp("xsxb_plant_feet", {
      project_id: "preview",
      animation_id: "walk",
    });
    assert.equal(receipt.data.dryRun, true);
    assert.equal(receipt.execution.effect, "unverifiable");
    assert.equal(receipt.verification.status, "unknown");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Florence runtime stays unavailable until an explicit pinned installation exists", () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-florence-runtime-"));
  try {
    assert.equal(florenceRuntimeStatus({ runtimeDir }).installed, false);
    const python =
      process.platform === "win32"
        ? path.join(runtimeDir, ".venv", "Scripts", "python.exe")
        : path.join(runtimeDir, ".venv", "bin", "python");
    const modelPath = path.join(runtimeDir, "model");
    fs.mkdirSync(path.dirname(python), { recursive: true });
    fs.mkdirSync(modelPath, { recursive: true });
    fs.writeFileSync(python, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(path.join(modelPath, "model.safetensors"), "placeholder");
    fs.writeFileSync(
      path.join(runtimeDir, "installed.json"),
      JSON.stringify({
        modelId: MODEL_ID,
        revision: MODEL_REVISION,
        modelPath,
        modelSha256: require("../../mcp/xsxb_mcp_florence").MODEL_FILE_SHA256,
      }),
    );
    assert.equal(florenceRuntimeStatus({ runtimeDir }).installed, true);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("closing Florence rejects pending inference without restarting the worker", async () => {
  const exitListenersBefore = process.listenerCount("exit");
  const worker = new FlorenceWorker({ python: process.execPath, modelPath: "." }, "unused");
  let sendCalls = 0;
  worker.send = async () => {
    sendCalls += 1;
    const error = new Error("Florence worker was stopped.");
    error.code = "MODEL_STOPPED";
    throw error;
  };
  try {
    await assert.rejects(
      () => worker.detect({ frames: [], targets: ["subject"] }),
      (error) => error.code === "MODEL_STOPPED",
    );
    assert.equal(sendCalls, 1);
    const pending = new Promise((resolve, reject) => {
      worker.pending.set(1, { resolve, reject, timer: setTimeout(() => {}, 60_000) });
    });
    worker.stop();
    await assert.rejects(pending, (error) => error.code === "MODEL_STOPPED");
    assert.equal(worker.child, null);
    assert.equal(process.listenerCount("exit"), exitListenersBefore);
  } finally {
    worker.stop();
  }
});

test("animation-derived writes require a current content-addressed snapshot", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-animation-snapshot-"));
  try {
    const godotRoot = path.join(root, "godot");
    fs.mkdirSync(godotRoot, { recursive: true });
    fs.writeFileSync(path.join(godotRoot, "project.godot"), "[application]\n");
    const store = createProjectStore(root);
    store.addProject({ id: "snapshot", label: "Snapshot", projectRoot: godotRoot });
    const sourceDir = path.join(root, "source");
    fs.mkdirSync(sourceDir, { recursive: true });
    const sprite = spriteFixture();
    for (let index = 0; index < 4; index += 1) {
      const pixels = new Uint8ClampedArray(sprite.data);
      pixels[(5 * sprite.width + 12 + index) * 4] = 100 + index;
      fs.writeFileSync(
        path.join(sourceDir, `frame_${index}.png`),
        encodePngRgba(pixels, sprite.width, sprite.height),
      );
    }
    const service = createXsxbMcpService({ root });
    await service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: sourceDir,
      project_id: "snapshot",
      profile_id: "mcp_imports",
      animation_id: "walk",
    });
    const analyzed = await service.callMcp("xsxb_analyze", {
      project_id: "snapshot",
      profile_id: "mcp_imports",
      animation_id: "walk",
      preview: false,
    });
    assert.match(analyzed.observation.snapshotId, /^obs_v1_[0-9a-f]{24}$/);
    await service.callMcp("xsxb_reorganize_frames", {
      project_id: "snapshot",
      profile_id: "mcp_imports",
      animation_id: "walk",
      order: [1, 0, 2, 3],
      basis_snapshot_id: analyzed.observation.snapshotId,
      sync: false,
    });

    let fresh = await service.callMcp("xsxb_get_animation", {
      project_id: "snapshot",
      profile_id: "mcp_imports",
      animation_id: "walk",
    });
    await assert.rejects(
      () =>
        service.callMcp("xsxb_update_frame_boxes", {
          project_id: "snapshot",
          profile_id: "mcp_imports",
          animation_id: "walk",
          frame: 0,
          hurtbox: { min: "A1", max: "B2" },
        }),
      (error) => error.code === "MISSING_SNAPSHOT",
    );
    await service.callMcp("xsxb_update_frame_boxes", {
      project_id: "snapshot",
      profile_id: "mcp_imports",
      animation_id: "walk",
      frame: 0,
      hurtbox: { min: "A1", max: "B2" },
      basis_snapshot_id: fresh.observation.snapshotId,
    });
    fresh = await service.callMcp("xsxb_get_animation", {
      project_id: "snapshot",
      profile_id: "mcp_imports",
      animation_id: "walk",
    });
    const firstPath = path.resolve(root, fresh.data.animation.frames[0].path);
    const changed = new Uint8ClampedArray(sprite.data);
    changed[(6 * sprite.width + 13) * 4 + 1] = 201;
    fs.writeFileSync(firstPath, encodePngRgba(changed, sprite.width, sprite.height));
    const before = await service.call("xsxb_get_animation", {
      project_id: "snapshot",
      profile_id: "mcp_imports",
      animation_id: "walk",
    });
    await assert.rejects(
      () =>
        service.callMcp("xsxb_reorganize_frames", {
          project_id: "snapshot",
          profile_id: "mcp_imports",
          animation_id: "walk",
          order: [0, 1, 2, 3],
          basis_snapshot_id: fresh.observation.snapshotId,
          sync: false,
        }),
      (error) => error.code === "STALE_SNAPSHOT",
    );
    const after = await service.call("xsxb_get_animation", {
      project_id: "snapshot",
      profile_id: "mcp_imports",
      animation_id: "walk",
    });
    assert.deepEqual(
      after.animation.frames,
      before.animation.frames,
      "stale rejection must happen before writes",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("animation xsxb_cutout via callMcp requires a snapshot then returns a new one", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-cutout-callmcp-"));
  try {
    const godotRoot = path.join(root, "godot");
    fs.mkdirSync(godotRoot, { recursive: true });
    fs.writeFileSync(path.join(godotRoot, "project.godot"), "[application]\n");
    createProjectStore(root).addProject({ id: "cutout", label: "Cutout", projectRoot: godotRoot });
    const sourceDir = path.join(root, "source");
    fs.mkdirSync(sourceDir, { recursive: true });
    const sprite = whitePlateBody();
    fs.writeFileSync(
      path.join(sourceDir, "frame.png"),
      encodePngRgba(sprite.data, sprite.width, sprite.height),
    );
    const service = createXsxbMcpService({ root });
    await service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: sourceDir,
      project_id: "cutout",
      animation_id: "walk",
    });
    const listed = await service.call("xsxb_get_animation", {
      project_id: "cutout",
      animation_id: "walk",
    });
    const framePath = listed.animation.frames[0].absolutePath;
    const beforeBytes = fs.readFileSync(framePath);
    await assert.rejects(
      () =>
        service.callMcp("xsxb_cutout", {
          project_id: "cutout",
          animation_id: "walk",
          key_mode: "border_flood",
          key_color: "#ffffff",
        }),
      (error) => error.code === "MISSING_SNAPSHOT",
    );
    assert.deepEqual(fs.readFileSync(framePath), beforeBytes, "missing snapshot must not rewrite frames");

    const observed = await service.callMcp("xsxb_get_animation", {
      project_id: "cutout",
      animation_id: "walk",
    });
    const cut = await service.callMcp("xsxb_cutout", {
      project_id: "cutout",
      animation_id: "walk",
      key_mode: "border_flood",
      key_color: "#ffffff",
      basis_snapshot_id: observed.observation.snapshotId,
    });
    assert.equal(cut.ok, true);
    assert.equal(cut.data.keyed, true);
    assert.match(cut.observation.snapshotId, /^obs_v1_[0-9a-f]{24}$/);
    assert.notEqual(cut.observation.snapshotId, observed.observation.snapshotId);
    assert.notDeepEqual(fs.readFileSync(framePath), beforeBytes, "accepted cutout must rewrite keyed frames");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
