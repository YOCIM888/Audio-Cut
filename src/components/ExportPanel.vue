<script setup lang="ts">
import { ref, watch } from 'vue'
import { useEditorStore } from '../stores/editor'
import { useToastStore } from '../stores/toast'
import { useAudioExporter, type ExportFormat } from '../composables/useAudioExporter'
import type { WavBitDepth } from '../utils/wav-encoder'

const editor = useEditorStore()
const toast = useToastStore()
const { exportAudio } = useAudioExporter()

const format = ref<ExportFormat>('wav')
const sampleRate = ref(0) // 0 = 保持原采样率
const bitDepth = ref<WavBitDepth>(16)
const channelMode = ref<'keep' | 'mono' | 'stereo'>('keep')
const bitrate = ref(192)
const range = ref<'all' | 'selection'>('all')
const fileName = ref('')
const progress = ref(0)
const exporting = ref(false)

watch(
  () => editor.fileName,
  (v) => {
    if (v) fileName.value = v
  },
  { immediate: true }
)

async function doExport(): Promise<void> {
  if (exporting.value || !editor.buffer) return
  exporting.value = true
  progress.value = 0
  try {
    await exportAudio(
      {
        format: format.value,
        sampleRate: sampleRate.value || null,
        bitDepth: bitDepth.value,
        channels: channelMode.value,
        bitrate: bitrate.value,
        range: range.value,
        fileName: fileName.value.trim() || 'audio'
      },
      (p) => {
        progress.value = p
      }
    )
    toast.push('success', '导出完成，已开始下载')
  } catch (err) {
    console.error(err)
    toast.push('error', err instanceof Error ? err.message : '导出失败')
  } finally {
    exporting.value = false
    progress.value = 0
  }
}
</script>

<template>
  <div class="space-y-3">
    <div>
      <label class="field-label">格式</label>
      <select class="field-input" v-model="format">
        <option value="wav">WAV（无损，纯 JS 编码）</option>
        <option value="mp3">MP3（lamejs Worker 编码）</option>
        <option value="webm">WebM / Opus（实时录制）</option>
        <option value="ogg">OGG / Opus（实时录制）</option>
      </select>
    </div>

    <div class="grid grid-cols-2 gap-3">
      <div>
        <label class="field-label">采样率</label>
        <select class="field-input" v-model.number="sampleRate">
          <option :value="0">保持（{{ editor.buffer?.sampleRate ?? '-' }}）</option>
          <option :value="22050">22050 Hz</option>
          <option :value="32000">32000 Hz</option>
          <option :value="44100">44100 Hz</option>
          <option :value="48000">48000 Hz</option>
        </select>
      </div>
      <div>
        <label class="field-label">声道</label>
        <select class="field-input" v-model="channelMode">
          <option value="keep">保持</option>
          <option value="mono">单声道</option>
          <option value="stereo">立体声</option>
        </select>
      </div>
    </div>

    <div v-if="format === 'wav'">
      <label class="field-label">位深</label>
      <select class="field-input" v-model.number="bitDepth">
        <option :value="16">16-bit PCM</option>
        <option :value="24">24-bit PCM</option>
        <option :value="32">32-bit Float</option>
      </select>
    </div>

    <div v-if="format === 'mp3'">
      <label class="field-label">比特率</label>
      <select class="field-input" v-model.number="bitrate">
        <option :value="128">128 kbps</option>
        <option :value="192">192 kbps</option>
        <option :value="256">256 kbps</option>
        <option :value="320">320 kbps</option>
      </select>
    </div>

    <div>
      <label class="field-label">范围</label>
      <div class="flex gap-4 text-xs text-slate-300">
        <label class="flex items-center gap-1.5 cursor-pointer">
          <input type="radio" value="all" v-model="range" />
          全曲
        </label>
        <label class="flex items-center gap-1.5 cursor-pointer" :class="{ 'opacity-40': !editor.hasSelection }">
          <input type="radio" value="selection" v-model="range" :disabled="!editor.hasSelection" />
          选区{{ editor.hasSelection ? `（${(editor.selection.end - editor.selection.start).toFixed(1)}s）` : '（未框选）' }}
        </label>
      </div>
    </div>

    <div>
      <label class="field-label">文件名</label>
      <input class="field-input" type="text" v-model="fileName" placeholder="导出文件名" />
    </div>

    <p v-if="format === 'webm' || format === 'ogg'" class="text-[11px] text-warn/80 leading-relaxed">
      该格式通过 MediaRecorder 实时录制导出，耗时约等于音频时长，期间请勿切换标签页。MIME 类型将自动降级探测。
    </p>

    <button
      class="btn btn-primary w-full py-2"
      :disabled="!editor.buffer || exporting || editor.busy.type !== null"
      @click="doExport"
    >
      {{ exporting ? `导出中 ${Math.round(progress * 100)}%` : '开始导出' }}
    </button>

    <div class="h-1.5 rounded bg-abyss-800 overflow-hidden">
      <div
        class="h-full bg-neon shadow-glow transition-all duration-150"
        :style="{ width: `${progress * 100}%` }"
      />
    </div>
  </div>
</template>
