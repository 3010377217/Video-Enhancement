import { useId } from 'react';
import { Segments } from './ui';

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


export default function OutputSettings({ config, sources, onChange }: {
  config: Settings; sources: Source[];
  onChange: (patch: Partial<OutputOptions>) => void;
}) {
  const id = useId();
  const error = outputError(config);
  const errorId = `${id}-error`;
  const fixed = config.rateControl === 'fixed';
  const suggested = fixed ? recommendation(config, sources) : null;
  const inputId = `${id}-value`;
  return <div className="field">
    <span className="field-label">输出方式</span>
    <Segments label="输出方式" value={fixed ? 'fixed' : 'dynamic'} onChange={value => onChange({ rateControl: value })}
      options={[{ value: 'dynamic', label: '动态码率' }, { value: 'fixed', label: '固定码率' }]} />
    <div className="value-row">
      <label htmlFor={inputId}>{fixed ? '视频码率' : '质量值'}</label>
      <input id={inputId} type="number" inputMode={fixed ? 'decimal' : 'numeric'} step={fixed ? 'any' : '1'}
        min={fixed ? '0.1' : '1'} max={fixed ? '1000' : '51'}
        value={fixed ? config.bitrate : config.qualityValue}
        onChange={event => onChange(fixed ? { bitrate: event.target.value } : { qualityValue: event.target.value })}
        aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} />
      <span>{fixed ? 'Mbps' : 'CRF / CQ'}</span>
    </div>
    <p className="field-hint">{fixed
      ? (suggested?.range ? `建议 ${suggested.range} Mbps` : '')
      : '建议 18～28，数值越小画质越高'}</p>
    {error && <p className="inline-error" id={errorId} role="alert">{error}</p>}
  </div>;
}
