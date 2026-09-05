"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

/**
 * Stages synchronous multi-file edits and restores originals on commit failure.
 * Each destination uses sibling staging and backup files, so renames work across
 * project volumes. This protects against caught errors, not process termination
 * or concurrent writers in other processes. Callers must serialize mutations.
 */
class FileTransaction {
  /** Creates an isolated set of staged destinations. */
  constructor() {
    this.id = randomUUID();
    this.entries = new Map();
  }

  /**
   * Resolves the latest staged version so repeated edits preserve their order.
   * @param {string} target Destination path.
   * @returns {string} Readable staged file or original path.
   */
  readPath(target) {
    return this.entries.get(path.resolve(target))?.staged || target;
  }

  /**
   * Writes bytes to a sibling staging file without changing the destination.
   * @param {string} target Destination path; its parent must already exist.
   * @param {Buffer|string} bytes Complete replacement content.
   * @returns {void}
   */
  writeFile(target, bytes) {
    const absolute = path.resolve(target);
    let entry = this.entries.get(absolute);
    if (!entry) {
      entry = {
        target: absolute,
        staged: `${absolute}.tmp-${this.id}`,
        backup: `${absolute}.backup-${this.id}`,
        existed: fs.existsSync(absolute),
        installed: false,
        preserveBackup: false,
      };
      this.entries.set(absolute, entry);
    }
    fs.writeFileSync(entry.staged, bytes);
    if (entry.existed) fs.chmodSync(entry.staged, fs.statSync(absolute).mode);
  }

  /** Stages deletion so revision restore can remove files created after a snapshot. */
  removeFile(target) {
    const absolute = path.resolve(target);
    if (!fs.existsSync(absolute)) return;
    this.entries.set(absolute, {
      target: absolute,
      staged: `${absolute}.tmp-${this.id}`,
      backup: `${absolute}.backup-${this.id}`,
      existed: true,
      installed: false,
      preserveBackup: false,
      remove: true,
    });
  }

  /**
   * Stages a JSON document in the same format as the project store.
   * @param {string} target JSON destination.
   * @param {unknown} value Serializable document.
   * @returns {void}
   */
  writeJson(target, value) {
    this.writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
  }

  /** Installs all staged files, restoring committed entries if a rename fails. */
  commit() {
    const entries = [...this.entries.values()];
    // Finish every backup before the first destination changes.
    for (const entry of entries) {
      if (entry.existed) fs.copyFileSync(entry.target, entry.backup, fs.constants.COPYFILE_EXCL);
    }
    try {
      for (const entry of entries) {
        if (entry.remove) fs.rmSync(entry.target);
        else fs.renameSync(entry.staged, entry.target);
        entry.installed = true;
      }
    } catch (error) {
      const failures = [];
      for (const entry of entries.reverse()) {
        if (!entry.installed) continue;
        try {
          if (entry.existed) fs.renameSync(entry.backup, entry.target);
          else fs.rmSync(entry.target, { force: true });
        } catch (restoreError) {
          entry.preserveBackup = true;
          failures.push(
            new Error(`Restore failed for ${entry.target}; original kept at ${entry.backup}.`, {
              cause: restoreError,
            }),
          );
        }
      }
      if (failures.length) {
        throw new AggregateError(
          [error, ...failures],
          `${error.message} Rollback incomplete: ${failures.map((failure) => failure.message).join(" ")}`,
        );
      }
      throw error;
    }
  }

  /** Removes temporary files, retaining any originals needed for manual recovery. */
  cleanup() {
    for (const entry of this.entries.values()) {
      const paths = entry.preserveBackup ? [entry.staged] : [entry.staged, entry.backup];
      for (const file of paths) {
        try {
          fs.rmSync(file, { force: true });
        } catch (error) {
          // Cleanup must not misreport a committed edit as failed, or mask its error.
          process.emitWarning(`Transaction temporary file could not be removed: ${file}: ${error.message}`);
        }
      }
    }
  }
}

/**
 * Prepares and commits one synchronous edit while always releasing staging files.
 * @param {(transaction:FileTransaction)=>unknown} prepare Synchronous preparation.
 * @returns {unknown} Preparation result after successful commit.
 */
function withFileTransaction(prepare) {
  const transaction = new FileTransaction();
  try {
    const result = prepare(transaction);
    transaction.commit();
    return result;
  } finally {
    transaction.cleanup();
  }
}

module.exports = { withFileTransaction };
