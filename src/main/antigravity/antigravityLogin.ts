/**
 * Interactive Google Antigravity login via BrowserWindow + isolated persist partition.
 *
 * Opens https://antigravity.google.com/ (redirects to Google Sign-In when signed out).
 * Uses a clean desktop Chrome User-Agent with a Firefox compatibility retry.
 * Success is verified via live `GetUserProfile` RPC (`aicode.clients6.google.com`).
 * Never prints cookie or auth-header values.
 */

import { BrowserWindow, session as electronSession, shell, type WebContents } from 'electron'
import { getAppWindowIcon } from '../appIcon'
import {
  attachGoogleOAuthWebContentsGuard,
  buildGoogleFallbackBannerScript,
  buildGoogleFirefoxCompatUa,
  cleanChromeUserAgentForGoogle,
  GOOGLE_BLOCK_CHECK_SCRIPT,
  installGoogleOAuthHeaderGuard,
  isGoogleFirefoxCompatMode,
  isGoogleBlockedOrPasskeyText,
  setGoogleFirefoxCompatMode
} from '../googleOAuthUaGuard'
import { applyProxyToPartition } from '../muse/accountProxy'
import { partitionForAccount } from '../webContentsViewManager'
import { listAntigravityCookieNames, probeAntigravitySession } from './antigravityClient'
import { withAntigravityCredentials } from './antigravityCredentials'
import {
  ANTIGRAVITY_ORIGIN,
  antigravityAuthUserFromUrl,
  isAllowedAntigravityUrl,
  isAntigravitySigningCookie,
  type AntigravityUserProfile
} from './antigravityProtocol'

const loginWindows = new Map<string, BrowserWindow>()
const loginAttempts = new Map<string, symbol>()

export type AntigravityLoginSuccess = {
  accountId: string
  signedIn: true
  handle?: string
  displayName: string
  planDisplayName?: string
  sessionCookieNames: string[]
}

export type AntigravityLoginEvent =
  | AntigravityLoginSuccess
  | { accountId: string; signedIn: false; windowClosed?: boolean }

export type AntigravityLoginListener = (event: AntigravityLoginEvent) => void

let loginListener: AntigravityLoginListener | undefined

export function onAntigravityLoginEvent(listener: AntigravityLoginListener): () => void {
  loginListener = listener
  return () => {
    if (loginListener === listener) loginListener = undefined
  }
}

function emit(event: AntigravityLoginEvent): void {
  try {
    loginListener?.(event)
  } catch (error) {
    console.error('[antigravity] login listener failed', error)
  }
}

function isAuthTriggerCookie(name: string): boolean {
  return (
    isAntigravitySigningCookie(name) ||
    name === 'SID' ||
    name === '__Secure-1PSID' ||
    name === '__Secure-3PSID'
  )
}

function signedInEvent(accountId: string, profile: AntigravityUserProfile, sessionCookieNames: string[]): AntigravityLoginSuccess {
  return {
    accountId,
    signedIn: true,
    handle: profile.email,
    displayName: profile.email?.split('@')[0] || 'Antigravity',
    planDisplayName: profile.planDisplayName,
    sessionCookieNames
  }
}

export async function completeAntigravityCredentialImport(
  accountId: string,
  profile: AntigravityUserProfile
): Promise<AntigravityLoginSuccess> {
  const cookieNames = await listAntigravityCookieNames(accountId).catch(() => [])
  closeAntigravityLoginWindow(accountId)
  const event = signedInEvent(accountId, profile, cookieNames)
  emit(event)
  return event
}

export async function openAntigravityLoginWindow(accountId: string, parent?: BrowserWindow): Promise<void> {
  const existing = loginWindows.get(accountId)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return
  }

  const attempt = Symbol()
  loginAttempts.set(accountId, attempt)
  const ownsAttempt = () => loginAttempts.get(accountId) === attempt
  const finishAttempt = () => { if (ownsAttempt()) loginAttempts.delete(accountId) }
  try {
    await applyProxyToPartition(accountId)
  } catch (error) {
    finishAttempt()
    throw error
  }
  if (!ownsAttempt()) return

  const partition = partitionForAccount(accountId)
  const ses = electronSession.fromPartition(partition)
  const cleanUa = cleanChromeUserAgentForGoogle(ses.getUserAgent())
  setGoogleFirefoxCompatMode(ses, false)
  installGoogleOAuthHeaderGuard(ses)

  // Already signed in on this partition?
  const already = await withAntigravityCredentials(accountId, () => probeAntigravitySession(accountId))
  if (!ownsAttempt()) return
  if (already.signedIn) {
    const cookieNames = await listAntigravityCookieNames(accountId)
    if (!ownsAttempt()) return
    finishAttempt()
    emit(signedInEvent(accountId, already.profile, cookieNames))
    return
  }

  const windowIcon = getAppWindowIcon()
  const win = new BrowserWindow({
    width: 1080,
    height: 780,
    minWidth: 720,
    minHeight: 560,
    title: '使用 Google Antigravity 登录',
    backgroundColor: '#1f1f1f',
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
  win.webContents.setUserAgent(cleanUa)
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

  const attachNavigationGuards = (wc: WebContents, parentForChild: BrowserWindow) => {
    attachGoogleOAuthWebContentsGuard(wc, ses, { allowGlobalCleanUa: true })

    const clearGoogleRejectionCookies = async (): Promise<void> => {
      if (typeof ses.cookies?.remove !== 'function') return
      const urls = ['https://accounts.google.com/', 'https://accounts.youtube.com/']
      const names = ['__Host-GAPS', 'GAPS', 'OTZ']
      await Promise.allSettled(
        urls.flatMap((url) => names.map((name) => ses.cookies.remove(url, name)))
      )
    }

    const retryWithFirefoxUa = () => {
      setGoogleFirefoxCompatMode(ses, true)
      const mainContents = win.webContents
      closeChildPopups()
      if (!mainContents.isDestroyed()) {
        mainContents.setUserAgent(buildGoogleFirefoxCompatUa())
        void clearGoogleRejectionCookies().finally(() => {
          if (!mainContents.isDestroyed()) {
            void mainContents.loadURL(ANTIGRAVITY_ORIGIN).catch(() => undefined)
          }
        })
      }
    }

    wc.setWindowOpenHandler(({ url }) => {
      if (url === 'botark-external://open') {
        void shell.openExternal(`${ANTIGRAVITY_ORIGIN}/`)
        return { action: 'deny' }
      }
      if (url === 'botark-action://retry-firefox-ua') {
        retryWithFirefoxUa()
        return { action: 'deny' }
      }
      if (isAllowedAntigravityUrl(url)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 540,
            height: 700,
            title: 'Google 登录',
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
        void shell.openExternal(`${ANTIGRAVITY_ORIGIN}/`)
        return
      }
      if (url === 'botark-action://retry-firefox-ua') {
        event.preventDefault()
        retryWithFirefoxUa()
        return
      }
      if (!isAllowedAntigravityUrl(url) && /^https?:\/\//i.test(url)) {
        event.preventDefault()
        void shell.openExternal(url)
      }
    })
  }

  attachNavigationGuards(win.webContents, win)

  let settling = false
  let checking = false
  let preferredAuthUser: string | undefined
  let shownProbeMessage: string | undefined

  const isAntigravityPage = (url: string) => url === ANTIGRAVITY_ORIGIN || url.startsWith(ANTIGRAVITY_ORIGIN + '/')

  const showProbeFailure = async (message: string): Promise<void> => {
    const wc = win.webContents
    if (!isAntigravityPage(wc.getURL()) || shownProbeMessage === message) return
    const id = 'botark-antigravity-session-banner'
    const banner = buildGoogleFallbackBannerScript({
      id,
      title: 'BotArk 尚未验证 Antigravity 会话',
      detail: message + ' 也可在系统浏览器完成登录后，将 Cookie 或「Copy as cURL」粘贴到 BotArk 的「添加 Bot」窗口。',
      buttonLabel: '在系统浏览器打开',
      actionUrl: 'botark-external://open'
    })
    try {
      const shown = await wc.executeJavaScript(`(() => {
        if (location.origin !== ${JSON.stringify(ANTIGRAVITY_ORIGIN)} || !document.body) return false;
        document.getElementById(${JSON.stringify(id)})?.remove();
        ${banner};
        return Boolean(document.getElementById(${JSON.stringify(id)}));
      })()`, true)
      if (shown) shownProbeMessage = message
    } catch {
      /* The page may have navigated while the probe was running. */
    }
  }

  const finishIfSignedIn = async (): Promise<void> => {
    if (settling || checking || win.isDestroyed() || !ownsAttempt()) return
    checking = true
    try {
      await withAntigravityCredentials(accountId, async () => {
        if (!ownsAttempt() || win.isDestroyed()) return
        const authUser = preferredAuthUser
        const probe = await probeAntigravitySession(accountId, authUser)
        if (authUser !== preferredAuthUser || win.isDestroyed() || !ownsAttempt()) return
        if (!probe.signedIn) {
          if (probe.reason !== 'no-cookies') await showProbeFailure(probe.message)
          return
        }
        const cookieNames = await listAntigravityCookieNames(accountId)
        if (authUser !== preferredAuthUser || win.isDestroyed() || !ownsAttempt()) return
        settling = true
        closeAntigravityLoginWindow(accountId)
        emit(signedInEvent(accountId, probe.profile, cookieNames))
      })
    } finally {
      checking = false
    }
  }

  let handedOffToBrowser = false
  let lastBlockCheckAt = 0
  const maybeShowGoogleFallbackBanner = async (wc: WebContents): Promise<void> => {
    if (settling || wc.isDestroyed()) return
    try {
      const currentUrl = wc.getURL()
      if (!/^https:\/\/accounts\.(?:google|youtube)\.com\//i.test(currentUrl)) return
      const now = Date.now()
      if (now - lastBlockCheckAt < 150) return
      lastBlockCheckAt = now
      const bodyText = await wc.executeJavaScript(GOOGLE_BLOCK_CHECK_SCRIPT, true)
      if (!isGoogleBlockedOrPasskeyText(bodyText, currentUrl)) return
      if (!handedOffToBrowser) {
        handedOffToBrowser = true
        void shell.openExternal(`${ANTIGRAVITY_ORIGIN}/`)
      }
      await wc.executeJavaScript(
        buildGoogleFallbackBannerScript({
          title: 'Google 登录受限或需要通行密钥',
          detail: '可点击「兼容模式重试」，也可在系统浏览器完成登录，再将 Antigravity 请求的 Cookie 或「Copy as cURL」粘贴到 BotArk 的「添加 Bot」窗口。',
          buttonLabel: '在系统浏览器打开',
          actionUrl: 'botark-external://open',
          secondaryActions: [{ label: '兼容模式重试', actionUrl: 'botark-action://retry-firefox-ua' }]
        }),
        true
      )
    } catch {
      /* ignore transient navigation states */
    }
  }

  const onNav = (wc: WebContents, url = wc.getURL()) => {
    const authUser = antigravityAuthUserFromUrl(url)
    if (authUser !== undefined) preferredAuthUser = authUser
    void finishIfSignedIn()
    void maybeShowGoogleFallbackBanner(wc)
  }
  win.webContents.on('did-finish-load', () => {
    shownProbeMessage = undefined
    onNav(win.webContents)
  })
  win.webContents.on('did-navigate', () => onNav(win.webContents))
  win.webContents.on('did-navigate-in-page', () => onNav(win.webContents))
  win.webContents.on('did-redirect-navigation', (details) => {
    if (details.isMainFrame) onNav(win.webContents, details.url)
  })

  const trackChildWindow = (childWin: BrowserWindow) => {
    childPopups.add(childWin)
    if (!childWin.webContents.isDestroyed()) {
      childWin.webContents.setUserAgent(isGoogleFirefoxCompatMode(ses) ? buildGoogleFirefoxCompatUa() : cleanUa)
    }
    attachNavigationGuards(childWin.webContents, childWin)
    childWin.webContents.on('did-finish-load', () => onNav(childWin.webContents))
    childWin.webContents.on('did-navigate', () => onNav(childWin.webContents))
    childWin.webContents.on('did-navigate-in-page', () => onNav(childWin.webContents))
    childWin.webContents.on('did-redirect-navigation', (details) => {
      if (details.isMainFrame) onNav(childWin.webContents, details.url)
    })
    childWin.webContents.on('did-create-window', (nested) => trackChildWindow(nested))
    childWin.on('closed', () => {
      childPopups.delete(childWin)
      void finishIfSignedIn()
    })
  }
  win.webContents.on('did-create-window', trackChildWindow)

  const onCookie = (
    _event: unknown,
    cookie: { name: string },
    _cause: string,
    removed: boolean
  ) => {
    if (!removed && isAuthTriggerCookie(cookie.name)) {
      void finishIfSignedIn()
    }
  }
  ses.cookies.on('changed', onCookie)

  const poll = setInterval(() => {
    if (win.isDestroyed() || settling) {
      clearInterval(poll)
      return
    }
    void finishIfSignedIn()
  }, 1500)

  win.on('closed', () => {
    clearInterval(poll)
    ses.cookies.off('changed', onCookie)
    const wasTracked = loginWindows.get(accountId) === win
    if (wasTracked) {
      loginWindows.delete(accountId)
      setGoogleFirefoxCompatMode(ses, false)
    }
    closeChildPopups()
    if (!wasTracked || settling || !ownsAttempt()) return
    void withAntigravityCredentials(accountId, async () => {
      if (!ownsAttempt()) return
      const probe = await probeAntigravitySession(accountId, preferredAuthUser)
      if (!ownsAttempt()) return
      if (probe.signedIn) {
        const cookieNames = await listAntigravityCookieNames(accountId)
        if (!ownsAttempt()) return
        finishAttempt()
        emit(signedInEvent(accountId, probe.profile, cookieNames))
        return
      }
      finishAttempt()
      emit({ accountId, signedIn: false, windowClosed: true })
    })
  })

  try {
    await win.loadURL(ANTIGRAVITY_ORIGIN)
  } catch (error) {
    const code = (error as { errno?: number })?.errno
    if (code !== -3) {
      console.error('[antigravity] openLogin load failed', error)
    }
  }
}

export function closeAntigravityLoginWindow(accountId: string): void {
  loginAttempts.delete(accountId)
  const win = loginWindows.get(accountId)
  loginWindows.delete(accountId)
  setGoogleFirefoxCompatMode(electronSession.fromPartition(partitionForAccount(accountId)), false)
  if (win && !win.isDestroyed()) win.destroy()
}
