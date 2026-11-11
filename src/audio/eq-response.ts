/**
 * Web Audio BiquadFilterNode 的频率响应计算（与规范中的系数公式一致）。
 * EffectsPanel 的 EQ 曲线用它把整条效果链里的滤波节点叠加成一条合成响应，
 * 因此曲线显示的就是实际试听/导出时听到的均衡形状。
 */
import type { EffectNode } from './effect-chain'

export interface FilterCoeffs {
  b0: number
  b1: number
  b2: number
  a0: number
  a1: number
  a2: number
}

export type FilterType = 'lowpass' | 'highpass' | 'peaking' | 'lowshelf' | 'highshelf'

/** 按 Web Audio 规范计算双二阶系数（未归一化，保留 a0） */
export function biquadCoeffs(
  type: FilterType,
  sampleRate: number,
  freq: number,
  q: number,
  gainDb: number
): FilterCoeffs {
  const w0 = (2 * Math.PI * Math.max(1, Math.min(sampleRate / 2 - 1, freq))) / sampleRate
  const cw = Math.cos(w0)
  const sw = Math.sin(w0)
  const Q = Math.max(0.0001, q)
  const A = Math.pow(10, gainDb / 40)
  const rootA = Math.sqrt(A)

  if (type === 'lowpass' || type === 'highpass') {
    const alpha = sw / (2 * Q)
    const a0 = 1 + alpha
    const a1 = -2 * cw
    const a2 = 1 - alpha
    if (type === 'lowpass') {
      const b0 = (1 - cw) / 2
      return { b0, b1: 1 - cw, b2: b0, a0, a1, a2 }
    }
    const b0 = (1 + cw) / 2
    return { b0, b1: -(1 + cw), b2: b0, a0, a1, a2 }
  }

  if (type === 'peaking') {
    const alpha = sw / (2 * Q)
    return {
      b0: 1 + alpha * A,
      b1: -2 * cw,
      b2: 1 - alpha * A,
      a0: 1 + alpha / A,
      a1: -2 * cw,
      a2: 1 - alpha / A
    }
  }

  // shelving：Web Audio 用 S = 1，alpha = sin(w0)/2 * sqrt((A + 1/A)(1/S - 1) + 2)
  const alpha = (sw / 2) * Math.sqrt((A + 1 / A) * (1 / 1 - 1) + 2)
  const twoRootAlpha = 2 * rootA * alpha
  if (type === 'lowshelf') {
    return {
      b0: A * (A + 1 - (A - 1) * cw + twoRootAlpha),
      b1: 2 * A * (A - 1 - (A + 1) * cw),
      b2: A * (A + 1 - (A - 1) * cw - twoRootAlpha),
      a0: A + 1 + (A - 1) * cw + twoRootAlpha,
      a1: -2 * (A - 1 + (A + 1) * cw),
      a2: A + 1 + (A - 1) * cw - twoRootAlpha
    }
  }
  return {
    b0: A * (A + 1 + (A - 1) * cw + twoRootAlpha),
    b1: -2 * A * (A - 1 + (A + 1) * cw),
    b2: A * (A + 1 + (A - 1) * cw - twoRootAlpha),
    a0: A + 1 - (A - 1) * cw + twoRootAlpha,
    a1: 2 * (A - 1 - (A + 1) * cw),
    a2: A + 1 - (A - 1) * cw - twoRootAlpha
  }
}

/** 单个双二阶在 freq 处的幅度响应（dB） */
export function biquadMagnitudeDb(c: FilterCoeffs, freq: number, sampleRate: number): number {
  const w = (2 * Math.PI * freq) / sampleRate
  const c1 = Math.cos(w)
  const s1 = Math.sin(w)
  const c2 = Math.cos(2 * w)
  const s2 = Math.sin(2 * w)
  const nr = c.b0 + c.b1 * c1 + c.b2 * c2
  const ni = -(c.b1 * s1 + c.b2 * s2)
  const dr = c.a0 + c.a1 * c1 + c.a2 * c2
  const di = -(c.a1 * s1 + c.a2 * s2)
  const num = nr * nr + ni * ni
  const den = dr * dr + di * di
  return den <= 0 ? 0 : 10 * Math.log10(Math.max(1e-20, num / den))
}

export interface EqBandPoint {
  id: string
  kind: FilterType
  freq: number
  q: number
  gainDb: number
  label: string
}

/** 从效果链抽出「已启用」的滤波节点，作为可拖拽的 EQ 控制点与合成频响的输入 */
export function eqBandsFromChain(nodes: EffectNode[]): EqBandPoint[] {
  const out: EqBandPoint[] = []
  for (const n of nodes) {
    if (!n.enabled) continue
    switch (n.kind) {
      case 'highpass':
        out.push({ id: n.id, kind: 'highpass', freq: n.hz, q: n.q, gainDb: 0, label: 'HP' })
        break
      case 'lowpass':
        out.push({ id: n.id, kind: 'lowpass', freq: n.hz, q: n.q, gainDb: 0, label: 'LP' })
        break
      case 'peaking':
        out.push({ id: n.id, kind: 'peaking', freq: n.hz, q: n.q, gainDb: n.gainDb, label: 'EQ' })
        break
      case 'lowshelf':
        out.push({ id: n.id, kind: 'lowshelf', freq: n.hz, q: n.q, gainDb: n.gainDb, label: 'LS' })
        break
      case 'highshelf':
        out.push({ id: n.id, kind: 'highshelf', freq: n.hz, q: n.q, gainDb: n.gainDb, label: 'HS' })
        break
    }
  }
  return out
}

export interface EqCurveOptions {
  sampleRate: number
  points?: number
  minFreq?: number
  maxFreq?: number
}

/** 合成响应：逐频点把各滤波器 dB 相加（级联等价于幅频相乘） */
export function compositeEqCurve(
  nodes: EffectNode[],
  options: EqCurveOptions
): { freqs: Float32Array; db: Float32Array } {
  const count = Math.max(16, options.points ?? 180)
  const minFreq = options.minFreq ?? 20
  const maxFreq = Math.min(options.maxFreq ?? 20000, options.sampleRate / 2)
  const freqs = new Float32Array(count)
  const db = new Float32Array(count)
  const coeffs = eqBandsFromChain(nodes).map((b) =>
    biquadCoeffs(b.kind, options.sampleRate, b.freq, b.q, b.gainDb)
  )
  const ratio = maxFreq / minFreq
  for (let i = 0; i < count; i++) {
    const f = minFreq * Math.pow(ratio, i / (count - 1))
    freqs[i] = f
    let sum = 0
    for (const c of coeffs) sum += biquadMagnitudeDb(c, f, options.sampleRate)
    db[i] = sum
  }
  return { freqs, db }
}
