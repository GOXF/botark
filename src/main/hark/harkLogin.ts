/**
 * Interactive Hark login via BrowserWindow + account persist partition.
 *
 * Opens app.hark.com/login (Continue with Google → auth.hark.com → Google).
 * Success: GET /api/auth/get-session returns a valid session. Cookies only
 * trigger a probe: they can appear before OAuth finishes or outlive a session.
 * Never prints cookie/token values.
 */

import { BrowserWindow, session as electronSession, shell } from 'electron'
import { applyProxyToPartition } from '../muse/accountProxy'
import { partitionForAccount } from '../webContentsViewManager'
import {
  extractHandle,
  HARK_LOGIN_URL,
  listSessionCookieNames,
  looksLikeSessionCookie,
  type HarkAuthSession
} from './harkClient'
import { probeHarkSession } from './harkSession'
import { harkLoginUserAgentFor, harkNativeUserAgent, isGoogleAuthUrl } from './harkUserAgent'

const ALLOWED_HOST =
  /^(?:[\w-]+\.)*(?:hark\.com|google\.com|googleusercontent\.com|gstatic\.com|googleapis\.com|youtube\.com|chromiumapp\.org|apple\.com|icloud\.com|cloudflare\.com)$/i

const loginWindows = new Map<string, BrowserWindow>()

export type HarkLoginSuccess = {
  accountId: string
  signedIn: true
  handle?: string
  displayName?: string
  sessionCookieNames: string[]
}

export type HarkLoginEvent =
  | HarkLoginSuccess
  | { accountId: string; signedIn: false; windowClosed?: boolean }

export type HarkLoginListener = (event: HarkLoginEvent) => void

let loginListener: HarkLoginListener | undefined

export function onHarkLoginEvent(listener: HarkLoginListener): () => void {
  loginListener = listener
  return () => {
    if (loginListener === listener) loginListener = undefined
  }
}

function emit(event: HarkLoginEvent): void {
  try {
    loginListener?.(event)
  } catch (error) {
    console.error('[hark] login listener failed', error)
  }
}

function hostAllowed(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return ALLOWED_HOST.test(host)
  } catch {
    return false
  }
}

async function probeSignedIn(accountId: string): Promise<{
  session: HarkAuthSession
  cookieNames: string[]
} | null> {
  const probe = await probeHarkSession(accountId)
  if (!('signedIn' in probe)) {
    return { session: probe.session, cookieNames: await listSessionCookieNames(accountId) }
  }
  return null
}

export async function openHarkLoginWindow(accountId: string, parent?: BrowserWindow): Promise<void> {
  const existing = loginWindows.get(accountId)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return
  }

  // Enforce per-account proxy BEFORE probing session or loading app.hark.com/login (fail-closed).
  await applyProxyToPartition(accountId)

  // Already signed in on this partition?
  const already = await probeSignedIn(accountId)
  if (already) {
    const { handle, displayName } = extractHandle(already.session)
    emit({
      accountId,
      signedIn: true,
      handle,
      displayName,
      sessionCookieNames: already.cookieNames
    })
    return
  }

  const partition = partitionForAccount(accountId)
  const ses = electronSession.fromPartition(partition)
  // Turnstile on app.hark.com only passes with Electron's native UA (a
  // hand-edited string no longer matches the engine's own fingerprint). The
  // partition may have been switched to a cleaned UA by another view, so reset.
  const nativeUa = harkNativeUserAgent()
  ses.setUserAgent(nativeUa)
  // Google OAuth rejects UAs naming Electron: rewrite the header for Google only.
  ses.webRequest.onBeforeSendHeaders(
    { urls: ['*://*.google.com/*', '*://accounts.youtube.com/*'] },
    (details, callback) => {
      const headers = { ...details.requestHeaders }
      if (isGoogleAuthUrl(details.url)) {
        const ua = harkLoginUserAgentFor(details.url, nativeUa)
        for (const k of Object.keys(headers)) if (k.toLowerCase() === 'user-agent') delete headers[k]
        headers['User-Agent'] = ua
      }
      callback({ requestHeaders: headers })
    }
  )

  const win = new BrowserWindow({
    width: 1040,
    height: 780,
    minWidth: 720,
    minHeight: 560,
    title: '使用 Hark 登录',
    backgroundColor: '#f7f7f8',
    autoHideMenuBar: true,
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  win.webContents.setUserAgent(nativeUa)
  loginWindows.set(accountId, win)

  // Keep navigator.userAgent in step with the header: cleaned on Google pages,
  // native again as soon as the flow returns to hark.com.
  win.webContents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return
    const want = harkLoginUserAgentFor(details.url, nativeUa)
    if (win.webContents.getUserAgent() !== want) win.webContents.setUserAgent(want)
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (hostAllowed(url)) {
      void win.webContents.loadURL(url)
      return { action: 'deny' }
    }
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (!hostAllowed(url) && /^https?:\/\//.test(url)) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  let settling = false

  const finish = async (): Promise<void> => {
    if (settling || win.isDestroyed()) return
    const hit = await probeSignedIn(accountId)
    if (!hit) return
    settling = true
    const { handle, displayName } = extractHandle(hit.session)
    // Emit BEFORE close so add-bot advances to Name (same race Muse fixed).
    emit({
      accountId,
      signedIn: true,
      handle,
      displayName,
      sessionCookieNames: hit.cookieNames
    })
    try {
      if (!win.isDestroyed()) win.close()
    } catch {
      /* ignore */
    }
  }

  const onNav = (): void => {
    void finish()
  }
  win.webContents.on('did-finish-load', onNav)
  win.webContents.on('did-navigate', onNav)
  win.webContents.on('did-navigate-in-page', onNav)
  win.webContents.on('did-redirect-navigation', onNav)

  const onCookie = (
    _event: unknown,
    cookie: { name: string },
    _cause: string,
    removed: boolean
  ): void => {
    if (!removed && looksLikeSessionCookie(cookie.name)) void finish()
  }
  ses.cookies.on('changed', onCookie)

  win.on('closed', () => {
    ses.cookies.off('changed', onCookie)
    ses.webRequest.onBeforeSendHeaders(null)
    loginWindows.delete(accountId)
    void (async () => {
      if (settling) return
      const hit = await probeSignedIn(accountId)
      if (hit) {
        const { handle, displayName } = extractHandle(hit.session)
        emit({
          accountId,
          signedIn: true,
          handle,
          displayName,
          sessionCookieNames: hit.cookieNames
        })
        return
      }
      emit({ accountId, signedIn: false, windowClosed: true })
    })()
  })

  const poll = setInterval(() => {
    if (win.isDestroyed() || settling) {
      clearInterval(poll)
      return
    }
    void finish()
  }, 1200)
  win.on('closed', () => clearInterval(poll))

  try {
    await win.loadURL(HARK_LOGIN_URL)
  } catch (error) {
    console.error('[hark] openLogin load failed', error)
  }
}

export async function cancelHarkLogin(accountId: string): Promise<void> {
  const win = loginWindows.get(accountId)
  loginWindows.delete(accountId)
  if (win && !win.isDestroyed()) win.destroy()
  try {
    const ses = electronSession.fromPartition(partitionForAccount(accountId))
    await ses.clearStorageData()
  } catch (error) {
    console.error('[hark] clear partition failed', error)
  }
}

/**
 * Close the login window (if any) WITHOUT touching the account partition.
 *
 * Use this after credentials were imported into the partition: unlike
 * `cancelHarkLogin`, it must never call `clearStorageData()`, or the freshly
 * imported session cookies are wiped and the account ends up signed out.
 * Returns true when a window was closed (its `closed` handler then probes the
 * partition and emits `signedIn`).
 */
export function closeHarkLoginWindow(accountId: string): boolean {
  const win = loginWindows.get(accountId)
  if (!win || win.isDestroyed()) return false
  win.close()
  return true
}

export function hasOpenHarkLogin(accountId: string): boolean {
  const win = loginWindows.get(accountId)
  return Boolean(win && !win.isDestroyed())
}
