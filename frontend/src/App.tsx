import { useEffect, useRef, useState } from 'react';
import OutputSettings, { outputError } from './OutputSettings';
import { Segments, Select } from './ui';
import type { Config, Video, ImportResult, JobEvent, QueueSnapshot } from './types';
import {
  ArchiveIcon, Cross2Icon, InfoCircledIcon, PauseIcon, PlayIcon, PlusIcon,
  ResetIcon, TrashIcon, UploadIcon, VideoIcon, ExternalLinkIcon,
} from '@radix-ui/react-icons';

const defaults: Config = {
  enhance: 'ai', resolution: 'source', fps: 'source', codec: 'h264',
  processingStrategy: 'quality', srTile: 'auto', srThreads: 'auto', cacheDir: '', chunkFrames: 'auto', interQuality: '12',
  rateControl: 'dynamic', bitrate: '10', qualityValue: '23', sizeLimit: '80',
  audio: true, destination: 'custom', directory: '',
  suffix: '_增强', collision: 'number', keepRatio: true, width: '1920', height: '1080',
};
const RESOLUTIONS = ['source', '720p', '1080p', '2k', '4k'];
const FPS = ['source', '24', '30', '60', '120'];
const TILES = ['auto', '128', '256', '512', '1024'];
const THREADS = ['auto', '1:1:1', '1:2:2', '2:2:2', '2:4:2', '4:4:4'];
const CHUNKS = ['auto', '100', '250', '500', '1000'];
const INTER = ['lossless', '12', '18'];
const ACTIVE = ['waiting', 'started', 'progress', 'paused'];
const FINISHED = ['completed', 'failed', 'cancelled', 'interrupted', 'skipped'];

// Settings saved by older versions may hold options this UI no longer offers.
function normalize(saved: Partial<Config> | undefined, directory: string): Config {
  const merged = { ...defaults, ...saved };
  return {
    ...merged,
    enhance: 'ai',
    resolution: RESOLUTIONS.includes(merged.resolution) ? merged.resolution : 'source',
    fps: FPS.includes(merged.fps) ? merged.fps : 'source',
    processingStrategy: ['speed', 'quality', 'custom'].includes(merged.processingStrategy) ? merged.processingStrategy : 'quality',
    srTile: TILES.includes(merged.srTile) ? merged.srTile : 'auto',
    srThreads: THREADS.includes(merged.srThreads) ? merged.srThreads : 'auto',
    cacheDir: typeof merged.cacheDir === 'string' ? merged.cacheDir : '',
    chunkFrames: CHUNKS.includes(merged.chunkFrames) ? merged.chunkFrames : 'auto',
    interQuality: INTER.includes(merged.interQuality) ? merged.interQuality : '12',
    rateControl: merged.rateControl === 'fixed' ? 'fixed' : 'dynamic',
    audio: true, keepRatio: true, destination: 'custom', collision: 'number',
    directory: merged.directory || directory,
  };
}
function size(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
function statusText(state: JobEvent, pending?: string) {
  if (pending === 'pausing') return '正在暂停…';
  if (pending === 'resuming') return '正在继续…';
  if (pending === 'removing') return '正在停止并移除…';
  switch (state.type) {
    case 'paused': return '已暂停';
    case 'completed': return '处理完成';
    case 'failed': return `失败：${state.error}`;
    case 'cancelled': return '已取消';
    case 'waiting': return '等待处理';
    case 'interrupted': return '已中断，可重试';
    case 'skipped': return '已跳过';
    default: return state.stage ?? '处理中';
  }
}

export default function App() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [config, setConfig] = useState<Config>({ ...defaults });
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState('');
  const [importing, setImporting] = useState(false);
  const [importErrors, setImportErrors] = useState<ImportResult['errors']>([]);
  const [directoryError, setDirectoryError] = useState('');
  const [cacheError, setCacheError] = useState('');
  const [jobStates, setJobStates] = useState<Record<string, JobEvent>>({});
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [taskActions, setTaskActions] = useState<Record<string, string>>({});
  const importRef = useRef<(files?: File[], sample?: boolean) => Promise<void>>(async () => {});

  const totalBytes = videos.reduce((sum, video) => sum + video.bytes, 0);
  const invalidConfig = Boolean(outputError(config));

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(''), 4500);
    return () => window.clearTimeout(timeout);
  }, [notice]);
  function applySnapshot(snapshot: QueueSnapshot) {
    setVideos(snapshot.videos); setPaused(snapshot.paused);
    setJobStates(Object.fromEntries(snapshot.tasks.map(task => [task.videoId, task.event])));
    setBusy(snapshot.tasks.some(task => ACTIVE.includes(task.status)));
  }
  useEffect(() => window.desktop.onJob(event => {
    if (event.type === 'queue') { applySnapshot(event as unknown as QueueSnapshot); return; }
    if (event.type === 'storage-error') { setNotice(event.error ?? '保存失败'); return; }
    setJobStates(previous => ({ ...previous, [event.videoId]: { ...previous[event.videoId], ...event } }));
    if (event.type === 'failed') setNotice(event.error ?? '处理失败');
  }), []);
  useEffect(() => {
    void window.desktop.snapshot().then(async snapshot => {
      applySnapshot(snapshot);
      const directory = await window.desktop.defaultDirectory();
      setConfig(normalize(snapshot.settings?.global, directory));
      if (snapshot.loadError) setNotice(snapshot.loadError);
      setHydrated(true);
    }).catch(error => setNotice(error.message));
  }, []);
  useEffect(() => {
    if (!hydrated || invalidConfig) return;
    const timer = setTimeout(() => void window.desktop.saveSettings({ global: config, overrides: {} }).catch(error => setNotice(error.message)), 400);
    return () => clearTimeout(timer);
  }, [config, hydrated, invalidConfig]);
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault(); void importRef.current();
      }
    }
    document.addEventListener('keydown', shortcut);
    return () => document.removeEventListener('keydown', shortcut);
  }, []);

  function update<K extends keyof Config>(key: K, value: Config[K]) { setConfig(previous => ({ ...previous, [key]: value })); }
  async function remove(ids: string[]) {
    setTaskActions(previous => ({ ...previous, ...Object.fromEntries(ids.map(id => [id, 'removing'])) }));
    try { await window.desktop.remove(ids); } catch (error) { setNotice((error as Error).message); return; }
    finally { setTaskActions(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => !ids.includes(id)))); }
    setVideos(previous => previous.filter(video => !ids.includes(video.id)));
  }
  async function toggleTaskPause(video: Video) {
    const resume = jobStates[video.id]?.type === 'paused';
    setTaskActions(previous => ({ ...previous, [video.id]: resume ? 'resuming' : 'pausing' }));
    try { await (resume ? window.desktop.resumeTask(video.id) : window.desktop.pauseTask(video.id)); }
    catch (error) { setNotice((error as Error).message); }
    finally { setTaskActions(previous => { const next = { ...previous }; delete next[video.id]; return next; }); }
  }
  async function importVideos(files?: File[], sample = false) {
    if (importing) return;
    setImporting(true); setImportErrors([]);
    try {
      const result = sample ? await window.desktop.loadSample() : files ? await window.desktop.importDropped(files) : await window.desktop.chooseVideos();
      setVideos(previous => [...previous, ...result.items]);
      setImportErrors(result.errors);
    } catch (error) { setImportErrors([{ name: '导入失败', message: (error as Error).message }]); }
    finally { setImporting(false); }
  }
  importRef.current = importVideos;
  async function chooseDirectory() {
    try { const directory = await window.desktop.chooseDirectory(config.directory); if (directory) { update('directory', directory); setDirectoryError(''); } }
    catch (error) { setDirectoryError((error as Error).message); }
  }
  async function chooseCacheDir() {
    try { const directory = await window.desktop.chooseDirectory(config.cacheDir); if (directory) { update('cacheDir', directory); setCacheError(''); } }
    catch (error) { setCacheError((error as Error).message); }
  }
  async function checkCacheDir() {
    if (!config.cacheDir) { setCacheError(''); return; }
    try { await window.desktop.checkDirectory(config.cacheDir); setCacheError(''); }
    catch (error) { setCacheError((error as Error).message); }
  }
  async function checkDirectory() {
    try { await window.desktop.checkDirectory(config.directory); setDirectoryError(''); }
    catch (error) { setDirectoryError((error as Error).message); }
  }
  async function startProcessing() {
    if (!videos.length) return;
    try {
      const items = videos.filter(video => !ACTIVE.includes(jobStates[video.id]?.type) && jobStates[video.id]?.type !== 'completed');
      if (!items.length) { setNotice(Object.values(jobStates).some(state => state.type === 'paused') ? '当前任务已暂停，请点击行内继续' : busy ? '所有视频均已入队' : '队列已全部完成，可用行内重试再次处理'); return; }
      applySnapshot(await window.desktop.enqueue(items.map(video => ({ id: video.id, config }))));
    } catch (error) { setNotice((error as Error).message); }
  }
  async function retryVideo(id: string) {
    try { applySnapshot(await window.desktop.retry(id)); }
    catch (error) { setNotice((error as Error).message); }
  }
  const report = (error: Error) => setNotice(error.message);

  return <div className="app">
    <header className="topbar">
      <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width="26" height="26" />
      <span className="brand-name">帧序</span>
    </header>

    <main className="workspace">
      <section className={`queue ${dragging ? 'is-dragging' : ''}`} aria-labelledby="queue-heading"
        onDragOver={event => { event.preventDefault(); if (event.dataTransfer.types.includes('Files')) setDragging(true); }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
        onDrop={event => { event.preventDefault(); setDragging(false); void importVideos(Array.from(event.dataTransfer.files)); }}>
        <div className="queue-head">
          <h1 id="queue-heading">视频队列</h1>
          {videos.length > 0 && <span className="queue-count">{videos.length} 个 · {size(totalBytes)}</span>}
          <div className="queue-tools">
            {busy && <>
              <button className="button quiet" onClick={() => void (paused ? window.desktop.resume() : window.desktop.pause()).catch(report)}>{paused ? '继续队列' : '暂停后续'}</button>
              <button className="button quiet" onClick={() => void window.desktop.cancel().catch(report)}>取消当前</button>
              <button className="button quiet" onClick={() => void window.desktop.stop().catch(report)}>停止队列</button>
            </>}
            <button className="button secondary" disabled={importing} onClick={() => void importVideos()}><PlusIcon />添加视频</button>
          </div>
        </div>

        {importErrors.length > 0 && <div className="import-errors" role="alert">
          <button className="icon-button" aria-label="关闭导入提示" onClick={() => setImportErrors([])}><Cross2Icon /></button>
          {importErrors.map((error, index) => <p key={index}><strong>{error.name}</strong>：{error.message}</p>)}
        </div>}

        {videos.length === 0
          ? <div className="empty">
            <UploadIcon />
            <p>拖入视频，或</p>
            <div className="empty-actions">
              <button className="button primary" disabled={importing} onClick={() => void importVideos()}>选择视频</button>
              <button className="button quiet" disabled={importing} onClick={() => void importVideos(undefined, true)}>示例</button>
            </div>
          </div>
          : <div className="table-scroll"><table className="video-table">
            <colgroup><col /><col className="col-res" /><col className="col-size" /><col className="col-actions" /></colgroup>
            <thead><tr><th>名称</th><th className="num">分辨率</th><th className="num">大小</th><th aria-label="操作" /></tr></thead>
            <tbody>{videos.map(video => {
              const state = jobStates[video.id];
              const type = state?.type;
              const processing = ['started', 'progress', 'paused'].includes(type);
              const isPaused = type === 'paused';
              const progress = Math.min(100, Math.max(0, Math.round((state?.progress ?? 0) * 100)));
              const pending = taskActions[video.id];
              const warnings = [video.vfr && '变帧率将转为恒定帧率', video.subtitles && '输出不含字幕流', video.audioTracks > 1 && '仅保留第一条音轨'].filter(Boolean).join('；');
              return <tr key={video.id} className={isPaused ? 'is-paused' : ''}>
                <td><div className="name-cell">
                  <span className="file-icon"><VideoIcon /></span>
                  <div className="file-info">
                    <span className="file-name" title={video.path}>{video.name}</span>
                    {(state || pending) && <span className={`file-meta ${type === 'failed' ? 'is-error' : type === 'completed' ? 'is-done' : ''}`} title={state?.error ?? state?.output}>{statusText(state ?? { type: '', videoId: video.id, jobId: '' }, pending)}</span>}
                    {warnings && !state && <span className="file-warn">{warnings}</span>}
                    {processing && <div className={`task-progress ${isPaused ? 'is-paused' : ''}`} role="progressbar" aria-label={`${video.name} 处理进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-valuetext={`${isPaused ? '已暂停，' : ''}${progress}%`}>
                      <span className="track"><span className="fill" style={{ width: `${progress}%` }} /></span><span className="pct">{progress}%</span>
                    </div>}
                  </div>
                </div></td>
                <td className="num mono">{video.width ? `${video.width} × ${video.height}` : '—'}</td>
                <td className="num mono">{size(video.bytes)}</td>
                <td><div className="row-actions">
                  {processing && <button className="icon-button is-accent" aria-label={`${isPaused ? '继续' : '暂停'} ${video.name}`} title={isPaused ? '继续' : '暂停'} disabled={Boolean(pending)} onClick={() => void toggleTaskPause(video)}>{isPaused ? <PlayIcon /> : <PauseIcon />}</button>}
                  {type === 'completed' && <button className="icon-button" aria-label={`打开 ${video.name} 的输出位置`} title="打开输出位置" onClick={() => void window.desktop.showResult(state.jobId).catch(report)}><ExternalLinkIcon /></button>}
                  {FINISHED.includes(type) && <button className="icon-button" aria-label={`重试 ${video.name}`} title="重试" onClick={() => void retryVideo(video.id)}><ResetIcon /></button>}
                  <button className="icon-button is-danger" aria-label={`移除 ${video.name}`} title={processing ? '停止并移除' : '移除'} disabled={Boolean(pending)} onClick={() => void remove([video.id])}><TrashIcon /></button>
                </div></td>
              </tr>;
            })}</tbody>
          </table></div>}
        {dragging && <div className="drop-overlay"><UploadIcon />松开添加</div>}
      </section>

      <aside className="settings" aria-labelledby="settings-heading">
        <div className="settings-head"><h2 id="settings-heading">导出设置</h2>
          <button className="icon-button" title="恢复默认" aria-label="恢复默认" onClick={() => setConfig(previous => ({ ...defaults, directory: previous.directory, cacheDir: previous.cacheDir }))}><ResetIcon /></button>
        </div>
        <div className="settings-body">
          <div className="field"><span className="field-label">处理策略</span>
            <Segments label="处理策略" value={config.processingStrategy} onChange={value => update('processingStrategy', value)}
              options={[{ value: 'speed', label: '速度优先' }, { value: 'quality', label: '质量优先' }, { value: 'custom', label: '自定义' }]} /></div>
          {config.processingStrategy === 'custom' && (
            <div className="sub-fields">
              <div className="pair">
                <div className="field"><span className="field-label">超分分块 tile</span>
                  <Select label="超分分块 tile" value={config.srTile} onChange={value => update('srTile', value)}>
                    <option value="auto">自动</option><option value="128">128</option><option value="256">256</option><option value="512">512</option><option value="1024">1024</option>
                  </Select></div>
                <div className="field"><span className="field-label">超分线程 -j</span>
                  <Select label="超分线程 -j（加载:处理:保存）" value={config.srThreads} onChange={value => update('srThreads', value)}>
                    <option value="auto">自动</option><option value="1:1:1">1:1:1</option><option value="1:2:2">1:2:2</option><option value="2:2:2">2:2:2</option><option value="2:4:2">2:4:2</option><option value="4:4:4">4:4:4</option>
                  </Select></div>
              </div>
              <div className="field"><span className="field-label">每块帧数</span>
                <Select label="每块帧数" value={config.chunkFrames} onChange={value => update('chunkFrames', value)}>
                  <option value="auto">自动</option><option value="100">100</option><option value="250">250</option><option value="500">500</option><option value="1000">1000</option>
                </Select></div>
              <div className="field"><span className="field-label">中间片段画质</span>
                <Segments label="中间片段画质" value={config.interQuality} onChange={value => update('interQuality', value)}
                  options={[{ value: 'lossless', label: '无损' }, { value: '12', label: '高' }, { value: '18', label: '中' }]} /></div>
            </div>
          )}
          <div className="pair">
            <div className="field"><span className="field-label">输出分辨率</span>
              <Select label="输出分辨率" value={config.resolution} onChange={value => update('resolution', value)}>
                <option value="source">保持原始</option><option value="720p">720p</option><option value="1080p">1080p</option><option value="2k">2K</option><option value="4k">4K</option>
              </Select></div>
            <div className="field"><span className="field-label">目标帧率</span>
              <Select label="目标帧率" value={config.fps} onChange={value => update('fps', value)}>
                <option value="source">保持原始</option><option value="24">24 fps</option><option value="30">30 fps</option><option value="60">60 fps</option><option value="120">120 fps</option>
              </Select></div>
          </div>
          <div className="field"><span className="field-label">编码方式</span>
            <Segments label="编码方式" value={config.codec} onChange={value => update('codec', value)}
              options={[{ value: 'h264', label: 'H.264' }, { value: 'hevc', label: 'H.265' }]} /></div>
          <OutputSettings config={config} sources={videos} onChange={patch => setConfig(previous => ({ ...previous, ...patch }))} />
          <div className="field"><label className="field-label" htmlFor="output-directory">存储目录</label>
            <div className={`path-input ${directoryError ? 'has-error' : ''}`}>
              <input id="output-directory" aria-label="输出目录路径" value={config.directory} title={config.directory}
                onChange={event => update('directory', event.target.value)} onBlur={() => void checkDirectory()} />
              <button className="icon-button" aria-label="选择输出目录" title="选择输出目录" onClick={() => void chooseDirectory()}><ArchiveIcon /></button>
            </div>
            {directoryError && <p className="inline-error" role="alert">{directoryError}</p>}
          </div>
          <div className="field"><label className="field-label" htmlFor="cache-directory">缓存目录</label>
            <div className={`path-input ${cacheError ? 'has-error' : ''}`}>
              <input id="cache-directory" aria-label="缓存目录路径" placeholder="程序所在目录（默认）" value={config.cacheDir} title={config.cacheDir || '程序所在目录下的 framesequence 文件夹'}
                onChange={event => update('cacheDir', event.target.value)} onBlur={() => void checkCacheDir()} />
              <button className="icon-button" aria-label="选择缓存目录" title="选择缓存目录" onClick={() => void chooseCacheDir()}><ArchiveIcon /></button>
            </div>
            <p className="field-hint">AI 处理的临时文件较大，系统盘空间不足时可换到其他磁盘</p>
            {cacheError && <p className="inline-error" role="alert">{cacheError}</p>}
          </div>
        </div>
        <div className="settings-foot">
          <button className="button primary start" disabled={!videos.length || invalidConfig || importing || !hydrated} onClick={() => void startProcessing()}>
            <PlayIcon />{busy ? '追加新任务' : '开始处理'}
          </button>
        </div>
      </aside>
    </main>

    {notice && <div className="toast" role="status"><InfoCircledIcon /><span>{notice}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setNotice('')}><Cross2Icon /></button></div>}
  </div>;
}
