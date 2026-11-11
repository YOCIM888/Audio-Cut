/**
 * 音频处理 Worker 的共享入口。
 *
 * Worker 使用简单的「一条消息一个响应」协议，多个任务并发调用会互相串包，
 * 因此这里额外用一条 Promise 链把所有请求串行化。转移的 ArrayBuffer 在真正
 * postMessage 之前不会被 detach，排队期间保持有效。
 */
import { runWorkerTask } from './worker-client'

let processWorker: Worker | null = null
let tail: Promise<unknown> = Promise.resolve()

export function getProcessWorker(): Worker {
  if (!processWorker) {
    processWorker = new Worker(new URL('../workers/audio-process.worker.ts', import.meta.url), {
      type: 'module'
    })
  }
  return processWorker
}

export function runProcessTask<TRes>(
  message: unknown,
  transfer: Transferable[],
  onProgress?: (p: number) => void
): Promise<TRes> {
  const start = () => runWorkerTask<TRes>(getProcessWorker(), message, transfer, onProgress)
  const task = tail.then(start, start)
  // 无论成功失败都让队列继续，避免一次异常永久卡死后续任务
  tail = task.catch(() => undefined)
  return task
}
