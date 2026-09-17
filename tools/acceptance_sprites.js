"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { encodePngRgba } = require("../mcp/xsxb_mcp_cutout");

const PLATE = Object.freeze([248, 248, 248, 255]);
const BODY = Object.freeze([24, 48, 96, 255]);
const BOOT = Object.freeze([12, 20, 40, 255]);

const HERO = Object.freeze({
  width: 64,
  height: 64,
  feetX: 32,
  feetY: 55,
});

const HERO_COLORS = Object.freeze({
  hair: Object.freeze([56, 36, 24, 255]),
  skin: Object.freeze([214, 166, 124, 255]),
  coat: Object.freeze([24, 48, 96, 255]),
  shirt: Object.freeze([40, 80, 140, 255]),
  belt: Object.freeze([168, 124, 48, 255]),
  pant: Object.freeze([16, 36, 80, 255]),
  boot: Object.freeze([12, 20, 40, 255]),
  eye: Object.freeze([28, 20, 16, 255]),
  steel: Object.freeze([196, 204, 212, 255]),
  glow: Object.freeze([255, 224, 64, 255]),
  crate: Object.freeze([132, 84, 44, 255]),
  crateDark: Object.freeze([88, 52, 28, 255]),
});

/**
 * Paints a navy body and darker boots on a studio plate.
 * @param {number} width Canvas width.
 * @param {number} height Canvas height.
 * @param {{originX:number,originY:number,bodyW?:number,bodyH?:number,plate?:number[]}} pose
 *   Body top-left and size.
 * @returns {Uint8ClampedArray} RGBA pixels.
 */
function paintGroundedActor(width, height, pose) {
  const data = new Uint8ClampedArray(width * height * 4);
  const bodyW = pose.bodyW || 8;
  const bodyH = pose.bodyH || 14;
  const plate = pose.plate || PLATE;
  for (let i = 0; i < width * height; i += 1) data.set(plate, i * 4);
  for (let y = pose.originY; y < pose.originY + bodyH; y += 1) {
    for (let x = pose.originX; x < pose.originX + bodyW; x += 1) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const boot = y >= pose.originY + bodyH - 2;
      data.set(boot ? BOOT : BODY, (y * width + x) * 4);
    }
  }
  return data;
}

/**
 * Writes one opaque pixel when the coordinate is inside the canvas.
 * @param {Uint8ClampedArray} data RGBA buffer.
 * @param {number} width Canvas width.
 * @param {number} height Canvas height.
 * @param {number} x Column.
 * @param {number} y Row.
 * @param {readonly number[]} color RGBA.
 * @returns {void}
 */
function putPixel(data, width, height, x, y, color) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  data.set(color, (y * width + x) * 4);
}

/**
 * Fills an inclusive rectangle.
 * @param {Uint8ClampedArray} data RGBA buffer.
 * @param {number} width Canvas width.
 * @param {number} height Canvas height.
 * @param {number} x0 Left.
 * @param {number} y0 Top.
 * @param {number} x1 Right inclusive.
 * @param {number} y1 Bottom inclusive.
 * @param {readonly number[]} color RGBA.
 * @returns {void}
 */
function fillRect(data, width, height, x0, y0, x1, y1, color) {
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) putPixel(data, width, height, x, y, color);
  }
}

/**
 * Paints one leg from hip to sole.
 * @param {Uint8ClampedArray} data RGBA buffer.
 * @param {number} width Canvas width.
 * @param {number} height Canvas height.
 * @param {number} footX Foot center.
 * @param {number} hipY Hip row.
 * @param {number} soleY Sole row.
 * @returns {void}
 */
function paintLeg(data, width, height, footX, hipY, soleY) {
  const bootTop = soleY - 2;
  fillRect(data, width, height, footX - 1, hipY, footX + 1, bootTop - 1, HERO_COLORS.pant);
  fillRect(data, width, height, footX - 2, bootTop, footX + 2, soleY, HERO_COLORS.boot);
}

/**
 * Paints a 64×64-class hero: hair, face, coat, belt, two legs, boots, optional
 * sword and a reaching gold slash past the body (crescent-sized, not a hair spark).
 * @param {number} width Canvas width.
 * @param {number} height Canvas height.
 * @param {{
 *   plate?:number[],
 *   feetX?:number,
 *   feetY?:number,
 *   lift?:number,
 *   stride?:number,
 *   arm?:number,
 *   tall?:number,
 *   sword?:boolean,
 *   slash?:boolean,
 * }} [pose] Stance. `lift` raises the whole body; `stride` splits the feet.
 * @returns {Uint8ClampedArray} RGBA pixels.
 */
function paintHero(width, height, pose = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  const plate = pose.plate || PLATE;
  for (let i = 0; i < width * height; i += 1) data.set(plate, i * 4);
  const feetX = Number.isFinite(Number(pose.feetX)) ? Number(pose.feetX) : HERO.feetX;
  const planted = Number.isFinite(Number(pose.feetY)) ? Number(pose.feetY) : HERO.feetY;
  const lift = Number(pose.lift) || 0;
  const stride = Number(pose.stride) || 0;
  const arm = Number(pose.arm) || 0;
  const tall = Number(pose.tall) || 0;
  const soleY = planted - lift;
  const hipY = soleY - 13;
  const torsoTop = hipY - 12 - tall;
  const headTop = torsoTop - 8;
  const hairTop = headTop - 2;
  const shoulderY = torsoTop + 2;
  if (pose.slash) {
    const slashY = shoulderY + 2;
    for (let i = 0; i < 22; i += 1) {
      const x = feetX + 8 + i;
      const y = slashY + Math.floor(i / 3);
      fillRect(data, width, height, x, y, x + 2, y + 3, HERO_COLORS.glow);
    }
  }
  paintLeg(data, width, height, feetX - 4 - stride, hipY, soleY);
  paintLeg(data, width, height, feetX + 3 + stride, hipY, soleY);
  fillRect(data, width, height, feetX - 6, torsoTop, feetX + 6, hipY, HERO_COLORS.coat);
  fillRect(data, width, height, feetX - 4, torsoTop + 3, feetX + 4, hipY - 3, HERO_COLORS.shirt);
  fillRect(data, width, height, feetX - 6, hipY - 1, feetX + 6, hipY + 1, HERO_COLORS.belt);
  fillRect(data, width, height, feetX - 4, hairTop, feetX + 4, headTop + 1, HERO_COLORS.hair);
  fillRect(data, width, height, feetX - 3, headTop, feetX + 3, torsoTop - 1, HERO_COLORS.skin);
  putPixel(data, width, height, feetX - 1, headTop + 3, HERO_COLORS.eye);
  putPixel(data, width, height, feetX + 2, headTop + 3, HERO_COLORS.eye);
  const handX = feetX + 8 + arm * 3;
  const handY = shoulderY + 8 - arm * 4;
  fillRect(data, width, height, feetX + 6, shoulderY, handX, shoulderY + 2, HERO_COLORS.coat);
  fillRect(data, width, height, handX - 1, handY - 1, handX + 1, handY + 6 - Math.abs(arm), HERO_COLORS.coat);
  fillRect(data, width, height, handX - 1, handY + 5 - Math.abs(arm), handX + 1, handY + 6, HERO_COLORS.skin);
  fillRect(data, width, height, feetX - 8, shoulderY + 1, feetX - 6, hipY - 2, HERO_COLORS.coat);
  if (pose.sword) {
    fillRect(data, width, height, handX + 1, handY - 10, handX + 2, handY + 2, HERO_COLORS.steel);
    fillRect(data, width, height, handX - 1, handY + 1, handX + 4, handY + 2, HERO_COLORS.belt);
  }
  return data;
}

/**
 * Paints a radial hit burst, not a standing body.
 * @param {number} width Canvas width.
 * @param {number} height Canvas height.
 * @param {{plate?:number[],cx?:number,cy?:number,radius?:number}} [pose] Burst center.
 * @returns {Uint8ClampedArray} RGBA pixels.
 */
function paintBurst(width, height, pose = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  const plate = pose.plate || PLATE;
  for (let i = 0; i < width * height; i += 1) data.set(plate, i * 4);
  const cx = Number.isFinite(Number(pose.cx)) ? Number(pose.cx) : Math.floor(width / 2);
  const cy = Number.isFinite(Number(pose.cy)) ? Number(pose.cy) : 18;
  const radius = Number(pose.radius) || 11;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= 2) putPixel(data, width, height, x, y, [255, 248, 200, 255]);
      else if (Math.abs(dist - radius * 0.45) < 1.2) putPixel(data, width, height, x, y, [255, 160, 48, 255]);
      else if (Math.abs(dist - radius) < 1.2) putPixel(data, width, height, x, y, [255, 72, 40, 255]);
    }
  }
  for (const [sx, sy] of [
    [cx + radius + 3, cy - 2],
    [cx - radius - 2, cy + 1],
    [cx + 2, cy - radius - 2],
    [cx - 4, cy + radius],
  ]) {
    fillRect(data, width, height, sx, sy, sx + 1, sy + 1, [255, 220, 80, 255]);
  }
  return data;
}

/**
 * Paints a crate prop that is not a grounded actor.
 * @param {number} width Canvas width.
 * @param {number} height Canvas height.
 * @param {{plate?:number[],x?:number,y?:number}} [pose] Box top-left.
 * @returns {Uint8ClampedArray} RGBA pixels.
 */
function paintCrate(width, height, pose = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  const plate = pose.plate || PLATE;
  for (let i = 0; i < width * height; i += 1) data.set(plate, i * 4);
  const x = Number.isFinite(Number(pose.x)) ? Number(pose.x) : 22;
  const y = Number.isFinite(Number(pose.y)) ? Number(pose.y) : 28;
  fillRect(data, width, height, x, y, x + 18, y + 16, HERO_COLORS.crate);
  fillRect(data, width, height, x + 2, y + 2, x + 16, y + 14, HERO_COLORS.crateDark);
  fillRect(data, width, height, x + 8, y, x + 9, y + 16, HERO_COLORS.crate);
  return data;
}

/**
 * Builds one hero frame on the shared 64×64 stage.
 * @param {object} [pose] Stance overrides.
 * @returns {{data:Uint8ClampedArray,width:number,height:number}} Frame.
 */
function heroFrame(pose = {}) {
  return {
    width: HERO.width,
    height: HERO.height,
    data: paintHero(HERO.width, HERO.height, {
      feetX: HERO.feetX,
      feetY: HERO.feetY,
      ...pose,
    }),
  };
}

/**
 * Writes numbered PNG frames into a directory.
 * @param {string} directory Output folder.
 * @param {Array<{data:Uint8ClampedArray,width:number,height:number}>} frames Frames.
 * @returns {string} Directory.
 */
function writePngSequence(directory, frames) {
  fs.mkdirSync(directory, { recursive: true });
  frames.forEach((frame, index) => {
    fs.writeFileSync(
      path.join(directory, `${String(index).padStart(2, "0")}.png`),
      encodePngRgba(frame.data, frame.width, frame.height),
    );
  });
  return directory;
}

/**
 * Counts pixels that match a predicate.
 * @param {{data:Uint8ClampedArray|Uint8Array}} image Decoded PNG.
 * @param {(r:number,g:number,b:number,a:number)=>boolean} test Pixel test.
 * @returns {number} Count.
 */
function countPixels(image, test) {
  let count = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    if (test(image.data[i], image.data[i + 1], image.data[i + 2], image.data[i + 3])) count += 1;
  }
  return count;
}

const isTrueMagenta = (r, g, b, a) => r >= 220 && g <= 40 && b >= 180 && a > 200;
const isOnionRed = (r, g, b, a) => r >= 180 && g <= 40 && b <= 40 && a > 200;
const isOnionCyan = (r, g, b, a) => r <= 40 && g >= 180 && b >= 180 && a > 200;

module.exports = {
  BOOT,
  BODY,
  HERO,
  HERO_COLORS,
  PLATE,
  countPixels,
  heroFrame,
  isOnionCyan,
  isOnionRed,
  isTrueMagenta,
  paintBurst,
  paintCrate,
  paintGroundedActor,
  paintHero,
  writePngSequence,
};
