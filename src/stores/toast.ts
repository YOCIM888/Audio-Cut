import { ref } from 'vue'
import { defineStore } from 'pinia'

export type ToastType = 'success' | 'error' | 'info'

export interface ToastItem {
  id: number
  type: ToastType
  message: string
}

export const useToastStore = defineStore('toast', () => {
  const toasts = ref<ToastItem[]>([])
  let seq = 0

  function dismiss(id: number): void {
    const idx = toasts.value.findIndex((t) => t.id === id)
    if (idx >= 0) toasts.value.splice(idx, 1)
  }

  function push(type: ToastType, message: string, ttl = 3200): void {
    const id = ++seq
    toasts.value.push({ id, type, message })
    window.setTimeout(() => dismiss(id), ttl)
  }

  return { toasts, push, dismiss }
})
