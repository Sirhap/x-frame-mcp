"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
/** Runs each new authoring tool through the same public client as the core audit. */
function authoringProbes(importSequence) {
  const names = [
    "xsxb_save_revision",
    "xsxb_list_revisions",
    "xsxb_compare_revisions",
    "xsxb_restore_revision",
    "xsxb_undo",
    "xsxb_manage_animation",
    "xsxb_resize_canvas",
    "xsxb_check_animation",
    "xsxb_interpolate_attachment",
  ];
  return Object.fromEntries(
    names.map((name) => [
      name,
      async (fixture) => {
        await importSequence(fixture, "walk");
        const saved = await fixture.call("xsxb_save_revision", { label: "audit" });
        let result;
        if (name === "xsxb_save_revision") result = saved;
        else if (name === "xsxb_list_revisions") {
          result = await fixture.call(name);
          assert.ok(result.revisions.length);
        } else if (name === "xsxb_compare_revisions") {
          result = await fixture.call(name, { revision_id: saved.revisionId });
          assert.deepEqual(result.changes, []);
        } else if (name === "xsxb_restore_revision" || name === "xsxb_undo") {
          await fixture.call("xsxb_update_timing", { frame: 0, duration: 2 });
          result = await fixture.call(name, { revision_id: saved.revisionId, dry_run: false });
          assert.equal(result.restored, true);
          const after = await fixture.call("xsxb_get_animation", { include: ["timing"] });
          assert.deepEqual(after.timing.frameOverrides, {});
        } else if (name === "xsxb_manage_animation") {
          result = await fixture.call(name, { action: "copy", target_animation_id: "copy", dry_run: false });
          assert.equal((await fixture.call("xsxb_get_animation", { animation_id: "copy" })).frameCount, 2);
        } else if (name === "xsxb_resize_canvas") {
          result = await fixture.call(name, { mode: "pad", width: 3, height: 3, dry_run: false });
          assert.equal((await fixture.call("xsxb_get_animation")).animation.frames[0].width, 3);
        } else if (name === "xsxb_check_animation") {
          result = await fixture.call(name);
          assert.equal(result.frameCount, 2);
          assert.ok(fs.existsSync(result.preview.path));
        } else {
          const animation = await fixture.call("xsxb_get_animation");
          await fixture.call("xsxb_add_attachment", {
            id: "probe",
            file_path: animation.animation.frames[0].absolutePath,
            frame: 0,
            sync: false,
          });
          result = await fixture.call(name, {
            id: "probe",
            keyframes: [
              { frame: 0, offset_x: 0, offset_y: 0 },
              { frame: 1, offset_x: 1, offset_y: 1 },
            ],
            dry_run: false,
          });
          assert.equal(result.updatedFrames, 2);
        }
        return {
          tool: name,
          status: "ready",
          evidence: `public authoring workflow passed: ${result.projectId}`,
          gap: "",
        };
      },
    ]),
  );
}
module.exports = { authoringProbes };
