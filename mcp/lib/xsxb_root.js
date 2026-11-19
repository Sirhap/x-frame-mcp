"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Selects the authoring host. Desktop launchers sometimes supply the filesystem
 * root as cwd even though no project directory was selected.
 * @param {string} [explicitRoot] Host supplied by the service caller.
 * @returns {string} Absolute host for the registry, project assets and artifacts.
 */
function resolveMcpHostRoot(explicitRoot) {
  const configured = explicitRoot || process.env.XSXB_ROOT;
  if (configured) return path.resolve(configured);
  const cwd = process.cwd();
  if (cwd !== path.parse(cwd).root) return cwd;
  const home = os.homedir();
  if (home && path.isAbsolute(home) && path.resolve(home) !== path.parse(home).root) {
    return path.resolve(home);
  }
  throw new Error("MCP started at the filesystem root without a user home. Set XSXB_ROOT to your workspace.");
}

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

module.exports = { resolveMcpHostRoot, resolveXsxbRoot };
