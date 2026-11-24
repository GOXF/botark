import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, dialog, ipcMain, type WebContents } from 'electron'
import {
  MOBILE_SYNC_CHANNELS,
  type DirectHermesCredential,
  type MobileBridgeLiveEvent,
  type MobileRelayCommand,
  type MobileSendCommand,
  type MobileSendResult,
  type MobileSyncStateView,
  type MobileWorkspaceSnapshotUpdate
} from '@shared/mobileSync'
import { getHermesAccount, listHermesAccountRecords } from '../hermes/hermesStore'
import {
  defaultMobileSyncDevicesPath,
  MOBILE_SEND_UNCONFIRMED,
  MobileSyncServer,
  SEND_RETRY_TTL_MS
} from './mobileSyncServer'

let syncServer: MobileSyncServer | null = null
let registered = false
const pendingSends = new Map<string, { contents: WebContents; finish: (result: MobileSendResult) => void }>()
const pendingSnapshots = new Map<WebContents, { id: string; promise: Promise<void>; finish: () => void }>()

function broadcastState(state: MobileSyncStateView): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    try {
      win.webContents.send(MOBILE_SYNC_CHANNELS.stateChanged, state)
    } catch {
      /* The renderer can disappear during a sync state change. */
    }
  }
}

function dispatchCommandToRenderer(command: MobileRelayCommand): void {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && !w.webContents.isDestroyed())
  if (!win) return
  win.webContents.send(MOBILE_SYNC_CHANNELS.command, command)
}

function dispatchSendToRenderer(command: MobileSendCommand): Promise<MobileSendResult> {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && !w.webContents.isDestroyed())
  const unavailable = { ok: false, status: 503, message: 'Desktop renderer is unavailable' } as const
  if (!win) return Promise.resolve(unavailable)
  const contents = win.webContents
  const id = randomUUID()
  return new Promise((resolve) => {
    // HTTP can time out while the renderer is still handling this request. Keep its
    // acknowledgment listener so the next request with the same ID can reconcile it.
    const onDestroyed = () => finish(MOBILE_SEND_UNCONFIRMED)
    const timer = setTimeout(onDestroyed, SEND_RETRY_TTL_MS).unref()
    const finish = (result: MobileSendResult) => {
      clearTimeout(timer)
      pendingSends.delete(id)
      contents.removeListener('destroyed', onDestroyed)
      resolve(result)
    }
    pendingSends.set(id, { contents, finish })
    contents.once('destroyed', onDestroyed)
    try {
      contents.send(MOBILE_SYNC_CHANNELS.sendCommand, id, command)
    } catch {
      finish(unavailable)
    }
  })
}

function requestRendererSnapshot(preferred?: WebContents): Promise<void> {
  const contents = preferred ?? BrowserWindow.getAllWindows()
    .find((win) => !win.isDestroyed() && !win.webContents.isDestroyed())?.webContents
  if (!contents || contents.isDestroyed()) return Promise.resolve()
  const pending = pendingSnapshots.get(contents)
  if (pending) return pending.promise

  const id = randomUUID()
  let complete!: () => void
  const promise = new Promise<void>((resolve) => { complete = resolve })
  const finish = () => {
    clearTimeout(timer)
    pendingSnapshots.delete(contents)
    contents.removeListener('destroyed', finish)
    complete()
  }
  const timer = setTimeout(finish, 3_000)
  pendingSnapshots.set(contents, { id, promise, finish })
  contents.once('destroyed', finish)
  try {
    contents.send(MOBILE_SYNC_CHANNELS.stateChanged, { ...ensureServer().getState(), snapshotRequestId: id })
  } catch {
    finish()
  }
  return promise
}

async function stopServer(): Promise<MobileSyncStateView> {
  for (const pending of pendingSnapshots.values()) pending.finish()
  return ensureServer().stop()
}

function collectDirectHermesCredentials(): DirectHermesCredential[] {
  const out: DirectHermesCredential[] = []
  try {
    for (const rec of listHermesAccountRecords()) {
      const full = getHermesAccount(rec.accountId)
      if (!full?.baseUrl) continue
      out.push({
        accountId: full.accountId,
        baseUrl: full.baseUrl,
        apiKey: full.apiKey,
        model: full.model,
        displayName: full.displayName
      })
    }
  } catch {
    /* keychain locked or empty */
  }
  return out
}

function ensureServer(): MobileSyncServer {
  if (!syncServer) {
    syncServer = new MobileSyncServer({
      storePath: defaultMobileSyncDevicesPath(app.getPath('userData')),
      appVersion: app.getVersion(),
      getDirectCredentials: collectDirectHermesCredentials,
      onCommand: dispatchCommandToRenderer,
      onSendMessage: dispatchSendToRenderer,
      refreshSnapshot: requestRendererSnapshot,
      onStateChange: broadcastState
    })
  }
  return syncServer
}

export async function stopMobileSyncServer(): Promise<void> {
  if (syncServer) {
    await stopServer().catch(() => undefined)
  }
}

export function registerMobileSyncIpc(): void {
  if (registered) return
  registered = true

  ipcMain.on(MOBILE_SYNC_CHANNELS.sendCommandResult, (event, requestId: string, result: MobileSendResult) => {
    const pending = pendingSends.get(requestId)
    if (pending?.contents === event.sender) pending.finish(result)
  })

  ipcMain.handle(MOBILE_SYNC_CHANNELS.getState, () => ensureServer().getState())
  ipcMain.handle(MOBILE_SYNC_CHANNELS.start, () => ensureServer().start())
  ipcMain.handle(MOBILE_SYNC_CHANNELS.stop, stopServer)
  ipcMain.handle(MOBILE_SYNC_CHANNELS.rotatePairing, () => ensureServer().rotatePairing())

  ipcMain.handle(MOBILE_SYNC_CHANNELS.setIncludeDirectCredentials, (_event, enabled: unknown) => {
    return ensureServer().setIncludeDirectCredentials(Boolean(enabled))
  })

  ipcMain.handle(MOBILE_SYNC_CHANNELS.revokeDevice, (_event, deviceId: unknown) => {
    if (typeof deviceId !== 'string') throw new TypeError('deviceId must be a string')
    return ensureServer().revokeDevice(deviceId)
  })

  ipcMain.handle(MOBILE_SYNC_CHANNELS.exportOfflineBundle, async (event) => {
    const srv = ensureServer()
    await requestRendererSnapshot(event.sender)
    const { bundleJson, transferKey, fingerprint } = srv.createOfflineEncryptedBundle()
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const defaultName = `BotArk-Sync-${fingerprint}.botark-sync`
    const result = win
      ? await dialog.showSaveDialog(win, {
          title: '导出加密同步包（可通过隔空投送发送到 iPhone）',
          defaultPath: defaultName,
          filters: [{ name: 'BotArk Sync Bundle', extensions: ['botark-sync', 'json'] }]
        })
      : await dialog.showSaveDialog({
          title: '导出加密同步包（可通过隔空投送发送到 iPhone）',
          defaultPath: defaultName,
          filters: [{ name: 'BotArk Sync Bundle', extensions: ['botark-sync', 'json'] }]
        })
    if (result.canceled || !result.filePath) {
      return { canceled: true as const }
    }
    writeFileSync(result.filePath, bundleJson, { encoding: 'utf8', mode: 0o600 })
    return {
      canceled: false as const,
      filePath: result.filePath,
      transferKey,
      fingerprint
    }
  })

  ipcMain.on(MOBILE_SYNC_CHANNELS.pushSnapshot, (event, snapshot: unknown) => {
    if (!snapshot || typeof snapshot !== 'object') return
    const { snapshotRequestId, publishSnapshot, ...workspace } = snapshot as MobileWorkspaceSnapshotUpdate
    if (snapshotRequestId) {
      const pending = pendingSnapshots.get(event.sender)
      if (!pending || pending.id !== snapshotRequestId) return
      ensureServer().updateSnapshot(workspace, Boolean(publishSnapshot))
      pending.finish()
    } else {
      ensureServer().updateSnapshot(workspace)
    }
  })

  ipcMain.on(MOBILE_SYNC_CHANNELS.pushEvent, (_event, payload: unknown) => {
    if (!syncServer || !payload || typeof payload !== 'object') return
    syncServer.broadcastLiveEvent(payload as MobileBridgeLiveEvent)
  })
}
