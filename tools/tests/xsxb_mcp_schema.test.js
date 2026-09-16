"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { validateToolArguments } = require("../xsxb_mcp_schema");
const { toolDefinitions } = require("../xsxb_mcp_service");

const SCHEMA = Object.freeze({
  type: "object",
  required: ["file_path"],
  properties: {
    file_path: { type: "string" },
    fps: { type: "number", minimum: 1, maximum: 120, default: 12 },
    start_frame: { type: "integer", minimum: 0 },
    sync: { type: "boolean" },
    layer: { type: "string", enum: ["standalone", "bind", "gameplay"] },
    protected_colors: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
});

/**
 * Captures the message of the error a validation raises.
 * @param {object} args Tool arguments.
 * @returns {string} Error message, or an empty string when it passed.
 */
function validationError(args) {
  try {
    validateToolArguments("xsxb_demo", SCHEMA, args);
    return "";
  } catch (error) {
    return error.message;
  }
}

test("an unknown property is rejected and named", () => {
  const message = validationError({ file_path: "/tmp/a.mp4", animaton_id: "idle" });

  assert.match(message, /animaton_id/u, "the offending property is named");
  assert.match(message, /xsxb_demo/u, "the tool is named");
});

test("an unknown property suggests the closest declared name", () => {
  assert.match(validationError({ file_path: "/tmp/a.mp4", start_frames: 2 }), /start_frame/u);
});

test("a missing required property is rejected", () => {
  assert.match(validationError({ fps: 12 }), /file_path/u);
});

test("a value outside the declared enum is rejected", () => {
  const message = validationError({ file_path: "/tmp/a.mp4", layer: "gamplay" });

  assert.match(message, /layer/u);
  assert.match(message, /standalone/u, "the accepted values are listed");
});

test("numbers outside the declared range are rejected", () => {
  assert.match(validationError({ file_path: "/tmp/a.mp4", fps: 500 }), /fps/u);
  assert.match(validationError({ file_path: "/tmp/a.mp4", start_frame: -1 }), /start_frame/u);
});

test("an exclusive lower bound rejects the bound itself", () => {
  const schema = {
    type: "object",
    properties: { visual_size: { type: "number", exclusiveMinimum: 0 } },
    additionalProperties: false,
  };

  assert.throws(() => validateToolArguments("xsxb_demo", schema, { visual_size: 0 }), /visual_size/u);
  validateToolArguments("xsxb_demo", schema, { visual_size: 0.5 });
});

test("a structurally wrong type is rejected", () => {
  assert.match(validationError({ file_path: { path: "/tmp/a.mp4" } }), /file_path/u);
  assert.match(validationError({ file_path: "/tmp/a.mp4", fps: "soon" }), /fps/u);
  assert.match(
    validationError({ file_path: "/tmp/a.mp4", protected_colors: "#ffffff" }),
    /protected_colors/u,
  );
  assert.match(validationError({ file_path: "/tmp/a.mp4", start_frame: 1.5 }), /start_frame/u);
});

test("array items are checked against their declared type", () => {
  assert.match(validationError({ file_path: "/tmp/a.mp4", protected_colors: [{}] }), /protected_colors/u);
});

// The handlers deliberately accept the stringified numbers and booleans that
// agents send. Validation must not narrow the surface that already works.
test("the leniency the handlers already implement is preserved", () => {
  assert.equal(validationError({ file_path: "/tmp/a.mp4", fps: "24" }), "");
  assert.equal(validationError({ file_path: "/tmp/a.mp4", start_frame: "3" }), "");
  assert.equal(validationError({ file_path: "/tmp/a.mp4", sync: "true" }), "");
  assert.equal(validationError({ file_path: "/tmp/a.mp4", sync: 1 }), "");
  assert.equal(validationError({ file_path: "/tmp/a.mp4", fps: undefined }), "");
});

test("number fields accept a simple a/b fraction", () => {
  const schema = toolDefinitions().find((tool) => tool.name === "xsxb_measure_image").inputSchema;
  validateToolArguments("xsxb_measure_image", schema, { file_path: "/tmp/blade.png", t: "2/3" });
});

test("a valid argument set passes", () => {
  assert.equal(
    validationError({
      file_path: "/tmp/a.mp4",
      fps: 12,
      start_frame: 0,
      sync: false,
      layer: "bind",
      protected_colors: ["#ffffff"],
    }),
    "",
  );
});

test("attack-trail catalog keeps its purpose, motion constraint, and stick interface", () => {
  const tool = toolDefinitions().find((entry) => entry.name === "xsxb_add_attack_trail");
  const stick = tool.inputSchema.properties.sticks.items;
  assert.match(tool.description, /attack-trail/i);
  assert.match(tool.description, /blade-edge/i);
  assert.match(tool.description, /smooth_arc only for truly curved motion/);
  assert.match(tool.description, /pixel-layer crescents belong to place_image/);
  assert.deepEqual(tool.inputSchema.properties.path_kind.enum, ["polyline", "smooth_arc"]);
  assert.equal(stick.type, "object");
  assert.equal(stick.properties.frame.type, "integer");
  assert.match(stick.properties.top.description, /blade tip/i);
  assert.match(stick.properties.bottom.description, /blade grip/i);
  assert.deepEqual(stick.properties.layer.enum, ["behind", "front"]);
  assert.equal(stick.properties.reverseDirection.type, "boolean");
});

test("export catalog describes previews and preserves sheet scale and grid options", () => {
  const gif = toolDefinitions().find((entry) => entry.name === "xsxb_export_gif");
  const sheet = toolDefinitions().find((entry) => entry.name === "xsxb_export_sheet");
  assert.match(gif.description, /trail/i);
  assert.match(sheet.description, /contact sheet PNG/i);
  assert.match(sheet.description, /without changing source frames/i);
  assert.match(sheet.description, /normalize=none\|feet preserves scale/);
  assert.match(sheet.description, /normalize=cell stretches/);
  assert.equal(gif.annotations.readOnlyHint, false, "GIF export writes a file");
  assert.equal(sheet.annotations.readOnlyHint, false, "sheet export writes a file");
  assert.deepEqual(sheet.inputSchema.properties.normalize.enum, ["none", "feet", "height", "cell"]);
  assert.equal(sheet.inputSchema.properties.normalize.default, "none");
  assert.equal(sheet.inputSchema.properties.grid.type, "boolean");
  assert.equal(sheet.inputSchema.properties.grid_divs.type, "string");
  assert.deepEqual(sheet.inputSchema.properties.grid_density.enum, ["sparse", "normal", "dense"]);
  assert.deepEqual(sheet.inputSchema.properties.grid_scope.enum, ["canvas", "subject"]);
});

test("shift catalog retains translation constraints and frame coordinate inputs", () => {
  const shift = toolDefinitions().find((entry) => entry.name === "xsxb_shift_frames");
  assert.match(shift.description, /without resampling or scaling/i);
  assert.match(shift.description, /positive dy moves down/i);
  assert.match(shift.description, /overlay group units/i);
  assert.match(shift.description, /y=-1/);
  assert.match(shift.description, /never 0,0/);
  assert.match(shift.inputSchema.properties.frames.items.properties.to.description, /y=-1/);
  assert.deepEqual(shift.inputSchema.required, ["frames"]);
  assert.ok(shift.inputSchema.properties.frames.items.properties.from);
  assert.ok(shift.inputSchema.properties.frames.items.properties.to);
  assert.equal(shift.inputSchema.properties.frames.items.properties.dx.type, "integer");
  assert.equal(shift.inputSchema.properties.frames.items.properties.dy.type, "integer");
});

test("plant_feet and shift_frames retain planting observation and stale-catalog recovery", () => {
  const plant = toolDefinitions().find((entry) => entry.name === "xsxb_plant_feet");
  const shift = toolDefinitions().find((entry) => entry.name === "xsxb_shift_frames");
  assert.match(plant.description, /lock height with xsxb_register_clip/);
  assert.match(plant.description, /metrics\.feetY is the boot sole and ignores connected bright slash/);
  assert.match(shift.description, /stale catalogs should be reloaded/);
});

test("attachment schema accepts a hand coordinate and handle fraction", () => {
  const attach = toolDefinitions().find((entry) => entry.name === "xsxb_add_attachment");
  assert.ok(attach.inputSchema.properties.hand);
  assert.ok(attach.inputSchema.properties.t);
});

test("unknown grid overlay argument names the closest declared name", () => {
  const sheet = toolDefinitions().find((entry) => entry.name === "xsxb_export_sheet");
  assert.throws(
    () => validateToolArguments("xsxb_export_sheet", sheet.inputSchema, { grid_div: "8x8" }),
    /grid_divs/,
  );
});

test("nested additionalProperties rejects unknown crop_from keys", () => {
  const tool = toolDefinitions().find((entry) => entry.name === "xsxb_overlay_grid");
  assert.throws(
    () =>
      validateToolArguments("xsxb_overlay_grid", tool.inputSchema, {
        file_path: "/tmp/a.png",
        crop_from: {
          parent_view: { x: 0, y: 0, width: 32, height: 32, rows: 8, cols: 8 },
          cells: ["A1"],
          padding: 1,
        },
      }),
    /padding_cells/,
  );
});

test("shift_frames array items reject unknown properties", () => {
  const tool = toolDefinitions().find((entry) => entry.name === "xsxb_shift_frames");
  assert.throws(
    () =>
      validateToolArguments("xsxb_shift_frames", tool.inputSchema, {
        frames: [{ frame: 0, dxx: 9 }],
      }),
    /dxx/,
  );
});

test("shift_frames array items require frame", () => {
  const tool = toolDefinitions().find((entry) => entry.name === "xsxb_shift_frames");
  assert.throws(
    () =>
      validateToolArguments("xsxb_shift_frames", tool.inputSchema, {
        frames: [{ dx: 1 }],
      }),
    /missing required argument "frame"/,
  );
});

test("place_image target_anchor rejects unknown keys", () => {
  const tool = toolDefinitions().find((entry) => entry.name === "xsxb_place_image");
  assert.throws(
    () =>
      validateToolArguments("xsxb_place_image", tool.inputSchema, {
        target_path: "/tmp/t.png",
        object_path: "/tmp/o.png",
        target_anchor: { derife: "center" },
        object_anchor: { mode: "alpha_center" },
      }),
    /derife/,
  );
});

test("create_project and import_video window fields stay optional and lenient", () => {
  const list = toolDefinitions().find((entry) => entry.name === "xsxb_list_projects");
  const get = toolDefinitions().find((entry) => entry.name === "xsxb_get_project");
  const setActive = toolDefinitions().find((entry) => entry.name === "xsxb_set_active_project");
  const create = toolDefinitions().find((entry) => entry.name === "xsxb_create_project");
  const video = toolDefinitions().find((entry) => entry.name === "xsxb_import_video");
  const animation = toolDefinitions().find((entry) => entry.name === "xsxb_import_animation");
  assert.ok(!list.inputSchema.required || list.inputSchema.required.length === 0);
  assert.ok(!get.inputSchema.required || !get.inputSchema.required.includes("project_id"));
  assert.deepEqual(setActive.inputSchema.required, ["project_id"]);
  assert.ok(create, "xsxb_create_project is catalogued");
  assert.ok(!create.inputSchema.required || create.inputSchema.required.length === 0);
  assert.ok(video.inputSchema.properties.start_time);
  assert.ok(video.inputSchema.properties.duration);
  assert.ok(animation.inputSchema.properties.start_time);
  assert.deepEqual(animation.inputSchema.properties.animation_type.enum, [
    "actor",
    "boss",
    "vfx",
    "prop",
    "scene_prop_attachment",
  ]);
  assert.equal(animation.inputSchema.properties.animation_type.default, "actor");
  assert.ok(video.inputSchema.properties.animation_type);
  assert.throws(
    () =>
      validateToolArguments("xsxb_import_animation", animation.inputSchema, {
        source: "png_sequence",
        directory: "/tmp/seq",
        animation_type: "jumper",
      }),
    /animation_type/,
  );
  validateToolArguments("xsxb_import_video", video.inputSchema, {
    file_path: "/tmp/a.mp4",
    fps: "12",
    start_time: "1.6",
    duration: "0.8",
    sync: "true",
  });
  validateToolArguments("xsxb_import_video", video.inputSchema, { file_path: "/tmp/a.mp4" });
});

test("every declared tool schema is one this validator understands", () => {
  const supported = new Set([
    "type",
    "description",
    "properties",
    "required",
    "additionalProperties",
    "enum",
    "items",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "default",
  ]);
  for (const tool of toolDefinitions()) {
    const schema = tool.inputSchema;
    assert.equal(schema.type, "object", `${tool.name} declares an object schema`);
    assert.equal(schema.additionalProperties, false, `${tool.name} closes its schema`);
    for (const [name, property] of Object.entries(schema.properties || {})) {
      for (const keyword of Object.keys(property)) {
        assert.ok(
          supported.has(keyword),
          `${tool.name}.${name} uses unsupported schema keyword "${keyword}"`,
        );
      }
    }
  }
});
