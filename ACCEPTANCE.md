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
