"use strict";

const path = require("node:path");
const { createProjectStore } = require("./project_store");

module.exports = async function xsxb_open_tuner(args = {}) {
  const root = path.resolve(process.env.XSXB_ROOT || path.join(__dirname, ".."));
  let projectId = "";
  try {
    const projectStore = createProjectStore(root);
    const project = projectStore.resolveProject(projectStore.readRegistry());
    projectId = project && project.id ? String(project.id) : "";
  } catch (_error) {
    projectId = "";
  }

  return {
    projectId,
    status: "not_implemented",
    error:
      "This leftover module does not start the Tuner. Use the xsxb_open_tuner MCP tool (xsxb_mcp_service.openTuner).",
  };
};

module.exports.description = "Open the XSXB Frame Tuner web interface";
module.exports.inputSchema = { type: "object", properties: { project_id: { type: "string" } } };
