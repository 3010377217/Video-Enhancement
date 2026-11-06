const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { getRuntime, command, inspectEnvironment } = require('./runtime.cjs');
const { MediaLibrary, probe } = require('./media.cjs');
const { Jobs } = require('./jobs.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const root = path.resolve(__dirname, '..', '..');
  const runtime = await getRuntime(process.argv[2] ? path.resolve(process.argv[2]) : root);
  const directory = path.join(root, 'output', 'acceptance', 'optimization');
  await fs.mkdir(directory, { recursive: true });
  const fixture = async (name, width, height, fps, duration, audio = false) => {
    const file = path.join(directory, name + '.mp4');
    await command(runtime.ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${fps}`,
      ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440'] : []), '-t', String(duration), '-c:v', 'libx264',
      ...(audio ? ['-c:a', 'aac'] : ['-an']), file], { timeout: 30000 });
    return file;
  };
  const inputs = [await fixture('720p 原片', 1280, 720, 24, 0.125, true),
    await fixture('60fps 原片', 320, 180, 60, 0.5), await fixture('多倍率 原片', 80, 48, 24, 0.125),
    await fixture('奇数输入 原片', 854, 480, 24, 0.125)];
  const hashes = await Promise.all(inputs.map(file => fs.readFile(file).then(data => crypto.createHash('sha256').update(data).digest('hex'))));
  const library = new MediaLibrary(runtime), sources = (await library.import(inputs)).items;
  const environment = await inspectEnvironment(runtime), events = [], results = [];
  const jobs = new Jobs({ runtime, library, environment: async () => environment, emit: event => events.push(event) });
  const config = { enhance: 'ai', processingStrategy: 'speed', resolution: '1080p', width: '320', height: '180', keepRatio: true,
    fps: 'source', codec: 'h264', rateControl: 'dynamic', qualityValue: '23', bitrate: '10', sizeLimit: '40', audio: true,
    destination: 'custom', directory, suffix: '_优化', collision: 'number' };
  async function run(source, patch, expected = 'completed') {
    const start = events.length, began = Date.now();
    await jobs.start(source.id, { ...config, ...patch });
    for (let attempt = 0; jobs.active && attempt < 2400; attempt++) await sleep(100);
    assert.equal(jobs.active, null, 'Worker must finish');
    const current = events.slice(start), terminal = current.find(event => ['completed', 'failed'].includes(event.type));
    assert.equal(terminal?.type, expected, JSON.stringify(terminal));
    const plan = current.find(event => event.processingPlan)?.processingPlan;
    const passes = current.filter(event => event.aiPass).map(event => event.aiPass);
    if (expected === 'failed') { assert.match(terminal.error, /体积预算过低/); assert.equal(plan, undefined); return; }
    const info = await probe(terminal.output, runtime);
    const counted = JSON.parse((await command(runtime.ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'json', terminal.output])).stdout);
    const result = { ...terminal, elapsedMs: Date.now() - began, plan, actualPasses: passes, frames: Number(counted.streams[0].nb_read_frames) };
    assert.equal(info.width, plan.outputWidth); assert.equal(info.height, plan.outputHeight);
    assert.equal(result.frames, plan.targetFrames);
    results.push(result); console.log(JSON.stringify({ source: source.name, ...result })); return result;
  }
  const speed = await run(sources[0], {});
  assert.equal(speed.plan.inputWidth, 960); assert.equal(speed.plan.inputHeight, 540);
  assert.deepEqual(speed.actualPasses.map(pass => [pass.inputWidth, pass.inputHeight, pass.outputWidth, pass.outputHeight]), [[960, 540, 1920, 1080]]);
  assert.equal(speed.plan.postResize, false);
  const quality = await run(sources[0], { processingStrategy: 'quality', suffix: '_质量' });
  assert.deepEqual(quality.actualPasses.map(pass => [pass.inputWidth, pass.inputHeight, pass.outputWidth, pass.outputHeight]), [[1280, 720, 2560, 1440]]);
  const up4k = await run(sources[0], { resolution: '4k', suffix: '_4K', audio: false });
  assert.deepEqual(up4k.plan.scales, [3]); assert.equal(up4k.actualPasses[0].outputHeight, 2160);
  const down = await run(sources[1], { resolution: 'source', fps: '24', suffix: '_降帧' });
  assert.equal(down.plan.sourceFrames, 30); assert.equal(down.plan.inferenceFrames, 12);
  assert.equal(down.actualPasses.reduce((sum, pass) => sum + pass.frames, 0), 12);
  const multiple = await run(sources[2], { resolution: 'custom', width: '720', height: '432', suffix: '_多倍率' });
  assert.deepEqual(multiple.plan.scales, [3, 3]); assert.deepEqual(multiple.actualPasses.map(pass => pass.outputHeight), [144, 432]);
  const odd = await run(sources[3], { keepRatio: false, suffix: '_奇数模型输入' });
  assert.equal(odd.plan.inputWidth, 641); assert.equal(odd.actualPasses[0].outputWidth, 1923);
  await run(sources[0], { rateControl: 'size', sizeLimit: '0.1', suffix: '_低预算' }, 'failed');
  const audioHash = async file => (await command(runtime.ffmpeg, ['-v', 'error', '-i', file, '-map', '0:a:0', '-c:a', 'copy', '-f', 'hash', '-hash', 'sha256', '-'])).stdout.trim();
  assert.equal(await audioHash(speed.output), await audioHash(inputs[0]), 'AAC bitstream must be retained');
  assert.deepEqual(await Promise.all(inputs.map(file => fs.readFile(file).then(data => crypto.createHash('sha256').update(data).digest('hex')))), hashes);
  const report = { passed: true, runtime: runtime.root, gpu: environment.gpu, results,
    checks: ['actual 720p to 1080p speed and quality AI dimensions', 'native 3x 720p to 4K', 'drop frames before inference', 'multiple real model passes', 'odd model input dimensions', 'invalid budget rejects before AI', 'AAC stream hash unchanged', 'source hashes unchanged'] };
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log('Optimization acceptance passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
