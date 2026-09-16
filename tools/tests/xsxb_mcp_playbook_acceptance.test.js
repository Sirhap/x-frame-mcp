"use strict";

const test = require("node:test");
const { runPlaybookAcceptance } = require("../acceptance_playbooks");

test("playbook acceptance diffs a 64x64 hero and gates planted walk, jump, slash, and drift", async () => {
  await runPlaybookAcceptance();
});
