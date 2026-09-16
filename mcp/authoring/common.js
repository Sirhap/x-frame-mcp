"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { withFileTransaction } = require("../lib/file_transaction");

/** Clones persisted JSON data. */
function clone(value) {
  return structuredClone(value);
}
/** Rejects unsafe ids instead of silently selecting another entity. */
function requireId(value, label = "id") {
  if (typeof value !== "string" || !/^[\p{L}\p{N}_-]{1,100}$/u.test(value))
    throw new Error(`${label} must contain 1–100 letters, digits, underscores or hyphens.`);
  return value;
}
/** Selects unique ascending indexes; ranges are inclusive and cannot mix with lists. */
function frameIndexes(args, count) {
  if (!count) throw new Error("Animation has no frames.");
  if (args.frames !== undefined && (args.start_frame !== undefined || args.end_frame !== undefined))
    throw new Error("Use frames or start_frame/end_frame, not both.");
  const start = args.start_frame ?? 0,
    end = args.end_frame ?? count - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= count)
    throw new Error("Frame range is outside the animation.");
  const indexes =
    args.frames !== undefined ? args.frames : Array.from({ length: end - start + 1 }, (_, i) => start + i);
  if (!Array.isArray(indexes) || !indexes.length || indexes.length > count)
    throw new Error("Frame selection must be non-empty and within the animation.");
  for (const index of indexes)
    if (!Number.isInteger(index) || index < 0 || index >= count)
      throw new Error(`Frame must be between 0 and ${count - 1}.`);
  if (new Set(indexes).size !== indexes.length) throw new Error("Duplicate frame indexes are not allowed.");
  return [...indexes].sort((a, b) => a - b);
}
/** Enumerates regular authoring files without following symlinks or preview directories. */
function walkFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".") || /\.(tmp|backup|import|organize)-/.test(entry.name)) return [];
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(file) : entry.isFile() ? [file] : [];
  });
}
/** Loads all related authoring documents in one consistent synchronous operation. */
function loadDocuments(store, project) {
  const paths = store.projectPaths(project);
  const defaults = {
    manifest: { schemaVersion: 1, profiles: [] },
    tuning: {},
    frameAudio: [],
    frameImageAttachments: [],
    attachmentAssets: [],
    attackTrails: { schemaVersion: 8, bindings: {} },
  };
  return {
    paths,
    documents: Object.fromEntries(
      Object.entries(defaults).map(([key, fallback]) => [key, store.readJson(paths[key], fallback)]),
    ),
  };
}
/** Atomically replaces the selected documents and PNG files with caught-error rollback. */
function commitDocuments(paths, documents, files = [], removed = []) {
  withFileTransaction((transaction) => {
    for (const { target, bytes } of files) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      transaction.writeFile(target, bytes);
    }
    for (const target of removed) transaction.removeFile(target);
    for (const [key, value] of Object.entries(documents)) transaction.writeJson(paths[key], value);
  });
}
/** Moves persisted point coordinates by the same origin delta as their frame pixels. */
function translateAnnotations(documents, key, dx, dy) {
  const boxes = documents.tuning.frame_box_overrides?.[key];
  for (const box of Object.values(boxes || {}))
    if (box?.offset) {
      box.offset.x = Number(box.offset.x || 0) + dx;
      box.offset.y = Number(box.offset.y || 0) + dy;
    }
  for (const binding of documents.frameImageAttachments || [])
    if ((binding.key || binding.frameKey) === key && binding.transform?.offset) {
      binding.transform.offset.x += dx;
      binding.transform.offset.y += dy;
    }
  const split = key.lastIndexOf(":"),
    group = key.slice(0, split),
    frame = Number(key.slice(split + 1));
  for (const segment of documents.attackTrails.bindings?.[group] || [])
    for (const stick of segment.sticks || [])
      if (stick.frame === frame)
        for (const name of ["top", "bottom"])
          if (stick[name]) {
            stick[name].x += dx;
            stick[name].y += dy;
          }
}
/**
 * Writes tuning, attachments, and trails only when those documents already hold bindings.
 * @param {{writeJson:Function}} transaction Open file transaction.
 * @param {object} paths Project store paths.
 * @param {object} documents Loaded authoring documents.
 * @returns {void}
 */
function persistAnnotationDocuments(transaction, paths, documents) {
  if (documents.tuning?.frame_box_overrides && Object.keys(documents.tuning.frame_box_overrides).length) {
    transaction.writeJson(paths.tuning, documents.tuning);
  }
  if (Array.isArray(documents.frameImageAttachments) && documents.frameImageAttachments.length) {
    transaction.writeJson(paths.frameImageAttachments, documents.frameImageAttachments);
  }
  if (documents.attackTrails?.bindings && Object.keys(documents.attackTrails.bindings).length) {
    transaction.writeJson(paths.attackTrails, documents.attackTrails);
  }
}
module.exports = {
  clone,
  requireId,
  frameIndexes,
  walkFiles,
  loadDocuments,
  commitDocuments,
  translateAnnotations,
  persistAnnotationDocuments,
};
