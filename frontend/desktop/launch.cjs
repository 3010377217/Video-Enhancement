const { spawn } = require('node:child_process');
const path = require('node:path');

async function main() {
  const root = path.resolve(__dirname, '..');
  const environment = { ...process.env };
  // Parent Electron-based editors can export this flag. The app needs GUI mode.
  delete environment.ELECTRON_RUN_AS_NODE;
  let server;
  if (process.argv.includes('--dev')) {
    const { createServer } = await import('vite');
    server = await createServer({
      root,
      configFile: path.join(root, 'vite.config.ts'),
      server: { host: '127.0.0.1', port: 5174, strictPort: true },
    });
    await server.listen();
    environment.FRAMESEQUENCE_DEV_URL = 'http://127.0.0.1:5174';
  } else {
    delete environment.FRAMESEQUENCE_DEV_URL;
  }
  const child = spawn(require('electron'), [root], {
    cwd: root, env: environment, stdio: 'inherit', windowsHide: true,
  });
  child.on('error', async error => {
    console.error(error); await server?.close(); process.exitCode = 1;
  });
  child.on('exit', async code => {
    await server?.close(); process.exitCode = code ?? 1;
  });
  process.on('SIGINT', () => child.kill());
  process.on('SIGTERM', () => child.kill());
}

main().catch(error => { console.error(error); process.exitCode = 1; });
