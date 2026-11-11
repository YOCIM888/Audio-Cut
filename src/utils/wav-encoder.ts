/**
 * 纯 JS WAV 编码器：16/24-bit PCM 与 32-bit IEEE float，任意采样率/声道。
 * 可选在 data 块之后追加 LIST/INFO 元数据块。
 *
 * 三种输出方式共用同一套分块编码逻辑：
 *  - encodeWav()：拼成单个 ArrayBuffer，兼容小文件与旧调用；
 *  - encodeWavBlob()：分块 Blob，长音频不再申请一块 691MB 级连续内存；
 *  - writeWavToHandle()：配合 File System Access API 边编码边写盘，内存 O(块)。
 * 16/24-bit 默认加确定性 TPDF dither，避免量化失真；32-bit float 保持原始动态范围。
 */
import { buildInfoChunk, type TrackMetadata } from './audio-metadata'

export type WavBitDepth = 16 | 24 | 32

export interface WavEncodeOptions {
  /** 16/24-bit 量化前加 TPDF 抖动，默认开启 */
  dither?: boolean
  /** 每块帧数，默认 16384 */
  chunkFrames?: number
  /** 0~1 编码进度 */
  onProgress?: (p: number) => void
  /** 分块循环中响应取消，避免长音频导出取消后仍把整段编码完 */
  signal?: AbortSignal
}

/** File System Access API 的最小结构化类型，避免依赖实验性 lib 声明 */
export interface WavSaveHandle {
  createWritable(): Promise<{
    write(data: Uint8Array | Blob): Promise<void>
    close(): Promise<void>
    abort?: () => Promise<void>
  }>
}

const DEFAULT_CHUNK_FRAMES = 16384

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
}

/** 确定性 xorshift32：同一输入每次编码结果一致，便于校验与复现 */
function createDitherRng(): () => number {
  let s = 0x9e3779b9
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 0x100000000
  }
}

function wavHeader(
  sampleRate: number,
  numChannels: number,
  bitDepth: WavBitDepth,
  dataSize: number,
  dataPad: number,
  infoSize: number
): Uint8Array {
  const head = new Uint8Array(44)
  const view = new DataView(head.buffer)
  const blockAlign = numChannels * (bitDepth / 8)
  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize + dataPad + infoSize, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, bitDepth === 32 ? 3 : 1, true) // 3 = IEEE float, 1 = PCM
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitDepth, true)
  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)
  return head
}

/** 编码一帧块（交错），返回独立 Uint8Array，可直接写入 Blob 或文件流 */
function encodeFrameChunk(
  channels: Float32Array[],
  startFrame: number,
  frames: number,
  numChannels: number,
  bitDepth: WavBitDepth,
  dither: boolean,
  rng: () => number
): Uint8Array {
  const bytes = new Uint8Array(frames * numChannels * (bitDepth / 8))
  const view = new DataView(bytes.buffer)
  const lsb = bitDepth === 16 ? 1 / 32768 : 1 / 8388608
  let offset = 0
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const raw = channels[ch]?.[startFrame + i] ?? 0
      const safe = Number.isFinite(raw) ? raw : 0
      if (bitDepth === 32) {
        // 浮点 WAV 保留超过 0 dBFS 的样本，不限幅、不加抖动
        view.setFloat32(offset, safe, true)
        offset += 4
        continue
      }
      let s = Math.max(-1, Math.min(1, safe))
      if (dither) s = Math.max(-1, Math.min(1, s + (rng() - rng()) * lsb))
      if (bitDepth === 16) {
        const v = Math.round(s < 0 ? s * 0x8000 : s * 0x7fff)
        view.setInt16(offset, Math.max(-32768, Math.min(32767, v)), true)
        offset += 2
      } else {
        const v = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff)
        const q = Math.max(-8388608, Math.min(8388607, v))
        view.setUint8(offset, q & 0xff)
        view.setUint8(offset + 1, (q >> 8) & 0xff)
        view.setUint8(offset + 2, (q >> 16) & 0xff)
        offset += 3
      }
    }
  }
  return bytes
}

/**
 * 分块产出 WAV 字节：header → 若干 data 块 → 对齐 pad → LIST/INFO。
 * 同步生成器，浏览器与 Node 均可直接用；调用方决定拼内存、组 Blob 还是写盘。
 */
export function* encodeWavChunks(
  channels: Float32Array[],
  sampleRate: number,
  bitDepth: WavBitDepth,
  metadata?: TrackMetadata,
  options: WavEncodeOptions = {}
): Generator<Uint8Array> {
  const numChannels = Math.max(1, channels.length)
  const numFrames = channels[0]?.length ?? 0
  const dataSize = numFrames * numChannels * (bitDepth / 8)
  if (dataSize > 0xffffffff - 44) throw new Error('音频超过 4GB，WAV 格式无法承载，请导出选区或改用压缩格式')
  const info = buildInfoChunk(metadata)
  const infoSize = info?.length ?? 0
  // RIFF 块必须 2 字节对齐：24-bit 单声道等场景 dataSize 可能为奇数
  const dataPad = dataSize % 2
  yield wavHeader(sampleRate, numChannels, bitDepth, dataSize, dataPad, infoSize)

  const chunkFrames = Math.max(1, Math.floor(options.chunkFrames ?? DEFAULT_CHUNK_FRAMES))
  const dither = options.dither !== false && bitDepth !== 32
  const rng = createDitherRng()
  const throwIfAborted = () => {
    if (options.signal?.aborted) throw new DOMException('WAV 编码已取消', 'AbortError')
  }
  for (let start = 0; start < numFrames; start += chunkFrames) {
    throwIfAborted()
    const frames = Math.min(chunkFrames, numFrames - start)
    yield encodeFrameChunk(channels, start, frames, numChannels, bitDepth, dither, rng)
    options.onProgress?.(numFrames === 0 ? 1 : (start + frames) / numFrames)
  }
  if (numFrames === 0) options.onProgress?.(1)
  if (dataPad) yield new Uint8Array(1)
  if (info) yield info
}

/** 旧接口：拼成单个 ArrayBuffer（小文件适用） */
export function encodeWav(
  channels: Float32Array[],
  sampleRate: number,
  bitDepth: WavBitDepth,
  metadata?: TrackMetadata,
  options: WavEncodeOptions = {}
): ArrayBuffer {
  const parts = [...encodeWavChunks(channels, sampleRate, bitDepth, metadata, options)]
  const total = parts.reduce((n, p) => n + p.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out.buffer
}

function yieldToUI(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** 分块 Blob：每部分独立分配，避免长音频一次性申请等大的连续内存 */
export async function encodeWavBlob(
  channels: Float32Array[],
  sampleRate: number,
  bitDepth: WavBitDepth,
  metadata?: TrackMetadata,
  options: WavEncodeOptions = {}
): Promise<Blob> {
  const parts: BlobPart[] = []
  let n = 0
  for (const part of encodeWavChunks(channels, sampleRate, bitDepth, metadata, options)) {
    parts.push(part)
    if (++n % 16 === 0) await yieldToUI()
  }
  return new Blob(parts, { type: 'audio/wav' })
}

/** 流式写盘：边编码边写入用户选择的文件，内存占用与长度无关 */
export async function writeWavToHandle(
  handle: WavSaveHandle,
  channels: Float32Array[],
  sampleRate: number,
  bitDepth: WavBitDepth,
  metadata?: TrackMetadata,
  options: WavEncodeOptions = {}
): Promise<void> {
  const writable = await handle.createWritable()
  try {
    let n = 0
    for (const part of encodeWavChunks(channels, sampleRate, bitDepth, metadata, options)) {
      await writable.write(part)
      if (++n % 8 === 0) await yieldToUI()
    }
    await writable.close()
  } catch (err) {
    try {
      await writable.abort?.()
    } catch {
      /* 流已关闭时忽略 */
    }
    throw err
  }
}

export function canPickSaveFile(): boolean {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window
}

/** 必须在用户手势的同步调用栈内发起（showSaveFilePicker 需要 transient activation） */
export async function pickWavSaveHandle(suggestedName: string): Promise<WavSaveHandle | null> {
  const w = window as Window & {
    showSaveFilePicker?: (opts: unknown) => Promise<WavSaveHandle>
  }
  if (!w.showSaveFilePicker) return null
  try {
    return await w.showSaveFilePicker({
      suggestedName,
      types: [{ description: 'WAV 音频', accept: { 'audio/wav': ['.wav'] } }]
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null
    throw err
  }
}
