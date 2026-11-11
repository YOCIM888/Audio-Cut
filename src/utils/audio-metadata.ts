/**
 * 导出元数据写入工具。
 *  - MP3：手写 ID3v2.3（TIT2 / TPE1 / TALB / TYER），文本用 UTF-16LE + BOM
 *  - WAV：追加 LIST/INFO 子块（INAM / IART / IPRD / ICRD），UTF-8 文本
 *  - ffmpeg 编码格式：生成 -metadata 参数，由容器写入 Vorbis comment / iTunes 标签
 */

export interface TrackMetadata {
  title?: string
  artist?: string
  album?: string
  year?: string
}

function clean(v: string | undefined): string {
  return (v ?? '').trim().slice(0, 240)
}

export function hasMetadata(meta: TrackMetadata | undefined): boolean {
  if (!meta) return false
  return Boolean(clean(meta.title) || clean(meta.artist) || clean(meta.album) || clean(meta.year))
}

/** ffmpeg 的 -metadata 参数对，值为空时跳过（argv 传参，无需 shell 转义） */
export function metadataArgs(meta: TrackMetadata | undefined): string[] {
  if (!hasMetadata(meta)) return []
  const pairs: [string, string][] = [
    ['title', clean(meta!.title)],
    ['artist', clean(meta!.artist)],
    ['album', clean(meta!.album)],
    ['date', clean(meta!.year)]
  ]
  const out: string[] = []
  for (const [key, value] of pairs) {
    if (value) out.push('-metadata', `${key}=${value}`)
  }
  return out
}

/** ID3v2.3 文本帧：4 字节 ID + 4 字节大端长度 + 2 字节标志 + UTF-16LE(BOM) */
function id3TextFrame(id: string, text: string): Uint8Array {
  const units: number[] = [0x01, 0xff, 0xfe]
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    units.push(code & 0xff, (code >>> 8) & 0xff)
  }
  units.push(0x00, 0x00) // UTF-16 字符串终止符
  const body = new Uint8Array(units)
  const size = body.length
  const frame = new Uint8Array(10 + size)
  for (let i = 0; i < 4; i++) frame[i] = id.charCodeAt(i)
  frame[4] = (size >>> 24) & 0xff
  frame[5] = (size >>> 16) & 0xff
  frame[6] = (size >>> 8) & 0xff
  frame[7] = size & 0xff
  frame[8] = 0
  frame[9] = 0
  frame.set(body, 10)
  return frame
}

function syncSafeSize(n: number): number[] {
  return [(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f]
}

/** 在纯 MP3 数据前插入 ID3v2.3 标签；无有效元数据时原样返回 */
export function writeId3v2(mp3: ArrayBuffer, meta: TrackMetadata | undefined): ArrayBuffer {
  if (!hasMetadata(meta)) return mp3
  const frames: Uint8Array[] = []
  const pairs: [string, string][] = [
    ['TIT2', clean(meta!.title)],
    ['TPE1', clean(meta!.artist)],
    ['TALB', clean(meta!.album)],
    ['TYER', clean(meta!.year)]
  ]
  for (const [id, text] of pairs) {
    if (text) frames.push(id3TextFrame(id, text))
  }
  const tagsSize = frames.reduce((sum, f) => sum + f.length, 0)
  const header = new Uint8Array(10)
  header[0] = 0x49 // I
  header[1] = 0x44 // D
  header[2] = 0x33 // 3
  header[3] = 0x03 // v2.3
  header[4] = 0x00
  header[5] = 0x00 // flags
  header.set(syncSafeSize(tagsSize), 6)

  const out = new Uint8Array(10 + tagsSize + mp3.byteLength)
  out.set(header, 0)
  let offset = 10
  for (const f of frames) {
    out.set(f, offset)
    offset += f.length
  }
  out.set(new Uint8Array(mp3), offset)
  return out.buffer
}

/** WAV LIST/INFO 子块；每个子块按 RIFF 规范补偶数字节。无有效元数据时返回 null */
export function buildInfoChunk(meta: TrackMetadata | undefined): Uint8Array | null {
  if (!hasMetadata(meta)) return null
  const encoder = new TextEncoder()
  const pairs: [string, string][] = [
    ['INAM', clean(meta!.title)],
    ['IART', clean(meta!.artist)],
    ['IPRD', clean(meta!.album)],
    ['ICRD', clean(meta!.year)]
  ]
  const subChunks: Uint8Array[] = []
  for (const [id, text] of pairs) {
    if (!text) continue
    const bytes = encoder.encode(text)
    const padded = bytes.length + (bytes.length % 2)
    const sub = new Uint8Array(8 + padded)
    for (let i = 0; i < 4; i++) sub[i] = id.charCodeAt(i)
    sub[4] = bytes.length & 0xff
    sub[5] = (bytes.length >>> 8) & 0xff
    sub[6] = (bytes.length >>> 16) & 0xff
    sub[7] = (bytes.length >>> 24) & 0xff
    sub.set(bytes, 8)
    subChunks.push(sub)
  }
  if (subChunks.length === 0) return null

  const payloadSize = 4 + subChunks.reduce((sum, c) => sum + c.length, 0) // 'INFO' + 子块
  const chunk = new Uint8Array(8 + payloadSize)
  for (let i = 0; i < 4; i++) chunk[i] = 'LIST'.charCodeAt(i)
  chunk[4] = payloadSize & 0xff
  chunk[5] = (payloadSize >>> 8) & 0xff
  chunk[6] = (payloadSize >>> 16) & 0xff
  chunk[7] = (payloadSize >>> 24) & 0xff
  chunk.set([0x49, 0x4e, 0x46, 0x4f], 8) // INFO
  let offset = 12
  for (const sub of subChunks) {
    chunk.set(sub, offset)
    offset += sub.length
  }
  return chunk
}
