"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createRevisionStore } = require("../../mcp/authoring/revisions");

/** Supplies real snapshots in an isolated temporary authoring workspace. */
function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-retention-"));
  const project = { id: "test" };
  const dataDir = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  const paths = { dataDir };
  for (const key of [
    "manifest",
    "tuning",
    "frameAudio",
    "frameImageAttachments",
    "attachmentAssets",
    "attackTrails",
  ])
    paths[key] = path.join(dataDir, `${key}.json`);
  fs.mkdirSync(dataDir);
  fs.mkdirSync(workspace);
  fs.writeFileSync(paths.manifest, JSON.stringify({ profiles: [] }));
  const context = {
    root,
    projectStore: {
      projectPaths: () => paths,
      projectWorkspaceDir: () => workspace,
      readJson: (file) => JSON.parse(fs.readFileSync(file, "utf8")),
    },
    resolveAnimationFramePath: () => null,
  };
  const revisions = createRevisionStore(context);
  const base = path.join(dataDir, "revisions");
  const previousLimit = process.env.XSXB_AUTO_REVISION_LIMIT;
  process.env.XSXB_AUTO_REVISION_LIMIT = "2";
  try {
    run({ revisions, project, base, root, paths });
  } finally {
    if (previousLimit === undefined) delete process.env.XSXB_AUTO_REVISION_LIMIT;
    else process.env.XSXB_AUTO_REVISION_LIMIT = previousLimit;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("retention bounds automatic checkpoints and preserves manual, safety, legacy and latest undo", () =>
  fixture(({ revisions, project, base }) => {
    const manual = revisions.save(project, "keep this");
    const safety = revisions.save(project, "before restore", true, false, "restore_safety");
    const legacy = revisions.save(project, "legacy", true);
    const legacyPath = path.join(base, legacy.revisionId, "revision.json");
    const legacyData = JSON.parse(fs.readFileSync(legacyPath));
    delete legacyData.purpose;
    delete legacyData.protection;
    fs.writeFileSync(legacyPath, JSON.stringify(legacyData));
    const automatic = Array.from({ length: 5 }, () => revisions.save(project, "before edit", true));
    assert.equal(revisions.list(project).length, 8, "saving before an edit must not prune history");
    const result = revisions.prune(project);
    assert.deepEqual(
      result.removedRevisionIds,
      automatic.slice(0, 3).map((entry) => entry.revisionId),
    );
    assert.deepEqual(
      new Set(revisions.list(project).map((entry) => entry.revisionId)),
      new Set([manual, safety, legacy, ...automatic.slice(3)].map((entry) => entry.revisionId)),
    );
    assert.equal(revisions.list(project)[0].revisionId, automatic.at(-1).revisionId);
  }));

test("retention accepts explicit protection and disables deletion for zero or malformed limits", () =>
  fixture(({ revisions, project }) => {
    const automatic = Array.from({ length: 4 }, () => revisions.save(project, "before edit", true));
    for (const limit of ["0", "-1", "1.5", "2garbage", "", "9007199254740992"]) {
      process.env.XSXB_AUTO_REVISION_LIMIT = limit;
      assert.deepEqual(revisions.prune(project).removedRevisionIds, []);
      assert.equal(revisions.list(project).length, 4);
    }
    process.env.XSXB_AUTO_REVISION_LIMIT = "1";
    const result = revisions.prune(project, { protectedRevisionIds: [automatic[0].revisionId] });
    assert.deepEqual(
      result.removedRevisionIds,
      automatic.slice(1, 3).map((entry) => entry.revisionId),
    );
  }));

test("retention skips symlinks, foreign metadata, and unexpected directory contents", () =>
  fixture(({ revisions, project, base, root }) => {
    const old = Array.from({ length: 4 }, () => revisions.save(project, "before edit", true));
    fs.writeFileSync(path.join(base, old[0].revisionId, "user-notes.txt"), "preserve");
    const foreignPath = path.join(base, old[1].revisionId, "revision.json");
    const foreign = JSON.parse(fs.readFileSync(foreignPath));
    foreign.projectId = "other";
    fs.writeFileSync(foreignPath, JSON.stringify(foreign));
    const moved = path.join(root, "external-revision");
    fs.renameSync(path.join(base, old[2].revisionId), moved);
    fs.symlinkSync(moved, path.join(base, old[2].revisionId));
    process.env.XSXB_AUTO_REVISION_LIMIT = "1";
    const result = revisions.prune(project);
    assert.deepEqual(result.removedRevisionIds, []);
    assert.ok(result.warnings.length >= 3);
    assert.ok(fs.existsSync(path.join(moved, "revision.json")));
    assert.ok(fs.existsSync(path.join(base, old[0].revisionId, "user-notes.txt")));
  }));

test("manual save reports GC failures without losing the saved revision", () =>
  fixture(({ revisions, project, base }) => {
    revisions.save(project, "old", true);
    revisions.save(project, "new", true);
    process.env.XSXB_AUTO_REVISION_LIMIT = "1";
    const originalRemove = fs.rmSync;
    fs.rmSync = (target, options) => {
      if (path.dirname(target) === base) throw new Error("fixture removal denied");
      return originalRemove(target, options);
    };
    try {
      const saved = revisions.save(project, "manual preserved");
      assert.ok(fs.existsSync(path.join(base, saved.revisionId, "revision.json")));
      assert.match(saved.retention.warnings.join(" "), /fixture removal denied/);
    } finally {
      fs.rmSync = originalRemove;
    }
  }));

test("restore failure preserves its safety revision and does not prune undo history", () =>
  fixture(({ revisions, project, paths }) => {
    const original = revisions.save(project, "original");
    fs.writeFileSync(paths.manifest, JSON.stringify({ profiles: [], changed: true }));
    for (let index = 0; index < 3; index++) revisions.save(project, "before edit", true);
    process.env.XSXB_AUTO_REVISION_LIMIT = "1";
    const originalRename = fs.renameSync;
    fs.renameSync = (source, target) => {
      if (target === paths.manifest) throw new Error("fixture restore failed");
      return originalRename(source, target);
    };
    try {
      assert.throws(
        () => revisions.restore(project, { revision_id: original.revisionId, dry_run: false }),
        /fixture restore failed/,
      );
      const snapshots = revisions.list(project);
      assert.equal(snapshots.length, 5);
      assert.equal(snapshots[0].purpose, "restore_safety");
      assert.equal(snapshots[0].protection.retained, true);
      assert.equal(JSON.parse(fs.readFileSync(paths.manifest)).changed, true);
      revisions.prune(project);
      assert.ok(revisions.list(project).some((entry) => entry.revisionId === snapshots[0].revisionId));
    } finally {
      fs.renameSync = originalRename;
    }
  }));

test("unknown purposes and explicitly retained pre-edit snapshots are never collected", () =>
  fixture(({ revisions, project, base }) => {
    const unknown = revisions.save(project, "future feature", true, false, "future_purpose");
    const pinned = revisions.save(project, "pinned", true);
    const metadata = path.join(base, pinned.revisionId, "revision.json");
    const snapshot = JSON.parse(fs.readFileSync(metadata));
    snapshot.protection = { retained: true, reason: "explicit" };
    fs.writeFileSync(metadata, JSON.stringify(snapshot));
    for (let index = 0; index < 3; index++) revisions.save(project, "before edit", true);
    process.env.XSXB_AUTO_REVISION_LIMIT = "1";
    revisions.prune(project);
    const remaining = revisions.list(project);
    assert.equal(remaining.length, 3);
    assert.ok(remaining.some((entry) => entry.revisionId === unknown.revisionId));
    assert.ok(remaining.some((entry) => entry.revisionId === pinned.revisionId));
  }));

test("retention refuses a symlinked revision store and symlinked metadata", () =>
  fixture(({ revisions, project, base, root }) => {
    const old = revisions.save(project, "old", true);
    revisions.save(project, "new", true);
    const metadata = path.join(base, old.revisionId, "revision.json");
    const externalMetadata = path.join(root, "external-metadata.json");
    fs.renameSync(metadata, externalMetadata);
    fs.symlinkSync(externalMetadata, metadata);
    process.env.XSXB_AUTO_REVISION_LIMIT = "1";
    assert.deepEqual(revisions.prune(project).removedRevisionIds, []);
    const externalStore = path.join(root, "external-store");
    fs.renameSync(base, externalStore);
    fs.symlinkSync(externalStore, base);
    const result = revisions.prune(project);
    assert.deepEqual(result.removedRevisionIds, []);
    assert.match(result.warnings.join(" "), /not a regular directory/);
    assert.ok(fs.existsSync(externalMetadata));
    assert.equal(fs.readdirSync(externalStore).length, 2);
  }));
