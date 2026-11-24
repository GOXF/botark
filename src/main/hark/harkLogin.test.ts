import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'

const { probe, cookieEvents, windows } = vi.hoisted(() => ({
  probe: vi.fn(), cookieEvents: { on: vi.fn(), off: vi.fn() }, windows: [] as unknown[]
}))

type LoginWindow = { webContents: EventEmitter; isDestroyed(): boolean }

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class MockLoginWindow extends EventEmitter {
    readonly webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn(), isDestroyed: () => this.destroyed, getURL: () => 'https://app.hark.com/login'
    })
    private destroyed = false

    constructor() { super(); windows.push(this) }
    show() { /* mock */ }
    focus() { /* mock */ }
    isDestroyed() { return this.destroyed }
    async loadURL() { /* mock */ }
    destroy() {
      if (this.destroyed) return
      this.destroyed = true
      this.emit('closed')
    }
  }
  return { BrowserWindow: MockLoginWindow, session: { fromPartition: () => ({ cookies: cookieEvents }) } }
})
vi.mock('../appIcon', () => ({ getAppWindowIcon: () => undefined }))
vi.mock('../googleOAuthUaGuard', () => ({ installGoogleOAuthHeaderGuard: vi.fn(), attachGoogleOAuthWebContentsGuard: vi.fn() }))
vi.mock('../muse/accountProxy', () => ({ applyProxyToPartition: vi.fn() }))
vi.mock('../webContentsViewManager', () => ({ partitionForAccount: (accountId: string) => accountId }))
vi.mock('./harkSession', () => ({ probeHarkSession: probe }))
vi.mock('./harkClient', async (load) => ({ ...await load<typeof import('./harkClient')>(), listSessionCookieNames: async () => [] }))

import { cancelHarkLogin, onHarkLoginEvent, openHarkLoginWindow } from './harkLogin'

afterEach(async () => {
  await cancelHarkLogin('account')
  windows.length = 0
  probe.mockReset()
})

it('settles concurrent navigation and cookie probes once', async () => {
  let resolveProbe!: (result: unknown) => void
  probe.mockResolvedValueOnce({ signedIn: false }).mockImplementationOnce(() => new Promise((resolve) => { resolveProbe = resolve }))
  const listener = vi.fn()
  const off = onHarkLoginEvent(listener)
  try {
    await openHarkLoginWindow('account')
    const win = windows[0] as LoginWindow
    win.webContents.emit('did-navigate')
    win.webContents.emit('did-finish-load')
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2))
    resolveProbe({ session: { user: { name: 'Signed In' } } })
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce())
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ signedIn: true, displayName: 'Signed In' }))
    expect(win.isDestroyed()).toBe(true)
  } finally { off() }
})

it('discards a successful probe from a cancelled login generation', async () => {
  let resolveProbe!: (result: unknown) => void
  probe.mockResolvedValueOnce({ signedIn: false })
    .mockImplementationOnce(() => new Promise((resolve) => { resolveProbe = resolve }))
    .mockResolvedValueOnce({ signedIn: false })
  const listener = vi.fn()
  const off = onHarkLoginEvent(listener)
  try {
    await openHarkLoginWindow('account')
    const previous = windows[0] as LoginWindow
    previous.webContents.emit('did-navigate')
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2))
    await cancelHarkLogin('account')
    const reopening = openHarkLoginWindow('account')
    resolveProbe({ session: { user: { name: 'Previous Attempt' } } })
    await reopening
    expect(previous.isDestroyed()).toBe(true)
    expect(windows).toHaveLength(2)
    expect(listener).not.toHaveBeenCalled()
  } finally { off() }
})
