<script setup lang="ts">
import { ref, watch } from 'vue'
import { useEditorStore, type FadeCurve } from '../stores/editor'

const editor = useEditorStore()

const selStart = ref(0)
const selEnd = ref(0)
const fadeCurve = ref<FadeCurve>('cosine')
const gainDb = ref(0)
const gainScope = ref<'selection' | 'all'>('selection')
const silenceSeconds = ref(1)

watch(
  () => [editor.selection.start, editor.selection.end] as const,
  ([s, e]) => {
    selStart.value = Number(s.toFixed(2))
    selEnd.value = Number(e.toFixed(2))
  },
  { immediate: true }
)

function applySelection(): void {
  // 数值输入走精确模式，不被 0.1s 网格吸附吞掉精度
  editor.setSelection(selStart.value, selEnd.value, true)
}

const busy = () => editor.busy.type !== null
const selDisabled = () => !editor.hasSelection || busy()

const curves: { value: FadeCurve; label: string }[] = [
  { value: 'linear', label: '线性' },
  { value: 'cosine', label: '余弦（平滑）' },
  { value: 'exponential', label: '指数' },
  { value: 'logarithmic', label: '对数' }
]
</script>

<template>
  <div class="space-y-4">
    <p class="text-xs text-slate-500 leading-relaxed">
      拖拽框选（0.1s 吸附），Shift+拖动整体移动选区，点击波形定位播放头。工具栏可用 Alt+滚轮调整振幅。
    </p>

    <div>
      <label class="field-label">精确选区（秒）</label>
      <div class="flex items-center gap-2">
        <input class="field-input" type="number" min="0" step="0.01" v-model.number="selStart" />
        <span class="text-slate-600 text-xs">→</span>
        <input class="field-input" type="number" min="0" step="0.01" v-model.number="selEnd" />
        <button class="btn px-2" :disabled="!editor.buffer" @click="applySelection">应用</button>
      </div>
      <p class="text-[11px] text-slate-600 mt-1">
        时长 {{ (editor.selection.end - editor.selection.start).toFixed(2) }}s
      </p>
    </div>

    <label class="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
      <input type="checkbox" v-model="editor.zeroSnap" />
      选区边缘吸附到零交叉点（±20ms）
    </label>

    <div>
      <label class="field-label">剪辑</label>
      <div class="grid grid-cols-2 gap-2">
        <button class="btn btn-primary" :disabled="selDisabled()" @click="editor.trim()">裁剪选区</button>
        <button class="btn btn-danger" :disabled="selDisabled()" @click="editor.deleteRegion()">删除（拼接）</button>
        <button class="btn" :disabled="selDisabled()" @click="editor.silence()">删除（留空）</button>
        <button class="btn" :disabled="busy()" @click="editor.clearSelection()">清除选区</button>
        <button class="btn" :disabled="selDisabled()" @click="editor.copySelection()">复制选区</button>
        <button class="btn" :disabled="selDisabled()" @click="editor.cutSelection()">剪切选区</button>
        <button
          class="btn"
          :disabled="!editor.hasClipboard || busy()"
          title="粘贴到播放头（有选区时粘贴到选区起点）"
          @click="editor.pasteAtPlayhead()"
        >
          粘贴
        </button>
        <button class="btn" :disabled="!editor.buffer || busy()" @click="editor.insertSilence(silenceSeconds)">
          插入静音
        </button>
      </div>
      <div class="flex items-center gap-2 mt-2">
        <span class="text-[11px] text-slate-500 shrink-0">静音时长</span>
        <input class="field-input" type="number" min="0.05" max="60" step="0.1" v-model.number="silenceSeconds" />
        <span class="text-[11px] text-slate-600">秒</span>
      </div>
    </div>

    <div>
      <label class="field-label">淡入淡出曲线</label>
      <div class="flex gap-2">
        <select class="field-input" v-model="fadeCurve">
          <option v-for="c in curves" :key="c.value" :value="c.value">{{ c.label }}</option>
        </select>
        <button class="btn" :disabled="selDisabled()" @click="editor.fadeIn(fadeCurve)">淡入</button>
        <button class="btn" :disabled="selDisabled()" @click="editor.fadeOut(fadeCurve)">淡出</button>
      </div>
    </div>

    <div>
      <label class="field-label">增益 / 归一化</label>
      <div class="flex items-center gap-2">
        <input class="field-input" type="number" min="-96" max="24" step="0.5" v-model.number="gainDb" />
        <span class="text-[11px] text-slate-500 shrink-0">dB</span>
        <select class="field-input" v-model="gainScope">
          <option value="selection">仅选区</option>
          <option value="all">全曲</option>
        </select>
      </div>
      <div class="flex gap-2 mt-2">
        <button
          class="btn flex-1"
          :disabled="busy() || (gainScope === 'selection' && !editor.hasSelection)"
          @click="editor.setGainDb(gainDb, gainScope === 'selection')"
        >
          应用增益
        </button>
        <button
          class="btn flex-1"
          :disabled="busy() || (gainScope === 'selection' && !editor.hasSelection)"
          @click="editor.normalize(gainScope === 'selection')"
        >
          归一化
        </button>
      </div>
    </div>

    <div class="panel p-3 text-xs text-slate-500 space-y-1">
      <p>快捷键：</p>
      <p>Space 播放/暂停 · Home/End 跳首尾</p>
      <p>Ctrl+Z 撤销 · Ctrl+Shift+Z 重做 · Del 删除选区</p>
      <p>Ctrl+C 复制 · Ctrl+X 剪切 · Ctrl+V 粘贴</p>
    </div>
  </div>
</template>
