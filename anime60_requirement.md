# 需求规格：动漫视频提速增强脚本（anime60）

> 目标读者：接手的实现模型。请先通读全文（含"已知环境与坑"章节）再动手。

## 1. 背景与总体目标

Windows 本地批处理/Python 脚本，对**动漫视频**做一次"缩分辨率 → AI 超分 → AI 补帧"的增强，输出**帧率 60fps、分辨率 = 源视频分辨率**的成片。核心动机是**速度**：超分阶段目标 **~15fps**（通过先缩小一半分辨率再 2x 超分实现，超分像素量只有直跑的 1/4）。

## 2. 硬件 / 环境（已确认）

- 设备：Intel i5-12450H + **NVIDIA RTX 4060 Laptop** + 32GB 内存，Windows 11
- 引擎（项目根目录 D:\codework\Video Enhancement 内，均可用）：
  - `realesrgan-ncnn-vulkan.exe`（NCNN Vulkan 版，走 RTX 4060）
  - `rife-ncnn-vulkan-20221029-windows\rife-ncnn-vulkan.exe` + 同目录模型 `rife-v4.6`
  - `video2x\video2x.exe`（Video2X 6.4.0，可选）
- `models\` 目录已有模型：`realesr-animevideov3-x2/-x3/-x4`、`realesrgan-x4plus`、`realesrgan-x4plus-anime`、`realesrnet-x4plus`（.param/.bin 成对）
- ffmpeg / ffprobe：gyan.dev 8.1.1 全量版，在 PATH 中
- 测试素材（根目录）：`test_clip.mp4`（640x360, 30fps, 90 帧, 3 秒，无音轨）；`onepiece_demo.mp4`（640x480, 1199/50≈23.98fps, 181 帧）

## 3. 处理流程（必须严格按此顺序）

```
源视频(如 1920x1080, 30fps)
  └─[1] 缩小一半分辨率      → 960x540   （ffmpeg, lanczos, 高质量中间文件）
  └─[2] Real-ESRGAN 超分 2x → 1920x1080 （realesr-animevideov3-x2, 回源分辨率）
  └─[3] RIFE 补帧 2x        → 60fps     （30fps 源 → 60fps；输出仍为 1920x1080）
  └─[4] 混入源音轨, 输出     → <源名>_60fps.mp4
```

### 3.1 阶段 1：缩小一半
- ffmpeg `-vf scale=trunc(iw*0.5/2)*2:trunc(ih*0.5/2)*2:flags=lanczos`（保证偶数宽高，2x 后能精确回源尺寸）
- 编码 `libx264 -crf 16 -preset fast -pix_fmt yuv420p`，中间文件质量要高（后续要再超分）
- 该阶段不要音频（最后一步统一混音）

### 3.2 阶段 2：超分 2x（分块）
- 用 `realesrgan-ncnn-vulkan.exe -i <帧目录> -o <输出目录> -n realesr-animevideov3 -s 2 -f jpg`
- **必须分块**（抽一坨帧→超分→编码成一段 mp4→删帧→下一坨），理由：整段拆帧可达几十 GB，分块后磁盘峰值 <1GB。建议每坨 1500 帧。
- 分块抽帧：`ffmpeg -ss <开始时间> -i <缩小后视频> -frames:v <坨大小> -pix_fmt yuvj420p -qscale:v 2 f_%08d.jpg`
- 每坨超分后编码：`ffmpeg -framerate <源fps如30/1> -i <超分帧目录>/f_%08d.jpg -c:v libx264 -crf 18 -pix_fmt yuv420p seg_%n.mp4`
- 全部坨完成后 concat：`ffmpeg -f concat -safe 0 -i seglist.txt -c copy sr_all.mp4`

### 3.3 阶段 3：RIFE 补帧 2x（分块）
- 输入 = 阶段 2 的 sr_all.mp4（已是源分辨率、源帧率）
- 同样分块抽帧（每坨建议 1000 帧），然后：
- `rife-ncnn-vulkan.exe -i <帧目录> -o <输出目录> -m <rife-v4.6 路径> -f "%08d.jpg"`
- 每坨编码：`ffmpeg -start_number 1 -framerate <2x帧率如60/1> -i <输出目录>/%08d.jpg -c:v libx264 -crf 18 -pix_fmt yuv420p seg_%n.mp4`
- concat 全部坨 → rf_all.mp4

### 3.4 阶段 4：混音输出
- 30fps 源（2x=60fps）：直接 `ffmpeg -i rf_all.mp4 -i <源> -map 0:v:0 -map 1:a? -c:v copy -c:a aac -b:a 192k -shortest <源名>_60fps.mp4`
- 非 30fps 源（如 24fps 源 2x=48fps）：需先 `minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bidir` 重编码到 60fps 再混音（脚本要自动检测帧率并走对应分支，并打印提示）

## 4. 验收标准

1. `test_clip.mp4`（640x360/30fps/90帧）：输出 640x360、60fps、约 180 帧、时长 3 秒
2. 阶段 2（超分）实际速度 ≥15fps（建议脚本打印各阶段耗时与 fps）
3. 源分辨率 = 输出分辨率（用 ffprobe 校验）
4. 音轨保留（源有音轨时）；无音轨源也能输出
5. 临时目录（帧、分片、seglist）处理完自动清理；失败时保留便于诊断
6. 磁盘峰值 < 2GB

## 5. 已知环境与坑（务必逐条遵守，均为实测踩坑）

1. **bat 文件编码**：cmd 默认代码页 GBK，UTF-8 中文注释/echo 会乱码导致整行解析失败（报 "is not recognized"）。**脚本内所有文字用纯英文 ASCII**，或开头 `chcp 65001` + 存为 UTF-8。
2. **ffprobe 在 for /f 里取宽高/帧率**：`=` 和 `,` 必须转义，否则 ffprobe 把参数当文件名：
   `for /f "tokens=1,2 delims=x" %%A in ('ffprobe -v error -select_streams v:0 -show_entries stream^=width^,height -of csv^=p^=0:s^=x "%SRC%"') do (...)`
   取帧数：`-count_frames -show_entries stream^=nb_read_frames -of csv^=p^=0`（注意 `count_frames` 较慢，长视频可改为 `nb_frames` 或 帧率×时长 估算，二选一都行但要有兜底）。
3. **ffmpeg 8.1 抽帧到 jpg 必须加 `-pix_fmt yuvj420p`**，否则报 "Non full-range YUV is non-standard" / "ff_frame_thread_encoder_init failed" 且抽不出帧。
4. **ffmpeg 8 抽帧越过 EOF** 返回码是 **-22**（不是 0），且抽 0 帧——这是分块循环的**正常结束条件**，不要当错误。判断"该坨 0 帧"要用文件计数（`dir /b ... | find /c /v ""`）而非退出码。
5. **cmd 括号块内变量展开问题**：`if (...)` 括号块里 `set VAR=...` 后再 `echo %VAR%` 拿到的是旧值（无延迟展开）。计时/fps 打印等要么用 `setlocal EnableDelayedExpansion` + `!VAR!`，要么把 set 和 echo 拆到括号块外。实测中 fps 显示为空就是这么来的。
6. **goto 标签**：批处理 `goto :label` 找不到标签会报 "The system cannot find the batch label specified - <label>"。实现时确保每个 goto 的标签都存在且拼写一致；标签行不要有尾随空格。**如用 Python 实现可完全规避本类问题，强烈建议用 Python**（仅用标准库 subprocess/ffprobe，无需第三方包），理由是上面 5 条 bat 坑全都能用 Python 干净解决。
7. Real-ESRGAN 的 stdout 进度是 `0.00% / 50.00%` 这种（每帧两行），可解析百分比做进度；RIFE 无百分比输出，可数输出帧文件数做进度。
8. RIFE 输入帧命名为 `f_00000001.jpg`（从 1 开始），`-f "%08d.jpg"` 控制输出名；RIFE 需要输入 ≥2 帧。
9. 临时目录统一放 `_anime60_<源名>\` 于项目根目录，结束后删除。
10. 输出命名：`<源目录>\<源名>_60fps.mp4`，与源视频同目录。

## 6. 建议实现形态（可二选一）

### 方案 A：Python 脚本（推荐）
- 单文件 `anime60.py`，只用标准库（subprocess、os、re、sys、json、time），运行 `python anime60.py <输入视频>`
- 直接规避 bat 的编码/转义/括号展开/goto 全部坑
- 进度打印友好，fps 统计简单（time.monotonic）
- 参考本项目已删的 `video_tasks.py` 的分块逻辑（extract → process → encode_segment → concat → mux），但流程改成"缩半→超分→补帧"

### 方案 B：批处理（不推荐，坑多）
- 单文件 `anime60.bat`，全英文 ASCII 输出，`setlocal EnableDelayedExpansion`
- 必须逐一遵守第 5 节全部坑

## 7. 参考命令速查

```bat
rem 缩半
ffmpeg -y -loglevel error -i src.mp4 -vf "scale=trunc(iw*0.5/2)*2:trunc(ih*0.5/2)*2:flags=lanczos" -c:v libx264 -crf 16 -preset fast -pix_fmt yuv420p -an down.mp4

rem 抽一坨帧（注意 yuvj420p）
ffmpeg -y -loglevel error -ss 0.016667 -i down.mp4 -frames:v 1500 -pix_fmt yuvj420p -qscale:v 2 frames\f_%08d.jpg

rem 超分一坨
realesrgan-ncnn-vulkan.exe -i frames -o up -n realesr-animevideov3 -s 2 -f jpg

rem 编码分片（源帧率）
ffmpeg -y -loglevel error -framerate 30/1 -i up\f_%08d.jpg -c:v libx264 -crf 18 -pix_fmt yuv420p seg_1.mp4

rem concat
ffmpeg -y -loglevel error -f concat -safe 0 -i segs.txt -c copy sr_all.mp4

rem RIFE 一坨（输入帧 f_00000001.jpg）
rife-ncnn-vulkan.exe -i r_in -o r_out -m rife-v4.6 -f "%08d.jpg"

rem 补帧分片（2x 帧率）
ffmpeg -y -loglevel error -start_number 1 -framerate 60/1 -i r_out\%08d.jpg -c:v libx264 -crf 18 -pix_fmt yuv420p seg_1.mp4

rem 混音（30fps 源直出 60fps）
ffmpeg -y -loglevel error -i rf_all.mp4 -i src.mp4 -map 0:v:0 -map 1:a? -c:v copy -c:a aac -b:a 192k -shortest out_60fps.mp4
```

## 8. 交付物

- `anime60.py`（或 .bat）+ 简短 README（用法、参数、输出命名）
- 用 `test_clip.mp4` 实测通过（附实测日志：各阶段耗时、超分 fps、输出 ffprobe 结果）
