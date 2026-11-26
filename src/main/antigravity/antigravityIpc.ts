/**
 * Electron IPC registration for Google Antigravity Cloud Agents (`antigravity.google.com`).
 */

import { BrowserWindow, ipcMain, session as electronSession } from 'electron'
import {
  ANTIGRAVITY_CHANNELS,
  type AntigravityAuthStatus,
  type AntigravityImportCredentialsRequest,
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
  completeAntigravityCredentialImport,
  onAntigravityLoginEvent,
  openAntigravityLoginWindow
} from './antigravityLogin'
import { AntigravityCredentialError, importAntigravityCredentials, withAntigravityCredentials } from './antigravityCredentials'

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
      displayName: probe.profile.email?.split('@')[0] || 'Antigravity',
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
    error: probe.reason === 'no-cookies' ? undefined : probe.message
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
    return withAntigravityCredentials(accountId, () => getAuthStatus(accountId))
  })

  ipcMain.handle(ANTIGRAVITY_CHANNELS.importCredentials, async (_event, request: unknown): Promise<AntigravityAuthStatus> => {
    if (typeof request !== 'object' || request === null) {
      throw new TypeError('Invalid antigravity importCredentials request')
    }
    const { accountId, rawInput } = request as AntigravityImportCredentialsRequest
    if (typeof accountId !== 'string' || !accountId.trim() || typeof rawInput !== 'string') {
      throw new TypeError('Invalid antigravity importCredentials fields')
    }
    return withAntigravityCredentials(accountId, async () => {
      try {
        const profile = await importAntigravityCredentials(accountId, rawInput)
        const status = await completeAntigravityCredentialImport(accountId, profile)
        const prefs = getAntigravityAccountPrefs(accountId)
        return { ...status, selectedModelEnum: prefs.modelEnum, selectedModelName: prefs.modelDisplayName }
      } catch (error) {
        return {
          accountId,
          signedIn: false,
          sessionCookieNames: await listAntigravityCookieNames(accountId),
          error: error instanceof AntigravityCredentialError ? error.message : '无法导入 Antigravity 凭据。请重试。'
        }
      }
    })
  })

  ipcMain.handle(ANTIGRAVITY_CHANNELS.cancelLogin, async (_event, accountId: unknown) => {
    if (typeof accountId !== 'string' || !accountId) return
    await withAntigravityCredentials(accountId, () => clearAccountPartition(accountId))
  })

  ipcMain.handle(ANTIGRAVITY_CHANNELS.clearAuth, async (_event, accountId: unknown) => {
    if (typeof accountId !== 'string' || !accountId) return
    await withAntigravityCredentials(accountId, async () => {
      await clearAccountPartition(accountId)
      broadcast({ type: 'login', accountId, signedIn: false })
    })
  })

  ipcMain.handle(ANTIGRAVITY_CHANNELS.authStatus, async (_event, accountId: unknown) => {
    if (typeof accountId !== 'string' || !accountId) {
      throw new TypeError('Invalid accountId')
    }
    return withAntigravityCredentials(accountId, () => getAuthStatus(accountId))
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
