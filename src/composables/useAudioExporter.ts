/**
 * 音频导出编排：
 *  - WAV：纯 JS 编码（16/24/32-bit）
 *  - MP3：lamejs Worker 分块编码
 *  - WebM / OGG：MediaRecorder 实时录制 + MIME 动态降级探测
 */
import { useEditorStore } from '../stores/editor'
import { useToastStore } from '../stores/toast'
import { encodeWav, type WavBitDepth } from '../utils/wav-encoder'
import {
  convertChannels,
  getAllChannels,
  resampleChannels,
  sliceChannels
} from '../utils/audio-utils'
import { runWorkerTask } from '../utils/worker-client'

export type ExportFormat = 'wav' | 'webm' | 'ogg' | 'mp3'

export interface ExportOptions {
  format: ExportFormat
  sampleRate: number | null
  bitDepth: WavBitDepth
  channels: 'keep' | 'mono' | 'stereo'
  bitrate: number
  range: 'all' | 'selection'
  fileName: string
}

let mp3Worker: Worker | null = null
function getMp3Worker(): Worker {
  if (!mp3Worker) {
    mp3Worker = new Worker(new URL('../workers/mp3-encoder.worker.ts', import.meta.url), {
      type: 'module'
    })
  }
  return mp3Worker
}

/** MIME 动态降级链：webm;opus -> ogg -> mp4 -> 浏览器默认 */
const MIME_CHAIN: Record<'webm' | 'ogg', string[]> = {
  webm: ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/mp4', ''],
  ogg: ['audio/ogg;codecs=opus', 'audio/ogg', 'audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', '']
}

export function pickMimeType(kind: 'webm' | 'ogg'): { mime: string; ext: string } {
  if (typeof MediaRecorder === 'undefined') return { mime: '', ext: kind }
  for (const candidate of MIME_CHAIN[kind]) {
    if (candidate === '' || MediaRecorder.isTypeSupported(candidate)) {
      const ext = candidate.includes('ogg')
        ? 'ogg'
        : candidate.includes('mp4')
          ? 'm4a'
          : candidate.includes('webm')
            ? 'webm'
            : kind
      return { mime: candidate, ext }
    }
  }
  return { mime: '', ext: kind }
}

function triggerDownload(blob: Blob, name: string, ext: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${name}.${ext}`
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 5000)
}

async function recordRealtime(
  channels: Float32Array[],
  sampleRate: number,
  mime: string,
  onProgress: (p: number) => void
): Promise<Blob> {
  const actx = new AudioContext()
  try {
    let data = channels
    if (sampleRate !== actx.sampleRate) {
      data = await resampleChannels(channels, sampleRate, actx.sampleRate)
    }
    const audioBuf = actx.createBuffer(data.length, Math.max(1, data[0].length), actx.sampleRate)
    data.forEach((c, i) => audioBuf.copyToChannel(c, i))

    const dest = actx.createMediaStreamDestination()
    const src = actx.createBufferSource()
    src.buffer = audioBuf
    src.connect(dest)

    const rec = new MediaRecorder(dest.stream, mime ? { mimeType: mime } : undefined)
    const chunks: BlobPart[] = []
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }

    const duration = audioBuf.duration
    const t0 = performance.now()
    const timer = window.setInterval(() => {
      onProgress(Math.min(0.99, (performance.now() - t0) / 1000 / duration))
    }, 200)

    try {
      await new Promise<void>((resolve, reject) => {
        rec.onstop = () => resolve()
        rec.onerror = () => reject(new Error('MediaRecorder 录制失败'))
        src.onended = () => {
          window.setTimeout(() => {
            if (rec.state !== 'inactive') rec.stop()
          }, 150)
        }
        rec.start(250)
        src.start()
      })
    } finally {
      window.clearInterval(timer)
    }

    onProgress(1)
    return new Blob(chunks, { type: mime || 'audio/webm' })
  } finally {
    void actx.close()
  }
}

export function useAudioExporter() {
  const editor = useEditorStore()
  const toast = useToastStore()

  async function prepare(opts: ExportOptions): Promise<{ channels: Float32Array[]; sampleRate: number }> {
    const buf = editor.buffer
    if (!buf) throw new Error('没有可导出的音频')
    const sr = buf.sampleRate
    let channels = getAllChannels(buf)
    if (opts.range === 'selection') {
      if (!editor.hasSelection) throw new Error('未框选选区，请先在波形上框选')
      channels = sliceChannels(
        channels,
        Math.floor(editor.selection.start * sr),
        Math.floor(editor.selection.end * sr)
      )
    } else {
      channels = channels.map((c) => c.slice())
    }
    channels = convertChannels(channels, opts.channels)
    let outRate = sr
    if (opts.sampleRate && opts.sampleRate !== sr) {
      channels = await resampleChannels(channels, sr, opts.sampleRate)
      outRate = opts.sampleRate
    }
    return { channels, sampleRate: outRate }
  }

  async function exportAudio(opts: ExportOptions, onProgress: (p: number) => void): Promise<void> {
    const { channels, sampleRate } = await prepare(opts)
    let blob: Blob
    let ext: string

    if (opts.format === 'wav') {
      onProgress(0.3)
      blob = new Blob([encodeWav(channels, sampleRate, opts.bitDepth)], { type: 'audio/wav' })
      ext = 'wav'
      onProgress(1)
    } else if (opts.format === 'mp3') {
      const payload = channels.slice(0, 2)
      const data = await runWorkerTask<ArrayBuffer>(
        getMp3Worker(),
        { channels: payload, sampleRate, kbps: opts.bitrate },
        payload.map((c) => c.buffer as ArrayBuffer),
        (p) => onProgress(p / 100)
      )
      blob = new Blob([data], { type: 'audio/mpeg' })
      ext = 'mp3'
    } else {
      const { mime, ext: pickedExt } = pickMimeType(opts.format)
      console.info(`[导出] MediaRecorder 选用 MIME：${mime || '(浏览器默认)'}`)
      toast.push('info', `实时录制中（${mime || '浏览器默认编码'}），耗时约等于音频时长`, 5000)
      blob = await recordRealtime(channels, sampleRate, mime, onProgress)
      ext = pickedExt
    }

    triggerDownload(blob, opts.fileName, ext)
  }

  return { exportAudio }
}
