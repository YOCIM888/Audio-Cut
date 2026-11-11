/**
 * 本地工程自动保存 / 刷新恢复。
 *
 * 分工：
 *  - 音轨（shallowRef<AudioBuffer>）变化 → 2s 防抖后把 **原始 planar Float32** 写进 IndexedDB。
 *    无编码、无 base64、无 JSON.stringify，long audio 不会被字符串撑爆，也不会二次有损。
 *  - 选区 / 视图 / 效果链等指令变化 → 700ms 防抖后只写几 KB 的 JSON。
 *  - 两类写入走同一条串行队列，避免「指令已更新、音频还是旧的」的竞态。
 *  - pagehide / 标签页隐藏时立即落盘兜底。
 *
 * 音频超过上限或配额不足时仍保存指令，但明确标记「音轨未落盘」并提示手动导出工程包。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useEditorStore, type SidebarTab } from '../stores/editor'
import { useToastStore } from '../stores/toast'
import { cloneChain, sanitizeChain } from '../audio/effect-chain'
import { channelsToAudioBuffer, getAllChannels } from '../utils/audio-utils'
import {
  ACTIVE_ID,
  SESSION_VERSION,
  clearSession,
  deleteSource,
  isPersistenceAvailable,
  persistenceUnavailableReason,
  readAudio,
  readSession,
  readSource,
  writeAudio,
  writeSession,
  writeSource,
  type AudioRecord,
  type SessionMeta
} from '../utils/project-db'
import { getSourceFile, onSourceFileChange, setSourceFile } from '../utils/source-file'

/** 超过此体积不再自动落盘（约 45 分钟 48kHz 立体声），避免拖垮浏览器与磁盘配额 */
export const MAX_AUTOSAVE_BYTES = 512 * 1024 * 1024
/** 原始导入文件的归档上限 */
const MAX_SOURCE_BYTES = 256 * 1024 * 1024

export type AutoSaveStatus = 'idle' | 'restoring' | 'saving' | 'saved' | 'error' | 'disabled' | 'oversize'

const status = ref<AutoSaveStatus>('idle')
const lastSavedAt = ref<number | null>(null)
const storedBytes = ref(0)
const hasSession = ref(false)
const paused = ref(false)
const note = ref('')

const statusLabel = computed(() => {
  switch (status.value) {
    case 'restoring':
      return '正在恢复本地工程…'
    case 'saving':
      return '正在自动保存…'
    case 'saved':
      return `已自动保存${lastSavedAt.value ? ` · ${new Date(lastSavedAt.value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : ''}`
    case 'error':
      return '自动保存失败'
    case 'disabled':
      return '本地自动保存不可用'
    case 'oversize':
      return '音频过大，仅保存编辑指令'
    default:
      return paused.value ? '本地备份已暂停' : '尚无本地备份'
  }
})

const statusTitle = computed(() => {
  const size = storedBytes.value > 0 ? `${(storedBytes.value / 1024 / 1024).toFixed(1)} MB 无损音轨` : '未写入音轨'
  const reason = note.value ? `\n${note.value}` : ''
  return `工程自动保存在本浏览器的 IndexedDB 中，刷新或关闭页面后可自动恢复。\n${size}${reason}`
})

function formatBytes(n: number): string {
  return n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
}

let installed = false
let suppress = false
let metaTimer: number | null = null
let audioTimer: number | null = null
let audioDirty = false
let queue: Promise<void> = Promise.resolve()
let lastAudioKey = 0
let warnedOversize = false
let warnedError = false

export function useProjectPersistence() {
  const editor = useEditorStore()
  const toast = useToastStore()

  function buildMeta(audioKey: number, audioBytes: number, oversize: boolean): SessionMeta {
    const buf = editor.buffer
    const src = getSourceFile()
    return {
      id: ACTIVE_ID,
      version: SESSION_VERSION,
      updatedAt: Date.now(),
      name: editor.fileName ?? 'project',
      sampleRate: buf?.sampleRate ?? 0,
      numberOfChannels: buf?.numberOfChannels ?? 0,
      length: buf?.length ?? 0,
      duration: buf?.duration ?? 0,
      selection: { start: editor.selection.start, end: editor.selection.end },
      view: { zoom: editor.zoom, scrollX: editor.scrollX, vGain: editor.vGain },
      zeroSnap: editor.zeroSnap,
      isLooping: editor.isLooping,
      volume: editor.volume,
      sidebarTab: editor.sidebarTab,
      chain: cloneChain(editor.chain),
      audioKey,
      audioBytes,
      audioOversize: oversize,
      sourceName: src?.name ?? null
    }
  }

  /** 所有 IDB 写入串行执行；失败不抛出到 UI，只降级状态并提示一次 */
  function enqueue(fn: () => Promise<void>): Promise<void> {
    queue = queue.then(async () => {
      try {
        await fn()
      } catch (err) {
        console.warn('[autosave] 写入失败', err)
        status.value = 'error'
        note.value = err instanceof Error ? err.message : '本地存储写入失败'
        if (!warnedError) {
          warnedError = true
          toast.push('error', `本地自动保存失败（${note.value}），请手动导出工程包备份`, 6000)
        }
      }
    })
    return queue
  }

  async function writeMetaOnly(): Promise<void> {
    if (!editor.buffer) return
    const ok = await writeSession(buildMeta(lastAudioKey, storedBytes.value, status.value === 'oversize'))
    if (!ok) throw new Error('编辑指令写入失败')
    hasSession.value = true
    lastSavedAt.value = Date.now()
    if (status.value === 'saving') status.value = 'saved'
  }

  async function writeAudioSnapshot(): Promise<void> {
    const buf = editor.buffer
    if (!buf) return
    const channels = getAllChannels(buf)
    const bytes = channels.reduce((n, c) => n + c.byteLength, 0)

    if (bytes > MAX_AUTOSAVE_BYTES) {
      status.value = 'oversize'
      note.value = `音轨 ${formatBytes(bytes)} 超过 ${formatBytes(MAX_AUTOSAVE_BYTES)} 自动保存上限`
      storedBytes.value = 0
      const ok = await writeSession(buildMeta(lastAudioKey, 0, true))
      if (!ok) throw new Error('编辑指令写入失败')
      hasSession.value = true
      if (!warnedOversize) {
        warnedOversize = true
        toast.push('info', `${note.value}；编辑指令仍会保存，但刷新后音轨需从工程包恢复。请用「保存工程」导出 .yac.zip`, 7000)
      }
      return
    }

    const updatedAt = Date.now()
    // Blob 直接引用各声道的字节视图；planar 布局无需交错、无需编码、零音质损失
    const blob = new Blob(
      channels.map((c) => new Uint8Array(c.buffer, c.byteOffset, c.byteLength)),
      { type: 'application/octet-stream' }
    )
    const rec: AudioRecord = {
      id: ACTIVE_ID,
      updatedAt,
      sampleRate: buf.sampleRate,
      numberOfChannels: buf.numberOfChannels,
      length: buf.length,
      bytes,
      blob
    }
    const ok = await writeAudio(rec)
    if (!ok) throw new Error('音频写入失败（可能是磁盘配额不足）')
    lastAudioKey = updatedAt
    storedBytes.value = bytes
    const metaOk = await writeSession(buildMeta(updatedAt, bytes, false))
    if (!metaOk) throw new Error('编辑指令写入失败')
    hasSession.value = true
    lastSavedAt.value = updatedAt
    status.value = 'saved'
    warnedOversize = false
    warnedError = false
    note.value = ''
  }

  function flushAudio(): Promise<void> {
    if (!audioDirty || paused.value) return Promise.resolve()
    audioDirty = false
    if (audioTimer !== null) {
      window.clearTimeout(audioTimer)
      audioTimer = null
    }
    status.value = 'saving'
    return enqueue(writeAudioSnapshot)
  }

  function scheduleAudio(): void {
    audioDirty = true
    if (audioTimer !== null) window.clearTimeout(audioTimer)
    audioTimer = window.setTimeout(() => {
      audioTimer = null
      void flushAudio()
    }, 1000)
  }

  function scheduleMeta(): void {
    if (metaTimer !== null) window.clearTimeout(metaTimer)
    metaTimer = window.setTimeout(() => {
      metaTimer = null
      if (paused.value) return
      status.value = 'saving'
      void enqueue(writeMetaOnly)
    }, 700)
  }

  function flushMeta(): void {
    if (suppress || paused.value || !editor.buffer) return
    if (metaTimer !== null) {
      window.clearTimeout(metaTimer)
      metaTimer = null
    }
    status.value = 'saving'
    void enqueue(writeMetaOnly)
  }

  /** 从 IndexedDB 恢复：planar Float32 → AudioBuffer，再还原全部编辑指令 */
  async function restore(): Promise<boolean> {
    const available = await isPersistenceAvailable()
    if (!available) {
      status.value = 'disabled'
      paused.value = true
      note.value = persistenceUnavailableReason() || '浏览器禁用了本地数据库'
      return false
    }
    status.value = 'restoring'
    try {
      const meta = await readSession()
      if (!meta) {
        status.value = 'idle'
        return false
      }
      const audio = await readAudio()
      if (!audio) {
        status.value = 'error'
        note.value = '本地备份只有编辑指令，音轨数据缺失'
        toast.push('info', '检测到上次的编辑指令，但音轨数据缺失，无法自动恢复', 5000)
        return false
      }
      const expected = audio.length * audio.numberOfChannels * 4
      if (audio.blob.size < expected || audio.length <= 0) {
        throw new Error('音轨数据不完整')
      }
      const ab = await audio.blob.arrayBuffer()
      const channels: Float32Array[] = []
      for (let c = 0; c < audio.numberOfChannels; c++) {
        channels.push(new Float32Array(ab, c * audio.length * 4, audio.length))
      }
      const buffer = channelsToAudioBuffer(channels, audio.sampleRate)

      suppress = true
      editor.loadDecodedBuffer(buffer, meta.name || 'project', {
        selection: meta.selection,
        zoom: meta.view?.zoom,
        scrollX: meta.view?.scrollX,
        vGain: meta.view?.vGain,
        chain: meta.chain ? sanitizeChain(meta.chain) : undefined
      })
      editor.applyViewState({
        zeroSnap: meta.zeroSnap,
        isLooping: meta.isLooping,
        volume: meta.volume,
        sidebarTab: meta.sidebarTab as SidebarTab | undefined
      })
      const src = await readSource()
      setSourceFile(src ? { blob: src.blob, name: src.name } : null, false)
      await nextTick()
      suppress = false

      lastAudioKey = audio.updatedAt
      storedBytes.value = audio.bytes
      lastSavedAt.value = meta.updatedAt
      hasSession.value = true
      paused.value = false
      status.value = 'saved'
      note.value = ''
      const stale = meta.audioKey !== audio.updatedAt || meta.length !== audio.length
      const nodeCount = editor.chain.nodes.length
      const warning = meta.audioOversize
        ? '；音轨此前因体积过大未落盘，恢复的是更早的音轨，请以工程包为准'
        : stale
          ? '；最新一次编辑未完成落盘，选区已按音轨校正'
          : ''
      toast.push(
        stale || meta.audioOversize ? 'info' : 'success',
        `已恢复上次编辑：${meta.name}（无损音轨 ${formatBytes(audio.bytes)}，效果链 ${nodeCount} 个节点）${warning}`,
        6500
      )
      return true
    } catch (err) {
      suppress = false
      status.value = 'error'
      note.value = err instanceof Error ? err.message : '恢复失败'
      toast.push('error', `本地工程恢复失败：${note.value}`, 5000)
      console.error('[autosave] restore', err)
      return false
    }
  }

  /** 手动立即全量保存（含音轨） */
  async function saveNow(): Promise<void> {
    if (!editor.buffer) {
      toast.push('info', '当前没有可保存的音频')
      return
    }
    if (status.value === 'disabled') {
      toast.push('error', `本地存储不可用：${note.value}`)
      return
    }
    paused.value = false
    audioDirty = true
    await flushAudio()
    if (status.value === 'saved') toast.push('success', '本地工程已保存')
    else if (status.value === 'oversize') {
      toast.push('info', `${note.value}，请改用「保存工程」导出 .yac.zip 归档`, 6500)
    }
  }

  /** 删除本地备份；本次会话暂停自动保存，直到再次导入/编辑音频 */
  async function deleteLocalProject(): Promise<void> {
    if (metaTimer !== null) window.clearTimeout(metaTimer)
    if (audioTimer !== null) window.clearTimeout(audioTimer)
    metaTimer = null
    audioTimer = null
    audioDirty = false
    paused.value = true
    await enqueue(async () => {
      await clearSession()
    })
    hasSession.value = false
    lastSavedAt.value = null
    storedBytes.value = 0
    lastAudioKey = 0
    warnedOversize = false
    warnedError = false
    note.value = ''
    status.value = 'idle'
    toast.push('success', '本地工程备份已删除，本次会话不再自动保存', 4500)
  }

  function install(): void {
    if (installed) return
    installed = true

    onSourceFileChange((info) => {
      if (suppress || status.value === 'disabled') return
      void enqueue(async () => {
        if (!info || info.blob.size > MAX_SOURCE_BYTES) {
          await deleteSource()
          return
        }
        const ok = await writeSource({
          id: ACTIVE_ID,
          updatedAt: Date.now(),
          name: info.name,
          type: info.blob.type,
          bytes: info.blob.size,
          blob: info.blob
        })
        if (!ok) throw new Error('原始文件写入失败')
        await writeMetaOnly()
      })
    })

    watch(
      () => [
        editor.fileName,
        editor.selection.start,
        editor.selection.end,
        editor.zoom,
        editor.scrollX,
        editor.vGain,
        editor.zeroSnap,
        editor.isLooping,
        editor.volume,
        editor.sidebarTab,
        editor.chain
      ],
      () => {
        if (!suppress && !paused.value && status.value !== 'disabled') scheduleMeta()
      },
      { flush: 'post' }
    )

    watch(
      () => editor.buffer,
      (buf) => {
        if (!buf || status.value === 'disabled') return
        // 删除备份后用户又开始导入/编辑 → 重新启用自动保存
        paused.value = false
        if (suppress) return
        warnedOversize = false
        scheduleAudio()
      },
      { flush: 'post' }
    )

    window.addEventListener('pagehide', () => {
      flushMeta()
      void flushAudio()
    })
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'hidden') return
      flushMeta()
      void flushAudio()
    })

    void restore()
  }

  return {
    status,
    statusLabel,
    statusTitle,
    lastSavedAt,
    storedBytes,
    hasSession,
    paused,
    note,
    install,
    restore,
    saveNow,
    deleteLocalProject
  }
}
