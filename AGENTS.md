# x-frame-mcp

This repository is the standalone XSXB MCP server. Do not edit [X-Frame](https://github.com/Sirhap/X-Frame) from here.

- Implementation lives in `mcp/`. `tools/xsxb_mcp_*.js` only re-export.
- Default host is the current working directory; authoring files go in `<cwd>/.x-frame/`. `project_root` (any folder) or `XSXB_ROOT` overrides the host. `xsxb_bind_godot` still needs `project.godot` to sync.
- After MCP code changes, run the affected checks and the final project gate. When live reload is needed, use the host reload operation or restart only the verified server instance. Do not delete/rewrite unrelated Cursor configuration or kill processes by broad name matching.
