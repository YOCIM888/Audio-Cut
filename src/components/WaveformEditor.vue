<script setup lang="ts">
/**
 * 波形编辑器：
 *  - 双 Canvas：底层波形+时间标尺（按需重绘），上层选区+播放头（rAF 每帧重绘）
 *  - 峰值金字塔渲染，支持滚轮缩放（光标锚点）、横向滚动、0.1s 吸附框选、
 *    选区边缘拖拽、Shift 拖动选区、点击定位播放头、播放自动跟随
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useEditorStore } from '../stores/editor'
import { audioEngine } from '../audio/engine'
import { clamp, formatTime } from '../utils/audio-utils'

const editor = useEditorStore()

const wrap = ref<HTMLDivElement | null>(null)
const baseCanvas = ref<HTMLCanvasElement | null>(null)
const overlayCanvas = ref<HTMLCanvasElement | null>(null)

const RULER_H = 28
const MIN_PX_PER_SEC = 0.5
const MAX_PX_PER_SEC = 20000

let baseCtx: CanvasRenderingContext2D | null = null
let ovCtx: CanvasRenderingContext2D | null = null
let cssW = 0
let cssH = 0
let raf = 0
let resizeObserver: ResizeObserver | null = null

type DragMode = 'none' | 'maybe' | 'select' | 'edge-l' | 'edge-r' | 'move'
let dragMode: DragMode = 'none'
let anchorTime = 0
let moveGrabOffset = 0
let downX = 0
/** 悬停读数位置（CSS px），普通变量，不进入响应式 */
let hoverX: number | null = null

const timeToX = (t: number) => t * editor.zoom - editor.scrollX
const xToTime = (x: number) => (x + editor.scrollX) / editor.zoom
const maxScroll = () => Math.max(0, editor.duration * editor.zoom - cssW)
const snap = (t: number) => clamp(Math.round(t * 10) / 10, 0, editor.duration)

function clampScroll(): void {
  editor.scrollX = clamp(editor.scrollX, 0, maxScroll())
}

// ---------- 尺寸 ----------
function resize(): void {
  const el = wrap.value
  if (!el || !baseCanvas.value || !overlayCanvas.value) return
  const dpr = window.devicePixelRatio || 1
  cssW = el.clientWidth
  cssH = el.clientHeight
  for (const c of [baseCanvas.value, overlayCanvas.value]) {
    c.width = Math.max(1, Math.round(cssW * dpr))
    c.height = Math.max(1, Math.round(cssH * dpr))
    c.style.width = `${cssW}px`
    c.style.height = `${cssH}px`
  }
  baseCtx = baseCanvas.value.getContext('2d')
  ovCtx = overlayCanvas.value.getContext('2d')
  baseCtx?.setTransform(dpr, 0, 0, dpr, 0, 0)
  ovCtx?.setTransform(dpr, 0, 0, dpr, 0, 0)
  clampScroll()
  drawBase()
}

// ---------- 底层绘制 ----------
function drawBase(): void {
  const ctx = baseCtx
  if (!ctx) return
  ctx.clearRect(0, 0, cssW, cssH)
  drawRuler(ctx)
  if (!editor.buffer) {
    ctx.fillStyle = 'rgba(148,163,184,0.55)'
    ctx.font = '14px ui-monospace, monospace'
    ctx.textAlign = 'center'
    ctx.fillText('点击顶部「导入音频」或将音频文件拖拽到此处', cssW / 2, cssH / 2)
    return
  }
  drawWaveform(ctx)
}

function drawRuler(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = 'rgba(7,11,20,0.92)'
  ctx.fillRect(0, 0, cssW, RULER_H)
  ctx.strokeStyle = 'rgba(34,211,238,0.25)'
  ctx.beginPath()
  ctx.moveTo(0, RULER_H - 0.5)
  ctx.lineTo(cssW, RULER_H - 0.5)
  ctx.stroke()
  if (!editor.buffer) return

  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600]
  const step = steps.find((s) => s * editor.zoom >= 80) ?? 3600
  const minor = step / 5
  const i0 = Math.floor(xToTime(0) / minor)
  const i1 = Math.ceil(xToTime(cssW) / minor)
  ctx.font = '10px ui-monospace, monospace'
  ctx.textAlign = 'left'
  for (let i = i0; i <= i1; i++) {
    const t = i * minor
    const x = Math.round(timeToX(t)) + 0.5
    const major = i % 5 === 0
    ctx.strokeStyle = major ? 'rgba(34,211,238,0.55)' : 'rgba(34,211,238,0.22)'
    ctx.beginPath()
    ctx.moveTo(x, RULER_H)
    ctx.lineTo(x, RULER_H - (major ? 10 : 5))
    ctx.stroke()
    if (major) {
      ctx.fillStyle = 'rgba(148,163,184,0.9)'
      ctx.fillText(formatTime(t), x + 3, 11)
    }
  }
}

function drawWaveform(ctx: CanvasRenderingContext2D): void {
  const buf = editor.buffer
  const cache = editor.peakCache
  if (!buf) return
  const sr = buf.sampleRate
  const h = cssH - RULER_H
  const mid = RULER_H + h / 2
  const amp = (h / 2 - 8) * editor.vGain

  // 中线
  ctx.strokeStyle = 'rgba(34,211,238,0.18)'
  ctx.beginPath()
  ctx.moveTo(0, mid + 0.5)
  ctx.lineTo(cssW, mid + 0.5)
  ctx.stroke()

  const spp = sr / editor.zoom

  if (cache && spp >= cache.baseSamplesPerBucket) {
    // 峰值模式
    const { min, max, samplesPerBucket } = cache.pick(spp)
    const path = new Path2D()
    for (let x = 0; x < cssW; x++) {
      const s0 = Math.floor(xToTime(x) * sr)
      const s1 = Math.ceil(xToTime(x + 1) * sr)
      if (s1 <= 0 || s0 >= buf.length) continue
      const b0 = Math.max(0, Math.floor(s0 / samplesPerBucket))
      const b1 = Math.min(min.length - 1, Math.floor(Math.max(s0, s1 - 1) / samplesPerBucket))
      let mn = Infinity
      let mx = -Infinity
      for (let b = b0; b <= b1; b++) {
        if (min[b] < mn) mn = min[b]
        if (max[b] > mx) mx = max[b]
      }
      if (!Number.isFinite(mn) || !Number.isFinite(mx)) continue
      let yTop = mid - mx * amp
      let yBot = mid - mn * amp
      if (yBot - yTop < 1) {
        yTop = mid - 0.5
        yBot = mid + 0.5
      }
      path.moveTo(x + 0.5, yTop)
      path.lineTo(x + 0.5, yBot)
    }
    ctx.save()
    ctx.shadowColor = 'rgba(34,211,238,0.7)'
    ctx.shadowBlur = 12
    ctx.strokeStyle = 'rgba(34,211,238,0.85)'
    ctx.lineWidth = 1
    ctx.stroke(path)
    ctx.restore()
    ctx.strokeStyle = 'rgba(165,243,252,0.9)'
    ctx.stroke(path)
  } else {
    // 原始采样模式（极限放大）
    const chCount = Math.min(2, buf.numberOfChannels)
    const chH = h / chCount
    for (let c = 0; c < chCount; c++) {
      const data = buf.getChannelData(c)
      const cMid = RULER_H + chH * (c + 0.5)
      const cAmp = (chH / 2 - 6) * editor.vGain
      ctx.beginPath()
      let started = false
      for (let x = 0; x < cssW; x++) {
        const s0 = Math.floor(xToTime(x) * sr)
        const s1 = Math.max(s0 + 1, Math.ceil(xToTime(x + 1) * sr))
        if (s1 <= 0 || s0 >= buf.length) continue
        let mn = Infinity
        let mx = -Infinity
        for (let i = Math.max(0, s0); i < Math.min(buf.length, s1); i++) {
          const v = data[i]
          if (v < mn) mn = v
          if (v > mx) mx = v
        }
        if (!Number.isFinite(mn)) continue
        const y1 = cMid - mx * cAmp
        const y2 = cMid - mn * cAmp
        if (!started) {
          ctx.moveTo(x + 0.5, y1)
          started = true
        } else {
          ctx.lineTo(x + 0.5, y1)
        }
        ctx.lineTo(x + 0.5, y2)
      }
      ctx.strokeStyle = 'rgba(34,211,238,0.9)'
      ctx.lineWidth = 1
      ctx.stroke()
    }
  }
}

// ---------- 上层绘制（每帧） ----------
function drawOverlay(): void {
  const ctx = ovCtx
  if (!ctx) return
  ctx.clearRect(0, 0, cssW, cssH)
  if (!editor.buffer) return

  // 悬停游标线 + 时间读数
  if (hoverX !== null) {
    const hx = Math.round(hoverX) + 0.5
    ctx.save()
    ctx.setLineDash([4, 4])
    ctx.strokeStyle = 'rgba(148,163,184,0.5)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(hx, RULER_H)
    ctx.lineTo(hx, cssH)
    ctx.stroke()
    ctx.restore()

    const t = clamp(xToTime(hoverX), 0, editor.duration)
    const label = formatTime(t)
    ctx.font = '10px ui-monospace, monospace'
    const w = ctx.measureText(label).width + 10
    const lx = clamp(hoverX - w / 2, 2, Math.max(2, cssW - w - 2))
    const ly = cssH - 20
    ctx.fillStyle = 'rgba(4,6,12,0.88)'
    ctx.fillRect(lx, ly, w, 15)
    ctx.strokeStyle = 'rgba(34,211,238,0.35)'
    ctx.strokeRect(lx + 0.5, ly + 0.5, w - 1, 14)
    ctx.fillStyle = '#cbd5e1'
    ctx.textAlign = 'left'
    ctx.fillText(label, lx + 5, ly + 11)
  }

  if (editor.hasSelection) {
    const x1 = timeToX(editor.selection.start)
    const x2 = timeToX(editor.selection.end)
    if (x2 > 0 && x1 < cssW) {
      ctx.fillStyle = 'rgba(34,211,238,0.12)'
      ctx.fillRect(x1, RULER_H, x2 - x1, cssH - RULER_H)
      ctx.strokeStyle = 'rgba(34,211,238,0.9)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(x1, RULER_H)
      ctx.lineTo(x1, cssH)
      ctx.moveTo(x2, RULER_H)
      ctx.lineTo(x2, cssH)
      ctx.stroke()
      const midY = (RULER_H + cssH) / 2
      ctx.fillStyle = '#22d3ee'
      ctx.fillRect(x1 - 3, midY - 10, 6, 20)
      ctx.fillRect(x2 - 3, midY - 10, 6, 20)
      const label = `${(editor.selection.end - editor.selection.start).toFixed(1)}s`
      ctx.font = '10px ui-monospace, monospace'
      const w = ctx.measureText(label).width + 8
      const lx = clamp((x1 + x2) / 2 - w / 2, 2, cssW - w - 2)
      ctx.fillStyle = 'rgba(4,6,12,0.85)'
      ctx.fillRect(lx, RULER_H + 4, w, 14)
      ctx.fillStyle = '#67e8f9'
      ctx.textAlign = 'left'
      ctx.fillText(label, lx + 4, RULER_H + 14)
    }
  }

  const x = timeToX(audioEngine.getPosition())
  if (x >= -4 && x <= cssW + 4) {
    ctx.save()
    ctx.shadowColor = 'rgba(103,232,249,0.9)'
    ctx.shadowBlur = 8
    ctx.strokeStyle = '#a5f3fc'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, cssH)
    ctx.stroke()
    ctx.restore()
    ctx.fillStyle = '#a5f3fc'
    ctx.beginPath()
    ctx.moveTo(x - 5, 0)
    ctx.lineTo(x + 5, 0)
    ctx.lineTo(x, 7)
    ctx.closePath()
    ctx.fill()
  }
}

function frame(): void {
  drawOverlay()
  if (editor.isPlaying && editor.buffer) {
    const x = timeToX(audioEngine.getPosition())
    if (x < 0 || x > cssW) {
      editor.scrollX = audioEngine.getPosition() * editor.zoom - cssW * 0.15
      clampScroll()
      drawBase()
    }
  }
  raf = requestAnimationFrame(frame)
}

// ---------- 交互 ----------
function onPointerDown(e: PointerEvent): void {
  if (!editor.buffer) return
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  const x = e.offsetX
  downX = x
  const t = xToTime(x)
  dragMode = 'none'
  if (editor.hasSelection) {
    const xl = timeToX(editor.selection.start)
    const xr = timeToX(editor.selection.end)
    if (Math.abs(x - xl) <= 7) dragMode = 'edge-l'
    else if (Math.abs(x - xr) <= 7) dragMode = 'edge-r'
    else if (e.shiftKey && x > xl && x < xr) {
      dragMode = 'move'
      moveGrabOffset = t - editor.selection.start
    } else {
      dragMode = 'maybe'
      anchorTime = t
    }
  } else {
    dragMode = 'maybe'
    anchorTime = t
  }
}

function onPointerMove(e: PointerEvent): void {
  const x = e.offsetX
  hoverX = x
  if (dragMode === 'none') {
    if (editor.buffer && overlayCanvas.value) {
      let cursor = 'crosshair'
      if (editor.hasSelection) {
        const xl = timeToX(editor.selection.start)
        const xr = timeToX(editor.selection.end)
        if (Math.abs(x - xl) <= 7 || Math.abs(x - xr) <= 7) cursor = 'col-resize'
        else if (x > xl && x < xr) cursor = e.shiftKey ? 'grab' : 'crosshair'
      }
      overlayCanvas.value.style.cursor = cursor
    }
    return
  }
  const t = xToTime(x)
  switch (dragMode) {
    case 'maybe':
      if (Math.abs(x - downX) > 4) {
        dragMode = 'select'
        editor.setSelection(anchorTime, t)
      }
      break
    case 'select':
      editor.setSelection(anchorTime, t)
      break
    case 'edge-l':
      editor.setSelection(t, editor.selection.end)
      break
    case 'edge-r':
      editor.setSelection(editor.selection.start, t)
      break
    case 'move': {
      const len = editor.selection.end - editor.selection.start
      const ns = clamp(snap(t - moveGrabOffset), 0, Math.max(0, editor.duration - len))
      editor.setSelectionRaw(ns, ns + len)
      break
    }
  }
}

function onPointerUp(e: PointerEvent): void {
  if (dragMode === 'maybe' && editor.buffer) {
    editor.seek(xToTime(e.offsetX))
  }
  dragMode = 'none'
}

function onPointerLeave(): void {
  if (dragMode === 'none') hoverX = null
}

function onWheel(e: WheelEvent): void {
  e.preventDefault()
  if (!editor.buffer) return
  if (e.altKey) {
    editor.vGain = clamp(editor.vGain * (e.deltaY > 0 ? 0.85 : 1.18), 0.25, 8)
    drawBase()
    return
  }
  if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
    editor.scrollX += delta
    clampScroll()
    drawBase()
    return
  }
  const factor = Math.exp(-e.deltaY * 0.0016)
  const fit = cssW / Math.max(0.001, editor.duration)
  const z = clamp(editor.zoom * factor, Math.min(MIN_PX_PER_SEC, fit), Math.max(MAX_PX_PER_SEC, fit))
  const x = e.offsetX
  const t = (editor.scrollX + x) / editor.zoom
  editor.zoom = z
  editor.scrollX = t * z - x
  clampScroll()
  drawBase()
}

// ---------- 视图工具栏 ----------
function fitAll(): void {
  if (!editor.buffer) return
  editor.zoom = clamp(cssW / Math.max(0.001, editor.buffer.duration), MIN_PX_PER_SEC, MAX_PX_PER_SEC)
  editor.scrollX = 0
  clampScroll()
  drawBase()
}

function zoomToSelection(): void {
  if (!editor.buffer || !editor.hasSelection) return
  const len = Math.max(0.05, editor.selection.end - editor.selection.start)
  editor.zoom = clamp(cssW / (len * 1.15), MIN_PX_PER_SEC, MAX_PX_PER_SEC)
  editor.scrollX = Math.max(0, editor.selection.start * editor.zoom - cssW * 0.08)
  clampScroll()
  drawBase()
}

function nudgeVGain(factor: number): void {
  editor.vGain = clamp(editor.vGain * factor, 0.25, 8)
  drawBase()
}

// ---------- 生命周期 ----------
onMounted(() => {
  resize()
  resizeObserver = new ResizeObserver(resize)
  if (wrap.value) resizeObserver.observe(wrap.value)
  wrap.value?.addEventListener('wheel', onWheel, { passive: false })
  raf = requestAnimationFrame(frame)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  wrap.value?.removeEventListener('wheel', onWheel)
  cancelAnimationFrame(raf)
})

watch(
  () => [editor.zoom, editor.scrollX, editor.vGain, editor.buffer, editor.peakCache] as const,
  () => {
    clampScroll()
    drawBase()
  }
)

watch(
  () => editor.buffer,
  (b, old) => {
    if (b && b !== old) {
      if (editor.pendingView) {
        // 工程加载已恢复视图，跳过自动适应
        editor.pendingView = false
      } else {
        editor.zoom = cssW / Math.max(0.001, b.duration)
        editor.scrollX = 0
      }
      drawBase()
    }
  }
)
</script>

<template>
  <div ref="wrap" class="relative min-h-0 select-none bg-abyss-950/60">
    <canvas ref="baseCanvas" class="absolute inset-0" />
    <canvas
      ref="overlayCanvas"
      class="absolute inset-0 touch-none"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @pointerleave="onPointerLeave"
    />

    <div class="absolute right-2 top-8 z-10 flex items-center gap-1 panel bg-abyss-900/90 px-1.5 py-1">
      <button class="btn px-1.5 py-0.5 text-[10px]" :disabled="!editor.buffer" @click="fitAll">
        全览
      </button>
      <button
        class="btn px-1.5 py-0.5 text-[10px]"
        :disabled="!editor.hasSelection"
        @click="zoomToSelection"
      >
        选区
      </button>
      <button class="btn px-1.5 py-0.5 text-[10px]" :disabled="!editor.buffer" @click="nudgeVGain(0.8)">
        A−
      </button>
      <button class="btn px-1.5 py-0.5 text-[10px]" :disabled="!editor.buffer" @click="nudgeVGain(1.25)">
        A+
      </button>
      <button
        class="btn px-1.5 py-0.5 text-[10px] text-neon-bright"
        :disabled="!editor.buffer"
        title="重置振幅（Alt+滚轮可调）"
        @click="nudgeVGain(1 / Math.max(0.01, editor.vGain))"
      >
        {{ Math.round(editor.vGain * 100) }}%
      </button>
    </div>
  </div>
</template>
