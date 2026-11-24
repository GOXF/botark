/**
 * GOXF fork only: startup time + memory log for portable builds.
 * Writes to <BotArk-Data>/perf.log so a real Windows run gives numbers
 * before we optimize memory or speed. No-op outside portable mode.
 */
import { appendFileSync, statSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, webContents } from 'electron'
import { PORTABLE_DATA_DIR } from './goxfPortable'

const MEMORY_INTERVAL_MS = 10 * 60 * 1000
const MAX_LOG_BYTES = 512 * 1024

export function logLine(text: string): void {
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
  const utility = app
    .getAppMetrics()
    .filter((m) => m.type === 'Utility')
    .map((m) => `${m.serviceName ?? m.name ?? '?'}=${Math.round(m.memory.workingSetSize / 1024)}MB`)
  return `total=${Math.round(totalKb / 1024)}MB ${parts.join(' ')}${utility.length ? ` utility[${utility.join(',')}]` : ''}`
}

/**
 * What the main window's page holds: JS heap, DOM size, and how much image
 * bitmap the visible <img>s could decode to. Tells us whether renderer growth
 * is script memory or pictures/DOM.
 */
const RENDERER_PROBE = `(() => {
  const mb = (b) => Math.round(b / 1048576)
  const m = performance.memory || {}
  const imgs = Array.from(document.images)
  let px = 0, blobs = 0
  for (const i of imgs) { px += (i.naturalWidth || 0) * (i.naturalHeight || 0); if (i.src.startsWith('blob:')) blobs++ }
  return 'heap=' + mb(m.usedJSHeapSize || 0) + '/' + mb(m.totalJSHeapSize || 0) + 'MB'
    + ' nodes=' + document.getElementsByTagName('*').length
    + ' imgs=' + imgs.length + ' imgBitmap~' + mb(px * 4) + 'MB blobImgs=' + blobs
    + ' iframes=' + document.querySelectorAll('iframe,webview').length
})()`

async function rendererSummary(win: BrowserWindow): Promise<string> {
  const others = webContents.getAllWebContents().length
  const wins = BrowserWindow.getAllWindows().length
  if (win.isDestroyed()) return `windows=${wins} webContents=${others}`
  try {
    const page = (await win.webContents.executeJavaScript(RENDERER_PROBE, true)) as string
    return `${page} windows=${wins} webContents=${others}`
  } catch {
    return `probe-failed windows=${wins} webContents=${others}`
  }
}

export function startPerfLog(win: BrowserWindow): void {
  if (!PORTABLE_DATA_DIR) return
  logLine(`start v${app.getVersion()} window-created=${process.uptime().toFixed(2)}s`)
  win.once('ready-to-show', () => {
    logLine(`window-shown=${process.uptime().toFixed(2)}s ${memorySummary()}`)
  })
  setInterval(() => {
    void rendererSummary(win).then((page) => logLine(`mem ${memorySummary()} ${page}`))
  }, MEMORY_INTERVAL_MS).unref()
}
