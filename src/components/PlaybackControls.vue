<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useEditorStore } from '../stores/editor'
import { audioEngine } from '../audio/engine'
import { formatTime } from '../utils/audio-utils'

const editor = useEditorStore()
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

    <div class="ml-auto flex items-center gap-3 w-56">
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
