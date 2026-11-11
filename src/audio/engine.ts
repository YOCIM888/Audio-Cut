/**
 * AudioEngine —— 非响应式播放引擎单例。
 * AudioBuffer 与播放头时间均不进入 Vue 响应式系统，
 * 波形组件通过 rAF 直读 getPosition() 绘制播放头。
 *
 * 效果链为非破坏性试听：主轨源同时馈入干路（原始）与湿路（效果节点图），
 * A/B 旁路只切换两个增益，链参数变化时只更新 AudioParam。
 *
 * 多轨：主轨仍是 editor.buffer，其它轨道由若干 Clip 组成。每个 clip 独立
 * AudioBufferSourceNode → Gain（增益 / 淡变）→ StereoPanner → 汇流母线，
 * 按时间轴 start 提前或延后调度，因此不需要预先混音，拖动片段后立即生效。
 * 循环与结束判定统一交给 25ms 看门狗，让所有轨道共享同一条时间线。
 */
import { chainActive, enabledNodes, type EffectChainState } from './effect-chain'
import { EffectGraph, ensureGateWorklet } from './effect-graph'
import { createRealtimeMeter, type MeterHandle, type MeterMode, type MeterStats } from './meter'
import { channelsToAudioBuffer } from '../utils/audio-utils'
import type { ChainTarget, ScheduledClip } from './multitrack'

export interface LoopRange {
  start: number
  end: number
}

export interface TimelineSetup {
  clips: ScheduledClip[]
  /** 整条时间线时长（秒） */
  duration: number
  chainTarget: ChainTarget
  /** 主轨增益（线性）与声像 */
  mainGain: number
  mainPan: number
}

interface ClipNode {
  id: string
  source: AudioBufferSourceNode
  gain: GainNode
  panner: StereoPannerNode | null
}

class AudioEngine {
  private ctx: AudioContext | null = null
  private gainNode: GainNode | null = null
  private dryGain: GainNode | null = null
  private wetGain: GainNode | null = null
  private fxInput: GainNode | null = null
  private meterTap: GainNode | null = null
  private graph: EffectGraph | null = null
  /** 主轨输入（承载轨道增益 / 声像），永远接到干路与湿路 */
  private mainInput: GainNode | null = null
  private mainPanner: StereoPannerNode | null = null
  /** 其它轨道的汇流母线：chainTarget=main 时绕过效果链，mix 时改走干湿路 */
  private clipBus: GainNode | null = null
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

  private meterListeners = new Set<(s: MeterStats) => void>()
  private meterHandle: MeterHandle | null = null
  private meterMode: MeterMode = 'unavailable'
  private meterAttaching = false

  // ---- 多轨 ----
  private timeline: TimelineSetup = {
    clips: [],
    duration: 0,
    chainTarget: 'main',
    mainGain: 1,
    mainPan: 0
  }
  private clipNodes: ClipNode[] = []
  /** 按 clip id 缓存 AudioBuffer；片段采样不可变，剪切只改 offset/duration */
  private clipBuffers = new Map<string, AudioBuffer>()
  private tickTimer: number | null = null

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

      // 测量抽头取主音量之前的干/湿汇流，调监听音量不影响电平读数
      this.meterTap = ctx.createGain()
      this.meterTap.gain.value = 1
      this.dryGain.connect(this.meterTap)
      this.wetGain.connect(this.meterTap)

      this.mainInput = ctx.createGain()
      this.mainInput.gain.value = this.timeline.mainGain
      this.mainPanner = this.createPanner(ctx)
      if (this.mainPanner) {
        this.mainPanner.pan.value = this.timeline.mainPan
        this.mainInput.connect(this.mainPanner)
        this.mainPanner.connect(this.dryGain)
        this.mainPanner.connect(this.fxInput)
      } else {
        this.mainInput.connect(this.dryGain)
        this.mainInput.connect(this.fxInput)
      }

      this.clipBus = ctx.createGain()
      this.clipBus.gain.value = 1
      this.clipBus.connect(this.gainNode)
      this.clipBus.connect(this.meterTap)

      this.graph = new EffectGraph(ctx, this.fxInput, this.wetGain)
      this.graph.sync(this.effectState ? enabledNodes(this.effectState) : [])
      this.prepareGateWorklet()
      this.applyMix()
      void this.syncMeter()
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    return this.ctx
  }

  private createPanner(ctx: AudioContext): StereoPannerNode | null {
    return typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null
  }

  get isPlaying(): boolean {
    return this.playing
  }

  get duration(): number {
    return this.timelineDuration
  }

  private get timelineDuration(): number {
    return Math.max(this.buffer?.duration ?? 0, this.timeline.duration)
  }

  get hasClips(): boolean {
    return this.timeline.clips.length > 0
  }

  /** 订阅实时电平表；第一个订阅者会惰性创建 AudioWorklet，最后一个解除时释放 */
  addMeterListener(fn: (s: MeterStats) => void): () => void {
    this.meterListeners.add(fn)
    void this.syncMeter()
    return () => {
      this.meterListeners.delete(fn)
      void this.syncMeter()
    }
  }

  getMeterMode(): MeterMode {
    return this.meterMode
  }

  resetMeter(): void {
    this.meterHandle?.reset()
  }

  private async syncMeter(): Promise<void> {
    if (!this.ctx || !this.meterTap) return
    if (this.meterListeners.size === 0) {
      this.meterHandle?.dispose()
      this.meterHandle = null
      this.meterMode = 'unavailable'
      return
    }
    if (this.meterHandle || this.meterAttaching) return
    this.meterAttaching = true
    try {
      const handle = await createRealtimeMeter(this.ctx, this.meterTap, (s) => {
        for (const fn of this.meterListeners) fn(s)
      })
      // 订阅可能在异步注册期间被全部移除
      if (this.meterListeners.size === 0) {
        handle.dispose()
        this.meterMode = 'unavailable'
      } else {
        this.meterHandle = handle
        this.meterMode = handle.mode
      }
    } finally {
      this.meterAttaching = false
    }
  }

  /**
   * 由 store 的 watcher 调用：更新多轨布局。
   * restart=false 用于时间线拖动预览，避免每帧重建所有 source；
   * 拖动结束后 store 调一次 seek 重新调度即可。
   */
  setTimeline(setup: TimelineSetup, restart = true): void {
    this.timeline = setup
    const keep = new Set(setup.clips.map((c) => c.id))
    for (const id of this.clipBuffers.keys()) {
      if (!keep.has(id)) this.clipBuffers.delete(id)
    }
    if (this.ctx) {
      if (this.mainInput) this.mainInput.gain.value = setup.mainGain
      if (this.mainPanner) this.mainPanner.pan.value = setup.mainPan
    }
    if (restart && this.playing) this.play(this.getPosition())
    // restart=false 时保留当前已排程的片段，拖动结束后由 store 调 seek 重新调度
  }

  setBuffer(buffer: AudioBuffer | null): void {
    this.stopAllSources()
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

  private clipBuffer(clip: ScheduledClip): AudioBuffer {
    const cached = this.clipBuffers.get(clip.id)
    if (cached) return cached
    const buffer = channelsToAudioBuffer(clip.channels, clip.sampleRate)
    this.clipBuffers.set(clip.id, buffer)
    return buffer
  }

  /** 为所有未来会响的片段提前排程；起播点之前的片段跳过，中途的自动偏移 */
  private scheduleClips(ctx: AudioContext, pos: number, when: number): void {
    const viaChain = this.timeline.chainTarget === 'mix'
    const dry = this.dryGain!
    const fx = this.fxInput!
    const bus = this.clipBus!
    for (const clip of this.timeline.clips) {
      if (clip.start + clip.duration <= pos) continue
      const buffer = this.clipBuffer(clip)
      const delay = Math.max(0, clip.start - pos)
      const skip = Math.max(0, pos - clip.start)
      const srcOffset = Math.min(Math.max(0, clip.offset + skip), Math.max(0, buffer.duration - 0.001))
      const remain = Math.min(clip.duration - skip, Math.max(0, buffer.duration - srcOffset))
      if (remain <= 0.001) continue

      const src = ctx.createBufferSource()
      src.buffer = buffer
      const gain = ctx.createGain()
      const panner = this.createPanner(ctx)
      src.connect(gain)
      let tail: AudioNode = gain
      if (panner) {
        gain.connect(panner)
        panner.pan.value = clip.pan
        tail = panner
      }
      if (viaChain) {
        tail.connect(dry)
        tail.connect(fx)
      } else {
        tail.connect(bus)
      }

      const t0 = when + delay
      const fi = Math.min(Math.max(0, clip.fadeInMs / 1000), remain / 2)
      const fo = Math.min(Math.max(0, clip.fadeOutMs / 1000), remain / 2)
      gain.gain.setValueAtTime(fi > 0 ? 0 : clip.gain, t0)
      if (fi > 0) gain.gain.linearRampToValueAtTime(clip.gain, t0 + fi)
      if (fo > 0) {
        gain.gain.setValueAtTime(clip.gain, t0 + remain - fo)
        gain.gain.linearRampToValueAtTime(0, t0 + remain)
      } else {
        gain.gain.setValueAtTime(clip.gain, t0 + remain)
      }
      try {
        src.start(t0, srcOffset, remain)
      } catch {
        continue
      }
      this.clipNodes.push({ id: clip.id, source: src, gain, panner })
    }
  }

  play(from?: number): void {
    if (!this.buffer && this.timeline.clips.length === 0) return
    const ctx = this.ensureContext()
    this.stopAllSources()
    const total = this.timelineDuration
    if (total <= 0) return
    let offset = Math.min(Math.max(0, from ?? this.startOffset), Math.max(0, total - 0.001))
    const ls = this.loop ? (this.range?.start ?? 0) : 0
    const le = this.loop ? (this.range?.end ?? total) : total
    if (this.loop && (offset < ls || offset >= le)) offset = ls

    // 15ms 预排，避开主线程抖动造成的开头爆音
    const when = ctx.currentTime + 0.015
    if (this.buffer && offset < this.buffer.duration - 0.001) {
      const src = ctx.createBufferSource()
      src.buffer = this.buffer
      src.connect(this.mainInput!)
      src.start(when, offset)
      this.source = src
    }
    this.scheduleClips(ctx, offset, when)

    this.startedAt = when
    this.startOffset = offset
    this.playing = true
    this.applyMix()
    this.syncMixTimer()
    this.startTick()
  }

  /** 循环 / 结束统一由看门狗判定，所有轨道共享同一播放头 */
  private startTick(): void {
    this.stopTick()
    this.tickTimer = window.setInterval(() => this.tick(), 25)
  }

  private stopTick(): void {
    if (this.tickTimer !== null) {
      window.clearInterval(this.tickTimer)
      this.tickTimer = null
    }
  }

  private tick(): void {
    if (!this.playing || !this.ctx) return
    const ctxTime = this.ctx.currentTime
    if (ctxTime < this.startedAt) return
    const total = this.timelineDuration
    const ls = this.range?.start ?? 0
    const le = this.range?.end ?? total
    const p = this.getPosition()
    if (this.loop && le > ls) {
      if (p >= le - 0.02) this.play(ls)
      return
    }
    if (p >= total - 0.02) {
      this.stopAllSources()
      this.playing = false
      this.startOffset = 0
      this.stopTick()
      this.syncMixTimer()
      this.applyMix()
      this.onEnded?.()
    }
  }

  pause(): void {
    if (!this.playing) return
    this.startOffset = this.getPosition()
    this.stopAllSources()
    this.playing = false
    this.syncMixTimer()
  }

  stop(): void {
    this.stopAllSources()
    this.playing = false
    this.startOffset = 0
    this.syncMixTimer()
    this.applyMix()
  }

  seek(t: number): void {
    const clamped = Math.min(Math.max(0, t), this.timelineDuration)
    if (this.playing) this.play(clamped)
    else {
      this.startOffset = clamped
      this.applyMix()
    }
  }

  /** 当前播放头位置（秒）。暂停时返回记忆位置。 */
  getPosition(): number {
    if (!this.buffer && this.timeline.clips.length === 0) return 0
    if (!this.playing || !this.ctx) return this.startOffset
    const elapsed = Math.max(0, this.ctx.currentTime - this.startedAt)
    const dur = this.timelineDuration
    if (this.loop) {
      const ls = this.range ? this.range.start : 0
      const le = this.range ? this.range.end : dur
      const len = Math.max(1e-6, le - ls)
      const absolute = this.startOffset + elapsed
      if (this.startOffset >= le) return Math.min(dur, absolute)
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

  /** 循环切换由看门狗读取，无需改动正在播放的 source */
  setLoop(on: boolean): void {
    this.loop = on
  }

  setRange(range: LoopRange | null): void {
    this.range = range
  }

  private stopClipSources(): void {
    for (const node of this.clipNodes) {
      try {
        node.source.stop()
      } catch {
        /* 尚未 start 时 stop 会抛错 */
      }
      node.source.disconnect()
      node.gain.disconnect()
      node.panner?.disconnect()
    }
    this.clipNodes = []
  }

  private stopAllSources(): void {
    this.stopTick()
    if (this.source) {
      const src = this.source
      this.source = null
      try {
        src.stop()
      } catch {
        /* 尚未 start 时 stop 会抛错 */
      }
      src.disconnect()
    }
    this.stopClipSources()
  }
}

export const audioEngine = new AudioEngine()
