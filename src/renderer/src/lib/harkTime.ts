/**
 * GOXF: Hark billing times. /billing/summary may send a display string such as
 * "Sat 2026-11-28 6:57 PM CST (UTC+08:00)"; `new Date()` reads "CST" as US Central
 * (UTC-6) and lands 14 hours off, so the "(UTC+08:00)" offset is read explicitly.
 */
const DISPLAY_RE = /(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?[^(]*\(UTC([+-])(\d{2}):?(\d{2})\)/i

export function parseHarkTime(v: unknown): Date | null {
  if (v == null || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? new Date(v < 1e12 ? v * 1000 : v) : null
  const s = String(v)
  const m = s.match(DISPLAY_RE)
  if (m) {
    let hour = Number(m[4]) % (m[7] ? 12 : 24)
    if (m[7]?.toUpperCase() === 'PM') hour += 12
    const offsetMin = (m[8] === '-' ? -1 : 1) * (Number(m[9]) * 60 + Number(m[10]))
    const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, Number(m[5]), Number(m[6] ?? 0)) - offsetMin * 60_000
    return new Date(utc)
  }
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

/** The first parseable time under any of `keys`, searching `objs` in order. */
export function pickTime(objs: Array<Record<string, unknown> | null | undefined>, keys: string[]): Date | null {
  for (const o of objs) {
    if (!o) continue
    for (const k of keys) {
      const d = parseHarkTime(o[k])
      if (d) return d
    }
  }
  return null
}
