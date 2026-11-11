<script setup lang="ts">
import TopBar from './components/TopBar.vue'
import WaveformEditor from './components/WaveformEditor.vue'
import TimelineEditor from './components/TimelineEditor.vue'
import PlaybackControls from './components/PlaybackControls.vue'
import SidebarTools from './components/SidebarTools.vue'
import ToastNotification from './components/ToastNotification.vue'
import { useKeyboardShortcuts } from './composables/useKeyboardShortcuts'
import { useAudioImporter } from './composables/useAudioImporter'
import { useProjectPersistence } from './composables/useProjectPersistence'
import { useEditorStore, type MainViewMode } from './stores/editor'

const editor = useEditorStore()
const views: { key: MainViewMode; label: string; hint: string }[] = [
  { key: 'waveform', label: '波形编辑', hint: '单轨精细剪辑、频谱、标记' },
  { key: 'timeline', label: '多轨时间线', hint: '多轨叠加、片段拖动、录音轨' }
]

useKeyboardShortcuts()
const { dragging, installGlobalDrop } = useAudioImporter()
installGlobalDrop()
// 恢复上次的无损音轨与编辑指令，并启动 IndexedDB 自动保存
useProjectPersistence().install()
</script>

<template>
  <div class="h-screen flex flex-col bg-cyber-grid overflow-hidden">
    <TopBar />
    <main class="flex-1 flex min-h-0">
      <section class="flex-1 flex flex-col min-w-0">
        <div class="h-8 shrink-0 flex items-center gap-2 px-3 border-b border-neon/10 bg-abyss-900/50">
          <button
            v-for="v in views"
            :key="v.key"
            class="btn px-2.5 py-0.5 text-[10px]"
            :class="{ 'btn-primary': editor.mainView === v.key }"
            :title="v.hint"
            @click="editor.setMainView(v.key)"
          >
            {{ v.label }}
          </button>
          <span v-if="editor.hasMultitrack" class="text-[10px] text-neon-bright ml-1">
            {{ editor.tracks.length }} 轨 · {{ editor.clips.length }} 片段
          </span>
          <span class="ml-auto text-[10px] text-slate-600">
            {{ editor.mainView === 'timeline' ? '主轨与所有片段共用同一时间轴' : 'Tab 切到「多轨」页可录音 / 管理轨道' }}
          </span>
        </div>
        <WaveformEditor v-if="editor.mainView === 'waveform'" class="flex-1 min-h-0" />
        <TimelineEditor v-else class="flex-1 min-h-0" />
        <PlaybackControls />
      </section>
      <SidebarTools />
    </main>
    <ToastNotification />

    <div
      v-if="dragging"
      class="fixed inset-0 z-40 bg-abyss-950/80 backdrop-blur-sm flex items-center justify-center border-2 border-dashed border-neon pointer-events-none"
    >
      <p class="text-neon text-2xl font-bold tracking-[0.3em] glow-text">松开以导入音频</p>
    </div>
  </div>
</template>
