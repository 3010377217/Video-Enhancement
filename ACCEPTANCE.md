# 节点验收记录

## 节点 1：通过

日期：2026-11-04。

执行 `node frontend/desktop/acceptance.cjs`，实际 Electron 窗口与 FFmpeg/FFprobe 验收通过。

覆盖原生多选、Ctrl+O、真实拖入 File 桥接、中文和空格路径、MP4/MKV/MOV、有理数帧率、90°旋转、音轨信息、损坏和重复视频、原生目录选择、无效目录、源文件覆盖防护与默认空队列。H.264/H.265 NVENC 和软件编码均实际编码一帧通过。AI 文件存在，模型实际推理留到节点 4 验证。

机器：NVIDIA T1200 Laptop 4GB，Python 3.13.13，FFmpeg 8.1.1。详细本机结果：`output/acceptance/node1/report.json`。

进入节点 2。

## 节点 2：通过

执行 `node frontend/desktop/accept-node2.cjs`。通过 Electron 实际导出，校验 H.264/H.265、NVENC 与软件回退、保留和关闭音频、自定义尺寸、原始 24000/1001 帧率、自动编号。源文件 SHA256 未变化，成片完整解码通过。实际取消 4K 编码后没有残留 partial 文件，所属进程树被结束。修复 Windows 管道默认编码导致中文路径损坏的问题。

详细结果：`output/acceptance/node2/report.json`。进入节点 3。

## 节点 3：通过

执行 `node frontend/desktop/accept-node3.cjs`。三任务实际顺序运行，中间输入临时移除导致失败，第三项继续完成；恢复输入后重试成功。暂停后续、继续、提交配置快照、完成记录恢复、中断标记、全局和独立配置保存通过。取消进程树沿用节点 2 已验收实现，任务状态以主进程为准。

详细结果：`output/acceptance/node3/report.json`。进入节点 4。

## 节点 4：通过

执行 `node frontend/desktop/accept-node4.cjs`，实际运行 Real-ESRGAN 和 RIFE。速度/质量两种策略、23.976→60、30→60、保持帧率、30→24、多块重叠、720p/1080p 和自定义尺寸通过。逐文件完整解码，读取实际帧数与全局时长折算一致，音轨保留。抽查同时间点对比图 `output/acceptance/node4/compare.png`；这不是全部素材主观画质保证。

处理帧采用有界 PNG 分块，分块中间视频为 FFV1 无损缓存；缓存可能随长视频累积，逐块检查可用空间，未宣称固定峰值。详细结果：`output/acceptance/node4/report.json`。进入节点 5。

## 节点 5：通过

执行 `node frontend/desktop/accept-node5.cjs`。固定 H.264/H.265 目标 1 Mbps 实测视频平均码率约 1.066/1.078 Mbps；动态质量值 18 与 32 的成片体积明显变化。5 秒素材按 5 MB/分钟预算，总上限 416666 字节，H.264 两遍编码输出 318756 字节、H.265 输出 328205 字节，均包含音轨与封装。过低预算明确失败；AI 与体积限制组合实际通过，AI 缓存复用于最终压缩。

详细结果：`output/acceptance/node5/report.json`。进入节点 6。

## 节点 6：本机验收通过

执行 `node frontend/desktop/accept-node6.cjs desktop-release/win-unpacked/FrameSequence.exe`。打包版子进程 PATH 限制为 `C:\Windows\System32`，移除 Python 环境变量，实际调用随包 Python、FFmpeg/FFprobe、Real-ESRGAN 和 RIFE，完成中文空格路径导入、独立配置、AI+60 fps、竖屏无音轨 H.265 导出、完整解码与源文件 SHA256 校验。双任务短片队列耗时约 5.69 秒，100ms 间隔抽样缓存最高 2,503,790 字节；抽样不等于精确峰值，也不能外推长视频。

原生目录选择、损坏/重复输入、打开结果位置调用、重启记录恢复、1000×740 最小窗口、1440×940 窗口、暂停后续、停止和 partial 清理通过。使用真实 ACL 禁止写入的临时目录，目录校验明确失败，随后恢复 ACL。缺 FFprobe、奇数尺寸偶数化、变帧率转 CFR、HDR 拒绝、准备阶段失败后继续、准备阶段停止队列通过。缓存空间不足通过注入零剩余空间验证；没有填满真实磁盘。实际结束 Node 父进程后，Windows Job Object 结束随包 Python 和后代进程。

发现原 CLI 的固定 HEVC B 帧参数与 T1200 不兼容，新增实际编码预检，失败时测试并切换 `-bf 0`，其他流程保持原样。CLI 实际输出 320×240、60 fps、36 帧、0.6 秒并带音轨，完整解码通过。

目录版结果：`output/acceptance/node6/unpacked-report.json`。截图：`output/acceptance/node6/minimum-processing.png`、`minimum-completed.png`、`desktop-completed.png`。

限制：当前仅在 T1200 Laptop 4GB 开发机验证短片。限制 PATH 能证明没有使用 PATH 中的开发工具，不能代替全新 Windows 电脑测试；RTX 4060、长视频耐久和长视频缓存峰值尚未验证。暂不支持 HDR、高于 8 位、非方形像素视频、字幕保留、多音轨管理与推理断点恢复。

便携版 `desktop-release/FrameSequence-0.2.0-Windows.exe`（315,179,885 字节）已通过 `node frontend/desktop/accept-portable.cjs` 验收：直接启动单文件 EXE，确认原生窗口；保留该窗口，对其在 Windows 临时目录实际解压的可执行程序，用独立配置运行完整第 6 节点测试。NSIS 启动器不转发 inspector 输出，因此采用此方式连接自动化，未把目录版结果冒充便携版测试。便携包实测双任务短片队列约 5.59 秒，100ms 抽样缓存最高 2,503,790 字节。

便携版结果：`output/acceptance/node6/portable-report.json`；汇总结果：`output/acceptance/node6/report.json`。程序 SHA256：`fce1e90637d79a5b43dee378ee40d53b739e2fb94000be6fd5c677fc273ee10c`，校验文件 `desktop-release/FrameSequence-0.2.0.sha256`。

本次开发使用 ui-design-brain 技能核对布局、表单、任务反馈和最小窗口。全部节点已按顺序完成本机验收。功能验收结束时尚未提交或推送 Git，后续仓库整理见下文。外部机器与长视频测试保持待测。

## 提交前清理

上述验收记录反映功能交付时状态。随后按用户要求清理旧仓库文件：旧网页、旧 CLI、过时说明、未使用模型、已移除预览区的素材和未引用的样式副本均移出当前目录；清理文件在仓库之外备份，原 Git 历史保留。当前桌面版运行所需模型、工具、源代码和许可证继续保留。

清理后 `npm run build` 与源码版 `node frontend/desktop/accept-node6.cjs` 完整验收通过。取消回归改为等待 4K 编码实际创建 partial 文件后再停止，发现并修复 Windows 终止进程与释放文件句柄的时序问题：先等待 taskkill 完成，临时文件遇占用时短暂重试，缓存使用有界重试，清理失败明确记录。低磁盘和进程生命周期测试同时支持开发 Python 的模块路径。复验结果保存在本机 `output/acceptance/node6/source-cleanup-report.json`；先前便携版报告独立保留，本次源码修复需重新构建后进入便携版。

## 0.2.1：AI 尺寸规划与处理优化

日期：2026-11-04。以下为本轮回归，不改写上述 0.2.0 历史结果。

`python -X utf8 -m unittest discover -s processing -p test_planning.py` 六项通过，其中边界项遍历 50 组尺寸与策略组合，覆盖速度/质量、竖屏、奇数输入、降尺寸、大倍率、过低预算与比例取整。

`node frontend/desktop/accept-optimization.cjs` 源码版通过；再传入 `desktop-release/win-unpacked/resources/runtime`，打包运行时同样通过。读取实际 PNG 而非只断言计划值，验证：

- 720p→1080p 速度：960×540 输入，2×实际输出 1920×1080，无后续放大。
- 720p→1080p 质量：1280×720 输入，2×实际输出 2560×1440，再缩至目标。
- 720p→4K：原尺寸直接 3×至 3840×2160。
- 9×目标：80×48 经两次 3×至 720×432；641×360 奇数模型输入实际得到 1923×1080。
- 0.5 秒 60→24 fps：源 30 帧，实际只对 12 帧推理，目标 12 帧。
- 过低体积预算在 AI 前失败；复制 AAC 的全码流 SHA256、RGB FFV1 缓存解码像素 SHA256 一致；源文件 SHA256 未变。

源码报告：`output/acceptance/optimization/source-report.json`；打包运行时报告：`output/acceptance/optimization/report.json`。720p 尺寸测试使用 0.125 秒片段，其耗时不能外推长视频。

`accept-node4.cjs` 与 `accept-node5.cjs` 均复验通过，覆盖 RIFE 有理数帧率、多块、降帧、音轨、完整解码、固定码率、动态质量和体积上限。5 秒、5 MB/分钟预算为 416666 字节，本轮 H.264 成片 318735 字节、H.265 成片 328825 字节。

`npm run desktop:pack` 成功，0.2.1 目录版通过完整 `accept-node6.cjs`：随包工具与受限 PATH、原生导入和独立配置、AI/RIFE 与竖屏导出、取消与 partial 清理、恢复、ACL 只读目录、注入低磁盘空间及父进程退出清理。报告独立保存为 `output/acceptance/optimization/node6-packaged-report.json`。目录版共 843,359,072 字节，较先前减少 126,852,540 字节；模型仅收集六个 animevideov3 文件，Electron 语言仅保留中文与英文。

本轮使用 ui-design-brain 核对策略说明及最小窗口；机器仍为 T1200 Laptop 4GB。RTX 4060、全新电脑和长视频耐久待测。RGB 缓存避免过早颜色抽样，但可能增加缓存体积；速度优先提高输出尺寸时现在实际承担 AI 放大，可能比旧流程更慢。改动和后续建议见 OPTIMIZATION.md。

0.2.1 便携单文件已通过 `node frontend/desktop/accept-portable.cjs`：限制 PATH 后直接启动 EXE，确认原生窗口，再对实际解压的程序使用独立配置执行完整第 6 节点验收。结果独立保存为 `output/acceptance/optimization/node6-portable-report.json`。包体 238,493,843 字节，比上一版减少约 24.3%；SHA256 为 `9fa0dbf357a272f51358d2bc0a06e18dd7968b56a018990c34f3150e00fb2189`，校验文件 `desktop-release/FrameSequence-0.2.1.sha256`。

## 0.2.2：行内进度、暂停与删除

日期：2026-11-04。处理中和暂停中的任务显示进度条与百分比；正常宽度位于名称列右侧，较窄队列内移到文件信息下方。处理中操作列仅显示暂停和删除，暂停后改为继续和删除。已完成项恢复配置、输出位置和重试操作。

新增当前任务暂停控制，与原有「暂停后续」独立。Windows 下按工作进程的专属 Job Object 查找所属进程，暂停工作进程及模型、编码子进程，恢复时校验 PID 与创建时间。独立 runner 保持父进程退出监控清醒，避免守护线程也被冻结而遗留后台进程。暂停保留显存和缓存，继续沿用原工作进程；关闭后重启仍记为中断，未宣称跨退出断点恢复。

删除等待项直接移出；删除运行或暂停项先结束所属进程树并等待临时文件、缓存清理，再移出列表，保留源视频及已完成输出。其他任务继续按序运行。提交准备、暂停、继续、取消及删除相互协调，暂停项不重复入队，等待项删除后不会被准备阶段重新加入。

`npm run desktop:pack` 和 `node frontend/desktop/accept-task-controls.cjs desktop-release/win-unpacked/FrameSequence.exe` 通过。实际桌面窗口与随包运行时验证：

- 真实 AI 任务进度条、百分比、两按钮状态与暂停记录保存；1000×740、1440×940 窗口无页面横向溢出。
- 暂停期间工作进程及模型进程 CPU 累计时间不增长，进度不变，下一项保持等待；继续使用相同 worker PID，后续任务按序完成，成片完整解码通过。
- 删除等待项不影响暂停中的当前任务；删除暂停项和运行项后，所属进程、缓存、partial 文件均已清理；运行项删除后下一项完成；三个源文件 SHA256 不变。
- 实际终止暂停时的 Electron 主进程，runner 及冻结的后代进程全部退出；重启后该项标为中断，无自动处理。Windows 下测试明确取得真实主进程 PID，未把 Playwright 启动包装进程 PID 当作主进程。

专项报告 `output/playwright/task-controls/packaged-report.json`；截图 `desktop-paused.png`、`minimum-paused.png` 位于同一目录。原第 6 节点综合回归也通过，报告独立保存为 `output/playwright/task-controls/node6-packaged-report.json`。仍为本机 T1200 短片验收。

`accept-task-queue.cjs` 补测删除与异步准备的两个交界：配置准备完成但尚未入队、已选中当前项但尚未启动工作进程。均确认被删除项不启动、不重新出现，下一项真实编码完成，源文件保留。结果 `output/playwright/task-controls/queue-boundary-report.json`。

本轮使用 ui-design-brain 核对表格、进度和按钮状态，使用 Playwright 验收实际 Electron 窗口。

0.2.2 便携包已通过 `node frontend/desktop/accept-portable.cjs --task-controls`，在单文件实际解压的运行时上完成第 6 节点与上述任务控制专项。专项还核对暂停/继续后实际输出帧数完整，暂停项及等待项不重复入队。报告为 `output/playwright/task-controls/portable-report.json` 与 `node6-portable-report.json`；运行中效果截图 `desktop-processing.png`。包体 238,496,587 字节，SHA256 为 `4eb44d159aaa591e8ccfd77003163391d5d09653bd366970624d9f42596245b0`，校验文件 `desktop-release/FrameSequence-0.2.2.sha256`。
