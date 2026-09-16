"use strict";

const test = require("node:test");
const { runGeneratedAcceptance } = require("../acceptance_generated");

test("generated-hero session walks import cutout lock diff boxes and Godot", async () => {
  await runGeneratedAcceptance();
});
