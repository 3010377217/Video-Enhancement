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

- 除上述环境外，需要 `rife-ncnn-vulkan-20221029-windows/`（含 `rife-v4.6` 模型）解压到脚本同目录。
  该目录较大且不进 git，请从 [releases](https://github.com/nihui/rife-ncnn-vulkan/releases) 下载对应版本解压。

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
