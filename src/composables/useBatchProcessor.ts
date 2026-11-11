/**
 * 批量文件处理 / 批量导出。
 *
 * 每个文件：解码 →（可选）去静音 → 淡入淡出 → 增益 → LUFS 归一化（可选限制器）
 *          → 编码 → 汇总。分析与限制器走 Worker，编码复用单文件导出的同一套实现，
 *          因此批量结果与在编辑器里逐项操作完全一致。
 * 输出可选「逐个下载」或打包成一个 zip（纯前端 STORED，零依赖）。
 */
import { computed, ref, shallowRef } from 'vue'
import { audioEngine } from '../audio/engine'
import { getAllChannels } from '../utils/audio-utils'
import { analyzeAudio, limitAudio } from '../utils/analysis-client'
import { detectSegments, type SilenceOptions } from '../audio/spectral'
import { normalizeGain } from '../audio/loudness'
import { encodeWavBlob, type WavBitDepth } from '../utils/wav-encoder'
import { writeId3v2, type TrackMetadata } from '../utils/audio-metadata'
import { runWorkerTask } from '../utils/worker-client'
import { createZip, type ZipInput } from '../utils/zip'
import { encodeWithFfmpeg, type FfmpegAudioFormat } from './useFfmpegEncoder'

export type BatchFormat = 'wav' | 'mp3' | 'flac' | 'm4a' | 'ogg' | 'webm'

export interface BatchOptions {
  format: BatchFormat
  bitDepth: WavBitDepth
  bitrate: number
  dither: boolean
  gainDb: number
  normalizeLufs: boolean
  targetLufs: number
  ceilingDbTp: number
  useLimiter: boolean
  trimSilence: boolean
  silence: SilenceOptions
  fadeInMs: number
  fadeOutMs: number
  /** 'zip' 打包为一个 zip 下载；'individual' 逐个触发下载 */
  output: 'zip' | 'individual'
}

export interface BatchItem {
  name: string
  status: 'pending' | 'processing' | 'done' | 'error' | 'skipped'
  message: string
  duration: number
  lufs: number
  bytes: number
}

export function defaultBatchOptions(): BatchOptions {
  return {
    format: 'wav',
    bitDepth: 16,
    bitrate: 192,
    dither: true,
    gainDb: 0,
    normalizeLufs: true,
    targetLufs: -16,
    ceilingDbTp: -1,
    useLimiter: true,
    trimSilence: false,
    silence: { thresholdDb: -45, minSilenceMs: 300, minSoundMs: 150, padMs: 80 },
    fadeInMs: 0,
    fadeOutMs: 0,
    output: 'zip'
  }
}

function safeName(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 100) || 'audio'
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10000)
}

function abortError(): DOMException {
  return new DOMException('批量处理已取消', 'AbortError')
}

function assertLive(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

function applyFades(channels: Float32Array[], sampleRate: number, fadeInMs: number, fadeOutMs: number): void {
  const n = channels[0]?.length ?? 0
  const fi = Math.min(n, Math.round((fadeInMs / 1000) * sampleRate))
  const fo = Math.min(n - fi, Math.round((fadeOutMs / 1000) * sampleRate))
  for (const ch of channels) {
    for (let i = 0; i < fi; i++) ch[i] *= (i + 1) / (fi + 1)
    for (let i = 0; i < fo; i++) ch[n - 1 - i] *= (i + 1) / (fo + 1)
  }
}

/** 一次只用一个 MP3 Worker，文件串行处理，避免消息串包 */
let mp3Worker: Worker | null = null
function getMp3Worker(): Worker {
  if (!mp3Worker) {
    mp3Worker = new Worker(new URL('../workers/mp3-encoder.worker.ts', import.meta.url), {
      type: 'module'
    })
  }
  return mp3Worker
}
function disposeMp3Worker(): void {
  mp3Worker?.terminate()
  mp3Worker = null
}

async function encodeBlob(
  channels: Float32Array[],
  sampleRate: number,
  opts: BatchOptions,
  meta: TrackMetadata,
  signal: AbortSignal,
  onPhase: (text: string) => void
): Promise<{ blob: Blob; ext: string }> {
  assertLive(signal)
  if (opts.format === 'wav') {
    onPhase('编码 WAV')
    return {
      blob: await encodeWavBlob(channels, sampleRate, opts.bitDepth, meta, {
        dither: opts.dither,
        signal
      }),
      ext: 'wav'
    }
  }
  if (opts.format === 'mp3') {
    onPhase('编码 MP3')
    const payload = channels.slice(0, 2).map((c) => c.slice())
    const raw = await runWorkerTask<ArrayBuffer>(
      getMp3Worker(),
      { channels: payload, sampleRate, kbps: opts.bitrate },
      payload.map((c) => c.buffer as ArrayBuffer)
    )
    assertLive(signal)
    return { blob: new Blob([writeId3v2(raw, meta)], { type: 'audio/mpeg' }), ext: 'mp3' }
  }
  onPhase('ffmpeg 离线编码')
  const result = await encodeWithFfmpeg(
    channels,
    sampleRate,
    opts.format as FfmpegAudioFormat,
    opts.bitrate,
    meta,
    { onProgress: () => undefined, onPhase }
  )
  assertLive(signal)
  return { blob: result.blob, ext: result.ext }
}

const items = shallowRef<BatchItem[]>([])
const running = ref(false)
const progress = ref(0)
const phase = ref('')
const overallLabel = computed(() => {
  if (!running.value) return items.value.length ? '批量处理已结束' : '尚未添加文件'
  return `处理中 ${Math.round(progress.value * 100)}% · ${phase.value}`
})

let controller: AbortController | null = null

export function useBatchProcessor() {
  function setFiles(files: File[]): void {
    if (running.value) return
    items.value = files.map((f) => ({
      name: f.name,
      status: 'pending',
      message: '',
      duration: 0,
      lufs: -Infinity,
      bytes: 0
    }))
    progress.value = 0
    phase.value = ''
  }

  function clear(): void {
    if (running.value) return
    items.value = []
    progress.value = 0
    phase.value = ''
  }

  function cancel(): void {
    controller?.abort()
    disposeMp3Worker()
  }

  async function run(files: File[], opts: BatchOptions): Promise<void> {
    if (running.value || files.length === 0) return
    running.value = true
    controller = new AbortController()
    const signal = controller.signal
    const ctx = audioEngine.ensureContext()
    const results: BatchItem[] = files.map((f) => ({
      name: f.name,
      status: 'pending',
      message: '',
      duration: 0,
      lufs: -Infinity,
      bytes: 0
    }))
    items.value = results
    const entries: ZipInput[] = []

    try {
      for (let i = 0; i < files.length; i++) {
        assertLive(signal)
        const file = files[i]
        const item = results[i]
        item.status = 'processing'
        items.value = results.slice()
        progress.value = i / files.length
        try {
          phase.value = `解码 ${file.name}`
          const decoded = await ctx.decodeAudioData(await file.arrayBuffer())
          const sr = decoded.sampleRate
          let channels = getAllChannels(decoded).map((c) => c.slice())
          item.duration = decoded.duration

          if (opts.trimSilence) {
            phase.value = '检测并移除静音'
            const segments = detectSegments(channels, sr, opts.silence)
            const sounds = segments.filter((s) => s.kind === 'sound')
            if (sounds.length) {
              const ranges = sounds.map((s) => ({
                from: Math.max(0, Math.floor(s.start * sr)),
                to: Math.min(channels[0].length, Math.ceil(s.end * sr))
              }))
              const total = ranges.reduce((n, r) => n + Math.max(0, r.to - r.from), 0)
              if (total > 0) {
                const joined = channels.map(() => new Float32Array(total))
                let pos = 0
                for (const r of ranges) {
                  if (r.to <= r.from) continue
                  for (let c = 0; c < channels.length; c++) {
                    joined[c].set(channels[c].subarray(r.from, r.to), pos)
                  }
                  pos += r.to - r.from
                }
                channels = joined
              }
            }
          }

          applyFades(channels, sr, opts.fadeInMs, opts.fadeOutMs)
          if (Math.abs(opts.gainDb) > 0.001) {
            const g = Math.pow(10, opts.gainDb / 20)
            for (const ch of channels) for (let j = 0; j < ch.length; j++) ch[j] *= g
          }

          if (opts.normalizeLufs) {
            phase.value = '测量响度'
            const stats = await analyzeAudio(channels, sr, { signal, maxHistoryPoints: 64 })
            item.lufs = stats.integratedLufs
            if (Number.isFinite(stats.integratedLufs)) {
              const calc = normalizeGain(stats, opts.targetLufs, opts.ceilingDbTp, opts.useLimiter)
              const g = Math.pow(10, calc.gainDb / 20)
              for (const ch of channels) for (let j = 0; j < ch.length; j++) ch[j] *= g
              if (opts.useLimiter) {
                phase.value = '限制真峰值'
                const lim = await limitAudio(channels, sr, opts.ceilingDbTp, signal)
                channels = lim.channels
              }
            }
          }

          const stem = safeName(file.name)
          const meta: TrackMetadata = { title: stem, artist: '', album: '', year: '' }
          const { blob, ext } = await encodeBlob(channels, sr, opts, meta, signal, (t) => {
            phase.value = t
          })
          item.bytes = blob.size
          item.status = 'done'
          item.message = `${(blob.size / 1024 / 1024).toFixed(2)} MB · ${channels.length}ch · ${sr}Hz`
          if (opts.output === 'zip') entries.push({ name: `${stem}.${ext}`, data: blob })
          else download(blob, `${stem}.${ext}`)
        } catch (err) {
          if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
            item.status = 'skipped'
            item.message = '已取消'
          } else {
            item.status = 'error'
            item.message = err instanceof Error ? err.message : '处理失败'
            console.error('[batch]', file.name, err)
          }
        }
        items.value = results.slice()
        progress.value = (i + 1) / files.length
        // 让出事件循环，避免连续大文件把界面卡住
        await new Promise((resolve) => window.setTimeout(resolve, 0))
      }

      assertLive(signal)
      if (opts.output === 'zip' && entries.length) {
        phase.value = '打包 ZIP'
        const zip = await createZip(entries)
        download(zip, `yocim-batch-${entries.length}-files.zip`)
      }
      progress.value = 1
      phase.value = ''
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        console.error('[batch]', err)
        phase.value = err instanceof Error ? err.message : '批量处理失败'
      }
    } finally {
      disposeMp3Worker()
      running.value = false
      controller = null
      items.value = results.slice()
    }
  }

  return { items, running, progress, phase, overallLabel, setFiles, clear, cancel, run }
}
