/**
 * 响度与峰值分析（ITU-R BS.1770-4 / EBU R128）。
 *
 * 全部为纯函数，主线程、Worker 与 Node 断言共用：
 *  - K 加权：高架预滤波 + RLB 高通，两级级联双二阶；
 *  - LUFS：400ms 块 / 100ms 跳距，两级门限（绝对 -70 LUFS、相对 -10 LU）得到 Integrated；
 *    Momentary = 400ms，Short-term = 3s；LRA 取短时响度的 10% / 95% 分位差；
 *  - True Peak：4 倍过采样的 Blackman 窗 sinc 插值（dBTP），并用「∑|h| × 局部峰值」
 *    作为严格上界剪枝，避免长音频做暴力卷积；
 *  - 削波：统计 |x| >= 1 的采样数与连续片段（事件）数。
 *
 * 系数按 ITU 给出的模拟原型用双线性变换在任意采样率下求解；48kHz 结果与官方表一致
 * （最大偏差 < 3e-5），因此不需要为 48k 单独硬编码。
 */

export interface BiquadCoeffs {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

export interface BiquadState {
  x1: number
  x2: number
  y1: number
  y2: number
}

export function createBiquadState(): BiquadState {
  return { x1: 0, x2: 0, y1: 0, y2: 0 }
}

/** 单采样 Transposed-Direct-Form-II；系数已按 a0 归一化 */
export function biquadSample(c: BiquadCoeffs, s: BiquadState, x: number): number {
  const y = c.b0 * x + c.b1 * s.x1 + c.b2 * s.x2 - c.a1 * s.y1 - c.a2 * s.y2
  s.x2 = s.x1
  s.x1 = x
  s.y2 = s.y1
  s.y1 = y
  return y
}

export interface KWeighting {
  shelf: BiquadCoeffs
  highpass: BiquadCoeffs
}

/** BS.1770-4 两级 K 加权系数 */
export function kWeightingCoeffs(sampleRate: number): KWeighting {
  const fs = Math.max(8000, sampleRate)
  // Stage 1：+4dB 高架，f0 = 1681.974450955533 Hz，Q = 1/√2
  const f0 = 1681.974450955533
  const K = Math.tan((Math.PI * f0) / fs)
  const Q = Math.SQRT1_2
  const Vh = Math.pow(10, 4 / 20)
  const Vb = Math.pow(Vh, 0.4996667741545416)
  const d0 = 1 + K / Q + K * K
  const shelf: BiquadCoeffs = {
    b0: (Vh + (Vb * K) / Q + K * K) / d0,
    b1: (2 * (K * K - Vh)) / d0,
    b2: (Vh - (Vb * K) / Q + K * K) / d0,
    a1: (2 * (K * K - 1)) / d0,
    a2: (1 - K / Q + K * K) / d0
  }
  // Stage 2：RLB 高通，f0 = 38.13547087602444 Hz，Q = 0.5003270373238773
  const f1 = 38.13547087602444
  const Q1 = 0.5003270373238773
  const K1 = Math.tan((Math.PI * f1) / fs)
  const d1 = 1 + K1 / Q1 + K1 * K1
  const norm = 1 / d1
  const highpass: BiquadCoeffs = {
    b0: norm,
    b1: -2 * norm,
    b2: norm,
    a1: (2 * (K1 * K1 - 1)) / d1,
    a2: (1 - K1 / Q1 + K1 * K1) / d1
  }
  // 官方表把 b 归一化到 b0 = 1；这里等价地放大 -1/dB 级，保证高通增益正确
  highpass.b0 = 1
  highpass.b1 = -2
  highpass.b2 = 1
  return { shelf, highpass }
}

/** EBU R128 声道权重（最多 2 声道时均为 1.0；5.1 时才需要环绕 1.41 / 低音 0） */
export function channelWeight(index: number, count: number): number {
  if (count <= 2) return 1
  if (index === 2) return 1 // C
  if (index === 3) return 0 // LFE 不参与
  return 1.41
}

export const LUFS_OFFSET = -0.691
export const ABS_GATE_LUFS = -70
export const REL_GATE_LU = 10
export const LRA_REL_GATE_LU = 20

export function powerToLufs(power: number): number {
  return power <= 0 ? -Infinity : LUFS_OFFSET + 10 * Math.log10(power)
}

export function lufsToPower(lufs: number): number {
  return Math.pow(10, (lufs - LUFS_OFFSET) / 10)
}

/** 两级门限积分；输入为 400ms 块的加权均方能量 */
export function integratedLoudness(blockPowers: number[]): number {
  const absThreshold = lufsToPower(ABS_GATE_LUFS)
  const gated = blockPowers.filter((p) => p > absThreshold)
  if (gated.length === 0) return -Infinity
  let sum = 0
  for (const p of gated) sum += p
  const mean = sum / gated.length
  const relThreshold = mean * Math.pow(10, -REL_GATE_LU / 10)
  let kept = 0
  let keptSum = 0
  for (const p of gated) {
    if (p < relThreshold) continue
    keptSum += p
    kept++
  }
  return kept === 0 ? -Infinity : powerToLufs(keptSum / kept)
}

/** LRA：短时（3s）响度序列的 95% 与 10% 分位差，门限为绝对 -70 / 相对 -20 LU */
export function loudnessRange(shortTermPowers: number[]): number {
  const absThreshold = lufsToPower(ABS_GATE_LUFS)
  const gated = shortTermPowers.filter((p) => p > absThreshold)
  if (gated.length < 2) return 0
  let sum = 0
  for (const p of gated) sum += p
  const rel = (sum / gated.length) * Math.pow(10, -LRA_REL_GATE_LU / 10)
  const kept = gated.filter((p) => p >= rel).sort((a, b) => a - b)
  if (kept.length < 2) return 0
  const pick = (q: number) => {
    const pos = (kept.length - 1) * q
    const lo = Math.floor(pos)
    const hi = Math.min(kept.length - 1, lo + 1)
    return kept[lo] + (kept[hi] - kept[lo]) * (pos - lo)
  }
  return Math.max(0, powerToLufs(pick(0.95)) - powerToLufs(pick(0.1)))
}

// ---- 4x 真峰值插值 ----

const OVERSAMPLE = 4
const FIR_HALF = 4 // 每相位 9 个原采样
const FIR_M = OVERSAMPLE * FIR_HALF + 1

interface InterpKernel {
  h: Float32Array // 索引 = phase + OVERSAMPLE * (k + FIR_HALF)
  sumAbs: Float32Array
}

function sinc(x: number): number {
  return x === 0 ? 1 : Math.sin((Math.PI * x) / OVERSAMPLE) / ((Math.PI * x) / OVERSAMPLE)
}

function buildKernel(): InterpKernel {
  const h = new Float32Array(OVERSAMPLE * (2 * FIR_HALF + 1))
  const sumAbs = new Float32Array(OVERSAMPLE)
  for (let p = 0; p < OVERSAMPLE; p++) {
    let sum = 0
    for (let k = -FIR_HALF; k <= FIR_HALF; k++) {
      const m = OVERSAMPLE * k + p
      // Blackman 窗，M = OVERSAMPLE * FIR_HALF + 1
      const w = 0.42 + 0.5 * Math.cos((Math.PI * m) / FIR_M) + 0.08 * Math.cos((2 * Math.PI * m) / FIR_M)
      const v = sinc(m) * w
      h[p + OVERSAMPLE * (k + FIR_HALF)] = v
      sum += Math.abs(v)
    }
    sumAbs[p] = sum
  }
  return { h, sumAbs }
}

const KERNEL = buildKernel()
const PRUNE_BOUND = Math.max(...Array.from(KERNEL.sumAbs))

/** 供实时电平表的 AudioWorklet 复用同一组 4x 插值系数 */
export function interpolationKernel(): { h: number[]; oversample: number; half: number } {
  return { h: Array.from(KERNEL.h), oversample: OVERSAMPLE, half: FIR_HALF }
}

/**
 * 4x 过采样真峰值。只考察 |x| 的局部极大点，并用
 * |插值结果| <= ∑|h| × 窗口内最大幅度 这一严格上界剪枝。
 */
export function truePeakAmplitude(channels: Float32Array[]): number {
  let tp = 0
  const { h } = KERNEL
  for (const ch of channels) {
    const n = ch.length
    for (let i = 0; i < n; i++) {
      const v = Math.abs(ch[i])
      if (v > tp) tp = v
      if (i === 0 || i === n - 1) continue
      const a = Math.abs(ch[i - 1])
      const b = Math.abs(ch[i + 1])
      if (v < a || v <= b) continue // 仅局部峰值
      // 窗口内最大幅度
      let localMax = v
      const lo = Math.max(0, i - FIR_HALF)
      const hi = Math.min(n - 1, i + FIR_HALF)
      for (let j = lo; j <= hi; j++) {
        const av = Math.abs(ch[j])
        if (av > localMax) localMax = av
      }
      if (localMax * PRUNE_BOUND <= tp) continue
      for (let p = 1; p < OVERSAMPLE; p++) {
        let y = 0
        for (let k = -FIR_HALF; k <= FIR_HALF; k++) {
          const idx = i - k
          if (idx < 0 || idx >= n) continue
          y += ch[idx] * h[p + OVERSAMPLE * (k + FIR_HALF)]
        }
        const ay = Math.abs(y)
        if (ay > tp) tp = ay
      }
    }
  }
  return tp
}

export function dbFromAmplitude(a: number): number {
  return a <= 0 ? -Infinity : 20 * Math.log10(a)
}

export interface ClipInfo {
  /** 判定为削波的采样总数（所有声道求和） */
  samples: number
  /** 连续削波片段数 */
  events: number
}

/**
 * 削波检测。直接判断 |x| >= 1 会把「满幅正弦恰好落在 sin(π/2)=1」的孤立采样
 * 误判为削波（5s 1kHz 正弦可产生上万个）。这里改为识别真正的削波特征：
 *  - 任一采样严格越界（|x| > threshold）；或
 *  - 连续 ≥2 帧停留在满幅（硬限幅造成的平台）。
 * 单个孤立满幅采样只算正常峰值，不计入。
 */
export function countClipping(channels: Float32Array[], threshold = 1): ClipInfo {
  const n = channels[0]?.length ?? 0
  const eps = 1e-7
  let samples = 0
  let events = 0
  let runFrames = 0
  let runHadOver = false
  let runSamples = 0

  const finishRun = () => {
    if (runFrames === 0) return
    if (runHadOver || runFrames >= 2) {
      samples += runSamples
      events++
    }
    runFrames = 0
    runHadOver = false
    runSamples = 0
  }

  for (let i = 0; i < n; i++) {
    let frameFull = false
    let frameSamples = 0
    for (const ch of channels) {
      const a = Math.abs(ch[i])
      if (a > threshold + eps) {
        runHadOver = true
        frameFull = true
        frameSamples++
      } else if (a >= threshold - eps) {
        frameFull = true
        frameSamples++
      }
    }
    if (frameFull) {
      runFrames++
      runSamples += frameSamples
    } else {
      finishRun()
    }
  }
  finishRun()
  return { samples, events }
}

export interface LoudnessStats {
  /** 整段积分响度（LUFS） */
  integratedLufs: number
  /** 短时最大值（3s，LUFS） */
  shortTermMaxLufs: number
  /** 瞬时最大值（400ms，LUFS） */
  momentaryMaxLufs: number
  /** 响度范围（LU） */
  lra: number
  rmsDb: number
  peakDb: number
  /** 4x 过采样真峰值（dBTP） */
  truePeakDb: number
  /** 真峰值与采样峰值之差，用于提示「采样峰值正常但编码后会削波」 */
  peakToTruePeakDb: number
  clippedSamples: number
  clipEvents: number
  duration: number
  /** 100ms 跳距的瞬时响度曲线（LUFS），供绘制历史图 */
  history: number[]
  /** 每个 100ms 块的时长（秒） */
  historyHop: number
}

export interface AnalyzeOptions {
  onProgress?: (p: number) => void
  signal?: AbortSignal
  /** 历史曲线最多保留多少点；超出后取窗口最大值抽样 */
  maxHistoryPoints?: number
}

function assertLive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('分析已取消', 'AbortError')
}

/** 对整段音频做一次完整测量。O(n × 声道数)，不分配与输入等长的中间缓冲。 */
export function analyzeLoudness(
  channels: Float32Array[],
  sampleRate: number,
  options: AnalyzeOptions = {}
): LoudnessStats {
  const n = channels[0]?.length ?? 0
  const hop = Math.max(1, Math.round(sampleRate * 0.1)) // 100ms
  const block = Math.max(hop, Math.round(sampleRate * 0.4)) // 400ms
  const k = kWeightingCoeffs(sampleRate)
  const states = channels.map(() => ({
    s1: createBiquadState(),
    s2: createBiquadState()
  }))
  const ring = new Float64Array(block)
  let ringPos = 0
  let ringFilled = 0
  let ringSum = 0
  let sinceHop = 0

  let sumSquares = 0
  let peak = 0
  const momentary: number[] = []
  let momentaryMax = -Infinity

  for (let i = 0; i < n; i++) {
    let z = 0
    for (let c = 0; c < channels.length; c++) {
      const x = channels[c][i]
      const ax = Math.abs(x)
      if (ax > peak) peak = ax
      sumSquares += x * x
      const y1 = biquadSample(k.shelf, states[c].s1, x)
      const y2 = biquadSample(k.highpass, states[c].s2, y1)
      z += channelWeight(c, channels.length) * y2 * y2
    }
    ringSum -= ring[ringPos]
    ring[ringPos] = z
    ringSum += z
    ringPos = (ringPos + 1) % block
    if (ringFilled < block) ringFilled++
    sinceHop++
    if (sinceHop >= hop) {
      sinceHop = 0
      if (ringFilled === block) {
        const p = ringSum / block
        momentary.push(p)
        const l = powerToLufs(p)
        if (l > momentaryMax) momentaryMax = l
      }
    }
    if ((i & 0x3ffff) === 0) {
      assertLive(options.signal)
      options.onProgress?.(n === 0 ? 1 : (i / n) * 0.7)
    }
  }
  assertLive(options.signal)
  options.onProgress?.(0.75)

  // 短时 3s：用 30 个 400ms 块（100ms 跳距）的均值近似，1s 步进
  const shortBlocks = Math.round(3 / 0.1)
  const shortHop = Math.round(1 / 0.1)
  const shortTermPowers: number[] = []
  let shortTermMax = -Infinity
  for (let start = 0; start + shortBlocks <= momentary.length; start += shortHop) {
    let sum = 0
    for (let j = start; j < start + shortBlocks; j++) sum += momentary[j]
    const p = sum / shortBlocks
    shortTermPowers.push(p)
    const l = powerToLufs(p)
    if (l > shortTermMax) shortTermMax = l
  }
  if (shortTermPowers.length === 0 && momentary.length > 0) {
    let sum = 0
    for (const p of momentary) sum += p
    const p = sum / momentary.length
    shortTermPowers.push(p)
    shortTermMax = powerToLufs(p)
  }

  const integrated = integratedLoudness(momentary)
  const lra = loudnessRange(shortTermPowers)
  const rms = Math.sqrt(sumSquares / Math.max(1, n * channels.length))
  const tp = truePeakAmplitude(channels)
  options.onProgress?.(0.95)
  const clip = countClipping(channels)
  options.onProgress?.(1)

  // 抽稀历史曲线，避免长音频在 UI 里生成几十万个点
  const maxPoints = Math.max(64, options.maxHistoryPoints ?? 1200)
  const stride = Math.max(1, Math.ceil(momentary.length / maxPoints))
  const history: number[] = []
  for (let i = 0; i < momentary.length; i += stride) {
    let max = -Infinity
    for (let j = i; j < Math.min(momentary.length, i + stride); j++) {
      const l = powerToLufs(momentary[j])
      if (l > max) max = l
    }
    history.push(max)
  }

  return {
    integratedLufs: integrated,
    shortTermMaxLufs: shortTermMax,
    momentaryMaxLufs: momentaryMax,
    lra,
    rmsDb: dbFromAmplitude(rms),
    peakDb: dbFromAmplitude(peak),
    truePeakDb: dbFromAmplitude(tp),
    peakToTruePeakDb: dbFromAmplitude(tp) - dbFromAmplitude(peak),
    clippedSamples: clip.samples,
    clipEvents: clip.events,
    duration: sampleRate > 0 ? n / sampleRate : 0,
    history,
    historyHop: (hop / Math.max(1, sampleRate)) * stride
  }
}

export interface NormalizeGain {
  gainDb: number
  /** 为遵守真峰值上限而被迫削减，导致无法达到目标响度 */
  limitedByCeiling: boolean
  /** 归一化后的预计真峰值（dBTP） */
  resultTruePeakDb: number
  /** 归一化后的预计积分响度（LUFS） */
  resultLufs: number
}

/**
 * 由测量结果计算 LUFS 归一化增益。若加增益后真峰值会超过 ceiling，
 * 默认压回上限（limitedByCeiling=true）；allowLimiter=true 时保持目标增益，
 * 由调用方再跑前瞻限制器压住真峰值。
 */
export function normalizeGain(
  stats: Pick<LoudnessStats, 'integratedLufs' | 'truePeakDb'>,
  targetLufs: number,
  ceilingDbTp: number,
  allowLimiter = false
): NormalizeGain {
  if (!Number.isFinite(stats.integratedLufs)) {
    return { gainDb: 0, limitedByCeiling: false, resultTruePeakDb: -Infinity, resultLufs: -Infinity }
  }
  let gainDb = targetLufs - stats.integratedLufs
  const unlimitedTp = (Number.isFinite(stats.truePeakDb) ? stats.truePeakDb : -Infinity) + gainDb
  const limitedByCeiling = !allowLimiter && unlimitedTp > ceilingDbTp
  if (limitedByCeiling) gainDb -= unlimitedTp - ceilingDbTp
  return {
    gainDb,
    limitedByCeiling,
    resultTruePeakDb: unlimitedTp - (allowLimiter ? 0 : Math.max(0, unlimitedTp - ceilingDbTp)),
    resultLufs: stats.integratedLufs + gainDb
  }
}

/** 常用流媒体响度目标 */
export const LOUDNESS_TARGETS = [
  { label: 'EBU R128 广播', value: -23 },
  { label: '播客 / Apple', value: -16 },
  { label: 'Spotify / YouTube', value: -14 },
  { label: '流媒体响（不推荐）', value: -12 },
  { label: '自定义', value: 0 }
] as const
