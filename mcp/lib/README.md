# MCP vendored dependencies

Copies of the Node modules this package needs so it runs without the Frame Tuner
webapp. These files are not the frontend.

Do not copy `tools/xsxb_mcp_*.js` shims into here — they point back at `mcp/`.

`xsxb_root.js` resolves the workspace via `XSXB_ROOT` or the nearest `package.json`.
