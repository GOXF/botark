import { app, ipcMain, net, shell, webContents } from 'electron'
import { createWriteStream, existsSync } from 'node:fs'
import { rename, unlink } from 'node:fs/promises'
import { join, parse } from 'node:path'
import { GOXF_DOWNLOAD_CHANNELS, downloadFileName, type GoxfDownloadEvent } from '@shared/goxfDownload'

const running = new Map<string, AbortController>()

function uniquePath(dir: string, name: string): string {
  const { name: base, ext } = parse(name)
  let p = join(dir, name)
  for (let i = 1; existsSync(p) || existsSync(p + '.part'); i++) p = join(dir, `${base} (${i})${ext}`)
  return p
}

export function registerDownloadIpc(): void {
  ipcMain.handle(GOXF_DOWNLOAD_CHANNELS.start, async (event, req: { id: string; url: string; filename?: string }) => {
    const senderId = event.sender.id
    const send = (e: GoxfDownloadEvent) => {
      const wc = webContents.fromId(senderId)
      if (wc && !wc.isDestroyed()) wc.send(GOXF_DOWNLOAD_CHANNELS.event, e)
    }
    if (!/^https?:\/\//i.test(req.url)) return { ok: false, error: 'Only http(s) links' }
    const ctrl = new AbortController()
    running.get(req.id)?.abort()
    running.set(req.id, ctrl)
    const target = uniquePath(app.getPath('downloads'), downloadFileName(req.url, req.filename))
    const part = target + '.part'
    let received = 0
    let total = 0
    try {
      // Chromium's network stack: honours the system proxy like the portable updater.
      const res = await net.fetch(req.url, { signal: ctrl.signal, redirect: 'follow' })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      total = Number(res.headers.get('content-length')) || 0
      const out = createWriteStream(part)
      const reader = res.body.getReader()
      let last = 0
      send({ id: req.id, received, total, state: 'progress' })
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
        const now = Date.now()
        if (now - last > 250) { last = now; send({ id: req.id, received, total, state: 'progress' }) }
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
      await rename(part, target)
      send({ id: req.id, received, total, state: 'done', path: target })
      return { ok: true, path: target }
    } catch (err) {
      await unlink(part).catch(() => {})
      const cancelled = ctrl.signal.aborted
      const error = err instanceof Error ? err.message : String(err)
      send({ id: req.id, received, total, state: cancelled ? 'cancelled' : 'error', error: cancelled ? undefined : error })
      return { ok: false, error: cancelled ? 'cancelled' : error }
    } finally {
      if (running.get(req.id) === ctrl) running.delete(req.id)
    }
  })
  ipcMain.handle(GOXF_DOWNLOAD_CHANNELS.cancel, (_e, id: string) => { running.get(id)?.abort() })
  ipcMain.handle(GOXF_DOWNLOAD_CHANNELS.reveal, (_e, path: string) => {
    if (typeof path === 'string' && path.startsWith(app.getPath('downloads'))) shell.showItemInFolder(path)
  })
}
