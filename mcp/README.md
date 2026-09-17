# XSXB MCP

本目录是 **x-frame-mcp** 的实现与安装入口。此仓库从 X-Frame 抽出 MCP 层，独立运行；Tuner 网页仍在原项目。

## v0.2 回执与代码优先感知

- 所有 MCP 工具通过 `structuredContent` 返回统一 v2 envelope；业务结果位于 `data`，`execution` 与 `verification` 分离。
- `ok: true` 只表示工具调用完成，不表示视觉或用户目标已经达成。
- `xsxb_detect_regions` 先运行 alpha、连通域、颜色、形状和时序代码；`provider=auto` 只在代码证据不足时尝试 Florence-2。
- `xsxb_detect_regions` 的每个候选都带 `{region_id,basis_snapshot_id}`。这个内容寻址引用可直接交给 `xsxb_place_image` 的 anchor/occlusion，或 `xsxb_add_attachment.hand`；源图改变、引用到另一张图或快照不一致都会拒绝，不会退回到手填像素。
- `targetStatus` 按请求目标分别报告 `geometry` 和 `semantic`。任意一个模型标签不会再把未确认的手、武器、特效或文字标成完成。
- 静图挂武器优先用 `xsxb_place_image` 的 `layer: "under_target"` 加目标手部 region：武器保留在人物上方，只有检测出的手部像素遮住剑柄。`behind` 仍表示整个人物遮挡。
- `xsxb_add_attachment` 用 `hand` + `t` 时会计入 attachment 的 `scale` 和 `rotation`；`xsxb_add_attack_trail render_mode:"sweep"` 用至少两帧明确 blade-edge sticks 在 MCP 的 GIF/sheet 导出中烘焙时间衰减拖影。Godot/Tuner 对该模式仍使用现有 mesh 路径。
- Florence 是可选兜底：`npm run mcp:perception:install` 显式安装原生 Transformers 版 `florence-community/Florence-2-base-ft`，`npm run mcp:perception:doctor` 检查。模型提交与 safetensors 哈希固定；普通安装和 MCP 启动不会下载模型或执行远程代码。
- `xsxb_reorganize_frames order=...` 和 A1 cell 派生写入必须传观察回执中的 `basis_snapshot_id`；动画 `xsxb_cutout` 经 MCP 同样要带快照，成功后回执是抠完后的新 id。静图 crop/place 必须传对应 `overlay_id`。
- `xsxb_detect_regions` 的 `output_path` 不得指向源 PNG。

- `xsxb_mcp_server.js`：JSON-RPC 传输与 `initialize.instructions`
- `xsxb_mcp_service.js`：工具实现
- `lib/`：MCP 运行所需的业务/算法副本（抠图、工程、Godot 同步等），不再 `require` 仓库其余部分
  改 MCP 能力时改本目录。`../tools/xsxb_mcp_*.js` 只是兼容转发，不要把逻辑写回 `tools/`。算法在 `lib/`。改 `MCP_TOOL_NAMES` 后必须在 Cursor MCP 面板重载 `x-frame`，否则会话还是旧目录。

## 谁能读到什么

| 读者                  | 能自动看到                                                      | 需要自己打开                       |
| --------------------- | --------------------------------------------------------------- | ---------------------------------- |
| 已接入本 MCP 的 Agent | `initialize.instructions`、`tools/list`、每次 `tools/call` 回执 | 本 README、skill                   |
| 人                    | 无（多数客户端不展示 `instructions`）                           | 本 README、示例配置、主仓库 README |

别人克隆本仓库后，读本目录即可接入。他们读不到你本机 `~/.cursor/mcp.json`，也读不到你的 Godot 路径和项目数据。

## 接入 Cursor

1. 仓库根目录需要能跑 `node`。抠图 / 视频抽帧还需要本机 `ffmpeg`。
2. 把 [`cursor.mcp.example.json`](cursor.mcp.example.json) 合并进 Cursor 的 MCP 配置。
3. 重启 Cursor MCP，或在 MCP 面板重载 `x-frame`。
4. 用 `xsxb_list_projects` 确认服务已起来。

不要把 Cursor 的 `args` 指到 `tools/xsxb_mcp_server.js` 再指望旧 shim 自己起来：那个文件以前只 `module.exports = require(...)`，当主进程跑时 **不会** 调用 `startServer()`，进程立刻退出，客户端看到 `MCP error -32000: Connection closed`。现在 shim 在 `require.main === module` 时会启动，但配置仍应指向 `mcp/xsxb_mcp_server.js`。

Cursor 配置可以放在：

- 用户级 `~/.cursor/mcp.json`
- 打开了本仓库时的项目级 `.cursor/mcp.json`

Cursor **不会**展开 `${workspaceFolder}`。`args` 必须是指向 `mcp/xsxb_mcp_server.js` 的**绝对路径**，否则会去加载字面量 `${workspaceFolder}/...` 并循环报 MODULE_NOT_FOUND。

把下面的路径换成你本机的 **x-frame-mcp** 根目录。若要读写已有 Tuner 项目，再设 `XSXB_ROOT`：

```json
{
  "mcpServers": {
    "x-frame": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/x-frame-mcp/mcp/xsxb_mcp_server.js"],
      "env": {
        "XSXB_ROOT": "/absolute/path/to/X-Frame"
      }
    }
  }
}
```

省略 `XSXB_ROOT` 时，作者文件写在**当前工作目录**的 `.x-frame/`（和 AI 平时操作的项目目录一致，不必是 Godot）。`xsxb_create_project` 带 `project_root` 时，写到那个目录的 `.x-frame/`。创作位置由注册表的 `authoringRoot` 保持稳定；`xsxb_bind_godot` 只更新 Godot 同步目标，不移动已有动画或切换创作目录。旧记录沿用原来的存储位置。

命令行自检：

```bash
npm run mcp:start
```

## Agent 规则（人也应知道）

服务在 `initialize` 里下发同一段说明，大意是：

- **工程流程：** 开工先用一句话写下用户目标，再 `list`/`get` 选 playbook；多步用有序 todo；每步改盘后打开图（`preview.path` / overlay / gif）再勾掉，`confirmed` 不算完成；眼睛不过就停，不要接着走 playbook
- 改数据前先 `xsxb_list_projects` 或 `xsxb_get_project`。没有项目时用 `xsxb_create_project`（`project_id` / `label` / `project_root` 均可选；已存在的 id 不重复建）。默认落在当前目录 `.x-frame/`；带 `project_root` 时落在那个目录的 `.x-frame/`
- 同步前先 `xsxb_bind_godot`
- 导入用 `xsxb_import_animation`（支持 `start_frame` / `end_frame` / `replace` / `in_place` / `animation_type`）；`xsxb_import_video` 只是视频别名，可另传 `start_time` / `duration`（ffmpeg `-ss`/`-t` 放在 `-i` 后；省略则抽整段）。`animation_type=vfx|prop` 会跳过待机脚底合同。`in_place: true` 让 PNG 序列继续用源文件，不拷进 `workspace/assets`
- 切表用 `xsxb_slice_sheet`（packed sprite/contact sheet → PNG 序列）。走循环锁高锁脚仍用 `xsxb_measure_frames` / `xsxb_register_clip`，不要用切表当锁尺
- 走循环锁尺：`xsxb_measure_frames`（相对待机看 `dBbox` / `dCx` / `dFx`）→ `xsxb_register_clip`（绕脚锁高锁脚锁左右，`equalize` 抹镜头远近，`shared_scale` 留姿势起伏）→ `xsxb_export_sheet normalize=feet|none` 和 `xsxb_export_overlay`（红/青叠）验收 → `xsxb_export_gif`（默认品红底，`output_path` 可出 XSXB 根）或 `xsxb_export_pack_slot` 拷进游戏仓。走循环不要用刀光 / `place_image`
- 抠图用 `xsxb_cutout`（默认 `fit=none`、`receipt=short`；生成白底或黑底用 `key_mode=border_flood`；看回执 `preview.path` 洋红扁平成图，不要用默认种脚小格子表当「人还在」；网页同一套智能抠图和滑块；可传 `tolerance` / `feather` / `protected_colors` 等，省略则用共用智能档；已抠帧默认跳过，除非 `force`；回执带 `bodyHeight` / `nearWhite`，`metrics=false` 可关）
- 视频做成循环动画：导入 → `xsxb_cutout`（省略滑块用共用智能档）→ `xsxb_analyze`（一次解码：去重 / 循环 / 动作窗，并写出推荐窗的 `grid=false` 预览 sheet）。看 `preview.path`，不要给每个候选单独 `xsxb_export_sheet`。`oneShotLikely` 表示长镜头里的短爆发，长镜头里的完整步态循环不是 one-shot。套用时 `xsxb_reorganize_frames` 传 `applyOrder`（不要只传 `loop.recommended.order` 或 `motion.order`，那会索引整段导入并保留 rest hold；`loop_endpoint=duplicate_first` 把第 0 帧拷成尾帧）。回执若带 `autoAdjustedThreshold`，不要直接套用 `duplicates.order`，除非传了 `auto_adjust`
- 循环段用 `xsxb_find_loop`（已导入动画、PNG 目录或 `file_paths`）；重复 hold 用 `xsxb_find_duplicates`；单次动作去头尾 hold 用 `xsxb_find_motion`；导入之后优先 `xsxb_analyze`。应用候选时再 `xsxb_reorganize_frames` 传 `order`
- 统一角色大小主路径是 `xsxb_register_clip`。`xsxb_estimate_visual` 只估倍率（`equalize` / `metric=bbox|body` / `reference_frame`），不是锁脚。手填用 `xsxb_set_visual_transform`（可 `frames[]` + `clear_group`）。要把组/帧缩放写进像素时用 `xsxb_cutout apply_visual`
- 预览用 `xsxb_export_gif`（尊重单帧时长和组/帧 `visual_size`；默认品红底，避免透明脚在黑底上跳；`output_path` / `copy_to` 可写到 `/tmp` 或游戏仓）或 `xsxb_export_sheet` 拼表。高度验收用 `normalize=none` 或 `feet`，不要用 `cell` 把矮帧拉满格子。格子带调参台组坐标网格，脚底 `0,0`，身体在负 y。`grid_density` 加密网格线；图上标的是与回执 `grid.cells[row][col]` 对应的行列号。组坐标由代码写在 JSON / `grid.legend` 里，**不要 OCR**。写回用 `grid.cells[row][col]`（row 0 是顶、col 0 是左，`x,y` 是该格左上角组坐标）。AI 按任务和画布大小填 `grid_density`（sparse/normal/dense）、`grid_divs`（如 `8x8`）或 `grid_x`/`grid_y`，以及 `grid_scope`（canvas|subject）；省略则用自动步长。源 PNG 不变
- 写回只报网格上的组坐标，或 overlay 格子 id（`E5` / `e5` / `{cell:"E5"}`，由帧 PNG 尺寸加 `grid_divs` / `grid_density` / `grid_scope` 算出，和 `export_sheet` 自动格一样）：`xsxb_shift_frames` 的 `from`/`to` 或 `dx`/`dy`、`xsxb_plant_feet` 的 `to`、框的 `min`/`max`、挂件的 `hand`+`t`、拖尾棍子、视觉偏移。不要 OCR overlay 数字，也不要自己换成画布像素。改完再 `export_sheet` 核对
- 走循环种脚：量完后用 `xsxb_plant_feet`（只平移，不缩放；锁高用 `xsxb_register_clip`）。默认种到 `y=-1`（最后一行像素），不要种到 `0,0`。种地前仍用 overlay 核对
- `xsxb_shift_frames` 已在目录（`MCP_TOOL_NAMES` / `tools/list`）。客户端报 not found 是会话目录过期，重载 `x-frame` MCP，不要跳过种植，也不要把 overlay 数字换成画布像素。`grid_divs` / `grid_density` 在 `xsxb_export_sheet` / `xsxb_cutout` 上已经可用
- 黄色 `0,0` 在位图外：`canvasAnchor` 的 `y` 是 `height`，最后一行像素是组坐标 `y=-1`。`to: "0,0"` 会裁掉 1px 鞋底，鞋底种到 `y=-1`
- `metrics.feetY` 是靴底，连着的亮刀光/辉光不算进去。种地前仍用 overlay 核对
- 量刀图长轴用 `xsxb_measure_image`：厚端是柄，薄端是尖；`t=0.5` 中间、`t=2/3` 或 `"2/3"` 是柄往尖的三分之二。落到舞台时把同一 `t` 和手上的组坐标交给 `xsxb_add_attachment`，不要自己减 `localFromCenter`
- 静止图可说格子：`xsxb_overlay_grid` 在 PNG 上画 A1 式格子（agent 用眼看，只回报格子 id，不要 OCR 像素盒或坐标）。回执 `overlay_id` 钉死当次 PNG+view，agent-led 的 `crop_from` / `place_image` 必须带上，对不上是 `STALE_OVERLAY`。`overlay.next` 为 `crop_from` 时先加密接触格再 place。不要把静图 `view` 和动画 `grid.cells` 混用。用户确认要合成后，先 `xsxb_plan_place` 做图度自检（读图接触、物理规则、验收、3～5 步方案），执行回执 `brief` 再 `xsxb_place_image`（可选带 `plan_id`）；`await_confirm` 或用户说先方案时停下等确认。接触格未写 `derive` 时默认 `snap: "alpha_centroid"`，不要手填自由 `x,y`。比例按选中跨度的 relative/physical；`layer` 用 `front` / `under_target` / `behind`；`rotation` 按看到的姿态。看 `verify.status` 和 `verify_overlay_path`。工具只合成、不重画。`xsxb_cutout file_path` 可抠一张工作区内的散图。门前站人只是例子，工具字段里没有门/人
- `xsxb_find_duplicates` 回执若带 `autoAdjustedThreshold`，不要直接 `reorganize` 那个 `order`，除非传了 `auto_adjust`
- 挂件/音效用 `file_path`。刀光 / `place_image` 不是走循环默认路径；攻击片才看 tool description 和 Skill。已过眼的参考（只作例子）：`exports/niulai-plunger-mcp/niulai-chop-crescent-trail-v4.gif`
- 默认项目用 `xsxb_set_active_project`
- 切换项目会清空旧角色与动画选择；同一项目重新设为 active 保留当前选择。切换角色时不沿用前一个角色的动画。省略角色或动画时选取当前作用域内的默认项。
- 本地修改已保存但 Godot 同步失败时，公开回执为 `ok=false`、`execution.effect=partial`、`error.code=GODOT_SYNC_FAILED`；`data` 保留本地操作结果，`error.details.localChangesSaved` 标明是否有已完成的本地操作。排除绑定或写入错误后，使用 `error.details.retry` 单独重试 `xsxb_sync_godot`，不要重复移帧或导入。Godot 文件可能已部分更新，重试会重新同步。兼容 `service.call` 调用者应检查返回的 `sync.ok`（单独同步则检查顶层 `ok`）。
- 先改框和时长，再显式同步
- 验证用 `layer=standalone|bind|gameplay`
- 误导入先 `dry_run` 再删
- 如实回报工具结果，不要编造成功
- MCP 报错、缺能力、或必须离开 MCP 才能做完时：告诉用户，并提到 `X-Frame` 项目。带上工具名、参数、回执或错误、期望结果、实际结果。不要静默绕过缺口

完整会话流程写在 `initialize.instructions`：走循环锁尺、视频成环、静图贴合、刀光各一行。硬约束（`preview.path`、`y=-1`、`overlay_id`、`grid=false`）在对应工具 description。Playbook 拆在 `skills/x-frame-import`、`x-frame-cutout`、`x-frame-gameplay`、`x-frame-godot`。`xsxb-frame-tuner` 只做路由。

Godot 编辑器操作（开场景、跑游戏、改节点）用独立的 Godot editor MCP，例如 [godot-mcp](https://github.com/Coding-Solo/godot-mcp) 或 [satelliteoflove/godot-mcp](https://github.com/satelliteoflove/godot-mcp)。本仓库不同化编辑器，也不内置 rembg/SAM。`xsxb_validate_for_godot` 只做数据与 gameplay 门闩，回执带 `qa`、`godot` 磁盘快照、`evidence.cells`（每格 clip id + 选中帧）和 `run_summary.path`；`xsxb_diff_frames` 写出可打开的对比 PNG（onion 会先抠底板）。`qa=warn` 必须停。导入或 sync 不是视觉验收。

## 当前工具

### 默认提交规则

初始化下发自洽的 playbook 行；不提供 MCP prompts/resources。`ping` 不进入业务队列；`tools/list` 与 `tools/call` 仍串行。`tools/list` 不重复 v2 回执 envelope，每次 `tools/call` 的 `structuredContent` 才带信封。同步解码或哈希仍会占用主线程。

`xsxb_register_clip`、`xsxb_plant_feet`、`xsxb_estimate_visual` 在省略两个开关时预览：`dry_run:true` 或 `apply:false` 优先保持预览，否则 `apply:true` 或 `dry_run:false` 提交。`xsxb_reorganize_frames` 非空 `order` 提交，省略 `order` 预览。`xsxb_compress_frames` 默认预览，提交必须传 `dry_run:false`。重排、挂件、音效、刀光和移除绑定均不再默认同步 Godot，需显式传 `sync:true`，或在本地验收后单独调用 `xsxb_sync_godot`。已有自动化若依赖旧默认写盘或同步行为，应补齐这些参数。

`xsxb_list_projects` · `xsxb_get_project` · `xsxb_create_project` · `xsxb_set_active_project` · `xsxb_bind_godot` · `xsxb_import_animation` · `xsxb_import_video` · `xsxb_slice_sheet` · `xsxb_get_animation` · `xsxb_find_loop` · `xsxb_find_duplicates` · `xsxb_find_motion` · `xsxb_analyze` · `xsxb_cutout` · `xsxb_measure_frames` · `xsxb_register_clip` · `xsxb_estimate_visual` · `xsxb_set_visual_transform` · `xsxb_estimate_boxes` · `xsxb_update_frame_boxes` · `xsxb_update_timing` · `xsxb_replace_frame` · `xsxb_shift_frames` · `xsxb_plant_feet` · `xsxb_reorganize_frames` · `xsxb_add_attack_trail` · `xsxb_plan_smear` · `xsxb_add_attachment` · `xsxb_add_sfx` · `xsxb_remove_binding` · `xsxb_delete_animation` · `xsxb_sync_godot` · `xsxb_validate_project` · `xsxb_validate_for_godot` · `xsxb_export_gif` · `xsxb_export_sheet` · `xsxb_export_overlay` · `xsxb_diff_frames` · `xsxb_export_pack_slot` · `xsxb_measure_image` · `xsxb_detect_regions` · `xsxb_overlay_grid` · `xsxb_plan_place` · `xsxb_place_image`

工具只接受项目、角色、动画、帧等业务标识，不接受任意 Shell 或不受限文件路径。

## 创作能力扩展

新增版本保存／比较／恢复／撤销、动画复制／拆分／合并／重命名、指定帧抠图、画布边距、跨帧质检与附件插值。工具说明、参数示例和适用限制见 [authoring/README.md](authoring/README.md)。
