import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, screen, type IpcMainEvent, type IpcMainInvokeEvent, type Rectangle } from 'electron'
import { GOXF_POPOUT_CHANNELS, type PopoutActionResult, type PopoutPatch } from '@shared/goxfPopout'
import { readJsonFile, writeJsonAtomic } from './jsonFile'
import { attachWebViewManager, moveBotWebViews } from './webViewIpc'

/**
 * GOXF fork: session panes popped out into their own windows (see shared/goxfPopout.ts).
 * goxf-popouts.json maps botId → window bounds; an entry left at quit is reopened at launch,
 * closing a popped window (= dock back) removes it.
 */

type CreateWindow = (query: Record<string, string>, bounds?: Rectangle) => BrowserWindow

const windows = new Map<string, BrowserWindow>()
const pending = new Map<string, (result: PopoutActionResult) => void>()
let getMain: () => BrowserWindow | null = () => null
let createWindow: CreateWindow | null = null
let saved: Record<string, Rectangle> = {}
let saveTimer: ReturnType<typeof setTimeout> | undefined
let quitting = false

const file = (): string => join(app.getPath('userData'), 'goxf-popouts.json')

function persist(): void {
  clearTimeout(saveTimer)
  try {
    writeJsonAtomic(file(), saved)
  } catch (err) {
    console.warn('[popout] could not save bounds', err instanceof Error ? err.message : err)
  }
}

function persistSoon(): void {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(persist, 500)
}

function liveMain(): BrowserWindow | null {
  const win = getMain()
  return win && !win.isDestroyed() && !win.webContents.isDestroyed() ? win : null
}

function notifyChanged(): void {
  liveMain()?.webContents.send(GOXF_POPOUT_CHANNELS.changed, [...windows.keys()])
}

function isPopout(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return [...windows.values()].some((w) => !w.isDestroyed() && w.webContents === event.sender)
}

/** Bounds saved on a monitor that is no longer attached would open off screen. */
function onScreen(bounds: Rectangle): boolean {
  return screen.getAllDisplays().some(({ workArea: a }) =>
    bounds.x < a.x + a.width && bounds.x + bounds.width > a.x && bounds.y < a.y + a.height && bounds.y + bounds.height > a.y)
}

function open(botId: string, bounds?: Rectangle): void {
  const existing = windows.get(botId)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return
  }
  if (!createWindow) return
  const win = createWindow({ popout: botId }, bounds && onScreen(bounds) ? bounds : undefined)
  windows.set(botId, win)
  attachWebViewManager(win)
  const main = liveMain()
  if (main) moveBotWebViews(botId, main, win)
  const remember = (): void => {
    if (win.isDestroyed()) return
    saved[botId] = win.getNormalBounds()
    persistSoon()
  }
  remember()
  win.on('resize', remember)
  win.on('move', remember)
  win.on('close', () => {
    const back = liveMain()
    if (back) moveBotWebViews(botId, win, back)
    // Closing it docks it back; quitting keeps it for the next launch.
    if (quitting) saved[botId] = win.getNormalBounds()
    else delete saved[botId]
    persist()
  })
  win.on('closed', () => {
    if (windows.get(botId) === win) windows.delete(botId)
    notifyChanged()
  })
  notifyChanged()
}

/** Reopen the windows that were popped out when the app last quit. Call once the main window has loaded. */
export function restorePopouts(): void {
  for (const [botId, bounds] of Object.entries(saved)) open(botId, bounds)
}

export function hasPopouts(): boolean {
  return windows.size > 0
}

export function registerPopoutIpc(main: () => BrowserWindow | null, create: CreateWindow): void {
  getMain = main
  createWindow = create
  saved = readJsonFile<Record<string, Rectangle>>(file(), {}, (raw) => typeof raw === 'object' && raw !== null && !Array.isArray(raw))
  app.on('before-quit', () => {
    quitting = true
  })

  ipcMain.handle(GOXF_POPOUT_CHANNELS.open, (_event, botId: unknown) => {
    if (typeof botId === 'string' && botId) open(botId)
  })
  ipcMain.handle(GOXF_POPOUT_CHANNELS.dock, (_event, botId: unknown) => {
    if (typeof botId === 'string') windows.get(botId)?.close()
  })
  ipcMain.handle(GOXF_POPOUT_CHANNELS.focus, (_event, botId: unknown) => {
    if (typeof botId === 'string' && windows.has(botId)) open(botId)
  })
  ipcMain.handle(GOXF_POPOUT_CHANNELS.list, () => [...windows.keys()])

  ipcMain.on(GOXF_POPOUT_CHANNELS.state, (event, patch: PopoutPatch) => {
    if (event.sender !== liveMain()?.webContents) return
    for (const win of windows.values()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(GOXF_POPOUT_CHANNELS.state, patch)
    }
  })
  ipcMain.on(GOXF_POPOUT_CHANNELS.ready, (event) => {
    if (isPopout(event)) liveMain()?.webContents.send(GOXF_POPOUT_CHANNELS.resync)
  })

  // Same relay as mobile sync's sendCommand: the main window renderer runs it and answers by id.
  ipcMain.handle(GOXF_POPOUT_CHANNELS.action, (event, name: unknown, args: unknown) => {
    const target = liveMain()
    if (!isPopout(event) || typeof name !== 'string' || !Array.isArray(args)) {
      return { ok: false, error: 'invalid popout action' } satisfies PopoutActionResult
    }
    if (!target) return { ok: false, error: '主窗口不可用' } satisfies PopoutActionResult
    const contents = target.webContents
    const id = randomUUID()
    return new Promise<PopoutActionResult>((resolve) => {
      const gone = (): void => finish({ ok: false, error: '主窗口已重新加载' })
      const finish = (result: PopoutActionResult): void => {
        pending.delete(id)
        contents.removeListener('destroyed', gone)
        contents.removeListener('render-process-gone', gone)
        resolve(result)
      }
      pending.set(id, finish)
      contents.once('destroyed', gone)
      contents.once('render-process-gone', gone)
      contents.send(GOXF_POPOUT_CHANNELS.action, id, name, args)
    })
  })
  ipcMain.on(GOXF_POPOUT_CHANNELS.actionResult, (event, id: unknown, result: PopoutActionResult) => {
    if (event.sender !== liveMain()?.webContents || typeof id !== 'string') return
    pending.get(id)?.(result)
  })
}
