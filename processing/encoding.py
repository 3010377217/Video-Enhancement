"""Final compression controls; size mode retries reuse the processed video input."""
import os


def final_encode(job, video_input, pipeline, vf, total_frames, partial, work, encode, event):
    runtime, source, config = job['runtime'], job['source'], job['config']
    encoder = job['encoder']
    mode = config['rateControl']
    duration = source['duration']
    audio = config['audio'] and source['audio']
    limit = int(float(config['sizeLimit']) * 1_000_000 * duration / 60) if mode == 'size' else None
    bitrate = float(config['bitrate']) * 1_000_000
    if limit is not None:
        bitrate = (limit * 0.92 - 8192) * 8 / duration - (192000 if audio else 0)
        if bitrate < 32000:
            raise RuntimeError('体积预算过低，无法容纳视频及音频，请提高上限或关闭音频')
    base = [runtime['ffmpeg'], '-nostdin', '-v', 'error', '-n'] + video_input
    if pipeline:
        base += ['-i', source['path']]
    base += ['-map', '0:v:0', '-vf', vf, '-c:v', encoder, '-preset', 'p5' if 'nvenc' in encoder else 'medium']
    if config['codec'] == 'hevc':
        base += ['-tag:v', 'hvc1']
    base += ['-pix_fmt', 'yuv420p', '-frames:v', str(total_frames), '-t', str(duration), '-map_metadata', '-1']
    audio_args = ['-map', '1:a:0?' if pipeline else '0:a:0?', '-c:a', 'aac', '-b:a', '192k'] if audio else ['-an']
    for attempt in range(3 if mode == 'size' else 1):
        partial.unlink(missing_ok=True)
        rate = []
        if mode == 'dynamic':
            rate = ['-rc', 'vbr', '-cq', config['qualityValue'], '-b:v', '0'] if 'nvenc' in encoder else ['-crf', config['qualityValue']]
        else:
            bits = str(round(bitrate))
            rate = ['-b:v', bits, '-maxrate', bits, '-bufsize', str(round(bitrate * 2))]
            if mode == 'fixed':
                rate += ['-minrate', bits]
                if 'nvenc' in encoder:
                    rate += ['-rc', 'cbr']
                elif encoder == 'libx264':
                    rate += ['-x264-params', 'nal-hrd=cbr:filler=1']
                elif encoder == 'libx265':
                    rate += ['-x265-params', 'strict-cbr=1']
        start = 0.8 if pipeline else 0
        span = 0.15 if pipeline else 0.95
        pass_args = []
        if mode == 'size' and encoder == 'libx264':
            prefix = str(work / f'pass-{attempt}')
            pass_args = ['-pass', '2', '-passlogfile', prefix]
            first = base + rate + ['-pass', '1', '-passlogfile', prefix, '-an', '-progress', 'pipe:1', '-f', 'null', os.devnull]
            # The null output can already exist, whereas real outputs never overwrite.
            first[first.index('-n')] = '-y'
            encode(first, duration, start=start, span=span * 0.35, stage=f'体积控制：分析第 {attempt + 1} 次')
            start += span * 0.35
            span *= 0.65
        args = base + rate + pass_args + audio_args + ['-movflags', '+faststart', '-progress', 'pipe:1', str(partial)]
        encode(args, duration, start=start, span=span, stage='最终压缩' if attempt == 0 else f'体积超限，重新压缩第 {attempt + 1} 次')
        if limit is None or partial.stat().st_size <= limit:
            return
        measured = partial.stat().st_size
        event('progress', stage=f'体积校验超限：{measured} / {limit} 字节', progress=0.9)
        bitrate *= limit / measured * 0.85
        if bitrate < 32000:
            break
    raise RuntimeError('已尝试压缩，仍不能满足体积上限；请提高预算或降低输出分辨率')
