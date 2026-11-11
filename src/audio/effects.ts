/**
 * 效果节点与离线渲染。
 *
 * 同一个 EffectNode 定义同时驱动「实时试听图」与「离线渲染」：
 *  - createEffectAudioNode / updateEffectAudioNode 被实时图和 OfflineAudioContext 共用；
 *  - renderChain 按链顺序把原生节点段（OfflineAudioContext）与门限段（Worker）串起来，
 *    因此链里门限放在压缩前还是压缩后，导出结果与试听一致。
 *
 * 注意：AudioContext / OfflineAudioContext 不可在 Web Worker 内使用，EQ 与压缩只在主线程渲染。
 */
import { runProcessTask } from '../utils/process-worker'
import type { EffectNode, GateNode } from './effect-chain'

function setParam(param: AudioParam, value: number, smooth: boolean, now: number): void {
  if (!Number.isFinite(value)) return
  if (smooth) param.setTargetAtTime(value, now, 0.012)
  else param.value = value
}

export function abortError(): DOMException {
  return new DOMException('离线渲染已取消', 'AbortError')
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

/** 让长任务在中止信号触发时立刻返回；底层不可中断的渲染仍会自然结束 */
function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  assertNotAborted(signal)
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(abortError()), { once: true })
    })
  ])
}

/** 按规格创建一个 Web Audio 节点；gate 由 effect-graph 的 AudioWorklet 处理，这里返回 null */
export function createEffectAudioNode(ctx: BaseAudioContext, spec: EffectNode): AudioNode | null {
  switch (spec.kind) {
    case 'highpass':
    case 'lowpass':
    case 'peaking': {
      const f = ctx.createBiquadFilter()
      f.type = spec.kind === 'highpass' ? 'highpass' : spec.kind === 'lowpass' ? 'lowpass' : 'peaking'
      f.Q.value = 0.707
      updateEffectAudioNode(f, spec, false, 0)
      return f
    }
    case 'compressor':
    case 'gain': {
      const n = spec.kind === 'compressor' ? ctx.createDynamicsCompressor() : ctx.createGain()
      updateEffectAudioNode(n, spec, false, 0)
      return n
    }
    default:
      return null
  }
}

/** 参数热更新：实时图用 setTargetAtTime 平滑，离线渲染直接赋值 */
export function updateEffectAudioNode(
  node: AudioNode,
  spec: EffectNode,
  smooth: boolean,
  now: number
): void {
  switch (spec.kind) {
    case 'highpass':
    case 'lowpass':
    case 'peaking': {
      const f = node as BiquadFilterNode
      setParam(f.frequency, spec.hz, smooth, now)
      setParam(f.Q, spec.q, smooth, now)
      if (spec.kind === 'peaking') setParam(f.gain, spec.gainDb, smooth, now)
      break
    }
    case 'compressor': {
      const c = node as DynamicsCompressorNode
      setParam(c.threshold, spec.thresholdDb, smooth, now)
      setParam(c.ratio, spec.ratio, smooth, now)
      setParam(c.knee, spec.kneeDb, smooth, now)
      setParam(c.attack, spec.attackMs / 1000, smooth, now)
      setParam(c.release, spec.releaseMs / 1000, smooth, now)
      break
    }
    case 'gain': {
      const g = node as GainNode
      setParam(g.gain, Math.pow(10, spec.gainDb / 20), smooth, now)
      break
    }
    case 'gate': {
      const w = node as AudioWorkletNode
      const threshold = w.parameters.get('threshold')
      if (threshold) setParam(threshold, Math.pow(10, spec.thresholdDb / 20), smooth, now)
      break
    }
  }
}

/** 用 OfflineAudioContext 渲染一段连续的原生节点（不含 gate） */
export async function renderNativeNodes(
  channels: Float32Array[],
  sampleRate: number,
  nodes: EffectNode[],
  onProgress?: (p: number) => void,
  signal?: AbortSignal
): Promise<Float32Array[]> {
  const native = nodes.filter((n) => n.kind !== 'gate')
  if (native.length === 0 || channels.length === 0 || channels[0].length === 0) {
    onProgress?.(1)
    return channels.map((c) => c.slice())
  }
  assertNotAborted(signal)
  const length = channels[0].length
  const ctx = new OfflineAudioContext(channels.length, length, sampleRate)
  const buffer = ctx.createBuffer(channels.length, length, sampleRate)
  channels.forEach((c, i) => buffer.copyToChannel(c, i))

  const src = ctx.createBufferSource()
  src.buffer = buffer
  let tail: AudioNode = src
  for (const spec of native) {
    const created = createEffectAudioNode(ctx, spec)
    if (!created) continue
    tail.connect(created)
    tail = created
  }
  tail.connect(ctx.destination)
  src.start()

  // OfflineAudioContext 支持按时间点挂起：用检查点上报真实渲染进度，
  // 长音频不再是「开始 → 一跳到 100%」。不支持 suspend 的浏览器自动忽略。
  const seconds = length / sampleRate
  const checkpoints = Math.min(32, Math.max(1, Math.ceil(seconds / 2)))
  try {
    for (let i = 1; i < checkpoints; i++) {
      const at = (i * seconds) / checkpoints
      void ctx
        .suspend(at)
        .then(() => {
          onProgress?.(i / checkpoints)
          void ctx.resume()
        })
        .catch(() => undefined)
    }
  } catch {
    /* 旧实现不支持 suspend，仍然照常渲染 */
  }

  const rendered = await abortable(ctx.startRendering(), signal)
  onProgress?.(1)
  const out: Float32Array[] = []
  for (let c = 0; c < channels.length; c++) out.push(rendered.getChannelData(c).slice())
  return out
}

export type ChainRun =
  | { type: 'native'; nodes: EffectNode[] }
  | { type: 'gate'; node: GateNode }

/** 以 gate 为界把链切成串行段，保持用户设定的处理顺序（纯函数，便于验证） */
export function splitChainRuns(specs: EffectNode[]): ChainRun[] {
  const runs: ChainRun[] = []
  let pending: EffectNode[] = []
  const flush = () => {
    if (pending.length > 0) {
      runs.push({ type: 'native', nodes: pending })
      pending = []
    }
  }
  for (const n of specs) {
    if (n.kind === 'gate') {
      flush()
      runs.push({ type: 'gate', node: n })
    } else {
      pending.push(n)
    }
  }
  flush()
  return runs
}

/**
 * 离线渲染整条效果链，返回与输入等长的新声道数据。
 * 输入会被复制，调用方可安全把 AudioBuffer 的视图传进来。
 */
export async function renderChain(
  channels: Float32Array[],
  sampleRate: number,
  specs: EffectNode[],
  onProgress?: (p: number) => void,
  signal?: AbortSignal
): Promise<Float32Array[]> {
  const active = specs.filter((n) => n.enabled)
  if (active.length === 0 || channels.length === 0 || channels[0].length === 0) {
    onProgress?.(100)
    return channels.map((c) => c.slice())
  }
  assertNotAborted(signal)

  const runs = splitChainRuns(active)
  let current = channels.map((c) => c.slice())
  for (let i = 0; i < runs.length; i++) {
    assertNotAborted(signal)
    const run = runs[i]
    const base = (i / runs.length) * 100
    const span = 100 / runs.length
    if (run.type === 'native') {
      current = await renderNativeNodes(
        current,
        sampleRate,
        run.nodes,
        (p) => onProgress?.(base + p * span),
        signal
      )
    } else {
      const work = runProcessTask<{ channels: Float32Array[] }>(
        { type: 'gate', channels: current, sampleRate, thresholdDb: run.node.thresholdDb },
        current.map((c) => c.buffer as ArrayBuffer),
        (p) => onProgress?.(base + (p / 100) * span)
      )
      current = (await abortable(work, signal)).channels
    }
    assertNotAborted(signal)
    onProgress?.(base + span)
  }
  onProgress?.(100)
  return current
}
