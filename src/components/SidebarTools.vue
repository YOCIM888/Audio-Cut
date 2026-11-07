<script setup lang="ts">
import { ref } from 'vue'
import { useEditorStore, type SidebarTab } from '../stores/editor'
import EditPanel from './EditPanel.vue'
import EffectsPanel from './EffectsPanel.vue'
import MergePanel from './MergePanel.vue'
import ExportPanel from './ExportPanel.vue'

const editor = useEditorStore()

const tabs: { key: SidebarTab; label: string }[] = [
  { key: 'edit', label: '编辑' },
  { key: 'effects', label: '处理' },
  { key: 'speed', label: '变速' },
  { key: 'merge', label: '合并' },
  { key: 'export', label: '导出' }
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
    <nav class="flex border-b border-neon/15">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="flex-1 py-2.5 text-xs tracking-[0.1em] transition-colors"
        :class="
          editor.sidebarTab === tab.key
            ? 'text-neon border-b-2 border-neon bg-neon/5 glow-text'
            : 'text-slate-500 hover:text-slate-300'
        "
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

      <ExportPanel v-else />
    </div>
  </aside>
</template>
