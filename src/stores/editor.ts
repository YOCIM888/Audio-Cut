/**
 * 编辑器核心 Store。
 * 关键约束：AudioBuffer / PeakCache 使用 shallowRef，历史快照为普通数组，
 * 绝不进入 Vue 深层响应式系统。
 */
import { computed, reactive, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import { audioEngine } from '../audio/engine'
import { PeakCache } from '../audio/peaks'
import { useToastStore } from './toast'
import {
  channelsToAudioBuffer,
  concatChannels,
  convertChannels,
  getAllChannels,
  resampleChannels,
  sliceChannels,
  snapTime,
  clamp
} from '../utils/audio-utils'
import { runWorkerTask } from '../utils/worker-client'
import { renderEffects, type EffectSettings } from '../audio/effects'

export interface Snapshot {
  channels: Float32Array[]
  sampleRate: number
}

export interface LoadOptions {
  selection?: { start: number; end: number }
  zoom?: number
  scrollX?: number
  vGain?: number
}

interface ClipboardData {
  channels: Float32Array[]
  sampleRate: number
}

/** 内部剪贴板：普通模块变量，不进入响应式系统 */
let clipboard: ClipboardData | null = null

export interface MergeClipInput {
  name: string
  channels: Float32Array[]
  sampleRate: number
}

export type SidebarTab = 'edit' | 'effects' | 'speed' | 'merge' | 'export'
export type BusyType = 'decode' | 'stretch' | 'merge' | 'effects' | 'gate' | null
export type FadeCurve = 'linear' | 'cosine' | 'exponential' | 'logarithmic'

const MAX_HISTORY = 30

let processWorker: Worker | null = null
function getProcessWorker(): Worker {
  if (!processWorker) {
    processWorker = new Worker(new URL('../workers/audio-process.worker.ts', import.meta.url), {
      type: 'module'
    })
  }
  return processWorker
}

export const useEditorStore = defineStore('editor', () => {
  const toast = useToastStore()

  // ---- 状态（大对象一律 shallowRef） ----
  const buffer = shallowRef<AudioBuffer | null>(null)
  const peakCache = shallowRef<PeakCache | null>(null)
  const fileName = ref<string | null>(null)
  const selection = reactive({ start: 0, end: 0 })
  const zoom = ref(80) // px / 秒
  const scrollX = ref(0) // px
  const vGain = ref(1) // 垂直振幅缩放（纯显示，不改数据）
  const zeroSnap = ref(false) // 选区边缘吸附零交叉点
  const hasClipboard = ref(false)
  const pendingView = ref(false) // 由工程加载设置视图，跳过自动适应窗口
  const isPlaying = ref(false)
  const isLooping = ref(false)
  const volume = ref(0.9)
  const sidebarTab = ref<SidebarTab>('edit')
  const busy = reactive({ type: null as BusyType, progress: 0 })

  // ---- 历史栈（非响应式数组 + 版本号触发 computed） ----
  const past: Snapshot[] = []
  const future: Snapshot[] = []
  const historyVersion = ref(0)

  const duration = computed(() => buffer.value?.duration ?? 0)
  const hasSelection = computed(() => selection.end - selection.start > 1e-4)
  const canUndo = computed(() => historyVersion.value >= 0 && past.length > 0)
  const canRedo = computed(() => historyVersion.value >= 0 && future.length > 0)

  audioEngine.onEnded = () => {
    isPlaying.value = false
  }

  // ---- 内部工具 ----
  function takeSnapshot(): Snapshot {
    const buf = buffer.value!
    return {
      channels: getAllChannels(buf).map((c) => c.slice()),
      sampleRate: buf.sampleRate
    }
  }

  function pushHistory(): void {
    if (!buffer.value) return
    past.push(takeSnapshot())
    if (past.length > MAX_HISTORY) past.shift()
    future.length = 0
    historyVersion.value++
  }

  function stopPlayback(): void {
    audioEngine.stop()
    isPlaying.value = false
  }

  function applyChannels(channels: Float32Array[], sampleRate: number): void {
    stopPlayback()
    const buf = channelsToAudioBuffer(channels, sampleRate)
    buffer.value = buf
    peakCache.value = new PeakCache(buf)
    audioEngine.setBuffer(buf)
    selection.start = clamp(selection.start, 0, buf.duration)
    selection.end = clamp(selection.end, 0, buf.duration)
    if (selection.end <= selection.start) {
      selection.start = 0
      selection.end = 0
    }
    syncLoopRange()
  }

  function syncLoopRange(): void {
    audioEngine.setRange(hasSelection.value ? { start: selection.start, end: selection.end } : null)
  }

  /** 用已解码的 AudioBuffer 替换当前音轨（导入与工程加载共用） */
  function loadDecodedBuffer(decoded: AudioBuffer, name: string, opts: LoadOptions = {}): void {
    stopPlayback()
    past.length = 0
    future.length = 0
    historyVersion.value++
    buffer.value = decoded
    peakCache.value = new PeakCache(decoded)
    fileName.value = name
    audioEngine.setBuffer(decoded)
    clipboard = null
    hasClipboard.value = false
    const dur = decoded.duration
    selection.start = clamp(opts.selection?.start ?? 0, 0, dur)
    selection.end = clamp(opts.selection?.end ?? 0, 0, dur)
    if (selection.end <= selection.start) {
      selection.start = 0
      selection.end = 0
    }
    if (opts.zoom && opts.zoom > 0) zoom.value = opts.zoom
    scrollX.value = opts.scrollX ?? 0
    vGain.value = clamp(opts.vGain ?? 1, 0.25, 8)
    pendingView.value = opts.zoom !== undefined
    syncLoopRange()
  }

  // ---- 导入 ----
  async function loadFile(file: File): Promise<void> {
    if (busy.type) return
    busy.type = 'decode'
    try {
      const ctx = audioEngine.ensureContext()
      const bytes = await file.arrayBuffer()
      const decoded = await ctx.decodeAudioData(bytes)
      loadDecodedBuffer(decoded, file.name.replace(/\.[^.]+$/, ''))
      toast.push('success', `已加载 ${file.name}（${decoded.duration.toFixed(1)}s / ${decoded.numberOfChannels}ch / ${decoded.sampleRate}Hz）`)
    } catch (err) {
      console.error(err)
      toast.push('error', '音频解码失败，请确认文件格式有效（mp3/wav/m4a/ogg/flac）')
    } finally {
      busy.type = null
      busy.progress = 0
    }
  }

  // ---- 选区 ----
  /** 在 ±20ms 范围寻找最近的上升沿零交叉采样点 */
  function findZeroCrossing(channel: Float32Array, target: number, radius: number): number {
    const lo = Math.max(1, target - radius)
    const hi = Math.min(channel.length - 1, target + radius)
    let best = -1
    let bestDist = Infinity
    for (let i = lo; i <= hi; i++) {
      if (channel[i - 1] <= 0 && channel[i] > 0) {
        const dist = Math.abs(i - target)
        if (dist < bestDist) {
          bestDist = dist
          best = i
        }
      }
    }
    return best >= 0 ? best : target
  }

  function setSelection(start: number, end: number): void {
    const dur = duration.value
    let s = snapTime(Math.min(start, end))
    let e = snapTime(Math.max(start, end))
    s = clamp(s, 0, dur)
    e = clamp(e, 0, dur)
    const buf = buffer.value
    if (zeroSnap.value && buf && buf.length > 2) {
      const sr = buf.sampleRate
      const radius = Math.round(sr * 0.02)
      const ch = buf.getChannelData(0)
      s = clamp(findZeroCrossing(ch, Math.round(s * sr), radius) / sr, 0, dur)
      e = clamp(findZeroCrossing(ch, Math.round(e * sr), radius) / sr, 0, dur)
    }
    selection.start = s
    selection.end = e
    syncLoopRange()
  }

  function setSelectionRaw(start: number, end: number): void {
    selection.start = start
    selection.end = end
    syncLoopRange()
  }

  function clearSelection(): void {
    selection.start = 0
    selection.end = 0
    syncLoopRange()
  }

  // ---- 剪辑操作 ----
  function trim(): void {
    if (!buffer.value || !hasSelection.value) return
    pushHistory()
    const sr = buffer.value.sampleRate
    const channels = sliceChannels(
      getAllChannels(buffer.value),
      Math.floor(selection.start * sr),
      Math.floor(selection.end * sr)
    )
    applyChannels(channels, sr)
    clearSelection()
    scrollX.value = 0
    toast.push('success', '已裁剪至选区')
  }

  function deleteRegion(): void {
    if (!buffer.value || !hasSelection.value) return
    const sr = buffer.value.sampleRate
    const all = getAllChannels(buffer.value)
    const s = Math.floor(selection.start * sr)
    const e = Math.floor(selection.end * sr)
    const merged = concatChannels(sliceChannels(all, 0, s), sliceChannels(all, e, buffer.value.length))
    if (merged.length === 0 || merged[0].length === 0) {
      toast.push('error', '不能删除整条音轨，请使用裁剪或重新导入')
      return
    }
    pushHistory()
    applyChannels(merged, sr)
    clearSelection()
    toast.push('success', '已删除选区')
  }

  function silence(): void {
    if (!buffer.value || !hasSelection.value) return
    pushHistory()
    const sr = buffer.value.sampleRate
    const s = Math.floor(selection.start * sr)
    const e = Math.floor(selection.end * sr)
    const channels = getAllChannels(buffer.value).map((c) => c.slice())
    for (const c of channels) c.fill(0, s, e)
    applyChannels(channels, sr)
    toast.push('success', '选区已静音')
  }

  /** 淡入增益曲线：t ∈ [0,1]，返回 0→1 */
  function curveValue(curve: FadeCurve, t: number): number {
    switch (curve) {
      case 'linear':
        return t
      case 'exponential': {
        const k = 4
        return (Math.exp(k * t) - 1) / (Math.exp(k) - 1)
      }
      case 'logarithmic': {
        const k = 4
        return Math.log1p(k * t) / Math.log1p(k)
      }
      default:
        return 0.5 * (1 - Math.cos(Math.PI * t))
    }
  }

  function applyFade(kind: 'in' | 'out', curve: FadeCurve): void {
    if (!buffer.value) return
    if (!hasSelection.value) {
      toast.push('info', '请先框选需要淡入/淡出的区域')
      return
    }
    pushHistory()
    const sr = buffer.value.sampleRate
    const s = Math.floor(selection.start * sr)
    const e = Math.floor(selection.end * sr)
    const channels = getAllChannels(buffer.value).map((c) => c.slice())
    const len = e - s
    for (const c of channels) {
      for (let i = 0; i < len; i++) {
        const t = len <= 1 ? 1 : i / (len - 1)
        const gain = kind === 'in' ? curveValue(curve, t) : curveValue(curve, 1 - t)
        c[s + i] *= gain
      }
    }
    applyChannels(channels, sr)
    toast.push('success', kind === 'in' ? '已应用淡入' : '已应用淡出')
  }

  function fadeIn(curve: FadeCurve = 'cosine'): void {
    applyFade('in', curve)
  }

  function fadeOut(curve: FadeCurve = 'cosine'): void {
    applyFade('out', curve)
  }

  // ---- 插入静音 / 复制剪切粘贴 ----
  function insertSilence(seconds: number): void {
    const buf = buffer.value
    if (!buf || busy.type) return
    const secs = clamp(seconds, 0.05, 60)
    const sr = buf.sampleRate
    const atSec = hasSelection.value
      ? selection.start
      : clamp(audioEngine.getPosition(), 0, buf.duration)
    const at = Math.floor(atSec * sr)
    pushHistory()
    const all = getAllChannels(buf)
    const silence = all.map(() => new Float32Array(Math.round(secs * sr)))
    const merged = concatChannels(
      concatChannels(sliceChannels(all, 0, at), silence),
      sliceChannels(all, at, buf.length)
    )
    applyChannels(merged, sr)
    const endSec = Math.min(duration.value, atSec + secs)
    setSelection(atSec, endSec)
    audioEngine.seek(endSec)
    toast.push('success', `已在 ${atSec.toFixed(1)}s 插入 ${secs.toFixed(1)}s 静音`)
  }

  function snapshotSelection(): ClipboardData | null {
    const buf = buffer.value
    if (!buf || !hasSelection.value) return null
    const sr = buf.sampleRate
    return {
      channels: sliceChannels(
        getAllChannels(buf),
        Math.floor(selection.start * sr),
        Math.floor(selection.end * sr)
      ),
      sampleRate: sr
    }
  }

  function copySelection(): void {
    const data = snapshotSelection()
    if (!data) {
      toast.push('info', '请先在波形上框选要复制的区域')
      return
    }
    clipboard = data
    hasClipboard.value = true
    toast.push('success', `已复制 ${(data.channels[0].length / data.sampleRate).toFixed(1)}s 选区`)
  }

  function cutSelection(): void {
    const data = snapshotSelection()
    if (!data) {
      toast.push('info', '请先在波形上框选要剪切的区域')
      return
    }
    const buf = buffer.value!
    const sr = buf.sampleRate
    const all = getAllChannels(buf)
    const s = Math.floor(selection.start * sr)
    const e = Math.floor(selection.end * sr)
    const merged = concatChannels(sliceChannels(all, 0, s), sliceChannels(all, e, buf.length))
    if (merged.length === 0 || merged[0].length === 0) {
      toast.push('error', '不能剪切整条音轨')
      return
    }
    clipboard = data
    hasClipboard.value = true
    pushHistory()
    applyChannels(merged, sr)
    clearSelection()
    toast.push('success', '已剪切选区')
  }

  async function pasteAtPlayhead(): Promise<void> {
    const buf = buffer.value
    if (!buf || !clipboard || busy.type) return
    const sr = buf.sampleRate
    let clip = convertChannels(
      clipboard.channels.map((c) => c.slice()),
      buf.numberOfChannels <= 1 ? 'mono' : 'stereo'
    )
    if (clipboard.sampleRate !== sr) {
      clip = await resampleChannels(clip, clipboard.sampleRate, sr)
    }
    const atSec = hasSelection.value
      ? selection.start
      : clamp(audioEngine.getPosition(), 0, buf.duration)
    const at = Math.floor(atSec * sr)
    pushHistory()
    const all = getAllChannels(buf)
    const merged = concatChannels(
      concatChannels(sliceChannels(all, 0, at), clip),
      sliceChannels(all, at, buf.length)
    )
    applyChannels(merged, sr)
    const endSec = Math.min(duration.value, atSec + clip[0].length / sr)
    setSelection(atSec, endSec)
    audioEngine.seek(endSec)
    toast.push('success', `已粘贴到 ${atSec.toFixed(1)}s`)
  }

  // ---- 增益 / 归一化 ----
  function scaleRegion(gain: number, onlySelection: boolean, message: string): boolean {
    const buf = buffer.value
    if (!buf || busy.type) return false
    const sr = buf.sampleRate
    const useSel = onlySelection && hasSelection.value
    const s = useSel ? Math.floor(selection.start * sr) : 0
    const e = useSel ? Math.floor(selection.end * sr) : buf.length
    const channels = getAllChannels(buf).map((c) => c.slice())
    let peak = 0
    for (const c of channels) {
      for (let i = s; i < e; i++) {
        const v = c[i] * gain
        c[i] = v
        const a = Math.abs(v)
        if (a > peak) peak = a
      }
    }
    pushHistory()
    applyChannels(channels, sr)
    if (peak > 1) {
      toast.push('info', `${message}完成；峰值 ${(20 * Math.log10(peak)).toFixed(1)} dBFS 超过 0 dBFS，导出时会被限幅`)
    } else {
      toast.push('success', `${message}完成`)
    }
    return true
  }

  function setGainDb(db: number, onlySelection: boolean): void {
    if (!Number.isFinite(db) || db < -96 || db > 24) {
      toast.push('info', '增益范围 -96 ~ +24 dB')
      return
    }
    scaleRegion(Math.pow(10, db / 20), onlySelection, `增益 ${db > 0 ? '+' : ''}${db.toFixed(1)} dB `)
  }

  function normalize(onlySelection: boolean): void {
    const buf = buffer.value
    if (!buf || busy.type) return
    const sr = buf.sampleRate
    const useSel = onlySelection && hasSelection.value
    const s = useSel ? Math.floor(selection.start * sr) : 0
    const e = useSel ? Math.floor(selection.end * sr) : buf.length
    let peak = 0
    for (const c of getAllChannels(buf)) {
      for (let i = s; i < e; i++) {
        const a = Math.abs(c[i])
        if (a > peak) peak = a
      }
    }
    if (peak < 1e-6) {
      toast.push('error', useSel ? '选区为静音，无法归一化' : '音轨为静音，无法归一化')
      return
    }
    const target = Math.pow(10, -1 / 20)
    scaleRegion(
      target / peak,
      onlySelection,
      `归一化至 -1 dBFS（原峰值 ${(20 * Math.log10(peak)).toFixed(1)} dBFS）`
    )
  }

  // ---- EQ / 压缩（OfflineAudioContext） ----
  async function applyEffects(settings: EffectSettings, onlySelection: boolean): Promise<void> {
    const buf = buffer.value
    if (!buf || busy.type) return
    const sr = buf.sampleRate
    const useSel = onlySelection && hasSelection.value
    const s = useSel ? Math.floor(selection.start * sr) : 0
    const e = useSel ? Math.floor(selection.end * sr) : buf.length
    if (e - s < 16) {
      toast.push('error', '处理区域过短')
      return
    }
    const region = sliceChannels(getAllChannels(buf), s, e)
    pushHistory()
    busy.type = 'effects'
    busy.progress = 10
    try {
      const processed = await renderEffects(region, sr, settings)
      busy.progress = 100
      let finalChannels = processed
      if (useSel) {
        const all = getAllChannels(buf)
        finalChannels = concatChannels(
          concatChannels(sliceChannels(all, 0, s), processed),
          sliceChannels(all, e, buf.length)
        )
      }
      applyChannels(finalChannels, sr)
      clearSelection()
      toast.push('success', '效果处理完成')
    } catch (err) {
      console.error(err)
      past.pop()
      historyVersion.value++
      toast.push('error', '效果处理失败')
    } finally {
      busy.type = null
      busy.progress = 0
    }
  }

  // ---- 门限降噪（Worker） ----
  async function applyGate(thresholdDb: number, onlySelection: boolean): Promise<void> {
    const buf = buffer.value
    if (!buf || busy.type) return
    const sr = buf.sampleRate
    const useSel = onlySelection && hasSelection.value
    const s = useSel ? Math.floor(selection.start * sr) : 0
    const e = useSel ? Math.floor(selection.end * sr) : buf.length
    if (e - s < 16) {
      toast.push('error', '处理区域过短')
      return
    }
    const region = sliceChannels(getAllChannels(buf), s, e)
    pushHistory()
    busy.type = 'gate'
    busy.progress = 0
    try {
      const result = await runWorkerTask<{ channels: Float32Array[] }>(
        getProcessWorker(),
        { type: 'gate', channels: region, sampleRate: sr, thresholdDb },
        region.map((c) => c.buffer as ArrayBuffer),
        (p) => {
          busy.progress = p
        }
      )
      let finalChannels = result.channels
      if (useSel) {
        const all = getAllChannels(buf)
        finalChannels = concatChannels(
          concatChannels(sliceChannels(all, 0, s), result.channels),
          sliceChannels(all, e, buf.length)
        )
      }
      applyChannels(finalChannels, sr)
      clearSelection()
      toast.push('success', `门限降噪完成（阈值 ${thresholdDb} dB）`)
    } catch (err) {
      console.error(err)
      past.pop()
      historyVersion.value++
      toast.push('error', '门限降噪失败')
    } finally {
      busy.type = null
      busy.progress = 0
    }
  }

  // ---- 变速（WSOLA Worker） ----
  async function timeStretch(ratio: number, keepPitch: boolean, onlySelection: boolean): Promise<void> {
    const buf = buffer.value
    if (!buf || busy.type) return
    if (Math.abs(ratio - 1) < 0.001) {
      toast.push('info', '速度为 1.00x，无需处理')
      return
    }
    const sr = buf.sampleRate
    const useSel = onlySelection && hasSelection.value
    const s = useSel ? Math.floor(selection.start * sr) : 0
    const e = useSel ? Math.floor(selection.end * sr) : buf.length
    if (e - s < sr * 0.05) {
      toast.push('error', '选区过短（< 0.05s），无法变速')
      return
    }
    pushHistory()
    busy.type = 'stretch'
    busy.progress = 0
    try {
      const region = sliceChannels(getAllChannels(buf), s, e)
      const result = await runWorkerTask<{ channels: Float32Array[] }>(
        getProcessWorker(),
        { type: 'time-stretch', channels: region, sampleRate: sr, ratio, keepPitch },
        region.map((c) => c.buffer as ArrayBuffer),
        (p) => {
          busy.progress = p
        }
      )
      let finalChannels = result.channels
      if (useSel) {
        const all = getAllChannels(buf)
        finalChannels = concatChannels(
          concatChannels(sliceChannels(all, 0, s), result.channels),
          sliceChannels(all, e, buf.length)
        )
      }
      applyChannels(finalChannels, sr)
      clearSelection()
      toast.push('success', `变速完成：${ratio.toFixed(2)}x${keepPitch ? '（保持音调）' : ''}`)
    } catch (err) {
      console.error(err)
      past.pop()
      historyVersion.value++
      toast.push('error', '变速处理失败')
    } finally {
      busy.type = null
      busy.progress = 0
    }
  }

  // ---- 合并（Worker） ----
  async function mergeClips(clips: MergeClipInput[], gapSeconds: number, crossfadeSeconds: number): Promise<void> {
    if (clips.length === 0 || busy.type) return
    pushHistory()
    busy.type = 'merge'
    busy.progress = 0
    try {
      const targetRate = buffer.value?.sampleRate ?? clips[0].sampleRate
      const targetChannels = Math.min(2, buffer.value?.numberOfChannels ?? clips[0].channels.length)
      const mode = targetChannels === 1 ? 'mono' : 'stereo'
      const normalized: Float32Array[][] = []
      for (const clip of clips) {
        let ch = convertChannels(clip.channels, mode)
        if (clip.sampleRate !== targetRate) {
          ch = await resampleChannels(ch, clip.sampleRate, targetRate)
        }
        normalized.push(ch)
      }
      const result = await runWorkerTask<{ channels: Float32Array[] }>(
        getProcessWorker(),
        { type: 'merge', clips: normalized, gapSeconds, crossfadeSeconds, sampleRate: targetRate },
        normalized.flat().map((c) => c.buffer as ArrayBuffer),
        (p) => {
          busy.progress = p
        }
      )
      applyChannels(result.channels, targetRate)
      clearSelection()
      scrollX.value = 0
      fileName.value = fileName.value ? `${fileName.value}-merged` : 'merged'
      toast.push('success', `已合并 ${clips.length} 个片段并替换当前音轨`)
    } catch (err) {
      console.error(err)
      past.pop()
      historyVersion.value++
      toast.push('error', '合并失败')
    } finally {
      busy.type = null
      busy.progress = 0
    }
  }

  // ---- 撤销 / 重做 ----
  function undo(): void {
    const snap = past.pop()
    if (!snap) return
    if (buffer.value) future.push(takeSnapshot())
    if (future.length > MAX_HISTORY) future.shift()
    applyChannels(snap.channels, snap.sampleRate)
    historyVersion.value++
  }

  function redo(): void {
    const snap = future.pop()
    if (!snap) return
    if (buffer.value) past.push(takeSnapshot())
    if (past.length > MAX_HISTORY) past.shift()
    applyChannels(snap.channels, snap.sampleRate)
    historyVersion.value++
  }

  // ---- 播放控制 ----
  function togglePlay(): void {
    if (!buffer.value) return
    if (audioEngine.isPlaying) {
      audioEngine.pause()
      isPlaying.value = false
      return
    }
    syncLoopRange()
    let from = audioEngine.getPosition()
    if (from >= duration.value - 0.01) {
      from = isLooping.value && hasSelection.value ? selection.start : 0
    }
    audioEngine.play(from)
    isPlaying.value = true
  }

  function stop(): void {
    stopPlayback()
  }

  function seek(t: number): void {
    audioEngine.seek(t)
  }

  function setVolume(v: number): void {
    volume.value = v
    audioEngine.setVolume(v)
  }

  function toggleLoop(): void {
    isLooping.value = !isLooping.value
    audioEngine.setLoop(isLooping.value)
    syncLoopRange()
  }

  return {
    buffer,
    peakCache,
    fileName,
    selection,
    zoom,
    scrollX,
    vGain,
    zeroSnap,
    hasClipboard,
    pendingView,
    isPlaying,
    isLooping,
    volume,
    sidebarTab,
    busy,
    duration,
    hasSelection,
    canUndo,
    canRedo,
    loadFile,
    loadDecodedBuffer,
    setSelection,
    setSelectionRaw,
    clearSelection,
    trim,
    deleteRegion,
    silence,
    fadeIn,
    fadeOut,
    insertSilence,
    copySelection,
    cutSelection,
    pasteAtPlayhead,
    setGainDb,
    normalize,
    applyEffects,
    applyGate,
    timeStretch,
    mergeClips,
    undo,
    redo,
    togglePlay,
    stop,
    seek,
    setVolume,
    toggleLoop
  }
})
