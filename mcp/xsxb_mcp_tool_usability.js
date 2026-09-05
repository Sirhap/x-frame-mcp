#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { authoringProbes } = require("./authoring/usability");
const { handleMessage } = require("./xsxb_mcp_server");
const { EFFECTS, ROUTES, VERIFICATION_STATUSES } = require("./xsxb_mcp_receipt");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createProjectStore } = require("./lib/project_store");
const {
  MCP_TOOL_NAMES,
  createTestWav,
  createXsxbMcpService,
  toolDefinitions,
} = require("./xsxb_mcp_service");
const { decodePngRgba, encodePngRgba, subjectAnchor } = require("./xsxb_mcp_cutout");

const ONE_PIXEL_PNG = encodePngRgba(new Uint8ClampedArray([255, 255, 255, 255]), 1, 1);

/**
 * Creates an isolated tuner root and MCP service for one tool probe.
 * @param {object} serviceOptions External process overrides.
 * @returns {object} Fixture exposing public requests, receipts and cleanup.
 */
function createFixture(serviceOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-mcp-usable-"));
  const godotRoot = path.join(root, "godot");
  fs.mkdirSync(godotRoot, { recursive: true });
  fs.writeFileSync(path.join(godotRoot, "project.godot"), '[application]\nconfig/name="Usable"\n');
  const presetPath = path.join(
    root,
    "tools/animation_tuner/public/presets/attack_trails/dynamic_trail_luma.png",
  );
  const realPreset = path.join(
    __dirname,
    "lib/animation_tuner/public/presets/attack_trails/dynamic_trail_luma.png",
  );
  fs.mkdirSync(path.dirname(presetPath), { recursive: true });
  if (fs.existsSync(realPreset)) fs.copyFileSync(realPreset, presetPath);
  else fs.writeFileSync(presetPath, ONE_PIXEL_PNG);
  createProjectStore(root).addProject({ id: "usable", label: "Usable", projectRoot: godotRoot });
  const gifJobs = [];
  const service = createXsxbMcpService({
    root,
    florenceDetectImpl: null,
    encodeGifImpl: async (job) => {
      gifJobs.push(job);
      fs.writeFileSync(job.outputPath, Buffer.from("GIF89a-fake"));
    },
    ...serviceOptions,
  });
  const receipts = [];
  /**
   * Exercises the same JSON-RPC dispatcher and receipt contract as MCP clients.
   * @param {string} name Tool name.
   * @param {object} args Explicit arguments; observation ids are never injected.
   * @returns {Promise<object>} Public receipt.
   */
  async function request(name, args = {}) {
    const id = receipts.length + 1;
    const handled = await handleMessage(
      {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      },
      service,
    );
    const response = JSON.parse(JSON.stringify(handled));
    assert.equal(response.id, id);
    assert.equal(response.jsonrpc, "2.0");
    const result = response.result;
    assert.ok(Array.isArray(result?.content));
    const receipt = result.structuredContent;
    assert.equal(receipt.schemaVersion, 2);
    assert.equal(receipt.tool, name);
    assert.equal(result.isError, !receipt.ok);
    for (const key of ["data", "observation", "execution", "verification", "escalation"]) {
      assert.ok(Object.hasOwn(receipt, key), `receipt is missing ${key}`);
    }
    if (receipt.execution) {
      assert.ok(EFFECTS.includes(receipt.execution.effect));
      assert.ok(ROUTES.includes(receipt.execution.route));
    }
    if (receipt.verification) assert.ok(VERIFICATION_STATUSES.includes(receipt.verification.status));
    receipts.push(receipt);
    if (!receipt.ok) {
      const error = new Error(receipt.error.message);
      error.code = receipt.error.code;
      throw error;
    }
    return receipt;
  }
  return {
    root,
    godotRoot,
    receipts,
    request,
    gifJobs,
    call: async (name, args) => (await request(name, args)).data,
    cleanup() {
      try {
        service.close();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Writes a two-frame PNG sequence and imports it.
 * @param {object} fixture Isolated fixture.
 * @param {string} animationId Animation id.
 * @returns {Promise<object>} Import receipt.
 */
async function importSequence(fixture, animationId) {
  const directory = path.join(fixture.root, `${animationId}-seq`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "01.png"), ONE_PIXEL_PNG);
  fs.writeFileSync(path.join(directory, "02.png"), ONE_PIXEL_PNG);
  return fixture.call("xsxb_import_animation", {
    source: "png_sequence",
    directory,
    animation_id: animationId,
    fps: 12,
    in_place: false,
  });
}

/**
 * Writes a green-screen PNG sequence for cutout probes.
 * @param {string} directory Output directory.
 * @returns {void}
 */
function writeGreenSequence(directory) {
  fs.mkdirSync(directory, { recursive: true });
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
  fs.writeFileSync(path.join(directory, "idle.png"), encodePngRgba(idle, width, height));
  fs.writeFileSync(path.join(directory, "hit.png"), encodePngRgba(hit, width, height));
}

/**
 * Builds one lavfi MP4 when ffmpeg is on PATH.
 * @param {string} filePath Destination path.
 * @returns {{ok:boolean,error?:string}} Probe result.
 */
function writeTestVideo(filePath) {
  try {
    execFileSync(
      process.env.XSXB_FFMPEG || "ffmpeg",
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=green:s=32x32:r=3:d=1",
        "-pix_fmt",
        "yuv420p",
        filePath,
      ],
      { timeout: 20_000 },
    );
    return { ok: fs.existsSync(filePath) };
  } catch (error) {
    return { ok: false, error: error.stderr || error.message };
  }
}

/**
 * Records one tool verdict.
 * @param {string} tool Tool name.
 * @param {"ready"|"limited"|"stub"|"fail"} status Usability class.
 * @param {string} evidence What was observed.
 * @param {string} [gap] Remaining product gap.
 * @returns {object} Verdict.
 */
function verdict(tool, status, evidence, gap) {
  return { tool, status, evidence, gap: gap || "" };
}

/**
 * Runs one probe and converts thrown errors into a fail verdict.
 * @param {string} tool Tool name.
 * @param {Function} probe Async probe.
 * @param {object} serviceOptions External process overrides.
 * @returns {Promise<object>} Verdict.
 */
async function isolate(tool, probe, serviceOptions) {
  const fixture = createFixture(serviceOptions);
  try {
    const result = await probe(fixture);
    if (result.status === "ready")
      assert.ok(
        fixture.receipts.some((receipt) => receipt.tool === tool && receipt.ok),
        `${tool} was not exercised through MCP`,
      );
    return { ...result, publicCalls: fixture.receipts.length };
  } catch (error) {
    return verdict(tool, "fail", error.message);
  } finally {
    fixture.cleanup();
  }
}

const PROBES = {
  ...authoringProbes(importSequence),
  xsxb_open_tuner: probeOpenTuner,

  async xsxb_list_projects(fixture) {
    const listed = await fixture.call("xsxb_list_projects");
    if (listed.count < 1 || listed.activeProjectId !== "usable") {
      return verdict("xsxb_list_projects", "fail", JSON.stringify(listed));
    }
    return verdict("xsxb_list_projects", "ready", `count=${listed.count} active=${listed.activeProjectId}`);
  },

  async xsxb_get_project(fixture) {
    const project = await fixture.call("xsxb_get_project", { project_id: "usable" });
    if (project.projectId !== "usable" || project.godotProjectValid !== true) {
      return verdict("xsxb_get_project", "fail", JSON.stringify(project));
    }
    return verdict("xsxb_get_project", "ready", `godotValid=${project.godotProjectValid}`);
  },

  async xsxb_create_project(fixture) {
    const created = await fixture.call("xsxb_create_project", {
      project_id: "warrior",
      label: "Warrior",
    });
    const listed = await fixture.call("xsxb_list_projects");
    const again = await fixture.call("xsxb_create_project", { project_id: "warrior" });
    if (
      created.projectId !== "warrior" ||
      created.created !== true ||
      listed.activeProjectId !== "warrior" ||
      !listed.projects.some((entry) => entry.id === "warrior") ||
      again.created !== false ||
      again.projectId !== "warrior"
    ) {
      return verdict("xsxb_create_project", "fail", JSON.stringify({ created, listed, again }));
    }
    return verdict("xsxb_create_project", "ready", `created ${created.projectId}`);
  },

  async xsxb_set_active_project(fixture) {
    const store = createProjectStore(fixture.root);
    store.addProject({ id: "other", label: "Other", projectRoot: "" });
    const activated = await fixture.call("xsxb_set_active_project", { project_id: "other" });
    const listed = await fixture.call("xsxb_list_projects");
    if (activated.activeProjectId !== "other" || listed.activeProjectId !== "other") {
      return verdict("xsxb_set_active_project", "fail", JSON.stringify({ activated, listed }));
    }
    return verdict("xsxb_set_active_project", "ready", "active project switches and persists");
  },

  async xsxb_bind_godot(fixture) {
    const store = createProjectStore(fixture.root);
    store.addProject({ id: "orphan", label: "Orphan", projectRoot: "" });
    const bound = await fixture.call("xsxb_bind_godot", {
      project_id: "orphan",
      project_root: fixture.godotRoot,
    });
    if (!bound.godotProjectValid || bound.projectId !== "orphan") {
      return verdict("xsxb_bind_godot", "fail", JSON.stringify(bound));
    }
    return verdict("xsxb_bind_godot", "ready", `bound ${bound.projectRoot}`);
  },

  async xsxb_import_animation(fixture) {
    const png = await importSequence(fixture, "walk");
    const spriteDir = path.join(fixture.godotRoot, "sprites");
    fs.mkdirSync(spriteDir, { recursive: true });
    fs.writeFileSync(path.join(spriteDir, "idle.png"), ONE_PIXEL_PNG);
    const tresPath = path.join(spriteDir, "hero.spriteframes.tres");
    fs.writeFileSync(
      tresPath,
      `[ext_resource type="Texture2D" path="res://sprites/idle.png" id="1_tex"]

[resource]
animations = [{
"frames": [{"duration": 1.0, "texture": ExtResource("1_tex")}],
"loop": true,
"name": &"idle",
"speed": 8.0
}]
`,
    );
    const sprite = await fixture.call("xsxb_import_animation", {
      source: "spriteframes",
      file_path: tresPath,
    });
    const inplaceDir = path.join(fixture.root, "inplace-seq");
    fs.mkdirSync(inplaceDir, { recursive: true });
    fs.writeFileSync(path.join(inplaceDir, "01.png"), ONE_PIXEL_PNG);
    fs.writeFileSync(path.join(inplaceDir, "02.png"), ONE_PIXEL_PNG);
    const inplace = await fixture.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: inplaceDir,
      animation_id: "inplace_walk",
      fps: 12,
      in_place: true,
    });
    if (png.importedFrameCount !== 2 || sprite.importedFrameCount < 1 || inplace.importedFrameCount !== 2) {
      return verdict("xsxb_import_animation", "fail", JSON.stringify({ png, sprite, inplace }));
    }
    return verdict(
      "xsxb_import_animation",
      "ready",
      `png=${png.importedFrameCount} spriteframes=${sprite.importedFrameCount} inplace=${inplace.inPlace}`,
    );
  },

  async xsxb_import_video(fixture) {
    const videoPath = path.join(fixture.root, "clip.mp4");
    const made = writeTestVideo(videoPath);
    if (!made.ok) {
      return verdict(
        "xsxb_import_video",
        "limited",
        "ffmpeg unavailable in this environment",
        made.error || "Cannot extract real video without ffmpeg",
      );
    }
    const imported = await fixture.call("xsxb_import_video", {
      file_path: videoPath,
      animation_id: "clip",
      fps: 12,
      start_frame: 0,
      end_frame: 1,
    });
    if (imported.importedFrameCount < 1) {
      return verdict("xsxb_import_video", "fail", JSON.stringify(imported));
    }
    return verdict(
      "xsxb_import_video",
      "ready",
      `imported=${imported.importedFrameCount} extracted=${imported.extractedFrameCount}`,
    );
  },

  async xsxb_slice_sheet(fixture) {
    const sheetPath = path.join(fixture.root, "sheet.png");
    const cell = 4;
    const width = 8;
    const height = 8;
    const rgba = new Uint8ClampedArray(width * height * 4);
    const colors = [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
      [255, 255, 0, 255],
    ];
    for (let row = 0; row < 2; row += 1) {
      for (let col = 0; col < 2; col += 1) {
        const color = colors[row * 2 + col];
        for (let y = 0; y < cell; y += 1) {
          for (let x = 0; x < cell; x += 1) {
            rgba.set(color, ((row * cell + y) * width + col * cell + x) * 4);
          }
        }
      }
    }
    fs.writeFileSync(sheetPath, encodePngRgba(rgba, width, height));
    const sliced = await fixture.call("xsxb_slice_sheet", {
      file_path: sheetPath,
      columns: 2,
      rows: 2,
    });
    if (sliced.frameCount !== 4 || sliced.paths.length !== 4 || !fs.existsSync(sliced.paths[0])) {
      return verdict("xsxb_slice_sheet", "fail", JSON.stringify(sliced));
    }
    return verdict("xsxb_slice_sheet", "ready", `frameCount=${sliced.frameCount} dest=${sliced.outputDir}`);
  },

  async xsxb_get_animation(fixture) {
    await importSequence(fixture, "walk");
    const full = await fixture.call("xsxb_get_animation", { animation_id: "walk" });
    const summary = await fixture.call("xsxb_get_animation", {
      animation_id: "walk",
      frames: "summary",
    });
    if (full.animation.frames.length !== 2 || summary.summary !== true || summary.animation.frames) {
      return verdict("xsxb_get_animation", "fail", JSON.stringify({ summary, full }));
    }
    return verdict("xsxb_get_animation", "ready", "default full frames; summary on request");
  },

  async xsxb_find_loop(fixture) {
    const directory = path.join(fixture.root, "loop-seq");
    const width = 8;
    const height = 8;
    const phases = [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
    ];
    fs.mkdirSync(directory, { recursive: true });
    for (let index = 0; index < 7; index += 1) {
      const rgba = new Uint8ClampedArray(width * height * 4);
      for (let offset = 0; offset < rgba.length; offset += 4) rgba.set(phases[index % 3], offset);
      fs.writeFileSync(
        path.join(directory, `${String(index + 1).padStart(2, "0")}.png`),
        encodePngRgba(rgba, width, height),
      );
    }
    await fixture.call("xsxb_import_animation", {
      source: "png_sequence",
      directory,
      animation_id: "cycle",
    });
    const found = await fixture.call("xsxb_find_loop", {
      animation_id: "cycle",
      sample_size: 8,
      min_period: 2,
      max_period: 4,
    });
    if (found.source !== "animation" || found.recommended?.period !== 3 || found.applied !== false) {
      return verdict("xsxb_find_loop", "fail", JSON.stringify(found));
    }
    return verdict(
      "xsxb_find_loop",
      "ready",
      `period=${found.recommended.period} order=${found.recommended.order.join(",")}`,
    );
  },

  async xsxb_find_duplicates(fixture) {
    const directory = path.join(fixture.root, "dup-seq");
    const width = 8;
    const height = 8;
    const colors = [
      [255, 0, 0, 255],
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
    ];
    fs.mkdirSync(directory, { recursive: true });
    colors.forEach((color, index) => {
      const rgba = new Uint8ClampedArray(width * height * 4);
      for (let offset = 0; offset < rgba.length; offset += 4) rgba.set(color, offset);
      fs.writeFileSync(
        path.join(directory, `${String(index + 1).padStart(2, "0")}.png`),
        encodePngRgba(rgba, width, height),
      );
    });
    await fixture.call("xsxb_import_animation", {
      source: "png_sequence",
      directory,
      animation_id: "holds",
    });
    const found = await fixture.call("xsxb_find_duplicates", {
      animation_id: "holds",
      sample_size: 8,
    });
    if (found.applied !== false || found.drop.join(",") !== "1,3" || found.order.join(",") !== "0,2,4") {
      return verdict("xsxb_find_duplicates", "fail", JSON.stringify(found));
    }
    return verdict(
      "xsxb_find_duplicates",
      "ready",
      `drop=${found.drop.join(",")} order=${found.order.join(",")}`,
    );
  },

  async xsxb_find_motion(fixture) {
    const directory = path.join(fixture.root, "motion-seq");
    fs.mkdirSync(directory, { recursive: true });
    const canvas = 16;
    const writeBody = (name, bodyH) => {
      const rgba = new Uint8ClampedArray(canvas * canvas * 4);
      const left = 6;
      const top = canvas - bodyH - 1;
      for (let y = top; y < top + bodyH; y += 1) {
        for (let x = left; x < left + 4; x += 1) {
          rgba.set([210, 36, 42, 255], (y * canvas + x) * 4);
        }
      }
      fs.writeFileSync(path.join(directory, name), encodePngRgba(rgba, canvas, canvas));
    };
    for (let index = 1; index <= 3; index += 1) writeBody(`${String(index).padStart(2, "0")}.png`, 8);
    for (let index = 4; index <= 6; index += 1) writeBody(`${String(index).padStart(2, "0")}.png`, 12);
    for (let index = 7; index <= 8; index += 1) writeBody(`${String(index).padStart(2, "0")}.png`, 8);
    await fixture.call("xsxb_import_animation", {
      source: "png_sequence",
      directory,
      animation_id: "jump",
    });
    const found = await fixture.call("xsxb_find_motion", { animation_id: "jump" });
    if (found.start !== 3 || found.end !== 5 || found.order.join(",") !== "3,4,5") {
      return verdict("xsxb_find_motion", "fail", JSON.stringify(found));
    }
    return verdict("xsxb_find_motion", "ready", `start=${found.start} end=${found.end}`);
  },

  async xsxb_analyze(fixture) {
    const directory = path.join(fixture.root, "analyze-seq");
    const width = 8;
    const height = 8;
    const phases = [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
    ];
    fs.mkdirSync(directory, { recursive: true });
    for (let index = 0; index < 7; index += 1) {
      const rgba = new Uint8ClampedArray(width * height * 4);
      for (let offset = 0; offset < rgba.length; offset += 4) rgba.set(phases[index % 3], offset);
      fs.writeFileSync(
        path.join(directory, `${String(index + 1).padStart(2, "0")}.png`),
        encodePngRgba(rgba, width, height),
      );
    }
    await fixture.call("xsxb_import_animation", {
      source: "png_sequence",
      directory,
      animation_id: "cycle",
    });
    const analyzed = await fixture.call("xsxb_analyze", {
      animation_id: "cycle",
      sample_size: 8,
      min_period: 2,
      max_period: 4,
    });
    if (
      analyzed.source !== "animation" ||
      analyzed.applied !== false ||
      analyzed.decodeCount !== 7 ||
      analyzed.loop?.recommended?.period !== 3 ||
      analyzed.preview?.kind !== "loop" ||
      !analyzed.preview?.path ||
      !fs.existsSync(analyzed.preview.path)
    ) {
      return verdict("xsxb_analyze", "fail", JSON.stringify(analyzed));
    }
    return verdict(
      "xsxb_analyze",
      "ready",
      `period=${analyzed.loop.recommended.period} preview=${path.basename(analyzed.preview.path)}`,
    );
  },

  async xsxb_update_frame_boxes(fixture) {
    await importSequence(fixture, "walk");
    const boxes = await fixture.call("xsxb_update_frame_boxes", {
      animation_id: "walk",
      frame: 0,
      hurtbox: { enabled: true, offset: { x: 1, y: -8 }, size: { x: 16, y: 16 } },
      collisionbox: { enabled: true, size: { x: 12, y: 20 } },
    });
    if (boxes.boxes.hurtbox.size.x !== 16 || boxes.sync.requested !== false) {
      return verdict("xsxb_update_frame_boxes", "fail", JSON.stringify(boxes));
    }
    return verdict("xsxb_update_frame_boxes", "ready", "writes boxes without implicit sync");
  },

  async xsxb_estimate_boxes(fixture) {
    await importSequence(fixture, "walk");
    const preview = await fixture.call("xsxb_estimate_boxes", {
      animation_id: "walk",
      replace: true,
      dry_run: true,
    });
    const applied = await fixture.call("xsxb_estimate_boxes", {
      animation_id: "walk",
      replace: true,
    });
    const skipped = await fixture.call("xsxb_estimate_boxes", { animation_id: "walk" });
    if (
      preview.dryRun !== true ||
      preview.sync.requested !== false ||
      applied.estimatedFrames !== 2 ||
      !applied.frames[0].boxes?.hurtbox ||
      skipped.skippedExistingFrames !== 2
    ) {
      return verdict("xsxb_estimate_boxes", "fail", JSON.stringify({ preview, applied, skipped }));
    }
    return verdict(
      "xsxb_estimate_boxes",
      "ready",
      `estimated=${applied.estimatedFrames}; keeps existing overrides unless replace`,
    );
  },

  async xsxb_update_timing(fixture) {
    await importSequence(fixture, "walk");
    const timing = await fixture.call("xsxb_update_timing", {
      animation_id: "walk",
      fps: 8,
      frame: 1,
      duration_ms: 250,
    });
    if (timing.fps !== 8 || timing.playback.durationMs !== 250) {
      return verdict("xsxb_update_timing", "fail", JSON.stringify(timing));
    }
    return verdict("xsxb_update_timing", "ready", "fps and per-frame duration persist");
  },

  async xsxb_set_visual_transform(fixture) {
    await importSequence(fixture, "walk");
    const group = await fixture.call("xsxb_set_visual_transform", {
      animation_id: "walk",
      level: "group",
      visual_size: 0.5,
      offset_x: 4,
      offset_y: -6,
    });
    const frameLevel = await fixture.call("xsxb_set_visual_transform", {
      animation_id: "walk",
      level: "frame",
      frame: 1,
      rotation: 0.25,
    });
    const readBack = await fixture.call("xsxb_get_animation", {
      animation_id: "walk",
      include: ["visual"],
    });
    const cleared = await fixture.call("xsxb_set_visual_transform", {
      animation_id: "walk",
      level: "frame",
      frame: 1,
      clear: true,
    });
    if (
      group.sync.requested !== false ||
      readBack.visual.group.visual_size !== 0.5 ||
      readBack.visual.group.offset.y !== -6 ||
      readBack.visual.frameOverrides["1"]?.rotation !== 0.25 ||
      frameLevel.override.rotation !== 0.25 ||
      cleared.cleared !== true
    ) {
      return verdict(
        "xsxb_set_visual_transform",
        "fail",
        JSON.stringify({ group, frameLevel, readBack, cleared }),
      );
    }
    return verdict(
      "xsxb_set_visual_transform",
      "ready",
      "group and frame levels persist and read back via include=visual",
    );
  },

  async xsxb_estimate_visual(fixture) {
    const idleDir = path.join(fixture.root, "idle-est");
    const comboDir = path.join(fixture.root, "combo-est");
    fs.mkdirSync(idleDir, { recursive: true });
    fs.mkdirSync(comboDir, { recursive: true });
    const canvas = 16;
    const writeBody = (directory, name, bodyH) => {
      const rgba = new Uint8ClampedArray(canvas * canvas * 4);
      const left = 6;
      const top = canvas - bodyH - 1;
      for (let y = top; y < top + bodyH; y += 1) {
        for (let x = left; x < left + 4; x += 1) {
          rgba.set([210, 36, 42, 255], (y * canvas + x) * 4);
        }
      }
      fs.writeFileSync(path.join(directory, name), encodePngRgba(rgba, canvas, canvas));
    };
    writeBody(idleDir, "01.png", 12);
    writeBody(idleDir, "02.png", 12);
    writeBody(comboDir, "01.png", 6);
    writeBody(comboDir, "02.png", 12);
    writeBody(comboDir, "03.png", 12);
    await fixture.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: idleDir,
      animation_id: "idle",
    });
    await fixture.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: comboDir,
      animation_id: "combo",
    });
    const estimated = await fixture.call("xsxb_estimate_visual", {
      animation_id: "combo",
      reference_animation_id: "idle",
      apply: true,
    });
    const readBack = await fixture.call("xsxb_get_animation", {
      animation_id: "combo",
      include: ["visual"],
    });
    if (
      estimated.groupScale !== 1 ||
      estimated.zoomFrameCount !== 1 ||
      estimated.frames[0].reason !== "zoom" ||
      readBack.visual.group.visual_size !== 1 ||
      readBack.visual.frameOverrides["0"]?.visual_size !== estimated.frames[0].scale
    ) {
      return verdict("xsxb_estimate_visual", "fail", JSON.stringify({ estimated, readBack }));
    }
    return verdict(
      "xsxb_estimate_visual",
      "ready",
      `group=${estimated.groupScale} zoom=${estimated.frames[0].scale}`,
    );
  },

  async xsxb_measure_frames(fixture) {
    await importSequence(fixture, "walk");
    const measured = await fixture.call("xsxb_measure_frames", { animation_id: "walk" });
    if (!measured.frames?.length || typeof measured.frames[0].bboxH !== "number") {
      return verdict("xsxb_measure_frames", "fail", JSON.stringify(measured));
    }
    return verdict(
      "xsxb_measure_frames",
      "ready",
      `frames=${measured.frames.length} bboxH=${measured.frames[0].bboxH}`,
    );
  },

  async xsxb_register_clip(fixture) {
    await importSequence(fixture, "walk");
    const planned = await fixture.call("xsxb_register_clip", {
      animation_id: "walk",
      target_bbox: 8,
      dry_run: true,
    });
    if (planned.applied !== false || !planned.frames?.length || planned.targetBbox !== 8) {
      return verdict("xsxb_register_clip", "fail", JSON.stringify(planned));
    }
    return verdict("xsxb_register_clip", "ready", `dryRun scale=${planned.frames[0].scale}`);
  },

  async xsxb_export_overlay(fixture) {
    await importSequence(fixture, "walk");
    const overlay = await fixture.call("xsxb_export_overlay", { animation_id: "walk" });
    if (!fs.existsSync(overlay.outputPath) || overlay.mse < 0) {
      return verdict("xsxb_export_overlay", "fail", JSON.stringify(overlay));
    }
    return verdict("xsxb_export_overlay", "ready", `mse=${overlay.mse}`);
  },

  async xsxb_export_pack_slot(fixture) {
    await importSequence(fixture, "walk");
    const dest = path.join(fixture.root, "pack", "run", "front");
    const exported = await fixture.call("xsxb_export_pack_slot", {
      animation_id: "walk",
      dest,
      slot: "run",
      view: "front",
    });
    if (exported.copied !== 2 || !fs.existsSync(path.join(dest, "0.png"))) {
      return verdict("xsxb_export_pack_slot", "fail", JSON.stringify(exported));
    }
    return verdict("xsxb_export_pack_slot", "ready", `copied=${exported.copied}`);
  },

  async xsxb_reorganize_frames(fixture) {
    await importSequence(fixture, "walk");
    const observed = await fixture.request("xsxb_get_animation", { animation_id: "walk" });
    const orderArgs = { animation_id: "walk", order: [1, 0], sync: false };
    await assert.rejects(fixture.call("xsxb_reorganize_frames", orderArgs), { code: "MISSING_SNAPSHOT" });
    const reversed = await fixture.call("xsxb_reorganize_frames", {
      animation_id: "walk",
      basis_snapshot_id: observed.observation.snapshotId,
      order: [1, 0],
      sync: false,
    });
    if (reversed.outputFrameCount !== 2 || reversed.identityOrder !== false) {
      return verdict("xsxb_reorganize_frames", "fail", JSON.stringify(reversed));
    }
    await assert.rejects(
      fixture.call("xsxb_reorganize_frames", {
        ...orderArgs,
        basis_snapshot_id: observed.observation.snapshotId,
      }),
      { code: "STALE_SNAPSHOT" },
    );
    const after = await fixture.call("xsxb_get_animation", { animation_id: "walk" });
    assert.equal(after.frameCount, 2);
    return verdict("xsxb_reorganize_frames", "ready", "public reorder; missing and stale snapshots refused");
  },

  async xsxb_replace_frame(fixture) {
    await importSequence(fixture, "walk");
    const width = 4;
    const height = 4;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let offset = 0; offset < rgba.length; offset += 4) rgba.set([255, 0, 0, 255], offset);
    const replacementPath = path.join(fixture.root, "replacement.png");
    fs.writeFileSync(replacementPath, encodePngRgba(rgba, width, height));
    const replaced = await fixture.call("xsxb_replace_frame", {
      animation_id: "walk",
      frame: 0,
      file_path: replacementPath,
      sync: false,
    });
    const readBack = await fixture.call("xsxb_get_animation", { animation_id: "walk" });
    if (
      replaced.sizeChanged !== true ||
      replaced.newSize.width !== 4 ||
      readBack.animation.frames[0].width !== 4 ||
      !replaced.warnings.length
    ) {
      return verdict("xsxb_replace_frame", "fail", JSON.stringify({ replaced, readBack }));
    }
    return verdict("xsxb_replace_frame", "ready", "swaps pixels and refreshes stored frame size");
  },

  async xsxb_shift_frames(fixture) {
    const directory = path.join(fixture.root, "shift-seq");
    fs.mkdirSync(directory, { recursive: true });
    const width = 8;
    const height = 8;
    const rgba = new Uint8ClampedArray(width * height * 4);
    rgba.set([210, 36, 42, 255], ((height - 2) * width + 3) * 4);
    fs.writeFileSync(path.join(directory, "01.png"), encodePngRgba(rgba, width, height));
    fs.writeFileSync(path.join(directory, "02.png"), encodePngRgba(rgba, width, height));
    await fixture.call("xsxb_import_animation", {
      source: "png_sequence",
      directory,
      animation_id: "walk",
    });
    const shifted = await fixture.call("xsxb_shift_frames", {
      animation_id: "walk",
      frames: [{ frame: 0, dx: 0, dy: 1 }],
      sync: false,
    });
    if (shifted.shifted[0]?.dy !== 1 || shifted.shifted[0]?.width !== 8) {
      return verdict("xsxb_shift_frames", "fail", JSON.stringify(shifted));
    }
    return verdict("xsxb_shift_frames", "ready", "translates one workspace PNG by integer pixels");
  },

  async xsxb_plant_feet(fixture) {
    const directory = path.join(fixture.root, "plant-seq");
    fs.mkdirSync(directory, { recursive: true });
    const width = 16;
    const height = 16;
    const bodyH = 8;
    const rgba = new Uint8ClampedArray(width * height * 4);
    const left = 4;
    const top = height - bodyH - 2;
    for (let y = top; y < top + bodyH; y += 1) {
      for (let x = left; x < left + 4; x += 1) {
        rgba.set([210, 36, 42, 255], (y * width + x) * 4);
      }
    }
    fs.writeFileSync(path.join(directory, "01.png"), encodePngRgba(rgba, width, height));
    fs.writeFileSync(path.join(directory, "02.png"), encodePngRgba(rgba, width, height));
    await fixture.call("xsxb_import_animation", {
      source: "png_sequence",
      directory,
      animation_id: "walk",
    });
    const preview = await fixture.call("xsxb_plant_feet", {
      animation_id: "walk",
      dry_run: true,
    });
    const planted = await fixture.call("xsxb_plant_feet", {
      animation_id: "walk",
      apply: true,
    });
    if (
      preview.applied !== false ||
      planted.applied !== true ||
      planted.frames[0]?.targetY !== -1 ||
      planted.frames[0]?.dy < 1
    ) {
      return verdict("xsxb_plant_feet", "fail", JSON.stringify({ preview, planted }));
    }
    return verdict(
      "xsxb_plant_feet",
      "ready",
      `dy=${planted.frames[0].dy} targetY=${planted.frames[0].targetY}`,
    );
  },

  async xsxb_compress_frames(fixture) {
    const directory = path.join(fixture.root, "walk-seq");
    fs.mkdirSync(directory, { recursive: true });
    const rgba = new Uint8ClampedArray(24 * 16 * 4);
    for (let offset = 0; offset < rgba.length; offset += 4) {
      rgba.set([offset % 250, 40, 200, 255], offset);
    }
    const bulky = encodePngRgba(rgba, 24, 16, { level: 0 });
    fs.writeFileSync(path.join(directory, "01.png"), bulky);
    fs.writeFileSync(path.join(directory, "02.png"), bulky);
    await fixture.call("xsxb_import_animation", {
      source: "png_sequence",
      directory,
      animation_id: "walk",
      fps: 12,
    });
    const preview = await fixture.call("xsxb_compress_frames", {
      animation_id: "walk",
      dry_run: true,
    });
    const written = await fixture.call("xsxb_compress_frames", { animation_id: "walk" });
    if (
      preview.frameCount !== 2 ||
      written.frameCount !== 2 ||
      preview.dryRun !== true ||
      written.dryRun !== false ||
      written.bytesAfter > written.bytesBefore
    ) {
      return verdict("xsxb_compress_frames", "fail", JSON.stringify({ preview, written }));
    }
    return verdict("xsxb_compress_frames", "ready", "dry_run then lossless rewrite");
  },

  async xsxb_delete_animation(fixture) {
    await importSequence(fixture, "walk");
    const preview = await fixture.call("xsxb_delete_animation", {
      animation_id: "walk",
      dry_run: true,
    });
    const still = await fixture.call("xsxb_get_animation", { animation_id: "walk" });
    const removed = await fixture.call("xsxb_delete_animation", { animation_id: "walk" });
    if (preview.deleted !== false || still.frameCount !== 2 || removed.deleted !== true) {
      return verdict("xsxb_delete_animation", "fail", JSON.stringify({ preview, still, removed }));
    }
    return verdict("xsxb_delete_animation", "ready", "dry_run then delete");
  },

  async xsxb_sync_godot(fixture) {
    await importSequence(fixture, "walk");
    const synced = await fixture.call("xsxb_sync_godot", { project_id: "usable" });
    if (synced.ok !== true || synced.requested !== true) {
      return verdict("xsxb_sync_godot", "fail", JSON.stringify(synced));
    }
    return verdict("xsxb_sync_godot", "ready", "syncs a bound Godot root");
  },

  async xsxb_validate_project(fixture) {
    await importSequence(fixture, "walk");
    const standalone = await fixture.call("xsxb_validate_project", { layer: "standalone" });
    if (!standalone.layers || !standalone.layers.standalone) {
      return verdict("xsxb_validate_project", "fail", JSON.stringify(standalone));
    }
    return verdict("xsxb_validate_project", "ready", `layer=${standalone.layer} ok=${standalone.ok}`);
  },

  async xsxb_cutout(fixture) {
    const directory = path.join(fixture.root, "green-seq");
    writeGreenSequence(directory);
    await fixture.call("xsxb_import_animation", {
      source: "png_sequence",
      directory,
      animation_id: "slash",
    });
    const observed = await fixture.request("xsxb_get_animation", { animation_id: "slash" });
    const cut = await fixture.call("xsxb_cutout", {
      animation_id: "slash",
      basis_snapshot_id: observed.observation.snapshotId,
    });
    const full = await fixture.call("xsxb_get_animation", {
      animation_id: "slash",
      frames: "full",
    });
    const idle = decodePngRgba(full.animation.frames[0].absolutePath);
    const hit = decodePngRgba(full.animation.frames[1].absolutePath);
    const idleFeet = subjectAnchor(idle.data, idle.width, idle.height);
    const hitFeet = subjectAnchor(hit.data, hit.width, hit.height);
    const fresh = await fixture.request("xsxb_get_animation", { animation_id: "slash" });
    const again = await fixture.call("xsxb_cutout", {
      animation_id: "slash",
      basis_snapshot_id: fresh.observation.snapshotId,
      protected_colors: ["#d2242a"],
    });
    if (
      cut.pipeline !== "smart_product" ||
      idle.data[3] > 16 ||
      idleFeet.feetY !== hitFeet.feetY ||
      again.skippedFrameCount !== 2
    ) {
      return verdict("xsxb_cutout", "fail", JSON.stringify({ cut, again, idleFeet, hitFeet }));
    }
    return verdict(
      "xsxb_cutout",
      "ready",
      `pipeline=${cut.pipeline} skipped=${again.skippedFrameCount} feet=${idleFeet.feetY}`,
    );
  },

  async xsxb_plan_smear(fixture) {
    const planned = await fixture.call("xsxb_plan_smear", {
      animation_id: "walk",
      motion: "head scoops upward from H8 through G5 to D1",
      path_kind: "polyline",
      color: "#DC2E2E",
      frames: [
        { index: 3, start: "H8", end: "H7", head: "H8", weight: "faint" },
        { index: 4, start: "H8", end: "G4", head: "G5", weight: "solid" },
      ],
    });
    if (
      !String(planned.brief || "").includes("scoops upward") ||
      planned.useMesh !== false ||
      planned.frames.length !== 2
    ) {
      return verdict("xsxb_plan_smear", "fail", JSON.stringify(planned));
    }
    return verdict("xsxb_plan_smear", "ready", "compiles a clip-specific smear brief");
  },

  async xsxb_add_attack_trail(fixture) {
    await importSequence(fixture, "walk");
    const trail = await fixture.call("xsxb_add_attack_trail", {
      animation_id: "walk",
      id: "slash_arc",
      name: "Slash Arc",
      color: "#88ccff",
      start_frame: 0,
      end_frame: 1,
      sticks: [
        { frame: 0, top: { x: -10, y: -20 }, bottom: { x: 10, y: 4 } },
        { frame: 1, top: { x: 12, y: -18 }, bottom: { x: -8, y: 6 } },
      ],
      sync: false,
    });
    if (
      trail.segment?.id !== "slash_arc" ||
      trail.segment.color !== "#88ccff" ||
      trail.segment.sticks.length !== 2
    ) {
      return verdict("xsxb_add_attack_trail", "fail", JSON.stringify(trail));
    }
    return verdict(
      "xsxb_add_attack_trail",
      "ready",
      `id=${trail.segment.id} sticks=${trail.segment.sticks.length}`,
    );
  },

  async xsxb_add_attachment(fixture) {
    await importSequence(fixture, "walk");
    const filePath = path.join(fixture.root, "spark.png");
    fs.writeFileSync(filePath, ONE_PIXEL_PNG);
    const attachment = await fixture.call("xsxb_add_attachment", {
      animation_id: "walk",
      file_path: filePath,
      frame: 0,
      layer: "above",
      scale: 0.5,
      sync: false,
    });
    if (
      !String(attachment.binding?.path || "").includes("attachments") ||
      attachment.binding.name !== "spark.png"
    ) {
      return verdict("xsxb_add_attachment", "fail", JSON.stringify(attachment));
    }
    return verdict("xsxb_add_attachment", "ready", `path=${attachment.binding.path}`);
  },

  async xsxb_add_sfx(fixture) {
    await importSequence(fixture, "walk");
    const filePath = path.join(fixture.root, "hit.wav");
    fs.writeFileSync(filePath, createTestWav());
    const sfx = await fixture.call("xsxb_add_sfx", {
      animation_id: "walk",
      file_path: filePath,
      frame: 0,
      sync: false,
    });
    if (sfx.binding?.name !== "hit.wav" || sfx.binding.type !== "audio/wav" || !sfx.binding.path) {
      return verdict("xsxb_add_sfx", "fail", JSON.stringify(sfx));
    }
    return verdict("xsxb_add_sfx", "ready", `path=${sfx.binding.path}`);
  },

  async xsxb_remove_binding(fixture) {
    await importSequence(fixture, "walk");
    const filePath = path.join(fixture.root, "hit.wav");
    fs.writeFileSync(filePath, createTestWav());
    await fixture.call("xsxb_add_sfx", {
      animation_id: "walk",
      file_path: filePath,
      frame: 0,
      id: "hit",
      sync: false,
    });
    const preview = await fixture.call("xsxb_remove_binding", {
      kind: "sfx",
      id: "hit",
      dry_run: true,
      sync: false,
    });
    const removed = await fixture.call("xsxb_remove_binding", {
      kind: "sfx",
      id: "hit",
      sync: false,
    });
    const readBack = await fixture.call("xsxb_get_animation", {
      animation_id: "walk",
      include: ["sfx"],
    });
    if (preview.dryRun !== true || removed.removedCount !== 1 || readBack.sfx.length !== 0) {
      return verdict("xsxb_remove_binding", "fail", JSON.stringify({ preview, removed, readBack }));
    }
    return verdict("xsxb_remove_binding", "ready", "dry_run previews; removal reads back empty");
  },

  async xsxb_export_gif(fixture) {
    const jobs = fixture.gifJobs;
    await importSequence(fixture, "walk");
    await fixture.call("xsxb_update_timing", { animation_id: "walk", frame: 1, duration_ms: 500 });
    const exported = await fixture.call("xsxb_export_gif", { animation_id: "walk" });
    if (
      exported.frameCount !== 2 ||
      exported.fps !== 12 ||
      !exported.outputPath.endsWith(".gif") ||
      !fs.existsSync(exported.outputPath) ||
      jobs[0].durations[0].toFixed(3) !== "0.083" ||
      jobs[0].durations[1].toFixed(3) !== "0.500"
    ) {
      return verdict("xsxb_export_gif", "fail", JSON.stringify({ exported, jobs }));
    }
    return verdict(
      "xsxb_export_gif",
      "ready",
      `wrote ${exported.outputPath.split("/").pop()} honoring per-frame durations`,
      "GIF encoder is stubbed; codec quality is not checked.",
    );
  },

  async xsxb_export_sheet(fixture) {
    const directory = path.join(fixture.root, "sheet-seq");
    fs.mkdirSync(directory, { recursive: true });
    const canvas = 16;
    for (const name of ["01.png", "02.png"]) {
      const rgba = new Uint8ClampedArray(canvas * canvas * 4);
      for (let y = 7; y < 15; y += 1) {
        for (let x = 6; x < 10; x += 1) {
          rgba.set([210, 36, 42, 255], (y * canvas + x) * 4);
        }
      }
      fs.writeFileSync(path.join(directory, name), encodePngRgba(rgba, canvas, canvas));
    }
    await fixture.call("xsxb_import_animation", {
      source: "png_sequence",
      directory,
      animation_id: "walk",
    });
    const exported = await fixture.call("xsxb_export_sheet", {
      animation_id: "walk",
      cell: 32,
      pad: 2,
      columns: 2,
    });
    if (
      exported.frameCount !== 2 ||
      exported.columns !== 2 ||
      exported.grid.enabled !== true ||
      exported.grid.overlayOnly !== true ||
      exported.grid.originLabel?.text !== "0,0" ||
      exported.grid.anchorMode !== "canvas_bottom_center" ||
      !exported.outputPath.endsWith("_sheet.png") ||
      !fs.existsSync(exported.outputPath)
    ) {
      return verdict("xsxb_export_sheet", "fail", JSON.stringify(exported));
    }
    return verdict("xsxb_export_sheet", "ready", `wrote ${exported.outputPath.split("/").pop()}`);
  },

  async xsxb_measure_image(fixture) {
    const width = 16;
    const height = 32;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 2; y <= 28; y += 1) {
      const taper = y < 10 ? 0 : y < 20 ? 1 : 2;
      for (let x = 7 - taper; x <= 8 + taper; x += 1) {
        rgba.set([180, 180, 190, 255], (y * width + x) * 4);
      }
    }
    const filePath = path.join(fixture.root, "blade.png");
    fs.writeFileSync(filePath, encodePngRgba(rgba, width, height));
    const measured = await fixture.call("xsxb_measure_image", {
      file_path: filePath,
      t: 2 / 3,
    });
    if (
      !(measured.tip.y < measured.pommel.y) ||
      measured.t !== 2 / 3 ||
      !measured.fractions["2/3"] ||
      measured.localFromCenter.y !== measured.at.y - height / 2
    ) {
      return verdict("xsxb_measure_image", "fail", JSON.stringify(measured));
    }
    return verdict(
      "xsxb_measure_image",
      "ready",
      `t=${measured.t} tipY=${measured.tip.y} pommelY=${measured.pommel.y}`,
    );
  },

  async xsxb_detect_regions(fixture) {
    const width = 32;
    const height = 32;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 6; y < 27; y += 1) {
      for (let x = 12; x < 20; x += 1) rgba.set([70, 90, 180, 255], (y * width + x) * 4);
    }
    const filePath = path.join(fixture.root, "detect-regions.png");
    fs.writeFileSync(filePath, encodePngRgba(rgba, width, height));
    const receipt = await fixture.call("xsxb_detect_regions", {
      file_path: filePath,
      provider: "code",
      targets: ["subject"],
    });
    if (
      !receipt.candidates.some((candidate) => candidate.hypothesis === "subject") ||
      !fs.existsSync(receipt.overlayPath)
    ) {
      return verdict("xsxb_detect_regions", "fail", JSON.stringify(receipt));
    }
    return verdict("xsxb_detect_regions", "ready", `code candidates=${receipt.candidates.length}`);
  },

  async xsxb_overlay_grid(fixture) {
    const width = 32;
    const height = 32;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let offset = 0; offset < rgba.length; offset += 4) rgba.set([236, 232, 220, 255], offset);
    for (let y = 8; y < 24; y += 1) {
      for (let x = 8; x < 24; x += 1) rgba.set([40, 80, 200, 255], (y * width + x) * 4);
    }
    const filePath = path.join(fixture.root, "overlay.png");
    fs.writeFileSync(filePath, encodePngRgba(rgba, width, height));
    const receipt = await fixture.call("xsxb_overlay_grid", { file_path: filePath });
    const overlay = decodePngRgba(receipt.overlay_path);
    let labeled = false;
    for (let offset = 0; offset < overlay.data.length; offset += 4) {
      if (
        overlay.data[offset] === 255 &&
        overlay.data[offset + 1] === 214 &&
        overlay.data[offset + 2] === 10 &&
        overlay.data[offset + 3] === 255
      ) {
        labeled = true;
        break;
      }
    }
    const cellA1 = receipt.cells && receipt.cells.A1;
    const cellOk = cellA1 && cellA1.id === "A1" && cellA1.x1 === undefined;
    if (receipt.view.width !== 32 || !cellOk || !fs.existsSync(receipt.overlay_path) || !labeled) {
      return verdict("xsxb_overlay_grid", "fail", JSON.stringify(receipt));
    }
    return verdict("xsxb_overlay_grid", "ready", `overlay ${path.basename(receipt.overlay_path)}`);
  },

  async xsxb_plan_place(fixture) {
    const targetPath = path.join(fixture.root, "plan-place-target.png");
    const objectPath = path.join(fixture.root, "plan-place-object.png");
    const pixel = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    fs.writeFileSync(targetPath, pixel);
    fs.writeFileSync(objectPath, pixel);
    const planned = await fixture.call("xsxb_plan_place", {
      target_path: targetPath,
      object_path: objectPath,
      intent: "Composite object onto target at named contact patches",
      read: {
        target_contact: "opaque contact on target",
        object_contact: "opaque contact on object",
        target_cells: ["E5"],
        object_cells: ["C4"],
      },
      physics: ["Contact opaque centroids coincide", "Composite only — do not redraw"],
      accept: ["verify_overlay shows contact patches overlapping"],
      plan: [
        "overlay both images",
        "place with snap alpha_centroid",
        "inspect verify_overlay_path",
        "nudge only if accept fails",
      ],
    });
    if (!String(planned.brief || "").includes("alpha_centroid") || planned.next !== "place") {
      return verdict("xsxb_plan_place", "fail", JSON.stringify(planned));
    }
    return verdict("xsxb_plan_place", "ready", "compiles a still-image place brief");
  },

  async xsxb_place_image(fixture) {
    const target = new Uint8ClampedArray(32 * 32 * 4);
    const object = new Uint8ClampedArray(16 * 16 * 4);
    for (let offset = 0; offset < target.length; offset += 4) target.set([236, 232, 220, 255], offset);
    for (let y = 4; y < 12; y += 1) {
      for (let x = 4; x < 12; x += 1) object.set([20, 180, 60, 255], (y * 16 + x) * 4);
    }
    const targetPath = path.join(fixture.root, "place-target.png");
    const objectPath = path.join(fixture.root, "place-object.png");
    fs.writeFileSync(targetPath, encodePngRgba(target, 32, 32));
    fs.writeFileSync(objectPath, encodePngRgba(object, 16, 16));
    const overlay = await fixture.call("xsxb_overlay_grid", { file_path: targetPath, rows: 8, cols: 8 });
    const view = overlay.view;
    const placeArgs = {
      target_path: targetPath,
      object_path: objectPath,
      target_anchor: { view, overlay_id: overlay.overlay_id, cells: ["D4"], derive: "center" },
      object_anchor: { mode: "alpha_center" },
      scale: { mode: "none" },
    };
    await assert.rejects(
      fixture.call("xsxb_place_image", {
        ...placeArgs,
        target_anchor: { view, cells: ["D4"], derive: "center" },
      }),
      { code: "MISSING_OVERLAY" },
    );
    const placed = await fixture.call("xsxb_place_image", placeArgs);
    const committed = fs.readFileSync(placed.output_path);
    target[0] = 235;
    fs.writeFileSync(targetPath, encodePngRgba(target, 32, 32));
    await assert.rejects(fixture.call("xsxb_place_image", placeArgs), { code: "STALE_OVERLAY" });
    assert.deepEqual(
      fs.readFileSync(placed.output_path),
      committed,
      "stale overlay cannot overwrite the composite",
    );
    if (!fs.existsSync(placed.output_path) || placed.rotation !== 0) {
      return verdict("xsxb_place_image", "fail", JSON.stringify(placed));
    }
    return verdict("xsxb_place_image", "ready", `placed ${path.basename(placed.output_path)}`);
  },
};

const OPEN_TUNER_OPTIONS = {
  probeTunerImpl: async () => false,
  launchTunerImpl: async () => ({ pid: 4242 }),
};

/**
 * Checks the public launch request with a stubbed Tuner process.
 * @param {object} fixture Isolated public client.
 * @returns {Promise<object>} Usability verdict.
 */
async function probeOpenTuner(fixture) {
  await importSequence(fixture, "walk");
  const opened = await fixture.call("xsxb_open_tuner", { animation_id: "walk" });
  if (!opened.launched || opened.pid !== 4242 || !opened.url.includes("walk")) {
    return verdict("xsxb_open_tuner", "fail", JSON.stringify(opened));
  }
  return verdict("xsxb_open_tuner", "ready", `launch request pid=${opened.pid}`, "Tuner process is stubbed.");
}

/**
 * Audits every catalogued MCP tool in isolation.
 * @returns {Promise<{catalog:string[],missing:string[],results:object[],counts:object}>}
 */
async function runUsabilityAudit() {
  const catalog = toolDefinitions().map((tool) => tool.name);
  const missing = MCP_TOOL_NAMES.filter((name) => !PROBES[name]);
  const extra = catalog.filter((name) => !MCP_TOOL_NAMES.includes(name));
  const results = [];
  for (const name of MCP_TOOL_NAMES) {
    const probe = PROBES[name];
    if (!probe) {
      results.push(verdict(name, "fail", "no isolated probe registered"));
      continue;
    }
    results.push(await isolate(name, probe, name === "xsxb_open_tuner" ? OPEN_TUNER_OPTIONS : {}));
  }
  const counts = { ready: 0, limited: 0, stub: 0, fail: 0 };
  for (const row of results) counts[row.status] += 1;
  return { transport: "tools/call", catalog, missing, extra, results, counts };
}

/**
 * Formats the audit as a markdown table.
 * @param {object} audit Audit payload.
 * @returns {string} Markdown report.
 */
function formatReport(audit) {
  const lines = [
    "# XSXB MCP tool usability",
    "",
    `ready ${audit.counts.ready} · limited ${audit.counts.limited} · stub ${audit.counts.stub} · fail ${audit.counts.fail}`,
    "",
    "| Tool | Status | Evidence | Gap |",
    "| --- | --- | --- | --- |",
  ];
  for (const row of audit.results) {
    lines.push(
      `| \`${row.tool}\` | ${row.status} | ${row.evidence.replace(/\|/g, "/")} | ${row.gap.replace(/\|/g, "/")} |`,
    );
  }
  if (audit.missing.length) lines.push("", `Unprobed catalog tools: ${audit.missing.join(", ")}`);
  return `${lines.join("\n")}\n`;
}

async function main() {
  const audit = await runUsabilityAudit();
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
  } else {
    process.stdout.write(formatReport(audit));
  }
  process.exitCode = audit.counts.fail > 0 ? 1 : 0;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { formatReport, runUsabilityAudit };
