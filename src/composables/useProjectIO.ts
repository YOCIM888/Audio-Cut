/**
 * 工程保存 / 加载（v3）。
 *
 * 旧版把音轨编码成 128kbps MP3 再 base64 塞进 JSON：每次保存/打开都重新损失一次音质，
 * 长音频的 JSON.stringify 还会撑爆内存。v3 改成 .yac.zip 工程包：
 *  - project.json 只存编辑指令与视图状态（几 KB），不含任何音频字节；
 *  - audio.wav 为 32-bit IEEE float WAV，与编辑器内部 Float32Array 逐位等价（零损失），
 *    且是标准 WAV，可直接用其他音频软件打开；
 *  - source/<原文件名> 归档未改动的原始导入文件（可选）。
 *
 * 浏览器内的自动保存走 IndexedDB（见 useProjectPersistence），不经过本模块。
 * v1/v2 的 .yac.json 仍可读，但会明确提示它是有损 MP3 副本。
 */
import { ref } from 'vue'
import { useEditorStore, type SidebarTab } from '../stores/editor'
import { useToastStore } from '../stores/toast'
import { audioEngine } from '../audio/engine'
import { cloneChain, sanitizeChain, type EffectChainState } from '../audio/effect-chain'
import { channelsToAudioBuffer, getAllChannels } from '../utils/audio-utils'
import { decodeWavBlob, encodeFloatWavBlob } from '../utils/wav-blob'
import { createZip, readZip, type ZipInput } from '../utils/zip'
import { clearSourceFile, getSourceFile, setSourceFile } from '../utils/source-file'

const PROJECT_APP = 'yocim-audio-cut'
const PROJECT_VERSION = 3
const AUDIO_ENTRY = 'audio.wav'
const MANIFEST_ENTRY = 'project.json'

interface ProjectManifest {
  version: number
  app: string
  name: string
  savedAt: string
  sampleRate: number
  numberOfChannels: number
  length: number
  duration: number
  selection: { start: number; end: number }
  view: { zoom: number; scrollX: number; vGain: number }
  zeroSnap: boolean
  isLooping: boolean
  volume: number
  sidebarTab: string
  chain: EffectChainState
  audio: { file: string; encoding: 'wav-f32' }
  source: { file: string; name: string; bytes: number } | null
}

/** v1 / v2 旧工程：MP3 base64 */
interface LegacyProject {
  version?: number
  app?: string
  name?: string
  selection?: { start: number; end: number }
  view?: { zoom?: number; scrollX?: number; vGain?: number }
  chain?: EffectChainState
  audio?: { mime?: string; base64?: string }
}

export function isProjectFile(file: File): boolean {
  return /\.(zip|json)$/i.test(file.name)
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

/** 清洗为可用作文件名 / ZIP 条目名的字符串（保留扩展名） */
function safeName(name: string): string {
  const cleaned = name
    .replace(/^.*[\\/]/, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  return cleaned || 'audio'
}

function stem(name: string): string {
  return safeName(name).replace(/\.[^.]+$/, '') || 'project'
}

function formatBytes(n: number): string {
  return n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
}

function baseName(file: File): string {
  return file.name.replace(/\.yac\.(zip|json)$/i, '').replace(/\.(zip|json)$/i, '')
}

/** 兼容用户把工程包重新打包成带一层文件夹的 zip */
function findEntry(entries: Map<string, Blob>, path: string): Blob | undefined {
  const direct = entries.get(path)
  if (direct) return direct
  for (const [key, value] of entries) {
    if (key === path || key.endsWith(`/${path}`)) return value
  }
  return undefined
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
      const channels = getAllChannels(buf)
      const wav = await encodeFloatWavBlob(channels, buf.sampleRate, (p) => {
        progress.value = p * 0.6
      })
      const src = getSourceFile()
      const sourceEntry = src ? `source/${safeName(src.name)}` : null
      const manifest: ProjectManifest = {
        version: PROJECT_VERSION,
        app: PROJECT_APP,
        name: editor.fileName ?? 'project',
        savedAt: new Date().toISOString(),
        sampleRate: buf.sampleRate,
        numberOfChannels: buf.numberOfChannels,
        length: buf.length,
        duration: buf.duration,
        selection: { start: editor.selection.start, end: editor.selection.end },
        view: { zoom: editor.zoom, scrollX: editor.scrollX, vGain: editor.vGain },
        zeroSnap: editor.zeroSnap,
        isLooping: editor.isLooping,
        volume: editor.volume,
        sidebarTab: editor.sidebarTab,
        chain: cloneChain(editor.chain),
        audio: { file: AUDIO_ENTRY, encoding: 'wav-f32' },
        source: src && sourceEntry ? { file: sourceEntry, name: src.name, bytes: src.blob.size } : null
      }

      const entries: ZipInput[] = [
        { name: MANIFEST_ENTRY, data: JSON.stringify(manifest, null, 2) },
        { name: AUDIO_ENTRY, data: wav }
      ]
      if (src && sourceEntry) entries.push({ name: sourceEntry, data: src.blob })
      progress.value = 0.7
      const zip = await createZip(entries)
      progress.value = 1

      download(zip, `${stem(editor.fileName ?? 'project')}.yac.zip`)
      toast.push(
        'success',
        `工程包已导出（${formatBytes(zip.size)}）：project.json 只含编辑指令，音轨为 32-bit float 无损 WAV${src ? '，并附原始导入文件' : ''}`,
        6000
      )
    } catch (err) {
      console.error(err)
      toast.push('error', err instanceof Error ? err.message : '保存工程失败')
    } finally {
      saving.value = false
      progress.value = 0
    }
  }

  async function loadZipProject(file: File): Promise<void> {
    const entries = await readZip(file)
    const manifestBlob = findEntry(entries, MANIFEST_ENTRY)
    if (!manifestBlob) throw new Error('工程包内缺少 project.json')
    const data = JSON.parse(await manifestBlob.text()) as Partial<ProjectManifest>
    if (data?.app !== PROJECT_APP) throw new Error('不是有效的 YOCIM Audio Cut 工程包')
    const version = Number(data.version ?? 0)
    if (!Number.isFinite(version) || version < 1 || version > PROJECT_VERSION) {
      throw new Error(`工程包版本 v${version} 不受支持（当前程序支持 v1–v${PROJECT_VERSION}）`)
    }

    const audioBlob = findEntry(entries, data.audio?.file ?? AUDIO_ENTRY) ?? findEntry(entries, AUDIO_ENTRY)
    if (!audioBlob) throw new Error('工程包内缺少音轨文件')

    const { channels, sampleRate } = await decodeWavBlob(audioBlob)
    const buffer = channelsToAudioBuffer(channels, sampleRate)
    const chain = data.chain ? sanitizeChain(data.chain) : undefined
    editor.loadDecodedBuffer(buffer, data.name || baseName(file), {
      selection: data.selection,
      zoom: data.view?.zoom,
      scrollX: data.view?.scrollX,
      vGain: data.view?.vGain,
      chain
    })
    editor.applyViewState({
      zeroSnap: data.zeroSnap,
      isLooping: data.isLooping,
      volume: data.volume,
      sidebarTab: data.sidebarTab as SidebarTab | undefined
    })

    const srcEntry = data.source?.file ? findEntry(entries, data.source.file) : undefined
    setSourceFile(
      srcEntry && data.source ? { blob: srcEntry, name: data.source.name } : null
    )
    const nodeCount = chain?.nodes.length ?? 0
    toast.push(
      'success',
      `工程已恢复：${formatBytes(audioBlob.size)} 无损音轨、效果链 ${nodeCount} 个节点${srcEntry ? '、原始导入文件' : ''}`,
      5500
    )
  }

  /** 兼容 v1/v2：明确告知用户这是有损副本，并建议另存为 v3 */
  async function loadLegacyProject(file: File): Promise<void> {
    const data = JSON.parse(await file.text()) as LegacyProject
    if (data?.app !== PROJECT_APP || typeof data.audio?.base64 !== 'string') {
      throw new Error('不是有效的 YOCIM Audio Cut 工程文件')
    }
    const binary = atob(data.audio.base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const ctx = audioEngine.ensureContext()
    const decoded = await ctx.decodeAudioData(bytes.buffer as ArrayBuffer)
    const chain = data.chain ? sanitizeChain(data.chain) : undefined
    editor.loadDecodedBuffer(decoded, data.name || baseName(file), {
      selection: data.selection,
      zoom: data.view?.zoom,
      scrollX: data.view?.scrollX,
      vGain: data.view?.vGain,
      chain
    })
    clearSourceFile()
    toast.push(
      'info',
      `已打开旧版工程 v${data.version ?? 1}：音轨是 128kbps MP3 有损副本。建议立刻点「保存工程」另存为无损 .yac.zip`,
      8000
    )
  }

  async function loadProject(file: File): Promise<void> {
    try {
      if (/\.json$/i.test(file.name)) await loadLegacyProject(file)
      else await loadZipProject(file)
    } catch (err) {
      console.error(err)
      toast.push('error', err instanceof Error ? err.message : '工程加载失败')
    }
  }

  return { saving, progress, saveProject, loadProject }
}
