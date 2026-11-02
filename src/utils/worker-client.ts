/** Web Worker 通信封装：统一的 progress / done / error 消息协议 */

export interface WorkerProgressMsg {
  type: 'progress'
  progress: number
}

export interface WorkerErrorMsg {
  type: 'error'
  message: string
}

export type WorkerResponse<T> =
  | { type: 'done'; data: T }
  | WorkerProgressMsg
  | WorkerErrorMsg

export function runWorkerTask<TRes>(
  worker: Worker,
  message: unknown,
  transfer: Transferable[],
  onProgress?: (p: number) => void
): Promise<TRes> {
  return new Promise<TRes>((resolve, reject) => {
    const onMessage = (e: MessageEvent) => {
      const msg = e.data as WorkerResponse<TRes>
      if (msg.type === 'progress') {
        onProgress?.(msg.progress)
      } else if (msg.type === 'done') {
        cleanup()
        resolve(msg.data)
      } else {
        cleanup()
        reject(new Error(msg.message))
      }
    }
    const onError = (e: ErrorEvent) => {
      cleanup()
      reject(new Error(e.message || 'Worker 运行错误'))
    }
    const cleanup = () => {
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
    }
    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)
    worker.postMessage(message, transfer)
  })
}
