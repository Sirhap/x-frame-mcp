---
name: x-frame-cutout
description: >-
  Key studio plates on imported frames and inspect the magenta flatten.
  Use for 抠图, white/black backgrounds, leftover fringe. Do not treat keyed=true as
  the character still being present.
---

# x-frame cutout

Need `basis_snapshot_id` from `xsxb_get_animation` or `xsxb_analyze` before a write.

1. `xsxb_cutout` with `border_flood` on generated white or black plates. Inspect `preview.path` (magenta flatten). Navy cloth on a black plate can be nearly invisible on the source; the magenta preview is the eye check.
2. Already-keyed frames skip unless `force` plus `key_color`. Re-key from raw, not from a previous cutout.
3. `grid=false` sheets for humans. Do not use a default planted contact sheet as “legs remain.”
4. A standing figure that already holds a weapon: `xsxb_place_image` stacks a second blade.

This repo does not ship rembg or SAM weights. If the plate will not key, stop and report the gap. Next: `skills/x-frame-gameplay`.
