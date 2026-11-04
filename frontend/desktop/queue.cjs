const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Jobs, validate } = require('./jobs.cjs');

class Queue {
  constructor({ runtime, library, environment, emit, stateFile }) {
    this.library = library; this.emit = emit; this.stateFile = stateFile;
    this.tasks = []; this.paused = false; this.settings = null; this.saving = Promise.resolve();
    this.jobs = new Jobs({ runtime, library, environment, emit: event => this.onEvent(event) });
    this.pumping = false;
    this.enqueueing = Promise.resolve();
    this.generation = 0;
  }
  async load() {
    try {
      const data = JSON.parse(await fs.readFile(this.stateFile, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.tasks) || !Array.isArray(data.videos)) return;
      for (const video of data.videos) if (typeof video.path === 'string' && typeof video.id === 'string') this.library.items.set(video.id, video);
      this.tasks = data.tasks.map(task => ['waiting', 'started', 'progress'].includes(task.status) ? { ...task, status: 'interrupted', event: { ...task.event, type: 'interrupted', error: '应用退出时任务尚未完成，可重试' } } : task);
      this.settings = data.settings;
      for (const task of this.tasks) if (task.status === 'completed') this.jobs.results.set(task.id, task.output);
      this.paused = true;
    } catch (error) { if (error.code !== 'ENOENT') this.loadError = `上次状态未能读取：${error.message}`; }
  }
  snapshot() { return { videos: [...this.library.items.values()], tasks: this.tasks.map(({ config, source, runtime, ...task }) => task), paused: this.paused, settings: this.settings, loadError: this.loadError }; }
  save() {
    const body = JSON.stringify({ version: 1, videos: [...this.library.items.values()], tasks: this.tasks, settings: this.settings }, null, 2);
    this.saving = this.saving.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
      const temporary = `${this.stateFile}.tmp`;
      await fs.writeFile(temporary, body); await fs.rename(temporary, this.stateFile);
    }).catch(error => { this.emit({ type: 'storage-error', error: `无法保存任务记录：${error.message}` }); });
    return this.saving;
  }
  broadcast() { this.emit({ type: 'queue', ...this.snapshot() }); }
  enqueue(items) {
    const pending = this.enqueueing.then(() => this.enqueueActual(items));
    this.enqueueing = pending.catch(() => {}); return pending;
  }
  async enqueueActual(items) {
    if (!Array.isArray(items) || !items.length || items.length > 2000) throw new Error('任务列表无效');
    const generation = this.generation;
    const reserved = new Set(this.tasks.filter(task => ['waiting', 'started', 'progress'].includes(task.status)).map(task => task.output.toLowerCase()));
    const prepared = [];
    for (const item of items) {
      if (generation !== this.generation) break;
      if (this.tasks.some(task => task.videoId === item.id && ['waiting', 'started', 'progress'].includes(task.status))) continue;
      try { prepared.push({ ...await this.jobs.prepare(item.id, item.config, reserved), status: 'waiting' }); }
      catch (error) {
        const id = randomUUID();
        prepared.push({ id, videoId: item.id, config: item.config, source: this.library.items.get(item.id), status: 'failed', event: { type: 'failed', videoId: item.id, jobId: id, error: error.message } });
      }
    }
    if (generation !== this.generation) return this.snapshot();
    for (const job of prepared) this.tasks.push({ ...job, event: job.event ?? { type: 'waiting', videoId: job.videoId, jobId: job.id } });
    this.paused = false; await this.save(); this.broadcast(); void this.pump();
    return this.snapshot();
  }
  async pump() {
    if (this.pumping || this.jobs.active || this.paused) return;
    this.pumping = true;
    const generation = this.generation;
    try {
      const task = this.tasks.find(task => task.status === 'waiting');
      if (!task) return;
      task.status = 'started'; task.runtime = this.jobs.runtime; await this.save();
      if (generation !== this.generation) { task.status = 'cancelled'; task.event.type = 'cancelled'; await this.save(); this.broadcast(); return; }
      this.jobs.run(task);
    } finally { this.pumping = false; }
  }
  onEvent(event) {
    const task = this.tasks.find(task => task.id === event.jobId);
    if (task) {
      task.event = { ...task.event, ...event }; task.status = event.type;
      if (event.output) task.output = event.output;
      if (event.type !== 'progress') void this.save();
    }
    this.emit(event); this.broadcast();
    if (['completed', 'failed', 'cancelled', 'skipped'].includes(event.type)) {
      // Start the next task only after the worker's close handler clears it.
      const next = () => this.jobs.active ? setTimeout(next, 50) : void this.pump(); setTimeout(next, 0);
    }
  }
  pause() { this.paused = true; this.broadcast(); return this.save(); }
  resume() { this.paused = false; this.broadcast(); void this.pump(); return this.save(); }
  async stop() {
    this.generation++;
    this.paused = true;
    for (const task of this.tasks) if (task.status === 'waiting') { task.status = 'cancelled'; task.event.type = 'cancelled'; }
    await this.jobs.cancel(); await this.save(); this.broadcast();
  }
  async retry(videoId) {
    const task = [...this.tasks].reverse().find(task => task.videoId === videoId && ['failed', 'cancelled', 'interrupted', 'completed', 'skipped'].includes(task.status));
    if (!task) throw new Error('没有可重试的任务');
    return this.enqueue([{ id: videoId, config: task.config }]);
  }
  async saveSettings(settings) {
    if (!settings || typeof settings !== 'object') throw new Error('设置无效');
    const global = validate(settings.global);
    const overrides = {};
    for (const [id, config] of Object.entries(settings.overrides ?? {})) if (this.library.items.has(id)) overrides[id] = validate(config);
    this.settings = { global, overrides }; return this.save();
  }
  remove(ids) {
    if (this.tasks.some(task => ids.includes(task.videoId) && ['waiting', 'started', 'progress'].includes(task.status))) throw new Error('请先停止队列再移除等待或处理中的视频');
    this.library.remove(ids); this.tasks = this.tasks.filter(task => !ids.includes(task.videoId)); void this.save(); this.broadcast();
  }
}
module.exports = { Queue };
