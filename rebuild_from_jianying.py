# rebuild_from_jianying.py
# Approximate constant-speed reconstruction from edit anchors inferred from a rendered video.
#
# 原理：
#   1. 从原视频和剪映成品各抽缩略图（1fps，同帧率采样，缩放一致），用 dHash
#      把成品的每一秒在整条原视频里找全局最佳匹配帧，得到锚点
#   2. 每张成品帧都独立匹配（不分窗口），无匹配的秒自动跳过 → 不丢素材
#   3. 相邻锚点间的斜率 = 变速倍率；倍率相近的连续锚点合并成段，段间即剪切点
#   4. 对原视频逐段切割 + 变速（setpts + atempo）+ 拼接，输出新文件
#
# 用法: python rebuild_from_jianying.py --src 原视频 --mod 剪映成品 --out 输出.mp4
# Output: an approximation of the edit; speed-adjusted segments are re-encoded.

import argparse
import os
import shutil
import subprocess
import sys
import time

CREATE_NO_WINDOW = 0x08000000
SAMPLE_INTERVAL = 1.0
MIN_RATE = 0.4
MAX_RATE = 2.5


def log(msg):
    print(time.strftime("[%H:%M:%S] ") + msg, flush=True)


def run(cmd, **kw):
    return subprocess.run(cmd, creationflags=CREATE_NO_WINDOW,
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          text=True, encoding="utf-8", errors="replace", **kw)


def normalized_path(path):
    return os.path.normcase(os.path.realpath(os.path.abspath(path)))


def is_path_within(parent, child):
    parent = normalized_path(parent)
    child = normalized_path(child)
    try:
        return os.path.commonpath([parent, child]) == parent
    except ValueError:
        return False


def is_filesystem_root(path):
    path = normalized_path(path)
    return os.path.dirname(path) == path


def validate_work_dir(work, protected_paths):
    if is_filesystem_root(work):
        raise ValueError("--work cannot be a filesystem root")
    for label, path in protected_paths:
        if is_path_within(work, path):
            raise ValueError(
                f"--work must be a dedicated temporary directory and cannot contain {label}"
            )
    if not os.path.lexists(work):
        return
    is_junction = getattr(os.path, "isjunction", lambda _: False)
    if os.path.islink(work) or is_junction(work):
        raise ValueError("--work cannot be a symbolic link or junction")
    if not os.path.isdir(work):
        raise ValueError(f"--work is not a directory: {work}")
    try:
        with os.scandir(work) as entries:
            if next(entries, None) is not None:
                raise ValueError("--work must be new or empty because it is deleted during processing")
    except OSError as exc:
        raise ValueError(f"Cannot inspect --work: {exc}") from exc


def resolve_paths(src, mod, out, work):
    src = os.path.abspath(src)
    mod = os.path.abspath(mod)
    out = os.path.abspath(out)

    for label, path in (("--src", src), ("--mod", mod)):
        if not os.path.isfile(path):
            raise ValueError(f"{label} must be an existing file: {path}")
    if normalized_path(out) in {normalized_path(src), normalized_path(mod)}:
        raise ValueError("--out must be different from --src and --mod")

    out_dir = os.path.dirname(out)
    os.makedirs(out_dir, exist_ok=True)
    work = os.path.abspath(work) if work else os.path.join(out_dir, ".rebuild")
    validate_work_dir(work, (("--src", src), ("--mod", mod), ("--out", out)))
    return src, mod, out, work


def probe_duration(video):
    r = run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", video])
    try:
        return float((r.stdout or "0").strip().splitlines()[0])
    except (ValueError, IndexError):
        return 0.0


def probe_fps(video):
    r = run(["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=r_frame_rate,avg_frame_rate",
             "-of", "csv=p=0", video])
    rate = (r.stdout or "").strip().splitlines()[0]
    num, _, den = rate.split("/")
    return int(num or 0), int(den or 1)


def has_audio_stream(video):
    r = run(["ffprobe", "-v", "error", "-select_streams", "a:0",
             "-show_entries", "stream=index", "-of", "csv=p=0", video])
    return r.returncode == 0 and bool((r.stdout or "").strip())


def atempo_filters(rate):
    factors = []
    while rate < 0.5:
        factors.append(0.5)
        rate /= 0.5
    while rate > 100.0:
        factors.append(100.0)
        rate /= 100.0
    factors.append(rate)
    return ",".join(f"atempo={factor:.6f}" for factor in factors)


def is_nonempty_file(path):
    return os.path.isfile(path) and os.path.getsize(path) > 0


def encode_part(src, output, start, duration, rate, has_audio):
    cmd = ["ffmpeg", "-y", "-nostats", "-loglevel", "error", "-i", src]
    video_filter = (
        f"trim=start={start:.6f}:duration={duration:.6f},"
        f"setpts=(PTS-STARTPTS)/{rate:.6f}"
    )
    if has_audio:
        cmd += [
            "-filter_complex",
            f"[0:v]{video_filter}[v];"
            f"[0:a]atrim=start={start:.6f}:duration={duration:.6f},"
            f"asetpts=PTS-STARTPTS,{atempo_filters(rate)}[a]",
            "-map", "[v]", "-map", "[a]",
        ]
    else:
        cmd += ["-vf", video_filter, "-map", "0:v:0", "-an"]
    cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
            "-pix_fmt", "yuv420p"]
    if has_audio:
        cmd += ["-c:a", "aac", "-b:a", "192k"]
    cmd.append(output)
    return run(cmd)


def extract_thumbs(video, outdir, rate=1.0):
    """抽视频缩略图，rate=每秒张数，返回张数"""
    os.makedirs(outdir, exist_ok=True)
    r = run(["ffmpeg", "-y", "-nostats", "-loglevel", "error",
             "-i", video,
             "-vf", f"fps={rate},scale=96:54",
             "-qscale:v", "3",
             os.path.join(outdir, "t_%08d.jpg")])
    return len([f for f in os.listdir(outdir) if f.endswith(".jpg")])


def dhash(path, size=8):
    from PIL import Image
    img = Image.open(path).convert("L").resize((size + 1, size), Image.LANCZOS)
    px = list(img.getdata())
    h = 0
    for row in range(size):
        for col in range(size):
            h <<= 1
            if px[row * (size + 1) + col] > px[row * (size + 1) + col + 1]:
                h |= 1
    return h


def hamming(a, b):
    return bin(a ^ b).count("1")


def find_anchors(src, mod, work):
    """抽缩略图 + dHash 匹配，返回锚点列表 [(mod_time_s, src_time_s)]
    src/mod 各抽 1fps 缩略图；成品每一秒在整条原视频里找全局汉明距离最小帧。
    每张独立匹配（不分窗口），>6 秒无匹配才判为丢帧；无匹配的秒自动跳过。"""
    d_src = os.path.join(work, "src")
    d_mod = os.path.join(work, "mod")
    for d in (d_src, d_mod):
        shutil.rmtree(d, ignore_errors=True)
    log(f"抽缩略图 (原 1fps, 成品 1fps, 缩放 96x54)...")
    ns = extract_thumbs(src, d_src, 1.0)
    nm = extract_thumbs(mod, d_mod, 1.0)
    log(f"  原 {ns} 张, 成品 {nm} 张")

    from PIL import Image
    log("计算 dHash + 匹配...")
    src_files = sorted([f for f in os.listdir(d_src) if f.endswith(".jpg")])
    src_hash = []
    for f in src_files:
        src_hash.append(dhash(os.path.join(d_src, f)))

    mod_files = sorted([f for f in os.listdir(d_mod) if f.endswith(".jpg")])
    anchors = []       # [(mod_time_s, src_time_s)]
    miss_count = 0
    for i, f in enumerate(mod_files):
        mh = dhash(os.path.join(d_mod, f))
        best_i, best_d = min(
            ((j, hamming(mh, h)) for j, h in enumerate(src_hash)),
            key=lambda kv: kv[1])
        if best_d < 8:
            anchors.append((i, best_i))
            miss_count = 0
        else:
            miss_count += 1
            if miss_count > 6:   # 连续 6 秒无匹配 = 真正断开，重置后续时间轴
                anchors.append((i, None))
                miss_count = 0
    log(f"  匹配到 {sum(1 for a in anchors if a[1] is not None)}/{len(anchors)} 个锚点")
    return anchors


def linfit(xs, ys):
    """线性回归，返回 (斜率, 截距)。斜率即变速倍率。"""
    n = len(xs)
    mx = sum(xs) / n
    my = sum(ys) / n
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    var = sum((x - mx) ** 2 for x in xs)
    if var <= 0:
        return 0.0, my
    slope = cov / var
    return slope, my - slope * mx


def build_segments(anchors, src_duration, mod_duration):
    """把锚点聚成段。锚点: [(mod_time_s, src_time_s)]（秒级，1fps 采样）。

    算法：贪心扩展 + 线性回归。对当前段做回归求整体倍率(斜率)，允许至多
    25% 的锚点离群（动画运动帧匹配抖动），其余锚点残差 ≤0.8s 则并入；
    否则闭合当前段、开新段。段间即剪切点，段倍率 = 段内锚点回归斜率。
    """
    if not anchors:
        return []
    pts = sorted((m, s) for m, s in anchors if s is not None)
    if len(pts) < 2:
        return []

    segs = []
    i = 0
    while i < len(pts):
        j = i + 2  # 段至少 2 个锚点
        while j < len(pts):
            xs = [p[0] for p in pts[i:j + 1]]
            ys = [p[1] for p in pts[i:j + 1]]
            a, b = linfit(xs, ys)
            res = [abs(y - (a * x + b)) for x, y in zip(xs, ys)]
            n = len(res)
            # 允许 25% 锚点离群（残差≤0.8s），其余必须贴合回归线
            ok = sum(1 for r in res if r <= 0.8)
            if (n - ok) > n * 0.25 or not (MIN_RATE <= a <= MAX_RATE):
                break
            j += 1
        if j > len(pts):
            j = len(pts)
        if j - i >= 2:
            xs = [p[0] for p in pts[i:j]]
            ys = [p[1] for p in pts[i:j]]
            a, b = linfit(xs, ys)
            mod_start = pts[i][0]
            mod_end = pts[j - 1][0] + SAMPLE_INTERVAL
            segs.append((mod_start, mod_end,
                         a * mod_start + b, a * mod_end + b, a))
        if j <= i:
            break
        i = j

    # 输出段：剔除倍率不合理的段
    result = []
    for m0, m1, s0, s1, rate in segs:
        if MIN_RATE <= rate <= MAX_RATE:
            m1 = min(m1, mod_duration)
            s0 = max(0.0, s0)
            s1 = min(src_duration, s0 + rate * (m1 - m0))
            if s1 <= s0:
                continue
            # Keep the encoded source interval and output timeline in sync after clipping.
            m1 = min(m1, m0 + (s1 - s0) / rate)
            if m1 <= m0:
                continue
            result.append({
                "mod_start": m0, "mod_end": m1,
                "src_start": s0, "src_end": s1,
                "rate": rate,
            })
    return result


def rebuild(src, mod, out, work):
    src_dur = probe_duration(src)
    mod_dur = probe_duration(mod)
    src_fn, src_fd = probe_fps(src)
    mod_fn, mod_fd = probe_fps(mod)
    log(f"原: {src_dur:.1f}s {src_fn}/{src_fd}fps")
    log(f"成品: {mod_dur:.1f}s {mod_fn}/{mod_fd}fps")

    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work, exist_ok=True)

    anchors = find_anchors(src, mod, work)
    matched = sum(1 for a in anchors if a[1] is not None)
    if matched < 5:
        log("[错误] 匹配锚点太少，无法重建")
        return False

    segments = build_segments(anchors, src_dur, mod_dur)
    if not segments:
        log(f"[错误] 未识别到支持范围 {MIN_RATE:.1f}x-{MAX_RATE:.1f}x 的连续片段")
        return False
    normalize_segments = any(abs(s["rate"] - 1.0) > 0.01 for s in segments)
    source_has_audio = has_audio_stream(src)
    if normalize_segments:
        log("检测到变速片段；将全部片段统一编码为 H.264/AAC 后再拼接")
    log(f"识别到 {len(segments)} 段:")
    total_mod = 0
    for i, s in enumerate(segments):
        total_mod += s["mod_end"] - s["mod_start"]
        log(f"  段{i+1}: 成品 {s['mod_start']:.1f}-{s['mod_end']:.1f}s "
            f"= 原 {s['src_start']:.1f}-{s['src_end']:.1f}s, 倍率 {s['rate']:.3f}x")
    log(f"成品覆盖 {total_mod:.1f}s / {mod_dur:.1f}s")

    # 逐段：从原视频切出源区间 -> 变速 -> 写中间文件
    clip_parts = []
    for i, s in enumerate(segments):
        src_start = s["src_start"]
        src_len = s["src_end"] - s["src_start"]
        if src_len <= 0:
            log(f"    [错误] 段{i+1} 的源时长无效")
            return False
        log(f"  段{i+1}: 切割原 {src_start:.1f}-{src_start+src_len:.1f}s...")
        if normalize_segments:
            encoded_part = os.path.join(work, f"enc{i+1:02d}.ts")
            if abs(s["rate"] - 1.0) > 0.01:
                log(f"    变速 {s['rate']:.3f}x...")
            r = encode_part(src, encoded_part, src_start, src_len,
                            s["rate"], source_has_audio)
            if r.returncode != 0 or not is_nonempty_file(encoded_part):
                log(f"    [错误] 编码失败: {r.stdout[-300:]}")
                return False
            clip_parts.append(encoded_part)
        else:
            # No speed adjustment: retain the source codec through stream copy.
            part = os.path.join(work, f"part{i+1:02d}.ts")
            r = run(["ffmpeg", "-y", "-nostats", "-loglevel", "error",
                     "-ss", f"{src_start:.3f}", "-t", f"{src_len:.3f}",
                     "-i", src, "-c", "copy", part])
            if r.returncode != 0 or not is_nonempty_file(part):
                log(f"    [错误] 切割失败: {r.stdout[-300:]}")
                return False
            clip_parts.append(part)
    log(f"全部 {len(clip_parts)} 段切割+变速完成，拼接中...")

    # 3) 拼接所有段
    concat_file = os.path.join(work, "concat.txt")
    with open(concat_file, "w", encoding="utf-8") as f:
        for p in clip_parts:
            f.write(f"file '{p.replace(chr(39), chr(39)+chr(92)+chr(39)+chr(39))}'\n")
    r = run(["ffmpeg", "-y", "-nostats", "-loglevel", "error",
             "-f", "concat", "-safe", "0", "-i", concat_file,
             "-c", "copy", out])
    if r.returncode != 0 or not is_nonempty_file(out):
        log(f"[错误] 拼接失败: {r.stdout[-300:]}")
        return False

    # 清理
    shutil.rmtree(work, ignore_errors=True)
    sz = os.path.getsize(out) / 1048576
    log(f"完成: {out} ({sz:.1f} MB)")
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--src", required=True, help="原视频")
    parser.add_argument("--mod", required=True, help="剪映成品")
    parser.add_argument("--out", required=True, help="输出文件")
    parser.add_argument("--work",
                        help="Temporary directory; defaults to <output-parent>\\.rebuild and is deleted")
    args = parser.parse_args()
    try:
        src, mod, out, work = resolve_paths(args.src, args.mod, args.out, args.work)
    except ValueError as exc:
        parser.error(str(exc))
    ok = rebuild(src, mod, out, work)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
