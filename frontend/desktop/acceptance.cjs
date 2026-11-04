const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { _electron } = require('playwright');
const { command, getRuntime, inspectEnvironment } = require('./runtime.cjs');
const { MediaLibrary, outputPath, writableDirectory } = require('./media.cjs');

async function main() {
  const root = path.resolve(__dirname, '..', '..');
  const directory = path.join(root, 'output', 'acceptance', 'node1', '中文 素材');
  await fs.mkdir(directory, { recursive: true });
  const runtime = await getRuntime(root);
  const mp4 = path.join(directory, '样本 视频.mp4');
  await command(runtime.ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=24000/1001', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1', '-c:v', 'libx264', '-c:a', 'aac', mp4]);
  for (const ext of ['mkv', 'mov']) await command(runtime.ffmpeg, ['-y', '-v', 'error', '-i', mp4, '-c', 'copy', path.join(directory, `样本.${ext}`)]);
  const rotated = path.join(directory, '旋转.mp4');
  await command(runtime.ffmpeg, ['-y', '-v', 'error', '-display_rotation', '90', '-i', mp4, '-c', 'copy', rotated]);
  const broken = path.join(directory, '损坏.mp4'); await fs.writeFile(broken, 'not video');
  const library = new MediaLibrary(runtime);
  const imported = await library.import([mp4, mp4, path.join(directory, '样本.mkv'), path.join(directory, '样本.mov'), rotated, broken]);
  assert.equal(imported.items.length, 4); assert.equal(imported.errors.length, 2);
  assert.equal(imported.items[0].fpsRational, '24000/1001'); assert.ok(imported.items[0].audio);
  assert.equal(imported.items[3].width, 120); assert.equal(imported.items[3].height, 160);
  const planned = await outputPath(imported.items[0], { destination: 'source', suffix: '', collision: 'number' });
  assert.notEqual(planned.path, mp4);
  await assert.rejects(writableDirectory(broken));
  await assert.rejects(writableDirectory(path.join(directory, 'missing')));
  const environment = await inspectEnvironment(runtime);
  assert.ok(environment.checks.every(check => check.ok));
  assert.ok(environment.encoders.some(check => check.ok));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  env.FRAMESEQUENCE_TEST_DATA = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'frame-node1-'));
  const app = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'frontend')], env });
  try {
    const page = await app.firstWindow();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('heading', { name: '视频队列', exact: true }).waitFor();
    assert.equal(await page.locator('tbody tr').count(), 0);
    assert.ok(await page.getByRole('button', { name: '开始处理', exact: true }).isDisabled());
    await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, [mp4, broken]);
    await page.getByRole('button', { name: '添加视频', exact: true }).click();
    await page.getByRole('button', { name: `配置 ${path.basename(mp4)}`, exact: true }).waitFor();
    assert.equal(await page.locator('tbody tr').count(), 1);
    assert.match(await page.locator('.import-errors').innerText(), /损坏/);
    await page.keyboard.press('Control+o');
    await page.waitForFunction(() => document.querySelector('.import-errors')?.textContent.includes('已在队列中'));
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, directory);
    await page.getByRole('button', { name: '选择输出目录', exact: true }).click();
    await page.waitForFunction(directory => document.querySelector('[aria-label="输出目录路径"]').value === directory, directory);
    assert.equal(await page.getByRole('textbox', { name: '输出目录路径', exact: true }).inputValue(), directory);
    // A native File supplied by Chromium exercises the same bridge as drag/drop.
    await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'acceptance-file'; document.body.append(input); });
    await page.locator('#acceptance-file').setInputFiles(rotated);
    const dropped = await page.evaluate(() => window.desktop.importDropped(Array.from(document.querySelector('#acceptance-file').files)));
    assert.equal(dropped.items[0].width, 120);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(directory, '..', 'desktop.png') });
  } finally { await app.close(); }
  const report = { node: 1, passed: true, checks: ['native picker and Ctrl+O', 'real drop file bridge', 'Chinese/space paths', 'MP4/MKV/MOV', 'rational frame rate', 'rotation', 'audio metadata', 'corrupt and duplicate files', 'native directory picker', 'directory validation', 'source overwrite prevention', 'actual encoder smoke tests', 'empty default queue'], environment };
  await fs.writeFile(path.join(directory, '..', 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
