/** 纯 JS WAV 编码器：16/24-bit PCM 与 32-bit IEEE float，任意采样率/声道 */

export type WavBitDepth = 16 | 24 | 32

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
}

export function encodeWav(
  channels: Float32Array[],
  sampleRate: number,
  bitDepth: WavBitDepth
): ArrayBuffer {
  const numChannels = Math.max(1, channels.length)
  const numFrames = channels[0]?.length ?? 0
  const bytesPerSample = bitDepth / 8
  const blockAlign = numChannels * bytesPerSample
  const dataSize = numFrames * blockAlign
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, bitDepth === 32 ? 3 : 1, true) // 3 = IEEE float, 1 = PCM
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitDepth, true)
  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const raw = channels[ch][i]
      const s = Math.max(-1, Math.min(1, raw))
      if (bitDepth === 16) {
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
        offset += 2
      } else if (bitDepth === 24) {
        const v = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff)
        view.setUint8(offset, v & 0xff)
        view.setUint8(offset + 1, (v >> 8) & 0xff)
        view.setUint8(offset + 2, (v >> 16) & 0xff)
        offset += 3
      } else {
        view.setFloat32(offset, s, true)
        offset += 4
      }
    }
  }
  return buffer
}
