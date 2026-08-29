# 项目进度交接

更新时间：2026-08-29

这份文档给接手本项目的模型使用。当前目标是为动漫视频提供两种可比较的处理路线：

```text
A. RIFE 在源分辨率补帧 -> Real-CUGAN 2x -> 缩回源分辨率
B. Real-CUGAN 2x -> RIFE 在 2x 分辨率补帧 -> 缩回源分辨率
```

## 已完成

- 已安装并验证 Video2X 6.4.0 Windows 版，当前机器的本地运行时在 `video2x\\video2x.exe`，使用 NVIDIA T1200 的 Vulkan 设备。
- 已接入 Video2X / Real-CUGAN WebUI：
  - `video_tasks.py`
  - `webui.py`
  - `app.js`
  - `index.html`
- 已按 Video2X 6.4.0 实际模型文件约束过滤 Real-CUGAN 选项：
  - `models-se`：2x/3x/4x；2x 可用 noise 0/1/2/3，3x/4x 可用 0/3。
  - `models-pro`：2x/3x；可用 noise 0/3。
  - `models-nose`：仅 2x、noise 0。
- 已新增 `upscale_keep_size_video2x.bat`：读取源宽高，执行 Real-CUGAN 2x，再用 Lanczos 缩回原宽高；复制全部音轨，不保留字幕流。
- 该脚本会读取源帧数。如果 Video2X 输出少了尾部帧，会使用 `tpad=stop_mode=clone` 复制最后一帧补齐。这个操作只是帧数补齐，不是 AI 补帧。
- 已处理 Video2X 6.4.0 的两个兼容问题：
  - Windows CLI 不接受 `--noise-level=-1`，默认改为 noise 0。
  - Video2X 偶尔在已经成功写出且可读取的文件后返回 `-1073741819`；后端和批处理脚本会在输出通过 `ffprobe` 校验时记录警告并继续，不再误判失败。
- 已通过语法检查：
  - `python -m py_compile video_tasks.py webui.py`
  - `node --check app.js`
  - `git diff --check`
- 已用 640x360、30fps 小视频验证 `upscale_keep_size_video2x.bat`：源文件 90 帧，Video2X 中间文件 88 帧，脚本补齐后最终文件恢复为 640x360、30fps、90 帧、3 秒。

## 最近一次实际实验

用户提供的源视频实际文件名是扁平化后的：

`C:\Users\P15\Desktop\e082c592605a9a57_mp4_354230129235_mp4_264_hd_taobao.mp4`

源参数：1280x720、30fps、约 59.84 秒、1795 帧、AAC 音频，源文件约 5.5MB。

实验工作目录：`_ab_taobao_20260829\\`。为了不修改源文件，曾复制了一份 `source.mp4` 到该目录。

- 流程 A 的 RIFE 阶段已完成，生成过 60fps 和 45fps 版本。
- 用户要求停止后，`source_60hz.mp4` 和 `source_45hz.mp4` 已删除并验证不存在。
- 流程 A 的 Real-CUGAN 阶段曾运行到 390/3590 帧（约 10.9%）后中断，没有生成最终成片。被中断的临时文件仍可能在项目根目录的 `_cugan_keep_source_60hz\\upscaled.mkv`，不可视为完整结果。
- 流程 B 尚未开始。
- 当前机器在 1280x720、60fps 上跑 Real-CUGAN 2x 约 1.94fps，完整流程 A 的超分阶段预计约 30 分钟；流程 B 还会额外承担 2560x1440 上的 RIFE，预计更慢。

## 接下来要做

1. 在另一台电脑确认 Video2X 6.4.0、RIFE、FFmpeg 和 Vulkan GPU 均可用，先用短片测试速度。
2. 重新生成流程 A 的 60fps 中间视频，然后执行：

   ```bat
   call interp_video.bat "<source.mp4>"
   call upscale_keep_size_video2x.bat "<source>_60hz.mp4" 0
   ```

   `interp_video.bat` 会额外生成 45fps 文件；A 流程只需要 60fps 文件。

3. 执行流程 B：
   - 用 Video2X / Real-CUGAN `models-se + 2x + noise 0` 生成 2560x1440 中间视频。
   - 对这个 2560x1440 中间视频运行 `interp_video.bat`，得到 60fps 高分辨率视频。
   - 用 FFmpeg `scale=1280:720:flags=lanczos` 缩回源分辨率，并复制音频。
4. 用 `ffprobe` 校验两个最终文件的宽高、帧率、帧数、时长、音频流和文件大小，再抽取相同时间点的截图进行主观对比。
5. 根据另一台电脑的实测速度，决定是否需要把两阶段合并成新的自动化脚本；当前仓库还没有“一键 RIFE + Real-CUGAN”脚本。

## 重要边界

- `upscale_keep_size_video2x.bat` 目前只负责 Real-CUGAN 超分和缩回原分辨率，不负责 RIFE AI 补帧。
- `interp_video.bat` 是现有的 RIFE 2x 补帧脚本，默认输出 60fps 和 45fps 两个版本。
- 不要把 `tpad` 尾帧复制称为补帧；它只用于修复 Video2X 少输出尾帧的问题。
- Video2X 的 `--noise-level` 在本地 6.4.0 版本只使用 0、1、2、3，不要恢复为 -1。

## Git / 提交边界

远程仓库：`https://github.com/3010377217/Video-Enhancement.git`

本次应提交的内容：代码改动、`upscale_keep_size_video2x.bat` 和本交接文档。

不要提交以下本地运行时或测试产物：`video2x\\`、ZIP 包、`_ab_taobao_20260829\\`、`_cugan_keep_*`、`_compare_30fps\\`、`_noise_test_*.mkv`、`test_clip*.mp4`、`timing_probe_*.mp4`、`video-editor\\` 以及其他未明确属于本次功能的未跟踪文件。`.gitignore` 已覆盖大部分运行时目录，但提交前仍需用 `git status` 复核。
