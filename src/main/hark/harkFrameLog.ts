/**
 * GOXF fork only: a small diagnostic log of Hark /sync/conversation frames.
 * Writes <BotArk-Data>/hark-frames.log (portable builds only) so we can see which
 * field carries the web app's live status line when BotArk shows only 「处理中…」.
 * Records op names, snapshot keys and any narration/activity/status-like values, capped at 1 MB.
 */
import { appendFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PORTABLE_DATA_DIR } from '../goxfPortable'

const MAX_BYTES = 4 * 1024 * 1024
const TASK_KEYS = ['requests', 'threads', 'activeWork', 'activeActivity', 'log', 'windows'] as const
const TASK_OPS = /request|work|activity|helper|thread|tool|panel|window|entry_add|log/i
const INTERESTING = /narrat|activit|status|wait|progress|thinking|line|label/i

function write(text: string): void {
  if (!PORTABLE_DATA_DIR) return
  const file = join(PORTABLE_DATA_DIR, 'hark-frames.log')
  try {
    if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.old`)
  } catch {
    // no log yet
  }
  try {
    appendFileSync(file, `${new Date().toISOString()} ${text}\n`)
  } catch {
    // never break the app
  }
}

function pick(obj: unknown, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!obj || typeof obj !== 'object' || depth > 3) return out
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k === 'content' || k === 'text' && depth > 1) continue
    if (INTERESTING.test(k) && (typeof v !== 'object' || v === null)) out[k] = typeof v === 'string' ? v.slice(0, 160) : v
    else if (INTERESTING.test(k)) out[k] = JSON.stringify(v).slice(0, 300)
    else if (v && typeof v === 'object') {
      const inner = pick(v, depth + 1)
      if (Object.keys(inner).length) out[k] = inner
    }
  }
  return out
}

export function logHarkFrame(conversationId: string, raw: string): void {
  if (!PORTABLE_DATA_DIR) return
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return
  }
  const conv = conversationId.slice(0, 8)
  if (parsed['type'] === 'snapshot') {
    const data = (parsed['data'] ?? {}) as Record<string, unknown>
    write(`${conv} snapshot keys=${Object.keys(data).join(',')} ${JSON.stringify(pick(data)).slice(0, 1500)}`)
    // v25 任务: how Hark groups concurrent work (per request) — keep these whole.
    for (const key of TASK_KEYS) if (key in data) write(`${conv} snapshot.${key} ${JSON.stringify(data[key]).slice(0, 20_000)}`)
  } else if (parsed['type'] === 'patches') {
    const list = Array.isArray(parsed['data']) ? (parsed['data'] as Array<Record<string, unknown>>) : []
    for (const p of list) {
      const op = String(p['op'] ?? '')
      if (op === 'message_update' && !INTERESTING.test(JSON.stringify(Object.keys((p['fields'] ?? {}) as object)))) continue
      write(`${conv} ${op} ${TASK_OPS.test(op) ? JSON.stringify(p).slice(0, 4000) : JSON.stringify(pick(p)).slice(0, 800)}`)
    }
  } else {
    write(`${conv} type=${String(parsed['type'])}`)
  }
}
