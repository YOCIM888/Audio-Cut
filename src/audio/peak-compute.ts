/** 峰值桶的纯计算逻辑：主线程与 Worker 共用，避免两份实现漂移 */

export const BASE_SAMPLES_PER_BUCKET = 64

/**
 * 计算一段采样覆盖的 base 桶（纯函数）。
 * channels[0][0] 对应全局帧 frameOffset；startBucket 是全局桶索引。
 */
export function computeBaseBuckets(
  channels: Float32Array[],
  frameOffset: number,
  startBucket: number,
  bucketCount: number,
  samplesPerBucket = BASE_SAMPLES_PER_BUCKET
): { min: Float32Array; max: Float32Array } {
  const min = new Float32Array(bucketCount)
  const max = new Float32Array(bucketCount)
  const avail = channels[0]?.length ?? 0
  for (let b = 0; b < bucketCount; b++) {
    const g0 = (startBucket + b) * samplesPerBucket
    const l0 = Math.max(0, g0 - frameOffset)
    const l1 = Math.min(avail, g0 + samplesPerBucket - frameOffset)
    let mn = Infinity
    let mx = -Infinity
    if (l1 > l0) {
      for (const ch of channels) {
        for (let i = l0; i < l1; i++) {
          const v = ch[i]
          if (v < mn) mn = v
          if (v > mx) mx = v
        }
      }
    }
    min[b] = Number.isFinite(mn) ? mn : 0
    max[b] = Number.isFinite(mx) ? mx : 0
  }
  return { min, max }
}
