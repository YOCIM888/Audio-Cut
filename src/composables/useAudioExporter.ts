/**
 * 音频导出编排：
 *  - WAV：纯 JS 编码（16/24/32-bit，可写 LIST/INFO）
 *  - MP3：lamejs Worker 分块编码 + ID3v2.3 标签
 *  - FLAC / M4A(AAC) / OGG / WebM：ffmpeg.wasm 离线编码（复用视频提取的核心，无需实时录制）
 *
 * 效果链是非破坏性的：音轨始终保存原始 PCM，导出前才按链顺序离线渲染一次，
 * 因此导出的结果与试听一致，且不会重复叠加效果。
 */
import { useEditorStore } from '../stores/editor'
import { useToastStore } from '../stores/toast'
import { encodeWav, type WavBitDepth } from '../utils/wav-encoder'
import { writeId3v2, hasMetadata, type TrackMetadata } from '../utils/audio-metadata'
import { chainActive, enabledNodes } from '../audio/effect-chain'
import { renderChain } from '../audio/effects'
import {
  clamp,
  concatChannels,
  convertChannels,
  getAllChannels,
  resampleChannels,
  sliceChannels
} from '../utils/audio-utils'
import { runWorkerTask } from '../utils/worker-client'
import { encodeWithFfmpeg, type FfmpegAudioFormat } from './useFfmpegEncoder'

export type ExportFormat = 'wav' | 'mp3' | 'flac' | 'm4a' | 'ogg' | 'webm'

export interface ExportOptions {
  format: ExportFormat
  sampleRate: number | null
  bitDepth: WavBitDepth
  channels: 'keep' | 'mono' | 'stereo'
  bitrate: number
  range: 'all' | 'selection'
  fileName: string
  metadata?: TrackMetadata
}

const FFMPEG_FORMATS: FfmpegAudioFormat[] = ['flac', 'm4a', 'ogg', 'webm']

function isFfmpegFormat(format: ExportFormat): format is FfmpegAudioFormat {
  return (FFMPEG_FORMATS as string[]).includes(format)
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

function triggerDownload(blob: Blob, name: string, ext: string): void {
  const safe = name.trim().replace(/[\\/:*?"<>|]+/g, '-') || 'audio'
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${safe}.${ext}`
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 5000)
}

export function useAudioExporter() {
  const editor = useEditorStore()
  const toast = useToastStore()

  async function prepare(
    opts: ExportOptions,
    onProgress: (p: number) => void,
    onPhase?: (text: string) => void
  ): Promise<{ channels: Float32Array[]; sampleRate: number; chainRendered: boolean }> {
    const buf = editor.buffer
    if (!buf) throw new Error('没有可导出的音频')
    const sr = buf.sampleRate
    let regionStart = 0
    let channels: Float32Array[]
    if (opts.range === 'selection') {
      if (!editor.hasSelection) throw new Error('未框选选区，请先在波形上框选')
      regionStart = Math.floor(editor.selection.start * sr)
      channels = sliceChannels(
        getAllChannels(buf),
        regionStart,
        Math.floor(editor.selection.end * sr)
      )
    } else {
      channels = getAllChannels(buf).map((c) => c.slice())
    }

    // 效果链在原采样率下渲染，再做声道/采样率转换，避免两次有损重采样。
    // 链作用域与导出选区可能不同：先求两者交集，只渲染真正需要的片段。
    let chainRendered = false
    const state = editor.chain
    if (chainActive(state)) {
      const useSel = state.scope === 'selection' && editor.hasSelection
      const from = useSel ? Math.floor(editor.selection.start * sr) : 0
      const to = useSel ? Math.floor(editor.selection.end * sr) : buf.length
      const len = channels[0]?.length ?? 0
      const lo = clamp(from - regionStart, 0, len)
      const hi = clamp(to - regionStart, 0, len)
      if (hi - lo > 16) {
        onPhase?.('正在离线渲染效果链…')
        onProgress(0.02)
        const sub = sliceChannels(channels, lo, hi)
        const rendered = await renderChain(sub, sr, enabledNodes(state), (p) => {
          onProgress(0.02 + (p / 100) * 0.33)
        })
        channels = concatChannels(
          concatChannels(sliceChannels(channels, 0, lo), rendered),
          sliceChannels(channels, hi, len)
        )
        chainRendered = true
      }
    }

    channels = convertChannels(channels, opts.channels)
    let outRate = sr
    if (opts.sampleRate && opts.sampleRate !== sr) {
      channels = await resampleChannels(channels, sr, opts.sampleRate)
      outRate = opts.sampleRate
    }
    return { channels, sampleRate: outRate, chainRendered }
  }

  async function exportAudio(
    opts: ExportOptions,
    onProgress: (p: number) => void,
    onPhase?: (text: string) => void
  ): Promise<void> {
    const { channels, sampleRate, chainRendered } = await prepare(opts, onProgress, onPhase)
    if (channels.length === 0 || channels[0].length === 0) throw new Error('导出内容为空')
    // 效果链渲染已占用前 35% 进度，编码阶段映射到剩余区间
    const base = chainRendered ? 0.35 : 0
    const report = (p: number) => onProgress(base + (1 - base) * clamp(p, 0, 1))
    let blob: Blob
    let ext: string

    if (opts.format === 'wav') {
      onPhase?.('正在编码 WAV…')
      report(0.3)
      const wav = encodeWav(channels, sampleRate, opts.bitDepth, opts.metadata)
      blob = new Blob([wav], { type: 'audio/wav' })
      ext = 'wav'
      report(1)
    } else if (opts.format === 'mp3') {
      onPhase?.('正在编码 MP3…')
      const payload = channels.slice(0, 2)
      const data = await runWorkerTask<ArrayBuffer>(
        getMp3Worker(),
        { channels: payload, sampleRate, kbps: opts.bitrate },
        payload.map((c) => c.buffer as ArrayBuffer),
        (p) => report(p / 100)
      )
      const withTags = hasMetadata(opts.metadata) ? writeId3v2(data, opts.metadata) : data
      blob = new Blob([withTags], { type: 'audio/mpeg' })
      ext = 'mp3'
      report(1)
    } else if (isFfmpegFormat(opts.format)) {
      toast.push('info', 'ffmpeg 离线编码中（核心按需加载约 31MB，本地缓存后免下载）', 4500)
      const result = await encodeWithFfmpeg(
        channels,
        sampleRate,
        opts.format,
        opts.bitrate,
        opts.metadata,
        {
          onProgress: report,
          onPhase: (text) => onPhase?.(text)
        }
      )
      blob = result.blob
      ext = result.ext
    } else {
      throw new Error('不支持的导出格式')
    }

    onPhase?.('')
    triggerDownload(blob, opts.fileName, ext)
  }

  return { exportAudio }
}
