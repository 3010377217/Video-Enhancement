const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Queue } = require('./queue.cjs');
const { MediaLibrary } = require('./media.cjs');
const { getRuntime, inspectEnvironment } = require('./runtime.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(predicate) { for (let index = 0; index < 600; index++) { if (predicate()) return; await pause(100); } throw new Error('Queue timed out'); }
async function main() {
  const root = path.resolve(__dirname, '..', '..'), runtime = await getRuntime(root);
  const directory = path.join(root, 'output', 'acceptance', 'node3'); await fs.mkdir(directory, { recursive: true });
  const original = path.join(root, 'output', 'acceptance', 'node1', '中文 素材', '样本 视频.mp4');
  const inputs = [1, 2, 3].map(index => path.join(directory, `任务${index}.mp4`));
  for (const file of inputs) await fs.copyFile(original, file);
  const library = new MediaLibrary(runtime), items = (await library.import(inputs)).items;
  const environment = await inspectEnvironment(runtime), events = [];
  const config = { enhance: 'resize', processingStrategy: 'quality', resolution: 'custom', width: '640', height: '480', keepRatio: true, fps: 'source', codec: 'h264', rateControl: 'dynamic', qualityValue: '23', bitrate: '10', sizeLimit: '40', audio: true, destination: 'custom', directory, suffix: '_增强', collision: 'number' };
  const queue = new Queue({ runtime, library, environment: async () => environment, emit: event => events.push(event), stateFile: path.join(directory, 'state.json') });
  await queue.enqueue(items.map(item => ({ id: item.id, config })));
  config.qualityValue = '51'; assert.equal(queue.tasks[0].config.qualityValue, '23');
  await queue.pause(); await fs.unlink(inputs[1]);
  await wait(() => queue.tasks[0].status === 'completed' && !queue.jobs.active);
  assert.equal(queue.tasks[1].status, 'waiting'); assert.equal(queue.tasks[2].status, 'waiting');
  await queue.save();
  const restored = new Queue({ runtime, library: new MediaLibrary(runtime), environment: async () => environment, emit() {}, stateFile: path.join(directory, 'state.json') });
  await restored.load(); assert.equal(restored.tasks[1].status, 'interrupted'); assert.equal(restored.tasks[0].status, 'completed');
  await queue.resume(); await wait(() => queue.tasks[2].status === 'completed' && !queue.jobs.active);
  assert.equal(queue.tasks[1].status, 'failed');
  const started = events.filter(event => event.type === 'started').map(event => event.videoId);
  assert.deepEqual(started, items.map(item => item.id));
  await fs.copyFile(original, inputs[1]); await queue.retry(items[1].id);
  await wait(() => queue.tasks.at(-1).status === 'completed' && !queue.jobs.active);
  await queue.saveSettings({ global: config, overrides: { [items[2].id]: { ...config, qualityValue: '18' } } });
  await restored.load(); assert.equal(restored.settings.overrides[items[2].id].qualityValue, '18');
  const report = { node: 3, passed: true, checks: ['serial three-video queue', 'middle failure continues', 'retry uses config snapshot', 'pause after current task', 'resume', 'completed results restored', 'unfinished tasks marked interrupted', 'global and individual settings persisted', 'frozen submitted config'], states: queue.tasks.map(task => ({ source: task.source.name, status: task.status })) };
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
