/**
 * 波形峰值 Worker：只对主线程送来的小块采样做 min/max 扫描。
 * 切片通过 transfer 交给 Worker，计算完把两个桶数组 transfer 回去，无整曲复制。
 */
import { computeBaseBuckets, BASE_SAMPLES_PER_BUCKET } from '../audio/peak-compute'

const scope = self as unknown as Worker

interface ChunkRequest {
  channels: Float32Array[]
  frameOffset: number
  startBucket: number
  bucketCount: number
  samplesPerBucket: number
}

scope.onmessage = (e: MessageEvent) => {
  try {
    const { channels, frameOffset, startBucket, bucketCount, samplesPerBucket } =
      e.data as ChunkRequest
    const { min, max } = computeBaseBuckets(
      channels,
      frameOffset,
      startBucket,
      bucketCount,
      samplesPerBucket || BASE_SAMPLES_PER_BUCKET
    )
    scope.postMessage({ type: 'chunk', startBucket, min, max }, [min.buffer, max.buffer])
  } catch (err) {
    scope.postMessage({
      type: 'error',
      startBucket: 0,
      message: err instanceof Error ? err.message : '峰值计算失败'
    })
  }
}
