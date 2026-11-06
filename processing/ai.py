"""Bounded PNG chunks with one overlapping frame and a single streaming decoder."""
import shutil
import struct
import subprocess
import threading
import time
from collections import defaultdict
from pathlib import Path
from fractions import Fraction
from planning import super_resolution_plan


def png_size(file):
    with file.open('rb') as stream:
        header = stream.read(24)
    if len(header) != 24 or header[:8] != b'\x89PNG\r\n\x1a\n' or header[12:16] != b'IHDR':
        raise RuntimeError('无法读取超分图像尺寸')
    return struct.unpack('>II', header[16:24])


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


# Measured on anime frames: PNG about 1.0-1.2 bytes/pixel; x264 CRF 12 intermediate parts
# about 0.035, padded for detail-heavy content.
PNG_BYTES_PER_PIXEL = 1.5
PART_BYTES_PER_PIXEL = 0.1
MAX_CHUNK = 1000
CHUNK_CACHE_BUDGET = 4_000_000_000
SR_TILES = ('512', '128')  # larger tile is ~20% faster; fall back if VRAM runs out
PART_BYTES = {'lossless': 0.35}  # lossless x264 parts are ~10x larger than CRF 12
SR_THREADS = '1:2:2'  # realesrgan-ncnn-vulkan's own default for -j load:proc:save
SR_THREAD_CHOICES = ('1:1:1', '1:2:2', '2:2:2', '2:4:2', '4:4:4')


def custom_options(config):
    """Advanced controls apply only to the custom strategy; others use the automatic values."""
    if config.get('processingStrategy') != 'custom':
        return {'tiles': SR_TILES, 'chunk': None, 'quality': '12', 'threads': SR_THREADS}
    tile = str(config.get('srTile', 'auto'))
    chunk = str(config.get('chunkFrames', 'auto'))
    threads = str(config.get('srThreads', 'auto'))
    return {
        'threads': threads if threads in SR_THREAD_CHOICES else SR_THREADS,
        'tiles': SR_TILES if tile == 'auto' else tuple(dict.fromkeys((tile, SR_TILES[-1]))),
        'chunk': None if chunk == 'auto' else max(1, min(MAX_CHUNK, int(chunk))),
        'quality': str(config.get('interQuality', '12')),
    }


def part_codec_args(quality):
    return ['-qp', '0'] if quality == 'lossless' else ['-crf', quality]


def frame_cost(plan, width, height, ratio):
    """Worst-case cache bytes per source frame while one chunk is being processed."""
    base = plan['inputWidth'] * plan['inputHeight']
    pixels, factor = base, 1
    for scale in plan['scales']:
        factor *= scale
        pixels += base * factor * factor
    if plan['postResize']:
        pixels += width * height
    pixels += width * height * ratio
    return pixels * PNG_BYTES_PER_PIXEL


def choose_chunk(free, per_frame, reserve):
    budget = min(CHUNK_CACHE_BUDGET, max(0, free - reserve) * 0.6)
    return int(max(1, min(MAX_CHUNK, budget // per_frame)))


def run_sr(execute, event, runtime, source_dir, target_dir, scale, frames, report, tiles=SR_TILES, threads=SR_THREADS):
    """One Real-ESRGAN call; a watcher reports finished frames while it runs."""
    stop = threading.Event()

    def watch():
        last = -1
        while not stop.wait(1.0):
            done = sum(1 for _ in target_dir.glob('*.png'))
            if done != last:
                last = done
                report(min(done, frames))
    watcher = threading.Thread(target=watch, daemon=True)
    watcher.start()
    try:
        for index, tile in enumerate(tiles):
            try:
                execute([runtime['sr'], '-i', str(source_dir), '-o', str(target_dir), '-m', runtime['srModels'],
                         '-n', 'realesr-animevideov3', '-s', str(scale), '-t', tile, '-j', threads, '-f', 'png'])
                return
            except RuntimeError:
                if index == len(tiles) - 1:
                    raise
                for stale in target_dir.glob('*.png'):
                    stale.unlink()
    finally:
        stop.set()
        watcher.join()


def enhance(job, work, width, height, execute, encode, event):
    runtime, config, source = job['runtime'], job['config'], job['source']
    source_fps = Fraction(source['fpsRational'])
    target_fps = source_fps if config['fps'] == 'source' else Fraction(config['fps'])
    # Discard unwanted frames before expensive inference when lowering fps.
    fps = min(source_fps, target_fps)
    total_source = max(1, round(source['duration'] * float(fps)))
    total_target = max(1, round(source['duration'] * float(target_fps)))
    ai = config['enhance'] == 'ai'
    options = custom_options(config)
    # Custom plans like speed (pre-shrunk input); only the tuning knobs differ.
    strategy = 'speed' if config['processingStrategy'] == 'custom' else config['processingStrategy']
    plan = super_resolution_plan(source['width'], source['height'], width, height, strategy) if ai else {
        'inputWidth': width, 'inputHeight': height, 'scales': [], 'aiWidth': width, 'aiHeight': height,
        'outputWidth': width, 'outputHeight': height, 'postResize': False,
        'preResize': (width, height) != (source['width'], source['height']),
    }
    input_width, input_height = plan['inputWidth'], plan['inputHeight']
    interpolate = target_fps > fps
    plan.update(sourceFrames=max(1, round(source['duration'] * float(source_fps))),
                inferenceFrames=total_source, targetFrames=total_target, normalizedFps=str(fps),
                intermediatePixelFormat='yuv420p', intermediateCodec=f"libx264 {options['quality']}")
    stages = ' × '.join(map(str, plan['scales']))
    description = f"AI 输入 {input_width}×{input_height}，倍率 {stages}，输出 {width}×{height}" if ai else '准备 RIFE 补帧'
    event('progress', stage=description, progress=0, processingPlan=plan)
    ratio = float(target_fps / fps) if interpolate else 0
    per_frame = frame_cost(plan, width, height, ratio)
    # Keep room for the intermediate parts that stay on disk until the final encode.
    reserve = total_target * width * height * PART_BYTES.get(options['quality'], PART_BYTES_PER_PIXEL)
    free = shutil.disk_usage(work).free
    # Fail before any inference when the cache drive cannot hold the intermediate parts
    # plus two frames of working space; otherwise the task would die hours in.
    required = reserve + per_frame * 2
    if free < required:
        raise RuntimeError(f'缓存盘剩余空间不足：预计至少需要 {required / 1e9:.1f} GB，当前可用 {free / 1e9:.1f} GB，请释放空间后重试')
    timings = defaultdict(float)
    if options['chunk']:
        chunk_size = options['chunk']
        if per_frame * (chunk_size + 1) + reserve > free:
            fit = int(max(0, free - reserve) // per_frame)
            raise RuntimeError(f'分块帧数过大：当前缓存盘最多约 {fit} 帧，请调小或释放磁盘空间')
    else:
        chunk_size = choose_chunk(free, per_frame, reserve)
    decode_filters = [f'fps={fps}']
    if plan['preResize']:
        decode_filters.append(f'scale={input_width}:{input_height}:flags=lanczos')
    decode_filters.append(f'tpad=stop_mode=clone:stop_duration={2 / float(fps)}')
    args = [runtime['ffmpeg'], '-nostdin', '-v', 'error', '-i', source['path'], '-an',
            '-vf', ','.join(decode_filters),
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
            count = min(chunk_size, total_source - start)
            if shutil.disk_usage(work).free < max(256_000_000, per_frame * (count + 1)):
                raise RuntimeError('缓存盘剩余空间不足，请释放磁盘空间后重试')
            input_dir = work / 'input'; resized = work / 'resized'; interpolated = work / 'interpolated'
            directories = [input_dir, resized, interpolated]
            for directory in directories:
                directory.mkdir(exist_ok=True)
            if carry is not None:
                (input_dir / 'f_00000001.png').write_bytes(carry)
            frames = 1 if carry is not None else 0
            needed = count + (1 if interpolate and start + count < total_source else 0)
            mark = time.monotonic()
            while frames < needed:
                frame = png_frame(decoder.stdout)
                if frame is None:
                    raise RuntimeError('抽帧数量少于按时长计算的期望数量')
                frames += 1
                (input_dir / f'f_{frames:08d}.png').write_bytes(frame)
            timings['抽帧'] += time.monotonic() - mark
            carry = (input_dir / f'f_{frames:08d}.png').read_bytes() if interpolate else None
            if interpolate and frames == count:
                shutil.copyfile(input_dir / f'f_{frames:08d}.png', input_dir / f'f_{frames + 1:08d}.png')
                frames += 1
            stage = f'第 {len(parts) + 1} 块：'
            event('progress', stage=stage + ('AI 超分' if ai else '抽帧'), progress=0.8 * start / total_source)
            current = input_dir
            current_width, current_height = png_size(input_dir / 'f_00000001.png')
            if (current_width, current_height) != (input_width, input_height):
                raise RuntimeError('实际超分输入尺寸与处理方案不一致')
            for index, scale in enumerate(plan['scales']):
                sr_dir = work / f'sr-{index}'
                sr_dir.mkdir(); directories.append(sr_dir)
                sr_share = 0.5 if interpolate else 0.9
                mark = time.monotonic()
                run_sr(execute, event, runtime, current, sr_dir, scale, frames,
                       lambda done, index=index: event(
                           'progress', stage=stage + 'AI 超分',
                           progress=0.8 * (start + count * sr_share * (index + done / frames) / len(plan['scales'])) / total_source),
                       options['tiles'], options['threads'])
                timings['超分'] += time.monotonic() - mark
                if len(list(sr_dir.glob('*.png'))) != frames:
                    raise RuntimeError('超分输出帧数不完整')
                actual_width, actual_height = png_size(sr_dir / 'f_00000001.png')
                if (actual_width, actual_height) != (current_width * scale, current_height * scale):
                    raise RuntimeError('模型实际输出尺寸与超分倍率不一致')
                event('progress', stage=stage + f'{scale}×超分完成',
                      progress=0.8 * (start + count * sr_share * (index + 1) / len(plan['scales'])) / total_source,
                      aiPass={'inputWidth': current_width, 'inputHeight': current_height,
                              'outputWidth': actual_width, 'outputHeight': actual_height, 'scale': scale, 'frames': frames})
                current_width, current_height = actual_width, actual_height
                # The carried frame is already in memory, so even the source PNGs can go after the first pass.
                shutil.rmtree(current, ignore_errors=True)
                current = sr_dir
            if plan['postResize']:
                execute([runtime['ffmpeg'], '-nostdin', '-v', 'error', '-framerate', str(fps), '-i', str(current / 'f_%08d.png'),
                         '-vf', f'scale={width}:{height}:flags=lanczos,setsar=1', '-c:v', 'png', '-compression_level', '1', str(resized / 'f_%08d.png')])
                shutil.rmtree(current, ignore_errors=True)  # Full-size SR frames are no longer needed.
                current = resized
            target_start = round(start * target_fps / fps)
            target_end = min(total_target, round((start + count) * target_fps / fps))
            out_count = target_end - target_start
            if interpolate:
                event('progress', stage=stage + 'RIFE 补帧', progress=0.8 * (start + count * 0.5) / total_source)
                mark = time.monotonic()
                try:
                    execute([runtime['rife'], '-i', str(current), '-o', str(interpolated), '-m', runtime['rifeModel'],
                             '-n', str(out_count + 1), '-j', '1:2:2', '-f', '%08d.png'])
                except RuntimeError:
                    if len(list(interpolated.glob('*.png'))) < out_count + 1:
                        raise
                    # NCNN Windows teardown errors are accepted only after complete PNG decode below.
                timings['补帧'] += time.monotonic() - mark
                files = sorted(interpolated.glob('*.png'))
                if len(files) != out_count + 1:
                    raise RuntimeError('RIFE 输出帧数校验失败')
                for index, file in enumerate(files[:out_count], 1):
                    file.rename(work / f'out_{index:08d}.png')
            if out_count:
                part = work / f'part_{len(parts):06d}.mkv'
                frames_input = work / 'out_%08d.png' if interpolate else current / 'f_%08d.png'
                mark = time.monotonic()
                execute([runtime['ffmpeg'], '-nostdin', '-v', 'error', '-framerate', str(target_fps), '-i', str(frames_input),
                         '-frames:v', str(out_count), '-c:v', 'libx264', '-preset', 'veryfast', *part_codec_args(options['quality']), '-pix_fmt', 'yuv420p', str(part)])
                timings['分段编码'] += time.monotonic() - mark
                parts.append(part)
            for file in work.glob('out_*.png'):
                file.unlink()
            for directory in directories:
                shutil.rmtree(directory, ignore_errors=True)
            start += count
        decoder.wait(); reader.join()
        if decoder.returncode:
            raise RuntimeError(b''.join(diagnostic).decode('utf-8', 'replace')[-2000:])
    finally:
        if decoder.poll() is None:
            decoder.kill(); decoder.wait()
    listing = work / 'parts.txt'
    listing.write_text(''.join(f"file '{file.name}'\n" for file in parts), encoding='utf-8')
    event('progress', stage='AI 阶段完成，准备最终压缩', progress=0.8,
          stageSeconds={name: round(seconds, 2) for name, seconds in timings.items()})
    return ['-f', 'concat', '-safe', '1', '-i', str(listing)], target_fps, total_target
