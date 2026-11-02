/**
 * 音频处理 Worker：
 *  - time-stretch：WSOLA 变速不变调（或纯重采样变速）
 *  - merge：多轨合并，支持静音间隔 / 等功率交叉淡化
 */

const scope = self as unknown as Worker

interface TimeStretchRequest {
  type: 'time-stretch'
  channels: Float32Array[]
  sampleRate: number
  ratio: number
  keepPitch: boolean
}

interface MergeRequest {
  type: 'merge'
  clips: Float32Array[][]
  gapSeconds: number
  crossfadeSeconds: number
  sampleRate: number
}

type Request = TimeStretchRequest | MergeRequest

function postProgress(progress: number): void {
  scope.postMessage({ type: 'progress', progress })
}

/**
 * WSOLA：窗长 20ms，合成 hop = 窗长/2（50% 重叠），
 * 以声道 0 在 ±5ms 内稀疏互相关搜索最佳偏移，所有声道施加同一偏移，
 * 相邻帧线性交叠拼接。
 */
function wsola(channels: Float32Array[], sampleRate: number, ratio: number): Float32Array[] {
  const n = channels[0].length
  const chCount = channels.length
  if (n < Math.round(sampleRate * 0.06)) return channels.map((c) => c.slice())

  const win = Math.max(64, Math.round(sampleRate * 0.02))
  const hopSyn = Math.max(32, Math.round(win / 2))
  const hopAna = Math.max(1, Math.round(hopSyn * ratio))
  const delta = Math.max(1, Math.round(sampleRate * 0.005))
  const overlap = win - hopSyn
  const outLen = Math.ceil(n / ratio) + win * 2
  const out: Float32Array[] = channels.map(() => new Float32Array(outLen))
  const ref = channels[0]
  const corrStep = Math.max(1, Math.floor(win / 64))

  // 首窗直接拷贝
  const first = Math.min(win, n)
  for (let c = 0; c < chCount; c++) out[c].set(channels[c].subarray(0, first))

  let outPos = hopSyn
  let inStart = 0
  let filled = first

  while (outPos + win <= outLen) {
    const target = inStart + hopAna
    const lo = Math.max(0, target - delta)
    const hi = Math.min(n - win, target + delta)
    if (hi < lo) break

    let bestStart = Math.min(Math.max(target, lo), hi)
    const refStart = inStart + hopAna
    if (refStart + win <= n) {
      let bestCorr = -Infinity
      for (let cand = lo; cand <= hi; cand++) {
        let corr = 0
        for (let i = 0; i < win; i += corrStep) corr += ref[cand + i] * ref[refStart + i]
        if (corr > bestCorr) {
          bestCorr = corr
          bestStart = cand
        }
      }
    }

    for (let c = 0; c < chCount; c++) {
      const inp = channels[c]
      const o = out[c]
      for (let i = 0; i < overlap; i++) {
        const t = (i + 1) / (overlap + 1)
        o[outPos + i] = o[outPos + i] * (1 - t) + inp[bestStart + i] * t
      }
      o.set(inp.subarray(bestStart + overlap, bestStart + win), outPos + overlap)
    }

    inStart = bestStart
    outPos += hopSyn
    filled = outPos + overlap

    if ((outPos / hopSyn) % 50 === 0) {
      postProgress(Math.min(99, Math.round((inStart / n) * 100)))
    }
  }

  const finalLen = Math.min(filled, outLen)
  return out.map((o) => o.slice(0, finalLen))
}

/** 不保持音调：线性插值重采样变速 */
function resampleFast(channels: Float32Array[], ratio: number): Float32Array[] {
  const n = channels[0].length
  const outLen = Math.max(1, Math.floor(n / ratio))
  return channels.map((c) => {
    const out = new Float32Array(outLen)
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio
      const i0 = Math.floor(pos)
      const i1 = Math.min(n - 1, i0 + 1)
      const frac = pos - i0
      out[i] = c[i0] * (1 - frac) + c[i1] * frac
      if ((i & 0xffff) === 0) postProgress(Math.min(99, Math.round((i / outLen) * 100)))
    }
    return out
  })
}

/** 多轨合并：crossfadeSeconds > 0 时等功率交叉淡化，否则插入静音间隔 */
function merge(
  clips: Float32Array[][],
  gapSeconds: number,
  crossfadeSeconds: number,
  sampleRate: number
): Float32Array[] {
  const chCount = clips[0].length
  const cf = Math.max(0, Math.floor(crossfadeSeconds * sampleRate))
  const gap = Math.max(0, Math.floor(gapSeconds * sampleRate))

  let total = 0
  clips.forEach((clip, i) => {
    total += clip[0].length
    if (i > 0) total += cf > 0 ? -Math.min(cf, clip[0].length, clips[i - 1][0].length) : gap
  })
  total = Math.max(1, total)

  const out: Float32Array[] = Array.from({ length: chCount }, () => new Float32Array(total))
  let pos = 0

  clips.forEach((clip, idx) => {
    const len = clip[0].length
    if (idx === 0) {
      for (let c = 0; c < chCount; c++) out[c].set(clip[c] ?? new Float32Array(len), 0)
      pos = len
    } else if (cf > 0) {
      const overlap = Math.min(cf, len, pos)
      const start = pos - overlap
      for (let c = 0; c < chCount; c++) {
        const o = out[c]
        const src = clip[c] ?? new Float32Array(len)
        for (let j = 0; j < overlap; j++) {
          const t = (j + 1) / (overlap + 1)
          o[start + j] = o[start + j] * Math.cos((t * Math.PI) / 2) + src[j] * Math.sin((t * Math.PI) / 2)
        }
        o.set(src.subarray(overlap), start + overlap)
      }
      pos = start + len
    } else {
      pos += gap
      for (let c = 0; c < chCount; c++) out[c].set(clip[c] ?? new Float32Array(len), pos)
      pos += len
    }
    postProgress(Math.min(99, Math.round(((idx + 1) / clips.length) * 100)))
  })

  return out
}

scope.onmessage = (e: MessageEvent) => {
  try {
    const msg = e.data as Request
    let channels: Float32Array[]
    if (msg.type === 'time-stretch') {
      channels = msg.keepPitch
        ? wsola(msg.channels, msg.sampleRate, msg.ratio)
        : resampleFast(msg.channels, msg.ratio)
    } else {
      channels = merge(msg.clips, msg.gapSeconds, msg.crossfadeSeconds, msg.sampleRate)
    }
    postProgress(100)
    scope.postMessage({ type: 'done', data: { channels } }, channels.map((c) => c.buffer))
  } catch (err) {
    scope.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err)
    })
  }
}
