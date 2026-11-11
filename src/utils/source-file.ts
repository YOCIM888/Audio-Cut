/**
 * 当前工程「原始导入文件」的引用（未解码、未改动的 Blob）。
 * 保存为模块级单例：它不参与渲染、不应进入 Vue 响应式系统。
 * 持久化层订阅变更，把 Blob 写入 IndexedDB；工程包导出时把它原样归档。
 */
export interface SourceFileInfo {
  blob: Blob
  name: string
}

let current: SourceFileInfo | null = null
let listener: ((value: SourceFileInfo | null) => void) | null = null

export function getSourceFile(): SourceFileInfo | null {
  return current
}

/** notify=false 用于「从本地备份恢复」这类不应再次触发落盘的场景 */
export function setSourceFile(info: SourceFileInfo | null, notify = true): void {
  current = info
  if (notify) listener?.(current)
}

export function clearSourceFile(notify = true): void {
  setSourceFile(null, notify)
}

export function onSourceFileChange(fn: (value: SourceFileInfo | null) => void): void {
  listener = fn
}
