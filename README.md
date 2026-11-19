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

Without `XSXB_ROOT`, authoring files go in the MCP process’s current working directory under `.x-frame/`. If a desktop client starts the process at the filesystem root (such as `/` on macOS), the service uses `~/.x-frame/`. Set `XSXB_ROOT` to select a shared workspace explicitly. Pass `project_root` when creating a project to store that project’s files under another folder’s `.x-frame/`.

Reload the `x-frame` MCP server after pulling. Confirm with `xsxb_list_projects`.

See [`mcp/README.md`](mcp/README.md) for the tool playbook.

## Direct media editing

Call `xsxb_edit_target` with a local PNG, video, PNG directory, SpriteFrames resource, or ordered PNG items. It works in a fresh directory without creating a project. For example, this writes the flipped frames back to their original paths:

```json
{ "operation": "flip_horizontal", "directory": "/path/to/walk", "dry_run": false }
```

Use `inspect` for dimensions and frame information, `analyze` for motion, duplicates and loop candidates, and `cutout` to remove the background. Edit operations preview by default. Videos use FFmpeg and its companion ffprobe. Project authoring, revision history and Godot synchronization remain available through the project tools.

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
Syntax checks visit every JavaScript and Python file under `mcp/` and `tools/`; vendored algorithms retain their upstream formatting. The legacy `check:mcp` and `check:mcp-v2` commands both run the complete check.

The usability audit (`node mcp/xsxb_mcp_tool_usability.js`) exercises public JSON-RPC `tools/call` receipts, including explicit snapshot/overlay flows. GIF encoding is stubbed and identified in the audit report.

See [the measured performance baseline](docs/performance/mcp-baseline-2026-09-05.md) for scope, numbers, and next steps.

See [the 2026-11-02 reproduction and fix report](docs/validation/optimization-regressions-2026-11-02.md) for snapshot consistency, PNG import and GIF memory fixes, and corrected busy-ping measurements.

See [authoring tools](mcp/authoring/README.md) for checkpoints/undo, animation copy/split/merge/rename, selective cutout, canvas edits, quality reports, and attachment interpolation.

## Layout

| Path                       | Role                                      |
| -------------------------- | ----------------------------------------- |
| `mcp/`                     | Server, tools, vendored algorithms        |
| `tools/xsxb_mcp_*.js`      | Compatibility shims (`require` → `mcp/`)  |
| `tools/tests/`             | MCP tests                                 |
| `skills/xsxb-frame-tuner/` | Agent skill copied for the same playbooks |

## License

MIT
