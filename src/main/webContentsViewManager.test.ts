import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  class FakeWebContents {
    url = ''
    loadURL = vi.fn(async (u: string) => {
      this.url = u
    })
    reload = vi.fn()
    setBackgroundThrottling = vi.fn()
    getURL = () => this.url
    isDestroyed = () => false
    setUserAgent = vi.fn()
    getUserAgent = () => 'Mozilla/5.0 Chrome/134 Electron/35.0.0'
    setWindowOpenHandler = vi.fn()
    on = vi.fn()
    once = vi.fn()
    close = vi.fn()
  }
  class WebContentsView {
    webContents = new FakeWebContents()
    setBackgroundColor = vi.fn()
    setBounds = vi.fn()
  }
  return {
    app: { getPath: () => '/tmp' },
    safeStorage: {},
    BrowserWindow: class {},
    WebContentsView,
    shell: { openExternal: vi.fn() },
    session: { fromPartition: () => ({ setProxy: vi.fn(async () => undefined) }) }
  }
})

vi.mock('./muse/accountProxy', () => ({ applyProxyToPartition: vi.fn(async () => undefined) }))

import { WebContentsViewManager } from './webContentsViewManager'

function fakeWindow() {
  return {
    webContents: { on: vi.fn(), once: vi.fn(), isDestroyed: () => false },
    on: vi.fn(),
    once: vi.fn(),
    isDestroyed: () => false,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }
  }
}

describe('WebContentsViewManager.reloadAccount', () => {
  it('reloads only the views of the given account, honoring resolveUrl', async () => {
    const mgr = new WebContentsViewManager(fakeWindow() as never)
    mgr.create({ botId: 'b1', accountId: 'acc_a', url: 'https://app.hark.com/login' })
    mgr.attach('b1::acc_a', { x: 0, y: 0, width: 100, height: 100 })
    mgr.create({ botId: 'b2', accountId: 'acc_b', url: 'https://app.hark.com/' })
    const a = mgr.getView('b1::acc_a')!.webContents as unknown as {
      loadURL: ReturnType<typeof vi.fn>
      reload: ReturnType<typeof vi.fn>
    }
    const b = mgr.getView('b2::acc_b')!.webContents as unknown as {
      loadURL: ReturnType<typeof vi.fn>
      reload: ReturnType<typeof vi.fn>
    }
    const flush = () => new Promise((r) => setTimeout(r, 0)) // loads wait for the account proxy
    await flush()
    a.loadURL.mockClear()
    b.loadURL.mockClear()

    const n = mgr.reloadAccount('acc_a', (cur) => (cur.endsWith('/login') ? 'https://app.hark.com' : undefined))
    await flush()
    expect(n).toBe(1)
    expect(a.loadURL).toHaveBeenCalledWith('https://app.hark.com')
    expect(b.loadURL).not.toHaveBeenCalled()
    expect(b.reload).not.toHaveBeenCalled()

    // Already inside the app: plain reload.
    mgr.reloadAccount('acc_a', (cur) => (cur.endsWith('/login') ? 'https://app.hark.com' : undefined))
    await flush()
    expect(a.reload).toHaveBeenCalledTimes(1)
  })
})

describe('WebContentsViewManager.transferBot', () => {
  it('moves one bot\'s views (same webContents) to another window and leaves the rest', () => {
    const fromWin = fakeWindow()
    const from = new WebContentsViewManager(fromWin as never)
    const to = new WebContentsViewManager(fakeWindow() as never)
    from.create({ botId: 'b1', accountId: 'acc_a', url: 'https://app.hark.com/' })
    from.attach('b1::acc_a', { x: 0, y: 0, width: 100, height: 100 })
    from.create({ botId: 'b2', accountId: 'acc_b', url: 'https://app.hark.com/' })
    const view = from.getView('b1::acc_a')

    from.transferBot('b1', to)

    expect(from.getView('b1::acc_a')).toBeUndefined()
    expect(to.getView('b1::acc_a')).toBe(view)
    expect(fromWin.contentView.removeChildView).toHaveBeenCalledWith(view)
    expect(from.getView('b2::acc_b')).toBeDefined()
    expect(to.create({ botId: 'b1', accountId: 'acc_a' }).viewId).toBe('b1::acc_a')
    expect(to.list()).toHaveLength(1)
  })
})
