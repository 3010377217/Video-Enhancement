#!/usr/bin/env python3
"""Batch-run anime60 over every .mp4 in a source folder, outputting to an out folder.

Resumable: files whose output already exists are skipped.
"""
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC_DIR = r"W:\Hanime\改版动漫"
OUT_DIR = r"W:\new hanime"
SKIP_SUBDIRS = {"JianyingPro Presets"}


def run_one(src):
    if not src.lower().endswith(".mp4"):
        return None
    name = os.path.splitext(os.path.basename(src))[0]
    out_path = os.path.join(OUT_DIR, f"{name}_60fps.mp4")
    if os.path.isfile(out_path):
        return ("skip", name, out_path)
    # unique workdir under ROOT so interrupted runs leave a diagnosable temp dir
    workdir = os.path.join(ROOT, f"_batch_{name}")
    return ("run", name, out_path)


def main():
    if not os.path.isdir(OUT_DIR):
        os.makedirs(OUT_DIR)
    targets = []
    for entry in sorted(os.listdir(SRC_DIR)):
        full = os.path.join(SRC_DIR, entry)
        if os.path.isfile(full) and full.lower().endswith(".mp4"):
            targets.append(full)

    todo = [t for t in targets if run_one(t)[0] == "run"]
    done = [t for t in targets if run_one(t)[0] == "skip"]
    print(f"[batch] found {len(targets)} videos; {len(done)} already done, {len(todo)} to process")
    for t in done:
        print(f"[batch]   SKIP (exists): {os.path.basename(t)}")

    for i, src in enumerate(todo, 1):
        _, name, _ = run_one(src)
        workdir = os.path.join(ROOT, f"_batch_{name}")
        print(f"\n[batch] ===== [{i}/{len(todo)}] {name} =====", flush=True)
        t0 = time.time()
        r = subprocess.run(
            [sys.executable, os.path.join(ROOT, "anime60.py"), src,
             "--outdir", OUT_DIR, "--workdir", workdir,
             "--rife-threads", "4"])
        dt = time.time() - t0
        if r.returncode != 0:
            print(f"[batch] FAILED {name} after {dt/60:.1f} min (rc={r.returncode}); stopping batch", flush=True)
            return 1
        print(f"[batch] OK {name} in {dt/60:.1f} min", flush=True)

    print("\n[batch] all done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
