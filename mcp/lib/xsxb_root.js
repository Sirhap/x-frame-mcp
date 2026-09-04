"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * Resolves the workspace / package root used by vendored MCP helpers.
 * XSXB_ROOT wins. Otherwise walk up from `fromDir` to the nearest package.json
 * so the same file works in this monorepo (`mcp/lib` → repo) and in a later
 * standalone MCP package (`lib` → package root).
 * @param {string} fromDir Directory to start walking from, usually `__dirname`.
 * @returns {string} Absolute root path.
 */
function resolveXsxbRoot(fromDir) {
  if (process.env.XSXB_ROOT) return path.resolve(process.env.XSXB_ROOT);
  let dir = path.resolve(fromDir);
  for (let index = 0; index < 8; index += 1) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(fromDir, "../..");
}

module.exports = { resolveXsxbRoot };
