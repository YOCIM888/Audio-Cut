/**
 * 实时电平表：LUFS-M / LUFS-S / LUFS-I、RMS、采样峰值、4x 真峰值、削波计数。
 *
 * 优先用 AudioWorklet 在音频线程上逐采样计算 K 加权（与离线分析同一套系数），
 * 50ms 上报一次；浏览器不支持时降级为 AnalyserNode 抽样（标记为近似值）。
 * 电平取自「主音量之前」的干/湿汇流点，因此调小监听音量不会改变测量读数。
 */
import {
  biquadSample,
  createBiquadState,
  interpolationKernel,
  kWeightingCoeffs,
  type BiquadCoeffs
} from './loudness'

export interface MeterStats {
  momentaryLufs: number
  shortTermLufs: number
  integratedLufs: number
  rmsDb: number
  peakDb: number
  truePeakDb: number
  peakHoldDb: number
  clippedSamples: number
}

export const EMPTY_METER_STATS: MeterStats = {
  momentaryLufs: -Infinity,
  shortTermLufs: -Infinity,
  integratedLufs: -Infinity,
  rmsDb: -Infinity,
  peakDb: -Infinity,
  truePeakDb: -Infinity,
  peakHoldDb: -Infinity,
  clippedSamples: 0
}

export type MeterMode = 'worklet' | 'analyser' | 'unavailable'

export interface MeterHandle {
  mode: MeterMode
  reset(): void
  dispose(): void
}

const METER_WORKLET_SOURCE = `
class YocimMeterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.shelf = o.shelf;
    this.hp = o.hp;
    this.kernel = Float32Array.from(o.kernel || []);
    this.L = o.oversample || 4;
    this.H = o.half || 4;
    const sr = sampleRate;
    this.block = Math.max(1, Math.round(sr * 0.4));
    this.hop = Math.max(1, Math.round(sr * 0.1));
    this.postEvery = Math.max(1, Math.round(sr * 0.05));
    this.mRing = new Float64Array(this.block);
    this.shortRing = new Float64Array(30);
    this.blocks = [];
    this.states = [];
    this.hist = [];
    this.resetAll();
    this.port.onmessage = (e) => { if (e.data === 'reset') this.resetAll(); };
  }

  resetAll() {
    this.mRing.fill(0); this.mPos = 0; this.mFilled = 0; this.mSum = 0;
    this.hopCount = 0; this.blocks.length = 0;
    this.shortRing.fill(0); this.shortPos = 0; this.shortCount = 0; this.shortSum = 0;
    this.states = []; this.hist = [];
    this.resetCounters();
  }

  resetCounters() {
    this.rmsSum = 0; this.rmsCount = 0;
    this.peak = 0; this.tpRecent = 0; this.peakHold = 0;
    this.clips = 0; this.sincePost = 0;
  }

  bq(c, s, o, x) {
    const y = c.b0 * x + c.b1 * s[o] + c.b2 * s[o + 1] - c.a1 * s[o + 2] - c.a2 * s[o + 3];
    s[o + 1] = s[o]; s[o] = x;
    s[o + 3] = s[o + 2]; s[o + 2] = y;
    return y;
  }

  state(ch) {
    if (!this.states[ch]) this.states[ch] = new Float64Array(8);
    return this.states[ch];
  }

  histBuf(ch) {
    if (!this.hist[ch]) { this.hist[ch] = { data: new Float32Array(2 * this.H + 1), filled: 0 }; }
    return this.hist[ch];
  }

  pushHist(ch, x) {
    const b = this.histBuf(ch);
    const d = b.data;
    for (let i = 0; i < d.length - 1; i++) d[i] = d[i + 1];
    d[d.length - 1] = x;
    if (b.filled < d.length) b.filled++;
    if (b.filled < d.length) return;
    for (let p = 1; p < this.L; p++) {
      let y = 0;
      for (let k = -this.H; k <= this.H; k++) {
        y += d[this.H - k] * this.kernel[p + this.L * (k + this.H)];
      }
      const a = Math.abs(y);
      if (a > this.tpRecent) this.tpRecent = a;
    }
  }

  integrated() {
    const absT = Math.pow(10, (-70 + 0.691) / 10);
    let sum = 0, n = 0;
    for (let i = 0; i < this.blocks.length; i++) {
      const p = this.blocks[i];
      if (p > absT) { sum += p; n++; }
    }
    if (n === 0) return -Infinity;
    const rel = (sum / n) * 0.1;
    let s2 = 0, n2 = 0;
    for (let i = 0; i < this.blocks.length; i++) {
      const p = this.blocks[i];
      if (p > absT && p >= rel) { s2 += p; n2++; }
    }
    return n2 === 0 ? -Infinity : -0.691 + 10 * Math.log10(s2 / n2);
  }

  db(v) { return v <= 0 ? -Infinity : 20 * Math.log10(v); }

  process(inputs, outputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const n = input[0].length;
    const chCount = Math.min(2, input.length);
    for (let i = 0; i < n; i++) {
      let z = 0;
      for (let c = 0; c < chCount; c++) {
        const x = input[c][i] || 0;
        const a = Math.abs(x);
        if (a > this.peak) this.peak = a;
        if (a > this.peakHold) this.peakHold = a;
        if (a > 1.0000001) this.clips++;
        this.rmsSum += x * x; this.rmsCount++;
        const s = this.state(c);
        const y1 = this.bq(this.shelf, s, 0, x);
        const y2 = this.bq(this.hp, s, 4, y1);
        z += y2 * y2;
        this.pushHist(c, x);
      }
      this.mSum -= this.mRing[this.mPos];
      this.mRing[this.mPos] = z;
      this.mSum += z;
      this.mPos = (this.mPos + 1) % this.block;
      if (this.mFilled < this.block) this.mFilled++;
      this.hopCount++;
      if (this.hopCount >= this.hop) {
        this.hopCount = 0;
        if (this.mFilled === this.block) {
          const p = this.mSum / this.block;
          this.blocks.push(p);
          if (this.blocks.length > 36000) this.blocks.splice(0, 1000);
          this.shortSum -= this.shortRing[this.shortPos];
          this.shortRing[this.shortPos] = p;
          this.shortSum += p;
          this.shortPos = (this.shortPos + 1) % 30;
          if (this.shortCount < 30) this.shortCount++;
        }
      }
      this.sincePost++;
      if (this.sincePost >= this.postEvery) {
        const momentary = this.mFilled === this.block ? -0.691 + 10 * Math.log10(Math.max(1e-20, this.mSum / this.block)) : -Infinity;
        const shortTerm = this.shortCount > 0 ? -0.691 + 10 * Math.log10(Math.max(1e-20, this.shortSum / this.shortCount)) : momentary;
        this.port.postMessage({
          momentaryLufs: momentary,
          shortTermLufs: shortTerm,
          integratedLufs: this.integrated(),
          rmsDb: this.db(Math.sqrt(this.rmsSum / Math.max(1, this.rmsCount))),
          peakDb: this.db(this.peak),
          truePeakDb: this.db(this.tpRecent),
          peakHoldDb: this.db(this.peakHold),
          clippedSamples: this.clips
        });
        // 短暂窗口量每 50ms 重置；峰值保持与累计削波到 reset 为止
        this.rmsSum = 0; this.rmsCount = 0;
        this.peak = 0; this.tpRecent = 0;
        this.sincePost = 0;
      }
    }
    // 输出静音：该节点只为取信号，经 0 增益汇入 destination 保证被拉取
    const out = outputs[0];
    if (out) for (let c = 0; c < out.length; c++) out[c].fill(0);
    return true;
  }
}
registerProcessor('yocim-meter', YocimMeterProcessor);
`

const registered = new WeakMap<AudioContext, Promise<boolean>>()

function ensureMeterWorklet(ctx: AudioContext): Promise<boolean> {
  const cached = registered.get(ctx)
  if (cached) return cached
  if (!ctx.audioWorklet) return Promise.resolve(false)
  const url = URL.createObjectURL(new Blob([METER_WORKLET_SOURCE], { type: 'text/javascript' }))
  const task = ctx.audioWorklet
    .addModule(url)
    .then(() => true)
    .catch((err) => {
      console.warn('[meter] AudioWorklet 不可用，电平表降级为 AnalyserNode 抽样', err)
      return false
    })
    .finally(() => URL.revokeObjectURL(url))
  registered.set(ctx, task)
  return task
}

/** AnalyserNode 降级路径：在可获得的时域窗口上做同样的 K 加权，标注为近似 */
function createAnalyserMeter(
  ctx: AudioContext,
  source: AudioNode,
  onStats: (s: MeterStats) => void
): MeterHandle {
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 16384
  analyser.smoothingTimeConstant = 0
  const sink = ctx.createGain()
  sink.gain.value = 0
  source.connect(analyser)
  analyser.connect(sink)
  sink.connect(ctx.destination)
  const data = new Float32Array(analyser.fftSize)
  const k = kWeightingCoeffs(ctx.sampleRate)
  let peakHold = 0
  let clips = 0
  const timer = window.setInterval(() => {
    analyser.getFloatTimeDomainData(data)
    const s1 = createBiquadState()
    const s2 = createBiquadState()
    let sum = 0
    let weighted = 0
    let peak = 0
    for (let i = 0; i < data.length; i++) {
      const x = data[i]
      sum += x * x
      const a = Math.abs(x)
      if (a > peak) peak = a
      if (a > peakHold) peakHold = a
      if (a > 1.0000001) clips++
      const y = biquadSample(k.highpass, s2, biquadSample(k.shelf, s1, x))
      weighted += y * y
    }
    const rms = Math.sqrt(sum / data.length)
    const ms = weighted / data.length
    const lufs = -0.691 + 10 * Math.log10(Math.max(1e-20, ms))
    onStats({
      momentaryLufs: lufs,
      shortTermLufs: lufs,
      integratedLufs: -Infinity,
      rmsDb: 20 * Math.log10(Math.max(1e-20, rms)),
      peakDb: 20 * Math.log10(Math.max(1e-20, peak)),
      truePeakDb: 20 * Math.log10(Math.max(1e-20, peak)),
      peakHoldDb: 20 * Math.log10(Math.max(1e-20, peakHold)),
      clippedSamples: clips
    })
  }, 100)
  return {
    mode: 'analyser',
    reset() {
      peakHold = 0
      clips = 0
    },
    dispose() {
      window.clearInterval(timer)
      try {
        source.disconnect(analyser)
      } catch {
        /* noop */
      }
      analyser.disconnect()
      sink.disconnect()
    }
  }
}

export async function createRealtimeMeter(
  ctx: AudioContext,
  source: AudioNode,
  onStats: (s: MeterStats) => void
): Promise<MeterHandle> {
  if (await ensureMeterWorklet(ctx)) {
    try {
      const kernel = interpolationKernel()
      const k = kWeightingCoeffs(ctx.sampleRate)
      const node = new AudioWorkletNode(ctx, 'yocim-meter', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: {
          shelf: k.shelf as BiquadCoeffs,
          hp: k.highpass as BiquadCoeffs,
          kernel: kernel.h,
          oversample: kernel.oversample,
          half: kernel.half
        }
      })
      const sink = ctx.createGain()
      sink.gain.value = 0
      source.connect(node)
      node.connect(sink)
      sink.connect(ctx.destination)
      node.port.onmessage = (e: MessageEvent<MeterStats>) => onStats(e.data)
      node.port.start?.()
      return {
        mode: 'worklet',
        reset() {
          node.port.postMessage('reset')
        },
        dispose() {
          node.port.onmessage = null
          try {
            source.disconnect(node)
          } catch {
            /* noop */
          }
          node.disconnect()
          try {
            sink.disconnect()
          } catch {
            /* noop */
          }
          node.port.close()
        }
      }
    } catch (err) {
      console.warn('[meter] 创建 AudioWorkletNode 失败，降级', err)
    }
  }
  return createAnalyserMeter(ctx, source, onStats)
}

/** 供 UI 把 -Infinity / NaN 显示成占位符 */
export function formatDb(v: number, digits = 1): string {
  return Number.isFinite(v) ? v.toFixed(digits) : '—'
}
