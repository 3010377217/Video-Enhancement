"""Bounded PNG chunks with one overlapping frame and a single streaming decoder."""
import math
import shutil
import struct
import subprocess
import threading
from pathlib import Path
from fractions import Fraction


def png_frame(stream):
    signature = stream.read(8)
    if not signature:
        return None
    if signature != b'\x89PNG\r\n\x1a\n':
        raise RuntimeError('抽帧数据不是完整 PNG')
    data = bytearray(signature)
    while True:
        header = stream.read(8)
        if len(header) != 8:
            raise RuntimeError('抽帧中途终止')
        length = struct.unpack('>I', header[:4])[0]
        if length > 200_000_000:
            raise RuntimeError('无效 PNG 数据块')
        body = stream.read(length + 4)
        if len(body) != length + 4:
            raise RuntimeError('抽帧文件不完整')
        data.extend(header); data.extend(body)
        if header[4:] == b'IEND':
            return bytes(data)


def enhance(job, work, width, height, execute, encode, event):
    runtime, config, source = job['runtime'], job['config'], job['source']
    fps = Fraction(source['fpsRational'])
    target_fps = fps if config['fps'] == 'source' else Fraction(config['fps'])
    total_source = max(1, round(source['duration'] * float(fps)))
    total_target = max(1, round(source['duration'] * float(target_fps)))
    ai = config['enhance'] == 'ai'
    speed = config['processingStrategy'] == 'speed'
    input_width = max(2, source['width'] // (4 if speed and ai else 2) * 2)
    input_height = max(2, source['height'] // (4 if speed and ai else 2) * 2)
    if not ai:
        input_width, input_height = width, height
    scale = 2 if speed else min(4, max(2, math.ceil(max(width / input_width, height / input_height))))
    chunk_size = max(4, min(48, 48_000_000 // max(width * height, input_width * input_height * scale * scale)))
    args = [runtime['ffmpeg'], '-nostdin', '-v', 'error', '-i', source['path'], '-an',
            '-vf', f'fps={fps},scale={input_width}:{input_height}:flags=lanczos,tpad=stop_mode=clone:stop_duration={2 / float(fps)}',
            '-frames:v', str(total_source), '-c:v', 'png', '-compression_level', '1', '-f', 'image2pipe', 'pipe:1']
    decoder = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    diagnostic = []
    reader = threading.Thread(target=lambda: diagnostic.append(decoder.stderr.read()), daemon=True)
    reader.start()
    parts = []
    carry = None
    start = 0
    try:
        while start < total_source:
            if shutil.disk_usage(work).free < max(256_000_000, width * height * chunk_size * 12):
                raise RuntimeError('缓存盘剩余空间不足，请释放磁盘空间后重试')
            count = min(chunk_size, total_source - start)
            input_dir = work / 'input'; sr_dir = work / 'sr'; resized = work / 'resized'; interpolated = work / 'interpolated'
            for directory in (input_dir, sr_dir, resized, interpolated):
                directory.mkdir(exist_ok=True)
            if carry is not None:
                (input_dir / 'f_00000001.png').write_bytes(carry)
            frames = 1 if carry is not None else 0
            needed = count + (1 if start + count < total_source else 0)
            while frames < needed:
                frame = png_frame(decoder.stdout)
                if frame is None:
                    raise RuntimeError('抽帧数量少于按时长计算的期望数量')
                frames += 1
                (input_dir / f'f_{frames:08d}.png').write_bytes(frame)
            carry = (input_dir / f'f_{frames:08d}.png').read_bytes()
            if frames == count:
                shutil.copyfile(input_dir / f'f_{frames:08d}.png', input_dir / f'f_{frames + 1:08d}.png')
                frames += 1
            stage = f'第 {len(parts) + 1} 块：'
            event('progress', stage=stage + ('AI 超分' if ai else '抽帧'), progress=0.8 * start / total_source)
            current = input_dir
            if ai:
                execute([runtime['sr'], '-i', str(input_dir), '-o', str(sr_dir), '-m', runtime['srModels'],
                         '-n', 'realesr-animevideov3', '-s', str(scale), '-t', '128', '-j', '1:2:2', '-f', 'png'])
                if len(list(sr_dir.glob('*.png'))) != frames:
                    raise RuntimeError('超分输出帧数不完整')
                current = sr_dir
            execute([runtime['ffmpeg'], '-nostdin', '-v', 'error', '-framerate', str(fps), '-i', str(current / 'f_%08d.png'),
                     '-vf', f'scale={width}:{height}:flags=lanczos,setsar=1', '-c:v', 'png', '-compression_level', '1', str(resized / 'f_%08d.png')])
            target_start = round(start * target_fps / fps)
            target_end = min(total_target, round((start + count) * target_fps / fps))
            out_count = target_end - target_start
            if target_fps > fps:
                event('progress', stage=stage + 'RIFE 补帧', progress=0.8 * (start + count * 0.5) / total_source)
                try:
                    execute([runtime['rife'], '-i', str(resized), '-o', str(interpolated), '-m', runtime['rifeModel'],
                             '-n', str(out_count + 1), '-j', '1:2:2', '-f', '%08d.png'])
                except RuntimeError:
                    if len(list(interpolated.glob('*.png'))) < out_count + 1:
                        raise
                    # NCNN Windows teardown errors are accepted only after complete PNG decode below.
                files = sorted(interpolated.glob('*.png'))
                if len(files) != out_count + 1:
                    raise RuntimeError('RIFE 输出帧数校验失败')
                for index, file in enumerate(files[:out_count], 1):
                    file.rename(work / f'out_{index:08d}.png')
            else:
                for index in range(out_count):
                    source_index = min(frames - 1, max(0, round((target_start + index) * fps / target_fps) - start)) + 1
                    shutil.copyfile(resized / f'f_{source_index:08d}.png', work / f'out_{index + 1:08d}.png')
            if out_count:
                part = work / f'part_{len(parts):06d}.mkv'
                execute([runtime['ffmpeg'], '-nostdin', '-v', 'error', '-framerate', str(target_fps), '-i', str(work / 'out_%08d.png'),
                         '-frames:v', str(out_count), '-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'yuv420p', str(part)])
                parts.append(part)
            for file in work.glob('out_*.png'):
                file.unlink()
            for directory in (input_dir, sr_dir, resized, interpolated):
                shutil.rmtree(directory)
            start += count
        decoder.wait(); reader.join()
        if decoder.returncode:
            raise RuntimeError(b''.join(diagnostic).decode('utf-8', 'replace')[-2000:])
    finally:
        if decoder.poll() is None:
            decoder.kill(); decoder.wait()
    listing = work / 'parts.txt'
    listing.write_text(''.join(f"file '{file.name}'\n" for file in parts), encoding='utf-8')
    event('progress', stage='AI 阶段完成，准备最终压缩', progress=0.8)
    return ['-f', 'concat', '-safe', '1', '-i', str(listing)], target_fps, total_target
