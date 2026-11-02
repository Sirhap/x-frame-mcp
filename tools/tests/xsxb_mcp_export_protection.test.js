"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createXsxbMcpService } = require("../../mcp/xsxb_mcp_service");
const { encodePngRgba } = require("../../mcp/xsxb_mcp_cutout");
const { createProjectStore } = require("../../mcp/lib/project_store");

/** Exercises public export calls against isolated, real PNG assets. */
async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-export-protection-"));
  const service = createXsxbMcpService({ root, florenceDetectImpl: null });
  try {
    await service.callMcp("xsxb_create_project", { project_id: "test", project_root: root });
    const source = path.join(root, "source.png");
    fs.writeFileSync(source, encodePngRgba(new Uint8ClampedArray(16 * 16 * 4).fill(255), 16, 16));
    await service.callMcp("xsxb_import_animation", {
      source: "items",
      items: [{ path: source }],
      animation_id: "walk",
      in_place: true,
    });
    const store = createProjectStore(root);
    const paths = store.projectPaths(store.activeProject());
    await run({ root, service, source, paths });
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (const alias of ["direct", "symlink", "hardlink", "parent-symlink"]) {
  test(`sheet rejects ${alias} source destination without changing bytes`, () =>
    fixture(async ({ root, service, source }) => {
      let target = source;
      if (alias === "symlink") {
        target = path.join(root, "alias.png");
        fs.symlinkSync(source, target);
      }
      if (alias === "hardlink") {
        target = path.join(root, "alias.png");
        fs.linkSync(source, target);
      }
      if (alias === "parent-symlink") {
        fs.symlinkSync(root, path.join(root, "alias-dir"));
        target = path.join(root, "alias-dir", "source.png");
      }
      const before = fs.readFileSync(source);
      await assert.rejects(
        service.callMcp("xsxb_export_sheet", { output_path: target, grid: false }),
        /protected|source/i,
      );
      assert.deepEqual(fs.readFileSync(source), before);
    }));
}

test("copy_to is checked before writing primary output or project data", () =>
  fixture(async ({ root, service, source, paths }) => {
    for (const target of [source, paths.manifest]) {
      const before = fs.readFileSync(target);
      const output = path.join(root, "safe.png");
      await assert.rejects(
        service.callMcp("xsxb_export_sheet", { output_path: output, copy_to: target }),
        /protected|source/i,
      );
      assert.deepEqual(fs.readFileSync(target), before);
      assert.equal(fs.existsSync(output), false);
    }
  }));

test("overlay rejects source output while normal sheet export and overwrite work", () =>
  fixture(async ({ root, service, source }) => {
    await assert.rejects(
      service.callMcp("xsxb_export_overlay", { output_path: source }),
      /protected|source/i,
    );
    const output = path.join(root, "safe.png");
    const copy = path.join(root, "copy.png");
    for (let i = 0; i < 2; i++) {
      const result = await service.callMcp("xsxb_export_sheet", {
        output_path: output,
        copy_to: copy,
        grid: false,
      });
      assert.equal(result.ok, true);
      assert.deepEqual(fs.readFileSync(output), fs.readFileSync(copy));
    }
  }));

test("exports protect owned attachment, audio, trail assets and metadata sidecars", () =>
  fixture(async ({ root, service, source, paths }) => {
    for (const directory of ["attachments", "audio", "attack_trails"]) {
      const asset = path.join(paths.workspaceDir, directory, "asset.png");
      fs.mkdirSync(path.dirname(asset), { recursive: true });
      fs.copyFileSync(source, asset);
      const before = fs.readFileSync(asset);
      await assert.rejects(service.callMcp("xsxb_export_sheet", { output_path: asset }), /protected/i);
      assert.deepEqual(fs.readFileSync(asset), before);
    }
    const output = path.join(root, "sidecar.png");
    fs.symlinkSync(paths.manifest, path.join(root, "sidecar.sheet.json"));
    const manifest = fs.readFileSync(paths.manifest);
    await assert.rejects(service.callMcp("xsxb_export_sheet", { output_path: output }), /protected/i);
    assert.equal(fs.existsSync(output), false);
    assert.deepEqual(fs.readFileSync(paths.manifest), manifest);
  }));
