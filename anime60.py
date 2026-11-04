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
import threading
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
REALESRGAN = os.path.join(ROOT, "realesrgan-ncnn-vulkan.exe")
RIFE_EXE = os.path.join(ROOT, "rife-ncnn-vulkan-20221029-windows", "rife-ncnn-vulkan.exe")
RIFE_MODEL = os.path.join(ROOT, "rife-ncnn-vulkan-20221029-windows", "rife-v4.6")

SR_CHUNK = 1500   # frames per super-resolution chunk
RIFE_CHUNK = 1000  # frames per interpolation chunk
TARGET_FPS = 60.0  # final output frame rate

# RIFE's -j load:proc:save split.  Measured on a 1080p 24->60 fps chunk:
#   -j 4:4:4  -> 21 fps, GPU 64% busy   (the save path starves the GPU)
#   -j 4:4:12 -> 32 fps, GPU 85% busy
# The stock symmetric split makes PNG encoding the bottleneck, not inference.
RIFE_LOAD = 4
RIFE_PROC = 4
RIFE_SAVE = 12


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


IMG_EXT = "png"   # lossless intermediate frames keep SR quality
IMG_PAT = f"f_%08d.{IMG_EXT}"

# Super-resolution runs on a half-res copy and doubles it back, so the frames
# fed to Real-ESRGAN are always half the source.  ffmpeg_extract applies this
# while decoding, which lets stage 1 disappear entirely: previously the source
# was decoded, rescaled and re-encoded to a half-res mp4, and that mp4 was then
# decoded again to PNGs - three full-frame passes for what is now one.
DOWNSCALE_FILTER = "scale=trunc(iw*0.5/2)*2:trunc(ih*0.5/2)*2:flags=lanczos"


def list_frames(d):
    return sorted(f for f in os.listdir(d) if f.lower().endswith("." + IMG_EXT))


def ffmpeg_extract(src, start_sec, n_frames, out_dir, scale=False):
    """Extract up to n_frames starting at start_sec into out_dir as f_%08d.png.

    ffmpeg 8.x returns -22 when stepping past EOF with 0 frames extracted -
    that is the normal chunk-loop end condition, not an error.
    With scale=True the half-res downscale is folded into the decode.
    Returns the number of frames actually extracted.
    """
    cmd = ["ffmpeg", "-y", "-loglevel", "error",
           "-ss", f"{start_sec:.6f}", "-i", src,
           "-frames:v", str(n_frames)]
    if scale:
        cmd += ["-vf", DOWNSCALE_FILTER]
    # level 1 instead of the default 3: extraction runs on the CPU alongside a
    # GPU stage, and PNG encode is ~40% cheaper at level 1 (300 half-res
    # frames: 0.77s vs 0.99s).
    cmd += ["-compression_level", "1", os.path.join(out_dir, IMG_PAT)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    n = len(list_frames(out_dir))
    if r.returncode not in (0, -22):
        raise RuntimeError(f"ffmpeg extract failed ({r.returncode}): {r.stderr.strip()}")
    return n


# Encoder presets used at different points of the pipeline:
#   * intermediate stages (downscale, SR output) re-encode lossily before the
#     next GPU stage re-decodes them, so use near-lossless crf 12 x264 - the
#     frames feed RIFE which is sensitive to input artefacts.
#   * the final output uses NVENC (RTX hardware encoder) to offload the CPU and
#     speed up the dominant encode; quality/bitrate tuned via cq.
#
# The x264 presets pin a thread count.  These encodes run on the CPU while
# Real-ESRGAN / RIFE own the GPU, and x264's default (all 12 logical cores)
# starves the GPU's own load/save threads:
#     SR alone                15.96 fps  (GPU 93%)
#     SR + x264 default        8.80 fps  (GPU 63%)
#     SR + x264 -threads 4    15.27 fps  (GPU 91%)
# 4 threads still encode 1080p crf12 at 32.6 fps, twice the 16 fps SR rate, so
# the encoder stays hidden behind the GPU stage either way.
ENCODE_THREADS = 4
ENCODERS = {
    "x264_crf12": ["-c:v", "libx264", "-crf", "12", "-preset", "fast",
                   "-threads", str(ENCODE_THREADS)],
    "x264_crf18": ["-c:v", "libx264", "-crf", "18", "-preset", "fast",
                   "-threads", str(ENCODE_THREADS)],
    "h264_nvenc": ["-c:v", "h264_nvenc", "-rc", "vbr", "-cq", "26", "-preset", "p5", "-bf", "2"],
    "hevc_nvenc": ["-c:v", "hevc_nvenc", "-rc", "vbr", "-cq", "26", "-preset", "p5", "-bf", "2"],
}

# Intermediate (SR output) encode: near-lossless but on the GPU's encoder.
#
# The SR stage was the pipeline bottleneck because its chunk encoder ran on the
# CPU at the same time as Real-ESRGAN, and x264's threads starved the GPU load
# threads.  Pinning fewer x264 threads did NOT help - the CPU work is what costs
# the GPU, not the thread count:
#     x264 -threads 4 (previous)  11.9-12.6 fps  GPU 70-75%
#     x264 -threads 2             11.0 fps       GPU 66%
#     hevc_nvenc cq19             14.9-15.2 fps  GPU 90%   (SR duty 81% -> 96%)
# cq14/16/19 all hit the same rate, so the encoder is no longer the limiter;
# cq16 keeps >1 dB extra headroom over cq19 at no cost.  Measured against the
# source PNGs the intermediate layer stays far above the delivered quality
# (54.6 dB vs 40.6 dB for the final cq26 file), so this cannot be seen.
INTERMEDIATE_ENCODER = "hevc_nvenc_cq16"
ENCODERS[INTERMEDIATE_ENCODER] = ["-c:v", "hevc_nvenc", "-rc", "vbr",
                                  "-cq", "16", "-preset", "p5", "-bf", "2"]


def encode_segment(frame_dir, fps_str, out_path, start_number=1, pattern=IMG_PAT,
                   encoder="x264_crf12"):
    run(["ffmpeg", "-y", "-loglevel", "error",
         "-start_number", str(start_number),
         "-framerate", fps_str, "-i", os.path.join(frame_dir, pattern)]
        + ENCODERS[encoder] + ["-pix_fmt", "yuv420p", out_path])


def parse_realesrgan_progress(line):
    """Real-ESRGAN prints '12.34%' style lines; return float or None."""
    m = re.search(r"([0-9.]+)%", line)
    return float(m.group(1)) if m else None


def rife_threads_arg(threads):
    """RIFE -j load:proc:save.

    `threads` (the --rife-threads value) is treated as the load/proc count for
    backwards compatibility, but the save count is deliberately much larger:
    saving 1080p PNGs is CPU-bound and starves the GPU at a symmetric split.
    """
    if threads and threads > 0:
        load = proc = threads
    else:
        load, proc = RIFE_LOAD, RIFE_PROC
    return f"{load}:{proc}:{RIFE_SAVE}"


def realesrgan_popen(in_dir, out_dir, gpu=0, tile=0, threads=2):
    """Start one Real-ESRGAN process on a frame directory; caller reads/waits it."""
    cmd = [REALESRGAN, "-i", in_dir, "-o", out_dir,
           "-n", "realesr-animevideov3", "-s", "2", "-f", IMG_EXT,
           "-g", str(gpu)]
    if tile and tile > 0:
        cmd += ["-t", str(tile)]
    if threads and threads > 0:
        cmd += ["-j", f"{threads}:{threads}:{threads}"]
    return subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        errors="replace", cwd=ROOT)


def run_realesrgan(in_dir, out_dir, gpu=0, tile=0, threads=2):
    """Run Real-ESRGAN on a frame directory with a coarse percent progress line."""
    proc = realesrgan_popen(in_dir, out_dir, gpu=gpu, tile=tile, threads=threads)
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


def run_rife(in_dir, out_dir, target_frames=0, threads=4):
    """Run RIFE, producing target_frames (>= input) or 2x if not given.

    RIFE v4.6's -n accepts any target frame count (not just integer multiples),
    so 24fps -> 60fps needs no minterpolate re-encode.
    Use relative paths from ROOT to work around Windows path handling issues.
    """
    in_rel = os.path.relpath(in_dir, ROOT)
    out_rel = os.path.relpath(out_dir, ROOT)
    cmd = [RIFE_EXE, "-i", in_rel, "-o", out_rel, "-m", RIFE_MODEL,
           "-f", f"%08d.{IMG_EXT}"]
    if target_frames > 0:
        cmd += ["-n", str(target_frames)]
    cmd += ["-j", rife_threads_arg(threads)]
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        errors="replace", cwd=ROOT)
    for line in proc.stdout:
        pass  # RIFE prints little; count frames below instead
    proc.wait()
    if proc.returncode != 0:
        # Some Windows/Vulkan builds report a heap error while tearing down
        # after all requested frames have already been written.  Trust the
        # output only when it is complete; a partial output remains a hard
        # failure so corrupted chunks cannot enter the concat stage.
        got = len(list_frames(out_dir))
        if target_frames > 0 and got >= target_frames:
            print(f"[anime60] warning: RIFE returned {proc.returncode} after writing "
                  f"all {got} requested frames; continuing")
        else:
            raise RuntimeError(f"rife-ncnn-vulkan failed ({proc.returncode})")


def concat_segments(seg_paths, out_path, workdir):
    listfile = os.path.join(workdir, "seglist.txt")
    with open(listfile, "w", encoding="utf-8") as f:
        for p in seg_paths:
            # concat resolves entries relative to the listfile's dir, so use
            # absolute paths to stay correct regardless of workdir/CWD.
            f.write(f"file '{os.path.abspath(p)}'\n")
    run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
         "-i", listfile, "-c", "copy", out_path])


def chunked_stage(video, chunk_size, workdir, process_fn, encode_fps, prefix,
                  out_pattern, src_fps=None, total_frames=0, label="",
                  process_kwargs=None, depth=2, encode_encoder="x264_crf12",
                  extract_scale=False):
    """Extract -> process -> encode -> delete as a 3-worker pipeline.

    Rather than doing chunk i fully before chunk i+1 (which leaves the GPU idle
    while the CPU extracts/encodes), three worker threads overlap the stages so
    the GPU stays fed:

      extractor (CPU): extracts frames for chunk i ahead of time
      processor (GPU): runs process_fn (super-res / interpolation) on chunk i
      encoder   (CPU): encodes finished out_dir into a segment

    `depth` bounds how many chunks may be extracted ahead, keeping disk usage
    bounded. Returns (merged_video_path, total_processed_frames).
    """
    seg_dir = os.path.join(workdir, f"{prefix}_segs")
    os.makedirs(seg_dir, exist_ok=True)
    fps_num = encode_fps
    src_fps = src_fps if src_fps else fps_num
    stage = Stage(label or prefix, total_frames)

    import queue
    to_process = queue.Queue(maxsize=depth)   # (idx, in_dir, n) ready for GPU
    to_encode = queue.Queue()                 # (idx, out_dir) ready to encode
    stop = threading.Event()
    err = []
    segs = {}
    total_done = 0
    END = object()  # queue sentinel for normal end-of-input

    def _qput(q, item):
        # Put honouring stop: never block forever on a full queue.
        while not stop.is_set():
            try:
                q.put(item, timeout=0.2)
                return True
            except queue.Full:
                continue
        return False

    def _qget(q):
        while not stop.is_set() or not q.empty():
            try:
                return q.get(timeout=0.2)
            except queue.Empty:
                continue
        return END

    def _extract():
        idx = 0
        start_sec = 0.0
        while True:
            if stop.is_set():
                _qput(to_process, END)
                return
            in_dir = os.path.join(workdir, f"{prefix}_in_{idx}")
            clean_dir(in_dir)
            n = ffmpeg_extract(video, start_sec, chunk_size, in_dir,
                               scale=extract_scale)
            if n == 0:
                clean_dir(in_dir)
                if not _qput(to_process, END):
                    return
                return
            if n == 1:
                first = os.path.join(in_dir, "f_00000001.png")
                if os.path.isfile(first):
                    shutil.copy2(first, os.path.join(in_dir, "f_00000002.png"))
                    n = 2
            if not _qput(to_process, (idx, in_dir, n)):
                return
            start_sec += n / src_fps
            idx += 1

    def _process():
        while True:
            item = _qget(to_process)
            if item is END:
                _qput(to_encode, END)
                return
            idx, in_dir, n = item
            out_dir = os.path.join(workdir, f"{prefix}_out_{idx}")
            clean_dir(out_dir)
            try:
                process_fn(in_dir, out_dir, n, **(process_kwargs or {}))
            except Exception as e:
                err.append(("process", e))
                stop.set()
                _qput(to_encode, END)
                return
            if not _qput(to_encode, (idx, out_dir)):
                return
            # free input disk once consumed
            shutil.rmtree(in_dir, ignore_errors=True)

    def _encode():
        nonlocal total_done
        while True:
            item = _qget(to_encode)
            if item is END:
                return
            idx, out_dir = item
            seg = os.path.join(seg_dir, f"seg_{idx}.mp4")
            try:
                encode_segment(out_dir, f"{fps_num:.6f}", seg, pattern=out_pattern,
                               encoder=encode_encoder)
            except Exception as e:
                err.append(("encode", e))
                stop.set()
                return
            segs[idx] = seg
            total_done += len(list_frames(out_dir))
            shutil.rmtree(out_dir, ignore_errors=True)

    threads = [
        threading.Thread(target=_extract, daemon=True),
        threading.Thread(target=_process, daemon=True),
        threading.Thread(target=_encode, daemon=True),
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    if err:
        raise RuntimeError(f"{prefix} pipeline failed in '{err[0][0]}': {err[0][1]}")

    if not segs:
        raise RuntimeError(f"no frames extracted in stage '{prefix}'")
    merged = os.path.join(workdir, f"{prefix}_all.mp4")
    concat_segments([segs[i] for i in sorted(segs)], merged, workdir)
    stage.done(total_done)
    return merged, total_done


def sr_process(in_dir, out_dir, n, sr_cfg=None):
    """Super-resolve frames. With parallel>1, shard frames across N concurrent
    Real-ESRGAN instances on the same GPU so the lightweight model keeps the
    GPU busy (per-instance I/O gaps get filled by sibling instances).
    """
    cfg = sr_cfg or {}
    gpu = cfg.get("gpu", 0)
    tile = cfg.get("tile", 0)
    threads = cfg.get("threads", 2)
    jobs = max(1, cfg.get("parallel", 1))

    if jobs <= 1 or n <= 1:
        run_realesrgan(in_dir, out_dir, gpu=gpu, tile=tile, threads=threads)
    else:
        frames = list_frames(in_dir)
        shards = [[] for _ in range(jobs)]
        for i, f in enumerate(frames):
            shards[i % jobs].append(f)  # round-robin keeps segments balanced
        procs = []
        for i in range(jobs):
            if not shards[i]:
                continue
            sh_in = os.path.join(in_dir, f"_shard_{i}")
            sh_out = os.path.join(out_dir, f"_out_{i}")
            os.makedirs(sh_in, exist_ok=True)
            os.makedirs(sh_out, exist_ok=True)
            for f in shards[i]:
                os.replace(os.path.join(in_dir, f), os.path.join(sh_in, f))
            procs.append((realesrgan_popen(sh_in, sh_out, gpu=gpu, tile=tile,
                                           threads=threads), sh_out))
        results = []

        def drain(proc, sh_out):
            proc.communicate()  # consume stdout so the pipe never fills
            results.append((proc.returncode, sh_out))

        runners = [threading.Thread(target=drain, args=p) for p in procs]
        for t in runners:
            t.start()
        for t in runners:
            t.join()
        for rc, sh_out in sorted(results, key=lambda r: r[1]):
            if rc != 0:
                raise RuntimeError(f"realesrgan-ncnn-vulkan failed ({rc})")
            for f in list_frames(sh_out):
                # outputs keep original f_%08d names, so merging preserves frame order
                os.replace(os.path.join(sh_out, f), os.path.join(out_dir, f))

    got = len(list_frames(out_dir))
    if got != n:
        raise RuntimeError(f"super-res produced {got} frames, expected {n}")
    return got


def rife_process(in_dir, out_dir, n, src_fps=0, out_fps=0, threads=4):
    # Interpolate to out_fps directly (RIFE -n accepts any target frame count).
    # A chunk of n frames at src_fps lasts n/src_fps s, which is n*out_fps/src_fps
    # frames at out_fps. Run in dir mode; RIFE reads back-to-back frames.
    if out_fps > 0 and src_fps > 0:
        target = round(n * out_fps / src_fps)
    else:
        target = n * 2  # default: plain 2x
    run_rife(in_dir, out_dir, target_frames=target, threads=threads)
    got = len(list_frames(out_dir))
    if got < n:
        raise RuntimeError(f"RIFE produced {got} frames, expected >= {n}")
    return got


def main():
    ap = argparse.ArgumentParser(description="Anime video: downscale -> 2x SR -> 2x interpolation -> 60fps output")
    ap.add_argument("input")
    ap.add_argument("--outdir", default=None,
                    help="output directory for the finished file (default: alongside input)")
    ap.add_argument("--workdir", default=None, help="temp dir (default: <root>/_anime60_<name>)")
    ap.add_argument("--keep-temp", action="store_true", help="keep temp dir on failure for diagnosis")
    ap.add_argument("--gpu", type=int, default=0, help="GPU id for Real-ESRGAN (default: 0 = RTX 4060)")
    ap.add_argument("--tile", type=int, default=0, help="Real-ESRGAN tile size in px (default: 0 = auto)")
    ap.add_argument("--threads", type=int, default=4, help="Real-ESRGAN load/proc/save threads (default: 4)")
    ap.add_argument("--rife-threads", type=int, default=4,
                    help="RIFE load/proc/save threads (default: 4; stock default is 1:2:2 which starves the GPU)")
    ap.add_argument("--sr-parallel", type=int, default=1, dest="sr_parallel",
                    help="concurrent Real-ESRGAN instances over split chunks (default: 1; "
                         "more instances contend for the same GPU and do not help)")
    ap.add_argument("--encode", default="hevc_nvenc", choices=sorted(ENCODERS),
                    help="final-output codec (default: hevc_nvenc cq26; "
                         "x264_crf18 keeps the old CPU encoder)")
    args = ap.parse_args()

    src = os.path.abspath(args.input)
    if not os.path.isfile(src):
        die(f"input not found: {src}")
    for tool in (REALESRGAN, RIFE_EXE):
        if not os.path.isfile(tool):
            die(f"required tool missing: {tool}")

    w, h, fps, has_audio = probe(src)
    src_name = os.path.splitext(os.path.basename(src))[0]
    out_dir = os.path.abspath(args.outdir) if args.outdir else os.path.dirname(src)
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"{src_name}_60fps.mp4")

    fps_round = round(fps)
    if fps_round not in (24, 25, 30, 48, 50, 60):
        print(f"[anime60] note: unusual source fps {fps:.4f}, treating as {fps_round}")
    print(f"[anime60] interpolating from {fps:.4f} fps to {TARGET_FPS:.0f} fps via RIFE")

    workdir = args.workdir or os.path.join(ROOT, f"_anime60_{src_name}")
    if os.path.isdir(workdir):
        print(f"[anime60] removing stale workdir {workdir}")
        shutil.rmtree(workdir)
    os.makedirs(workdir)

    print(f"[anime60] input: {src}")
    print(f"[anime60] {w}x{h} @ {fps:.4f} fps, audio={'yes' if has_audio else 'no'}")
    print(f"[anime60] output: {out_path}")

    try:
        # The half-res downscale used to be its own stage (decode the source,
        # rescale, encode to a half-res mp4, then decode that again to PNGs).
        # It now happens inside the SR extractor, so the source is decoded once
        # and no intermediate mp4 is written or re-read.
        dw = max(2, (w // 2) // 2 * 2)
        dh = max(2, (h // 2) // 2 * 2)
        dfps = fps
        total = frame_count(src)
        print(f"[anime60] super-resolving from half res {dw}x{dh} (scale on extract)")

        # Stage 2: chunked super-resolution 2x -> back to source resolution.
        # Output stays near-lossless: it will be re-decoded for RIFE.
        sr_video, sr_frames = chunked_stage(
            src, SR_CHUNK, workdir, sr_process, dfps, "sr",
            out_pattern=IMG_PAT, total_frames=total, label="super-resolution",
            encode_encoder=INTERMEDIATE_ENCODER,
            extract_scale=True,
            process_kwargs={"sr_cfg": {"gpu": args.gpu, "tile": args.tile,
                                       "threads": args.threads,
                                       "parallel": args.sr_parallel}})
        sw, sh, sfps, _ = probe(sr_video)
        print(f"[anime60] SR result: {sw}x{sh} @ {sfps:.4f} fps ({sr_frames} frames)")
        if (sw, sh) != (w, h):
            print(f"[anime60] warning: SR size {sw}x{sh} != source {w}x{h}")

        # Stage 3: chunked RIFE interpolation to 60 fps (any source fps allowed).
        # Final output is encoded with the chosen codec (NVENC by default).
        rf_video, rf_frames = chunked_stage(
            sr_video, RIFE_CHUNK, workdir, rife_process, TARGET_FPS, "rife",
            out_pattern=f"%08d.{IMG_EXT}", src_fps=sfps,
            total_frames=round(sr_frames * TARGET_FPS / sfps), label="interpolation",
            encode_encoder=args.encode,
            process_kwargs={"src_fps": sfps, "out_fps": TARGET_FPS,
                            "threads": args.rife_threads})
        rw, rh, rfps, _ = probe(rf_video)
        print(f"[anime60] RIFE result: {rw}x{rh} @ {rfps:.4f} fps ({rf_frames} frames)")

        # Stage 4: mux audio (video already at 60fps from RIFE)
        t = Stage("mux")
        cmd = ["ffmpeg", "-y", "-loglevel", "error",
               "-i", rf_video, "-i", src,
               "-map", "0:v:0", "-map", "1:a?",
               "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
               "-shortest", out_path]
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
