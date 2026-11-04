import { useEffect, useRef, useState } from 'react';
import OutputSettings, { outputError } from './OutputSettings';
import EnvironmentStatus from './EnvironmentStatus';
import type { Config, Video, ImportResult, JobEvent, QueueSnapshot } from './types';
import {
  ArrowRightIcon, ArchiveIcon, CheckIcon, CheckCircledIcon,
  ChevronDownIcon, Cross2Icon, DesktopIcon, DownloadIcon,
  InfoCircledIcon, LayersIcon,
  LightningBoltIcon, Link2Icon, MixerHorizontalIcon,
  PlayIcon, PlusIcon, QuestionMarkCircledIcon, ResetIcon,
  SpeakerLoudIcon, TrashIcon, UploadIcon, VideoIcon,
} from '@radix-ui/react-icons';

const defaults: Config = {
  enhance: 'resize', resolution: 'source', fps: 'source', codec: 'h264',
  processingStrategy: 'quality', rateControl: 'dynamic', bitrate: '10', qualityValue: '23', sizeLimit: '80',
  audio: true, destination: 'custom', directory: '',
  suffix: '_增强', collision: 'number', keepRatio: true, width: '1920', height: '1080',
};
function size(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
function duration(seconds: number) {
  const s = Math.floor(seconds || 0);
  return `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
}
function hasInvalidDimensions(config: Config) {
  return config.resolution === 'custom' && ![config.width, config.height].every(
    value => Number.isInteger(Number(value)) && Number(value) >= 16 && Number(value) <= 7680 && Number(value) % 2 === 0,
  );
}
function Segments<Value extends string>({ label, value, options, onChange }: {
  label: string; value: Value; options: { value: Value; label: string; icon?: React.ReactNode; disabled?: boolean }[];
  onChange: (value: Value) => void;
}) {
  return <div role="group" aria-label={label} className="segments inline-flex items-center">
    {options.map(option => <button type="button" key={option.value} aria-pressed={value === option.value}
      disabled={option.disabled} className={value === option.value ? 'segment is-active' : 'segment'} onClick={() => onChange(option.value)}>
      {option.icon}{option.label}
    </button>)}
  </div>;
}

function Select({ label, value, onChange, children, className = '' }: {
  label: string; value: string; onChange: (value: string) => void;
  children: React.ReactNode; className?: string;
}) {
  return <div className={`select-wrap ${className}`}>
    <select aria-label={label} value={value} onChange={event => onChange(event.target.value)}>{children}</select>
    <ChevronDownIcon aria-hidden="true" />
  </div>;
}

export default function App() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [activeId, setActiveId] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [globalConfig, setGlobalConfig] = useState<Config>({ ...defaults });
  const [overrides, setOverrides] = useState<Record<string, Config>>({});
  const [scope, setScope] = useState('all');
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState('');
  const [importing, setImporting] = useState(false);
  const [importErrors, setImportErrors] = useState<ImportResult['errors']>([]);
  const [directoryError, setDirectoryError] = useState('');
  const [jobStates, setJobStates] = useState<Record<string, JobEvent>>({});
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [directoryEditing, setDirectoryEditing] = useState(false);
  const directoryRef = useRef<HTMLInputElement>(null);
  const helpRef = useRef<HTMLDialogElement>(null);
  const active = videos.find(video => video.id === activeId) ?? videos[0];
  const config = scope === 'all' ? globalConfig : overrides[scope] ?? globalConfig;
  const totalBytes = videos.reduce((sum, video) => sum + video.bytes, 0);
  const invalidDimensions = hasInvalidDimensions(config);
  const invalidTasks = videos.filter(video => {
    const settings = overrides[video.id] ?? globalConfig;
    return hasInvalidDimensions(settings) || Boolean(outputError(settings));
  });
  const invalidConfig = invalidDimensions || Boolean(outputError(config)) || invalidTasks.length > 0;

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(''), 4500);
    return () => window.clearTimeout(timeout);
  }, [notice]);
  function applySnapshot(snapshot: QueueSnapshot) {
    setVideos(snapshot.videos); setPaused(snapshot.paused);
    setJobStates(Object.fromEntries(snapshot.tasks.map(task => [task.videoId, task.event])));
    setBusy(snapshot.tasks.some(task => ['waiting', 'started', 'progress'].includes(task.status)));
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
      if (snapshot.settings) { setGlobalConfig(snapshot.settings.global); setOverrides(snapshot.settings.overrides); }
      else { const directory = await window.desktop.defaultDirectory(); setGlobalConfig(previous => ({ ...previous, directory })); }
      if (snapshot.loadError) setNotice(snapshot.loadError);
      setHydrated(true);
    }).catch(error => setNotice(error.message));
  }, []);
  useEffect(() => {
    if (!hydrated || invalidConfig) return;
    const timer = setTimeout(() => void window.desktop.saveSettings({ global: globalConfig, overrides }).catch(error => setNotice(error.message)), 400);
    return () => clearTimeout(timer);
  }, [globalConfig, overrides, hydrated, invalidConfig]);
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault(); void importVideos();
      }
    }
    document.addEventListener('keydown', shortcut);
    return () => document.removeEventListener('keydown', shortcut);
  }, []);

  function update<K extends keyof Config>(key: K, value: Config[K]) {
    updateConfig({ [key]: value });
  }
  function updateConfig(patch: Partial<Config>) {
    if (scope === 'all') setGlobalConfig(previous => ({ ...previous, ...patch }));
    else setOverrides(previous => ({ ...previous, [scope]: { ...(previous[scope] ?? globalConfig), ...patch } }));
  }
  function toggleSelected(id: string) {
    setSelected(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  async function remove(ids: string[]) {
    if (busy) { setNotice('请先结束当前任务'); return; }
    try { await window.desktop.remove(ids); } catch (error) { setNotice((error as Error).message); return; }
    const remaining = videos.filter(video => !ids.includes(video.id));
    setVideos(remaining);
    setSelected(previous => new Set([...previous].filter(id => !ids.includes(id))));
    if (ids.includes(activeId)) setActiveId(remaining[0]?.id ?? '');
    if (ids.includes(scope)) setScope('all');
    setOverrides(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => !ids.includes(id))));
  }
  async function importVideos(files?: File[], sample = false) {
    if (importing) return;
    setImporting(true); setImportErrors([]);
    try {
      const result = sample ? await window.desktop.loadSample() : files ? await window.desktop.importDropped(files) : await window.desktop.chooseVideos();
      setVideos(previous => [...previous, ...result.items]);
      if (result.items.length) { setActiveId(result.items[0].id); setScope('all'); }
      setImportErrors(result.errors);
      if (result.items.length) setNotice(`已添加 ${result.items.length} 个本地视频`);
    } catch (error) { setImportErrors([{ name: '导入失败', message: (error as Error).message }]); }
    finally { setImporting(false); }
  }
  async function chooseDirectory() {
    try { const directory = await window.desktop.chooseDirectory(config.directory); if (directory) { update('directory', directory); setDirectoryError(''); } }
    catch (error) { setDirectoryError((error as Error).message); }
  }
  async function checkDirectory() {
    try { await window.desktop.checkDirectory(config.directory); setDirectoryError(''); }
    catch (error) { setDirectoryError((error as Error).message); }
  }
  async function startProcessing() {
    if (!videos.length) return;
    try {
      const items = videos.filter(video => !['waiting', 'started', 'progress', 'completed'].includes(jobStates[video.id]?.type));
      if (!items.length) { setNotice('队列已全部完成，可用行内重试再次处理'); return; }
      const snapshot = await window.desktop.enqueue(items.map(video => ({ id: video.id, config: overrides[video.id] ?? globalConfig })));
      applySnapshot(snapshot);
    } catch (error) { setNotice((error as Error).message); }
  }
  async function retryVideo(id: string) {
    try { applySnapshot(await window.desktop.retry(id)); }
    catch (error) { setNotice((error as Error).message); }
  }
  function singleSettings(video: Video) {
    setActiveId(video.id); setScope(video.id);
    document.getElementById('export-heading')?.scrollIntoView({ block: 'nearest' });
  }

  return <div className="app-shell flex flex-col">
    <header className="app-header flex items-center justify-between">
      <a href={`${import.meta.env.BASE_URL}index.html`} className="brand flex items-center gap-3" aria-label="帧序工作台首页">
        <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width="31" height="31" />
        <span className="brand-name">帧序</span><span className="brand-divider" />
        <span className="brand-description">视频增强工作台</span>
      </a>
      <div className="header-right flex items-center gap-4">
        <span className="preview-badge">本地工作台 <span>V0.2</span></span>
        <button className="icon-button help-button" title="使用说明" aria-label="使用说明" onClick={() => helpRef.current?.showModal()}><QuestionMarkCircledIcon /></button>
      </div>
    </header>

    <main className="workspace grid">
      <div className="main-column flex flex-col">
        <section className={`queue-panel panel ${dragging ? 'is-dragging' : ''}`} aria-labelledby="queue-heading"
          onDragOver={event => { event.preventDefault(); if (event.dataTransfer.types.includes('Files')) setDragging(true); }}
          onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
          onDrop={event => { event.preventDefault(); setDragging(false); void importVideos(Array.from(event.dataTransfer.files)); }}>
          <div className="queue-heading flex items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2.5"><h1 id="queue-heading">视频队列</h1><span className="count-badge">{videos.length.toString().padStart(2, '0')}</span></div>
              <p className="section-description">把清晰与流畅，交给每一帧。</p>
            </div>
            <button className="button secondary" disabled={importing} onClick={() => void importVideos()}><PlusIcon />添加视频</button>
          </div>
          <div className="queue-toolbar flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5"><LayersIcon /><span>{selected.size ? `已选 ${selected.size} 项` : `全部视频`}</span><span className="muted">{size(totalBytes)}</span></div>
            {selected.size > 0 ? <button className="text-button" onClick={() => remove([...selected])}><TrashIcon />移除所选</button> : <span className="sample-label">{importing ? '正在读取' : '本地素材'}</span>}
          </div>
          {importErrors.length > 0 && <div className="import-errors" role="alert"><button className="icon-button" aria-label="关闭导入提示" onClick={() => setImportErrors([])}><Cross2Icon /></button>{importErrors.map((error, index) => <p key={index}><strong>{error.name}</strong>：{error.message}</p>)}</div>}
          <div className={`table-scroll ${videos.length === 0 ? 'is-empty' : ''}`}>
            <table className="video-table">
              <colgroup><col className="name-col" /><col className="size-col" /><col className="resolution-col" /><col className="actions-col" /></colgroup>
              <thead><tr>
                <th><div className="flex items-center gap-3.5"><input type="checkbox" aria-label="全选视频" checked={videos.length > 0 && selected.size === videos.length}
                  disabled={!videos.length} onChange={event => setSelected(event.target.checked ? new Set(videos.map(video => video.id)) : new Set())} />视频名称</div></th>
                <th className="numeric">视频大小</th><th className="numeric">视频分辨率</th><th className="actions-heading">操作</th>
              </tr></thead>
              <tbody>{videos.map(video => <tr key={video.id} className={active?.id === video.id ? 'active-row' : ''}>
                <td><div className="file-cell flex items-center gap-3.5">
                  <input type="checkbox" aria-label={`选择 ${video.name}`} checked={selected.has(video.id)} onChange={() => toggleSelected(video.id)} />
                  <button className="file-select flex items-center gap-3" onClick={() => { setActiveId(video.id); if (scope !== 'all') setScope(video.id); }} title={`选择 ${video.name}`} aria-pressed={active?.id === video.id}>
                    <span className="thumbnail"><VideoIcon /></span>
                    <span className="file-info"><span className="file-name" title={video.path}>{video.name}</span>
                      <span className="file-meta" title={video.path}>
                        {jobStates[video.id] ? <span title={jobStates[video.id].error ?? jobStates[video.id].output}>{jobStates[video.id].type === 'completed' ? '处理完成' : jobStates[video.id].type === 'failed' ? `失败：${jobStates[video.id].error}` : jobStates[video.id].type === 'cancelled' ? '已取消' : jobStates[video.id].type === 'waiting' ? '等待处理' : jobStates[video.id].type === 'interrupted' ? '已中断，可重试' : jobStates[video.id].type === 'skipped' ? '已跳过' : `${jobStates[video.id].stage ?? '处理中'} ${Math.round((jobStates[video.id].progress ?? 0) * 100)}%`}</span> : <>{duration(video.duration)}<span className="meta-dot" />{Number(video.fps.toFixed(3))} fps</>}{overrides[video.id] && <span className="individual-tag">独立配置</span>}
                      </span>
                      {(video.vfr || video.subtitles || video.audioTracks > 1) && <span className="media-warning">{video.vfr ? '变帧率将转为恒定帧率。' : ''}{video.subtitles ? '输出不含字幕流。' : ''}{video.audioTracks > 1 ? '仅保留第一条音轨。' : ''}</span>}
                      {jobStates[video.id]?.encoder && <span className="encoder-label">{jobStates[video.id].encoder} · {jobStates[video.id].encoder?.includes('nvenc') ? 'GPU 编码' : 'CPU 编码'}</span>}
                    </span>
                  </button>
                </div></td>
                <td className="numeric mono">{size(video.bytes)}</td>
                <td className="numeric mono">{video.width ? `${video.width} × ${video.height}` : '待识别'}</td>
                <td><div className="row-actions flex items-center justify-center gap-1">
                  <button className="icon-button" aria-label={`配置 ${video.name}`} title="单独配置" onClick={() => singleSettings(video)}><MixerHorizontalIcon /></button>
                  {jobStates[video.id]?.type === 'completed' && <button className="icon-button" aria-label={`打开 ${video.name} 的输出位置`} onClick={() => void window.desktop.showResult(jobStates[video.id].jobId).catch(error => setNotice(error.message))}><ArchiveIcon /></button>}
                  {['completed', 'failed', 'cancelled', 'interrupted', 'skipped'].includes(jobStates[video.id]?.type) && <button className="icon-button" aria-label={`重试 ${video.name}`} onClick={() => void retryVideo(video.id)}><ResetIcon /></button>}
                  <button className="icon-button delete-button" aria-label={`移除 ${video.name}`} title="移除视频" onClick={() => remove([video.id])}><TrashIcon /></button>
                </div></td>
              </tr>)}</tbody>
            </table>
          </div>
          {videos.length === 0 ? <div className="empty-queue flex flex-col items-center justify-center">
            <div className="empty-icon"><VideoIcon /></div><h2>从第一个视频开始</h2><p>拖入视频，或点击上方「添加视频」</p>
            <button className="text-button accent-text" disabled={importing} onClick={() => void importVideos(undefined, true)}>添加项目示例<ArrowRightIcon /></button>
          </div> : null}
          <button className="dropzone flex items-center justify-center gap-2" disabled={importing} onClick={() => void importVideos()}>
            <UploadIcon /><span>{dragging ? '松开鼠标，添加到队列' : '拖入视频到这里，继续添加'}</span><span className="dropzone-formats">MP4 / MOV / MKV</span>
          </button>
          <div className="queue-footnote flex items-center justify-between"><span>按列表顺序逐个处理</span><span className="shortcut"><kbd>Ctrl</kbd><kbd>O</kbd><span>添加视频</span></span></div>
        </section>

      </div>

      <aside className="inspector panel flex flex-col" aria-labelledby="export-heading">
        <div className="inspector-heading flex items-center justify-between"><h2 id="export-heading">导出配置</h2>
          <button className="icon-button" title="重置当前配置" aria-label="重置当前配置" onClick={() => { if (scope === 'all') setGlobalConfig({ ...defaults, directory: globalConfig.directory }); else setOverrides(previous => { const next = { ...previous }; delete next[scope]; return next; }); setNotice('已恢复默认配置'); }}><ResetIcon /></button>
        </div>
        <div className="config-scope"><Select label="配置应用范围" value={scope} onChange={value => { setScope(value); if (value !== 'all') setActiveId(value); }}>
          <option value="all">统一配置全部视频</option>{videos.map(video => <option key={video.id} value={video.id}>{video.name}</option>)}
        </Select><p>{scope === 'all' ? '新添加的视频也将使用以下设置' : '仅修改此视频，其他任务保持原设置'}</p></div>

        <div className="inspector-scroll">
          <section className="config-section" aria-labelledby="picture-heading">
            <h3 id="picture-heading"><VideoIcon />画面设置</h3>
            <div className="field enhancement-field"><label>增强方式</label><Segments label="增强方式" value={config.enhance} onChange={value => update('enhance', value)} options={[
              { value: 'ai', label: 'AI 画质增强', icon: <LightningBoltIcon /> }, { value: 'resize', label: '普通缩放' },
            ]} /><p className="field-hint">{config.enhance === 'ai' ? '修复模糊细节，让画面更清晰' : '调整画面尺寸，保留原始画面风格'}</p></div>
            <div className="field processing-field"><span className="field-label">处理策略</span>
              <Segments label="处理策略" value={config.processingStrategy} onChange={value => update('processingStrategy', value)} options={[
                { value: 'speed', label: '速度优先', disabled: config.enhance !== 'ai' }, { value: 'quality', label: '质量优先', disabled: config.enhance !== 'ai' },
              ]} />
              <p className="field-hint">{config.enhance !== 'ai' ? '普通缩放无需选择 AI 处理策略。' : config.processingStrategy === 'speed' ? '先缩半再超分，优先缩短处理时间。' : '从原始帧超分，耗时更长，建议设备高性能下使用。'}</p>
            </div>
            <div className="resolution-fps grid gap-4">
              <div className="field"><label>输出分辨率</label><Select label="输出分辨率" value={config.resolution} onChange={value => update('resolution', value)}>
                <option value="source">保持原始</option><option value="720p">720p HD</option><option value="1080p">1080p FHD</option><option value="2k">2K QHD</option><option value="4k">4K UHD</option><option value="custom">自定义</option>
              </Select></div>
              <div className="field"><label>目标帧率</label><Select label="目标帧率" value={config.fps} onChange={value => update('fps', value)}>
                <option value="source">保持原始</option><option value="24">24 fps</option><option value="30">30 fps</option><option value="60">60 fps</option><option value="120">120 fps</option>
              </Select></div>
            </div>
            {config.resolution === 'custom' && <div className="custom-resolution flex items-center gap-2">
              <label className="sr-only" htmlFor="custom-width">自定义宽度</label><input id="custom-width" aria-invalid={invalidDimensions} type="number" min="16" step="2" value={config.width} onChange={event => update('width', event.target.value)} />
              <span>×</span><label className="sr-only" htmlFor="custom-height">自定义高度</label><input id="custom-height" aria-invalid={invalidDimensions} type="number" min="16" step="2" value={config.height} onChange={event => update('height', event.target.value)} /><span>px</span>
            </div>}
            {invalidDimensions && <p className="inline-error">宽高需为 16～7680 之间的偶数</p>}
            <label className="checkbox-label keep-ratio"><input type="checkbox" checked={config.keepRatio} onChange={event => update('keepRatio', event.target.checked)} /><Link2Icon />保持原始宽高比</label>
          </section>

          <section className="config-section" aria-labelledby="encoding-heading">
            <h3 id="encoding-heading"><LayersIcon />编码与音频</h3>
            <div className="codec-row flex items-center justify-between gap-3"><span className="field-label">视频编码</span><Segments label="视频编码" value={config.codec} onChange={value => update('codec', value)} options={[{ value: 'h264', label: 'H.264' }, { value: 'hevc', label: 'H.265' }]} /></div>
            <p className="codec-hint field-hint">{config.codec === 'h264' ? '兼容更多设备与播放器' : '相近画质下，通常占用更少空间'}</p>
            <OutputSettings config={config} sources={scope === 'all' ? videos : videos.filter(video => video.id === scope)} onChange={updateConfig} />
            <div className="audio-row flex items-center justify-between gap-3"><label className="flex items-center gap-2" htmlFor="keep-audio"><SpeakerLoudIcon />保留原音频</label>
              <input id="keep-audio" className="switch" type="checkbox" role="switch" checked={config.audio} onChange={event => update('audio', event.target.checked)} />
            </div>
          </section>

          <section className="config-section save-section" aria-labelledby="save-heading">
            <h3 id="save-heading"><ArchiveIcon />保存设置</h3>
            <div className="field destination-field"><label>存储目录</label><Segments label="存储目录" value={config.destination} onChange={value => update('destination', value)} options={[{ value: 'custom', label: '指定目录' }, { value: 'source', label: '源文件目录' }]} />
              {config.destination === 'custom' ? <div className={`directory-input flex items-center gap-2 ${directoryEditing ? 'is-editing' : ''}`}>
                <ArchiveIcon /><input ref={directoryRef} aria-label="输出目录路径" value={config.directory} title={config.directory} onChange={event => update('directory', event.target.value)} onFocus={() => setDirectoryEditing(true)} onBlur={() => { setDirectoryEditing(false); void checkDirectory(); }} />
                <button className="icon-button" aria-label="选择输出目录" title="选择输出目录" onClick={() => void chooseDirectory()}><ArchiveIcon /></button>
              </div> : <p className="field-hint destination-hint">每个视频将保存到各自的源文件目录</p>}
            </div>
            {config.destination === 'custom' && <><button className="text-button" onClick={() => void window.desktop.openDirectory(config.directory).catch(error => setDirectoryError(error.message))}>打开输出目录<ArrowRightIcon /></button>{directoryError && <p className="inline-error" role="alert">{directoryError}</p>}</>}
            <div className="filename-field field"><label htmlFor="filename-suffix">文件命名</label><div className="filename-control flex items-center"><span>原文件名</span><input id="filename-suffix" aria-label="输出文件名后缀" value={config.suffix} maxLength={32} onChange={event => update('suffix', event.target.value.replace(/[\\/:*?"<>|]/g, ''))} /><span className="mono">.mp4</span></div></div>
            <details className="advanced-options"><summary>更多设置<ChevronDownIcon /></summary><div className="flex items-center justify-between gap-3"><label>同名文件</label><Select label="同名文件处理方式" value={config.collision} onChange={value => update('collision', value)}><option value="number">自动编号</option><option value="skip">跳过文件</option></Select></div></details>
          </section>
          <EnvironmentStatus />
        </div>
        <div className="inspector-footnote flex items-center gap-2"><CheckCircledIcon />{scope === 'all' ? '设置自动应用，无需额外保存' : '此视频使用独立配置'}</div>
      </aside>
    </main>

    <footer className="action-bar flex items-center justify-between gap-5">
      <div className="footer-status flex items-center gap-3"><span className="footer-status-icon"><DesktopIcon /></span>
        <div><p>{busy ? paused ? '当前任务完成后暂停队列' : '正在按顺序处理' : importing ? '正在读取视频信息' : invalidConfig ? '请检查导出配置' : '准备就绪'}<span className="local-tag">本地处理</span></p><span>按列表顺序处理；已入队任务保留提交时的配置。</span></div>
      </div>
      <div className="footer-actions flex items-center gap-5"><div className="export-summary"><p>{videos.length} 个视频<span className="meta-dot" />{size(totalBytes)}</p><span>按顺序处理，完成后保存至指定目录</span></div>
        {busy && <div className="queue-controls"><button className="text-button" onClick={() => void (paused ? window.desktop.resume() : window.desktop.pause()).catch(error => setNotice(error.message))}>{paused ? '继续队列' : '暂停后续'}</button><button className="text-button" onClick={() => void window.desktop.cancel().catch(error => setNotice(error.message))}>取消当前</button><button className="text-button" onClick={() => void window.desktop.stop().catch(error => setNotice(error.message))}>停止队列</button></div>}
        <button className="button primary start-button" disabled={!videos.length || invalidConfig || importing || !hydrated} onClick={() => void startProcessing()}><PlayIcon />{busy ? '追加新任务' : '开始处理'}<ArrowRightIcon /></button>
      </div>
    </footer>
    <div className="bottom-strip flex items-center justify-between"><span><span className="status-dot" />本地处理</span><span>VIDEO ENHANCEMENT<span className="strip-divider">/</span>帧序 0.2</span></div>
    {notice && <div className="toast flex items-center gap-2.5" role="status"><InfoCircledIcon /><span>{notice}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setNotice('')}><Cross2Icon /></button></div>}

    <dialog ref={helpRef} className="help-dialog" onClick={event => { if (event.target === event.currentTarget) helpRef.current?.close(); }}>
      <div className="flex items-center justify-between gap-4"><h2>帧序使用说明</h2><button className="icon-button" aria-label="关闭使用说明" onClick={() => helpRef.current?.close()}><Cross2Icon /></button></div>
      <p>已接入顺序队列、真实导出与任务记录恢复。暂停后续会在当前任务完成后生效。</p>
      <ol><li><UploadIcon /><div><strong>加入视频队列</strong><span>多选本地视频或直接拖入，视频信息由 FFprobe 读取。</span></div></li><li><MixerHorizontalIcon /><div><strong>调整导出效果</strong><span>右侧统一配置，行内设置图标可单独调整。</span></div></li><li><DownloadIcon /><div><strong>查看处理状态</strong><span>完成后可打开输出位置；失败或中断可通过行内重试。</span></div></li></ol>
      <p className="help-note">项目示例使用真实视频文件，不再加载虚构任务。</p>
      <button className="button primary" onClick={() => helpRef.current?.close()}><CheckIcon />开始体验</button>
    </dialog>
  </div>;
}
