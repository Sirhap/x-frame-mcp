"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const REPO = path.join(__dirname, "../..");
const MCP_DIR = path.join(REPO, "mcp");
const TOOLS_DIR = path.join(REPO, "tools");
const FRONTEND_SESSION = path.join(TOOLS_DIR, "animation_tuner/public/batch_cutout_session_controller.js");

const MCP_MODULES = [
  "xsxb_mcp_arguments",
  "xsxb_mcp_cutout",
  "xsxb_mcp_lock",
  "xsxb_mcp_plant",
  "xsxb_mcp_loop",
  "xsxb_mcp_place",
  "xsxb_mcp_place_brief",
  "xsxb_mcp_processes",
  "xsxb_mcp_schema",
  "xsxb_mcp_server",
  "xsxb_mcp_service",
  "xsxb_mcp_slice",
  "xsxb_mcp_smear_brief",
  "xsxb_mcp_tool_catalog",
  "xsxb_mcp_tool_usability",
  "xsxb_mcp_trail_preview",
  "xsxb_mcp_visual_qa",
];

test("MCP implementations live under mcp/ and tools/ only re-exports", () => {
  for (const name of MCP_MODULES) {
    const impl = fs.readFileSync(path.join(MCP_DIR, `${name}.js`), "utf8");
    const shim = fs.readFileSync(path.join(TOOLS_DIR, `${name}.js`), "utf8");
    assert.match(impl, /module\.exports/, `${name} implementation must export`);
    assert.doesNotMatch(impl, /Compatibility shim/, `${name} implementation is not a shim`);
    assert.match(shim, /Compatibility shim/, `${name} tools/ file is a shim`);
    assert.match(shim, new RegExp(`\\.\\./mcp/${name}`), `${name} shim points at mcp/`);
  }
});

test("frontend still requires the tools/ cutout shim path, not mcp/", () => {
  const src = fs.readFileSync(FRONTEND_SESSION, "utf8");
  assert.match(src, /require\("\.\.\/\.\.\/xsxb_mcp_cutout"\)/);
  assert.doesNotMatch(src, /require\("\.\.\/\.\.\/mcp\//);
  const { alreadyCutOut } = require("../xsxb_mcp_cutout");
  assert.equal(typeof alreadyCutOut, "function");
});

const REQUIRE_RE = /require\(\s*["']([^"']+)["']\s*\)/g;
const NODE_BUILTIN = /^(node:|[a-z][a-z0-9_]*$)/;

/**
 * Collects relative require specifiers from a CommonJS file.
 * @param {string} file Absolute path.
 * @returns {string[]} Specifiers that start with `.`.
 */
function relativeRequires(file) {
  const src = fs.readFileSync(file, "utf8");
  return [...src.matchAll(REQUIRE_RE)].map((match) => match[1]).filter((spec) => spec.startsWith("."));
}

/**
 * Walks the MCP require graph and returns files that resolve outside mcp/.
 * @returns {{file:string,spec:string,resolved:string}[]} Escapes.
 */
function mcpRequireEscapes() {
  const queue = MCP_MODULES.map((name) => path.join(MCP_DIR, `${name}.js`));
  const seen = new Set();
  const escapes = [];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    for (const spec of relativeRequires(file)) {
      const resolved = require.resolve(spec, { paths: [path.dirname(file)] });
      if (!resolved.startsWith(`${MCP_DIR}${path.sep}`) && resolved !== MCP_DIR) {
        escapes.push({ file: path.relative(REPO, file), spec, resolved: path.relative(REPO, resolved) });
        continue;
      }
      if (!NODE_BUILTIN.test(spec)) queue.push(resolved);
    }
  }
  return escapes;
}

test("MCP require graph stays inside mcp/ (vendored lib, no tools/ imports)", () => {
  const escapes = mcpRequireEscapes();
  assert.deepEqual(
    escapes,
    [],
    `MCP still imports outside mcp/:\n${escapes.map((row) => `${row.file} -> ${row.spec} (${row.resolved})`).join("\n")}`,
  );
  assert.ok(fs.existsSync(path.join(MCP_DIR, "lib/project_store.js")), "vendored project_store");
  assert.ok(
    fs.existsSync(path.join(MCP_DIR, "lib/runtime/xsxb_attack_trail_renderer.gd")),
    "vendored Godot trail runtime",
  );
  assert.ok(
    fs.existsSync(
      path.join(MCP_DIR, "lib/animation_tuner/public/presets/attack_trails/dynamic_trail_luma.png"),
    ),
    "vendored trail preset",
  );
  const { resolveXsxbRoot } = require("../../mcp/lib/xsxb_root");
  assert.equal(resolveXsxbRoot(path.join(MCP_DIR, "lib")), REPO);
});
