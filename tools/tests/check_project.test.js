"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { sourceFiles, testFiles, checkSyntax } = require("../check_project");

test("syntax checks reject an invalid second source file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-check-"));
  try {
    fs.mkdirSync(path.join(root, "mcp"));
    fs.writeFileSync(path.join(root, "mcp", "a.js"), "module.exports = {};\n");
    fs.writeFileSync(path.join(root, "mcp", "b.js"), "const = ;\n");
    await assert.rejects(checkSyntax(root), /b\.js/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("new test files and the overlay demo are discovered without a script list", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-test-discovery-"));
  try {
    fs.mkdirSync(path.join(root, "tools", "tests"), { recursive: true });
    const names = ["new_regression.test.js", "xsxb_mcp_overlay_vision_demo.test.js"];
    for (const name of names) fs.writeFileSync(path.join(root, "tools", "tests", name), "");
    assert.deepEqual(
      testFiles(sourceFiles(root)).map((file) => path.basename(file)),
      names,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
