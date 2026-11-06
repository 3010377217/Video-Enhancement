// Exercise removal at the two async boundaries before a worker is started.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Queue } = require('./queue.cjs');
const { MediaLibrary } = require('./media.cjs');
const { getRuntime, inspectEnvironment, command } = require('./runtime.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 600; i++) { if (check()) return; await sleep(100); }
  throw new Error('Queue removal boundary timed out');
}
async function main() {
  const root = path.resolve(__dirname, '..', '..'), runtime = await getRuntime(root);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-queue-removal-'));
  const inputs = [path.join(directory, '被删除.mp4'), path.join(directory, '继续处理.mp4')];
  for (const input of inputs) await command(runtime.ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30', '-t', '0.5', '-c:v', 'libx264', input]);
  const capability = await inspectEnvironment(runtime), checks = [];
  const config = { enhance: 'resize', processingStrategy: 'quality', resolution: 'source', width: '160', height: '120', keepRatio: true, fps: 'source', codec: 'h264', rateControl: 'dynamic', qualityValue: '23', bitrate: '1', sizeLimit: '10', audio: false, destination: 'custom', directory, suffix: '_验证', collision: 'number' };
  for (const boundary of ['prepare', 'save-before-spawn']) {
    const library = new MediaLibrary(runtime), sources = (await library.import(inputs)).items;
    const queue = new Queue({ runtime, library, environment: async () => capability, emit: () => {}, stateFile: path.join(directory, `${boundary}.json`) });
    let release, entered = false;
    const gate = new Promise(resolve => { release = resolve; });
    const run = queue.jobs.run.bind(queue.jobs), ran = [];
    queue.jobs.run = job => { ran.push(job.videoId); return run(job); };
    if (boundary === 'prepare') {
      const prepare = queue.jobs.prepare.bind(queue.jobs);
      queue.jobs.prepare = async (...args) => { const job = await prepare(...args); if (args[0] === sources[0].id) { entered = true; await gate; } return job; };
    } else {
      const save = queue.save.bind(queue);
      queue.save = async () => { if (!entered && queue.tasks.some(task => task.videoId === sources[0].id && task.status === 'started')) { entered = true; await gate; } return save(); };
    }
    const enqueued = queue.enqueue(sources.map(source => ({ id: source.id, config })));
    try {
      await until(() => entered);
      await queue.remove([sources[0].id]);
      release(); await enqueued;
      await until(() => queue.tasks.length === 1 && queue.tasks[0].status === 'completed' && !queue.jobs.active);
      assert.deepEqual(ran, [sources[1].id]);
      assert.ok(!library.items.has(sources[0].id));
      assert.ok((await fs.stat(inputs[0])).size > 0);
      checks.push(`${boundary}: removed video never starts/reappears, next task completes, source retained`);
    } finally { release(); await queue.stop(); }
  }
  const report = { passed: true, checks, directory };
  const reportDirectory = path.join(root, 'output', 'playwright', 'task-controls');
  await fs.mkdir(reportDirectory, { recursive: true });
  await fs.writeFile(path.join(reportDirectory, 'queue-boundary-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
