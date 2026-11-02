<script setup lang="ts">
import { ref, shallowRef } from 'vue'
import { useEditorStore, type MergeClipInput } from '../stores/editor'
import { useToastStore } from '../stores/toast'
import { audioEngine } from '../audio/engine'
import { getAllChannels } from '../utils/audio-utils'

interface MergeItem {
  id: number
  name: string
  channels: Float32Array[]
  sampleRate: number
  duration: number
}

const editor = useEditorStore()
const toast = useToastStore()

// shallowRef 避免声道数据进入深层响应式
const items = shallowRef<MergeItem[]>([])
const gapSeconds = ref(0.5)
const crossfadeSeconds = ref(0)
const merging = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
let seq = 0

function addCurrent(): void {
  const buf = editor.buffer
  if (!buf) {
    toast.push('error', '请先导入音频')
    return
  }
  const item: MergeItem = {
    id: ++seq,
    name: editor.fileName ?? '当前音轨',
    channels: getAllChannels(buf).map((c) => c.slice()),
    sampleRate: buf.sampleRate,
    duration: buf.duration
  }
  items.value = [...items.value, item]
}

async function onFiles(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const files = input.files ? Array.from(input.files) : []
  input.value = ''
  if (files.length === 0) return
  const ctx = audioEngine.ensureContext()
  for (const file of files) {
    try {
      const decoded = await ctx.decodeAudioData(await file.arrayBuffer())
      const item: MergeItem = {
        id: ++seq,
        name: file.name,
        channels: getAllChannels(decoded).map((c) => c.slice()),
        sampleRate: decoded.sampleRate,
        duration: decoded.duration
      }
      items.value = [...items.value, item]
    } catch {
      toast.push('error', `解码失败：${file.name}`)
    }
  }
}

function move(index: number, dir: -1 | 1): void {
  const next = [...items.value]
  const target = index + dir
  if (target < 0 || target >= next.length) return
  ;[next[index], next[target]] = [next[target], next[index]]
  items.value = next
}

function remove(index: number): void {
  items.value = items.value.filter((_, i) => i !== index)
}

async function doMerge(): Promise<void> {
  if (items.value.length === 0 || merging.value) return
  merging.value = true
  try {
    const clips: MergeClipInput[] = items.value.map((it) => ({
      name: it.name,
      channels: it.channels.map((c) => c.slice()),
      sampleRate: it.sampleRate
    }))
    await editor.mergeClips(clips, Math.max(0, gapSeconds.value), Math.max(0, crossfadeSeconds.value))
    items.value = []
  } finally {
    merging.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <p class="text-xs text-slate-500 leading-relaxed">
      按列表顺序合并。「添加当前音轨」加入正在编辑的音频，也可追加新文件。交叉淡化 > 0 时使用等功率交叉淡化，否则插入静音间隔。
    </p>

    <div class="flex gap-2">
      <button class="btn flex-1" :disabled="!editor.buffer" @click="addCurrent">+ 当前音轨</button>
      <button class="btn flex-1" @click="fileInput?.click()">+ 添加文件</button>
      <input
        ref="fileInput"
        type="file"
        multiple
        accept=".mp3,.wav,.m4a,.ogg,.flac,audio/*"
        class="hidden"
        @change="onFiles"
      />
    </div>

    <ul class="space-y-1.5">
      <li
        v-for="(item, index) in items"
        :key="item.id"
        class="panel px-2.5 py-2 flex items-center gap-2 text-xs"
      >
        <span class="text-neon font-mono">{{ index + 1 }}</span>
        <span class="flex-1 truncate text-slate-200" :title="item.name">{{ item.name }}</span>
        <span class="text-slate-500 font-mono">{{ item.duration.toFixed(1) }}s</span>
        <button class="btn px-1.5 py-0.5" :disabled="index === 0" @click="move(index, -1)">↑</button>
        <button class="btn px-1.5 py-0.5" :disabled="index === items.length - 1" @click="move(index, 1)">↓</button>
        <button class="btn btn-danger px-1.5 py-0.5" @click="remove(index)">×</button>
      </li>
      <li v-if="items.length === 0" class="text-xs text-slate-600 text-center py-3">
        合并列表为空
      </li>
    </ul>

    <div class="grid grid-cols-2 gap-3">
      <div>
        <label class="field-label">间隔（秒）</label>
        <input class="field-input" type="number" min="0" step="0.1" v-model.number="gapSeconds" />
      </div>
      <div>
        <label class="field-label">交叉淡化（秒）</label>
        <input
          class="field-input"
          type="number"
          min="0"
          step="0.1"
          v-model.number="crossfadeSeconds"
        />
      </div>
    </div>
    <p class="text-[11px] text-slate-600">
      {{ crossfadeSeconds > 0 ? `将使用 ${crossfadeSeconds}s 交叉淡化衔接` : `将使用 ${gapSeconds}s 静音间隔` }}
    </p>

    <button
      class="btn btn-primary w-full py-2"
      :disabled="items.length === 0 || merging || editor.busy.type !== null"
      @click="doMerge"
    >
      {{ editor.busy.type === 'merge' ? `合并中 ${Math.round(editor.busy.progress)}%` : '合并并替换当前音轨' }}
    </button>
    <div v-if="editor.busy.type === 'merge'" class="h-1.5 rounded bg-abyss-800 overflow-hidden">
      <div
        class="h-full bg-neon shadow-glow transition-all"
        :style="{ width: `${editor.busy.progress}%` }"
      />
    </div>
  </div>
</template>
