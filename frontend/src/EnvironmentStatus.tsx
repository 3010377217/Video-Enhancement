import { useEffect, useState } from 'react';
import type { Environment } from './types';

export default function EnvironmentStatus() {
  const [environment, setEnvironment] = useState<Environment>();
  const [error, setError] = useState('');
  useEffect(() => { window.desktop.environment().then(setEnvironment).catch(error => setError(error.message)); }, []);
  return <details className="environment-status">
    <summary>运行环境 <span>{error ? '检测失败' : environment ? environment.checks.every(check => check.ok) ? '基础工具就绪' : '缺少工具' : '检测中'}</span></summary>
    {error && <p className="inline-error">{error}</p>}
    {environment && <><p className="field-hint">{environment.gpu}</p>
      {[...environment.checks, ...environment.encoders, ...environment.models].map(check => <p key={check.name} title={check.detail} className={check.ok ? 'field-hint' : 'inline-error'}>{check.name}：{check.ok ? '可用' : '不可用'}</p>)}
      <p className="field-hint">编码器已做短帧实测；AI 文件已检测，GPU 推理以实际任务结果为准。</p>
    </>}
  </details>;
}
