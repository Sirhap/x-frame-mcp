---
name: x-frame-gameplay
description: >-
  Lock scale and feet, save boxes, and diff frames before Godot. Use for walk
  cycles, idle-vs-run height, planting soles, hurt/collision boxes. Idle is the
  grounded reference; VFX and airborne clips are not.
---

# x-frame gameplay

Grounded actors share idle feet and body height. FX, overlay, jump, and airborne clips are exempt.

1. Pick idle (or the first grounded clip) as the reference.
2. `xsxb_measure_frames` against that idle. Walk-lock: `xsxb_register_clip` (apply bakes about the feet) then `xsxb_plant_feet` at `y=-1`, not `0,0`.
3. `xsxb_diff_frames` (`mode=diff` magenta, `mode=onion` keys the plate then red/cyan). Open `preview.path`. `qa=warn` means stop (identical frames or the wrong pair). `qa=review` is not a pass.
4. `xsxb_estimate_boxes` for every actor frame. Attacks need a hitbox. Confirm collision bottoms stay grounded.
5. `xsxb_export_sheet normalize=feet|none` and `grid=false` for a human look. `cell` stretch is not lock QA.

Scale/feet drift is a contract failure, not a style note. Hand off to `skills/x-frame-godot`.
