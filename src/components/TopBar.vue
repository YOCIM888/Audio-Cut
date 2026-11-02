<script setup lang="ts">
import { computed, ref } from 'vue'
import { useEditorStore } from '../stores/editor'
import { useAudioImporter } from '../composables/useAudioImporter'

const editor = useEditorStore()
const { importFiles } = useAudioImporter()
const fileInput = ref<HTMLInputElement | null>(null)

function pickFile(): void {
  fileInput.value?.click()
}

async function onFileChange(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  if (input.files && input.files.length > 0) await importFiles(Array.from(input.files))
  input.value = ''
}

const busyLabel = computed(() => {
  switch (editor.busy.type) {
    case 'decode':
      return '解码中…'
    case 'stretch':
      return `变速处理 ${Math.round(editor.busy.progress)}%`
    case 'merge':
      return `合并中 ${Math.round(editor.busy.progress)}%`
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

    <div class="flex-1 text-center text-xs text-slate-500 truncate">
      <span v-if="editor.fileName" class="text-slate-200">{{ editor.fileName }}</span>
      <span v-else>未加载音频 — 点击「导入音频」或直接拖拽文件到窗口</span>
    </div>

    <span v-if="editor.busy.type" class="text-xs text-neon-bright animate-pulse">{{ busyLabel }}</span>

    <button class="btn" :disabled="!editor.canUndo || editor.busy.type !== null" @click="editor.undo()">
      撤销
    </button>
    <button class="btn" :disabled="!editor.canRedo || editor.busy.type !== null" @click="editor.redo()">
      重做
    </button>
    <button class="btn" :disabled="editor.busy.type !== null" @click="pickFile">导入音频</button>
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
  </header>
</template>
