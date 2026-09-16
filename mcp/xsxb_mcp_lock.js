"use strict";

/**
 * Geometry ruler and lock for walk/run clips: measure bbox/feet/cx, scale about
 * the soles, flood generated plates, and paint honest overlays. Reuses the
 * cutout subjectAnchor so glow-below-boots is not a second geometry model.
 */

const { ALPHA_VISIBLE, parseHexColor, parseProtectedColors, subjectAnchor } = require("./xsxb_mcp_cutout");

const NEAR_WHITE_LUMA = 240;
const NEAR_BLACK_LUMA = 16;

/**
 * Luma of one RGB pixel.
 * @param {number} r Red.
 * @param {number} g Green.
 * @param {number} b Blue.
 * @returns {number} 0–255 luma.
 */
function luma(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Opaque bounding box of every visible pixel, including glow.
 * @param {Uint8ClampedArray|Uint8Array} rgba Pixels.
 * @param {number} width Width.
 * @param {number} height Height.
 * @returns {{minX:number,minY:number,maxX:number,maxY:number,width:number,height:number}|null} Box.
 */
function opaqueBounds(rgba, width, height) {
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
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Mean X of opaque pixels on one row.
 * @param {Uint8ClampedArray|Uint8Array} rgba Pixels.
 * @param {number} width Width.
 * @param {number} y Row.
 * @returns {number} Foot-center X, or NaN.
 */
function rowCenterX(rgba, width, y) {
  let sum = 0;
  let count = 0;
  for (let x = 0; x < width; x += 1) {
    if (rgba[(y * width + x) * 4 + 3] <= ALPHA_VISIBLE) continue;
    sum += x;
    count += 1;
  }
  return count ? sum / count : Number.NaN;
}

/**
 * Per-frame geometry used to lock walk/run clips against idle.
 * @param {Uint8ClampedArray|Uint8Array} rgba Pixels.
 * @param {number} width Width.
 * @param {number} height Height.
 * @returns {object} Geometry.
 */
function measureSpriteGeometry(rgba, width, height) {
  const box = opaqueBounds(rgba, width, height);
  const body = subjectAnchor(rgba, width, height);
  const feetY = body ? body.feetY : box ? box.maxY : 0;
  const headY = body ? body.minY : box ? box.minY : 0;
  const cx = body ? body.centerX : box ? (box.minX + box.maxX) / 2 : width / 2;
  const fxRaw = Number.isInteger(feetY) ? rowCenterX(rgba, width, feetY) : Number.NaN;
  const fx = Number.isFinite(fxRaw) ? fxRaw : cx;
  return {
    canvasW: width,
    canvasH: height,
    bboxW: box ? box.width : 0,
    bboxH: box ? box.height : 0,
    bodyW: body ? body.width : 0,
    bodyH: body ? body.height : 0,
    headY,
    feetY,
    cx,
    fx,
    minX: box ? box.minX : 0,
    minY: box ? box.minY : 0,
    maxX: box ? box.maxX : 0,
    maxY: box ? box.maxY : 0,
  };
}

/**
 * Height used by a lock metric.
 * @param {object} geometry Frame geometry.
 * @param {string} metric bbox|body|torso.
 * @returns {number} Pixels.
 */
function metricHeight(geometry, metric) {
  if (metric === "bbox") return Number(geometry.bboxH || 0);
  if (metric === "torso") return Number(geometry.bodyH || geometry.bboxH || 0);
  return Number(geometry.bodyH || geometry.bboxH || 0);
}

/**
 * Deltas of one frame against a reference pose and the clip's first frame.
 * @param {object} frame Frame geometry.
 * @param {object|null} reference Idle/reference geometry.
 * @param {object|null} first Clip frame 0.
 * @returns {object} Signed deltas.
 */
function geometryDeltas(frame, reference, first) {
  const ref = reference || {};
  const origin = first || frame;
  return {
    dBbox: Number(frame.bboxH || 0) - Number(ref.bboxH || 0),
    dFirst: Number(frame.bboxH || 0) - Number(origin.bboxH || 0),
    dBody: Number(frame.bodyH || 0) - Number(ref.bodyH || 0),
    dFeet: Number(frame.feetY || 0) - Number(ref.feetY || 0),
    dCx: Number(frame.cx || 0) - Number(ref.cx || 0),
    dFx: Number(frame.fx || 0) - Number(ref.fx || 0),
  };
}

/**
 * Scales one frame about the soles, then plants feet and aligns cx/fx.
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} frame Source.
 * @param {object} geometry Source geometry.
 * @param {{scale:number,destFeetX:number,destFeetY:number,alignX:number,sourceX:number}} plan Placement.
 * @returns {{data:Uint8ClampedArray,width:number,height:number}} Locked frame.
 */
function scaleAboutFeet(frame, geometry, plan) {
  const scale = Number(plan.scale);
  const dest = new Uint8ClampedArray(frame.width * frame.height * 4);
  if (!Number.isFinite(scale) || scale <= 0) {
    return { data: new Uint8ClampedArray(frame.data), width: frame.width, height: frame.height };
  }
  const sourceX = Number(plan.sourceX);
  const sourceY = Number(geometry.feetY);
  const destX = Number(plan.destFeetX);
  const destY = Number(plan.destFeetY);
  for (let y = 0; y < frame.height; y += 1) {
    const srcY = Math.round(sourceY + (y - destY) / scale);
    if (srcY < 0 || srcY >= frame.height) continue;
    for (let x = 0; x < frame.width; x += 1) {
      const srcX = Math.round(sourceX + (x - destX) / scale);
      if (srcX < 0 || srcX >= frame.width) continue;
      const sourceOffset = (srcY * frame.width + srcX) * 4;
      if (frame.data[sourceOffset + 3] <= ALPHA_VISIBLE) continue;
      dest.set(frame.data.subarray(sourceOffset, sourceOffset + 4), (y * frame.width + x) * 4);
    }
  }
  return { data: dest, width: frame.width, height: frame.height };
}

/**
 * Builds per-frame scale and plant targets for register_clip.
 * @param {object[]} frames Clip geometry.
 * @param {{mode?:string,metric?:string,align?:string,targetHeight:number,reference?:object,referenceFrame?:number}} options Plan.
 * @returns {object} Register plan.
 */
function planRegisterClip(frames, options = {}) {
  const mode = options.mode === "shared_scale" || options.mode === "shared" ? "shared_scale" : "equalize";
  const metric = options.metric === "bbox" || options.metric === "torso" ? options.metric : "body";
  const align = options.align === "fx" || options.align === "torso" ? options.align : "cx";
  const targetHeight = Math.max(1, Number(options.targetHeight) || 1);
  const reference = options.reference || null;
  const referenceFrame = Number.isInteger(Number(options.referenceFrame))
    ? Math.max(0, Number(options.referenceFrame))
    : 0;
  const pivot = frames[Math.min(referenceFrame, Math.max(0, frames.length - 1))] || frames[0];
  const sharedSource = reference || pivot;
  const sharedScale =
    sharedSource && metricHeight(sharedSource, metric) > 0
      ? targetHeight / metricHeight(sharedSource, metric)
      : 1;
  const destFeetY = reference ? Number(reference.feetY) : Number(pivot?.feetY || 0);
  const destAlign =
    align === "fx"
      ? Number(reference ? reference.fx : pivot?.fx)
      : Number(reference ? reference.cx : pivot?.cx);
  return {
    mode,
    metric,
    align,
    targetBbox: metric === "bbox" ? targetHeight : Number(reference?.bboxH || targetHeight),
    targetHeight,
    destFeetY,
    destAlign,
    frames: frames.map((frame, index) => {
      const height = Math.max(1, metricHeight(frame, metric));
      const scale = mode === "equalize" ? targetHeight / height : sharedScale;
      const sourceX = align === "fx" ? Number(frame.fx) : Number(frame.cx);
      return {
        index,
        scale: Number(scale.toFixed(4)),
        sourceX,
        destFeetX: destAlign,
        destFeetY,
        metricHeight: height,
      };
    }),
  };
}

/**
 * True when RGB is a yellow/gold family sample (saturated core or pale glow).
 * Achromatic studio white is excluded so border flood can still key the plate.
 * @param {number} r Red.
 * @param {number} g Green.
 * @param {number} b Blue.
 * @returns {boolean} Yellow/gold family.
 */
function isYellowGoldFamily(r, g, b) {
  const sat = Math.max(r, g, b) - Math.min(r, g, b);
  if (sat < 28 || r < 180 || g < 140 || b >= g) return false;
  return r - b >= 36 && g - b >= 16;
}

/**
 * True when a pixel matches a protected RGB swatch.
 * Yellow/gold swatches also protect the pale crescent glow that sits next to a
 * white plate — a tight RGB box misses those high-luma yellows.
 * @param {number} r Red.
 * @param {number} g Green.
 * @param {number} b Blue.
 * @param {Array<{r:number,g:number,b:number}>} protectedColors Swatches.
 * @param {number} tolerance Channel slop.
 * @returns {boolean} Protected.
 */
function isProtected(r, g, b, protectedColors, tolerance) {
  const goldSample = isYellowGoldFamily(r, g, b);
  for (const color of protectedColors) {
    if (
      Math.abs(r - color.r) <= tolerance &&
      Math.abs(g - color.g) <= tolerance &&
      Math.abs(b - color.b) <= tolerance
    ) {
      return true;
    }
    if (goldSample && isYellowGoldFamily(color.r, color.g, color.b)) return true;
  }
  return false;
}

/**
 * Picks the plate the border flood should key. MCP passes keyMode=border_flood
 * together with key_color; that string is not a plate kind.
 * @param {{mode?:string,keyMode?:string,key_mode?:string,keyColor?:string,key_color?:string}} options Flood options.
 * @returns {"near_black"|"near_white"|"any"} Plate kind.
 */
function resolveBorderFloodMode(options = {}) {
  const mode = String(options.mode || "");
  if (mode === "near_black" || mode === "near_white" || mode === "any") return mode;
  const keyMode = String(options.keyMode || options.key_mode || "");
  if (keyMode === "near_black" || keyMode === "near_white" || keyMode === "any") return keyMode;
  const parsed = parseHexColor(options.keyColor || options.key_color || "");
  if (parsed && Math.max(parsed.r, parsed.g, parsed.b) <= 24) return "near_black";
  if (parsed && Math.min(parsed.r, parsed.g, parsed.b) >= 232) return "near_white";
  return keyMode === "border_flood" ? "any" : "near_white";
}

/**
 * Floods near-white or near-black studio plate from the border to transparent.
 * @param {Uint8ClampedArray|Uint8Array} rgba Pixels.
 * @param {number} width Width.
 * @param {number} height Height.
 * @param {{protectedColors?:unknown,tolerance?:number,mode?:string}} [options] Flood options.
 * @returns {{data:Uint8ClampedArray,keyed:number}} Result.
 */
function borderFloodKey(rgba, width, height, options = {}) {
  const dest = new Uint8ClampedArray(rgba);
  const protectedColors = parseProtectedColors(options.protectedColors || options.protected_colors || []);
  const tolerance = Math.max(0, Number(options.tolerance ?? 18));
  const mode = resolveBorderFloodMode(options);
  const visited = new Uint8Array(width * height);
  const queue = [];
  /**
   * Enqueues a border or flood neighbor.
   * @param {number} x Column.
   * @param {number} y Row.
   * @returns {void}
   */
  function enqueue(x, y) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = y * width + x;
    if (visited[index]) return;
    visited[index] = 1;
    queue.push(index);
  }
  for (let x = 0; x < width; x += 1) {
    enqueue(x, 0);
    enqueue(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(0, y);
    enqueue(width - 1, y);
  }
  let keyed = 0;
  while (queue.length) {
    const index = queue.pop();
    const offset = index * 4;
    const r = dest[offset];
    const g = dest[offset + 1];
    const b = dest[offset + 2];
    const a = dest[offset + 3];
    if (a <= ALPHA_VISIBLE) {
      const x = index % width;
      const y = Math.floor(index / width);
      enqueue(x + 1, y);
      enqueue(x - 1, y);
      enqueue(x, y + 1);
      enqueue(x, y - 1);
      continue;
    }
    if (isProtected(r, g, b, protectedColors, Math.max(4, tolerance))) continue;
    const sample = luma(r, g, b);
    const maxc = Math.max(r, g, b);
    const minc = Math.min(r, g, b);
    const nearWhite = sample >= NEAR_WHITE_LUMA - tolerance;
    // Neutral black plate only. Dark navy trousers (high B, low luma) are clothes.
    const nearBlack = maxc <= 24 && maxc - minc <= 12;
    const hit = mode === "near_black" ? nearBlack : mode === "any" ? nearWhite || nearBlack : nearWhite;
    if (!hit) continue;
    dest[offset + 3] = 0;
    keyed += 1;
    const x = index % width;
    const y = Math.floor(index / width);
    enqueue(x + 1, y);
    enqueue(x - 1, y);
    enqueue(x, y + 1);
    enqueue(x, y - 1);
  }
  return { data: dest, keyed };
}

/**
 * Composites two same-size frames as red / cyan / white intersection.
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} frameA First.
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} frameB Second.
 * @returns {{data:Uint8ClampedArray,width:number,height:number,mse:number,legWidthA:number,legWidthB:number}} Overlay.
 */
function composeRbOverlay(frameA, frameB) {
  const width = Math.max(frameA.width, frameB.width);
  const height = Math.max(frameA.height, frameB.height);
  const dest = new Uint8ClampedArray(width * height * 4);
  let error = 0;
  let samples = 0;
  let legA = 0;
  let legB = 0;
  const feetYA = subjectAnchor(frameA.data, frameA.width, frameA.height)?.feetY;
  const feetYB = subjectAnchor(frameB.data, frameB.width, frameB.height)?.feetY;
  for (let y = 0; y < height; y += 1) {
    let rowA = 0;
    let rowB = 0;
    for (let x = 0; x < width; x += 1) {
      const aOn =
        x < frameA.width && y < frameA.height && frameA.data[(y * frameA.width + x) * 4 + 3] > ALPHA_VISIBLE;
      const bOn =
        x < frameB.width && y < frameB.height && frameB.data[(y * frameB.width + x) * 4 + 3] > ALPHA_VISIBLE;
      const offset = (y * width + x) * 4;
      if (aOn) rowA += 1;
      if (bOn) rowB += 1;
      if (aOn && bOn) dest.set([255, 255, 255, 255], offset);
      else if (aOn) dest.set([255, 0, 0, 255], offset);
      else if (bOn) dest.set([0, 255, 255, 255], offset);
      if (aOn || bOn) {
        const aOff = aOn ? (y * frameA.width + x) * 4 : -1;
        const bOff = bOn ? (y * frameB.width + x) * 4 : -1;
        const ar = aOff >= 0 ? frameA.data[aOff] : 0;
        const ag = aOff >= 0 ? frameA.data[aOff + 1] : 0;
        const ab = aOff >= 0 ? frameA.data[aOff + 2] : 0;
        const br = bOff >= 0 ? frameB.data[bOff] : 0;
        const bg = bOff >= 0 ? frameB.data[bOff + 1] : 0;
        const bb = bOff >= 0 ? frameB.data[bOff + 2] : 0;
        error += (ar - br) ** 2 + (ag - bg) ** 2 + (ab - bb) ** 2;
        samples += 1;
      }
    }
    if (y === feetYA) legA = rowA;
    if (y === feetYB) legB = rowB;
  }
  return {
    data: dest,
    width,
    height,
    mse: samples ? error / samples : 0,
    legWidthA: legA,
    legWidthB: legB,
  };
}

/**
 * Resolves a GIF/sheet flatten color. Magenta is the default chroma key.
 * @param {unknown} value Named or hex color.
 * @returns {{r:number,g:number,b:number,kind:string}|null} Color, or null for transparent.
 */
function resolvePreviewBackground(value) {
  if (value === undefined || value === null || value === "") {
    return { r: 255, g: 0, b: 255, kind: "magenta" };
  }
  const raw = String(value).trim().toLowerCase();
  if (raw === "transparent" || raw === "none") return null;
  if (raw === "checker") return { r: 0, g: 0, b: 0, kind: "checker" };
  if (raw === "magenta") return { r: 255, g: 0, b: 255, kind: "magenta" };
  if (raw === "black") return { r: 0, g: 0, b: 0, kind: "black" };
  if (raw === "green" || raw === "#00ff00" || raw === "00ff00") {
    return { r: 0, g: 255, b: 0, kind: "green" };
  }
  const parsed = parseHexColor(raw.startsWith("#") ? raw : `#${raw}`);
  return { ...parsed, kind: "hex" };
}

/**
 * Flattens one RGBA frame onto a solid or checker field.
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} frame Source.
 * @param {{r:number,g:number,b:number,kind:string}|null} background Field.
 * @returns {{data:Uint8ClampedArray,width:number,height:number}} Opaque frame.
 */
function flattenFrameBackground(frame, background) {
  const dest = new Uint8ClampedArray(frame.width * frame.height * 4);
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const offset = (y * frame.width + x) * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      if (background?.kind === "checker") {
        const on = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0;
        r = on ? 200 : 80;
        g = r;
        b = r;
      } else if (background) {
        r = background.r;
        g = background.g;
        b = background.b;
      }
      const alpha = frame.data[offset + 3] / 255;
      dest[offset] = Math.round(frame.data[offset] * alpha + r * (1 - alpha));
      dest[offset + 1] = Math.round(frame.data[offset + 1] * alpha + g * (1 - alpha));
      dest[offset + 2] = Math.round(frame.data[offset + 2] * alpha + b * (1 - alpha));
      dest[offset + 3] = 255;
    }
  }
  return { data: dest, width: frame.width, height: frame.height };
}

/**
 * Blits a source frame into a contact-sheet cell at 1:1, optionally planting feet.
 * @param {object} sheet Destination sheet.
 * @param {object} frame Source frame.
 * @param {number} originX Cell left.
 * @param {number} originY Cell top.
 * @param {number} cell Cell edge.
 * @param {string} normalize none|feet|height|cell.
 * @param {boolean} [plant] When false, blit 1:1 from the canvas origin (look sheets).
 * @returns {void}
 */
function blitFrameIntoCell(sheet, frame, originX, originY, cell, normalize, plant) {
  const geometry = measureSpriteGeometry(frame.data, frame.width, frame.height);
  let scale = 1;
  if (normalize === "cell") {
    scale = cell / Math.max(frame.width, frame.height, 1);
  } else if (normalize === "height" && geometry.bboxH > 0) {
    scale = cell / geometry.bboxH;
  }
  const plantFeet =
    plant !== false && (normalize === "feet" || normalize === "height" || normalize === "none");
  const destFeetY = originY + cell - 1;
  const destFeetX = originX + Math.floor(cell / 2);
  for (let y = 0; y < cell; y += 1) {
    for (let x = 0; x < cell; x += 1) {
      let sourceX;
      let sourceY;
      if (normalize === "cell") {
        sourceX = Math.min(frame.width - 1, Math.floor(((x + 0.5) * frame.width) / cell));
        sourceY = Math.min(frame.height - 1, Math.floor(((y + 0.5) * frame.height) / cell));
      } else if (plantFeet) {
        sourceX = Math.round(geometry.fx + (originX + x - destFeetX) / scale);
        sourceY = Math.round(geometry.feetY + (originY + y - destFeetY) / scale);
      } else {
        sourceX = x;
        sourceY = y;
      }
      if (sourceX < 0 || sourceY < 0 || sourceX >= frame.width || sourceY >= frame.height) continue;
      const source = (sourceY * frame.width + sourceX) * 4;
      if (frame.data[source + 3] <= ALPHA_VISIBLE) continue;
      const dest = ((originY + y) * sheet.width + (originX + x)) * 4;
      sheet.data[dest] = frame.data[source];
      sheet.data[dest + 1] = frame.data[source + 1];
      sheet.data[dest + 2] = frame.data[source + 2];
      sheet.data[dest + 3] = 255;
    }
  }
}

module.exports = {
  borderFloodKey,
  blitFrameIntoCell,
  composeRbOverlay,
  flattenFrameBackground,
  geometryDeltas,
  measureSpriteGeometry,
  metricHeight,
  planRegisterClip,
  resolvePreviewBackground,
  scaleAboutFeet,
};
