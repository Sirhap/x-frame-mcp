"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { sha256, canonicalValue } = require("./xsxb_mcp_observation");
const { exposedSkinPixel } = require("./xsxb_mcp_hand_candidates");

/** Throws a machine-readable region resolution failure. */
function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

/** Returns the content-addressed identity of an immutable observation payload. */
function identity(record) {
  return `reg_${sha256(JSON.stringify(canonicalValue(record)))}`;
}

/** Builds source-alpha coverage, excluding clothing from locally detected hands. */
function regionMask(foreground, candidate) {
  const { width, height, data } = foreground;
  const mask = new Uint8ClampedArray(width * height);
  const box = candidate.component;
  const skinOnly = candidate.provenance.includes("local_pixel_components");
  for (let y = Math.max(0, box.minY); y <= Math.min(height - 1, box.maxY); y += 1) {
    for (let x = Math.max(0, box.minX); x <= Math.min(width - 1, box.maxX); x += 1) {
      const index = y * width + x;
      const offset = index * 4;
      if (data[offset + 3] <= 16) continue;
      if (skinOnly && !exposedSkinPixel(data[offset], data[offset + 1], data[offset + 2])) continue;
      mask[index] = data[offset + 3];
    }
  }
  return mask;
}

/**
 * Persists immutable, source-bound geometry only after detection has completed.
 * Public candidates expose references, never raw pixel boxes or mask payloads.
 * @param {object} code analyzeRegions result including foreground analyses.
 * @param {object[]} candidates Fused public candidates.
 * @param {{root:string,frames:object[],observation:object}} context Detection context.
 * @returns {object[]} Candidates carrying reusable region references.
 */
function persistPerceptionRegions(code, candidates, context) {
  const directory = path.join(context.root, ".x-frame", "perception-observations");
  const sources = new Map();
  const records = candidates.map((candidate, index) => {
    const frameIndex = context.frames.findIndex(
      (frame, offset) => (frame.frame ?? offset) === candidate.frame,
    );
    const frame = context.frames[frameIndex];
    if (!frame?.filePath) fail("REGION_SOURCE_MISSING", "Region persistence requires a source frame file.");
    if (!sources.has(frame.filePath)) {
      const sourcePath = fs.realpathSync(frame.filePath);
      sources.set(frame.filePath, { sourcePath, sourceHash: sha256(fs.readFileSync(sourcePath)) });
    }
    const source = sources.get(frame.filePath);
    const knownHashes = Object.values(context.observation.sourceHashes || {});
    if (knownHashes.length && !knownHashes.includes(source.sourceHash)) {
      fail("STALE_SNAPSHOT", "Source changed while its regions were being detected.");
    }
    const internal = code.internalCandidates[index];
    const foreground = code.analyses[frameIndex].foreground;
    const mask = regionMask(foreground, internal);
    const record = {
      version: 1,
      snapshotId: context.observation.snapshotId,
      ...source,
      width: frame.width,
      height: frame.height,
      frame: candidate.frame,
      hypothesis: candidate.hypothesis,
      component: internal.component,
      mask: zlib.deflateSync(mask).toString("base64"),
    };
    return { record, regionId: identity(record) };
  });
  if (records.length) fs.mkdirSync(directory, { recursive: true });
  records.forEach(({ record, regionId }) => {
    // Exclusive writes preserve immutable records and remain safe across workers.
    try {
      fs.writeFileSync(path.join(directory, `${regionId}.json`), JSON.stringify(record), { flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  });
  return candidates.map((candidate, index) => ({
    ...candidate,
    regionId: records[index].regionId,
    reference: { region_id: records[index].regionId, basis_snapshot_id: context.observation.snapshotId },
  }));
}

/**
 * Resolves a public region reference into immutable pixel geometry and coverage.
 * @param {{region_id:string,basis_snapshot_id:string}} reference Detection reference.
 * @param {string} sourcePath Source image used by the consuming operation.
 * @param {{root:string}} options Host root owning the observations.
 * @returns {{x:number,y:number,width:number,height:number,mask:Uint8ClampedArray,component:object,regionId:string,snapshotId:string,sourceHash:string,frame:number}}
 */
function resolvePerceptionRegion(reference, sourcePath, { root }) {
  if (
    !/^reg_[a-f0-9]{64}$/u.test(reference?.region_id || "") ||
    typeof reference?.basis_snapshot_id !== "string" ||
    !reference.basis_snapshot_id
  ) {
    fail("INVALID_REGION_REFERENCE", "A detected region_id and basis_snapshot_id are required.");
  }
  const filename = path.join(root, ".x-frame", "perception-observations", `${reference.region_id}.json`);
  let record;
  try {
    record = JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch (error) {
    fail(
      error.code === "ENOENT" ? "REGION_NOT_FOUND" : "INVALID_REGION_RECORD",
      "Region observation is unavailable or corrupt; detect again.",
    );
  }
  if (identity(record) !== reference.region_id || record.version !== 1)
    fail("INVALID_REGION_RECORD", "Region observation failed its content digest.");
  if (record.snapshotId !== reference.basis_snapshot_id)
    fail("STALE_SNAPSHOT", "Region belongs to a different observation.");
  let actualPath;
  try {
    actualPath = fs.realpathSync(sourcePath);
  } catch {
    fail("REGION_SOURCE_MISSING", "The observed source file is no longer available.");
  }
  if (actualPath !== record.sourcePath)
    fail("REGION_SOURCE_MISMATCH", "Region belongs to another source image.");
  if (sha256(fs.readFileSync(actualPath)) !== record.sourceHash)
    fail("STALE_SNAPSHOT", "Region source changed; run detection again.");
  let mask;
  try {
    mask = new Uint8ClampedArray(
      zlib.inflateSync(Buffer.from(record.mask, "base64"), { maxOutputLength: record.width * record.height }),
    );
  } catch {
    fail("INVALID_REGION_RECORD", "Region mask cannot be decoded.");
  }
  if (mask.length !== record.width * record.height)
    fail("INVALID_REGION_RECORD", "Region mask dimensions are invalid.");
  return {
    x: record.component.centerX,
    y: record.component.centerY,
    width: record.width,
    height: record.height,
    mask,
    component: record.component,
    regionId: reference.region_id,
    snapshotId: record.snapshotId,
    sourceHash: record.sourceHash,
    frame: record.frame,
  };
}

module.exports = { persistPerceptionRegions, resolvePerceptionRegion };
