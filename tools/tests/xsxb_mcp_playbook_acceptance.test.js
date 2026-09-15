"use strict";

const test = require("node:test");
const { runPlaybookAcceptance } = require("../acceptance_playbooks");

test("playbook acceptance diffs real 32x32 actors and gates Godot gameplay", async () => {
  await runPlaybookAcceptance();
});
