/**
 * MP3 编码 Worker：lamejs 分块编码 PCM，进度上报，合并后以 transferable 返回。
 * 使用 @breezystack/lamejs（lamejs 的 ESM 维护版，修复 MPEGMode 未定义问题）。
 */
import { Mp3Encoder } from '@breezystack/lamejs'

const scope = self as unknown as Worker

interface EncodeRequest {
  channels: Float32Array[]
  sampleRate: number
  kbps: number
}

function floatTo16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

scope.onmessage = (e: MessageEvent) => {
  try {
    const { channels, sampleRate, kbps } = e.data as EncodeRequest
    const numCh = Math.min(2, channels.length)
    const len = channels[0].length
    const encoder = new Mp3Encoder(numCh, sampleRate, kbps)
    const left = floatTo16(channels[0])
    const right = numCh === 2 ? floatTo16(channels[1]) : undefined

    const blockSize = 1152
    const parts: Uint8Array[] = []
    let lastProgress = -1

    for (let i = 0; i < len; i += blockSize) {
      const end = Math.min(i + blockSize, len)
      const l = left.subarray(i, end)
      const encoded =
        numCh === 2 ? encoder.encodeBuffer(l, right!.subarray(i, end)) : encoder.encodeBuffer(l)
      if (encoded.length > 0) parts.push(encoded)

      const progress = Math.floor((end / len) * 100)
      if (progress >= lastProgress + 5) {
        lastProgress = progress
        scope.postMessage({ type: 'progress', progress: Math.min(99, progress) })
      }
    }

    const tail = encoder.flush()
    if (tail.length > 0) parts.push(tail)

    let total = 0
    for (const p of parts) total += p.byteLength
    const out = new Uint8Array(total)
    let offset = 0
    for (const p of parts) {
      out.set(p, offset)
      offset += p.byteLength
    }
    scope.postMessage({ type: 'progress', progress: 100 })
    scope.postMessage({ type: 'done', data: out.buffer }, [out.buffer])
  } catch (err) {
    scope.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err)
    })
  }
}
