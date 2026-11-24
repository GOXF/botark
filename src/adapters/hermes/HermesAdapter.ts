import { createId } from '@shared/id'
import type { HermesRpcRequest, HermesRpcResponse } from '@shared/ipc'
import type { HermesTurnEvent } from './events'
import { getBotHubBridge } from '../meta-muse/electronBridge'
import { statusAfterSendFailure } from '../sendFailure'
import {
  AdapterError,
  type AdapterEvent,
  type AdapterListener,
  type ApprovalDecision,
  type ConnectionStatus,
  type IncomingMessage,
  type MuseApproval,
  type MuseMediaPart,
  type MuseToolCall,
  type OutgoingMessage,
  type PlatformAccount,
  type PlatformAdapter,
  type SendReceipt,
  type Unsubscribe
} from '../types'

async function invokeHermesRpc(request: HermesRpcRequest & { requestId?: string }): Promise<unknown> {
  const bridge = getBotHubBridge()?.hermes
  if (!bridge?.rpc) {
    throw new AdapterError('not-connected', 'Hermes IPC unavailable (Electron main required)')
  }
  const res = (await bridge.rpc(request)) as HermesRpcResponse
  if (!res.ok) {
    if (res.code === 'aborted') throw new DOMException(res.message, 'AbortError')
    throw new AdapterError(
      res.status === 401 || res.status === 403 ? 'not-connected' : 'network',
      res.message || `Hermes RPC failed (${res.status})`
    )
  }
  return res.data
}

/**
 * Hermes Agent (`NousResearch/hermes-agent`) platform adapter.
 * Connects to a local or remote Hermes API server (`hermes gateway`) via
 * Electron main-process REST + SSE streaming with encrypted API key storage.
 */
export class HermesAdapter implements PlatformAdapter {
  readonly id = 'hermes' as const
  readonly name = 'Hermes'
  private readonly activeSends = new Map<string, { conversationId: string; requestId: string; sessionId?: string }>()

  private readonly accounts = new Map<string, PlatformAccount>()
  private readonly statuses = new Map<string, ConnectionStatus>()
  private readonly listeners = new Set<AdapterListener>()
  private bridgeUnsub: Unsubscribe | null = null
  private readonly pendingAcceptances = new Map<string, () => void>()

  constructor() {
    this.bindBridgeEvents()
  }

  private bindBridgeEvents(): void {
    const b = getBotHubBridge()
    if (!b?.hermes || this.bridgeUnsub) return
    this.bridgeUnsub = b.hermes.onEvent((event) => this.handleMainEvent(event))
  }

  private handleMainEvent(event: HermesTurnEvent): void {
    const send = this.activeSends.get(event.accountId)
    if (event.requestId && send?.requestId !== event.requestId) return
    if (event.type === 'accepted') {
      this.pendingAcceptances.get(event.requestId)?.()
      return
    }
    if (event.type === 'activity') {
      this.emit({
        type: 'activity',
        accountId: event.accountId,
        sessionId: send?.sessionId ?? event.sessionId,
        activity: {
          code: event.activityCode,
          text: event.activityText ?? null,
          emoji: event.activityEmoji ?? null,
          agentId: null,
          subagents: 0,
          busy: event.busy
        }
      })
      return
    }

    if (event.type === 'approvals') {
      const pending: MuseApproval[] = event.pending.map((a) => ({
        id: a.id,
        status: a.status,
        title: a.title,
        detail: a.detail,
        approvalType: a.approvalType,
        host: a.host,
        decisionOptions: a.decisionOptions,
        reason: a.reason,
        raw: a.raw
      }))
      this.emit({ type: 'approvals', accountId: event.accountId, pending })
      if (pending.length > 0) {
        this.setStatus(event.accountId, 'attention', 'Waiting for command approval')
      }
      return
    }

    if (event.type === 'stream') {
      if (!send || event.requestId !== send.requestId) return
      const convId = send.conversationId
      // If the gateway recreated the session, match the selection that
      // initiated the send until the receipt updates the session ID.
      const sessionId = send.sessionId ?? event.sessionId
      const tools = event.tools as MuseToolCall[] | undefined
      const media = event.media as MuseMediaPart[] | undefined
      if (!event.done) {
        this.emit({
          type: 'typing',
          conversationId: convId,
          accountId: event.accountId,
          sessionId,
          isTyping: true
        })
        if (event.text || tools?.length || media?.length) {
          this.emit({
            type: 'message_delta',
            messageId: event.messageId,
            conversationId: convId,
            accountId: event.accountId,
            sessionId,
            text: event.text,
            tools,
            media
          })
        }
      } else {
        this.emit({
          type: 'typing',
          conversationId: convId,
          accountId: event.accountId,
          sessionId,
          isTyping: false
        })
        this.setStatus(event.accountId, 'online')
        if (event.text || tools?.length || media?.length) {
          this.emit({
            type: 'message',
            message: {
              id: event.messageId,
              conversationId: convId,
              accountId: event.accountId,
              sessionId,
              text: event.text,
              createdAt: Date.now(),
              ...(tools?.length ? { tools } : {}),
              ...(media?.length ? { media } : {})
            }
          })
        }
      }
      return
    }

    if (event.type === 'login') {
      if (event.signedIn) {
        this.upsert(event.accountId, {
          displayName: event.displayName,
          handle: event.handle
        })
        this.emit({
          type: 'login',
          accountId: event.accountId,
          signedIn: true,
          handle: event.handle,
          displayName: event.displayName
        })
        this.setStatus(event.accountId, 'online')
      } else {
        this.emit({
          type: 'login',
          accountId: event.accountId,
          signedIn: false
        })
        this.setStatus(event.accountId, 'offline')
      }
    }
  }

  private emit(event: AdapterEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[hermes] listener failed', error)
      }
    }
  }

  private setStatus(accountId: string, status: ConnectionStatus, detail?: string): void {
    this.statuses.set(accountId, status)
    this.emit({ type: 'status', accountId, status, detail })
  }

  private upsert(accountId: string, patch?: Partial<PlatformAccount>): void {
    const prev = this.accounts.get(accountId)
    this.accounts.set(accountId, {
      id: accountId,
      platformId: 'hermes',
      displayName: patch?.displayName ?? prev?.displayName ?? 'Hermes',
      handle: patch?.handle ?? prev?.handle ?? accountId,
      avatarUrl: patch?.avatarUrl ?? prev?.avatarUrl
    })
    if (!this.statuses.has(accountId)) this.statuses.set(accountId, 'offline')
  }

  async listAccounts(): Promise<PlatformAccount[]> {
    return [...this.accounts.values()]
  }

  async connect(accountId: string): Promise<ConnectionStatus> {
    this.bindBridgeEvents()
    this.upsert(accountId)
    const bridge = getBotHubBridge()?.hermes
    if (!bridge) {
      this.setStatus(accountId, 'offline', '需要 Electron')
      return 'offline'
    }
    try {
      const status = await bridge.authStatus(accountId)
      if (!status.signedIn) {
        this.setStatus(accountId, status.baseUrl ? 'error' : 'offline', status.error || '未连接 Hermes 服务')
        return status.baseUrl ? 'error' : 'offline'
      }
      this.upsert(accountId, {
        displayName: status.displayName || 'Hermes',
        handle: status.handle || status.baseUrl || accountId
      })
      this.setStatus(accountId, 'online')
      return 'online'
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.setStatus(accountId, 'error', detail)
      return 'error'
    }
  }

  async disconnect(accountId: string): Promise<void> {
    await invokeHermesRpc({ accountId, op: 'stopRun' })
    this.setStatus(accountId, 'offline')
  }

  async sendMessage(message: OutgoingMessage): Promise<SendReceipt> {
    message.signal?.throwIfAborted()
    this.bindBridgeEvents()
    const previous = this.activeSends.get(message.accountId)
    const { accountId, conversationId, sessionId } = message
    const requestId = createId('hermes_req')
    const send = { conversationId, requestId, sessionId }
    this.activeSends.set(message.accountId, send)
    if (previous && previous.conversationId !== conversationId) {
      this.emit({ type: 'typing', accountId, isTyping: false, conversationId: previous.conversationId, sessionId: previous.sessionId })
    }
    const finishTyping = () => {
      if (this.activeSends.get(message.accountId) !== send) return false
      this.activeSends.delete(message.accountId)
      this.emit({ type: 'typing', accountId, isTyping: false, conversationId, sessionId })
      return true
    }
    this.setStatus(message.accountId, 'busy')
    this.emit({
      type: 'typing',
      conversationId: message.conversationId,
      accountId: message.accountId,
      sessionId,
      isTyping: true
    })

    let accepted = false
    const markAccepted = () => {
      if (accepted) return
      accepted = true
      message.onAccepted?.()
    }
    const onAbort = () => {
      void invokeHermesRpc({ accountId, op: 'stopRun', requestId }).catch(() => undefined)
    }
    this.pendingAcceptances.set(requestId, markAccepted)
    try {
      message.signal?.throwIfAborted()
      message.signal?.addEventListener('abort', onAbort, { once: true })
      const res = (await invokeHermesRpc({
        accountId: message.accountId,
        op: 'sendMessage',
        botId: message.conversationId,
        requestId,
        sessionId,
        sessionKey: message.hermesSessionKey,
        text: message.text,
        attachments: message.attachments
          ?.filter((a) => Boolean(a.dataBase64))
          .map((a) => ({
            name: a.name,
            mimeType: a.mimeType,
            dataBase64: a.dataBase64!
          }))
      })) as {
        messageId?: string
        sessionId?: string
        text?: string
        tools?: MuseToolCall[]
        media?: MuseMediaPart[]
      }

      if (finishTyping()) this.setStatus(message.accountId, 'online')

      markAccepted()
      const hasPayload = Boolean(res?.text?.trim() || res?.tools?.length || res?.media?.length)
      return {
        messageId: createId('msg'),
        acceptedAt: Date.now(),
        sessionId: res?.sessionId || sessionId,
        ...(hasPayload ? {} : { noReply: true })
      }
    } catch (error) {
      const current = finishTyping()
      if (current) {
        this.emit({
          type: 'activity',
          accountId: message.accountId,
          activity: {
            code: 'idle',
            text: null,
            emoji: null,
            agentId: null,
            subagents: 0,
            busy: false
          }
        })
      }
      const detail = error instanceof Error ? error.message : String(error)
      if (accepted && error instanceof Error && error.name === 'AbortError') {
        if (current) this.setStatus(message.accountId, 'online')
        return { messageId: createId('msg'), acceptedAt: Date.now(), sessionId, noReply: true }
      }
      const next = statusAfterSendFailure(error)
      if (current) this.setStatus(message.accountId, next, next === 'error' ? detail : undefined)
      throw error instanceof AdapterError ? error : new AdapterError('network', detail)
    } finally {
      message.signal?.removeEventListener('abort', onAbort)
      this.pendingAcceptances.delete(requestId)
    }
  }

  async listApprovals(accountId: string): Promise<MuseApproval[]> {
    const res = await invokeHermesRpc({ accountId, op: 'listApprovals' })
    return Array.isArray(res) ? (res as MuseApproval[]) : []
  }

  async decideApproval(accountId: string, approvalId: string, decision: ApprovalDecision): Promise<void> {
    await invokeHermesRpc({
      accountId,
      op: 'decideApproval',
      approvalId,
      decision
    })
  }

  subscribe(listener: AdapterListener): Unsubscribe {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onMessage(listener: (message: IncomingMessage) => void): Unsubscribe {
    return this.subscribe((event) => {
      if (event.type === 'message') listener(event.message)
    })
  }

  getStatus(accountId: string): ConnectionStatus {
    return this.statuses.get(accountId) ?? 'offline'
  }
}

export function createHermesAdapter(): HermesAdapter {
  return new HermesAdapter()
}
