<script setup lang="ts">
/**
 * 波形编辑器：
 *  - 双 Canvas：底层波形 / 语谱图 + 时间标尺（按需重绘），上层选区 + 播放头（脏标记按需重绘）
 *  - 峰值金字塔由 Worker 分块构建，构建期间逐块渐进显示
 *  - 波形 / 频谱 / 叠加三种视图共用同一条时间轴，标记点、静音段与吸附网格同步绘制
 *  - 支持滚轮缩放（光标锚点）、横向滚动、吸附框选、选区边缘拖拽、
 *    Shift 拖动选区、点击定位播放头、播放自动跟随
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useEditorStore, SNAP_GRIDS, type WaveViewMode } from '../stores/editor'
import { audioEngine } from '../audio/engine'
import { clamp, formatTime } from '../utils/audio-utils'
import type { Spectrogram } from '../audio/spectral'

const editor = useEditorStore()
const viewModes: { key: WaveViewMode; label: string }[] = [
  { key: 'waveform', label: '波形' },
  { key: 'spectrum', label: '频谱' },
  { key: 'both', label: '叠加' }
]
const gridLabel = computed(
  () => SNAP_GRIDS.find((g) => g.value === editor.snapGrid)?.label ?? `${editor.snapGrid}s`
)

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
/** overlay 只在状态变化或播放时重绘，暂停且无悬停时不再每帧全量绘制 */
let overlayDirty = true
let lastPlayheadX = Number.NaN

type DragMode = 'none' | 'maybe' | 'select' | 'edge-l' | 'edge-r' | 'move'
let dragMode: DragMode = 'none'
let anchorTime = 0
let moveGrabOffset = 0
let downX = 0
/** 悬停读数位置（CSS px），普通变量，不进入响应式 */
let hoverX: number | null = null

/** 语谱图离屏位图缓存：只在 spec 变化时重建，缩放/滚动时只做 drawImage 裁剪 */
let specBitmap: HTMLCanvasElement | null = null
let specSource: Spectrogram | null = null
const SPEC_HEIGHT = 256
const SPEC_MIN_FREQ = 20
const palette = buildPalette()

function buildPalette(): Uint8ClampedArray {
  // 深蓝 → 青 → 黄 → 白，低能量更暗，便于看清语音谐波结构
  const stops: [number, number, number, number][] = [
    [0, 4, 8, 22],
    [0.18, 12, 34, 78],
    [0.4, 16, 120, 148],
    [0.62, 34, 211, 190],
    [0.8, 250, 204, 21],
    [1, 255, 250, 224]
  ]
  const out = new Uint8ClampedArray(256 * 4)
  for (let i = 0; i < 256; i++) {
    const t = i / 255
    let k = 0
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++
    const a = stops[k]
    const b = stops[k + 1]
    const f = (t - a[0]) / Math.max(1e-6, b[0] - a[0])
    out[i * 4] = a[1] + (b[1] - a[1]) * f
    out[i * 4 + 1] = a[2] + (b[2] - a[2]) * f
    out[i * 4 + 2] = a[3] + (b[3] - a[3]) * f
    out[i * 4 + 3] = 255
  }
  return out
}

function buildSpecBitmap(spec: Spectrogram): HTMLCanvasElement {
  const bmp = document.createElement('canvas')
  bmp.width = spec.columns
  bmp.height = SPEC_HEIGHT
  const c = bmp.getContext('2d')
  if (!c) return bmp
  const img = c.createImageData(spec.columns, SPEC_HEIGHT)
  const maxFreq = Math.min(spec.sampleRate / 2, 24000)
  const logRatio = Math.log(maxFreq / SPEC_MIN_FREQ)
  // 纵向对数频率轴：第 0 行 = 高频，最后一行 = 低频
  const rowBins = new Int32Array(SPEC_HEIGHT)
  for (let y = 0; y < SPEC_HEIGHT; y++) {
    const f = maxFreq * Math.exp(-(y / (SPEC_HEIGHT - 1)) * logRatio)
    rowBins[y] = clamp(Math.round((f / (spec.sampleRate / 2)) * (spec.bins - 1)), 0, spec.bins - 1)
  }
  for (let x = 0; x < spec.columns; x++) {
    const base = x * spec.bins
    for (let y = 0; y < SPEC_HEIGHT; y++) {
      const v = spec.data[base + rowBins[y]]
      const o = (y * spec.columns + x) * 4
      const p = v * 4
      img.data[o] = palette[p]
      img.data[o + 1] = palette[p + 1]
      img.data[o + 2] = palette[p + 2]
      img.data[o + 3] = 255
    }
  }
  c.putImageData(img, 0, 0)
  return bmp
}

const timeToX = (t: number) => t * editor.zoom - editor.scrollX
const xToTime = (x: number) => (x + editor.scrollX) / editor.zoom
const maxScroll = () => Math.max(0, editor.duration * editor.zoom - cssW)
/** 拖动整段选区时的吸附：与「标记」页的吸附精度保持一致，0 = 采样级不吸附 */
function snap(t: number): number {
  const g = editor.snapGrid
  return clamp(g > 0 ? Math.round(t / g) * g : t, 0, editor.duration)
}

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
  overlayDirty = true
  lastPlayheadX = Number.NaN
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
  drawSnapGrid(ctx)
  drawSpectrogram(ctx)
  if (editor.viewMode !== 'spectrum') drawWaveform(ctx)
  drawSilenceSegments(ctx)
  drawMarkers(ctx)

  const cache = editor.peakCache
  if (cache && !cache.complete) {
    const label = `波形构建中 ${Math.round(cache.progress * 100)}%`
    ctx.font = '11px ui-monospace, monospace'
    ctx.textAlign = 'left'
    const w = ctx.measureText(label).width + 14
    ctx.fillStyle = 'rgba(4,6,12,0.85)'
    ctx.fillRect(8, cssH - 24, w, 18)
    ctx.fillStyle = '#67e8f9'
    ctx.fillText(label, 15, cssH - 11)
  }
  if (editor.viewMode !== 'waveform' && !editor.spectrogram) {
    const label = '尚未生成频谱：到「测量」页点击「生成频谱图」'
    ctx.font = '11px ui-monospace, monospace'
    ctx.textAlign = 'center'
    const w = ctx.measureText(label).width + 20
    ctx.fillStyle = 'rgba(4,6,12,0.88)'
    ctx.fillRect(cssW / 2 - w / 2, cssH / 2 - 13, w, 24)
    ctx.fillStyle = '#fbbf24'
    ctx.fillText(label, cssW / 2, cssH / 2 + 3)
  }
}

/** 吸附网格：只在间距足够宽时绘制，避免放大成一片竖线 */
function drawSnapGrid(ctx: CanvasRenderingContext2D): void {
  const grid = editor.snapGrid
  if (!grid || grid * editor.zoom < 9) return
  const t0 = Math.max(0, Math.floor(xToTime(0) / grid) * grid)
  const t1 = Math.min(editor.duration, xToTime(cssW))
  ctx.save()
  ctx.beginPath()
  for (let t = t0; t <= t1; t += grid) {
    const x = Math.round(timeToX(t)) + 0.5
    ctx.moveTo(x, RULER_H)
    ctx.lineTo(x, cssH)
  }
  ctx.strokeStyle = 'rgba(148,163,184,0.09)'
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.restore()
}

/** 语谱图：把缓存位图按当前时间窗横向裁剪后拉伸绘制，与波形共用时间轴 */
function drawSpectrogram(ctx: CanvasRenderingContext2D): void {
  if (editor.viewMode === 'waveform') return
  const spec = editor.spectrogram
  if (!spec) return
  if (specSource !== spec || !specBitmap) {
    specBitmap = buildSpecBitmap(spec)
    specSource = spec
  }
  const bmp = specBitmap
  const sr = spec.sampleRate
  const samplesPerCol = spec.hopSize > 0 ? spec.hopSize : spec.fftSize
  const colAt = (x: number) => (xToTime(x) * sr) / samplesPerCol
  let sx = colAt(0)
  let sw = colAt(cssW) - sx
  // 源矩形超出位图时按边界裁剪，同时等比修正目标矩形
  let dx = 0
  let dw = cssW
  if (sx < 0) {
    dw *= (sw + sx) / sw
    dx = cssW - dw
    sw += sx
    sx = 0
  }
  if (sx + sw > bmp.width) {
    const visible = bmp.width - sx
    dw = dw * (visible / sw)
    sw = visible
  }
  if (sw <= 0 || dw <= 0) return
  ctx.save()
  ctx.globalAlpha = editor.viewMode === 'both' ? 0.82 : 1
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(bmp, sx, 0, sw, bmp.height, dx, RULER_H, dw, cssH - RULER_H)
  ctx.restore()
  // 频率刻度（右侧）
  const maxFreq = Math.min(sr / 2, 24000)
  const ratio = Math.log(maxFreq / SPEC_MIN_FREQ)
  ctx.save()
  ctx.font = '9px ui-monospace, monospace'
  ctx.textAlign = 'right'
  for (const f of [100, 500, 1000, 4000, 8000, 16000]) {
    if (f >= maxFreq) continue
    const y = RULER_H + (Math.log(maxFreq / f) / ratio) * (cssH - RULER_H)
    ctx.fillStyle = 'rgba(4,6,12,0.6)'
    ctx.fillRect(cssW - 38, y - 9, 36, 11)
    ctx.fillStyle = 'rgba(226,232,240,0.75)'
    ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, cssW - 4, y)
  }
  ctx.restore()
}

/** 静音分段：暗色遮罩，方便一眼看出自动分段结果 */
function drawSilenceSegments(ctx: CanvasRenderingContext2D): void {
  const list = editor.segments
  if (!list.length) return
  ctx.save()
  for (const seg of list) {
    if (seg.kind !== 'silence') continue
    const x1 = timeToX(seg.start)
    const x2 = timeToX(seg.end)
    if (x2 <= 0 || x1 >= cssW) continue
    const l = Math.max(0, x1)
    const r = Math.min(cssW, x2)
    ctx.fillStyle = 'rgba(2,6,12,0.62)'
    ctx.fillRect(l, RULER_H, r - l, cssH - RULER_H)
    ctx.strokeStyle = 'rgba(251,191,36,0.35)'
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(l + 0.5, RULER_H)
    ctx.lineTo(l + 0.5, cssH)
    ctx.moveTo(r - 0.5, RULER_H)
    ctx.lineTo(r - 0.5, cssH)
    ctx.stroke()
    ctx.setLineDash([])
  }
  ctx.restore()
}

/** 标记点：刻度线 + 序号标签，落在标尺区的小三角便于点击定位 */
function drawMarkers(ctx: CanvasRenderingContext2D): void {
  const list = editor.markers
  if (!list.length) return
  ctx.save()
  ctx.font = '9px ui-monospace, monospace'
  ctx.textAlign = 'left'
  list.forEach((m, i) => {
    const x = timeToX(m.time)
    if (x < -30 || x > cssW + 30) return
    ctx.strokeStyle = 'rgba(251,191,36,0.75)'
    ctx.lineWidth = 1
    ctx.setLineDash([5, 4])
    ctx.beginPath()
    ctx.moveTo(x + 0.5, RULER_H)
    ctx.lineTo(x + 0.5, cssH)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = '#fbbf24'
    ctx.beginPath()
    ctx.moveTo(x - 4, RULER_H - 1)
    ctx.lineTo(x + 4, RULER_H - 1)
    ctx.lineTo(x, RULER_H + 6)
    ctx.closePath()
    ctx.fill()
    if (m.label) {
      const label = `${i + 1} ${m.label}`
      const w = Math.min(120, ctx.measureText(label).width + 8)
      const lx = clamp(x + 3, 2, Math.max(2, cssW - w - 2))
      ctx.fillStyle = 'rgba(4,6,12,0.82)'
      ctx.fillRect(lx, RULER_H + 2, w, 13)
      ctx.fillStyle = 'rgba(253,230,138,0.9)'
      ctx.fillText(label.slice(0, 24), lx + 3, RULER_H + 12)
    }
  })
  ctx.restore()
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
  const playheadX = Math.round(timeToX(audioEngine.getPosition()) * 2) / 2
  // 暂停且无状态变化时，播放头位置不变，跳过整帧 overlay 绘制
  if (overlayDirty || editor.isPlaying || playheadX !== lastPlayheadX) {
    drawOverlay()
    overlayDirty = false
    lastPlayheadX = playheadX
  }
  if (editor.isPlaying && editor.buffer) {
    const x = timeToX(audioEngine.getPosition())
    if (x < 0 || x > cssW) {
      editor.scrollX = audioEngine.getPosition() * editor.zoom - cssW * 0.15
      clampScroll()
      overlayDirty = true
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
  // 点击标尺区的标记三角或其竖线：直接跳到该 Cue，不进入框选
  if (!e.shiftKey && e.offsetY <= RULER_H + 12) {
    const hit = editor.markers.find((m) => Math.abs(timeToX(m.time) - x) <= 5)
    if (hit) {
      editor.gotoMarker(hit.id)
      dragMode = 'none'
      return
    }
  }
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
  if (hoverX !== x) overlayDirty = true
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
  if (dragMode === 'none' && hoverX !== null) {
    hoverX = null
    overlayDirty = true
  }
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
  () =>
    [
      editor.zoom,
      editor.scrollX,
      editor.vGain,
      editor.buffer,
      editor.peakCache,
      editor.peakVersion,
      editor.viewMode,
      editor.spectrogram,
      editor.markers,
      editor.segments,
      editor.snapGrid
    ] as const,
  () => {
    overlayDirty = true
    clampScroll()
    drawBase()
  }
)

// 选区与播放状态不改变播放头坐标，但 overlay 内容必须重绘
watch(
  () =>
    [
      editor.selection.start,
      editor.selection.end,
      editor.hasSelection,
      editor.isPlaying
    ] as const,
  () => {
    overlayDirty = true
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

    <div class="absolute left-2 top-8 z-10 flex items-center gap-1 panel bg-abyss-900/90 px-1.5 py-1">
      <span class="text-[9px] text-slate-500 mr-0.5 select-none">视图</span>
      <button
        v-for="m in viewModes"
        :key="m.key"
        class="btn px-1.5 py-0.5 text-[10px]"
        :class="{ 'btn-primary': editor.viewMode === m.key }"
        :disabled="!editor.buffer"
        @click="editor.setViewMode(m.key)"
      >
        {{ m.label }}
      </button>
      <span
        class="text-[9px] text-slate-500 ml-1 border-l border-neon/15 pl-1.5 select-none"
        :title="`当前吸附精度：${gridLabel}，可在「标记」页切换`"
      >
        {{ gridLabel }}
      </span>
    </div>

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
