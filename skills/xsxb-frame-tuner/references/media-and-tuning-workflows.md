# Media and Tuning Workflows

Use this reference for existing tuner operations beyond deterministic animation import and runtime wiring.

## Contents

- Local execution and project selection
- Batch cutout
- MCP video-to-loop playbook
- MCP overlay grid and group coordinates
- MCP still overlay and place
- MCP chop crescent trail (pixel layer)
- Video extraction and frame organization
- Transform and playback tuning
- Boxes, SFX, and image attachments
- Save, synchronization, and completion evidence

## Local Execution and Project Selection

- Keep source images, videos, audio, and Godot projects on the local machine.
- Start or reuse `tools/animation_tuner/server.js`; it listens on `127.0.0.1` by default.
- Select the exact XSXB project, profile, and animation before editing.
- Record the initial frame count and existing frame-indexed tuning, boxes, SFX, and attachments before destructive operations.
- Use an available browser-control capability for features implemented only in the local tuner UI. Inspect the page state and rendered frames before acting.
- Do not invent a CLI or direct JSON rewrite for a browser-only operation when doing so would bypass its remapping, confirmation, or synchronization behavior.

## Batch Cutout

Use the Batch Cutout panel for local multi-image background removal and animation-frame replacement.

Supported operations include:

- Load multiple local images or load the current animation group.
- Estimate a background color per image or use one or more manual background samples.
- Clear only edge-connected background or clear matching background across the image.
- Adjust perceptual keying, alpha low/high thresholds, hard transparency threshold, edge softness, edge recovery, despill/decontamination, and background search radius.
- Protect sampled colors or colors extracted from a selected rectangle.
- Apply rectangular smart clear, full clear, subject restoration, undo, and redo.
- Propagate a local repair through the sequence using motion prediction and shape matching.
- Export processed PNG files without changing the active animation.
- Replace the current animation only when processed image count equals the current frame count.

Workflow:

1. Load the intended source set and confirm file order and image count.
2. Start with automatic edge-connected background detection.
3. Inspect representative frames containing the hardest edges, similar foreground/background colors, weapons, VFX, hair, and semi-transparent details.
4. Add background samples or protected colors before increasing destructive tolerance.
5. Apply local repair on a representative frame and inspect propagated results, including skipped frames.
6. Prefer separate PNG export when replacement intent is absent.
7. Before replacing the current group, confirm exact frame-count equality and explicit overwrite intent.
8. After replacement, inspect the animation, save, sync Godot, and verify manifest frame paths and counts.

Do not claim a clean cutout solely because the batch completed. Check edge halos, missing foreground colors, accidental holes, alpha noise, and consistency across frames.

## MCP Video-to-Loop Playbook

For a local video that should become one looping animation, stay on XSXB MCP. Follow skill「MCP 工程流程」first: one-sentence goal, ordered todo, look at `preview.path` after cutout before the next step.

1. If no project exists, `xsxb_create_project`. Import with `xsxb_import_animation` or `xsxb_import_video` (optional `start_time` / `duration`; omit for the full file).
2. Run `xsxb_cutout` (omit sliders for the shared smart profile; generated black/white plates use `key_mode=border_flood`). Look at `preview.path` (magenta flatten) — not the planted contact sheet — to confirm dark clothes remain.
3. `xsxb_analyze` (one decode: duplicates, loop, motion, plus a `grid=false` preview sheet). Look at `preview.path` — do not export every candidate with `xsxb_export_sheet`. `oneShotLikely` means a short burst inside a longer clip; a solid interior cycle in a long take is not a one-shot. Skip apply when the receipt has `autoAdjustedThreshold` unless you passed `auto_adjust`.
4. Inspect the preview, pick `loop.recommended.order` or `motion.order`, and `xsxb_reorganize_frames`.
5. Keep character scale the same across clips: choose one animation as the template, `xsxb_estimate_visual` with `reference_animation_id` and `apply`, then `xsxb_cutout apply_visual` on a shared canvas.
6. Finish with one `xsxb_export_gif` of the kept loop.

Do not treat a finder or analyze receipt as applied. `xsxb_analyze`, `xsxb_find_duplicates`, and `xsxb_find_loop` only return orders.

## MCP overlay grid and group coordinates

Contact sheets from `xsxb_export_sheet` (and cutout `inspectFeet`) overlay a group-coordinate grid. Source animation PNGs are unchanged. Foot `0,0`, `+x` right, `+y` down, body in negative y. Yellow `0,0` is outside the bitmap (`canvasAnchor` uses `y: height`); last pixel row is group `y=-1`. Receipt `lastPixel` is `{ group: {x:0,y:-1}, canvas: {y: height-1} }`. **Grid lines** follow density. Overlay paints row/col indices matching `grid.cells[row][col]`. Group `x,y` are code-generated in that JSON and `grid.legend` — **do not OCR** overlay digits. For write-back use `grid.cells[row][col]` (row 0 = top of the overlay cell, col 0 = left; `x`,`y` is that square's top-left group corner). Receipt also lists `xLines`, `yLines`, and every grid `tick`.

Fill overlay parameters from the task and image size; MCP does not guess:

- `grid_density`: `sparse` (4×4), `normal` (8×8), `dense` (16×16) — this densifies lines, not the digit soup
- or `grid_divs` like `8x8`, or `grid_x` / `grid_y`
- `grid_scope`: `canvas` for the whole frame, `subject` for the opaque character box

Write-back uses `grid.cells[row][col]` (or the same group numbers). Do not convert them to canvas pixels. Do not OCR the overlay digits.

Planting:

- `xsxb_shift_frames` is already in the catalog. If a client reports it not found, reload the `xsxb` MCP server (stale session catalog). Do not skip planting.
- Do not plant soles to `0,0`; that clips 1px. Plant the sole to `y=-1`.
- `metrics.feetY` is the boot sole and ignores connected bright slash/glow below it. Confirm on the overlay before planting.

- `xsxb_shift_frames` `from`/`to` or `dx`/`dy`
- box `min`/`max` or `offset`/`size`
- attachment `hand` plus `t` (MCP measures the PNG)
- trail stick `top`/`bottom`
- visual `offset_x`/`offset_y`

After a write, export another sheet and check the ticks. `xsxb_get_animation` receipts are also group space.

## MCP still overlay and place

`xsxb_overlay_grid`, `xsxb_plan_place`, and `xsxb_place_image` work on still PNGs. MCP does not call a VLM; the agent is the eye.

1. Overlay each PNG with `xsxb_overlay_grid` (default 8×8). Report only speakable cell ids such as `A1`. Do not OCR pixel boxes or x,y. Pass receipt `overlay_id` on later `crop_from` / place (agent-led MUST). If `next` is `crop_from`, overlay the contact cells before placing. Do not mix still `view` with animation `grid.cells`. Source PNG is unchanged.
2. Refine with `crop_from: { parent_view, cells, padding_cells, overlay_id }`. The crop is integer (floor origin, ceil far edge) and `view` stays in original-image pixels so remapped `A1` starts at the crop origin. The new `overlay_id` is for that cropped view.
3. **图度：** after the user confirms a composite, call `xsxb_plan_place` (`intent`, `read`, `physics`, `accept`, 3–5 step `plan`). Execute `receipt.brief`. Default is to place next; `await_confirm` or a user “先方案” request pauses. Named contact cells default to `snap: "alpha_centroid"` — never freehand `x,y`.
4. Place with `xsxb_place_image` per that brief. Pass `overlay_id` and optional `plan_id`. Named cells without `derive` default to `alpha_centroid`, then `nudge` `{dx,dy}` only if accept fails. `scale` `relative`|`physical` from a named span. `layer` `front`|`under_target`|`behind`. `rotation` from the pose you see. The tool does not redraw either sprite. Inspect `verify.status` and `verify_overlay_path` against `accept`. Never freehand `x,y`.
5. Example only: standing a figure on a marked region is cell ids plus a physical width — there are no domain-specific place fields.
6. `xsxb_measure_image` `anchor=alpha_bottom` returns the same opaque-foot geometry.
7. `xsxb_cutout` `file_path` runs the same smart-cutout on one workspace PNG (sibling `_cut.png` by default). Animation-frame cutout is unchanged.

## MCP attack sickle trail (pixel layer)

Look at **this** animation's frames (sheet / `xsxb_overlay_grid`) and **trace the striking-mass** (weapon head) cell to cell. The smear arc is that observed motion — do not pick a canned chop or 上挑 recipe. A clip like 牛来's plunger that travels overhead then down reads as a downward sickle; a clip whose head scoops upward reads as 上挑. Same playbook.

The generic playbook is only the **skeleton**. Before painting, call `xsxb_plan_smear` with the motion you actually read, `path_kind` `polyline` or `smooth_arc`, sampled color, and per-frame start/end/head cells. `receipt.brief` is the clip-specific prompt — execute that brief. Do not jump from the skeleton to GenerateImage.

Use `xsxb_add_attack_trail` Hermite sticks only when that traced path is already a smooth arc that matches the smear you want. Mesh `color` is the striking mass or a user-named hex — do not hardcode red. If what you traced is a polyline that should still read as a sickle (牛来 chop across then down, e.g. D1→G3 then H8, is one case; an 上挑 clip can fail the same way) — do **not** default to that mesh. Hermite through those points always reads as a 7字折杆, a diagonal slice, or a column plus hook. Twisting `tangentStrength`, `reverseDirection`, or extra mid sticks only swaps 不够弯 and 7字.

Paint the 拖影 as a 像素层 月牙/镰刀 along the traced path:

0. **Lock per-frame start and end cells first** (via `xsxb_plan_smear`). Start = where this smear begins (the far cell already swept). End = on the leading/outer side of the current striking face — do not pin the head on the striking-mass cell (that paints the ribbon onto the cup/shaft). Keep the band tight: `layer` `behind` so opaque weapon pixels punch through (hairline readable cup). Reject a full-grid-cell void. The smear occupies the front half of the weapon (striking-mass side), not the grip, not overlapping the weapon sprite, and not farther ahead than this frame's cup has reached.
1. Take smear color from the striking mass or the named hex — do not hardcode red. Generate a hollow sickle ribbon on pure white (pixel art; no character, no text) that follows those locked cells. Not a solid fan or triangle slice. If a GIF/sheet already passed eye QA, pass `accepted_path` and reuse it — do not GenerateImage a weaker sickle.
2. `xsxb_cutout` the white; `protected_colors` for those smear colors.
3. `xsxb_overlay_grid` then `xsxb_place_image` with cell anchors onto the committed-strike frames. `layer` `behind` or `front` on the weapon path; do not cover the face or the weapon. Scale and anchor in cells — do not convert canvas pixels. Do not pin mid-swing at the far end with a large scale or the crescent crops.
4. Timing follows the strike you read: wind-up none or faint; committed swing longest/solid; follow-through a remnant; idle none.
5. Replace-import, then `xsxb_export_gif` plus `xsxb_export_sheet`. GIF forward-play can hide a 7字 — inspect the sheet and split frames. Human inspect sheets pass `grid=false`.
6. Accept a continuous bow between the chord (locked start→locked end) and the smear band. Reject straight bars, triangular slices, 7字, overlap onto the weapon, and a cell-sized gap that floats the smear. Follow the weapon head, not the palm; keep visible width; obvious on the strike only.

Validated reference (example only, not a canned recipe for other attacks): 牛来 downward plunger chop, polyline D1→G3 then H8, 像素层 月牙, `layer` behind — `exports/niulai-plunger-mcp/niulai-chop-crescent-trail-v4.gif`, `exports/niulai-plunger-mcp/niulai-chop-crescent-trail-v4-sheet.png`. Intermediates in `exports/niulai-plunger-mcp/crescent-trail/`.

## Video Extraction and Frame Organization

Use the Frame Workset panel for local images, local video extraction, reordering, reduction, flipping, tagging, diagnostics, and animation replacement.

Video extraction:

- Decode the video locally in the browser; do not upload it.
- Select a start and end time and an extraction rate from 1–60 FPS.
- Keep a single extraction at or below 300 frames.
- If decoding fails, try a browser-compatible H.264 MP4 or WebM source.
- If memory use is excessive, shorten the clip, lower FPS, or reduce source resolution.
- Inspect extracted ordering and representative frames before applying the workset.

Frame workset operations:

- Include or exclude individual frames and invert selection.
- Reduce by keeping one frame per selected step.
- Restore source order.
- Horizontally flip selected frames.
- Import additional images or delete selected workset entries.
- Add human-readable frame tags.
- Diagnose isolated jump frames.
- Diagnose near-duplicate frames.
- Find candidate loop segments by endpoint similarity.

Diagnostics are suggestions, not automatic truth. Visually inspect flagged frames before deleting or excluding them.

Applying a workset:

1. Record original count, order, tuning, boxes, SFX, and attachments.
2. Confirm the final included frame order and transformed images.
3. Require explicit confirmation because Apply replaces the animation frame set.
4. Use the tuner Apply action so frame tuning, boxes, audio, and attachments are remapped together.
5. Confirm the resulting frame count and source-to-result mapping.
6. Inspect attack active frames, timing, reference frame, SFX, and attachment ownership after remapping.
7. Save, sync Godot, and run validation.

## Transform and Playback Tuning

The tuner supports Character, Group, and Frame transform layers.

- Tune uniform scale, X/Y scale, X/Y offset, and rotation at the intended layer.
- Keep broad actor sizing at Character level.
- Keep animation-specific alignment at Group level.
- Keep pose- or canvas-specific corrections at Frame level.
- Use the reference-frame overlay and black, white, transparent, or grid backgrounds for visual comparison.
- Preserve the same Character × Group × Frame × Scene transform semantics in tuner and Godot.
- Never use box offsets to correct sprite alignment.

Playback operations:

- Set group playback time or per-frame duration.
- Treat group time and per-frame duration overrides as alternative timing sources.
- Respect confirmations that clear the conflicting timing source.
- Disable intentionally unused frames without treating disabled state as a duration override.
- Preview the actual resulting cadence and action duration before saving.

## Boxes, SFX, and Image Attachments

Boxes:

- Tune hurtbox, hitbox, and collisionbox independently.
- Move a selected box by dragging its body.
- Reshape with the supported modifier and handles.
- Keep collisionbox grounded, unrotated, and conservative.
- Inspect representative poses and every materially different attack phase.

SFX:

- Bind local audio to the intended frame card.
- Preview the binding when browser playback is available.
- Confirm before deleting or replacing an existing binding.
- Preserve path-only bindings and stable frame keys across reload and Save.

Image attachments:

- Add local images to the intended owner frame.
- Use card order for above/below layer order.
- Copy or paste attachments only within the same project.
- Tune attachment local offset, scale, and rotation independently from the owner sprite.
- Inspect owner inheritance, facing, scene scale, and layer order in both preview and Godot.
- Keep attachments visual-only unless explicit gameplay-box support is added.

## Save, Synchronization, and Completion Evidence

Treat Save as the persistence and Godot synchronization boundary.

After every requested operation:

- Confirm no unsaved-edit indicator remains.
- Check `/api/config?project=<id>` for warnings.
- Confirm standalone and Godot-local manifests have the intended frame counts.
- Confirm frame-indexed visual, playback, box, SFX, and attachment data still targets the intended frames.
- Run `npm run check`, `npm test`, and strict project validation when project data or Godot synchronization changed.
- Report the initial and final frame counts, exported or replaced destinations, operations applied, warnings resolved, and any remaining artistic judgment.
