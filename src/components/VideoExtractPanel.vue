<script setup lang="ts">
/**
 * 视频提取面板：选择/拖入视频 -> ffmpeg.wasm 提取音轨为 MP3。
 * 核心按需加载，提取结果可下载或直接载入编辑器。
 */
import { computed, ref, shallowRef } from 'vue'
import { useEditorStore } from '../stores/editor'
import { useToastStore } from '../stores/toast'
import {
  CANCEL_MESSAGE,
  cancelExtraction,
  extractAudio,
  sanitizeFileName,
  type ExtractPhase,
  type ExtractResult
} from '../composables/useVideoExtractor'
import { formatTime } from '../utils/audio-utils'

const editor = useEditorStore()
const toast = useToastStore()

const VIDEO_EXTENSIONS = [
  '.mp4',
  '.mov',
  '.mkv',
  '.webm',
  '.avi',
  '.m4v',
  '.ts',
  '.flv',
  '.wmv',
  '.mpg',
  '.mpeg'
]

const fileInput = ref<HTMLInputElement | null>(null)
const file = ref<File | null>(null)
const durationHint = ref(0)
const metaLoading = ref(false)
const running = ref(false)
const phase = ref<'idle' | ExtractPhase | 'done' | 'error'>('idle')
const loadProgress = ref(0)
const progress = ref(0)
const elapsed = ref(0)
const total = ref(0)
const errorText = ref('')
const result = shallowRef<ExtractResult | null>(null)

const bitrate = ref(192)
const keepOriginalRate = ref(true)

const barPercent = computed(() => {
  if (phase.value === 'loading') return Math.min(0.95, loadProgress.value) * 100
  if (phase.value === 'probing') return 96
  if (phase.value === 'done') return 100
  return progress.value * 100
})

const statusLabel = computed(() => {
  switch (phase.value) {
    case 'loading':
      return `加载 ffmpeg 核心 ${Math.round(loadProgress.value * 100)}%（首次约 32MB，之后走本地缓存）`
    case 'probing':
      return '探测视频音轨…'
    case 'extracting':
      return total.value > 0
        ? `提取中 ${Math.round(progress.value * 100)}%`
        : `提取中（已处理 ${formatTime(elapsed.value)}）`
    case 'done':
      return '提取完成'
    default:
      return ''
  }
})

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function isVideoFile(f: File): boolean {
  return (
    f.type.startsWith('video/') ||
    VIDEO_EXTENSIONS.some((ext) => f.name.toLowerCase().endsWith(ext))
  )
}

/** 用 video 元素读取时长，失败时返回 0（不阻塞提取） */
function readDuration(f: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(f)
    const video = document.createElement('video')
    let settled = false
    const finish = (d: number) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      video.removeAttribute('src')
      URL.revokeObjectURL(url)
      resolve(d)
    }
    const timer = window.setTimeout(() => finish(0), 8000)
    video.preload = 'metadata'
    video.onloadedmetadata = () => finish(Number.isFinite(video.duration) ? video.duration : 0)
    video.onerror = () => finish(0)
    video.src = url
  })
}

async function selectFile(f: File): Promise<void> {
  if (running.value) {
    toast.push('info', '正在提取中，请先等待完成或取消')
    return
  }
  if (!isVideoFile(f)) {
    toast.push('error', '请选择视频文件（mp4 / mov / mkv / webm 等）')
    return
  }
  file.value = f
  result.value = null
  errorText.value = ''
  phase.value = 'idle'
  progress.value = 0
  elapsed.value = 0
  total.value = 0
  durationHint.value = 0
  metaLoading.value = true
  const token = ++metaToken
  const d = await readDuration(f)
  if (token !== metaToken) return
  durationHint.value = d
  metaLoading.value = false
}

let metaToken = 0

function pickFile(): void {
  if (running.value) return
  fileInput.value?.click()
}

function onFileChange(e: Event): void {
  const input = e.target as HTMLInputElement
  const picked = input.files?.[0]
  input.value = ''
  if (picked) void selectFile(picked)
}

function onDrop(e: DragEvent): void {
  const dropped = e.dataTransfer?.files?.[0]
  if (dropped) void selectFile(dropped)
}

async function startExtract(): Promise<void> {
  const f = file.value
  if (!f || running.value) return
  running.value = true
  result.value = null
  errorText.value = ''
  phase.value = 'loading'
  loadProgress.value = 0
  progress.value = 0
  elapsed.value = 0
  total.value = durationHint.value

  try {
    const res = await extractAudio(
      f,
      { bitrate: bitrate.value, keepOriginalRate: keepOriginalRate.value, durationHint: durationHint.value },
      {
        onPhase: (p) => {
          phase.value = p
        },
        onLoadProgress: (p) => {
          phase.value = 'loading'
          loadProgress.value = p
        },
        onProgress: (p, t, d) => {
          progress.value = p
          elapsed.value = t
          total.value = d
        }
      }
    )
    result.value = res
    phase.value = 'done'
    durationHint.value = res.duration || durationHint.value
    toast.push('success', `提取完成：${formatBytes(res.blob.size)}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : '提取失败'
    if (msg === CANCEL_MESSAGE) {
      phase.value = 'idle'
      toast.push('info', '已取消提取')
    } else {
      phase.value = 'error'
      errorText.value = msg
      toast.push('error', msg)
      console.error(err)
    }
  } finally {
    running.value = false
    loadProgress.value = 0
  }
}

function cancel(): void {
  if (!running.value) return
  cancelExtraction()
}

function downloadResult(): void {
  const r = result.value
  if (!r) return
  const url = URL.createObjectURL(r.blob)
  const a = document.createElement('a')
  a.href = url
  a.download = r.fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 5000)
}

async function loadIntoEditor(): Promise<void> {
  const r = result.value
  if (!r) return
  const expectedName = r.fileName.replace(/\.mp3$/i, '')
  const asFile = new File([r.blob], `${sanitizeFileName(r.fileName)}.mp3`, { type: 'audio/mpeg' })
  await editor.loadFile(asFile)
  if (editor.fileName === expectedName) {
    editor.sidebarTab = 'edit'
    toast.push('success', '已载入编辑器，可继续剪辑')
  }
}
</script>

<template>
  <div class="space-y-4">
    <p class="text-xs text-slate-500 leading-relaxed">
      在浏览器本地用 ffmpeg.wasm（单线程核心）提取视频音轨，文件不会上传到服务器。
    </p>

    <div
      class="panel p-4 text-center cursor-pointer transition-colors hover:border-neon/40"
      @click="pickFile"
      @dragenter.prevent.stop
      @dragover.prevent.stop
      @drop.prevent.stop="onDrop"
    >
      <input
        ref="fileInput"
        type="file"
        class="hidden"
        accept="video/*,.mp4,.mov,.mkv,.webm,.avi,.m4v,.ts,.flv,.wmv,.mpg,.mpeg"
        @change="onFileChange"
      />
      <template v-if="file">
        <p class="text-sm text-slate-200 truncate" :title="file.name">{{ file.name }}</p>
        <p class="text-[11px] text-slate-500 mt-1">
          {{ formatBytes(file.size) }} ·
          {{ durationHint > 0 ? formatTime(durationHint) : metaLoading ? '读取时长…' : '时长未知' }}
        </p>
        <p class="text-[11px] text-neon/80 mt-2">点击更换视频</p>
      </template>
      <template v-else>
        <p class="text-xs text-slate-400">点击选择视频，或拖拽视频到此处</p>
        <p class="text-[11px] text-slate-600 mt-1">mp4 / mov / mkv / webm / avi 等</p>
      </template>
    </div>

    <div class="grid grid-cols-2 gap-3">
      <div>
        <label class="field-label">MP3 比特率</label>
        <select class="field-input" v-model.number="bitrate" :disabled="running">
          <option :value="128">128 kbps</option>
          <option :value="192">192 kbps</option>
          <option :value="320">320 kbps</option>
        </select>
      </div>
      <div class="flex items-end pb-0.5">
        <label class="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
          <input type="checkbox" v-model="keepOriginalRate" :disabled="running" />
          保留原始采样率
        </label>
      </div>
    </div>

    <div v-if="running || phase === 'done'" class="space-y-1.5">
      <div class="h-1.5 rounded bg-abyss-800 overflow-hidden">
        <div
          class="h-full bg-neon shadow-glow transition-all duration-150"
          :style="{ width: `${barPercent}%` }"
        />
      </div>
      <div class="flex items-center justify-between gap-2 text-[11px] text-slate-500">
        <span class="truncate">{{ statusLabel }}</span>
        <span v-if="phase === 'extracting' && total > 0" class="font-mono shrink-0">
          {{ formatTime(elapsed) }} / {{ formatTime(total) }}
        </span>
      </div>
    </div>

    <div class="flex gap-2">
      <button
        class="btn btn-primary flex-1 py-2"
        :disabled="!file || running"
        @click="startExtract"
      >
        {{ running ? '处理中…' : '开始提取' }}
      </button>
      <button v-if="running" class="btn btn-danger px-3" @click="cancel">取消</button>
    </div>

    <div
      v-if="phase === 'error'"
      class="panel p-3 border border-danger/40 text-xs text-danger leading-relaxed"
    >
      {{ errorText }}
    </div>

    <div v-if="result" class="panel p-3 space-y-2">
      <p class="text-xs text-slate-200 truncate" :title="result.fileName">{{ result.fileName }}</p>
      <p class="text-[11px] text-slate-500">
        {{ formatBytes(result.blob.size) }}
        <span v-if="result.duration > 0"> · {{ formatTime(result.duration) }}</span>
      </p>
      <div class="grid grid-cols-2 gap-2">
        <button class="btn btn-primary" @click="downloadResult">下载 MP3</button>
        <button class="btn" :disabled="editor.busy.type !== null" @click="loadIntoEditor">
          载入编辑器
        </button>
      </div>
    </div>

    <p class="text-[11px] text-slate-600 leading-relaxed">
      核心文件自托管，首次使用需下载约 32MB；提取耗时随视频长度增长，期间请保持页面在前台。取消会终止处理并清理虚拟文件系统。
    </p>
  </div>
</template>
