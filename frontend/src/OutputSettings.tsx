import { useId } from 'react';

export type OutputOptions = {
  rateControl: 'fixed' | 'dynamic' | 'size';
  bitrate: string;
  qualityValue: string;
  sizeLimit: string;
};

type Settings = OutputOptions & {
  resolution: string; fps: string; codec: string;
  width: string; height: string; audio: boolean;
};
type Source = { width: number; height: number; fps?: number };

export function outputError(config: OutputOptions) {
  if (config.rateControl === 'fixed') {
    const value = Number(config.bitrate);
    return config.bitrate.trim() && Number.isFinite(value) && value >= 0.1 && value <= 1000
      ? '' : '请输入 0.1～1000 之间的视频码率';
  }
  if (config.rateControl === 'dynamic') {
    const value = Number(config.qualityValue);
    return config.qualityValue.trim() && Number.isInteger(value) && value >= 1 && value <= 51
      ? '' : '请输入 1～51 之间的整数质量值';
  }
  const value = Number(config.sizeLimit);
  return config.sizeLimit.trim() && Number.isFinite(value) && value >= 0.1
    ? '' : '请输入不小于 0.1 MB 的每分钟体积上限';
}

const tiers = [
  { pixels: 1280 * 720, low: [2, 5], high: [4, 8] },
  { pixels: 1920 * 1080, low: [4, 8], high: [8, 12] },
  { pixels: 2560 * 1440, low: [8, 16], high: [12, 24] },
  { pixels: 3840 * 2160, low: [20, 40], high: [35, 60] },
];
const resolutions: Record<string, { label: string; pixels: number }> = {
  '720p': { label: '720p', pixels: 1280 * 720 },
  '1080p': { label: '1080p', pixels: 1920 * 1080 },
  '2k': { label: '2K', pixels: 2560 * 1440 },
  '4k': { label: '4K', pixels: 3840 * 2160 },
};
const number = (value: number) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value);

// Viewing-quality estimates, not codec guarantees or automatic bitrate changes.
function rangeFor(pixels: number, fps: number, codec: string) {
  const first = tiers[0];
  const last = tiers[tiers.length - 1];
  let low: number[];
  let high: number[];
  if (pixels < first.pixels || pixels > last.pixels) {
    const edge = pixels < first.pixels ? first : last;
    const factor = pixels / edge.pixels;
    low = edge.low.map(value => value * factor);
    high = edge.high.map(value => value * factor);
  } else {
    const upperIndex = tiers.findIndex(tier => pixels <= tier.pixels);
    const upper = tiers[upperIndex];
    const lower = tiers[Math.max(0, upperIndex - 1)];
    const fraction = upper.pixels === lower.pixels ? 0 : (pixels - lower.pixels) / (upper.pixels - lower.pixels);
    low = lower.low.map((value, index) => value + (upper.low[index] - value) * fraction);
    high = lower.high.map((value, index) => value + (upper.high[index] - value) * fraction);
  }
  const frameFraction = Math.min(1, Math.max(0, (fps - 30) / 30));
  const factor = (codec === 'hevc' ? 0.65 : 1) * (fps > 60 ? fps / 60 : 1);
  return low.map((value, index) => Math.max(0.1, (value + (high[index] - value) * frameFraction) * factor));
}

function recommendation(config: Settings, sources: Source[]) {
  const usesSource = config.resolution === 'source' || config.fps === 'source';
  const targets: (Source | undefined)[] = usesSource ? sources : [undefined];
  let unknownDimensions = false;
  let unknownFps = false;
  const ranges: number[][] = [];
  for (const source of targets) {
    const pixels = config.resolution === 'source' ? (source?.width ?? 0) * (source?.height ?? 0)
      : config.resolution === 'custom' ? Number(config.width) * Number(config.height)
        : resolutions[config.resolution]?.pixels;
    if (!pixels || !Number.isFinite(pixels) || pixels <= 0) { unknownDimensions = true; continue; }
    let fps = Number(config.fps);
    if (config.fps === 'source') {
      fps = source?.fps ?? 30;
      if (!source?.fps) unknownFps = true;
    }
    ranges.push(rangeFor(pixels, fps, config.codec));
  }
  const resolutionLabel = config.resolution === 'source' ? '原始分辨率'
    : config.resolution === 'custom' ? `${config.width || '…'} × ${config.height || '…'}`
      : resolutions[config.resolution]?.label;
  const context = `${resolutionLabel} · ${config.fps === 'source' ? '原始帧率' : `${config.fps} fps`} · ${config.codec === 'hevc' ? 'H.265' : 'H.264'}`;
  const range = ranges.length ? `${number(Math.min(...ranges.map(value => value[0])))}～${number(Math.max(...ranges.map(value => value[1])))}` : '';
  const notes = [
    usesSource && sources.length > 1 ? '混合素材范围，可在单个视频配置中查看建议。' : '',
    unknownDimensions ? '部分源尺寸待识别。' : '',
    unknownFps ? '原帧率待识别，暂按 30 fps 估算。' : '',
  ].filter(Boolean).join('');
  return { context, range, notes };
}

const methods = [
  { value: 'fixed', label: '固定码率' },
  { value: 'dynamic', label: '动态码率' },
  { value: 'size', label: '体积限制' },
] as const;

export default function OutputSettings({ config, sources, onChange }: {
  config: Settings; sources: Source[];
  onChange: (patch: Partial<OutputOptions>) => void;
}) {
  const id = useId();
  const error = outputError(config);
  const suggested = recommendation(config, sources);
  const budget = Number(config.sizeLimit) * 8 / 60;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return <fieldset className="output-settings">
    <legend className="field-label">输出控制</legend>
    <div className="rate-methods">
      {methods.map(method => <label key={method.value}>
        <input type="radio" name={`${id}-rate-control`} value={method.value}
          checked={config.rateControl === method.value} onChange={() => onChange({ rateControl: method.value })} />
        {method.label}
      </label>)}
    </div>
      <div className="rate-details">
        {config.rateControl === 'fixed' && <>
          <label className="field-label" htmlFor={`${id}-bitrate`}>视频码率</label>
          <div className="number-with-unit">
            <input id={`${id}-bitrate`} type="number" min="0.1" max="1000" step="any" inputMode="decimal"
              value={config.bitrate} onChange={event => onChange({ bitrate: event.target.value })}
              aria-invalid={Boolean(error)} aria-describedby={`${hintId}${error ? ` ${errorId}` : ''}`} />
            <span>Mbps</span>
          </div>
          <div className="rate-hints" id={hintId}>
            <p className="recommendation-context">{suggested.context}</p>
            <p className="field-hint">{suggested.range ? <>建议 <strong>{suggested.range} Mbps</strong>，仅作经验参考。</> : '源尺寸待识别，请先指定输出分辨率。'}</p>
            <p className="field-hint">{suggested.notes || '画面越复杂，通常需要越高的码率。'}</p>
          </div>
        </>}
        {config.rateControl === 'dynamic' && <>
          <label className="field-label" htmlFor={`${id}-quality`}>质量值（CQ / CRF）</label>
          <div className="number-with-unit">
            <input id={`${id}-quality`} type="number" min="1" max="51" step="1" inputMode="numeric"
              value={config.qualityValue} onChange={event => onChange({ qualityValue: event.target.value })}
              aria-invalid={Boolean(error)} aria-describedby={`${hintId}${error ? ` ${errorId}` : ''}`} />
            <span>1～51</span>
          </div>
          <div className="rate-hints" id={hintId}>
            <p className="field-hint">建议 <strong>18～28</strong>，可从 <strong>23</strong> 开始。</p>
            <p className="field-hint">数值越小，画质越高、文件越大。</p>
            <p className="field-hint">码率随画面复杂度变化；不同编码器的数值不宜直接比较。</p>
            <p className="field-hint">硬件编码使用 CQ，软件回退使用 CRF，实际编码器显示在任务状态中。</p>
          </div>
        </>}
        {config.rateControl === 'size' && <>
          <label className="field-label" htmlFor={`${id}-size`}>每分钟体积上限</label>
          <div className="number-with-unit size-budget">
            <span>1 分钟最多</span>
            <input id={`${id}-size`} type="number" min="0.1" step="any" inputMode="decimal"
              value={config.sizeLimit} onChange={event => onChange({ sizeLimit: event.target.value })}
              aria-invalid={Boolean(error)} aria-describedby={`${hintId}${error ? ` ${errorId}` : ''}`} />
            <span>MB</span>
          </div>
          <div className="rate-hints" id={hintId}>
            {!error && <p className="field-hint">总码率预算约 <strong>{number(budget)} Mbps</strong>。</p>}
            <p className="field-hint">{config.audio ? '视频、音频与封装共用此上限。' : '视频与封装共用此上限。'}体积越小，画质越受限。</p>
            <p className="field-hint">按总时长折算总文件上限，使用软件编码并校验成片大小。</p>
          </div>
        </>}
        {error && <p className="inline-error" id={errorId} role="alert">{error}</p>}
      </div>
  </fieldset>;
}
