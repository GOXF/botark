/**
 * GOXF fork only: startup time + memory log for portable builds.
 * Writes to <BotArk-Data>/perf.log so a real Windows run gives numbers
 * before we optimize memory or speed. No-op outside portable mode.
 */
import { appendFileSync, statSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { PORTABLE_DATA_DIR } from './goxfPortable'

const MEMORY_INTERVAL_MS = 10 * 60 * 1000
const MAX_LOG_BYTES = 512 * 1024

function logLine(text: string): void {
  if (!PORTABLE_DATA_DIR) return
  const file = join(PORTABLE_DATA_DIR, 'perf.log')
  try {
    if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.old`)
  } catch {
    // no log yet
  }
  try {
    appendFileSync(file, `${new Date().toISOString()} ${text}\n`)
  } catch {
    // logging must never break the app
  }
}

/** Working set per process type, in MB (getAppMetrics reports KB). */
export function memorySummary(): string {
  const byType = new Map<string, { count: number; kb: number }>()
  for (const m of app.getAppMetrics()) {
    const entry = byType.get(m.type) ?? { count: 0, kb: 0 }
    entry.count += 1
    entry.kb += m.memory.workingSetSize
    byType.set(m.type, entry)
  }
  let totalKb = 0
  const parts: string[] = []
  for (const [type, { count, kb }] of byType) {
    totalKb += kb
    parts.push(`${type}x${count}=${Math.round(kb / 1024)}MB`)
  }
  return `total=${Math.round(totalKb / 1024)}MB ${parts.join(' ')}`
}

export function startPerfLog(win: BrowserWindow): void {
  if (!PORTABLE_DATA_DIR) return
  logLine(`start v${app.getVersion()} window-created=${process.uptime().toFixed(2)}s`)
  win.once('ready-to-show', () => {
    logLine(`window-shown=${process.uptime().toFixed(2)}s ${memorySummary()}`)
  })
  setInterval(() => logLine(`mem ${memorySummary()}`), MEMORY_INTERVAL_MS).unref()
}
