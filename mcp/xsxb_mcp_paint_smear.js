"use strict";

/**
 * Paints a pixel-layer weapon crescent from blade geometry. The smear is the
 * annular sector the edge would sweep; it is not a placed PNG.
 */

const fs = require("node:fs");
const path = require("node:path");
const { mcpArtifactDir, requireExistingFile, resolveMcpArtifactPath } = require("./xsxb_mcp_arguments");
const { decodePngRgba, encodePngRgba } = require("./xsxb_mcp_cutout");
const { flattenFrameBackground, resolvePreviewBackground } = require("./xsxb_mcp_lock");
const { assertOverlayId, cellBox, deriveFromCells } = require("./xsxb_mcp_place");
const { compositeOccludedObject, resolveOcclusion } = require("./xsxb_mcp_place_occlusion");
const { compileSmearBrief } = require("./xsxb_mcp_smear_brief");

const HEX_COLOR = /^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})$/;

/**
 * Parses a smear #RGB or #RRGGBB color.
 * @param {string} value Hex color.
 * @returns {{r:number,g:number,b:number}} RGB.
 */
function parseSmearHex(value) {
  const text = String(value || "").trim();
  if (!HEX_COLOR.test(text)) throw new Error("color must be a sampled #RGB or #RRGGBB hex.");
  const hex = text.slice(1);
  const full = hex.length === 3 ? `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}` : hex;
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

/**
 * Wraps an angle delta onto (-π, π].
 * @param {number} delta Raw delta.
 * @returns {number} Wrapped delta.
 */
function wrapDelta(delta) {
  let value = delta;
  while (value > Math.PI) value -= Math.PI * 2;
  while (value <= -Math.PI) value += Math.PI * 2;
  return value;
}

/**
 * Deterministic 0..1 hash from an integer bin.
 * @param {number} bin Angle bin.
 * @returns {number} Unit value.
 */
function unitHash(bin) {
  let value = Math.imul(bin ^ 0x9e3779b9, 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return ((value >>> 0) % 1000) / 999;
}

/**
 * Smoothstep from 0 to 1 across an edge.
 * @param {number} edge0 Start.
 * @param {number} edge1 End.
 * @param {number} value Sample.
 * @returns {number} 0..1.
 */
function smoothstep(edge0, edge1, value) {
  if (edge1 <= edge0) return value >= edge1 ? 1 : 0;
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Paints a hollow ice crescent into a new RGBA buffer. Source pixels are not
 * copied; callers composite with layer=behind.
 * @param {number} width Canvas width.
 * @param {number} height Canvas height.
 * @param {{pivot:{x:number,y:number},tip:{x:number,y:number},start?:{x:number,y:number},useStartArc?:boolean,color:{r:number,g:number,b:number},arcDegrees?:number,innerRatio?:number,outerScale?:number}} spec Geometry.
 * @returns {{data:Uint8ClampedArray,painted:number,rInner:number,rOuter:number,theta:number,halfArc:number}} Layer.
 */
function paintCrescentRgba(width, height, spec) {
  const pivot = spec.pivot;
  const tip = spec.tip;
  const color = spec.color;
  const rTip = Math.hypot(tip.x - pivot.x, tip.y - pivot.y);
  if (!(rTip > 8)) throw new Error("pivot and tip must be more than 8 pixels apart.");
  const innerRatio = Math.min(0.85, Math.max(0.12, Number(spec.innerRatio) || 0.42));
  const outerScale = Math.min(1.6, Math.max(1.02, Number(spec.outerScale) || 1.12));
  const arcDegrees = Math.min(170, Math.max(40, Number(spec.arcDegrees) || 120));
  const rInner = rTip * innerRatio;
  const rOuter = rTip * outerScale;
  const thetaTip = Math.atan2(tip.y - pivot.y, tip.x - pivot.x);
  const halfArc = (arcDegrees * Math.PI) / 180 / 2;
  let theta0 = thetaTip - halfArc;
  let span = halfArc * 2;
  if (spec.useStartArc && spec.start && Number.isFinite(spec.start.x) && Number.isFinite(spec.start.y)) {
    const thetaStart = Math.atan2(spec.start.y - pivot.y, spec.start.x - pivot.x);
    const motion = wrapDelta(thetaTip - thetaStart);
    if (Math.abs(motion) > (28 * Math.PI) / 180) {
      const overshoot = Math.min(Math.abs(motion) * 0.16, (16 * Math.PI) / 180);
      theta0 = thetaStart;
      span = motion + Math.sign(motion) * overshoot;
    }
  }
  const absSpan = Math.abs(span);
  const data = new Uint8ClampedArray(width * height * 4);
  let painted = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x + 0.5 - pivot.x;
      const dy = y + 0.5 - pivot.y;
      const radius = Math.hypot(dx, dy);
      if (radius > rOuter + 1.5 || radius < rInner * 0.55) continue;
      const from0 = wrapDelta(Math.atan2(dy, dx) - theta0);
      const along = from0 / span;
      if (along < 0 || along > 1) continue;
      const bin = Math.floor((((Math.atan2(dy, dx) + Math.PI) / (Math.PI * 2)) * 64) % 64);
      const notch = 0.7 + 0.3 * unitHash(bin);
      const inner = rInner * notch;
      if (radius < inner) continue;
      const radial = (radius - inner) / Math.max(1, rOuter - inner);
      if (radial > 1.05) continue;
      const body = smoothstep(0.04, 0.28, radial) * (1 - smoothstep(0.86, 1.02, radial));
      const rim = smoothstep(0.76, 0.9, radial) * (1 - smoothstep(0.96, 1.05, radial));
      const shard = unitHash(bin + 17) > 0.82 && radial > 0.55 && radial < 0.98 ? 0.35 : 0;
      const angular = smoothstep(0, 0.1, along) * (1 - smoothstep(0.88, 1, along));
      const alpha = Math.min(1, (body * 0.82 + rim * 0.95 + shard) * Math.max(0.15, angular));
      if (alpha <= 0.02) continue;
      const highlight = Math.min(1, rim * 0.7 + shard);
      const off = (y * width + x) * 4;
      data[off] = Math.round(color.r + (255 - color.r) * highlight);
      data[off + 1] = Math.round(color.g + (255 - color.g) * highlight);
      data[off + 2] = Math.round(color.b + (255 - color.b) * Math.min(1, highlight * 0.85));
      data[off + 3] = Math.round(alpha * 255);
      painted += 1;
    }
  }
  if (painted < 24) throw new Error("painted crescent collapsed; check pivot, tip, and arc_degrees.");
  return { data, painted, rInner, rOuter, theta: thetaTip, halfArc: absSpan / 2 };
}

/**
 * Resolves a speakable cell to its geometric center. Empty cells are allowed.
 * @param {object} view Overlay view.
 * @param {string} cellId Cell id.
 * @returns {{x:number,y:number}} Center.
 */
function cellCenter(view, cellId) {
  return deriveFromCells({ view, cells: [cellId], derive: "center" });
}

/**
 * Finds the opaque pixel in a cell farthest from the pivot (blade tip).
 * @param {{data:Uint8ClampedArray,width:number,height:number}} image Target RGBA.
 * @param {object} view Overlay view.
 * @param {string} cellId Speakable cell.
 * @param {{x:number,y:number}} pivot Grip.
 * @returns {{x:number,y:number}|null} Tip, or null when the cell is empty.
 */
function farthestOpaqueInCell(image, view, cellId, pivot) {
  const box = cellBox(view, cellId);
  const x0 = Math.max(0, Math.floor(box.x1));
  const y0 = Math.max(0, Math.floor(box.y1));
  const x1 = Math.min(image.width, Math.ceil(box.x2));
  const y1 = Math.min(image.height, Math.ceil(box.y2));
  let best = null;
  let bestDistance = -1;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (image.data[(y * image.width + x) * 4 + 3] < 40) continue;
      const distance = Math.hypot(x + 0.5 - pivot.x, y + 0.5 - pivot.y);
      if (distance > bestDistance) {
        bestDistance = distance;
        best = { x: x + 0.5, y: y + 0.5 };
      }
    }
  }
  return best;
}

/**
 * Picks the committed-swing frame, else the last traced frame.
 * @param {object[]} frames Brief frames.
 * @returns {object} Frame.
 */
function committedFrame(frames) {
  const solid = frames.filter((frame) => frame.weight === "solid");
  return solid.at(-1) || frames.at(-1);
}

/**
 * Paints a crescent onto a still PNG using overlay cells as blade landmarks.
 * @param {object} args Tool arguments.
 * @param {{root:string,artifactDir?:string}} options Service paths.
 * @returns {object} Paint receipt fields.
 */
function paintSmearOnTarget(args, options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const artifactDir = options.artifactDir || mcpArtifactDir("", root);
  const targetPath = requireExistingFile(args.target_path, "Smear target");
  if (!/\.png$/i.test(targetPath)) throw new Error("target_path must be a PNG file.");
  const overlayId = String(args.overlay_id || "").trim();
  if (!overlayId) {
    const error = new Error("target_path paint requires overlay_id from xsxb_overlay_grid.");
    error.code = "MISSING_OVERLAY";
    throw error;
  }
  const view = args.view;
  assertOverlayId(targetPath, view, overlayId, "overlay_id");
  const pivotCells = Array.isArray(args.pivot_cells) ? args.pivot_cells : [];
  if (!pivotCells.length) throw new Error("pivot_cells must name the grip cell on the target overlay.");
  const frame = committedFrame(args.frames || []);
  const tipCell = String(frame?.head || frame?.end || "").trim();
  if (!tipCell) throw new Error("frames must include a head or end cell for the current blade tip.");
  const pivot = deriveFromCells({ view, cells: pivotCells, derive: "center" });
  const startCell = String(frame?.start || "").trim();
  const start = startCell ? cellCenter(view, startCell) : null;
  const target = decodePngRgba(targetPath);
  const tip =
    farthestOpaqueInCell(target, view, tipCell, pivot) ||
    (String(frame?.end || "").trim() && String(frame.end).toUpperCase() !== tipCell
      ? farthestOpaqueInCell(target, view, String(frame.end).toUpperCase(), pivot)
      : null) ||
    cellCenter(view, tipCell);
  const explicitArc = Number(args.arc_degrees);
  let arcDegrees = explicitArc;
  if (start && !Number.isFinite(arcDegrees)) {
    const span =
      (Math.abs(
        wrapDelta(
          Math.atan2(tip.y - pivot.y, tip.x - pivot.x) - Math.atan2(start.y - pivot.y, start.x - pivot.x),
        ),
      ) *
        180) /
      Math.PI;
    arcDegrees = Math.max(90, Math.min(160, span * 2.2));
  }
  if (!Number.isFinite(arcDegrees)) arcDegrees = 120;
  const painted = paintCrescentRgba(target.width, target.height, {
    pivot,
    tip,
    start: start || undefined,
    useStartArc: Boolean(start) && !Number.isFinite(explicitArc),
    color: parseSmearHex(args.color),
    arcDegrees,
    innerRatio: args.inner_ratio,
    outerScale: args.outer_scale,
  });
  const layer = String(args.layer || "behind").trim() || "behind";
  const occlusion = resolveOcclusion(undefined, target, targetPath, root, layer, null, () => null);
  const composite = compositeOccludedObject(target, painted.data, occlusion);
  const outputPath = resolveMcpArtifactPath(args.output_path, {
    root,
    artifactDir,
    defaultName: `${path.parse(targetPath).name}_smear.png`,
    extensionPattern: /\.png$/i,
    extensionLabel: ".png",
  });
  const previewPath = outputPath.replace(/\.png$/i, "_preview.png");
  const magenta = flattenFrameBackground(
    { data: composite.data, width: target.width, height: target.height },
    resolvePreviewBackground("magenta"),
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, encodePngRgba(composite.data, target.width, target.height));
  fs.writeFileSync(previewPath, encodePngRgba(magenta.data, target.width, target.height));
  return {
    output_path: outputPath,
    preview: { kind: "magenta", path: previewPath },
    painted_pixels: painted.painted,
    pivot,
    tip,
    arc_degrees: arcDegrees,
    layer,
    method: "pixel_crescent",
  };
}

/**
 * Compiles the smear brief and, when target_path is set, paints the crescent.
 * @param {object} args Tool arguments.
 * @param {{root:string,artifactDir?:string}} [options] Service paths.
 * @returns {object} Brief, plus paint fields when a still was written.
 */
function planSmear(args = {}, options = {}) {
  const planned = compileSmearBrief(args);
  const targetPath = String(args.target_path || "").trim();
  if (!targetPath) return planned;
  return { ...planned, ...paintSmearOnTarget({ ...args, frames: planned.frames }, options) };
}

module.exports = {
  paintCrescentRgba,
  paintSmearOnTarget,
  parseSmearHex,
  planSmear,
};
