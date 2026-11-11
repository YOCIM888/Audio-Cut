/**
 * 工程包专用的 32-bit IEEE float WAV 编解码。
 *
 * 与 wav-encoder.ts 的区别：
 *  - 分块交错写入，返回 Blob 而不是一次性 new ArrayBuffer(44 + dataSize)，
 *    长音频不会额外申请一块与成品等大的连续内存。
 *  - 编码过程分批让出事件循环，界面不假死，还能报告进度。
 *  - 解码自己解析 RIFF，不依赖 decodeAudioData（浏览器对 float WAV 的支持并不一致）。
 * float32 与编辑器内部 Float32Array 逐位等价，因此工程往返零音质损失。
 */

export interface DecodedWav {
  channels: Float32Array[]
  sampleRate: number
}

const ENCODE_FRAMES_PER_CHUNK = 16384
const DECODE_FRAMES_PER_CHUNK = 32768
/** 每处理这么多块让出一次事件循环 */
const YIELD_EVERY = 16

function yieldToUI(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function writeHeader(sampleRate: number, numChannels: number, dataSize: number): Uint8Array {
  const head = new Uint8Array(44)
  const v = new DataView(head.buffer)
  const put = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i))
  }
  const blockAlign = numChannels * 4
  put(0, 'RIFF')
  v.setUint32(4, 36 + dataSize, true)
  put(8, 'WAVE')
  put(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 3, true) // WAVE_FORMAT_IEEE_FLOAT
  v.setUint16(22, numChannels, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * blockAlign, true)
  v.setUint16(32, blockAlign, true)
  v.setUint16(34, 32, true)
  put(36, 'data')
  v.setUint32(40, dataSize, true)
  return head
}

/** 32-bit float WAV（小端）。onProgress 传 0~1 */
export async function encodeFloatWavBlob(
  channels: Float32Array[],
  sampleRate: number,
  onProgress?: (p: number) => void
): Promise<Blob> {
  const numChannels = Math.max(1, channels.length)
  const numFrames = channels[0]?.length ?? 0
  if (numFrames === 0) throw new Error('音轨为空，无法生成工程音频')
  if (numFrames * numChannels * 4 > 0xffffffff - 44) {
    throw new Error('音轨超过 4GB，当前 WAV 格式无法承载')
  }
  const parts: BlobPart[] = [writeHeader(sampleRate, numChannels, numFrames * numChannels * 4)]
  const chunks = Math.ceil(numFrames / ENCODE_FRAMES_PER_CHUNK)

  for (let ci = 0; ci < chunks; ci++) {
    const start = ci * ENCODE_FRAMES_PER_CHUNK
    const frames = Math.min(ENCODE_FRAMES_PER_CHUNK, numFrames - start)
    const bytes = new Uint8Array(frames * numChannels * 4)
    const view = new DataView(bytes.buffer)
    let o = 0
    for (let i = 0; i < frames; i++) {
      const frame = start + i
      for (let ch = 0; ch < numChannels; ch++) {
        const raw = channels[ch]?.[frame] ?? 0
        view.setFloat32(o, Number.isFinite(raw) ? raw : 0, true)
        o += 4
      }
    }
    parts.push(bytes)
    if (ci % YIELD_EVERY === YIELD_EVERY - 1) {
      onProgress?.((ci + 1) / chunks)
      await yieldToUI()
    }
  }
  onProgress?.(1)
  return new Blob(parts, { type: 'audio/wav' })
}

interface FmtInfo {
  format: number
  numChannels: number
  sampleRate: number
  bitsPerSample: number
  blockAlign: number
}

async function readWavStructure(
  blob: Blob
): Promise<{ fmt: FmtInfo; dataOffset: number; dataSize: number }> {
  if (blob.size < 44) throw new Error('工程音频不是有效的 WAV 文件')
  const riff = new DataView(await blob.slice(0, 12).arrayBuffer())
  const tag = (v: DataView, o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3))
  if (tag(riff, 0) !== 'RIFF' || tag(riff, 8) !== 'WAVE') throw new Error('工程音频缺少 RIFF/WAVE 头')

  let offset = 12
  let fmt: FmtInfo | null = null
  let dataOffset = -1
  let dataSize = 0
  while (offset + 8 <= blob.size) {
    const head = new DataView(await blob.slice(offset, offset + 8).arrayBuffer())
    const id = tag(head, 0)
    const size = head.getUint32(4, true)
    const body = offset + 8
    if (size < 0 || body + size > blob.size) break
    if (id === 'fmt ') {
      const f = new DataView(await blob.slice(body, body + Math.min(size, 40)).arrayBuffer())
      fmt = {
        format: f.getUint16(0, true),
        numChannels: f.getUint16(2, true),
        sampleRate: f.getUint32(4, true),
        bitsPerSample: f.getUint16(14, true),
        blockAlign: f.getUint16(12, true)
      }
    } else if (id === 'data') {
      dataOffset = body
      dataSize = size
      break // 工程音频由本模块生成，data 一定在最后；遇到即可停止扫描
    }
    offset = body + size + (size % 2)
  }
  if (!fmt || dataOffset < 0) throw new Error('工程音频缺少 fmt/data 块')
  if (![1, 3].includes(fmt.format)) throw new Error(`工程音频格式不受支持（format tag ${fmt.format}）`)
  if (![8, 16, 24, 32].includes(fmt.bitsPerSample)) {
    throw new Error(`工程音频位深不受支持（${fmt.bitsPerSample} bit）`)
  }
  if (fmt.format === 3 && fmt.bitsPerSample !== 32) {
    throw new Error('浮点 WAV 必须为 32-bit')
  }
  if (fmt.numChannels < 1 || fmt.numChannels > 32 || fmt.sampleRate < 8000 || fmt.sampleRate > 384000) {
    throw new Error('工程音频声道数或采样率异常')
  }
  return { fmt, dataOffset, dataSize }
}

/** 分块解码 WAV（float32 / PCM 8·16·24·32-bit），返回 planar Float32Array */
export async function decodeWavBlob(
  blob: Blob,
  onProgress?: (p: number) => void
): Promise<DecodedWav> {
  const { fmt, dataOffset, dataSize } = await readWavStructure(blob)
  const bytesPerSample = fmt.bitsPerSample / 8
  const blockAlign = fmt.blockAlign || fmt.numChannels * bytesPerSample
  if (blockAlign < fmt.numChannels * bytesPerSample) throw new Error('工程音频块对齐异常')
  const numFrames = Math.floor(Math.min(dataSize, blob.size - dataOffset) / blockAlign)
  if (numFrames <= 0) throw new Error('工程音频数据为空')

  const channels: Float32Array[] = []
  for (let c = 0; c < fmt.numChannels; c++) channels.push(new Float32Array(numFrames))
  const chunks = Math.ceil(numFrames / DECODE_FRAMES_PER_CHUNK)

  for (let ci = 0; ci < chunks; ci++) {
    const startFrame = ci * DECODE_FRAMES_PER_CHUNK
    const frames = Math.min(DECODE_FRAMES_PER_CHUNK, numFrames - startFrame)
    const byteStart = dataOffset + startFrame * blockAlign
    const slice = await blob.slice(byteStart, byteStart + frames * blockAlign).arrayBuffer()
    const view = new DataView(slice)
    let o = 0
    for (let i = 0; i < frames; i++) {
      for (let ch = 0; ch < fmt.numChannels; ch++) {
        let v: number
        if (fmt.format === 3) {
          v = view.getFloat32(o, true)
        } else if (fmt.bitsPerSample === 8) {
          v = (view.getUint8(o) - 128) / 128
        } else if (fmt.bitsPerSample === 16) {
          v = view.getInt16(o, true) / 32768
        } else if (fmt.bitsPerSample === 24) {
          const raw = view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getUint8(o + 2) << 16)
          v = (raw << 8) / 2147483648
        } else {
          v = view.getInt32(o, true) / 2147483648
        }
        channels[ch][startFrame + i] = Number.isFinite(v) ? v : 0
        o += bytesPerSample
      }
    }
    if (ci % YIELD_EVERY === YIELD_EVERY - 1) {
      onProgress?.((ci + 1) / chunks)
      await yieldToUI()
    }
  }
  onProgress?.(1)
  return { channels, sampleRate: fmt.sampleRate }
}
