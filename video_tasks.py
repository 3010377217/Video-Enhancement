# video_tasks.py
# Chunked video pipelines for the local Web GUI:
#   upscale (Real-ESRGAN or Video2X/Real-CUGAN) / interp 60+45 (RIFE) /
#   interp 120 (RIFE 2x) / resize (ffmpeg)
# Ported faithfully from upscale_video.bat / interp_video.bat / interp120_video.bat.

import json
import math
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
import zipfile
from collections import deque

APP_DIR = os.path.dirname(os.path.abspath(__file__))
REALESRGAN_EXE = os.path.join(APP_DIR, "realesrgan-ncnn-vulkan.exe")
RIFE_EXE = os.path.join(APP_DIR, "rife-ncnn-vulkan-20221029-windows", "rife-ncnn-vulkan.exe")
RIFE_MODEL = os.path.join(APP_DIR, "rife-ncnn-vulkan-20221029-windows", "rife-v4.6")
WORK_ROOT = os.path.join(APP_DIR, "_web_work")
VIDEO2X_ENV = "VIDEO2X_EXE"

CREATE_NO_WINDOW = 0x08000000
VIDEO_EXT = {".mp4", ".mkv", ".mov", ".avi", ".webm", ".flv", ".m4v", ".ts", ".mpg", ".mpeg", ".wmv"}
CHUNK_DEFAULT = {"upscale": 1500, "interp": 1000, "interp120": 1000}

MODELS_DIR = os.path.join(APP_DIR, "models")
MODEL_DL_DIR = os.path.join(WORK_ROOT, "_model_dl")
PROXY = "http://127.0.0.1:7897"

# Registry of selectable upscale models. `scaled=True` means the local files
# are <name>-x<scale>.param/.bin (animevideov3), otherwise a single
# <name>.param/.bin is used at any scale. `download` is only present for
# models not bundled locally; the source is the official release zip.
MODELS = [
    {"name": "realesr-animevideov3", "label": "动漫 / 卡通（速度快）", "mb": None, "scaled": True},
    {"name": "realesrgan-x4plus", "label": "真人 / 通用（画质好）", "mb": 33.4},
    {"name": "realesrgan-x4plus-anime", "label": "动漫（画质好）", "mb": 8.9},
    {"name": "realesrnet-x4plus", "label": "真人 / 通用（轻量省显存）", "mb": 31.9,
     "download": {"zip_url": "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.3.0/realesrgan-ncnn-vulkan-20211212-windows.zip",
                  "zip_mb": 75, "files": ["models/realesrnet-x4plus.param", "models/realesrnet-x4plus.bin"]}},
]
MODELS_BY_NAME = {m["name"]: m for m in MODELS}

# Video2X ships Real-CUGAN and its model files separately from this project.
# Keep the choices explicit so the UI can expose only supported CLI values.
REALCUGAN_MODELS = [
    {"name": "models-nose", "label": "Real-CUGAN Nose（仅 2x、无降噪）"},
    {"name": "models-pro", "label": "Real-CUGAN Pro（2x / 3x）"},
    {"name": "models-se", "label": "Real-CUGAN SE（推荐，2x / 3x / 4x）"},
]
REALCUGAN_MODELS_BY_NAME = {m["name"]: m for m in REALCUGAN_MODELS}
REALCUGAN_NOISE_LEVELS = [
    {"value": 0, "label": "0：不降噪"},
    {"value": 1, "label": "1：轻度降噪"},
    {"value": 2, "label": "2：较强降噪"},
    {"value": 3, "label": "3：强降噪"},
]
REALCUGAN_NOISE_VALUES = {n["value"] for n in REALCUGAN_NOISE_LEVELS}
REALCUGAN_CAPABILITIES = {
    "models-nose": {2: [0]},
    "models-pro": {2: [0, 3], 3: [0, 3]},
    "models-se": {2: [0, 1, 2, 3], 3: [0, 3], 4: [0, 3]},
}


def validate_realcugan_config(model, scale, noise_level):
    """Reject model/scale/noise combinations not bundled by Video2X."""
    if model not in REALCUGAN_MODELS_BY_NAME:
        raise ValueError(f"未知 Real-CUGAN 模型: {model}")
    supported = REALCUGAN_CAPABILITIES[model]
    if scale not in supported:
        scales = "、".join(str(value) for value in supported)
        raise ValueError(f"{model} 仅支持 {scales}x 放大")
    if noise_level not in supported[scale]:
        levels = "、".join(str(value) for value in supported[scale])
        raise ValueError(f"{model} 在 {scale}x 时仅支持降噪等级 {levels}")


def find_video2x_exe():
    """Find a Video2X executable without requiring a global installation."""
    candidates = []
    configured = os.environ.get(VIDEO2X_ENV)
    if configured:
        configured = os.path.abspath(os.path.expandvars(configured))
        if os.path.isdir(configured):
            candidates.append(os.path.join(configured, "video2x.exe"))
            candidates.append(os.path.join(configured, "video2x"))
        else:
            candidates.append(configured)
    candidates.extend([
        os.path.join(APP_DIR, "video2x.exe"),
        os.path.join(APP_DIR, "video2x", "video2x.exe"),
        os.path.join(APP_DIR, "video2x", "video2x"),
        os.path.join(APP_DIR, "Video2X", "video2x.exe"),
        os.path.join(APP_DIR, "Video2X", "video2x"),
    ])
    for candidate in candidates:
        if os.path.isfile(candidate):
            return os.path.abspath(candidate)
    return shutil.which("video2x.exe") or shutil.which("video2x")


def video2x_info():
    exe = find_video2x_exe()
    return {
        "available": bool(exe),
        "path": exe,
        "env": VIDEO2X_ENV,
        "hint": "将 Video2X Windows 包解压到 video2x\\，或设置 VIDEO2X_EXE 环境变量",
    }


def engine_info():
    return {
        "realesrgan": {
            "available": os.path.isfile(REALESRGAN_EXE),
            "label": "Real-ESRGAN（现有方案）",
        },
        "video2x": video2x_info(),
    }


def model_downloaded(name):
    """True when models/ contains <name>.param or <name>-x<scale>.param."""
    if name not in MODELS_BY_NAME or not os.path.isdir(MODELS_DIR):
        return False
    try:
        for fn in os.listdir(MODELS_DIR):
            if fn.endswith(".param") and (fn == name + ".param" or fn.startswith(name + "-")):
                return True
    except OSError:
        pass
    return False


class ModelDownloadState:
    def __init__(self, name):
        self.name = name
        self.state = "running"  # running | done | error
        self.total = 0
        self.received = 0
        self.error = None

    def info(self):
        return {"state": self.state, "total": self.total,
                "received": self.received, "error": self.error}


def _fetch(url, dest, state):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        _open_download(req, urllib.request.build_opener(), dest, state)
    except urllib.error.URLError:
        # direct fetch failed -> retry through the local proxy (mirrors the
        # curl -x used when vue.global.prod.js was first downloaded)
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": PROXY, "https": PROXY}))
        _open_download(req, opener, dest, state)


def _open_download(req, opener, dest, state):
    with opener.open(req, timeout=60) as r:
        try:
            state.total = int(r.headers.get("Content-Length") or 0)
        except ValueError:
            state.total = 0
        with open(dest, "wb") as f:
            while True:
                chunk = r.read(1 << 16)
                if not chunk:
                    break
                f.write(chunk)
                state.received += len(chunk)


def start_model_download(name, state):
    """Download the model's source zip and extract only the needed files."""
    def work():
        try:
            m = MODELS_BY_NAME[name]
            dl = m["download"]
            os.makedirs(MODEL_DL_DIR, exist_ok=True)
            os.makedirs(MODELS_DIR, exist_ok=True)
            zip_path = os.path.join(MODEL_DL_DIR, name + ".zip")
            _fetch(dl["zip_url"], zip_path, state)
            with zipfile.ZipFile(zip_path) as z:
                for member in dl["files"]:
                    with z.open(member) as src, \
                         open(os.path.join(MODELS_DIR, os.path.basename(member)), "wb") as dst:
                        shutil.copyfileobj(src, dst)
            os.remove(zip_path)
            if not model_downloaded(name):
                raise RuntimeError("解压后未找到模型文件")
            state.state = "done"
        except Exception as e:
            state.state = "error"
            state.error = str(e)

    threading.Thread(target=work, daemon=True).start()
    return state


class JobCancelled(Exception):
    pass


def _check_cancel(job):
    if job.cancel_event.is_set():
        raise JobCancelled()


def count_files(path):
    if not os.path.isdir(path):
        return 0
    return sum(1 for _ in os.listdir(path))


def parse_fps(text):
    if not text:
        return 0, 1
    m = re.match(r"^(\d+)/(\d+)$", text.strip())
    if m:
        return int(m.group(1)), int(m.group(2))
    try:
        return int(text.strip()), 1
    except ValueError:
        return 0, 1


def probe_video(path):
    cmd = ["ffprobe", "-v", "error", "-select_streams", "v:0",
           "-show_entries", "stream=width,height,avg_frame_rate,r_frame_rate,nb_frames",
           "-show_entries", "format=duration,size",
           "-of", "json", path]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                       errors="replace", creationflags=CREATE_NO_WINDOW)
    if r.returncode != 0:
        raise ValueError("无法读取视频信息: " + (r.stderr.strip() or "ffprobe 失败"))
    j = json.loads(r.stdout or "{}")
    streams = j.get("streams") or []
    if not streams:
        raise ValueError("没有找到视频流")
    s = streams[0]
    fn, fd = parse_fps(s.get("avg_frame_rate") or s.get("r_frame_rate"))
    fps = fn / fd if fd else None
    nb = s.get("nb_frames")
    try:
        frames = int(nb) if nb and nb not in ("N/A", "0") else None
    except ValueError:
        frames = None
    dur = 0.0
    try:
        dur = float(j["format"].get("duration") or 0)
    except ValueError:
        pass
    if not frames and fps and dur:
        frames = int(round(fps * dur))
    try:
        size = int(j["format"].get("size") or 0)
    except ValueError:
        size = 0
    free = shutil.disk_usage(os.path.dirname(os.path.abspath(path))).free
    return {"width": s.get("width"), "height": s.get("height"),
            "fps_num": fn, "fps_den": fd,
            "fps": round(fps, 4) if fps else None,
            "frames": frames, "duration": dur, "size": size, "free": free}


def list_dir(path):
    path = os.path.abspath(path or os.path.expanduser("~"))
    if not os.path.isdir(path):
        path = os.path.dirname(path)
    dirs, videos = [], []
    try:
        entries = sorted(os.scandir(path), key=lambda e: (not e.is_dir(), e.name.lower()))
        for e in entries:
            try:
                if e.is_dir():
                    dirs.append(e.name)
                elif e.is_file() and os.path.splitext(e.name)[1].lower() in VIDEO_EXT:
                    videos.append({"name": e.name, "size": e.stat().st_size})
            except OSError:
                pass
    except OSError:
        pass
    return {"current": path, "parent": os.path.dirname(path),
            "dirs": dirs, "videos": videos}


class Reporter:
    """Collects SSE events + a replayable history for late/reconnecting clients."""

    def __init__(self):
        self.history = deque(maxlen=400)
        self.cond = threading.Condition()

    def _emit(self, ev):
        with self.cond:
            self.history.append(ev)
            self.cond.notify_all()

    def log(self, line):
        self._emit({"type": "log", "line": line})

    def stage(self, text):
        self._emit({"type": "stage", "text": text})

    def progress(self, percent, text, fps=None, eta=None):
        self._emit({"type": "progress", "percent": percent, "text": text, "fps": fps, "eta": eta})

    def done(self, outputs):
        self._emit({"type": "done", "outputs": outputs})

    def error(self, message):
        self._emit({"type": "error", "message": message})

    def cancelled(self):
        self._emit({"type": "cancelled"})


class ProgressMeter:
    """Computes percent / fps / ETA from an overall progress fraction."""

    def __init__(self, rep, total_frames):
        self.rep = rep
        self.total = total_frames or None
        self.t0 = time.monotonic()

    def step(self, frac, text):
        if self.total is None:
            self.rep.progress(None, text)
            return
        frac = max(0.0, min(1.0, frac))
        elapsed = time.monotonic() - self.t0
        done = max(frac, 1e-6)
        fps = done * self.total / elapsed if elapsed > 0 else None
        eta = ((1 - frac) * self.total / fps) if fps else None
        self.rep.progress(frac, text, fps=fps, eta=eta)


class Runner:
    """Runs a subprocess while streaming stdout/stderr lines; cancel kills it."""

    def __init__(self, cancel_event):
        self.cancel_event = cancel_event
        self.proc = None

    def cancel(self):
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.kill()
            except OSError:
                pass

    def run(self, cmd, cwd=None, on_stdout=None, on_stderr=None):
        self.proc = subprocess.Popen(cmd, cwd=cwd,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     creationflags=CREATE_NO_WINDOW,
                                     text=True, encoding="utf-8", errors="replace")

        def pump(pipe, cb):
            try:
                for line in pipe:
                    if cb:
                        cb(line.rstrip("\r\n"))
            except ValueError:
                pass

        t1 = threading.Thread(target=pump, args=(self.proc.stdout, on_stdout), daemon=True)
        t2 = threading.Thread(target=pump, args=(self.proc.stderr, on_stderr), daemon=True)
        t1.start()
        t2.start()
        while True:
            try:
                rc = self.proc.wait(timeout=0.2)
                break
            except subprocess.TimeoutExpired:
                if self.cancel_event.is_set():
                    self.cancel()
                    break
        t1.join()
        t2.join()
        return self.proc.returncode


class Job:
    def __init__(self, job_id, mode, src, opts):
        self.id = job_id
        self.mode = mode
        self.src = src
        self.opts = opts
        self.rep = Reporter()
        self.cancel_event = threading.Event()
        self.runner = Runner(self.cancel_event)
        self.status = "pending"
        self.error = None
        self.outputs = []
        self.created = time.time()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self.thread.start()

    def cancel(self):
        self.cancel_event.set()
        self.runner.cancel()

    def info(self):
        return {"id": self.id, "mode": self.mode, "src": self.src, "status": self.status,
                "error": self.error, "outputs": self.outputs, "created": self.created}

    def _run(self):
        self.status = "running"
        work = os.path.join(WORK_ROOT, self.id)
        try:
            os.makedirs(work, exist_ok=True)
            self.outputs = dispatch(self, work)
            self.status = "done"
            self.rep.done(self.outputs)
        except JobCancelled:
            self.status = "cancelled"
            self.rep.cancelled()
        except Exception as e:
            self.status = "error"
            self.error = str(e)
            self.rep.log("错误: " + str(e))
            self.rep.error(str(e))
        finally:
            shutil.rmtree(work, ignore_errors=True)
            self.rep._emit({"type": "end"})


def dispatch(job, work):
    m = job.mode
    if m == "upscale":
        return run_upscale(job, work)
    if m == "interp":
        return run_interp(job, work)
    if m == "interp120":
        return run_interp120(job, work)
    if m == "resize":
        return run_resize(job, work)
    raise ValueError(f"未知模式: {m}")


def _start_watcher(job, target_dir, expected, meter, base, span, label, stop):
    def poll():
        while not stop.is_set() and not job.cancel_event.is_set():
            n = count_files(target_dir)
            meter.step(base + span * (n / max(expected, 1)), f"{label} {n}/{expected}")
            if n >= expected:
                break
            time.sleep(0.3)

    t = threading.Thread(target=poll, daemon=True)
    t.start()
    return t


def extract(job, indir, target, stime, meter, base, span, rep):
    os.makedirs(indir, exist_ok=True)
    pat = os.path.join(indir, "f_%08d.jpg")
    stop = threading.Event()
    t = _start_watcher(job, indir, target, meter, base, span, "抽帧", stop)
    rc = job.runner.run(["ffmpeg", "-y", "-nostats", "-progress", "pipe:1",
                         "-ss", f"{stime:.6f}", "-i", job.src,
                         "-frames:v", str(target), "-qscale:v", "2", pat],
                        on_stderr=lambda l: rep.log(l))
    stop.set()
    t.join()
    _check_cancel(job)
    if rc != 0 and not job.cancel_event.is_set():
        # ffmpeg 8+ exits -22 when the seek lands past EOF and 0 frames
        # are decoded (mjpeg encoder can't init with no frames). That's
        # the normal end of the chunk loop, not a real error.
        if count_files(indir) == 0:
            return 0
        raise RuntimeError(f"抽帧失败 (ffmpeg exit {rc})")
    return count_files(indir)


def watch_process(job, cmd, target_dir, expected, meter, base, span, label, rep):
    os.makedirs(target_dir, exist_ok=True)
    stop = threading.Event()
    t = _start_watcher(job, target_dir, expected, meter, base, span, label, stop)
    rc = job.runner.run(cmd, on_stdout=lambda l: rep.log(l), on_stderr=lambda l: rep.log(l))
    stop.set()
    t.join()
    _check_cancel(job)
    if rc != 0 and not job.cancel_event.is_set():
        raise RuntimeError(f"{label} 失败 (exit {rc})")
    return count_files(target_dir)


def encode_segment(job, outdir, expected, framerate, seg, crf, meter, base, span, rep):
    pat = os.path.join(outdir, "f_%08d.jpg")
    cmd = ["ffmpeg", "-y", "-nostats", "-progress", "pipe:1",
           "-framerate", framerate, "-start_number", "1",
           "-i", pat, "-c:v", "libx264", "-crf", str(crf), "-pix_fmt", "yuv420p", seg]

    def on_out(line):
        m = re.match(r"^frame=(\d+)$", line.strip())
        if m:
            n = int(m.group(1))
            meter.step(base + span * (n / max(expected, 1)), f"编码分片 {n}/{expected}")

    rc = job.runner.run(cmd, on_stdout=on_out, on_stderr=lambda l: rep.log(l))
    _check_cancel(job)
    if rc != 0 and not job.cancel_event.is_set():
        raise RuntimeError(f"编码分片失败 (exit {rc})")


def run_chunked(job, work, fn, fd, chunk, process, enc_framerate, crf, meter, rep, total_chunks):
    seglist = os.path.join(work, "segments.txt")
    segs = []
    with open(seglist, "w", encoding="utf-8") as sl:
        chunk_n = 1
        while True:
            _check_cancel(job)
            base = (chunk_n - 1) / max(total_chunks, 1)
            start_idx = (chunk_n - 1) * chunk
            stime = (start_idx + 0.5) * fd / fn
            indir = os.path.join(work, "in")
            outdir = os.path.join(work, "out")
            rep.log(f"=== chunk {chunk_n}/{total_chunks} (start {stime:.4f}s) ===")
            cnt = extract(job, indir, chunk, stime, meter, base, 0.4, rep)
            if cnt == 0:
                break
            _check_cancel(job)
            expected = process(indir, outdir, cnt, base + 0.4, 0.5, meter, rep)
            _check_cancel(job)
            seg = os.path.join(work, f"seg_{chunk_n}.mp4")
            encode_segment(job, outdir, expected, enc_framerate, seg, crf,
                           meter, base + 0.9, 0.1, rep)
            sl.write(f"file '{seg.replace(os.sep, '/')}'\n")
            sl.flush()
            segs.append(seg)
            shutil.rmtree(indir, ignore_errors=True)
            shutil.rmtree(outdir, ignore_errors=True)
            chunk_n += 1
    if not segs:
        raise RuntimeError("没有提取到任何帧，请检查输入视频")
    return segs


def mux(job, video_src, audio_src, outfile, video_filter=None, crf=18, rep=None):
    cmd = ["ffmpeg", "-y", "-i", video_src]
    if audio_src is not None:
        cmd += ["-i", audio_src]
    cmd += ["-map", "0:v"]
    if audio_src is not None:
        cmd += ["-map", "1:a?"]
    if video_filter:
        cmd += ["-vf", video_filter, "-c:v", "libx264", "-crf", str(crf), "-pix_fmt", "yuv420p"]
    else:
        cmd += ["-c:v", "copy"]
    if audio_src is not None:
        cmd += ["-c:a", "aac", "-b:a", "160k"]
    else:
        cmd += ["-an"]
    cmd += ["-shortest", outfile]
    rc = job.runner.run(cmd, on_stderr=lambda l: rep.log(l) if rep else None)
    if rc != 0 and not job.cancel_event.is_set():
        raise RuntimeError(f"输出失败: {os.path.basename(outfile)} (exit {rc})")


def concat_video(job, segs, rep):
    seglist = os.path.join(os.path.dirname(segs[0]), "segments.txt")
    concat = os.path.join(os.path.dirname(segs[0]), "concat.mp4")
    rep.log("合并分片...")
    rc = job.runner.run(["ffmpeg", "-y", "-f", "concat", "-safe", "0",
                         "-i", seglist, "-c:v", "copy", concat],
                        on_stderr=lambda l: rep.log(l))
    if rc != 0 and not job.cancel_event.is_set():
        raise RuntimeError(f"合并分片失败 (exit {rc})")
    return concat


def _out_path(src, suffix):
    d = os.path.dirname(os.path.abspath(src))
    name = os.path.splitext(os.path.basename(src))[0]
    return os.path.join(d, f"{name}{suffix}.mp4")


def _probe_fps(src, rep):
    p = probe_video(src)
    rep.log(f"输入: {p['width']}x{p['height']}, {p['fps_num']}/{p['fps_den']} fps, "
            f"{p['frames'] or '?'} 帧, {p['duration']:.1f}s")
    return p


def run_video2x(job, work):
    """Run Video2X with selectable processor (realesrgan or realcugan)."""
    src, opts, rep = job.src, job.opts, job.rep
    exe = find_video2x_exe()
    if not exe:
        raise RuntimeError(
            "未找到 Video2X。请将 Windows 包解压到项目的 video2x\\ 目录，"
            "或设置 VIDEO2X_EXE 环境变量后重试"
        )
    scale = int(opts.get("scale", 2))
    if scale not in (2, 3, 4):
        raise RuntimeError("Video2X 超分倍率只能是 2、3 或 4")

    # 选择处理器: realesrgan 或 realcugan
    processor = opts.get("video2x_processor", "realcugan")
    crf = int(opts.get("crf", 18))
    p = _probe_fps(src, rep)
    meter = ProgressMeter(rep, p["frames"])

    if processor == "realesrgan":
        # 使用 RealESRGAN 处理器
        model = opts.get("realesrgan_model", "realesr-animevideov3")
        if model not in ["realesr-animevideov3", "realesrgan-plus-anime", "realesrgan-plus"]:
            raise RuntimeError(f"未知 RealESRGAN 模型: {model}")
        outfile = _out_path(src, f"_x{scale}_{model}")
        rep.stage(f"Video2X / RealESRGAN x{scale} · {model}")
        cmd = [
            exe, "-i", src, "-o", outfile,
            "-p", "realesrgan", "-s", str(scale),
            "--realesrgan-model", model,
            "-c", "libx264", "-e", f"crf={crf}",
        ]
    elif processor == "realcugan":
        # 使用 RealCUGAN 处理器（原有逻辑）
        cugan_model = opts.get("realcugan_model", "models-se")
        try:
            noise_level = int(opts.get("noise_level", 0))
        except (TypeError, ValueError):
            raise RuntimeError("Real-CUGAN 降噪等级必须是 0 到 3 的整数")
        try:
            validate_realcugan_config(cugan_model, scale, noise_level)
        except ValueError as e:
            raise RuntimeError(str(e))
        noise_tag = "m1" if noise_level < 0 else str(noise_level)
        outfile = _out_path(src, f"_x{scale}_cugan_n{noise_tag}")
        rep.stage(f"Video2X / Real-CUGAN x{scale} · 降噪 {noise_level}")
        cmd = [
            exe, "-i", src, "-o", outfile,
            "-p", "realcugan", "-s", str(scale), f"--noise-level={noise_level}",
            "--realcugan-model", cugan_model,
            "-c", "libx264", "-e", f"crf={crf}",
        ]
    else:
        raise RuntimeError(f"未知处理器: {processor}，只支持 realesrgan 或 realcugan")

    rep.log("执行 Video2X: " + subprocess.list2cmdline(cmd))

    percent_re = re.compile(r"(\d+(?:\.\d+)?)\s*%")
    frame_re = re.compile(r"(?:frame|frames)\s*[:=]?\s*(\d+)(?:\s*/\s*(\d+))?", re.I)

    def on_line(line):
        rep.log(line)
        match = percent_re.search(line)
        if match:
            value = max(0.0, min(100.0, float(match.group(1))))
            meter.step(value / 100.0, f"Video2X {value:.1f}%")
            return
        match = frame_re.search(line)
        if match and p["frames"]:
            current = int(match.group(1))
            total = int(match.group(2)) if match.group(2) else p["frames"]
            meter.step(current / max(total, 1), f"Video2X {current}/{total}")

    rc = job.runner.run(cmd, cwd=os.path.dirname(exe), on_stdout=on_line, on_stderr=on_line)
    _check_cancel(job)
    if not os.path.isfile(outfile):
        raise RuntimeError(f"Video2X / Real-CUGAN 失败 (exit {rc})，未找到输出视频")
    try:
        probe_video(outfile)
    except Exception as e:
        raise RuntimeError(f"Video2X 输出视频无法读取 (exit {rc}): {e}")
    if rc != 0:
        rep.log(f"警告：Video2X 返回 exit {rc}，但输出视频已成功生成并通过读取校验；继续完成任务")
    meter.step(1.0, "Video2X 完成")
    return [outfile]


def run_upscale(job, work):
    src, opts, rep = job.src, job.opts, job.rep
    engine = opts.get("engine", "realesrgan")
    if engine == "video2x":
        return run_video2x(job, work)
    if engine != "realesrgan":
        raise RuntimeError(f"未知超分引擎: {engine}")
    scale = int(opts.get("scale", 2))
    model = opts.get("model", "realesr-animevideov3")
    if model not in MODELS_BY_NAME:
        raise RuntimeError(f"未知模型: {model}")
    if not model_downloaded(model):
        raise RuntimeError(f"模型未下载: {model}，请先在页面上点击下载")
    chunk = int(opts.get("chunk") or CHUNK_DEFAULT["upscale"])
    crf = int(opts.get("crf", 18))
    p = _probe_fps(src, rep)
    fn, fd = p["fps_num"], p["fps_den"]
    meter = ProgressMeter(rep, p["frames"])
    outfile = _out_path(src, f"_x{scale}")
    rep.stage(f"超分 x{scale} · {model}")
    total_chunks = max(1, math.ceil((p["frames"] or chunk) / chunk))

    def process(indir, outdir, cnt, base, span, m, r):
        r.log(f"  超分 {cnt} 帧 (x{scale})")
        watch_process(job, [REALESRGAN_EXE, "-i", indir, "-o", outdir,
                            "-n", model, "-s", str(scale), "-f", "jpg"],
                      outdir, cnt, m, base, span, "超分", r)
        return cnt

    segs = run_chunked(job, work, fn, fd, chunk, process, f"{fn}/{fd}", crf,
                       meter, rep, total_chunks)
    rep.stage("合并分片 + 混音")
    concat = concat_video(job, segs, rep)
    mux(job, concat, src, outfile, rep=rep)
    return [outfile]


def run_interp(job, work):
    src, opts, rep = job.src, job.opts, job.rep
    want60 = opts.get("want60", True)
    want45 = opts.get("want45", True)
    if not want60 and not want45:
        want60 = True
    chunk = int(opts.get("chunk") or CHUNK_DEFAULT["interp"])
    crf = int(opts.get("crf", 18))
    p = _probe_fps(src, rep)
    fn, fd = p["fps_num"], p["fps_den"]
    fn2 = fn * 2
    meter = ProgressMeter(rep, p["frames"])
    rep.stage("RIFE 2x 插值")
    total_chunks = max(1, math.ceil((p["frames"] or chunk) / chunk))

    def process(indir, outdir, cnt, base, span, m, r):
        expected = cnt * 2
        r.log(f"  插值 {cnt} 帧 -> {expected} 帧")
        watch_process(job, [RIFE_EXE, "-i", indir, "-o", outdir, "-m", RIFE_MODEL,
                            "-f", "f_%08d.jpg"],
                      outdir, expected, m, base, span, "插值", r)
        return expected

    segs = run_chunked(job, work, fn, fd, chunk, process, f"{fn2}/{fd}", crf,
                       meter, rep, total_chunks)
    rep.stage("合并分片 + 输出")
    concat = concat_video(job, segs, rep)
    outs = []
    if want60:
        out60 = _out_path(src, "_60hz")
        mux(job, concat, src, out60, rep=rep)
        outs.append(out60)
    if want45:
        out45 = _out_path(src, "_45hz")
        mux(job, concat, src, out45, video_filter="fps=45", crf=crf, rep=rep)
        outs.append(out45)
    return outs


def run_interp120(job, work):
    src, opts, rep = job.src, job.opts, job.rep
    chunk = int(opts.get("chunk") or CHUNK_DEFAULT["interp120"])
    crf = int(opts.get("crf", 18))
    p = _probe_fps(src, rep)
    fn, fd = p["fps_num"], p["fps_den"]
    fn2 = fn * 2
    meter = ProgressMeter(rep, p["frames"])
    rep.stage("RIFE 2x 插值 -> 120hz")
    total_chunks = max(1, math.ceil((p["frames"] or chunk) / chunk))

    def process(indir, outdir, cnt, base, span, m, r):
        expected = cnt * 2
        r.log(f"  插值 {cnt} 帧 -> {expected} 帧")
        watch_process(job, [RIFE_EXE, "-i", indir, "-o", outdir, "-m", RIFE_MODEL,
                            "-f", "f_%08d.jpg"],
                      outdir, expected, m, base, span, "插值", r)
        return expected

    segs = run_chunked(job, work, fn, fd, chunk, process, f"{fn2}/{fd}", crf,
                       meter, rep, total_chunks)
    rep.stage("合并分片 + 输出 120hz")
    concat = concat_video(job, segs, rep)
    out120 = _out_path(src, "_120hz")
    mux(job, concat, src, out120, rep=rep)
    return [out120]


def run_resize(job, work):
    src, opts, rep = job.src, job.opts, job.rep
    w = max(2, int(opts.get("width", 1920)) // 2 * 2)
    h = max(2, int(opts.get("height", 1080)) // 2 * 2)
    crf = int(opts.get("crf", 18))
    p = _probe_fps(src, rep)
    total = p["frames"] or 0
    meter = ProgressMeter(rep, total or None)
    outfile = _out_path(src, f"_{w}x{h}")
    rep.stage(f"缩放 {w}x{h}")
    cmd = ["ffmpeg", "-y", "-nostats", "-progress", "pipe:1", "-i", src,
           "-vf", f"scale={w}:{h}",
           "-c:v", "libx264", "-crf", str(crf), "-pix_fmt", "yuv420p",
           "-map", "0:v", "-map", "0:a?",
           "-c:a", "aac", "-b:a", "160k", "-shortest", outfile]

    def on_out(line):
        m = re.match(r"^frame=(\d+)$", line.strip())
        if m and total:
            n = int(m.group(1))
            meter.step(n / total, f"缩放 {n}/{total}")

    rc = job.runner.run(cmd, on_stdout=on_out, on_stderr=lambda l: rep.log(l))
    _check_cancel(job)
    if rc != 0 and not job.cancel_event.is_set():
        raise RuntimeError(f"缩放失败 (exit {rc})")
    return [outfile]
