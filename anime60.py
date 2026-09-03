#!/usr/bin/env python3
"""anime60 - Anime video enhancement: downscale -> 2x super-resolution -> 2x frame interpolation -> mux audio.

Output: <source>_60fps.mp4 (source resolution, 60 fps, audio preserved).

Usage:
    python anime60.py <input_video> [--workdir DIR] [--keep-temp]

Only Python standard library is used (subprocess / os / re / sys / json / time).
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
REALESRGAN = os.path.join(ROOT, "realesrgan-ncnn-vulkan.exe")
RIFE_EXE = os.path.join(ROOT, "rife-ncnn-vulkan-20221029-windows", "rife-ncnn-vulkan.exe")
RIFE_MODEL = os.path.join(ROOT, "rife-ncnn-vulkan-20221029-windows", "rife-v4.6")

SR_CHUNK = 1500   # frames per super-resolution chunk
RIFE_CHUNK = 1000  # frames per interpolation chunk


def die(msg):
    print(f"[anime60] ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def run(cmd, **kw):
    """Run a subprocess, raising on failure with the command shown."""
    printable = " ".join(f'"{c}"' if " " in c else c for c in cmd)
    r = subprocess.run(cmd, **kw)
    if r.returncode != 0:
        raise RuntimeError(f"command failed ({r.returncode}): {printable}")
    return r


def probe(src):
    """Return (width, height, fps_float, has_audio) via ffprobe."""
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate:stream_tags=",
         "-of", "json", src],
        capture_output=True, text=True)
    if r.returncode != 0:
        die(f"ffprobe failed on {src}: {r.stderr.strip()}")
    info = json.loads(r.stdout)
    if not info.get("streams"):
        die(f"no video stream found in {src}")
    st = info["streams"][0]
    w, h = st["width"], st["height"]
    num, den = st["r_frame_rate"].split("/")
    fps = float(num) / float(den)
    if fps <= 0:
        die(f"invalid frame rate for {src}")

    a = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
         "stream=index", "-of", "csv=p=0", src],
        capture_output=True, text=True)
    has_audio = a.returncode == 0 and a.stdout.strip() != ""
    return w, h, fps, has_audio


def frame_count(path):
    """Best-effort frame count: nb_frames, else duration * fps."""
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=nb_frames,duration", "-of", "json", path],
        capture_output=True, text=True)
    try:
        st = json.loads(r.stdout)["streams"][0]
        n = int(st.get("nb_frames", 0))
        if n > 0:
            return n
        d = float(st.get("duration", 0))
        if d > 0:
            return int(d * 24)  # rough fallback; refined later by fps
    except (KeyError, IndexError, ValueError, json.JSONDecodeError):
        pass
    return 0


class Stage:
    """Simple timer that prints stage duration and effective fps."""

    def __init__(self, name, expected_frames=0):
        self.name = name
        self.expected = expected_frames
        self.t0 = time.monotonic()

    def done(self, frames):
        dt = time.monotonic() - self.t0
        fps = frames / dt if dt > 0 else 0
        tail = f", {fps:.2f} fps" if frames > 0 else ""
        print(f"[anime60] stage '{self.name}' done: {frames} frames in {dt:.1f}s{tail}")


def clean_dir(path):
    if os.path.isdir(path):
        shutil.rmtree(path)
    os.makedirs(path, exist_ok=True)


def list_jpgs(d):
    return sorted(f for f in os.listdir(d) if f.lower().endswith(".jpg"))


def ffmpeg_extract(src, start_sec, n_frames, out_dir):
    """Extract up to n_frames starting at start_sec into out_dir as f_%08d.jpg.

    ffmpeg 8.x returns -22 when stepping past EOF with 0 frames extracted -
    that is the normal chunk-loop end condition, not an error.
    Returns the number of frames actually extracted.
    """
    cmd = ["ffmpeg", "-y", "-loglevel", "error",
           "-ss", f"{start_sec:.6f}", "-i", src,
           "-frames:v", str(n_frames),
           "-pix_fmt", "yuvj420p", "-qscale:v", "2",
           os.path.join(out_dir, "f_%08d.jpg")]
    r = subprocess.run(cmd, capture_output=True, text=True)
    n = len(list_jpgs(out_dir))
    if r.returncode not in (0, -22):
        raise RuntimeError(f"ffmpeg extract failed ({r.returncode}): {r.stderr.strip()}")
    return n


def encode_segment(frame_dir, fps_str, out_path, start_number=1, pattern="f_%08d.jpg"):
    run(["ffmpeg", "-y", "-loglevel", "error",
         "-start_number", str(start_number),
         "-framerate", fps_str, "-i", os.path.join(frame_dir, pattern),
         "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p",
         out_path])


def parse_realesrgan_progress(line):
    """Real-ESRGAN prints '12.34%' style lines; return float or None."""
    m = re.search(r"([0-9.]+)%", line)
    return float(m.group(1)) if m else None


def run_realesrgan(in_dir, out_dir, gpu=0, tile=0, threads=2):
    """Run Real-ESRGAN on a frame directory with a coarse percent progress line."""
    cmd = [REALESRGAN, "-i", in_dir, "-o", out_dir,
           "-n", "realesr-animevideov3", "-s", "2", "-f", "jpg",
           "-g", str(gpu)]
    if tile and tile > 0:
        cmd += ["-t", str(tile)]
    if threads and threads > 0:
        cmd += ["-j", f"{threads}:{threads}:{threads}"]
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        errors="replace", cwd=ROOT)
    last_pct = -1
    for line in proc.stdout:
        pct = parse_realesrgan_progress(line)
        if pct is not None and pct > last_pct:
            last_pct = pct
            sys.stdout.write(f"\r[anime60]   super-res {pct:5.1f}%")
            sys.stdout.flush()
    proc.wait()
    if last_pct >= 0:
        sys.stdout.write("\n")
    if proc.returncode != 0:
        raise RuntimeError(f"realesrgan-ncnn-vulkan failed ({proc.returncode})")


def run_rife(in_dir, out_dir):
    """Run RIFE; no percentage output - report by counting output frames.

    Use relative paths from ROOT to work around Windows path handling issues.
    """
    in_rel = os.path.relpath(in_dir, ROOT)
    out_rel = os.path.relpath(out_dir, ROOT)
    proc = subprocess.Popen(
        [RIFE_EXE, "-i", in_rel, "-o", out_rel, "-m", RIFE_MODEL,
         "-f", "%08d.jpg"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        errors="replace", cwd=ROOT)
    for line in proc.stdout:
        pass  # RIFE prints little; count frames below instead
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError(f"rife-ncnn-vulkan failed ({proc.returncode})")


def concat_segments(seg_paths, out_path, workdir):
    listfile = os.path.join(workdir, "seglist.txt")
    with open(listfile, "w", encoding="ascii") as f:
        for p in seg_paths:
            f.write(f"file '{p}'\n")
    run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
         "-i", listfile, "-c", "copy", out_path])


def chunked_stage(video, chunk_size, workdir, process_fn, encode_fps, prefix,
                  out_pattern, src_fps=None, total_frames=0, label="",
                  process_kwargs=None):
    """Shared extract -> process -> encode -> delete loop.

    process_fn(in_dir, out_dir, n_frames) fills out_dir with frames.
    Returns list of segment paths, and total processed frame count.
    """
    seg_dir = os.path.join(workdir, f"{prefix}_segs")
    os.makedirs(seg_dir, exist_ok=True)
    segs = []
    start_sec = 0.0
    idx = 0
    total_done = 0
    stage = Stage(label or prefix, total_frames)
    fps_num = encode_fps
    src_fps = src_fps if src_fps else fps_num
    while True:
        in_dir = os.path.join(workdir, f"{prefix}_in_{idx}")
        out_dir = os.path.join(workdir, f"{prefix}_out_{idx}")
        clean_dir(in_dir)
        clean_dir(out_dir)
        n = ffmpeg_extract(video, start_sec, chunk_size, in_dir)
        if n == 0:
            clean_dir(in_dir)
            clean_dir(out_dir)
            break
        if n == 1:
            # RIFE needs >= 2 input frames; duplicate the single frame.
            first = os.path.join(in_dir, "f_00000001.jpg")
            if os.path.isfile(first):
                shutil.copy2(first, os.path.join(in_dir, "f_00000002.jpg"))
        produced = process_fn(in_dir, out_dir, n, **(process_kwargs or {}))
        seg = os.path.join(seg_dir, f"seg_{idx}.mp4")
        encode_segment(out_dir, f"{fps_num:.6f}", seg, pattern=out_pattern)
        segs.append(seg)
        total_done += produced
        start_sec += n / src_fps
        idx += 1
        # free disk immediately
        shutil.rmtree(in_dir, ignore_errors=True)
        shutil.rmtree(out_dir, ignore_errors=True)
    if not segs:
        raise RuntimeError(f"no frames extracted in stage '{prefix}'")
    merged = os.path.join(workdir, f"{prefix}_all.mp4")
    concat_segments(segs, merged, workdir)
    stage.done(total_done)
    return merged, total_done


def sr_process(in_dir, out_dir, n, sr_cfg=None):
    cfg = sr_cfg or {}
    run_realesrgan(in_dir, out_dir, gpu=cfg.get("gpu", 0),
                   tile=cfg.get("tile", 0), threads=cfg.get("threads", 2))
    # realesrgan names outputs same as inputs; verify count
    got = len(list_jpgs(out_dir))
    if got != n:
        raise RuntimeError(f"super-res produced {got} frames, expected {n}")
    return got


def rife_process(in_dir, out_dir, n):
    run_rife(in_dir, out_dir)
    got = len(list_jpgs(out_dir))
    if got < n:
        raise RuntimeError(f"RIFE produced {got} frames, expected >= {n}")
    return got


def main():
    ap = argparse.ArgumentParser(description="Anime video: downscale -> 2x SR -> 2x interpolation -> 60fps output")
    ap.add_argument("input")
    ap.add_argument("--workdir", default=None, help="temp dir (default: <root>/_anime60_<name>)")
    ap.add_argument("--keep-temp", action="store_true", help="keep temp dir on failure for diagnosis")
    ap.add_argument("--gpu", type=int, default=0, help="GPU id for Real-ESRGAN (default: 0 = RTX 4060)")
    ap.add_argument("--tile", type=int, default=0, help="Real-ESRGAN tile size in px (default: 0 = auto)")
    ap.add_argument("--threads", type=int, default=2, help="Real-ESRGAN load/save threads (default: 2)")
    args = ap.parse_args()

    src = os.path.abspath(args.input)
    if not os.path.isfile(src):
        die(f"input not found: {src}")
    for tool in (REALESRGAN, RIFE_EXE):
        if not os.path.isfile(tool):
            die(f"required tool missing: {tool}")

    w, h, fps, has_audio = probe(src)
    src_name = os.path.splitext(os.path.basename(src))[0]
    src_dir = os.path.dirname(src)
    out_path = os.path.join(src_dir, f"{src_name}_60fps.mp4")

    fps_round = round(fps)
    if fps_round not in (24, 25, 30, 48, 50, 60):
        print(f"[anime60] note: unusual source fps {fps:.4f}, treating as {fps_round}")

    if abs(fps - 30.0) < 0.01:
        target_fps = 60.0
        mode = "direct"
    else:
        target_fps = 60.0
        mode = "minterpolate"
        print(f"[anime60] source is {fps:.4f} fps (not 30); after 2x interpolation ({fps*2:.2f} fps) "
              f"will re-time to 60 fps via minterpolate")

    workdir = args.workdir or os.path.join(ROOT, f"_anime60_{src_name}")
    if os.path.isdir(workdir):
        print(f"[anime60] removing stale workdir {workdir}")
        shutil.rmtree(workdir)
    os.makedirs(workdir)

    print(f"[anime60] input: {src}")
    print(f"[anime60] {w}x{h} @ {fps:.4f} fps, audio={'yes' if has_audio else 'no'}")
    print(f"[anime60] output: {out_path}")

    try:
        # Stage 1: downscale to half (even dimensions so 2x SR lands back exactly)
        t = Stage("downscale")
        down = os.path.join(workdir, "down.mp4")
        run(["ffmpeg", "-y", "-loglevel", "error", "-i", src,
             "-vf", "scale=trunc(iw*0.5/2)*2:trunc(ih*0.5/2)*2:flags=lanczos",
             "-c:v", "libx264", "-crf", "16", "-preset", "fast",
             "-pix_fmt", "yuv420p", "-an", down])
        dw, dh, dfps, _ = probe(down)
        t.done(0)
        print(f"[anime60] downscaled to {dw}x{dh} @ {dfps:.4f} fps")

        total = frame_count(down)

        # Stage 2: chunked super-resolution 2x -> back to source resolution
        sr_video, sr_frames = chunked_stage(
            down, SR_CHUNK, workdir, sr_process, dfps, "sr",
            out_pattern="f_%08d.jpg", total_frames=total, label="super-resolution",
            process_kwargs={"sr_cfg": {"gpu": args.gpu, "tile": args.tile,
                                       "threads": args.threads}})
        sw, sh, sfps, _ = probe(sr_video)
        print(f"[anime60] SR result: {sw}x{sh} @ {sfps:.4f} fps ({sr_frames} frames)")
        if (sw, sh) != (w, h):
            print(f"[anime60] warning: SR size {sw}x{sh} != source {w}x{h}")

        # Stage 3: chunked RIFE 2x interpolation
        rf_video, rf_frames = chunked_stage(
            sr_video, RIFE_CHUNK, workdir, rife_process, sfps * 2, "rife",
            out_pattern="%08d.jpg", src_fps=sfps, total_frames=sr_frames * 2, label="interpolation")
        rw, rh, rfps, _ = probe(rf_video)
        print(f"[anime60] RIFE result: {rw}x{rh} @ {rfps:.4f} fps ({rf_frames} frames)")

        # Stage 4: mux audio / re-time to 60fps
        t = Stage("mux")
        if mode == "direct":
            cmd = ["ffmpeg", "-y", "-loglevel", "error",
                   "-i", rf_video, "-i", src,
                   "-map", "0:v:0", "-map", "1:a?",
                   "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                   "-shortest", out_path]
        else:
            cmd = ["ffmpeg", "-y", "-loglevel", "error",
                   "-i", rf_video,
                   "-vf", "minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bidir",
                   "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p"]
            if has_audio:
                cmd += ["-i", src, "-map", "0:v:0", "-map", "1:a?",
                        "-c:a", "aac", "-b:a", "192k", "-shortest"]
            else:
                cmd += ["-an"]
            cmd += [out_path]
        run(cmd)
        ow, oh, ofps, _ = probe(out_path)
        t.done(0)

        print(f"[anime60] final: {ow}x{oh} @ {ofps:.4f} fps -> {out_path}")
        if (ow, oh) != (w, h):
            die(f"output resolution {ow}x{oh} != source {w}x{h}")
        if abs(ofps - 60.0) > 0.5:
            die(f"output fps {ofps:.4f} != 60")

        # cleanup on success
        shutil.rmtree(workdir, ignore_errors=True)
        print(f"[anime60] OK, temp dir cleaned: {workdir}")
        return 0
    except Exception as e:
        print(f"[anime60] FAILED: {e}", file=sys.stderr)
        if not args.keep_temp:
            print(f"[anime60] keeping temp dir for diagnosis: {workdir}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
