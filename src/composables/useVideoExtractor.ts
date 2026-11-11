/**
 * 视频提取音频（ffmpeg.wasm 单线程核心）。
 *
 * 关键设计：
 *  - 核心加载与实例管理统一交给 utils/ffmpeg-core，与离线音频导出共用同一 Worker；
 *    任务串行执行，避免两个任务争抢虚拟 FS。
 *  - 输入视频通过 WORKERFS 挂载进虚拟 FS（按需读取 File），
 *    不会把整个视频复制进 MEMFS，避免大文件内存翻倍。
 *  - 解析 ffmpeg 日志中的 time= 计算真实进度。
 *  - 取消通过终止 Worker（同时清空其虚拟 FS），下次任务自动重新加载核心。
 */
import { FFFSType, type LogEvent } from '@ffmpeg/ffmpeg'
import {
  FfmpegCancelledError,
  cancelActiveFfmpegTask,
  runFfmpegTask
} from '../utils/ffmpeg-core'

const MOUNT_DIR = '/input'
const OUTPUT_PATH = '/extract.mp3'
/** WORKERFS + wasm 堆叠加后的保守上限，超过基本必然 OOM */
const MAX_INPUT_BYTES = 1024 * 1024 * 1024

export const CANCEL_MESSAGE = '已取消提取'

export type ExtractPhase = 'loading' | 'probing' | 'extracting'

export interface ExtractOptions {
  bitrate: number
  keepOriginalRate: boolean
  /** 浏览器 video 元素读到的时长，作为日志解析失败时的兜底 */
  durationHint?: number
}

export interface ExtractHooks {
  onPhase: (phase: ExtractPhase, text: string) => void
  onLoadProgress: (progress: number) => void
  onProgress: (progress: number, elapsed: number, total: number) => void
}

export interface ExtractResult {
  blob: Blob
  fileName: string
  duration: number
}

let running = false

/** Windows 非法字符清洗（文件名出口统一走这里） */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/\.[^.]+$/, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  return cleaned || 'audio'
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function parseLogTime(message: string): number | null {
  const m = /time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message)
  if (!m) return null
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

function parseDuration(text: string): number {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text)
  if (!m) return 0
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

/** 把 ffmpeg 常见报错翻译成可读提示 */
function describeFailure(text: string): string {
  const t = text.toLowerCase()
  if (t.includes('matches no streams') || t.includes('does not contain any stream')) {
    return '该视频不包含可提取的音轨'
  }
  if (t.includes('invalid data found')) {
    return '无法识别的视频格式，或文件已损坏'
  }
  if (t.includes('moov atom not found')) {
    return '视频文件不完整（缺少 moov atom），请重新导出后再试'
  }
  if (
    t.includes('cannot allocate memory') ||
    t.includes('out of memory') ||
    t.includes('memory access out of bounds') ||
    t.includes('allocation failed')
  ) {
    return '内存不足：请改用更小的视频，或先裁剪时长后重试'
  }
  if (t.includes('unsupported codec') || t.includes('decoder not found')) {
    return '该视频使用了浏览器版 ffmpeg 不支持的编码'
  }
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const tail = lines.slice(-2).join(' ')
  return tail ? `处理失败：${tail}` : '处理失败，未获取到有效日志'
}

function extensionOf(name: string): string {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name)
  return m ? `.${m[1].toLowerCase()}` : ''
}

/** 取消当前任务：终止 Worker（虚拟 FS 随之销毁），下次任务重新加载核心（走缓存） */
export function cancelExtraction(): void {
  cancelActiveFfmpegTask()
}

export async function extractAudio(
  file: File,
  options: ExtractOptions,
  hooks: ExtractHooks
): Promise<ExtractResult> {
  if (running) throw new Error('已有提取任务正在进行')
  if (file.size <= 0) throw new Error('视频文件为空')
  if (file.size > MAX_INPUT_BYTES) {
    throw new Error('文件过大（超过 1GB），浏览器内存无法承载，请先压缩或裁剪视频')
  }

  running = true
  hooks.onPhase('loading', '正在加载 ffmpeg 核心…')

  try {
    return await runFfmpegTask(async (ctx) => {
      const logs: string[] = []
      let elapsed = 0
      let total = Math.max(0, options.durationHint ?? 0)

      const onLog = (e: LogEvent) => {
        logs.push(e.message)
        if (logs.length > 600) logs.shift()
        const t = parseLogTime(e.message)
        if (t !== null) {
          elapsed = Math.max(elapsed, t)
          if (total > 0) {
            hooks.onProgress(Math.min(0.99, elapsed / total), elapsed, total)
          }
        }
      }

      const inst = ctx.ffmpeg
      inst.on('log', onLog)
      try {
        // 1) 挂载输入文件（WORKERFS 不复制视频数据）
        hooks.onPhase('probing', '正在探测视频音轨…')
        await inst.createDir(MOUNT_DIR).catch(() => undefined)
        const inputName = `source${extensionOf(file.name) || '.mp4'}`
        await inst.mount(
          FFFSType.WORKERFS,
          { files: [new File([file], inputName, { type: file.type || 'video/mp4' })] },
          MOUNT_DIR
        )
        const inputPath = `${MOUNT_DIR}/${inputName}`

        // 2) 只探测，不转码：仅 -i 会退出码非 0，但已打印流信息
        logs.length = 0
        await inst.exec(['-hide_banner', '-i', inputPath])
        if (ctx.isCancelled()) throw new FfmpegCancelledError()

        const probeText = logs.join('\n')
        const hasAudio = /Audio:\s/.test(probeText)
        const probedDuration = parseDuration(probeText)
        if (probedDuration > 0) total = probedDuration
        if (!hasAudio) {
          // 与「格式不支持」区分：能解析出视频/时长，但没有 Audio 流
          if (/Video:\s/.test(probeText) || probedDuration > 0) {
            throw new Error('该视频不包含音轨（未检测到 Audio 流），无法提取音频')
          }
          throw new Error(describeFailure(probeText))
        }

        // 3) 提取为 MP3
        hooks.onPhase('extracting', '正在提取音频…')
        elapsed = 0
        hooks.onProgress(0, 0, total)
        logs.length = 0
        const args = ['-i', inputPath, '-vn', '-map', '0:a:0', '-b:a', `${options.bitrate}k`]
        if (!options.keepOriginalRate) args.push('-ar', '44100')
        args.push(OUTPUT_PATH)
        const code = await inst.exec(args)
        if (ctx.isCancelled()) throw new FfmpegCancelledError()
        if (code !== 0) throw new Error(describeFailure(logs.join('\n')))

        hooks.onProgress(1, total, total)
        const data = await inst.readFile(OUTPUT_PATH)
        if (typeof data === 'string') throw new Error('输出文件读取失败')
        const blob = new Blob([data], { type: 'audio/mpeg' })
        if (blob.size === 0) throw new Error('提取结果为空，请确认视频音轨有效')

        return {
          blob,
          fileName: `${sanitizeFileName(file.name)}.mp3`,
          duration: total
        }
      } finally {
        try {
          inst.off('log', onLog)
        } catch {
          // 实例已被终止时忽略
        }
        // 正常结束时清理虚拟 FS；取消时 Worker 已终止，FS 已随之销毁
        if (!ctx.isCancelled()) {
          try {
            await inst.unmount(MOUNT_DIR)
          } catch {
            // 未挂载时忽略
          }
          try {
            await inst.deleteDir(MOUNT_DIR)
          } catch {
            // 目录已不存在时忽略
          }
          try {
            await inst.deleteFile(OUTPUT_PATH)
          } catch {
            // 输出文件不存在（失败/取消）时忽略
          }
        }
      }
    }, hooks.onLoadProgress)
  } catch (err) {
    if (err instanceof FfmpegCancelledError) throw new Error(CANCEL_MESSAGE)
    throw err instanceof Error ? err : new Error(errorMessage(err))
  } finally {
    running = false
  }
}
