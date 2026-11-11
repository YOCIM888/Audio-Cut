/**
 * 频谱域工具：FFT、语谱图、噪声指纹降噪、去咔嗒、静音分段、前瞻真峰值限制器。
 * 全为纯函数，主线程 / Worker / Node 断言共用，不依赖任何浏览器 API。
 */
import { truePeakAmplitude, dbFromAmplitude } from './loudness'

export function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)))
  return w
}

/** 原地 radix-2 Cooley-Tukey FFT；长度必须是 2 的幂 */
export function fftInPlace(re: Float32Array, im: Float32Array): void {
  const n = re.length
  if (n < 2 || (n & (n - 1)) !== 0) throw new Error('FFT 长度必须是 2 的幂')
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k]
        const ui = im[i + k]
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr
        re[i + k] = ur + vr
        im[i + k] = ui + vi
        re[i + k + len / 2] = ur - vr
        im[i + k + len / 2] = ui - vi
        const nr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = nr
      }
    }
  }
}

function monoMix(channels: Float32Array[]): Float32Array {
  const n = channels[0]?.length ?? 0
  if (channels.length === 1) return channels[0]
  const out = new Float32Array(n)
  const inv = 1 / channels.length
  for (const ch of channels) {
    for (let i = 0; i < n; i++) out[i] += ch[i] * inv
  }
  return out
}

function magnitudeDb(re: Float32Array, im: Float32Array, bin: number, norm: number): number {
  const m = Math.hypot(re[bin], im[bin]) / norm
  return 20 * Math.log10(m + 1e-12)
}

// ---- 语谱图 ----

export interface Spectrogram {
  /** columns × bins，0..255 的归一化幅度，便于直接写 ImageData */
  data: Uint8Array
  columns: number
  bins: number
  fftSize: number
  hopSize: number
  sampleRate: number
  minDb: number
  maxDb: number
  duration: number
}

export interface SpectrogramOptions {
  fftSize?: number
  maxColumns?: number
  minDb?: number
  maxDb?: number
  onProgress?: (p: number) => void
}

/** 生成线性频率、Hann 窗的幅度谱；列数按 maxColumns 自动抽稀 */
export function computeSpectrogram(
  channels: Float32Array[],
  sampleRate: number,
  options: SpectrogramOptions = {}
): Spectrogram {
  const n = channels[0]?.length ?? 0
  const fftSize = Math.min(4096, Math.max(256, 1 << Math.floor(Math.log2(options.fftSize ?? 2048))))
  const bins = fftSize / 2
  const minDb = options.minDb ?? -95
  const maxDb = options.maxDb ?? -10
  const maxColumns = Math.max(1, options.maxColumns ?? 1600)
  const desired = Math.max(1, Math.floor(Math.max(0, n - fftSize) / (fftSize / 4)) + 1)
  const columns = Math.min(maxColumns, desired)
  const hopSize = columns > 1 ? Math.max(1, Math.floor(Math.max(0, n - fftSize) / (columns - 1))) : fftSize
  const data = new Uint8Array(columns * bins)
  const win = hannWindow(fftSize)
  const norm = fftSize / 2
  const mono = monoMix(channels)
  const re = new Float32Array(fftSize)
  const im = new Float32Array(fftSize)
  const span = Math.max(0, maxDb - minDb)

  for (let col = 0; col < columns; col++) {
    const start = col * hopSize
    for (let i = 0; i < fftSize; i++) {
      re[i] = (mono[start + i] ?? 0) * win[i]
      im[i] = 0
    }
    fftInPlace(re, im)
    const base = col * bins
    for (let b = 0; b < bins; b++) {
      const db = magnitudeDb(re, im, b, norm)
      const v = ((db - minDb) / span) * 255
      data[base + b] = v <= 0 ? 0 : v >= 255 ? 255 : v | 0
    }
    if ((col & 63) === 0) options.onProgress?.(columns === 0 ? 1 : col / columns)
  }
  options.onProgress?.(1)
  return {
    data,
    columns,
    bins,
    fftSize,
    hopSize,
    sampleRate,
    minDb,
    maxDb,
    duration: sampleRate > 0 ? n / sampleRate : 0
  }
}

// ---- 噪声指纹 ----

export const NOISE_BANDS = 32

export interface NoiseProfile {
  /** 每个对数频段的本底噪声幅度（dBFS，负数） */
  bands: number[]
  sampleRate: number
  /** 采样来源（秒），用于 UI 显示 */
  source: { start: number; end: number }
}

function bandEdges(sampleRate: number, count: number): Float32Array {
  const lo = 20
  const hi = Math.min(sampleRate / 2, 24000)
  const edges = new Float32Array(count + 1)
  for (let i = 0; i <= count; i++) edges[i] = lo * Math.pow(hi / lo, i / count)
  return edges
}

export function bandForFrequency(freq: number, sampleRate: number, count = NOISE_BANDS): number {
  const lo = 20
  const hi = Math.min(sampleRate / 2, 24000)
  const t = Math.log(Math.max(lo, Math.min(hi, freq)) / lo) / Math.log(hi / lo)
  return Math.max(0, Math.min(count - 1, Math.floor(t * count)))
}

/**
 * 从一段「只有噪声」的音频采样噪声指纹。
 * 每个对数频段取所有帧能量的 20 分位（比均值更抗偶发语音），得到稳态本底。
 */
export function estimateNoiseProfile(
  channels: Float32Array[],
  sampleRate: number,
  startFrame = 0,
  endFrame = -1,
  onProgress?: (p: number) => void
): NoiseProfile {
  const n = channels[0]?.length ?? 0
  const from = Math.max(0, Math.min(n, Math.floor(startFrame)))
  const to = endFrame < 0 ? n : Math.max(from, Math.min(n, Math.floor(endFrame)))
  const fftSize = 2048
  const hop = 512
  const win = hannWindow(fftSize)
  const norm = fftSize / 2
  const mono = monoMix(channels)
  const frames: Float32Array[] = []
  const maxFrames = 240
  const total = Math.max(1, to - from)
  const stride = Math.max(hop, Math.ceil(Math.max(0, total - fftSize) / maxFrames))
  const re = new Float32Array(fftSize)
  const im = new Float32Array(fftSize)
  const edges = bandEdges(sampleRate, NOISE_BANDS)

  for (let start = from; start + fftSize <= to; start += stride) {
    for (let i = 0; i < fftSize; i++) {
      re[i] = mono[start + i] * win[i]
      im[i] = 0
    }
    fftInPlace(re, im)
    const bandPower = new Float32Array(NOISE_BANDS)
    const bandCount = new Float32Array(NOISE_BANDS)
    for (let b = 1; b < fftSize / 2; b++) {
      const freq = (b * sampleRate) / fftSize
      let bi = 0
      while (bi < NOISE_BANDS - 1 && freq >= edges[bi + 1]) bi++
      const m = Math.hypot(re[b], im[b]) / norm
      bandPower[bi] += m * m
      bandCount[bi]++
    }
    for (let i = 0; i < NOISE_BANDS; i++) {
      bandPower[i] = bandCount[i] > 0 ? bandPower[i] / bandCount[i] : 0
    }
    frames.push(bandPower)
    if (frames.length >= maxFrames) break
    onProgress?.(Math.min(1, (start - from + fftSize) / total))
  }

  const bands: number[] = []
  for (let i = 0; i < NOISE_BANDS; i++) {
    if (frames.length === 0) {
      bands.push(-120)
      continue
    }
    const values = frames.map((f) => f[i]).sort((a, b) => a - b)
    const q = values[Math.min(values.length - 1, Math.floor(values.length * 0.2))]
    bands.push(10 * Math.log10(q + 1e-15))
  }
  onProgress?.(1)
  return { bands, sampleRate, source: { start: from / sampleRate, end: to / sampleRate } }
}

export function sanitizeNoiseProfile(raw: unknown, sampleRate: number): NoiseProfile | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (!Array.isArray(obj.bands) || obj.bands.length !== NOISE_BANDS) return null
  const bands = obj.bands.map((v) => {
    const x = Number(v)
    return Number.isFinite(x) ? Math.max(-140, Math.min(0, x)) : -120
  })
  return { bands, sampleRate, source: { start: 0, end: 0 } }
}

/**
 * 谱减法降噪：按噪声指纹做功率谱减，增益在频率与时间上平滑以抑制音乐噪声，
 * 最后 OLA 用窗平方和归一化。输入不会被修改。
 */
export function spectralDenoise(
  channels: Float32Array[],
  sampleRate: number,
  profile: NoiseProfile,
  amountDb: number,
  onProgress?: (p: number) => void
): Float32Array[] {
  const n = channels[0]?.length ?? 0
  const fftSize = 2048
  const hop = 512
  const win = hannWindow(fftSize)
  const norm = fftSize / 2
  const k = Math.pow(10, Math.max(0, Math.min(30, amountDb)) / 10)
  const floor = 0.12
  const noiseMag = profile.bands.map((db) => Math.pow(10, Math.max(-140, Math.min(0, db)) / 20))
  const out = channels.map(() => new Float32Array(n))
  const weight = new Float32Array(n)
  const frames = Math.max(1, Math.ceil((n + fftSize) / hop))
  const prevGains = channels.map(() => new Float32Array(fftSize / 2).fill(1))

  const re = new Float32Array(fftSize)
  const im = new Float32Array(fftSize)
  const gain = new Float32Array(fftSize / 2)

  for (let f = 0; f < frames; f++) {
    const start = f * hop - fftSize / 2
    for (let ch = 0; ch < channels.length; ch++) {
      const src = channels[ch]
      for (let i = 0; i < fftSize; i++) {
        const idx = start + i
        re[i] = idx >= 0 && idx < n ? src[idx] * win[i] : 0
        im[i] = 0
      }
      fftInPlace(re, im)
      // 频率平滑：3 点均值后再与上一帧做释放平滑
      for (let b = 0; b < fftSize / 2; b++) {
        const m = Math.hypot(re[b], im[b]) / norm
        const band = bandForFrequency((b * sampleRate) / fftSize, sampleRate)
        const noise = noiseMag[band]
        const ratio = m > 1e-9 ? 1 - (k * noise * noise) / (m * m) : 0
        gain[b] = Math.max(floor, Math.sqrt(Math.max(0, ratio)))
      }
      for (let b = 0; b < fftSize / 2; b++) {
        const a = gain[Math.max(0, b - 1)]
        const c = gain[Math.min(fftSize / 2 - 1, b + 1)]
        const smoothed = (a + 2 * gain[b] + c) / 4
        const prev = prevGains[ch][b]
        // 回升放慢（0.7 系数），下降立即跟随，减少抽吸感
        const g = smoothed < prev ? smoothed : prev + (smoothed - prev) * 0.7
        prevGains[ch][b] = g
        re[b] *= g
        im[b] *= g
      }
      for (let b = fftSize / 2 + 1; b < fftSize; b++) {
        re[b] = re[fftSize - b]
        im[b] = -im[fftSize - b]
      }
      // 逆 FFT：共轭 + 正向变换 + 除以 N
      for (let i = 0; i < fftSize; i++) im[i] = -im[i]
      fftInPlace(re, im)
      const dst = out[ch]
      for (let i = 0; i < fftSize; i++) {
        const idx = start + i
        if (idx < 0 || idx >= n) continue
        dst[idx] += (re[i] / fftSize) * win[i]
        if (ch === 0) weight[idx] += win[i] * win[i]
      }
    }
    if ((f & 63) === 0) onProgress?.(Math.min(1, f / frames))
  }
  for (const ch of out) {
    for (let i = 0; i < n; i++) ch[i] /= Math.max(1e-6, weight[i])
  }
  onProgress?.(1)
  return out
}

// ---- 去咔嗒 ----

export interface DeclickResult {
  channels: Float32Array[]
  clicks: number
}

/**
 * 用「二阶线性预测误差」定位脉冲：正常波形可被相邻采样线性预测，
 * 咔嗒声是 abrupt 的单点/短促跳变。命中后按相邻干净采样线性插值修复，
 * 所有声道使用同一命中掩码，避免破坏立体声相位关系。
 */
export function declick(
  channels: Float32Array[],
  sampleRate: number,
  sensitivity: number,
  onProgress?: (p: number) => void
): DeclickResult {
  const n = channels[0]?.length ?? 0
  const s = Math.max(0, Math.min(1, sensitivity))
  const factor = 8 - 7 * s
  const absFloor = 0.02 * (1 - s) + 0.0005
  // 连续命中超过 2ms 更像真实瞬态而不是咔嗒，线性插值会造成明显掉音，直接忽略
  const maxRun = Math.max(3, Math.round(sampleRate * 0.002))
  const mask = new Uint8Array(n)
  let hits = 0
  for (let i = 4; i < n - 4; i++) {
    let trigger = false
    for (const ch of channels) {
      const pred = (ch[i - 1] + ch[i + 1]) * 0.5
      const dev = Math.abs(ch[i] - pred)
      // 局部尺度只取 ±2 以外的外侧差分：若脉冲宽 2~3 个采样，
      // 把 i-1 / i+1 算进来会让阈值被脉冲本身抬高而漏检。
      const local =
        (Math.abs(ch[i - 2] - ch[i - 3]) +
          Math.abs(ch[i - 3] - ch[i - 4]) +
          Math.abs(ch[i + 3] - ch[i + 2]) +
          Math.abs(ch[i + 4] - ch[i + 3])) *
        0.25
      if (dev > absFloor && dev > local * factor + absFloor * 0.5) {
        trigger = true
        break
      }
    }
    if (trigger) {
      mask[i] = 1
      hits++
    }
    if ((i & 0x3ffff) === 0) onProgress?.(n === 0 ? 1 : i / n)
  }

  const out = channels.map((c) => c.slice())
  let i = 0
  let clicks = 0
  while (i < n) {
    if (!mask[i]) {
      i++
      continue
    }
    let j = i
    while (j < n && mask[j]) j++
    if (j - i > maxRun) {
      i = j
      continue
    }
    // 把连续命中合并成一次修复事件
    clicks++
    const from = Math.max(0, i - 1)
    const to = Math.min(n - 1, j)
    const span = to - from
    for (const ch of out) {
      const a = ch[from]
      const b = ch[to]
      for (let k = from + 1; k < to; k++) ch[k] = a + ((b - a) * (k - from)) / span
    }
    i = j
  }
  onProgress?.(1)
  return { channels: out, clicks }
}

// ---- 静音检测分段 ----

export interface AudioSegment {
  start: number
  end: number
  kind: 'sound' | 'silence'
  rmsDb: number
}

export interface SilenceOptions {
  thresholdDb: number
  minSilenceMs: number
  minSoundMs: number
  /** 保留在每段有声内容前后的余量，避免把换气/尾音切掉 */
  padMs: number
}

/** 10ms 帧 RMS + 双阈值迟滞分段（播客/口播自动去静音的核心） */
export function detectSegments(
  channels: Float32Array[],
  sampleRate: number,
  options: SilenceOptions
): AudioSegment[] {
  const n = channels[0]?.length ?? 0
  if (n === 0) return []
  const frame = Math.max(1, Math.round(sampleRate * 0.01))
  const frames = Math.max(1, Math.ceil(n / frame))
  const rms = new Float64Array(frames)
  const threshold = Math.pow(10, options.thresholdDb / 20)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    let count = 0
    const from = f * frame
    const to = Math.min(n, from + frame)
    for (const ch of channels) {
      for (let i = from; i < to; i++) {
        sum += ch[i] * ch[i]
        count++
      }
    }
    rms[f] = Math.sqrt(sum / Math.max(1, count))
  }

  const quiet = new Uint8Array(frames)
  for (let f = 0; f < frames; f++) quiet[f] = rms[f] < threshold ? 1 : 0
  const minQuietFrames = Math.max(1, Math.round(options.minSilenceMs / 10))
  const minLoudFrames = Math.max(1, Math.round(options.minSoundMs / 10))

  // 先吞掉夹在静音之间的极短有声段，再吞掉夹在有声之间的极短静音段
  for (let pass = 0; pass < 2; pass++) {
    const target = pass === 0 ? 0 : 1
    const minLen = pass === 0 ? minLoudFrames : minQuietFrames
    let f = 0
    while (f < frames) {
      if (quiet[f] !== target) {
        f++
        continue
      }
      let g = f
      while (g < frames && quiet[g] === target) g++
      if (g - f < minLen && f > 0 && g < frames) {
        for (let k = f; k < g; k++) quiet[k] = 1 - target
      }
      f = g
    }
  }

  interface Run {
    from: number
    to: number
    kind: 0 | 1
  }
  const runs: Run[] = []
  let f = 0
  while (f < frames) {
    let g = f
    while (g < frames && quiet[g] === quiet[f]) g++
    runs.push({ from: f, to: g, kind: quiet[f] as 0 | 1 })
    f = g
  }
  // 首尾的静音段保留，但把 pad 加在静音与有声的交界处
  const padFrames = Math.max(0, Math.round(options.padMs / 10))
  const segments: AudioSegment[] = []
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r]
    let from = run.from
    let to = run.to
    if (run.kind === 1) {
      if (r > 0) from = Math.min(to, from + padFrames)
      if (r < runs.length - 1) to = Math.max(from, to - padFrames)
    }
    let sum = 0
    for (let k = from; k < to; k++) sum += rms[k]
    segments.push({
      start: (from * frame) / sampleRate,
      end: (Math.min(n, to * frame)) / sampleRate,
      kind: run.kind === 1 ? 'silence' : 'sound',
      rmsDb: dbFromAmplitude(to > from ? sum / (to - from) : 0)
    })
  }
  // 合并零长度段并补全末端
  const cleaned = segments.filter((s) => s.end > s.start)
  if (cleaned.length === 0) {
    return [{ start: 0, end: n / sampleRate, kind: quiet[0] ? 'silence' : 'sound', rmsDb: dbFromAmplitude(rms[0]) }]
  }
  cleaned[0].start = 0
  cleaned[cleaned.length - 1].end = n / sampleRate
  return cleaned
}

// ---- 前瞻真峰值限制器 ----

export interface LimiterResult {
  channels: Float32Array[]
  /** 最大增益衰减（dB，正数） */
  maxReductionDb: number
  /** 输出真峰值（dBTP） */
  truePeakDb: number
}

/**
 * 5ms 前瞻峰值限制器：滑动窗口最大值求所需增益，1ms 启动 / 50ms 释放平滑，
 * 最后用 4x 真峰值复测并做一次全局校正，保证输出严格不超过 ceiling。
 */
export function limitTruePeak(
  channels: Float32Array[],
  sampleRate: number,
  ceilingDb: number,
  onProgress?: (p: number) => void
): LimiterResult {
  const n = channels[0]?.length ?? 0
  const ceiling = Math.pow(10, Math.max(-24, Math.min(0, ceilingDb)) / 20)
  const look = Math.max(1, Math.round(sampleRate * 0.005))
  const peak = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let m = 0
    for (const ch of channels) {
      const v = Math.abs(ch[i])
      if (v > m) m = v
    }
    peak[i] = m
  }
  // 单调递减队列求 [i, i+look] 的滑动最大值（O(n)，避免 O(n×look)）
  const windowMax = new Float32Array(n)
  const capacity = look + 2
  const deque = new Int32Array(n)
  let head = 0
  let tail = 0
  let next = 0
  for (let i = 0; i < n; i++) {
    const right = Math.min(n - 1, i + look)
    while (next <= right) {
      while (tail > head && peak[deque[tail - 1]] <= peak[next]) tail--
      deque[tail++] = next
      if (tail - head > capacity) head++ // 理论上不会发生，保险起见
      next++
    }
    while (tail > head && deque[head] < i) head++
    windowMax[i] = tail > head ? peak[deque[head]] : peak[i]
    if ((i & 0x3ffff) === 0) onProgress?.(n === 0 ? 1 : (i / n) * 0.5)
  }

  const attack = Math.exp(-1 / (sampleRate * 0.001))
  const release = Math.exp(-1 / (sampleRate * 0.05))
  let g = 1
  let maxReductionDb = 0
  const out = channels.map(() => new Float32Array(n))
  for (let i = 0; i < n; i++) {
    const desired = Math.min(1, ceiling / Math.max(1e-9, windowMax[i]))
    const coef = desired < g ? attack : release
    g = desired + (g - desired) * coef
    const red = -20 * Math.log10(Math.max(1e-9, g))
    if (red > maxReductionDb) maxReductionDb = red
    for (let c = 0; c < channels.length; c++) out[c][i] = channels[c][i] * g
    if ((i & 0x3ffff) === 0) onProgress?.(0.5 + (n === 0 ? 0.5 : (i / n) * 0.4))
  }

  // 真峰值复测：限制器按采样峰值工作，插值后可能仍有微小超标
  const tp = truePeakAmplitude(out)
  if (tp > ceiling * (1 + 1e-4)) {
    const fix = ceiling / tp
    for (const ch of out) {
      for (let i = 0; i < n; i++) ch[i] *= fix
    }
  }
  onProgress?.(1)
  return {
    channels: out,
    maxReductionDb,
    truePeakDb: dbFromAmplitude(Math.min(tp, ceiling))
  }
}
