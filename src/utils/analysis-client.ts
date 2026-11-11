/**
 * 音频分析 Worker 的类型化客户端。
 *
 * 所有请求都会先把声道数据 `.slice()` 成专有拷贝再 transfer——AudioBuffer 的
 * getChannelData() 视图属于内部存储，直接转移会把正在播放的音轨 detach 掉。
 * 任务经 process-worker 的串行队列执行；取消采用「提前返回、结果丢弃」语义，
 * 底层任务自然结束后队列继续，不会把后续请求卡死。
 */
import { runProcessTask } from './process-worker'
import type { LoudnessStats } from '../audio/loudness'
import type {
  AudioSegment,
  NoiseProfile,
  SilenceOptions,
  Spectrogram,
  SpectrogramOptions
} from '../audio/spectral'

function copyChannels(channels: Float32Array[]): { data: Float32Array[]; transfer: Transferable[] } {
  const data = channels.map((c) => c.slice())
  return { data, transfer: data.map((c) => c.buffer) }
}

function abortError(): DOMException {
  return new DOMException('分析已取消', 'AbortError')
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError())
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(abortError()), { once: true })
    })
  ])
}

function run<T>(
  message: Record<string, unknown>,
  channels: Float32Array[],
  signal?: AbortSignal,
  onProgress?: (p: number) => void
): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError())
  const copy = copyChannels(channels)
  return withAbort(
    runProcessTask<T>({ ...message, channels: copy.data }, copy.transfer, onProgress),
    signal
  )
}

export function analyzeAudio(
  channels: Float32Array[],
  sampleRate: number,
  options: { maxHistoryPoints?: number; signal?: AbortSignal; onProgress?: (p: number) => void } = {}
): Promise<LoudnessStats> {
  return run<{ stats: LoudnessStats }>(
    { type: 'analyze', sampleRate, maxHistoryPoints: options.maxHistoryPoints },
    channels,
    options.signal,
    options.onProgress
  ).then((r) => r.stats)
}

export function buildSpectrogram(
  channels: Float32Array[],
  sampleRate: number,
  options: SpectrogramOptions & { signal?: AbortSignal } = {}
): Promise<Spectrogram> {
  return run<{ spectrogram: Spectrogram }>(
    {
      type: 'spectrogram',
      sampleRate,
      fftSize: options.fftSize ?? 2048,
      maxColumns: options.maxColumns ?? 1600,
      minDb: options.minDb ?? -95,
      maxDb: options.maxDb ?? -10
    },
    channels,
    options.signal,
    options.onProgress
  ).then((r) => r.spectrogram)
}

export function captureNoiseProfile(
  channels: Float32Array[],
  sampleRate: number,
  startFrame: number,
  endFrame: number,
  signal?: AbortSignal,
  onProgress?: (p: number) => void
): Promise<NoiseProfile> {
  return run<{ profile: NoiseProfile }>(
    { type: 'noise-profile', sampleRate, startFrame, endFrame },
    channels,
    signal,
    onProgress
  ).then((r) => r.profile)
}

export function denoiseAudio(
  channels: Float32Array[],
  sampleRate: number,
  profile: NoiseProfile,
  amountDb: number,
  signal?: AbortSignal,
  onProgress?: (p: number) => void
): Promise<Float32Array[]> {
  return run<{ channels: Float32Array[] }>(
    { type: 'denoise', sampleRate, profile, amountDb },
    channels,
    signal,
    onProgress
  ).then((r) => r.channels)
}

export function declickAudio(
  channels: Float32Array[],
  sampleRate: number,
  sensitivity: number,
  signal?: AbortSignal,
  onProgress?: (p: number) => void
): Promise<{ channels: Float32Array[]; clicks: number }> {
  return run<{ channels: Float32Array[]; clicks: number }>(
    { type: 'declick', sampleRate, sensitivity },
    channels,
    signal,
    onProgress
  )
}

export function detectSilence(
  channels: Float32Array[],
  sampleRate: number,
  options: SilenceOptions,
  signal?: AbortSignal
): Promise<AudioSegment[]> {
  return run<{ segments: AudioSegment[] }>(
    { type: 'silence', sampleRate, options },
    channels,
    signal
  ).then((r) => r.segments)
}

export function limitAudio(
  channels: Float32Array[],
  sampleRate: number,
  ceilingDb: number,
  signal?: AbortSignal,
  onProgress?: (p: number) => void
): Promise<{ channels: Float32Array[]; maxReductionDb: number; truePeakDb: number }> {
  return run<{ channels: Float32Array[]; maxReductionDb: number; truePeakDb: number }>(
    { type: 'limiter', sampleRate, ceilingDb },
    channels,
    signal,
    onProgress
  )
}

export function shiftPitch(
  channels: Float32Array[],
  sampleRate: number,
  semitones: number,
  signal?: AbortSignal,
  onProgress?: (p: number) => void
): Promise<Float32Array[]> {
  return run<{ channels: Float32Array[] }>(
    { type: 'pitch-shift', sampleRate, semitones },
    channels,
    signal,
    onProgress
  ).then((r) => r.channels)
}
