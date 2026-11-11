<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useEditorStore } from '../stores/editor'
import { useToastStore } from '../stores/toast'
import { useAudioExporter, type ExportFormat } from '../composables/useAudioExporter'
import { useProjectPersistence } from '../composables/useProjectPersistence'
import type { TrackMetadata } from '../utils/audio-metadata'
import type { WavBitDepth } from '../utils/wav-encoder'

const editor = useEditorStore()
const toast = useToastStore()
const { exportAudio } = useAudioExporter()
const {
  status: localStatus,
  statusLabel: localLabel,
  statusTitle: localTitle,
  hasSession: localHasSession,
  saveNow,
  deleteLocalProject
} = useProjectPersistence()

function confirmDeleteLocal(): void {
  if (!window.confirm('确定删除本浏览器保存的本地工程备份吗？此操作不可撤销（当前正在编辑的内容不受影响）。')) return
  void deleteLocalProject()
}

const format = ref<ExportFormat>('wav')
const sampleRate = ref(0) // 0 = 保持原采样率
const bitDepth = ref<WavBitDepth>(16)
const channelMode = ref<'keep' | 'mono' | 'stereo'>('keep')
const bitrate = ref(192)
const range = ref<'all' | 'selection'>('all')
const fileName = ref('')
const progress = ref(0)
const phaseText = ref('')
const exporting = ref(false)
const metadata = reactive<TrackMetadata>({ title: '', artist: '', album: '', year: '' })

const usesFfmpeg = computed(() => ['flac', 'm4a', 'ogg', 'webm'].includes(format.value))
const usesBitrate = computed(() => ['mp3', 'm4a', 'ogg', 'webm'].includes(format.value))

watch(
  () => editor.fileName,
  (v) => {
    if (v) {
      fileName.value = v
      if (!metadata.title) metadata.title = v
    }
  },
  { immediate: true }
)

watch(
  () => editor.hasSelection,
  (v) => {
    // 选区被清除后不能停留在「选区导出」，否则导出会直接抛错
    if (!v && range.value === 'selection') range.value = 'all'
  }
)

async function doExport(): Promise<void> {
  if (exporting.value || !editor.buffer) return
  exporting.value = true
  progress.value = 0
  phaseText.value = ''
  try {
    await exportAudio(
      {
        format: format.value,
        sampleRate: sampleRate.value || null,
        bitDepth: bitDepth.value,
        channels: channelMode.value,
        bitrate: bitrate.value,
        range: range.value,
        fileName: fileName.value.trim() || 'audio',
        metadata: { ...metadata }
      },
      (p) => {
        progress.value = p
      },
      (t) => {
        phaseText.value = t
      }
    )
    toast.push('success', '导出完成，已开始下载')
  } catch (err) {
    console.error(err)
    toast.push('error', err instanceof Error ? err.message : '导出失败')
  } finally {
    exporting.value = false
    progress.value = 0
    phaseText.value = ''
  }
}
</script>

<template>
  <div class="space-y-3">
    <div>
      <label class="field-label">格式</label>
      <select class="field-input" v-model="format">
        <option value="wav">WAV（无损 PCM，纯 JS 编码）</option>
        <option value="flac">FLAC（无损压缩，离线编码）</option>
        <option value="mp3">MP3（lamejs 编码 + ID3 标签）</option>
        <option value="m4a">M4A / AAC（离线编码）</option>
        <option value="ogg">OGG / Vorbis·Opus（离线编码）</option>
        <option value="webm">WebM / Opus（离线编码）</option>
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

    <div v-if="usesBitrate">
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

    <div class="panel p-3 space-y-2">
      <label class="field-label">元数据（MP3 写 ID3v2，WAV 写 LIST/INFO，其余写容器标签）</label>
      <div class="grid grid-cols-2 gap-2">
        <input class="field-input" type="text" v-model="metadata.title" placeholder="标题" />
        <input class="field-input" type="text" v-model="metadata.artist" placeholder="艺术家" />
        <input class="field-input" type="text" v-model="metadata.album" placeholder="专辑" />
        <input class="field-input" type="text" maxlength="4" v-model="metadata.year" placeholder="年份" />
      </div>
    </div>

    <p v-if="usesFfmpeg" class="text-[11px] text-slate-500 leading-relaxed">
      ffmpeg.wasm 离线编码，速度远快于实时，切标签页不受影响。首次使用需加载约 31MB 编码核心（本地缓存后免下载）。FLAC 由 16-bit PCM 无损压缩。
    </p>

    <p
      v-if="editor.chain.nodes.length"
      class="text-[11px] leading-relaxed"
      :class="editor.chain.bypass ? 'text-warn/80' : 'text-slate-500'"
    >
      效果链 {{ editor.activeEffectCount }} 个节点：导出前按链顺序离线渲染。
      <template v-if="editor.chain.bypass">当前为 A/B 旁路状态，导出将使用原声、不含效果。</template>
    </p>

    <button
      class="btn btn-primary w-full py-2"
      :disabled="!editor.buffer || exporting || editor.busy.type !== null"
      @click="doExport"
    >
      {{ exporting ? `导出中 ${Math.round(progress * 100)}%` : '开始导出' }}
    </button>

    <p v-if="phaseText" class="text-[11px] text-neon-bright">{{ phaseText }}</p>

    <div class="h-1.5 rounded bg-abyss-800 overflow-hidden">
      <div
        class="h-full bg-neon shadow-glow transition-all duration-150"
        :style="{ width: `${progress * 100}%` }"
      />
    </div>

    <div class="panel p-3 space-y-2 mt-3">
      <div class="flex items-center justify-between gap-2">
        <label class="field-label !mb-0">本地工程备份</label>
        <span
          class="text-[10px] truncate"
          :class="localStatus === 'error' ? 'text-danger' : localStatus === 'oversize' ? 'text-warn' : 'text-neon/70'"
          :title="localTitle"
        >{{ localLabel }}</span>
      </div>
      <p class="text-[11px] text-slate-500 leading-relaxed">
        音轨以原始 Float32 无损写入浏览器本地数据库，编辑指令另存，刷新或关闭页面后自动恢复。跨设备归档请用「保存工程」导出 .yac.zip。
      </p>
      <div class="flex gap-2">
        <button
          class="btn flex-1"
          :disabled="!editor.buffer || localStatus === 'disabled' || localStatus === 'saving'"
          @click="saveNow"
        >
          立即保存
        </button>
        <button class="btn btn-danger flex-1" :disabled="!localHasSession" @click="confirmDeleteLocal">
          删除备份
        </button>
      </div>
    </div>
  </div>
</template>
