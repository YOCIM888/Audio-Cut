/** 通用音频工具函数（均为纯函数，操作 Float32Array 拷贝，避免触碰响应式） */

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** 选区吸附：0.1s 网格 */
export function snapTime(t: number, grid = 0.1): number {
  return Math.round(t / grid) * grid
}

/** 00:00.0 格式（0.1s 精度） */
export function formatTime(t: number): string {
  const neg = t < 0
  const v = Math.abs(t)
  const m = Math.floor(v / 60)
  const s = Math.floor(v % 60)
  const d = Math.floor((v % 1) * 10)
  return `${neg ? '-' : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${d}`
}

/** 取出 AudioBuffer 各声道（原始视图，勿直接 transfer） */
export function getAllChannels(buffer: AudioBuffer): Float32Array[] {
  const out: Float32Array[] = []
  for (let c = 0; c < buffer.numberOfChannels; c++) out.push(buffer.getChannelData(c))
  return out
}

/** 截取 [start, end) 采样，返回拷贝 */
export function sliceChannels(channels: Float32Array[], start: number, end: number): Float32Array[] {
  const len = channels[0]?.length ?? 0
  const s = clamp(Math.floor(start), 0, len)
  const e = clamp(Math.floor(end), s, len)
  return channels.map((c) => c.slice(s, e))
}

/** 顺序拼接两组声道（拷贝） */
export function concatChannels(a: Float32Array[], b: Float32Array[]): Float32Array[] {
  if (a.length === 0 || a[0].length === 0) return b
  if (b.length === 0 || b[0].length === 0) return a
  return a.map((ca, i) => {
    const cb = b[i]
    const out = new Float32Array(ca.length + cb.length)
    out.set(ca)
    out.set(cb, ca.length)
    return out
  })
}

/** 由声道数据构建 AudioBuffer */
export function channelsToAudioBuffer(channels: Float32Array[], sampleRate: number): AudioBuffer {
  const length = Math.max(1, channels[0]?.length ?? 0)
  const buffer = new AudioBuffer({
    numberOfChannels: Math.max(1, channels.length),
    length,
    sampleRate
  })
  channels.forEach((c, i) => buffer.copyToChannel(c, i))
  return buffer
}

/**
 * 局部替换 [start, start + removeFrames)：只分配一块新 AudioBuffer，
 * 不产生「全曲 Float32Array 中间拷贝」，因此一次编辑最多两份内存（新音轨 + 历史片段）。
 * inserted 为 planar 声道数据，长度可与 removeFrames 不同（支持插入与删除）。
 */
export function replaceAudioRegion(
  buffer: AudioBuffer,
  start: number,
  removeFrames: number,
  inserted: Float32Array[]
): AudioBuffer {
  const s = clamp(Math.floor(start), 0, buffer.length)
  const r = clamp(Math.floor(removeFrames), 0, buffer.length - s)
  const insertLen = inserted[0]?.length ?? 0
  const length = Math.max(1, buffer.length - r + insertLen)
  const out = new AudioBuffer({
    numberOfChannels: buffer.numberOfChannels,
    length,
    sampleRate: buffer.sampleRate
  })
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = buffer.getChannelData(c)
    const dst = out.getChannelData(c)
    dst.set(src.subarray(0, s), 0)
    const ins = inserted[Math.min(c, Math.max(0, inserted.length - 1))]
    if (ins && insertLen > 0) dst.set(ins.subarray(0, insertLen), s)
    dst.set(src.subarray(s + r), s + insertLen)
  }
  return out
}

/** 声道转换：mono 混音平均 / stereo 复制补齐 */
export function convertChannels(
  channels: Float32Array[],
  mode: 'keep' | 'mono' | 'stereo'
): Float32Array[] {
  if (mode === 'keep' || channels.length === 0) return channels
  if (mode === 'mono') {
    if (channels.length === 1) return channels
    const n = channels[0].length
    const out = new Float32Array(n)
    for (const c of channels) {
      for (let i = 0; i < n; i++) out[i] += c[i]
    }
    const inv = 1 / channels.length
    for (let i = 0; i < n; i++) out[i] *= inv
    return [out]
  }
  // stereo
  if (channels.length === 1) return [channels[0], channels[0].slice()]
  if (channels.length === 2) return channels
  return [channels[0], channels[1]]
}

/** 使用 OfflineAudioContext 高质量重采样 */
export async function resampleChannels(
  channels: Float32Array[],
  fromRate: number,
  toRate: number
): Promise<Float32Array[]> {
  if (fromRate === toRate || channels.length === 0) return channels.map((c) => c.slice())
  const length = Math.max(1, Math.ceil((channels[0].length * toRate) / fromRate))
  const ctx = new OfflineAudioContext(channels.length, length, toRate)
  const buffer = ctx.createBuffer(channels.length, channels[0].length, fromRate)
  channels.forEach((c, i) => buffer.copyToChannel(c, i))
  const src = ctx.createBufferSource()
  src.buffer = buffer
  src.connect(ctx.destination)
  src.start()
  const rendered = await ctx.startRendering()
  const out: Float32Array[] = []
  for (let c = 0; c < rendered.numberOfChannels; c++) out.push(rendered.getChannelData(c).slice())
  return out
}
