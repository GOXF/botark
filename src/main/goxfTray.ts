/** GOXF fork: close-to-tray on Windows/Linux. The tray menu's 退出 BotArk is the real quit. */
import { app, ipcMain, Menu, Notification, Tray, type BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getAppWindowIcon } from './appIcon'
import { GOXF_TRAY_CHANNELS, normalizeCloseBehavior, type GoxfCloseBehavior } from '@shared/goxfTray'

const settingsFile = (): string => join(app.getPath('userData'), 'goxf-tray.json')
let behavior: GoxfCloseBehavior | null = null
let hintShown = false
let tray: Tray | null = null

function load(): GoxfCloseBehavior {
  if (behavior) return behavior
  try {
    const saved = JSON.parse(readFileSync(settingsFile(), 'utf8')) as { closeBehavior?: unknown; hintShown?: unknown }
    behavior = normalizeCloseBehavior(saved.closeBehavior)
    hintShown = saved.hintShown === true
  } catch {
    behavior = 'tray'
  }
  return behavior
}

function save(): void {
  try {
    writeFileSync(settingsFile(), JSON.stringify({ closeBehavior: load(), hintShown }))
  } catch {
    /* keep the in-memory value */
  }
}

export const closeToTray = (): boolean => process.platform !== 'darwin' && load() === 'tray'

export function registerTrayIpc(): void {
  ipcMain.handle(GOXF_TRAY_CHANNELS.get, () => load())
  ipcMain.handle(GOXF_TRAY_CHANNELS.set, (_e, value: unknown) => {
    behavior = normalizeCloseBehavior(value)
    save()
    return behavior
  })
}

function reveal(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function ensureTray(getWin: () => BrowserWindow | null): void {
  if (tray && !tray.isDestroyed()) return
  const icon = getAppWindowIcon()
  if (!icon) return
  tray = new Tray(icon)
  tray.setToolTip('BotArk')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 BotArk', click: () => { const w = getWin(); if (w) reveal(w) } },
      { type: 'separator' },
      { label: '退出 BotArk', click: () => app.quit() }
    ])
  )
  tray.on('click', () => {
    const w = getWin()
    if (!w || w.isDestroyed()) return
    if (w.isVisible() && w.isFocused()) w.hide()
    else reveal(w)
  })
}

/** Called from the main window's close handler. Returns true when the close was turned into a hide. */
export function hideToTray(win: BrowserWindow, getWin: () => BrowserWindow | null): boolean {
  if (!closeToTray()) return false
  ensureTray(getWin)
  if (!tray) return false // no icon: hiding would leave no way back
  win.hide()
  if (!hintShown) {
    hintShown = true
    save()
    try {
      if (Notification.isSupported()) {
        new Notification({ title: 'BotArk 还在托盘里运行', body: '右键托盘图标选「退出 BotArk」才会真正退出，可在设置里改。' }).show()
      }
    } catch {
      /* hint only */
    }
  }
  return true
}

/** Create the tray at startup when the setting is on, so the icon is there before the first close. */
export function startTray(getWin: () => BrowserWindow | null): void {
  if (closeToTray()) ensureTray(getWin)
}
