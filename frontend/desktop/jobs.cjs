const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { outputPath, probe, writableDirectory } = require('./media.cjs');

// Default cache sits beside the program (portable exe folder, install folder, or the
// project root in development). The user may pick another drive; if the default folder
// is read-only (e.g. Program Files) the system temp folder is the last resort.
function defaultCacheBase() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  const packaged = process.versions.electron && path.basename(process.execPath).toLowerCase() !== 'electron.exe';
  return packaged ? path.dirname(process.execPath) : path.resolve(__dirname, '..', '..');
}
async function resolveCacheBase(config) {
  if (config.cacheDir) {
    await writableDirectory(config.cacheDir).catch(error => { throw new Error(`缓存目录不可用：${error.message}`); });
    return config.cacheDir;
  }
  const base = defaultCacheBase();
  try { await writableDirectory(base); return base; }
  catch { return require('node:os').tmpdir(); }
}
const { command } = require('./runtime.cjs');

async function removePartial(file) {
  for (let attempt = 0; ; attempt++) {
    try { await fs.unlink(file); return; }
    catch (error) {
      if (error.code === 'ENOENT') return;
      if (attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

function validate(config) {
  if (!config || typeof config !== 'object') throw new Error('配置无效');
  for (const [field, choices] of Object.entries({ enhance: ['resize', 'ai'], processingStrategy: ['speed', 'quality', 'custom'], resolution: ['source', '720p', '1080p', '2k', '4k', 'custom'], fps: ['source', '24', '30', '60', '120'], codec: ['h264', 'hevc'], rateControl: ['dynamic', 'fixed', 'size'], destination: ['custom', 'source'], collision: ['number', 'skip'] })) {
    if (!choices.includes(config[field])) throw new Error(`无效配置：${field}`);
  }
  if (typeof config.audio !== 'boolean' || typeof config.keepRatio !== 'boolean') throw new Error('音频或宽高比配置无效');
  // Advanced controls are optional so older saved settings stay valid.
  if (config.cacheDir !== undefined && (typeof config.cacheDir !== 'string' || config.cacheDir && !path.isAbsolute(config.cacheDir))) throw new Error('缓存目录需为完整路径，或留空使用程序所在目录');
  if (config.srTile !== undefined && !['auto', '128', '256', '512', '1024'].includes(config.srTile)) throw new Error('无效配置：srTile');
  if (config.srThreads !== undefined && !['auto', '1:1:1', '1:2:2', '2:2:2', '2:4:2', '4:4:4'].includes(config.srThreads)) throw new Error('无效配置：srThreads');
  if (config.interQuality !== undefined && !['lossless', '12', '18'].includes(config.interQuality)) throw new Error('无效配置：interQuality');
  if (config.chunkFrames !== undefined && config.chunkFrames !== 'auto' && !(/^\d+$/.test(config.chunkFrames) && Number(config.chunkFrames) >= 10 && Number(config.chunkFrames) <= 1000)) throw new Error('分块帧数需为自动或 10～1000 的整数');
  if (config.resolution === 'custom' && ![config.width, config.height].every(value => Number.isInteger(Number(value)) && Number(value) >= 16 && Number(value) <= 7680 && Number(value) % 2 === 0)) throw new Error('自定义宽高需为 16～7680 之间的偶数');
  if (config.rateControl === 'dynamic' && !(/^\d+$/.test(config.qualityValue) && Number(config.qualityValue) >= 1 && Number(config.qualityValue) <= 51)) throw new Error('质量值需为 1～51 的整数');
  if (config.rateControl === 'fixed' && !(Number(config.bitrate) >= 0.1 && Number(config.bitrate) <= 1000)) throw new Error('视频码率需在 0.1～1000 Mbps');
  if (config.rateControl === 'size' && !(Number(config.sizeLimit) >= 0.1 && Number.isFinite(Number(config.sizeLimit)))) throw new Error('体积上限需不小于 0.1 MB');
  return JSON.parse(JSON.stringify(config));
}

class Jobs {
  constructor({ runtime, library, environment, emit }) { Object.assign(this, { runtime, library, environment, emit }); this.active = null; this.results = new Map(); }
  async prepare(id, input, reserved) {
    const config = validate(input), original = this.library.get(id);
    const source = { ...await probe(original.path, this.runtime), id: original.id };
    if (source.bytes !== original.bytes || source.width !== original.width || source.height !== original.height || Math.abs(source.duration - original.duration) > 0.01) throw new Error('源文件已改变，请移除后重新导入');
    await fs.access(source.path);
    if (source.hdr || source.bitDepth > 8 || source.sar !== '1:1' && source.sar !== 'N/A') throw new Error('当前版本暂不处理 HDR、高位深或非方形像素视频，避免静默改变画面');
    const required = [];
    if (config.enhance === 'ai') required.push(this.runtime.sr, ...[2, 3, 4].flatMap(scale => ['bin', 'param'].map(ext => path.join(this.runtime.srModels, `realesr-animevideov3-x${scale}.${ext}`))));
    if (config.fps !== 'source' && Number(config.fps) > source.fps) required.push(this.runtime.rife, ...['bin', 'param'].map(ext => path.join(this.runtime.rifeModel, `flownet.${ext}`)));
    for (const file of required) await fs.access(file).catch(() => { throw new Error(`缺少处理所需文件：${path.basename(file)}`); });
    const cacheBase = await resolveCacheBase(config);
    const capability = await this.environment();
    const hardware = config.codec === 'hevc' ? 'hevc_nvenc' : 'h264_nvenc';
    const software = config.codec === 'hevc' ? 'libx265' : 'libx264';
    const encoder = (config.rateControl === 'size' ? [software] : [hardware, software]).find(name => capability.encoders.some(item => item.name === name && item.ok));
    if (!encoder) throw new Error('当前环境没有可用的视频编码器');
    const target = await outputPath(source, config, reserved);
    return { id: randomUUID(), videoId: id, source, config, output: target.path, skip: target.skip, encoder, runtime: this.runtime, cacheBase };
  }
  async start(id, config) {
    if (this.active) throw new Error('已有任务正在处理');
    this.active = { preparing: true };
    try { const job = await this.prepare(id, config); this.run(job); return { id: job.id }; }
    catch (error) { this.active = null; throw error; }
  }
  run(job) {
    if (job.skip) { this.active = null; this.emit({ type: 'skipped', videoId: job.videoId, jobId: job.id, output: job.output }); return; }
    job.work = path.join(job.cacheBase, 'framesequence', job.id);
    const child = spawn(this.runtime.python, ['-X', 'utf8', '-u', path.join(path.dirname(this.runtime.worker), 'runner.py')], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let closed, ready;
    const active = { job, child, cancelled: false, completed: false, paused: false, suspended: [], control: Promise.resolve(), ready: new Promise(resolve => { ready = resolve; }), closed: new Promise(resolve => { closed = resolve; }) }; this.active = active;
    const send = event => {
      if (event.type === 'progress') {
        active.lastProgress = { ...active.lastProgress, ...event };
        if (active.paused) return;
      }
      this.emit({ videoId: job.videoId, jobId: job.id, encoder: job.encoder, ...event });
    };
    active.send = send;
    let pending = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    send({ type: 'started', output: job.output, progress: 0, stage: '准备编码' });
    child.stdout.on('data', data => {
      pending += data;
      let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index); pending = pending.slice(index + 1);
        try { const event = JSON.parse(line); if (event.workerPid) { active.workerPid = event.workerPid; ready(event.workerPid); } if (['completed', 'failed'].includes(event.type)) active.terminal = true; if (event.type === 'completed') { active.completed = true; this.results.set(job.id, job.output); } if (!active.cancelled) send(event); } catch { stderr += line; }
      }
    });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
    child.once('error', error => { active.terminal = true; send({ type: 'failed', error: error.message }); });
    child.once('close', async code => {
      if (active.cancelled) {
        await active.killPromise;
        const output = path.parse(job.output);
        let cleanupError;
        await removePartial(path.join(output.dir, `.${output.name}.${job.id}.partial.mp4`)).catch(error => { cleanupError = `任务已取消，但临时文件未能清理：${error.message}`; });
        const cacheRoot = path.resolve(job.cacheBase, 'framesequence');
        const cache = path.resolve(job.work);
        if (path.dirname(cache) === cacheRoot && path.basename(cache) === job.id) await fs.rm(cache, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(error => { cleanupError ??= `任务已取消，但缓存未能清理：${error.message}`; });
        active.cleanupError = cleanupError;
        send({ type: 'cancelled', ...(cleanupError ? { error: cleanupError } : {}) });
      } else if (!active.terminal) send({ type: 'failed', error: stderr || `处理进程异常退出：${code}` });
      if (this.active === active) this.active = null;
      ready(null);
      closed();
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(job));
  }
  async cancel() {
    const active = this.active;
    if (!active?.child) return;
    if (active.completed) { await active.closed; return; }
    active.cancelled = true;
    await active.control.catch(() => {});
    if (this.active !== active) return;
    active.killPromise ??= new Promise(resolve => execFile('taskkill.exe', ['/pid', String(active.child.pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
    await active.killPromise;
    await active.closed;
    if (active.cleanupError) throw new Error(active.cleanupError);
  }
  async controlCurrent(id, action) {
    const active = this.active;
    if (!active?.child || active.job.videoId !== id || active.cancelled || active.terminal) throw new Error('该任务已不在处理中');
    const operation = active.control.catch(() => {}).then(async () => {
      await active.ready;
      if (this.active !== active || active.cancelled || active.terminal || active.paused === (action === 'pause')) return;
      const { stdout } = await command(this.runtime.python, ['-X', 'utf8', path.join(path.dirname(this.runtime.worker), 'control.py'), action,
        action === 'pause' ? String(active.workerPid) : JSON.stringify(active.suspended)], { timeout: 20000 });
      const result = JSON.parse(stdout);
      if (action === 'pause') {
        active.suspended = result.processes;
        active.paused = active.suspended.length > 0;
      } else {
        active.suspended = result.remaining;
        active.paused = active.suspended.length > 0;
        if (active.paused) throw new Error('部分任务进程未能继续，请重试或删除任务');
      }
      if (this.active === active && !active.cancelled && !active.terminal) active.send({ ...active.lastProgress, type: active.paused ? 'paused' : 'progress' });
    });
    active.control = operation;
    return operation;
  }
}
module.exports = { Jobs, validate, defaultCacheBase };
