<script setup lang="ts">
import { useToastStore } from '../stores/toast'

const toast = useToastStore()
</script>

<template>
  <div class="fixed top-16 right-4 z-50 flex flex-col gap-2 w-80 pointer-events-none">
    <div
      v-for="t in toast.toasts"
      :key="t.id"
      class="toast pointer-events-auto"
      :class="`toast-${t.type}`"
      @click="toast.dismiss(t.id)"
    >
      {{ t.message }}
    </div>
  </div>
</template>
