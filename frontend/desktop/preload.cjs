const { contextBridge, ipcRenderer, webUtils } = require('electron');
const call = async (name, ...args) => {
  const result = await ipcRenderer.invoke(`frame:${name}`, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
contextBridge.exposeInMainWorld('desktop', {
  chooseVideos: () => call('choose-videos'),
  importDropped: files => call('import', Array.from(files, file => webUtils.getPathForFile(file)).filter(Boolean)),
  loadSample: () => call('sample'),
  remove: ids => call('remove', ids),
  chooseDirectory: current => call('choose-directory', current),
  checkDirectory: directory => call('check-directory', directory),
  openDirectory: directory => call('open-directory', directory),
  environment: () => call('environment'),
  defaultDirectory: () => call('default-directory'),
  start: (id, config) => call('start', id, config),
  cancel: () => call('cancel'),
  showResult: id => call('show-result', id),
  onJob: callback => { const listener = (_event, data) => callback(data); ipcRenderer.on('frame:job', listener); return () => ipcRenderer.removeListener('frame:job', listener); },
  snapshot: () => call('snapshot'), enqueue: items => call('enqueue', items),
  pause: () => call('pause'), resume: () => call('resume'), stop: () => call('stop'),
  retry: id => call('retry', id), saveSettings: settings => call('settings', settings),
});
