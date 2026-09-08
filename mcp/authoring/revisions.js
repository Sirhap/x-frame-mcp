"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { walkFiles, requireId } = require("./common");
const { withFileTransaction } = require("../lib/file_transaction");
const { decodePngRgba, encodePngRgba } = require("../xsxb_mcp_cutout");
const { renderContactSheet } = require("../xsxb_mcp_visual_qa");
const { pruneRevisions } = require("./revision_retention");

/** Hashes exact file bytes, including PNG encoding and alpha. */
function digest(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
/** Builds project-scoped immutable snapshots and restores without changing registry bindings. */
function createRevisionStore(context) {
  const { root, projectStore: store, resolveAnimationFramePath: resolveFrame } = context;
  let lastTick = 0;
  /** Returns the private revision directory outside the workspace being captured. */
  const directory = (project) => path.join(store.projectPaths(project).dataDir, "revisions");
  /** Lists snapshot-owned files, including explicit in-place frame sources. */
  function currentFiles(project, tolerateMissing = false) {
    const paths = store.projectPaths(project);
    let manifest;
    try {
      manifest = store.readJson(paths.manifest, { profiles: [] });
    } catch (error) {
      if (!tolerateMissing) throw error;
      manifest = { profiles: [] };
    }
    const workspace = store.projectWorkspaceDir(project);
    const files = [
      "manifest",
      "tuning",
      "frameAudio",
      "frameImageAttachments",
      "attachmentAssets",
      "attackTrails",
    ].map((key) => ({
      key: `data/${key}`,
      target: paths[key],
      external: false,
    }));
    for (const file of walkFiles(workspace))
      files.push({
        key: `workspace/${path.relative(workspace, file).split(path.sep).join("/")}`,
        target: file,
        external: false,
      });
    for (const profile of manifest.profiles || [])
      for (const animation of profile.animations || [])
        for (const frame of animation.frames || []) {
          const file = resolveFrame(project, frame.path, animation);
          if (!file || !fs.existsSync(file)) {
            if (tolerateMissing) continue;
            throw new Error(`Snapshot requires every frame to exist: ${frame.path}`);
          }
          if (!files.some((entry) => entry.target === file))
            files.push({ key: `external/${digest(file)}`, target: file, external: true });
        }
    return files.filter((entry) => fs.existsSync(entry.target)).sort((a, b) => a.key.localeCompare(b.key));
  }
  /** Saves exact bytes before a user edit; partially written snapshots are never listed. */
  function save(
    project,
    label = "checkpoint",
    automatic = false,
    tolerateMissing = false,
    purpose = automatic ? "pre_edit" : "manual",
  ) {
    lastTick = Math.max(Date.now(), lastTick + 1);
    const id = `rev_${lastTick}_${crypto.randomBytes(5).toString("hex")}`;
    const base = directory(project),
      staging = path.join(base, `.${id}`),
      destination = path.join(base, id);
    fs.mkdirSync(staging, { recursive: true });
    try {
      const files = currentFiles(project, tolerateMissing).map((entry) => {
        const bytes = fs.readFileSync(entry.target),
          hash = digest(bytes);
        const blob = path.join(staging, hash);
        if (!fs.existsSync(blob)) fs.writeFileSync(blob, bytes);
        return { ...entry, hash, size: bytes.length };
      });
      const snapshot = {
        schemaVersion: 1,
        id,
        projectId: project.id,
        createdAt: new Date().toISOString(),
        label: String(label).slice(0, 160),
        automatic,
        purpose,
        protection: { retained: purpose !== "pre_edit" || !automatic, reason: purpose },
        files,
      };
      fs.writeFileSync(path.join(staging, "revision.json"), JSON.stringify(snapshot, null, 2));
      fs.renameSync(staging, destination);
      const result = summary(snapshot);
      if (!automatic) result.retention = prune(project);
      return result;
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }
  /** Returns compact metadata without embedding asset bytes. */
  function summary(snapshot) {
    return {
      revisionId: snapshot.id,
      label: snapshot.label,
      createdAt: snapshot.createdAt,
      automatic: snapshot.automatic,
      purpose: snapshot.purpose || "legacy",
      protection: snapshot.protection || { retained: true, reason: "legacy" },
      fileCount: snapshot.files.length,
      bytes: snapshot.files.reduce((sum, f) => sum + f.size, 0),
    };
  }
  /** Reads metadata and validates snapshot ownership. */
  function read(project, id) {
    requireId(id, "revision_id");
    const snapshot = JSON.parse(fs.readFileSync(path.join(directory(project), id, "revision.json"), "utf8"));
    if (
      snapshot.schemaVersion !== 1 ||
      snapshot.projectId !== project.id ||
      snapshot.id !== id ||
      !Array.isArray(snapshot.files)
    )
      throw new Error("Revision does not belong to this project.");
    return snapshot;
  }
  /** Lists newest checkpoints first without touching original assets. */
  function list(project) {
    const base = directory(project);
    return fs.existsSync(base)
      ? fs
          .readdirSync(base)
          .filter((id) => id.startsWith("rev_"))
          .sort()
          .reverse()
          .map((id) => summary(read(project, id)))
      : [];
  }
  /** Resolves owned file locations from logical keys; external writes need opt-in. */
  function targetFor(project, entry, allowExternal) {
    if (entry.external) {
      if (!allowExternal)
        throw new Error(
          "Revision includes in_place sources; pass restore_external=true to restore those files.",
        );
      return entry.target;
    }
    const paths = store.projectPaths(project);
    if (entry.key.startsWith("data/")) {
      const key = entry.key.slice(5);
      if (
        ![
          "manifest",
          "tuning",
          "frameAudio",
          "frameImageAttachments",
          "attachmentAssets",
          "attackTrails",
        ].includes(key)
      )
        throw new Error("Invalid revision data key.");
      return paths[key];
    }
    if (!entry.key.startsWith("workspace/")) throw new Error("Invalid revision file key.");
    const base = store.projectWorkspaceDir(project),
      target = path.resolve(base, entry.key.slice(10));
    if (!target.startsWith(`${base}${path.sep}`)) throw new Error("Revision path escapes workspace.");
    return target;
  }
  /** Validates blobs before restoring any original file. */
  function bytesFor(project, snapshot, entry) {
    if (!/^[a-f0-9]{64}$/.test(entry.hash)) throw new Error("Invalid revision hash.");
    const bytes = fs.readFileSync(path.join(directory(project), snapshot.id, entry.hash));
    if (digest(bytes) !== entry.hash) throw new Error(`Corrupt revision blob: ${entry.key}`);
    return bytes;
  }
  /** Compares two checkpoints or one checkpoint with current files, optionally rendering changed PNGs. */
  function compare(project, args) {
    const left = read(project, args.revision_id);
    const right = args.other_revision_id
      ? read(project, args.other_revision_id)
      : { files: currentFiles(project).map((f) => ({ ...f, hash: digest(fs.readFileSync(f.target)) })) };
    const l = new Map(left.files.map((f) => [f.key, f])),
      r = new Map(right.files.map((f) => [f.key, f]));
    const changes = [...new Set([...l.keys(), ...r.keys()])]
      .filter((key) => l.get(key)?.hash !== r.get(key)?.hash)
      .map((key) => ({ key, status: !l.has(key) ? "added" : !r.has(key) ? "removed" : "changed" }));
    const images = [];
    for (const change of changes.filter((c) => c.key.endsWith(".png")).slice(0, 8))
      for (const [snapshot, entries] of [
        [left, l],
        [right, r],
      ]) {
        const entry = entries.get(change.key);
        if (!entry) {
          images.push({ data: new Uint8ClampedArray(64 * 64 * 4), width: 64, height: 64 });
          continue;
        }
        if (snapshot.id) bytesFor(project, snapshot, entry);
        const imagePath = snapshot.id ? path.join(directory(project), snapshot.id, entry.hash) : entry.target;
        images.push(decodePngRgba(imagePath));
      }
    let preview = null;
    if (images.length) {
      const sheet = renderContactSheet(images, {
        cell: 192,
        columns: 2,
        pad: 8,
        grid: false,
        normalize: "cell",
        labels: true,
      });
      const output = path.join(context.currentArtifactDir(project), `revision_compare_${Date.now()}.png`);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, encodePngRgba(sheet.data, sheet.width, sheet.height));
      preview = {
        path: output,
        order: "left=before, right=after; empty checkerboard means missing file",
        files: changes.filter((c) => c.key.endsWith(".png")).slice(0, 8),
      };
    }
    return {
      projectId: project.id,
      revisionId: left.id,
      otherRevisionId: right.id || "current",
      changes,
      preview,
    };
  }
  /** Restores a checkpoint and creates a safety checkpoint first, enabling redo. */
  function restore(project, args) {
    const snapshot = read(project, args.revision_id);
    const jobs = snapshot.files.map((entry) => ({
      target: targetFor(project, entry, args.restore_external === true),
      bytes: bytesFor(project, snapshot, entry),
    }));
    const retained = new Set(jobs.map((job) => job.target));
    const removed = currentFiles(project, true).filter(
      (entry) => !entry.external && !retained.has(entry.target),
    );
    const result = {
      projectId: project.id,
      revisionId: snapshot.id,
      restoredFiles: jobs.length,
      removedFiles: removed.length,
      dryRun: args.dry_run !== false,
    };
    if (result.dryRun) return result;
    result.safetyRevisionId = save(
      project,
      `before restore ${snapshot.id}`,
      true,
      true,
      "restore_safety",
    ).revisionId;
    withFileTransaction((transaction) => {
      for (const job of jobs) {
        fs.mkdirSync(path.dirname(job.target), { recursive: true });
        transaction.writeFile(job.target, job.bytes);
      }
      for (const entry of removed) transaction.removeFile(entry.target);
    });
    return { ...result, restored: true, retention: prune(project, { protectedRevisionIds: [snapshot.id] }) };
  }
  /** Removes an automatic checkpoint only when the attempted operation changed no file. */
  function discardUnchanged(project, id) {
    const snapshot = read(project, id);
    if (!snapshot.automatic || snapshot.purpose !== "pre_edit" || snapshot.protection?.retained !== false)
      return false;
    const current = currentFiles(project, true);
    if (current.length !== snapshot.files.length) return false;
    const byKey = new Map(current.map((entry) => [entry.key, entry]));
    if (
      !snapshot.files.every(
        (entry) =>
          byKey.has(entry.key) && digest(fs.readFileSync(byKey.get(entry.key).target)) === entry.hash,
      )
    )
      return false;
    fs.rmSync(path.join(directory(project), id), { recursive: true, force: true });
    return true;
  }
  /** Runs bounded cleanup after a successful mutation, preserving caller-owned undo checkpoints. */
  function prune(project, options) {
    return pruneRevisions(directory(project), project.id, options);
  }
  return { save, list, compare, restore, discardUnchanged, prune };
}
module.exports = { createRevisionStore };
