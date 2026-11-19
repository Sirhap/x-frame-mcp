---
name: xsxb-frame-tuner
description: 使用 x-frame MCP 处理本地 PNG、视频或 Godot SpriteFrames，编辑帧动画、挂武器、制作刀光拖影和大月牙斩、校准步态、导出预览，或将动画同步到指定 Godot 项目。
---

# XSXB Frame Tuner

## MCP 工程流程

先从当前客户端的 `tools/list` 查 `xsxb_*` 工具及参数。独立 MCP 可以直接处理本地素材。下面的项目编辑示例假定已选中目标动画；跨项目或同名动作要显式传 `project_id`、`profile_id`、`animation_id`。工具索引从 0 开始，范围包含结束帧。例如“第 4 帧”通常对应索引 3；用户给的是编辑器索引时直接沿用。

| 用户手里的素材或目标 | 入口与交付 |
| --- | --- |
| 已有视频、PNG、PNG 目录、SpriteFrames 或有序图片，需要检查、分析、翻转或抠图 | 直接用 `xsxb_edit_target`，通过 `file_path`、`directory` 或 `items` 指定素材。`operation:"inspect"` 和 `"analyze"` 只读；翻转和抠图默认预演，按请求写入时传 `dry_run:false`。单张 PNG 的尺寸在 `data.animations[0].frames[0]` 的 `width`、`height`。应用批量 PNG 编辑会写回源文件。 |
| 保存一个可继续编辑的动画、调时序、碰撞框、音效或挂件 | 用 `xsxb_list_projects` / `xsxb_get_project` 定位项目，缺项目时用 `xsxb_create_project`。用 `xsxb_import_animation` 导入，用 `xsxb_get_animation` 核对帧数、动画 ID 和已有绑定。只有要覆盖同名动作时传 `replace:true`。 |
| 走路循环、脚底漂移 | 先 `xsxb_measure_frames` 量脚底和身高。缩放用 `xsxb_register_clip`，纯平移用 `xsxb_plant_feet`，最后一行像素是组坐标 `y=-1`。先看预演，再用叠图核对应用结果。 |
| 静图上合成武器或道具 | 用 `xsxb_overlay_grid` 取得两张图的视图和格子，`xsxb_plan_place` 做图度，再 `xsxb_place_image`。沿用对应视图的 `overlay_id`，查看合成图和遮挡验证图。动画逐帧持武器用 `xsxb_add_attachment`。 |
| 用户要求同步到游戏、接入实际角色 | 确认目标目录含 `project.godot`，绑定后用 `xsxb_sync_godot`，或在支持的编辑调用上传 `sync:true`。仅在任务涉及实战接线时检查游戏场景、碰撞、时序和播放。 |

## 刀光和拖影

制作新攻击先看去掉特效的起势、加速、命中和收招。按握点绑定武器，让肩、手、剑尖的运动交代出一条剑路，再用 `weapon_motion` 从实际姿势取样。新刀光默认保留命中前最后一次同向挥动；需要更利落的快斩时可单独缩短该击的 `trail_duration_ms`。三连击用一次 `xsxb_add_attack_trail`，把实际挥击区间按顺序放入 `hits`。回执直接附上各击结束帧的 PNG，角标是动画帧索引。

```json
{"brush_preset":"weapon_motion","hits":[{"start_frame":3,"end_frame":7},{"start_frame":11,"end_frame":17},{"start_frame":21,"end_frame":27}]}
```

做新刀光或检查弧线违和时，打开[横斩、上挑、下劈和回旋的参考图](references/attack-trails/gallery.md)，选与当前挥动平面接近的一张，对照刀刃前缘、细尾和遮挡。逐帧位置与时序以当前动作实测为准。

**弧光的验收标准**

1. **方向与动作一致。** 横扫看腰线附近的扁弧，上挑看低处的细尾和高处的刀锋，下劈看高处的细尾和低处的刀锋。直刺允许近直线；回旋要有转身姿势和前后遮挡。根据实际挥动平面选轮廓。
2. **先读得出人，再读得出弧。** 原速看预备、加速、承重、收招；逐帧看手是否握住同一位置。剑尖在相邻挥动姿势间应连续沿同一侧推进；突跳先改武器或人物姿势。若手臂和剑的方向无法配合，要换或补姿势。
3. **新旧位置有主次。** 主弧前缘接当帧的外刃，保留清楚的刀尖，越靠旧位置越窄。单击中意外出现折角、第二个鼓包、刀光盖住脸或穿过握手，都需要回看。根据视角安排人物与拖影的遮挡；需要前后两层的回旋可用分层像素素材。
4. **验整击。** 用相同倍率并排检查无特效、带特效的中段与命中帧，再按实际时长播放 GIF。蓄力不能提前亮出完整大弧，收招应干净。在原生画布检查完整刀尖、弧顶和尾尖是否有留白，尤其是低位重劈。读 `arcReview.sweepDegrees` 和 `swingMs` 了解实际挥过的角度和用时；`reversalFrames` 指出可能该拆击的位置。角度属于动作描述，视觉验收看实际画面。

调整某刀时，从 `data.hits` 取回它的 `id`，单独传这个 `id` 和新首尾帧。已有工程会沿用已有刀光 ID。只改一端且匹配唯一时，工具也能自动找到原来的刀。

- **用户明确指定固定剪影**时，按命中帧轮廓选 `pixel_cross`（扁长横斩）、`pixel_overhead`（头顶弧斩）或 `pixel_spin`（绕身回旋，中心留空）。每击填起止帧即可。默认粉色，`color` 可改色，`pixel_facing:"left"` 可镜像。已有刀光要换形状时传原 `id`。

  ```json
  {"hits":[{"start_frame":3,"end_frame":7,"brush_preset":"pixel_cross"},{"start_frame":11,"end_frame":17,"brush_preset":"pixel_overhead"},{"start_frame":21,"end_frame":27,"brush_preset":"pixel_spin"}]}
  ```

- **角色前方整个月牙**，包括白芯、橙边、两端尖的参考图：用 `xsxb_add_attack_trail`。结束帧是月牙完全展开的一帧。例子向右鼓出，上挑加 `crescent_direction:"up"`，朝左加 `crescent_facing:"left"`。

  ```json
  {"brush_preset":"crescent","start_frame":3,"end_frame":7,"crescent_fit":"shrink"}
  ```

  `shrink` 在命中帧空间不足时缩小；有意让刀光出画时用 `keep`。调大小用 `crescent_scale`。执行回执的 `data.previewCall` 看命中帧，两尖、亮芯和人物遮挡都合适后，用 GIF 看起落时机。
- **一笔贴着已绑定的剑锋走**：两端只有一个共同挂件时直接给首尾帧；多个候选时从错误回执 `error.details.attachment_ids` 选中武器，再传 `attachment_id`。下面的红色来自示例需求；用 `color` 指定实际需要的笔刷颜色。工具根据武器姿势拟合曲线，保存首尾两个控制姿势；改过武器姿势后用相同区间重建。

  ```json
  {"attachment_id":"sword","start_frame":3,"end_frame":7,"color":"#ff0000"}
  ```

- **武器已画进人物帧**：连续笔刷用同一工具的 `sticks` 手动标起止两帧；`top` 指刀尖，`bottom` 指刃内缘。需要按时间淡出的扫掠面时选 `render_mode:"sweep"`，至少在两个不同帧上标记同层的刀刃。
- **用户要手绘像素层**：用 `xsxb_plan_smear` 根据观察到的运动生成绘制说明，读取 `data.brief`。逐帧绘制和遮挡的细节见[媒体与调参流程](references/media-and-tuning-workflows.md#mcp-attack-sickle-trail-pixel-layer)。

## 读回执和验收

公开 MCP 的结果在 `structuredContent`。业务字段在 `data`；抠图时看 `data.preview.path`，导出 GIF 时看 `data.outputPath`。观察后重排、对动画抠图或按格子写入时，把对应观察的 `observation.snapshotId` 作为 `basis_snapshot_id`。收到过期错误时重新观察素材。多步骤任务可用 todo 跟踪。

预览按实际用途检查：命中形状看 `xsxb_export_sheet` 的 `grid:false` 帧图，节奏看 `xsxb_export_gif`，游戏表现看目标场景实际播放。交付时给出产物路径、检查到的结果和仍需实机确认的部分。

## 按需参考

- [媒体与调参流程](references/media-and-tuning-workflows.md)：循环、坐标、遮挡、手绘残像和完整工作台的专项操作。
- [导入约定](references/import-contract.md)：批量动作分组、锚点、替换已调动作；附完整工作台的 CLI 示例。
- [运行时约定](references/runtime-contract.md)与[验证项目](references/validation.md)：用户要求 Godot 游戏接线时，按实际功能选取检查。
- [角色素材生成](references/character-generation-workflow.md)：将生成的姿势或动作帧接入 XSXB。
- [完整工作台 UI](references/ui-contract.md)与[Lite 编辑器](references/lite-contract.md)：仅在使用对应产品时查阅。
