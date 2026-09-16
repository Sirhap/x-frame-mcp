"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createProjectStore } = require("../project_store");
const { createXsxbMcpService } = require("../xsxb_mcp_service");
const { decodePngRgba, encodePngRgba } = require("../xsxb_mcp_cutout");
const { parseGroupPoint, requireFps } = require("../xsxb_mcp_arguments");
const { encodeGifWithFfmpeg } = require("../xsxb_mcp_processes");
const { handleMessage } = require("../xsxb_mcp_server");
const { canvasAnchor, measureLongAxis } = require("../xsxb_mcp_visual_qa");

const TRAIL_PRESET = path.join(
  __dirname,
  "../animation_tuner/public/presets/attack_trails/dynamic_trail_luma.png",
);

/**
 * Builds a square opaque PNG of one color.
 * @param {number} size Edge length in pixels.
 * @param {number[]} [color] RGBA color.
 * @returns {Buffer} Encoded PNG.
 */
function solidPng(size, color = [200, 40, 40, 255]) {
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) rgba.set(color, offset);
  return encodePngRgba(rgba, size, size);
}

/**
 * Builds an already-cut frame: transparent border, opaque interior.
 * @param {number} size Edge length in pixels.
 * @returns {Buffer} Encoded PNG.
 */
function cutBodyPng(size) {
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let y = 1; y < size - 1; y += 1) {
    for (let x = 1; x < size - 1; x += 1) {
      rgba.set([210, 36, 42, 255], (y * size + x) * 4);
    }
  }
  return encodePngRgba(rgba, size, size);
}

/**
 * Builds a 64×64 cut frame: transparent field plus a red torso.
 * @returns {Buffer} Encoded PNG.
 */
function slashBodyPng() {
  const width = 64;
  const height = 64;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 20; y < 56; y += 1) {
    for (let x = 28; x < 36; x += 1) {
      rgba.set([200, 40, 40, 255], (y * width + x) * 4);
    }
  }
  return encodePngRgba(rgba, width, height);
}

/**
 * Counts gold-tint pixels that a solid #ffe082 trail mesh must produce.
 * @param {Uint8ClampedArray|Buffer} rgba Pixel buffer.
 * @returns {number} Matching pixels.
 */
function isGoldPixel(rgba, offset) {
  return (
    rgba[offset + 3] >= 32 &&
    rgba[offset] > 180 &&
    rgba[offset + 1] > 140 &&
    rgba[offset + 2] < 190 &&
    rgba[offset + 1] > rgba[offset + 2]
  );
}

function countGoldPixels(rgba) {
  let count = 0;
  for (let offset = 0; offset < rgba.length; offset += 4) {
    if (isGoldPixel(rgba, offset)) count += 1;
  }
  return count;
}

/**
 * Counts gold pixels inside a box. Used to prove a rotating slash leaves a
 * smear behind the blade instead of filling the whole pie.
 * @param {Uint8ClampedArray|Buffer} rgba Pixel buffer.
 * @param {number} width Image width.
 * @param {number} x0 Inclusive left.
 * @param {number} y0 Inclusive top.
 * @param {number} x1 Exclusive right.
 * @param {number} y1 Exclusive bottom.
 * @returns {number} Matching pixels.
 */
function countGoldInBox(rgba, width, x0, y0, x1, y1) {
  let count = 0;
  const height = rgba.length / 4 / width;
  for (let y = Math.max(0, y0); y < Math.min(height, y1); y += 1) {
    for (let x = Math.max(0, x0); x < Math.min(width, x1); x += 1) {
      if (isGoldPixel(rgba, (y * width + x) * 4)) count += 1;
    }
  }
  return count;
}

function fixture(serviceOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-mcp-media-"));
  const godotRoot = path.join(root, "godot");
  fs.mkdirSync(godotRoot, { recursive: true });
  fs.writeFileSync(path.join(godotRoot, "project.godot"), '[application]\nconfig/name="Media"\n');
  const presetPath = path.join(
    root,
    "tools/animation_tuner/public/presets/attack_trails/dynamic_trail_luma.png",
  );
  fs.mkdirSync(path.dirname(presetPath), { recursive: true });
  fs.copyFileSync(TRAIL_PRESET, presetPath);
  const store = createProjectStore(root);
  store.addProject({ id: "media", label: "Media", projectRoot: godotRoot });
  const sequenceDir = path.join(root, "seq");
  fs.mkdirSync(sequenceDir);
  fs.writeFileSync(path.join(sequenceDir, "a.png"), solidPng(16));
  fs.writeFileSync(path.join(sequenceDir, "b.png"), solidPng(16, [40, 200, 40, 255]));
  return {
    root,
    store,
    sequenceDir,
    workspaceDir: store.projectWorkspaceDir(store.readRegistry().projects[0]),
    service: createXsxbMcpService({ root, ...serviceOptions }),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Imports a three-frame slash with a gold blade that translates across the canvas.
 * @param {object} [serviceOptions] Service overrides.
 * @returns {Promise<object>} Fixture plus animation id.
 */
async function importedSlash(serviceOptions = {}) {
  const current = fixture(serviceOptions);
  fs.writeFileSync(path.join(current.sequenceDir, "a.png"), slashBodyPng());
  fs.writeFileSync(path.join(current.sequenceDir, "b.png"), slashBodyPng());
  fs.writeFileSync(path.join(current.sequenceDir, "c.png"), slashBodyPng());
  await current.service.call("xsxb_import_animation", {
    source: "png_sequence",
    directory: current.sequenceDir,
    project_id: "media",
    animation_id: "slash",
  });
  await current.service.call("xsxb_add_attack_trail", {
    animation_id: "slash",
    id: "gold_cleave",
    color: "#ffe082",
    sticks: [
      { frame: 0, top: { x: -22, y: -40 }, bottom: { x: -22, y: -16 }, layer: "front" },
      { frame: 1, top: { x: 0, y: -48 }, bottom: { x: 0, y: -18 }, layer: "front" },
      { frame: 2, top: { x: 22, y: -40 }, bottom: { x: 22, y: -16 }, layer: "front" },
    ],
    sync: false,
  });
  return current;
}

async function importWalk(current) {
  await current.service.call("xsxb_import_animation", {
    source: "png_sequence",
    directory: current.sequenceDir,
    project_id: "media",
    animation_id: "walk",
  });
}

/**
 * Builds an easily compressible RGBA PNG so compress_frames has bytes to save.
 * @param {number} width Pixel width.
 * @param {number} height Pixel height.
 * @returns {Buffer} PNG bytes encoded at zlib level 0.
 */
function bulkyRgbaPng(width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) {
    rgba.set([offset % 250, 40, 200, offset % 5 === 0 ? 0 : 255], offset);
  }
  return encodePngRgba(rgba, width, height, { level: 0 });
}

test("set_visual_transform writes character, group, and frame levels with clear support", async () => {
  const current = fixture();
  try {
    await importWalk(current);
    const character = await current.service.call("xsxb_set_visual_transform", {
      level: "character",
      visual_size: 0.25,
    });
    assert.equal(character.space, "group");
    assert.equal(character.values["profiles.mcp_imports.character.visual_size"], 0.25);

    await current.service.call("xsxb_set_visual_transform", {
      level: "group",
      visual_size: 2,
      offset_x: 10,
      rotation: 0.5,
    });
    const partialOffset = await current.service.call("xsxb_set_visual_transform", {
      level: "group",
      offset_y: -3,
    });
    assert.equal(
      partialOffset.values["profiles.mcp_imports.groups.walk.offset"].x,
      10,
      "offset merge keeps the earlier x",
    );

    await current.service.call("xsxb_set_visual_transform", {
      level: "frame",
      frame: 1,
      visual_size: 1.5,
      offset_x: 2,
    });

    const readBack = await current.service.call("xsxb_get_animation", { include: ["visual"] });
    assert.equal(readBack.visual.character.visual_size, 0.25);
    assert.equal(readBack.visual.group.visual_size, 2);
    assert.deepEqual(readBack.visual.group.offset, { x: 10, y: -3 });
    assert.equal(readBack.visual.group.rotation, 0.5);
    assert.equal(readBack.visual.frameOverrides["1"].visual_size, 1.5);
    assert.equal(readBack.space, "group");
    assert.deepEqual(readBack.origin.group, { x: 0, y: 0 });
    assert.equal(readBack.ySign, "down");

    const cleared = await current.service.call("xsxb_set_visual_transform", {
      level: "group",
      clear: true,
    });
    assert.equal(cleared.cleared, true);
    const afterClear = await current.service.call("xsxb_get_animation", { include: ["visual"] });
    assert.equal(afterClear.visual.group.visual_size, undefined);
    assert.equal(afterClear.visual.character.visual_size, 0.25, "character level survives group clear");
    assert.equal(afterClear.visual.frameOverrides["1"].visual_size, 1.5, "frame level survives");

    await assert.rejects(
      current.service.call("xsxb_set_visual_transform", { level: "group" }),
      /at least one of visual_size/,
    );
    await assert.rejects(
      current.service.call("xsxb_set_visual_transform", { level: "frame", visual_size: 1 }),
      /frame is required/,
    );
    await assert.rejects(
      current.service.call("xsxb_set_visual_transform", { level: "group", visual_size: 0 }),
      /greater than 0/,
    );
  } finally {
    current.cleanup();
  }
});

test("replace_frame swaps the PNG, keeps tuning, and refreshes the stored size", async () => {
  const current = fixture();
  try {
    await importWalk(current);
    await current.service.call("xsxb_update_frame_boxes", {
      frame: 0,
      hurtbox: { size: { x: 7, y: 7 } },
    });
    const replacementPath = path.join(current.root, "new.png");
    fs.writeFileSync(replacementPath, solidPng(32, [0, 0, 255, 255]));

    const replaced = await current.service.call("xsxb_replace_frame", {
      frame: 0,
      file_path: replacementPath,
    });
    assert.equal(replaced.sizeChanged, true);
    assert.deepEqual(replaced.newSize, { width: 32, height: 32 });
    assert.ok(replaced.warnings.length, "size change carries a warning");

    const readBack = await current.service.call("xsxb_get_animation", { include: ["boxes"] });
    assert.equal(readBack.animation.frames[0].width, 32, "manifest size is refreshed");
    assert.equal(readBack.boxes["0"].hurtbox.size.x, 7, "box overrides survive replacement");
    const frameOnDisk = fs.readFileSync(readBack.animation.frames[0].absolutePath);
    assert.deepEqual(frameOnDisk, fs.readFileSync(replacementPath), "pixels are swapped");

    const samePath = path.join(current.root, "same.png");
    fs.writeFileSync(samePath, solidPng(32));
    const again = await current.service.call("xsxb_replace_frame", { frame: 0, file_path: samePath });
    assert.equal(again.sizeChanged, false);
    assert.equal(again.warnings.length, 0);

    fs.writeFileSync(path.join(current.root, "not-png.png"), "plain text");
    await assert.rejects(
      current.service.call("xsxb_replace_frame", {
        frame: 0,
        file_path: path.join(current.root, "not-png.png"),
      }),
      /valid PNG/,
    );
    await assert.rejects(
      current.service.call("xsxb_replace_frame", { frame: 99, file_path: replacementPath }),
      /Frame must be an integer/,
    );
  } finally {
    current.cleanup();
  }
});

test("compress_frames reencodes stored PNGs losslessly and dry_run does not write", async () => {
  const current = fixture();
  try {
    const bulky = bulkyRgbaPng(24, 16);
    fs.writeFileSync(path.join(current.sequenceDir, "a.png"), bulky);
    fs.writeFileSync(path.join(current.sequenceDir, "b.png"), bulky);
    await importWalk(current);
    const animation = await current.service.call("xsxb_get_animation", { animation_id: "walk" });
    const firstPath = animation.animation.frames[0].absolutePath;
    const sizeBefore = fs.statSync(firstPath).size;
    const preview = await current.service.call("xsxb_compress_frames", {
      animation_id: "walk",
      dry_run: true,
    });
    assert.equal(preview.dryRun, true);
    assert.ok(preview.savedBytes > 0);
    assert.equal(fs.statSync(firstPath).size, sizeBefore);
    const originalPixels = decodePngRgba(firstPath).data;
    const written = await current.service.call("xsxb_compress_frames", {
      animation_id: "walk",
      dry_run: false,
    });
    assert.ok(written.rewritten >= 1);
    assert.ok(written.bytesAfter < written.bytesBefore);
    assert.deepEqual(
      Buffer.from(decodePngRgba(firstPath).data),
      Buffer.from(originalPixels),
      "pixels stay identical",
    );
    assert.ok(fs.statSync(firstPath).size < sizeBefore);
    const again = await current.service.call("xsxb_compress_frames", {
      animation_id: "walk",
      dry_run: false,
    });
    assert.equal(again.rewritten, 0);
  } finally {
    current.cleanup();
  }
});

test("compress_frames start_frame/end_frame only rewrites the selected slice", async () => {
  const current = fixture();
  try {
    const bulky = bulkyRgbaPng(24, 16);
    fs.writeFileSync(path.join(current.sequenceDir, "a.png"), bulky);
    fs.writeFileSync(path.join(current.sequenceDir, "b.png"), bulky);
    await importWalk(current);
    const animation = await current.service.call("xsxb_get_animation", { animation_id: "walk" });
    const firstPath = animation.animation.frames[0].absolutePath;
    const secondPath = animation.animation.frames[1].absolutePath;
    const firstBefore = fs.statSync(firstPath).size;
    const secondBefore = fs.statSync(secondPath).size;
    const written = await current.service.call("xsxb_compress_frames", {
      animation_id: "walk",
      dry_run: false,
      start_frame: 1,
      end_frame: 1,
    });
    assert.equal(written.frameCount, 1);
    assert.equal(written.frames[0].index, 1);
    assert.equal(fs.statSync(firstPath).size, firstBefore);
    assert.ok(fs.statSync(secondPath).size < secondBefore);
  } finally {
    current.cleanup();
  }
});

test("compress_frames names the first missing on-disk frame instead of succeeding", async () => {
  const current = fixture();
  try {
    const bulky = bulkyRgbaPng(24, 16);
    fs.writeFileSync(path.join(current.sequenceDir, "a.png"), bulky);
    fs.writeFileSync(path.join(current.sequenceDir, "b.png"), bulky);
    await importWalk(current);
    const animation = await current.service.call("xsxb_get_animation", { animation_id: "walk" });
    const secondPath = animation.animation.frames[1].absolutePath;
    fs.rmSync(secondPath);
    await assert.rejects(
      () => current.service.call("xsxb_compress_frames", { animation_id: "walk" }),
      /missing on-disk frame 1/,
    );
    assert.equal(fs.existsSync(animation.animation.frames[0].absolutePath), true);
  } finally {
    current.cleanup();
  }
});

test("xsxb_cutout names the first missing on-disk frame instead of succeeding", async () => {
  const current = fixture();
  try {
    fs.writeFileSync(path.join(current.sequenceDir, "a.png"), solidPng(16));
    fs.writeFileSync(path.join(current.sequenceDir, "b.png"), solidPng(16, [40, 200, 40, 255]));
    await importWalk(current);
    const animation = await current.service.call("xsxb_get_animation", { animation_id: "walk" });
    const firstPath = animation.animation.frames[0].absolutePath;
    const secondPath = animation.animation.frames[1].absolutePath;
    fs.rmSync(secondPath);
    await assert.rejects(
      () => current.service.call("xsxb_cutout", { animation_id: "walk" }),
      /missing on-disk frame/,
    );
    assert.equal(fs.existsSync(firstPath), true);
  } finally {
    current.cleanup();
  }
});

test("MCP GIF defaults and relative exports land in the project .xsxb folder, not the MCP dump", async () => {
  const current = fixture({
    encodeGifImpl: async (job) => {
      fs.writeFileSync(job.outputPath, Buffer.from("GIF89a-fake"));
    },
  });
  try {
    await importWalk(current);
    const artifactDir = path.join(current.workspaceDir, ".xsxb");
    const exported = await current.service.call("xsxb_export_gif", {});
    assert.equal(path.dirname(exported.outputPath), artifactDir);
    assert.equal(path.basename(exported.outputPath), "mcp_imports_walk.gif");
    assert.equal(fs.existsSync(path.join(current.root, "exports", "mcp_imports_walk.gif")), false);
    assert.equal(fs.existsSync(path.join(current.workspaceDir, "exports", "mcp_imports_walk.gif")), false);

    const relative = await current.service.call("xsxb_export_gif", {
      output_path: "exports/from-mcp.gif",
    });
    assert.equal(relative.outputPath, path.join(artifactDir, "exports", "from-mcp.gif"));
    assert.equal(fs.existsSync(path.join(current.root, "exports", "from-mcp.gif")), false);
  } finally {
    current.cleanup();
  }
});

test("export_gif honors timing, skips disabled frames, and validates the output path", async () => {
  const jobs = [];
  const current = fixture({
    encodeGifImpl: async (job) => {
      jobs.push(job);
      fs.writeFileSync(job.outputPath, Buffer.from("GIF89a-fake"));
    },
  });
  try {
    await importWalk(current);
    await current.service.call("xsxb_update_timing", {
      frames: [
        { frame: 0, duration_ms: 250 },
        { frame: 1, disabled: true },
      ],
    });

    const exported = await current.service.call("xsxb_export_gif", {});
    assert.equal(exported.frameCount, 1, "disabled frame is skipped");
    assert.equal(exported.skippedDisabledFrames, 1);
    assert.equal(exported.totalDurationMs, 250);
    assert.ok(exported.outputPath.includes(path.join(".xsxb", "mcp_imports_walk.gif")));
    assert.ok(fs.existsSync(exported.outputPath));
    assert.equal(jobs[0].durations.length, 1);
    assert.equal(jobs[0].durations[0].toFixed(2), "0.25");

    const withDisabled = await current.service.call("xsxb_export_gif", { include_disabled: true });
    assert.equal(withDisabled.frameCount, 2);

    const customPath = path.join(current.root, "out", "preview.gif");
    const custom = await current.service.call("xsxb_export_gif", { output_path: customPath });
    assert.equal(custom.outputPath, customPath);
    assert.ok(fs.existsSync(customPath), "parent directory is created");

    // A relative output_path hangs off the project .xsxb folder rather than
    // the MCP repo or whatever directory the server happens to be running in.
    const relative = await current.service.call("xsxb_export_gif", { output_path: "previews/walk.gif" });
    assert.equal(relative.outputPath, path.join(current.workspaceDir, ".xsxb", "previews", "walk.gif"));

    await assert.rejects(
      current.service.call("xsxb_export_gif", { output_path: "/tmp/not-a-gif.png" }),
      /must end with \.gif/,
    );
    await assert.rejects(
      current.service.call("xsxb_export_gif", { start_frame: 1, end_frame: 0 }),
      /greater than or equal/,
    );
  } finally {
    current.cleanup();
  }
});

test("cutout apply_visual rematches from group and frame visual_size, not a shared scale", async () => {
  const current = fixture();
  try {
    fs.writeFileSync(path.join(current.sequenceDir, "a.png"), cutBodyPng(16));
    fs.writeFileSync(path.join(current.sequenceDir, "b.png"), cutBodyPng(16));
    await importWalk(current);
    await current.service.call("xsxb_set_visual_transform", { level: "group", visual_size: 0.5 });
    await current.service.call("xsxb_set_visual_transform", {
      level: "frame",
      frame: 1,
      visual_size: 1,
    });

    const cut = await current.service.call("xsxb_cutout", {
      output_width: 16,
      output_height: 16,
      apply_visual: true,
    });
    assert.equal(cut.rematchMode, "visual");
    assert.deepEqual(cut.frameScales, [0.5, 1]);

    const { decodePngRgba, subjectAnchor } = require("../xsxb_mcp_cutout");
    const readBack = await current.service.call("xsxb_get_animation", { frames: "full" });
    const first = decodePngRgba(readBack.animation.frames[0].absolutePath);
    const second = decodePngRgba(readBack.animation.frames[1].absolutePath);
    assert.equal(subjectAnchor(first.data, 16, 16).height, 7);
    assert.equal(subjectAnchor(second.data, 16, 16).height, 14);
    assert.equal(subjectAnchor(first.data, 16, 16).feetY, 15);
    assert.equal(subjectAnchor(second.data, 16, 16).feetY, 15);

    const visual = await current.service.call("xsxb_get_animation", { include: ["visual"] });
    assert.equal(visual.visual.group.visual_size, 1, "baked group scale is consumed");
    assert.equal(visual.visual.frameOverrides["1"], undefined, "baked frame scale is consumed");
  } finally {
    current.cleanup();
  }
});

test("export_gif rematches group and frame visual_size before encode", async () => {
  const jobs = [];
  const { decodePngRgba, subjectAnchor } = require("../xsxb_mcp_cutout");
  const current = fixture({
    encodeGifImpl: async (job) => {
      const first = decodePngRgba(job.framePaths[0]);
      let minY = first.height;
      let maxY = -1;
      for (let y = 0; y < first.height; y += 1) {
        for (let x = 0; x < first.width; x += 1) {
          const offset = (y * first.width + x) * 4;
          if (first.data[offset] === 255 && first.data[offset + 1] === 0 && first.data[offset + 2] === 255) {
            continue;
          }
          if (first.data[offset + 3] < 16) continue;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      jobs.push({
        ...job,
        firstHeight: maxY < 0 ? 0 : maxY - minY + 1,
      });
      fs.writeFileSync(job.outputPath, Buffer.from("GIF89a-fake"));
    },
  });
  try {
    fs.writeFileSync(path.join(current.sequenceDir, "a.png"), cutBodyPng(16));
    fs.writeFileSync(path.join(current.sequenceDir, "b.png"), cutBodyPng(16));
    await importWalk(current);
    await current.service.call("xsxb_set_visual_transform", { level: "group", visual_size: 0.5 });
    const exported = await current.service.call("xsxb_export_gif", {});
    assert.equal(exported.appliedVisual, true);
    assert.deepEqual(exported.frameScales, [0.5, 0.5]);
    assert.equal(jobs[0].firstHeight, 7);
    const source = (await current.service.call("xsxb_get_animation")).animation.frames[0].absolutePath;
    assert.notEqual(jobs[0].framePaths[0], source);
  } finally {
    current.cleanup();
  }
});

test("export_gif bakes the attack-trail mesh into the encoded frames", async () => {
  let encodedGold = 0;
  const current = await importedSlash({
    encodeGifImpl: async (job) => {
      const last = decodePngRgba(job.framePaths[job.framePaths.length - 1]);
      encodedGold = countGoldPixels(last.data);
      fs.writeFileSync(job.outputPath, Buffer.from("GIF89a-fake"));
    },
  });
  try {
    const source = await current.service.call("xsxb_get_animation", {
      animation_id: "slash",
      frames: "full",
    });
    assert.equal(
      countGoldPixels(decodePngRgba(source.animation.frames[2].absolutePath).data),
      0,
      "source frames stay unbaked",
    );
    const exported = await current.service.call("xsxb_export_gif", { animation_id: "slash" });
    assert.equal(exported.bakedTrails, true);
    assert.deepEqual(exported.trailIds, ["gold_cleave"]);
    assert.ok(encodedGold > 40, `encoded last frame must show the gold mesh, got ${encodedGold} pixels`);
  } finally {
    current.cleanup();
  }
});

test("export_sheet bakes the attack-trail mesh into the contact sheet", async () => {
  const current = await importedSlash();
  try {
    const source = await current.service.call("xsxb_get_animation", {
      animation_id: "slash",
      frames: "full",
    });
    const lastSource = decodePngRgba(source.animation.frames[2].absolutePath);
    assert.equal(countGoldPixels(lastSource.data), 0, "source frames stay unbaked");

    const exported = await current.service.call("xsxb_export_sheet", {
      animation_id: "slash",
      cell: 64,
      pad: 4,
      columns: 3,
      grid: false,
    });
    assert.equal(exported.bakedTrails, true);
    assert.deepEqual(exported.trailIds, ["gold_cleave"]);
    const sheet = decodePngRgba(exported.outputPath);
    const gold = countGoldPixels(sheet.data);
    assert.ok(gold > 40, `sheet must show the gold mesh, got ${gold} pixels`);
  } finally {
    current.cleanup();
  }
});

test("export_gif paints a trailing smear behind a rotating blade", async () => {
  const goldByFrame = [];
  let startArcOnLast = 0;
  let midArcOnLast = 0;
  const current = fixture({
    encodeGifImpl: async (job) => {
      for (const filePath of job.framePaths) {
        const frame = decodePngRgba(filePath);
        goldByFrame.push(countGoldPixels(frame.data));
      }
      const last = decodePngRgba(job.framePaths[job.framePaths.length - 1]);
      // Start blade is vertical at (32, 6)–(32, 50). End blade is horizontal
      // through y=28. A 拖影 sits on the mid-arc behind the blade; a filled
      // pie still paints the start tip; a 4px edge paints only the new blade.
      // The mid-arc sample is the upper-right quadrant of that sweep, not a
      // 16×16 sliver that one rasterizer can miss by a pixel.
      startArcOnLast = countGoldInBox(last.data, last.width, 30, 4, 35, 10);
      midArcOnLast = countGoldInBox(last.data, last.width, 36, 8, 60, 32);
      fs.writeFileSync(job.outputPath, Buffer.from("GIF89a-fake"));
    },
  });
  try {
    fs.writeFileSync(path.join(current.sequenceDir, "a.png"), slashBodyPng());
    fs.writeFileSync(path.join(current.sequenceDir, "b.png"), slashBodyPng());
    fs.writeFileSync(path.join(current.sequenceDir, "c.png"), slashBodyPng());
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: current.sequenceDir,
      project_id: "media",
      animation_id: "spin",
    });
    const added = await current.service.call("xsxb_add_attack_trail", {
      animation_id: "spin",
      id: "spin_cleave",
      color: "#ffe082",
      sticks: [
        { frame: 0, top: { x: 0, y: -58 }, bottom: { x: 0, y: -14 }, layer: "front" },
        { frame: 2, top: { x: 22, y: -36 }, bottom: { x: -22, y: -36 }, layer: "front" },
      ],
      sync: false,
    });
    assert.equal(added.segment.sticks[0].framePhase, 0);
    assert.equal(added.segment.sticks[1].framePhase, 1);
    assert.ok(added.edgeTravel > 28, "receipt must report the tip sweep");
    await current.service.call("xsxb_export_gif", { animation_id: "spin" });
    const startGold = goldByFrame[0];
    const endGold = goldByFrame[2];
    assert.ok(startGold > 8, `start frame must already show the smear, got ${startGold}`);
    assert.ok(endGold > 20, `end frame must show the smear, got ${endGold}`);
    assert.ok(endGold > startGold, "the smear must grow toward the tip");
    assert.ok(midArcOnLast > 6, `last frame must paint the smear behind the blade, got ${midArcOnLast}`);
    // The collapsed tail is allowed to touch the origin as a point. Anything
    // wider means the ribbon never let go of where the swing started.
    assert.ok(startArcOnLast <= 4, `last frame must not hold on to the swing origin, got ${startArcOnLast}`);
  } finally {
    current.cleanup();
  }
});

test("parseGroupPoint reads objects, strings, and arrays, and rejects other spaces", () => {
  assert.deepEqual(parseGroupPoint({ x: 40, y: -80 }), { x: 40, y: -80 });
  assert.deepEqual(parseGroupPoint("40,-80"), { x: 40, y: -80 });
  assert.deepEqual(parseGroupPoint([4, -8]), { x: 4, y: -8 });
  assert.throws(() => parseGroupPoint({ x: 1, y: 2, space: "cell" }), /space must be "group"/);
  assert.throws(() => parseGroupPoint({ x: 1, y: 2, space: "image_pixels" }), /space must be "group"/);
});

test("shift_frames from/to group points plant pixels toward the foot origin", async () => {
  const current = fixture();
  try {
    const width = 16;
    const height = 16;
    const rgba = new Uint8ClampedArray(width * height * 4);
    rgba.set([210, 36, 42, 255], (8 * width + 8) * 4);
    fs.writeFileSync(path.join(current.sequenceDir, "a.png"), encodePngRgba(rgba, width, height));
    fs.writeFileSync(path.join(current.sequenceDir, "b.png"), encodePngRgba(rgba, width, height));
    await importWalk(current);
    const animation = await current.service.call("xsxb_get_animation", { animation_id: "walk" });
    const firstPath = animation.animation.frames[0].absolutePath;
    const shifted = await current.service.call("xsxb_shift_frames", {
      animation_id: "walk",
      frames: [{ frame: 0, from: "0,-8", to: { x: 0, y: -4 } }],
    });
    assert.equal(shifted.shifted[0].dx, 0);
    assert.equal(shifted.shifted[0].dy, 4);
    assert.equal(shifted.space, "group");
    const next = decodePngRgba(firstPath);
    assert.equal(next.height, 16, "in-canvas destMaxY must not pad");
    assert.equal(shifted.shifted[0].width, 16);
    assert.equal(shifted.shifted[0].height, 16);
    assert.equal(next.data[(8 * width + 8) * 4 + 3], 0, "source pixel vacated");
    assert.equal(next.data[(12 * width + 8) * 4 + 3], 255, "marker moved down 4px");
    assert.equal(next.data[(12 * width + 8) * 4], 210);
  } finally {
    current.cleanup();
  }
});

test("update_frame_boxes min/max group corners become center offset and size", async () => {
  const current = fixture();
  try {
    await importWalk(current);
    const updated = await current.service.call("xsxb_update_frame_boxes", {
      animation_id: "walk",
      frame: 0,
      hurtbox: { min: { x: -4, y: -10 }, max: { x: 4, y: -2 } },
    });
    assert.deepEqual(updated.boxes.hurtbox.offset, { x: 0, y: -6 });
    assert.deepEqual(updated.boxes.hurtbox.size, { x: 8, y: 8 });
    assert.equal(updated.space, "group");
  } finally {
    current.cleanup();
  }
});

test("add_attachment hand plus t writes hand minus localFromCenter", async () => {
  const current = fixture();
  try {
    await importWalk(current);
    const width = 16;
    const height = 32;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 2; y <= 28; y += 1) {
      const taper = y < 10 ? 0 : y < 20 ? 1 : 2;
      for (let x = 7 - taper; x <= 8 + taper; x += 1) {
        rgba.set([180, 180, 190, 255], (y * width + x) * 4);
      }
    }
    const bladePath = path.join(current.root, "blade.png");
    fs.writeFileSync(bladePath, encodePngRgba(rgba, width, height));
    const measured = measureLongAxis(rgba, width, height, { t: 0.5 });
    const hand = { x: 12, y: -18 };
    const added = await current.service.call("xsxb_add_attachment", {
      animation_id: "walk",
      file_path: bladePath,
      frame: 0,
      hand,
      t: 0.5,
      sync: false,
    });
    assert.equal(added.space, "group");
    assert.equal(added.binding.transform.offset.x, hand.x - measured.localFromCenter.x);
    assert.equal(added.binding.transform.offset.y, hand.y - measured.localFromCenter.y);
  } finally {
    current.cleanup();
  }
});

test("copyIntoWorkspace rewrites when hash dest exists but bytes drift", async () => {
  const current = fixture();
  try {
    await importWalk(current);
    const sourcePng = solidPng(8, [40, 180, 80, 255]);
    const sourcePath = path.join(current.root, "spark.png");
    fs.writeFileSync(sourcePath, sourcePng);
    const added = await current.service.call("xsxb_add_attachment", {
      animation_id: "walk",
      file_path: sourcePath,
      id: "spark",
      frame: 0,
      sync: false,
    });
    const destPath = path.resolve(current.root, added.binding.path);
    assert.equal(fs.existsSync(destPath), true);
    const intact = fs.readFileSync(sourcePath);
    const corrupted = intact.subarray(0, Math.max(8, Math.floor(intact.length / 2)));
    fs.writeFileSync(destPath, corrupted);
    assert.equal(fs.readFileSync(destPath).equals(intact), false);
    await current.service.call("xsxb_add_attachment", {
      animation_id: "walk",
      file_path: sourcePath,
      id: "spark",
      frame: 0,
      sync: false,
    });
    const restored = fs.readFileSync(destPath);
    assert.equal(restored.equals(intact), true, "dest must match the intact source PNG");
    assert.equal(restored.equals(corrupted), false, "dest must not keep the truncated payload");
  } finally {
    current.cleanup();
  }
});

test("add_attack_trail parses string group points on sticks", async () => {
  const current = fixture();
  try {
    await importWalk(current);
    const added = await current.service.call("xsxb_add_attack_trail", {
      animation_id: "walk",
      id: "string_points",
      sticks: [
        { frame: 0, top: " -10,-20 ", bottom: [-10, -4], layer: "front" },
        { frame: 1, top: { x: 10, y: -20 }, bottom: { x: 10, y: -4 }, layer: "front" },
      ],
      sync: false,
    });
    assert.equal(added.segment.coordinateSpace, "group");
    assert.deepEqual(added.segment.sticks[0].top, { x: -10, y: -20 });
    assert.deepEqual(added.segment.sticks[0].bottom, { x: -10, y: -4 });
  } finally {
    current.cleanup();
  }
});

/**
 * Counts near-magenta pixels so scaled sheet cells still match the marker.
 * @param {Uint8ClampedArray|Buffer} rgba Pixel buffer.
 * @returns {number} Matching pixels.
 */
function countMagentaPixels(rgba) {
  let count = 0;
  for (let offset = 0; offset < rgba.length; offset += 4) {
    if (rgba[offset + 3] < 128) continue;
    if (rgba[offset] > 180 && rgba[offset + 1] < 80 && rgba[offset + 2] > 180) count += 1;
  }
  return count;
}

/**
 * Weighted centroid of magenta marker pixels in a PNG.
 * @param {string} filePath PNG path.
 * @returns {{x:number,y:number,n:number,width:number}}
 */
function magentaCentroid(filePath) {
  const decoded = decodePngRgba(filePath);
  const rgba = decoded.data;
  const width = decoded.width;
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (let offset = 0, index = 0; offset < rgba.length; offset += 4, index += 1) {
    if (rgba[offset + 3] < 128) continue;
    if (!(rgba[offset] > 180 && rgba[offset + 1] < 80 && rgba[offset + 2] > 180)) continue;
    sumX += index % width;
    sumY += Math.floor(index / width);
    count += 1;
  }
  return { x: count ? sumX / count : 0, y: count ? sumY / count : 0, n: count, width };
}

/**
 * Writes pet millisecond-clock fps and per-frame duration multipliers into the manifest.
 * @param {object} current Media fixture.
 * @param {string} animationId Animation id.
 * @param {number[]} durations Pet duration multipliers (milliseconds at fps 1000).
 * @returns {void}
 */
function patchMillisecondClock(current, animationId, durations) {
  const project = current.store.readRegistry().projects[0];
  const paths = current.store.projectPaths(project);
  const manifest = current.store.readJson(paths.manifest);
  for (const profile of manifest.profiles || []) {
    for (const animation of profile.animations || []) {
      if (String(animation.id || animation.name) !== animationId) continue;
      animation.fps = 1000;
      animation.type = "pet";
      (animation.frames || []).forEach((frame, index) => {
        frame.duration = durations[index] ?? durations[durations.length - 1] ?? 280;
      });
    }
  }
  current.store.writeJson(paths.manifest, manifest);
}

test("export_sheet bakes a magenta attachment marker instead of matching the pre-attach sheet", async () => {
  const current = fixture();
  try {
    const frameSize = 128;
    fs.writeFileSync(path.join(current.sequenceDir, "a.png"), solidPng(frameSize, [40, 80, 40, 255]));
    fs.writeFileSync(path.join(current.sequenceDir, "b.png"), solidPng(frameSize, [40, 80, 40, 255]));
    await importWalk(current);
    const before = await current.service.call("xsxb_export_sheet", {
      animation_id: "walk",
      cell: 256,
      pad: 4,
      columns: 2,
      grid: false,
    });
    const beforeBytes = fs.readFileSync(before.outputPath);
    assert.equal(countMagentaPixels(decodePngRgba(before.outputPath).data), 0);
    assert.equal(before.bakedAttachments, false);

    const markerPath = path.join(current.root, "magenta-marker.png");
    fs.writeFileSync(markerPath, solidPng(64, [255, 0, 255, 255]));
    const added = await current.service.call("xsxb_add_attachment", {
      animation_id: "walk",
      file_path: markerPath,
      id: "magenta-marker",
      frames: [
        { frame: 0, offset_x: 0, offset_y: -64, scale: 1 },
        { frame: 1, offset_x: 0, offset_y: -64, scale: 1 },
      ],
      sync: false,
    });
    assert.equal(added.updatedFrames, 2);

    const after = await current.service.call("xsxb_export_sheet", {
      animation_id: "walk",
      cell: 256,
      pad: 4,
      columns: 2,
      grid: false,
    });
    const afterBytes = fs.readFileSync(after.outputPath);
    assert.equal(after.bakedAttachments, true);
    assert.ok(after.attachmentIds.includes("magenta-marker"));
    assert.equal(afterBytes.equals(beforeBytes), false, "sheet must change after attaching the marker");
    const magenta = countMagentaPixels(decodePngRgba(after.outputPath).data);
    assert.ok(magenta > 100, `sheet must contain the magenta marker, got ${magenta} pixels`);
  } finally {
    current.cleanup();
  }
});

test("export_sheet bakes Tuner 7-part attachment keys whose metadata.animation is the clip name", async () => {
  const current = fixture();
  try {
    const frameSize = 128;
    fs.writeFileSync(path.join(current.sequenceDir, "a.png"), solidPng(frameSize, [40, 80, 40, 255]));
    fs.writeFileSync(path.join(current.sequenceDir, "b.png"), solidPng(frameSize, [40, 80, 40, 255]));
    await importWalk(current);
    const before = await current.service.call("xsxb_export_sheet", {
      animation_id: "walk",
      cell: 256,
      pad: 4,
      columns: 2,
      grid: false,
    });
    const beforeBytes = fs.readFileSync(before.outputPath);
    assert.equal(countMagentaPixels(decodePngRgba(before.outputPath).data), 0);

    const markerPath = path.join(current.root, "magenta-marker.png");
    fs.writeFileSync(markerPath, solidPng(64, [255, 0, 255, 255]));
    await current.service.call("xsxb_add_attachment", {
      animation_id: "walk",
      file_path: markerPath,
      id: "magenta-marker",
      frames: [
        { frame: 0, offset_x: 0, offset_y: -64, scale: 1 },
        { frame: 1, offset_x: 0, offset_y: -64, scale: 1 },
      ],
      sync: false,
    });
    const project = current.store.readRegistry().projects[0];
    const paths = current.store.projectPaths(project);
    const bindings = current.store.readJson(paths.frameImageAttachments, []);
    const rewritten = bindings.map((binding) => ({
      ...binding,
      key: `proj:player:hero:animation:walk:sheet.png:${binding.frame}`,
      frameKey: `proj:player:hero:animation:walk:sheet.png:${binding.frame}`,
      metadata: {
        profileId: "hero",
        animation: "walk",
        frame: binding.frame,
      },
    }));
    current.store.writeJson(paths.frameImageAttachments, rewritten);

    const after = await current.service.call("xsxb_export_sheet", {
      animation_id: "walk",
      cell: 256,
      pad: 4,
      columns: 2,
      grid: false,
    });
    const afterBytes = fs.readFileSync(after.outputPath);
    assert.equal(after.bakedAttachments, true);
    assert.ok(after.attachmentIds.includes("magenta-marker"));
    assert.equal(afterBytes.equals(beforeBytes), false, "Tuner-keyed marker must change the sheet");
    const magenta = countMagentaPixels(decodePngRgba(after.outputPath).data);
    assert.ok(magenta > 100, `sheet must contain the Tuner-keyed magenta marker, got ${magenta} pixels`);
  } finally {
    current.cleanup();
  }
});

test("export_sheet attachment bake applies owner visual_size and flipH like Tuner", async () => {
  const current = fixture();
  try {
    const frameSize = 64;
    fs.writeFileSync(path.join(current.sequenceDir, "a.png"), solidPng(frameSize, [20, 40, 20, 255]));
    fs.unlinkSync(path.join(current.sequenceDir, "b.png"));
    await importWalk(current);
    const markerPath = path.join(current.root, "magenta-marker.png");
    fs.writeFileSync(markerPath, solidPng(8, [255, 0, 255, 255]));
    await current.service.call("xsxb_add_attachment", {
      animation_id: "walk",
      file_path: markerPath,
      id: "magenta-marker",
      frames: [{ frame: 0, offset_x: 10, offset_y: -10, scale: 1 }],
      sync: false,
    });
    const exportOne = () =>
      current.service.call("xsxb_export_sheet", {
        animation_id: "walk",
        cell: frameSize,
        pad: 1,
        columns: 1,
        grid: false,
      });

    const baseline = magentaCentroid((await exportOne()).outputPath);
    assert.ok(baseline.n > 10, `baseline marker missing, n=${baseline.n}`);

    await current.service.call("xsxb_set_visual_transform", { level: "group", visual_size: 2 });
    const scaled = magentaCentroid((await exportOne()).outputPath);
    const originX = 1 + frameSize / 2;
    const originY = 1 + frameSize;
    const baseDx = baseline.x - originX;
    const scaledDx = scaled.x - originX;
    const baseDy = baseline.y - originY;
    const scaledDy = scaled.y - originY;
    assert.ok(
      Math.abs(scaledDx) > Math.abs(baseDx) * 1.5,
      `visual_size=2 must multiply offset (base dx=${baseDx.toFixed(2)} scaled dx=${scaledDx.toFixed(2)})`,
    );
    assert.ok(
      Math.abs(scaledDy) > Math.abs(baseDy) * 1.5,
      `visual_size=2 must multiply offset y (base dy=${baseDy.toFixed(2)} scaled dy=${scaledDy.toFixed(2)})`,
    );

    await current.service.call("xsxb_set_visual_transform", { level: "group", visual_size: 1 });
    const project = current.store.readRegistry().projects[0];
    const paths = current.store.projectPaths(project);
    const manifest = current.store.readJson(paths.manifest);
    const animation = manifest.profiles[0].animations[0];
    animation.flipH = true;
    current.store.writeJson(paths.manifest, manifest);
    const flipped = magentaCentroid((await exportOne()).outputPath);
    const flippedDx = flipped.x - originX;
    assert.ok(
      flippedDx * baseDx < 0,
      `flipH must mirror attachment offset x (base dx=${baseDx.toFixed(2)} flipped dx=${flippedDx.toFixed(2)})`,
    );
  } finally {
    current.cleanup();
  }
});

test("export_sheet of an fps-1000 pet clip uses millisecond durations and does not throw", async () => {
  const captured = [];
  const current = fixture({
    encodeGifImpl: async (job) => {
      captured.push(job.durations.slice());
      fs.writeFileSync(job.outputPath, Buffer.from("GIF89a-fake"));
    },
  });
  try {
    const idleMs = [280, 110, 110, 140, 140, 320];
    for (let index = 0; index < idleMs.length; index += 1) {
      fs.writeFileSync(
        path.join(current.sequenceDir, `${String(index).padStart(2, "0")}.png`),
        solidPng(16, [40, 80, 120, 255]),
      );
    }
    fs.unlinkSync(path.join(current.sequenceDir, "a.png"));
    fs.unlinkSync(path.join(current.sequenceDir, "b.png"));
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: current.sequenceDir,
      project_id: "media",
      animation_id: "idle",
    });
    patchMillisecondClock(current, "idle", idleMs);

    assert.throws(() => requireFps(1000), /between 1 and 120/);

    const sheet = await current.service.call("xsxb_export_sheet", {
      animation_id: "idle",
      cell: 32,
      pad: 2,
      columns: 6,
      grid: false,
    });
    assert.equal(sheet.frameCount, 6);
    assert.equal(sheet.fps, 1000);

    const gif = await current.service.call("xsxb_export_gif", { animation_id: "idle" });
    assert.equal(gif.fps, 1000);
    assert.equal(gif.totalDurationMs, 1100);
    assert.deepEqual(
      captured[0].map((seconds) => Math.round(seconds * 1000)),
      idleMs,
    );
    assert.notEqual(gif.totalDurationMs, Math.round((idleMs.length / 12) * 1000));
  } finally {
    current.cleanup();
  }
});

test("export_gif fps override on a pet clip keeps millisecond durations", async () => {
  const captured = [];
  const current = fixture({
    encodeGifImpl: async (job) => {
      captured.push(job.durations.slice());
      fs.writeFileSync(job.outputPath, Buffer.from("GIF89a-fake"));
    },
  });
  try {
    const idleMs = [280, 110, 110, 140, 140, 320];
    for (let index = 0; index < idleMs.length; index += 1) {
      fs.writeFileSync(
        path.join(current.sequenceDir, `${String(index).padStart(2, "0")}.png`),
        solidPng(16, [40, 80, 120, 255]),
      );
    }
    fs.unlinkSync(path.join(current.sequenceDir, "a.png"));
    fs.unlinkSync(path.join(current.sequenceDir, "b.png"));
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: current.sequenceDir,
      project_id: "media",
      animation_id: "idle",
    });
    patchMillisecondClock(current, "idle", idleMs);

    const gif = await current.service.call("xsxb_export_gif", { animation_id: "idle", fps: 12 });
    assert.equal(gif.fps, 1000);
    assert.equal(gif.totalDurationMs, 1100);
    assert.deepEqual(
      captured[0].map((seconds) => Math.round(seconds * 1000)),
      idleMs,
    );
    assert.notEqual(Math.round((captured[0][0] || 0) * 1000), Math.round((280 / 12) * 1000));
  } finally {
    current.cleanup();
  }
});

test("export_sheet 8x8 on a 320 canvas includes column 7", async () => {
  const current = fixture();
  try {
    fs.writeFileSync(path.join(current.sequenceDir, "a.png"), solidPng(320, [40, 80, 120, 255]));
    fs.writeFileSync(path.join(current.sequenceDir, "b.png"), solidPng(320, [40, 80, 120, 255]));
    await importWalk(current);
    const exported = await current.service.call("xsxb_export_sheet", {
      animation_id: "walk",
      grid_divs: "8x8",
      cell: 160,
    });
    assert.deepEqual(exported.grid.divs, { x: 8, y: 8 });
    assert.equal(exported.grid.cells.length, 8);
    assert.equal(exported.grid.cells[0].length, 8, "8×8 JSON must include col 7");
    assert.equal(exported.grid.cells[0][7].col, 7);
  } finally {
    current.cleanup();
  }
});

test("export_sheet default grid true and grid false write distinct files plus sidecar", async () => {
  const current = fixture();
  try {
    await importWalk(current);
    const withGrid = await current.service.call("xsxb_export_sheet", { animation_id: "walk" });
    const noGrid = await current.service.call("xsxb_export_sheet", {
      animation_id: "walk",
      grid: false,
    });
    assert.ok(withGrid.outputPath.endsWith("_sheet.png"), withGrid.outputPath);
    assert.ok(noGrid.outputPath.endsWith("_sheet_view.png"), noGrid.outputPath);
    assert.notEqual(withGrid.outputPath, noGrid.outputPath);
    assert.ok(fs.existsSync(withGrid.outputPath), "grid true default PNG");
    assert.ok(fs.existsSync(noGrid.outputPath), "grid false default PNG");
    assert.equal(path.basename(withGrid.outputPath), "mcp_imports_walk_sheet.png");
    assert.equal(path.basename(noGrid.outputPath), "mcp_imports_walk_sheet_view.png");

    for (const [exported, gridFlag] of [
      [withGrid, true],
      [noGrid, false],
    ]) {
      const sidecarPath = exported.outputPath.replace(/\.png$/i, ".sheet.json");
      assert.ok(fs.existsSync(sidecarPath), sidecarPath);
      const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
      assert.equal(sidecar.kind, "xsxb_contact_sheet");
      assert.equal(sidecar.schemaVersion, 1);
      assert.equal(sidecar.columns, exported.columns);
      assert.equal(sidecar.rows, exported.rows);
      assert.equal(sidecar.cell, exported.cell);
      assert.equal(sidecar.pad, exported.pad);
      assert.equal(sidecar.grid, gridFlag);
    }
  } finally {
    current.cleanup();
  }
});

test("shift_frames pads height so hanging ice is not clipped", async () => {
  const current = fixture();
  try {
    const width = 32;
    const height = 32;
    const dy = 6;
    const iceX = 16;
    const iceY = height - 1;
    const ice = [84, 190, 251, 255];
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 8; y < 20; y += 1) {
      for (let x = 12; x < 20; x += 1) {
        rgba.set([210, 36, 42, 255], (y * width + x) * 4);
      }
    }
    rgba.set(ice, (iceY * width + iceX) * 4);
    rgba.set(ice, ((iceY - 1) * width + iceX) * 4);
    fs.writeFileSync(path.join(current.sequenceDir, "a.png"), encodePngRgba(rgba, width, height));
    fs.writeFileSync(path.join(current.sequenceDir, "b.png"), encodePngRgba(rgba, width, height));
    await importWalk(current);

    const shifted = await current.service.call("xsxb_shift_frames", {
      animation_id: "walk",
      frames: [{ frame: 0, dx: 0, dy }],
    });
    const destIceY = iceY + dy;
    const expectedHeight = destIceY + 1;
    assert.equal(shifted.shifted[0].dy, dy);
    assert.equal(shifted.shifted[0].width, width);
    assert.equal(shifted.shifted[0].height, expectedHeight, "receipt height must include downward pad");

    const animation = await current.service.call("xsxb_get_animation", { animation_id: "walk" });
    const image = decodePngRgba(animation.animation.frames[0].absolutePath);
    assert.ok(image.height > height, "PNG height must grow when ice would leave the canvas");
    assert.equal(image.height, expectedHeight);
    assert.equal(image.width, width);
    assert.equal(animation.animation.frames[0].height, image.height, "manifest height must match PNG");
    assert.equal(animation.animation.frames[0].width, image.width);
    const destOffset = (destIceY * width + iceX) * 4;
    assert.equal(image.data[destOffset + 3], 255, "ice pixel must stay opaque after +dy");
    assert.equal(image.data[destOffset], ice[0]);
    assert.equal(image.data[destOffset + 1], ice[1]);
    assert.equal(image.data[destOffset + 2], ice[2]);
  } finally {
    current.cleanup();
  }
});

/**
 * Group-space delta matching `xsxb_resize_canvas`: origin plus pixel shift minus new origin.
 * @param {{width:number,height:number}} before Source canvas.
 * @param {{width:number,height:number}} after Destination canvas.
 * @param {number} pixelDx Canvas/group X pixels applied to the PNG.
 * @param {number} pixelDy Canvas/group Y pixels applied to the PNG (positive down).
 * @param {string} [anchorMode] Animation anchor.
 * @returns {{x:number,y:number}} Annotation delta.
 */
function annotationGroupDelta(before, after, pixelDx, pixelDy, anchorMode) {
  const oldAnchor = canvasAnchor(before.width, before.height, anchorMode);
  const newAnchor = canvasAnchor(after.width, after.height, anchorMode);
  return {
    x: oldAnchor.x + pixelDx - newAnchor.x,
    y: oldAnchor.y + pixelDy - newAnchor.y,
  };
}

/**
 * Calls one MCP tool through JSON-RPC `tools/call` and returns receipt data.
 * @param {object} service XSXB service.
 * @param {string|number} id JSON-RPC id.
 * @param {string} name Tool name.
 * @param {object} [args] Tool arguments.
 * @returns {Promise<object>} `structuredContent.data`.
 */
async function callTool(service, id, name, args = {}) {
  const response = await handleMessage(
    {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    },
    service,
  );
  const receipt = response.result.structuredContent;
  assert.equal(receipt.ok, true, receipt.error?.message || JSON.stringify(receipt));
  return receipt.data;
}

test("shift_frames translates boxes, attachments, and trail sticks by the group delta", async () => {
  const current = fixture();
  try {
    const size = 16;
    fs.writeFileSync(path.join(current.sequenceDir, "a.png"), solidPng(size));
    fs.writeFileSync(path.join(current.sequenceDir, "b.png"), solidPng(size, [40, 200, 40, 255]));
    await importWalk(current);

    const hurtboxOffset = { x: 1, y: -6 };
    const attachmentOffset = { x: 3, y: -4 };
    const trailTop = { x: -2, y: -10 };
    const trailBottom = { x: -2, y: -2 };
    const pixelDx = 2;
    const pixelDy = -3;

    await current.service.call("xsxb_update_frame_boxes", {
      animation_id: "walk",
      frame: 0,
      hurtbox: { offset: hurtboxOffset, size: { x: 8, y: 8 } },
    });
    const sparkPath = path.join(current.root, "spark.png");
    fs.writeFileSync(sparkPath, solidPng(8, [40, 180, 80, 255]));
    await current.service.call("xsxb_add_attachment", {
      animation_id: "walk",
      file_path: sparkPath,
      id: "spark",
      frame: 0,
      offset_x: attachmentOffset.x,
      offset_y: attachmentOffset.y,
      sync: false,
    });
    await current.service.call("xsxb_add_attack_trail", {
      animation_id: "walk",
      id: "shift-trail",
      sticks: [{ frame: 0, top: trailTop, bottom: trailBottom, layer: "front" }],
      sync: false,
    });

    const before = await current.service.call("xsxb_get_animation", { animation_id: "walk" });
    const beforeFrame = before.animation.frames[0];
    const shifted = await callTool(current.service, 1, "xsxb_shift_frames", {
      animation_id: "walk",
      frames: [{ frame: 0, dx: pixelDx, dy: pixelDy }],
    });
    assert.equal(shifted.shifted[0].dx, pixelDx);
    assert.equal(shifted.shifted[0].dy, pixelDy);
    const afterFrame = shifted.shifted[0];
    const delta = annotationGroupDelta(
      beforeFrame,
      afterFrame,
      pixelDx,
      pixelDy,
      before.animation.anchorMode,
    );

    const readBack = await callTool(current.service, 2, "xsxb_get_animation", {
      animation_id: "walk",
      include: ["boxes", "attachments", "trails"],
    });
    assert.deepEqual(readBack.boxes["0"].hurtbox.offset, {
      x: hurtboxOffset.x + delta.x,
      y: hurtboxOffset.y + delta.y,
    });
    assert.deepEqual(readBack.attachments[0].transform.offset, {
      x: attachmentOffset.x + delta.x,
      y: attachmentOffset.y + delta.y,
    });
    assert.deepEqual(readBack.trails[0].sticks[0].top, { x: trailTop.x + delta.x, y: trailTop.y + delta.y });
    assert.deepEqual(readBack.trails[0].sticks[0].bottom, {
      x: trailBottom.x + delta.x,
      y: trailBottom.y + delta.y,
    });
  } finally {
    current.cleanup();
  }
});

test("encodeGifWithFfmpeg rejects missing durations instead of writing NaN", async () => {
  await assert.rejects(
    () =>
      encodeGifWithFfmpeg({
        framePaths: ["/tmp/a.png", "/tmp/b.png"],
        durations: [0.08],
        outputPath: "/tmp/out.gif",
        ffmpegBinary: "true",
      }),
    /GIF duration is missing for frame 2/,
  );
});
