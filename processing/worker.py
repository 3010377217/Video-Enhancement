"""Desktop worker. JSON on stdout, diagnostics on stderr; no shell commands."""
import json
import os
import subprocess
import sys
import threading
import time
import shutil
from fractions import Fraction
from pathlib import Path

CREATE_NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)


def event(kind, **data):
    print(json.dumps({'type': kind, **data}, ensure_ascii=False), flush=True)


def execute(args, *, capture=True):
    result = subprocess.run(args, stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                            stderr=subprocess.PIPE, creationflags=CREATE_NO_WINDOW)
    if result.returncode:
        raise RuntimeError(result.stderr.decode('utf-8', 'replace')[-4000:])
    return result.stdout


def metadata(file, runtime):
    return json.loads(execute([runtime['ffprobe'], '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(file)]))


def encode(args, duration, start=0, span=0.95, stage='编码'):
    event('progress', stage=stage, progress=start)
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            creationflags=CREATE_NO_WINDOW)
    tail = []

    def drain():
        for line in proc.stderr:
            tail.append(line.decode('utf-8', 'replace'))
            if len(tail) > 100:
                del tail[:50]
    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    last = 0
    for raw in proc.stdout:
        line = raw.decode('utf-8', 'replace').strip()
        if line.startswith('out_time_us='):
            try:
                progress = min(1, max(0, int(line.split('=', 1)[1]) / 1_000_000 / duration))
                now = time.monotonic()
                if now - last > 0.2:
                    event('progress', stage=stage, progress=start + progress * span)
                    last = now
            except ValueError:
                pass
    proc.wait()
    reader.join()
    if proc.returncode:
        raise RuntimeError(''.join(tail)[-4000:] or f'编码退出 {proc.returncode}')


def filters(job):
    config, source = job['config'], job['source']
    if config['resolution'] == 'source':
        width, height = source['width'], source['height']
    elif config['resolution'] == 'custom':
        width, height = int(config['width']), int(config['height'])
    else:
        width, height = {'720p': (1280, 720), '1080p': (1920, 1080), '2k': (2560, 1440), '4k': (3840, 2160)}[config['resolution']]
        if source['height'] > source['width']:
            width, height = height, width
    width, height = max(16, width // 2 * 2), max(16, height // 2 * 2)
    if config['keepRatio'] and config['resolution'] != 'source':
        factor = min(width / source['width'], height / source['height'])
        width = max(16, int(source['width'] * factor) // 2 * 2)
        height = max(16, int(source['height'] * factor) // 2 * 2)
    return width, height, f'scale={width}:{height}:flags=lanczos,setsar=1'


def process(job):
    runtime, config, source = job['runtime'], job['config'], job['source']
    output = Path(job['output'])
    partial = output.with_name(f'.{output.stem}.{job["id"]}.partial.mp4')
    width, height, vf = filters(job)
    work = Path(job['work'])
    work.mkdir(parents=True, exist_ok=False)
    try:
        target_fps = Fraction(source['fpsRational']) if config['fps'] == 'source' else Fraction(config['fps'])
        source_fps = Fraction(source['fpsRational'])
        pipeline = config['enhance'] == 'ai' or target_fps > source_fps
        if pipeline:
            from ai import enhance
            video_input, target_fps, total_frames = enhance(job, work, width, height, execute, encode, event)
        else:
            video_input = ['-i', source['path']]
            total_frames = max(1, round(source['duration'] * float(target_fps)))
            if config['fps'] != 'source' or source.get('vfr'):
                vf += f',fps={target_fps}'
        from encoding import final_encode
        final_encode(job, video_input, pipeline, vf, total_frames, partial, work, encode, event)
        event('progress', stage='校验成片', progress=0.96)
        result = metadata(partial, runtime)
        video = next(stream for stream in result['streams'] if stream['codec_type'] == 'video')
        if video['width'] != width or video['height'] != height:
            raise RuntimeError('输出尺寸校验失败')
        actual_duration = float(result['format']['duration'])
        if abs(actual_duration - source['duration']) > max(0.25, 2 / source['fps']):
            raise RuntimeError('输出时长校验失败')
        actual_fps = float(Fraction(video['avg_frame_rate']))
        if abs(actual_fps - float(target_fps)) > 0.02:
            raise RuntimeError('输出帧率校验失败')
        has_audio = any(stream['codec_type'] == 'audio' for stream in result['streams'])
        if has_audio != (config['audio'] and source['audio']):
            raise RuntimeError('输出音轨校验失败')
        execute([runtime['ffmpeg'], '-v', 'error', '-i', str(partial), '-f', 'null', '-'], capture=False)
        # On Windows rename fails when destination exists, preserving unrelated files.
        if output.exists():
            raise RuntimeError('输出文件已被其他程序创建，请重新生成文件名')
        partial.rename(output)
        event('completed', output=str(output), width=width, height=height, fps=actual_fps,
              bytes=output.stat().st_size, duration=actual_duration, encoder=job['encoder'])
    finally:
        partial.unlink(missing_ok=True)
        shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    try:
        from winprocess import attach
        attach()
        job = json.load(sys.stdin)
        process(job)
    except Exception as error:
        event('failed', error=str(error))
        sys.exit(1)
