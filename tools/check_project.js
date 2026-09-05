#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, "..");

/**
 * Discovers files in source roots without following symlinks or generated stores.
 * @param {string} root Repository or isolated test root.
 * @returns {string[]} Sorted repository-relative paths.
 */
function sourceFiles(root) {
  const files = [];
  /** Recursively visits one source directory. */
  function visit(relative) {
    const directory = path.join(root, relative);
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "__pycache__" || entry.name === "node_modules")
        continue;
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) files.push(name);
    }
  }
  visit("mcp");
  visit("tools");
  return files.sort();
}

/**
 * Runs an external check and preserves actionable stdout/stderr on failure.
 * @param {string} command Executable.
 * @param {string[]} args Arguments without shell interpolation.
 * @param {string} root Working directory.
 * @returns {Promise<string>} Check output.
 */
async function execute(command, args, root) {
  try {
    const result = await execFileAsync(command, args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
    return `${result.stdout}${result.stderr}`;
  } catch (error) {
    throw new Error(`${command} ${args.join(" ")}\n${error.stdout || ""}${error.stderr || error.message}`);
  }
}

/**
 * Checks each JavaScript file as the sole --check input, with bounded concurrency.
 * @param {string} root Source root.
 * @param {string[]} files Source files.
 * @returns {Promise<void>} Completion after every syntax check passes.
 */
async function checkSyntax(root, files = sourceFiles(root)) {
  const javascript = files.filter((file) => file.endsWith(".js"));
  for (let index = 0; index < javascript.length; index += 4) {
    const results = await Promise.allSettled(
      javascript.slice(index, index + 4).map((file) => execute(process.execPath, ["--check", file], root)),
    );
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        failures.map((result) => result.reason.message).join("\n"),
      );
  }
}

/**
 * Selects all test files; npm test and npm run check share this discovery.
 * @param {string[]} files Discovered paths.
 * @returns {string[]} Test paths.
 */
function testFiles(files) {
  return files.filter(
    (file) => file.startsWith(`tools${path.sep}tests${path.sep}`) && file.endsWith(".test.js"),
  );
}

/**
 * Selects authored files for formatting. Vendored algorithms keep upstream style;
 * every JavaScript file, including vendored files, still gets a syntax check.
 * @param {string[]} files Discovered paths.
 * @returns {string[]} Authored JavaScript and Markdown paths.
 */
function formatFiles(files) {
  const maintainedLib = new Set(["project_store.js", "xsxb_root.js", "file_transaction.js"]);
  return files.filter((file) => {
    if (!/\.(js|md)$/.test(file)) return false;
    const parts = file.split(path.sep);
    if (parts[0] === "mcp") {
      return (
        parts.length === 2 ||
        (parts[1] === "lib" &&
          parts.length === 3 &&
          (maintainedLib.has(parts[2]) || parts[2] === "README.md"))
      );
    }
    return parts.length === 2 || parts[1] === "authoring" || parts[1] === "tests";
  });
}

/**
 * Executes a requested check mode. Source and test discovery are shared.
 * @param {string} mode --all, --syntax, --format, --python or --test.
 * @param {string} root Repository root.
 * @returns {Promise<void>} Completed checks.
 */
async function runChecks(mode = "--all", root = REPO_ROOT) {
  if (!["--all", "--syntax", "--format", "--python", "--test"].includes(mode))
    throw new Error(`Unknown check mode: ${mode}`);
  const files = sourceFiles(root);
  if (mode === "--all" || mode === "--syntax") {
    await checkSyntax(root, files);
    process.stdout.write(
      `Syntax: ${files.filter((file) => file.endsWith(".js")).length} JavaScript files passed.\n`,
    );
  }
  if (mode === "--all" || mode === "--python") {
    const python = files.filter((file) => file.endsWith(".py"));
    if (python.length) {
      await execute(
        "python3",
        [
          "-c",
          "import pathlib,sys; [compile(pathlib.Path(p).read_bytes(),p,'exec') for p in sys.argv[1:]]",
          ...python,
        ],
        root,
      );
    }
    process.stdout.write(`Syntax: ${python.length} Python files passed.\n`);
  }
  if (mode === "--all" || mode === "--format") {
    const prettier = require.resolve("prettier/bin/prettier.cjs");
    process.stdout.write(
      await execute(process.execPath, [prettier, "--check", ...formatFiles(files), "package.json"], root),
    );
  }
  if (mode === "--all" || mode === "--test") {
    const tests = testFiles(files);
    if (!tests.length) throw new Error("No tests discovered.");
    process.stdout.write(`Tests: ${tests.length} discovered files.\n`);
    process.stdout.write(await execute(process.execPath, ["--test", ...tests], root));
  }
}

if (require.main === module) {
  runChecks(process.argv[2]).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { sourceFiles, testFiles, formatFiles, checkSyntax, runChecks };
