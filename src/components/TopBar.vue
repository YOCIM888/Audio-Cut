<script setup lang="ts">
import { computed, ref } from 'vue'
import { useEditorStore } from '../stores/editor'
import { useAudioImporter } from '../composables/useAudioImporter'
import { useProjectIO } from '../composables/useProjectIO'
import { useProjectPersistence } from '../composables/useProjectPersistence'

const editor = useEditorStore()
const { importFiles } = useAudioImporter()
const { saving, progress: saveProgress, saveProject, loadProject } = useProjectIO()
const { status: saveStatus, statusLabel, statusTitle } = useProjectPersistence()
const fileInput = ref<HTMLInputElement | null>(null)
const projectInput = ref<HTMLInputElement | null>(null)

const saveStatusClass = computed(() => {
  switch (saveStatus.value) {
    case 'error':
      return 'text-danger'
    case 'oversize':
    case 'disabled':
      return 'text-warn'
    case 'saved':
    case 'saving':
      return 'text-neon/70'
    default:
      return 'text-slate-600'
  }
})

function pickFile(): void {
  fileInput.value?.click()
}

async function onFileChange(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  if (input.files && input.files.length > 0) await importFiles(Array.from(input.files))
  input.value = ''
}

async function onProjectChange(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) await loadProject(file)
}

const busyLabel = computed(() => {
  switch (editor.busy.type) {
    case 'decode':
      return '解码中…'
    case 'stretch':
      return `变速处理 ${Math.round(editor.busy.progress)}%`
    case 'merge':
      return `合并中 ${Math.round(editor.busy.progress)}%`
    case 'effects':
      return `效果渲染中 ${Math.round(editor.busy.progress)}%`
    case 'analyze':
      return `响度分析 ${Math.round(editor.busy.progress)}%`
    case 'repair':
      return `音频修复 ${Math.round(editor.busy.progress)}%`
    case 'batch':
      return `批量处理 ${Math.round(editor.busy.progress)}%`
    case 'tracks':
      return '正在解码多轨素材…'
    default:
      return ''
  }
})
</script>

<template>
  <header
    class="h-14 shrink-0 flex items-center gap-3 px-4 border-b border-neon/15 bg-abyss-900/80 backdrop-blur"
  >
    <div class="flex items-center gap-2">
      <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="6" fill="#0b1120" stroke="rgba(34,211,238,0.4)" />
        <path
          d="M5 16h3l2-6 3 12 3-9 2 5 3-7 2 5h4"
          stroke="#22d3ee"
          stroke-width="2"
          fill="none"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <h1 class="text-neon font-bold tracking-[0.25em] text-sm glow-text select-none">
        YOCIM AUDIO CUT
      </h1>
    </div>

    <div class="flex-1 min-w-0 flex flex-col items-center justify-center gap-0.5 leading-tight">
      <div class="text-xs text-slate-500 truncate max-w-full">
        <span v-if="editor.fileName" class="text-slate-200">{{ editor.fileName }}</span>
        <span v-else>未加载音频 — 点击「导入音频」或直接拖拽文件到窗口</span>
      </div>
      <div class="text-[10px] truncate max-w-full" :class="saveStatusClass" :title="statusTitle">
        {{ statusLabel }}
      </div>
    </div>

    <span v-if="editor.busy.type" class="text-xs text-neon-bright animate-pulse">{{ busyLabel }}</span>

    <button
      v-if="editor.chain.nodes.length"
      class="btn"
      :class="editor.chain.bypass ? 'text-warn' : 'btn-primary'"
      :title="editor.chain.bypass ? '效果链已旁路，点击开启（B）' : '效果链生效中，点击旁路（B）'"
      @click="editor.toggleBypass()"
    >
      FX {{ editor.activeEffectCount }}/{{ editor.chain.nodes.length }} · {{ editor.chain.bypass ? '原声' : '生效' }}
    </button>

    <button class="btn" :disabled="!editor.canUndo || editor.busy.type !== null" @click="editor.undo()">
      撤销
    </button>
    <button class="btn" :disabled="!editor.canRedo || editor.busy.type !== null" @click="editor.redo()">
      重做
    </button>
    <button class="btn" :disabled="editor.busy.type !== null" @click="pickFile">导入音频</button>
    <button
      class="btn"
      :disabled="!editor.buffer || saving"
      title="导出无损工程包 .yac.zip（project.json 只存编辑指令，音轨为 32-bit float WAV）"
      @click="saveProject"
    >
      {{ saving ? `打包中 ${Math.round(saveProgress * 100)}%` : '保存工程' }}
    </button>
    <button class="btn" :disabled="editor.busy.type !== null" @click="projectInput?.click()">
      打开工程
    </button>
    <button class="btn btn-primary" :disabled="!editor.buffer" @click="editor.sidebarTab = 'export'">
      导出
    </button>

    <input
      ref="fileInput"
      type="file"
      accept=".mp3,.wav,.m4a,.ogg,.flac,audio/*"
      class="hidden"
      @change="onFileChange"
    />
    <input
      ref="projectInput"
      type="file"
      accept=".zip,.json,.yac.zip,application/zip,application/json"
      class="hidden"
      @change="onProjectChange"
    />
  </header>
</template>
