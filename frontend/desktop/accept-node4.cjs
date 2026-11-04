const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { Jobs } = require('./jobs.cjs');
const { MediaLibrary, probe } = require('./media.cjs');
const { getRuntime, inspectEnvironment, command } = require('./runtime.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const root = path.resolve(__dirname, '..', '..'), runtime = await getRuntime(root);
  const directory = path.join(root, 'output', 'acceptance', 'node4'); await fs.mkdir(directory, { recursive: true });
  const capability = await inspectEnvironment(runtime), library = new MediaLibrary(runtime), events = [];
  const jobs = new Jobs({ runtime, library, environment: async () => capability, emit: event => { events.push(event); if (event.type !== 'progress') console.log(JSON.stringify(event)); } });
  const config = { enhance: 'ai', processingStrategy: 'speed', resolution: 'source', width: '320', height: '240', keepRatio: true, fps: '60', codec: 'h264', rateControl: 'dynamic', qualityValue: '23', bitrate: '10', sizeLimit: '40', audio: true, destination: 'custom', directory, suffix: '_speed', collision: 'number' };
  const outputs = [];
  async function run(source, patch) {
    const start = events.length; await jobs.start(source.id, { ...config, ...patch });
    for (let attempt = 0; jobs.active && attempt < 1800; attempt++) await pause(100);
    assert.equal(jobs.active, null, 'AI worker must finish');
    const terminal = events.slice(start).find(event => ['completed', 'failed'].includes(event.type));
    assert.equal(terminal?.type, 'completed', JSON.stringify(terminal));
    const result = await probe(terminal.output, runtime);
    assert.ok(Math.abs(result.duration - source.duration) < 0.15);
    const frameData = JSON.parse((await command(runtime.ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'json', terminal.output])).stdout);
    const fps = patch?.fps === 'source' ? source.fps : Number(patch?.fps ?? config.fps);
    assert.equal(Number(frameData.streams[0].nb_read_frames), Math.round(source.duration * fps));
    outputs.push({ ...terminal, frames: Number(frameData.streams[0].nb_read_frames) });
  }
  for (const fps of ['24000/1001', '30']) {
    const file = path.join(directory, `素材_${fps.replace('/', '_')}.mp4`);
    await command(runtime.ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=160x120:rate=${fps}`, '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2.2', '-c:v', 'libx264', '-c:a', 'aac', file]);
    const source = (await library.import([file])).items[0];
    await run(source, { suffix: '_speed' });
    if (fps === '24000/1001') {
      await run(source, { processingStrategy: 'quality', fps: 'source', suffix: '_quality' });
      await run(source, { enhance: 'resize', fps: '24', suffix: '_lower', resolution: 'custom', width: '320', height: '240' });
    } else {
      await run(source, { enhance: 'resize', fps: '24', suffix: '_down24' });
      await run(source, { enhance: 'resize', fps: 'source', suffix: '_720', resolution: '720p' });
      await run(source, { enhance: 'resize', fps: 'source', suffix: '_1080', resolution: '1080p' });
    }
  }
  const report = { node: 4, passed: true, checks: ['actual RealESRGAN speed strategy', 'actual quality strategy', 'RIFE 23.976 to 60 and 30 to 60', 'multiple chunks with overlap', 'exact global frame count', 'original fps bypass', 'resize and explicit fps conversion', 'audio duration and full decode'], outputs };
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
