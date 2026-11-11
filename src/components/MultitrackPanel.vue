<script setup lang="ts">
/**
 * 多轨面板：麦克风录音、导入片段、轨道管理、选中片段参数与效果链作用域。
 * 时间线的拖动/裁剪在 TimelineEditor 完成，这里负责参数化操作与素材入口。
 */
import { computed, onMounted, ref } from 'vue'
import { useEditorStore } from '../stores/editor'
import { useToastStore } from '../stores/toast'
import { useRecorder } from '../composables/useRecorder'
import { audioEngine } from '../audio/engine'
import { formatTime, getAllChannels } from '../utils/audio-utils'
import { MAIN_TRACK_ID, type ChainTarget } from '../audio/multitrack'

const editor = useEditorStore()
const toast = useToastStore()
const rec = useRecorder()
const {
  devices,
  deviceId,
  processing,
  monitor,
  recording,
  paused,
  starting,
  elapsedLabel,
  levelPercent,
  peakPercent,
  error
} = rec

const fileInput = ref<HTMLInputElement | null>(null)
const importing = ref(false)
const insertTrackId = ref('')
const targetTracks = computed(() => editor.tracks.filter((t) => t.kind === 'audio'))
const clip = computed(() => editor.selectedClip)
const busy = computed(() => editor.busy.type !== null)

onMounted(() => {
  void rec.refreshDevices()
})

function dbText(v: number): string {
  return `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`
}

async function startRecording(): Promise<void> {
  await rec.start()
  if (error.value) toast.push('error', error.value, 6000)
  else toast.push('info', '录音中：默认关闭回声消除/降噪/自动增益，且不回放监听，避免啸叫', 5000)
}

function stopRecording(): void {
  const result = rec.stop()
  if (!result) return
  if (result.channels[0].length < 128) {
    toast.push('error', '录音太短，已丢弃')
    return
  }
  const stamp = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const at = audioEngine.getPosition()
  editor.addClip(
    result.channels.map((c) => c.slice()),
    result.sampleRate,
    `录音 ${stamp}`,
    at,
    insertTrackId.value || undefined
  )
  toast.push(
    'success',
    `录音完成：${result.duration.toFixed(1)}s / ${result.channels.length}ch / ${result.sampleRate}Hz，已放到 ${at.toFixed(2)}s 处的新轨道`
  )
}

function cancelRecording(): void {
  rec.cancel()
  toast.push('info', '录音已取消')
}

async function importClips(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!files.length || importing.value) return
  importing.value = true
  editor.busy.type = 'tracks'
  const at = audioEngine.getPosition()
  let ok = 0
  try {
    const ctx = audioEngine.ensureContext()
    for (const f of files) {
      try {
        const decoded = await ctx.decodeAudioData(await f.arrayBuffer())
        const channels = getAllChannels(decoded).map((c) => c.slice())
        editor.addClip(channels, decoded.sampleRate, f.name.replace(/\.[^.]+$/, ''), at, insertTrackId.value || undefined)
        ok++
      } catch (err) {
        console.warn('[multitrack] 片段解码失败', f.name, err)
        toast.push('error', `${f.name} 解码失败`)
      }
    }
  } finally {
    editor.busy.type = null
    importing.value = false
  }
  if (ok) {
    editor.setMainView('timeline')
    toast.push('success', `已插入 ${ok} 个片段到 ${at.toFixed(2)}s（每个片段独立轨道）`)
  }
}

function setChainTarget(e: Event): void {
  editor.setChainTarget((e.target as HTMLSelectElement).value as ChainTarget)
}

function splitAtPlayhead(): void {
  if (!clip.value) return
  editor.splitClip(clip.value.id, audioEngine.getPosition())
}

function setNum(key: 'start' | 'offset' | 'duration' | 'gainDb' | 'fadeInMs' | 'fadeOutMs', e: Event): void {
  if (!clip.value) return
  const v = Number((e.target as HTMLInputElement).value)
  if (Number.isFinite(v)) editor.updateClip(clip.value.id, { [key]: v })
}
</script>

<template>
  <div class="space-y-3">
    <!-- 麦克风录音 -->
    <div class="panel p-3 space-y-2">
      <div class="flex items-center justify-between">
        <label class="field-label !mb-0">麦克风录音</label>
        <span class="font-mono text-xs" :class="recording ? 'text-danger' : 'text-slate-500'">
          {{ elapsedLabel }}
        </span>
      </div>

      <select class="field-input" v-model="deviceId">
        <option value="">系统默认输入</option>
        <option v-for="d in devices" :key="d.id" :value="d.id">{{ d.label }}</option>
      </select>
      <button class="btn w-full text-[10px]" :disabled="recording" @click="rec.refreshDevices()">
        刷新设备列表
      </button>

      <div class="flex gap-3 text-[10px] text-slate-400">
        <label class="flex items-center gap-1 cursor-pointer">
          <input type="checkbox" v-model="processing" :disabled="recording" /> 浏览器降噪/增益
        </label>
        <label class="flex items-center gap-1 cursor-pointer">
          <input type="checkbox" v-model="monitor" :disabled="recording" /> 监听（注意啸叫）
        </label>
      </div>

      <!-- 输入电平 -->
      <div class="space-y-1">
        <div class="flex items-center gap-2">
          <span class="text-[9px] text-slate-500 w-8">RMS</span>
          <div class="flex-1 h-2 rounded bg-abyss-800 overflow-hidden">
            <div
              class="h-full transition-all duration-75"
              :class="peakPercent > 98 ? 'bg-danger' : 'bg-neon'"
              :style="{ width: `${levelPercent}%` }"
            />
          </div>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-[9px] text-slate-500 w-8">Peak</span>
          <div class="flex-1 h-2 rounded bg-abyss-800 overflow-hidden">
            <div
              class="h-full transition-all duration-75"
              :class="peakPercent > 98 ? 'bg-danger' : 'bg-warn'"
              :style="{ width: `${peakPercent}%` }"
            />
          </div>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-2">
        <button
          v-if="!recording"
          class="btn btn-primary"
          :disabled="starting"
          @click="startRecording"
        >
          {{ starting ? '正在打开麦克风…' : '● 开始录音' }}
        </button>
        <template v-else>
          <button class="btn" @click="rec.togglePause()">{{ paused ? '继续' : '暂停' }}</button>
          <button class="btn btn-danger" @click="stopRecording">■ 停止并插入</button>
        </template>
        <button
          v-if="!recording"
          class="btn"
          :disabled="!editor.buffer"
          title="不录音时也可以先建轨"
          @click="editor.addTrack()"
        >
          ＋ 空轨道
        </button>
        <button v-else class="btn" @click="cancelRecording">取消录音</button>
      </div>
      <p v-if="error" class="text-[10px] text-danger">{{ error }}</p>
      <p class="text-[10px] text-slate-600 leading-relaxed">
        从当前播放头位置开始录，结束后自动建成一条新轨道。AudioWorklet 采集原始 Float32，
        不经过 MediaRecorder 的有损压缩；浏览器不支持时自动回退兼容采集。
      </p>
    </div>

    <!-- 导入片段 -->
    <div class="panel p-3 space-y-2">
      <label class="field-label">导入音频为片段</label>
      <select class="field-input" v-model="insertTrackId">
        <option value="">每个文件自动新建轨道</option>
        <option v-for="t in targetTracks" :key="t.id" :value="t.id">追加到：{{ t.name }}</option>
      </select>
      <button class="btn btn-primary w-full" :disabled="importing" @click="fileInput?.click()">
        {{ importing ? '解码中…' : '选择多个音频文件' }}
      </button>
      <input
        ref="fileInput"
        type="file"
        multiple
        accept=".mp3,.wav,.m4a,.ogg,.flac,.webm,audio/*"
        class="hidden"
        @change="importClips"
      />
      <p class="text-[10px] text-slate-600">全部插入到当前播放头 {{ formatTime(audioEngine.getPosition()) }}，可在时间线上拖到任意位置。</p>
    </div>

    <!-- 轨道与链作用域 -->
    <div class="panel p-3 space-y-2">
      <div class="flex items-center justify-between">
        <label class="field-label !mb-0">轨道（{{ editor.tracks.length }}）</label>
        <button class="btn px-2 py-0.5 text-[10px]" @click="editor.addTrack()">＋ 添加</button>
      </div>
      <div class="max-h-40 overflow-y-auto space-y-1 pr-1">
        <div
          v-for="(t, i) in editor.tracks"
          :key="t.id"
          class="flex items-center gap-1.5 bg-abyss-800/60 rounded px-1.5 py-1"
          :class="{ 'opacity-50': !editor.audibleTracks.has(t.id) }"
        >
          <span class="w-2 h-2 rounded-sm shrink-0" :style="{ background: t.color }" />
          <span class="text-[11px] text-slate-200 flex-1 truncate">{{ i + 1 }}. {{ t.name }}</span>
          <span class="text-[9px] text-slate-600">{{ editor.trackClipCount.get(t.id) ?? 0 }} 片段</span>
          <button class="btn px-1 py-0 text-[9px]" :class="{ 'btn-primary': t.muted }" @click="editor.updateTrack(t.id, { muted: !t.muted })">M</button>
          <button class="btn px-1 py-0 text-[9px]" :class="{ 'btn-primary': t.solo }" @click="editor.updateTrack(t.id, { solo: !t.solo })">S</button>
          <button
            v-if="t.id !== MAIN_TRACK_ID"
            class="btn btn-danger px-1 py-0 text-[9px]"
            @click="editor.removeTrack(t.id)"
          >×</button>
        </div>
      </div>
      <div>
        <label class="field-label">效果链作用于</label>
        <select class="field-input" :value="editor.chainTarget" @change="setChainTarget">
          <option value="main">仅主轨（默认）</option>
          <option value="mix">整个混音（含所有其它轨）</option>
        </select>
      </div>
      <p class="text-[10px] text-slate-600 leading-relaxed">
        主轨增益 / 声像同时作用于试听与导出；有 Solo 时只听 Solo 轨，否则排除静音轨。
      </p>
    </div>

    <!-- 选中片段检查器 -->
    <div v-if="clip" class="panel p-3 space-y-2">
      <div class="flex items-center justify-between">
        <label class="field-label !mb-0">片段检查器</label>
        <span class="text-[9px] text-slate-600 font-mono">{{ clip.id.slice(-8) }}</span>
      </div>
      <input
        class="field-input"
        :value="clip.name"
        @change="editor.updateClip(clip.id, { name: ($event.target as HTMLInputElement).value })"
      />
      <div class="grid grid-cols-2 gap-2">
        <label class="text-[10px] text-slate-500">
          起点 (s)
          <input class="field-input !py-0.5" type="number" min="0" step="0.01" :value="clip.start.toFixed(3)" @change="setNum('start', $event)" />
        </label>
        <label class="text-[10px] text-slate-500">
          时长 (s)
          <input class="field-input !py-0.5" type="number" min="0.001" step="0.01" :value="clip.duration.toFixed(3)" @change="setNum('duration', $event)" />
        </label>
        <label class="text-[10px] text-slate-500">
          源内偏移 (s)
          <input class="field-input !py-0.5" type="number" min="0" step="0.01" :value="clip.offset.toFixed(3)" @change="setNum('offset', $event)" />
        </label>
        <label class="text-[10px] text-slate-500">
          片段增益 (dB)
          <input class="field-input !py-0.5" type="number" min="-60" max="12" step="0.5" :value="clip.gainDb" @change="setNum('gainDb', $event)" />
        </label>
        <label class="text-[10px] text-slate-500">
          淡入 (ms)
          <input class="field-input !py-0.5" type="number" min="0" max="10000" step="10" :value="clip.fadeInMs" @change="setNum('fadeInMs', $event)" />
        </label>
        <label class="text-[10px] text-slate-500">
          淡出 (ms)
          <input class="field-input !py-0.5" type="number" min="0" max="10000" step="10" :value="clip.fadeOutMs" @change="setNum('fadeOutMs', $event)" />
        </label>
      </div>
      <select class="field-input" :value="clip.trackId" @change="editor.updateClip(clip.id, { trackId: ($event.target as HTMLSelectElement).value })">
        <option v-for="t in targetTracks" :key="t.id" :value="t.id">所在轨：{{ t.name }}</option>
      </select>
      <p class="text-[10px] text-slate-600">
        {{ clip.channels.length }}ch / {{ clip.sampleRate }}Hz · 源长 {{ clip.sourceDuration.toFixed(2) }}s · {{ dbText(clip.gainDb) }}
      </p>
      <div class="grid grid-cols-3 gap-1.5">
        <button class="btn text-[10px]" :disabled="busy" @click="splitAtPlayhead">播放头拆分</button>
        <button class="btn text-[10px]" @click="editor.duplicateClip(clip.id)">复制</button>
        <button class="btn btn-danger text-[10px]" @click="editor.removeClip(clip.id)">删除</button>
      </div>
    </div>

    <div class="panel p-3 space-y-1.5">
      <label class="field-label">时间线总览</label>
      <div class="grid grid-cols-3 gap-1 text-center">
        <div class="bg-abyss-800/60 rounded py-1.5">
          <div class="text-[9px] text-slate-500">轨道</div>
          <div class="font-mono text-sm text-neon">{{ editor.tracks.length }}</div>
        </div>
        <div class="bg-abyss-800/60 rounded py-1.5">
          <div class="text-[9px] text-slate-500">片段</div>
          <div class="font-mono text-sm text-neon">{{ editor.clips.length }}</div>
        </div>
        <div class="bg-abyss-800/60 rounded py-1.5">
          <div class="text-[9px] text-slate-500">总长</div>
          <div class="font-mono text-sm text-neon">{{ editor.timelineLength.toFixed(1) }}s</div>
        </div>
      </div>
      <button class="btn w-full" @click="editor.setMainView('timeline')">打开多轨时间线视图</button>
      <p class="text-[10px] text-slate-600 leading-relaxed">
        导出时到「导出」页选择「整条时间线混音」，会把所有可听轨按增益/声像/淡变离线混合后编码。
      </p>
      <button class="btn btn-danger w-full" :disabled="!editor.hasMultitrack" @click="editor.clearMultitrack()">
        清空全部多轨（可撤销）
      </button>
    </div>
  </div>
</template>
