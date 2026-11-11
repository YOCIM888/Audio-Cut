<script setup lang="ts">
/** 标记 / Cue 列表、吸附精度、选区微调与静音自动分段 */
import { computed, ref } from 'vue'
import { useEditorStore, SNAP_GRIDS, type SilencePresetOptions } from '../stores/editor'
import { useToastStore } from '../stores/toast'
import { formatMarkerTime, markersToCsv, csvToMarkers } from '../audio/markers'

const editor = useEditorStore()
const toast = useToastStore()

const csvInput = ref<HTMLInputElement | null>(null)
const editingId = ref<string | null>(null)
const editingLabel = ref('')
const silence = ref<SilencePresetOptions>({
  thresholdDb: -45,
  minSilenceMs: 300,
  minSoundMs: 150,
  padMs: 80
})

const busy = computed(() => editor.busy.type !== null)
const sorted = computed(() => editor.markers)
const silenceCount = computed(() => editor.silenceSegmentCount)

function addAtPlayhead(): void {
  editor.addMarker()
}

function addAtSelection(): void {
  if (!editor.hasSelection) {
    toast.push('info', '请先框选一段音频')
    return
  }
  editor.addMarker(editor.selection.start)
}

function startEdit(id: string, label: string): void {
  editingId.value = id
  editingLabel.value = label
}

function commitEdit(): void {
  if (editingId.value) editor.renameMarker(editingId.value, editingLabel.value)
  editingId.value = null
}

function onTimeInput(id: string, e: Event): void {
  const v = Number((e.target as HTMLInputElement).value)
  if (Number.isFinite(v)) editor.setMarkerTime(id, v)
}

function nudgeLabel(): string {
  const step = editor.nudgeStep
  return step >= 0.001 ? `${(step * 1000).toFixed(step < 0.01 ? 1 : 0)} ms` : `${(step * 1e6).toFixed(0)} µs`
}

function exportCsv(): void {
  if (!editor.markers.length) {
    toast.push('info', '还没有标记点')
    return
  }
  const blob = new Blob([markersToCsv(editor.markers)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${editor.fileName ?? 'project'}-cues.csv`
  a.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 5000)
  toast.push('success', `已导出 ${editor.markers.length} 个 Cue 点`)
}

async function importCsv(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    const list = csvToMarkers(await file.text())
    if (!list.length) {
      toast.push('error', 'CSV 中没有可识别的时间点（格式：12.500, 名称）')
      return
    }
    editor.loadMarkers([...editor.markers, ...list])
    toast.push('success', `已导入 ${list.length} 个 Cue 点`)
  } catch (err) {
    toast.push('error', err instanceof Error ? err.message : 'CSV 读取失败')
  }
}

function setGrid(e: Event): void {
  editor.setSnapGrid(Number((e.target as HTMLSelectElement).value))
}

async function runDetect(): Promise<void> {
  await editor.detectSilenceSegments({ ...silence.value })
}

async function runRemove(): Promise<void> {
  await editor.removeSilences({ ...silence.value })
}
</script>

<template>
  <div class="space-y-3">
    <!-- 标记列表 -->
    <div class="panel p-3 space-y-2">
      <div class="flex items-center justify-between">
        <label class="field-label !mb-0">标记点 / Cue（{{ sorted.length }}）</label>
        <span class="text-[10px] text-slate-600">M 添加 · [ ] 跳转</span>
      </div>
      <div class="grid grid-cols-2 gap-2">
        <button class="btn btn-primary" :disabled="!editor.buffer" @click="addAtPlayhead">＋ 播放头处</button>
        <button class="btn" :disabled="!editor.hasSelection" @click="addAtSelection">＋ 选区起点</button>
      </div>

      <div v-if="sorted.length" class="max-h-52 overflow-y-auto space-y-1 pr-1">
        <div
          v-for="(m, i) in sorted"
          :key="m.id"
          class="flex items-center gap-1.5 bg-abyss-800/60 rounded px-1.5 py-1"
        >
          <span class="font-mono text-[10px] text-slate-600 w-4 shrink-0">{{ i + 1 }}</span>
          <input
            v-if="editingId === m.id"
            class="field-input !w-[68px] !py-0.5 !text-[10px] font-mono shrink-0"
            type="number"
            min="0"
            :max="editor.duration"
            step="0.001"
            :value="m.time.toFixed(3)"
            title="修改时间点（秒）"
            @change="onTimeInput(m.id, $event)"
          />
          <button
            v-else
            class="font-mono text-[10px] text-neon-bright w-[68px] text-left shrink-0 hover:underline"
            title="点击跳转 · 双击名称可修改时间与标签"
            @click="editor.gotoMarker(m.id)"
          >
            {{ formatMarkerTime(m.time) }}
          </button>
          <input
            v-if="editingId === m.id"
            class="field-input flex-1 !py-0.5 !text-[11px]"
            v-model="editingLabel"
            @blur="commitEdit"
            @keydown.enter="commitEdit"
          />
          <button
            v-else
            class="text-[11px] text-slate-200 flex-1 truncate text-left hover:text-neon"
            title="点击重命名"
            @click="startEdit(m.id, m.label)"
          >
            {{ m.label }}
          </button>
          <button class="btn px-1 py-0.5 text-[10px]" title="把播放头到该点设为选区" @click="editor.selectToMarker(m.id)">选</button>
          <button class="btn btn-danger px-1 py-0.5 text-[10px]" title="删除" @click="editor.removeMarker(m.id)">×</button>
        </div>
      </div>
      <p v-else class="text-[11px] text-slate-500 leading-relaxed">
        还没有标记。按 M 在播放头处添加，或先做静音检测后一键在每段语音起点打点。
      </p>

      <div class="flex gap-2">
        <button class="btn flex-1" :disabled="!sorted.length" @click="exportCsv">导出 CSV</button>
        <button class="btn flex-1" @click="csvInput?.click()">导入 CSV</button>
        <button class="btn btn-danger" :disabled="!sorted.length" @click="editor.clearMarkers()">清空</button>
      </div>
      <input ref="csvInput" type="file" accept=".csv,text/csv" class="hidden" @change="importCsv" />
    </div>

    <!-- 吸附与微调 -->
    <div class="panel p-3 space-y-2">
      <label class="field-label">吸附精度 / 选区微调</label>
      <select class="field-input" :value="editor.snapGrid" @change="setGrid">
        <option v-for="g in SNAP_GRIDS" :key="g.value" :value="g.value">{{ g.label }}</option>
      </select>
      <div class="grid grid-cols-3 gap-1.5">
        <button class="btn" :disabled="!editor.buffer" @click="editor.nudge(-1)">← {{ nudgeLabel() }}</button>
        <button class="btn" :disabled="!editor.buffer" title="跳到上一个标记" @click="editor.jumpMarker(-1)">◀ Cue</button>
        <button class="btn" :disabled="!editor.buffer" @click="editor.nudge(1)">{{ nudgeLabel() }} →</button>
      </div>
      <p class="text-[10px] text-slate-600 leading-relaxed">
        方向键移动选区（无选区时移动播放头）；Shift+方向键调右边界，Ctrl+方向键调左边界，Alt ×10。
        选区边缘的零交叉吸附现在综合全部声道，立体声不再只看左声道。
      </p>
      <label class="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer">
        <input type="checkbox" v-model="editor.zeroSnap" />
        选区边缘吸附零交叉点（±20ms，全声道）
      </label>
    </div>

    <!-- 静音检测自动分段 -->
    <div class="panel p-3 space-y-2">
      <label class="field-label">静音检测自动分段（播客 / 口播）</label>
      <div class="grid grid-cols-2 gap-2">
        <div>
          <span class="text-[10px] text-slate-500">阈值 {{ silence.thresholdDb }} dB</span>
          <input class="neon-range w-full" type="range" min="-70" max="-20" step="1" v-model.number="silence.thresholdDb" />
        </div>
        <div>
          <span class="text-[10px] text-slate-500">最短静音 {{ silence.minSilenceMs }} ms</span>
          <input class="neon-range w-full" type="range" min="50" max="2000" step="50" v-model.number="silence.minSilenceMs" />
        </div>
        <div>
          <span class="text-[10px] text-slate-500">最短有声 {{ silence.minSoundMs }} ms</span>
          <input class="neon-range w-full" type="range" min="50" max="1000" step="50" v-model.number="silence.minSoundMs" />
        </div>
        <div>
          <span class="text-[10px] text-slate-500">保留余量 {{ silence.padMs }} ms</span>
          <input class="neon-range w-full" type="range" min="0" max="500" step="10" v-model.number="silence.padMs" />
        </div>
      </div>
      <div class="grid grid-cols-2 gap-2">
        <button class="btn" :disabled="!editor.buffer || busy" @click="runDetect">检测分段</button>
        <button class="btn" :disabled="!editor.buffer || busy" @click="editor.segmentsToMarkers()">段落起点打标记</button>
      </div>
      <button class="btn btn-danger w-full" :disabled="!editor.buffer || busy" @click="runRemove">
        移除全部静音段（可 Ctrl+Z）
      </button>
      <p v-if="editor.segments.length" class="text-[10px] text-slate-500">
        共 {{ editor.segments.length }} 段，其中静音 {{ silenceCount }} 段。波形上以暗色区间标出。
      </p>
      <p class="text-[10px] text-slate-600 leading-relaxed">
        10ms 帧 RMS + 双阈值迟滞：先吞掉静音之间的极短有声，再吞掉有声之间的极短静音；「保留余量」避免切掉换气和尾音。
      </p>
    </div>
  </div>
</template>
