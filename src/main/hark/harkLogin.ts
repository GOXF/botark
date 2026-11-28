import { nativeDisplayCopy } from '../nativeDisplayCopy'
/**
 * Interactive Hark login via BrowserWindow + account persist partition.
 *
 * Opens app.hark.com/login (Continue with Google → auth.hark.com → Google).
 * Account profile and session probes verify login. Cookie changes trigger
 * another probe because OAuth can set cookies before the session is usable.
 * Never prints cookie/token values.
 */

import { BrowserWindow, session as electronSession, shell, type WebContents } from 'electron'
import { getAppWindowIcon } from '../appIcon'
import {
  attachGoogleOAuthWebContentsGuard,
  buildGoogleFallbackBannerScript,
  buildGoogleFirefoxCompatUa,
  GOOGLE_BLOCK_CHECK_SCRIPT,
  installGoogleOAuthHeaderGuard,
  isGoogleBlockedOrPasskeyText,
  setGoogleFirefoxCompatMode
} from '../googleOAuthUaGuard'
import { applyProxyToPartition } from '../muse/accountProxy'
import { partitionForAccount } from '../webContentsViewManager'
import {
  extractHandle,
  HARK_LOGIN_URL,
  listSessionCookieNames,
  looksLikeSessionCookie,
  withHarkCredentials,
  type HarkAuthSession
} from './harkClient'
import { probeHarkSession } from './harkSession'

const ALLOWED_HOST =
  /^(?:[\w-]+\.)*(?:hark\.com|google\.com|googleusercontent\.com|gstatic\.com|googleapis\.com|youtube\.com|chromiumapp\.org|apple\.com|icloud\.com|cloudflare\.com)$/i

const loginWindows = new Map<string, BrowserWindow>()
type HarkLoginResult = { session: HarkAuthSession; cookieNames: string[] }
interface HarkLoginAttempt {
  cleanup?: () => void
  checking?: Promise<void>
  closing?: boolean
}
const loginAttempts = new Map<string, HarkLoginAttempt>()

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
  if (!url || url === 'about:blank') return true
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    return ALLOWED_HOST.test(parsed.hostname)
  } catch {
    return false
  }
}

async function probeSignedIn(accountId: string): Promise<HarkLoginResult | null> {
  return withHarkCredentials(accountId, async () => {
    try {
      const probe = await probeHarkSession(accountId)
      if (!('signedIn' in probe)) {
        return { session: probe.session, cookieNames: await listSessionCookieNames(accountId) }
      }
    } catch { /* A transient error can be retried by the login window. */ }
    return null
  })
}

function settleLogin(accountId: string, attempt: HarkLoginAttempt, hit: HarkLoginResult | null, silent = false): void {
  if (loginAttempts.get(accountId) !== attempt) return
  loginAttempts.delete(accountId)
  const win = loginWindows.get(accountId)
  if (!silent) {
    if (hit) emit({
      accountId, signedIn: true, ...extractHandle(hit.session), sessionCookieNames: hit.cookieNames
    })
    else emit({ accountId, signedIn: false, windowClosed: true })
  }
  attempt.cleanup?.()
  if (loginWindows.get(accountId) === win) loginWindows.delete(accountId)
  if (win && !win.isDestroyed()) win.destroy()
}

export async function openHarkLoginWindow(accountId: string, parent?: BrowserWindow): Promise<void> {
  const existing = loginWindows.get(accountId)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return
  }
  const previous = loginAttempts.get(accountId)
  if (previous && !previous.closing) return
  const attempt: HarkLoginAttempt = {}
  loginAttempts.set(accountId, attempt)
  const current = () => loginAttempts.get(accountId) === attempt

  // Enforce per-account proxy BEFORE probing session or loading app.hark.com/login (fail-closed).
  try {
    await applyProxyToPartition(accountId)
  } catch (error) {
    settleLogin(accountId, attempt, null, true)
    throw error
  }
  if (!current()) return

  // Already signed in on this partition?
  const already = await probeSignedIn(accountId)
  if (!current()) return
  if (already) {
    settleLogin(accountId, attempt, already)
    return
  }

  const partition = partitionForAccount(accountId)
  const ses = electronSession.fromPartition(partition)
  installGoogleOAuthHeaderGuard(ses)

  const windowIcon = getAppWindowIcon()
  const win = new BrowserWindow({
    width: 1040,
    height: 780,
    minWidth: 720,
    minHeight: 560,
    title: nativeDisplayCopy("使用 Hark 登录", "Sign in to Hark"),
    backgroundColor: '#f7f7f8',
    autoHideMenuBar: true,
    ...(windowIcon ? { icon: windowIcon } : {}),
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  loginWindows.set(accountId, win)

  const childPopups = new Set<BrowserWindow>()
  const closeChildPopups = () => {
    for (const child of childPopups) {
      try {
        if (!child.isDestroyed()) child.close()
      } catch {
        /* ignore */
      }
    }
    childPopups.clear()
  }

  let handedOffToBrowser = false
  let lastBlockCheckAt = 0

  const maybeShowGoogleFallbackBanner = async (wc: WebContents): Promise<void> => {
    if (!current() || attempt.closing || wc.isDestroyed()) return
    try {
      const currentUrl = wc.getURL()
      if (!/^https:\/\/accounts\.(?:google|youtube)\.com\//i.test(currentUrl)) return
      const now = Date.now()
      if (now - lastBlockCheckAt < 150) return
      lastBlockCheckAt = now
      const bodyText = await wc.executeJavaScript(GOOGLE_BLOCK_CHECK_SCRIPT, true)
      if (!current() || attempt.closing) return
      if (!isGoogleBlockedOrPasskeyText(bodyText, currentUrl)) return
      if (!handedOffToBrowser) {
        handedOffToBrowser = true
        void shell.openExternal(HARK_LOGIN_URL)
      }
      await wc.executeJavaScript(
        buildGoogleFallbackBannerScript({
          title: nativeDisplayCopy("Google 登录受限或需要通行密钥", "Google sign-in is restricted or requires a passkey."),
          detail: nativeDisplayCopy("可尝试兼容模式重试，或在系统浏览器打开 Hark 登录后使用「粘贴凭据导入」。", "Retry here, or sign in to Hark in your browser. Browser sign-in alone does not connect BotArk; return to Add Bot to complete the account import."),
          buttonLabel: nativeDisplayCopy("在系统浏览器打开", "Open in browser"),
          actionUrl: 'botark-external://open',
          secondaryActions: [
            { label: nativeDisplayCopy("尝试兼容模式重试", "Retry in compatibility mode"), actionUrl: 'botark-action://retry-firefox-ua' },
            { label: nativeDisplayCopy("返回 Hark 登录页", "Back to Hark sign-in"), actionUrl: 'botark-action://back-to-login' }
          ]
        }),
        true
      )
    } catch {
      /* ignore transient navigation states */
    }
  }

  const attachNavigationGuards = (wc: WebContents, parentForChild: BrowserWindow) => {
    attachGoogleOAuthWebContentsGuard(wc, ses)

    const retryWithFirefoxUa = () => {
      setGoogleFirefoxCompatMode(ses, true)
      if (!wc.isDestroyed()) {
        wc.setUserAgent(buildGoogleFirefoxCompatUa())
        if (/^https:\/\/accounts\.(?:google|youtube)\.com\//i.test(wc.getURL())) {
          void wc.loadURL(HARK_LOGIN_URL).catch(() => undefined)
        } else {
          wc.reload()
        }
      }
    }

    const backToLogin = () => {
      setGoogleFirefoxCompatMode(ses, false)
      closeChildPopups()
      if (!win.isDestroyed()) {
        void win.loadURL(HARK_LOGIN_URL).catch(() => undefined)
      }
    }

    wc.setWindowOpenHandler(({ url }) => {
      if (url === 'botark-external://open') {
        void shell.openExternal(HARK_LOGIN_URL)
        return { action: 'deny' }
      }
      if (url === 'botark-action://retry-firefox-ua') {
        retryWithFirefoxUa()
        return { action: 'deny' }
      }
      if (url === 'botark-action://back-to-login') {
        backToLogin()
        return { action: 'deny' }
      }
      if (hostAllowed(url)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 540,
            height: 700,
            title: nativeDisplayCopy("Hark 安全登录", "Hark secure sign-in"),
            autoHideMenuBar: true,
            ...(windowIcon ? { icon: windowIcon } : {}),
            parent: parentForChild.isDestroyed() ? undefined : parentForChild,
            webPreferences: {
              partition,
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false
            }
          }
        }
      }
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })

    wc.on('will-navigate', (event, url) => {
      if (url === 'botark-external://open') {
        event.preventDefault()
        void shell.openExternal(HARK_LOGIN_URL)
        return
      }
      if (url === 'botark-action://retry-firefox-ua') {
        event.preventDefault()
        retryWithFirefoxUa()
        return
      }
      if (url === 'botark-action://back-to-login') {
        event.preventDefault()
        backToLogin()
        return
      }
      if (!hostAllowed(url) && /^https?:\/\//i.test(url)) {
        event.preventDefault()
        void shell.openExternal(url)
      }
    })
  }

  attachNavigationGuards(win.webContents, win)

  const finish = (): void => {
    if (!current() || attempt.checking) return
    attempt.checking = probeSignedIn(accountId).then((hit) => {
      if (current() && (hit || attempt.closing)) settleLogin(accountId, attempt, hit)
    }).finally(() => { attempt.checking = undefined })
  }

  const onNav = (wc: WebContents): void => {
    void finish()
    void maybeShowGoogleFallbackBanner(wc)
  }
  win.webContents.on('did-finish-load', () => onNav(win.webContents))
  win.webContents.on('did-navigate', () => onNav(win.webContents))
  win.webContents.on('did-navigate-in-page', () => onNav(win.webContents))
  win.webContents.on('did-redirect-navigation', () => onNav(win.webContents))

  const trackChildWindow = (childWin: BrowserWindow) => {
    childPopups.add(childWin)
    attachNavigationGuards(childWin.webContents, childWin)
    childWin.webContents.on('did-finish-load', () => onNav(childWin.webContents))
    childWin.webContents.on('did-navigate', () => onNav(childWin.webContents))
    childWin.webContents.on('did-navigate-in-page', () => onNav(childWin.webContents))
    childWin.webContents.on('did-redirect-navigation', () => onNav(childWin.webContents))
    childWin.webContents.on('did-create-window', (nested) => trackChildWindow(nested))
    childWin.on('closed', () => {
      childPopups.delete(childWin)
      void finish()
    })
  }
  win.webContents.on('did-create-window', trackChildWindow)

  const onCookie = (
    _event: unknown,
    cookie: { name: string },
    _cause: string,
    removed: boolean
  ): void => {
    if (!removed && looksLikeSessionCookie(cookie.name)) void finish()
  }
  ses.cookies.on('changed', onCookie)

  const poll = setInterval(() => {
    if (win.isDestroyed() || !current()) {
      clearInterval(poll)
      return
    }
    void finish()
  }, 1200)

  attempt.cleanup = () => {
    clearInterval(poll)
    ses.cookies.off('changed', onCookie)
    closeChildPopups()
  }
  win.on('closed', () => {
    if (!current()) return
    attempt.closing = true
    if (loginWindows.get(accountId) === win) loginWindows.delete(accountId)
    attempt.cleanup?.()
    attempt.cleanup = undefined
    finish()
  })

  try {
    await win.loadURL(HARK_LOGIN_URL)
  } catch (error) {
    if (current() && !attempt.closing) console.error('[hark] openLogin load failed', error)
  }
}

export async function cancelHarkLogin(accountId: string, opts?: { clearIfEmpty?: boolean }): Promise<void> {
  const attempt = loginAttempts.get(accountId)
  if (attempt) {
    settleLogin(accountId, attempt, null, true)
  } else {
    const win = loginWindows.get(accountId)
    if (win) {
      loginWindows.delete(accountId)
      if (!win.isDestroyed()) win.destroy()
    }
  }
  if (opts?.clearIfEmpty === false) return
  try {
    const existingCookies = await listSessionCookieNames(accountId)
    const alreadyValid = existingCookies.length > 0 && Boolean(await probeSignedIn(accountId))
    if (!alreadyValid && !loginAttempts.has(accountId)) {
      const ses = electronSession.fromPartition(partitionForAccount(accountId))
      if (typeof ses?.clearStorageData === 'function') {
        await ses.clearStorageData()
      }
    }
  } catch (error) {
    console.error('[hark] clear partition failed', error)
  }
}

export async function completeHarkCredentialImport(accountId: string, session: HarkAuthSession): Promise<void> {
  const cookieNames = await listSessionCookieNames(accountId).catch(() => [])
  const attempt = loginAttempts.get(accountId) ?? {}
  loginAttempts.set(accountId, attempt)
  settleLogin(accountId, attempt, { session, cookieNames })
}

export function hasOpenHarkLogin(accountId: string): boolean {
  const win = loginWindows.get(accountId)
  return Boolean(win && !win.isDestroyed())
}
