<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useEditorStore } from '../stores/editor'
import { audioEngine } from '../audio/engine'
import { formatTime } from '../utils/audio-utils'
import { useRealtimeMeter } from '../composables/useRealtimeMeter'
import { formatDb } from '../audio/meter'

const editor = useEditorStore()
const { stats, mode, reset } = useRealtimeMeter()
const currentTime = ref(0)
let timer: number | undefined

onMounted(() => {
  timer = window.setInterval(() => {
    currentTime.value = audioEngine.getPosition()
  }, 100)
})

onBeforeUnmount(() => {
  if (timer !== undefined) window.clearInterval(timer)
})

function onVolumeInput(e: Event): void {
  editor.setVolume(Number((e.target as HTMLInputElement).value))
}

/** -60..0 LUFS 映射到 0..1；真峰值用 -20..+3 dBTP */
function bar(v: number, lo = -60, hi = 0): number {
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(1, (v - lo) / (hi - lo))) * 100
}

function levelClass(v: number): string {
  if (!Number.isFinite(v)) return 'bg-slate-700'
  if (v > -1) return 'bg-danger'
  if (v > -9) return 'bg-warn'
  return 'bg-neon'
}

const clipHint = computed(() =>
  stats.value.clippedSamples > 0 ? ` · 越界 ${stats.value.clippedSamples}` : ''
)
const meterTitle = computed(() => {
  const src =
    mode.value === 'worklet'
      ? 'AudioWorklet 逐采样 K 加权'
      : mode.value === 'analyser'
        ? 'AnalyserNode 兼容模式（近似值）'
        : '播放后开始测量'
  return `${src} · 取自主音量之前${clipHint.value}`
})
</script>

<template>
  <div
    class="h-20 shrink-0 border-t border-neon/15 bg-abyss-900/70 backdrop-blur flex items-center gap-6 px-6"
  >
    <div class="flex items-center gap-2">
      <button class="btn text-base px-3" :disabled="!editor.buffer" title="停止" @click="editor.stop()">
        &#9632;
      </button>
      <button
        class="btn btn-primary text-lg px-5 py-2"
        :disabled="!editor.buffer"
        :title="editor.isPlaying ? '暂停 (Space)' : '播放 (Space)'"
        @click="editor.togglePlay()"
      >
        {{ editor.isPlaying ? '❚❚' : '▶' }}
      </button>
      <button
        class="btn"
        :class="{ 'btn-primary': editor.isLooping }"
        :disabled="!editor.buffer"
        title="循环播放（有选区时循环选区）"
        @click="editor.toggleLoop()"
      >
        循环
      </button>
    </div>

    <div class="font-mono text-lg text-neon glow-text tabular-nums select-none">
      {{ formatTime(currentTime) }}
      <span class="text-slate-500 text-sm">/ {{ formatTime(editor.duration) }}</span>
    </div>

    <div v-if="editor.hasSelection" class="text-xs text-slate-400 font-mono select-none">
      选区 {{ editor.selection.start.toFixed(1) }}s → {{ editor.selection.end.toFixed(1) }}s
      <span class="text-neon-bright">（{{ (editor.selection.end - editor.selection.start).toFixed(1) }}s）</span>
    </div>

    <!-- 实时电平表：始终可见，读数不受监听音量影响 -->
    <div class="ml-auto flex items-center gap-2 w-60" :title="meterTitle">
      <div class="flex-1 space-y-1 select-none">
        <div class="flex items-center gap-1.5">
          <span class="text-[9px] text-slate-500 w-8 shrink-0">LUFS</span>
          <div class="flex-1 h-1.5 rounded bg-abyss-800 overflow-hidden">
            <div
              class="h-full transition-all duration-75"
              :class="levelClass(stats.momentaryLufs)"
              :style="{ width: `${bar(stats.momentaryLufs)}%` }"
            />
          </div>
          <span class="font-mono text-[10px] text-neon-bright w-10 text-right">{{
            formatDb(stats.momentaryLufs)
          }}</span>
        </div>
        <div class="flex items-center gap-1.5">
          <span class="text-[9px] text-slate-500 w-8 shrink-0">dBTP</span>
          <div class="flex-1 h-1.5 rounded bg-abyss-800 overflow-hidden">
            <div
              class="h-full transition-all duration-75"
              :class="levelClass(stats.truePeakDb)"
              :style="{ width: `${bar(stats.truePeakDb, -20, 3)}%` }"
            />
          </div>
          <span class="font-mono text-[10px] w-10 text-right" :class="stats.truePeakDb > -1 ? 'text-danger' : 'text-slate-300'">{{
            formatDb(stats.truePeakDb)
          }}</span>
        </div>
      </div>
      <button
        class="btn px-1.5 py-0.5 text-[9px] shrink-0"
        title="重置峰值保持与削波累计"
        @click="reset"
      >
        R
      </button>
    </div>

    <div class="flex items-center gap-3 w-44">
      <span class="text-xs text-slate-500 tracking-widest select-none">音量</span>
      <input
        class="neon-range flex-1"
        type="range"
        min="0"
        max="1"
        step="0.01"
        :value="editor.volume"
        @input="onVolumeInput"
      />
      <span class="text-xs text-neon-bright font-mono w-8 text-right">{{ Math.round(editor.volume * 100) }}</span>
    </div>
  </div>
</template>
