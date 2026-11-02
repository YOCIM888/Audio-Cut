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

export interface Snapshot {
  channels: Float32Array[]
  sampleRate: number
}

export interface MergeClipInput {
  name: string
  channels: Float32Array[]
  sampleRate: number
}

export type SidebarTab = 'edit' | 'speed' | 'merge' | 'export'
export type BusyType = 'decode' | 'stretch' | 'merge' | null

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

  // ---- 导入 ----
  async function loadFile(file: File): Promise<void> {
    if (busy.type) return
    busy.type = 'decode'
    try {
      const ctx = audioEngine.ensureContext()
      const bytes = await file.arrayBuffer()
      const decoded = await ctx.decodeAudioData(bytes)
      stopPlayback()
      past.length = 0
      future.length = 0
      historyVersion.value++
      buffer.value = decoded
      peakCache.value = new PeakCache(decoded)
      fileName.value = file.name.replace(/\.[^.]+$/, '')
      audioEngine.setBuffer(decoded)
      selection.start = 0
      selection.end = 0
      scrollX.value = 0
      syncLoopRange()
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
  function setSelection(start: number, end: number): void {
    const dur = duration.value
    let s = snapTime(Math.min(start, end))
    let e = snapTime(Math.max(start, end))
    s = clamp(s, 0, dur)
    e = clamp(e, 0, dur)
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

  function applyFade(kind: 'in' | 'out'): void {
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
        const gain = kind === 'in' ? 0.5 * (1 - Math.cos(Math.PI * t)) : 0.5 * (1 + Math.cos(Math.PI * t))
        c[s + i] *= gain
      }
    }
    applyChannels(channels, sr)
    toast.push('success', kind === 'in' ? '已应用淡入' : '已应用淡出')
  }

  function fadeIn(): void {
    applyFade('in')
  }

  function fadeOut(): void {
    applyFade('out')
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
    setSelection,
    setSelectionRaw,
    clearSelection,
    trim,
    deleteRegion,
    silence,
    fadeIn,
    fadeOut,
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
