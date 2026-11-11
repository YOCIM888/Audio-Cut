/**
 * 全局快捷键：
 *  Space 播放/暂停 · B 效果链 A/B · M 加标记 · [ / ] 跳上一个/下一个标记
 *  ←/→ 微调（默认移动选区或播放头，Shift 调选区右边界，Ctrl 调左边界，Alt ×10）
 *  Home/End 跳首尾 · Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y 撤销重做 · Delete 删除选区
 *  Ctrl+C / X / V 复制 / 剪切 / 粘贴
 */
import { onBeforeUnmount, onMounted } from 'vue'
import { useEditorStore } from '../stores/editor'

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT' ||
      target.isContentEditable)
  )
}

export function useKeyboardShortcuts(): void {
  const editor = useEditorStore()

  const onKey = (e: KeyboardEvent) => {
    if (isEditableTarget(e.target) || e.isComposing) return
    const key = e.key.toLowerCase()
    const mod = e.ctrlKey || e.metaKey

    if (e.code === 'Space') {
      e.preventDefault()
      editor.togglePlay()
    } else if (key === 'b' && !mod && !e.altKey) {
      e.preventDefault()
      editor.toggleBypass()
    } else if (key === 'm' && !mod && !e.altKey) {
      e.preventDefault()
      editor.addMarker()
    } else if (key === '[' && !mod) {
      e.preventDefault()
      editor.jumpMarker(-1)
    } else if (key === ']' && !mod) {
      e.preventDefault()
      editor.jumpMarker(1)
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      const direction = e.key === 'ArrowRight' ? 1 : -1
      const mode = e.shiftKey ? 'end' : mod ? 'start' : 'move'
      editor.nudge(direction, mode, e.altKey ? 10 : 1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      editor.seek(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      editor.seek(editor.duration)
    } else if (mod && !e.shiftKey && key === 'z') {
      e.preventDefault()
      editor.undo()
    } else if (mod && (key === 'y' || (e.shiftKey && key === 'z'))) {
      e.preventDefault()
      editor.redo()
    } else if (mod && key === 'c' && editor.hasSelection) {
      e.preventDefault()
      editor.copySelection()
    } else if (mod && key === 'x' && editor.hasSelection) {
      e.preventDefault()
      editor.cutSelection()
    } else if (mod && key === 'v' && editor.hasClipboard) {
      e.preventDefault()
      void editor.pasteAtPlayhead()
    } else if (e.key === 'Delete' && editor.hasSelection) {
      e.preventDefault()
      editor.deleteRegion()
    }
  }

  onMounted(() => window.addEventListener('keydown', onKey))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
}
