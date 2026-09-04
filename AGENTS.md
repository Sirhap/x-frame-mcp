# x-frame-mcp

This repository is the standalone XSXB MCP server. Do not edit [XSXB-Frame-Tuner](https://github.com/Sirhap/XSXB-Frame-Tuner) from here.

- Implementation lives in `mcp/`. `tools/xsxb_mcp_*.js` only re-export.
- Default workspace is this repo (`data/`, `workspace/`). Set `XSXB_ROOT` to reuse a Tuner checkout.
- `xsxb_open_tuner` needs `XSXB_TUNER_ROOT` or a root that contains `tools/animation_tuner/server.js`.
- After MCP code changes, run `npm run check` (or at least `npm test`).
