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
2. Instance `{sync_root}/runtime/xsxb_frame_actor.tscn` from a real gameplay scene (not the generated test scene). Consume `animation_duration` and `scene_scale`. Copy-paste stub `validateImport` accepts (`{sync_root}` is `xsxb_frame_tuner` on this MCP):

```gdscript
extends Node2D
const ACTOR := preload("res://xsxb_frame_tuner/runtime/xsxb_frame_actor.tscn")
func _ready() -> void:
	var actor = ACTOR.instantiate()
	add_child(actor)
	actor.play_frame_animation("idle")
	var _lock := actor.animation_duration("idle")
	var _move := actor.scene_scale()
```

3. `xsxb_sync_godot` then `xsxb_validate_for_godot` with default `require_gameplay: true` — that default needs a gameplay scene/script that instances `xsxb_frame_actor` and calls `animation_duration` before validate; if missing, receipt `next` says to add a non-runtime `.gd`/`.tscn` that does both. Validate syncs stale game-local tuning when bound. Open `evidence.path` (one cell per clip; one cell per decodable clip; `evidence.skipped` lists zero-decodable, empty_manifest_frames, and unmeasurable_subject clips; `evidence.cells` lists each clip id + picked frame index: attack/slash shows the hit/crescent frame, jump/airborne shows the apex (highest head among near-highest soles) — not always frame 0) and `run_summary.path`. Validate `qa=review` or `warn` means stop (scale drift is not a pass). `ok` is the gate. `godot` is a disk snapshot (runtime files, animation counts) an editor MCP can `describe` against.
4. `xsxb_validate_project` remains for layered standalone/bind/gameplay dumps.

Editor chores (open scene, run, inspect nodes) belong in a Godot editor MCP such as [godot-mcp](https://github.com/Coding-Solo/godot-mcp) or [satelliteoflove/godot-mcp](https://github.com/satelliteoflove/godot-mcp). This skill does not drive the Godot editor and does not vendor rembg/SAM.
