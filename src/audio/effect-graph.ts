/**
 * 实时试听用的效果节点图 + 门限 AudioWorklet。
 *
 * 图结构（engine.ts 持有首尾两个增益节点）：
 *
 *   source ─┬─> dryGain ──────────────────────────────┐
 *           └─> fxInput ─> [效果节点…] ─> wetGain ─────┴─> masterGain ─> destination
 *
 * A/B 旁路只切换 dryGain / wetGain 的增益，不重建节点，所以切换无爆音、无延迟。
 * 参数拖动时只更新 AudioParam；只有增删/排序节点才重建内部链路。
 */
import { createEffectAudioNode, updateEffectAudioNode } from './effects'
import type { EffectNode } from './effect-chain'

/**
 * 与 workers/audio-process.worker.ts 中 gate() 完全相同的包络跟随算法，
 * 保证「实时试听」和「导出渲染」听感一致。以 Blob URL 加载，不依赖部署路径。
 */
const GATE_WORKLET_SOURCE = `
class YocimGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'threshold', defaultValue: 0.0056, minValue: 0, maxValue: 2, automationRate: 'k-rate' }];
  }
  constructor() {
    super();
    this.env = 0;
    this.gain = 0;
    this.envDecay = Math.exp(-1 / (sampleRate * 0.015));
    this.openCoef = Math.exp(-1 / (sampleRate * 0.005));
    this.closeCoef = Math.exp(-1 / (sampleRate * 0.040));
  }
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0 || !output || output.length === 0) return true;
    const n = output[0].length;
    const tp = parameters.threshold;
    const threshold = tp && tp.length ? tp[0] : 0.0056;
    const inCh = input.length;
    const outCh = output.length;
    for (let i = 0; i < n; i++) {
      let peak = 0;
      for (let c = 0; c < inCh; c++) {
        const ch = input[c];
        const v = ch && i < ch.length ? Math.abs(ch[i]) : 0;
        if (v > peak) peak = v;
      }
      this.env = peak > this.env ? peak : this.env * this.envDecay;
      const target = this.env >= threshold ? 1 : 0;
      const coef = target > this.gain ? this.openCoef : this.closeCoef;
      this.gain = target + (this.gain - target) * coef;
      for (let c = 0; c < outCh; c++) {
        const src = input[Math.min(c, inCh - 1)];
        output[c][i] = (src && i < src.length ? src[i] : 0) * this.gain;
      }
    }
    return true;
  }
}
registerProcessor('yocim-gate', YocimGateProcessor);
`

const loaded = new WeakMap<AudioContext, Promise<boolean>>()
const ready = new WeakSet<AudioContext>()

/** 幂等：每个 AudioContext 只注册一次；失败返回 false，由调用方降级跳过门限 */
export function ensureGateWorklet(ctx: AudioContext): Promise<boolean> {
  const cached = loaded.get(ctx)
  if (cached) return cached
  if (!ctx.audioWorklet) return Promise.resolve(false)
  const url = URL.createObjectURL(new Blob([GATE_WORKLET_SOURCE], { type: 'text/javascript' }))
  const task = ctx.audioWorklet
    .addModule(url)
    .then(() => {
      ready.add(ctx)
      return true
    })
    .catch((err) => {
      console.warn('[effect-graph] AudioWorklet 门限不可用，实时试听将跳过该节点', err)
      return false
    })
    .finally(() => URL.revokeObjectURL(url))
  loaded.set(ctx, task)
  return task
}

export function isGateWorkletReady(ctx: AudioContext): boolean {
  return ready.has(ctx)
}

function createGateNode(ctx: AudioContext): AudioWorkletNode {
  return new AudioWorkletNode(ctx, 'yocim-gate', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers'
  })
}

/** 管理 fxInput → … → wetGain 之间的内部链路 */
export class EffectGraph {
  private nodes: AudioNode[] = []
  /** 与 nodes 一一对应的规格；节点创建失败时可能比入参短 */
  private applied: EffectNode[] = []
  /** 上次请求的节点序列签名。用「请求」而非「实际建成」比较，避免创建失败时反复重建 */
  private requestedSig: string | null = null

  constructor(
    private ctx: AudioContext,
    private input: GainNode,
    private output: GainNode
  ) {}

  /** 若节点序列未变则只热更新参数，避免拖动滑杆时不断断开重连产生爆音 */
  sync(specs: EffectNode[]): void {
    const usable = specs.filter((n) => n.kind !== 'gate' || isGateWorkletReady(this.ctx))
    const signature = usable.map((n) => `${n.id}:${n.kind}`).join('|')
    if (signature !== this.requestedSig) {
      this.requestedSig = signature
      this.rebuild(usable)
      return
    }
    // 参数热更新必须用本次传入的规格；按 id 配对，容忍个别节点创建失败造成的错位
    const now = this.ctx.currentTime
    for (let i = 0; i < this.nodes.length; i++) {
      const spec = usable.find((n) => n.id === this.applied[i].id)
      if (!spec) continue
      this.applied[i] = { ...spec }
      updateEffectAudioNode(this.nodes[i], this.applied[i], true, now)
    }
  }

  /** worklet 异步就绪后强制重建，把此前跳过的 gate 节点补进链路 */
  invalidate(): void {
    this.dispose()
  }

  private rebuild(usable: EffectNode[]): void {
    try {
      this.input.disconnect()
    } catch {
      /* 尚未连接 */
    }
    for (const n of this.nodes) {
      try {
        n.disconnect()
      } catch {
        /* 已断开 */
      }
    }
    this.nodes = []
    this.applied = []

    let tail: AudioNode = this.input
    for (const spec of usable) {
      let created: AudioNode | null
      if (spec.kind === 'gate') {
        try {
          created = createGateNode(this.ctx)
        } catch (err) {
          console.warn('[effect-graph] 创建门限节点失败', err)
          created = null
        }
      } else {
        created = createEffectAudioNode(this.ctx, spec)
      }
      if (!created) continue
      tail.connect(created)
      tail = created
      this.nodes.push(created)
      this.applied.push({ ...spec })
    }
    tail.connect(this.output)
    for (let i = 0; i < this.nodes.length; i++) {
      updateEffectAudioNode(this.nodes[i], this.applied[i], false, 0)
    }
  }

  dispose(): void {
    try {
      this.input.disconnect()
    } catch {
      /* noop */
    }
    for (const n of this.nodes) {
      try {
        n.disconnect()
      } catch {
        /* noop */
      }
    }
    this.nodes = []
    this.applied = []
    this.requestedSig = null
  }
}
