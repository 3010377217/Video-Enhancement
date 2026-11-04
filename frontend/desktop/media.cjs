const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { command } = require('./runtime.cjs');
const extensions = new Set(['.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4v']);
const key = file => path.resolve(file).toLowerCase();
const ratio = value => { const [a, b = 1] = String(value).split('/').map(Number); return b && Number.isFinite(a / b) ? a / b : 0; };

async function probe(file, runtime) {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error('请选择视频文件');
  if (!extensions.has(path.extname(file).toLowerCase())) throw new Error('不支持此文件类型');
  const { stdout } = await command(runtime.ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]);
  const data = JSON.parse(stdout);
  const video = data.streams?.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  if (!video?.width || !video.height) throw new Error('未找到可处理的视频画面');
  const rotation = Number(video.side_data_list?.find(side => side.rotation !== undefined)?.rotation ?? video.tags?.rotate ?? 0);
  const rotated = Math.abs(Math.round(rotation / 90)) % 2 === 1;
  const fpsRational = ratio(video.avg_frame_rate) > 0 ? video.avg_frame_rate : video.r_frame_rate;
  const fps = ratio(fpsRational);
  const duration = Number(video.duration ?? data.format?.duration);
  const rawDepth = Number(video.bits_per_raw_sample);
  const pixelDepth = /(?:p|gray)(9|10|12|14|16|32)(?:le|be)?$/.exec(video.pix_fmt ?? '');
  if (!(fps > 0) || !(duration > 0)) throw new Error('视频时长或帧率无效');
  return {
    id: randomUUID(), path: file, name: path.basename(file), bytes: stat.size,
    width: rotated ? video.height : video.width, height: rotated ? video.width : video.height,
    codedWidth: video.width, codedHeight: video.height, rotation, fps, fpsRational, duration,
    codec: video.codec_name, audio: data.streams.some(stream => stream.codec_type === 'audio'),
    hdr: ['smpte2084', 'arib-std-b67'].includes(video.color_transfer),
    bitDepth: rawDepth > 0 ? rawDepth : pixelDepth ? Number(pixelDepth[1]) : /(?:rgb|bgr|rgba|bgra)(?:48|64)/.test(video.pix_fmt ?? '') ? 16 : 8,
    sar: video.sample_aspect_ratio ?? '1:1',
    vfr: Math.abs(ratio(video.r_frame_rate) - fps) > 0.01,
    audioTracks: data.streams.filter(stream => stream.codec_type === 'audio').length,
    subtitles: data.streams.some(stream => stream.codec_type === 'subtitle'),
  };
}

class MediaLibrary {
  constructor(runtime) { this.runtime = runtime; this.items = new Map(); }
  async import(paths) {
    if (!Array.isArray(paths) || paths.length > 2000) throw new Error('一次最多添加 2000 个视频');
    const items = [], errors = [];
    for (const file of paths) {
      try {
        if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('无效的本地文件路径');
        const real = await fs.realpath(file);
        if ([...this.items.values()].some(item => key(item.path) === key(real))) { errors.push({ name: path.basename(file), message: '已在队列中，已跳过' }); continue; }
        const item = await probe(real, this.runtime);
        this.items.set(item.id, item); items.push(item);
      } catch (error) { errors.push({ name: typeof file === 'string' ? path.basename(file) : '文件', message: error.message.slice(-500) }); }
    }
    return { items, errors };
  }
  get(id) { const item = this.items.get(id); if (!item) throw new Error('视频已移除，请重新导入'); return item; }
  remove(ids) { for (const id of ids) this.items.delete(id); }
}

async function writableDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('请选择完整的输出目录');
  const stat = await fs.stat(directory).catch(() => null);
  if (!stat?.isDirectory()) throw new Error('输出目录不存在，请通过目录选择器创建或选择目录');
  const testFile = path.join(directory, `.framesequence-write-${randomUUID()}`);
  let handle;
  try { handle = await fs.open(testFile, 'wx'); } catch { throw new Error('输出目录不可写，请选择其他目录'); }
  finally { if (handle) { await handle.close(); await fs.unlink(testFile); } }
  return directory;
}

async function outputPath(source, config, reserved = new Set()) {
  const directory = await writableDirectory(config.destination === 'source' ? path.dirname(source.path) : config.directory);
  const suffix = typeof config.suffix === 'string' ? config.suffix : '_增强';
  if (suffix.length > 32 || /[\\/:*?"<>|\x00-\x1f]/.test(suffix)) throw new Error('文件名后缀包含无效字符');
  if (!['number', 'skip'].includes(config.collision)) throw new Error('同名文件规则无效');
  const stem = path.parse(source.path).name + suffix;
  let candidate = path.join(directory, `${stem}.mp4`), index = 1;
  while (key(candidate) === key(source.path) || reserved.has(key(candidate)) || await fs.stat(candidate).then(() => true, () => false)) {
    if (config.collision === 'skip' && key(candidate) !== key(source.path)) return { path: candidate, skip: true };
    candidate = path.join(directory, `${stem} (${index++}).mp4`);
  }
  reserved.add(key(candidate));
  return { path: candidate, skip: false };
}
module.exports = { probe, MediaLibrary, writableDirectory, outputPath, key };
