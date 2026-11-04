const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

function command(executable, args, { timeout = 20000, cwd, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, shell: false, signal });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-4_000_000); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-2_000_000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) reject(new Error('操作超时，请检查文件或运行环境'));
      else if (code !== 0) reject(new Error(stderr.trim() || stdout.trim() || `程序退出：${code}`));
      else resolve({ stdout, stderr });
    });
  });
}

async function exists(file) { try { return (await fs.stat(file)).isFile(); } catch { return false; } }
async function findTool(root, name, fallback = name) {
  const candidates = [path.join(root, 'tools', `${name}.exe`), path.join(root, `${name}.exe`)];
  if (name === 'python') candidates.unshift(path.join(root, 'python', 'python.exe'));
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  return fallback;
}

async function getRuntime(root) {
  const [ffmpeg, ffprobe, python] = await Promise.all(['ffmpeg', 'ffprobe', 'python'].map(name => findTool(root, name)));
  return {
    root, ffmpeg, ffprobe, python,
    sr: path.join(root, 'realesrgan-ncnn-vulkan.exe'),
    rife: path.join(root, 'rife-ncnn-vulkan-20221029-windows', 'rife-ncnn-vulkan.exe'),
    srModels: path.join(root, 'models'),
    rifeModel: path.join(root, 'rife-ncnn-vulkan-20221029-windows', 'rife-v4.6'),
    worker: path.join(root, 'processing', 'worker.py'),
  };
}

async function inspectEnvironment(runtime) {
  const checks = await Promise.all([
    ['ffmpeg', runtime.ffmpeg, ['-version']], ['ffprobe', runtime.ffprobe, ['-version']],
    ['python', runtime.python, ['--version']],
  ].map(async ([name, executable, args]) => {
    try { const result = await command(executable, args); return { name, ok: true, detail: result.stdout.split(/\r?\n/)[0] }; }
    catch { return { name, ok: false, detail: `找不到或无法运行 ${name}，请检查工具路径` }; }
  }));
  const encoderResults = await Promise.all(['h264_nvenc', 'hevc_nvenc', 'libx264', 'libx265'].map(async name => {
    try {
      await command(runtime.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=size=128x128:rate=24', '-frames:v', '1', '-c:v', name, '-f', 'null', '-'], { timeout: 30000 });
      return { name, ok: true, detail: '实际编码通过' };
    } catch (error) { return { name, ok: false, detail: error.message.slice(-400) }; }
  }));
  const models = await Promise.all([
    ['Real-ESRGAN', runtime.sr], ['SR 模型', path.join(runtime.srModels, 'realesr-animevideov3-x2.bin')],
    ['RIFE', runtime.rife], ['RIFE 模型', path.join(runtime.rifeModel, 'flownet.bin')],
  ].map(async ([name, file]) => ({ name, ok: await exists(file), detail: file })));
  let gpu = '未取得 GPU 信息，AI 可用性将在实际模型测试中验证';
  try { gpu = (await command('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'])).stdout.trim(); } catch { /* Vulkan GPUs need not be NVIDIA. */ }
  return { checks, encoders: encoderResults, models, gpu, aiVerified: false };
}
module.exports = { command, exists, getRuntime, inspectEnvironment };
