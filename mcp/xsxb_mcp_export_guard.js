"use strict";
const fs = require("node:fs");
const path = require("node:path");

/**
 * Resolves existing ancestors so a destination cannot bypass protection through a directory symlink.
 * @param {string} target Existing or future file path.
 * @returns {string} Canonical destination.
 */
function canonicalPath(target) {
  const absolute = path.resolve(target);
  try {
    return fs.realpathSync(absolute);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(canonicalPath(parent), path.basename(absolute));
  }
}

/**
 * Reads file identity to catch hard links without reading image bytes.
 * @param {string} target File path.
 * @returns {string|null} Device and inode, or null for a missing file.
 */
function fileIdentity(target) {
  try {
    const stat = fs.statSync(target, { bigint: true });
    return `${stat.dev}:${stat.ino}`;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Rejects all conflicting destinations before the exporter writes any output.
 * @param {string[]} targets Output files including sidecars and copies.
 * @param {{files:string[],directories:string[]}} protectedPaths Authoring files and stores.
 * @returns {void}
 */
function assertExportDestinations(targets, protectedPaths) {
  const files = new Set(protectedPaths.files.filter(Boolean).map(canonicalPath));
  const identities = new Set(protectedPaths.files.filter(Boolean).map(fileIdentity).filter(Boolean));
  const directories = protectedPaths.directories.filter(Boolean).map(canonicalPath);
  for (const target of targets.filter(Boolean)) {
    const canonical = canonicalPath(target);
    const identity = fileIdentity(target);
    const inside = directories.some((directory) => {
      const relative = path.relative(directory, canonical);
      return (
        relative === "" ||
        (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      );
    });
    if (files.has(canonical) || (identity && identities.has(identity)) || inside) {
      const error = new Error(`Export destination is a protected source or project file: ${target}`);
      error.code = "PROTECTED_EXPORT_PATH";
      throw error;
    }
  }
}
module.exports = { assertExportDestinations };
