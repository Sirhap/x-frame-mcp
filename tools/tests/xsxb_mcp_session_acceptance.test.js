"use strict";

const test = require("node:test");
const { runSessionAcceptance } = require("../acceptance_session");

test("session acceptance walks import cutout lock diff boxes and Godot", async () => {
  await runSessionAcceptance();
});
