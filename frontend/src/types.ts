import type { OutputOptions } from './OutputSettings';
export type Video = {
  id: string; path: string; name: string; bytes: number; width: number; height: number;
  codedWidth: number; codedHeight: number; rotation: number; duration: number;
  fps: number; fpsRational: string; codec: string; audio: boolean; hdr: boolean; bitDepth: number; sar: string;
  vfr: boolean; audioTracks: number; subtitles: boolean; audioCodec?: string;
};
export interface Config extends OutputOptions {
  processingStrategy: 'speed' | 'quality' | 'custom'; srTile: string; srThreads: string; cacheDir: string; chunkFrames: string; interQuality: string; enhance: string; resolution: string; fps: string; codec: string;
  audio: boolean; destination: string; directory: string; suffix: string;
  collision: string; keepRatio: boolean; width: string; height: string;
}
export type Environment = {
  checks: { name: string; ok: boolean; detail: string }[];
  encoders: { name: string; ok: boolean; detail: string }[];
  models: { name: string; ok: boolean; detail: string }[];
  gpu: string; aiVerified: boolean;
};
export type ImportResult = { items: Video[]; errors: { name: string; message: string }[] };
export type JobEvent = { type: string; videoId: string; jobId: string; stage?: string; progress?: number; output?: string; error?: string; encoder?: string };
export type QueueSnapshot = { videos: Video[]; tasks: { id: string; videoId: string; status: string; event: JobEvent }[]; paused: boolean; settings: { global: Config; overrides: Record<string, Config> } | null; loadError?: string };
declare global {
  interface Window {
    desktop: {
      chooseVideos(): Promise<ImportResult>;
      importDropped(files: File[]): Promise<ImportResult>;
      loadSample(): Promise<ImportResult>;
      remove(ids: string[]): Promise<void>;
      chooseDirectory(current: string): Promise<string | null>;
      checkDirectory(directory: string): Promise<string>;
      openDirectory(directory: string): Promise<void>;
      environment(): Promise<Environment>;
      defaultDirectory(): Promise<string>;
      start(id: string, config: Config): Promise<{ id: string }>;
      cancel(): Promise<void>;
      pauseTask(id: string): Promise<void>; resumeTask(id: string): Promise<void>;
      showResult(id: string): Promise<void>;
      onJob(callback: (event: JobEvent) => void): () => void;
      snapshot(): Promise<QueueSnapshot>;
      enqueue(items: { id: string; config: Config }[]): Promise<QueueSnapshot>;
      pause(): Promise<void>; resume(): Promise<void>; stop(): Promise<void>;
      retry(id: string): Promise<QueueSnapshot>;
      saveSettings(settings: { global: Config; overrides: Record<string, Config> }): Promise<void>;
    };
  }
}
