/**
 * Electron IPC registration for Google Antigravity Cloud Agents (`antigravity.google.com`).
 */

import { BrowserWindow, ipcMain, session as electronSession } from 'electron'
import {
  ANTIGRAVITY_CHANNELS,
  type AntigravityAuthStatus,
  type AntigravityOpenLoginRequest,
  type AntigravityRpcRequest,
  type AntigravityRpcResponse,
  type AntigravitySendRequest
} from '@shared/ipc'
import { partitionForAccount } from '../webContentsViewManager'
import type { AntigravityTurnEvent } from './antigravityProtocol'
import {
  AntigravityRpcError,
  cancelAntigravityRun,
  clearAntigravityAccountState,
  deleteAntigravityConversation,
  fetchAntigravityAgents,
  fetchAntigravityConversations,
  fetchAntigravityEnvironments,
  fetchAntigravityModels,
  fetchAntigravityProfile,
  fetchAntigravityTranscript,
  fetchAntigravityWorkspaces,
  getAntigravityAccountPrefs,
  listAntigravityCookieNames,
  probeAntigravitySession,
  sendAndStreamAntigravityMessage,
  setAntigravityAccountPrefs
} from './antigravityClient'
import {
  closeAntigravityLoginWindow,
  onAntigravityLoginEvent,
  openAntigravityLoginWindow
} from './antigravityLogin'

let registered = false

function broadcast(event: AntigravityTurnEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(ANTIGRAVITY_CHANNELS.event, event)
    }
  }
}

async function getAuthStatus(accountId: string): Promise<AntigravityAuthStatus> {
  const probe = await probeAntigravitySession(accountId)
  const cookieNames = await listAntigravityCookieNames(accountId)
  const prefs = getAntigravityAccountPrefs(accountId)
  if (probe.signedIn) {
    return {
      accountId,
      signedIn: true,
      handle: probe.profile.email,
      displayName: probe.profile.email.split('@')[0] || 'Antigravity',
      planDisplayName: probe.profile.planDisplayName,
      selectedModelEnum: prefs.modelEnum,
      selectedModelName: prefs.modelDisplayName,
      sessionCookieNames: cookieNames
    }
  }
  return {
    accountId,
    signedIn: false,
    sessionCookieNames: cookieNames,
    error: probe.reason === 'network' ? probe.message : undefined
  }
}

async function clearAccountPartition(accountId: string): Promise<void> {
  closeAntigravityLoginWindow(accountId)
  clearAntigravityAccountState(accountId)
  const ses = electronSession.fromPartition(partitionForAccount(accountId))
  await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers'] })
}

export function registerAntigravityIpc(): void {
  if (registered) return
  registered = true

  onAntigravityLoginEvent((ev) => {
    if (ev.signedIn) {
      broadcast({
        type: 'login',
        accountId: ev.accountId,
        signedIn: true,
        handle: ev.handle,
        displayName: ev.displayName,
        planDisplayName: ev.planDisplayName
      })
    } else {
      broadcast({
        type: 'login',
        accountId: ev.accountId,
        signedIn: false,
        windowClosed: ev.windowClosed
      })
    }
  })

  ipcMain.handle(ANTIGRAVITY_CHANNELS.openLogin, async (event, request: unknown) => {
    if (typeof request !== 'object' || request === null) {
      throw new TypeError('Invalid antigravity openLogin request')
    }
    const { accountId } = request as AntigravityOpenLoginRequest
    if (typeof accountId !== 'string' || !accountId) {
      throw new TypeError('Invalid accountId')
    }
    const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined
    await openAntigravityLoginWindow(accountId, parent)
    return getAuthStatus(accountId)
  })

  ipcMain.handle(ANTIGRAVITY_CHANNELS.cancelLogin, async (_event, accountId: unknown) => {
    if (typeof accountId !== 'string' || !accountId) return
    await clearAccountPartition(accountId)
  })

  ipcMain.handle(ANTIGRAVITY_CHANNELS.clearAuth, async (_event, accountId: unknown) => {
    if (typeof accountId !== 'string' || !accountId) return
    await clearAccountPartition(accountId)
    broadcast({ type: 'login', accountId, signedIn: false })
  })

  ipcMain.handle(ANTIGRAVITY_CHANNELS.authStatus, async (_event, accountId: unknown) => {
    if (typeof accountId !== 'string' || !accountId) {
      throw new TypeError('Invalid accountId')
    }
    return getAuthStatus(accountId)
  })

  ipcMain.handle(ANTIGRAVITY_CHANNELS.cancelRun, (_event, accountId: unknown) => {
    if (typeof accountId === 'string' && accountId) {
      cancelAntigravityRun(accountId)
    }
  })

  ipcMain.handle(ANTIGRAVITY_CHANNELS.sendMessage, async (_event, request: unknown) => {
    if (typeof request !== 'object' || request === null) {
      throw new TypeError('Invalid antigravity sendMessage request')
    }
    const req = request as AntigravitySendRequest
    if (!req.accountId || !req.conversationId || typeof req.text !== 'string') {
      throw new TypeError('Invalid antigravity sendMessage fields')
    }
    try {
      const res = await sendAndStreamAntigravityMessage({
        accountId: req.accountId,
        conversationId: req.conversationId,
        sessionId: req.sessionId,
        text: req.text,
        clientMessageId: req.clientMessageId,
        onEvent: broadcast
      })
      return { ok: true, cascadeId: res.cascadeId, messageId: res.messageId }
    } catch (error) {
      const status = error instanceof AntigravityRpcError ? error.status : 500
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, status, message }
    }
  })

  ipcMain.handle(ANTIGRAVITY_CHANNELS.rpc, async (_event, request: unknown): Promise<AntigravityRpcResponse> => {
    if (typeof request !== 'object' || request === null) {
      return { ok: false, status: 400, message: 'Invalid antigravity rpc request' }
    }
    const req = request as AntigravityRpcRequest
    if (!req.accountId || !req.action) {
      return { ok: false, status: 400, message: 'Missing accountId or action' }
    }
    try {
      switch (req.action) {
        case 'profile':
          return { ok: true, status: 200, data: await fetchAntigravityProfile(req.accountId) }
        case 'models': {
          const models = await fetchAntigravityModels(req.accountId)
          const prefs = getAntigravityAccountPrefs(req.accountId)
          return { ok: true, status: 200, data: { models, selectedModelEnum: prefs.modelEnum } }
        }
        case 'agents': {
          const agents = await fetchAntigravityAgents(req.accountId)
          const prefs = getAntigravityAccountPrefs(req.accountId)
          return { ok: true, status: 200, data: { agents, selectedAgentPath: prefs.agentPath } }
        }
        case 'environments': {
          const environments = await fetchAntigravityEnvironments(req.accountId)
          const prefs = getAntigravityAccountPrefs(req.accountId)
          return { ok: true, status: 200, data: { environments, selectedCapsuleId: prefs.capsuleId } }
        }
        case 'workspaces':
          return { ok: true, status: 200, data: await fetchAntigravityWorkspaces(req.accountId) }
        case 'listConversations':
          return {
            ok: true,
            status: 200,
            data: await fetchAntigravityConversations(req.accountId, req.pageSize ?? 30)
          }
        case 'getConversation':
          if (!req.conversationId) return { ok: false, status: 400, message: 'Missing conversationId' }
          return {
            ok: true,
            status: 200,
            data: await fetchAntigravityTranscript(req.accountId, req.conversationId)
          }
        case 'deleteConversation':
          if (!req.conversationId) return { ok: false, status: 400, message: 'Missing conversationId' }
          await deleteAntigravityConversation(req.accountId, req.conversationId)
          return { ok: true, status: 200, data: { ok: true } }
        case 'setPrefs': {
          const next = setAntigravityAccountPrefs(req.accountId, {
            ...(req.modelEnum !== undefined ? { modelEnum: req.modelEnum } : {}),
            ...(req.modelDisplayName !== undefined ? { modelDisplayName: req.modelDisplayName } : {}),
            ...(req.capsuleId !== undefined ? { capsuleId: req.capsuleId || undefined } : {}),
            ...(req.agentPath !== undefined ? { agentPath: req.agentPath || undefined } : {})
          })
          return { ok: true, status: 200, data: next }
        }
        default:
          return { ok: false, status: 400, message: `Unknown antigravity RPC action` }
      }
    } catch (error) {
      const status = error instanceof AntigravityRpcError ? error.status : 500
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, status, message }
    }
  })
}
