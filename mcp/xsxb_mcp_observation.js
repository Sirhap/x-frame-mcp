"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");

/**
 * Recursively sorts object keys so observation ids do not depend on insertion order.
 * @param {unknown} value Source value.
 * @returns {unknown} Canonical JSON-compatible value.
 */
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

/**
 * Returns a SHA-256 digest for bytes.
 * @param {Buffer|Uint8Array|string} value Bytes or string.
 * @returns {string} Lowercase hexadecimal digest.
 */
function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * Creates one content-addressed observation record.
 * createdAt is deliberately excluded from the id so an unchanged source remains
 * valid after an MCP server restart.
 * @param {{scope:object,sources:Array<{key:string,path?:string,hash?:string}>,view?:object|null}} input
 * @returns {{snapshotId:string,scope:object,sourceHashes:object,view:object|null,createdAt:string}}
 */
function createObservation(input) {
  const sourceHashes = {};
  for (const source of input.sources || []) {
    sourceHashes[source.key] = source.hash || sha256(fs.readFileSync(source.path));
  }
  const identity = canonicalValue({
    scope: input.scope || {},
    sourceHashes,
    view: input.view || null,
  });
  const digest = sha256(JSON.stringify(identity));
  return {
    snapshotId: `obs_v1_${digest.slice(0, 24)}`,
    scope: input.scope || {},
    sourceHashes,
    view: input.view || null,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Creates a stable file observation.
 * @param {string} filePath Existing file.
 * @param {object} [scope] Extra domain scope.
 * @param {object|null} [view] View/grid parameters.
 * @returns {object} Observation record.
 */
function observeFile(filePath, scope = {}, view = null) {
  return createObservation({
    scope: { kind: "file", ...scope },
    sources: [{ key: "file", path: filePath }],
    view,
  });
}

/**
 * Throws a machine-coded error if an expected observation is no longer current.
 * @param {unknown} expected Snapshot id supplied by the caller.
 * @param {object} actual Recomputed observation.
 * @param {string} [label] Human scope label.
 * @returns {void}
 */
function assertObservation(expected, actual, label = "observation") {
  const received = String(expected || "").trim();
  if (!received) {
    const error = new Error(`${label} requires basis_snapshot_id from the observation tool.`);
    error.code = "MISSING_SNAPSHOT";
    error.details = { actual: actual.snapshotId };
    throw error;
  }
  if (received !== actual.snapshotId) {
    const error = new Error(`${label} changed after it was observed.`);
    error.code = "STALE_SNAPSHOT";
    error.details = { expected: received, actual: actual.snapshotId };
    throw error;
  }
}

/**
 * Detects speakable A1-style coordinates anywhere in an argument tree.
 * Group points such as "40,-80" are deliberately not treated as observations.
 * @param {unknown} value Argument value.
 * @returns {boolean} Whether a cell token is present.
 */
function containsCellToken(value) {
  if (typeof value === "string") return /^[A-Z][1-9][0-9]*$/iu.test(value.trim());
  if (Array.isArray(value)) return value.some(containsCellToken);
  if (!value || typeof value !== "object") return false;
  if (typeof value.cell === "string" && /^[A-Z][1-9][0-9]*$/iu.test(value.cell.trim())) return true;
  return Object.values(value).some(containsCellToken);
}

module.exports = {
  assertObservation,
  canonicalValue,
  containsCellToken,
  createObservation,
  observeFile,
  sha256,
};
