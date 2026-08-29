# Real-ESRGAN NCNN Vulkan 便携版（动漫视频超分）

基于 [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) 官方 NCNN Vulkan 便携版，封装了一个 ffmpeg 批处理脚本，把"抽帧 → 超分 → 合帧（保留音频）"串成一条命令。

## 环境要求

- Windows 10/11
- 支持 Vulkan 的 NVIDIA 显卡（NCNN Vulkan 版不走 CUDA）
- `ffmpeg` / `ffprobe` 在 PATH 中（[gyan.dev full build](https://www.gyan.dev/ffmpeg/builds/) 或 `winget install ffmpeg`）

## 用法

```
upscale_video.bat <视频路径> [放大倍数]
```

- `scale` 省略时默认 `2`
- 示例：`upscale_video.bat "D:\videos\anime.mp4" 2`
- 输出：`D:\videos\anime_x2.mp4`（源视频同目录，追加 `_x2` 后缀）

## 工作原理（分块处理）

整段视频拆帧后可达几十 GB，所以脚本把视频**分批**处理，磁盘上始终只保留一批的帧：

1. 抽取一批（默认 1500 帧）
2. 这批做超分
3. 编码成一个小分片 mp4
4. 删除这批的原始帧和超分帧，继续下一批

全部完成后用 ffmpeg concat 合并分片，再混入源音频。峰值磁盘占用约 1GB 以内，与视频总长度无关。若磁盘紧张，可把 `upscale_video.bat` 里的 `CHUNK` 调小（如 `1000`）。

## 说明

- 默认模型：`realesr-animevideov3`（动漫专用，支持 x2 / x3 / x4），适合动漫；真人视频请改用 `realesrgan-x4plus`
- 帧率保持不变（只超分、不补帧）
- 临时文件 `_work_*` / `_seg_*.mp4` / `_segs_*.txt` 处理完自动删除
- 时间参考（854x480 源，NVIDIA T1200，CHUNK=1500）：约 0.2 秒/帧，27 分钟视频约 3 小时

---

# RIFE 帧率插值（动漫补帧）

基于 [RIFE](https://github.com/hzwer/arXiv2020-RIFE) 的 ncnn-vulkan 便携版，把低帧率动画（如 30fps）插值成 60fps 的流畅观感，一次跑出 60hz 和 45hz 两个版本。

## 环境要求

- 仓库已附带精简的 `rife-ncnn-vulkan-20221029-windows/` 运行时和 `rife-v4.6` 模型；如需额外模型，请从 [releases](https://github.com/nihui/rife-ncnn-vulkan/releases) 下载后自行解压。

## 用法

```
interp_video.bat <视频路径>
```

- 示例：`interp_video.bat "D:\videos\anime.mp4"`
- 输出（源视频同目录）：
  - `<视频名>_60hz.mp4` —— 2x 插值后的完整 60fps
  - `<视频名>_45hz.mp4` —— 从 60fps 每 4 帧取 3 帧派生（保留原帧 + 一半插值帧）

## 工作原理（分块 + 磁盘优化）

与超分脚本相同的分块思路，峰值磁盘占用约数百 MB，与视频总长度无关（笔记本剩余空间不多也没问题）：

1. 抽取一批（默认 1000 帧）
2. 该批做 RIFE 2x 插值
3. 编码成小分片 mp4，立即删除本批帧
4. 继续下一批，最后 concat 合并 + 混入音频

分块边界会跳过一次插值（每块约一帧的轻微定格，CHUNK=1000 时每约 33 秒一次，几乎无感）。磁盘紧张可把 `interp_video.bat` 里的 `CHUNK` 调小（如 `300`）。

## 说明

- 模型写死为 `rife-v4.6`；插值用 GPU（Vulkan），不占 CPU 太多
- 60hz 版 CRF 18 编码；45hz 版从 60hz 重编码派生
- 输入需为恒定帧率（CFR）；VFR 源不精确
- 时间参考（1708x960，NVIDIA T1200）：RIFE 约 24 帧/秒，27 分钟视频插值阶段约 10 分钟（不含抽帧/编码）

## 附加脚本

### `process_videos.py`

批量执行缩放、Real-ESRGAN 超分、RIFE 补帧和 HEVC NVENC 编码。它只处理输入目录第一层的 MP4 文件，并把输出、`process.log` 与 `timings.csv` 写入输出目录。

```powershell
py -3 .\process_videos.py --src-dir "D:\Videos\input" --out-dir "D:\Videos\output"
```

- 需要 Windows、`ffmpeg`/`ffprobe` 位于 `PATH`、支持 Vulkan 的显卡，以及仓库中的 Real-ESRGAN 和 RIFE 运行时。
- 默认使用 `hevc_nvenc`，因此还需要可用的 NVIDIA NVENC 编码器；整个流程会重新编码视频，不是无损剪辑。
- 输入会先缩放：接近 4:3 的视频缩为 `480x360` 后输出 `960x720`，其他视频缩为 `640x360` 后输出 `1280x720`；再进行固定 2.5 倍帧数的插帧。高于这些目标尺寸的源视频会被降分辨率，不适用于保真导出。
- 分块流程使用双缓冲预取：当前块进入超分、补帧或编码后，后台抽取下一块输入帧；只额外保留一块输入 JPEG，临时帧峰值约 `1.25` GiB（默认 1000 帧块），低于 1.5 GiB 限制。
- `--work-dir` 默认为 `<out-dir>\.work`，必须是新建或空的专用目录；其中内容会在运行结束时递归删除。不要将其指定为包含源视频或输出视频的目录。
- 工具不在仓库默认位置时，可用 `--esrgan`、`--rife` 和 `--rife-model` 传入对应路径。`--dry-run` 可只检查输入排序，不实际处理视频。

### `rebuild_from_jianying.py`

该工具从原视频和剪辑成品的缩略图匹配结果推断剪切点与固定倍速，并重建新文件。

```powershell
py -3 -m pip install -r requirements.txt
py -3 .\rebuild_from_jianying.py --src "D:\Videos\source.mp4" --mod "D:\Videos\edited.mp4" --out "D:\Videos\rebuilt.mp4"
```

- 需要 `ffmpeg`、`ffprobe` 和 Pillow；默认临时目录为输出文件同级的 `.rebuild`，也可用 `--work` 覆盖。临时目录必须新建或为空，且会在开始和成功结束时删除，不能指向素材或输出所在的父目录。
- 匹配基于 1fps 的 dHash，是近似重建而非逐帧保证；仅识别约 `0.4x` 到 `2.5x` 的连续固定倍速片段，范围外或无法匹配的区间可能不会被重建。
- 只要存在变速片段，所有片段都会统一重编码为 H.264/AAC 以保证可拼接；无音轨源会输出仅含 H.264 视频流。没有变速时才使用流复制切段。流复制仍受关键帧位置限制，因此不能视为逐字节无损。

### `gpu_monitor.py`

记录 `nvidia-smi` 报告的 GPU 利用率和显存。可选地读取 `process_videos.py` 的日志以标注当前阶段。

```powershell
py -3 .\gpu_monitor.py --output "D:\Videos\output\gpu_monitor.log" --process-log "D:\Videos\output\process.log"
```

需要 NVIDIA 驱动附带的 `nvidia-smi`。使用 `--once` 可只记录一个样本。生成的监控日志属于本地运行产物，不应提交。

## 本地实验文件

以下文件有意保留在本机并由 `.gitignore` 忽略：本地扫描和对比结果（`_*.txt`、`_probe_*.png`）、一次性重处理脚本（`_reprocess_*.py`）、帧匹配探针（`frame_match_probe.py`）、120fps 实验（`interp_120.py`）、编码器对比脚本（`test_720p*.py`、`test_direct2x.py`）以及未说明硬件和命令的测速数据（`upscale_speed.json`）。这些文件可能包含本机路径、具体媒体名称或无法复现的实验上下文。

要将实验脚本升级为项目功能，先删除本机绝对路径和具体媒体信息，改为命令行参数，说明依赖、临时目录清理行为和画质限制，并提供可重复的验证步骤。任何用户视频、截图、日志或测速结果都不应直接提交到仓库。
