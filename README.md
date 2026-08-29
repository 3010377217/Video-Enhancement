# 视频增强工具箱（Real-ESRGAN / Video2X / RIFE）

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

## 两种 AI 超分引擎

Web 界面的“超分”页现在可以选择两条路线：

- **Real-ESRGAN**：项目自带 `realesrgan-ncnn-vulkan.exe` 和动漫模型，继续使用上面的分块抽帧流程。
- **Video2X / Real-CUGAN**：Video2X 直接读取视频并输出视频，推荐 `2x` 并从 Real-CUGAN 降噪等级 `0` 或 `1` 开始测试。输出文件名会追加 `_cugan_n0`、`_cugan_n1` 等后缀，便于和 Real-ESRGAN 结果做对比。

Video2X 是可选的外部运行时，未随仓库提交。配置方式任选其一：

1. 将兼容当前 Video2X CLI 的 Windows 包解压到项目目录 `video2x\\`，确保其中有 `video2x.exe`。
2. 设置环境变量 `VIDEO2X_EXE`，值为 `video2x.exe` 的完整路径。

启动 `webui.bat` 后，超分引擎状态会显示在选择项中。未配置 Video2X 时，Real-ESRGAN 仍可正常使用；选择 Video2X 会给出配置提示。

Video2X 模式不会使用 `CHUNK` 参数，因为视频解码、处理和编码由 Video2X 自己完成；Real-ESRGAN 模式仍按分块流程运行。

### 2x 超分后缩回原分辨率

`upscale_keep_size_video2x.bat` 用于“文件标称分辨率较高、实际观感偏糊”的片源：先由 Real-CUGAN 放大 2 倍，再以 Lanczos 缩回源视频的原始宽高。它保持帧率、复制全部音轨，输出文件名追加 `_cugan2x_keep_<宽>x<高>`。

```
upscale_keep_size_video2x.bat "D:\videos\anime.mp4"
upscale_keep_size_video2x.bat "D:\videos\anime.mp4" 1
```

- 默认：`models-se + 2x + noise 0`。
- 第二个参数为降噪等级：`0`、`1`、`2`、`3`。
- 脚本会产生一个临时的 2 倍分辨率视频；建议预留至少相当于最终输出文件大小的额外空间。脚本会读取源视频帧数；如果 Video2X 输出少了尾部帧，会自动复制最后一帧补齐，不会把帧率写死为 24fps。处理失败时该临时文件会保留，方便查看错误日志。

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
