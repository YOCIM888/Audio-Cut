<script setup lang="ts">
/**
 * 批量文件处理 / 批量导出面板。
 * 与编辑器当前音轨无关：单独拖入多个音频文件，串行做「去静音 → 淡变 → 增益
 * → LUFS 归一化 / 限制 → 编码」，最后逐个下载或打成一个 zip。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useEditorStore } from '../stores/editor'
import {
  defaultBatchOptions,
  useBatchProcessor,
  type BatchFormat,
  type BatchOptions
} from '../composables/useBatchProcessor'
import { useToastStore } from '../stores/toast'
import type { WavBitDepth } from '../utils/wav-encoder'

function onBitDepth(e: Event): void {
  opts.value.bitDepth = Number((e.target as HTMLSelectElement).value) as WavBitDepth
}

const editor = useEditorStore()
const toast = useToastStore()
const { items, running, progress, phase, overallLabel, setFiles, clear, cancel, run } =
  useBatchProcessor()

// 批量任务也占用全局忙状态：顶栏显示进度，撤销 / 导入等按钮同步禁用
watch(running, (v) => {
  editor.busy.type = v ? 'batch' : null
  editor.busy.progress = 0
})
watch(progress, (p) => {
  if (running.value) editor.busy.progress = p * 100
})
onBeforeUnmount(() => {
  if (editor.busy.type === 'batch') editor.busy.type = null
})

const files = ref<File[]>([])
const opts = ref<BatchOptions>(defaultBatchOptions())
const fileInput = ref<HTMLInputElement | null>(null)
const dragging = ref(false)

const formats: { value: BatchFormat; label: string }[] = [
  { value: 'wav', label: 'WAV' },
  { value: 'mp3', label: 'MP3' },
  { value: 'flac', label: 'FLAC' },
  { value: 'm4a', label: 'AAC / M4A' },
  { value: 'ogg', label: 'Ogg / Opus' },
  { value: 'webm', label: 'WebM / Opus' }
]

const doneCount = computed(() => items.value.filter((i) => i.status === 'done').length)
const errorCount = computed(() => items.value.filter((i) => i.status === 'error').length)
const totalBytes = computed(() => items.value.reduce((n, i) => n + i.bytes, 0))

function addFiles(list: File[]): void {
  if (running.value) return
  const accepted = list.filter(
    (f) => /\.(mp3|wav|m4a|aac|ogg|oga|flac|webm|opus|mp4|mov|mkv)$/i.test(f.name) || f.type.startsWith('audio/')
  )
  if (!accepted.length) {
    toast.push('error', '没有可识别的音频文件')
    return
  }
  if (accepted.length < list.length) {
    toast.push('info', `已忽略 ${list.length - accepted.length} 个非音频文件`)
  }
  files.value = [...files.value, ...accepted]
  setFiles(files.value)
}

function onPick(e: Event): void {
  const input = e.target as HTMLInputElement
  if (input.files?.length) addFiles(Array.from(input.files))
  input.value = ''
}

function onDrop(e: DragEvent): void {
  dragging.value = false
  if (e.dataTransfer?.files?.length) addFiles(Array.from(e.dataTransfer.files))
}

function removeFile(index: number): void {
  if (running.value) return
  files.value = files.value.filter((_, i) => i !== index)
  setFiles(files.value)
}

function clearAll(): void {
  if (running.value) return
  files.value = []
  clear()
}

async function start(): Promise<void> {
  if (!files.value.length) {
    toast.push('info', '请先添加要处理的文件')
    return
  }
  await run(files.value, { ...opts.value, silence: { ...opts.value.silence } })
  if (errorCount.value) toast.push('error', `${errorCount.value} 个文件处理失败，请查看列表`)
  else toast.push('success', `批量处理完成：${doneCount.value} 个文件`)
}

function statusText(s: string): string {
  switch (s) {
    case 'done':
      return '完成'
    case 'processing':
      return '处理中'
    case 'error':
      return '失败'
    case 'skipped':
      return '已跳过'
    default:
      return '等待'
  }
}

function statusClass(s: string): string {
  if (s === 'done') return 'text-neon'
  if (s === 'error') return 'text-danger'
  if (s === 'processing') return 'text-warn'
  return 'text-slate-500'
}
</script>

<template>
  <div class="space-y-3">
    <!-- 文件列表 -->
    <div class="panel p-3 space-y-2">
      <div class="flex items-center justify-between">
        <label class="field-label !mb-0">待处理文件（{{ files.length }}）</label>
        <span class="text-[10px] text-slate-600">串行处理 · Worker 分析</span>
      </div>

      <div
        class="border border-dashed rounded px-3 py-4 text-center text-[11px] transition-colors cursor-pointer"
        :class="dragging ? 'border-neon bg-neon/10 text-neon' : 'border-neon/25 text-slate-500 hover:border-neon/60'"
        @click="fileInput?.click()"
        @dragover.prevent="dragging = true"
        @dragleave.prevent="dragging = false"
        @drop.prevent="onDrop"
      >
        点击选择，或把多个音频文件拖到这里
        <div class="text-[9px] text-slate-600 mt-1">mp3 / wav / m4a / ogg / flac / webm</div>
      </div>
      <input
        ref="fileInput"
        type="file"
        multiple
        accept=".mp3,.wav,.m4a,.aac,.ogg,.flac,.webm,.opus,audio/*"
        class="hidden"
        @change="onPick"
      />

      <div v-if="files.length" class="max-h-40 overflow-y-auto space-y-1 pr-1">
        <div
          v-for="(f, i) in files"
          :key="`${f.name}-${i}`"
          class="flex items-center gap-1.5 bg-abyss-800/60 rounded px-1.5 py-1"
        >
          <span class="text-[11px] text-slate-200 flex-1 truncate" :title="f.name">{{ f.name }}</span>
          <span class="text-[9px] text-slate-600 shrink-0">{{ (f.size / 1024 / 1024).toFixed(1) }}M</span>
          <button class="btn btn-danger px-1 py-0.5 text-[10px]" :disabled="running" @click="removeFile(i)">×</button>
        </div>
      </div>

      <div class="flex gap-2">
        <button class="btn flex-1" :disabled="running || !files.length" @click="clearAll">清空列表</button>
        <button class="btn flex-1" :disabled="running" @click="fileInput?.click()">＋ 添加</button>
      </div>
    </div>

    <!-- 输出格式 -->
    <div class="panel p-3 space-y-2">
      <label class="field-label">输出格式</label>
      <div class="grid grid-cols-2 gap-2">
        <select class="field-input" v-model="opts.format">
          <option v-for="f in formats" :key="f.value" :value="f.value">{{ f.label }}</option>
        </select>
        <select class="field-input" v-model="opts.output">
          <option value="zip">打包为一个 ZIP</option>
          <option value="individual">逐个下载</option>
        </select>
      </div>
      <div v-if="opts.format === 'wav'" class="grid grid-cols-2 gap-2 items-center">
        <select class="field-input" :value="opts.bitDepth" @change="onBitDepth">
          <option :value="16">16-bit PCM</option>
          <option :value="24">24-bit PCM</option>
          <option :value="32">32-bit float</option>
        </select>
        <label class="flex items-center gap-1.5 text-[11px] text-slate-300 cursor-pointer">
          <input type="checkbox" v-model="opts.dither" :disabled="opts.bitDepth === 32" />
          TPDF 抖动（16/24-bit）
        </label>
      </div>
      <div v-else>
        <span class="text-[10px] text-slate-500">码率 {{ opts.bitrate }} kbps</span>
        <input class="neon-range w-full" type="range" min="64" max="320" step="16" v-model.number="opts.bitrate" />
      </div>
    </div>

    <!-- 处理链 -->
    <div class="panel p-3 space-y-2">
      <label class="field-label">批量处理链</label>

      <label class="flex items-center justify-between text-[11px] text-slate-300 cursor-pointer">
        <span class="flex items-center gap-1.5">
          <input type="checkbox" v-model="opts.normalizeLufs" /> 响度归一化
        </span>
        <span class="flex items-center gap-1">
          <input class="field-input !w-16 !py-0.5 !text-[11px]" type="number" min="-40" max="0" step="0.5" v-model.number="opts.targetLufs" :disabled="!opts.normalizeLufs" />
          <span class="text-slate-500">LUFS</span>
        </span>
      </label>
      <label class="flex items-center gap-1.5 text-[11px] text-slate-300 cursor-pointer" :class="{ 'opacity-40': !opts.normalizeLufs }">
        <input type="checkbox" v-model="opts.useLimiter" :disabled="!opts.normalizeLufs" />
        真峰值限制器（上限
        <select class="field-input !w-20 !py-0.5 !text-[11px]" v-model.number="opts.ceilingDbTp" :disabled="!opts.normalizeLufs">
          <option :value="-1">-1 dBTP</option>
          <option :value="-2">-2 dBTP</option>
          <option :value="-3">-3 dBTP</option>
          <option :value="-6">-6 dBTP</option>
        </select>
        ）
      </label>

      <div class="flex items-center gap-2">
        <span class="text-[10px] text-slate-500 w-16 shrink-0">静态增益 {{ opts.gainDb }} dB</span>
        <input class="neon-range flex-1" type="range" min="-24" max="24" step="0.5" v-model.number="opts.gainDb" />
      </div>

      <label class="flex items-center gap-1.5 text-[11px] text-slate-300 cursor-pointer">
        <input type="checkbox" v-model="opts.trimSilence" /> 自动移除静音段
      </label>
      <div v-if="opts.trimSilence" class="grid grid-cols-2 gap-2 pl-4">
        <div>
          <span class="text-[10px] text-slate-500">阈值 {{ opts.silence.thresholdDb }} dB</span>
          <input class="neon-range w-full" type="range" min="-70" max="-20" step="1" v-model.number="opts.silence.thresholdDb" />
        </div>
        <div>
          <span class="text-[10px] text-slate-500">最短静音 {{ opts.silence.minSilenceMs }} ms</span>
          <input class="neon-range w-full" type="range" min="50" max="2000" step="50" v-model.number="opts.silence.minSilenceMs" />
        </div>
        <div>
          <span class="text-[10px] text-slate-500">最短有声 {{ opts.silence.minSoundMs }} ms</span>
          <input class="neon-range w-full" type="range" min="50" max="1000" step="50" v-model.number="opts.silence.minSoundMs" />
        </div>
        <div>
          <span class="text-[10px] text-slate-500">保留余量 {{ opts.silence.padMs }} ms</span>
          <input class="neon-range w-full" type="range" min="0" max="500" step="10" v-model.number="opts.silence.padMs" />
        </div>
      </div>

      <div class="grid grid-cols-2 gap-2">
        <div>
          <span class="text-[10px] text-slate-500">淡入 {{ opts.fadeInMs }} ms</span>
          <input class="neon-range w-full" type="range" min="0" max="2000" step="10" v-model.number="opts.fadeInMs" />
        </div>
        <div>
          <span class="text-[10px] text-slate-500">淡出 {{ opts.fadeOutMs }} ms</span>
          <input class="neon-range w-full" type="range" min="0" max="2000" step="10" v-model.number="opts.fadeOutMs" />
        </div>
      </div>
      <p class="text-[10px] text-slate-600 leading-relaxed">
        顺序固定为：解码 → 去静音 → 淡变 → 增益 → 测响度 → 归一化 / 限制 → 编码。
        「去静音」会拼接有声段，适合播客批量剪掉停顿。
      </p>
    </div>

    <!-- 执行 -->
    <div class="panel p-3 space-y-2">
      <div class="flex gap-2">
        <button class="btn btn-primary flex-1 py-2" :disabled="running || !files.length" @click="start">
          {{ running ? `处理中 ${Math.round(progress * 100)}%` : `开始批量处理（${files.length}）` }}
        </button>
        <button v-if="running" class="btn btn-danger px-3 py-2" @click="cancel">取消</button>
      </div>
      <div v-if="running || items.length" class="h-1.5 rounded bg-abyss-800 overflow-hidden">
        <div class="h-full bg-neon shadow-glow transition-all" :style="{ width: `${progress * 100}%` }" />
      </div>
      <div class="flex justify-between text-[10px] text-slate-500">
        <span>{{ overallLabel }}</span>
        <span v-if="phase" class="text-neon-bright truncate max-w-[55%] text-right">{{ phase }}</span>
      </div>
    </div>

    <!-- 结果 -->
    <div v-if="items.length" class="panel p-3 space-y-1.5">
      <div class="flex items-center justify-between">
        <label class="field-label !mb-0">处理结果</label>
        <span class="text-[10px] text-slate-500">
          成功 {{ doneCount }} · 失败 {{ errorCount }} · {{ (totalBytes / 1024 / 1024).toFixed(1) }} MB
        </span>
      </div>
      <div class="max-h-52 overflow-y-auto space-y-1 pr-1">
        <div v-for="(it, i) in items" :key="`${it.name}-${i}`" class="bg-abyss-800/60 rounded px-1.5 py-1">
          <div class="flex items-center gap-2">
            <span class="text-[11px] text-slate-200 truncate flex-1" :title="it.name">{{ it.name }}</span>
            <span class="text-[10px] shrink-0" :class="statusClass(it.status)">{{ statusText(it.status) }}</span>
          </div>
          <div v-if="it.message" class="text-[9px] text-slate-500 truncate" :title="it.message">{{ it.message }}</div>
          <div v-if="it.status === 'done' && Number.isFinite(it.lufs)" class="text-[9px] text-slate-600">
            原始 {{ it.lufs.toFixed(1) }} LUFS · {{ it.duration.toFixed(1) }}s
          </div>
        </div>
      </div>
    </div>

    <p class="text-[11px] text-slate-600 leading-relaxed">
      全部在浏览器本地完成，不上传任何音频。大文件建议优先选 WAV / FLAC；
      MP3 与 ffmpeg 格式需要额外编码时间，处理期间请勿关闭标签页。
    </p>
  </div>
</template>
