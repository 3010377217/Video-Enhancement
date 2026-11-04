const { app, BrowserWindow, Menu, nativeTheme, screen, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { getRuntime, inspectEnvironment } = require('./runtime.cjs');
const { MediaLibrary, writableDirectory } = require('./media.cjs');
const { Queue } = require('./queue.cjs');

const title = '帧序 · 视频增强工作台';
const rendererFile = path.join(__dirname, '..', 'dist', 'index.html');
const rendererUrl = pathToFileURL(rendererFile).href;
let mainWindow;
let library, runtime, environmentPromise, jobs, queue;

function handle(name, action) {
  ipcMain.handle(`frame:${name}`, async (event, ...args) => {
    try {
      if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('无效的调用来源');
      return { ok: true, value: await action(...args) };
    } catch (error) { return { ok: false, error: error.message }; }
  });
}

async function setup() {
  runtime = await getRuntime(app.isPackaged ? path.join(process.resourcesPath, 'runtime') : path.resolve(__dirname, '..', '..'));
  library = new MediaLibrary(runtime);
  const environment = () => environmentPromise ??= inspectEnvironment(runtime).catch(error => { environmentPromise = null; throw error; });
  queue = new Queue({ runtime, library, environment, emit: event => mainWindow?.webContents.send('frame:job', event), stateFile: path.join(app.getPath('userData'), 'queue-v1.json') });
  await queue.load(); jobs = queue.jobs;
  handle('snapshot', () => queue.snapshot());
  handle('enqueue', items => queue.enqueue(items));
  handle('pause', () => queue.pause());
  handle('resume', () => queue.resume());
  handle('stop', () => queue.stop());
  handle('retry', id => queue.retry(id));
  handle('settings', settings => queue.saveSettings(settings));
  handle('start', (id, config) => jobs.start(id, config));
  handle('cancel', () => jobs.cancel());
  handle('show-result', id => { const file = jobs.results.get(id); if (!file) throw new Error('没有已完成的输出文件'); shell.showItemInFolder(file); });
  handle('choose-videos', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'], filters: [{ name: '视频', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v'] }] });
    if (result.canceled) return { items: [], errors: [] };
    const imported = await library.import(result.filePaths); await queue.save(); return imported;
  });
  handle('import', async paths => { const imported = await library.import(paths); await queue.save(); return imported; });
  handle('sample', async () => { const imported = await library.import([app.isPackaged ? path.join(process.resourcesPath, 'runtime', 'onepiece_demo.mp4') : path.resolve(__dirname, '..', '..', 'onepiece_demo.mp4')]); await queue.save(); return imported; });
  handle('remove', ids => { if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('无效的视频列表'); queue.remove(ids); });
  handle('choose-directory', async current => {
    const result = await dialog.showOpenDialog(mainWindow, { defaultPath: typeof current === 'string' ? current : app.getPath('videos'), properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : writableDirectory(result.filePaths[0]);
  });
  handle('check-directory', writableDirectory);
  handle('open-directory', async directory => { await writableDirectory(directory); const error = await shell.openPath(directory); if (error) throw new Error(error); });
  handle('default-directory', () => app.getPath('videos'));
  handle('environment', environment);
}

app.setName('帧序');
app.setAppUserModelId('com.framesequence.desktop');
if (!app.isPackaged && process.env.FRAMESEQUENCE_TEST_DATA) app.setPath('userData', path.resolve(process.env.FRAMESEQUENCE_TEST_DATA));
const acceptanceData = app.commandLine.getSwitchValue('acceptance-user-data');
if (acceptanceData) app.setPath('userData', path.resolve(acceptanceData));
if (!app.requestSingleInstanceLock()) app.exit(0);
else app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });

function localDevUrl() {
  const input = process.env.FRAMESEQUENCE_DEV_URL;
  if (app.isPackaged || !input) return undefined;
  const url = new URL(input);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
    throw new Error('The development renderer must be served from 127.0.0.1.');
  }
  return url;
}

async function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  const devUrl = localDevUrl();
  mainWindow = new BrowserWindow({
    title,
    width: Math.min(1440, area.width - 48),
    height: Math.min(940, area.height - 48),
    minWidth: 1000,
    minHeight: 740,
    center: true,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#14171b',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, target) => {
    let allowed = target.split('#')[0] === rendererUrl;
    if (devUrl) {
      try { allowed = new URL(target).origin === devUrl.origin; } catch { allowed = false; }
    }
    if (!allowed) event.preventDefault();
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  mainWindow.on('page-title-updated', event => event.preventDefault());
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = undefined; });
  mainWindow.on('close', event => {
    if (!jobs?.active) return;
    event.preventDefault();
    void dialog.showMessageBox(mainWindow, { type: 'question', title: '仍有任务正在处理', message: '停止队列并退出，还是继续处理？', buttons: ['继续处理', '停止并退出'], defaultId: 0, cancelId: 0 }).then(async result => {
      if (result.response === 1) { await queue.stop(); const wait = () => jobs.active ? setTimeout(wait, 100) : mainWindow?.destroy(); wait(); }
    });
  });
  if (devUrl) await mainWindow.loadURL(devUrl.href);
  else await mainWindow.loadFile(rendererFile);
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  Menu.setApplicationMenu(null);
  await setup();
  await createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) void createWindow(); });
}).catch(error => {
  console.error(error);
  app.quit();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
