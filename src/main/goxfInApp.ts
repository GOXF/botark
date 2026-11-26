import { BrowserWindow, Menu, clipboard, ipcMain, shell } from 'electron'
import {
  GOXF_INAPP_CHANNELS,
  reachedDoneUrl,
  type InAppOpenRequest,
  type InAppOpenResult
} from '@shared/goxfInApp'
import { partitionForAccount } from './webContentsViewManager'

/**
 * GOXF fork: chat links and Hark connect flows open in a BotArk window first, so an OAuth
 * flow that returns to app.hark.com lands in the same account session and the chat can react.
 * The window menu (and Ctrl+Shift+O) moves the page to the system browser when a site refuses it.
 */
const LINKS_PARTITION = 'persist:botark-links'
const isHttp = (url: string) => /^https?:\/\//i.test(url)

function openExternal(url: string): InAppOpenResult {
  if (isHttp(url)) void shell.openExternal(url)
  return { result: 'external', url }
}

export function openInApp(req: InAppOpenRequest): Promise<InAppOpenResult> {
  const url = String(req.url || '')
  if (!isHttp(url)) return Promise.resolve({ result: 'closed' })
  if (req.external) return Promise.resolve(openExternal(url))

  return new Promise((resolve) => {
    let settled: InAppOpenResult | null = null
    const settle = (r: InAppOpenResult) => {
      if (!settled) {
        settled = r
        resolve(r)
      }
    }
    const partition = req.accountId ? partitionForAccount(req.accountId) : LINKS_PARTITION
    const win = new BrowserWindow({
      width: 1040,
      height: 780,
      minWidth: 420,
      minHeight: 420,
      title: 'BotArk',
      backgroundColor: '#ffffff',
      autoHideMenuBar: false,
      webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true }
    })
    const wc = win.webContents
    const current = () => (win.isDestroyed() ? url : wc.getURL() || url)
    const toBrowser = () => {
      settle(openExternal(current()))
      if (!win.isDestroyed()) win.close()
    }
    win.setMenu(
      Menu.buildFromTemplate([
        { label: '后退', accelerator: 'Alt+Left', click: () => wc.navigationHistory.canGoBack() && wc.navigationHistory.goBack() },
        { label: '前进', accelerator: 'Alt+Right', click: () => wc.navigationHistory.canGoForward() && wc.navigationHistory.goForward() },
        { label: '刷新', accelerator: 'F5', click: () => wc.reload() },
        { label: '在浏览器打开', accelerator: 'CmdOrCtrl+Shift+O', click: toBrowser },
        { label: '复制链接', click: () => clipboard.writeText(current()) },
        { label: '关闭', accelerator: 'CmdOrCtrl+W', click: () => win.close() }
      ])
    )
    const check = (_e: unknown, next: string) => {
      if (req.doneUrlPrefix && reachedDoneUrl(next, req.doneUrlPrefix)) {
        settle({ result: 'done', url: next })
        setTimeout(() => !win.isDestroyed() && win.close(), 800)
      }
    }
    wc.on('did-navigate', check)
    wc.on('did-redirect-navigation', (e, next) => check(e, next))
    wc.on('did-navigate-in-page', check)
    // OAuth pages may open a popup: keep it in this session (http only).
    wc.setWindowOpenHandler(({ url: popup }) =>
      isHttp(popup)
        ? { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { partition, sandbox: true, contextIsolation: true } } }
        : { action: 'deny' }
    )
    wc.on('page-title-updated', (_e, title) => !win.isDestroyed() && win.setTitle(`${title} · BotArk`))
    win.on('closed', () => settle({ result: 'closed', url }))
    void win.loadURL(url).catch(() => {
      /* load errors show in the page; the menu can still move it to the browser */
    })
  })
}

export function registerInAppIpc(): void {
  ipcMain.handle(GOXF_INAPP_CHANNELS.open, (_event, req: InAppOpenRequest) => openInApp(req ?? { url: '' }))
}
