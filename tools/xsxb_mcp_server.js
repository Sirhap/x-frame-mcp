#!/usr/bin/env node
"use strict";

/** Compatibility shim — implementation lives in mcp/. */
const server = require("../mcp/xsxb_mcp_server");
module.exports = server;
if (require.main === module) server.startServer();
