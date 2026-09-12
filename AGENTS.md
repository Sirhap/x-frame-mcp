# x-frame-mcp

This repository is the standalone XSXB MCP server. Do not edit [X-Frame](https://github.com/Sirhap/X-Frame) from here.

- Implementation lives in `mcp/`. `tools/xsxb_mcp_*.js` only re-export.
- Default host is the current working directory; authoring files go in `<cwd>/.x-frame/`. `project_root` (any folder) or `XSXB_ROOT` overrides the host. `xsxb_bind_godot` still needs `project.godot` to sync.
- After MCP code changes, run `npm run check` (or at least `npm test`). Then reload x-frame: delete the `x-frame` entry from `.cursor/mcp.json` (and `~/.cursor/mcp.json` if it points at the same server), write it back with a new `XSXB_MCP_REV`, and kill leftover `xsxb_mcp_server.js` processes. Disk changes are not the live session.
