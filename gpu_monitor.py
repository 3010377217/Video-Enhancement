# gpu_monitor.py
# 后台监听 GPU 占用，每隔 2 秒采样一次 nvidia-smi 的 GPU 利用率 + 显存，
# 并记录当时的流水线阶段（通过 process.log 推断）。输出到 gpu_monitor.log

import argparse
import os
import subprocess
import time

LOG = None
PROC_LOG = None
CREATE_NO_WINDOW = 0x08000000

# 从 process.log 判断当前阶段
def current_stage():
    if not PROC_LOG:
        return "?"
    try:
        with open(PROC_LOG, encoding="utf-8") as f:
            lines = [l.strip() for l in f if l.strip()]
        if not lines:
            return "?"
        last = lines[-1]
        for kw, label in [
            ("Real-ESRGAN 2x", "超分"),
            ("RIFE", "补帧"),
            ("抽帧", "抽帧"),
            ("编码", "编码+混音"),
            ("完成:", "完成"),
            ("====", "开始"),
        ]:
            if kw in last:
                return label
        return last[-20:]
    except OSError:
        return "?"

def gpu_info():
    try:
        r = subprocess.run(
            ["nvidia-smi", "--query-gpu=utilization.gpu,memory.used,memory.total",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, creationflags=CREATE_NO_WINDOW,
            timeout=5, encoding="utf-8", errors="replace")
        if r.returncode == 0:
            parts = [p.strip() for p in r.stdout.strip().split(",")]
            return parts[0], parts[1]  # util%, memMB
    except Exception:
        pass
    return "?", "?"

def main():
    parser = argparse.ArgumentParser(description="Record NVIDIA GPU utilization")
    parser.add_argument("--output", default="gpu_monitor.log", metavar="PATH",
                        help="Output log file; overwritten when monitoring starts")
    parser.add_argument("--process-log", metavar="PATH",
                        help="Optional process_videos.py log used to label the current stage")
    parser.add_argument("--interval", type=float, default=2.0, metavar="SECONDS",
                        help="Sampling interval in seconds (default: 2)")
    parser.add_argument("--once", action="store_true",
                        help="Record one sample and exit")
    args = parser.parse_args()
    if args.interval <= 0:
        parser.error("--interval must be greater than zero")

    global LOG, PROC_LOG
    LOG = os.path.abspath(args.output)
    PROC_LOG = os.path.abspath(args.process_log) if args.process_log else None
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    # 清空旧日志
    try:
        os.remove(LOG)
    except OSError:
        pass
    t0 = time.time()
    with open(LOG, "a", encoding="utf-8") as f:
        while True:
            el = int(time.time() - t0)
            util, mem = gpu_info()
            stage = current_stage()
            f.write(f"{el:5d}s GPU={util:>3}% 显存={mem}MB  [{stage}]\n")
            f.flush()
            if args.once:
                return
            time.sleep(args.interval)

if __name__ == "__main__":
    main()
