"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { copyKeepFile } = require("../acceptance_keep");

test("copyKeepFile retries EAGAIN then writes", () => {
  const calls = [];
  const copyFileSync = (from, dest) => {
    calls.push([from, dest]);
    if (calls.length < 3) {
      const error = new Error("EAGAIN");
      error.code = "EAGAIN";
      throw error;
    }
  };
  const dest = copyKeepFile("/tmp/from.gif", "/tmp/keep.gif", {
    copyFileSync,
    tries: 5,
    waitMs: 0,
  });
  assert.equal(dest, "/tmp/keep.gif");
  assert.equal(calls.length, 3);
});

test("copyKeepFile does not retry permanent errors", () => {
  const copyFileSync = () => {
    const error = new Error("ENOENT");
    error.code = "ENOENT";
    throw error;
  };
  assert.throws(
    () => copyKeepFile("/tmp/missing.gif", "/tmp/keep.gif", { copyFileSync, tries: 5, waitMs: 0 }),
    { code: "ENOENT" },
  );
});
