/** 全局快捷键：Space 播放/暂停，B 切换效果链 A/B，Home/End 跳转，Ctrl+Z / Ctrl+Shift+Z 撤销重做，Delete 删除选区 */
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

    if (e.code === 'Space') {
      e.preventDefault()
      editor.togglePlay()
    } else if (key === 'b' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      editor.toggleBypass()
    } else if (e.key === 'Home') {
      e.preventDefault()
      editor.seek(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      editor.seek(editor.duration)
    } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && key === 'z') {
      e.preventDefault()
      editor.undo()
    } else if ((e.ctrlKey || e.metaKey) && (key === 'y' || (e.shiftKey && key === 'z'))) {
      e.preventDefault()
      editor.redo()
    } else if ((e.ctrlKey || e.metaKey) && key === 'c' && editor.hasSelection) {
      e.preventDefault()
      editor.copySelection()
    } else if ((e.ctrlKey || e.metaKey) && key === 'x' && editor.hasSelection) {
      e.preventDefault()
      editor.cutSelection()
    } else if ((e.ctrlKey || e.metaKey) && key === 'v' && editor.hasClipboard) {
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
