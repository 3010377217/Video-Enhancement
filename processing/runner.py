"""Keep the lifetime guard awake while the processing worker is suspended."""
import json
import subprocess
import sys
from pathlib import Path
from winprocess import attach


if __name__ == '__main__':
    try:
        attach()
        job = json.load(sys.stdin)
        child = subprocess.Popen([sys.executable, '-X', 'utf8', '-u', str(Path(__file__).with_name('worker.py'))],
                                 stdin=subprocess.PIPE, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        print(json.dumps({'type': 'progress', 'progress': 0, 'stage': '准备处理', 'workerPid': child.pid}), flush=True)
        child.communicate(json.dumps(job).encode('utf-8'))
        sys.exit(child.returncode)
    except Exception as error:
        print(json.dumps({'type': 'failed', 'error': str(error)}, ensure_ascii=False), flush=True)
        sys.exit(1)
