/**
 * PeakCache —— 波形峰值金字塔缓存（大文件性能优化核心）。
 * 底层每 64 采样一个 min/max 桶，逐层 ×16 抽稀。
 * 普通类实例，绝不进入 Vue 深层响应式。
 */

export interface PeakLevel {
  min: Float32Array
  max: Float32Array
  samplesPerBucket: number
}

const BASE_SAMPLES_PER_BUCKET = 64
const LEVEL_FACTOR = 16

export class PeakCache {
  readonly levels: PeakLevel[] = []
  readonly length: number

  constructor(buffer: AudioBuffer) {
    this.length = buffer.length
    const channels: Float32Array[] = []
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c))

    // 底层
    const spb = BASE_SAMPLES_PER_BUCKET
    const nBuckets = Math.max(1, Math.ceil(buffer.length / spb))
    const min = new Float32Array(nBuckets)
    const max = new Float32Array(nBuckets)
    for (let b = 0; b < nBuckets; b++) {
      const s0 = b * spb
      const s1 = Math.min(buffer.length, s0 + spb)
      let mn = Infinity
      let mx = -Infinity
      for (const ch of channels) {
        for (let i = s0; i < s1; i++) {
          const v = ch[i]
          if (v < mn) mn = v
          if (v > mx) mx = v
        }
      }
      min[b] = Number.isFinite(mn) ? mn : 0
      max[b] = Number.isFinite(mx) ? mx : 0
    }
    this.levels.push({ min, max, samplesPerBucket: spb })

    // 高层：每 16 桶聚合为 1 桶
    for (;;) {
      const prev = this.levels[this.levels.length - 1]
      if (prev.min.length <= 1) break
      const n = Math.ceil(prev.min.length / LEVEL_FACTOR)
      if (n >= prev.min.length) break
      const nMin = new Float32Array(n)
      const nMax = new Float32Array(n)
      for (let b = 0; b < n; b++) {
        let mn = Infinity
        let mx = -Infinity
        const kEnd = Math.min(prev.min.length, (b + 1) * LEVEL_FACTOR)
        for (let k = b * LEVEL_FACTOR; k < kEnd; k++) {
          if (prev.min[k] < mn) mn = prev.min[k]
          if (prev.max[k] > mx) mx = prev.max[k]
        }
        nMin[b] = mn
        nMax[b] = mx
      }
      this.levels.push({ min: nMin, max: nMax, samplesPerBucket: prev.samplesPerBucket * LEVEL_FACTOR })
    }
  }

  get baseSamplesPerBucket(): number {
    return this.levels[0].samplesPerBucket
  }

  /** 选择不粗于 samplesPerPixel 的最粗层级（聚合开销最小） */
  pick(samplesPerPixel: number): PeakLevel {
    let best = this.levels[0]
    for (const lv of this.levels) {
      if (lv.samplesPerBucket <= samplesPerPixel) best = lv
      else break
    }
    return best
  }
}
