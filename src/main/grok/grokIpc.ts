import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { GrokRequest } from '../../adapters/grokbot/grokRequests'
import {
  GROK_CHANNELS,
  type GrokAuthSessionPayload,
  type GrokAuthStatus,
  type GrokOpenLoginRequest,
  type GrokSetAccessTokenRequest
} from '@shared/ipc'
import { loadAccountProxyUrl } from '../muse/accountProxy'
import { cancelAllGrokLogins, cancelGrokLogin, onGrokAuthCaptured, openGrokLoginWindow } from './grokLogin'
import { getOrCreateGrokMachineId } from './grokMachineId'
import { runGrokRpc } from './grokRpc'
import {
  clearGrokCredentials,
  loadGrokCredential,
  parseAnyGrokCredentialInput,
  replaceGrokCredentials
} from './grokSandAuth'

const activeRequests = new Map<string, { accountId: string; controller: AbortController }>()

function ownerWindow(event: IpcMainInvokeEvent): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(event.sender) ?? undefined
}

function broadcastAuthEvent(payload: {
  accountId: string
  signedIn: boolean
  accountSlot?: string
  teamId?: string
  machineId?: string
  windowClosed?: boolean
}): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    if (payload.signedIn) {
      // Security: never broadcast raw Bearer accessToken to renderer; all RPCs execute in main.
      win.webContents.send(GROK_CHANNELS.event, {
        type: 'auth',
        accountId: payload.accountId,
        signedIn: true as const,
        accountSlot: payload.accountSlot,
        teamId: payload.teamId,
        machineId: payload.machineId
      })
    } else {
      win.webContents.send(GROK_CHANNELS.event, {
        type: 'auth',
        accountId: payload.accountId,
        signedIn: false as const,
        windowClosed: payload.windowClosed
      })
    }
  }
}

async function statusFor(accountId: string): Promise<GrokAuthStatus> {
  const hasProxy = Boolean(await loadAccountProxyUrl(accountId).catch(() => true))
  return { ...await sessionFor(accountId), hasProxy }
}

async function sessionFor(accountId: string): Promise<GrokAuthStatus> {
  const auth = await loadGrokCredential(accountId)
  if (!auth) return { accountId, signedIn: false }
  const sand = auth.tokens
  return {
    accountId,
    signedIn: true,
    accountSlot: sand.authId ?? sand.selectedTeamId,
    teamId: sand.selectedTeamId,
    machineId: auth.machineId ?? getOrCreateGrokMachineId(accountId),
    hasRefreshToken: Boolean(sand.refreshToken),
    authKind: sand.authKind ?? 'cursor'
  }
}

let registered = false

export function registerGrokIpc(): void {
  if (registered) return
  registered = true

  onGrokAuthCaptured((ev) => {
    if (ev.signedIn) {
      broadcastAuthEvent({
        accountId: ev.accountId,
        signedIn: true,
        accountSlot: ev.accountSlot,
        teamId: ev.teamId,
        machineId: ev.machineId
      })
    } else {
      broadcastAuthEvent({
        accountId: ev.accountId,
        signedIn: false,
        windowClosed: ev.windowClosed
      })
    }
  })

  ipcMain.handle(GROK_CHANNELS.openLogin, async (event, request: unknown) => {
    if (typeof request !== 'object' || request === null) {
      throw new TypeError('Invalid grok openLogin')
    }
    const req = request as GrokOpenLoginRequest
    if (typeof req.accountId !== 'string') throw new TypeError('Invalid accountId')
    await openGrokLoginWindow(req.accountId, ownerWindow(event), {
      openInBrowser: Boolean(req.openInBrowser)
    })
    return { ok: true as const }
  })

  ipcMain.handle(GROK_CHANNELS.cancelLogin, async (_event, accountId: unknown) => {
    if (typeof accountId !== 'string') throw new TypeError('Invalid accountId')
    cancelGrokLogin(accountId)
    return { ok: true as const }
  })

  ipcMain.handle(GROK_CHANNELS.setAccessToken, async (_event, request: unknown) => {
    if (typeof request !== 'object' || request === null) {
      throw new TypeError('Invalid setAccessToken')
    }
    const req = request as GrokSetAccessTokenRequest
    if (
      typeof req.accountId !== 'string' ||
      typeof req.accessToken !== 'string' ||
      !req.accessToken.trim()
    ) {
      throw new TypeError('accountId and accessToken required')
    }
    const machineId = req.machineId?.trim() || getOrCreateGrokMachineId(req.accountId)
    const resolved = await replaceGrokCredentials(req.accountId, (existing) => parseAnyGrokCredentialInput(req.accessToken, {
      refreshToken: req.refreshToken, accountSlot: req.accountSlot, teamId: req.teamId, existing, accountId: req.accountId
    }), {
      machineId,
      committed: ({ tokens }) => {
        cancelGrokLogin(req.accountId)
        broadcastAuthEvent({
          accountId: req.accountId, signedIn: true, accountSlot: tokens.authId, teamId: tokens.selectedTeamId, machineId
        })
      }
    })
    if (!resolved) {
      throw new Error(
        '无法识别该凭据：请粘贴有效的 Grok/Sand Access Token (eyJ...)、WorkosCursorSessionToken Cookie、JSON 或 API Key'
      )
    }

    return statusFor(req.accountId)
  })

  ipcMain.handle(GROK_CHANNELS.clearAuth, async (_event, accountId: unknown) => {
    if (typeof accountId !== 'string') throw new TypeError('Invalid accountId')
    const cancelLogins = () => accountId === '*' ? cancelAllGrokLogins() : cancelGrokLogin(accountId)
    cancelLogins()
    for (const request of activeRequests.values()) {
      if (accountId === '*' || request.accountId === accountId) request.controller.abort()
    }
    await clearGrokCredentials(accountId, () => {
      cancelLogins()
      if (accountId !== '*') broadcastAuthEvent({ accountId, signedIn: false })
    })
    return { accountId, signedIn: false }
  })

  ipcMain.handle(GROK_CHANNELS.authStatus, async (_event, accountId: unknown) => {
    if (typeof accountId !== 'string') throw new TypeError('Invalid accountId')
    return statusFor(accountId)
  })

  ipcMain.handle(
    GROK_CHANNELS.getSession,
    async (_event, accountId: unknown): Promise<GrokAuthSessionPayload> => {
      if (typeof accountId !== 'string') throw new TypeError('Invalid accountId')
      return sessionFor(accountId)
    }
  )

  ipcMain.handle(GROK_CHANNELS.rpc, async (event, request: unknown) => {
    if (typeof request !== 'object' || request === null) {
      return { ok: false as const, status: 0, message: 'Invalid grok rpc request' }
    }
    const req = request as GrokRequest
    if (typeof req.accountId !== 'string' || typeof req.op !== 'string') {
      return { ok: false as const, status: 0, message: 'accountId and op required' }
    }
    const key = typeof req.requestId === 'string' && req.requestId
      ? JSON.stringify([event.sender.id, req.accountId, req.requestId]) : undefined
    if (req.op === 'cancelRequest') {
      if (key) activeRequests.get(key)?.controller.abort()
      return { ok: true, data: null }
    }
    if (!key || !['sendUserMessage', 'watchUntilReply', 'listTranscriptEntries'].includes(req.op)) return runGrokRpc(req)
    if (activeRequests.has(key)) return { ok: false, status: 409, message: 'Grok request already active' }
    const controller = new AbortController()
    const abort = () => controller.abort()
    activeRequests.set(key, { accountId: req.accountId, controller })
    event.sender.once('destroyed', abort)
    event.sender.once('did-navigate', abort)
    try {
      return await runGrokRpc(req, controller.signal)
    } finally {
      controller.abort()
      activeRequests.delete(key)
      event.sender.off('destroyed', abort)
      event.sender.off('did-navigate', abort)
    }
  })
}

export {
  setGrokChecksumCalculator,
  getGrokChecksumCalculator,
  createCursorChecksum
} from './connectClient'
