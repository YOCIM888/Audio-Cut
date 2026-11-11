/** 标记点 / Cue 列表：纯数据模型，供 store、工程文件与 CSV 导入导出共用 */

export interface Marker {
  id: string
  /** 秒 */
  time: number
  label: string
}

let counter = 0
export function newMarkerId(): string {
  counter += 1
  return `mk-${Date.now().toString(36)}-${counter.toString(36)}`
}

export function sortMarkers(list: Marker[]): Marker[] {
  return list.slice().sort((a, b) => a.time - b.time || a.label.localeCompare(b.label))
}

/** 外部输入（工程文件 / CSV）必须逐字段校验，避免 NaN 时间进入波形绘制 */
export function sanitizeMarkers(raw: unknown, duration = Infinity): Marker[] {
  if (!Array.isArray(raw)) return []
  const out: Marker[] = []
  for (const item of raw.slice(0, 500)) {
    if (!item || typeof item !== 'object') continue
    const m = item as Record<string, unknown>
    const time = Number(m.time)
    if (!Number.isFinite(time) || time < 0) continue
    out.push({
      id: typeof m.id === 'string' && m.id.length < 64 ? m.id : newMarkerId(),
      time: Math.min(Math.max(0, time), Number.isFinite(duration) ? duration : time),
      label: typeof m.label === 'string' ? m.label.slice(0, 80) : ''
    })
  }
  return sortMarkers(out)
}

export function formatMarkerTime(t: number): string {
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  const ms = Math.floor((t % 1) * 1000)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

export function markersToCsv(list: Marker[]): string {
  const rows = ['time,label']
  for (const m of sortMarkers(list)) rows.push(`${m.time.toFixed(3)},${csvCell(m.label)}`)
  return rows.join('\n')
}

/** 支持 "12.5, 名称" 或 "00:01:02.500, 名称" 两种时间写法 */
export function csvToMarkers(text: string): Marker[] {
  const out: Marker[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || /^time\s*[,;\t]/i.test(trimmed)) continue
    const match = trimmed.match(/^([^,;]+)[,;]\s*(.*)$/)
    if (!match) continue
    const rawTime = match[1].trim().replace(/^"|"$/g, '')
    let time = Number(rawTime)
    if (!Number.isFinite(time)) {
      const parts = rawTime.split(':')
      if (parts.length === 2 || parts.length === 3) {
        time = parts.reduce((acc, p) => acc * 60 + Number(p), 0)
        if (parts.length === 3) time = Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2])
      }
    }
    if (!Number.isFinite(time) || time < 0) continue
    const label = match[2].trim().replace(/^"(.*)"$/, '$1').replace(/""/g, '"')
    out.push({ id: newMarkerId(), time, label })
  }
  return sortMarkers(sanitizeMarkers(out))
}
