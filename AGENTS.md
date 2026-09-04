# x-frame-mcp

This repository is the standalone XSXB MCP server. Do not edit [XSXB-Frame-Tuner](https://github.com/Sirhap/XSXB-Frame-Tuner) from here.

- Implementation lives in `mcp/`. `tools/xsxb_mcp_*.js` only re-export.
- Default host is the current working directory; authoring files go in `<cwd>/.x-frame/`. `project_root` (any folder) or `XSXB_ROOT` overrides the host. `xsxb_bind_godot` still needs `project.godot` to sync.
- `xsxb_open_tuner` needs `XSXB_TUNER_ROOT` or a root that contains `tools/animation_tuner/server.js`.
- After MCP code changes, run `npm run check` (or at least `npm test`).
