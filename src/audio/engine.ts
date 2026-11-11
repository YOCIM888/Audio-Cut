/**
 * AudioEngine —— 非响应式播放引擎单例。
 * AudioBuffer 与播放头时间均不进入 Vue 响应式系统，
 * 波形组件通过 rAF 直读 getPosition() 绘制播放头。
 *
 * 效果链为非破坏性试听：source 同时馈入干路（原始）与湿路（效果节点图），
 * A/B 旁路只切换两个增益，链参数变化时只更新 AudioParam。
 */
import { chainActive, enabledNodes, type EffectChainState } from './effect-chain'
import { EffectGraph, ensureGateWorklet } from './effect-graph'

export interface LoopRange {
  start: number
  end: number
}

class AudioEngine {
  private ctx: AudioContext | null = null
  private gainNode: GainNode | null = null
  private dryGain: GainNode | null = null
  private wetGain: GainNode | null = null
  private fxInput: GainNode | null = null
  private graph: EffectGraph | null = null
  private source: AudioBufferSourceNode | null = null
  private buffer: AudioBuffer | null = null
  private startedAt = 0
  private startOffset = 0
  private playing = false
  private loop = false
  private range: LoopRange | null = null
  private volumeValue = 0.9

  private effectState: EffectChainState | null = null
  private effectRange: LoopRange | null = null
  private mixTimer: number | null = null
  private gateWorkletHooked = false
  private lastWet: boolean | null = null

  /** 自然播放结束回调（手动 stop 不触发） */
  onEnded: (() => void) | null = null
  /** AudioWorklet 不可用时通知 UI（门限仍会在导出/固化时生效） */
  onGateWorkletUnavailable: (() => void) | null = null

  ensureContext(): AudioContext {
    if (!this.ctx) {
      const ctx = new AudioContext()
      this.ctx = ctx
      this.gainNode = ctx.createGain()
      this.gainNode.gain.value = this.volumeValue
      this.gainNode.connect(ctx.destination)

      // 干路：原始音频；湿路：效果节点图。两条路都汇入主音量节点。
      this.dryGain = ctx.createGain()
      this.dryGain.gain.value = 1
      this.dryGain.connect(this.gainNode)
      this.wetGain = ctx.createGain()
      this.wetGain.gain.value = 0
      this.wetGain.connect(this.gainNode)
      this.fxInput = ctx.createGain()
      this.fxInput.gain.value = 1

      this.graph = new EffectGraph(ctx, this.fxInput, this.wetGain)
      this.graph.sync(this.effectState ? enabledNodes(this.effectState) : [])
      this.prepareGateWorklet()
      this.applyMix()
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    return this.ctx
  }

  get isPlaying(): boolean {
    return this.playing
  }

  get duration(): number {
    return this.buffer?.duration ?? 0
  }

  setBuffer(buffer: AudioBuffer | null): void {
    this.stopSource()
    this.buffer = buffer
    this.playing = false
    this.startOffset = 0
    this.syncMixTimer()
    this.applyMix()
  }

  /**
   * 由 store 的 watcher 调用：更新试听链与作用范围。
   * 旁路状态不参与图构建，切换 A/B 只动增益，因此无重建延迟。
   */
  setEffectChain(chain: EffectChainState | null, effectRange: LoopRange | null = null): void {
    this.effectState = chain
    this.effectRange = effectRange
    if (this.ctx && this.graph) {
      this.prepareGateWorklet()
      this.graph.sync(chain ? enabledNodes(chain) : [])
      this.applyMix()
    }
    this.syncMixTimer()
  }

  /** 门限节点依赖 AudioWorklet；只挂一次回调用来补建链路，避免每次参数拖动都重建 */
  private prepareGateWorklet(): void {
    const ctx = this.ctx
    if (!ctx || this.gateWorkletHooked) return
    if (!this.effectState?.nodes.some((n) => n.kind === 'gate' && n.enabled)) return
    this.gateWorkletHooked = true
    void ensureGateWorklet(ctx).then((ok) => {
      if (this.ctx !== ctx) return
      if (!ok) {
        this.onGateWorkletUnavailable?.()
        return
      }
      if (!this.graph) return
      this.graph.invalidate()
      this.graph.sync(this.effectState ? enabledNodes(this.effectState) : [])
    })
  }

  /** 干湿增益：旁路 / 无效果 / 播放头在选区外 → 纯干路 */
  private applyMix(): void {
    if (!this.ctx || !this.dryGain || !this.wetGain) return
    let wet = this.effectState ? chainActive(this.effectState) : false
    if (wet && this.effectRange) {
      const pos = this.getPosition()
      wet = pos >= this.effectRange.start && pos < this.effectRange.end
    }
    // 拖动滑杆会频繁触发 applyMix，目标值不变时不要往自动化时间线上堆事件
    if (this.lastWet === wet) return
    this.lastWet = wet
    const now = this.ctx.currentTime
    this.wetGain.gain.setTargetAtTime(wet ? 1 : 0, now, 0.008)
    this.dryGain.gain.setTargetAtTime(wet ? 0 : 1, now, 0.008)
  }

  /** 「仅选区」时按播放头位置实时切换干湿，比预排自动化更简单且天然兼容循环 */
  private syncMixTimer(): void {
    const need =
      this.playing && !!this.effectRange && !!this.effectState && chainActive(this.effectState)
    if (need && this.mixTimer === null) {
      this.mixTimer = window.setInterval(() => this.applyMix(), 20)
    } else if (!need && this.mixTimer !== null) {
      window.clearInterval(this.mixTimer)
      this.mixTimer = null
    }
  }

  play(from?: number): void {
    if (!this.buffer) return
    const ctx = this.ensureContext()
    this.stopSource()

    const dur = this.buffer.duration
    let offset = Math.min(Math.max(0, from ?? this.startOffset), Math.max(0, dur - 0.001))

    const src = ctx.createBufferSource()
    src.buffer = this.buffer
    src.connect(this.dryGain!)
    src.connect(this.fxInput!)

    // 仅循环模式下才把选区当作循环边界；普通播放不受选区限制
    if (this.loop) {
      src.loop = true
      if (this.range) {
        if (offset < this.range.start || offset >= this.range.end) offset = this.range.start
        src.loopStart = this.range.start
        src.loopEnd = this.range.end
      } else {
        src.loopStart = 0
        src.loopEnd = dur
      }
    }

    src.onended = () => {
      if (this.source !== src) return
      this.source = null
      this.playing = false
      this.startOffset = 0
      this.syncMixTimer()
      this.onEnded?.()
    }

    this.source = src
    this.startedAt = ctx.currentTime
    this.startOffset = offset
    this.playing = true
    this.applyMix()
    this.syncMixTimer()
    src.start(0, offset)
  }

  pause(): void {
    if (!this.playing) return
    this.startOffset = this.getPosition()
    this.stopSource()
    this.playing = false
    this.syncMixTimer()
  }

  stop(): void {
    this.stopSource()
    this.playing = false
    this.startOffset = 0
    this.syncMixTimer()
    this.applyMix()
  }

  seek(t: number): void {
    const clamped = Math.min(Math.max(0, t), this.duration)
    if (this.playing) this.play(clamped)
    else {
      this.startOffset = clamped
      this.applyMix()
    }
  }

  /** 当前播放头位置（秒）。暂停时返回记忆位置。 */
  getPosition(): number {
    if (!this.buffer) return 0
    if (!this.playing || !this.ctx) return this.startOffset
    const elapsed = this.ctx.currentTime - this.startedAt
    const dur = this.buffer.duration
    if (this.loop) {
      const ls = this.range ? this.range.start : 0
      const le = this.range ? this.range.end : dur
      const len = Math.max(1e-6, le - ls)
      const absolute = this.startOffset + elapsed
      // 起播点已在循环区间之后：不会回绕，只播放到音轨结尾
      if (this.startOffset >= le) return Math.min(dur, absolute)
      // 起播点可能在循环区间中段，先走到 loopEnd 再进入循环
      if (absolute <= le) return Math.min(absolute, dur)
      return ls + ((absolute - le) % len)
    }
    return Math.min(dur, this.startOffset + elapsed)
  }

  setVolume(v: number): void {
    this.volumeValue = v
    if (this.gainNode && this.ctx) {
      this.gainNode.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02)
    }
  }

  /** 播放中切换循环时，必须同步更新正在播放的 source，否则会继续按旧状态循环 */
  setLoop(on: boolean): void {
    this.loop = on
    if (this.source && this.playing) {
      this.source.loop = on
      this.source.loopStart = this.range ? this.range.start : 0
      this.source.loopEnd = this.range ? this.range.end : this.buffer?.duration ?? 0
    }
  }

  /** 设置循环区间；播放中实时更新 loopStart/loopEnd */
  setRange(range: LoopRange | null): void {
    this.range = range
    if (this.source && this.playing) {
      this.source.loopStart = range ? range.start : 0
      this.source.loopEnd = range ? range.end : this.buffer?.duration ?? 0
    }
  }

  private stopSource(): void {
    if (this.source) {
      const src = this.source
      this.source = null
      src.onended = null
      try {
        src.stop()
      } catch {
        /* 尚未 start 时 stop 会抛错，忽略 */
      }
      src.disconnect()
    }
  }
}

export const audioEngine = new AudioEngine()
