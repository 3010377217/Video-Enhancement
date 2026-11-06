# 帧序桌面应用

Electron 主进程管理原生文件访问、任务队列、配置快照与持久化；React/TypeScript 提供本地界面；Python 标准库工作进程调用 FFmpeg、Real-ESRGAN 与 RIFE。生产版从本地构建文件加载，无需 Web 服务。

## 开发

```powershell
cd "D:\codework\Video Enhancement\frontend"
npm install
npm start
```

`npm start` 构建后启动桌面窗口；`npm run desktop:dev` 启动 Vite 热更新与 Electron。`npm run dev` 仅供前端调试，实际功能依赖桌面 preload 桥接。

开发环境需要 Python、FFmpeg/FFprobe（项目本地 tools/、python/ 优先，其次 PATH），以及仓库中的 Real-ESRGAN、RIFE 和模型。前端不接收任意 shell 命令，处理任务均以参数数组启动。

## 打包

```powershell
npm run desktop:pack
npm run desktop:portable
```

均先构建界面，再准备 `.cache/runtime` 并调用 electron-builder。前者生成 `../desktop-release/win-unpacked`，后者生成 `../desktop-release/FrameSequence-<版本号>-Windows.exe`，版本号取自 `package.json`。已准备的目录版也可执行 `npx electron-builder --win portable --x64 --prepackaged ../desktop-release/win-unpacked`，直接封装同一产物。

`desktop/prepare-runtime.cjs` 收集本机 Python 标准库、所需 DLL、FFmpeg/FFprobe、GPU 可执行程序与模型；不包含第三方 Python 包。打包机需具备上述工具。第三方许可证来自本地保留文件，生成运行时无需联网获取许可证。发布时保留随包许可证。

## 自动验收

```powershell
node desktop/acceptance.cjs
node desktop/accept-node2.cjs
node desktop/accept-node3.cjs
node desktop/accept-node4.cjs
node desktop/accept-node5.cjs
node desktop/accept-node6.cjs ../desktop-release/win-unpacked/FrameSequence.exe
node desktop/accept-portable.cjs
node desktop/accept-optimization.cjs
node desktop/accept-task-controls.cjs
node desktop/accept-task-queue.cjs
```

按节点顺序运行；部分后续节点复用前面生成的短片。第 6 节点可独立生成测试素材。验收会实际执行视频处理，输出到 `../output/acceptance/nodeN`；运行期间不要手动操作测试窗口。`desktop/smoke.cjs` 是第 6 节点综合验收的兼容入口，不再检查虚构演示任务。

第 6 节点使用独立用户配置，打包版子进程 PATH 限制为 Windows System32，并移除 Python 环境变量，验证随包工具。包含真实 AI/RIFE 导出、竖屏、独立配置、取消、重启、错误路径、只读目录和进程树回收；低磁盘场景通过注入零剩余空间验证错误分支，不填满真实磁盘。每次验收记录机器和限制，不能替代其他电脑与长视频测试。

## 关键文件

- `desktop/main.cjs` / `preload.cjs`：原生窗口与受限 IPC。
- `desktop/media.cjs` / `runtime.cjs`：视频探测、输出命名与实际编码器检测。
- `desktop/queue.cjs` / `jobs.cjs`：顺序队列、任务快照、持久化与取消。
- `../processing/worker.py` / `ai.py` / `encoding.py`：实际处理、AI 管线与三种压缩控制。
- `../processing/winprocess.py`：Windows Job Object，主进程异常退出时清理后代进程。
- `../processing/runner.py` / `control.py`：保留独立生命周期守护，暂停/继续该任务的工作进程及其模型、编码子进程，避免暂停时失去退出监控。

具体产品行为与限制见根目录 README 和 ACCEPTANCE.md。

便携版的 NSIS 启动器不会转发 Playwright 需要的 inspector 标准输出，使用 `accept-portable.cjs` 验收：先直接启动单文件 EXE 并确认其原生窗口，再保留该实例，对它实际解压的可执行程序运行完整第 6 节点测试。两个实例使用独立配置，测试结束正常关闭启动器实例。

优化回归另包含 `python -X utf8 -m unittest discover -s processing -p test_planning.py`（在根目录执行）。`accept-optimization.cjs` 实际验证 720p→1080p/4K、模型中间尺寸、降帧先丢帧、多次超分、AAC 码流和 RGB 像素哈希；可传入打包后的 runtime 目录验证同一套处理代码。每次打包先清理受控 runtime 缓存，只收集使用的六个 SR 模型文件，Electron 仅保留中文和英文语言资源。

`accept-task-controls.cjs` 验证实际行内进度、当前任务暂停/继续、冻结期间进程 CPU 时间不增长、沿用同一工作进程、等待/运行/暂停项删除、队列继续、临时文件清理，以及暂停时应用异常退出后的进程回收和重启标记。可传目录版 EXE；截图与报告位于 `output/playwright/task-controls`。

便携包专项可执行 `node desktop/accept-portable.cjs --task-controls`，在同一便携包解压运行时上依次完成第 6 节点与任务控制验收。
