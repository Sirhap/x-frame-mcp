"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  PLAYBOOK_CLIPS,
  expectedPlaybookEvidenceCells,
  runPlaybookAcceptance,
} = require("../acceptance_playbooks");

test("playbook expected evidence cells pin jump apex and attack slash, not windup", () => {
  assert.deepEqual(PLAYBOOK_CLIPS, ["idle", "walk", "jump", "attack", "hit_vfx"]);
  assert.deepEqual(expectedPlaybookEvidenceCells(), [
    { id: "idle", frame: 0 },
    { id: "walk", frame: 0 },
    { id: "jump", frame: 1 },
    { id: "attack", frame: 1 },
    { id: "hit_vfx", frame: 0 },
  ]);
  assert.deepEqual(expectedPlaybookEvidenceCells(["idle", "walk", "jump", "attack"]), [
    { id: "idle", frame: 0 },
    { id: "walk", frame: 0 },
    { id: "jump", frame: 1 },
    { id: "attack", frame: 1 },
  ]);
  const attack = expectedPlaybookEvidenceCells(PLAYBOOK_CLIPS).find((cell) => cell.id === "attack");
  assert.ok(attack && attack.frame !== 0, "attack must not be 0 if a slash frame exists");
});

test("playbook acceptance diffs a 64x64 hero and gates planted walk, jump, slash, and drift", async () => {
  await runPlaybookAcceptance();
});
