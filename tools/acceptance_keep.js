"use strict";

const fs = require("node:fs");
const path = require("node:path");

const RETRY_CODES = new Set(["EAGAIN", "EBUSY", "EINTR"]);

/**
 * Copies one file, retrying when the destination is briefly busy.
 * Parallel acceptance sessions share `/opt/cursor/artifacts` and can hit EAGAIN.
 * @param {string} from Source path.
 * @param {string} dest Destination path.
 * @param {{tries?:number,copyFileSync?:Function,waitMs?:number}} [options] Retry knobs.
 * @returns {string} dest.
 */
function copyKeepFile(from, dest, options = {}) {
  const tries = Math.max(1, Number(options.tries) || 5);
  const waitMs = Math.max(0, Number(options.waitMs) || 20);
  const copyFileSync = options.copyFileSync || fs.copyFileSync;
  let lastError;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      copyFileSync(from, dest);
      return dest;
    } catch (error) {
      lastError = error;
      if (!RETRY_CODES.has(error && error.code)) throw error;
      if (attempt + 1 < tries && waitMs) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs * (attempt + 1));
      }
    }
  }
  throw lastError;
}

/**
 * Copies named files into dest, retrying busy artifact copies.
 * @param {string} dest Destination directory.
 * @param {Record<string,string>} files Basename to source path.
 * @param {{tries?:number,copyFileSync?:Function}} [options] Retry knobs.
 * @returns {void}
 */
function keepFiles(dest, files, options = {}) {
  if (!dest) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const [name, from] of Object.entries(files)) {
    if (from && fs.existsSync(from)) copyKeepFile(from, path.join(dest, name), options);
  }
}

module.exports = {
  copyKeepFile,
  keepFiles,
};
