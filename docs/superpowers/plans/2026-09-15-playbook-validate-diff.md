# Playbook split + Godot validate + frame diff

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split agent playbooks and add `xsxb_diff_frames` plus `xsxb_validate_for_godot` so agents cannot call import or sync a visual pass.

**Architecture:** Pixel compose lives in `mcp/xsxb_mcp_diff_frames.js`. Scale-contract helpers live in `mcp/xsxb_mcp_validate_godot.js`. Service/catalog wire public tools. Skills under `skills/x-frame-*` own the four playbooks. Acceptance drives JSON-RPC with 32×32 plate-and-subject PNGs and reads the written preview bytes.

**Tech Stack:** Node.js 18+, existing MCP receipt v2, `node:test`.

## Global Constraints

- No rembg/SAM weights in this change.
- Do not absorb a Godot editor MCP; document composition only.
- `initialize` instructions stay under 2000 characters.
- Image fixtures must include a plate plus a known-area subject (not 1×1).

## Tasks

- [x] RED: acceptance + compose tests fail because tools/modules are missing.
- [x] GREEN: implement compose, validate-for-godot, catalog, skills, docs.
- [x] Real acceptance writes and decodes preview/evidence PNGs through `tools/call`.
