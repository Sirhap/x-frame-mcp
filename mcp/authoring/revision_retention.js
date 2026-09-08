"use strict";
const fs = require("node:fs");
const path = require("node:path");

/** Parses the optional cap strictly; malformed configuration disables deletion. */
function retentionLimit(value = process.env.XSXB_AUTO_REVISION_LIMIT) {
  if (value === undefined) return { limit: 20, warnings: [] };
  if (/^(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value)))
    return { limit: Number(value), warnings: [] };
  return { limit: 0, warnings: ["Invalid XSXB_AUTO_REVISION_LIMIT; automatic revision cleanup disabled."] };
}

/** Rejects links, foreign snapshots, and unexpected content before recursive removal. */
function ownedSnapshot(base, projectId, id) {
  if (!/^rev_\d+_[a-f0-9]{10}$/.test(id)) throw new Error("Invalid revision directory name.");
  const target = path.join(base, id);
  if (!fs.lstatSync(target).isDirectory()) throw new Error("Revision directory is not a regular directory.");
  const metadata = path.join(target, "revision.json");
  if (!fs.lstatSync(metadata).isFile()) throw new Error("Revision metadata is not a regular file.");
  const snapshot = JSON.parse(fs.readFileSync(metadata, "utf8"));
  if (
    snapshot.id !== id ||
    snapshot.projectId !== projectId ||
    snapshot.schemaVersion !== 1 ||
    !Array.isArray(snapshot.files)
  )
    throw new Error("Revision ownership metadata does not match.");
  const allowed = new Set(["revision.json"]);
  for (const file of snapshot.files) {
    if (!file || !/^[a-f0-9]{64}$/.test(file.hash)) throw new Error("Invalid revision blob metadata.");
    allowed.add(file.hash);
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true }))
    if (!entry.isFile() || !allowed.has(entry.name))
      throw new Error("Unexpected revision directory content.");
  return snapshot;
}

/** Best-effort pruning only removes explicitly disposable pre-edit snapshots. */
function pruneRevisions(base, projectId, { protectedRevisionIds = [] } = {}) {
  const result = { ...retentionLimit(), removedRevisionIds: [], retainedAutomaticCount: 0 };
  if (result.limit === 0) return result;
  try {
    if (!fs.existsSync(base)) return result;
    if (!fs.lstatSync(base).isDirectory()) throw new Error("Revision store is not a regular directory.");
    const snapshots = [];
    for (const id of fs
      .readdirSync(base)
      .filter((name) => name.startsWith("rev_"))
      .sort()
      .reverse()) {
      try {
        snapshots.push(ownedSnapshot(base, projectId, id));
      } catch (error) {
        result.warnings.push(`Revision ${id} retained: ${error.message}`);
      }
    }
    const protectedIds = new Set(protectedRevisionIds);
    if (snapshots.length) protectedIds.add(snapshots[0].id);
    const automatic = snapshots.filter(
      (snapshot) =>
        snapshot.automatic === true &&
        snapshot.purpose === "pre_edit" &&
        snapshot.protection?.retained === false,
    );
    for (const snapshot of automatic.slice(0, result.limit)) protectedIds.add(snapshot.id);
    for (const snapshot of automatic.slice().reverse()) {
      if (protectedIds.has(snapshot.id)) continue;
      try {
        const verified = ownedSnapshot(base, projectId, snapshot.id);
        if (
          verified.automatic !== true ||
          verified.purpose !== "pre_edit" ||
          verified.protection?.retained !== false
        )
          throw new Error("Revision protection changed during cleanup.");
        fs.rmSync(path.join(base, snapshot.id), { recursive: true });
        result.removedRevisionIds.push(snapshot.id);
      } catch (error) {
        result.warnings.push(`Revision ${snapshot.id} retained: ${error.message}`);
      }
    }
    result.retainedAutomaticCount = automatic.length - result.removedRevisionIds.length;
  } catch (error) {
    result.warnings.push(`Revision cleanup deferred: ${error.message}`);
  }
  return result;
}

module.exports = { pruneRevisions };
