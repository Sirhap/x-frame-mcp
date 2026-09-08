"use strict";

const { decodePngRgba } = require("./xsxb_mcp_cutout");
const { requireExistingFile } = require("./xsxb_mcp_arguments");

/** Resolves a fresh region reference without permitting ambiguous addressing. */
function resolveRegionAnchor(anchor, sourcePath, root, label) {
  if (anchor?.region_id === undefined && anchor?.basis_snapshot_id === undefined) return null;
  if (Object.keys(anchor).some((key) => !["region_id", "basis_snapshot_id"].includes(key))) {
    throw new Error(`${label} region reference cannot combine with cells, mode, view, or other anchor fields.`);
  }
  if (!anchor.region_id || !anchor.basis_snapshot_id) {
    throw new Error(`${label} requires both region_id and basis_snapshot_id.`);
  }
  const region = require("./xsxb_mcp_region_store").resolvePerceptionRegion(anchor, sourcePath, { root });
  return {
    x: region.x,
    y: region.y,
    region,
    resolved: {
      mode: "perception_region",
      region_id: region.regionId,
      basis_snapshot_id: region.snapshotId,
      x: region.x,
      y: region.y,
      space: "image_pixels",
    },
  };
}

/** Loads an explicit alpha mask or the selected target region's actual pixels. */
function resolveOcclusion(spec, target, targetPath, root, layer, targetRegion, coverBox) {
  let mask = null;
  let source = "none";
  let reference;
  if (spec !== undefined) {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("occlusion must be an object.");
    if (layer === "behind") throw new Error("occlusion cannot combine with layer=behind; use front or under_target.");
    if (spec.mask_path !== undefined) {
      if (Object.keys(spec).length !== 1) throw new Error("occlusion.mask_path cannot combine with region references or other fields.");
      const maskPath = requireExistingFile(spec.mask_path, "Occlusion mask");
      const image = decodePngRgba(maskPath);
      if (image.width !== target.width || image.height !== target.height) throw new Error("Occlusion mask dimensions must match the target image.");
      mask = new Uint8ClampedArray(target.width * target.height);
      for (let i = 0; i < mask.length; i += 1) mask[i] = image.data[i * 4 + 3];
      source = "mask_path";
      reference = { mask_path: maskPath };
    } else {
      const resolved = resolveRegionAnchor(spec, targetPath, root, "occlusion");
      if (!resolved) throw new Error("occlusion requires mask_path or a region_id and basis_snapshot_id reference.");
      mask = resolved.region.mask;
      source = "perception_region";
      reference = { region_id: resolved.region.regionId, basis_snapshot_id: resolved.region.snapshotId };
    }
  } else if (layer === "under_target" && targetRegion) {
    mask = targetRegion.mask;
    source = "target_region";
    reference = { region_id: targetRegion.regionId, basis_snapshot_id: targetRegion.snapshotId };
  } else if (layer === "behind" || layer === "under_target") {
    mask = new Uint8ClampedArray(target.width * target.height);
    const box = layer === "behind" ? null : coverBox();
    for (let y = 0; y < target.height; y += 1) {
      for (let x = 0; x < target.width; x += 1) {
        if (box && (x < Math.floor(box.x1) || x >= Math.ceil(box.x2) || y < Math.floor(box.y1) || y >= Math.ceil(box.y2))) continue;
        const i = y * target.width + x;
        mask[i] = target.data[i * 4 + 3];
      }
    }
    source = layer === "behind" ? "whole_target" : "legacy_cell_union";
  }
  if (mask && mask.length !== target.width * target.height) throw new Error("Occlusion mask dimensions must match the target image.");
  return { mask, source, reference };
}

/**
 * Composes a transformed object between the target background and local foreground.
 * Splitting target alpha avoids painting antialiased target edges twice. Mask alpha
 * is absolute foreground opacity, capped to the target alpha at the same pixel.
 */
function compositeOccludedObject(target, objectLayer, occlusion) {
  const output = new Uint8ClampedArray(target.data);
  let rendered = 0;
  let visible = 0;
  let occluded = 0;
  let changed = 0;
  for (let i = 0; i < target.width * target.height; i += 1) {
    const off = i * 4;
    const objectAlpha = objectLayer[off + 3] / 255;
    if (!objectAlpha) continue;
    rendered += 1;
    const targetAlpha = target.data[off + 3] / 255;
    const frontAlpha = Math.min(targetAlpha, (occlusion.mask?.[i] || 0) / 255);
    if (frontAlpha > 0) occluded += 1;
    if (frontAlpha < 1) visible += 1;
    const remainingTarget = targetAlpha - frontAlpha;
    const objectWeight = objectAlpha * (1 - frontAlpha);
    const targetWeight = frontAlpha + remainingTarget * (1 - objectAlpha);
    const alpha = objectWeight + targetWeight;
    if (!alpha) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      output[off + channel] = Math.round((objectLayer[off + channel] * objectWeight + target.data[off + channel] * targetWeight) / alpha);
    }
    output[off + 3] = Math.round(alpha * 255);
    if ([0, 1, 2, 3].some((channel) => output[off + channel] !== target.data[off + channel])) changed += 1;
  }
  return {
    data: output,
    receipt: {
      source: occlusion.source,
      ...occlusion.reference,
      rendered_object_pixels: rendered,
      visible_object_pixels: visible,
      occluded_object_pixels: occluded,
      changed_pixels: changed,
      semantics: "absolute_foreground_alpha",
    },
  };
}

/** Reports transformed opaque bounds separately from observed output pixel counts. */
function placementClipping(bbox, objectAnchor, targetAnchor, scale, degrees, target) {
  const angle = degrees * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const points = [[bbox.minX, bbox.minY], [bbox.maxX + 1, bbox.minY], [bbox.minX, bbox.maxY + 1], [bbox.maxX + 1, bbox.maxY + 1]].map(([x, y]) => {
    const dx = (x - objectAnchor.x) * scale;
    const dy = (y - objectAnchor.y) * scale;
    return { x: targetAnchor.x + dx * cosine - dy * sine, y: targetAnchor.y + dx * sine + dy * cosine };
  });
  const bounds = { min_x: Math.min(...points.map((point) => point.x)), min_y: Math.min(...points.map((point) => point.y)), max_x: Math.max(...points.map((point) => point.x)), max_y: Math.max(...points.map((point) => point.y)) };
  return {
    basis: "transformed_alpha_bounds",
    possible_clipping: bounds.min_x < -1e-9 || bounds.min_y < -1e-9 || bounds.max_x > target.width + 1e-9 || bounds.max_y > target.height + 1e-9,
    bounds,
  };
}

module.exports = { resolveRegionAnchor, resolveOcclusion, compositeOccludedObject, placementClipping };
