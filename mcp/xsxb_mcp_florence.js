"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const { spawnSync } = require("node:child_process");

const MODEL_ID = "florence-community/Florence-2-base-ft";
const MODEL_REVISION = "0b03b6f15a4a211370fb204aee4e7dd48887ea37";
const MODEL_FILE_SHA256 = "ab06dea66b16d5e54513256d64854be2194443452fd0d84353b40a278bf87d42";
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Returns the untracked runtime directory for the optional model.
 * @returns {string} Absolute runtime path.
 */
function florenceRuntimeDir() {
  if (process.env.XSXB_PERCEPTION_RUNTIME) return path.resolve(process.env.XSXB_PERCEPTION_RUNTIME);
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "XSXB-Frame-Tuner", "perception");
  }
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || os.homedir(), "XSXB-Frame-Tuner", "perception");
  }
  return path.join(
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
    "xsxb-frame-tuner",
    "perception",
  );
}

/**
 * Reports whether the explicitly installed Florence runtime is usable.
 * @param {{runtimeDir?:string}} [options] Runtime override.
 * @returns {object} Diagnostic status.
 */
function florenceRuntimeStatus(options = {}) {
  const runtimeDir = path.resolve(options.runtimeDir || florenceRuntimeDir());
  const python =
    process.platform === "win32"
      ? path.join(runtimeDir, ".venv", "Scripts", "python.exe")
      : path.join(runtimeDir, ".venv", "bin", "python");
  const manifestPath = path.join(runtimeDir, "installed.json");
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (_error) {
    manifest = null;
  }
  let executable = false;
  try {
    fs.accessSync(python, fs.constants.X_OK);
    executable = true;
  } catch (_error) {
    executable = false;
  }
  const modelFile =
    typeof manifest?.modelPath === "string" ? path.join(manifest.modelPath, "model.safetensors") : "";
  let installed =
    executable &&
    manifest?.modelId === MODEL_ID &&
    manifest?.revision === MODEL_REVISION &&
    manifest?.modelSha256 === MODEL_FILE_SHA256 &&
    typeof manifest?.modelPath === "string" &&
    fs.existsSync(modelFile);
  let deepCheck = null;
  if (installed && options.deep === true) {
    const check = spawnSync(
      python,
      [
        "-c",
        "import hashlib,sys,torch,transformers; from transformers import Florence2ForConditionalGeneration; h=hashlib.sha256(); f=open(sys.argv[1],'rb'); [h.update(chunk) for chunk in iter(lambda:f.read(1048576),b'')]; print(h.hexdigest())",
        modelFile,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    const digest =
      String(check.stdout || "")
        .trim()
        .split(/\r?\n/u)
        .at(-1) || "";
    installed = digest === MODEL_FILE_SHA256 && check.status === 0 && !check.error;
    deepCheck = {
      modelSha256: digest,
      importsReady: check.status === 0 && !check.error,
      error: check.error?.message || String(check.stderr || "").trim() || null,
    };
  }
  return {
    installed,
    runtimeDir,
    python,
    manifestPath,
    modelId: MODEL_ID,
    revision: MODEL_REVISION,
    modelPath: manifest?.modelPath || null,
    deepCheck,
    reason: installed ? null : "Run npm run mcp:perception:install to install the optional model.",
  };
}

class FlorenceWorker {
  /**
   * @param {object} status Installed runtime status.
   * @param {string} workerPath Python worker path.
   */
  constructor(status, workerPath) {
    this.status = status;
    this.workerPath = workerPath;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.restarted = false;
    this.stopped = false;
    this.stderr = "";
    this.exitHandler = () => this.stop();
    process.once("exit", this.exitHandler);
  }

  /** Starts the persistent sidecar on first use. */
  start() {
    if (this.stopped) {
      const error = new Error("Florence worker was stopped.");
      error.code = "MODEL_STOPPED";
      throw error;
    }
    if (this.child) return;
    const child = spawn(this.status.python, [this.workerPath, "--model", this.status.modelPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" },
    });
    this.child = child;
    this.stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4000);
    });
    child.stdin.on("error", (error) => {
      this.stderr = `${this.stderr}\n${error.message}`.trim();
      this.handleExit();
    });
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleLine(line));
    child.on("error", (error) => {
      this.stderr = `${this.stderr}\n${error.message}`.trim();
      this.handleExit();
    });
    child.on("exit", () => this.handleExit());
    child.unref();
    child.stdin.unref?.();
    child.stdout.unref?.();
    child.stderr.unref?.();
  }

  /** Stops the child and releases the process-exit listener. */
  stop() {
    this.stopped = true;
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill("SIGTERM");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      const error = new Error("Florence worker was stopped.");
      error.code = "MODEL_STOPPED";
      pending.reject(error);
    }
    this.pending.clear();
    process.removeListener("exit", this.exitHandler);
  }

  /**
   * Resolves one JSONL response.
   * @param {string} line JSON response line.
   */
  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (_error) {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      const error = new Error(String(message.error.message || "Florence worker failed."));
      error.code = String(message.error.code || "MODEL_ERROR");
      pending.reject(error);
    } else pending.resolve(message.result || {});
  }

  /** Rejects requests when the worker exits unexpectedly. */
  handleExit() {
    this.child = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      const error = new Error(`Florence worker exited. ${this.stderr}`.trim());
      error.code = "MODEL_WORKER_EXITED";
      pending.reject(error);
    }
    this.pending.clear();
  }

  /**
   * Sends one bounded inference request, retrying one worker crash.
   * @param {{frames:object[],targets:string[]}} input Detection input.
   * @returns {Promise<object>} Worker result.
   */
  async detect(input) {
    try {
      return await this.send(input);
    } catch (error) {
      if (
        this.restarted ||
        error.code === "MODEL_TIMEOUT" ||
        error.code === "MODEL_ERROR" ||
        error.code === "MODEL_STOPPED"
      ) {
        throw error;
      }
      this.restarted = true;
      this.child?.kill("SIGTERM");
      this.child = null;
      return this.send(input);
    }
  }

  /**
   * Writes one JSONL request.
   * @param {{frames:object[],targets:string[]}} input Detection input.
   * @returns {Promise<object>} Worker result.
   */
  send(input) {
    this.start();
    const id = this.nextId++;
    const frames = input.frames
      .slice(0, 8)
      .filter((frame) => Boolean(frame.filePath))
      .map((frame, index) => ({
        file: frame.filePath,
        frame: Number.isInteger(frame.frame) ? frame.frame : index,
      }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.child?.kill("SIGTERM");
        const error = new Error("Florence inference exceeded 60 seconds.");
        error.code = "MODEL_TIMEOUT";
        reject(error);
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, frames, targets: input.targets })}\n`);
    });
  }
}

/**
 * Creates the optional detector only after an explicit installation.
 * @param {{workerPath?:string,runtimeDir?:string}} [options] Paths.
 * @returns {Function|null} Detection function or null when unavailable.
 */
function createFlorenceDetector(options = {}) {
  const status = florenceRuntimeStatus(options);
  if (!status.installed) return null;
  const workerPath = options.workerPath || path.join(__dirname, "perception", "florence_worker.py");
  const worker = new FlorenceWorker(status, workerPath);
  const detect = (input) => worker.detect(input);
  detect.close = () => worker.stop();
  return detect;
}

module.exports = {
  MODEL_ID,
  MODEL_REVISION,
  MODEL_FILE_SHA256,
  FlorenceWorker,
  createFlorenceDetector,
  florenceRuntimeDir,
  florenceRuntimeStatus,
};
