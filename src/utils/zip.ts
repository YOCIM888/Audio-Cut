/**
 * 极简 ZIP 读写（零依赖）。
 *
 * 写入：STORED（method 0）+ UTF-8 文件名标志。音频本身几乎无法被 deflate 再压缩，
 * 用 STORED 可以让写入端不做二次全量内存拷贝，且任何解压工具都能打开。
 * 读取：解析中央目录，支持 method 0 与 method 8（DecompressionStream），
 * 因此也能打开用户用系统工具重新压缩过的工程包。
 * 不支持 ZIP64（单个工程包 >4GB 时明确报错，而不是静默产出坏文件）。
 */

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const FLAG_UTF8 = 0x0800
const MAX_U32 = 0xffffffff

export interface ZipInput {
  name: string
  data: Blob | ArrayBufferView | ArrayBuffer | string
}

let crcTable: Uint32Array | null = null

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  crcTable = t
  return t
}

/** 增量 CRC32：输入为「已取反」的寄存器值，返回同形态的值 */
export function crc32Update(crc: number, bytes: Uint8Array): number {
  const t = getCrcTable()
  let c = crc >>> 0
  for (let i = 0; i < bytes.length; i++) c = (c >>> 8) ^ t[(c ^ bytes[i]) & 0xff]
  return c >>> 0
}

export function crc32(bytes: Uint8Array): number {
  return (crc32Update(0xffffffff, bytes) ^ 0xffffffff) >>> 0
}

/** 流式计算 CRC，避免把整个音频读进一个 ArrayBuffer */
async function crc32OfBlob(blob: Blob): Promise<number> {
  let crc = 0xffffffff
  if (typeof blob.stream === 'function') {
    const reader = blob.stream().getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      crc = crc32Update(crc, value as Uint8Array)
    }
  } else {
    const ab = await blob.arrayBuffer()
    const bytes = new Uint8Array(ab)
    for (let i = 0; i < bytes.length; i += 0x100000) {
      crc = crc32Update(crc, bytes.subarray(i, i + 0x100000))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** ZIP 时间：DOS 日期/时间（本地时间，精度 2 秒） */
function dosDateTime(date: Date): { time: number; date: number } {
  const y = Math.max(1980, Math.min(2107, date.getFullYear()))
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  }
}

/** 规范化条目名，杜绝 ../ 与绝对路径 */
export function normalizeEntryName(name: string): string {
  const cleaned = name
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/')
  if (!cleaned) throw new Error('工程包内文件名无效')
  return cleaned
}

function toBlob(data: ZipInput['data']): Blob {
  if (data instanceof Blob) return data
  if (typeof data === 'string') return new Blob([data], { type: 'application/json;charset=utf-8' })
  return new Blob([data as BlobPart])
}

interface Prepared {
  nameBytes: Uint8Array
  data: Blob
  size: number
  crc: number
  offset: number
}

export async function createZip(entries: ZipInput[], date = new Date()): Promise<Blob> {
  if (entries.length === 0) throw new Error('工程包内容为空')
  const { time, date: dosDate } = dosDateTime(date)
  const prepared: Prepared[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(normalizeEntryName(entry.name))
    const data = toBlob(entry.data)
    const size = data.size
    if (size > MAX_U32 || offset > MAX_U32) {
      throw new Error('工程超过 4GB，超出当前 ZIP 格式支持范围；请缩短音频或分段导出')
    }
    const crc = await crc32OfBlob(data)
    prepared.push({ nameBytes, data, size, crc, offset })
    offset += 30 + nameBytes.length + size
    if (offset > MAX_U32) throw new Error('工程超过 4GB，超出当前 ZIP 格式支持范围')
  }

  const parts: BlobPart[] = []
  for (const p of prepared) {
    const head = new Uint8Array(30 + p.nameBytes.length)
    const v = new DataView(head.buffer)
    v.setUint32(0, SIG_LOCAL, true)
    v.setUint16(4, 20, true) // version needed
    v.setUint16(6, FLAG_UTF8, true)
    v.setUint16(8, 0, true) // method: stored
    v.setUint16(10, time, true)
    v.setUint16(12, dosDate, true)
    v.setUint32(14, p.crc, true)
    v.setUint32(18, p.size, true)
    v.setUint32(22, p.size, true)
    v.setUint16(26, p.nameBytes.length, true)
    v.setUint16(28, 0, true)
    head.set(p.nameBytes, 30)
    parts.push(head, p.data)
  }

  const centralSize = prepared.reduce((n, p) => n + 46 + p.nameBytes.length, 0)
  if (offset + centralSize + 22 > MAX_U32) throw new Error('工程超过 4GB，超出当前 ZIP 格式支持范围')
  const central = new Uint8Array(centralSize)
  const cv = new DataView(central.buffer)
  let c = 0
  for (const p of prepared) {
    cv.setUint32(c, SIG_CENTRAL, true)
    cv.setUint16(c + 4, 20, true) // version made by
    cv.setUint16(c + 6, 20, true) // version needed
    cv.setUint16(c + 8, FLAG_UTF8, true)
    cv.setUint16(c + 10, 0, true) // method
    cv.setUint16(c + 12, time, true)
    cv.setUint16(c + 14, dosDate, true)
    cv.setUint32(c + 16, p.crc, true)
    cv.setUint32(c + 20, p.size, true)
    cv.setUint32(c + 24, p.size, true)
    cv.setUint16(c + 28, p.nameBytes.length, true)
    cv.setUint16(c + 30, 0, true) // extra
    cv.setUint16(c + 32, 0, true) // comment
    cv.setUint16(c + 34, 0, true) // disk start
    cv.setUint16(c + 36, 0, true) // internal attrs
    cv.setUint32(c + 38, 0, true) // external attrs
    cv.setUint32(c + 42, p.offset, true)
    central.set(p.nameBytes, c + 46)
    c += 46 + p.nameBytes.length
  }

  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, SIG_EOCD, true)
  ev.setUint16(4, 0, true)
  ev.setUint16(6, 0, true)
  ev.setUint16(8, prepared.length, true)
  ev.setUint16(10, prepared.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  ev.setUint16(20, 0, true)

  parts.push(central, eocd)
  return new Blob(parts, { type: 'application/zip' })
}

interface CentralEntry {
  name: string
  method: number
  compSize: number
  uncompSize: number
  localOffset: number
}

async function inflateRaw(blob: Blob): Promise<Blob> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持解压 deflate 工程包，请用未压缩的 .yac.zip')
  }
  const stream = blob.stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Response(stream).blob()
}

/** 读取 ZIP，返回「条目名 → 内容 Blob」；只按需 slice，不整包载入内存 */
export async function readZip(blob: Blob): Promise<Map<string, Blob>> {
  if (blob.size < 22) throw new Error('工程包文件过小或已损坏')
  const tailLen = Math.min(blob.size, 65557 + 22)
  const tail = new Uint8Array(await blob.slice(blob.size - tailLen).arrayBuffer())
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (new DataView(tail.buffer, tail.byteOffset + i, 4).getUint32(0, true) === SIG_EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的工程包（未找到 ZIP 结束标记）')
  const tv = new DataView(tail.buffer, tail.byteOffset + eocd, 22)
  const count = tv.getUint16(10, true)
  const cdSize = tv.getUint32(12, true)
  const cdOffset = tv.getUint32(16, true)
  if (count === 0xffff || cdOffset === MAX_U32 || cdSize === MAX_U32) {
    throw new Error('不支持 ZIP64 工程包')
  }
  if (count > 256 || cdOffset + cdSize > blob.size) {
    throw new Error('工程包目录异常或已损坏')
  }

  const cd = new Uint8Array(await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer())
  const dv = new DataView(cd.buffer)
  const decoder = new TextDecoder('utf-8')
  const entries: CentralEntry[] = []
  let p = 0
  while (p + 46 <= cd.length && entries.length < count) {
    if (dv.getUint32(p, true) !== SIG_CENTRAL) break
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    if (p + 46 + nameLen + extraLen + commentLen > cd.length) throw new Error('工程包目录已损坏')
    const name = decoder.decode(cd.subarray(p + 46, p + 46 + nameLen))
    entries.push({
      name,
      method: dv.getUint16(p + 10, true),
      compSize: dv.getUint32(p + 20, true),
      uncompSize: dv.getUint32(p + 24, true),
      localOffset: dv.getUint32(p + 42, true)
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  if (entries.length === 0) throw new Error('工程包内没有文件')

  const out = new Map<string, Blob>()
  for (const entry of entries) {
    const head = new Uint8Array(
      await blob.slice(entry.localOffset, Math.min(blob.size, entry.localOffset + 30)).arrayBuffer()
    )
    if (head.length < 30 || new DataView(head.buffer).getUint32(0, true) !== SIG_LOCAL) {
      throw new Error(`工程包条目「${entry.name}」已损坏`)
    }
    const hv = new DataView(head.buffer)
    const nameLen = hv.getUint16(26, true)
    const extraLen = hv.getUint16(28, true)
    const start = entry.localOffset + 30 + nameLen + extraLen
    if (start + entry.compSize > blob.size) throw new Error(`工程包条目「${entry.name}」数据不完整`)
    const raw = blob.slice(start, start + entry.compSize)
    let data: Blob
    if (entry.method === 0) data = raw
    else if (entry.method === 8) data = await inflateRaw(raw)
    else throw new Error(`工程包使用了不支持的压缩方式（method ${entry.method}）`)
    if (data.size !== entry.uncompSize) {
      throw new Error(`工程包条目「${entry.name}」解压后长度不符`)
    }
    // 只暴露规范化后的名字，避免路径穿越的键名干扰查找
    out.set(entry.name.replace(/\\/g, '/').replace(/^\/+/, ''), data)
  }
  return out
}
