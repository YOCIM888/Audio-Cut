/**
 * PeakCache —— 波形峰值金字塔缓存（大文件性能优化核心）。
 * 底层每 64 采样一个 min/max 桶，逐层 ×16 抽稀。
 * 普通类实例，绝不进入 Vue 深层响应式。
 *
 * 构建策略（导入长音频不再卡死主线程）：
 *  - 小文件（< 200 万采样）：同步构建，避免 Worker 启动开销；
 *  - 大文件：startPeakBuild() 在 Worker 里分块计算 base 桶，逐块回传并增量
 *    维护高层金字塔，主线程只做 O(桶数) 的聚合，波形随构建进度渐进显示；
 *  - 等长编辑：refreshRegion() 只重算受影响区间的桶，不重建整条金字塔。
 */
import { clamp } from '../utils/audio-utils'
import { BASE_SAMPLES_PER_BUCKET, computeBaseBuckets } from './peak-compute'

export { BASE_SAMPLES_PER_BUCKET, computeBaseBuckets }

export interface PeakLevel {
  min: Float32Array
  max: Float32Array
  samplesPerBucket: number
}

const LEVEL_FACTOR = 16
/** 低于此采样量时同步构建更快（约 20ms 以内） */
const SYNC_SAMPLE_LIMIT = 2_000_000
/** 每个 Worker 任务处理的帧数：立体声约 8MB，计算耗时约 10ms */
const CHUNK_FRAMES = 1 << 20

type ChannelSource = Pick<AudioBuffer, 'length' | 'numberOfChannels' | 'getChannelData'>

function channelsOf(buffer: ChannelSource): Float32Array[] {
  const out: Float32Array[] = []
  for (let c = 0; c < buffer.numberOfChannels; c++) out.push(buffer.getChannelData(c))
  return out
}

export class PeakCache {
  readonly levels: PeakLevel[] = []
  readonly length: number
  private filled = 0
  private readonly totalBuckets: number

  private constructor(length: number) {
    this.length = length
    this.totalBuckets = Math.max(1, Math.ceil(length / BASE_SAMPLES_PER_BUCKET))
    let n = this.totalBuckets
    let spb = BASE_SAMPLES_PER_BUCKET
    for (;;) {
      this.levels.push({
        min: new Float32Array(n),
        max: new Float32Array(n),
        samplesPerBucket: spb
      })
      const next = Math.ceil(n / LEVEL_FACTOR)
      if (n <= 1 || next >= n) break
      n = next
      spb *= LEVEL_FACTOR
    }
  }

  /** 同步完整构建（小文件、Worker 不可用时的降级路径） */
  static fromBuffer(buffer: ChannelSource): PeakCache {
    const cache = new PeakCache(buffer.length)
    cache.fillBase(channelsOf(buffer), 0, buffer.length)
    cache.finalize()
    return cache
  }

  /** 预分配空金字塔，供 Worker 增量填充 */
  static allocate(length: number): PeakCache {
    return new PeakCache(length)
  }

  get baseSamplesPerBucket(): number {
    return this.levels[0].samplesPerBucket
  }

  get progress(): number {
    return this.totalBuckets === 0 ? 1 : clamp(this.filled / this.totalBuckets, 0, 1)
  }

  get complete(): boolean {
    return this.filled >= this.totalBuckets
  }

  /** 主线程直接填充一段 base 桶（用于同步构建与等长编辑的局部刷新） */
  fillBase(channels: Float32Array[], fromFrame: number, toFrame: number): void {
    const b0 = Math.max(0, Math.floor(fromFrame / BASE_SAMPLES_PER_BUCKET))
    const b1 = Math.min(
      this.totalBuckets,
      Math.ceil(Math.min(toFrame, this.length) / BASE_SAMPLES_PER_BUCKET)
    )
    if (b1 <= b0) return
    const { min, max } = computeBaseBuckets(channels, 0, b0, b1 - b0)
    this.writeBuckets(b0, min, max, true)
  }

  /** Worker 每完成一块后调用；只写入区间并增量更新高层 */
  appendBase(startBucket: number, min: Float32Array, max: Float32Array): void {
    if (min.length === 0) return
    this.writeBuckets(startBucket, min, max, true)
  }

  /**
   * 等长编辑后局部重算 [fromFrame, toFrame)（不重建整条金字塔）。
   * 返回 false 表示缓存尚未构建完，调用方应改为完整重建。
   */
  refreshRegion(buffer: ChannelSource, fromFrame: number, toFrame: number): boolean {
    if (!this.complete || buffer.length !== this.length) return false
    const b0 = Math.max(0, Math.floor(fromFrame / BASE_SAMPLES_PER_BUCKET))
    const b1 = Math.min(this.totalBuckets, Math.ceil(toFrame / BASE_SAMPLES_PER_BUCKET))
    if (b1 <= b0) return true
    const { min, max } = computeBaseBuckets(channelsOf(buffer), 0, b0, b1 - b0)
    this.writeBuckets(b0, min, max, false)
    return true
  }

  /** 构建结束：补齐可能的尾桶并做一次全量聚合，消除跨块边界父桶的偏差 */
  finalize(): void {
    this.filled = this.totalBuckets
    this.refreshAncestors(0, this.totalBuckets)
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

  private writeBuckets(b0: number, min: Float32Array, max: Float32Array, advance: boolean): void {
    const end = Math.min(this.totalBuckets, b0 + min.length)
    if (end <= b0) return
    const base = this.levels[0]
    if (advance && b0 < this.filled) {
      // 分块边界可能切在同一个 64 采样桶里，此时两次扫描要取并集而不是互相覆盖
      const overlap = Math.max(0, Math.min(end, this.filled) - b0)
      for (let i = 0; i < overlap; i++) {
        const k = b0 + i
        base.min[k] = Math.min(base.min[k], min[i])
        base.max[k] = Math.max(base.max[k], max[i])
      }
      if (end > b0 + overlap) {
        base.min.set(min.subarray(overlap, end - b0), b0 + overlap)
        base.max.set(max.subarray(overlap, end - b0), b0 + overlap)
      }
    } else {
      base.min.set(min.subarray(0, end - b0), b0)
      base.max.set(max.subarray(0, end - b0), b0)
    }
    if (advance) this.filled = Math.max(this.filled, end)
    this.refreshAncestors(b0, end)
  }

  /**
   * 只重算受影响的祖先桶。未填充的子桶不参与聚合（值为 0 的静音线），
   * 因此增量构建期间的波形不会出现「被 0 拉平」的假峰。
   */
  private refreshAncestors(fromBucket: number, toBucket: number): void {
    let lo = fromBucket
    let hi = toBucket
    let childCovered = this.filled
    for (let lv = 1; lv < this.levels.length; lv++) {
      const child = this.levels[lv - 1]
      const parent = this.levels[lv]
      const p0 = Math.max(0, Math.floor(lo / LEVEL_FACTOR))
      const p1 = Math.min(parent.min.length, Math.floor((hi - 1) / LEVEL_FACTOR) + 1)
      for (let b = p0; b < p1; b++) {
        const c0 = b * LEVEL_FACTOR
        const c1 = Math.min(c0 + LEVEL_FACTOR, child.min.length, childCovered)
        let mn = Infinity
        let mx = -Infinity
        for (let k = c0; k < c1; k++) {
          if (child.min[k] < mn) mn = child.min[k]
          if (child.max[k] > mx) mx = child.max[k]
        }
        parent.min[b] = Number.isFinite(mn) ? mn : 0
        parent.max[b] = Number.isFinite(mx) ? mx : 0
      }
      childCovered = Math.ceil(childCovered / LEVEL_FACTOR)
      lo = p0
      hi = Math.max(p0, p1)
      if (hi <= lo) break
    }
  }
}

export interface PeakBuildHooks {
  /** 每填充一块后触发，供 UI 重绘 */
  onChunk?: () => void
  /** 0~1 构建进度 */
  onProgress?: (p: number) => void
}

export interface PeakBuild {
  /** 立即可用于绘制的增量缓存（同一实例会随构建更新） */
  cache: PeakCache
  /** 完成后的最终缓存；降级同步构建时可能与 cache 不同 */
  done: Promise<PeakCache>
  cancel(): void
}

interface ChunkResponse {
  type: 'chunk' | 'error'
  startBucket: number
  min?: Float32Array
  max?: Float32Array
  message?: string
}

/**
 * 异步分块构建峰值缓存。Worker 只搬运 8MB 级的采样切片并计算 min/max，
 * 主线程不再对全曲做上亿次 JS 循环；每块之间让出事件循环，界面保持响应。
 */
export function startPeakBuild(buffer: ChannelSource, hooks: PeakBuildHooks = {}): PeakBuild {
  const samples = buffer.length * buffer.numberOfChannels
  const hasWorker = typeof Worker !== 'undefined' && typeof window !== 'undefined'
  if (!hasWorker || samples <= SYNC_SAMPLE_LIMIT) {
    const cache = PeakCache.fromBuffer(buffer)
    hooks.onProgress?.(1)
    return { cache, done: Promise.resolve(cache), cancel: () => undefined }
  }

  const cache = PeakCache.allocate(buffer.length)
  let cancelled = false
  let worker: Worker | null = null
  let resolveDone!: (c: PeakCache) => void
  let releaseCancelled!: () => void
  // terminate() 后正在等待的 Worker 响应永远不会到达，用这条 Promise 把循环唤醒，
  // 否则闭包会一直持有整条音轨的采样引用，无法被 GC 回收。
  const cancelledSignal = new Promise<void>((resolve) => {
    releaseCancelled = resolve
  })
  const done = new Promise<PeakCache>((resolve) => {
    resolveDone = resolve
  })

  const settle = (final: PeakCache) => {
    hooks.onProgress?.(final.progress)
    resolveDone(final)
  }

  const run = async (): Promise<void> => {
    try {
      worker = new Worker(new URL('../workers/peaks.worker.ts', import.meta.url), {
        type: 'module'
      })
      const channels = channelsOf(buffer)
      for (let start = 0; start < buffer.length; start += CHUNK_FRAMES) {
        if (cancelled) break
        const end = Math.min(buffer.length, start + CHUNK_FRAMES)
        const slices = channels.map((c) => c.slice(start, end))
        const startBucket = Math.floor(start / BASE_SAMPLES_PER_BUCKET)
        const bucketCount = Math.ceil(end / BASE_SAMPLES_PER_BUCKET) - startBucket
        const chunk = new Promise<ChunkResponse | null>((resolve, reject) => {
          const w = worker!
          const cleanup = () => {
            w.removeEventListener('message', onMessage)
            w.removeEventListener('error', onError)
          }
          const onMessage = (e: MessageEvent<ChunkResponse>) => {
            cleanup()
            if (e.data.type === 'error') reject(new Error(e.data.message || '峰值构建失败'))
            else resolve(e.data)
          }
          const onError = (e: ErrorEvent) => {
            cleanup()
            reject(new Error(e.message || '峰值 Worker 运行错误'))
          }
          w.addEventListener('message', onMessage)
          w.addEventListener('error', onError)
          w.postMessage(
            {
              channels: slices,
              frameOffset: start,
              startBucket,
              bucketCount,
              samplesPerBucket: BASE_SAMPLES_PER_BUCKET
            },
            slices.map((s) => s.buffer)
          )
        })
        const res = await Promise.race([chunk, cancelledSignal.then(() => null)])
        if (cancelled || !res || !res.min || !res.max) break
        cache.appendBase(res.startBucket, res.min, res.max)
        hooks.onChunk?.()
        hooks.onProgress?.(cache.progress)
        // 让出一次事件循环，避免连续微任务饿死输入与绘制
        await new Promise<void>((r) => window.setTimeout(r, 0))
      }
      if (!cancelled) {
        cache.finalize()
        hooks.onChunk?.()
        settle(cache)
      } else {
        settle(cache)
      }
    } catch (err) {
      if (cancelled) {
        settle(cache)
        return
      }
      console.warn('[peaks] Worker 构建失败，回退同步构建', err)
      settle(PeakCache.fromBuffer(buffer))
    } finally {
      worker?.terminate()
      worker = null
    }
  }
  void run()

  return {
    cache,
    done,
    cancel() {
      if (cancelled) return
      cancelled = true
      worker?.terminate()
      worker = null
      releaseCancelled()
      settle(cache)
    }
  }
}
