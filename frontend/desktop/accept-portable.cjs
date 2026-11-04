// The NSIS portable launcher does not forward inspector stdout to Playwright.
// Keep its real native window open, and test its extracted executable with an
// isolated second profile while the launcher retains ownership of the files.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { command } = require('./runtime.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const root = path.resolve(__dirname, '..', '..');
  const executable = path.resolve(process.argv[2] ?? path.join(root, 'desktop-release', 'FrameSequence-0.2.0-Windows.exe'));
  const anchor = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-portable-launch-'));
  const environment = { ...process.env, PATH: path.join(process.env.SystemRoot, 'System32') };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'FRAMESEQUENCE_DEV_URL', 'FRAMESEQUENCE_TEST_DATA', 'PYTHONHOME', 'PYTHONPATH']) delete environment[key];
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const launcher = spawn(executable, [`--acceptance-user-data=${anchor}`], { env: environment, windowsHide: true, stdio: 'ignore' });
  let native;
  try {
    for (let attempt = 0; attempt < 90; attempt++) {
      const { stdout } = await command(powershell, ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process -Filter "Name=\'FrameSequence.exe\'" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress']);
      const candidates = JSON.parse(stdout.trim() || '[]');
      native = [candidates].flat().find(item => item.CommandLine?.includes(anchor) && !item.CommandLine.includes('--type='));
      if (native) {
        const { stdout: handle } = await command(powershell, ['-NoProfile', '-Command', `(Get-Process -Id ${native.ProcessId}).MainWindowHandle`]);
        if (Number(handle.trim()) > 0) break;
      }
      native = null; await sleep(1000);
    }
    assert.ok(native, 'Portable must launch its actual native window');
    const relative = path.relative(os.tmpdir(), native.ExecutablePath);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    const result = await command(process.execPath, [path.join(__dirname, 'accept-node6.cjs'), native.ExecutablePath], { timeout: 240000 });
    const reportPath = path.join(root, 'output', 'acceptance', 'node6', 'report.json');
    const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
    report.portableArtifact = executable;
    report.portableNativeWindowVerified = true;
    report.portableTestMethod = 'Direct portable launch with restricted PATH, native window verified, complete acceptance on its extracted executable with independent test profile';
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    await fs.writeFile(path.join(path.dirname(reportPath), 'portable-report.json'), JSON.stringify(report, null, 2));
    console.log(result.stdout); console.log('Portable direct launch and extracted-runtime acceptance passed:', executable);
  } finally {
    if (native) await command(powershell, ['-NoProfile', '-Command', `(Get-Process -Id ${native.ProcessId} -ErrorAction SilentlyContinue).CloseMainWindow()`]).catch(() => {});
    for (let attempt = 0; launcher.exitCode === null && attempt < 100; attempt++) await sleep(100);
    if (launcher.exitCode === null) await command('taskkill.exe', ['/PID', String(launcher.pid), '/T', '/F']).catch(() => {});
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
