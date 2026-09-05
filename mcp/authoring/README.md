# Authoring tools

新增 9 个工具，加上增强后的 `xsxb_cutout`，覆盖六类日常制作能力。实现集中在本目录，公开入口仍为 `callMcp` / JSON-RPC `tools/call`。

## 版本与撤销

- `xsxb_save_revision {project_id?, label?}`：保存当前项目的 PNG、创作清单、时序、碰撞框、音效、附件资产与拖尾数据。
- `xsxb_list_revisions {project_id?}`：列出手动和自动恢复点。
- `xsxb_compare_revisions {revision_id, other_revision_id?}`：省略第二个 id 时与当前状态比较，返回文件差异和 PNG 左前／右后的对比图。
- `xsxb_restore_revision {revision_id, dry_run:false}`：应用恢复。省略 `dry_run` 默认只预览。
- `xsxb_undo {dry_run:false}`：恢复最新的恢复点；也可指定 `revision_id`。

常用公开修改操作在执行前自动保存项目恢复点，成功回执的 `data.revisionId` 给出该 id。没有改变文件的失败操作会清理其自动恢复点。恢复之前会再保存一个安全版本，所以撤销一次恢复相当于重做。兼容内部 `service.call` 路径不自动创建恢复点，应用客户端应使用公开 MCP 入口。

恢复点位于项目 data 目录下的 `revisions/`，不包含自身、预览缓存、注册表、Godot 绑定或生成的 Godot 运行文件。恢复后可显式 `sync:true` 同步到当前绑定目标。

对于 `in_place` 动画，恢复点会保存外部源 PNG，但恢复这些外部文件必须显式 `restore_external:true`。缺失 PNG 可从恢复点补回；损坏的快照 blob 会在任何恢复写入前拒绝。恢复点当前不会自动淘汰，请按实际使用量管理磁盘空间。

## 动画管理

`xsxb_manage_animation` 默认只预览；`dry_run:false` 应用并创建恢复点。同一 profile 内支持：

```json
{ "action": "copy", "animation_id": "walk", "target_animation_id": "walk_variant", "dry_run": false }
```

```json
{
  "action": "split",
  "animation_id": "attack",
  "segments": [
    { "animation_id": "windup", "start_frame": 0, "end_frame": 3 },
    { "animation_id": "recover", "start_frame": 4, "end_frame": 9 }
  ],
  "dry_run": false
}
```

```json
{
  "action": "merge",
  "animation_id": "windup",
  "source_animation_ids": ["windup", "recover"],
  "target_animation_id": "attack_joined",
  "fps": 24,
  "dry_run": false
}
```

```json
{ "action": "rename", "animation_id": "walk_variant", "target_animation_id": "run", "dry_run": false }
```

复制、拆分、合并保留来源动画。重命名迁移所有权并移除不再引用的旧工作区帧，恢复点保留其原始字节。目标 id 冲突会拒绝；重命名可以再改回原 id。

时序、碰撞框、视觉覆写、音效、附件和拖尾都按新帧号映射；合并时按目标 FPS 换算 duration 以保持实际播放时长。源动画需要一致的原点、翻转和 group 视觉设置，否则先校准／烘焙再合并。单次最多 100 个目标，每个动画最多 5000 帧。

## 指定帧抠图

`xsxb_cutout` 现在接受 `frames:[3,7]` 或包含两端的 `start_frame` / `end_frame`，两种选法不能混用。未选中的 PNG 和时序保持不变。

```json
{
  "animation_id": "walk",
  "frames": [3, 7],
  "basis_snapshot_id": "从 get_animation 获取",
  "key_mode": "border_flood",
  "key_color": "#ffffff",
  "force": true
}
```

既有快照新鲜度校验继续生效。所有选中 PNG 先在临时目录完成处理，再和尺寸清单一起提交；准备或提交失败会清理暂存或恢复。局部处理不允许 `apply_visual:true`，因为部分烘焙后重置整个 group 会影响其他帧。独立 PNG 模式不接受帧范围。

## 画布与边距

`xsxb_resize_canvas` 支持 `mode:pad`（指定 `width` / `height`）和 `mode:trim`（共享主体范围，可带 `padding`），可选择帧范围，默认预览。

- 不缩放、不重采样源像素。
- 默认 `preserve_origin:true`，保持脚底 group 原点；精确对齐要求画布宽度奇偶性兼容。
- `preserve_origin:false` 的紧凑裁边会同时移动碰撞框、附件和拖尾坐标，使它们继续对齐像素。
- 裁掉可见像素默认拒绝，只有明确设置 `allow_clip:true` 才允许。
- 对完全透明的选区拒绝自动 trim；可用 pad 指定尺寸。

## 跨帧质检

`xsxb_check_animation` 不修改 PNG，返回每帧测量与异常列表，以及使用共同缩放比例的品红证据图。图上标注实际帧号。

检测项：空帧、主体尺寸跳变、脚底漂移、中心漂移、封闭透明孔洞、亮色边缘、可见像素触及画布边缘。阈值可通过 `size_tolerance`、`feet_tolerance`、`center_tolerance`、`min_hole_pixels`、`white_edge_ratio` 调整。

这些是疑似异常：白毛、眼镜孔、跳跃或故意铺满画布都可能触发。工具不会把几何检查当成视觉验收，也不会自动修图。

## 附件关键帧插值

先通过 `xsxb_add_attachment` 绑定 PNG，再调用：

```json
{
  "animation_id": "attack",
  "id": "weapon",
  "interpolation": "smooth",
  "keyframes": [
    { "frame": 0, "offset_x": -10, "offset_y": -80, "rotation": 0, "layer": "below" },
    { "frame": 8, "offset_x": 15, "offset_y": -70, "rotation": 1.2, "layer": "above" }
  ],
  "dry_run": false
}
```

- 插值区间包含两端，区间外绑定不受影响；坐标为 group 空间，角度单位为弧度。
- `linear` 线性、`smooth` 平滑起止、`hold` 保持前一个关键帧。
- 角度默认走最短路径；`rotation_path:direct` 可表达整圈旋转。
- 原样保留关键帧值，遮挡层只在关键帧处切换。
- `replace:false` 会拒绝覆盖已有绑定；默认替换同 id 的区间内绑定。
- 不跟踪手部、不推断握持或遮挡；应用后用 `xsxb_export_gif` / `xsxb_export_sheet` 检查合成效果。

## 验证

`npm run check` 自动发现本目录源码与测试。`xsxb_mcp_authoring.test.js` 覆盖公开调用、字段和字节保留、故障恢复、外部文件保护、插值端点及画布规则；全部新增工具也进入公开 JSON-RPC 可用性审计。

多文件事务保护可捕获的运行异常，不提供跨进程并发事务或断电恢复保证。
