---
name: xsxb-frame-tuner
description: >-
  Operate the complete local XSXB Frame Tuner workflow for Godot frame animation:
  import or replace PNG/SpriteFrames animations, extract frames from local video,
  batch-remove image backgrounds, organize/reduce/flip/diagnose frame sets, tune
  Character/Group/Frame transforms, timing and hit/hurt/collision boxes, bind frame
  SFX and image attachments, sync the Godot runtime, and validate gameplay integration.
  Use for requests involving characters, animations/actions, cutout/background removal,
  video-to-frames, frame cleanup or ordering, duplicate/jump/loop detection, visual
  tuning, boxes, playback, SFX, attachments, scene scale, facing, Godot wiring, or
  phrases such as 添加角色, 批量添加动画, 新动作, 接入 XSXB, 帧动画调参, 批量抠图,
  去背景, 视频抽帧, 帧整理, 减帧, 重复帧, 跳变帧, 循环段, 水平翻转, 碰撞框, 音效, 附加帧.
---

# XSXB Frame Tuner

Deliver the complete user-visible result from a natural-language request. Do not require the user to run importer commands or enumerate internal data files.

## Required References

For every actor import, animation import, replacement, or gameplay wiring task, read all three references before editing:

- [references/import-contract.md](references/import-contract.md) for batch grouping, project isolation, anchors, initial scale, and box generation.
- [references/runtime-contract.md](references/runtime-contract.md) for gameplay wiring, playback, SFX, image attachments, scene scale, facing, and box transforms.
- [references/validation.md](references/validation.md) for completion gates and commands.

For batch cutout, video extraction, frame organization, visual tuning, playback editing, SFX, attachments, attack trails, or other existing tuner operations, read [references/media-and-tuning-workflows.md](references/media-and-tuning-workflows.md).

When modifying the tuner web UI, save payload, or direct-manipulation behavior, also read [references/ui-contract.md](references/ui-contract.md).

For the isolated Lite importer/exporter, preset storage, duration-driven trail sampling, or Lite audio export, read [references/lite-contract.md](references/lite-contract.md).

For character concept simplification, target-style conversion, pose transfer, action exploration, or green-screen idle generation, use the vendored [2DCS skill](../2dcs/SKILL.md) first, then continue with the XSXB media workflow. Read [references/character-generation-workflow.md](references/character-generation-workflow.md) before connecting generated images to cutout or animation import.

## Completion Contract

Treat a request such as “add these animation folders to this character” as authorization to complete the entire in-scope local integration. Unless the user explicitly asks for tuner-only import, success requires all of the following:

1. Import every requested animation into one correctly bound XSXB project and profile.
2. Copy every frame into stable tuner-local and Godot-local asset paths.
3. Save `hurtbox` and `collisionbox` for every actor frame; save `hitbox` for every attack-like frame entry with plausible active-frame enablement.
4. Visually inspect representative frames from every animation group and correct heuristic boxes that include weapons, VFX, tails, cloth, empty canvas, or alpha noise as body mass.
5. Generate or refresh the complete Godot runtime, including playback, boxes, SFX, image attachments, duration, facing, and scene-scale interfaces.
6. Connect at least one actual gameplay scene or gameplay actor to the generated runtime. The generated runtime test scene alone does not count.
7. Keep tuner preview, saved data, and Godot playback on the same Character/Group/Frame transform and timing data.
8. Run deterministic validation and relevant Godot checks. Treat warnings as incomplete work, not success.
9. Start the tuner only after import, sync, gameplay wiring, and validation succeed.

Do not silently downgrade to “frames copied” or “runtime generated.” Report a partial result only when a concrete blocker remains.

For media-processing or tuner-editing requests, complete the requested local workflow, save the result, resync the bound Godot project when one exists, and verify that frame counts and bindings remain consistent. Do not treat opening the relevant panel as completion.

## Locate the Tool

Resolve the XSXB Frame Tuner root in this order:

1. Use the current workspace when it contains `tools/animation_tuner/server.js`.
2. Use a tuner root explicitly supplied by the user.
3. Ask the user for the local tuner root when neither location is available.

Never hard-code personal machine paths. Store project bindings in `data/projects.json`, not in this skill.

## Resolve the Request

Infer safe inputs from the request and project before asking questions:

- target Godot project root
- new or existing XSXB profile
- one or many animation folders or `.spriteframes.tres` resources
- local image folders, image files, or video files used for cutout and frame organization
- animation IDs, labels, FPS, actor/VFX type, and replacement intent
- whether processed output should be exported separately or replace the current animation
- gameplay actor/scene that must consume the runtime

Ask only when guessing could bind the wrong Godot project, overwrite source or tuned animation data, or change gameplay semantics. Multiple animation paths in one message are one batch, not separate future tasks.

## Required Workflow

1. Inspect the Godot project, source folders, representative frames, existing XSXB registry, manifests, tuning, gameplay scenes/scripts, and tests.
2. Select or create one XSXB project bound to the exact target Godot root. Never reuse an ID bound to another project.
3. Select or create one profile for the character. Preserve existing profile and animation IDs when tuning already exists.
4. Import all requested groups:
   - Use `tools/import_batch.js` for two or more PNG folders.
   - Use `tools/import_frames.js` for one PNG folder.
   - Use `tools/import_spriteframes.js --all` for a Godot project or SpriteFrames batch.
5. Confirm imported group count, animation IDs, per-group frame counts, FPS, anchor modes, and game-local frame paths.
6. Perform per-group visual QA. Inspect at least one representative neutral/movement frame and every materially different attack/action phase. Correct saved boxes when the heuristic result is not playable.
7. Inspect source facing from an upright frame and set gameplay-facing behavior accordingly. Do not infer facing from filenames.
8. Wire the generated XSXB actor into actual gameplay. Route animation state, action duration, collision, hit/hurt queries, movement scale, SFX, and attachments through runtime interfaces.
9. Run `tools/validate_import.js` with `--require-gameplay --strict`, then run available Godot headless/smoke checks.
10. Start or reuse the tuner server. If already open, tell the user to refresh the animation list.

For cutout, video extraction, frame organization, or existing-project tuning without a new import:

1. Inspect the active XSXB project, target profile/group, current frame count, tuning, SFX, and attachments.
2. Start or reuse the local tuner and select the exact project and animation group.
3. Execute the requested workflow according to `media-and-tuning-workflows.md`, using browser operation when the feature is implemented only in the tuner UI.
4. Require explicit confirmation before replacing original frames, deleting frames, or applying a reorganized workset.
5. Save the tuner state and allow its normal Godot synchronization to complete.
6. Recheck frame counts, frame-indexed tuning, boxes, SFX, attachments, and validation warnings.

### Attachment Sequence Automation

For a main character attack animation plus an ordered attachment sequence such as slash effects, use this low-freedom workflow:

1. Inspect the exact project, profile, animation, frame count, existing attachments, and local attachment folder or asset-library selection.
2. Run `auto_align_attachments.js` in plan mode. Planning must not modify project JSON or copy external assets.
3. Read the generated summary and plan entries. Confirm natural filename order, target frame range, canvas compatibility, existing attachment preservation, and every proposed transform. Strict one-to-one mapping remains the default. For different sequence lengths, use explicit `--strategy resample` or `--strategy active`; both require visual review and never apply automatically.
4. When canvases are shared, identity transforms are the deterministic default. When the plan reports `requiresVisualReview`, inspect representative owner/effect pairs and edit only the proposed per-entry transform values needed for correct placement. Do not guess spatial alignment from filenames alone.
5. Show the user the mapping and visual-review summary. Obtain explicit confirmation before applying; the apply command must include `--confirm` only after that confirmation.
6. Apply the reviewed plan. If the CLI reports a revision conflict, stop and generate a fresh plan instead of bypassing the guard. Do not delete or replace existing attachments silently.
7. Run validate mode for the target animation. Require valid frame ownership, paths, finite transforms, positive scales, non-zero layer order, asset identity, and no duplicate plan instances.
8. Start or reuse the workbench, then use the signed-in Microsoft Edge Codex plugin for final rendered inspection. Correct only exceptional frames in the workbench, save, and validate again.

Do not use MCP for this local attachment workflow. The Core/CLI owns deterministic data operations; Codex owns orchestration and visual judgment; the browser plugin is reserved for rendered QA and exceptional-frame tuning.

## MCP 工程流程

MCP v0.2 回执的业务字段位于 `data`。`ok` 只表示工具调用完成；分别检查 `execution.effect`、`verification.status`、`observation` 和 `escalation`。使用观察结果重排帧或写入 A1 cell 时传回 `basis_snapshot_id`，静图 crop/place 必须传精确视图的 `overlay_id`。

素材感知固定为代码优先：先调用 `xsxb_detect_regions provider=code|auto`，使用 alpha、连通域、颜色、形状和时序证据。`auto` 只有在代码置信度不足或存在歧义时才尝试本地 Florence-2；模型不可用时查看候选 overlay，不得把未验证的 region 直接用于 mutation，也不得改用自由像素坐标。

连上 xsxb 之后，工具 playbook 之前先走这四步。不要一上来连打导入/抠图。

1. **开工先分析：** 用一句话写下用户要的结果，`xsxb_list_projects` / `xsxb_get_project` 看当前项目和动画，再选 playbook（走循环锁尺、视频成循环、静图 place、刀光 smear）。选错 playbook 比少调一个工具更糟。
2. **多步用 todo：** 把步骤写成有序列表（例如导入 → 抠图 → 看 `preview.path` → 种脚 → 导出）。做完一项勾掉再开下一项。
3. **完成一项就 check：** 每个会改盘的工具之后，打开图（`preview.path`、overlay、gif、`grid=false` 表），不要只看 `confirmed` / `keyed`。眼睛不过就停在这一项修，不要继续 playbook。
4. **缺能力就报：** 见下面 MCP Feedback。不要默默换工具链假装 MCP 已经覆盖。

## MCP Feedback

When using XSXB MCP: if a tool errors, a needed capability is missing, or you must leave MCP to finish the request, tell the user and raise it to the `XSXB-Frame-Tuner` project. Include tool name, arguments, receipt or error, expected result, and actual result. Do not silently work around a product gap as if the MCP already covers it.

Video-to-loop playbook (simple clip → one looping animation):

1. If the registry has no project, `xsxb_create_project`. Then `xsxb_import_animation` / `xsxb_import_video` the source clip (optional `start_time` / `duration` instead of offline ffmpeg).
2. `xsxb_cutout` (omit sliders for the shared smart profile) so loop search is not poisoned by a keyed background. Pass `basis_snapshot_id` from `xsxb_get_animation` / `xsxb_analyze`. Look at `preview.path` (magenta). A standing figure that already holds a weapon: `xsxb_place_image` stacks a second blade, it does not swap.
3. `xsxb_analyze` (one decode: duplicates, loop, motion, plus a `grid=false` preview sheet). Look at `preview.path` — do not `xsxb_export_sheet` every candidate. `oneShotLikely` means a short burst inside a longer clip; a solid interior cycle in a long take is not a one-shot. If `autoAdjustedThreshold` is set, do not apply `duplicates.order` unless you passed `auto_adjust`.
4. Look at the preview and `xsxb_reorganize_frames` with `loop.recommended.order` or `motion.order`, passing the analyze receipt's `observation.snapshotId` as `basis_snapshot_id`.
5. Keep character scale consistent: pick one clip as the template, `xsxb_estimate_visual` `reference_animation_id` + `apply`, then `xsxb_cutout apply_visual` with a shared canvas.
6. Finish with one `xsxb_export_gif` of the kept loop.

Read group coordinates from `xsxb_export_sheet` receipt `grid.cells[row][col]` (row 0 = top, col 0 = left; `x,y` is that square's top-left group corner). Overlay paints matching row/col indices; group numbers are in that JSON — **do not OCR**. Foot origin `0,0`, body is negative y; source animation PNGs stay unchanged. Grid lines follow `grid_density`. Yellow `0,0` is outside the bitmap (`canvasAnchor` `y=height`); last pixel row is group `y=-1` — do not plant soles to `0,0` or they clip 1px. Plant the sole to `y=-1`. `metrics.feetY` is the boot sole and ignores connected bright slash/glow below it; confirm on the overlay before planting. `xsxb_shift_frames` is already in the catalog (`MCP_TOOL_NAMES` / `tools/list`); if a client reports it not found, the session catalog is stale — reload the `xsxb` MCP server. Do not skip planting or convert overlay numbers to canvas pixels. `grid_divs` / `grid_density` already work on `xsxb_export_sheet` / `xsxb_cutout`. Walk-loop plant after measure with `xsxb_plant_feet` (translate only; lock height with `xsxb_register_clip`). Default target is `y=-1`, not `0,0`; still confirm on the overlay. Write tools accept overlay cell ids (`E5` / `e5` / `{cell:"E5"}`) on `xsxb_shift_frames` from/to, `xsxb_plant_feet` `to`, box min/max, attachment `hand`, and trail stick top/bottom — resolved from the frame PNG size plus `grid_divs` / `grid_density` / `grid_scope`; pass the observation's `snapshotId` back as `basis_snapshot_id`. If boots float above the last pixel after rematch, plant with `xsxb_plant_feet` or `xsxb_shift_frames` (positive `dy`); do not guess boot colors. Measure a weapon PNG with `xsxb_measure_image` (`t=0.5` middle of pommel→tip, `t=2/3` or `"2/3"` two-thirds toward the tip); `localFromCenter` is the grip relative to the image center, so attachment offset = hand − `localFromCenter`. Estimate standing scales with `xsxb_estimate_visual`, override with `xsxb_set_visual_transform` if needed, bake group/frame `visual_size` with `xsxb_cutout apply_visual`, and preview with `xsxb_export_gif` or `xsxb_export_sheet`. `xsxb_cutout` sliders (`tolerance`, `feather`, `protected_colors`, …) match the tuner workbench; omit them for the shared smart-cutout profile. Trim one-shot holds with `xsxb_find_motion`. Do not rematch or bake frames outside MCP.

Still-image overlay and place (agent is the eye; MCP does not call a VLM):

1. `xsxb_overlay_grid` on each PNG involved. Look at `overlay_path` and report only speakable cell ids (`A1`–`H8`). Do not OCR pixel boxes or x,y. Receipt `overlay_id` stamps that PNG+view — agent-led calls MUST pass it on `crop_from` and place anchors. If `next` is `crop_from`, overlay the contact cells before placing. Do not mix still `view` / `overlay_id` with animation `grid.cells`. No AX, VLM, or `[0,1000]`.
2. To refine, call `xsxb_overlay_grid` again with `crop_from: { parent_view, cells, padding_cells, overlay_id }`. Receipt `view` stays in original-image pixels; crop origin equals remapped A1; the new `overlay_id` is for the cropped view.
3. **图度自检（必做）：** after the user confirms a composite, call `xsxb_plan_place` with `intent`, `read` (contact on both images + optional cells), `physics`, `accept`, and a 3–5 step `plan`. Execute `receipt.brief`. If `receipt.next` is `await_user` or the user asked for plan-first, stop and show the brief. Named contact cells default to `snap: "alpha_centroid"` — never freehand `x,y`.
4. `xsxb_place_image` with `target_anchor` / `object_anchor` (named cells default `alpha_centroid` when `derive` is omitted; pass `overlay_id`; optional `nudge` `{dx,dy}` or `alpha_*`) and `scale` `relative` or `physical` from the selected span. Pass optional `plan_id` from the brief. Receipt `resolved` is MCP pixels (debug only); inspect `verify.status` and `verify_overlay_path`. Never freehand `x,y`. `layer` `under_target` puts the object under opaque pixels inside the target cell union; `behind` restores every opaque target pixel; omit for `front`. `rotation` is clockwise degrees around the object anchor (screen y-down) from the pose you see. The tool composites only — it does not redraw either sprite. Inspect `verify_overlay_path` against the accept criteria.
5. `xsxb_measure_image` `anchor=alpha_bottom` returns the same opaque-foot geometry.
6. `xsxb_cutout` `file_path` runs the same smart-cutout on one workspace PNG.

Attack-trail sickle (像素层, not Hermite mesh):

Look at **this** animation's frames (sheet / `xsxb_overlay_grid`) and **trace the striking-mass** (weapon head) cell to cell. The smear arc is that observed motion — do not pick a canned chop or 上挑 recipe. A clip like 牛来's plunger that travels overhead then down reads as a downward sickle; a clip whose head scoops upward reads as 上挑. Same playbook.

The generic playbook is only the **skeleton**. Before painting, call `xsxb_plan_smear` with the motion you actually read, `path_kind` `polyline` or `smooth_arc`, sampled color, and per-frame start/end/head cells. `receipt.brief` is the clip-specific prompt — execute that brief. Do not jump from the skeleton to GenerateImage.

Use `xsxb_add_attack_trail` only when that traced path is already a smooth arc that matches the smear you want. Mesh `color` is the striking mass or a user-named hex — do not hardcode red. If what you traced is a polyline that should still read as a sickle (牛来 chop across then down, e.g. D1→G3 then H8, is one case; an 上挑 clip can fail the same way) — do **not** bind Hermite sticks. That mesh always reads as a 7字折杆, a diagonal slice, or a column plus hook. `tangentStrength`, `reverseDirection`, or extra mid sticks only swap 不够弯 and 7字.

Paint the 拖影 as a 像素层 月牙/镰刀 along the traced path:

0. **Lock per-frame start and end cells first** (via `xsxb_plan_smear`). Start = where this smear begins (the far cell already swept). End = on the leading/outer side of the current striking face — do not pin the head on the striking-mass cell (that paints the ribbon onto the cup/shaft). Keep the band tight: `layer` `behind` so opaque weapon pixels punch through (hairline readable cup). Reject a full-grid-cell void. The smear occupies the front half of the weapon (striking-mass side), not the grip, not overlapping the weapon sprite, and not farther ahead than this frame's cup has reached.
1. Take smear color from the striking mass or the named hex — do not hardcode red. Generate a hollow sickle ribbon on pure white (pixel art; no character, no text) that follows those locked cells. Not a solid fan or triangle slice. If a GIF/sheet already passed eye QA, pass `accepted_path` and reuse it — do not GenerateImage a weaker sickle.
2. `xsxb_cutout` the white; `protected_colors` for those smear colors.
3. `xsxb_overlay_grid` then `xsxb_place_image` with cell anchors onto committed-strike frames. `layer` `behind` on the weapon path; do not cover the face or the weapon. Scale/anchor in cells — do not convert canvas pixels. Do not pin mid-swing at the far end with a large scale (crops).
4. Timing follows the strike you read: wind-up none or faint; committed swing longest/solid; follow-through a remnant; idle none.
5. Replace-import, `xsxb_export_gif`, and `xsxb_export_sheet`. GIF forward-play can hide a 7字 — inspect the sheet and the frames. Human inspect sheets pass `grid=false`.
6. Accept a continuous bow between the chord (locked start→locked end) and the smear band. Reject straight bars, triangular slices, 7字, overlap onto the weapon, and a cell-sized gap that floats the smear. Follow the weapon head, not the palm; keep visible width; obvious on the strike only.

Validated reference (example only, not a canned recipe for other attacks): 牛来 downward plunger chop, polyline D1→G3 then H8, 像素层 月牙, `layer` behind — `exports/niulai-plunger-mcp/niulai-chop-crescent-trail-v4.gif`, `exports/niulai-plunger-mcp/niulai-chop-crescent-trail-v4-sheet.png`.

## Agent-Facing Commands

Run commands from the resolved tuner root. For several PNG groups, place global options before the first `--animation` block:

```powershell
node "<tuner_root>\tools\import_batch.js" --project-root "<godot_project_root>" --project <xsxb_project_id> --profile <profile_id> --label "<character_label>" --replace `
  --animation idle --source "<idle_png_folder>" --fps 12 `
  --animation run --source "<run_png_folder>" --fps 12 `
  --animation stand_attack --source "<attack_png_folder>" --fps 12
```

For one PNG group:

```powershell
node "<tuner_root>\tools\import_frames.js" --project <xsxb_project_id> --project-root "<godot_project_root>" --profile <profile_id> --animation <animation_id> --source "<png_folder>" --fps <fps> --replace
```

For SpriteFrames:

```powershell
node "<tuner_root>\tools\import_spriteframes.js" --project-root "<godot_project_root>" --project <xsxb_project_id> --all
```

Plan an attachment sequence from a local PNG folder (frame ranges are one-based):

```bash
node "<tuner_root>/tools/auto_align_attachments.js" \
  --project <xsxb_project_id> \
  --profile <profile_id> \
  --animation <animation_id> \
  --assets "<attachment_png_folder>" \
  --frames <all_or_range> \
  --plan "<review_plan.json>"
```

For a longer VFX sequence mapped onto a reviewed active-frame range, request Alpha-activity sampling and spatial proposals explicitly:

```bash
node "<tuner_root>/tools/auto_align_attachments.js" \
  --project <xsxb_project_id> \
  --profile <profile_id> \
  --animation <animation_id> \
  --assets "<attachment_png_folder>" \
  --frames <active_range> \
  --strategy active \
  --spatial auto \
  --direction <auto|left|right> \
  --plan "<review_plan.json>"
```

`active` trims low-Alpha tails and samples representative effect phases. `resample` preserves the full source endpoints. `spatial auto` uses robust owner-body and effect Alpha bounds to propose scale and offset; it always sets `requiresVisualReview`.

After reviewing the plan and receiving explicit user confirmation:

```bash
node "<tuner_root>/tools/auto_align_attachments.js" --apply "<review_plan.json>" --confirm
node "<tuner_root>/tools/auto_align_attachments.js" \
  --project <xsxb_project_id> \
  --profile <profile_id> \
  --animation <animation_id> \
  --validate
```

Use `--assets group`, `--assets group:<profile>/<animation>`, or `--assets ids:<id1>,<id2>` when the images are already in the local attachment asset library. Reapplying an already completed plan must return `already_applied` without creating another instance.

Validate the complete integration:

```powershell
node "<tuner_root>\tools\validate_import.js" --project <xsxb_project_id> --project-root "<godot_project_root>" --require-gameplay --strict
```

Start the tuner:

```powershell
$env:PORT="5179"; node "<tuner_root>\tools\animation_tuner\server.js"
```

## Tuner Operation Boundary

- Prefer importer, synchronization, organizer, and validation scripts for deterministic file operations.
- Use the local tuner UI for batch cutout, local video decoding, visual frame selection, attachment direct manipulation, and other browser-only interactions.
- When browser operation is available, inspect the rendered result instead of inferring success from UI state or API responses.
- Keep raw images and videos local. Do not upload them to a remote service unless the user explicitly requests a cloud workflow.
- Never replace frames or apply a destructive workset without explicit replace/apply intent.
- After any frame-order or frame-count change, verify that tuning, boxes, SFX, and attachments were remapped to the intended source frames.

## Non-Negotiable Data Rules

- Keep every Godot project isolated by exact project root.
- Keep source assets in stable folders; never leave runtime paths pointing to Downloads or temp directories.
- Preserve tuned data when adding a new animation. Remove stale animation-prefixed overrides only when replacing that whole animation.
- Preserve original media when the user asks only for preview, diagnosis, or exported processed copies.
- Use `canvas_bottom_center` for grounded actors unless the existing project intentionally uses another authored anchor.
- Keep collision, hit, and hurt boxes as local gameplay data. Never use box offsets to position the sprite.
- Apply Character, Group, Frame, facing, and scene scale to visuals and boxes through the same outer transform.
- Keep frame SFX and image-attachment support present even when their binding files are empty at import time.
- Keep action timing derived from XSXB playback data; fixed timing constants are fallback-only.

## Validation Summary

Before reporting success, verify at minimum:

- requested animation count and total frame count match the sources
- standalone and game-local manifests match by profile, animation, and frame count
- every actor frame has valid saved hurtbox and collisionbox data
- every attack-like frame entry has saved hitbox data and visually plausible active frames
- tuner and runtime scale boxes proportionally at Character, Group, Frame, and scene levels
- game-local audio and attachment bindings use stable `<profile>/<animation>:<frame>` keys and `res://` assets
- runtime plays SFX once per frame entry and can replay it on later loop visits
- image attachments inherit owner transform, facing, scene scale, and layer order
- gameplay uses runtime animation duration, scene scale, collisionbox, hitbox, and hurtbox interfaces where applicable
- an actual gameplay scene uses the generated actor
- `/api/config?project=<id>` and `validate_import.js --strict` report no warnings
- requested cutout, extraction, organization, or tuning results are visibly inspected when those workflows were used
- destructive frame changes preserve the intended frame order and remap frame-indexed data correctly

If Godot cannot run, state exactly which runtime checks remain unverified.

## Final Response

Report:

- affected profile, animation IDs, before/after per-group counts, and total frame count
- media operations performed, including cutout, video extraction, reordering, reduction, flipping, or diagnostics
- tuner-local and Godot-local destinations
- manifest, tuning, runtime, SFX, attachment, and gameplay files changed
- deterministic and Godot validation that passed
- any remaining manual artistic box tuning

Do not present internal scripts as work the user still needs to perform.
