---
name: x-frame-godot
description: >-
  Sync XSXB data into a bound Godot root and gate gameplay wiring. Use before
  claiming the actor is in the game. Compose with a Godot editor MCP; do not
  absorb editor tools here.
---

# x-frame Godot

`xsxb_sync_godot` copies data and runtime files. Open `godot` on the receipt (runtime files, animation counts). It is not a visual pass and not proof a gameplay scene uses the actor.

1. Bind with `xsxb_bind_godot` (`project.godot` required). Sync only after boxes and scale look right.
2. Instance `{sync_root}/runtime/xsxb_frame_actor.tscn` from a real gameplay scene (not the generated test scene). Consume `animation_duration` and `scene_scale`.
3. `xsxb_sync_godot` then `xsxb_validate_for_godot` with default `require_gameplay: true`. Open `evidence.path` and `run_summary.path`. Validate `qa=review` or `warn` means stop (scale drift is not a pass). `ok` is the gate. `godot` is a disk snapshot (runtime files, animation counts) an editor MCP can `describe` against.
4. `xsxb_validate_project` remains for layered standalone/bind/gameplay dumps.

Editor chores (open scene, run, inspect nodes) belong in a Godot editor MCP such as [godot-mcp](https://github.com/Coding-Solo/godot-mcp) or [satelliteoflove/godot-mcp](https://github.com/satelliteoflove/godot-mcp). This skill does not drive the Godot editor and does not vendor rembg/SAM.
