<script setup lang="ts">
/**
 * 多段参数 EQ 曲线：把效果链里的低切/低架/参数/高架/高切叠加成合成频响，
 * 控制点可直接拖动改频率与增益（改的是链里的节点参数，因此非破坏、可撤销）。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { EffectNode } from '../audio/effect-chain'
import { compositeEqCurve, eqBandsFromChain } from '../audio/eq-response'
import { clamp } from '../utils/audio-utils'

const props = defineProps<{
  nodes: EffectNode[]
  sampleRate: number
  selectedId?: string | null
}>()

const emit = defineEmits<{
  update: [id: string, patch: Record<string, number>]
  select: [id: string]
}>()

const canvas = ref<HTMLCanvasElement | null>(null)
let ctx: CanvasRenderingContext2D | null = null
let observer: ResizeObserver | null = null
let cssW = 0
let cssH = 0
let draggingId: string | null = null

const MIN_F = 20
const MAX_F = 20000
const MIN_DB = -18
const MAX_DB = 18

const xOfFreq = (f: number) => (Math.log(clamp(f, MIN_F, MAX_F) / MIN_F) / Math.log(MAX_F / MIN_F)) * cssW
const freqOfX = (x: number) => MIN_F * Math.pow(MAX_F / MIN_F, clamp(x, 0, cssW) / Math.max(1, cssW))
const yOfDb = (d: number) => cssH / 2 - (clamp(d, MIN_DB, MAX_DB) / MAX_DB) * (cssH / 2 - 10)
const dbOfY = (y: number) => clamp(((cssH / 2 - y) / Math.max(1, cssH / 2 - 10)) * MAX_DB, MIN_DB, MAX_DB)

function resize(): void {
  if (!canvas.value) return
  const parent = canvas.value.parentElement
  if (!parent) return
  const dpr = window.devicePixelRatio || 1
  cssW = Math.max(120, parent.clientWidth)
  cssH = 118
  canvas.value.width = Math.round(cssW * dpr)
  canvas.value.height = Math.round(cssH * dpr)
  canvas.value.style.width = `${cssW}px`
  canvas.value.style.height = `${cssH}px`
  ctx = canvas.value.getContext('2d')
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
  draw()
}

function draw(): void {
  const c = ctx
  if (!c) return
  c.clearRect(0, 0, cssW, cssH)
  c.fillStyle = 'rgba(4,6,12,0.75)'
  c.fillRect(0, 0, cssW, cssH)

  // 频率 / 增益网格
  c.font = '9px ui-monospace, monospace'
  c.textAlign = 'left'
  for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
    const x = xOfFreq(f)
    c.strokeStyle = f === 1000 ? 'rgba(34,211,238,0.28)' : 'rgba(148,163,184,0.10)'
    c.beginPath()
    c.moveTo(x + 0.5, 0)
    c.lineTo(x + 0.5, cssH)
    c.stroke()
    if (f === 20 || f === 100 || f === 1000 || f === 10000) {
      c.fillStyle = 'rgba(148,163,184,0.55)'
      c.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 2, cssH - 3)
    }
  }
  for (const d of [-12, -6, 0, 6, 12]) {
    const y = yOfDb(d)
    c.strokeStyle = d === 0 ? 'rgba(34,211,238,0.35)' : 'rgba(148,163,184,0.10)'
    c.beginPath()
    c.moveTo(0, y + 0.5)
    c.lineTo(cssW, y + 0.5)
    c.stroke()
    c.fillStyle = 'rgba(148,163,184,0.5)'
    c.fillText(`${d > 0 ? '+' : ''}${d}`, 2, y - 2)
  }

  const { db } = compositeEqCurve(props.nodes, {
    sampleRate: props.sampleRate,
    points: Math.max(120, Math.round(cssW)),
    minFreq: MIN_F,
    maxFreq: Math.min(MAX_F, props.sampleRate / 2)
  })
  const curve = new Path2D()
  for (let i = 0; i < db.length; i++) {
    const f = MIN_F * Math.pow(Math.min(MAX_F, props.sampleRate / 2) / MIN_F, i / (db.length - 1))
    const x = xOfFreq(f)
    const y = yOfDb(db[i])
    if (i === 0) curve.moveTo(x, y)
    else curve.lineTo(x, y)
  }
  c.save()
  c.shadowColor = 'rgba(34,211,238,0.7)'
  c.shadowBlur = 8
  c.strokeStyle = 'rgba(34,211,238,0.95)'
  c.lineWidth = 2
  c.stroke(curve)
  c.restore()

  // 可拖动控制点
  for (const b of eqBandsFromChain(props.nodes)) {
    const x = xOfFreq(b.freq)
    const y = yOfDb(b.gainDb)
    const active = props.selectedId === b.id || draggingId === b.id
    c.beginPath()
    c.arc(x, y, active ? 6 : 4.5, 0, Math.PI * 2)
    c.fillStyle = b.kind === 'highpass' || b.kind === 'lowpass' ? '#fbbf24' : active ? '#ecfeff' : '#22d3ee'
    c.fill()
    c.strokeStyle = 'rgba(4,6,12,0.9)'
    c.lineWidth = 1.5
    c.stroke()
    c.fillStyle = active ? '#ecfeff' : 'rgba(165,243,252,0.75)'
    c.fillText(b.label, clamp(x + 7, 2, cssW - 18), clamp(y - 7, 10, cssH - 4))
  }
}

function pointAt(x: number, y: number): { id: string; adjustable: boolean } | null {
  let best: { id: string; adjustable: boolean } | null = null
  let dist = 18
  for (const b of eqBandsFromChain(props.nodes)) {
    const d = Math.hypot(xOfFreq(b.freq) - x, yOfDb(b.gainDb) - y)
    if (d < dist) {
      dist = d
      best = { id: b.id, adjustable: b.kind !== 'highpass' && b.kind !== 'lowpass' }
    }
  }
  return best
}

function onDown(e: PointerEvent): void {
  const hit = pointAt(e.offsetX, e.offsetY)
  if (!hit) return
  draggingId = hit.id
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  emit('select', hit.id)
  if (!hit.adjustable) return
  applyDrag(e.offsetX, e.offsetY)
}

function applyDrag(x: number, y: number): void {
  if (!draggingId) return
  const band = eqBandsFromChain(props.nodes).find((b) => b.id === draggingId)
  if (!band) return
  const freq = Math.round(freqOfX(x))
  const minHz = band.kind === 'lowpass' || band.kind === 'highshelf' ? 1000 : 20
  const patch: Record<string, number> = {
    hz: clamp(freq, minHz, Math.min(20000, props.sampleRate / 2 - 100))
  }
  // 低切/高切没有增益参数，拖动只改截止频率
  if (band.kind !== 'highpass' && band.kind !== 'lowpass') {
    patch.gainDb = Math.round(dbOfY(y) * 2) / 2
  }
  emit('update', draggingId, patch)
}

function onMove(e: PointerEvent): void {
  if (!draggingId) return
  applyDrag(e.offsetX, e.offsetY)
}

function onUp(): void {
  draggingId = null
}

onMounted(() => {
  resize()
  observer = new ResizeObserver(resize)
  if (canvas.value?.parentElement) observer.observe(canvas.value.parentElement)
})
onBeforeUnmount(() => observer?.disconnect())
watch(() => [props.nodes, props.sampleRate, props.selectedId] as const, draw, { deep: true })
</script>

<template>
  <div class="relative w-full">
    <canvas
      ref="canvas"
      class="block rounded border border-neon/20 cursor-crosshair touch-none"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
    />
  </div>
</template>
