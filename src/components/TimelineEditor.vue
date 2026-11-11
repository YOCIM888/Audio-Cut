<script setup lang="ts">
/**
 * 多轨时间线视图。
 *
 * 左侧是可编辑的轨道头（M/S、增益、声像），右侧 Canvas 按时间轴绘制主轨与所有片段；
 * 与波形视图共用 editor.zoom / scrollX，因此来回切换时位置不跳。
 * 片段支持拖动改起点、跨轨移动、拖左右边缘非破坏性裁剪，全部可 Ctrl+Z。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useEditorStore } from '../stores/editor'
import { audioEngine } from '../audio/engine'
import { clamp, formatTime, getAllChannels } from '../utils/audio-utils'
import { computeClipPeaks } from '../audio/mixdown'
import { clampClipTimes, MAIN_TRACK_ID, type Clip, type MultitrackState } from '../audio/multitrack'

const editor = useEditorStore()

const RULER_H = 28
const LANE_H = 78
const HEADER_W = 176
const MIN_ZOOM = 0.5
const MAX_ZOOM = 20000

const scroller = ref<HTMLDivElement | null>(null)
const canvasWrap = ref<HTMLDivElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const overlayCanvas = ref<HTMLCanvasElement | null>(null)
let ctx: CanvasRenderingContext2D | null = null
let ovCtx: CanvasRenderingContext2D | null = null
let observer: ResizeObserver | null = null
let raf = 0
let cssW = 0
let cssH = 0
let dpr = 1
let overlayDirty = true
let lastHeadX = Number.NaN
let hoverX: number | null = null
let draggingBefore: MultitrackState | null = null

const peakCacheMap = new Map<string, { min: Float32Array; max: Float32Array }>()

type DragMode = 'none' | 'move' | 'trim-l' | 'trim-r' | 'range' | 'seek'
let dragMode: DragMode = 'none'
let dragClipId = ''
let grabOffset = 0
let downTime = 0

const totalHeight = computed(() => RULER_H + editor.tracks.length * LANE_H)
const timeToX = (t: number) => t * editor.zoom - editor.scrollX
const xToTime = (x: number) => (x + editor.scrollX) / editor.zoom
const maxScroll = () => Math.max(0, editor.timelineLength * editor.zoom - cssW)
const gridLabel = computed(() =>
  editor.snapGrid === 0 ? '采样点' : editor.snapGrid < 0.01 ? `${editor.snapGrid * 1000} ms` : `${editor.snapGrid} s`
)
const snap = (t: number) => {
  const g = editor.snapGrid
  return Math.max(0, g > 0 ? Math.round(t / g) * g : t)
}

function clampScroll(): void {
  editor.scrollX = clamp(editor.scrollX, 0, maxScroll())
}

function resize(): void {
  const el = canvasWrap.value
  const c = canvas.value
  const ov = overlayCanvas.value
  if (!el || !c || !ov) return
  dpr = window.devicePixelRatio || 1
  cssW = Math.max(1, el.clientWidth)
  cssH = totalHeight.value
  for (const target of [c, ov]) {
    target.width = Math.round(cssW * dpr)
    target.height = Math.round(cssH * dpr)
    target.style.width = `${cssW}px`
    target.style.height = `${cssH}px`
  }
  ctx = c.getContext('2d')
  ovCtx = ov.getContext('2d')
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
  ovCtx?.setTransform(dpr, 0, 0, dpr, 0, 0)
  clampScroll()
  peakCacheMap.clear()
  draw()
}

function laneY(index: number): number {
  return RULER_H + index * LANE_H
}

function drawRuler(): void {
  const c = ctx
  if (!c) return
  c.fillStyle = 'rgba(7,11,20,0.95)'
  c.fillRect(0, 0, cssW, RULER_H)
  c.strokeStyle = 'rgba(34,211,238,0.25)'
  c.beginPath()
  c.moveTo(0, RULER_H - 0.5)
  c.lineTo(cssW, RULER_H - 0.5)
  c.stroke()
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600]
  const step = steps.find((s) => s * editor.zoom >= 80) ?? 3600
  const minor = step / 5
  const i0 = Math.floor(xToTime(0) / minor)
  const i1 = Math.ceil(xToTime(cssW) / minor)
  c.font = '10px ui-monospace, monospace'
  c.textAlign = 'left'
  for (let i = i0; i <= i1; i++) {
    const t = i * minor
    const x = Math.round(timeToX(t)) + 0.5
    const major = i % 5 === 0
    c.strokeStyle = major ? 'rgba(34,211,238,0.55)' : 'rgba(34,211,238,0.2)'
    c.beginPath()
    c.moveTo(x, RULER_H)
    c.lineTo(x, RULER_H - (major ? 10 : 5))
    c.stroke()
    if (major) {
      c.fillStyle = 'rgba(148,163,184,0.9)'
      c.fillText(formatTime(t), x + 3, 11)
    }
  }
}

function drawGrid(): void {
  const c = ctx
  if (!c) return
  const g = editor.snapGrid
  if (g > 0 && g * editor.zoom >= 9) {
    const t0 = Math.max(0, Math.floor(xToTime(0) / g) * g)
    const t1 = Math.min(editor.timelineLength, xToTime(cssW))
    c.strokeStyle = 'rgba(148,163,184,0.09)'
    c.beginPath()
    for (let t = t0; t <= t1; t += g) {
      const x = Math.round(timeToX(t)) + 0.5
      c.moveTo(x, RULER_H)
      c.lineTo(x, cssH)
    }
    c.stroke()
  }
}

function drawMainLane(trackIndex: number, color: string): void {
  const c = ctx
  const buf = editor.buffer
  if (!c || !buf) return
  const y = laneY(trackIndex)
  const x0 = timeToX(0)
  const x1 = timeToX(buf.duration)
  const l = Math.max(0, x0)
  const r = Math.min(cssW, x1)
  if (r <= l) return
  c.fillStyle = `${color}22`
  c.fillRect(l, y + 6, r - l, LANE_H - 12)
  c.strokeStyle = `${color}99`
  c.lineWidth = 1
  c.strokeRect(l + 0.5, y + 6.5, Math.max(0, r - l - 1), LANE_H - 13)

  const mid = y + LANE_H / 2
  const amp = LANE_H / 2 - 12
  const cache = editor.peakCache
  c.save()
  c.beginPath()
  c.rect(l, y + 6, r - l, LANE_H - 12)
  c.clip()
  if (cache) {
    const spp = buf.sampleRate / editor.zoom
    const { min, max, samplesPerBucket } = cache.pick(spp)
    const path = new Path2D()
    for (let x = Math.floor(l); x < Math.ceil(r); x++) {
      const t = xToTime(x)
      const s0 = Math.floor(t * buf.sampleRate)
      const s1 = Math.ceil(xToTime(x + 1) * buf.sampleRate)
      if (s1 <= 0 || s0 >= buf.length) continue
      const b0 = Math.max(0, Math.floor(s0 / samplesPerBucket))
      const b1 = Math.min(min.length - 1, Math.floor(Math.max(s0, s1 - 1) / samplesPerBucket))
      let mn = Infinity
      let mx = -Infinity
      for (let b = b0; b <= b1; b++) {
        if (min[b] < mn) mn = min[b]
        if (max[b] > mx) mx = max[b]
      }
      if (!Number.isFinite(mn)) continue
      path.moveTo(x + 0.5, mid - mx * amp)
      path.lineTo(x + 0.5, mid - mn * amp)
    }
    c.strokeStyle = `${color}cc`
    c.stroke(path)
  } else {
    const ch = getAllChannels(buf)[0]
    if (!ch) return
    const per = buf.length / Math.max(1, x1 - x0)
    const path = new Path2D()
    for (let x = Math.floor(l); x < Math.ceil(r); x++) {
      const a = Math.max(0, Math.floor(xToTime(x) * buf.sampleRate))
      const b = Math.min(ch.length, a + Math.max(1, Math.floor(per)))
      let mn = Infinity
      let mx = -Infinity
      const stride = Math.max(1, Math.floor((b - a) / 64))
      for (let i = a; i < b; i += stride) {
        if (ch[i] < mn) mn = ch[i]
        if (ch[i] > mx) mx = ch[i]
      }
      if (!Number.isFinite(mn)) continue
      path.moveTo(x + 0.5, mid - mx * amp)
      path.lineTo(x + 0.5, mid - mn * amp)
    }
    c.strokeStyle = `${color}cc`
    c.stroke(path)
  }
  c.restore()
  c.fillStyle = 'rgba(4,6,12,0.82)'
  c.fillRect(l + 4, y + 10, 96, 15)
  c.fillStyle = color
  c.font = '10px ui-monospace, monospace'
  c.textAlign = 'left'
  c.fillText(`主轨 ${buf.duration.toFixed(1)}s`, l + 8, y + 21)
}

function clipPeaks(clip: Clip, width: number) {
  const cols = Math.max(2, Math.round(width))
  const key = `${clip.id}:${clip.offset.toFixed(4)}:${clip.duration.toFixed(4)}:${cols}`
  const hit = peakCacheMap.get(key)
  if (hit) return hit
  const value = computeClipPeaks(clip.channels, clip.sampleRate, clip.offset, clip.duration, cols)
  if (peakCacheMap.size > 200) peakCacheMap.clear()
  peakCacheMap.set(key, value)
  return value
}

function drawClip(clip: Clip, trackIndex: number, color: string): void {
  const c = ctx
  if (!c) return
  const y = laneY(trackIndex) + 6
  const x0 = timeToX(clip.start)
  const x1 = timeToX(clip.start + clip.duration)
  if (x1 <= 0 || x0 >= cssW) return
  const l = Math.max(0, x0)
  const r = Math.min(cssW, x1)
  const w = Math.max(1, r - l)
  const h = LANE_H - 12
  const selected = editor.selectedClipId === clip.id
  const audible = editor.audibleTracks.has(clip.trackId)

  c.save()
  c.globalAlpha = audible ? 1 : 0.45
  c.fillStyle = selected ? `${color}55` : `${color}2e`
  c.fillRect(l, y, w, h)
  c.strokeStyle = selected ? '#ecfeff' : `${color}bb`
  c.lineWidth = selected ? 1.8 : 1
  c.strokeRect(l + 0.5, y + 0.5, Math.max(1, w - 1), h - 1)

  c.save()
  c.beginPath()
  c.rect(l, y, w, h)
  c.clip()
  const { min, max } = clipPeaks(clip, Math.min(1600, w))
  const mid = y + h / 2 + 4
  const amp = h / 2 - 14
  const path = new Path2D()
  for (let i = 0; i < min.length; i++) {
    const x = l + (i / Math.max(1, min.length - 1)) * w
    path.moveTo(x, mid - max[i] * amp)
    path.lineTo(x, mid - min[i] * amp)
  }
  c.strokeStyle = color
  c.lineWidth = 1
  c.stroke(path)
  c.restore()

  // 淡入 / 淡出三角
  c.fillStyle = 'rgba(4,6,12,0.55)'
  const fi = Math.min(w / 2, (clip.fadeInMs / 1000) * editor.zoom)
  const fo = Math.min(w / 2, (clip.fadeOutMs / 1000) * editor.zoom)
  if (fi > 1) {
    c.beginPath()
    c.moveTo(l, y)
    c.lineTo(l + fi, y)
    c.lineTo(l, y + h)
    c.closePath()
    c.fill()
  }
  if (fo > 1) {
    c.beginPath()
    c.moveTo(r, y)
    c.lineTo(r - fo, y)
    c.lineTo(r, y + h)
    c.closePath()
    c.fill()
  }

  if (w > 42) {
    c.fillStyle = 'rgba(4,6,12,0.85)'
    c.fillRect(l + 2, y + 2, Math.min(w - 4, 160), 15)
    c.fillStyle = '#e2e8f0'
    c.font = '10px ui-monospace, monospace'
    c.textAlign = 'left'
    c.fillText(clip.name.slice(0, 26), l + 6, y + 13)
  }
  c.restore()
}

function drawOverlay(): void {
  const c = ovCtx
  if (!c) return
  c.clearRect(0, 0, cssW, cssH)
  // 选区
  if (editor.hasSelection) {
    const x1 = timeToX(editor.selection.start)
    const x2 = timeToX(editor.selection.end)
    c.fillStyle = 'rgba(34,211,238,0.10)'
    c.fillRect(x1, RULER_H, x2 - x1, cssH - RULER_H)
    c.strokeStyle = 'rgba(34,211,238,0.8)'
    c.beginPath()
    c.moveTo(x1 + 0.5, RULER_H)
    c.lineTo(x1 + 0.5, cssH)
    c.moveTo(x2 + 0.5, RULER_H)
    c.lineTo(x2 + 0.5, cssH)
    c.stroke()
  }
  // 标记线
  for (const m of editor.markers) {
    const x = timeToX(m.time)
    if (x < 0 || x > cssW) continue
    c.save()
    c.setLineDash([4, 4])
    c.strokeStyle = 'rgba(251,191,36,0.7)'
    c.beginPath()
    c.moveTo(x + 0.5, RULER_H)
    c.lineTo(x + 0.5, cssH)
    c.stroke()
    c.restore()
  }
  // 悬停游标
  if (hoverX !== null) {
    c.save()
    c.setLineDash([3, 3])
    c.strokeStyle = 'rgba(148,163,184,0.45)'
    c.beginPath()
    c.moveTo(Math.round(hoverX) + 0.5, RULER_H)
    c.lineTo(Math.round(hoverX) + 0.5, cssH)
    c.stroke()
    c.restore()
  }
  // 播放头
  const x = Math.round(timeToX(audioEngine.getPosition())) + 0.5
  if (x >= -4 && x <= cssW + 4) {
    c.save()
    c.shadowColor = 'rgba(103,232,249,0.9)'
    c.shadowBlur = 8
    c.strokeStyle = '#a5f3fc'
    c.lineWidth = 1.5
    c.beginPath()
    c.moveTo(x, 0)
    c.lineTo(x, cssH)
    c.stroke()
    c.restore()
  }
}

/** 底层（标尺 + 轨道 + 片段）与上层（选区/播放头）分开画，暂停时不重复全量绘制 */
function drawStatic(): void {
  const c = ctx
  if (!c) return
  c.clearRect(0, 0, cssW, cssH)
  c.fillStyle = 'rgba(4,6,12,0.55)'
  c.fillRect(0, RULER_H, cssW, cssH - RULER_H)
  editor.tracks.forEach((t, i) => {
    const y = laneY(i)
    c.fillStyle = i % 2 ? 'rgba(15,23,42,0.35)' : 'rgba(2,6,23,0.35)'
    c.fillRect(0, y, cssW, LANE_H)
    c.strokeStyle = 'rgba(34,211,238,0.12)'
    c.beginPath()
    c.moveTo(0, y + LANE_H - 0.5)
    c.lineTo(cssW, y + LANE_H - 0.5)
    c.stroke()
    if (t.kind === 'main') drawMainLane(i, t.color)
  })
  drawGrid()
  editor.tracks.forEach((t, i) => {
    for (const clip of editor.clips) {
      if (clip.trackId === t.id) drawClip(clip, i, t.color)
    }
  })
  drawRuler()
  overlayDirty = true
  drawOverlay()
}

function draw(): void {
  drawStatic()
}

function frame(): void {
  const headX = Math.round(timeToX(audioEngine.getPosition()) * 2) / 2
  if (overlayDirty || editor.isPlaying || headX !== lastHeadX) {
    drawOverlay()
    overlayDirty = false
    lastHeadX = headX
  }
  if (editor.isPlaying) {
    const x = timeToX(audioEngine.getPosition())
    if (x < 0 || x > cssW) {
      editor.scrollX = audioEngine.getPosition() * editor.zoom - cssW * 0.15
      clampScroll()
      draw()
    }
  }
  raf = requestAnimationFrame(frame)
}

// ---------- 交互 ----------
function trackIndexAt(y: number): number {
  return clamp(Math.floor((y - RULER_H) / LANE_H), 0, Math.max(0, editor.tracks.length - 1))
}

function clipAt(x: number, y: number): Clip | null {
  const i = trackIndexAt(y)
  const track = editor.tracks[i]
  if (!track || track.kind === 'main') return null
  const t = xToTime(x)
  const list = editor.clips.filter((c) => c.trackId === track.id)
  // 逆序：后画的在上层，优先命中
  for (let k = list.length - 1; k >= 0; k--) {
    const c = list[k]
    if (t >= c.start && t <= c.start + c.duration) return c
  }
  return null
}

function onPointerDown(e: PointerEvent): void {
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)
  const x = e.offsetX
  const y = e.offsetY
  downTime = xToTime(x)
  dragMode = 'none'
  if (y < RULER_H) {
    dragMode = 'seek'
    editor.seek(snap(clamp(downTime, 0, editor.timelineLength)))
    return
  }
  const hit = clipAt(x, y)
  if (hit) {
    editor.selectClip(hit.id)
    grabOffset = downTime - hit.start
    dragClipId = hit.id
    const xl = timeToX(hit.start)
    const xr = timeToX(hit.start + hit.duration)
    if (Math.abs(x - xl) <= 6) dragMode = 'trim-l'
    else if (Math.abs(x - xr) <= 6) dragMode = 'trim-r'
    else dragMode = 'move'
    draggingBefore = editor.beginClipDrag()
    editor.setTimelineDragging(true)
    return
  }
  editor.selectClip(null)
  if (e.shiftKey) {
    dragMode = 'range'
    editor.setSelection(downTime, downTime)
  } else {
    dragMode = 'seek'
    editor.seek(snap(clamp(downTime, 0, editor.timelineLength)))
  }
}

function onPointerMove(e: PointerEvent): void {
  const x = e.offsetX
  hoverX = x
  if (dragMode === 'none') {
    overlayDirty = true
    return
  }
  const t = xToTime(x)
  if (dragMode === 'seek') {
    editor.seek(snap(clamp(t, 0, editor.timelineLength)))
    overlayDirty = true
    return
  }
  if (dragMode === 'range') {
    editor.setSelection(downTime, t)
    overlayDirty = true
    return
  }
  if (!draggingBefore) return
  const current = editor.clips.find((c) => c.id === dragClipId)
  if (!current) return
  const next = editor.clips.slice()
  const idx = next.findIndex((c) => c.id === dragClipId)
  const targetTrack = editor.tracks[trackIndexAt(e.offsetY)]
  const trackId = targetTrack && targetTrack.kind === 'audio' ? targetTrack.id : current.trackId
  let patch: Partial<Clip>
  if (dragMode === 'move') {
    patch = { start: Math.max(0, snap(t - grabOffset)), trackId }
  } else if (dragMode === 'trim-l') {
    const end = current.start + current.duration
    const ns = clamp(snap(t), 0, end - 0.01)
    const delta = ns - current.start
    patch = { start: ns, offset: current.offset + delta, duration: current.duration - delta }
  } else {
    patch = { duration: Math.max(0.01, snap(t) - current.start) }
  }
  const times = clampClipTimes(current, patch)
  next[idx] = { ...current, ...times, trackId }
  editor.previewClips(next)
  overlayDirty = true
}

function onPointerUp(): void {
  if (draggingBefore) {
    editor.commitClipDrag(draggingBefore)
    draggingBefore = null
  }
  if (dragMode === 'move' || dragMode === 'trim-l' || dragMode === 'trim-r') {
    editor.setTimelineDragging(false)
  }
  dragMode = 'none'
  dragClipId = ''
  overlayDirty = true
}

function onPointerLeave(): void {
  if (dragMode === 'none') {
    hoverX = null
    overlayDirty = true
  }
}

function onWheel(e: WheelEvent): void {
  e.preventDefault()
  if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
    editor.scrollX += delta
    clampScroll()
    draw()
    return
  }
  const factor = Math.exp(-e.deltaY * 0.0016)
  const fit = cssW / Math.max(0.001, editor.timelineLength)
  const z = clamp(editor.zoom * factor, Math.min(MIN_ZOOM, fit), Math.max(MAX_ZOOM, fit))
  const x = e.offsetX
  const t = (editor.scrollX + x) / editor.zoom
  editor.zoom = z
  editor.scrollX = t * z - x
  clampScroll()
  peakCacheMap.clear()
  draw()
}

function fitAll(): void {
  editor.zoom = clamp(cssW / Math.max(0.001, editor.timelineLength), MIN_ZOOM, MAX_ZOOM)
  editor.scrollX = 0
  clampScroll()
  peakCacheMap.clear()
  draw()
}

function zoomBy(factor: number): void {
  const center = xToTime(cssW / 2)
  editor.zoom = clamp(editor.zoom * factor, MIN_ZOOM, MAX_ZOOM)
  editor.scrollX = center * editor.zoom - cssW / 2
  clampScroll()
  peakCacheMap.clear()
  draw()
}

function splitSelected(): void {
  if (!editor.selectedClipId) return
  editor.splitClip(editor.selectedClipId, audioEngine.getPosition())
}

function deleteSelected(): void {
  if (!editor.selectedClipId) return
  editor.removeClip(editor.selectedClipId)
}

onMounted(() => {
  resize()
  observer = new ResizeObserver(resize)
  if (canvasWrap.value) observer.observe(canvasWrap.value)
  canvasWrap.value?.addEventListener('wheel', onWheel, { passive: false })
  raf = requestAnimationFrame(frame)
})
onBeforeUnmount(() => {
  observer?.disconnect()
  canvasWrap.value?.removeEventListener('wheel', onWheel)
  cancelAnimationFrame(raf)
})

watch(
  () => [editor.tracks, editor.clips, editor.zoom, editor.scrollX, editor.buffer, editor.peakVersion, editor.selection.start, editor.selection.end, editor.markers, editor.snapGrid, editor.chainTarget] as const,
  () => {
    if (canvas.value && cssH !== totalHeight.value) resize()
    else {
      overlayDirty = true
      draw()
    }
  }
)
</script>

<template>
  <div class="flex-1 min-h-0 flex flex-col bg-abyss-950/60">
    <!-- 工具条 -->
    <div class="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-neon/15 bg-abyss-900/70 text-[11px]">
      <span class="text-neon font-bold tracking-widest">多轨时间线</span>
      <span class="text-slate-500">{{ editor.tracks.length }} 轨 · {{ editor.clips.length }} 片段 · {{ editor.timelineLength.toFixed(1) }}s</span>
      <span class="text-slate-600">吸附 {{ gridLabel }}</span>
      <div class="ml-auto flex items-center gap-1.5">
        <button class="btn px-2 py-0.5 text-[10px]" @click="zoomBy(1 / 1.4)">−</button>
        <button class="btn px-2 py-0.5 text-[10px]" @click="fitAll">全览</button>
        <button class="btn px-2 py-0.5 text-[10px]" @click="zoomBy(1.4)">＋</button>
        <button class="btn px-2 py-0.5 text-[10px]" :disabled="!editor.selectedClip" @click="splitSelected">在播放头拆分</button>
        <button class="btn btn-danger px-2 py-0.5 text-[10px]" :disabled="!editor.selectedClip" @click="deleteSelected">删除片段</button>
        <button class="btn px-2 py-0.5 text-[10px]" @click="editor.addTrack()">＋ 轨道</button>
      </div>
    </div>

    <div ref="scroller" class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
      <div class="flex" :style="{ height: `${totalHeight}px` }">
        <!-- 轨道头 -->
        <div class="shrink-0 border-r border-neon/15 bg-abyss-900/80" :style="{ width: `${HEADER_W}px` }">
          <div class="flex items-end px-2 pb-1 text-[9px] text-slate-500" :style="{ height: `${RULER_H}px` }">轨道</div>
          <div
            v-for="t in editor.tracks"
            :key="t.id"
            class="border-t border-neon/10 px-2 py-1 flex flex-col justify-between"
            :class="{ 'opacity-50': !editor.audibleTracks.has(t.id) }"
            :style="{ height: `${LANE_H}px`, borderLeft: `3px solid ${t.color}` }"
          >
            <div class="flex items-center gap-1">
              <input
                class="field-input flex-1 !py-0 !px-1 !text-[10px] min-w-0"
                :value="t.name"
                :disabled="t.kind === 'main'"
                @change="editor.updateTrack(t.id, { name: ($event.target as HTMLInputElement).value })"
              />
              <button
                class="btn px-1 py-0 text-[9px]"
                :class="{ 'btn-primary': t.muted }"
                :title="t.muted ? '取消静音' : '静音'"
                @click="editor.updateTrack(t.id, { muted: !t.muted })"
              >M</button>
              <button
                class="btn px-1 py-0 text-[9px]"
                :class="{ 'btn-primary': t.solo }"
                :title="t.solo ? '取消独奏' : '独奏'"
                @click="editor.updateTrack(t.id, { solo: !t.solo })"
              >S</button>
              <button
                v-if="t.kind !== 'main'"
                class="btn btn-danger px-1 py-0 text-[9px]"
                title="删除轨道及其片段"
                @click="editor.removeTrack(t.id)"
              >×</button>
            </div>
            <div class="flex items-center gap-1">
              <span class="text-[9px] text-slate-600 w-4">dB</span>
              <input
                class="neon-range flex-1"
                type="range"
                min="-60"
                max="12"
                step="0.5"
                :value="t.gainDb"
                @input="editor.updateTrack(t.id, { gainDb: Number(($event.target as HTMLInputElement).value) })"
              />
              <span class="font-mono text-[9px] text-neon w-8 text-right">{{ t.gainDb.toFixed(1) }}</span>
            </div>
            <div class="flex items-center gap-1">
              <span class="text-[9px] text-slate-600 w-4">Pan</span>
              <input
                class="neon-range flex-1"
                type="range"
                min="-1"
                max="1"
                step="0.05"
                :value="t.pan"
                @input="editor.updateTrack(t.id, { pan: Number(($event.target as HTMLInputElement).value) })"
              />
              <span class="font-mono text-[9px] text-slate-400 w-8 text-right">{{ t.pan === 0 ? 'C' : (t.pan < 0 ? `L${Math.round(-t.pan * 100)}` : `R${Math.round(t.pan * 100)}`) }}</span>
            </div>
          </div>
        </div>

        <!-- 时间线画布 -->
        <div ref="canvasWrap" class="flex-1 min-w-0 relative">
          <canvas ref="canvas" class="absolute inset-0" />
          <canvas
            ref="overlayCanvas"
            class="absolute inset-0 touch-none"
            @pointerdown="onPointerDown"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointercancel="onPointerUp"
            @pointerleave="onPointerLeave"
          />
        </div>
      </div>
    </div>

    <div class="h-7 shrink-0 flex items-center gap-3 px-3 border-t border-neon/10 text-[10px] text-slate-600">
      <span>拖动片段改起点 / 跨轨；拖左右边缘裁剪；标尺点击定位；Shift 拖动框选时间</span>
      <span v-if="editor.selectedClip" class="text-neon-bright truncate">
        已选：{{ editor.selectedClip.name }} · {{ editor.selectedClip.start.toFixed(2) }}s → {{ (editor.selectedClip.start + editor.selectedClip.duration).toFixed(2) }}s
      </span>
      <span class="ml-auto">主轨 ID {{ MAIN_TRACK_ID }} · 效果链作用于{{ editor.chainTarget === 'main' ? '主轨' : '整个混音' }}</span>
    </div>
  </div>
</template>
