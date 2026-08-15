# webui.py
# Local Web GUI server for the video enhancement tools.
# Binds 127.0.0.1 only. Stdlib-only (no third-party deps).

import json
import os
import re
import shutil
import subprocess
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import video_tasks as vt

PORT = 8008
APP_DIR = vt.APP_DIR
STATIC = {
    "index.html": "text/html; charset=utf-8",
    "app.js": "application/javascript; charset=utf-8",
    "vue.global.prod.js": "application/javascript; charset=utf-8",
}

jobs = {}
job_order = []
lock = threading.Lock()
_counter = [0]
model_dls = {}
_dl_counter = [0]

_GPU_CACHE = {"name": None}


def _next_id():
    with lock:
        _counter[0] += 1
        return f"job{_counter[0]:03d}"


def gpu_name():
    if _GPU_CACHE["name"] is not None:
        return _GPU_CACHE["name"]
    name = None
    try:
        r = subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
                           capture_output=True, text=True, encoding="utf-8", errors="replace",
                           timeout=3, creationflags=vt.CREATE_NO_WINDOW)
        if r.returncode == 0:
            name = r.stdout.strip().splitlines()[0] if r.stdout.strip() else None
    except Exception:
        pass
    _GPU_CACHE["name"] = name
    return name


def state():
    with lock:
        active = [jobs[jid].info() for jid in job_order if jobs[jid].status in ("pending", "running")]
        recent = [jobs[jid].info() for jid in job_order[:8]]
    return {"active": active, "recent": recent, "gpu": gpu_name()}


def models():
    out = []
    for m in vt.MODELS:
        d = m.get("download")
        out.append({"name": m["name"], "label": m["label"], "mb": m["mb"],
                    "downloaded": vt.model_downloaded(m["name"]),
                    "zip_mb": d["zip_mb"] if d else None})
    return {"models": out}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "VideoTool/1.0"

    def log_message(self, fmt, *args):
        pass

    def _send(self, body: bytes, ctype, code=200):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8", code)

    def _static(self, name):
        if name not in STATIC or not os.path.isfile(os.path.join(APP_DIR, name)):
            return self._json({"error": "not found"}, 404)
        with open(os.path.join(APP_DIR, name), "rb") as f:
            self._send(f.read(), STATIC[name])

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if not n:
            return {}
        raw = self.rfile.read(n)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def do_GET(self):
        u = urlparse(self.path)
        path, qs = u.path, parse_qs(u.query)
        if path == "/":
            return self._static("index.html")
        name = path.lstrip("/")
        if name in STATIC:
            return self._static(name)
        if path == "/api/browse":
            p = qs.get("path", [None])[0]
            try:
                return self._json(vt.list_dir(p))
            except Exception as e:
                return self._json({"error": str(e)}, 400)
        if path == "/api/state":
            return self._json(state())
        if path == "/api/models":
            return self._json(models())
        m = re.match(r"^/api/model/download/(\w+)$", path)
        if m:
            st = model_dls.get(m.group(1))
            if not st:
                return self._json({"error": "下载任务不存在"}, 404)
            return self._json(st.info())
        m = re.match(r"^/api/stream/(\w+)$", path)
        if m:
            return self._stream(m.group(1))
        return self._json({"error": "not found"}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/probe":
            b = self._body()
            try:
                return self._json(vt.probe_video(b.get("path", "")))
            except Exception as e:
                return self._json({"error": str(e)}, 400)
        if path == "/api/job":
            return self._start_job(self._body())
        if path == "/api/open":
            return self._open(self._body())
        if path == "/api/model/download":
            return self._model_download(self._body())
        m = re.match(r"^/api/job/(\w+)/cancel$", path)
        if m:
            job = jobs.get(m.group(1))
            if not job:
                return self._json({"error": "任务不存在"}, 404)
            job.cancel()
            return self._json({"ok": True})
        return self._json({"error": "not found"}, 404)

    def _model_download(self, b):
        name = b.get("name")
        if name not in vt.MODELS_BY_NAME:
            return self._json({"error": "未知模型"}, 400)
        if vt.model_downloaded(name):
            return self._json({"error": "模型已下载"}, 400)
        with lock:
            if any(s.name == name and s.state == "running" for s in model_dls.values()):
                return self._json({"error": "该模型正在下载中"}, 409)
            _dl_counter[0] += 1
            dl_id = f"dl{_dl_counter[0]:03d}"
            st = vt.ModelDownloadState(name)
            model_dls[dl_id] = st
            if len(model_dls) > 20:
                old = [k for k, s in list(model_dls.items()) if s.state != "running"]
                for k in old[:len(model_dls) - 20]:
                    model_dls.pop(k, None)
        vt.start_model_download(name, st)
        return self._json({"dl_id": dl_id})

    def _start_job(self, b):
        mode, src = b.get("mode"), b.get("path")
        if mode not in {"upscale", "interp", "interp120", "resize"}:
            return self._json({"error": "未知模式"}, 400)
        if mode == "upscale" and b.get("model") not in vt.MODELS_BY_NAME:
            return self._json({"error": "未知模型"}, 400)
        if not src or not os.path.isfile(src):
            return self._json({"error": "文件不存在"}, 400)
        with lock:
            busy = [j for j in jobs.values() if j.status in ("pending", "running")]
            if busy:
                return self._json({"error": "已有任务在运行，请先等待完成或取消"}, 409)
        opts = {k: v for k, v in b.items() if k not in ("mode", "path")}
        jid = _next_id()
        job = vt.Job(jid, mode, src, opts)
        with lock:
            jobs[jid] = job
            job_order.insert(0, jid)
            if len(job_order) > 20:
                dropped = job_order.pop()
                jobs.pop(dropped, None)
        job.start()
        return self._json({"job_id": jid})

    def _open(self, b):
        path = b.get("path", "")
        how = b.get("how", "folder")
        if not path or not os.path.exists(path):
            return self._json({"error": "路径不存在"}, 400)
        try:
            if how == "file":
                os.startfile(path)
            elif os.path.isdir(path):
                subprocess.Popen(["explorer", path])
            else:
                subprocess.Popen(["explorer", "/select,", path])
            return self._json({"ok": True})
        except Exception as e:
            return self._json({"error": str(e)}, 400)

    def _sse(self, ev):
        payload = json.dumps(ev, ensure_ascii=False)
        self.wfile.write(f"data: {payload}\n\n".encode("utf-8"))
        self.wfile.flush()

    def _stream(self, jid):
        job = jobs.get(jid)
        if not job:
            return self._json({"error": "任务不存在"}, 404)
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            rep = job.rep
            last = 0
            while True:
                new = []
                with rep.cond:
                    while len(rep.history) <= last and job.status in ("pending", "running"):
                        rep.cond.wait(timeout=1.0)
                    hist = list(rep.history)
                    new = hist[last:]
                    last = len(hist)
                for ev in new:
                    self._sse(ev)
                if job.status in ("done", "error", "cancelled") and last >= len(rep.history):
                    self._sse({"type": "end"})
                    return
                if not new:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    url = f"http://127.0.0.1:{PORT}"
    gpu = gpu_name()
    print("=" * 56)
    print("  视频增强工具箱 - 本地 Web 界面")
    print(f"  GPU : {gpu or '未检测到 nvidia-smi'}")
    print(f"  地址: {url}  (仅本机可访问)")
    print("  停止: 关闭此窗口或按 Ctrl+C")
    print("=" * 56)
    threading.Timer(0.8, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
        server.shutdown()


if __name__ == "__main__":
    main()
