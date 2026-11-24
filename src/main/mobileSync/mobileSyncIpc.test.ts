import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter, once } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { MOBILE_SYNC_CHANNELS, parsePairingUri, type MobileSyncStateView, type MobileWorkspaceSnapshot } from '@shared/mobileSync'
import { decryptAesGcmCombined } from './mobileSyncCrypto'

const fixture = vi.hoisted(() => ({
  directory: '',
  windows: [] as unknown[],
  on: new Map<string, (...args: unknown[]) => unknown>(),
  handle: new Map<string, (...args: unknown[]) => unknown>()
}))
vi.mock('electron', () => ({
  app: { getPath: () => fixture.directory, getVersion: () => '1.0.0' },
  BrowserWindow: { fromWebContents: () => undefined, getAllWindows: () => fixture.windows },
  dialog: { showSaveDialog: async () => ({ filePath: join(fixture.directory, 'workspace.botark-sync') }) },
  ipcMain: {
    on: (name: string, handler: (...args: unknown[]) => unknown) => fixture.on.set(name, handler),
    handle: (name: string, handler: (...args: unknown[]) => unknown) => fixture.handle.set(name, handler)
  }
}))
vi.mock('../hermes/hermesStore', () => ({
  listHermesAccountRecords: () => [],
  getHermesAccount: () => undefined
}))

let stopServer: () => Promise<void>

beforeEach(async () => {
  vi.resetModules()
  fixture.on.clear()
  fixture.handle.clear()
  fixture.windows = []
  fixture.directory = mkdtempSync(join(tmpdir(), 'botark-export-test-'))
  const ipc = await import('./mobileSyncIpc')
  stopServer = ipc.stopMobileSyncServer
  ipc.registerMobileSyncIpc()
})

afterEach(async () => {
  await stopServer()
  rmSync(fixture.directory, { recursive: true, force: true })
})

class Renderer extends EventEmitter {
  readonly isDestroyed = () => false

  send(channel: string, ...args: unknown[]) {
    this.emit(channel, ...args)
  }

  pushSnapshot(snapshotRequestId: string, selectedBotId: string) {
    fixture.on.get(MOBILE_SYNC_CHANNELS.pushSnapshot)!({ sender: this }, {
      ...snapshot, selectedBotId, snapshotRequestId, publishSnapshot: false
    })
  }
}

const snapshot: MobileWorkspaceSnapshot = {
  version: 1, updatedAtMs: 1, hostName: 'Fixture', selectedBotId: null,
  groups: [{ id: 'group', name: 'Fixture group', collapsed: true }],
  bots: [], accounts: {}, messages: {}, approvals: {}
}

it('requests an up-to-date export from its renderer while the LAN server is stopped', async () => {
  const sender = new Renderer()
  const refresh = vi.fn((state: MobileSyncStateView) => {
    expect(state.running).toBe(false)
    if (state.snapshotRequestId) sender.pushSnapshot(state.snapshotRequestId, 'exported-bot')
  })
  sender.on(MOBILE_SYNC_CHANNELS.stateChanged, refresh)
  const exported = await fixture.handle.get(MOBILE_SYNC_CHANNELS.exportOfflineBundle)!({ sender }) as {
    filePath: string; transferKey: string
  }
  const envelope = JSON.parse(readFileSync(exported.filePath, 'utf8')) as { payload: string }
  const bundle = JSON.parse(decryptAesGcmCombined(envelope.payload, exported.transferKey))
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(bundle.snapshot).toMatchObject({ groups: snapshot.groups, selectedBotId: 'exported-bot' })
})

it('uses one renderer response for simultaneous socket and HTTP snapshot requests', async () => {
  const renderer = new Renderer()
  fixture.windows = [{ isDestroyed: () => false, webContents: renderer }]
  let refresh!: (id: string) => void
  renderer.on(MOBILE_SYNC_CHANNELS.stateChanged, (state: MobileSyncStateView) => {
    if (state.snapshotRequestId) refresh(state.snapshotRequestId)
  })
  refresh = (id) => renderer.pushSnapshot(id, 'paired-bot')
  const state = await fixture.handle.get(MOBILE_SYNC_CHANNELS.start)!() as MobileSyncStateView
  const base = `http://127.0.0.1:${state.port}/api/mobile/v1`
  const paired = await fetch(`${base}/pair`, {
    method: 'POST', body: JSON.stringify({ pairToken: parsePairingUri(state.pairUri!)?.token })
  }).then((res) => res.json() as Promise<{ snapshot: MobileWorkspaceSnapshot; deviceToken: string }>)
  expect(paired.snapshot.selectedBotId).toBe('paired-bot')

  const allRequests = vi.fn()
  let acknowledgeRequest!: (id: string) => void
  const request = new Promise<string>((resolve) => { acknowledgeRequest = resolve })
  refresh = (id) => { allRequests(id); acknowledgeRequest(id) }
  let snapshotLookupReached = 0
  const getWindows = vi.spyOn((await import('electron')).BrowserWindow, 'getAllWindows').mockImplementation(() => {
    snapshotLookupReached++
    return fixture.windows as ReturnType<typeof import('electron').BrowserWindow.getAllWindows>
  })
  const socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws?token=${paired.deviceToken}`)
  try {
    const firstFrame = once(socket, 'message')
    const id = await request
    const beforeLookup = snapshotLookupReached
    const http = fetch(`${base}/snapshot`, { headers: { Authorization: `Bearer ${paired.deviceToken}` } })
    await vi.waitFor(() => expect(snapshotLookupReached).toBeGreaterThan(beforeLookup))
    new Renderer().pushSnapshot(id, 'wrong-renderer')
    renderer.pushSnapshot(id, 'shared-bot')
    const [wsResponse, httpResponse] = await Promise.all([firstFrame, http])
    expect(JSON.parse(String(wsResponse[0])).snapshot.selectedBotId).toBe('shared-bot')
    const payload = await httpResponse.json() as { snapshot: MobileWorkspaceSnapshot }
    expect(payload.snapshot.selectedBotId).toBe('shared-bot')
    expect(allRequests).toHaveBeenCalledTimes(1)
  } finally {
    getWindows.mockRestore()
    socket.terminate()
  }
})
