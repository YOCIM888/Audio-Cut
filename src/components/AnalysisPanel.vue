<script setup lang="ts">
/** 测量面板：实时电平表、全曲响度分析、LUFS 归一化、频谱视图与响度历史曲线 */
import { computed, ref, watch } from 'vue'
import { useEditorStore } from '../stores/editor'
import { useToastStore } from '../stores/toast'
import { useRealtimeMeter } from '../composables/useRealtimeMeter'
import { buildSpectrogram } from '../utils/analysis-client'
import { LOUDNESS_TARGETS } from '../audio/loudness'
import { formatDb } from '../audio/meter'

const editor = useEditorStore()
const toast = useToastStore()
const { stats, mode, reset } = useRealtimeMeter()

const targetIndex = ref(2) // Spotify / YouTube -14
const customTarget = ref(-14)
const ceiling = ref(-1)
const allowLimiter = ref(true)
const analysisRange = ref<'all' | 'selection'>('all')
const normalizeScope = ref<'all' | 'selection'>('all')
const spectrumBusy = ref(false)
const spectrumProgress = ref(0)

const targetLufs = computed(() =>
  LOUDNESS_TARGETS[targetIndex.value].value === 0 ? customTarget.value : LOUDNESS_TARGETS[targetIndex.value].value
)
const busy = computed(() => editor.busy.type !== null)
const s = computed(() => editor.loudnessStats)

function dbText(v: number, digits = 1): string {
  return formatDb(v, digits)
}

/** -60 ~ 0 LUFS 映射到 0..1，用于电平条 */
function bar(v: number, lo = -60, hi = 0): number {
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(1, (v - lo) / (hi - lo)))
}

function meterColor(v: number): string {
  if (!Number.isFinite(v)) return 'bg-slate-700'
  if (v > -1) return 'bg-danger'
  if (v > -9) return 'bg-warn'
  return 'bg-neon'
}

async function runAnalysis(): Promise<void> {
  await editor.analyzeFullLoudness(analysisRange.value)
}

async function runNormalize(): Promise<void> {
  await editor.normalizeLufs(
    targetLufs.value,
    ceiling.value,
    normalizeScope.value === 'selection',
    allowLimiter.value
  )
}

async function generateSpectrum(): Promise<void> {
  if (!editor.buffer || spectrumBusy.value) return
  spectrumBusy.value = true
  spectrumProgress.value = 0
  editor.setViewMode(editor.viewMode === 'waveform' ? 'both' : editor.viewMode)
  try {
    const buf = editor.buffer
    const ch: Float32Array[] = []
    for (let c = 0; c < buf.numberOfChannels; c++) ch.push(buf.getChannelData(c))
    const spec = await buildSpectrogram(ch, buf.sampleRate, {
      fftSize: 2048,
      maxColumns: 1600,
      onProgress: (p) => {
        spectrumProgress.value = p
      }
    })
    editor.setSpectrogram(spec, 1)
    toast.push('success', `语谱图已生成：${spec.columns} 列 × ${spec.bins} 频点`)
  } catch (err) {
    toast.push('error', err instanceof Error ? err.message : '频谱分析失败')
  } finally {
    spectrumBusy.value = false
    spectrumProgress.value = 0
  }
}

// ---- 响度历史 mini 图 ----
const historyCanvas = ref<HTMLCanvasElement | null>(null)
function drawHistory(): void {
  const canvas = historyCanvas.value
  const stats = editor.loudnessStats
  if (!canvas || !stats?.history.length) return
  const dpr = window.devicePixelRatio || 1
  const w = Math.max(120, canvas.parentElement?.clientWidth ?? 240)
  const h = 64
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  canvas.style.width = `${w}px`
  canvas.style.height = `${h}px`
  const c = canvas.getContext('2d')
  if (!c) return
  c.setTransform(dpr, 0, 0, dpr, 0, 0)
  c.fillStyle = 'rgba(4,6,12,0.75)'
  c.fillRect(0, 0, w, h)
  for (const db of [-60, -40, -20, -10, 0]) {
    const y = h - bar(db) * (h - 6) - 3
    c.strokeStyle = 'rgba(148,163,184,0.13)'
    c.beginPath()
    c.moveTo(0, y)
    c.lineTo(w, y)
    c.stroke()
    c.fillStyle = 'rgba(148,163,184,0.5)'
    c.font = '8px ui-monospace, monospace'
    c.fillText(`${db}`, 2, Math.max(9, y - 2))
  }
  const path = new Path2D()
  stats.history.forEach((v, i) => {
    const x = (i / Math.max(1, stats.history.length - 1)) * w
    const y = h - bar(v) * (h - 6) - 3
    if (i === 0) path.moveTo(x, y)
    else path.lineTo(x, y)
  })
  c.strokeStyle = '#22d3ee'
  c.lineWidth = 1.4
  c.stroke(path)
  if (Number.isFinite(targetLufs.value)) {
    const y = h - bar(targetLufs.value) * (h - 6) - 3
    c.strokeStyle = 'rgba(251,191,36,0.75)'
    c.setLineDash([4, 3])
    c.beginPath()
    c.moveTo(0, y)
    c.lineTo(w, y)
    c.stroke()
    c.setLineDash([])
  }
}
watch(() => [editor.loudnessStats, targetLufs.value] as const, () => window.requestAnimationFrame(drawHistory), {
  flush: 'post'
})
</script>

<template>
  <div class="space-y-3">
    <!-- 实时电平表 -->
    <div class="panel p-3 space-y-2">
      <div class="flex items-center justify-between">
        <label class="field-label !mb-0">实时电平表 · EBU R128</label>
        <button class="btn px-1.5 py-0.5 text-[10px]" title="清除峰值保持与削波累计" @click="reset">
          重置
        </button>
      </div>
      <div class="space-y-1.5">
        <div class="flex items-center gap-2">
          <span class="text-[10px] text-slate-500 w-14 shrink-0">LUFS-M</span>
          <div class="flex-1 h-2 rounded bg-abyss-800 overflow-hidden">
            <div class="h-full transition-all duration-75" :class="meterColor(stats.momentaryLufs)" :style="{ width: `${bar(stats.momentaryLufs) * 100}%` }" />
          </div>
          <span class="font-mono text-[10px] text-neon-bright w-12 text-right">{{ dbText(stats.momentaryLufs) }}</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-[10px] text-slate-500 w-14 shrink-0">LUFS-S</span>
          <div class="flex-1 h-2 rounded bg-abyss-800 overflow-hidden">
            <div class="h-full bg-neon/70 transition-all duration-75" :style="{ width: `${bar(stats.shortTermLufs) * 100}%` }" />
          </div>
          <span class="font-mono text-[10px] text-neon-bright w-12 text-right">{{ dbText(stats.shortTermLufs) }}</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-[10px] text-slate-500 w-14 shrink-0">dBTP</span>
          <div class="flex-1 h-2 rounded bg-abyss-800 overflow-hidden">
            <div class="h-full transition-all duration-75" :class="meterColor(stats.truePeakDb)" :style="{ width: `${bar(stats.truePeakDb, -20, 3) * 100}%` }" />
          </div>
          <span class="font-mono text-[10px] text-neon-bright w-12 text-right">{{ dbText(stats.truePeakDb) }}</span>
        </div>
      </div>
      <div class="grid grid-cols-3 gap-1 text-center">
        <div class="bg-abyss-800/60 rounded py-1">
          <div class="text-[9px] text-slate-500">LUFS-I</div>
          <div class="font-mono text-xs text-neon">{{ dbText(stats.integratedLufs) }}</div>
        </div>
        <div class="bg-abyss-800/60 rounded py-1">
          <div class="text-[9px] text-slate-500">RMS</div>
          <div class="font-mono text-xs text-slate-200">{{ dbText(stats.rmsDb) }}</div>
        </div>
        <div class="bg-abyss-800/60 rounded py-1">
          <div class="text-[9px] text-slate-500">峰值保持</div>
          <div class="font-mono text-xs" :class="stats.peakHoldDb > -0.1 ? 'text-danger' : 'text-slate-200'">{{ dbText(stats.peakHoldDb) }}</div>
        </div>
      </div>
      <div class="flex items-center justify-between text-[10px]">
        <span :class="stats.clippedSamples > 0 ? 'text-danger' : 'text-slate-500'">
          越界采样 {{ stats.clippedSamples }}
        </span>
        <span class="text-slate-600">
          {{ mode === 'worklet' ? 'AudioWorklet · 逐采样 K 加权' : mode === 'analyser' ? '兼容模式 · 近似值' : '播放后开始测量' }}
        </span>
      </div>
    </div>

    <!-- 全曲分析 -->
    <div class="panel p-3 space-y-2">
      <label class="field-label">全曲响度分析（BS.1770-4）</label>
      <div class="flex gap-2">
        <select class="field-input flex-1" v-model="analysisRange">
          <option value="all">整条音轨</option>
          <option value="selection" :disabled="!editor.hasSelection">仅选区</option>
        </select>
        <button class="btn btn-primary" :disabled="!editor.buffer || busy" @click="runAnalysis">
          {{ editor.busy.type === 'analyze' ? `分析 ${Math.round(editor.busy.progress)}%` : '开始测量' }}
        </button>
      </div>
      <div v-if="s" class="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] font-mono pt-1">
        <div class="flex justify-between"><span class="text-slate-500">积分响度</span><span class="text-neon">{{ dbText(s.integratedLufs) }} LUFS</span></div>
        <div class="flex justify-between"><span class="text-slate-500">响度范围</span><span class="text-slate-200">{{ s.lra.toFixed(1) }} LU</span></div>
        <div class="flex justify-between"><span class="text-slate-500">短时最大</span><span class="text-slate-200">{{ dbText(s.shortTermMaxLufs) }}</span></div>
        <div class="flex justify-between"><span class="text-slate-500">瞬时最大</span><span class="text-slate-200">{{ dbText(s.momentaryMaxLufs) }}</span></div>
        <div class="flex justify-between"><span class="text-slate-500">采样峰值</span><span class="text-slate-200">{{ dbText(s.peakDb) }} dBFS</span></div>
        <div class="flex justify-between"><span class="text-slate-500">真峰值</span><span :class="s.truePeakDb > -1 ? 'text-danger' : 'text-slate-200'">{{ dbText(s.truePeakDb) }} dBTP</span></div>
        <div class="flex justify-between"><span class="text-slate-500">削波采样</span><span :class="s.clippedSamples ? 'text-danger' : 'text-slate-200'">{{ s.clippedSamples }}</span></div>
        <div class="flex justify-between"><span class="text-slate-500">削波段数</span><span class="text-slate-200">{{ s.clipEvents }}</span></div>
      </div>
      <div v-if="s" class="relative w-full">
        <canvas ref="historyCanvas" class="block rounded border border-neon/15" />
        <p class="text-[9px] text-slate-600 mt-1">瞬时响度历史（虚线为当前归一化目标）</p>
      </div>
      <p v-if="s && s.peakToTruePeakDb > 0.5" class="text-[10px] text-warn/80">
        真峰值比采样峰值高 {{ s.peakToTruePeakDb.toFixed(1) }} dB，编码为有损格式后可能削波，建议用限制器。
      </p>
    </div>

    <!-- LUFS 归一化 -->
    <div class="panel p-3 space-y-2">
      <label class="field-label">响度归一化（不再靠峰值凭感觉）</label>
      <div class="grid grid-cols-2 gap-2">
        <select class="field-input" v-model.number="targetIndex">
          <option v-for="(t, i) in LOUDNESS_TARGETS" :key="t.label" :value="i">{{ t.label }} {{ t.value ? `(${t.value})` : '' }}</option>
        </select>
        <select class="field-input" v-model.number="ceiling">
          <option :value="-1">上限 -1 dBTP</option>
          <option :value="-2">上限 -2 dBTP</option>
          <option :value="-3">上限 -3 dBTP</option>
        </select>
      </div>
      <input
        v-if="LOUDNESS_TARGETS[targetIndex].value === 0"
        class="field-input"
        type="number"
        min="-40"
        max="0"
        step="0.5"
        v-model.number="customTarget"
      />
      <label class="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer">
        <input type="checkbox" v-model="allowLimiter" />
        允许前瞻限制器（可真正达到目标响度）
      </label>
      <div class="flex gap-2">
        <select class="field-input flex-1" v-model="normalizeScope">
          <option value="all">整条音轨</option>
          <option value="selection" :disabled="!editor.hasSelection">仅选区</option>
        </select>
        <button class="btn btn-primary flex-1" :disabled="!editor.buffer || busy" @click="runNormalize">
          归一化到 {{ targetLufs }} LUFS
        </button>
      </div>
      <p class="text-[10px] text-slate-600 leading-relaxed">
        按 400ms 块 + 两级门限测得积分响度后补增益；不勾限制器时，若真峰值会超上限则自动压回，宁可略低于目标也不削波。可 Ctrl+Z 撤销。
      </p>
    </div>

    <!-- 频谱视图 -->
    <div class="panel p-3 space-y-2">
      <label class="field-label">频谱图视图</label>
      <div class="grid grid-cols-3 gap-1.5">
        <button class="btn" :class="{ 'btn-primary': editor.viewMode === 'waveform' }" @click="editor.setViewMode('waveform')">波形</button>
        <button class="btn" :class="{ 'btn-primary': editor.viewMode === 'spectrum' }" @click="editor.setViewMode('spectrum')">频谱</button>
        <button class="btn" :class="{ 'btn-primary': editor.viewMode === 'both' }" @click="editor.setViewMode('both')">叠加</button>
      </div>
      <button class="btn w-full" :disabled="!editor.buffer || spectrumBusy" @click="generateSpectrum">
        {{ spectrumBusy ? `计算频谱 ${Math.round(spectrumProgress * 100)}%` : editor.spectrogram ? '重新生成频谱' : '生成频谱图' }}
      </button>
      <p v-if="editor.spectrogram" class="text-[10px] text-slate-500">
        {{ editor.spectrogram.columns }} 列 / {{ editor.spectrogram.bins }} 频点 · 对数频率轴 · {{ editor.spectrogram.minDb }}~{{ editor.spectrogram.maxDb }} dB
      </p>
      <p class="text-[10px] text-slate-600 leading-relaxed">
        频谱与波形共用同一条时间轴，缩放/滚动同步；音轨编辑后频谱会失效，需重新生成。
      </p>
    </div>
  </div>
</template>
