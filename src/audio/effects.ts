/**
 * 离线效果渲染（OfflineAudioContext）。
 * 注意：AudioContext / OfflineAudioContext 在主线程可用，但不可在 Web Worker 中使用，
 * 因此 EQ 与压缩在主线程离线渲染（渲染速度远快于实时）。
 */

export interface EffectSettings {
  /** 低切（高通）Hz，null = 关闭 */
  highPassHz: number | null
  /** 高切（低通）Hz，null = 关闭 */
  lowPassHz: number | null
  /** 动态压缩，null = 关闭 */
  compressor: { thresholdDb: number; ratio: number } | null
}

export function hasEnabledEffect(s: EffectSettings): boolean {
  return s.highPassHz !== null || s.lowPassHz !== null || s.compressor !== null
}

export async function renderEffects(
  channels: Float32Array[],
  sampleRate: number,
  settings: EffectSettings
): Promise<Float32Array[]> {
  const length = channels[0]?.length ?? 0
  if (length === 0 || !hasEnabledEffect(settings)) {
    return channels.map((c) => c.slice())
  }

  const ctx = new OfflineAudioContext(channels.length, length, sampleRate)
  const buffer = ctx.createBuffer(channels.length, length, sampleRate)
  channels.forEach((c, i) => buffer.copyToChannel(c, i))

  const src = ctx.createBufferSource()
  src.buffer = buffer

  let node: AudioNode = src
  if (settings.highPassHz !== null && settings.highPassHz > 0) {
    const f = ctx.createBiquadFilter()
    f.type = 'highpass'
    f.frequency.value = settings.highPassHz
    f.Q.value = 0.707
    node.connect(f)
    node = f
  }
  if (settings.lowPassHz !== null && settings.lowPassHz > 0) {
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.value = settings.lowPassHz
    f.Q.value = 0.707
    node.connect(f)
    node = f
  }
  if (settings.compressor) {
    const c = ctx.createDynamicsCompressor()
    c.threshold.value = settings.compressor.thresholdDb
    c.ratio.value = settings.compressor.ratio
    c.knee.value = 6
    c.attack.value = 0.005
    c.release.value = 0.25
    node.connect(c)
    node = c
  }
  node.connect(ctx.destination)

  src.start()
  const rendered = await ctx.startRendering()
  const out: Float32Array[] = []
  for (let c = 0; c < channels.length; c++) {
    out.push(rendered.getChannelData(c).slice())
  }
  return out
}
