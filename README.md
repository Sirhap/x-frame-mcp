# x-frame-mcp

Standalone **XSXB MCP** server. Clone this repo, point Cursor at `mcp/xsxb_mcp_server.js`, and the agent can import frames, cut out backgrounds, lock walk cycles, place stills, and sync Godot — without opening the Frame Tuner web UI.

This package is a copy of the MCP layer from [X-Frame](https://github.com/Sirhap/X-Frame). The Tuner webapp stays in that project. This repo does not replace it.

## Requirements

- Node.js 18+
- `ffmpeg` on `PATH` (video extract and GIF export)
- Optional: a local [X-Frame](https://github.com/Sirhap/X-Frame) checkout if you want to reuse existing Tuner projects

## Install

```bash
git clone https://github.com/Sirhap/x-frame-mcp.git
cd x-frame-mcp
npm install
```

No production npm dependencies. `npm install` only pulls Prettier for `npm run check`.

## Cursor

Cursor does not expand `${workspaceFolder}`. Use an **absolute** path:

```json
{
  "mcpServers": {
    "x-frame": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/x-frame-mcp/mcp/xsxb_mcp_server.js"]
    }
  }
}
```

To operate an existing Tuner workspace (same `data/projects` and frames):

```json
{
  "mcpServers": {
    "x-frame": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/x-frame-mcp/mcp/xsxb_mcp_server.js"],
      "env": {
        "XSXB_ROOT": "/absolute/path/to/X-Frame"
      }
    }
  }
}
```

Without `XSXB_ROOT`, authoring files go in the current working directory’s `.x-frame/` folder (the project the agent is in). Pass `project_root` to store under another folder’s `.x-frame/`.

Reload the `x-frame` MCP server after pulling. Confirm with `xsxb_list_projects`.

See [`mcp/README.md`](mcp/README.md) for the tool playbook. Agent playbooks are `skills/x-frame-import`, `skills/x-frame-cutout`, `skills/x-frame-gameplay`, and `skills/x-frame-godot`. Godot editor actions stay in a separate editor MCP; this server only authors frames and gates the handoff.

## Commands

```bash
npm start                 # stdio MCP server
npm test                  # MCP unit tests
npm run check             # discover sources/tests; syntax, Prettier, tests
npm run benchmark:mcp     # isolated 100/500-frame performance baseline
npm run mcp:perception:install   # optional Florence-2 fallback
npm run mcp:perception:doctor
```

`npm test` and `npm run check` discover the same `tools/tests/**/*.test.js` files.
`npm run acceptance:playbooks` drives JSON-RPC `tools/call` with 32×32 plate-and-subject PNGs and decodes the written preview/evidence files.
Syntax checks visit every JavaScript and Python file under `mcp/` and `tools/`; vendored algorithms retain their upstream formatting. The legacy `check:mcp` and `check:mcp-v2` commands both run the complete check.

The usability audit (`node mcp/xsxb_mcp_tool_usability.js`) exercises public JSON-RPC `tools/call` receipts, including explicit snapshot/overlay flows. GIF encoding is stubbed and identified in the audit report.

See [the measured performance baseline](docs/performance/mcp-baseline-2026-09-05.md) for scope, numbers, and next steps.

See [authoring tools](mcp/authoring/README.md) for checkpoints/undo, animation copy/split/merge/rename, selective cutout, canvas edits, quality reports, and attachment interpolation.

## Layout

| Path                       | Role                                      |
| -------------------------- | ----------------------------------------- |
| `mcp/`                     | Server, tools, vendored algorithms        |
| `tools/xsxb_mcp_*.js`      | Compatibility shims (`require` → `mcp/`)  |
| `tools/tests/`             | MCP tests                                 |
| `skills/xsxb-frame-tuner/` | Router skill; points at the four playbooks |
| `skills/x-frame-*`         | Import, cutout, gameplay, Godot playbooks |

## License

MIT
