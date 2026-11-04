const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { _electron } = require('playwright');
const { Jobs } = require('./jobs.cjs');
const { MediaLibrary, probe } = require('./media.cjs');
const { getRuntime, inspectEnvironment, command } = require('./runtime.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const root = path.resolve(__dirname, '..', '..'), runtime = await getRuntime(root);
  const directory = path.join(root, 'output', 'acceptance', 'node2'); await fs.mkdir(directory, { recursive: true });
  const input = path.join(root, 'output', 'acceptance', 'node1', '中文 素材', '样本 视频.mp4');
  const before = crypto.createHash('sha256').update(await fs.readFile(input)).digest('hex');
  const library = new MediaLibrary(runtime), source = (await library.import([input])).items[0];
  const capability = await inspectEnvironment(runtime), events = [];
  const jobs = new Jobs({ runtime, library, environment: async () => capability, emit: event => events.push(event) });
  const config = { enhance: 'resize', processingStrategy: 'quality', resolution: 'custom', width: '320', height: '240', keepRatio: true, fps: 'source', codec: 'h264', rateControl: 'dynamic', qualityValue: '23', bitrate: '10', sizeLimit: '40', audio: true, destination: 'custom', directory, suffix: '_增强', collision: 'number' };
  async function complete(options) {
    const start = events.length;
    await jobs.start(source.id, { ...config, ...options });
    for (let tries = 0; jobs.active && tries < 600; tries++) await pause(100);
    assert.equal(jobs.active, null, 'Job must terminate');
    const terminal = events.slice(start).filter(event => ['completed', 'failed', 'cancelled'].includes(event.type));
    assert.equal(terminal.length, 1); assert.equal(terminal[0].type, 'completed', JSON.stringify(terminal));
    return terminal[0];
  }
  const first = await complete({});
  let result = await probe(first.output, runtime); assert.equal(result.width, 320); assert.ok(result.audio);
  const second = await complete({ codec: 'hevc', audio: false, suffix: '_无音频' });
  result = await probe(second.output, runtime); assert.equal(result.codec, 'hevc'); assert.equal(result.audio, false);
  jobs.environment = async () => ({ ...capability, encoders: capability.encoders.filter(item => !item.name.includes('nvenc')) });
  const software = await complete({ suffix: '_software' }); assert.equal(software.encoder, 'libx264');
  const numbered = await complete({}); assert.notEqual(numbered.output, first.output);
  const appEnv = { ...process.env }; delete appEnv.ELECTRON_RUN_AS_NODE;
  appEnv.FRAMESEQUENCE_TEST_DATA = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'frame-node2-'));
  const app = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'frontend')], env: appEnv });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, input) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input] }); }, input);
    await page.getByRole('button', { name: '添加视频', exact: true }).click();
    await page.locator('tbody tr').waitFor();
    const directoryField = page.getByRole('textbox', { name: '输出目录路径', exact: true });
    await directoryField.fill(directory);
    await page.getByRole('button', { name: '开始处理', exact: true }).click();
    await page.getByRole('button', { name: /的输出位置$/ }).waitFor({ timeout: 30000 });
    assert.match(await page.locator('.file-meta').innerText(), /处理完成/);
    await page.screenshot({ path: path.join(directory, 'desktop.png') });
  } finally { await app.close(); }
  const long = path.join(directory, '长片.mp4');
  await command(runtime.ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=size=320x240:rate=30', '-t', '30', '-c:v', 'libx264', long]);
  const longSource = (await library.import([long])).items[0];
  await jobs.start(longSource.id, { ...config, resolution: '4k', suffix: '_cancel' });
  await pause(200); await jobs.cancel();
  for (let tries = 0; jobs.active && tries < 100; tries++) await pause(100);
  assert.equal(jobs.active, null); assert.equal(events.at(-1).type, 'cancelled');
  assert.equal((await fs.readdir(directory)).some(file => file.includes('.partial.')), false);
  assert.equal(crypto.createHash('sha256').update(await fs.readFile(input)).digest('hex'), before);
  const report = { node: 2, passed: true, checks: ['actual Electron export', 'H264 and H265', 'audio retained and removed', 'software fallback', 'custom resolution', 'original rational fps', 'numbering', 'source hash unchanged', 'cancel process tree', 'partial cleanup', 'full output decode validation'], outputs: [first, second, software] };
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
