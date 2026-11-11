/**
 * 编辑器核心 Store。
 * 关键约束：AudioBuffer / PeakCache 使用 shallowRef，历史快照为普通数组，
 * 绝不进入 Vue 深层响应式系统。
 *
 * 效果链是非破坏性的：chain 只存指令，音轨数据保持原始状态。
 * 撤销栈因此分两类——音频命令（只保存被替换区间的 before/after 片段）与链快照
 * （仅几十字节，不复制任何采样），使 Ctrl+Z 能同时撤销剪辑与效果参数改动。
 */
import { computed, reactive, ref, shallowRef, watch } from 'vue'
import { defineStore } from 'pinia'
import { audioEngine } from '../audio/engine'
import { startPeakBuild, type PeakBuild, type PeakCache } from '../audio/peaks'
import { useToastStore } from './toast'
import { renderChain } from '../audio/effects'
import {
  applyParamPatch,
  chainActive,
  chainSignature,
  CHAIN_PRESETS,
  cloneChain,
  createDefaultChain,
  createNode,
  enabledNodes,
  sanitizeChain,
  type EffectChainState,
  type EffectKind
} from '../audio/effect-chain'
import {
  channelsToAudioBuffer,
  convertChannels,
  getAllChannels,
  replaceAudioRegion,
  resampleChannels,
  sliceChannels,
  snapTime,
  clamp
} from '../utils/audio-utils'
import { runProcessTask } from '../utils/process-worker'
import { setSourceFile } from '../utils/source-file'

/**
 * 音频命令：一次剪辑只记录「在 start 处用 after 替换掉 before」这一区间，
 * 不再复制整条音轨。before/after 长度可以不同，因此插入、删除、变速同样适用。
 * 约定：传入的数组必须是专有的新拷贝，命令持有后不再被外部修改。
 */
interface AudioCommand {
  kind: 'audio'
  start: number
  before: Float32Array[]
  after: Float32Array[]
  sampleRate: number
  chainBefore: EffectChainState
  chainAfter: EffectChainState
  selectionBefore: { start: number; end: number }
  positionBefore: number
}

/** 链快照：只记录前后两份指令，体积可忽略 */
interface ChainSnapshot {
  kind: 'chain'
  before: EffectChainState
  after: EffectChainState
}

export type Snapshot = AudioCommand | ChainSnapshot

export interface LoadOptions {
  selection?: { start: number; end: number }
  zoom?: number
  scrollX?: number
  vGain?: number
  chain?: EffectChainState
}

/** 工程/本地备份恢复时一并还原的界面标志位（不含音频与撤销栈） */
export interface ViewState {
  zeroSnap?: boolean
  isLooping?: boolean
  volume?: number
  sidebarTab?: SidebarTab
}

const VALID_TABS: SidebarTab[] = ['edit', 'effects', 'speed', 'merge', 'extract', 'export']

interface ClipboardData {
  channels: Float32Array[]
  sampleRate: number
}

/** 内部剪贴板：普通模块变量，不进入响应式系统 */
let clipboard: ClipboardData | null = null

export interface MergeClipInput {
  name: string
  channels: Float32Array[]
  sampleRate: number
}

export type SidebarTab = 'edit' | 'effects' | 'speed' | 'merge' | 'extract' | 'export'
export type BusyType = 'decode' | 'stretch' | 'merge' | 'effects' | null
export type FadeCurve = 'linear' | 'cosine' | 'exponential' | 'logarithmic'

const MAX_HISTORY = 30
/** 撤销栈总内存预算（字节）。命令式历史只存改动片段，预算相应收紧 */
const MAX_HISTORY_BYTES = 192 * 1024 * 1024
/** 等长编辑时，超过此帧数就不再主线程局部刷新峰值，交给 Worker 全量重建 */
const PEAK_REFRESH_FRAME_LIMIT = 4_000_000
/** 拖动滑杆的合并窗口：停止操作后 450ms 才记为一次撤销 */
const CHAIN_COMMIT_DELAY = 450

export const useEditorStore = defineStore('editor', () => {
  const toast = useToastStore()

  // ---- 状态（大对象一律 shallowRef） ----
  const buffer = shallowRef<AudioBuffer | null>(null)
  const peakCache = shallowRef<PeakCache | null>(null)
  /** 增量峰值构建的版本号：普通数值，供波形组件 watch 后重绘 */
  const peakVersion = ref(0)
  const peakProgress = ref(1)
  const fileName = ref<string | null>(null)
  const selection = reactive({ start: 0, end: 0 })
  const zoom = ref(80) // px / 秒
  const scrollX = ref(0) // px
  const vGain = ref(1) // 垂直振幅缩放（纯显示，不改数据）
  const zeroSnap = ref(false) // 选区边缘吸附零交叉点
  const hasClipboard = ref(false)
  const pendingView = ref(false) // 由工程加载设置视图，跳过自动适应窗口
  const isPlaying = ref(false)
  const isLooping = ref(false)
  const volume = ref(0.9)
  const sidebarTab = ref<SidebarTab>('edit')
  const busy = reactive({ type: null as BusyType, progress: 0 })

  // ---- 非破坏性效果链（整体替换式更新，避免深层响应式代理） ----
  const chain = ref<EffectChainState>(createDefaultChain())
  const chainActiveNow = computed(() => chainActive(chain.value))
  const activeEffectCount = computed(() => enabledNodes(chain.value).length)

  // ---- 历史栈（非响应式数组 + 版本号触发 computed） ----
  const past: Snapshot[] = []
  const future: Snapshot[] = []
  const historyVersion = ref(0)
  let pendingChainBefore: EffectChainState | null = null
  let chainTimer: number | null = null
  let peakBuild: PeakBuild | null = null
  /** 长任务（效果固化）的取消令牌 */
  let processingController: AbortController | null = null

  const duration = computed(() => buffer.value?.duration ?? 0)
  const hasSelection = computed(() => selection.end - selection.start > 1e-4)
  const canUndo = computed(() => historyVersion.value >= 0 && past.length > 0)
  const canRedo = computed(() => historyVersion.value >= 0 && future.length > 0)

  audioEngine.onEnded = () => {
    isPlaying.value = false
  }
  let gateWarned = false
  audioEngine.onGateWorkletUnavailable = () => {
    if (gateWarned) return
    gateWarned = true
    toast.push('info', '当前浏览器不支持 AudioWorklet，门限降噪仅在导出/固化时生效', 5000)
  }

  // ---- 内部工具 ----
  function snapshotBytes(snap: Snapshot): number {
    if (snap.kind !== 'audio') return 0
    let n = 0
    for (const c of snap.before) n += c.byteLength
    for (const c of snap.after) n += c.byteLength
    return n
  }

  function totalHistoryBytes(): number {
    let n = 0
    for (const s of past) n += snapshotBytes(s)
    for (const s of future) n += snapshotBytes(s)
    return n
  }

  /** 按音频快照步数 + 字节预算裁剪；链快照只有几十字节，不占用音频撤销额度 */
  function trimHistory(): void {
    const dropOldestAudio = (list: Snapshot[], limit: number) => {
      while (list.filter((s) => s.kind === 'audio').length > limit) {
        const i = list.findIndex((s) => s.kind === 'audio')
        if (i < 0) break
        list.splice(i, 1)
      }
    }
    dropOldestAudio(past, MAX_HISTORY)
    dropOldestAudio(future, MAX_HISTORY)
    // 总条目硬上限，避免连续调整参数无限堆积链快照
    while (past.length > MAX_HISTORY * 4) past.shift()
    while (future.length > MAX_HISTORY * 4) future.shift()
    let bytes = totalHistoryBytes()
    while (bytes > MAX_HISTORY_BYTES) {
      const count =
        past.filter((s) => s.kind === 'audio').length +
        future.filter((s) => s.kind === 'audio').length
      if (count <= 1) break
      const p = past.findIndex((s) => s.kind === 'audio')
      const f = future.findIndex((s) => s.kind === 'audio')
      if (p >= 0) {
        bytes -= snapshotBytes(past[p])
        past.splice(p, 1)
      } else if (f >= 0) {
        bytes -= snapshotBytes(future[f])
        future.splice(f, 1)
      } else break
    }
  }

  /** 提交挂起的滑杆拖动，保证历史顺序与真实操作顺序一致 */
  function flushChainHistory(): void {
    if (chainTimer !== null) {
      window.clearTimeout(chainTimer)
      chainTimer = null
    }
    const before = pendingChainBefore
    pendingChainBefore = null
    if (!before) return
    const after = cloneChain(chain.value)
    if (chainSignature(before) === chainSignature(after)) return
    past.push({ kind: 'chain', before, after })
    future.length = 0
    trimHistory()
    historyVersion.value++
  }

  function clearPendingChain(): void {
    if (chainTimer !== null) window.clearTimeout(chainTimer)
    chainTimer = null
    pendingChainBefore = null
  }

  /** 记录一次链改动。coalesce=true 用于滑杆连续输入，合并为一次撤销 */
  function mutateChain(fn: (draft: EffectChainState) => void, coalesce = false): void {
    const before = cloneChain(chain.value)
    const draft = cloneChain(before)
    fn(draft)
    if (chainSignature(before) === chainSignature(draft)) return
    // 先结算挂起的滑杆拖动，其 after 应是本次离散操作之前的状态
    if (!coalesce) flushChainHistory()
    chain.value = draft
    if (coalesce) {
      if (!pendingChainBefore) pendingChainBefore = before
      if (chainTimer !== null) window.clearTimeout(chainTimer)
      chainTimer = window.setTimeout(() => flushChainHistory(), CHAIN_COMMIT_DELAY)
    } else {
      past.push({ kind: 'chain', before, after: cloneChain(draft) })
      future.length = 0
      trimHistory()
      historyVersion.value++
    }
  }

  function restoreChain(state: EffectChainState): void {
    chain.value = cloneChain(state)
  }

  function stopPlayback(): void {
    audioEngine.stop()
    isPlaying.value = false
  }

  /** 长音频峰值放 Worker 分块构建，短音频同步完成；旧任务会被取消 */
  function rebuildPeaks(buf: AudioBuffer): void {
    peakBuild?.cancel()
    const build = startPeakBuild(buf, {
      onChunk: () => {
        peakVersion.value++
      },
      onProgress: (p) => {
        peakProgress.value = p
      }
    })
    peakBuild = build
    peakCache.value = build.cache
    peakProgress.value = build.cache.progress
    peakVersion.value++
    void build.done.then((final) => {
      if (peakBuild !== build) return
      peakCache.value = final
      peakProgress.value = final.progress
      peakVersion.value++
      peakBuild = null
    })
  }

  /**
   * 局部替换并保留播放上下文：不再 stop() 把播放头归零，
   * 剪辑后仍在原时间点继续播放，选区按新时长裁剪。
   */
  function applyAudioData(
    start: number,
    removeFrames: number,
    inserted: Float32Array[]
  ): void {
    const oldBuf = buffer.value
    if (!oldBuf) return
    const wasPlaying = audioEngine.isPlaying
    const pos = audioEngine.getPosition()

    const newBuf = replaceAudioRegion(oldBuf, start, removeFrames, inserted)
    buffer.value = newBuf
    audioEngine.setBuffer(newBuf)
    const target = clamp(pos, 0, Math.max(0, newBuf.duration - 0.001))
    audioEngine.seek(target)
    if (wasPlaying) {
      audioEngine.play(target)
      isPlaying.value = true
    } else {
      isPlaying.value = false
    }

    const cache = peakCache.value
    const changedFrames = inserted[0]?.length ?? 0
    const refreshed =
      newBuf.length === oldBuf.length &&
      changedFrames <= PEAK_REFRESH_FRAME_LIMIT &&
      cache?.refreshRegion(newBuf, start, start + changedFrames)
    if (refreshed) {
      // 局部刷新：只重算改动区间，长音频无需重建整条金字塔
      peakVersion.value++
    } else {
      rebuildPeaks(newBuf)
    }

    selection.start = clamp(selection.start, 0, newBuf.duration)
    selection.end = clamp(selection.end, 0, newBuf.duration)
    if (selection.end <= selection.start) {
      selection.start = 0
      selection.end = 0
    }
    syncLoopRange()
  }

  /** before / after 必须是专有拷贝；命令持有后不会被外部修改 */
  function makeAudioCommand(
    start: number,
    before: Float32Array[],
    after: Float32Array[],
    chainAfter?: EffectChainState
  ): AudioCommand {
    return {
      kind: 'audio',
      start,
      before,
      after,
      sampleRate: buffer.value!.sampleRate,
      chainBefore: cloneChain(chain.value),
      chainAfter: cloneChain(chainAfter ?? chain.value),
      selectionBefore: { start: selection.start, end: selection.end },
      positionBefore: audioEngine.getPosition()
    }
  }

  /** 提交一条音频命令：入栈 + 局部应用 + 恢复操作后的链状态 */
  function commitAudioCommand(cmd: AudioCommand): void {
    flushChainHistory()
    past.push(cmd)
    future.length = 0
    trimHistory()
    historyVersion.value++
    applyAudioData(cmd.start, cmd.before[0]?.length ?? 0, cmd.after)
    restoreChain(cmd.chainAfter)
  }

  /** 撤销音频命令时把选区与播放头恢复到操作前，便于继续精细对点 */
  function restoreCommandContext(cmd: AudioCommand): void {
    const dur = duration.value
    selection.start = clamp(cmd.selectionBefore.start, 0, dur)
    selection.end = clamp(cmd.selectionBefore.end, 0, dur)
    if (selection.end <= selection.start) {
      selection.start = 0
      selection.end = 0
    }
    audioEngine.seek(clamp(cmd.positionBefore, 0, dur))
    syncLoopRange()
  }

  /** 导入 / 工程加载：新音轨从 0 开始，清空历史与旧的峰值构建任务 */
  function installBuffer(decoded: AudioBuffer): void {
    stopPlayback()
    buffer.value = decoded
    audioEngine.setBuffer(decoded)
    rebuildPeaks(decoded)
  }

  /** 仅循环开启且存在选区时才把选区设为循环边界，普通播放不受选区限制 */
  function syncLoopRange(): void {
    audioEngine.setRange(
      isLooping.value && hasSelection.value ? { start: selection.start, end: selection.end } : null
    )
  }

  /** 用已解码的 AudioBuffer 替换当前音轨（导入与工程加载共用） */
  function loadDecodedBuffer(decoded: AudioBuffer, name: string, opts: LoadOptions = {}): void {
    processingController?.abort()
    processingController = null
    past.length = 0
    future.length = 0
    clearPendingChain()
    historyVersion.value++
    installBuffer(decoded)
    fileName.value = name
    chain.value = opts.chain ? sanitizeChain(opts.chain) : createDefaultChain()
    clipboard = null
    hasClipboard.value = false
    const dur = decoded.duration
    selection.start = clamp(opts.selection?.start ?? 0, 0, dur)
    selection.end = clamp(opts.selection?.end ?? 0, 0, dur)
    if (selection.end <= selection.start) {
      selection.start = 0
      selection.end = 0
    }
    if (opts.zoom !== undefined && Number.isFinite(opts.zoom)) {
      zoom.value = clamp(opts.zoom, 0.5, 20000)
    }
    scrollX.value = Number.isFinite(opts.scrollX) ? Math.max(0, opts.scrollX!) : 0
    vGain.value = clamp(Number.isFinite(opts.vGain) ? opts.vGain! : 1, 0.25, 8)
    pendingView.value = opts.zoom !== undefined
    syncLoopRange()
  }

  /** 恢复界面标志位：循环/音量要同步到播放引擎，避免只改 ref 造成状态漂移 */
  function applyViewState(state: ViewState): void {
    if (typeof state.zeroSnap === 'boolean') zeroSnap.value = state.zeroSnap
    if (typeof state.isLooping === 'boolean') {
      isLooping.value = state.isLooping
      audioEngine.setLoop(state.isLooping)
      syncLoopRange()
    }
    if (typeof state.volume === 'number' && Number.isFinite(state.volume)) {
      setVolume(clamp(state.volume, 0, 1))
    }
    if (state.sidebarTab && VALID_TABS.includes(state.sidebarTab)) sidebarTab.value = state.sidebarTab
  }

  // ---- 效果链动作 ----
  function addEffect(kind: EffectKind): void {
    mutateChain((d) => {
      d.nodes.push(createNode(kind))
    })
  }

  function removeEffect(id: string): void {
    mutateChain((d) => {
      d.nodes = d.nodes.filter((n) => n.id !== id)
    })
  }

  function moveEffect(id: string, delta: -1 | 1): void {
    mutateChain((d) => {
      const i = d.nodes.findIndex((n) => n.id === id)
      const j = i + delta
      if (i < 0 || j < 0 || j >= d.nodes.length) return
      const tmp = d.nodes[i]
      d.nodes[i] = d.nodes[j]
      d.nodes[j] = tmp
    })
  }

  function setEffectEnabled(id: string, enabled: boolean): void {
    mutateChain((d) => {
      const n = d.nodes.find((x) => x.id === id)
      if (n) n.enabled = enabled
    })
  }

  function updateEffect(id: string, patch: Record<string, number | boolean>): void {
    mutateChain((d) => {
      const i = d.nodes.findIndex((n) => n.id === id)
      if (i >= 0) d.nodes[i] = applyParamPatch(d.nodes[i], patch)
    }, true)
  }

  function setBypass(value: boolean): void {
    mutateChain((d) => {
      d.bypass = value
    })
  }

  function toggleBypass(): void {
    setBypass(!chain.value.bypass)
  }

  /** 「按住听原声」的瞬时旁路：只改试听状态，不写入撤销栈 */
  function previewBypass(value: boolean): void {
    if (chain.value.bypass === value) return
    chain.value = { ...cloneChain(chain.value), bypass: value }
  }

  function setEffectScope(scope: 'all' | 'selection'): void {
    mutateChain((d) => {
      d.scope = scope
    })
  }

  function applyPreset(index: number): void {
    const preset = CHAIN_PRESETS[index]
    if (!preset) return
    mutateChain((d) => {
      const built = preset.build()
      d.nodes = built.nodes
      d.scope = built.scope
      d.bypass = false
    })
    toast.push('success', `已载入预设「${preset.name}」`)
  }

  function clearChain(): void {
    mutateChain((d) => {
      d.nodes = []
      d.bypass = false
    })
  }

  /** 从工程文件恢复链（不产生撤销记录） */
  function loadChain(raw: unknown): void {
    clearPendingChain()
    chain.value = sanitizeChain(raw)
  }

  /** 把当前链按作用范围固化进音轨，随后清空链；一次 Ctrl+Z 可完整还原 */
  async function bounceChain(): Promise<void> {
    const buf = buffer.value
    if (!buf || busy.type) return
    if (!chainActiveNow.value) {
      toast.push('info', '效果链为空或已旁路，没有需要固化的效果')
      return
    }
    const sr = buf.sampleRate
    const useSel = chain.value.scope === 'selection' && hasSelection.value
    const s = useSel ? Math.floor(selection.start * sr) : 0
    const e = useSel ? Math.floor(selection.end * sr) : buf.length
    if (e - s < 16) {
      toast.push('error', '处理区域过短')
      return
    }
    const nodes = enabledNodes(chain.value)
    const scopeToKeep = chain.value.scope
    const controller = new AbortController()
    processingController = controller
    busy.type = 'effects'
    busy.progress = 0
    try {
      const before = sliceChannels(getAllChannels(buf), s, e)
      const processed = await renderChain(
        before,
        sr,
        nodes,
        (p) => {
          busy.progress = Math.round(p)
        },
        controller.signal
      )
      if (controller.signal.aborted) throw new DOMException('已取消', 'AbortError')
      const chainAfter = { ...createDefaultChain(), scope: scopeToKeep }
      commitAudioCommand(makeAudioCommand(s, before, processed, chainAfter))
      toast.push('success', `已把 ${nodes.length} 个效果写入音轨（可用 Ctrl+Z 还原）`)
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        toast.push('info', '已取消效果固化')
      } else {
        console.error(err)
        toast.push('error', '效果固化失败，音轨未改动')
      }
    } finally {
      if (processingController === controller) processingController = null
      busy.type = null
      busy.progress = 0
    }
  }

  /** 取消正在进行的离线效果渲染（固化） */
  function cancelProcessing(): void {
    processingController?.abort()
  }

  /** 链与选区变化时同步到播放引擎（无 AudioContext 时仅记录状态） */
  watch(
    [chain, () => selection.start, () => selection.end, hasSelection],
    () => {
      audioEngine.setEffectChain(
        chain.value,
        chain.value.scope === 'selection' && hasSelection.value
          ? { start: selection.start, end: selection.end }
          : null
      )
    },
    { immediate: true }
  )

  // ---- 导入 ----
  async function loadFile(file: File): Promise<void> {
    if (busy.type) return
    busy.type = 'decode'
    try {
      const ctx = audioEngine.ensureContext()
      const bytes = await file.arrayBuffer()
      const decoded = await ctx.decodeAudioData(bytes)
      loadDecodedBuffer(decoded, file.name.replace(/\.[^.]+$/, ''))
      // 保留未解码的原始文件：工程包归档与「重新解码」都用得上，且不会引入二次有损
      setSourceFile({ blob: file, name: file.name })
      toast.push('success', `已加载 ${file.name}（${decoded.duration.toFixed(1)}s / ${decoded.numberOfChannels}ch / ${decoded.sampleRate}Hz）`)
    } catch (err) {
      console.error(err)
      toast.push('error', '音频解码失败，请确认文件格式有效（mp3/wav/m4a/ogg/flac）')
    } finally {
      busy.type = null
      busy.progress = 0
    }
  }

  // ---- 选区 ----
  /** 在 ±20ms 范围寻找最近的上升沿零交叉采样点 */
  function findZeroCrossing(channel: Float32Array, target: number, radius: number): number {
    const lo = Math.max(1, target - radius)
    const hi = Math.min(channel.length - 1, target + radius)
    let best = -1
    let bestDist = Infinity
    for (let i = lo; i <= hi; i++) {
      if (channel[i - 1] <= 0 && channel[i] > 0) {
        const dist = Math.abs(i - target)
        if (dist < bestDist) {
          bestDist = dist
          best = i
        }
      }
    }
    return best >= 0 ? best : target
  }

  /** precise=true 时跳过 0.1s 网格吸附，用于面板内数值精确输入 */
  function setSelection(start: number, end: number, precise = false): void {
    if (!Number.isFinite(start) || !Number.isFinite(end)) return
    const dur = duration.value
    let s = precise ? Math.min(start, end) : snapTime(Math.min(start, end))
    let e = precise ? Math.max(start, end) : snapTime(Math.max(start, end))
    s = clamp(s, 0, dur)
    e = clamp(e, 0, dur)
    const buf = buffer.value
    if (zeroSnap.value && buf && buf.length > 2) {
      const sr = buf.sampleRate
      const radius = Math.round(sr * 0.02)
      const ch = buf.getChannelData(0)
      const plainS = s
      const plainE = e
      const snappedS = findZeroCrossing(ch, Math.round(s * sr), radius) / sr
      const snappedE = findZeroCrossing(ch, Math.round(e * sr), radius) / sr
      // 起止点各自独立吸附可能重合甚至翻转，吸附后必须重新校验顺序
      s = clamp(Math.min(snappedS, snappedE), 0, dur)
      e = clamp(Math.max(snappedS, snappedE), 0, dur)
      // 短选区两端可能吸到同一采样：放弃吸附而不是让选区静默消失
      if (e - s < 1 / sr) {
        s = plainS
        e = plainE
      }
    }
    selection.start = s
    selection.end = e
    syncLoopRange()
  }

  function setSelectionRaw(start: number, end: number): void {
    selection.start = start
    selection.end = end
    syncLoopRange()
  }

  function clearSelection(): void {
    selection.start = 0
    selection.end = 0
    syncLoopRange()
  }

  // ---- 剪辑操作 ----
  function trim(): void {
    const buf = buffer.value
    if (!buf || !hasSelection.value) return
    const sr = buf.sampleRate
    const s = Math.floor(selection.start * sr)
    const e = Math.floor(selection.end * sr)
    const all = getAllChannels(buf)
    // 裁剪本质是整条替换，历史仍需保留原音轨；其余剪辑都只保存改动区间
    const before = sliceChannels(all, 0, buf.length)
    const after = sliceChannels(all, s, e)
    if (after[0]?.length === 0) {
      toast.push('error', '选区为空，无法裁剪')
      return
    }
    commitAudioCommand(makeAudioCommand(0, before, after))
    clearSelection()
    scrollX.value = 0
    toast.push('success', '已裁剪至选区')
  }

  function deleteRegion(): void {
    const buf = buffer.value
    if (!buf || !hasSelection.value || busy.type) return
    const sr = buf.sampleRate
    const all = getAllChannels(buf)
    const s = Math.floor(selection.start * sr)
    const e = Math.floor(selection.end * sr)
    const before = sliceChannels(all, s, e)
    if (buf.length - before[0].length < 1) {
      toast.push('error', '不能删除整条音轨，请使用裁剪或重新导入')
      return
    }
    // 删除操作的历史只保存「被删掉的片段」，插入端是零长度
    const after = all.map(() => new Float32Array(0))
    commitAudioCommand(makeAudioCommand(s, before, after))
    clearSelection()
    toast.push('success', '已删除选区')
  }

  function silence(): void {
    const buf = buffer.value
    if (!buf || !hasSelection.value) return
    const sr = buf.sampleRate
    const s = Math.floor(selection.start * sr)
    const e = Math.floor(selection.end * sr)
    const all = getAllChannels(buf)
    const before = sliceChannels(all, s, e)
    const after = all.map(() => new Float32Array(e - s))
    commitAudioCommand(makeAudioCommand(s, before, after))
    toast.push('success', '选区已静音')
  }

  /** 淡入增益曲线：t ∈ [0,1]，返回 0→1 */
  function curveValue(curve: FadeCurve, t: number): number {
    switch (curve) {
      case 'linear':
        return t
      case 'exponential': {
        const k = 4
        return (Math.exp(k * t) - 1) / (Math.exp(k) - 1)
      }
      case 'logarithmic': {
        const k = 4
        return Math.log1p(k * t) / Math.log1p(k)
      }
      default:
        return 0.5 * (1 - Math.cos(Math.PI * t))
    }
  }

  function applyFade(kind: 'in' | 'out', curve: FadeCurve): void {
    if (!buffer.value) return
    if (!hasSelection.value) {
      toast.push('info', '请先框选需要淡入/淡出的区域')
      return
    }
    const buf = buffer.value
    const sr = buf.sampleRate
    const s = Math.floor(selection.start * sr)
    const e = Math.floor(selection.end * sr)
    const before = sliceChannels(getAllChannels(buf), s, e)
    const after = before.map((c) => c.slice())
    const len = e - s
    for (const c of after) {
      for (let i = 0; i < len; i++) {
        const t = len <= 1 ? 1 : i / (len - 1)
        const gain = kind === 'in' ? curveValue(curve, t) : curveValue(curve, 1 - t)
        c[i] *= gain
      }
    }
    commitAudioCommand(makeAudioCommand(s, before, after))
    toast.push('success', kind === 'in' ? '已应用淡入' : '已应用淡出')
  }

  function fadeIn(curve: FadeCurve = 'cosine'): void {
    applyFade('in', curve)
  }

  function fadeOut(curve: FadeCurve = 'cosine'): void {
    applyFade('out', curve)
  }

  // ---- 插入静音 / 复制剪切粘贴 ----
  function insertSilence(seconds: number): void {
    const buf = buffer.value
    if (!buf || busy.type) return
    const secs = clamp(seconds, 0.05, 60)
    const sr = buf.sampleRate
    const atSec = hasSelection.value
      ? selection.start
      : clamp(audioEngine.getPosition(), 0, buf.duration)
    const at = Math.floor(atSec * sr)
    const all = getAllChannels(buf)
    const before = all.map(() => new Float32Array(0))
    const after = all.map(() => new Float32Array(Math.round(secs * sr)))
    commitAudioCommand(makeAudioCommand(at, before, after))
    const endSec = Math.min(duration.value, atSec + secs)
    setSelection(atSec, endSec)
    audioEngine.seek(endSec)
    toast.push('success', `已在 ${atSec.toFixed(1)}s 插入 ${secs.toFixed(1)}s 静音`)
  }

  function snapshotSelection(): ClipboardData | null {
    const buf = buffer.value
    if (!buf || !hasSelection.value) return null
    const sr = buf.sampleRate
    return {
      channels: sliceChannels(
        getAllChannels(buf),
        Math.floor(selection.start * sr),
        Math.floor(selection.end * sr)
      ),
      sampleRate: sr
    }
  }

  function copySelection(): void {
    const data = snapshotSelection()
    if (!data) {
      toast.push('info', '请先在波形上框选要复制的区域')
      return
    }
    clipboard = data
    hasClipboard.value = true
    toast.push('success', `已复制 ${(data.channels[0].length / data.sampleRate).toFixed(1)}s 选区`)
  }

  function cutSelection(): void {
    const data = snapshotSelection()
    if (!data) {
      toast.push('info', '请先在波形上框选要剪切的区域')
      return
    }
    const buf = buffer.value!
    const s = Math.floor(selection.start * buf.sampleRate)
    const before = data.channels
    if (buf.length - before[0].length < 1) {
      toast.push('error', '不能剪切整条音轨')
      return
    }
    clipboard = data
    hasClipboard.value = true
    const after = getAllChannels(buf).map(() => new Float32Array(0))
    commitAudioCommand(makeAudioCommand(s, before, after))
    clearSelection()
    toast.push('success', '已剪切选区')
  }

  async function pasteAtPlayhead(): Promise<void> {
    const buf = buffer.value
    if (!buf || !clipboard || busy.type) return
    const sr = buf.sampleRate
    let clip = convertChannels(
      clipboard.channels.map((c) => c.slice()),
      buf.numberOfChannels <= 1 ? 'mono' : 'stereo'
    )
    if (clipboard.sampleRate !== sr) {
      clip = await resampleChannels(clip, clipboard.sampleRate, sr)
    }
    const atSec = hasSelection.value
      ? selection.start
      : clamp(audioEngine.getPosition(), 0, buf.duration)
    const at = Math.floor(atSec * sr)
    const before = getAllChannels(buf).map(() => new Float32Array(0))
    commitAudioCommand(makeAudioCommand(at, before, clip))
    const endSec = Math.min(duration.value, atSec + clip[0].length / sr)
    setSelection(atSec, endSec)
    audioEngine.seek(endSec)
    toast.push('success', `已粘贴到 ${atSec.toFixed(1)}s`)
  }

  // ---- 增益 / 归一化 ----
  function scaleRegion(gain: number, onlySelection: boolean, message: string): boolean {
    const buf = buffer.value
    if (!buf || busy.type) return false
    const sr = buf.sampleRate
    const useSel = onlySelection && hasSelection.value
    const s = useSel ? Math.floor(selection.start * sr) : 0
    const e = useSel ? Math.floor(selection.end * sr) : buf.length
    const before = sliceChannels(getAllChannels(buf), s, e)
    const after = before.map((c) => c.slice())
    let peak = 0
    for (const c of after) {
      for (let i = 0; i < c.length; i++) {
        const v = c[i] * gain
        c[i] = v
        const a = Math.abs(v)
        if (a > peak) peak = a
      }
    }
    commitAudioCommand(makeAudioCommand(s, before, after))
    if (peak > 1) {
      toast.push('info', `${message}完成；峰值 ${(20 * Math.log10(peak)).toFixed(1)} dBFS 超过 0 dBFS，导出时会被限幅`)
    } else {
      toast.push('success', `${message}完成`)
    }
    return true
  }

  function setGainDb(db: number, onlySelection: boolean): void {
    if (!Number.isFinite(db) || db < -96 || db > 24) {
      toast.push('info', '增益范围 -96 ~ +24 dB')
      return
    }
    scaleRegion(Math.pow(10, db / 20), onlySelection, `增益 ${db > 0 ? '+' : ''}${db.toFixed(1)} dB `)
  }

  function normalize(onlySelection: boolean): void {
    const buf = buffer.value
    if (!buf || busy.type) return
    const sr = buf.sampleRate
    const useSel = onlySelection && hasSelection.value
    const s = useSel ? Math.floor(selection.start * sr) : 0
    const e = useSel ? Math.floor(selection.end * sr) : buf.length
    let peak = 0
    for (const c of getAllChannels(buf)) {
      for (let i = s; i < e; i++) {
        const a = Math.abs(c[i])
        if (a > peak) peak = a
      }
    }
    if (peak < 1e-6) {
      toast.push('error', useSel ? '选区为静音，无法归一化' : '音轨为静音，无法归一化')
      return
    }
    const target = Math.pow(10, -1 / 20)
    scaleRegion(
      target / peak,
      onlySelection,
      `归一化至 -1 dBFS（原峰值 ${(20 * Math.log10(peak)).toFixed(1)} dBFS）`
    )
  }

  // ---- 变速（WSOLA Worker） ----
  async function timeStretch(ratio: number, keepPitch: boolean, onlySelection: boolean): Promise<void> {
    const buf = buffer.value
    if (!buf || busy.type) return
    if (Math.abs(ratio - 1) < 0.001) {
      toast.push('info', '速度为 1.00x，无需处理')
      return
    }
    const sr = buf.sampleRate
    const useSel = onlySelection && hasSelection.value
    const s = useSel ? Math.floor(selection.start * sr) : 0
    const e = useSel ? Math.floor(selection.end * sr) : buf.length
    if (e - s < sr * 0.05) {
      toast.push('error', '选区过短（< 0.05s），无法变速')
      return
    }
    busy.type = 'stretch'
    busy.progress = 0
    try {
      const before = sliceChannels(getAllChannels(buf), s, e)
      // Worker 会转移 buffer，历史要保留原始数据，因此另送一份副本进 Worker
      const work = before.map((c) => c.slice())
      const result = await runProcessTask<{ channels: Float32Array[] }>(
        { type: 'time-stretch', channels: work, sampleRate: sr, ratio, keepPitch },
        work.map((c) => c.buffer as ArrayBuffer),
        (p) => {
          busy.progress = p
        }
      )
      commitAudioCommand(makeAudioCommand(s, before, result.channels))
      clearSelection()
      toast.push('success', `变速完成：${ratio.toFixed(2)}x${keepPitch ? '（保持音调）' : ''}`)
    } catch (err) {
      console.error(err)
      toast.push('error', '变速处理失败')
    } finally {
      busy.type = null
      busy.progress = 0
    }
  }

  // ---- 合并（Worker） ----
  async function mergeClips(clips: MergeClipInput[], gapSeconds: number, crossfadeSeconds: number): Promise<void> {
    if (clips.length === 0 || busy.type) return
    busy.type = 'merge'
    busy.progress = 0
    try {
      const targetRate = buffer.value?.sampleRate ?? clips[0].sampleRate
      const targetChannels = Math.min(2, buffer.value?.numberOfChannels ?? clips[0].channels.length)
      const mode = targetChannels === 1 ? 'mono' : 'stereo'
      const normalized: Float32Array[][] = []
      for (const clip of clips) {
        let ch = convertChannels(clip.channels, mode)
        if (clip.sampleRate !== targetRate) {
          ch = await resampleChannels(ch, clip.sampleRate, targetRate)
        }
        normalized.push(ch)
      }
      const result = await runProcessTask<{ channels: Float32Array[] }>(
        { type: 'merge', clips: normalized, gapSeconds, crossfadeSeconds, sampleRate: targetRate },
        normalized.flat().map((c) => c.buffer as ArrayBuffer),
        (p) => {
          busy.progress = p
        }
      )
      if (buffer.value) {
        const before = sliceChannels(getAllChannels(buffer.value), 0, buffer.value.length)
        commitAudioCommand(makeAudioCommand(0, before, result.channels))
      } else {
        installBuffer(channelsToAudioBuffer(result.channels, targetRate))
      }
      clearSelection()
      scrollX.value = 0
      fileName.value = fileName.value ? `${fileName.value}-merged` : 'merged'
      toast.push('success', `已合并 ${clips.length} 个片段并替换当前音轨`)
    } catch (err) {
      console.error(err)
      toast.push('error', '合并失败')
    } finally {
      busy.type = null
      busy.progress = 0
    }
  }

  // ---- 撤销 / 重做 ----
  function undo(): void {
    // 异步处理期间不允许撤销，否则会把半成品写入历史栈
    if (busy.type) return
    flushChainHistory()
    const snap = past.pop()
    if (!snap) return
    if (snap.kind === 'audio') {
      future.push(snap)
      applyAudioData(snap.start, snap.after[0]?.length ?? 0, snap.before)
      restoreChain(snap.chainBefore)
      restoreCommandContext(snap)
    } else {
      future.push(snap)
      restoreChain(snap.before)
    }
    trimHistory()
    historyVersion.value++
  }

  function redo(): void {
    if (busy.type) return
    flushChainHistory()
    const snap = future.pop()
    if (!snap) return
    if (snap.kind === 'audio') {
      past.push(snap)
      applyAudioData(snap.start, snap.before[0]?.length ?? 0, snap.after)
      restoreChain(snap.chainAfter)
    } else {
      past.push(snap)
      restoreChain(snap.after)
    }
    trimHistory()
    historyVersion.value++
  }

  // ---- 播放控制 ----
  function togglePlay(from?: number): void {
    if (!buffer.value) return
    if (audioEngine.isPlaying) {
      audioEngine.pause()
      isPlaying.value = false
      return
    }
    syncLoopRange()
    let pos = from ?? audioEngine.getPosition()
    if (pos >= duration.value - 0.01) {
      pos = isLooping.value && hasSelection.value ? selection.start : 0
    }
    audioEngine.play(pos)
    isPlaying.value = true
  }

  /** 试听：有选区时从选区起点开始，否则从头开始，便于 A/B 对比同一段落 */
  function audition(): void {
    if (!buffer.value) return
    flushChainHistory()
    togglePlay(hasSelection.value ? selection.start : 0)
  }

  function stop(): void {
    stopPlayback()
  }

  function seek(t: number): void {
    audioEngine.seek(t)
  }

  function setVolume(v: number): void {
    volume.value = v
    audioEngine.setVolume(v)
  }

  function toggleLoop(): void {
    isLooping.value = !isLooping.value
    audioEngine.setLoop(isLooping.value)
    syncLoopRange()
  }

  return {
    buffer,
    peakCache,
    peakVersion,
    peakProgress,
    fileName,
    selection,
    zoom,
    scrollX,
    vGain,
    zeroSnap,
    hasClipboard,
    pendingView,
    isPlaying,
    isLooping,
    volume,
    sidebarTab,
    busy,
    chain,
    chainActiveNow,
    activeEffectCount,
    duration,
    hasSelection,
    canUndo,
    canRedo,
    loadFile,
    loadDecodedBuffer,
    applyViewState,
    setSelection,
    setSelectionRaw,
    clearSelection,
    trim,
    deleteRegion,
    silence,
    fadeIn,
    fadeOut,
    insertSilence,
    copySelection,
    cutSelection,
    pasteAtPlayhead,
    setGainDb,
    normalize,
    addEffect,
    removeEffect,
    moveEffect,
    setEffectEnabled,
    updateEffect,
    setBypass,
    toggleBypass,
    previewBypass,
    setEffectScope,
    applyPreset,
    clearChain,
    loadChain,
    bounceChain,
    cancelProcessing,
    audition,
    timeStretch,
    mergeClips,
    undo,
    redo,
    togglePlay,
    stop,
    seek,
    setVolume,
    toggleLoop
  }
})
