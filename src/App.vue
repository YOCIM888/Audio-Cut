<script setup lang="ts">
import TopBar from './components/TopBar.vue'
import WaveformEditor from './components/WaveformEditor.vue'
import PlaybackControls from './components/PlaybackControls.vue'
import SidebarTools from './components/SidebarTools.vue'
import ToastNotification from './components/ToastNotification.vue'
import { useKeyboardShortcuts } from './composables/useKeyboardShortcuts'
import { useAudioImporter } from './composables/useAudioImporter'

useKeyboardShortcuts()
const { dragging, installGlobalDrop } = useAudioImporter()
installGlobalDrop()
</script>

<template>
  <div class="h-screen flex flex-col bg-cyber-grid overflow-hidden">
    <TopBar />
    <main class="flex-1 flex min-h-0">
      <section class="flex-1 flex flex-col min-w-0">
        <WaveformEditor class="flex-1 min-h-0" />
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
