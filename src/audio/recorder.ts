/**
 * 麦克风录音：AudioWorklet 逐帧采集原始 Float32，不经过 MediaRecorder 的有损编码。
 *
 * 采集到的块在主线程拼接为 planar Float32Array[]，与项目内部音频表示完全一致，
 * 因此录音可以直接作为多轨片段插入，无需解码、无需二次转换。
 * 默认关闭浏览器三大件（回声消除 / 噪声抑制 / 自动增益），避免「修音」污染素材；
 * 也默认不把麦克风接回扬声器，防止啸叫。
 */

const PROCESSOR_NAME = 'yocim-recorder'

const WORKLET_SOURCE = `
class YocimRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.active = true
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'setActive') this.active = e.data.value !== false
    }
  }
  process(inputs) {
    const input = inputs[0]
    if (!this.active || !input || !input.length || !input[0] || !input[0].length) return true
    const frames = input[0].length
    const channels = new Array(input.length)
    let sum = 0
    let peak = 0
    let count = 0
    for (let c = 0; c < input.length; c++) {
      const copy = new Float32Array(frames)
      copy.set(input[c])
      channels[c] = copy
      for (let i = 0; i < frames; i++) {
        const v = copy[i]
        sum += v * v
        const a = v < 0 ? -v : v
        if (a > peak) peak = a
      }
      count += frames
    }
    this.port.postMessage(
      { type: 'chunk', channels, rms: Math.sqrt(sum / Math.max(1, count)), peak },
      channels.map((c) => c.buffer)
    )
    return true
  }
}
registerProcessor('${PROCESSOR_NAME}', YocimRecorderProcessor)
`

export interface RecordingResult {
  channels: Float32Array[]
  sampleRate: number
  duration: number
}

export interface RecorderLevel {
  rms: number
  peak: number
}

export interface StartOptions {
  deviceId?: string
  /** 想要的采样率；浏览器不支持时回落到设备默认 */
  sampleRate?: number
  /** 回声消除 / 噪声抑制 / 自动增益，默认全关 */
  processing?: boolean
  /** 是否把麦克风接到扬声器监听（可能啸叫，默认关） */
  monitor?: boolean
}

export class MicRecorder {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private node: AudioWorkletNode | ScriptProcessorNode | null = null
  private monitorGain: GainNode | null = null
  private workletUrl: string | null = null
  private chunks: Float32Array[][] = []
  private frames = 0
  private channelCount = 1
  private active = false
  private registered = false

  onLevel: ((level: RecorderLevel) => void) | null = null

  get isRecording(): boolean {
    return this.active
  }

  get elapsed(): number {
    return this.ctx ? this.frames / this.ctx.sampleRate : 0
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000
  }

  async start(opts: StartOptions = {}): Promise<void> {
    if (this.active) return
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('当前环境不支持麦克风采集（需要 HTTPS 或 localhost）')
    }
    const constraints: MediaStreamConstraints = {
      audio: {
        ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
        channelCount: { ideal: 2 },
        echoCancellation: opts.processing === true,
        noiseSuppression: opts.processing === true,
        autoGainControl: opts.processing === true
      },
      video: false
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints)
    } catch (err) {
      // 指定的设备可能已拔出，退回系统默认输入
      if (opts.deviceId) {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: opts.processing === true,
            noiseSuppression: opts.processing === true,
            autoGainControl: opts.processing === true
          }
        })
      } else {
        throw new Error(`无法访问麦克风：${err instanceof Error ? err.message : '权限被拒绝'}`)
      }
    }
    this.stream = stream

    let ctx: AudioContext
    try {
      ctx = new AudioContext(opts.sampleRate ? { sampleRate: opts.sampleRate } : undefined)
    } catch {
      ctx = new AudioContext()
    }
    this.ctx = ctx
    if (ctx.state === 'suspended') await ctx.resume()

    this.source = ctx.createMediaStreamSource(stream)
    this.channelCount = Math.min(2, Math.max(1, this.source.channelCount || stream.getAudioTracks()[0]?.getSettings().channelCount || 1))
    this.chunks = []
    this.frames = 0
    this.active = true

    const useWorklet = typeof ctx.audioWorklet !== 'undefined' && typeof AudioWorkletNode !== 'undefined'
    if (useWorklet) {
      try {
        if (!this.registered) {
          this.workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }))
          await ctx.audioWorklet.addModule(this.workletUrl)
          this.registered = true
        }
        const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [this.channelCount],
          channelCount: this.channelCount,
          channelCountMode: 'explicit'
        })
        node.port.onmessage = (e: MessageEvent) => {
          const data = e.data as { type?: string; channels?: Float32Array[]; rms?: number; peak?: number }
          if (data.type !== 'chunk' || !data.channels?.length) return
          this.pushChunk(data.channels)
          this.onLevel?.({ rms: data.rms ?? 0, peak: data.peak ?? 0 })
        }
        this.source.connect(node)
        // 不接 destination：AudioWorklet 只要被连到某处就会持续 process
        const silent = ctx.createGain()
        silent.gain.value = 0
        node.connect(silent)
        silent.connect(ctx.destination)
        if (opts.monitor) {
          this.monitorGain = ctx.createGain()
          this.monitorGain.gain.value = 0.6
          this.source.connect(this.monitorGain)
          this.monitorGain.connect(ctx.destination)
        }
        this.node = node
        return
      } catch (err) {
        console.warn('[recorder] AudioWorklet 不可用，改用兼容采集', err)
      }
    }

    // 兼容路径：ScriptProcessorNode（已废弃但仍广泛可用）
    const processor = ctx.createScriptProcessor(4096, this.channelCount, this.channelCount)
    processor.onaudioprocess = (e) => {
      if (!this.active) return
      const channels: Float32Array[] = []
      let sum = 0
      let peak = 0
      let count = 0
      for (let c = 0; c < e.inputBuffer.numberOfChannels; c++) {
        const input = e.inputBuffer.getChannelData(c)
        const copy = new Float32Array(input)
        channels.push(copy)
        for (let i = 0; i < copy.length; i++) {
          sum += copy[i] * copy[i]
          const a = Math.abs(copy[i])
          if (a > peak) peak = a
        }
        count += copy.length
      }
      this.pushChunk(channels)
      this.onLevel?.({ rms: Math.sqrt(sum / Math.max(1, count)), peak })
    }
    this.source.connect(processor)
    const silent = ctx.createGain()
    silent.gain.value = 0
    processor.connect(silent)
    silent.connect(ctx.destination)
    if (opts.monitor) {
      this.monitorGain = ctx.createGain()
      this.monitorGain.gain.value = 0.6
      this.source.connect(this.monitorGain)
      this.monitorGain.connect(ctx.destination)
    }
    this.node = processor
  }

  private pushChunk(channels: Float32Array[]): void {
    const n = Math.min(this.channelCount, channels.length)
    for (let c = 0; c < n; c++) {
      if (!this.chunks[c]) this.chunks[c] = []
      this.chunks[c].push(channels[c])
    }
    this.frames += channels[0]?.length ?? 0
  }

  /** 暂停采集但保留流；恢复后继续追加到同一段录音 */
  setActive(value: boolean): void {
    this.active = value
    if (typeof AudioWorkletNode !== 'undefined' && this.node instanceof AudioWorkletNode) {
      this.node.port.postMessage({ type: 'setActive', value })
    }
  }

  /** 结束录音并拼接为完整的 planar 声道数据 */
  stop(): RecordingResult {
    const rate = this.ctx?.sampleRate ?? 48000
    const channels: Float32Array[] = []
    const n = Math.max(1, this.chunks.length)
    for (let c = 0; c < n; c++) {
      const parts = this.chunks[c] ?? []
      const out = new Float32Array(parts.reduce((sum, p) => sum + p.length, 0))
      let pos = 0
      for (const p of parts) {
        out.set(p, pos)
        pos += p.length
      }
      channels.push(out)
    }
    const duration = (channels[0]?.length ?? 0) / rate
    this.dispose()
    return { channels: channels.length ? channels : [new Float32Array(0)], sampleRate: rate, duration }
  }

  dispose(): void {
    this.active = false
    try {
      this.source?.disconnect()
      this.node?.disconnect()
      this.monitorGain?.disconnect()
      if (typeof ScriptProcessorNode !== 'undefined' && this.node instanceof ScriptProcessorNode) {
        this.node.onaudioprocess = null
      }
    } catch {
      /* 已断开 */
    }
    this.stream?.getTracks().forEach((t) => t.stop())
    void this.ctx?.close().catch(() => undefined)
    if (this.workletUrl) {
      URL.revokeObjectURL(this.workletUrl)
      this.workletUrl = null
    }
    this.ctx = null
    this.stream = null
    this.source = null
    this.node = null
    this.monitorGain = null
    this.chunks = []
    this.registered = false
  }
}

export interface InputDevice {
  id: string
  label: string
}

/** 需要已获得麦克风权限才会返回真实标签；未授权时返回默认项 */
export async function listInputDevices(): Promise<InputDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  try {
    const list = await navigator.mediaDevices.enumerateDevices()
    return list
      .filter((d) => d.kind === 'audioinput')
      .map((d, i) => ({ id: d.deviceId, label: d.label || `麦克风 ${i + 1}` }))
  } catch {
    return []
  }
}
