---
name: x-frame-import
description: >-
  Import local PNG sequences, sprite sheets, or video into an XSXB project.
  Use when the user adds idle/walk/attack folders, extracts a clip, or binds a
  Godot root. Import and sync are not a visual pass.
---

# x-frame import

State the user goal in one sentence. `xsxb_list_projects` or `xsxb_get_project`. Create or bind only when the registry has no matching project.

1. `xsxb_create_project` when needed. `xsxb_bind_godot` before any sync.
2. `xsxb_import_animation` (PNG folder, `in_place` if sources stay put) or `xsxb_import_video` / `xsxb_slice_sheet`.
3. `xsxb_get_animation` and open a frame or sheet. Frame count matching the folder is not “the character looks right.”
4. Prefer `xsxb_analyze` after import. Do not `xsxb_export_sheet` every candidate.
5. Reorder with `xsxb_reorganize_frames` and the analyze `basis_snapshot_id`.

Then hand off to `skills/x-frame-cutout` or `skills/x-frame-gameplay`. Do not call import or `xsxb_sync_godot` a visual pass.
