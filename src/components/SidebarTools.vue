<script setup lang="ts">
import { ref } from 'vue'
import { useEditorStore, type SidebarTab } from '../stores/editor'
import EditPanel from './EditPanel.vue'
import EffectsPanel from './EffectsPanel.vue'
import MergePanel from './MergePanel.vue'
import VideoExtractPanel from './VideoExtractPanel.vue'
import ExportPanel from './ExportPanel.vue'
import AnalysisPanel from './AnalysisPanel.vue'
import MarkersPanel from './MarkersPanel.vue'
import RepairPanel from './RepairPanel.vue'
import BatchPanel from './BatchPanel.vue'

const editor = useEditorStore()

/** 两行分组：第一行是基础剪辑，第二行是测量 / 导航 / 修复 / 自动化 */
const tabRows: { key: SidebarTab; label: string; title: string }[][] = [
  [
    { key: 'edit', label: '编辑', title: '剪切、复制、粘贴、淡变' },
    { key: 'effects', label: '效果链', title: '非破坏性多段 EQ 与动态效果' },
    { key: 'speed', label: '变速', title: 'WSOLA 变速 / 保持音调' },
    { key: 'merge', label: '合并', title: '多段音频拼接' },
    { key: 'extract', label: '提取', title: '从视频中提取音频' }
  ],
  [
    { key: 'measure', label: '测量', title: 'LUFS / RMS / 真峰值 / 频谱图' },
    { key: 'marks', label: '标记', title: 'Cue 列表、吸附精度、静音分段' },
    { key: 'repair', label: '修复', title: '降噪 / 去咔嗒 / 限制器 / 变调' },
    { key: 'batch', label: '批量', title: '多文件串行处理与批量导出' },
    { key: 'export', label: '导出', title: 'WAV / MP3 / FLAC / M4A / OGG / WebM' }
  ]
]

const ratio = ref(1)
const keepPitch = ref(true)
const onlySelection = ref(false)
const presets = [0.5, 0.75, 1, 1.5, 2, 4]

async function applyStretch(): Promise<void> {
  await editor.timeStretch(ratio.value, keepPitch.value, onlySelection.value)
}
</script>

<template>
  <aside class="w-80 shrink-0 border-l border-neon/15 bg-abyss-900/70 backdrop-blur flex flex-col">
    <nav class="grid grid-cols-5 border-b border-neon/15">
      <button
        v-for="tab in tabRows.flat()"
        :key="tab.key"
        class="py-1.5 text-[11px] tracking-[0.04em] transition-colors"
        :class="
          editor.sidebarTab === tab.key
            ? 'text-neon border-b-2 border-neon bg-neon/5 glow-text'
            : 'text-slate-500 hover:text-slate-300'
        "
        :title="tab.title"
        @click="editor.sidebarTab = tab.key"
      >
        {{ tab.label }}
      </button>
    </nav>

    <div class="flex-1 overflow-y-auto p-4">
      <EditPanel v-if="editor.sidebarTab === 'edit'" />

      <EffectsPanel v-else-if="editor.sidebarTab === 'effects'" />

      <div v-else-if="editor.sidebarTab === 'speed'" class="space-y-4">
        <div>
          <label class="field-label">速度倍率</label>
          <div class="flex items-center gap-3">
            <input
              class="neon-range flex-1"
              type="range"
              min="0.25"
              max="4"
              step="0.01"
              v-model.number="ratio"
            />
            <span class="font-mono text-neon w-14 text-right">{{ ratio.toFixed(2) }}x</span>
          </div>
          <div class="flex gap-1.5 mt-2 flex-wrap">
            <button
              v-for="p in presets"
              :key="p"
              class="btn px-2 py-1"
              :class="{ 'btn-primary': Math.abs(ratio - p) < 0.001 }"
              @click="ratio = p"
            >
              {{ p }}x
            </button>
          </div>
        </div>

        <label class="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
          <input type="checkbox" v-model="keepPitch" />
          保持音调不变（WSOLA 算法，Worker 处理）
        </label>
        <label class="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
          <input type="checkbox" v-model="onlySelection" :disabled="!editor.hasSelection" />
          仅作用于选区
          <span v-if="!editor.hasSelection" class="text-slate-600">（未框选）</span>
        </label>

        <button
          class="btn btn-primary w-full py-2"
          :disabled="!editor.buffer || editor.busy.type !== null"
          @click="applyStretch"
        >
          {{ editor.busy.type === 'stretch' ? `处理中 ${Math.round(editor.busy.progress)}%` : '应用变速' }}
        </button>
        <div v-if="editor.busy.type === 'stretch'" class="h-1.5 rounded bg-abyss-800 overflow-hidden">
          <div
            class="h-full bg-neon shadow-glow transition-all"
            :style="{ width: `${editor.busy.progress}%` }"
          />
        </div>
      </div>

      <MergePanel v-else-if="editor.sidebarTab === 'merge'" />

      <VideoExtractPanel v-else-if="editor.sidebarTab === 'extract'" />

      <AnalysisPanel v-else-if="editor.sidebarTab === 'measure'" />

      <MarkersPanel v-else-if="editor.sidebarTab === 'marks'" />

      <RepairPanel v-else-if="editor.sidebarTab === 'repair'" />

      <BatchPanel v-else-if="editor.sidebarTab === 'batch'" />

      <ExportPanel v-else-if="editor.sidebarTab === 'export'" />
    </div>
  </aside>
</template>
