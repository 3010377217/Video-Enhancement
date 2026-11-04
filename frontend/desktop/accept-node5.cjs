const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { Jobs } = require('./jobs.cjs');
const { MediaLibrary } = require('./media.cjs');
const { getRuntime, inspectEnvironment, command } = require('./runtime.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const root = path.resolve(__dirname, '..', '..'), runtime = await getRuntime(root);
  const directory = path.join(root, 'output', 'acceptance', 'node5'); await fs.mkdir(directory, { recursive: true });
  const input = path.join(directory, '有码率测试.mp4');
  await command(runtime.ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=330', '-t', '5', '-c:v', 'libx264', '-crf', '15', '-c:a', 'aac', input]);
  const library = new MediaLibrary(runtime), source = (await library.import([input])).items[0], environment = await inspectEnvironment(runtime), events = [];
  const jobs = new Jobs({ runtime, library, environment: async () => environment, emit: event => events.push(event) });
  const config = { enhance: 'resize', processingStrategy: 'quality', resolution: 'source', width: '320', height: '240', keepRatio: true, fps: 'source', codec: 'h264', rateControl: 'fixed', qualityValue: '23', bitrate: '1', sizeLimit: '5', audio: true, destination: 'custom', directory, suffix: '_fixed', collision: 'number' };
  const outputs = [];
  async function run(patch, shouldFail = false) {
    const offset = events.length; const settings = { ...config, ...patch }; await jobs.start(source.id, settings);
    for (let attempt = 0; jobs.active && attempt < 1800; attempt++) await pause(100);
    assert.equal(jobs.active, null);
    const terminal = events.slice(offset).find(event => ['completed', 'failed'].includes(event.type));
    assert.equal(terminal?.type, shouldFail ? 'failed' : 'completed', JSON.stringify(terminal));
    if (!shouldFail) {
      const info = JSON.parse((await command(runtime.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', terminal.output])).stdout);
      if (settings.rateControl === 'size') assert.ok(Number(info.format.size) <= Number(settings.sizeLimit) * 1e6 * source.duration / 60);
      outputs.push({ ...terminal, videoBitrate: info.streams.find(stream => stream.codec_type === 'video').bit_rate });
    }
  }
  await run({});
  await run({ codec: 'hevc', suffix: '_fixed_hevc' });
  await run({ rateControl: 'dynamic', qualityValue: '18', suffix: '_q18' });
  await run({ rateControl: 'dynamic', qualityValue: '32', suffix: '_q32' });
  assert.ok(outputs[2].bytes > outputs[3].bytes, 'Quality values must affect real compression');
  await run({ rateControl: 'size', suffix: '_size', sizeLimit: '5' });
  await run({ rateControl: 'size', codec: 'hevc', suffix: '_size_hevc', sizeLimit: '5' });
  await run({ rateControl: 'size', sizeLimit: '0.1', suffix: '_too_small' }, true);
  const small = path.join(root, 'output', 'acceptance', 'node4', '素材_30.mp4');
  const tiny = (await library.import([small])).items[0];
  await jobs.start(tiny.id, { ...config, enhance: 'ai', processingStrategy: 'speed', rateControl: 'size', sizeLimit: '40', suffix: '_ai_budget' });
  for (let attempt = 0; jobs.active && attempt < 1800; attempt++) await pause(100);
  assert.equal(events.at(-1).type, 'completed', JSON.stringify(events.at(-1)));
  const report = { node: 5, passed: true, checks: ['fixed H264 and H265 bitrate', 'quality 18 versus 32 changes real file size', 'H264 two-pass size control', 'HEVC bounded size control', 'audio and container inside total budget', 'too-low budget fails clearly', 'AI plus size control with cached intermediate'], outputs };
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
