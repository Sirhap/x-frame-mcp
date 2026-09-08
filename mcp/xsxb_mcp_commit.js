"use strict";

const { booleanFlag } = require("./xsxb_mcp_arguments");

/**
 * Resolves the shared preview/commit contract without conflicting schema defaults.
 * @param {{apply?:boolean,dry_run?:boolean}} args Normalized tool arguments.
 * @returns {boolean} Whether an explicit commit was requested and not vetoed.
 */
function shouldCommit(args) {
  if (booleanFlag(args.dry_run) || (args.apply !== undefined && !booleanFlag(args.apply))) return false;
  return booleanFlag(args.apply) || (args.dry_run !== undefined && !booleanFlag(args.dry_run));
}

module.exports = { shouldCommit };
