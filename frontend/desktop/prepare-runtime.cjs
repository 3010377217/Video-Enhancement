const fs = require('node:fs/promises');
const path = require('node:path');
const { getRuntime, command } = require('./runtime.cjs');

async function main() {
  const root = path.resolve(__dirname, '..', '..'), output = path.join(root, 'frontend', '.cache', 'runtime');
  const runtime = await getRuntime(root);
  if (path.dirname(output) !== path.join(root, 'frontend', '.cache') || path.basename(output) !== 'runtime') throw new Error('无效的运行时缓存目录');
  await fs.rm(output, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await fs.mkdir(path.join(output, 'tools'), { recursive: true });
  const tools = {};
  for (const name of ['ffmpeg', 'ffprobe']) {
    const found = await command('where.exe', [runtime[name]]);
    tools[name] = found.stdout.trim().split(/\r?\n/)[0];
    await fs.copyFile(tools[name], path.join(output, 'tools', `${name}.exe`));
  }
  const copy = async (from, to) => { await fs.mkdir(path.dirname(to), { recursive: true }); await fs.cp(from, to, { recursive: true, filter: file => !file.includes('__pycache__') && !path.basename(file).startsWith('test_') }); };
  for (const file of ['realesrgan-ncnn-vulkan.exe', 'vcomp140.dll', 'processing', 'onepiece_demo.mp4']) await copy(path.join(root, file), path.join(output, file));
  for (const scale of [2, 3, 4]) for (const ext of ['bin', 'param']) {
    const relative = path.join('models', `realesr-animevideov3-x${scale}.${ext}`);
    await copy(path.join(root, relative), path.join(output, relative));
  }
  for (const file of ['rife-ncnn-vulkan.exe', 'rife-v4.6', 'vcomp140.dll', 'LICENSE']) await copy(path.join(root, 'rife-ncnn-vulkan-20221029-windows', file), path.join(output, 'rife-ncnn-vulkan-20221029-windows', file));
  const pythonRoot = (await command(runtime.python, ['-X', 'utf8', '-c', 'import sys; print(sys.base_prefix)'])).stdout.trim();
  const pythonDir = path.join(output, 'python'); await fs.mkdir(pythonDir, { recursive: true });
  for (const file of await fs.readdir(pythonRoot)) if (/^(python.*\.dll|python\.exe|vcruntime.*\.dll|LICENSE\.txt)$/.test(file)) await copy(path.join(pythonRoot, file), path.join(pythonDir, file));
  await copy(path.join(pythonRoot, 'DLLs'), path.join(pythonDir, 'DLLs'));
  const zip = "import pathlib,zipfile,sys; r=pathlib.Path(sys.argv[1])/'Lib'; z=zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED); [z.write(p,p.relative_to(r).as_posix()) for p in r.rglob('*.py') if not set(p.relative_to(r).parts)&{'site-packages','test','tests','__pycache__','idlelib','tkinter','turtledemo','ensurepip'}]; z.close()";
  const version = (await command(runtime.python, ['-c', 'import sys; print(str(sys.version_info.major)+str(sys.version_info.minor))'])).stdout.trim();
  await command(runtime.python, ['-X', 'utf8', '-c', zip, pythonRoot, path.join(pythonDir, `python${version}.zip`)], { timeout: 60000 });
  await fs.writeFile(path.join(pythonDir, `python${version}._pth`), `python${version}.zip\nDLLs\n.\n../processing\n`);
  const licenses = path.join(output, 'licenses'); await fs.mkdir(licenses, { recursive: true });
  await copy(path.join(pythonRoot, 'LICENSE.txt'), path.join(licenses, 'Python.txt'));
  await copy(path.join(path.dirname(tools.ffmpeg), '..', 'LICENSE'), path.join(licenses, 'FFmpeg.txt'));
  await copy(path.join(path.dirname(tools.ffmpeg), '..', 'README.txt'), path.join(licenses, 'FFmpeg-build.txt'));
  await copy(path.join(root, 'rife-ncnn-vulkan-20221029-windows', 'LICENSE'), path.join(licenses, 'RIFE-NCNN.txt'));
  for (const name of ['Real-ESRGAN.txt', 'Real-ESRGAN-NCNN.txt', 'NCNN.txt']) await copy(path.join(__dirname, 'licenses', name), path.join(licenses, name));
  await fs.writeFile(path.join(licenses, 'THIRD-PARTY-NOTICES.txt'), `FrameSequence local runtime\nPython: https://www.python.org/\nFFmpeg 8.1.1 Gyan full build (GPL): https://www.gyan.dev/ffmpeg/builds/\nFFmpeg source: https://ffmpeg.org/releases/ffmpeg-8.1.1.tar.xz\nFFmpeg build scripts: https://github.com/GyanD/codexffmpeg\nReal-ESRGAN: https://github.com/xinntao/Real-ESRGAN\nNCNN runtime: https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan\nRIFE NCNN: https://github.com/nihui/rife-ncnn-vulkan\nNCNN: https://github.com/Tencent/ncnn\nElectron licenses are alongside the app executable.\n`);
  await command(path.join(pythonDir, 'python.exe'), ['-X', 'utf8', '-c', 'import json, fractions, subprocess, threading, struct, shutil; import ai, encoding, winprocess; winprocess.attach(); print("bundled python ready")']);
  console.log(`Runtime prepared: ${output}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
