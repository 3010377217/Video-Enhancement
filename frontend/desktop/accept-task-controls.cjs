const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { _electron } = require('playwright');
const { getRuntime, command } = require('./runtime.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 180000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await sleep(100); }
  throw new Error('Task-control acceptance timed out');
}
async function main() {
  const root = path.resolve(__dirname, '..', '..');
  const directory = path.join(root, 'output', 'playwright', 'task-controls');
  await fs.mkdir(directory, { recursive: true });
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-task-controls-'));
  const dev = await getRuntime(root), checks = [], errors = [];
  const files = ['当前任务.mp4', '后续任务.mp4', '等待删除.mp4'].map(name => path.join(directory, name));
  for (let i = 0; i < files.length; i++) await command(dev.ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${i ? '160x120' : '640x360'}:rate=30`, '-t', i ? '0.6' : '4', '-c:v', 'libx264', files[i]], { timeout: 30000 });
  const hash = file => fs.readFile(file).then(data => crypto.createHash('sha256').update(data).digest('hex'));
  const originalHashes = await Promise.all(files.map(hash));
  const executablePath = process.argv[2] ? path.resolve(process.argv[2]) : require('electron');
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'FRAMESEQUENCE_DEV_URL', 'FRAMESEQUENCE_TEST_DATA', 'PYTHONHOME', 'PYTHONPATH']) delete env[key];
  if (process.argv[2]) env.PATH = path.join(process.env.SystemRoot, 'System32');
  const launch = () => _electron.launch({ executablePath, args: [...(process.argv[2] ? [] : [path.join(root, 'frontend')]), `--acceptance-user-data=${profile}`], env, timeout: 90000 });
  let app, page, runtime, capturedRunning = false;
  const snapshot = () => page.evaluate(() => window.desktop.snapshot());
  const row = name => page.locator('tbody tr').filter({ has: page.getByText(name, { exact: true }) });
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  async function cpu(pids) {
    const result = await command(powershell, ['-NoProfile', '-Command', `@((Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue) | Select-Object Id,CPU) | ConvertTo-Json -Compress`]);
    return [JSON.parse(result.stdout.trim() || '[]')].flat().sort((a, b) => a.Id - b.Id);
  }
  async function importFiles(paths) {
    const count = (await snapshot()).videos.length;
    await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, paths);
    await page.getByRole('button', { name: '添加视频', exact: true }).click();
    await until(async () => (await snapshot()).videos.length === count + paths.length);
  }
  async function aiSettings() {
    await page.getByRole('button', { name: '质量优先', exact: true }).click();
  }
  async function activeInfo() {
    return app.evaluate(() => {
      const active = globalThis.acceptanceJobs.active;
      return active ? { runner: active.child.pid, worker: active.workerPid, suspended: active.suspended, job: active.job } : null;
    });
  }
  async function hook() {
    await app.evaluate(({ app }) => {
      const path = process.getBuiltinModule('node:path');
      const { createRequire } = process.getBuiltinModule('node:module');
      const require = createRequire(path.join(app.getAppPath(), 'package.json'));
      const { Jobs } = require('./desktop/jobs.cjs');
      const run = Jobs.prototype.run;
      Jobs.prototype.run = function(job) { globalThis.acceptanceJobs = this; return run.call(this, job); };
    });
  }
  async function pauseCurrent() {
    await until(async () => Number(await row('当前任务.mp4').getByRole('progressbar').getAttribute('aria-valuenow')) > 0);
    if (!capturedRunning) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 940));
      await page.screenshot({ path: path.join(directory, 'desktop-processing.png') });
      capturedRunning = true;
    }
    assert.equal(await row('当前任务.mp4').locator('.row-actions button').count(), 2);
    await row('当前任务.mp4').getByRole('button', { name: '暂停 当前任务.mp4', exact: true }).click();
    await row('当前任务.mp4').getByRole('button', { name: '继续 当前任务.mp4', exact: true }).waitFor();
    const info = await activeInfo();
    assert.ok(info.suspended.length >= 2, JSON.stringify(info));
    assert.ok(info.suspended.some(record => record.pid === info.worker));
    assert.ok(!info.suspended.some(record => record.pid === info.runner), 'Lifetime guard must stay awake');
    return info;
  }
  async function clean(info) {
    await until(async () => (await cpu([info.runner, ...info.suspended.map(record => record.pid)])).length === 0);
    await assert.rejects(fs.stat(info.job.work), { code: 'ENOENT' });
    assert.ok(!(await fs.readdir(directory)).some(name => name.includes(info.job.id) && name.includes('.partial.')));
  }
  try {
    app = await launch(); page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('heading', { name: '视频队列', exact: true }).waitFor();
    runtime = await getRuntime(process.argv[2] ? path.join(await app.evaluate(() => process.resourcesPath), 'runtime') : root);
    await hook();
    await importFiles(files);
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, directory);
    await page.getByRole('button', { name: '选择输出目录' }).click();
    await until(async () => await page.getByRole('textbox', { name: '输出目录路径', exact: true }).inputValue() === directory);
    await aiSettings();
    await page.getByRole('button', { name: '开始处理', exact: true }).click();
    const info = await pauseCurrent();
    const progress = await row('当前任务.mp4').getByRole('progressbar').getAttribute('aria-valuenow');
    const before = await cpu(info.suspended.map(record => record.pid));
    await sleep(1200);
    assert.deepEqual(await cpu(info.suspended.map(record => record.pid)), before, 'Suspended worker and models must consume no CPU');
    assert.equal(await row('当前任务.mp4').getByRole('progressbar').getAttribute('aria-valuenow'), progress);
    assert.equal((await snapshot()).tasks[1].status, 'waiting');
    await page.getByRole('button', { name: '追加新任务', exact: true }).click();
    assert.equal((await snapshot()).tasks.length, 3, 'Paused and waiting tasks must not be enqueued twice');
    const persisted = JSON.parse(await fs.readFile(path.join(profile, 'queue-v1.json'), 'utf8'));
    assert.equal(persisted.tasks[0].status, 'paused');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 940));
    await page.screenshot({ path: path.join(directory, 'desktop-paused.png') });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 740));
    await page.screenshot({ path: path.join(directory, 'minimum-paused.png') });
    const bounds = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(bounds.scroll <= bounds.width + 1);
    await page.getByRole('button', { name: '移除 等待删除.mp4', exact: true }).click();
    await until(async () => (await snapshot()).videos.length === 2);
    assert.equal((await snapshot()).tasks[0].status, 'paused');
    await page.getByRole('button', { name: '继续 当前任务.mp4', exact: true }).click();
    assert.equal((await activeInfo()).worker, info.worker, 'Resume must preserve the worker, without restarting inference');
    await until(async () => (await snapshot()).tasks.every(task => task.status === 'completed'));
    const completed = await snapshot();
    for (const task of completed.tasks) {
      await command(runtime.ffmpeg, ['-v', 'error', '-i', task.output, '-f', 'null', '-']);
      const counted = JSON.parse((await command(runtime.ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'json', task.output])).stdout);
      const source = completed.videos.find(video => video.id === task.videoId);
      assert.equal(Number(counted.streams[0].nb_read_frames), Math.round(source.duration * source.fps));
    }
    checks.push('real UI progress and pause/resume; worker/model CPU frozen; same worker resumed; subsequent task waits then completes; waiting deletion; 1000/1440 layouts; full output decode');
    console.log('Progress, native pause/resume and sequential completion passed');

    await page.getByRole('button', { name: '重试 当前任务.mp4', exact: true }).click();
    const pausedDelete = await pauseCurrent();
    await page.getByRole('button', { name: '移除 当前任务.mp4', exact: true }).click();
    await until(async () => (await snapshot()).videos.length === 1);
    await clean(pausedDelete);
    checks.push('delete a paused task waits for the complete process tree and cache/partial cleanup, preserving source');
    console.log('Paused task deletion and cleanup passed');

    await importFiles([files[0], files[2]]); await aiSettings();
    await page.getByRole('button', { name: '开始处理', exact: true }).click();
    await until(async () => (await activeInfo())?.worker);
    const runningDelete = await activeInfo();
    runningDelete.suspended = [{ pid: runningDelete.worker }];
    await page.getByRole('button', { name: '移除 当前任务.mp4', exact: true }).click();
    await until(async () => (await snapshot()).videos.length === 2);
    await clean(runningDelete);
    await until(async () => (await snapshot()).tasks.every(task => task.status === 'completed'));
    checks.push('delete a running task and automatically continue the next task');
    console.log('Running task deletion and queue continuation passed');

    await importFiles([files[0]]); await aiSettings();
    await page.getByRole('button', { name: '开始处理', exact: true }).click();
    const interrupted = await pauseCurrent();
    // On Windows Playwright may expose a launcher PID; kill the real main.
    process.kill(await app.evaluate(() => process.pid));
    app = null;
    await until(async () => (await cpu([interrupted.runner, ...interrupted.suspended.map(record => record.pid)])).length === 0);
    app = await launch(); page = await app.firstWindow();
    await until(async () => (await snapshot()).tasks.at(-1)?.status === 'interrupted');
    assert.equal(await row('当前任务.mp4').getByRole('progressbar').count(), 0);
    checks.push('unexpected app exit while paused reclaims frozen descendants; restart records interruption without auto-running');
    assert.deepEqual(await Promise.all(files.map(hash)), originalHashes);
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify({ passed: true, executablePath, runtime: runtime.root, checks, profile, sourceHashesUnchanged: true }, null, 2));
    console.log(JSON.stringify({ passed: true, checks, directory }, null, 2));
  } finally {
    if (app) { await page.evaluate(() => window.desktop.stop()).catch(() => {}); await app.close().catch(() => {}); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
