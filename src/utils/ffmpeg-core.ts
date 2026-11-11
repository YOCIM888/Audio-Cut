/**
 * ffmpeg.wasm 共享核心管理。
 *
 * 设计要点：
 *  - 核心文件自托管于 public/ffmpeg，首次按需下载并写入 Cache Storage，之后从缓存读取；
 *    首屏不加载，objectURL 全局复用。
 *  - FFmpeg 实例为单例，视频提取音频与离线音频编码共用同一个 Worker / 虚拟 FS。
 *  - 所有任务通过 Promise 链串行化，避免两个任务并发写同一虚拟 FS 或抢同一 Worker。
 *  - 取消通过终止 Worker 实现（ffmpeg.wasm 的 exec 不可中断），终止后按 generation
 *    校验防止「已终止实例」被重新登记为可用实例，下次任务自动用缓存重建。
 */
import { FFmpeg } from '@ffmpeg/ffmpeg'

const CORE_DIR = `${import.meta.env.BASE_URL}ffmpeg/`
const CORE_CACHE = 'yac-ffmpeg-core-v1'
const CORE_FILES: { name: string; type: string; weight: number }[] = [
  { name: 'ffmpeg-core.js', type: 'text/javascript', weight: 0.05 },
  { name: 'ffmpeg-core.wasm', type: 'application/wasm', weight: 0.95 }
]

interface CoreUrls {
  coreURL: string
  wasmURL: string
}

export type LoadProgress = (progress: number) => void

/** 任务被取消时抛出的专用错误，调用方可转换成自己的提示文案 */
export class FfmpegCancelledError extends Error {
  constructor() {
    super('已取消处理')
    this.name = 'FfmpegCancelledError'
  }
}

export interface FfmpegTaskContext {
  ffmpeg: FFmpeg
  isCancelled: () => boolean
}

let cachedCoreUrls: CoreUrls | null = null
let coreUrlsPromise: Promise<CoreUrls> | null = null
let instance: FFmpeg | null = null
let coreLoaded = false
/** 每次 terminate 递增，用于识别「加载过程中被取消」的过期实例 */
let generation = 0
let activeCancel: (() => void) | null = null
let tail: Promise<unknown> = Promise.resolve()

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function readCachedBlob(url: string): Promise<Blob | null> {
  if (typeof caches === 'undefined') return null
  try {
    const cache = await caches.open(CORE_CACHE)
    const hit = await cache.match(url)
    return hit ? await hit.blob() : null
  } catch {
    return null
  }
}

async function fetchBlobWithProgress(
  url: string,
  type: string,
  onProgress: LoadProgress
): Promise<Blob> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`核心文件请求失败（HTTP ${res.status}）`)
  const total = Number(res.headers.get('content-length') ?? 0)
  if (!res.body || !(total > 0)) {
    onProgress(1)
    return new Blob([await res.arrayBuffer()], { type })
  }
  const reader = res.body.getReader()
  const parts: BlobPart[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      parts.push(value)
      received += value.byteLength
      onProgress(Math.min(1, received / total))
    }
  }
  return new Blob(parts, { type })
}

async function ensureCoreUrls(onProgress: LoadProgress): Promise<CoreUrls> {
  if (cachedCoreUrls) {
    onProgress(1)
    return cachedCoreUrls
  }
  if (coreUrlsPromise) return coreUrlsPromise

  coreUrlsPromise = (async () => {
    let done = 0
    const objectUrls: string[] = []
    for (const item of CORE_FILES) {
      const url = `${CORE_DIR}${item.name}`
      let blob = await readCachedBlob(url)
      if (!blob) {
        blob = await fetchBlobWithProgress(url, item.type, (p) =>
          onProgress(done + p * item.weight)
        )
        try {
          const cache = await caches.open(CORE_CACHE)
          await cache.put(url, new Response(blob, { headers: { 'Content-Type': item.type } }))
        } catch {
          // Cache Storage 不可用（隐私模式等）时不影响本次使用
        }
      } else {
        onProgress(done + item.weight)
      }
      done += item.weight
      objectUrls.push(URL.createObjectURL(new Blob([blob], { type: item.type })))
    }
    onProgress(1)
    return { coreURL: objectUrls[0], wasmURL: objectUrls[1] }
  })()

  try {
    cachedCoreUrls = await coreUrlsPromise
    return cachedCoreUrls
  } catch (err) {
    coreUrlsPromise = null
    throw new Error(`ffmpeg 核心加载失败：${errorMessage(err)}`)
  }
}

function terminateInstance(): void {
  generation++
  if (instance) {
    try {
      instance.terminate()
    } catch {
      // 已终止时忽略
    }
  }
  instance = null
  coreLoaded = false
}

async function ensureInstance(
  onLoadProgress: LoadProgress,
  isCancelled: () => boolean
): Promise<FFmpeg> {
  if (instance && coreLoaded) {
    onLoadProgress(1)
    return instance
  }
  const g = generation
  const urls = await ensureCoreUrls(onLoadProgress)
  if (isCancelled() || generation !== g) throw new FfmpegCancelledError()

  const inst = new FFmpeg()
  try {
    await inst.load({ coreURL: urls.coreURL, wasmURL: urls.wasmURL })
  } catch (err) {
    inst.terminate()
    // 加载期间被取消： terminate 已销毁 Worker，不登记为可用实例
    if (isCancelled() || generation !== g) throw new FfmpegCancelledError()
    throw new Error(`ffmpeg 核心初始化失败：${errorMessage(err)}`)
  }
  if (isCancelled() || generation !== g) {
    inst.terminate()
    throw new FfmpegCancelledError()
  }
  instance = inst
  coreLoaded = true
  return inst
}

/** 取消当前正在运行的 ffmpeg 任务（含排队中任务的后续检查点） */
export function cancelActiveFfmpegTask(): void {
  activeCancel?.()
}

/**
 * 串行执行一个 ffmpeg 任务。同一时刻只有一个任务持有实例，
 * 前一个任务失败也不会阻塞后续任务。
 */
export function runFfmpegTask<T>(
  task: (ctx: FfmpegTaskContext) => Promise<T>,
  onLoadProgress?: LoadProgress
): Promise<T> {
  const run = async (): Promise<T> => {
    let cancelled = false
    const isCancelled = () => cancelled
    activeCancel = () => {
      cancelled = true
      terminateInstance()
    }
    try {
      const ffmpeg = await ensureInstance(onLoadProgress ?? (() => {}), isCancelled)
      if (cancelled) throw new FfmpegCancelledError()
      return await task({ ffmpeg, isCancelled })
    } catch (err) {
      if (cancelled) throw new FfmpegCancelledError()
      throw err
    } finally {
      activeCancel = null
    }
  }
  const result = tail.then(run, run)
  tail = result.catch(() => undefined)
  return result
}

/** 从 ffmpeg 日志尾部提取可读错误摘要 */
export function tailLogMessage(logs: string[]): string {
  const lines = logs
    .join('\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const tail = lines.slice(-2).join(' ')
  return tail ? `处理失败：${tail}` : '处理失败，未获取到有效日志'
}
