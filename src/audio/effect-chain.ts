/**
 * 非破坏性效果链的数据模型。
 *
 * 这里只保存「指令」，不保存任何音频数据：所有节点都是可 JSON 序列化的扁平对象，
 * 因此可以低成本进入撤销栈、写进工程文件、并在导出时按当前参数重新渲染。
 * 同一份链有两条执行路径：
 *   - 实时试听：Web Audio 节点图（见 effect-graph.ts），参数改动立即生效；
 *   - 导出 / 固化：离线渲染（见 effects.ts），保证结果与试听一致但精确到采样。
 */

export type EffectKind = 'highpass' | 'lowpass' | 'peaking' | 'compressor' | 'gain' | 'gate'

interface NodeBase {
  id: string
  enabled: boolean
}

export interface HighPassNode extends NodeBase {
  kind: 'highpass'
  hz: number
  q: number
}
export interface LowPassNode extends NodeBase {
  kind: 'lowpass'
  hz: number
  q: number
}
export interface PeakingNode extends NodeBase {
  kind: 'peaking'
  hz: number
  gainDb: number
  q: number
}
export interface CompressorNode extends NodeBase {
  kind: 'compressor'
  thresholdDb: number
  ratio: number
  kneeDb: number
  attackMs: number
  releaseMs: number
}
export interface GainNodeSpec extends NodeBase {
  kind: 'gain'
  gainDb: number
}
export interface GateNode extends NodeBase {
  kind: 'gate'
  thresholdDb: number
}

export type EffectNode =
  | HighPassNode
  | LowPassNode
  | PeakingNode
  | CompressorNode
  | GainNodeSpec
  | GateNode

export interface EffectChainState {
  /** true = 旁路整条链，听原始音频（A/B 对比的 A） */
  bypass: boolean
  /** 效果作用范围：全曲或仅选区 */
  scope: 'all' | 'selection'
  nodes: EffectNode[]
}

export interface EffectMeta {
  label: string
  short: string
  hint: string
}

export const EFFECT_META: Record<EffectKind, EffectMeta> = {
  highpass: { label: '低切 / 高通', short: 'HP', hint: '滤除低频隆隆声与风噪' },
  lowpass: { label: '高切 / 低通', short: 'LP', hint: '滤除高频嘶声' },
  peaking: { label: '参数 EQ', short: 'EQ', hint: '提升或衰减指定频段' },
  compressor: { label: '动态压缩', short: 'COMP', hint: '收窄动态范围' },
  gain: { label: '增益', short: 'GAIN', hint: '整体电平增减（dB）' },
  gate: { label: '门限降噪', short: 'GATE', hint: '低于阈值的段落自动淡出' }
}

export const EFFECT_KINDS = Object.keys(EFFECT_META) as EffectKind[]

let idCounter = 0
function newId(): string {
  idCounter += 1
  return `fx-${Date.now().toString(36)}-${idCounter.toString(36)}`
}

export function createNode(kind: EffectKind): EffectNode {
  const base = { id: newId(), enabled: true }
  switch (kind) {
    case 'highpass':
      return { ...base, kind, hz: 80, q: 0.707 }
    case 'lowpass':
      return { ...base, kind, hz: 12000, q: 0.707 }
    case 'peaking':
      return { ...base, kind, hz: 3000, gainDb: 3, q: 1 }
    case 'compressor':
      return { ...base, kind, thresholdDb: -24, ratio: 4, kneeDb: 6, attackMs: 5, releaseMs: 250 }
    case 'gain':
      return { ...base, kind, gainDb: 0 }
    case 'gate':
      return { ...base, kind, thresholdDb: -45 }
  }
}

export function createDefaultChain(): EffectChainState {
  return { bypass: false, scope: 'all', nodes: [] }
}

/** 节点是扁平对象，浅拷贝即可安全隔离撤销栈 */
export function cloneChain(chain: EffectChainState): EffectChainState {
  return {
    bypass: chain.bypass,
    scope: chain.scope,
    nodes: chain.nodes.map((n) => ({ ...n }))
  }
}

export function chainSignature(chain: EffectChainState): string {
  return JSON.stringify(chain)
}

/** 忽略 bypass，供实时节点图使用：旁路只切换干湿增益，不需要重建节点 */
export function enabledNodes(chain: EffectChainState): EffectNode[] {
  return chain.nodes.filter((n) => n.enabled)
}

export function chainActive(chain: EffectChainState): boolean {
  return !chain.bypass && chain.nodes.some((n) => n.enabled)
}

export function activeCount(chain: EffectChainState): number {
  return enabledNodes(chain).length
}

// ---- 参数规格：UI 与校验共用，避免在模板里做联合类型窄化 ----

export interface ParamSpec {
  key: string
  label: string
  min: number
  max: number
  step: number
  value: number
  unit: string
  digits: number
}

function p(
  key: string,
  label: string,
  min: number,
  max: number,
  step: number,
  value: number,
  unit: string,
  digits = 0
): ParamSpec {
  return { key, label, min, max, step, value, unit, digits }
}

export function paramSpecs(node: EffectNode): ParamSpec[] {
  switch (node.kind) {
    case 'highpass':
      return [
        p('hz', '截止频率', 20, 1000, 10, node.hz, 'Hz'),
        p('q', 'Q 值', 0.3, 3, 0.1, node.q, '', 2)
      ]
    case 'lowpass':
      return [
        p('hz', '截止频率', 1000, 20000, 100, node.hz, 'Hz'),
        p('q', 'Q 值', 0.3, 3, 0.1, node.q, '', 2)
      ]
    case 'peaking':
      return [
        p('hz', '中心频率', 20, 20000, 10, node.hz, 'Hz'),
        p('gainDb', '增益', -18, 18, 0.5, node.gainDb, 'dB', 1),
        p('q', '带宽 Q', 0.3, 8, 0.1, node.q, '', 2)
      ]
    case 'compressor':
      return [
        p('thresholdDb', '阈值', -60, 0, 1, node.thresholdDb, 'dB'),
        p('ratio', '压缩比', 1, 20, 0.5, node.ratio, ':1', 1),
        p('kneeDb', '拐点', 0, 30, 1, node.kneeDb, 'dB'),
        p('attackMs', '启动', 1, 100, 1, node.attackMs, 'ms'),
        p('releaseMs', '释放', 20, 1000, 10, node.releaseMs, 'ms')
      ]
    case 'gain':
      return [p('gainDb', '增益', -24, 24, 0.5, node.gainDb, 'dB', 1)]
    case 'gate':
      return [p('thresholdDb', '阈值', -80, -20, 1, node.thresholdDb, 'dB')]
  }
}

/** 把用户输入写回节点，自动按规格裁剪范围，避免脏参数进入 Web Audio */
export function applyParamPatch(node: EffectNode, patch: Record<string, number | boolean>): EffectNode {
  const next = { ...node } as unknown as Record<string, number | boolean>
  const allowed = new Set(paramSpecs(node).map((s) => s.key))
  for (const [key, raw] of Object.entries(patch)) {
    if (key === 'enabled') {
      next.enabled = Boolean(raw)
      continue
    }
    if (!allowed.has(key) || typeof raw !== 'number' || !Number.isFinite(raw)) continue
    const spec = paramSpecs(node).find((s) => s.key === key)!
    next[key] = Math.min(spec.max, Math.max(spec.min, raw))
  }
  return next as unknown as EffectNode
}

// ---- 预设 ----

export interface ChainPreset {
  name: string
  hint: string
  build: () => EffectChainState
}

function chain(nodes: EffectNode[], scope: 'all' | 'selection' = 'all'): EffectChainState {
  return { bypass: false, scope, nodes }
}

export const CHAIN_PRESETS: ChainPreset[] = [
  {
    name: '人声清理',
    hint: '低切 80Hz → 压缩 3:1 → 门限 -45dB',
    build: () =>
      chain([
        createNode('highpass'),
        { ...createNode('compressor'), ratio: 3, thresholdDb: -20 } as CompressorNode,
        createNode('gate')
      ])
  },
  {
    name: '播客响度',
    hint: '提亮 3kHz → 压缩 4:1 → 补增益',
    build: () =>
      chain([
        { ...createNode('highpass'), hz: 90 } as HighPassNode,
        { ...createNode('peaking'), hz: 3000, gainDb: 2.5 } as PeakingNode,
        createNode('compressor'),
        { ...createNode('gain'), gainDb: -2 } as GainNodeSpec
      ])
  },
  {
    name: '电话音',
    hint: '300Hz ~ 3.4kHz 带通',
    build: () =>
      chain([
        { ...createNode('highpass'), hz: 300 } as HighPassNode,
        { ...createNode('lowpass'), hz: 3400 } as LowPassNode
      ])
  },
  {
    name: '低音增强',
    hint: '100Hz +4dB → 轻压缩',
    build: () =>
      chain([
        { ...createNode('peaking'), hz: 100, gainDb: 4, q: 0.8 } as PeakingNode,
        { ...createNode('compressor'), thresholdDb: -12, ratio: 2 } as CompressorNode
      ])
  }
]

/**
 * 工程文件 / 外部输入的安全解析：逐字段校验并裁剪，任何异常都退回默认空链，
 * 绝不把不可信数据直接送进 Web Audio（例如 NaN 频率会让滤波器抛错）。
 */
export function sanitizeChain(raw: unknown): EffectChainState {
  const fallback = createDefaultChain()
  if (!raw || typeof raw !== 'object') return fallback
  const obj = raw as Record<string, unknown>
  if (!Array.isArray(obj.nodes)) return fallback
  const nodes: EffectNode[] = []
  for (const item of obj.nodes.slice(0, 24)) {
    if (!item || typeof item !== 'object') continue
    const n = item as Record<string, unknown>
    if (typeof n.kind !== 'string' || !(n.kind in EFFECT_META)) continue
    const base = createNode(n.kind as EffectKind)
    const merged = applyParamPatch(base, n as Record<string, number | boolean>)
    merged.id = typeof n.id === 'string' && n.id.length < 64 ? n.id : base.id
    merged.enabled = n.enabled !== false
    nodes.push(merged)
  }
  return {
    bypass: obj.bypass === true,
    scope: obj.scope === 'selection' ? 'selection' : 'all',
    nodes
  }
}
