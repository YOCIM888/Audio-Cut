/**
 * 离线音频编码（复用视频提取音频的 ffmpeg.wasm 核心）。
 *
 * 与旧的 MediaRecorder 实时录制方案相比：
 *  - 不需要真实等待音频时长，编码速度远快于实时，切标签页不受节流影响；
 *  - 支持 FLAC 无损、AAC-M4A、Ogg、WebM，并可写入容器元数据；
 *  - 输入 PCM 通过 WORKERFS 挂载成 WAV 文件，不复制进 MEMFS，避免内存翻倍。
 *
 * 不同浏览器构建的 @ffmpeg/core 编译进去的编码器不完全一致，
 * 因此按「候选编码器链」逐个尝试：成功且输出非空即采用，最后兜底交给 ffmpeg 按扩展名自动选择。
 */
import { FFFSType, type FFmpeg, type LogEvent } from '@ffmpeg/ffmpeg'
import { encodeWav } from '../utils/wav-encoder'
import { convertChannels } from '../utils/audio-utils'
import { metadataArgs, type TrackMetadata } from '../utils/audio-metadata'
import {
  FfmpegCancelledError,
  runFfmpegTask,
  tailLogMessage
} from '../utils/ffmpeg-core'

export type FfmpegAudioFormat = 'flac' | 'm4a' | 'ogg' | 'webm'

export interface EncodedAudio {
  blob: Blob
  ext: string
  mime: string
}

export interface EncodeHooks {
  /** 0~1 总进度 */
  onProgress: (progress: number) => void
  onPhase: (text: string) => void
}

const MOUNT_DIR = '/yac-input'
const OUTPUT_PATH = '/yac-out'
const INPUT_PATH = `${MOUNT_DIR}/source.wav`

const FORMATS: Record<FfmpegAudioFormat, { ext: string; mime: string }> = {
  flac: { ext: 'flac', mime: 'audio/flac' },
  m4a: { ext: 'm4a', mime: 'audio/mp4' },
  ogg: { ext: 'ogg', mime: 'audio/ogg' },
  webm: { ext: 'webm', mime: 'audio/webm' }
}

function candidatesFor(format: FfmpegAudioFormat, kbps: number): string[][] {
  const rate = `${Math.round(kbps)}k`
  switch (format) {
    case 'flac':
      return [['-c:a', 'flac', '-compression_level', '5'], ['-c:a', 'flac'], []]
    case 'm4a':
      return [['-c:a', 'aac', '-b:a', rate], []]
    case 'ogg':
      return [
        ['-c:a', 'libvorbis', '-b:a', rate],
        ['-c:a', 'libopus', '-b:a', rate],
        []
      ]
    case 'webm':
      return [['-c:a', 'libopus', '-b:a', rate], []]
  }
}

function parseLogTime(message: string): number | null {
  const m = /time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message)
  if (!m) return null
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

function describeEncodeFailure(logs: string[]): string {
  const text = logs.join('\n').toLowerCase()
  if (text.includes('unknown encoder') || text.includes('encoder not found')) {
    return '当前浏览器版 ffmpeg 核心未提供该格式的编码器，请改用 WAV / MP3 / FLAC'
  }
  if (text.includes('cannot allocate memory') || text.includes('out of memory')) {
    return '内存不足：音频过长，请导出选区或改用更小采样率后重试'
  }
  return tailLogMessage(logs)
}

async function encodeOnInstance(
  inst: FFmpeg,
  channels: Float32Array[],
  sampleRate: number,
  format: FfmpegAudioFormat,
  kbps: number,
  meta: TrackMetadata | undefined,
  hooks: EncodeHooks,
  isCancelled: () => boolean
): Promise<EncodedAudio> {
  const spec = FORMATS[format]
  const outPath = `${OUTPUT_PATH}.${spec.ext}`
  const duration = Math.max(0.001, (channels[0]?.length ?? 0) / sampleRate)

  // 容器/编码器对多声道支持有限，统一降到立体声
  const pcm = channels.length > 2 ? convertChannels(channels, 'stereo') : channels
  hooks.onPhase('正在准备 PCM 数据…')
  const wav = encodeWav(pcm, sampleRate, 16)
  hooks.onProgress(0.2)

  const logs: string[] = []
  let progress = 0.2
  const onLog = (e: LogEvent) => {
    logs.push(e.message)
    if (logs.length > 600) logs.shift()
    const t = parseLogTime(e.message)
    if (t !== null) {
      const p = Math.max(progress, 0.2 + 0.75 * Math.min(0.99, t / duration))
      progress = p
      hooks.onProgress(p)
    }
  }
  inst.on('log', onLog)

  let mounted = false
  try {
    // 清理上次任务异常退出时可能残留的挂载目录，避免 EEXIST / 旧文件干扰
    await inst.deleteDir(MOUNT_DIR).catch(() => undefined)
    await inst.createDir(MOUNT_DIR).catch(() => undefined)
    await inst.mount(
      FFFSType.WORKERFS,
      { files: [new File([wav], 'source.wav', { type: 'audio/wav' })] },
      MOUNT_DIR
    )
    mounted = true
    if (isCancelled()) throw new FfmpegCancelledError()

    hooks.onPhase('正在离线编码…')
    const metaFlags = metadataArgs(meta)
    const candidates = candidatesFor(format, kbps)
    let lastLogs: string[] = []

    for (let i = 0; i < candidates.length; i++) {
      if (isCancelled()) throw new FfmpegCancelledError()
      logs.length = 0
      const args = [
        '-hide_banner',
        '-y',
        '-i',
        INPUT_PATH,
        '-vn',
        '-map',
        '0:a:0',
        ...candidates[i],
        ...metaFlags,
        outPath
      ]
      let code = -1
      try {
        code = await inst.exec(args)
      } catch (err) {
        lastLogs = [...logs, err instanceof Error ? err.message : String(err)]
        continue
      }
      if (isCancelled()) throw new FfmpegCancelledError()
      if (code !== 0) {
        lastLogs = [...logs]
        continue
      }

      const data = await inst.readFile(outPath)
      if (typeof data === 'string' || data.byteLength === 0) {
        lastLogs = [...logs, '编码器返回了空文件']
        continue
      }
      hooks.onProgress(1)
      hooks.onPhase('编码完成')
      return { blob: new Blob([data], { type: spec.mime }), ext: spec.ext, mime: spec.mime }
    }

    if (isCancelled()) throw new FfmpegCancelledError()
    throw new Error(describeEncodeFailure(lastLogs))
  } finally {
    try {
      inst.off('log', onLog)
    } catch {
      // 实例已被终止时忽略
    }
    if (!isCancelled()) {
      if (mounted) {
        try {
          await inst.unmount(MOUNT_DIR)
        } catch {
          // 未挂载时忽略
        }
      }
      try {
        await inst.deleteDir(MOUNT_DIR)
      } catch {
        // 目录已不存在时忽略
      }
      try {
        await inst.deleteFile(outPath)
      } catch {
        // 输出文件不存在时忽略
      }
    }
  }
}

export async function encodeWithFfmpeg(
  channels: Float32Array[],
  sampleRate: number,
  format: FfmpegAudioFormat,
  kbps: number,
  meta: TrackMetadata | undefined,
  hooks: EncodeHooks
): Promise<EncodedAudio> {
  return runFfmpegTask(
    (ctx) =>
      encodeOnInstance(
        ctx.ffmpeg,
        channels,
        sampleRate,
        format,
        kbps,
        meta,
        hooks,
        ctx.isCancelled
      ),
    (p) => hooks.onProgress(p * 0.15)
  )
}
