/**
 * 多轨离线混音（纯函数，可在 Node 中断言）。
 *
 * 与播放引擎采用同一套规则：片段按时间轴 start 定位、offset 裁剪源、
 * 轨道增益 + 声像用等功率 pan law、片段淡入淡出为线性斜坡。
 * 采样率不一致时用 8 抽头 Lanczos 窗 sinc 重采样，避免线性插值的镜像噪声。
 */
import type { Clip, MultitrackState } from './multitrack'
import { audibleTrackIds, dbToGain } from './multitrack'

export interface MixInput {
  channels: Float32Array[]
  sampleRate: number
  start: number
  offset: number
  duration: number
  gain: number
  pan: number
  fadeInMs: number
  fadeOutMs: number
}

export interface MixdownOptions {
  sampleRate: number
  outChannels: 1 | 2
  /** 输出总时长（秒），通常由 timelineDuration 决定 */
  duration: number
  /** 从时间轴上截取一段（秒），用于「导出选区」 */
  from?: number
  to?: number
  onProgress?: (p: number) => void
  /** 长混音是同步计算，允许在片段与采样块边界响应取消 */
  signal?: AbortSignal
}

const SINC_TAPS = 8

function sinc(x: number): number {
  if (Math.abs(x) < 1e-9) return 1
  const p = Math.PI * x
  return Math.sin(p) / p
}

/** 单声道重采样：fromRate → toRate，带低通截止的窗化 sinc */
export function resampleChannel(
  input: Float32Array,
  fromRate: number,
  toRate: number
): Float32Array {
  if (fromRate === toRate || input.length === 0) return input
  const ratio = fromRate / toRate
  const outLength = Math.max(1, Math.floor(input.length / ratio))
  const out = new Float32Array(outLength)
  const cutoff = Math.min(1, 1 / Math.max(1e-6, ratio))
  const n = input.length
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio
    const center = Math.floor(pos)
    let sum = 0
    for (let k = -SINC_TAPS + 1; k <= SINC_TAPS; k++) {
      const idx = center + k
      if (idx < 0 || idx >= n) continue
      const t = pos - idx
      const window = sinc(t / SINC_TAPS)
      sum += input[idx] * sinc(t * cutoff) * cutoff * window
    }
    out[i] = sum
  }
  return out
}

/** 等功率声像：pan=0 时左右各 1.0，pan=±1 时一侧为 sqrt(2) */
export function panGains(pan: number): { left: number; right: number } {
  const p = Math.max(-1, Math.min(1, pan))
  const theta = ((p + 1) * Math.PI) / 4
  return { left: Math.cos(theta) * Math.SQRT2, right: Math.sin(theta) * Math.SQRT2 }
}

export function clipToMixInput(clip: Clip, state: MultitrackState): MixInput {
  const track = state.tracks.find((t) => t.id === clip.trackId)
  return {
    channels: clip.channels,
    sampleRate: clip.sampleRate,
    start: clip.start,
    offset: clip.offset,
    duration: clip.duration,
    gain: dbToGain(clip.gainDb) * dbToGain(track?.gainDb ?? 0),
    pan: Math.max(-1, Math.min(1, track?.pan ?? 0)),
    fadeInMs: clip.fadeInMs,
    fadeOutMs: clip.fadeOutMs
  }
}

/** 把主轨（现有 buffer）与其它片段统一转成混音输入；M/S 在这里生效 */
export function buildMixInputs(
  main: { channels: Float32Array[]; sampleRate: number; duration: number } | null,
  state: MultitrackState,
  includeMain = true
): MixInput[] {
  const audible = audibleTrackIds(state.tracks)
  const out: MixInput[] = []
  if (includeMain && main && audible.has('track-main')) {
    const mainTrack = state.tracks.find((t) => t.kind === 'main')
    out.push({
      channels: main.channels,
      sampleRate: main.sampleRate,
      start: 0,
      offset: 0,
      duration: main.duration,
      gain: dbToGain(mainTrack?.gainDb ?? 0),
      pan: Math.max(-1, Math.min(1, mainTrack?.pan ?? 0)),
      fadeInMs: 0,
      fadeOutMs: 0
    })
  }
  for (const c of state.clips) {
    if (!audible.has(c.trackId)) continue
    out.push(clipToMixInput(c, state))
  }
  return out
}

/**
 * 混音到指定采样率 / 声道数。超出输出范围的片段自动跳过；
 * from/to 可只渲染时间轴的一段（导出选区），返回结果已按 from 对齐。
 */
function aborted(): never {
  throw new DOMException('混音已取消', 'AbortError')
}

export function mixdown(inputs: MixInput[], opts: MixdownOptions): Float32Array[] {
  // 严格按调用方给的采样率输出；只对非法值兜底，不做下限钳制，
  // 否则低采样率渲染会静默产生成倍的采样点。
  const requestedRate = Math.round(opts.sampleRate)
  const rate = Number.isFinite(requestedRate) && requestedRate > 0 ? requestedRate : 48000
  const from = Math.max(0, opts.from ?? 0)
  const to = Math.max(from, opts.to ?? opts.duration)
  const frames = Math.max(0, Math.round((to - from) * rate))
  const nCh = opts.outChannels
  if (opts.signal?.aborted) aborted()
  const out = Array.from({ length: nCh }, () => new Float32Array(frames))
  if (frames === 0) return out

  const active = inputs.filter(
    (i) => i.channels.length > 0 && i.duration > 0 && i.start + i.duration > from && i.start < to
  )
  active.forEach((input, index) => {
    if (opts.signal?.aborted) aborted()
    const srcRate = input.sampleRate
    const srcOffset = Math.max(0, Math.round(input.offset * srcRate))
    const wanted = Math.round(input.duration * srcRate)
    const available = Math.max(0, (input.channels[0]?.length ?? 0) - srcOffset)
    const srcFrames = Math.min(wanted, available)
    if (srcFrames <= 0) return

    // 一次性重采样整段可见部分（采样率相同时零拷贝）
    const resampled = input.channels.map((ch) => {
      const view = ch.subarray(srcOffset, srcOffset + srcFrames)
      return resampleChannel(view, srcRate, rate)
    })
    const { left, right } = panGains(input.pan)
    const destStart = Math.round(input.start * rate) - Math.round(from * rate)
    const fadeIn = Math.max(0, Math.round((input.fadeInMs / 1000) * rate))
    const fadeOut = Math.max(0, Math.round((input.fadeOutMs / 1000) * rate))

    for (let c = 0; c < nCh; c++) {
      const dst = out[c]
      // 单声道源复制到两侧；多声道源按 L/R 交错映射，其余声道取平均
      const src =
        resampled.length === 1
          ? resampled[0]
          : c === 0
            ? resampled[0]
            : c === 1
              ? resampled[Math.min(1, resampled.length - 1)]
              : resampled[Math.min(c, resampled.length - 1)]
      if (!src) continue
      const baseGain = input.gain * (nCh === 1 ? 1 : resampled.length === 1 ? Math.SQRT1_2 : 1)
      const panGain = nCh === 1 ? 1 : c === 0 ? left : right
      const g = baseGain * panGain
      const lo = Math.max(0, -destStart)
      const hi = Math.min(src.length, frames - destStart)
      for (let i = lo; i < hi; i++) {
        // 每 65536 个采样检查一次，长音轨混音也能被「取消导出」及时打断
        if ((i & 0xffff) === 0 && opts.signal?.aborted) aborted()
        let fade = 1
        if (fadeIn > 0 && i < fadeIn) fade = (i + 1) / (fadeIn + 1)
        if (fadeOut > 0 && i > src.length - fadeOut) {
          fade = Math.min(fade, Math.max(0, (src.length - i) / (fadeOut + 1)))
        }
        dst[destStart + i] += src[i] * g * fade
      }
    }
    opts.onProgress?.((index + 1) / Math.max(1, active.length))
  })
  return out
}

/** 时间线片段的迷你波形：按列取 min/max，供 Canvas 绘制，不做全采样遍历的响应式代理 */
export function computeClipPeaks(
  channels: Float32Array[],
  sampleRate: number,
  offset: number,
  duration: number,
  columns: number
): { min: Float32Array; max: Float32Array } {
  const cols = Math.max(1, Math.round(columns))
  const min = new Float32Array(cols)
  const max = new Float32Array(cols)
  const ch = channels[0]
  if (!ch || duration <= 0) return { min, max }
  const startFrame = Math.max(0, Math.round(offset * sampleRate))
  const totalFrames = Math.min(ch.length - startFrame, Math.round(duration * sampleRate))
  if (totalFrames <= 0) return { min, max }
  const per = totalFrames / cols
  // 每列最多抽 96 点：长片段缩放/拖动时不会 O(全采样) 重绘，视觉上仍保留瞬态轮廓
  const stride = Math.max(1, Math.floor(per / 96))
  for (let x = 0; x < cols; x++) {
    const a = startFrame + Math.floor(x * per)
    const b = Math.min(ch.length, startFrame + Math.floor((x + 1) * per))
    let mn = Infinity
    let mx = -Infinity
    for (let i = a; i < b; i += stride) {
      const v = ch[i]
      if (v < mn) mn = v
      if (v > mx) mx = v
    }
    if (b > a) {
      const last = ch[b - 1]
      if (last < mn) mn = last
      if (last > mx) mx = last
    }
    if (mn === Infinity) {
      mn = 0
      mx = 0
    }
    min[x] = mn
    max[x] = mx
  }
  return { min, max }
}
