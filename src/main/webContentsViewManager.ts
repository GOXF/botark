import { createHash } from 'node:crypto'
import { installHarkBrowserOnly } from './goxfHarkBrowserOnly'
import {
  BrowserWindow,
  session as electronSession,
  shell,
  WebContentsView,
  type Rectangle,
  type WebContents
} from 'electron'
import type {
  CreateWebViewRequest,
  OpenInPartitionRequest,
  WebViewBounds,
  WebViewInfo
} from '@shared/ipc'
import { getAppWindowIcon } from './appIcon'
import { applyProxyToPartition } from './muse/accountProxy'
import {
  attachGoogleOAuthWebContentsGuard,
  installGoogleOAuthHeaderGuard
} from './googleOAuthUaGuard'

/**
 * Manages embedded platform web sessions for one window.
 *
 * Memory & Session Discipline:
 * - Only ONE WebContentsView is attached at a time; switching bots swaps the
 *   active view cleanly inside the same window.
 * - Detached views immediately enable `backgroundThrottling` and enter an LRU
 *   idle hibernation queue (keeping at most 1 warm detached view for 90s).
 *   Older idle views close their Chromium renderer process while preserving
 *   100% of their `persist:bothub-account-*` cookies & storage on disk.
 * - Popups (`window.open`) inside embedded views open in an authenticated
 *   in-app child BrowserWindow sharing the exact same account partition & proxy,
 *   never leaking or bouncing out to an unauthenticated OS browser.
 */

const IDLE_HIBERNATE_MS = 90_000
const MAX_WARM_DETACHED_VIEWS = 1

interface ManagedView {
  info: Omit<WebViewInfo, 'attached'>
  view: WebContentsView
  lastUsed: number
  proxyReady: Promise<void>
  proxyConfigured: boolean
  idleTimer?: ReturnType<typeof setTimeout>
  pinned?: boolean
}

const LEGACY_ACCOUNT_ID = /^[a-zA-Z0-9_-]+$/

export function webViewId(botId: string, accountId: string): string {
  const legacyId = `${botId}::${accountId}`
  if (legacyId.indexOf('::') === legacyId.lastIndexOf('::')) return legacyId
  const digest = createHash('sha256').update(JSON.stringify([botId, accountId])).digest('hex')
  return `web-view.${digest}`
}

export function partitionForAccount(accountId: string): string {
  if (LEGACY_ACCOUNT_ID.test(accountId)) return `persist:bothub-account-${accountId}`
  const hash = createHash('sha256').update(accountId, 'utf16le').digest('hex')
  return `persist:bothub-account-v2.${hash}`
}

function liveWebContents(owner: WebContentsView | BrowserWindow): WebContents | undefined {
  try {
    const contents = owner.webContents
    return contents && !contents.isDestroyed() ? contents : undefined
  } catch {
    // Electron may already have invalidated the native object.
    return undefined
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)
}

function placeholderPage(label: string, partition: string): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(label)}</title>
<style>
  html,body{height:100%;margin:0}
  body{display:grid;place-items:center;background:#fafafb;color:#4a4a56;
       font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
  .card{max-width:380px;padding:28px 32px;text-align:center;background:#fff;border:1px solid #ebebef;
        border-radius:16px;box-shadow:0 6px 16px -6px rgb(23 23 28 / .08)}
  h1{margin:12px 0 6px;font-size:15px;color:#17171c}
  code{font:11px ui-monospace,Menlo,monospace;background:#f1f1f4;padding:2px 6px;border-radius:6px}
  .glyph{width:44px;height:44px;margin:0 auto;display:grid;place-items:center;border-radius:12px;
         background:#f4f4ff;color:#5f56df;font-weight:600;font-size:18px}
</style></head><body><div class="card">
  <div class="glyph">◎</div>
  <h1>${escapeHtml(label)}</h1>
  <p>This is an embedded WebContentsView running in its own session partition <code>${escapeHtml(partition)}</code>.</p>
</div></body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

export function isHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function toRectangle(bounds: WebViewBounds): Rectangle {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height))
  }
}

export class WebContentsViewManager {
  private static readonly liveManagers = new Set<WebContentsViewManager>()
  private static readonly clearingPartitions = new Map<string, Promise<void>>()
  private static readonly pendingPopups = new Map<string, Set<AbortController>>()
  private readonly views = new Map<string, ManagedView>()
  private readonly childWindows = new Map<string, Set<BrowserWindow>>()
  private attachedId: string | null = null
  private useSequence = 0
  private disposed = false

  constructor(private readonly window: BrowserWindow) {
    const contents = liveWebContents(window)
    contents?.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.detachAll()
    })
    contents?.once('destroyed', () => this.destroyAll())
    window.once('closed', () => this.destroyAll())
    WebContentsViewManager.liveManagers.add(this)
  }

  isAlive(): boolean {
    return !this.disposed && !this.window.isDestroyed() && !!liveWebContents(this.window)
  }

  private requireAvailable(partition: string): void {
    if (!this.isAlive()) throw new Error('Web view window is closed')
    if (WebContentsViewManager.clearingPartitions.has(partition)) throw new Error('Account partition is being cleared')
  }

  /** Retains synchronous view creation for callers that configure the view before navigation. */
  create(request: CreateWebViewRequest): WebViewInfo {
    return this.describe(this.getOrCreate(request))
  }

  /** The renderer's create IPC reports proxy setup failures before it tries to attach. */
  async createReady(request: CreateWebViewRequest): Promise<WebViewInfo> {
    const managed = this.getOrCreate(request)
    await managed.proxyReady
    this.requireContents(managed)
    return this.describe(managed)
  }

  private getOrCreate(request: CreateWebViewRequest): ManagedView {
    if (request.url !== undefined && !isHttpUrl(request.url)) {
      throw new Error(`Refusing to load non-http(s) URL: ${request.url}`)
    }

    const partition = partitionForAccount(request.accountId)
    this.requireAvailable(partition)
    const viewId = webViewId(request.botId, request.accountId)
    const existing = this.views.get(viewId)
    if (existing && liveWebContents(existing.view)) {
      existing.lastUsed = ++this.useSequence
      if (request.url && request.url !== existing.info.url) {
        existing.info.url = request.url
        if (existing.proxyConfigured) this.loadView(existing, request.url)
      }
      return existing
    }
    if (existing) this.destroy(viewId)

    const ses = electronSession.fromPartition(partition)
    installGoogleOAuthHeaderGuard(ses)
    const view = new WebContentsView({
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: true
      }
    })
    const contents = liveWebContents(view)
    if (!contents) throw new Error(`Web view is closed: ${viewId}`)
    const managed: ManagedView = {
      info: {
        viewId,
        botId: request.botId,
        accountId: request.accountId,
        partition,
        url: request.url ?? 'about:placeholder'
      },
      view,
      lastUsed: ++this.useSequence,
      proxyReady: applyProxyToPartition(request.accountId),
      proxyConfigured: false
    }
    this.views.set(viewId, managed)
    contents.once('destroyed', () => this.removeView(managed))
    view.setBackgroundColor('#ffffff')
    attachGoogleOAuthWebContentsGuard(contents, ses)
    installHarkBrowserOnly(contents)
    const popupSize = { width: 1060, height: 740, minWidth: 680 }
    this.installPopupHandler(contents, partition, this.window, popupSize, () => managed.proxyConfigured)

    contents.on('will-navigate', (event, url) => {
      if (!managed.proxyConfigured || !isHttpUrl(url)) event.preventDefault()
    })
    contents.on('did-navigate', (_event, url) => {
      if (isHttpUrl(url)) managed.info.url = url
    })

    const placeholder = placeholderPage(request.label ?? 'Web session', partition)
    void managed.proxyReady.then(() => {
      managed.proxyConfigured = true
      const url = managed.info.url === 'about:placeholder' ? placeholder : managed.info.url
      this.loadView(managed, url)
    }).catch((error: unknown) => {
      if (this.views.get(viewId) === managed) {
        this.destroy(viewId)
        console.error(`[web-view ${viewId}] initialization failed`, error)
      }
    })
    this.scheduleIdleHibernate(managed)
    this.evictExcessDetachedViews()
    return managed
  }

  private loadView(managed: ManagedView, url: string): void {
    if (!managed.proxyConfigured || this.views.get(managed.info.viewId) !== managed || !this.isAlive()) return
    if (WebContentsViewManager.clearingPartitions.has(managed.info.partition)) return
    void liveWebContents(managed.view)?.loadURL(url).catch((error: unknown) => {
      console.error(`[web-view ${managed.info.viewId}] failed to load`, error)
    })
  }

  /** Pin or unpin a view from automatic idle hibernation (used only for active DOM hook fallbacks). */
  setPinned(viewId: string, pinned: boolean): void {
    const managed = this.views.get(viewId)
    if (!managed || Boolean(managed.pinned) === pinned) return
    const contents = liveWebContents(managed.view)
    if (!contents) return
    managed.pinned = pinned
    if (pinned) {
      this.clearIdleTimer(managed)
      contents.setBackgroundThrottling(false)
    } else if (this.attachedId !== viewId) {
      this.markIdle(managed)
      this.evictExcessDetachedViews()
    }
  }

  attach(viewId: string, bounds: WebViewBounds): WebViewInfo {
    const managed = this.require(viewId)
    const contents = this.requireContents(managed)
    if (this.attachedId !== viewId) {
      const previous = this.attachedId ? this.views.get(this.attachedId) : undefined
      if (previous) {
        this.removeAttachedView(previous)
        this.markIdle(previous)
      }
      this.window.contentView.addChildView(managed.view)
      this.attachedId = viewId
    }
    this.clearIdleTimer(managed)
    managed.lastUsed = ++this.useSequence
    contents.setBackgroundThrottling(false)
    managed.view.setBounds(toRectangle(bounds))
    this.evictExcessDetachedViews()
    return this.describe(managed)
  }

  resize(viewId: string, bounds: WebViewBounds): void {
    if (this.attachedId !== viewId) return
    const managed = this.views.get(viewId)
    if (managed && liveWebContents(managed.view)) managed.view.setBounds(toRectangle(bounds))
  }

  detach(viewId: string): void {
    const managed = this.views.get(viewId)
    if (!managed || this.attachedId !== viewId) return
    this.removeAttachedView(managed)
    this.markIdle(managed)
    this.evictExcessDetachedViews()
  }

  private markIdle(managed: ManagedView): void {
    managed.lastUsed = ++this.useSequence
    if (managed.pinned) return
    try {
      liveWebContents(managed.view)?.setBackgroundThrottling(true)
    } catch (error) {
      console.warn('[web-view] background throttling failed', error)
    }
    this.scheduleIdleHibernate(managed)
  }

  detachAll(): void {
    if (this.attachedId) this.detach(this.attachedId)
  }

  async navigate(viewId: string, url?: string): Promise<WebViewInfo> {
    // The renderer's refresh button still builds the original tuple. The
    // attached view gives that refresh a single destination.
    const attached = this.attachedId ? this.views.get(this.attachedId) : undefined
    if (url === undefined && attached && viewId === `${attached.info.botId}::${attached.info.accountId}`) {
      viewId = attached.info.viewId
    }
    const managed = this.require(viewId)
    await managed.proxyReady
    const contents = this.requireContents(managed)
    managed.lastUsed = ++this.useSequence
    if (url && isHttpUrl(url)) {
      managed.info.url = url
      this.loadView(managed, url)
    } else {
      contents.reload()
    }
    return this.describe(managed)
  }

  /** Reload the account's views after its session changes, e.g. after importing credentials. */
  reloadAccount(accountId: string, resolveUrl?: (currentUrl: string) => string | undefined): number {
    let count = 0
    for (const managed of this.views.values()) {
      if (managed.info.accountId !== accountId || !liveWebContents(managed.view)) continue
      void managed.proxyReady.then(() => {
        if (this.views.get(managed.info.viewId) !== managed || !this.isAlive()) return
        if (WebContentsViewManager.clearingPartitions.has(managed.info.partition)) return
        const contents = liveWebContents(managed.view)
        if (!contents) return
        const next = resolveUrl?.(contents.getURL() || managed.info.url)
        if (next && isHttpUrl(next)) {
          managed.info.url = next
          this.loadView(managed, next)
        } else {
          contents.reload()
        }
      }).catch(() => undefined)
      count++
    }
    return count
  }

  /** Open an authenticated child window using the account's partition and proxy. */
  async openInPartition(request: OpenInPartitionRequest): Promise<void> {
    if (!isHttpUrl(request.url)) return
    const partition = partitionForAccount(request.accountId)
    this.requireAvailable(partition)
    const pending = WebContentsViewManager.pendingPopups.get(partition) ?? new Set<AbortController>()
    WebContentsViewManager.pendingPopups.set(partition, pending)
    const opening = new AbortController()
    pending.add(opening)
    try {
      await applyProxyToPartition(request.accountId)
    } catch (error) {
      console.error(`[web-view ${partition}] proxy setup failed`, error)
      throw error
    } finally {
      pending.delete(opening)
      if (!pending.size) WebContentsViewManager.pendingPopups.delete(partition)
    }
    opening.signal.throwIfAborted()
    this.requireAvailable(partition)
    const ses = electronSession.fromPartition(partition)
    installGoogleOAuthHeaderGuard(ses)

    const windowIcon = getAppWindowIcon()
    const popup = new BrowserWindow({
      width: 1060,
      height: 740,
      minWidth: 680,
      minHeight: 480,
      parent: this.window,
      title: request.title || 'BotArk 安全会话窗口',
      autoHideMenuBar: true,
      ...(windowIcon ? { icon: windowIcon } : {}),
      backgroundColor: '#ffffff',
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    if (!this.trackChildWindow(popup, partition)) return
    await popup.loadURL(request.url).catch((err) => {
      console.warn('[web-view] openInPartition failed:', err instanceof Error ? err.message : err)
    })
  }

  private installPopupHandler(
    contents: WebContents,
    partition: string,
    parent: BrowserWindow,
    size: { width: number; height: number; minWidth: number },
    proxyReady: () => boolean = () => true
  ): void {
    const windowIcon = getAppWindowIcon()
    contents.setWindowOpenHandler(({ url }) => {
      if (!proxyReady() || !this.isAlive() || parent.isDestroyed() || WebContentsViewManager.clearingPartitions.has(partition)) {
        return { action: 'deny' }
      }
      if (url === 'about:blank' || isHttpUrl(url)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            ...size,
            minHeight: 480,
            parent,
            title: 'BotArk 安全会话窗口',
            autoHideMenuBar: true,
            ...(windowIcon ? { icon: windowIcon } : {}),
            backgroundColor: '#ffffff',
            webPreferences: {
              partition,
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false
            }
          }
        }
      }
      if (/^mailto:/i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    contents.on('did-create-window', (child) => {
      this.trackChildWindow(child, partition)
    })
  }

  private trackChildWindow(popup: BrowserWindow, partition: string): boolean {
    const contents = liveWebContents(popup)
    if (!contents || !this.isAlive() || WebContentsViewManager.clearingPartitions.has(partition)) {
      this.destroyPopup(popup)
      return false
    }
    let popups = this.childWindows.get(partition)
    if (!popups) {
      popups = new Set()
      this.childWindows.set(partition, popups)
    }
    const tracked = popups
    tracked.add(popup)
    popup.once('closed', () => {
      tracked.delete(popup)
      if (!tracked.size && this.childWindows.get(partition) === tracked) {
        this.childWindows.delete(partition)
      }
    })
    const ses = electronSession.fromPartition(partition)
    installGoogleOAuthHeaderGuard(ses)
    attachGoogleOAuthWebContentsGuard(contents, ses)
    this.installPopupHandler(contents, partition, popup, { width: 540, height: 700, minWidth: 420 })
    contents.on('will-navigate', (event, url) => {
      if (url !== 'about:blank' && !isHttpUrl(url)) event.preventDefault()
    })
    return true
  }

  private destroyPopup(popup: BrowserWindow): void {
    try {
      if (!popup.isDestroyed()) popup.destroy()
    } catch (error) {
      console.warn('[web-view] popup teardown failed', error)
    }
  }

  destroy(viewId: string): void {
    const managed = this.views.get(viewId)
    if (!managed) return
    this.removeView(managed)
    try {
      liveWebContents(managed.view)?.close({ waitForBeforeUnload: false })
    } catch (error) {
      console.warn('[web-view] view teardown failed', error)
    }
  }

  private removeView(managed: ManagedView): void {
    if (this.views.get(managed.info.viewId) !== managed) return
    this.views.delete(managed.info.viewId)
    this.clearIdleTimer(managed)
    this.removeAttachedView(managed)
  }

  private removeAttachedView(managed: ManagedView): void {
    if (this.attachedId !== managed.info.viewId) return
    this.attachedId = null
    try {
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(managed.view)
    } catch (error) {
      console.warn('[web-view] view detach failed', error)
    }
  }

  /** GOXF pop-out: hand a bot's views to another window's manager so one webContents never lives twice. Pinned DOM-hook helpers stay. */
  transferBot(botId: string, to: WebContentsViewManager): void {
    for (const [viewId, managed] of [...this.views]) {
      if (managed.info.botId !== botId || managed.pinned) continue
      if (to.views.has(viewId)) {
        this.destroy(viewId)
        continue
      }
      this.clearIdleTimer(managed)
      this.removeAttachedView(managed)
      this.views.delete(viewId)
      to.views.set(viewId, managed)
      liveWebContents(managed.view)?.once('destroyed', () => to.removeView(managed))
      to.scheduleIdleHibernate(managed)
    }
  }

  getView(viewId: string): WebContentsView | undefined {
    const managed = this.views.get(viewId)
    if (managed && liveWebContents(managed.view)) return managed.view
    return undefined
  }

  clearPartition(accountId: string): Promise<void> {
    const partition = partitionForAccount(accountId)
    const { clearingPartitions, pendingPopups, liveManagers } = WebContentsViewManager
    const pending = clearingPartitions.get(partition)
    if (pending) return pending

    for (const opening of pendingPopups.get(partition) ?? []) {
      opening.abort(new Error('Account partition was cleared'))
    }
    const clear = Promise.resolve().then(async () => {
      for (const manager of liveManagers) manager.closePartitionViews(partition)
      const ses = electronSession.fromPartition(partition)
      await ses.clearStorageData()
      await ses.clearCache()
    }).finally(() => clearingPartitions.delete(partition))
    clearingPartitions.set(partition, clear)
    return clear
  }

  private closePartitionViews(partition: string): void {
    for (const popup of this.childWindows.get(partition) ?? []) this.destroyPopup(popup)
    for (const managed of this.views.values()) {
      if (managed.info.partition === partition) this.destroy(managed.info.viewId)
    }
  }

  destroyAll(): void {
    if (this.disposed) return
    this.disposed = true
    WebContentsViewManager.liveManagers.delete(this)
    for (const popups of this.childWindows.values()) {
      for (const popup of popups) this.destroyPopup(popup)
    }
    this.childWindows.clear()
    for (const viewId of this.views.keys()) this.destroy(viewId)
    this.attachedId = null
  }

  list(): WebViewInfo[] {
    return [...this.views.values()].map((managed) => this.describe(managed))
  }

  private clearIdleTimer(managed: ManagedView): void {
    if (managed.idleTimer) {
      clearTimeout(managed.idleTimer)
      managed.idleTimer = undefined
    }
  }

  private scheduleIdleHibernate(managed: ManagedView): void {
    this.clearIdleTimer(managed)
    managed.idleTimer = setTimeout(() => {
      managed.idleTimer = undefined
      const viewId = managed.info.viewId
      if (this.views.get(viewId) === managed && this.attachedId !== viewId && !managed.pinned) {
        this.destroy(viewId)
      }
    }, IDLE_HIBERNATE_MS)
    managed.idleTimer.unref?.()
  }

  private evictExcessDetachedViews(): void {
    const candidates = [...this.views.values()]
      .filter((m) => m.info.viewId !== this.attachedId && !m.pinned)
      .sort((a, b) => b.lastUsed - a.lastUsed)
    for (const stale of candidates.slice(MAX_WARM_DETACHED_VIEWS)) {
      this.destroy(stale.info.viewId)
    }
  }

  private require(viewId: string): ManagedView {
    const managed = this.views.get(viewId)
    if (!managed) throw new Error(`Unknown web view: ${viewId}`)
    return managed
  }

  private requireContents(managed: ManagedView): WebContents {
    this.requireAvailable(managed.info.partition)
    const contents = liveWebContents(managed.view)
    if (!contents || this.views.get(managed.info.viewId) !== managed) {
      throw new Error(`Web view is closed: ${managed.info.viewId}`)
    }
    return contents
  }

  private describe(managed: ManagedView): WebViewInfo {
    return { ...managed.info, attached: this.attachedId === managed.info.viewId }
  }
}
