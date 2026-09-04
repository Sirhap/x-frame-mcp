#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  MODEL_ID,
  MODEL_REVISION,
  MODEL_FILE_SHA256,
  florenceRuntimeDir,
  florenceRuntimeStatus,
} = require("../mcp/xsxb_mcp_florence");

/**
 * Runs one child process and throws with its captured output on failure.
 * @param {string} command Executable.
 * @param {string[]} args Arguments.
 * @returns {string} Standard output.
 */
function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message || result.stderr || result.stdout}`.trim());
  }
  return String(result.stdout || "").trim();
}

/**
 * Computes one file SHA-256 without loading it into memory.
 * @param {string} filePath File.
 * @returns {Promise<string>} Hex digest.
 */
function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** Prints the optional runtime status. */
function doctor() {
  const status = florenceRuntimeStatus({ deep: true });
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  process.exitCode = status.installed ? 0 : 1;
}

/** Installs the pinned optional runtime and model after an explicit command. */
async function install() {
  const runtimeDir = florenceRuntimeDir();
  const venvDir = path.join(runtimeDir, ".venv");
  const pythonCommand = process.env.XSXB_PERCEPTION_BOOTSTRAP_PYTHON || "python3";
  const version = run(pythonCommand, [
    "-c",
    "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')",
  ]);
  const [major, minor] = version.split(".").map(Number);
  if (major !== 3 || minor < 11 || minor >= 14) {
    throw new Error(`Florence setup requires Python 3.11-3.13. Received ${version}.`);
  }
  fs.mkdirSync(runtimeDir, { recursive: true });
  if (!fs.existsSync(venvDir)) run(pythonCommand, ["-m", "venv", venvDir]);
  const python =
    process.platform === "win32"
      ? path.join(venvDir, "Scripts", "python.exe")
      : path.join(venvDir, "bin", "python");
  const requirements = path.join(__dirname, "../mcp/perception/requirements.txt");
  run(python, ["-m", "pip", "install", "--disable-pip-version-check", "-r", requirements]);
  const downloadScript = [
    "from huggingface_hub import snapshot_download",
    `print(snapshot_download(repo_id=${JSON.stringify(MODEL_ID)}, revision=${JSON.stringify(MODEL_REVISION)}, local_dir=${JSON.stringify(path.join(runtimeDir, "model"))}, allow_patterns=['*.json','*.txt','*.safetensors','tokenizer*','vocab*','merges*']))`,
  ].join("\n");
  const modelPath = run(python, ["-c", downloadScript]).split(/\r?\n/u).at(-1);
  const modelFile = path.join(modelPath, "model.safetensors");
  if (!fs.existsSync(modelFile)) throw new Error("Florence download did not produce model.safetensors.");
  const digest = await hashFile(modelFile);
  if (digest !== MODEL_FILE_SHA256) {
    throw new Error(`Florence model checksum mismatch. Expected ${MODEL_FILE_SHA256}, received ${digest}.`);
  }
  fs.writeFileSync(
    path.join(runtimeDir, "installed.json"),
    `${JSON.stringify({ modelId: MODEL_ID, revision: MODEL_REVISION, modelPath, modelSha256: digest }, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(florenceRuntimeStatus(), null, 2)}\n`);
}

if (require.main === module) {
  if (process.argv.includes("--doctor")) doctor();
  else
    install().catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { MODEL_FILE_SHA256, doctor, hashFile, install, run };
