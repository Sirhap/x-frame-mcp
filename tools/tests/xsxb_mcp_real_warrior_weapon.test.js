"use strict";

/**
 * Real-material MCP suite for 程序大陆 / 战士皮肤武器1.
 * Not a synthetic 16×16 stand-in: stills and a slash clip from the artist's pack.
 * Skip when the folder or ffmpeg is missing so CI without Downloads still passes.
 */

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");
const { createProjectStore } = require("../project_store");
const { createXsxbMcpService } = require("../xsxb_mcp_service");
const { decodePngRgba } = require("../xsxb_mcp_cutout");
const { cellBox } = require("../xsxb_mcp_place");
const { measureSpriteGeometry } = require("../xsxb_mcp_lock");
const { canvasToGroup } = require("../xsxb_mcp_visual_qa");

const execFileAsync = promisify(execFile);
const ALPHA_VISIBLE = 16;

const SOURCE_DIR =
  process.env.XSXB_REAL_WARRIOR_DIR || "/Users/sirhao/Downloads/图片素材/程序大陆/战士皮肤武器1";

const FILES = Object.freeze({
  warriorJpg: "grok-0408eaa1-f413-40cb-946b-5f62c9cc9a65.jpg",
  swordJpg: "grok-051b0079-1bac-4d13-bba7-382a2b950bd3.jpg",
  slashMp4: "grok-02f3d442-6875-4ff5-a0b9-a677668bf8c4-720p.mp4",
});

/**
 * Whether the artist pack is on disk.
 * @returns {boolean} True when every named source file exists.
 */
function hasSource() {
  return Object.values(FILES).every((name) => fs.existsSync(path.join(SOURCE_DIR, name)));
}

/**
 * Whether ffmpeg can be spawned.
 * @returns {Promise<boolean>} True when `-version` exits 0.
 */
async function hasFfmpeg() {
  try {
    await execFileAsync("ffmpeg", ["-version"], { timeout: 8_000 });
    return true;
  } catch {
    return false;
  }
}

const SKIP_REASON = !hasSource() ? `missing real pack at ${SOURCE_DIR}` : undefined;

/**
 * Isolated tuner root plus MCP service. GIF encoding is real ffmpeg.
 * @returns {{root:string,workspaceDir:string,service:object,cleanup:Function}} Fixture.
 */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-real-warrior-"));
  const godotRoot = path.join(root, "godot");
  fs.mkdirSync(godotRoot, { recursive: true });
  fs.writeFileSync(path.join(godotRoot, "project.godot"), '[application]\nconfig/name="WarriorWeapon"\n');
  const store = createProjectStore(root);
  store.addProject({ id: "warrior", label: "Warrior", projectRoot: godotRoot });
  return {
    root,
    workspaceDir: store.projectWorkspaceDir(store.readRegistry().projects[0]),
    service: createXsxbMcpService({ root }),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Runs ffmpeg and throws a readable error.
 * @param {string[]} args ffmpeg argv.
 * @returns {Promise<void>}
 */
async function ffmpeg(args) {
  try {
    await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], {
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`ffmpeg failed: ${error.stderr || error.message}`);
  }
}

/**
 * Converts a JPEG still into a workspace PNG.
 * @param {string} jpgPath Source JPEG.
 * @param {string} pngPath Destination PNG.
 * @returns {Promise<string>} Destination path.
 */
async function jpgToPng(jpgPath, pngPath) {
  fs.mkdirSync(path.dirname(pngPath), { recursive: true });
  await ffmpeg(["-y", "-i", jpgPath, pngPath]);
  return pngPath;
}

/**
 * Builds a short 320×320 clip so import_video is real without 145 full-res frames.
 * @param {string} srcMp4 Source slash clip.
 * @param {string} destMp4 Destination.
 * @returns {Promise<string>} Destination path.
 */
async function writeShortSlash(srcMp4, destMp4) {
  fs.mkdirSync(path.dirname(destMp4), { recursive: true });
  await ffmpeg(["-y", "-i", srcMp4, "-t", "0.8", "-r", "10", "-vf", "scale=320:320", "-an", destMp4]);
  return destMp4;
}

/**
 * Transparent pixel fraction (alpha <= threshold).
 * @param {Uint8ClampedArray} rgba Pixels.
 * @returns {number} 0–1.
 */
function transparentRatio(rgba) {
  let count = 0;
  for (let offset = 3; offset < rgba.length; offset += 4) {
    if (rgba[offset] <= ALPHA_VISIBLE) count += 1;
  }
  return count / (rgba.length / 4);
}

/**
 * Ice-blue opaque pixels (sword / frost, not black plate).
 * @param {Uint8ClampedArray} rgba Pixels.
 * @returns {number} Count.
 */
function iceBlueCount(rgba) {
  let count = 0;
  for (let offset = 0; offset < rgba.length; offset += 4) {
    const red = rgba[offset];
    const green = rgba[offset + 1];
    const blue = rgba[offset + 2];
    const alpha = rgba[offset + 3];
    if (alpha <= ALPHA_VISIBLE) continue;
    if (blue > 70 && blue > red + 8 && blue >= green - 20) count += 1;
  }
  return count;
}

/**
 * Alpha of the four corners.
 * @param {{data:Uint8ClampedArray,width:number,height:number}} image Image.
 * @returns {number[]} Corner alphas.
 */
function cornerAlphas(image) {
  const { data, width, height } = image;
  const spots = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ];
  return spots.map(([x, y]) => data[(y * width + x) * 4 + 3]);
}

/**
 * Opaque bounding box, or null.
 * @param {Uint8ClampedArray} rgba Pixels.
 * @param {number} width Width.
 * @param {number} height Height.
 * @returns {{minX:number,minY:number,maxX:number,maxY:number}|null} Box.
 */
function opaqueBBox(rgba, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (rgba[(y * width + x) * 4 + 3] <= ALPHA_VISIBLE) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * Speakable cell id covering an original-image pixel.
 * @param {object} view Overlay view.
 * @param {number} x Image x.
 * @param {number} y Image y.
 * @returns {string} Cell id.
 */
function cellIdAt(view, x, y) {
  for (let row = 1; row <= view.rows; row += 1) {
    for (let col = 0; col < view.cols; col += 1) {
      const id = `${String.fromCharCode(65 + col)}${row}`;
      const box = cellBox(view, id);
      if (x >= box.x1 && x < box.x2 && y >= box.y1 && y < box.y2) return id;
    }
  }
  throw new Error(`no overlay cell covers ${x},${y} in view ${JSON.stringify(view)}`);
}

test("战士皮肤武器1 真实素材（按项）", { skip: SKIP_REASON, timeout: 180_000 }, async (t) => {
  if (!(await hasFfmpeg())) {
    t.skip("ffmpeg not on PATH");
    return;
  }
  const current = fixture();
  const mediaDir = path.join(current.workspaceDir, "real-warrior");
  const ctx = {
    warriorPng: path.join(mediaDir, "warrior.png"),
    swordPng: path.join(mediaDir, "sword.png"),
    shortMp4: path.join(mediaDir, "slash-short.mp4"),
    animationId: "ice_slash",
  };
  try {
    await jpgToPng(path.join(SOURCE_DIR, FILES.warriorJpg), ctx.warriorPng);
    await jpgToPng(path.join(SOURCE_DIR, FILES.swordJpg), ctx.swordPng);
    await writeShortSlash(path.join(SOURCE_DIR, FILES.slashMp4), ctx.shortMp4);

    await t.test("1. 素材接入：list / import_video / get_animation", async () => {
      const listed = await current.service.call("xsxb_list_projects", {});
      assert.ok(
        listed.projects.some((entry) => entry.id === "warrior"),
        "project warrior is listed",
      );
      await current.service.call("xsxb_set_active_project", { project_id: "warrior" });
      const imported = await current.service.call("xsxb_import_video", {
        file_path: ctx.shortMp4,
        project_id: "warrior",
        animation_id: ctx.animationId,
        fps: 10,
      });
      assert.equal(imported.animationId, ctx.animationId);
      assert.ok(
        imported.importedFrameCount >= 4,
        `expected several frames, got ${imported.importedFrameCount}`,
      );
      assert.ok(imported.importedFrameCount <= 16, "short clip must not dump the full 145-frame take");
      const animation = await current.service.call("xsxb_get_animation", {
        animation_id: ctx.animationId,
      });
      assert.equal(animation.animation.frames.length, imported.importedFrameCount);
      ctx.frameCount = imported.importedFrameCount;
      for (const frame of animation.animation.frames) {
        assert.ok(fs.existsSync(frame.absolutePath), frame.absolutePath);
        const png = decodePngRgba(frame.absolutePath);
        assert.equal(png.width, 320);
        assert.equal(png.height, 320);
      }
    });

    await t.test("2. 抠图：黑底静图 + 动画帧，角透明、冰蓝还在", async () => {
      const warriorCut = await current.service.call("xsxb_cutout", {
        file_path: ctx.warriorPng,
        key_mode: "border_flood",
        key_color: "#000000",
      });
      assert.equal(warriorCut.verify.status, "confirmed");
      assert.ok(warriorCut.processedFrameCount >= 1);
      const warriorImage = decodePngRgba(warriorCut.output_path);
      const warriorCorners = cornerAlphas(warriorImage);
      assert.ok(
        warriorCorners.every((alpha) => alpha <= ALPHA_VISIBLE),
        `warrior corners still opaque: ${warriorCorners}`,
      );
      const warriorClear = transparentRatio(warriorImage.data);
      assert.ok(warriorClear > 0.35, `warrior transparent ratio ${warriorClear} — plate not keyed`);
      assert.ok(warriorClear < 0.97, `warrior transparent ratio ${warriorClear} — subject eaten`);
      const warriorIce = iceBlueCount(warriorImage.data);
      assert.ok(warriorIce > 400, `warrior ice-blue pixels ${warriorIce}`);
      ctx.warriorCut = warriorCut.output_path;

      const swordCut = await current.service.call("xsxb_cutout", {
        file_path: ctx.swordPng,
        key_mode: "border_flood",
        key_color: "#000000",
      });
      assert.equal(swordCut.verify.status, "confirmed");
      const swordImage = decodePngRgba(swordCut.output_path);
      assert.ok(cornerAlphas(swordImage).every((alpha) => alpha <= ALPHA_VISIBLE));
      const swordIce = iceBlueCount(swordImage.data);
      assert.ok(swordIce > 400, `sword ice-blue pixels ${swordIce}`);
      ctx.swordCut = swordCut.output_path;

      const again = await current.service.call("xsxb_cutout", {
        file_path: ctx.warriorCut,
        output_path: "warrior_cut_again.png",
        key_mode: "border_flood",
        key_color: "#000000",
      });
      assert.equal(again.verify.status, "suspected_noop");

      const framesCut = await current.service.call("xsxb_cutout", {
        animation_id: ctx.animationId,
        key_mode: "border_flood",
        key_color: "#000000",
      });
      assert.equal(framesCut.verify.status, "confirmed");
      assert.ok(framesCut.processedFrameCount >= 1);
      const animation = await current.service.call("xsxb_get_animation", {
        animation_id: ctx.animationId,
      });
      const first = decodePngRgba(animation.animation.frames[0].absolutePath);
      assert.ok(
        cornerAlphas(first).every((alpha) => alpha <= ALPHA_VISIBLE),
        `slash frame 0 corners ${cornerAlphas(first)}`,
      );
      assert.ok(iceBlueCount(first.data) > 80, "slash frame keeps frost/sword blues");
    });

    await t.test("3. 分析整理：analyze 出预览，不把回执当已 apply", async () => {
      const analyzed = await current.service.call("xsxb_analyze", {
        animation_id: ctx.animationId,
      });
      assert.equal(analyzed.applied, false);
      assert.ok(analyzed.duplicates, "duplicates section");
      assert.ok(analyzed.loop || analyzed.motion, "loop or motion window");
      assert.ok(analyzed.preview?.path && fs.existsSync(analyzed.preview.path), "analyze preview sheet");
    });

    await t.test("4. 静图格子 / 量刀 / 图度贴合", async () => {
      const overlayWarrior = await current.service.call("xsxb_overlay_grid", {
        file_path: ctx.warriorCut,
      });
      assert.match(overlayWarrior.overlay_id, /^ovl_[0-9a-f]{12}$/);
      assert.equal(overlayWarrior.cells.A1.id, "A1");
      assert.equal(overlayWarrior.cells.A1.x1, undefined);
      assert.equal(overlayWarrior.next, "crop_from");
      assert.ok(overlayWarrior.cell_width_px >= 40);
      assert.ok(fs.existsSync(overlayWarrior.overlay_path));

      const overlaySword = await current.service.call("xsxb_overlay_grid", {
        file_path: ctx.swordCut,
      });
      assert.match(overlaySword.overlay_id, /^ovl_[0-9a-f]{12}$/);

      const warriorImage = decodePngRgba(ctx.warriorCut);
      const box = opaqueBBox(warriorImage.data, warriorImage.width, warriorImage.height);
      assert.ok(box, "cut warrior has opaque pixels");
      const gripX = box.minX + (box.maxX - box.minX) * 0.72;
      const gripY = box.minY + (box.maxY - box.minY) * 0.55;
      const handCell = cellIdAt(overlayWarrior.view, gripX, gripY);
      const cropped = await current.service.call("xsxb_overlay_grid", {
        file_path: ctx.warriorCut,
        crop_from: {
          parent_view: overlayWarrior.view,
          cells: [handCell],
          padding_cells: 1,
          overlay_id: overlayWarrior.overlay_id,
        },
      });
      assert.notEqual(cropped.overlay_id, overlayWarrior.overlay_id);
      assert.ok(cropped.next == null || cropped.next === undefined);

      await assert.rejects(
        () =>
          current.service.call("xsxb_overlay_grid", {
            file_path: ctx.warriorCut,
            crop_from: {
              parent_view: overlayWarrior.view,
              cells: [handCell],
              overlay_id: "ovl_ffffffffffff",
            },
          }),
        (error) => error.code === "STALE_OVERLAY",
      );

      const measured = await current.service.call("xsxb_measure_image", {
        file_path: ctx.swordCut,
        t: "2/3",
      });
      assert.ok(Number.isFinite(measured.pommel.x));
      assert.ok(Number.isFinite(measured.tip.x));
      assert.ok(measured.length > 20, `sword axis length ${measured.length}`);
      assert.ok(Number.isFinite(measured.at.x) && Number.isFinite(measured.at.y));

      const feet = await current.service.call("xsxb_measure_image", {
        file_path: ctx.warriorCut,
        anchor: "alpha_bottom",
      });
      assert.ok(Number.isFinite(feet.at.y));

      const planned = await current.service.call("xsxb_plan_place", {
        target_path: ctx.warriorCut,
        object_path: ctx.swordCut,
        intent: "Place the ice sword grip on the warrior's weapon hand",
        read: {
          target_contact: "right-hand grip on the standing ice warrior",
          object_contact: "wrapped hilt of the isolated ice greatsword",
          target_cells: [handCell],
        },
        proposed: { layer: "front", snap: "alpha_centroid" },
        physics: [
          "Grip opaque centroid meets the hand cell",
          "Scale from the named hand span, not image-width-per-meter",
          "Composite only — do not redraw the warrior or the sword",
        ],
        accept: ["verify.status is not suspected_noop", "ice-blue sword pixels remain in the composite"],
        plan: [
          "overlay both cut PNGs and crop_from the hand cell if next says so",
          "place with overlay_id, plan_id, default alpha_centroid, measure_t on the hilt",
          "keep layer front",
          "inspect verify_overlay_path against accept",
        ],
      });
      assert.match(planned.plan_id, /^pln_[0-9a-f]{12}$/);
      assert.equal(planned.next, "place");

      const placed = await current.service.call("xsxb_place_image", {
        target_path: ctx.warriorCut,
        object_path: ctx.swordCut,
        plan_id: planned.plan_id,
        target_anchor: {
          view: overlayWarrior.view,
          cells: [handCell],
          overlay_id: overlayWarrior.overlay_id,
        },
        object_anchor: { measure_t: 0.25 },
        layer: "front",
        scale: {
          mode: "relative",
          ratio: 1,
          span: "height",
          target: { view: overlayWarrior.view, cells: [handCell] },
        },
      });
      assert.ok(["confirmed", "unverified", "unverifiable"].includes(placed.verify.status));
      assert.notEqual(placed.verify.status, "suspected_noop");
      assert.ok(fs.existsSync(placed.output_path));
      const composite = decodePngRgba(placed.output_path);
      assert.ok(iceBlueCount(composite.data) > 400, "placed composite still has ice-blue");

      await assert.rejects(
        () =>
          current.service.call("xsxb_place_image", {
            target_path: ctx.warriorCut,
            object_path: ctx.swordCut,
            plan_id: planned.plan_id,
            target_anchor: {
              view: overlayWarrior.view,
              cells: [handCell],
              overlay_id: overlayWarrior.overlay_id,
              derive: "center",
            },
            object_anchor: { measure_t: 0.25 },
            layer: "behind",
          }),
        (error) => error.code === "PLAN_MISMATCH",
      );
    });

    await t.test("5. 种脚与比例：measure_frames / plant_feet y=-1 / estimate_visual", async () => {
      const measured = await current.service.call("xsxb_measure_frames", {
        animation_id: ctx.animationId,
      });
      assert.ok(measured.frames.length >= 1);
      assert.ok(Number.isFinite(measured.frames[0].feetY));

      const dry = await current.service.call("xsxb_plant_feet", {
        animation_id: ctx.animationId,
        dry_run: true,
      });
      assert.equal(dry.dryRun, true);
      assert.equal(dry.applied, false);
      assert.equal(dry.frames[0].targetY, -1);

      const planted = await current.service.call("xsxb_plant_feet", {
        animation_id: ctx.animationId,
        apply: true,
      });
      assert.equal(planted.applied, true);
      const animation = await current.service.call("xsxb_get_animation", {
        animation_id: ctx.animationId,
      });
      const image = decodePngRgba(animation.animation.frames[0].absolutePath);
      const geom = measureSpriteGeometry(image.data, image.width, image.height);
      const overhang = Math.max(0, geom.maxY - geom.feetY);
      const lockHeight = image.height - overhang;
      assert.equal(
        canvasToGroup(0, geom.feetY, image.width, lockHeight).y,
        -1,
        `planted sole feetY=${geom.feetY} height=${image.height} lock=${lockHeight} (group y=-1; ice may pad below)`,
      );
      if (overhang === 0) {
        assert.ok(geom.feetY >= image.height - 3, "walk soles without hanging ice land on the last pixel");
      }

      const estimated = await current.service.call("xsxb_estimate_visual", {
        animation_id: ctx.animationId,
        target_height: 180,
        metric: "body",
      });
      assert.equal(estimated.targetHeight, 180);
      assert.ok(Number.isFinite(estimated.groupScale));
      assert.ok(estimated.groupScale > 0);
    });

    await t.test("6. 导出：sheet 带格子，GIF 能播", async () => {
      const sheet = await current.service.call("xsxb_export_sheet", {
        animation_id: ctx.animationId,
        grid_divs: "8x8",
      });
      assert.ok(fs.existsSync(sheet.outputPath), sheet.outputPath);
      assert.ok(sheet.grid?.cells, "grid.cells for write-back, not OCR");
      assert.ok(Number.isFinite(sheet.grid.cells[0][0].y));
      const lastPixel = sheet.grid.lastPixel;
      if (lastPixel?.group) {
        assert.equal(lastPixel.group.y, -1);
      }

      const gif = await current.service.call("xsxb_export_gif", {
        animation_id: ctx.animationId,
      });
      assert.ok(fs.existsSync(gif.outputPath), gif.outputPath);
      const gifPath = gif.outputPath;
      const header = fs.readFileSync(gifPath).subarray(0, 6).toString("ascii");
      assert.match(header, /^GIF8[79]a/);
    });

    await t.test("7. 挥砍图度：plan_smear 只出 brief，不画刀光", async () => {
      const animation = await current.service.call("xsxb_get_animation", {
        animation_id: ctx.animationId,
      });
      const framePath = animation.animation.frames[0].absolutePath;
      const overlay = await current.service.call("xsxb_overlay_grid", {
        file_path: framePath,
      });
      const image = decodePngRgba(framePath);
      const box = opaqueBBox(image.data, image.width, image.height);
      const head = cellIdAt(overlay.view, (box.minX + box.maxX) / 2, box.minY + 8);
      const end = cellIdAt(overlay.view, box.maxX - 4, (box.minY + box.maxY) / 2);
      const start = cellIdAt(overlay.view, box.minX + 4, (box.minY + box.maxY) / 2);
      const smeared = await current.service.call("xsxb_plan_smear", {
        animation_id: ctx.animationId,
        motion: "ice greatsword idle-to-slash on this clip, head traces the crystalline blade",
        path_kind: "polyline",
        color: "#7ec8ff",
        layer: "behind",
        frames: [
          {
            index: 0,
            start,
            end: end === head ? start : end,
            head,
          },
        ],
      });
      assert.ok(smeared.brief);
      assert.match(smeared.brief, /pixel|月牙|polyline|behind/i);
      assert.ok(!smeared.output_path, "plan_smear must not paint a smear PNG");
    });
  } finally {
    current.cleanup();
  }
});
