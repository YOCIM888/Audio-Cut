/** 音频导入：文件白名单校验 + 全局拖拽（模块级共享状态，仅安装一次监听） */
import { ref } from 'vue'
import { useEditorStore } from '../stores/editor'
import { useToastStore } from '../stores/toast'

const ACCEPT_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.ogg', '.flac']

const dragging = ref(false)
let installed = false
let dragDepth = 0

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}

export function useAudioImporter() {
  const editor = useEditorStore()
  const toast = useToastStore()

  async function importFiles(files: File[]): Promise<void> {
    const accepted = files.filter((f) =>
      ACCEPT_EXTENSIONS.some((ext) => f.name.toLowerCase().endsWith(ext))
    )
    if (accepted.length === 0) {
      toast.push('error', '不支持的格式，请选择 mp3 / wav / m4a / ogg / flac 文件')
      return
    }
    await editor.loadFile(accepted[0])
  }

  function installGlobalDrop(): void {
    if (installed) return
    installed = true

    window.addEventListener('dragenter', (e) => {
      e.preventDefault()
      if (hasFiles(e)) {
        dragDepth++
        dragging.value = true
      }
    })
    window.addEventListener('dragover', (e) => {
      e.preventDefault()
    })
    window.addEventListener('dragleave', (e) => {
      e.preventDefault()
      if (dragDepth > 0) {
        dragDepth--
        if (dragDepth === 0) dragging.value = false
      }
    })
    window.addEventListener('drop', (e) => {
      e.preventDefault()
      dragDepth = 0
      dragging.value = false
      const files = e.dataTransfer?.files
      if (files && files.length > 0) void importFiles(Array.from(files))
    })
  }

  return { dragging, importFiles, installGlobalDrop }
}
