/**
 * 多轨时间线数据模型。
 *
 * 设计取舍：不推翻现有单轨编辑链路。editor.buffer 依然是「主轨」，
 * 所有剪辑、效果链、测量、分析、撤销都继续作用在它上面；其它轨道由
 * 独立 Clip 组成，可在时间轴任意位置起播，彼此叠加播放、离线混音导出。
 *
 * Clip 的 channels 是不可变采样数据：裁剪 / 拆分只改 offset/duration 或生成
 * 新的 slice，永远不原地改写 Float32Array。因此快照可以只复制元信息、
 * 共享采样引用，撤销栈不会因为多轨而爆内存。
 */

export type ChainTarget = 'main' | 'mix'

export interface Track {
  id: string
  name: string
  kind: 'main' | 'audio'
  color: string
  muted: boolean
  solo: boolean
  /** -60 ~ +12 dB */
  gainDb: number
  /** -1（全左） ~ +1（全右） */
  pan: number
}

export interface Clip {
  id: string
  trackId: string
  name: string
  /** 时间轴上的起点（秒） */
  start: number
  /** 源音频内的起点（秒），用于非破坏性裁剪 */
  offset: number
  /** 时间轴上的可见时长（秒） */
  duration: number
  sourceDuration: number
  channels: Float32Array[]
  sampleRate: number
  /** -60 ~ +12 dB */
  gainDb: number
  fadeInMs: number
  fadeOutMs: number
}

/** 不含采样数据的片段元信息，用于工程文件 / IndexedDB session */
export interface ClipMeta {
  id: string
  trackId: string
  name: string
  start: number
  offset: number
  duration: number
  sourceDuration: number
  sampleRate: number
  numberOfChannels: number
  frames: number
  gainDb: number
  fadeInMs: number
  fadeOutMs: number
  /** 对应的无损 WAV 文件名 */
  file: string
}

export interface SerializedMultitrack {
  tracks: Track[]
  clips: ClipMeta[]
  chainTarget: ChainTarget
}

export interface MultitrackState {
  tracks: Track[]
  clips: Clip[]
  chainTarget: ChainTarget
}

export const TRACK_COLORS = [
  '#22d3ee',
  '#a78bfa',
  '#f472b6',
  '#fbbf24',
  '#4ade80',
  '#60a5fa',
  '#fb923c',
  '#2dd4bf'
]

export const MAIN_TRACK_ID = 'track-main'

let idCounter = 0
export function newId(prefix: string): string {
  idCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`
}

export function createMainTrack(): Track {
  return {
    id: MAIN_TRACK_ID,
    name: '主轨（可编辑）',
    kind: 'main',
    color: TRACK_COLORS[0],
    muted: false,
    solo: false,
    gainDb: 0,
    pan: 0
  }
}

export function createTrack(index: number): Track {
  return {
    id: newId('track'),
    name: `轨道 ${index + 1}`,
    kind: 'audio',
    color: TRACK_COLORS[index % TRACK_COLORS.length],
    muted: false,
    solo: false,
    gainDb: 0,
    pan: 0
  }
}

export function createClip(
  channels: Float32Array[],
  sampleRate: number,
  trackId: string,
  name: string,
  start: number
): Clip {
  const frames = channels[0]?.length ?? 0
  const sourceDuration = sampleRate > 0 ? frames / sampleRate : 0
  return {
    id: newId('clip'),
    trackId,
    name,
    start: Math.max(0, start),
    offset: 0,
    duration: sourceDuration,
    sourceDuration,
    channels,
    sampleRate,
    gainDb: 0,
    fadeInMs: 0,
    fadeOutMs: 0
  }
}

export function cloneMultitrack(s: MultitrackState): MultitrackState {
  return {
    tracks: s.tracks.map((t) => ({ ...t })),
    clips: s.clips.map((c) => ({ ...c, channels: c.channels })),
    chainTarget: s.chainTarget
  }
}

export function clipMeta(c: Clip, file: string): ClipMeta {
  return {
    id: c.id,
    trackId: c.trackId,
    name: c.name,
    start: c.start,
    offset: c.offset,
    duration: c.duration,
    sourceDuration: c.sourceDuration,
    sampleRate: c.sampleRate,
    numberOfChannels: c.channels.length,
    frames: c.channels[0]?.length ?? 0,
    gainDb: c.gainDb,
    fadeInMs: c.fadeInMs,
    fadeOutMs: c.fadeOutMs,
    file
  }
}

export function clipFileName(id: string): string {
  return `tracks/clip-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}.wav`
}

/** 片段边界钳制：不允许负起点、超出源长度、或短于 1ms */
export function clampClipTimes(
  clip: Clip,
  patch: { start?: number; offset?: number; duration?: number }
): { start: number; offset: number; duration: number } {
  const src = Math.max(0.001, clip.sourceDuration)
  let offset = Math.max(0, Math.min(patch.offset ?? clip.offset, src - 0.001))
  let duration = Math.max(0.001, patch.duration ?? clip.duration)
  duration = Math.min(duration, src - offset)
  const start = Math.max(0, patch.start ?? clip.start)
  return { start, offset, duration }
}

/** 有 solo 时只听 solo 轨；否则排除 muted 轨。返回可发声的轨道 id 集合 */
export function audibleTrackIds(tracks: Track[]): Set<string> {
  const soloed = tracks.filter((t) => t.solo)
  const list = soloed.length ? soloed : tracks.filter((t) => !t.muted)
  return new Set(list.map((t) => t.id))
}

export function dbToGain(db: number): number {
  return Math.pow(10, Math.max(-60, Math.min(12, db)) / 20)
}

export function timelineDuration(mainDuration: number, clips: Clip[]): number {
  let d = mainDuration
  for (const c of clips) d = Math.max(d, c.start + c.duration)
  return d
}

/** 供播放引擎调度的纯数据描述（不含 AudioBuffer，由引擎按需构建并缓存） */
export interface ScheduledClip {
  id: string
  channels: Float32Array[]
  sampleRate: number
  start: number
  offset: number
  duration: number
  gain: number
  pan: number
  fadeInMs: number
  fadeOutMs: number
}

export function scheduledClips(
  state: MultitrackState,
  audible: Set<string>
): ScheduledClip[] {
  return state.clips
    .filter((c) => audible.has(c.trackId))
    .map((c) => {
      const track = state.tracks.find((t) => t.id === c.trackId)
      return {
        id: c.id,
        channels: c.channels,
        sampleRate: c.sampleRate,
        start: c.start,
        offset: c.offset,
        duration: c.duration,
        gain: dbToGain(c.gainDb) * dbToGain(track?.gainDb ?? 0),
        pan: Math.max(-1, Math.min(1, track?.pan ?? 0)),
        fadeInMs: c.fadeInMs,
        fadeOutMs: c.fadeOutMs
      }
    })
}

/** 外部输入逐字段校验（工程文件可能来自别的机器 / 旧版本） */
export function sanitizeTracks(raw: unknown): Track[] {
  const main = createMainTrack()
  if (!Array.isArray(raw)) return [main]
  const out: Track[] = []
  for (const item of raw.slice(0, 32)) {
    if (!item || typeof item !== 'object') continue
    const t = item as Record<string, unknown>
    const kind = t.kind === 'main' ? 'main' : 'audio'
    if (kind === 'main' && out.some((x) => x.kind === 'main')) continue
    out.push({
      id: typeof t.id === 'string' && t.id.length < 64 ? t.id : newId('track'),
      name: typeof t.name === 'string' ? t.name.slice(0, 60) : '轨道',
      kind,
      color: typeof t.color === 'string' && /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : TRACK_COLORS[out.length % TRACK_COLORS.length],
      muted: t.muted === true,
      solo: t.solo === true,
      gainDb: finite(t.gainDb, -60, 12, 0),
      pan: finite(t.pan, -1, 1, 0)
    })
  }
  if (!out.some((t) => t.kind === 'main')) out.unshift(main)
  return out
}

export function sanitizeClipMeta(raw: unknown, trackIds: Set<string>): ClipMeta[] {
  if (!Array.isArray(raw)) return []
  const out: ClipMeta[] = []
  for (const item of raw.slice(0, 256)) {
    if (!item || typeof item !== 'object') continue
    const c = item as Record<string, unknown>
    const id = typeof c.id === 'string' && c.id.length < 64 ? c.id : newId('clip')
    const trackId = typeof c.trackId === 'string' && trackIds.has(c.trackId) ? c.trackId : ''
    if (!trackId) continue
    const sourceDuration = finite(c.sourceDuration, 0.001, 86400, 0)
    const offset = finite(c.offset, 0, Math.max(0, sourceDuration - 0.001), 0)
    const duration = finite(c.duration, 0.001, Math.max(0.001, sourceDuration - offset), 0.001)
    out.push({
      id,
      trackId,
      name: typeof c.name === 'string' ? c.name.slice(0, 120) : '片段',
      start: finite(c.start, 0, 86400, 0),
      offset,
      duration,
      sourceDuration,
      sampleRate: finite(c.sampleRate, 8000, 192000, 48000),
      numberOfChannels: Math.round(finite(c.numberOfChannels, 1, 8, 1)),
      frames: Math.round(finite(c.frames, 1, 1e9, 1)),
      gainDb: finite(c.gainDb, -60, 12, 0),
      fadeInMs: finite(c.fadeInMs, 0, 10000, 0),
      fadeOutMs: finite(c.fadeOutMs, 0, 10000, 0),
      file: typeof c.file === 'string' && c.file.startsWith('tracks/') ? c.file : clipFileName(id)
    })
  }
  return out
}

function finite(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback
}
