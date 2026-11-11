/**
 * 本地工程仓库（IndexedDB）。
 *
 * 关键设计：把「小且频繁变化」的编辑指令与「大且不常变化」的音频数据拆成两个 store。
 *  - session：几 KB 的 JSON（选区 / 视图 / 效果链 / 标志位），可任意频繁写入。
 *  - audio  ：原始 planar Float32 PCM 的 Blob，逐字节等价于 AudioBuffer.getChannelData()，
 *             没有任何有损编码、不做 base64、不经过 JSON.stringify。
 *  - source ：用户导入的原始文件 Blob（未改动），供工程包归档。
 *
 * 所有接口在 IndexedDB 不可用（隐私模式 / 被策略禁用 / 配额失败）时静默降级，
 * 不会阻塞编辑器主流程。
 */
import type { EffectChainState } from '../audio/effect-chain'

export const ACTIVE_ID = 'active'
export const SESSION_VERSION = 3

const DB_NAME = 'yocim-audio-cut'
const DB_VERSION = 1
const STORE_SESSION = 'session'
const STORE_AUDIO = 'audio'
const STORE_SOURCE = 'source'

export interface SessionMeta {
  id: typeof ACTIVE_ID
  version: number
  updatedAt: number
  name: string
  sampleRate: number
  numberOfChannels: number
  length: number
  duration: number
  selection: { start: number; end: number }
  view: { zoom: number; scrollX: number; vGain: number }
  zeroSnap: boolean
  isLooping: boolean
  volume: number
  sidebarTab: string
  chain: EffectChainState
  /** 当前 session 对应的 audio 记录版本；刷新时用于检测音频是否落后于指令 */
  audioKey: number
  audioBytes: number
  /** 音频超出自动保存上限时仍保存指令，但明确标记音轨未落盘 */
  audioOversize: boolean
  sourceName: string | null
}

/** planar Float32：blob 内依次为 ch0/ch1/...，每段 length * 4 字节 */
export interface AudioRecord {
  id: typeof ACTIVE_ID
  updatedAt: number
  sampleRate: number
  numberOfChannels: number
  length: number
  bytes: number
  blob: Blob
}

export interface SourceRecord {
  id: typeof ACTIVE_ID
  updatedAt: number
  name: string
  type: string
  bytes: number
  blob: Blob
}

let dbPromise: Promise<IDBDatabase | null> | null = null
let unavailable = false
let unavailableReason = ''

function openDB(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      unavailable = true
      unavailableReason = '当前环境不支持 IndexedDB'
      resolve(null)
      return
    }
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch (err) {
      unavailable = true
      unavailableReason = err instanceof Error ? err.message : '无法打开本地数据库'
      resolve(null)
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_SESSION)) db.createObjectStore(STORE_SESSION, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(STORE_AUDIO)) db.createObjectStore(STORE_AUDIO, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(STORE_SOURCE)) db.createObjectStore(STORE_SOURCE, { keyPath: 'id' })
    }
    req.onsuccess = () => {
      const db = req.result
      db.onversionchange = () => db.close()
      resolve(db)
    }
    req.onerror = () => {
      unavailable = true
      unavailableReason = req.error?.message || '本地数据库打开失败'
      resolve(null)
    }
    req.onblocked = () => {
      unavailable = true
      unavailableReason = '本地数据库被其他标签页占用'
      resolve(null)
    }
  })
  return dbPromise
}

export function persistenceUnavailableReason(): string {
  return unavailableReason
}

function request<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDB().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null)
          return
        }
        try {
          const tx = db.transaction(store, mode)
          const req = run(tx.objectStore(store))
          req.onsuccess = () => resolve(req.result ?? null)
          req.onerror = () => {
            const msg = req.error?.message || ''
            if (/quota/i.test(req.error?.name ?? '') || /quota/i.test(msg)) {
              // 配额错误交给调用方降级，不把整个仓库标记为不可用
              console.warn('[project-db] 存储空间不足', msg)
            }
            resolve(null)
          }
          tx.onabort = () => resolve(null)
        } catch (err) {
          console.warn('[project-db] 事务失败', err)
          resolve(null)
        }
      })
  )
}

function put(store: string, value: unknown): Promise<boolean> {
  return request<IDBValidKey>(store, 'readwrite', (s) => s.put(value as never)).then((key) => key !== null)
}

function get<T>(store: string): Promise<T | null> {
  return request<T>(store, 'readonly', (s) => s.get(ACTIVE_ID) as IDBRequest<T>)
}

function del(store: string): Promise<boolean> {
  return request<undefined>(store, 'readwrite', (s) => s.delete(ACTIVE_ID) as IDBRequest<undefined>).then(
    () => true
  )
}

export async function readSession(): Promise<SessionMeta | null> {
  const row = await get<SessionMeta>(STORE_SESSION)
  if (!row || row.id !== ACTIVE_ID || !Number.isFinite(row.length)) return null
  return row
}

export function writeSession(meta: SessionMeta): Promise<boolean> {
  return put(STORE_SESSION, meta)
}

export async function readAudio(): Promise<AudioRecord | null> {
  const row = await get<AudioRecord>(STORE_AUDIO)
  if (!row || !(row.blob instanceof Blob) || !Number.isFinite(row.length)) return null
  return row
}

export function writeAudio(rec: AudioRecord): Promise<boolean> {
  return put(STORE_AUDIO, rec)
}

export async function readSource(): Promise<SourceRecord | null> {
  const row = await get<SourceRecord>(STORE_SOURCE)
  if (!row || !(row.blob instanceof Blob)) return null
  return row
}

export function writeSource(rec: SourceRecord): Promise<boolean> {
  return put(STORE_SOURCE, rec)
}

export function deleteSource(): Promise<boolean> {
  return del(STORE_SOURCE)
}

export async function clearSession(): Promise<void> {
  await Promise.all([del(STORE_SESSION), del(STORE_AUDIO), del(STORE_SOURCE)])
}

export async function isPersistenceAvailable(): Promise<boolean> {
  if (unavailable) return false
  const db = await openDB()
  return db !== null
}

export interface StorageInfo {
  usage: number
  quota: number
}

/** navigator.storage.estimate() 不可用时返回 0，由调用方按「未知」处理 */
export async function storageEstimate(): Promise<StorageInfo> {
  try {
    const est = await navigator.storage?.estimate?.()
    return { usage: est?.usage ?? 0, quota: est?.quota ?? 0 }
  } catch {
    return { usage: 0, quota: 0 }
  }
}
