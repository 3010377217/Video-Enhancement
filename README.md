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
