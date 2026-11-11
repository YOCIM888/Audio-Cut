/** 音频导入：文件白名单校验 + 全局拖拽（模块级共享状态，仅安装一次监听） */
import { ref } from 'vue'
import { useEditorStore } from '../stores/editor'
import { useToastStore } from '../stores/toast'
import { isProjectFile, useProjectIO } from './useProjectIO'

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
    const project = files.find(isProjectFile)
    if (project) {
      await useProjectIO().loadProject(project)
      if (files.length > 1) toast.push('info', '已打开工程文件，其余拖入的文件未处理')
      return
    }
    const accepted = files.filter((f) =>
      ACCEPT_EXTENSIONS.some((ext) => f.name.toLowerCase().endsWith(ext))
    )
    const rejected = files.length - accepted.length
    if (accepted.length === 0) {
      toast.push('error', '不支持的格式，请选择 mp3 / wav / m4a / ogg / flac 文件或 .yac.zip 工程包')
      return
    }
    if (rejected > 0) toast.push('info', `已忽略 ${rejected} 个不支持的文件`, 3500)
    // 编辑器是单音轨的，多余文件不再静默丢弃：明确告知，需要合并请走「合并」面板
    if (accepted.length > 1) {
      toast.push('info', `一次只能载入一个音频，已载入「${accepted[0].name}」；其余 ${accepted.length - 1} 个请在「合并」面板添加`, 5500)
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
