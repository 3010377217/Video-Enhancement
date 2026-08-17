# process_videos.py
# Batch pipeline: resize -> Real-ESRGAN 2x -> RIFE interpolation -> HEVC NVENC.
# Input and output directories are provided on the command line.
# Each chunk is encoded as a segment so temporary frame storage stays bounded.
# --chunk 0 keeps the whole-video path for comparison and troubleshooting.

import argparse
import csv
import json
import math
import os
import shutil
import subprocess
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ESRGAN = None
RIFE = None
RIFE_MODEL = None
MODEL = "realesr-animevideov3"
SCALE = 2
ENCODER = "hevc_nvenc"   # H.265 硬件编码（实测 cq27 全场体积最优，44MB vs h264 46.4MB）
ENC_ARGS = ["-rc", "vbr", "-cq", "27", "-preset", "p6", "-b:v", "0"]
TARGET_FACTOR = 2.5   # 24fps -> 60fps

# 分块大小：每块抽 CHUNK 个输入帧（+1 重叠帧保证块边界原帧连续）。
# 磁盘峰值估算（1000 帧块）：in 44MB + up 350MB + rife 830MB ≈ 1.2GB（整段一次性 ≈ 12GB）
CHUNK = 1000

SRC_DIR = None
OUT_DIR = None
WORK = None

# Explicit user-supplied input file names to skip.
SKIP_NAMES = set()

# 统一先缩放到 640x360（1280x720 的一半），2x 超分后输出统一为 1280x720
SCALE_STR = "640:360"

CREATE_NO_WINDOW = 0x08000000
LOG = None
TIMINGS = None
TIMING_HEADER = [
    "name",
    "source_duration_s",
    "input_frames",
    "output_frames",
    "extract_s",
    "upscale_s",
    "rife_s",
    "encode_s",
    "total_s",
    "output_mb",
    "status",
    "finished_at",
]


def log(msg):
    line = time.strftime("[%H:%M:%S] ") + msg
    print(line, flush=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def run(cmd, **kw):
    return subprocess.run(cmd, creationflags=CREATE_NO_WINDOW,
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          text=True, encoding="utf-8", errors="replace",
                          **kw)


def normalized_path(path):
    return os.path.normcase(os.path.realpath(os.path.abspath(path)))


def is_path_within(parent, child):
    """Return whether child is parent itself or is contained by parent."""
    parent = normalized_path(parent)
    child = normalized_path(child)
    try:
        return os.path.commonpath([parent, child]) == parent
    except ValueError:
        return False


def is_filesystem_root(path):
    path = normalized_path(path)
    return os.path.dirname(path) == path


def validate_work_dir(work_dir, src_dir, out_dir):
    if is_filesystem_root(work_dir):
        raise ValueError("--work-dir cannot be a filesystem root")
    if is_path_within(work_dir, src_dir) or is_path_within(work_dir, out_dir):
        raise ValueError(
            "--work-dir must be a dedicated temporary directory and cannot contain "
            "the input or output directory"
        )
    if not os.path.lexists(work_dir):
        return
    is_junction = getattr(os.path, "isjunction", lambda _: False)
    if os.path.islink(work_dir) or is_junction(work_dir):
        raise ValueError("--work-dir cannot be a symbolic link or junction")
    if not os.path.isdir(work_dir):
        raise ValueError(f"--work-dir is not a directory: {work_dir}")
    try:
        with os.scandir(work_dir) as entries:
            if next(entries, None) is not None:
                raise ValueError("--work-dir must be new or empty because it is deleted after processing")
    except OSError as exc:
        raise ValueError(f"Cannot inspect --work-dir: {exc}") from exc


def configure_paths(args):
    global ESRGAN, RIFE, RIFE_MODEL, SRC_DIR, OUT_DIR, WORK, LOG, TIMINGS, SKIP_NAMES

    src_dir = os.path.abspath(args.src_dir)
    out_dir = os.path.abspath(args.out_dir)
    work_dir = os.path.abspath(args.work_dir or os.path.join(out_dir, ".work"))

    if not os.path.isdir(src_dir):
        raise ValueError(f"Input directory does not exist: {src_dir}")
    if normalized_path(src_dir) == normalized_path(out_dir):
        raise ValueError("--src-dir and --out-dir must be different directories")
    if os.path.exists(out_dir) and not os.path.isdir(out_dir):
        raise ValueError(f"Output path is not a directory: {out_dir}")
    validate_work_dir(work_dir, src_dir, out_dir)

    SRC_DIR = src_dir
    OUT_DIR = out_dir
    WORK = work_dir
    LOG = os.path.join(OUT_DIR, "process.log")
    TIMINGS = os.path.join(OUT_DIR, "timings.csv")
    SKIP_NAMES = set(args.skip_name)
    ESRGAN = os.path.abspath(args.esrgan)
    RIFE = os.path.abspath(args.rife)
    RIFE_MODEL = os.path.abspath(args.rife_model)


def validate_tools():
    missing = []
    for label, path, check in (
        ("Real-ESRGAN executable", ESRGAN, os.path.isfile),
        ("RIFE executable", RIFE, os.path.isfile),
        ("RIFE model directory", RIFE_MODEL, os.path.isdir),
    ):
        if not check(path):
            missing.append(f"{label}: {path}")
    if missing:
        raise FileNotFoundError("\n".join(missing))


def is_nonempty_file(path):
    return os.path.isfile(path) and os.path.getsize(path) > 0


def clear_output(path):
    if not os.path.lexists(path):
        return
    if os.path.isdir(path):
        raise RuntimeError(f"Output path is a directory: {path}")
    os.remove(path)


def ffconcat_path(path):
    return path.replace(os.sep, "/").replace("'", r"'\''")


def duration_of(path):
    r = run(["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "format=duration", "-of", "csv=p=0", path])
    try:
        return float((r.stdout or "0").strip().splitlines()[0])
    except (ValueError, IndexError):
        return 0.0


def list_videos_sorted_by_duration():
    names = [f for f in os.listdir(SRC_DIR) if f.lower().endswith(".mp4")]
    items = []
    for name in names:
        dur = duration_of(os.path.join(SRC_DIR, name))
        items.append((dur, name))
    items.sort(key=lambda x: (x[0], x[1]))
    return items


def save_timing(row):
    new = not os.path.isfile(TIMINGS)
    with open(TIMINGS, "a", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=TIMING_HEADER)
        if new:
            w.writeheader()
        w.writerow(row)


def probe(src):
    r = run(["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=r_frame_rate,avg_frame_rate,nb_frames",
             "-show_entries", "format=duration",
             "-of", "json", src])
    j = json.loads(r.stdout or "{}")
    s = (j.get("streams") or [{}])[0]
    rate = s.get("r_frame_rate") or s.get("avg_frame_rate") or "0/1"
    num, _, den = rate.partition("/")
    num = int(num or 0)
    den = int(den or 1)
    nb = s.get("nb_frames")
    try:
        total = int(nb) if nb and nb not in ("N/A", "0") else 0
    except ValueError:
        total = 0
    dur = 0.0
    try:
        dur = float(j.get("format", {}).get("duration") or 0)
    except ValueError:
        pass
    if not total and num and dur:
        total = int(round(num / den * dur))
    return num, den, total


def probe_res(src):
    """返回源视频宽高 (w, h)；失败返回 (0, 0)。"""
    r = run(["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height",
             "-of", "csv=p=0", src])
    parts = (r.stdout or "").strip().split(",")
    try:
        return int(parts[0]), int(parts[1])
    except (ValueError, IndexError):
        return 0, 0


def is_4x3(src):
    """640x480 等 4:3 源 -> True（这些输出 960x720 保持比例）"""
    w, h = probe_res(src)
    if not w or not h:
        return False
    return abs(w / h - 4 / 3) < 0.03


def count_files(d):
    if not os.path.isdir(d):
        return 0
    return sum(1 for _ in os.listdir(d))


def rm(path):
    if os.path.isdir(path):
        shutil.rmtree(path, ignore_errors=True)
    elif os.path.isfile(path):
        try:
            os.remove(path)
        except OSError:
            pass


def process_one(src, out, index, total, chunk):
    log(f"[{index}/{total}] ==== {os.path.basename(src)} ====")
    clear_output(out)
    fn, fd, total_frames = probe(src)
    if fn == 0:
        log(f"  [跳过] 无法读取帧率: {src}")
        return False
    new_fps_num = int(round(fn * TARGET_FACTOR))
    log(f"  输入: {fn}/{fd} fps, 约 {total_frames} 帧  -> 输出 {new_fps_num}/{fd} fps")
    src_dur = duration_of(src)

    # 按画面比例选缩放尺寸：4:3 源缩到 480x360 -> 2x 输出 960x720（保持比例）；
    # 16:9 源缩到 640x360 -> 2x 输出 1280x720（统一）
    if is_4x3(src):
        scale_str = "480:360"
        out_wh = "960x720"
    else:
        scale_str = SCALE_STR
        out_wh = "1280x720"
    log(f"  缩放目标 {scale_str} -> 超分 2x -> {out_wh}")

    if chunk <= 0:
        return process_one_full(src, out, scale_str, new_fps_num, fd, src_dur)

    # ---- 分块处理：限制磁盘峰值（每块只有 ~1.2GB 中间帧） ----
    indir = os.path.join(WORK, "in")
    updir = os.path.join(WORK, "up")
    rifedir = os.path.join(WORK, "rife")
    segdir = os.path.join(WORK, "seg")
    for d in (indir, updir, rifedir, segdir):
        rm(d)
    os.makedirs(indir, exist_ok=True)
    os.makedirs(segdir, exist_ok=True)
    seglist = os.path.join(WORK, "segments.txt")

    extract_s = upscale_s = rife_s = encode_s = 0.0
    total_in = total_out = 0
    segs = []
    n_chunks = max(1, math.ceil(total_frames / chunk)) if total_frames else 0
    with open(seglist, "w", encoding="utf-8") as sl:
        start_idx = 0
        chunk_n = 1
        while True:
            os.makedirs(indir, exist_ok=True)
            t_stage = time.monotonic()
            # stime 必须是 start_idx 帧的精确时间（帧级对齐，勿加 0.5：实测会跳过一帧）
            stime = start_idx * fd / fn
            r = run(["ffmpeg", "-y", "-nostats", "-loglevel", "error",
                     "-i", src, "-ss", f"{stime:.6f}", "-frames:v", str(chunk),
                     "-vf", f"scale={scale_str}:flags=lanczos",
                     "-qscale:v", "2", os.path.join(indir, "f_%08d.jpg")])
            cnt = count_files(indir)
            if cnt == 0:
                log(f"  分块 {chunk_n-1}/{n_chunks or '?'}: 已到视频末尾，结束")
                break
            extract_s += time.monotonic() - t_stage
            total_in += cnt
            log(f"  [{chunk_n}/{n_chunks or '?'}] 抽帧 {cnt} @{stime:.3f}s")

            # ESRGAN 2x
            os.makedirs(updir, exist_ok=True)
            t_stage = time.monotonic()
            r = run([ESRGAN, "-i", indir, "-o", updir,
                     "-n", MODEL, "-s", str(SCALE), "-f", "jpg"])
            upscale_s += time.monotonic() - t_stage
            upcnt = count_files(updir)
            if r.returncode != 0 or upcnt == 0:
                log(f"  [错误] 超分输出为空 (exit {r.returncode})")
                return False
            rm(indir)

            # RIFE 补帧到 2.5x
            os.makedirs(rifedir, exist_ok=True)
            tgt = int(round(upcnt * TARGET_FACTOR))
            t_stage = time.monotonic()
            r = run([RIFE, "-i", updir, "-o", rifedir, "-m", RIFE_MODEL,
                     "-n", str(tgt), "-f", "f_%08d.jpg"])
            rife_s += time.monotonic() - t_stage
            rcnt = count_files(rifedir)
            if r.returncode != 0 or rcnt == 0:
                log(f"  [错误] RIFE 输出为空 (exit {r.returncode})")
                return False
            rm(updir)
            total_out += rcnt

            # 编码当前块为 seg（纯视频；-g 250 + 强制首帧 IDR，保证 concat 无缝 + 快进正常）
            seg = os.path.join(segdir, f"seg_{chunk_n:04d}.mp4")
            t_stage = time.monotonic()
            r = run(["ffmpeg", "-y", "-nostats", "-loglevel", "error",
                     "-framerate", f"{new_fps_num}/{fd}", "-start_number", "1",
                     "-i", os.path.join(rifedir, "f_%08d.jpg"),
                     "-c:v", ENCODER, *ENC_ARGS, "-g", "250", "-sc_threshold", "0",
                     "-pix_fmt", "yuv420p", "-an", seg])
            encode_s += time.monotonic() - t_stage
            rm(rifedir)
            if r.returncode != 0 or not is_nonempty_file(seg):
                log(f"  [错误] 分片编码失败 (exit {r.returncode})")
                return False
            sl.write(f"file '{ffconcat_path(seg)}'\n")
            sl.flush()
            segs.append(seg)
            log(f"  [{chunk_n}/{n_chunks or '?'}] seg {cnt}->{rcnt} 帧，编码完成")
            start_idx += cnt
            chunk_n += 1

    if not segs:
        log("  [错误] 没有抽到任何帧")
        return False

    # concat 所有 seg -> concat.mp4（-c copy 无缝）
    concat = os.path.join(WORK, "concat.mp4")
    t_stage = time.monotonic()
    r = run(["ffmpeg", "-y", "-nostats", "-loglevel", "error",
             "-f", "concat", "-safe", "0", "-i", seglist,
             "-c", "copy", concat])
    encode_s += time.monotonic() - t_stage
    if r.returncode != 0 or not is_nonempty_file(concat):
        log(f"  [错误] 合并分片失败 (exit {r.returncode})")
        return False

    # 混音（视频流 -c copy，音频从源取）
    t_stage = time.monotonic()
    r = run(["ffmpeg", "-y", "-nostats", "-loglevel", "error",
             "-i", concat, "-i", src,
             "-map", "0:v", "-map", "1:a?",
             "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", out])
    encode_s += time.monotonic() - t_stage
    if r.returncode != 0 or not is_nonempty_file(out):
        clear_output(out)
        log(f"  [错误] 输出失败 (exit {r.returncode})")
        return False
    sz = os.path.getsize(out) / 1048576
    total_s = extract_s + upscale_s + rife_s + encode_s
    save_timing({
        "name": os.path.basename(src),
        "source_duration_s": round(src_dur, 2),
        "input_frames": total_in,
        "output_frames": total_out,
        "extract_s": round(extract_s, 2),
        "upscale_s": round(upscale_s, 2),
        "rife_s": round(rife_s, 2),
        "encode_s": round(encode_s, 2),
        "total_s": round(total_s, 2),
        "output_mb": round(sz, 2),
        "status": "ok",
        "finished_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    })
    log(f"  完成: {out} ({sz:.1f} MB)")
    log(f"  耗时: 抽帧+缩放 {extract_s:.1f}s / 超分 {upscale_s:.1f}s / "
        f"补帧 {rife_s:.1f}s / 编码+拼接 {encode_s:.1f}s / 总 {total_s:.1f}s")
    return True


def process_one_full(src, out, scale_str, new_fps_num, fd, src_dur):
    """--chunk 0 的旧逻辑：整段一次性处理（用于对比回归）。"""
    indir = os.path.join(WORK, "in")
    rifedir = os.path.join(WORK, "rife")
    updir = os.path.join(WORK, "up")
    for d in (indir, rifedir, updir):
        rm(d)
    os.makedirs(indir, exist_ok=True)

    # 1) 抽全部帧 + 缩放到目标尺寸（一步完成）
    t_stage = time.monotonic()
    r = run(["ffmpeg", "-y", "-nostats", "-loglevel", "error", "-i", src,
             "-vf", f"scale={scale_str}:flags=lanczos",
             "-qscale:v", "2", os.path.join(indir, "f_%08d.jpg")])
    extract_s = time.monotonic() - t_stage
    cnt = count_files(indir)
    if r.returncode != 0 or cnt == 0:
        log("  [错误] 抽帧失败")
        return False
    log(f"  抽帧 {cnt}，耗时 {extract_s:.1f}s")

    # 2) ESRGAN 2x 超分
    os.makedirs(updir, exist_ok=True)
    t_stage = time.monotonic()
    r = run([ESRGAN, "-i", indir, "-o", updir,
             "-n", MODEL, "-s", str(SCALE), "-f", "jpg"])
    upscale_s = time.monotonic() - t_stage
    upcnt = count_files(updir)
    if r.returncode != 0 or upcnt == 0:
        log(f"  [错误] 超分输出为空 (exit {r.returncode})")
        return False
    log(f"  超分 {upcnt} 帧，耗时 {upscale_s:.1f}s")
    rm(indir)

    # 3) RIFE 补帧到 2.5x
    os.makedirs(rifedir, exist_ok=True)
    tgt = int(round(upcnt * TARGET_FACTOR))
    t_stage = time.monotonic()
    r = run([RIFE, "-i", updir, "-o", rifedir, "-m", RIFE_MODEL,
             "-n", str(tgt), "-f", "f_%08d.jpg"])
    rife_s = time.monotonic() - t_stage
    rcnt = count_files(rifedir)
    if r.returncode != 0 or rcnt == 0:
        log(f"  [错误] RIFE 输出为空 (exit {r.returncode})")
        return False
    log(f"  补帧后 {rcnt} 帧，耗时 {rife_s:.1f}s")
    rm(updir)

    # 4) 编码 + 混音
    t_stage = time.monotonic()
    r = run(["ffmpeg", "-y", "-nostats", "-loglevel", "error",
             "-framerate", f"{new_fps_num}/{fd}", "-start_number", "1",
             "-i", os.path.join(rifedir, "f_%08d.jpg"),
             "-i", src,
             "-map", "0:v", "-map", "1:a?",
             "-c:v", ENCODER, *ENC_ARGS, "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "160k", "-shortest", out])
    encode_s = time.monotonic() - t_stage
    rm(rifedir)
    if r.returncode != 0 or not is_nonempty_file(out):
        clear_output(out)
        log(f"  [错误] 输出失败 (exit {r.returncode})")
        return False
    sz = os.path.getsize(out) / 1048576
    total_s = extract_s + upscale_s + rife_s + encode_s
    save_timing({
        "name": os.path.basename(src),
        "source_duration_s": round(src_dur, 2),
        "input_frames": cnt,
        "output_frames": rcnt,
        "extract_s": round(extract_s, 2),
        "upscale_s": round(upscale_s, 2),
        "rife_s": round(rife_s, 2),
        "encode_s": round(encode_s, 2),
        "total_s": round(total_s, 2),
        "output_mb": round(sz, 2),
        "status": "ok",
        "finished_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    })
    log(f"  完成: {out} ({sz:.1f} MB)")
    log(f"  耗时: 抽帧+缩放 {extract_s:.1f}s / 超分 {upscale_s:.1f}s / "
        f"补帧 {rife_s:.1f}s / 编码 {encode_s:.1f}s / 总 {total_s:.1f}s")
    return True


def main():
    default_esrgan = os.path.join(SCRIPT_DIR, "realesrgan-ncnn-vulkan.exe")
    default_rife = os.path.join(
        SCRIPT_DIR, "rife-ncnn-vulkan-20221029-windows", "rife-ncnn-vulkan.exe"
    )
    default_rife_model = os.path.join(
        SCRIPT_DIR, "rife-ncnn-vulkan-20221029-windows", "rife-v4.6"
    )
    parser = argparse.ArgumentParser(description="Batch upscale and interpolate MP4 videos")
    parser.add_argument("--src-dir", required=True, metavar="DIR",
                        help="Directory containing input MP4 files")
    parser.add_argument("--out-dir", required=True, metavar="DIR",
                        help="Directory for processed videos, logs, and timings")
    parser.add_argument("--work-dir", metavar="DIR",
                        help="Temporary directory; defaults to <out-dir>\\.work")
    parser.add_argument("--esrgan", default=default_esrgan, metavar="PATH",
                        help="Path to realesrgan-ncnn-vulkan.exe")
    parser.add_argument("--rife", default=default_rife, metavar="PATH",
                        help="Path to rife-ncnn-vulkan.exe")
    parser.add_argument("--rife-model", default=default_rife_model, metavar="DIR",
                        help="Path to the RIFE model directory")
    parser.add_argument("--skip-name", action="append", default=[], metavar="FILE",
                        help="Input filename to skip; may be passed more than once")
    parser.add_argument("--limit", type=int, default=0,
                        help="Maximum videos to process; 0 means no limit")
    parser.add_argument("--dry-run", action="store_true",
                        help="List input files by duration without processing")
    parser.add_argument("--no-skip", action="store_true",
                        help="Process files even when an output exists or --skip-name was supplied")
    parser.add_argument("--chunk", type=int, default=CHUNK,
                        help=f"Input frames per chunk; 0 processes a whole video (default: {CHUNK})")
    args = parser.parse_args()
    try:
        configure_paths(args)
    except ValueError as exc:
        parser.error(str(exc))

    videos = list_videos_sorted_by_duration()
    if args.dry_run:
        for i, (dur, name) in enumerate(videos, 1):
            print(f"{i:3d}  {dur:8.2f}s  {name}", flush=True)
        return

    try:
        validate_tools()
    except FileNotFoundError as exc:
        parser.error(str(exc))

    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(WORK, exist_ok=True)
    ok = 0
    attempted = 0
    for i, (_, name) in enumerate(videos, 1):
        src = os.path.join(SRC_DIR, name)
        out = os.path.join(OUT_DIR, name)
        if not os.path.isfile(src):
            log(f"[跳过] 源文件不存在: {name}")
            continue
        if not args.no_skip and name in SKIP_NAMES:
            log(f"[{i}/{len(videos)}] [跳过] 已确认完成: {name}")
            continue
        if not args.no_skip and os.path.isfile(out) and os.path.getsize(out) > 0:
            log(f"[{i}/{len(videos)}] [跳过] 输出已存在: {name}")
            continue
        try:
            if process_one(src, out, i, len(videos), args.chunk):
                ok += 1
        except Exception as e:
            import traceback
            log(f"[异常] {name}: {e}\n{traceback.format_exc()}")
        attempted += 1
        if args.limit and attempted >= args.limit:
            log(f"达到本批上限 {args.limit}，剩余 {len(videos) - i} 个待处理")
            break
    rm(WORK)
    done_outputs = sum(1 for _, name in videos
                       if os.path.isfile(os.path.join(OUT_DIR, name)))
    log(f"全部结束: 本批 {attempted} 个处理，{ok} 成功；输出目录已有 {done_outputs} 个文件")


if __name__ == "__main__":
    main()
