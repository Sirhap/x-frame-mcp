"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PassThrough } = require("node:stream");
const { createProjectStore } = require("../project_store");
const { INSTRUCTIONS, handleMessage, startServer } = require("../xsxb_mcp_server");
const {
  MCP_TOOL_NAMES,
  booleanFlag,
  classifyValidationMessage,
  createTestWav,
  createXsxbMcpService,
  requireFps,
  requireFrameIndex,
  toolDefinitions,
} = require("../xsxb_mcp_service");
const { decodePngRgba, encodePngRgba, subjectAnchor } = require("../xsxb_mcp_cutout");
const { videoExtractFfmpegArgs } = require("../xsxb_mcp_processes");

const ONE_PIXEL_PNG = encodePngRgba(new Uint8ClampedArray([255, 255, 255, 255]), 1, 1);

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-mcp-test-"));
  const godotRoot = path.join(root, "godot");
  fs.mkdirSync(godotRoot, { recursive: true });
  fs.writeFileSync(path.join(godotRoot, "project.godot"), '[application]\nconfig/name="MCP Test"\n');
  const presetPath = path.join(
    root,
    "tools/animation_tuner/public/presets/attack_trails/dynamic_trail_luma.png",
  );
  fs.mkdirSync(path.dirname(presetPath), { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, "../animation_tuner/public/presets/attack_trails/dynamic_trail_luma.png"),
    presetPath,
  );
  const store = createProjectStore(root);
  store.addProject({ id: "mcp-test", label: "MCP Test", projectRoot: godotRoot });
  const video = path.join(root, "source.mp4");
  fs.writeFileSync(video, "test-video-placeholder");
  const extractVideoFramesImpl = async (_videoPath, outputDirectory) => {
    return Array.from({ length: 3 }, (_, index) => {
      const framePath = path.join(outputDirectory, `frame_${String(index + 1).padStart(6, "0")}.png`);
      fs.writeFileSync(framePath, ONE_PIXEL_PNG);
      return framePath;
    });
  };
  const serviceOptions = { root, extractVideoFramesImpl };
  if (options.encodeGifImpl) serviceOptions.encodeGifImpl = options.encodeGifImpl;
  if (!options.realCutout) {
    serviceOptions.cutoutPngFileImpl = async (inputPath, outputPath) => {
      fs.copyFileSync(inputPath, outputPath);
    };
  }
  return {
    root,
    godotRoot,
    video,
    service: createXsxbMcpService(serviceOptions),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("MCP tool catalog exposes the required XSXB tools in the requested order", () => {
  assert.deepEqual(
    toolDefinitions().map((tool) => tool.name),
    MCP_TOOL_NAMES,
  );
  for (const tool of toolDefinitions()) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(typeof tool.description, "string");
  }
});

test("MCP transport initializes, lists tools, and returns structured tool results", async () => {
  const service = { tools: toolDefinitions(), call: async () => ({ ok: true, value: 42 }) };
  const initialized = await handleMessage(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    service,
  );
  assert.equal(initialized.result.serverInfo.name, "x-frame");
  assert.match(initialized.result.instructions, /X-Frame/);
  assert.match(initialized.result.instructions, /missing capability|leave MCP|raise it/i);
  assert.equal(initialized.result.instructions, INSTRUCTIONS);
  const listed = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, service);
  assert.equal(listed.result.tools.length, MCP_TOOL_NAMES.length);
  const called = await handleMessage(
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "xsxb_list_projects" } },
    service,
  );
  assert.equal(called.result.structuredContent.schemaVersion, 2);
  assert.deepEqual(called.result.structuredContent.data, { ok: true, value: 42 });
  assert.equal(called.result.isError, false);
});

test("stdio entrypoints stay alive and answer initialize", async () => {
  const repo = path.join(__dirname, "../..");
  const request = `${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  })}\n`;
  for (const rel of ["mcp/xsxb_mcp_server.js", "tools/xsxb_mcp_server.js"]) {
    const child = spawn(process.execPath, [path.join(repo, rel)], {
      cwd: repo,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    const closed = new Promise((resolve) => child.on("close", resolve));
    child.stdin.write(request);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve("ready"), 1500);
      child.stdout.once("data", () => {
        clearTimeout(timer);
        resolve("ready");
      });
      child.once("error", reject);
    });
    child.kill("SIGTERM");
    const code = await closed;
    assert.match(stdout, /"x-frame"/, `${rel} must answer initialize (exit ${code})`);
  }
});

test("stdio transport disposes its service when input closes", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let closeCalls = 0;
  const service = {
    tools: [],
    call: async () => ({}),
    close() {
      closeCalls += 1;
    },
  };
  const lines = startServer({ input, output, service });
  const closed = new Promise((resolve) => lines.once("close", resolve));
  input.end();
  await closed;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeCalls, 1);
});

test("instructions and shift_frames name last-pixel planting and a stale catalog", () => {
  const shift = toolDefinitions().find((entry) => entry.name === "xsxb_shift_frames");
  const plant = toolDefinitions().find((entry) => entry.name === "xsxb_plant_feet");
  assert.ok(shift, "xsxb_shift_frames is a catalog tool");
  assert.match(INSTRUCTIONS, /y=-1/);
  assert.match(INSTRUCTIONS, /not 0,0/);
  assert.match(shift.description, /stale/);
  assert.match(shift.description, /reload/i);
  assert.match(plant.description, /ignores connected bright slash/);
  assert.match(shift.description, /y=-1/);
  assert.match(shift.description, /never 0,0/);
  assert.match(INSTRUCTIONS, /do not OCR/i, "instructions must say not to OCR overlay digits");
  assert.match(INSTRUCTIONS, /xsxb_analyze/, "instructions must use one-pass analyze after import");
  assert.match(
    INSTRUCTIONS,
    /do not export_sheet every candidate|preview\.path/i,
    "instructions must not send agents through per-candidate sheets by default",
  );
  const sheet = toolDefinitions().find((entry) => entry.name === "xsxb_export_sheet");
  assert.match(sheet.description, /group cells/);
  assert.match(sheet.description, /grid=false/);
});

test("instructions and skill name session process: goal, todo, check after each step", () => {
  assert.match(INSTRUCTIONS, /one sentence|user goal/i, "instructions must start from the stated user goal");
  assert.match(INSTRUCTIONS, /\btodo\b/i, "instructions must require an ordered todo for multi-step work");
  assert.match(INSTRUCTIONS, /after each/i, "instructions must check after each mutating step");
  assert.match(
    INSTRUCTIONS,
    /stop and fix|do not continue the playbook/i,
    "instructions must stop the playbook when the eye fails",
  );
  const skill = fs.readFileSync(path.join(__dirname, "../../skills/xsxb-frame-tuner/SKILL.md"), "utf8");
  assert.match(skill, /MCP 工程流程/);
  assert.match(skill, /\btodo\b/i);
  assert.match(skill, /preview\.path/);
});

test("instructions and cutout/sheet name black plates and magenta look previews", () => {
  const cutout = toolDefinitions().find((entry) => entry.name === "xsxb_cutout");
  const sheet = toolDefinitions().find((entry) => entry.name === "xsxb_export_sheet");
  assert.match(
    INSTRUCTIONS,
    /white or black|black or white|white\/black|black\/white|black plates/i,
    "instructions must name generated black plates, not only white",
  );
  assert.match(cutout.description, /preview\.path/, "xsxb_cutout must send the eye to preview.path");
  assert.match(cutout.description, /magenta/i, "xsxb_cutout preview is a magenta flatten");
  assert.match(cutout.description, /black/i, "xsxb_cutout must name generated black plates");
  assert.match(sheet.description, /grid=false/);
  assert.match(sheet.description, /normalize=none\|feet preserves scale/);
});

test("concise tools retain routing constraints and workflow docs retain the crescent playbook", () => {
  const trail = toolDefinitions().find((entry) => entry.name === "xsxb_add_attack_trail");
  const place = toolDefinitions().find((entry) => entry.name === "xsxb_place_image");
  const cutout = toolDefinitions().find((entry) => entry.name === "xsxb_cutout");
  const gif = toolDefinitions().find((entry) => entry.name === "xsxb_export_gif");
  const sheet = toolDefinitions().find((entry) => entry.name === "xsxb_export_sheet");
  assert.ok(trail && place && cutout && gif && sheet);
  assert.match(trail.description, /smooth_arc only for truly curved motion/);
  assert.match(trail.description, /pixel-layer crescents belong to place_image/);
  assert.match(place.description, /require overlay_id/);
  assert.match(place.description, /xsxb_plan_place/);
  assert.match(place.description, /output_path stays inside XSXB root/);
  assert.match(cutout.description, /protected_colors/, "xsxb_cutout must protect smear colors");
  assert.equal(cutout.inputSchema.properties.protected_colors.type, "array");
  assert.equal(cutout.inputSchema.properties.protected_colors.items.type, "string");
  assert.match(gif.description, /export_sheet|sheet/, "xsxb_export_gif must send crescent QA to a sheet");
  assert.match(sheet.description, /grid=false/);
  const skillRoot = path.join(__dirname, "../../skills/xsxb-frame-tuner");
  const skill = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
  const workflows = fs.readFileSync(path.join(skillRoot, "references/media-and-tuning-workflows.md"), "utf8");
  for (const [label, text] of [
    ["SKILL.md", skill],
    ["media-and-tuning-workflows.md", workflows],
  ]) {
    assert.match(text, /月牙/, `${label} must name 月牙`);
    assert.match(text, /像素层/, `${label} must name 像素层`);
    assert.match(text, /7字/, `${label} must name the 7字 failure`);
    assert.match(text, /xsxb_add_attack_trail/, `${label} must name when not to use the mesh`);
    assert.match(
      text,
      /do not hardcode red|sample.*color|smear color/i,
      `${label} must keep smear color generic`,
    );
    assert.match(text, /上挑/, `${label} must still name 上挑 as something you can read from frames`);
    assert.match(
      text,
      /trace the striking-mass|trace.{0,60}striking-mass/i,
      `${label} must read the smear arc from this clip's weapon motion`,
    );
    assert.doesNotMatch(text, /Generate a red hollow/, `${label} must not prescribe a red VFX`);
    assert.doesNotMatch(
      text,
      /high→forward→down|chop bows high/i,
      `${label} must not ship a canned chop/挑 arc recipe`,
    );
    assert.match(
      text,
      /start and end cells|lock per-frame start/i,
      `${label} must lock smear start/end cells before painting`,
    );
    assert.match(
      text,
      /do not pin the head on the striking/i,
      `${label} must not pin the smear head on the weapon`,
    );
    assert.match(
      text,
      /xsxb_plan_smear/,
      `${label} must compile a clip-specific smear brief before painting`,
    );
    assert.match(text, /skeleton/, `${label} must treat the generic playbook as a skeleton`);
    assert.doesNotMatch(text, /one gap off/, `${label} must not tell the agent to skip a full grid cell`);
    assert.doesNotMatch(text, /head at the current striking mass/, `${label} must not pin onto the cup`);
    assert.match(text, /crescent-trail-v4/, `${label} must cite the validated smear reference`);
  }
});

test("a failing tool answers with an MCP error result instead of a transport error", async () => {
  const service = {
    tools: toolDefinitions(),
    call: async () => {
      const error = new Error("Animation not found: ghost");
      error.code = "xsxb_missing_animation";
      throw error;
    },
  };

  const called = await handleMessage(
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "xsxb_get_animation" } },
    service,
  );

  assert.equal(called.error, undefined, "a tool failure is not a JSON-RPC error");
  assert.equal(called.result.isError, true);
  assert.equal(called.result.structuredContent.ok, false);
  assert.equal(called.result.structuredContent.error.message, "Animation not found: ghost");
  assert.equal(called.result.structuredContent.error.code, "xsxb_missing_animation");
  assert.match(called.result.content[0].text, /xsxb_missing_animation/u);
});

test("unknown methods and malformed requests answer with JSON-RPC errors", async () => {
  const service = { tools: toolDefinitions(), call: async () => ({ ok: true }) };

  const unknown = await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/destroy" }, service);
  assert.equal(unknown.error.code, -32601);
  assert.match(unknown.error.message, /tools\/destroy/u);
  assert.equal(unknown.id, 1);

  const methodless = await handleMessage({ jsonrpc: "2.0", id: 2 }, service);
  assert.equal(methodless.error.code, -32600);

  const unknownTool = await handleMessage(
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "xsxb_nope" } },
    { tools: [], call: createXsxbMcpService().call },
  );
  assert.equal(unknownTool.result.isError, true);
  assert.match(unknownTool.result.structuredContent.error.message, /Unknown XSXB MCP tool/u);
});

test("notifications are executed without a response", async () => {
  const service = { tools: toolDefinitions(), call: async () => ({ ok: true }) };

  assert.equal(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, service), null);
  assert.equal(await handleMessage({ jsonrpc: "2.0", method: "ping" }, service), null);
});

test("STDIO transport answers unparsable lines and keeps serving the next request", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => {
    text += chunk.toString();
  });
  const lines = startServer({
    input,
    output,
    service: { tools: toolDefinitions(), call: async () => ({ projects: [] }) },
  });

  input.write("{ not json at all\n");
  input.write("   \n");
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  lines.close();

  const responses = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(responses.length, 2, "blank lines and notifications produce no response");
  assert.equal(responses[0].error.code, -32700);
  assert.match(responses[0].error.message, /Parse error/u);
  assert.equal(responses[1].id, 9, "the transport keeps serving after a parse error");
  assert.deepEqual(responses[1].result, {});
});

test("STDIO transport answers ping without waiting behind a queued business call", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => {
    text += chunk.toString();
  });
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const lines = startServer({
    input,
    output,
    service: {
      tools: toolDefinitions(),
      call: async () => {
        await blocked;
        return { ok: true };
      },
    },
  });

  input.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "xsxb_list_projects", arguments: {} },
    })}\n`,
  );
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(text.trim()), { jsonrpc: "2.0", id: 2, result: {} });

  release();
  await new Promise((resolve) => setImmediate(resolve));
  lines.close();
});

test("STDIO server accepts newline-delimited JSON-RPC", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => {
    text += chunk.toString();
  });
  const lines = startServer({
    input,
    output,
    service: { tools: toolDefinitions(), call: async () => ({ projects: [] }) },
  });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  lines.close();
  const response = JSON.parse(text.trim());
  assert.equal(response.id, 1);
  assert.equal(response.result.tools.length, MCP_TOOL_NAMES.length);
});

test("the dispatcher rejects arguments the declared schema does not allow", async () => {
  const current = fixture();
  try {
    // A misspelled argument used to be dropped, so the tool ran with its
    // defaults and reported success for work the caller never requested.
    await assert.rejects(
      () => current.service.call("xsxb_get_animation", { animaton_id: "idle" }),
      /unknown argument "animaton_id".*animation_id/su,
    );
    await assert.rejects(
      () => current.service.call("xsxb_validate_project", { layer: "gamplay" }),
      /"layer" must be one of/u,
    );
    const error = await current.service
      .call("xsxb_get_animation", { animaton_id: "idle" })
      .catch((reason) => reason);
    assert.equal(error.code, "xsxb_invalid_arguments");
  } finally {
    current.cleanup();
  }
});

test("GIF export allows an absolute path outside the root and still rejects relative escapes", async () => {
  const outside = path.join(os.tmpdir(), `xsxb-escape-${process.pid}.gif`);
  const current = fixture({
    encodeGifImpl: async (job) => {
      fs.mkdirSync(path.dirname(job.outputPath), { recursive: true });
      fs.writeFileSync(job.outputPath, Buffer.from("GIF89a"));
    },
  });
  try {
    const sequenceDir = path.join(current.root, "seq");
    fs.mkdirSync(sequenceDir, { recursive: true });
    fs.writeFileSync(path.join(sequenceDir, "a.png"), ONE_PIXEL_PNG);
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: sequenceDir,
      animation_id: "walk",
    });

    const exported = await current.service.call("xsxb_export_gif", {
      animation_id: "walk",
      output_path: outside,
    });
    assert.equal(exported.outputPath, outside);
    assert.equal(fs.existsSync(outside), true);
    await assert.rejects(
      () =>
        current.service.call("xsxb_export_gif", {
          animation_id: "walk",
          output_path: "../../../../../../../../../../../../escape.gif",
        }),
      /must stay inside the XSXB workspace root/u,
    );
  } finally {
    fs.rmSync(outside, { force: true });
    current.cleanup();
  }
});

test("oversized agent-supplied files are refused before they are read", async () => {
  const current = fixture();
  try {
    const sequenceDir = path.join(current.root, "seq");
    fs.mkdirSync(sequenceDir, { recursive: true });
    fs.writeFileSync(path.join(sequenceDir, "a.png"), ONE_PIXEL_PNG);
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: sequenceDir,
      animation_id: "walk",
    });
    // Sparse file: the size guard must reject on the stat, never by reading it.
    const huge = path.join(current.root, "huge.png");
    const handle = fs.openSync(huge, "w");
    fs.ftruncateSync(handle, 600 * 1024 * 1024);
    fs.closeSync(handle);

    await assert.rejects(
      () => current.service.call("xsxb_add_attachment", { animation_id: "walk", file_path: huge }),
      /too large/iu,
    );
  } finally {
    current.cleanup();
  }
});

test("XSXB MCP service executes the complete mutation workflow", async () => {
  const current = fixture();
  try {
    const projects = await current.service.call("xsxb_list_projects");
    assert.equal(projects.count, 1);
    assert.equal(projects.projects[0].godotProjectValid, true);

    const imported = await current.service.call("xsxb_import_video", {
      file_path: current.video,
      fps: 12,
      sync: true,
      validate: true,
    });
    assert.equal(imported.importedFrameCount, 3);
    assert.equal(imported.sync.ok, true);
    assert.equal(imported.validation.ok, true, imported.validation.errors.join("\n"));

    const animation = await current.service.call("xsxb_get_animation");
    assert.equal(animation.frameCount, 3);
    assert.equal(animation.generatedFrameCount, 3);
    assert.equal(animation.allFramesGenerated, true);

    const trail = await current.service.call("xsxb_add_attack_trail", { sync: true });
    assert.equal(trail.segment.sticks.length, 2);
    assert.equal(trail.sync.ok, true);

    const spark = path.join(current.root, "spark.png");
    fs.writeFileSync(spark, ONE_PIXEL_PNG);
    const attachment = await current.service.call("xsxb_add_attachment", { file_path: spark, sync: true });
    assert.equal(attachment.binding.key, "mcp_imports/source:0");
    assert.equal(attachment.sync.imageAttachmentCount, 1);

    const hit = path.join(current.root, "hit.wav");
    fs.writeFileSync(hit, createTestWav());
    const sfx = await current.service.call("xsxb_add_sfx", { file_path: hit, sync: true });
    assert.equal(sfx.binding.type, "audio/wav");
    assert.equal(sfx.sync.audioCount, 1);

    const reorganized = await current.service.call("xsxb_reorganize_frames", { dry_run: false });
    assert.equal(reorganized.dryRun, true);
    assert.equal(reorganized.applied, false);
    assert.equal(reorganized.outputFrameCount, 3);
    assert.equal(reorganized.identityOrder, true);

    const validation = await current.service.call("xsxb_validate_project");
    assert.equal(validation.ok, true, validation.errors.join("\n"));
    assert.equal(validation.summary.frames, 3);
    assert.equal(validation.summary.frameAudioBindings, 1);
    assert.equal(validation.summary.frameImageAttachments, 1);
    assert.equal(validation.summary.attackTrailSegments, 1);
  } finally {
    current.cleanup();
  }
});

test("generated MCP test WAV has a valid PCM RIFF header", () => {
  const wav = createTestWav();
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.length, wav.readUInt32LE(4) + 8);
});

test("MCP catalog includes the production editing tools", () => {
  for (const name of [
    "xsxb_import_animation",
    "xsxb_find_loop",
    "xsxb_find_duplicates",
    "xsxb_find_motion",
    "xsxb_analyze",
    "xsxb_estimate_visual",
    "xsxb_export_sheet",
    "xsxb_shift_frames",
    "xsxb_measure_image",
    "xsxb_overlay_grid",
    "xsxb_plan_place",
    "xsxb_place_image",
    "xsxb_plan_smear",
    "xsxb_update_frame_boxes",
    "xsxb_update_timing",
    "xsxb_sync_godot",
    "xsxb_validate_for_godot",
    "xsxb_diff_frames",
    "xsxb_get_project",
    "xsxb_create_project",
    "xsxb_delete_animation",
  ]) {
    assert.ok(MCP_TOOL_NAMES.includes(name), name);
  }
  assert.ok(MCP_TOOL_NAMES.includes("xsxb_import_video"));
  assert.equal(MCP_TOOL_NAMES[MCP_TOOL_NAMES.indexOf("xsxb_get_project") + 1], "xsxb_create_project");
});

test("XSXB MCP service completes the production editing loop", async () => {
  const current = fixture();
  try {
    const sequenceDir = path.join(current.root, "png-sequence");
    fs.mkdirSync(sequenceDir, { recursive: true });
    fs.writeFileSync(path.join(sequenceDir, "walk_02.png"), ONE_PIXEL_PNG);
    fs.writeFileSync(path.join(sequenceDir, "walk_01.png"), ONE_PIXEL_PNG);

    const imported = await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: sequenceDir,
      animation_id: "walk",
      fps: 10,
    });
    assert.equal(imported.source, "png_sequence");
    assert.equal(imported.importedFrameCount, 2);
    assert.equal(imported.animationId, "walk");
    assert.equal(imported.sync.requested, false);

    const videoAlias = await current.service.call("xsxb_import_animation", {
      source: "video",
      file_path: current.video,
      animation_id: "clip",
      fps: 12,
    });
    assert.equal(videoAlias.source, "video");
    assert.equal(videoAlias.importedFrameCount, 3);

    const spriteDir = path.join(current.godotRoot, "sprites");
    fs.mkdirSync(spriteDir, { recursive: true });
    fs.writeFileSync(path.join(spriteDir, "idle.png"), ONE_PIXEL_PNG);
    const tresPath = path.join(spriteDir, "hero.spriteframes.tres");
    fs.writeFileSync(
      tresPath,
      `[ext_resource type="Texture2D" path="res://sprites/idle.png" id="1_tex"]

[resource]
animations = [{
"frames": [{
"duration": 1.0,
"texture": ExtResource("1_tex")
}],
"loop": true,
"name": &"idle",
"speed": 8.0
}]
`,
    );
    const spriteImported = await current.service.call("xsxb_import_animation", {
      source: "spriteframes",
      file_path: tresPath,
    });
    assert.equal(spriteImported.source, "spriteframes");
    assert.ok(spriteImported.importedFrameCount >= 1);

    const boxes = await current.service.call("xsxb_update_frame_boxes", {
      animation_id: "walk",
      frame: 0,
      hurtbox: { enabled: true, offset: { x: 1, y: -8 }, size: { x: 16, y: 16 } },
      collisionbox: { enabled: true, size: { x: 12, y: 20 } },
      hitbox: { enabled: false, offset: { x: 4, y: -4 }, size: { x: 8, y: 8 } },
    });
    assert.equal(boxes.frame, 0);
    assert.equal(boxes.boxes.hurtbox.size.x, 16);
    assert.equal(boxes.boxes.collisionbox.offset.y, -10);
    assert.equal(boxes.sync.requested, false);

    const timing = await current.service.call("xsxb_update_timing", {
      animation_id: "walk",
      fps: 8,
      frame: 1,
      duration_ms: 250,
      disabled: false,
    });
    assert.equal(timing.fps, 8);
    assert.equal(timing.playback.durationMs, 250);
    assert.equal(timing.sync.requested, false);

    const project = await current.service.call("xsxb_get_project");
    assert.equal(project.projectId, "mcp-test");
    assert.equal(project.godotProjectValid, true);
    assert.ok(project.animations.some((entry) => entry.id === "walk" && entry.frameCount === 2));
    assert.ok(project.animations.some((entry) => entry.id === "clip"));

    const preview = await current.service.call("xsxb_delete_animation", {
      animation_id: "clip",
      dry_run: true,
    });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.deleted, false);
    assert.equal(preview.removedFrames, 3);
    const stillThere = await current.service.call("xsxb_get_animation", { animation_id: "clip" });
    assert.equal(stillThere.frameCount, 3);

    const removed = await current.service.call("xsxb_delete_animation", { animation_id: "clip" });
    assert.equal(removed.deleted, true);
    assert.equal(removed.removedFrames, 3);
    await assert.rejects(
      () => current.service.call("xsxb_get_animation", { animation_id: "clip" }),
      /not found/i,
    );

    const synced = await current.service.call("xsxb_sync_godot");
    assert.equal(synced.ok, true);
    assert.equal(synced.requested, true);
    const afterSync = await current.service.call("xsxb_get_project");
    assert.equal(afterSync.animationCount, project.animationCount - 1);
  } finally {
    current.cleanup();
  }
});

/**
 * Writes a two-clip Godot SpriteFrames tres plus idle/walk PNGs.
 * @param {string} godotRoot Bound Godot project root.
 * @param {Buffer} idlePng Idle frame bytes.
 * @param {Buffer} walkPng Walk frame bytes.
 * @returns {string} Absolute path to hero.spriteframes.tres.
 */
function writeTwoClipSpriteFrames(godotRoot, idlePng, walkPng) {
  const spriteDir = path.join(godotRoot, "sprites");
  fs.mkdirSync(spriteDir, { recursive: true });
  fs.writeFileSync(path.join(spriteDir, "idle.png"), idlePng);
  fs.writeFileSync(path.join(spriteDir, "walk.png"), walkPng);
  const tresPath = path.join(spriteDir, "hero.spriteframes.tres");
  fs.writeFileSync(
    tresPath,
    `[ext_resource type="Texture2D" path="res://sprites/idle.png" id="1_tex"]
[ext_resource type="Texture2D" path="res://sprites/walk.png" id="2_tex"]

[resource]
animations = [{
"frames": [{
"duration": 1.0,
"texture": ExtResource("1_tex")
}],
"loop": true,
"name": &"idle",
"speed": 8.0
}, {
"frames": [{
"duration": 1.0,
"texture": ExtResource("2_tex")
}],
"loop": true,
"name": &"walk",
"speed": 10.0
}]
`,
  );
  return tresPath;
}

test("import_spriteframes_animation_id_selects_one_clip_not_renames_every_row", async () => {
  const idleColor = [210, 36, 42, 255];
  const walkColor = [32, 80, 200, 255];
  const idlePng = encodePngRgba(new Uint8ClampedArray(idleColor), 1, 1);
  const walkPng = encodePngRgba(new Uint8ClampedArray(walkColor), 1, 1);

  const current = fixture();
  try {
    const tresPath = writeTwoClipSpriteFrames(current.godotRoot, idlePng, walkPng);
    const imported = await current.service.call("xsxb_import_animation", {
      source: "spriteframes",
      file_path: tresPath,
      animation_id: "walk",
    });
    assert.equal(imported.importedAnimationCount, 1);
    assert.equal(imported.animationId, "walk");
    assert.deepEqual(
      imported.animations.map((entry) => entry.animationId),
      ["walk"],
    );

    const walk = await current.service.call("xsxb_get_animation", { animation_id: "walk" });
    const pixels = decodePngRgba(walk.animation.frames[0].absolutePath).data;
    assert.equal(pixels[0], walkColor[0]);
    assert.equal(pixels[1], walkColor[1]);
    assert.equal(pixels[2], walkColor[2]);

    const project = await current.service.call("xsxb_get_project");
    assert.ok(!project.animations.some((entry) => entry.id === "walk_2"));
    assert.ok(!project.animations.some((entry) => entry.id === "idle"));
    await assert.rejects(
      () => current.service.call("xsxb_get_animation", { animation_id: "idle" }),
      /not found/i,
    );
    await assert.rejects(
      () => current.service.call("xsxb_get_animation", { animation_id: "walk_2" }),
      /not found/i,
    );
  } finally {
    current.cleanup();
  }

  const omitted = fixture();
  try {
    const tresPath = writeTwoClipSpriteFrames(omitted.godotRoot, idlePng, walkPng);
    const imported = await omitted.service.call("xsxb_import_animation", {
      source: "spriteframes",
      file_path: tresPath,
    });
    assert.equal(imported.importedAnimationCount, 2);
    assert.deepEqual(imported.animations.map((entry) => entry.animationId).sort(), ["idle", "walk"]);
    const idle = await omitted.service.call("xsxb_get_animation", { animation_id: "idle" });
    const walk = await omitted.service.call("xsxb_get_animation", { animation_id: "walk" });
    const idlePixels = decodePngRgba(idle.animation.frames[0].absolutePath).data;
    const walkPixels = decodePngRgba(walk.animation.frames[0].absolutePath).data;
    assert.equal(idlePixels[0], idleColor[0]);
    assert.equal(walkPixels[0], walkColor[0]);
    await assert.rejects(
      () =>
        omitted.service.call("xsxb_import_animation", {
          source: "spriteframes",
          file_path: tresPath,
          animation_id: "jump",
        }),
      /jump|available|idle|walk/i,
    );
  } finally {
    omitted.cleanup();
  }
});

test("MCP catalog exposes bind, cutout, and active tools without open_tuner", () => {
  for (const name of ["xsxb_bind_godot", "xsxb_cutout", "xsxb_set_active_project"]) {
    assert.ok(MCP_TOOL_NAMES.includes(name), name);
  }
  assert.equal(MCP_TOOL_NAMES.includes("xsxb_open_tuner"), false);
});

test("sync keeps the requested project and reports the missing Godot bind", async () => {
  const current = fixture();
  try {
    const store = createProjectStore(current.root);
    store.addProject({ id: "orphan", label: "Orphan", projectRoot: "" });
    await assert.rejects(
      () => current.service.call("xsxb_sync_godot", { project_id: "orphan" }),
      /orphan[\s\S]*does not exist/i,
    );
  } finally {
    current.cleanup();
  }
});

test("bind_godot retargets a project to an existing Godot root", async () => {
  const current = fixture();
  try {
    const store = createProjectStore(current.root);
    store.addProject({ id: "orphan", label: "Orphan", projectRoot: "" });
    const bound = await current.service.call("xsxb_bind_godot", {
      project_id: "orphan",
      project_root: current.godotRoot,
    });
    assert.equal(bound.projectId, "orphan");
    assert.equal(bound.godotProjectValid, true);
    assert.equal(path.resolve(bound.projectRoot), path.resolve(current.godotRoot));
  } finally {
    current.cleanup();
  }
});

test("bind_godot retarget prunes previous Godot project slices", async () => {
  const current = fixture();
  try {
    const clipDir = path.join(current.root, "idle-sequence");
    fs.mkdirSync(clipDir, { recursive: true });
    fs.writeFileSync(path.join(clipDir, "idle_01.png"), ONE_PIXEL_PNG);
    const imported = await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: clipDir,
      animation_id: "idle",
      fps: 8,
      sync: true,
    });
    assert.equal(imported.importedFrameCount, 1);
    assert.equal(imported.sync.ok, true);

    const oldDataDir = path.join(current.godotRoot, "xsxb_frame_tuner", "data", "projects", "mcp-test");
    const oldWorkspaceDir = path.join(
      current.godotRoot,
      "xsxb_frame_tuner",
      "workspace",
      "projects",
      "mcp-test",
    );
    assert.equal(fs.existsSync(oldDataDir), true);
    const workspaceExisted = fs.existsSync(oldWorkspaceDir);

    const leftoverRuntime = path.join(
      current.godotRoot,
      "xsxb_frame_tuner",
      "runtime",
      "xsxb_frame_actor.tscn",
    );
    fs.mkdirSync(path.dirname(leftoverRuntime), { recursive: true });
    fs.writeFileSync(leftoverRuntime, "[gd_scene leftover]\n");

    const secondRoot = path.join(current.root, "godot-second");
    fs.mkdirSync(secondRoot, { recursive: true });
    fs.writeFileSync(path.join(secondRoot, "project.godot"), '[application]\nconfig/name="Second"\n');

    const bound = await current.service.call("xsxb_bind_godot", {
      project_id: "mcp-test",
      project_root: secondRoot,
    });
    assert.equal(bound.projectId, "mcp-test");
    assert.equal(path.resolve(bound.projectRoot), path.resolve(secondRoot));
    assert.equal(fs.existsSync(oldDataDir), false, "retarget must drop previous data/projects/<id>");
    if (workspaceExisted) {
      assert.equal(
        fs.existsSync(oldWorkspaceDir),
        false,
        "retarget must drop previous workspace/projects/<id>",
      );
    }
    assert.equal(
      fs.existsSync(path.join(secondRoot, "xsxb_frame_tuner", "data", "projects", "mcp-test")),
      false,
      "bind_godot must not sync slices into the new Godot root",
    );
    await current.service.call("xsxb_bind_godot", {
      project_id: "mcp-test",
      project_root: secondRoot,
    });
    assert.equal(fs.existsSync(leftoverRuntime), true, "shared runtime under the old root must stay");
  } finally {
    current.cleanup();
  }
});

test("bind_godot retarget forgets stale Godot imported ctex from pruned slices", async () => {
  const current = fixture();
  try {
    const clipDir = path.join(current.root, "idle-sequence");
    fs.mkdirSync(clipDir, { recursive: true });
    fs.writeFileSync(path.join(clipDir, "idle_01.png"), ONE_PIXEL_PNG);
    const imported = await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: clipDir,
      animation_id: "idle",
      fps: 8,
      sync: true,
    });
    assert.equal(imported.importedFrameCount, 1);
    assert.equal(imported.sync.ok, true);

    const spark = path.join(current.root, "spark.png");
    fs.writeFileSync(spark, ONE_PIXEL_PNG);
    const added = await current.service.call("xsxb_add_attachment", {
      animation_id: "idle",
      file_path: spark,
      id: "spark",
      frame: 0,
      sync: true,
    });
    assert.equal(added.sync.ok, true);
    assert.equal(added.sync.imageAttachmentCount, 1);

    const attachmentDir = path.join(
      current.godotRoot,
      "xsxb_frame_tuner",
      "attachments",
      "projects",
      "mcp-test",
    );
    const pngs = fs.existsSync(attachmentDir)
      ? fs.readdirSync(attachmentDir).filter((name) => /\.png$/i.test(name))
      : [];
    assert.ok(pngs.length >= 1, "add_attachment+sync must copy a hash PNG into Godot attachments");
    const hashPath = path.join(attachmentDir, pngs[0]);
    const stem = path.basename(hashPath, path.extname(hashPath));
    const importedDir = path.join(current.godotRoot, ".godot", "imported");
    fs.mkdirSync(importedDir, { recursive: true });
    fs.writeFileSync(`${hashPath}.import`, `path="res://.godot/imported/${stem}.ctex"\n`);
    fs.writeFileSync(path.join(importedDir, `${stem}.ctex`), "stale-ctex");
    fs.writeFileSync(path.join(importedDir, `${stem}.md5`), "stale-ctex");

    const leftoverRuntime = path.join(
      current.godotRoot,
      "xsxb_frame_tuner",
      "runtime",
      "xsxb_frame_actor.tscn",
    );
    fs.mkdirSync(path.dirname(leftoverRuntime), { recursive: true });
    fs.writeFileSync(leftoverRuntime, "[gd_scene leftover]\n");

    const oldDataDir = path.join(current.godotRoot, "xsxb_frame_tuner", "data", "projects", "mcp-test");
    assert.equal(fs.existsSync(oldDataDir), true);

    const secondRoot = path.join(current.root, "godot-second");
    fs.mkdirSync(secondRoot, { recursive: true });
    fs.writeFileSync(path.join(secondRoot, "project.godot"), '[application]\nconfig/name="Second"\n');

    const bound = await current.service.call("xsxb_bind_godot", {
      project_id: "mcp-test",
      project_root: secondRoot,
    });
    assert.equal(bound.projectId, "mcp-test");
    assert.equal(path.resolve(bound.projectRoot), path.resolve(secondRoot));
    assert.equal(fs.existsSync(hashPath), false, "retarget must drop previous attachment hash PNG");
    assert.equal(
      fs.existsSync(path.join(importedDir, `${stem}.ctex`)),
      false,
      `pruned ${stem}.ctex must be forgotten from .godot/imported`,
    );
    assert.equal(
      fs.existsSync(path.join(importedDir, `${stem}.md5`)),
      false,
      `pruned ${stem}.md5 must be forgotten from .godot/imported`,
    );
    assert.equal(fs.existsSync(leftoverRuntime), true, "shared runtime under the old root must stay");
    assert.equal(fs.existsSync(oldDataDir), false, "retarget must drop previous data/projects/<id>");
  } finally {
    current.cleanup();
  }
});

test("bind_godot retarget forgets stale Godot imported sample from pruned audio slices", async () => {
  const current = fixture();
  try {
    const clipDir = path.join(current.root, "idle-sequence");
    fs.mkdirSync(clipDir, { recursive: true });
    fs.writeFileSync(path.join(clipDir, "idle_01.png"), ONE_PIXEL_PNG);
    const imported = await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: clipDir,
      animation_id: "idle",
      fps: 8,
      sync: true,
    });
    assert.equal(imported.importedFrameCount, 1);
    assert.equal(imported.sync.ok, true);

    const hit = path.join(current.root, "hit.wav");
    fs.writeFileSync(hit, createTestWav());
    const added = await current.service.call("xsxb_add_sfx", {
      animation_id: "idle",
      file_path: hit,
      id: "hit",
      sync: true,
    });
    assert.equal(added.sync.ok, true);

    const audioDir = path.join(current.godotRoot, "xsxb_frame_tuner", "audio", "projects", "mcp-test");
    const wavs = [];
    const walkWavs = (directory) => {
      if (!fs.existsSync(directory)) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) walkWavs(fullPath);
        else if (/\.wav$/i.test(entry.name)) wavs.push(fullPath);
      }
    };
    walkWavs(audioDir);
    assert.ok(wavs.length >= 1, "add_sfx+sync must copy a WAV into Godot audio/projects");
    const wavPath = wavs[0];
    const stem = path.basename(wavPath, path.extname(wavPath));
    const importedDir = path.join(current.godotRoot, ".godot", "imported");
    fs.mkdirSync(importedDir, { recursive: true });
    fs.writeFileSync(`${wavPath}.import`, `path="res://.godot/imported/${stem}.sample"\n`);
    fs.writeFileSync(path.join(importedDir, `${stem}.sample`), "stale-sample");
    fs.writeFileSync(path.join(importedDir, `${stem}.md5`), "stale-sample");

    const leftoverRuntime = path.join(
      current.godotRoot,
      "xsxb_frame_tuner",
      "runtime",
      "xsxb_frame_actor.tscn",
    );
    fs.mkdirSync(path.dirname(leftoverRuntime), { recursive: true });
    fs.writeFileSync(leftoverRuntime, "[gd_scene leftover]\n");

    const oldDataDir = path.join(current.godotRoot, "xsxb_frame_tuner", "data", "projects", "mcp-test");
    assert.equal(fs.existsSync(oldDataDir), true);

    const secondRoot = path.join(current.root, "godot-second");
    fs.mkdirSync(secondRoot, { recursive: true });
    fs.writeFileSync(path.join(secondRoot, "project.godot"), '[application]\nconfig/name="Second"\n');

    const bound = await current.service.call("xsxb_bind_godot", {
      project_id: "mcp-test",
      project_root: secondRoot,
    });
    assert.equal(bound.projectId, "mcp-test");
    assert.equal(path.resolve(bound.projectRoot), path.resolve(secondRoot));
    assert.equal(fs.existsSync(wavPath), false, "retarget must drop previous audio WAV");
    assert.equal(
      fs.existsSync(path.join(importedDir, `${stem}.sample`)),
      false,
      `pruned ${stem}.sample must be forgotten from .godot/imported`,
    );
    assert.equal(
      fs.existsSync(path.join(importedDir, `${stem}.md5`)),
      false,
      `pruned ${stem}.md5 must be forgotten from .godot/imported`,
    );
    assert.equal(fs.existsSync(leftoverRuntime), true, "shared runtime under the old root must stay");
    assert.equal(fs.existsSync(oldDataDir), false, "retarget must drop previous data/projects/<id>");
  } finally {
    current.cleanup();
  }
});

test("xsxb_create_project adds a registry project without changing list/get/set_active shapes", async () => {
  const current = fixture();
  try {
    const created = await current.service.call("xsxb_create_project", {
      project_id: "warrior",
      label: "Warrior",
    });
    assert.equal(created.created, true);
    assert.equal(created.projectId, "warrior");
    assert.equal(created.project.id, "warrior");
    assert.equal(created.project.label, "Warrior");
    const listed = await current.service.call("xsxb_list_projects");
    assert.equal(listed.activeProjectId, "warrior");
    assert.ok(listed.projects.some((entry) => entry.id === "warrior"));
    const snapshot = await current.service.call("xsxb_get_project", { project_id: "warrior" });
    assert.equal(snapshot.projectId, "warrior");
    const again = await current.service.call("xsxb_create_project", { project_id: "warrior" });
    assert.equal(again.created, false);
    assert.equal(again.projectId, "warrior");
    const createSchema = toolDefinitions().find((entry) => entry.name === "xsxb_create_project");
    const listSchema = toolDefinitions().find((entry) => entry.name === "xsxb_list_projects");
    const getSchema = toolDefinitions().find((entry) => entry.name === "xsxb_get_project");
    const setSchema = toolDefinitions().find((entry) => entry.name === "xsxb_set_active_project");
    assert.ok(!createSchema.inputSchema.required || createSchema.inputSchema.required.length === 0);
    assert.ok(!listSchema.inputSchema.required || listSchema.inputSchema.required.length === 0);
    assert.ok(!getSchema.inputSchema.required || !getSchema.inputSchema.required.includes("project_id"));
    assert.deepEqual(setSchema.inputSchema.required, ["project_id"]);
  } finally {
    current.cleanup();
  }
});

test("xsxb_create_project with project_root stores files under that directory's .x-frame folder", async () => {
  const current = fixture();
  try {
    const game = path.join(current.root, "game");
    fs.mkdirSync(game, { recursive: true });
    fs.writeFileSync(path.join(game, "project.godot"), '[application]\nconfig/name="Hero"\n');
    const created = await current.service.call("xsxb_create_project", {
      project_id: "hero",
      label: "Hero",
      project_root: game,
    });
    const frameRoot = path.join(game, ".x-frame");
    assert.equal(created.created, true);
    assert.ok(created.project.dataPath.startsWith(frameRoot));
    assert.ok(created.project.workspacePath.startsWith(frameRoot));
    assert.equal(
      fs.existsSync(path.join(frameRoot, "data", "projects", "hero", "animation_manifest.json")),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(current.root, "data", "projects", "hero", "animation_manifest.json")),
      false,
    );
  } finally {
    current.cleanup();
  }
});

test("xsxb_bind_godot preserves the existing authoring directory", async () => {
  const current = fixture();
  try {
    await current.service.call("xsxb_create_project", {
      project_id: "orphan",
      label: "Orphan",
    });
    const bound = await current.service.call("xsxb_bind_godot", {
      project_id: "orphan",
      project_root: current.godotRoot,
    });
    const frameRoot = path.join(current.root, ".x-frame");
    assert.equal(path.resolve(bound.projectRoot), path.resolve(current.godotRoot));
    const snapshot = await current.service.call("xsxb_get_project", { project_id: "orphan" });
    assert.ok(snapshot.dataPath.startsWith(frameRoot));
    assert.equal(
      fs.existsSync(path.join(frameRoot, "data", "projects", "orphan", "animation_manifest.json")),
      true,
    );
  } finally {
    current.cleanup();
  }
});

test("xsxb_create_project without project_root stores under the current host .x-frame directory", async () => {
  const current = fixture();
  try {
    const created = await current.service.call("xsxb_create_project", {
      project_id: "notes",
      label: "Notes",
    });
    const frameRoot = path.join(current.root, ".x-frame");
    assert.equal(created.created, true);
    assert.ok(created.project.dataPath.startsWith(frameRoot));
    assert.equal(
      fs.existsSync(path.join(frameRoot, "data", "projects", "notes", "animation_manifest.json")),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(current.root, "data", "projects", "notes", "animation_manifest.json")),
      false,
    );
  } finally {
    current.cleanup();
  }
});

test("xsxb_create_project project_root can be any directory, not only a Godot project", async () => {
  const current = fixture();
  try {
    const folder = path.join(current.root, "art");
    fs.mkdirSync(folder, { recursive: true });
    const created = await current.service.call("xsxb_create_project", {
      project_id: "sheets",
      label: "Sheets",
      project_root: folder,
    });
    const frameRoot = path.join(folder, ".x-frame");
    assert.ok(created.project.dataPath.startsWith(frameRoot));
    assert.equal(
      fs.existsSync(path.join(frameRoot, "data", "projects", "sheets", "animation_manifest.json")),
      true,
    );
  } finally {
    current.cleanup();
  }
});

test("MCP without an explicit root stores in the current working directory .x-frame", async () => {
  const host = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-mcp-cwd-"));
  const previousCwd = process.cwd();
  const previousRoot = process.env.XSXB_ROOT;
  delete process.env.XSXB_ROOT;
  process.chdir(host);
  try {
    const service = createXsxbMcpService({});
    const created = await service.call("xsxb_create_project", {
      project_id: "local",
      label: "Local",
    });
    const frameRoot = fs.realpathSync(path.join(host, ".x-frame"));
    const dataPath = fs.realpathSync(created.project.dataPath);
    assert.ok(dataPath === frameRoot || dataPath.startsWith(`${frameRoot}${path.sep}`));
    assert.equal(
      fs.existsSync(path.join(frameRoot, "data", "projects", "local", "animation_manifest.json")),
      true,
    );
  } finally {
    process.chdir(previousCwd);
    if (previousRoot === undefined) delete process.env.XSXB_ROOT;
    else process.env.XSXB_ROOT = previousRoot;
    fs.rmSync(host, { recursive: true, force: true });
  }
});

test("import_video forwards optional start_time/duration and omits them for full-file extract", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-mcp-window-"));
  const godotRoot = path.join(root, "godot");
  fs.mkdirSync(godotRoot, { recursive: true });
  fs.writeFileSync(path.join(godotRoot, "project.godot"), '[application]\nconfig/name="Window"\n');
  createProjectStore(root).addProject({ id: "window", label: "Window", projectRoot: godotRoot });
  const video = path.join(root, "clip.mp4");
  fs.writeFileSync(video, "placeholder");
  const seen = [];
  const service = createXsxbMcpService({
    root,
    extractVideoFramesImpl: async (_videoPath, outputDirectory, options) => {
      seen.push(options);
      const framePath = path.join(outputDirectory, "frame_000001.png");
      fs.writeFileSync(framePath, ONE_PIXEL_PNG);
      return [framePath];
    },
  });
  try {
    await service.call("xsxb_import_video", {
      file_path: video,
      animation_id: "full",
      fps: "12",
    });
    await service.call("xsxb_import_video", {
      file_path: video,
      animation_id: "windowed",
      fps: "10",
      start_time: "1.6",
      duration: "0.8",
    });
    assert.equal(seen.length, 2);
    assert.equal(seen[0].start_time, undefined);
    assert.equal(seen[0].duration, undefined);
    assert.equal(seen[1].start_time, 1.6);
    assert.equal(seen[1].duration, 0.8);
    const fullArgs = videoExtractFfmpegArgs("/tmp/a.mp4", "/tmp/out/frame_%06d.png", {});
    assert.deepEqual(fullArgs, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "/tmp/a.mp4",
      "-map",
      "0:v:0",
      "-vsync",
      "0",
      "/tmp/out/frame_%06d.png",
    ]);
    const windowArgs = videoExtractFfmpegArgs("/tmp/a.mp4", "/tmp/out/frame_%06d.png", {
      start_time: "1.6",
      duration: "0.8",
    });
    assert.ok(windowArgs.includes("-ss"));
    assert.ok(windowArgs.includes("1.6"));
    assert.ok(windowArgs.includes("-t"));
    assert.ok(windowArgs.includes("0.8"));
    assert.ok(windowArgs.indexOf("-i") < windowArgs.indexOf("-ss"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("set_active_project and get_animation summary keep MCP context explicit", async () => {
  const current = fixture();
  try {
    const store = createProjectStore(current.root);
    store.addProject({ id: "other", label: "Other", projectRoot: "" });
    const activated = await current.service.call("xsxb_set_active_project", { project_id: "other" });
    assert.equal(activated.activeProjectId, "other");
    const listed = await current.service.call("xsxb_list_projects");
    assert.equal(listed.activeProjectId, "other");

    const sequenceDir = path.join(current.root, "png-sequence");
    fs.mkdirSync(sequenceDir, { recursive: true });
    fs.writeFileSync(path.join(sequenceDir, "a.png"), ONE_PIXEL_PNG);
    fs.writeFileSync(path.join(sequenceDir, "b.png"), ONE_PIXEL_PNG);
    await current.service.call("xsxb_set_active_project", { project_id: "mcp-test" });
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: sequenceDir,
      animation_id: "walk",
    });
    const full = await current.service.call("xsxb_get_animation", { animation_id: "walk" });
    assert.equal(full.summary, false);
    assert.equal(full.frameCount, 2);
    assert.equal(full.animation.frames.length, 2);
    const summary = await current.service.call("xsxb_get_animation", {
      animation_id: "walk",
      frames: "summary",
    });
    assert.equal(summary.summary, true);
    assert.ok(!summary.animation.frames);
    const explicitFull = await current.service.call("xsxb_get_animation", {
      animation_id: "walk",
      frames: "full",
    });
    assert.equal(explicitFull.animation.frames.length, 2);
  } finally {
    current.cleanup();
  }
});

test("string dry_run and failed video replace do not destroy data", async () => {
  assert.equal(booleanFlag("true"), true);
  assert.equal(booleanFlag("false"), false);
  assert.equal(requireFps(24), 24);
  assert.throws(() => requireFps("abc"), /fps must be a finite number/);
  assert.throws(() => requireFrameIndex(1.5, 3), /Frame must be an integer/);

  const current = fixture();
  try {
    await current.service.call("xsxb_import_video", {
      file_path: current.video,
      animation_id: "keep",
      fps: 12,
    });
    const preview = await current.service.call("xsxb_delete_animation", {
      animation_id: "keep",
      dry_run: "true",
    });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.deleted, false);
    const stillThere = await current.service.call("xsxb_get_animation", { animation_id: "keep" });
    assert.equal(stillThere.frameCount, 3);

    const failing = createXsxbMcpService({
      root: current.root,
      extractVideoFramesImpl: async () => {
        throw new Error("FFmpeg video extraction failed: spawn ffmpeg ENOENT");
      },
    });
    await assert.rejects(
      () =>
        failing.call("xsxb_import_video", {
          file_path: current.video,
          animation_id: "keep",
          replace: true,
        }),
      /FFmpeg video extraction failed/,
    );
    const afterFailure = await current.service.call("xsxb_get_animation", { animation_id: "keep" });
    assert.equal(afterFailure.frameCount, 3);

    const corrupt = createXsxbMcpService({
      root: current.root,
      extractVideoFramesImpl: async (_videoPath, outputDirectory) => {
        const framePath = path.join(outputDirectory, "frame_000001.png");
        fs.writeFileSync(framePath, "not-a-png");
        return [framePath];
      },
    });
    await assert.rejects(
      () =>
        corrupt.call("xsxb_import_video", {
          file_path: current.video,
          animation_id: "keep",
          replace: true,
          fps: 12,
        }),
      /PNG|not PNG|image data/i,
    );
    const afterCorrupt = await current.service.call("xsxb_get_animation", { animation_id: "keep" });
    assert.equal(afterCorrupt.frameCount, 3);
  } finally {
    current.cleanup();
  }
});

test("reorganize duplicated frames receive unique ids", async () => {
  const current = fixture();
  try {
    await current.service.call("xsxb_import_video", {
      file_path: current.video,
      animation_id: "walk",
      fps: 12,
    });
    const observation = await current.service.callMcp("xsxb_get_animation", { animation_id: "walk" });
    const reorganized = await current.service.call("xsxb_reorganize_frames", {
      animation_id: "walk",
      order: [0, 0, 1],
      dry_run: false,
      basis_snapshot_id: observation.observation.snapshotId,
      sync: false,
    });
    assert.equal(reorganized.outputFrameCount, 3);
    const animation = await current.service.call("xsxb_get_animation", { animation_id: "walk" });
    const ids = animation.animation.frames.map((frame) => frame.id);
    assert.equal(new Set(ids).size, ids.length);
  } finally {
    current.cleanup();
  }
});

/**
 * Lists synced Godot `frame_*.png` copies under `xsxb_frame_tuner`.
 * @param {string} godotRoot Bound Godot project root.
 * @param {string} [clipId] When set, keep only files whose path includes `/clipId/`.
 * @returns {string[]} Absolute PNG paths.
 */
function syncedGodotFramePngs(godotRoot, clipId) {
  const tuner = path.join(godotRoot, "xsxb_frame_tuner");
  const found = [];
  const visit = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (/^frame_\d+\.png$/i.test(entry.name)) found.push(fullPath);
    }
  };
  visit(tuner);
  if (!clipId) return found;
  const needle = `${path.sep}${clipId}${path.sep}`;
  return found.filter((filePath) => filePath.includes(needle));
}

/**
 * Reads one clip's frame count from the Godot-side animation manifest.
 * @param {string} godotRoot Bound Godot project root.
 * @param {string} projectId Registry project id.
 * @param {string} animationId Clip id.
 * @returns {number} Manifest frame count, or 0 when the clip is absent.
 */
function godotManifestFrameCount(godotRoot, projectId, animationId) {
  const manifestPath = path.join(
    godotRoot,
    "xsxb_frame_tuner",
    "data",
    "projects",
    projectId,
    "animation_manifest.json",
  );
  if (!fs.existsSync(manifestPath)) return 0;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  for (const profile of manifest.profiles || []) {
    for (const animation of profile.animations || []) {
      if (String(animation.id || animation.name) === animationId) return (animation.frames || []).length;
    }
  }
  return 0;
}

test("sync_godot_prunes_stale_synced_frame_pngs_after_clip_shrink_or_delete", async () => {
  const current = fixture();
  try {
    const walkDir = path.join(current.root, "walk-sequence");
    fs.mkdirSync(walkDir, { recursive: true });
    for (let index = 1; index <= 4; index += 1) {
      fs.writeFileSync(path.join(walkDir, `walk_${String(index).padStart(2, "0")}.png`), ONE_PIXEL_PNG);
    }
    const importedWalk = await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: walkDir,
      animation_id: "walk",
      fps: 10,
      sync: true,
    });
    assert.equal(importedWalk.importedFrameCount, 4);
    assert.equal(importedWalk.sync.ok, true);
    const walkBefore = syncedGodotFramePngs(current.godotRoot, "walk");
    assert.equal(walkBefore.length, 4, "import+sync must copy four walk PNGs into xsxb_frame_tuner");
    assert.equal(godotManifestFrameCount(current.godotRoot, "mcp-test", "walk"), 4);

    const observation = await current.service.callMcp("xsxb_get_animation", { animation_id: "walk" });
    const reorganized = await current.service.call("xsxb_reorganize_frames", {
      animation_id: "walk",
      order: [0, 1],
      basis_snapshot_id: observation.observation.snapshotId,
      sync: true,
    });
    assert.equal(reorganized.applied, true);
    assert.equal(reorganized.outputFrameCount, 2);
    assert.equal(reorganized.sync.ok, true);
    const walkAfter = syncedGodotFramePngs(current.godotRoot, "walk");
    assert.equal(walkAfter.length, 2, "Godot walk dir must drop leftover frame_0003/0004 after shrink+sync");
    assert.equal(godotManifestFrameCount(current.godotRoot, "mcp-test", "walk"), 2);

    const idleDir = path.join(current.root, "idle-sequence");
    fs.mkdirSync(idleDir, { recursive: true });
    fs.writeFileSync(path.join(idleDir, "idle_01.png"), ONE_PIXEL_PNG);
    fs.writeFileSync(path.join(idleDir, "idle_02.png"), ONE_PIXEL_PNG);
    const importedIdle = await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: idleDir,
      animation_id: "idle",
      fps: 8,
      sync: true,
    });
    assert.equal(importedIdle.importedFrameCount, 2);
    assert.equal(importedIdle.sync.ok, true);
    const idleBefore = syncedGodotFramePngs(current.godotRoot, "idle");
    assert.equal(idleBefore.length, 2, "import+sync must copy idle PNGs into xsxb_frame_tuner");
    const idleParent = path.dirname(idleBefore[0]);

    const removed = await current.service.call("xsxb_delete_animation", {
      animation_id: "idle",
      sync: true,
    });
    assert.equal(removed.deleted, true);
    assert.equal(removed.sync.ok, true);
    const idleAfter = syncedGodotFramePngs(current.godotRoot, "idle");
    assert.equal(idleAfter.length, 0, "deleted clip must not leave frame_*.png under Godot");
    assert.equal(
      fs.existsSync(idleParent) && fs.readdirSync(idleParent).some((name) => /^frame_\d+\.png$/i.test(name)),
      false,
    );
    assert.equal(syncedGodotFramePngs(current.godotRoot, "walk").length, 2);
    assert.equal(godotManifestFrameCount(current.godotRoot, "mcp-test", "idle"), 0);
    assert.equal(godotManifestFrameCount(current.godotRoot, "mcp-test", "walk"), 2);
  } finally {
    current.cleanup();
  }
});

test("sync_godot_forgets_stale_imported_ctex_after_clip_shrink", async () => {
  const current = fixture();
  try {
    const walkDir = path.join(current.root, "walk-sequence");
    fs.mkdirSync(walkDir, { recursive: true });
    for (let index = 1; index <= 4; index += 1) {
      fs.writeFileSync(path.join(walkDir, `walk_${String(index).padStart(2, "0")}.png`), ONE_PIXEL_PNG);
    }
    const importedWalk = await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: walkDir,
      animation_id: "walk",
      fps: 10,
      sync: true,
    });
    assert.equal(importedWalk.importedFrameCount, 4);
    assert.equal(importedWalk.sync.ok, true);
    const walkBefore = syncedGodotFramePngs(current.godotRoot, "walk");
    assert.equal(walkBefore.length, 4, "import+sync must copy four walk PNGs into xsxb_frame_tuner");

    const importedDir = path.join(current.godotRoot, ".godot", "imported");
    fs.mkdirSync(importedDir, { recursive: true });
    for (const pngPath of walkBefore) {
      const stem = path.basename(pngPath, path.extname(pngPath));
      fs.writeFileSync(`${pngPath}.import`, `path="res://.godot/imported/${stem}.ctex"\n`);
      fs.writeFileSync(path.join(importedDir, `${stem}.ctex`), "stale-ctex");
      fs.writeFileSync(path.join(importedDir, `${stem}.md5`), "stale-ctex");
    }

    const observation = await current.service.callMcp("xsxb_get_animation", { animation_id: "walk" });
    const reorganized = await current.service.call("xsxb_reorganize_frames", {
      animation_id: "walk",
      order: [0, 1],
      basis_snapshot_id: observation.observation.snapshotId,
      sync: true,
    });
    assert.equal(reorganized.applied, true);
    assert.equal(reorganized.outputFrameCount, 2);
    assert.equal(reorganized.sync.ok, true);
    const walkAfter = syncedGodotFramePngs(current.godotRoot, "walk");
    assert.equal(walkAfter.length, 2, "Godot walk dir must drop leftover frame_0003/0004 after shrink+sync");

    const retained = new Set(walkAfter.map((filePath) => path.resolve(filePath)));
    const dropped = walkBefore.filter((filePath) => !retained.has(path.resolve(filePath)));
    for (const pngPath of dropped) {
      const stem = path.basename(pngPath, path.extname(pngPath));
      assert.equal(
        fs.existsSync(path.join(importedDir, `${stem}.ctex`)),
        false,
        `dropped ${stem}.ctex must be forgotten from .godot/imported`,
      );
    }
    assert.equal(syncedGodotFramePngs(current.godotRoot, "walk").length, 2);
  } finally {
    current.cleanup();
  }
});

test("sync_godot_prunes_stale_synced_attachment_pngs_after_remove_binding", async () => {
  const current = fixture();
  try {
    const clipDir = path.join(current.root, "idle-sequence");
    fs.mkdirSync(clipDir, { recursive: true });
    fs.writeFileSync(path.join(clipDir, "idle_01.png"), ONE_PIXEL_PNG);
    const imported = await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: clipDir,
      animation_id: "idle",
      fps: 8,
      sync: true,
    });
    assert.equal(imported.importedFrameCount, 1);
    assert.equal(imported.sync.ok, true);

    const spark = path.join(current.root, "spark.png");
    fs.writeFileSync(spark, ONE_PIXEL_PNG);
    const added = await current.service.call("xsxb_add_attachment", {
      animation_id: "idle",
      file_path: spark,
      id: "spark",
      frame: 0,
      sync: true,
    });
    assert.equal(added.sync.ok, true);
    assert.equal(added.sync.imageAttachmentCount, 1);

    const attachmentDir = path.join(
      current.godotRoot,
      "xsxb_frame_tuner",
      "attachments",
      "projects",
      "mcp-test",
    );
    const pngs = fs.existsSync(attachmentDir)
      ? fs.readdirSync(attachmentDir).filter((name) => /\.png$/i.test(name))
      : [];
    assert.ok(pngs.length >= 1, "add_attachment+sync must copy a hash PNG into Godot attachments");
    const hashName = pngs[0];
    const hashPath = path.join(attachmentDir, hashName);

    const godotAttachmentsPath = path.join(
      current.godotRoot,
      "xsxb_frame_tuner",
      "data",
      "projects",
      "mcp-test",
      "frame_image_attachments.json",
    );
    const beforeJson = JSON.parse(fs.readFileSync(godotAttachmentsPath, "utf8"));
    assert.ok(
      beforeJson.some((entry) => String(entry.path || "").includes(hashName)),
      "Godot attachments JSON must list the synced hash PNG",
    );

    const removed = await current.service.call("xsxb_remove_binding", {
      animation_id: "idle",
      kind: "attachment",
      id: "spark",
      sync: true,
    });
    assert.equal(removed.removedCount, 1);
    assert.equal(removed.sync.ok, true);

    const afterJson = JSON.parse(fs.readFileSync(godotAttachmentsPath, "utf8"));
    assert.equal(
      afterJson.some((entry) => String(entry.path || "").includes(hashName)),
      false,
      "Godot attachments JSON must drop the removed binding",
    );
    assert.equal(
      fs.existsSync(hashPath),
      false,
      "stale Godot attachment hash PNG must be pruned after remove_binding+sync",
    );
  } finally {
    current.cleanup();
  }
});

test("sync_godot_forgets_stale_imported_ctex_after_attachment_remove", async () => {
  const current = fixture();
  try {
    const clipDir = path.join(current.root, "idle-sequence");
    fs.mkdirSync(clipDir, { recursive: true });
    fs.writeFileSync(path.join(clipDir, "idle_01.png"), ONE_PIXEL_PNG);
    const imported = await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: clipDir,
      animation_id: "idle",
      fps: 8,
      sync: true,
    });
    assert.equal(imported.importedFrameCount, 1);
    assert.equal(imported.sync.ok, true);

    const spark = path.join(current.root, "spark.png");
    fs.writeFileSync(spark, ONE_PIXEL_PNG);
    const added = await current.service.call("xsxb_add_attachment", {
      animation_id: "idle",
      file_path: spark,
      id: "spark",
      frame: 0,
      sync: true,
    });
    assert.equal(added.sync.ok, true);
    assert.equal(added.sync.imageAttachmentCount, 1);

    const attachmentDir = path.join(
      current.godotRoot,
      "xsxb_frame_tuner",
      "attachments",
      "projects",
      "mcp-test",
    );
    const pngs = fs.existsSync(attachmentDir)
      ? fs.readdirSync(attachmentDir).filter((name) => /\.png$/i.test(name))
      : [];
    assert.ok(pngs.length >= 1, "add_attachment+sync must copy a hash PNG into Godot attachments");
    const hashName = pngs[0];
    const hashPath = path.join(attachmentDir, hashName);
    const stem = path.basename(hashPath, path.extname(hashPath));
    const importedDir = path.join(current.godotRoot, ".godot", "imported");
    fs.mkdirSync(importedDir, { recursive: true });
    fs.writeFileSync(`${hashPath}.import`, `path="res://.godot/imported/${stem}.ctex"\n`);
    fs.writeFileSync(path.join(importedDir, `${stem}.ctex`), "stale-ctex");
    fs.writeFileSync(path.join(importedDir, `${stem}.md5`), "stale-ctex");

    const removed = await current.service.call("xsxb_remove_binding", {
      animation_id: "idle",
      kind: "attachment",
      id: "spark",
      sync: true,
    });
    assert.equal(removed.removedCount, 1);
    assert.equal(removed.sync.ok, true);
    assert.equal(
      fs.existsSync(hashPath),
      false,
      "stale Godot attachment hash PNG must be pruned after remove_binding+sync",
    );
    assert.equal(
      fs.existsSync(path.join(importedDir, `${stem}.ctex`)),
      false,
      `dropped ${stem}.ctex must be forgotten from .godot/imported`,
    );
    assert.equal(
      fs.existsSync(path.join(importedDir, `${stem}.md5`)),
      false,
      `dropped ${stem}.md5 must be forgotten from .godot/imported`,
    );
  } finally {
    current.cleanup();
  }
});

test("sync_godot_forgets_stale_imported_ctex_after_kept_attachment_overwrite", async () => {
  const current = fixture();
  try {
    const clipDir = path.join(current.root, "idle-sequence");
    fs.mkdirSync(clipDir, { recursive: true });
    fs.writeFileSync(path.join(clipDir, "idle_01.png"), ONE_PIXEL_PNG);
    const imported = await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: clipDir,
      animation_id: "idle",
      fps: 8,
      sync: true,
    });
    assert.equal(imported.importedFrameCount, 1);
    assert.equal(imported.sync.ok, true);

    const spark = path.join(current.root, "spark.png");
    fs.writeFileSync(spark, ONE_PIXEL_PNG);
    const added = await current.service.call("xsxb_add_attachment", {
      animation_id: "idle",
      file_path: spark,
      id: "spark",
      frame: 0,
      sync: true,
    });
    assert.equal(added.sync.ok, true);
    assert.equal(added.sync.imageAttachmentCount, 1);

    const attachmentDir = path.join(
      current.godotRoot,
      "xsxb_frame_tuner",
      "attachments",
      "projects",
      "mcp-test",
    );
    const pngs = fs.existsSync(attachmentDir)
      ? fs.readdirSync(attachmentDir).filter((name) => /\.png$/i.test(name))
      : [];
    assert.ok(pngs.length >= 1, "add_attachment+sync must copy a hash PNG into Godot attachments");
    const dest = path.join(attachmentDir, pngs[0]);
    const stem = path.basename(dest, path.extname(dest));
    const importedDir = path.join(current.godotRoot, ".godot", "imported");
    fs.mkdirSync(importedDir, { recursive: true });
    fs.writeFileSync(`${dest}.import`, `path="res://.godot/imported/${stem}.ctex"\n`);
    fs.writeFileSync(path.join(importedDir, `${stem}.ctex`), "stale-ctex");
    fs.writeFileSync(path.join(importedDir, `${stem}.md5`), "stale-ctex");

    const authoringAttachmentsPath = path.join(
      current.godotRoot,
      ".x-frame",
      "data",
      "projects",
      "mcp-test",
      "frame_image_attachments.json",
    );
    assert.equal(fs.existsSync(authoringAttachmentsPath), true, "authoring attachments JSON must exist");
    const authoringAttachments = JSON.parse(fs.readFileSync(authoringAttachmentsPath, "utf8"));
    const sparkEntry =
      authoringAttachments.find((entry) => String(entry?.id || "") === "spark") || authoringAttachments[0];
    assert.ok(sparkEntry, "authoring frame_image_attachments.json must list spark");
    if (!sparkEntry.assetHash) sparkEntry.assetHash = stem;
    fs.writeFileSync(authoringAttachmentsPath, `${JSON.stringify(authoringAttachments, null, 2)}\n`);

    const receiptPath = String(added.binding?.path || "");
    let sourcePath = receiptPath
      ? path.isAbsolute(receiptPath)
        ? receiptPath
        : path.join(current.root, receiptPath)
      : "";
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      const recorded = String(sparkEntry.path || "");
      sourcePath = path.isAbsolute(recorded) ? recorded : path.join(current.root, recorded);
    }
    assert.ok(fs.existsSync(sourcePath), "must find workspace attachment source for overwrite");

    const redPng = encodePngRgba(new Uint8ClampedArray([255, 0, 0, 255]), 1, 1);
    fs.writeFileSync(sourcePath, redPng);

    const synced = await current.service.call("xsxb_sync_godot");
    assert.equal(synced.ok, true);
    assert.equal(fs.existsSync(dest), true, "kept dest hash PNG must still exist");
    assert.equal(
      fs.readFileSync(dest).equals(ONE_PIXEL_PNG),
      false,
      "dest bytes must change after source overwrite",
    );
    assert.equal(
      fs.existsSync(path.join(importedDir, `${stem}.ctex`)),
      false,
      `kept ${stem}.ctex must be forgotten after overwrite+sync`,
    );
    assert.equal(
      fs.existsSync(path.join(importedDir, `${stem}.md5`)),
      false,
      `kept ${stem}.md5 must be forgotten after overwrite+sync`,
    );
    assert.equal(fs.existsSync(`${dest}.import`), true, "dest .import sidecar must stay");
  } finally {
    current.cleanup();
  }
});

test("import can slice frames, replace the same id, and cutout updates the files", async () => {
  const current = fixture();
  try {
    const first = await current.service.call("xsxb_import_video", {
      file_path: current.video,
      animation_id: "attack",
      fps: 24,
      start_frame: 1,
      end_frame: 2,
    });
    assert.equal(first.importedFrameCount, 2);
    assert.equal(first.extractedFrameCount, 3);
    assert.equal(first.fps, 24);

    const replaced = await current.service.call("xsxb_import_video", {
      file_path: current.video,
      animation_id: "attack",
      replace: true,
      fps: 24,
    });
    assert.equal(replaced.animationId, "attack");
    assert.equal(replaced.importedFrameCount, 3);
    assert.equal(replaced.replaced, true);

    const cut = await current.service.call("xsxb_cutout", {
      animation_id: "attack",
      key_color: "#00f002",
      output_width: 256,
      output_height: 256,
    });
    assert.equal(cut.frameCount, 3);
    assert.equal(cut.outputWidth, 256);
    assert.equal(cut.outputHeight, 256);
    assert.ok(cut.processedFrameCount >= 1);

    const validation = await current.service.call("xsxb_validate_project", { layer: "standalone" });
    assert.ok(validation.layers.standalone);
    assert.ok(validation.layers.bind);
    assert.equal(validation.layer, "standalone");
  } finally {
    current.cleanup();
  }
});

test("xsxb_cutout uses the tuner smart-cutout path and keeps hit-frame feet", async () => {
  const current = fixture({ realCutout: true });
  try {
    const sequenceDir = path.join(current.root, "green-sequence");
    fs.mkdirSync(sequenceDir, { recursive: true });
    const width = 16;
    const height = 16;
    const idle = new Uint8ClampedArray(width * height * 4);
    const hit = new Uint8ClampedArray(width * height * 4);
    for (let offset = 0; offset < idle.length; offset += 4) {
      idle.set([0, 255, 0, 255], offset);
      hit.set([0, 255, 0, 255], offset);
    }
    for (let y = 6; y <= 11; y += 1) {
      idle.set([210, 36, 42, 255], (y * width + 7) * 4);
      idle.set([210, 36, 42, 255], (y * width + 8) * 4);
      hit.set([210, 36, 42, 255], (y * width + 7) * 4);
      hit.set([210, 36, 42, 255], (y * width + 8) * 4);
    }
    for (let x = 6; x <= 14; x += 1) hit.set([240, 250, 255, 255], (14 * width + x) * 4);
    fs.writeFileSync(path.join(sequenceDir, "idle.png"), encodePngRgba(idle, width, height));
    fs.writeFileSync(path.join(sequenceDir, "hit.png"), encodePngRgba(hit, width, height));

    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: sequenceDir,
      animation_id: "slash",
    });
    const cut = await current.service.call("xsxb_cutout", { animation_id: "slash" });
    assert.equal(cut.pipeline, "smart_product");
    assert.equal(cut.rematched, false);
    assert.equal(cut.processedFrameCount, 2);

    const full = await current.service.call("xsxb_get_animation", {
      animation_id: "slash",
      frames: "full",
    });
    const idleCut = decodePngRgba(full.animation.frames[0].absolutePath);
    const hitCut = decodePngRgba(full.animation.frames[1].absolutePath);
    assert.ok(idleCut.data[3] <= 16);
    assert.equal(idleCut.data[(6 * width + 7) * 4 + 3], 255);
    assert.equal(subjectAnchor(idleCut.data, width, height).feetY, 11);
    assert.equal(subjectAnchor(hitCut.data, width, height).feetY, 11);
  } finally {
    current.cleanup();
  }
});

test("add tools accept real files", async () => {
  const current = fixture();
  const service = createXsxbMcpService({
    root: current.root,
    extractVideoFramesImpl: async (_videoPath, outputDirectory) => {
      return Array.from({ length: 3 }, (_, index) => {
        const framePath = path.join(outputDirectory, `frame_${String(index + 1).padStart(6, "0")}.png`);
        fs.writeFileSync(framePath, ONE_PIXEL_PNG);
        return framePath;
      });
    },
  });
  try {
    const sequenceDir = path.join(current.root, "seq");
    fs.mkdirSync(sequenceDir, { recursive: true });
    fs.writeFileSync(path.join(sequenceDir, "a.png"), ONE_PIXEL_PNG);
    fs.writeFileSync(path.join(sequenceDir, "b.png"), ONE_PIXEL_PNG);
    await service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: sequenceDir,
      animation_id: "walk",
    });

    const spark = path.join(current.root, "spark.png");
    fs.writeFileSync(spark, ONE_PIXEL_PNG);
    const attachment = await service.call("xsxb_add_attachment", {
      animation_id: "walk",
      file_path: spark,
      sync: false,
    });
    assert.match(attachment.binding.path, /attachments/);
    assert.equal(attachment.binding.name, "spark.png");

    const hit = path.join(current.root, "hit.wav");
    fs.writeFileSync(hit, createTestWav());
    const sfx = await service.call("xsxb_add_sfx", {
      animation_id: "walk",
      file_path: hit,
      sync: false,
    });
    assert.equal(sfx.binding.name, "hit.wav");
    assert.match(String(sfx.binding.path), /audio/);

    const trail = await service.call("xsxb_add_attack_trail", {
      animation_id: "walk",
      id: "arc",
      color: "#112233",
      sticks: [
        { frame: 0, top: { x: -4, y: -8 }, bottom: { x: 4, y: 2 } },
        { frame: 1, top: { x: 6, y: -6 }, bottom: { x: -2, y: 3 } },
      ],
      sync: false,
    });
    assert.equal(trail.segment.id, "arc");
    assert.equal(trail.segment.color, "#112233");

    await assert.rejects(
      () => service.call("xsxb_add_attachment", { animation_id: "walk", sync: false }),
      /missing required argument "file_path"/,
    );
    await assert.rejects(
      () => service.call("xsxb_add_sfx", { animation_id: "walk", sync: false }),
      /missing required argument "file_path"/,
    );
    const ordered = await service.call("xsxb_add_attachment", {
      animation_id: "walk",
      file_path: spark,
      layer_order: 0,
      sync: false,
    });
    assert.equal(ordered.binding.layerOrder, 0);
    await assert.rejects(
      () => service.call("xsxb_update_timing", { animation_id: "walk", fps: "abc" }),
      /"fps" must be number/,
    );
    const stillWalk = await service.call("xsxb_get_animation", { animation_id: "walk" });
    assert.equal(stillWalk.animation.fps, 12);
  } finally {
    current.cleanup();
  }
});

test("attack trail defaults stay inside a one-frame animation", async () => {
  const current = fixture();
  try {
    const sequenceDir = path.join(current.root, "one");
    fs.mkdirSync(sequenceDir, { recursive: true });
    fs.writeFileSync(path.join(sequenceDir, "only.png"), ONE_PIXEL_PNG);
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: sequenceDir,
      animation_id: "idle",
      fps: 12,
    });
    const trail = await current.service.call("xsxb_add_attack_trail", {
      animation_id: "idle",
      sync: false,
    });
    const frames = trail.segment.sticks.map((stick) => stick.frame);
    assert.deepEqual(frames, [0, 0]);
    assert.equal(
      frames.some((frame) => frame < 0 || frame > 0),
      false,
    );
  } finally {
    current.cleanup();
  }
});

test("cutout writes each frame's own size when no canvas is requested", async () => {
  const current = fixture({ realCutout: true });
  try {
    const sequenceDir = path.join(current.root, "mixed-size");
    fs.mkdirSync(sequenceDir, { recursive: true });
    const small = new Uint8ClampedArray(40 * 40 * 4);
    const large = new Uint8ClampedArray(80 * 60 * 4);
    for (let offset = 0; offset < small.length; offset += 4) small.set([0, 255, 0, 255], offset);
    for (let offset = 0; offset < large.length; offset += 4) large.set([0, 255, 0, 255], offset);
    small.set([210, 36, 42, 255], (20 * 40 + 20) * 4);
    large.set([210, 36, 42, 255], (30 * 80 + 40) * 4);
    fs.writeFileSync(path.join(sequenceDir, "a.png"), encodePngRgba(small, 40, 40));
    fs.writeFileSync(path.join(sequenceDir, "b.png"), encodePngRgba(large, 80, 60));
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: sequenceDir,
      animation_id: "mixed",
    });
    await current.service.call("xsxb_cutout", { animation_id: "mixed" });
    const full = await current.service.call("xsxb_get_animation", {
      animation_id: "mixed",
      frames: "full",
    });
    assert.equal(full.animation.frames[0].width, 40);
    assert.equal(full.animation.frames[0].height, 40);
    assert.equal(full.animation.frames[1].width, 80);
    assert.equal(full.animation.frames[1].height, 60);
  } finally {
    current.cleanup();
  }
});

test("import_animation slices PNG sequences with start_frame and end_frame", async () => {
  const current = fixture();
  try {
    const sequenceDir = path.join(current.root, "ten-frames");
    fs.mkdirSync(sequenceDir, { recursive: true });
    for (let index = 0; index < 10; index += 1) {
      fs.writeFileSync(path.join(sequenceDir, `f${String(index).padStart(2, "0")}.png`), ONE_PIXEL_PNG);
    }
    const imported = await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: sequenceDir,
      animation_id: "clip",
      start_frame: 2,
      end_frame: 4,
    });
    assert.equal(imported.importedFrameCount, 3);
    assert.equal(imported.startFrame, 2);
    assert.equal(imported.endFrame, 4);
    assert.equal(imported.sourceFrameCount, 10);
  } finally {
    current.cleanup();
  }
});

test("MCP service uses XSXB_ROOT when options.root is omitted", async () => {
  const previous = process.env.XSXB_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-mcp-env-root-"));
  process.env.XSXB_ROOT = root;
  try {
    const service = createXsxbMcpService({});
    await service.call("xsxb_list_projects");
    assert.ok(fs.existsSync(path.join(root, ".x-frame", "data", "projects.json")));
    assert.equal(fs.existsSync(path.join(root, "data", "projects.json")), false);
  } finally {
    if (previous === undefined) delete process.env.XSXB_ROOT;
    else process.env.XSXB_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("update_timing does not persist fps when a frame request is invalid", async () => {
  const current = fixture();
  try {
    await current.service.call("xsxb_import_video", {
      file_path: current.video,
      animation_id: "walk",
      fps: 12,
    });
    await assert.rejects(
      () =>
        current.service.call("xsxb_update_timing", {
          animation_id: "walk",
          fps: 24,
          frames: [{ frame: 99, duration: 2 }],
        }),
      /Frame must be an integer/,
    );
    const after = await current.service.call("xsxb_get_animation", { animation_id: "walk" });
    assert.equal(after.animation.fps, 12);
  } finally {
    current.cleanup();
  }
});

test("bind validation layer keeps standalone/game-local mismatch errors", () => {
  assert.equal(classifyValidationMessage("Standalone and game-local animation_tuning.json differ."), "bind");
  assert.equal(
    classifyValidationMessage("hero/slash: standalone and game-local attack trail data differ."),
    "bind",
  );
  assert.equal(classifyValidationMessage("Unstable frame binding key: bad"), "bind");
  assert.equal(classifyValidationMessage("project.godot not found"), "bind");
  assert.equal(classifyValidationMessage("Generated runtime is missing"), "gameplay");
});

test("cutout is marked destructive because it overwrites source frames", () => {
  const cutout = toolDefinitions().find((tool) => tool.name === "xsxb_cutout");
  assert.equal(cutout.annotations.destructiveHint, true);
});

test("cutout accepts workspace-absolute imported frames and refuses escaped paths", async () => {
  const current = fixture();
  try {
    const sequenceDir = path.join(current.root, "seq-cutout-path");
    fs.mkdirSync(sequenceDir, { recursive: true });
    fs.writeFileSync(path.join(sequenceDir, "a.png"), ONE_PIXEL_PNG);
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: sequenceDir,
      animation_id: "idle",
    });
    const store = createProjectStore(current.root);
    const project = store.resolveProject(store.readRegistry());
    const paths = store.projectPaths(project);
    const manifest = store.readJson(paths.manifest, { schemaVersion: 1, profiles: [] });
    const animation = manifest.profiles[0].animations.find((entry) => entry.id === "idle");
    const relativePath = String(animation.frames[0].path);
    const workspaceAbsolute = path.resolve(current.root, relativePath);
    const outside = path.join(current.root, "outside-cutout.png");
    fs.writeFileSync(outside, ONE_PIXEL_PNG);
    const originalOutside = fs.readFileSync(outside);

    animation.frames[0].path = workspaceAbsolute;
    store.writeJson(paths.manifest, manifest);
    const cut = await current.service.call("xsxb_cutout", { animation_id: "idle" });
    assert.ok(cut.processedFrameCount >= 1);

    animation.frames[0].path = outside;
    store.writeJson(paths.manifest, manifest);
    await assert.rejects(
      () => current.service.call("xsxb_cutout", { animation_id: "idle" }),
      /outside the project workspace or Godot root/,
    );
    assert.deepEqual(fs.readFileSync(outside), originalOutside);

    animation.frames[0].path = "res://../outside-cutout.png";
    store.writeJson(paths.manifest, manifest);
    await assert.rejects(
      () => current.service.call("xsxb_cutout", { animation_id: "idle" }),
      /outside the project workspace or Godot root/,
    );
    assert.deepEqual(fs.readFileSync(outside), originalOutside);

    const view = await current.service.call("xsxb_get_animation", { animation_id: "idle" });
    assert.equal(view.animation.frames[0].exists, false);
    assert.equal(view.animation.frames[0].absolutePath, "");
  } finally {
    current.cleanup();
  }
});
