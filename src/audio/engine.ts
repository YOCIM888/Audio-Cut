/**
 * AudioEngine —— 非响应式播放引擎单例。
 * AudioBuffer 与播放头时间均不进入 Vue 响应式系统，
 * 波形组件通过 rAF 直读 getPosition() 绘制播放头。
 */

export interface LoopRange {
  start: number
  end: number
}

class AudioEngine {
  private ctx: AudioContext | null = null
  private gainNode: GainNode | null = null
  private source: AudioBufferSourceNode | null = null
  private buffer: AudioBuffer | null = null
  private startedAt = 0
  private startOffset = 0
  private playing = false
  private loop = false
  private range: LoopRange | null = null
  private volumeValue = 0.9

  /** 自然播放结束回调（手动 stop 不触发） */
  onEnded: (() => void) | null = null

  ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext()
      this.gainNode = this.ctx.createGain()
      this.gainNode.gain.value = this.volumeValue
      this.gainNode.connect(this.ctx.destination)
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
  }

  play(from?: number): void {
    if (!this.buffer) return
    const ctx = this.ensureContext()
    this.stopSource()

    const dur = this.buffer.duration
    let offset = Math.min(Math.max(0, from ?? this.startOffset), Math.max(0, dur - 0.001))

    const src = ctx.createBufferSource()
    src.buffer = this.buffer
    src.connect(this.gainNode!)

    let durationArg: number | undefined
    if (this.loop) {
      src.loop = true
      if (this.range) {
        src.loopStart = this.range.start
        src.loopEnd = this.range.end
      }
    } else if (this.range) {
      if (offset >= this.range.end) offset = this.range.start
      durationArg = Math.max(0, this.range.end - offset)
    }

    src.onended = () => {
      if (this.source !== src) return
      this.source = null
      this.playing = false
      this.startOffset = this.range ? this.range.start : 0
      this.onEnded?.()
    }

    this.source = src
    this.startedAt = ctx.currentTime
    this.startOffset = offset
    this.playing = true
    if (durationArg !== undefined) src.start(0, offset, durationArg)
    else src.start(0, offset)
  }

  pause(): void {
    if (!this.playing) return
    this.startOffset = this.getPosition()
    this.stopSource()
    this.playing = false
  }

  stop(): void {
    this.stopSource()
    this.playing = false
    this.startOffset = this.range ? this.range.start : 0
  }

  seek(t: number): void {
    const clamped = Math.min(Math.max(0, t), this.duration)
    if (this.playing) this.play(clamped)
    else this.startOffset = clamped
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
      return ls + (elapsed % len)
    }
    return Math.min(dur, this.startOffset + elapsed)
  }

  setVolume(v: number): void {
    this.volumeValue = v
    if (this.gainNode && this.ctx) {
      this.gainNode.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02)
    }
  }

  setLoop(on: boolean): void {
    this.loop = on
  }

  /** 设置循环区间；播放中实时更新 loopStart/loopEnd */
  setRange(range: LoopRange | null): void {
    this.range = range
    if (this.source && this.playing && range) {
      this.source.loopStart = range.start
      this.source.loopEnd = range.end
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
