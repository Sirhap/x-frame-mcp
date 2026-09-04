"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { MCP_TOOL_NAMES, createXsxbMcpService, toolDefinitions } = require("../xsxb_mcp_service");
const { INSTRUCTIONS } = require("../xsxb_mcp_server");
const { mcpArtifactDir } = require("../xsxb_mcp_arguments");
const { compilePlaceBrief } = require("../xsxb_mcp_place_brief");

/** Minimal valid PNG (1×1). */
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * @returns {{root:string, target:string, object:string, cleanup:()=>void}}
 */
function pngPair() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-plan-place-"));
  const target = path.join(root, "target.png");
  const object = path.join(root, "object.png");
  fs.writeFileSync(target, ONE_PIXEL_PNG);
  fs.writeFileSync(object, ONE_PIXEL_PNG);
  return {
    root,
    target,
    object,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * @param {Partial<object>} [extra]
 * @param {{root:string,target:string,object:string}} pair
 */
function validArgs(pair, extra = {}) {
  return {
    target_path: pair.target,
    object_path: pair.object,
    intent: "Composite object onto target at the named contact patches",
    read: {
      target_contact: "opaque contact mass on the target",
      object_contact: "opaque contact mass on the object",
      target_cells: ["E5"],
      object_cells: ["C4", "C5"],
    },
    physics: [
      "Contact opaque centroids coincide",
      "Scale from a named span on the target",
      "Composite only — do not redraw either sprite",
    ],
    accept: [
      "verify_overlay shows contact patches overlapping",
      "Object does not float a full cell away from the contact patch",
    ],
    plan: [
      "overlay both images and refine contact cells with crop_from if needed",
      "place with both anchors snap alpha_centroid",
      "set rotation scale layer from the pose read above",
      "inspect verify_overlay_path against accept",
    ],
    ...extra,
  };
}

test("a valid 图度 compiles a place brief and defaults to next=place", () => {
  const pair = pngPair();
  try {
    const planned = compilePlaceBrief(validArgs(pair), { root: pair.root });
    assert.equal(planned.next, "place");
    assert.equal(planned.await_confirm, false);
    assert.match(planned.brief, /Execute this brief/i);
    assert.match(planned.brief, /snap alpha_centroid on both contact patches/);
    assert.match(planned.brief, /does not redraw|do not redraw/i);
    assert.match(planned.brief, /never freehand|speakable cell/i);
    assert.match(planned.brief, /Composite object onto target/);
    assert.match(planned.brief, /Contact opaque centroids coincide/);
    assert.deepEqual(planned.read.target_cells, ["E5"]);
    assert.equal(planned.plan.length, 4);
    assert.doesNotMatch(planned.brief, /Held weapon fast path|measure_t\s*~?\s*0\.1|forearm/i);
  } finally {
    pair.cleanup();
  }
});

test("await_confirm sets next=await_user and tells the agent to pause", () => {
  const pair = pngPair();
  try {
    const planned = compilePlaceBrief(validArgs(pair, { await_confirm: true }), { root: pair.root });
    assert.equal(planned.next, "await_user");
    assert.equal(planned.await_confirm, true);
    assert.match(planned.brief, /await|confirm|do not call xsxb_place_image/i);
  } finally {
    pair.cleanup();
  }
});

test("await_confirm coerces string true like other MCP flags", () => {
  const pair = pngPair();
  try {
    const planned = compilePlaceBrief(validArgs(pair, { await_confirm: "true" }), { root: pair.root });
    assert.equal(planned.await_confirm, true);
    assert.equal(planned.next, "await_user");
  } finally {
    pair.cleanup();
  }
});

test("thin physics warns but still compiles", () => {
  const pair = pngPair();
  try {
    const planned = compilePlaceBrief(
      validArgs(pair, {
        physics: ["Contact opaque centroids coincide"],
      }),
      { root: pair.root },
    );
    assert.ok(planned.warnings.some((w) => /physics/i.test(w)));
  } finally {
    pair.cleanup();
  }
});

test("rejects empty intent, physics, accept, or bad plan length", () => {
  const pair = pngPair();
  try {
    assert.throws(() => compilePlaceBrief(validArgs(pair, { intent: "x" }), { root: pair.root }), /intent/);
    assert.throws(() => compilePlaceBrief(validArgs(pair, { physics: [] }), { root: pair.root }), /physics/);
    assert.throws(() => compilePlaceBrief(validArgs(pair, { accept: [] }), { root: pair.root }), /accept/);
    assert.throws(
      () =>
        compilePlaceBrief(
          validArgs(pair, {
            plan: ["one", "two"],
          }),
          { root: pair.root },
        ),
      /plan/,
    );
    assert.throws(
      () =>
        compilePlaceBrief(
          validArgs(pair, {
            plan: ["1", "2", "3", "4", "5", "6"],
          }),
          { root: pair.root },
        ),
      /plan/,
    );
  } finally {
    pair.cleanup();
  }
});

test("rejects bad cell ids and freehand proposed coordinates", () => {
  const pair = pngPair();
  try {
    assert.throws(
      () =>
        compilePlaceBrief(
          validArgs(pair, {
            read: {
              target_contact: "opaque mass on the target",
              object_contact: "opaque mass on the object",
              target_cells: ["cup"],
            },
          }),
          { root: pair.root },
        ),
      /speakable|cell/i,
    );
    assert.throws(
      () =>
        compilePlaceBrief(
          validArgs(pair, {
            proposed: { x: 40, y: 32 },
          }),
          { root: pair.root },
        ),
      /freehand|x,y|proposed/i,
    );
  } finally {
    pair.cleanup();
  }
});

test("rejects paths outside the XSXB root or missing files", () => {
  const pair = pngPair();
  try {
    assert.throws(
      () =>
        compilePlaceBrief(validArgs(pair, { target_path: "/tmp/outside-xsxb-target.png" }), {
          root: pair.root,
        }),
      /inside|not found|root/i,
    );
    assert.throws(
      () =>
        compilePlaceBrief(validArgs(pair, { object_path: path.join(pair.root, "missing.png") }), {
          root: pair.root,
        }),
      /not found/i,
    );
  } finally {
    pair.cleanup();
  }
});

test("xsxb_plan_place is catalogued, generic, and returns the compiled brief", async () => {
  assert.ok(MCP_TOOL_NAMES.includes("xsxb_plan_place"));
  const overlay = MCP_TOOL_NAMES.indexOf("xsxb_overlay_grid");
  const plan = MCP_TOOL_NAMES.indexOf("xsxb_plan_place");
  const place = MCP_TOOL_NAMES.indexOf("xsxb_place_image");
  assert.ok(overlay < plan && plan < place, "plan_place sits between overlay and place");
  const tool = toolDefinitions().find((entry) => entry.name === "xsxb_plan_place");
  assert.ok(tool);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.match(tool.description, /图度|read|physics|brief/i);
  assert.match(tool.description, /alpha_centroid/);
  assert.doesNotMatch(tool.description, /Held weapon fast path|measure_t\s*~?\s*0\.1|forearm/i);
  const pair = pngPair();
  try {
    const service = createXsxbMcpService({ root: pair.root });
    const planned = await service.call("xsxb_plan_place", validArgs(pair));
    assert.equal(planned.next, "place");
    assert.match(planned.brief, /alpha_centroid/);
    assert.match(planned.plan_id, /^pln_[0-9a-f]{12}$/);
    assert.match(planned.brief, /overlay_id/);
    assert.ok(planned.brief.includes(planned.plan_id), "brief must name this plan_id");
    const artifactDir = mcpArtifactDir("", pair.root);
    assert.equal(fs.existsSync(path.join(artifactDir, "place-plans", `${planned.plan_id}.json`)), true);
  } finally {
    pair.cleanup();
  }
});

test("object_cells stay on the brief as read notes that may pair with measure_t", () => {
  const pair = pngPair();
  try {
    const planned = compilePlaceBrief(validArgs(pair), { root: pair.root });
    assert.deepEqual(planned.read.object_cells, ["C4", "C5"]);
    assert.match(planned.brief, /Object contact cells: C4, C5/);
    assert.match(
      planned.brief,
      /measure_t/,
      "brief must say place may use object_anchor.measure_t instead of matching those cells",
    );
    const planTool = toolDefinitions().find((entry) => entry.name === "xsxb_plan_place");
    assert.match(
      planTool.inputSchema.properties.read.properties.object_cells.description,
      /measure_t|notes/i,
    );
    const place = toolDefinitions().find((entry) => entry.name === "xsxb_place_image");
    assert.match(place.inputSchema.properties.plan_id.description, /measure_t/);
  } finally {
    pair.cleanup();
  }
});

test("compilePlaceBrief writes a stable plan_id JSON the place consumer can load", () => {
  const pair = pngPair();
  const artifactDir = path.join(pair.root, ".xsxb");
  try {
    const args = validArgs(pair, {
      proposed: { layer: "under_target", snap: "alpha_centroid" },
    });
    const planned = compilePlaceBrief(args, { root: pair.root, artifactDir });
    assert.match(planned.plan_id, /^pln_[0-9a-f]{12}$/);
    assert.match(planned.brief, /overlay_id/);
    assert.match(planned.brief, /plan_id/);
    assert.ok(planned.brief.includes(planned.plan_id), "brief must name this plan_id");
    assert.match(planned.brief, /xsxb_place_image/);
    assert.match(planned.brief, /never freehand|speakable cell/i);

    const canonical = {
      target_path: pair.target,
      object_path: pair.object,
      read: { target_cells: ["E5"], object_cells: ["C4", "C5"] },
      proposed: { layer: "under_target", snap: "alpha_centroid" },
    };
    const expectedId = `pln_${crypto.createHash("sha1").update(JSON.stringify(canonical)).digest("hex").slice(0, 12)}`;
    assert.equal(planned.plan_id, expectedId);

    const planPath = path.join(artifactDir, "place-plans", `${planned.plan_id}.json`);
    assert.equal(fs.existsSync(planPath), true, "plan JSON must land under artifactDir/place-plans");
    const saved = JSON.parse(fs.readFileSync(planPath, "utf8"));
    assert.equal(saved.plan_id, planned.plan_id);
    assert.equal(saved.target_path, pair.target);
    assert.equal(saved.object_path, pair.object);
    assert.deepEqual(saved.read.target_cells, ["E5"]);
    assert.deepEqual(saved.read.object_cells, ["C4", "C5"]);
    assert.equal(saved.proposed.layer, "under_target");
    assert.equal(saved.proposed.snap, "alpha_centroid");

    const again = compilePlaceBrief(args, { root: pair.root, artifactDir });
    assert.equal(again.plan_id, planned.plan_id, "same inputs must reuse the same plan_id");
  } finally {
    pair.cleanup();
  }
});

test("omitted proposed fields persist as null except default snap alpha_centroid", () => {
  const pair = pngPair();
  const artifactDir = path.join(pair.root, ".xsxb");
  try {
    const planned = compilePlaceBrief(validArgs(pair), { root: pair.root, artifactDir });
    const saved = JSON.parse(
      fs.readFileSync(path.join(artifactDir, "place-plans", `${planned.plan_id}.json`), "utf8"),
    );
    assert.equal(saved.proposed.layer, null);
    assert.equal(saved.proposed.snap, "alpha_centroid");
    const canonical = {
      target_path: pair.target,
      object_path: pair.object,
      read: { target_cells: ["E5"], object_cells: ["C4", "C5"] },
      proposed: { layer: null, snap: null },
    };
    const expectedId = `pln_${crypto.createHash("sha1").update(JSON.stringify(canonical)).digest("hex").slice(0, 12)}`;
    assert.equal(
      planned.plan_id,
      expectedId,
      "hash missing snap as null even if the file stores the default",
    );
  } finally {
    pair.cleanup();
  }
});

test("INSTRUCTIONS and skill path mention xsxb_plan_place before place", () => {
  assert.match(INSTRUCTIONS, /xsxb_plan_place/);
  assert.match(INSTRUCTIONS, /图度|physics|read.*plan|plan_place/i);
  const place = toolDefinitions().find((entry) => entry.name === "xsxb_place_image");
  assert.match(place.description, /xsxb_plan_place/);
  const skill = fs.readFileSync(path.join(__dirname, "../../skills/xsxb-frame-tuner/SKILL.md"), "utf8");
  assert.match(skill, /xsxb_plan_place/);
  assert.match(skill, /图度/);
});
