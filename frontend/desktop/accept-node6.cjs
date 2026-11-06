const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { _electron } = require('playwright');
const { getRuntime, command, inspectEnvironment } = require('./runtime.cjs');
const { MediaLibrary, probe, writableDirectory } = require('./media.cjs');
const { Jobs } = require('./jobs.cjs');
const { Queue } = require('./queue.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 180000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await sleep(100); }
  throw new Error('Acceptance timed out');
}
async function bytesIn(folder) {
  try {
    const entries = await fs.readdir(folder, { withFileTypes: true });
    return (await Promise.all(entries.map(async entry => {
      const file = path.join(folder, entry.name);
      return entry.isDirectory() ? bytesIn(file) : fs.stat(file).then(stat => stat.size, () => 0);
    }))).reduce((a, b) => a + b, 0);
  } catch { return 0; }
}
async function main() {
  const root = path.resolve(__dirname, '..', '..');
  const directory = path.join(root, 'output', 'acceptance', 'node6');
  await fs.mkdir(directory, { recursive: true });
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-node6-'));
  const devRuntime = await getRuntime(root), input = path.join(directory, '中文 空格 样本.mp4');
  const rotated = path.join(directory, '竖屏 无音轨.mov');
  const ff = args => command(devRuntime.ffmpeg, ['-y', '-v', 'error', ...args], { timeout: 60000 });
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '0.6', '-c:v', 'libx264', '-c:a', 'aac', input]);
  await ff(['-display_rotation', '90', '-i', input, '-an', '-c', 'copy', rotated]);
  const broken = path.join(directory, '损坏.mp4'); await fs.writeFile(broken, 'invalid video');
  const hash = file => fs.readFile(file).then(data => crypto.createHash('sha256').update(data).digest('hex'));
  const originalHashes = await Promise.all([input, rotated].map(hash));
  const executablePath = process.argv[2] ? path.resolve(process.argv[2]) : require('electron');
  const env = { ...process.env };
  if (process.argv[2]) env.PATH = path.join(process.env.SystemRoot, 'System32');
  for (const key of ['ELECTRON_RUN_AS_NODE', 'FRAMESEQUENCE_DEV_URL', 'FRAMESEQUENCE_TEST_DATA', 'PYTHONHOME', 'PYTHONPATH']) delete env[key];
  const launch = () => _electron.launch({ executablePath, args: [...(process.argv[2] ? [] : [path.join(root, 'frontend')]), `--acceptance-user-data=${profile}`], env, timeout: 90000 });
  let app = await launch();
  let runtime, snapshot, page;
  const errors = [], checks = [];
  let queueMilliseconds, sampledCacheBytes = 0;
  try {
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('heading', { name: '视频队列', exact: true }).waitFor();
    assert.ok(page.url().startsWith('file:')); assert.equal(await page.locator('tbody tr').count(), 0);
    assert.equal(await page.locator('video,.preview-panel').count(), 0);
    const resources = await app.evaluate(() => process.resourcesPath);
    runtime = await getRuntime(process.argv[2] ? path.join(resources, 'runtime') : root);
    if (process.argv[2]) for (const name of ['ffmpeg', 'ffprobe', 'python']) assert.ok(path.isAbsolute(runtime[name]), `${name} must be bundled`);
    const uiCapability = await page.evaluate(() => window.desktop.environment());
    assert.ok(uiCapability.checks.every(check => check.ok));
    checks.push(process.argv[2] ? 'local-file native app, sandboxed bridge, bundled runtime with restricted PATH' : 'local-file native app, sandboxed bridge, development runtime');
    const preferences = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
    assert.ok(preferences.sandbox && preferences.contextIsolation && !preferences.nodeIntegration);
    await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, [input, rotated, broken, input]);
    await page.getByRole('button', { name: '添加视频', exact: true }).click();
    await until(async () => await page.locator('tbody tr').count() === 2);
    await page.getByRole('alert').waitFor();
    await page.getByRole('button', { name: '关闭导入提示' }).click();
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, directory);
    await page.getByRole('button', { name: '选择输出目录' }).click();
    await until(async () => await page.getByRole('textbox', { name: '输出目录路径', exact: true }).inputValue() === directory);
    await page.getByRole('button', { name: 'H.265', exact: true }).click();
    await page.getByRole('button', { name: '速度优先', exact: true }).click();
    await page.getByRole('combobox', { name: '目标帧率', exact: true }).selectOption('60');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 740));
    const queueStarted = Date.now();
    await page.getByRole('button', { name: '开始处理', exact: true }).click();
    await page.getByRole('button', { name: '暂停后续', exact: true }).waitFor();
    await page.screenshot({ path: path.join(directory, 'minimum-processing.png') });
    const bounds = await page.evaluate(() => {
      const footer = document.querySelector('.settings-foot');
      return { width: innerWidth, scroll: document.documentElement.scrollWidth, footerWidth: footer.clientWidth, footerScroll: footer.scrollWidth };
    });
    assert.ok(bounds.scroll <= bounds.width + 1, JSON.stringify(bounds));
    assert.ok(bounds.footerScroll <= bounds.footerWidth + 1, JSON.stringify(bounds));
    await until(async () => {
      snapshot = await page.evaluate(() => window.desktop.snapshot());
      const bytes = (await Promise.all(snapshot.tasks.map(task => Promise.all([root, path.dirname(executablePath), os.tmpdir()].map(base => bytesIn(path.join(base, 'framesequence', task.id)))).then(sizes => sizes.reduce((a, b) => a + b, 0))))).reduce((a, b) => a + b, 0);
      sampledCacheBytes = Math.max(sampledCacheBytes, bytes);
      return snapshot.tasks.length === 2 && snapshot.tasks.every(task => ['completed', 'failed'].includes(task.status));
    });
    queueMilliseconds = Date.now() - queueStarted;
    assert.ok(snapshot.tasks.every(task => task.status === 'completed'), JSON.stringify(snapshot));
    checks.push('native picker import and directory, malformed/duplicate handling, global settings, sequential AI+RIFE and HEVC export');
    const outputs = [];
    for (const task of snapshot.tasks) {
      const info = await probe(task.output, runtime); outputs.push(info);
      await command(runtime.ffmpeg, ['-v', 'error', '-i', task.output, '-f', 'null', '-']);
    }
    assert.equal(outputs[0].fps, 60); assert.equal(outputs[0].width, 160); assert.ok(outputs[0].audio);
    assert.equal(outputs[1].width, 120); assert.equal(outputs[1].height, 160); assert.equal(outputs[1].audio, false);
    await app.evaluate(({ shell }) => { shell.showItemInFolder = file => { globalThis.acceptanceOpened = file; }; });
    await page.getByRole('button', { name: `打开 ${path.basename(input)} 的输出位置` }).click();
    assert.equal(await app.evaluate(() => globalThis.acceptanceOpened), outputs[0].path);
    await page.screenshot({ path: path.join(directory, 'minimum-completed.png') });
    await app.close(); app = await launch(); page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    if (process.argv[2]) runtime = await getRuntime(path.join(await app.evaluate(() => process.resourcesPath), 'runtime'));
    await until(async () => await page.locator('tbody tr').count() === 2);
    snapshot = await page.evaluate(() => window.desktop.snapshot());
    assert.ok(snapshot.tasks.every(task => task.status === 'completed')); assert.equal(snapshot.settings.global.codec, 'hevc');
    assert.equal(snapshot.settings.global.fps, '60');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 940));
    await page.screenshot({ path: path.join(directory, 'desktop-completed.png') });
    checks.push('full decode, rotated portrait, no audio, output-location action, restart and settings persistence, minimum-window bounds');
    assert.deepEqual(await Promise.all([input, rotated].map(hash)), originalHashes);
    const long = path.join(directory, '取消测试.mp4');
    await ff(['-f', 'lavfi', '-i', 'color=size=160x120:rate=30', '-t', '60', '-c:v', 'libx264', long]);
    await app.evaluate(({ dialog }, long) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [long] }); }, long);
    await page.getByRole('button', { name: '添加视频', exact: true }).click();
    await until(async () => await page.locator('tbody tr').count() === 3);
    await page.getByRole('combobox', { name: '输出分辨率', exact: true }).selectOption('4k');
    await page.getByRole('button', { name: '开始处理', exact: true }).click();
    let cancellationWork;
    await until(async () => {
      const task = (await page.evaluate(() => window.desktop.snapshot())).tasks.at(-1);
      // AI writes the final partial file only after all inference has finished.
      // Cancel once real frame data exists instead of waiting for a full 4K clip.
      cancellationWork = task.work;
      return cancellationWork && await bytesIn(cancellationWork) > 0;
    });
    await page.getByRole('button', { name: '暂停后续', exact: true }).click();
    await page.getByRole('button', { name: '继续队列', exact: true }).waitFor();
    await page.getByRole('button', { name: '停止队列', exact: true }).click();
    await until(async () => (await page.evaluate(() => window.desktop.snapshot())).tasks.at(-1).status === 'cancelled');
    await until(async () => !(await fs.readdir(directory)).some(file => file.includes('.partial.')));
    await until(async () => fs.stat(cancellationWork).then(() => false, error => {
      if (error.code === 'ENOENT') return true;
      throw error;
    }));
    checks.push('pause and stop real AI work via actual UI, cache cleanup, no partial output, unchanged source SHA256');

  // Additional media and error-path checks use precisely the packaged worker/runtime.
  const odd = path.join(directory, '奇数尺寸.mkv'), vfr = path.join(directory, '变帧率.mp4'), hdr = path.join(directory, 'HDR.mkv');
  await ff(['-f', 'lavfi', '-i', 'testsrc=size=161x121:rate=24', '-t', '0.5', '-c:v', 'ffv1', odd]);
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30', '-t', '1.2', '-vf', "select='not(eq(mod(n,3),2))'", '-fps_mode', 'vfr', '-c:v', 'libx264', vfr]);
  await ff(['-f', 'lavfi', '-i', 'color=size=160x120:rate=24', '-t', '0.5', '-pix_fmt', 'yuv420p10le', '-c:v', 'libx265', '-color_trc', 'smpte2084', hdr]);
  const library = new MediaLibrary(runtime), capability = await inspectEnvironment(runtime), events = [];
  const imported = await library.import([odd, vfr, hdr, input]); assert.equal(imported.items.length, 4);
  const config = { enhance: 'resize', processingStrategy: 'quality', resolution: 'source', width: '160', height: '120', keepRatio: true, fps: 'source', codec: 'h264', rateControl: 'dynamic', qualityValue: '23', bitrate: '1', sizeLimit: '5', audio: true, destination: 'custom', directory, suffix: '_边界验收', collision: 'number' };
  const jobs = new Jobs({ runtime, library, environment: async () => capability, emit: event => events.push(event) });
  for (const source of imported.items.slice(0, 2)) {
    await jobs.start(source.id, config); await until(() => !jobs.active);
    assert.equal(events.at(-1).type, 'completed', JSON.stringify(events.at(-1)));
    if (source.id === imported.items[0].id) { assert.equal(events.at(-1).width, 160); assert.equal(events.at(-1).height, 120); }
    else assert.ok(source.vfr, 'Fixture must really be VFR');
  }
  await assert.rejects(jobs.prepare(imported.items[2].id, config), /HDR/);
  await assert.rejects(writableDirectory(path.join(directory, 'not-created')));
  const readOnly = await fs.mkdtemp(path.join(directory, 'readonly-'));
  const sid = (await command('whoami.exe', ['/user', '/fo', 'csv', '/nh'])).stdout.match(/S-1-[0-9-]+/)[0];
  try {
    await command('icacls.exe', [readOnly, '/deny', `*${sid}:(OI)(CI)(WD,AD)`]);
    await assert.rejects(writableDirectory(readOnly), /不可写/);
  } finally { await command('icacls.exe', [readOnly, '/remove:d', `*${sid}`]); }
  const lowDiskCode = 'import shutil,json,sys,pathlib,collections; job=json.loads(sys.argv[1]); sys.path.insert(0,str(pathlib.Path(job["runtime"]["worker"]).parent)); import ai; shutil.disk_usage=lambda p:collections.namedtuple("Usage","total used free")(100,100,0); ai.enhance(job,pathlib.Path(sys.argv[2]),160,120,lambda *a:None,lambda *a,**kw:None,lambda *a,**kw:None)';
  const lowDiskWork = await fs.mkdtemp(path.join(directory, 'low-disk-'));
  await assert.rejects(command(runtime.python, ['-X', 'utf8', '-c', lowDiskCode, JSON.stringify({ runtime, source: imported.items[3], config: { ...config, enhance: 'ai' } }), lowDiskWork]), /剩余空间不足/);
  const badLibrary = new MediaLibrary({ ...runtime, ffprobe: path.join(directory, 'missing-ffprobe.exe') });
  assert.equal((await badLibrary.import([input])).errors.length, 1);
  const queue = new Queue({ runtime, library, environment: async () => capability, emit() {}, stateFile: path.join(directory, 'edge-state.json') });
  await queue.enqueue([{ id: imported.items[2].id, config }, { id: imported.items[3].id, config }]);
  await until(() => queue.tasks[1].status === 'completed' && !queue.jobs.active);
  assert.equal(queue.tasks[0].status, 'failed');
  const prepare = queue.jobs.prepare.bind(queue.jobs);
  queue.jobs.prepare = async (...args) => { await sleep(300); return prepare(...args); };
  const pending = queue.enqueue([{ id: imported.items[3].id, config }]); await sleep(50); await queue.stop(); await pending;
  assert.equal(queue.tasks.length, 2); assert.equal(queue.paused, true);
  checks.push('worker odd-size normalization, VFR to CFR, HDR rejection, missing dependency and invalid directory errors, preparation failure continues, stop during preparation');
  checks.push('actual read-only directory ACL rejection and injected low-cache-space failure');

  // Kill the Node parent and verify Windows Job Object closes worker descendants.
  const childCode = `import sys; sys.path.insert(0,${JSON.stringify(path.dirname(runtime.worker))}); import winprocess,subprocess,os,time,json; winprocess.attach(); c=subprocess.Popen([sys.executable,"-c","import time; time.sleep(60)"]); print(json.dumps([os.getpid(),c.pid]),flush=True); time.sleep(60)`;
  const helperCode = `const {spawn}=require('node:child_process');const c=spawn(${JSON.stringify(runtime.python)},['-X','utf8','-u','-c',${JSON.stringify(childCode)}],{windowsHide:true});c.stdout.pipe(process.stdout);c.stderr.pipe(process.stderr);setInterval(()=>{},1000);`;
  const helper = spawn(process.execPath, ['-e', helperCode], { windowsHide: true });
  let pids;
  try {
    pids = await new Promise((resolve, reject) => { let data = ''; const timer = setTimeout(() => reject(new Error('worker PID timeout')), 10000); helper.stdout.on('data', chunk => { data += chunk; if (data.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(data.trim())); } }); });
    helper.kill();
    for (const pid of pids) await until(async () => !(await command('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])).stdout.includes(`"${pid}"`), 10000);
  } finally { if (!helper.killed) helper.kill(); }
  checks.push('unexpected parent exit kills Python worker and descendants');
  assert.equal(errors.length, 0, errors.join('\n'));
  const report = { node: 6, passed: true, executablePath, restrictedPath: env.PATH, runtime, checks, profile, actualGpu: capability.gpu, queueMilliseconds, sampledCacheBytes, cacheSamplingIntervalMs: 100, outputRecords: snapshot.tasks, limitations: ['short clips on T1200 host only', 'clean external PC and RTX 4060 not tested', 'low disk space injected; physical full disk not tested', 'long-video cache peak and endurance not tested'] };
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  } finally { if (app) await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
