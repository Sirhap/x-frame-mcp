"use strict";

const { normalizeTrailId } = require("./lib/attack_trails");
const { decodePngRgba, encodePngRgba } = require("./xsxb_mcp_cutout");
const { renderContactSheet } = require("./xsxb_mcp_visual_qa");

const MAX_HITS = 12;
const INLINE_TRAIL_PNG = Symbol("inline trail preview");

/** A timed brush follows the one attachment present at both ends of this swing. */
function selectWeapon(byFrame, start, end) {
  const ids = (frame) => new Set((byFrame.get(frame) || []).map((binding) => binding.id).filter(Boolean));
  const last = ids(end);
  const candidates = [...ids(start)].filter((id) => last.has(id)).sort();
  if (candidates.length === 1) return candidates[0];
  const reason = candidates.length
    ? `Choose attachment_id from: ${candidates.join(", ")}.`
    : "Bind the weapon on both frames, or supply two sticks for a painted blade.";
  const error = new Error(`Frames ${start} and ${end}: ${reason}`);
  error.details = { start_frame: start, end_frame: end, attachment_ids: candidates };
  throw error;
}

/** Match an existing stroke before allocating an ID. Legacy auto IDs encode their original endpoints. */
function identifyHit(segments, args, source) {
  if (args.id !== undefined) {
    const id = normalizeTrailId(args.id, "");
    if (!id) throw new Error("Supply a non-empty stroke id.");
    return id;
  }
  const prefix = source === "crescent" ? "crescent" : args.attachment_id;
  const matches = segments.filter((entry) => {
    if (entry.sticks.length < 2 || (entry.sticks.length !== 2 && !source.startsWith("motion:"))) return false;
    const first = entry.sticks[0],
      last = entry.sticks.at(-1);
    const sameSource = entry.brushSource
      ? entry.brushSource === source
      : entry.id === normalizeTrailId(`${prefix}_${first.frame}_${last.frame}`) &&
        (entry.texture.name === "crescent.png") === (source === "crescent");
    return sameSource && (first.frame === args.start_frame || last.frame === args.end_frame);
  });
  const exact = matches.filter(
    ({ sticks }) => sticks[0].frame === args.start_frame && sticks.at(-1).frame === args.end_frame,
  );
  const candidates = exact.length ? exact : matches;
  if (candidates.length > 1)
    throw new Error(
      `Multiple strokes share these endpoints. Supply id: ${candidates.map((s) => s.id).join(", ")}.`,
    );
  if (candidates.length) return candidates[0].id;
  const used = new Set(segments.map((s) => s.id));
  let n = 1;
  while (used.has(`hit_${n}`)) n++;
  return `hit_${n}`;
}

/** Downsample only large canvases, preserving aspect ratio and the full strike silhouette. */
function thumbnail(file) {
  const image = decodePngRgba(file);
  const scale = Math.min(1, 224 / Math.max(image.width, image.height));
  if (scale === 1) return image;
  const width = Math.max(1, Math.round(image.width * scale)),
    height = Math.max(1, Math.round(image.height * scale));
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.floor((y * image.height) / height);
    for (let x = 0; x < width; x++) {
      const offset = 4 * (sy * image.width + Math.floor((x * image.width) / width));
      data.set(image.data.subarray(offset, offset + 4), 4 * (y * width + x));
    }
  }
  return { data, width, height };
}

/** Build one numbered preview tile per hit in request order. */
function strikeSheet(paths, frames) {
  const images = paths.map(thumbnail);
  const sheet = renderContactSheet(images, {
    cell: Math.max(...images.map((i) => Math.max(i.width, i.height))),
    columns: Math.min(images.length, 4),
    grid: false,
    labels: true,
    normalize: "none",
    frameIndexes: frames,
  });
  return encodePngRgba(sheet.data, sheet.width, sheet.height);
}

module.exports = { MAX_HITS, INLINE_TRAIL_PNG, selectWeapon, identifyHit, strikeSheet };
