/**
 * 工程保存 / 加载。
 * 工程为单个 JSON 文件：内嵌 128kbps MP3 副本的 base64（体积远小于内嵌 WAV），
 * 同时保存选区、视图缩放与振幅缩放，便于下次继续编辑。
 */
import { ref } from 'vue'
import { useEditorStore } from '../stores/editor'
import { useToastStore } from '../stores/toast'
import { audioEngine } from '../audio/engine'
import { getAllChannels } from '../utils/audio-utils'
import { runWorkerTask } from '../utils/worker-client'

const PROJECT_APP = 'yocim-audio-cut'
const PROJECT_VERSION = 1
const PROJECT_MP3_BITRATE = 128

interface ProjectFile {
  version: number
  app: string
  name: string
  sampleRate: number
  duration: number
  selection: { start: number; end: number }
  view: { zoom: number; scrollX: number; vGain: number }
  audio: { mime: string; base64: string }
}

let mp3Worker: Worker | null = null
function getMp3Worker(): Worker {
  if (!mp3Worker) {
    mp3Worker = new Worker(new URL('../workers/mp3-encoder.worker.ts', import.meta.url), {
      type: 'module'
    })
  }
  return mp3Worker
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 5000)
}

/** 分块转换，避免 String.fromCharCode 参数溢出 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export function useProjectIO() {
  const editor = useEditorStore()
  const toast = useToastStore()
  const saving = ref(false)
  const progress = ref(0)

  async function saveProject(): Promise<void> {
    const buf = editor.buffer
    if (!buf || saving.value) return
    saving.value = true
    progress.value = 0
    try {
      const channels = getAllChannels(buf).map((c) => c.slice())
      const encoded = await runWorkerTask<ArrayBuffer>(
        getMp3Worker(),
        { channels, sampleRate: buf.sampleRate, kbps: PROJECT_MP3_BITRATE },
        channels.map((c) => c.buffer as ArrayBuffer),
        (p) => {
          progress.value = p / 100
        }
      )
      const project: ProjectFile = {
        version: PROJECT_VERSION,
        app: PROJECT_APP,
        name: editor.fileName ?? 'project',
        sampleRate: buf.sampleRate,
        duration: buf.duration,
        selection: { start: editor.selection.start, end: editor.selection.end },
        view: { zoom: editor.zoom, scrollX: editor.scrollX, vGain: editor.vGain },
        audio: { mime: 'audio/mpeg', base64: arrayBufferToBase64(encoded) }
      }
      const json = JSON.stringify(project)
      download(new Blob([json], { type: 'application/json' }), `${project.name}.yac.json`)
      toast.push(
        'success',
        `工程已保存（${(json.length / 1024 / 1024).toFixed(1)} MB，音频为 ${PROJECT_MP3_BITRATE}kbps MP3 副本）`,
        4500
      )
    } catch (err) {
      console.error(err)
      toast.push('error', '保存工程失败')
    } finally {
      saving.value = false
      progress.value = 0
    }
  }

  async function loadProject(file: File): Promise<void> {
    try {
      const text = await file.text()
      const data = JSON.parse(text) as ProjectFile
      if (data?.app !== PROJECT_APP || typeof data.audio?.base64 !== 'string') {
        throw new Error('不是有效的 YOCIM Audio Cut 工程文件')
      }
      const binary = atob(data.audio.base64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      const ctx = audioEngine.ensureContext()
      const decoded = await ctx.decodeAudioData(bytes.buffer as ArrayBuffer)
      editor.loadDecodedBuffer(decoded, data.name || file.name.replace(/\.yac\.json$/i, ''), {
        selection: data.selection,
        zoom: data.view?.zoom,
        scrollX: data.view?.scrollX,
        vGain: data.view?.vGain
      })
      toast.push('success', '工程已恢复（音频为 128kbps MP3 副本，非原始无损数据）', 4500)
    } catch (err) {
      console.error(err)
      toast.push('error', err instanceof Error ? err.message : '工程加载失败')
    }
  }

  return { saving, progress, saveProject, loadProject }
}
