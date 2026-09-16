"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { estimateFrameBoxes } = require("../../mcp/lib/box_estimator");
const { encodePngRgba, decodePngRgba } = require("../../mcp/xsxb_mcp_cutout");
const { borderFloodKey, measureSpriteGeometry } = require("../../mcp/xsxb_mcp_lock");
const { createXsxbMcpService } = require("../../mcp/xsxb_mcp_service");
const { createProjectStore } = require("../../mcp/lib/project_store");
const { assertFrameBoxes, boxRectOnCanvas, drawBoxesOnMagenta } = require("../acceptance_generated");

const GENERATED_IDLE_0 = path.join(__dirname, "../fixtures/generated_hero/idle/00.png");
const GENERATED_ATTACK_SLASH = path.join(__dirname, "../fixtures/generated_hero/attack/01.png");
const GENERATED_ATTACK_FOLLOW = path.join(__dirname, "../fixtures/generated_hero/attack/02.png");

const CANVAS_W = 256;
const CANVAS_H = 264;
const BODY_W = 48;
const BODY_H = 120;
const HURT_LIME = Object.freeze([0, 255, 80, 255]);

/**
 * Paints one opaque pixel.
 * @param {Uint8ClampedArray} rgba Buffer.
 * @param {number} width Canvas width.
 * @param {number} x Column.
 * @param {number} y Row.
 * @param {readonly number[]} color RGBA.
 * @returns {void}
 */
function setPixel(rgba, width, x, y, color) {
  const height = rgba.length / (width * 4);
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  rgba.set(color, (y * width + x) * 4);
}

/**
 * Builds a transparent-padded 256×264 actor with an optional right-hand slash
 * or a left-hand steel sword (no gold crescent).
 * Soles sit one pixel above the last row, matching planted generated frames.
 * @param {{slash?:boolean,sword?:boolean}} [options] Attack reach.
 * @returns {{data:Uint8ClampedArray,width:number,height:number,left:number,top:number,feetY:number}}
 */
function paddedActorFrame(options = {}) {
  const rgba = new Uint8ClampedArray(CANVAS_W * CANVAS_H * 4);
  const left = Math.floor((CANVAS_W - BODY_W) / 2);
  const feetY = CANVAS_H - 2;
  const top = feetY - BODY_H + 1;
  for (let y = top; y <= feetY; y += 1) {
    for (let x = left; x < left + BODY_W; x += 1) {
      setPixel(rgba, CANVAS_W, x, y, [36, 58, 118, 255]);
    }
  }
  if (options.slash) {
    const slashY = top + Math.floor(BODY_H * 0.32);
    for (let y = slashY; y < slashY + 10; y += 1) {
      for (let x = left + BODY_W - 4; x < left + BODY_W + 56; x += 1) {
        setPixel(rgba, CANVAS_W, x, y, [255, 214, 56, 255]);
      }
    }
  }
  if (options.sword) {
    const bladeX = left - 10;
    for (let y = top + 8; y < top + 52; y += 1) {
      for (let x = bladeX; x < bladeX + 3; x += 1) {
        setPixel(rgba, CANVAS_W, x, y, [200, 204, 214, 255]);
      }
    }
  }
  return { data: rgba, width: CANVAS_W, height: CANVAS_H, left, top, feetY };
}

/**
 * Writes one padded actor PNG into a temp directory.
 * @param {string} filePath Destination.
 * @param {{slash?:boolean}} [options] Attack reach.
 * @returns {{data:Uint8ClampedArray,width:number,height:number,feetY:number}} Frame.
 */
function writePaddedActorPng(filePath, options = {}) {
  const frame = paddedActorFrame(options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, encodePngRgba(frame.data, frame.width, frame.height));
  return frame;
}

/**
 * Keys a generated-hero plate (studio white) the same way the session cutout does.
 * @param {string} sourcePath Fixture PNG.
 * @param {string} destPath Keyed output.
 * @returns {{data:Uint8ClampedArray,width:number,height:number}} Keyed frame.
 */
function writeKeyedGeneratedPng(sourcePath, destPath) {
  const image = decodePngRgba(sourcePath);
  const keyed = borderFloodKey(image.data, image.width, image.height, {
    keyColor: "#F8F8F8",
    protectedColors: ["#ffe040", "#ffe080", "#ffd070"],
  });
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, encodePngRgba(keyed.data, image.width, image.height));
  return { data: keyed.data, width: image.width, height: image.height };
}

/**
 * Grounded collision plus a torso hurtbox that reaches the hair.
 * @param {{stamp?:boolean,neckOnly?:boolean,floatCollision?:boolean,belowCanvas?:boolean,cloneHit?:boolean}} [options]
 *   Failure modes.
 * @returns {object} Box override.
 */
function plantedBoxes(options = {}) {
  const hurt = options.stamp
    ? { offset: { x: 0, y: -60 }, size: { x: 1, y: 1 }, enabled: true }
    : options.neckOnly
      ? { offset: { x: 0, y: -58 }, size: { x: 38, y: 80 }, enabled: true }
      : { offset: { x: 0, y: -67 }, size: { x: 38, y: 112 }, enabled: true };
  const collision = options.floatCollision
    ? { offset: { x: 0, y: -140 }, size: { x: 20, y: 40 }, enabled: true }
    : options.belowCanvas
      ? { offset: { x: 0, y: 24 }, size: { x: 20, y: 20 }, enabled: true }
      : { offset: { x: 0, y: -43 }, size: { x: 20, y: 86 }, enabled: true };
  const hit = options.cloneHit
    ? { ...hurt, offset: { ...hurt.offset }, size: { ...hurt.size } }
    : { offset: { x: 52, y: -70 }, size: { x: 44, y: 18 }, enabled: true };
  return { hurtbox: hurt, collisionbox: collision, hitbox: hit };
}

test("estimateFrameBoxes fills hurt+collision on transparent-padded 256x264 frames", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-box-est-"));
  try {
    const filePath = path.join(root, "idle.png");
    writePaddedActorPng(filePath);
    const boxes = estimateFrameBoxes(filePath, {
      type: "actor",
      animationId: "idle",
      animationName: "idle",
      frameIndex: 0,
      frameCount: 2,
      groupCanvasWidth: CANVAS_W,
      groupCanvasHeight: CANVAS_H,
    });
    assert.ok(boxes.hurtbox, `hurtbox missing: ${JSON.stringify(boxes)}`);
    assert.ok(boxes.collisionbox, `collisionbox missing: ${JSON.stringify(boxes)}`);
    assert.ok(boxes.hurtbox.size.x >= 16 && boxes.hurtbox.size.y >= 24, JSON.stringify(boxes.hurtbox));
    assert.ok(
      boxes.collisionbox.size.x >= 8 && boxes.collisionbox.size.y >= 16,
      JSON.stringify(boxes.collisionbox),
    );
    assert.equal(boxes.collisionbox.offset.y, -boxes.collisionbox.size.y / 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("estimateFrameBoxes attack hitbox reaches past the padded body, not a hurtbox clone", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-box-atk-"));
  try {
    const filePath = path.join(root, "attack.png");
    writePaddedActorPng(filePath, { slash: true });
    const boxes = estimateFrameBoxes(filePath, {
      type: "actor",
      animationId: "attack",
      animationName: "slash",
      frameIndex: 1,
      frameCount: 2,
      groupCanvasWidth: CANVAS_W,
      groupCanvasHeight: CANVAS_H,
    });
    assert.ok(boxes.hitbox, `hitbox missing: ${JSON.stringify(boxes)}`);
    assert.ok(
      boxes.hitbox.size.x !== boxes.hurtbox.size.x ||
        boxes.hitbox.size.y !== boxes.hurtbox.size.y ||
        boxes.hitbox.offset.x !== boxes.hurtbox.offset.x,
      `hitbox cloned hurtbox: ${JSON.stringify(boxes)}`,
    );
    const hit = boxRectOnCanvas(boxes.hitbox, CANVAS_W, CANVAS_H);
    const hurt = boxRectOnCanvas(boxes.hurtbox, CANVAS_W, CANVAS_H);
    assert.ok(
      hit.maxX > hurt.maxX + 4 || hit.minX < hurt.minX - 4,
      `hitbox does not reach past the body: hit=${JSON.stringify(hit)} hurt=${JSON.stringify(hurt)}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("xsxb_estimate_boxes JSON-RPC keeps torso boxes on a padded 256x264 clip", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-box-rpc-"));
  const service = createXsxbMcpService({ root, florenceDetectImpl: null });
  try {
    const godotRoot = path.join(root, "godot");
    fs.mkdirSync(godotRoot, { recursive: true });
    fs.writeFileSync(path.join(godotRoot, "project.godot"), '[application]\nconfig/name="Boxes"\n');
    const store = createProjectStore(root);
    store.addProject({ id: "boxes", label: "Boxes", projectRoot: godotRoot });
    const seq = path.join(root, "idle");
    fs.mkdirSync(seq);
    writePaddedActorPng(path.join(seq, "00.png"));
    writePaddedActorPng(path.join(seq, "01.png"));
    await service.call("xsxb_import_animation", {
      project_id: "boxes",
      source: "png_sequence",
      directory: seq,
      profile_id: "hero",
      animation_id: "idle",
      fps: 8,
    });
    const estimated = await service.call("xsxb_estimate_boxes", {
      project_id: "boxes",
      animation_id: "idle",
      replace: true,
    });
    assert.equal(estimated.estimatedFrames, 2);
    assert.ok(estimated.frames[0].boxes?.hurtbox, JSON.stringify(estimated.frames[0]));
    assert.ok(estimated.frames[0].boxes?.collisionbox, JSON.stringify(estimated.frames[0]));
    const listed = await service.call("xsxb_get_animation", {
      project_id: "boxes",
      animation_id: "idle",
      include: ["boxes"],
    });
    const image = decodePngRgba(listed.animation.frames[0].absolutePath);
    assertFrameBoxes("idle", 0, listed.boxes[0] || listed.boxes["0"], image);
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("assertFrameBoxes rejects a 1px hurt stamp and a mid-torso collision", () => {
  const frame = paddedActorFrame();
  assert.throws(
    () => assertFrameBoxes("idle", 0, plantedBoxes({ stamp: true }), frame),
    /hurtbox|stamp|torso/i,
  );
  assert.throws(
    () => assertFrameBoxes("idle", 0, plantedBoxes({ neckOnly: true }), frame),
    /neck|hair|minY|hurtbox/i,
  );
  assert.throws(
    () => assertFrameBoxes("walk", 0, plantedBoxes({ floatCollision: true }), frame),
    /sole|collision|torso/i,
  );
  assert.throws(
    () => assertFrameBoxes("walk", 1, plantedBoxes({ belowCanvas: true }), frame),
    /canvas|collision/i,
  );
  assert.throws(
    () => assertFrameBoxes("attack", 0, plantedBoxes({ cloneHit: true }), frame),
    /hitbox|identical|reach|crescent/i,
  );
  assert.throws(
    () => assertFrameBoxes("attack", 1, plantedBoxes(), paddedActorFrame({ sword: true })),
    /hitbox|enabled|crescent/i,
  );
});

test("assertFrameBoxes accepts planted idle/attack estimates", () => {
  const idle = paddedActorFrame();
  const attack = paddedActorFrame({ slash: true });
  assertFrameBoxes("idle", 0, plantedBoxes(), idle);
  assertFrameBoxes("attack", 0, plantedBoxes(), attack);
});

test("drawBoxesOnMagenta paints a lime hurtbox outline on the flatten", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-box-draw-"));
  try {
    const frame = paddedActorFrame();
    const dest = path.join(root, "generated_boxes_idle_0.png");
    const boxes = plantedBoxes();
    const written = drawBoxesOnMagenta(frame, boxes, dest);
    assert.equal(written, dest);
    assert.ok(fs.existsSync(dest));
    const painted = decodePngRgba(dest);
    assert.equal(painted.width, CANVAS_W);
    assert.equal(painted.height, CANVAS_H);
    const rect = boxRectOnCanvas(boxes.hurtbox, CANVAS_W, CANVAS_H);
    const x = Math.round(rect.minX);
    const y = Math.round((rect.minY + rect.maxY) / 2);
    const offset = (y * painted.width + x) * 4;
    assert.deepEqual(
      [painted.data[offset], painted.data[offset + 1], painted.data[offset + 2], painted.data[offset + 3]],
      [...HURT_LIME],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("estimateFrameBoxes hurtbox reaches the hair on generated idle, not the neck", () => {
  assert.ok(fs.existsSync(GENERATED_IDLE_0), `missing fixture ${GENERATED_IDLE_0}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-box-idle-head-"));
  try {
    const filePath = path.join(root, "idle.png");
    const image = writeKeyedGeneratedPng(GENERATED_IDLE_0, filePath);
    const boxes = estimateFrameBoxes(filePath, {
      type: "actor",
      animationId: "idle",
      animationName: "idle",
      frameIndex: 0,
      frameCount: 2,
      groupCanvasWidth: image.width,
      groupCanvasHeight: image.height,
    });
    const geometry = measureSpriteGeometry(image.data, image.width, image.height);
    const hurt = boxRectOnCanvas(boxes.hurtbox, image.width, image.height);
    assert.ok(
      hurt.minY <= geometry.minY + 8,
      `hurtbox top ${hurt.minY} starts at the neck; hair minY=${geometry.minY} size=${JSON.stringify(boxes.hurtbox)}`,
    );
    assert.ok(
      hurt.maxY >= (geometry.minY + geometry.feetY) / 2,
      `hurtbox misses chest: ${JSON.stringify(hurt)}`,
    );
    const collision = boxRectOnCanvas(boxes.collisionbox, image.width, image.height);
    assert.equal(boxes.collisionbox.offset.y, -boxes.collisionbox.size.y / 2);
    assert.ok(collision.maxY <= image.height, `collision floated past canvas ${JSON.stringify(collision)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("estimateFrameBoxes hitbox covers the generated attack gold crescent", () => {
  assert.ok(fs.existsSync(GENERATED_ATTACK_SLASH), `missing fixture ${GENERATED_ATTACK_SLASH}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-box-atk-crescent-"));
  try {
    const filePath = path.join(root, "attack0.png");
    const image = writeKeyedGeneratedPng(GENERATED_ATTACK_SLASH, filePath);
    const boxes = estimateFrameBoxes(filePath, {
      type: "actor",
      animationId: "attack",
      animationName: "slash",
      frameIndex: 0,
      frameCount: 2,
      groupCanvasWidth: image.width,
      groupCanvasHeight: image.height,
    });
    assert.ok(boxes.hitbox && boxes.hitbox.enabled !== false, `hitbox missing: ${JSON.stringify(boxes)}`);
    assert.ok(
      boxes.hitbox.size.x > 20 && boxes.hitbox.size.y > 16,
      `hitbox is a stamp ${boxes.hitbox.size.x}x${boxes.hitbox.size.y}`,
    );
    const hurt = boxRectOnCanvas(boxes.hurtbox, image.width, image.height);
    const hit = boxRectOnCanvas(boxes.hitbox, image.width, image.height);
    assert.ok(
      hit.maxX > hurt.maxX + 4 || hit.minX < hurt.minX - 4,
      `hitbox does not reach past the body: hit=${JSON.stringify(hit)} hurt=${JSON.stringify(hurt)}`,
    );
    let gold = 0;
    let inside = 0;
    const x0 = Math.round(image.width * 0.55);
    const y0 = Math.round(image.height * 0.35);
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        if (x < x0 || y < y0) continue;
        const offset = (y * image.width + x) * 4;
        const r = image.data[offset];
        const g = image.data[offset + 1];
        const b = image.data[offset + 2];
        const a = image.data[offset + 3];
        if (a < 160) continue;
        const sat = Math.max(r, g, b) - Math.min(r, g, b);
        if (!(r >= 220 && g >= 180 && b <= 180 && r - b >= 50 && g - b >= 20 && sat >= 40)) continue;
        gold += 1;
        if (x >= hit.minX && x <= hit.maxX && y >= hit.minY && y <= hit.maxY) inside += 1;
      }
    }
    assert.ok(gold >= 160, `fixture lost the gold crescent (${gold} px)`);
    assert.ok(
      inside / gold >= 0.2,
      `hitbox overlaps ${inside}/${gold} crescent pixels; stamp beside the arc is not enough ${JSON.stringify(boxes.hitbox)}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("estimateFrameBoxes hitbox covers the generated attack follow-through crescent", () => {
  assert.ok(fs.existsSync(GENERATED_ATTACK_FOLLOW), `missing fixture ${GENERATED_ATTACK_FOLLOW}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-box-atk-followthrough-"));
  try {
    const filePath = path.join(root, "attack1.png");
    const image = writeKeyedGeneratedPng(GENERATED_ATTACK_FOLLOW, filePath);
    const boxes = estimateFrameBoxes(filePath, {
      type: "actor",
      animationId: "attack",
      animationName: "slash",
      frameIndex: 1,
      frameCount: 2,
      groupCanvasWidth: image.width,
      groupCanvasHeight: image.height,
    });
    assert.ok(boxes.hitbox && boxes.hitbox.enabled !== false, `hitbox missing: ${JSON.stringify(boxes)}`);
    assert.ok(
      boxes.hitbox.size.x > 20 && boxes.hitbox.size.y > 16,
      `hitbox is a stamp ${boxes.hitbox.size.x}x${boxes.hitbox.size.y}`,
    );
    const hit = boxRectOnCanvas(boxes.hitbox, image.width, image.height);
    let gold = 0;
    let inside = 0;
    const x0 = Math.round(image.width * 0.55);
    const y0 = Math.round(image.height * 0.35);
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        if (x < x0 || y < y0) continue;
        const offset = (y * image.width + x) * 4;
        const r = image.data[offset];
        const g = image.data[offset + 1];
        const b = image.data[offset + 2];
        const a = image.data[offset + 3];
        if (a < 160) continue;
        const sat = Math.max(r, g, b) - Math.min(r, g, b);
        if (!(r >= 220 && g >= 180 && b <= 180 && r - b >= 50 && g - b >= 20 && sat >= 40)) continue;
        gold += 1;
        if (x >= hit.minX && x <= hit.maxX && y >= hit.minY && y <= hit.maxY) inside += 1;
      }
    }
    assert.ok(gold >= 160, `follow-through fixture lost the gold crescent (${gold} px)`);
    assert.ok(
      inside / gold >= 0.2,
      `hitbox overlaps ${inside}/${gold} crescent pixels; stamp beside the arc is not enough ${JSON.stringify(boxes.hitbox)}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("estimateFrameBoxes disables hitbox on a padded sword-only attack frame", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-box-sword-only-"));
  try {
    const filePath = path.join(root, "attack.png");
    writePaddedActorPng(filePath, { sword: true });
    const boxes = estimateFrameBoxes(filePath, {
      type: "actor",
      animationId: "attack",
      animationName: "slash",
      frameIndex: 1,
      frameCount: 2,
      groupCanvasWidth: CANVAS_W,
      groupCanvasHeight: CANVAS_H,
    });
    assert.ok(
      !boxes.hitbox || boxes.hitbox.enabled === false,
      `sword-only frame kept an enabled hitbox: ${JSON.stringify(boxes.hitbox)}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
